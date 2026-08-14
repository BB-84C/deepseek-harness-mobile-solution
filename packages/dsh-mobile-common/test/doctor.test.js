import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../src/doctor.js';
import { defaultConfig } from '../src/config.js';

function findCheck(results, check) {
  return results.find((r) => r.check === check);
}

const happyProbes = {
  nodeVersion: '22.1.0',
  home: '/tmp/.dsh/mobile',
  findTailscale: () => '/usr/bin/tailscale',
  tailscaleStatus: () => ({ ok: true, data: { BackendState: 'Running' } }),
  tailscaleIp4: () => '100.1.2.3',
  resolveDshBinary: () => '/usr/bin/dsh',
  checkPortFree: async () => ({ free: true }),
  checkWritable: () => ({ writable: true }),
  checkRelay: async () => ({ ok: true, status: 200 }),
  fetch: async () => ({ status: 200 }),
};

test('doctor reports ok for a healthy tailscale setup', async () => {
  const results = await diagnose({ config: defaultConfig(), probes: happyProbes });
  for (const r of results) {
    assert.equal(r.level, 'ok', `${r.check}: ${r.detail}`);
  }
  assert.ok(findCheck(results, 'config'));
  assert.ok(findCheck(results, 'node'));
  assert.ok(findCheck(results, 'dsh binary'));
  assert.ok(findCheck(results, 'tailscale binary'));
  assert.ok(findCheck(results, 'tailscale up'));
  assert.ok(findCheck(results, 'tailscale ip'));
});

test('doctor flags bad config, old node, missing binaries and busy ports', async () => {
  const results = await diagnose({
    config: { ...defaultConfig(), mode: 'bogus', webPort: 0 },
    probes: {
      ...happyProbes,
      nodeVersion: '18.0.0',
      resolveDshBinary: () => null,
      findTailscale: () => null,
      checkPortFree: async (port) => ({ free: false, error: 'port already in use' }),
    },
  });
  assert.equal(findCheck(results, 'config').level, 'error');
  assert.equal(findCheck(results, 'node').level, 'error');
  assert.equal(findCheck(results, 'dsh binary').level, 'error');
  assert.equal(findCheck(results, 'gateway port').level, 'error');
  assert.equal(findCheck(results, 'web port').level, 'error');
  assert.equal(findCheck(results, 'tailscale binary').level, 'error');
});

test('doctor checks relay health in relay mode', async () => {
  let healthUrl = null;
  const results = await diagnose({
    config: { ...defaultConfig(), mode: 'relay', relay: { ...defaultConfig().relay, url: 'relay.example.com' } },
    probes: {
      ...happyProbes,
      checkRelay: async (host, fetchImpl) => {
        healthUrl = host;
        return { ok: true, status: 200 };
      },
    },
  });
  assert.equal(healthUrl, 'relay.example.com');
  assert.equal(findCheck(results, 'relay url').level, 'ok');
});

test('doctor reports unreachable relay', async () => {
  const results = await diagnose({
    config: { ...defaultConfig(), mode: 'relay', relay: { ...defaultConfig().relay, url: 'relay.example.com' } },
    probes: {
      ...happyProbes,
      checkRelay: async () => ({ ok: false, error: 'fetch failed' }),
    },
  });
  assert.equal(findCheck(results, 'relay url').level, 'error');
});

test('doctor warns when tailscale is present but not running', async () => {
  const results = await diagnose({
    config: defaultConfig(),
    probes: {
      ...happyProbes,
      tailscaleStatus: () => ({ ok: true, data: { BackendState: 'Stopped' } }),
      tailscaleIp4: () => null,
    },
  });
  assert.equal(findCheck(results, 'tailscale up').level, 'warn');
  assert.equal(findCheck(results, 'tailscale ip').level, 'error');
});

test('doctor errors when the mobile home is not writable', async () => {
  const results = await diagnose({
    config: defaultConfig(),
    probes: { ...happyProbes, checkWritable: () => ({ writable: false, error: 'EACCES' }) },
  });
  assert.equal(findCheck(results, 'mobile home writable').level, 'error');
});
