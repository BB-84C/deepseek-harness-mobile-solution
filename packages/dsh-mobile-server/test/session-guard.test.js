// Offline tests for the session-live guard (single-writer protection).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkResumeSafe, findSessionLog } from '../src/session-guard.js';

async function tmpHome() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-guard-'));
}

test('finds a session log by id in the sharded layout', async () => {
  const home = await tmpHome();
  const logDir = path.join(home, 'sessions', '--D-work--', 'session-abc');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'session.jsonl.zstd'), 'x');
  assert.strictEqual(findSessionLog(home, 'session-abc'), logDir);
  assert.strictEqual(findSessionLog(home, 'session-missing'), null);
  await fs.promises.rm(home, { recursive: true, force: true });
});

test('fresh log + not live here -> unsafe', async () => {
  const home = await tmpHome();
  const logDir = path.join(home, 'sessions', '--D-work--', 'session-fresh');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'session.jsonl.zstd'), 'x');
  const now = Date.now();
  fs.utimesSync(path.join(logDir, 'session.jsonl.zstd'), now / 1000, now / 1000);

  const sessions = { get: () => undefined };
  const verdict = await checkResumeSafe({ dshHome: home, sessions, now: () => now }, 'session-fresh');
  assert.strictEqual(verdict.safe, false);
  assert.match(verdict.reason, /being written right now/);
  await fs.promises.rm(home, { recursive: true, force: true });
});

test('stale log -> safe', async () => {
  const home = await tmpHome();
  const logDir = path.join(home, 'sessions', '--D-work--', 'session-stale');
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'session.jsonl.zstd');
  fs.writeFileSync(file, 'x');
  const now = Date.now();
  fs.utimesSync(file, (now - 60000) / 1000, (now - 60000) / 1000);

  const verdict = await checkResumeSafe({ dshHome: home, sessions: { get: () => undefined }, now: () => now }, 'session-stale');
  assert.strictEqual(verdict.safe, true);
  await fs.promises.rm(home, { recursive: true, force: true });
});

test('fresh log but live in OUR store -> safe (we own the writer)', async () => {
  const home = await tmpHome();
  const logDir = path.join(home, 'sessions', '--D-work--', 'session-ours');
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'session.jsonl.zstd');
  fs.writeFileSync(file, 'x');
  const now = Date.now();
  fs.utimesSync(file, now / 1000, now / 1000);

  const sessions = { get: (id) => (id === 'session-ours' ? {} : undefined) };
  const verdict = await checkResumeSafe({ dshHome: home, sessions, now: () => now }, 'session-ours');
  assert.strictEqual(verdict.safe, true);
  assert.strictEqual(verdict.reason, 'live-here');
  await fs.promises.rm(home, { recursive: true, force: true });
});

test('unknown session id -> safe (official layer errors normally)', async () => {
  const home = await tmpHome();
  const verdict = await checkResumeSafe({ dshHome: home, sessions: { get: () => undefined }, now: () => Date.now() }, 'nope');
  assert.strictEqual(verdict.safe, true);
  await fs.promises.rm(home, { recursive: true, force: true });
});
