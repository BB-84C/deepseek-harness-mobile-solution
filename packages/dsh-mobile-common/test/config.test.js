import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultConfig,
  normalizeConfig,
  validateConfig,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  validateKey,
  ConfigError,
  MODES,
} from '../src/config.js';

function tempPaths() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-config-'));
  return { tmp, paths: { configPath: path.join(tmp, 'config', 'config.json') } };
}

test('defaultConfig returns the full version-1 shape', () => {
  const d = defaultConfig();
  assert.equal(d.version, 1);
  assert.equal(d.mode, 'tailscale');
  assert.equal(d.gatewayPort, 3081);
  assert.deepEqual(d.tailscale, { interfaceIp: '' });
  assert.deepEqual(d.relay, { url: '', instanceId: '', instanceToken: '', displayName: '' });
  assert.deepEqual(d.auth, { sessionTtlDays: 30 });
});

test('normalizeConfig fills defaults and drops unknown structure', () => {
  const out = normalizeConfig({ mode: 'relay', relay: { url: 'relay.example.com' }, webPort: 3090 });
  assert.equal(out.mode, 'relay');
  assert.equal(out.relay.url, 'relay.example.com');
  // webPort is deliberately NOT part of the schema anymore — the resident
  // instance always owns 3080; legacy configs carrying webPort drop it.
  assert.equal(out.webPort, undefined);
  assert.equal(out.relay.instanceToken, '');
});

test('validateConfig accepts a valid config', () => {
  const { valid, errors } = validateConfig(defaultConfig());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateConfig rejects bad mode and out-of-range ports', () => {
  const { valid, errors } = validateConfig({ ...defaultConfig(), mode: 'bogus', gatewayPort: 70000 });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('mode')));
  assert.ok(errors.some((e) => e.includes('gatewayPort')));
});

test('loadConfig returns defaults when the file is missing', () => {
  const { tmp, paths } = tempPaths();
  try {
    const res = loadConfig({ paths });
    assert.equal(res.source, 'default');
    assert.equal(res.valid, true);
    assert.deepEqual(res.config, defaultConfig());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfig + loadConfig round-trips atomically with no tmp leftovers', () => {
  const { tmp, paths } = tempPaths();
  try {
    const config = { ...defaultConfig(), mode: 'relay', gatewayPort: 4000, relay: { ...defaultConfig().relay, url: 'r.example.com' } };
    saveConfig(config, { paths });
    assert.ok(fs.existsSync(paths.configPath));
    const res = loadConfig({ paths });
    assert.equal(res.source, 'file');
    assert.equal(res.valid, true);
    assert.equal(res.config.mode, 'relay');
    assert.equal(res.config.gatewayPort, 4000);
    assert.equal(res.config.relay.url, 'r.example.com');
    // no temp files left behind
    const leftovers = fs.readdirSync(path.dirname(paths.configPath)).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfig rejects an invalid config', () => {
  const { tmp, paths } = tempPaths();
  try {
    assert.throws(() => saveConfig({ ...defaultConfig(), gatewayPort: 'nope' }, { paths }), ConfigError);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getConfigValue reads nested dotted keys', () => {
  const config = defaultConfig();
  assert.equal(getConfigValue(config, 'relay.url'), '');
  assert.equal(getConfigValue(config, 'auth.sessionTtlDays'), 30);
  assert.equal(getConfigValue(config, 'does.not.exist'), undefined);
});

test('setConfigValue deep-sets without mutating the input', () => {
  const config = defaultConfig();
  const next = setConfigValue(config, 'relay.url', 'https://relay.example.com');
  assert.equal(next.relay.url, 'https://relay.example.com');
  assert.equal(config.relay.url, ''); // original untouched
});

test('setConfigValue validates value and unknown keys', () => {
  const config = defaultConfig();
  // webPort is intentionally not a valid key anymore (one-instance principle).
  assert.throws(() => setConfigValue(config, 'webPort', 3080), ConfigError);
  assert.throws(() => setConfigValue(config, 'mode', 'nope'), ConfigError);
  assert.throws(() => setConfigValue(config, 'no.such.key', 1), ConfigError);
});

test('validateKey accepts every documented mode', () => {
  for (const mode of MODES) assert.equal(validateKey('mode', mode), null);
});
