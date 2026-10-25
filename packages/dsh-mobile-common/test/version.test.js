import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareDshVersions,
  needsLaunchToken,
  parseDshVersion,
  supportsNoOpen,
  VERIFIED_DSH_VERSIONS,
  NO_OPEN_SINCE,
  LAUNCH_TOKEN_SINCE,
} from '../src/version.js';
import { latestDesktopUrl, readDshVersion, resolveDshEntry } from '../src/service.js';

test('parseDshVersion splits numbers and prerelease', () => {
  assert.deepEqual(parseDshVersion('0.2.1-rc.2'), { numbers: [0, 2, 1], prerelease: ['rc', '2'] });
  assert.deepEqual(parseDshVersion('1.0.0'), { numbers: [1, 0, 0], prerelease: [] });
  assert.equal(parseDshVersion('not-a-version'), null);
  assert.equal(parseDshVersion(null), null);
});

test('compareDshVersions orders releases and prereleases', () => {
  assert.ok(compareDshVersions('0.1.0-rc.6', '0.1.2-rc.1') < 0);
  assert.ok(compareDshVersions('0.1.1-rc.2', '0.1.2-rc.1') < 0);
  assert.ok(compareDshVersions('0.1.2-rc.1', '0.1.2') < 0);
  assert.ok(compareDshVersions('0.1.0-rc.10', '0.1.0-rc.9') > 0);
  assert.ok(compareDshVersions('0.2.1-rc.2', '0.3.0') < 0);
  assert.equal(compareDshVersions('0.2.1-rc.2', '0.2.1-rc.2'), 0);
});

test('supportsNoOpen matches the releases that ship the flag', () => {
  // Verified by unpacking dsh-web-app: 0.1.0-rc.6 has no --no-open, 0.1.1-rc.1+
  // (0.1.1-rc.2, 0.1.2-rc.1, 0.1.5-rc.3, 0.1.7-rc.2, 0.2.0-rc.1, 0.2.1-rc.2) do.
  assert.equal(NO_OPEN_SINCE, '0.1.1-rc.1');
  assert.equal(supportsNoOpen('0.1.0-rc.6'), false);
  assert.equal(supportsNoOpen('0.1.0-rc.8'), false);
  assert.equal(supportsNoOpen('0.1.1-rc.1'), true);
  assert.equal(supportsNoOpen('0.2.1-rc.2'), true);
  // Unknown versions take the conservative path: no extra flag.
  assert.equal(supportsNoOpen(null), false);
  assert.equal(supportsNoOpen('garbage'), false);
});

test('needsLaunchToken marks the browser-token era', () => {
  assert.equal(LAUNCH_TOKEN_SINCE, '0.1.2-rc.1');
  assert.equal(needsLaunchToken('0.1.0-rc.6'), false);
  assert.equal(needsLaunchToken('0.1.1-rc.2'), false);
  assert.equal(needsLaunchToken('0.1.2-rc.1'), true);
  assert.equal(needsLaunchToken('0.2.1-rc.2'), true);
  assert.equal(needsLaunchToken(null), false);
  // Both verified releases stay listed as such.
  assert.ok(VERIFIED_DSH_VERSIONS.includes('0.2.1-rc.2'));
});

test('latestDesktopUrl picks the newest launch-token URL from the log', () => {
  const log = [
    '[dsh-mobile-server] mobile gateway listening on http://127.0.0.1:3081',
    'dsh web: http://127.0.0.1:3080/?token=FIRST',
    'dsh web: opening the default browser; pass --no-open to disable',
    'dsh web: http://127.0.0.1:3080/?token=SECOND',
    '',
  ].join('\n');
  assert.equal(latestDesktopUrl(log), 'http://127.0.0.1:3080/?token=SECOND');
  // An older dsh prints a bare URL; nothing to hand to the desktop browser.
  assert.equal(latestDesktopUrl('dsh web: http://127.0.0.1:3080\n'), null);
  assert.equal(latestDesktopUrl(''), null);
  assert.equal(latestDesktopUrl(null), null);
});

test('resolveDshEntry finds lib/bin.js beside an npm shim', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-entry-'));
  try {
    const binPath = path.join(tmp, 'dsh.cmd');
    fs.writeFileSync(binPath, '@echo off\n');
    const entry = path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// entry\n');
    assert.equal(resolveDshEntry(binPath), entry);
    // A path already pointing at JS is returned as-is.
    assert.equal(resolveDshEntry(entry), entry);
    // Nothing to resolve next to a bare shim.
    fs.rmSync(path.join(tmp, 'node_modules'), { recursive: true, force: true });
    assert.equal(resolveDshEntry(binPath), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readDshVersion parses the launcher output through the injected spawn', () => {
  const seen = [];
  const spawnImpl = (bin, args) => {
    seen.push({ bin, args });
    return { status: 0, stdout: '0.2.1-rc.2\n', stderr: '' };
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-version-'));
  try {
    const fakeBin = path.join(tmp, 'dsh');
    fs.writeFileSync(fakeBin, '#!/bin/sh\n');
    const version = readDshVersion({ env: { DSH_BIN: fakeBin }, platform: 'linux', spawnImpl });
    assert.equal(version, '0.2.1-rc.2');
    assert.deepEqual(seen[0].args, ['--version']);

    // Unparsable output → null (callers then take the conservative path).
    assert.equal(readDshVersion({ env: { DSH_BIN: fakeBin }, platform: 'linux', spawnImpl: () => ({ status: 0, stdout: 'no idea' }) }), null);
    // A throwing spawn must not break service start.
    assert.equal(readDshVersion({ env: { DSH_BIN: fakeBin }, platform: 'linux', spawnImpl: () => { throw new Error('boom'); } }), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
