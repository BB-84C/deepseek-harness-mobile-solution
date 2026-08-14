import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveMobileHome,
  mobilePaths,
  configPath,
  pidFilePath,
  logsDir,
  devicesPath,
  instancesDir,
  ensureMobileDirs,
} from '../src/home.js';

test('resolveMobileHome uses MOBILE_HOME as full override', () => {
  const home = resolveMobileHome({ MOBILE_HOME: '/tmp/override-mobile' }, '/home/user');
  assert.equal(home, path.resolve('/tmp/override-mobile'));
});

test('resolveMobileHome uses DSH_HOME + /mobile', () => {
  const home = resolveMobileHome({ DSH_HOME: '/home/user/.dsh' }, '/home/user');
  assert.equal(home, path.join('/home/user/.dsh', 'mobile'));
});

test('resolveMobileHome defaults to ~/.dsh/mobile', () => {
  const home = resolveMobileHome({}, '/home/user');
  assert.equal(home, path.join('/home/user', '.dsh', 'mobile'));
});

test('mobilePaths derives the full layout', () => {
  const p = mobilePaths({ DSH_HOME: '/base/.dsh' }, '/base');
  assert.equal(p.configPath, path.join('/base/.dsh/mobile/config/config.json'));
  assert.equal(p.pidFilePath, path.join('/base/.dsh/mobile/pid.json'));
  assert.equal(p.logsDir, path.join('/base/.dsh/mobile/logs'));
  assert.equal(p.devicesPath, path.join('/base/.dsh/mobile/data/devices.json'));
  assert.equal(p.instancesDir, path.join('/base/.dsh/mobile/instances'));
  assert.equal(p.pairingsPath, path.join('/base/.dsh/mobile/data/pairings.json'));
});

test('named path helpers match mobilePaths', () => {
  const env = { DSH_HOME: '/x/.dsh' };
  assert.equal(configPath(env, '/x'), mobilePaths(env, '/x').configPath);
  assert.equal(pidFilePath(env, '/x'), mobilePaths(env, '/x').pidFilePath);
  assert.equal(logsDir(env, '/x'), mobilePaths(env, '/x').logsDir);
  assert.equal(devicesPath(env, '/x'), mobilePaths(env, '/x').devicesPath);
  assert.equal(instancesDir(env, '/x'), mobilePaths(env, '/x').instancesDir);
});

test('ensureMobileDirs creates config/logs/data/instances', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-home-'));
  try {
    const p = ensureMobileDirs({ DSH_HOME: tmp }, os.homedir());
    for (const dir of [p.home, p.configDir, p.logsDir, p.dataDir, p.instancesDir]) {
      assert.ok(fs.existsSync(dir), `expected ${dir} to exist`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
