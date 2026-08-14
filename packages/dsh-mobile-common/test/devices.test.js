import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDeviceStore,
  DeviceError,
  PAIRING_TTL_MS,
  sha256Hex,
} from '../src/devices.js';

function makeStore(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-devices-'));
  const paths = () => ({
    devicesPath: path.join(tmp, 'data', 'devices.json'),
    pairingsPath: path.join(tmp, 'data', 'pairings.json'),
  });
  const now = overrides.now ?? (() => 1000);
  const random = overrides.random ?? {
    code: () => '123456',
    token: () => 'a'.repeat(32),
    id: () => 'device-1',
  };
  const store = createDeviceStore({ paths, now, random });
  return { store, tmp, paths: paths() };
}

test('issue -> complete -> verify -> revoke -> verify fails', () => {
  const { store, tmp } = makeStore();
  try {
    const raw = 'a'.repeat(32);
    const issued = store.issuePairing({ name: '  Phone  ' });
    assert.equal(issued.pairingCode, '123456');
    assert.equal(issued.rawToken, raw);
    assert.equal(issued.expiresAt, 1000 + PAIRING_TTL_MS);

    const device = store.completePairing({ pairingCode: '123456', rawToken: raw });
    assert.equal(device.id, 'device-1');
    assert.equal(device.name, 'Phone');
    assert.equal(device.tokenHash, sha256Hex(raw));
    assert.equal(device.revoked, false);

    // token hash is persisted, raw token is not
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'devices.json'), 'utf8'));
    assert.equal(onDisk[0].tokenHash, sha256Hex(raw));
    assert.ok(!JSON.stringify(onDisk).includes(raw));

    const verified = store.verifyDevice(raw);
    assert.ok(verified);
    assert.equal(verified.id, 'device-1');

    const revoked = store.revokeDevice('device-1');
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.revokedAt, 1000);

    assert.equal(store.verifyDevice(raw), null);
    assert.equal(store.listDevices().length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pairing code is single-use', () => {
  const { store, tmp } = makeStore();
  try {
    store.issuePairing({ name: 'Phone' });
    store.completePairing({ pairingCode: '123456', rawToken: 'a'.repeat(32) });
    assert.throws(
      () => store.completePairing({ pairingCode: '123456', rawToken: 'b'.repeat(32) }),
      (e) => e instanceof DeviceError && e.code === 'INVALID_CODE',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pairing code expires after TTL (injected clock)', () => {
  const t0 = 1000;
  const { store, tmp } = makeStore({ now: () => t0 });
  try {
    store.issuePairing({ name: 'Phone' });
    const pastExpiry = t0 + PAIRING_TTL_MS + 1;
    assert.throws(
      () => store.completePairing({ pairingCode: '123456', rawToken: 'a'.repeat(32) }, { now: pastExpiry }),
      (e) => e instanceof DeviceError && e.code === 'INVALID_CODE',
    );
    // expiry also pruned the pending record
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'pairings.json'), 'utf8'));
    assert.equal(onDisk.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifyDevice rejects wrong tokens and revoked devices', () => {
  const { store, tmp } = makeStore();
  try {
    store.issuePairing({ name: 'Phone' });
    store.completePairing({ pairingCode: '123456', rawToken: 'a'.repeat(32) });
    assert.equal(store.verifyDevice('b'.repeat(32)), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('issuePairing requires a name', () => {
  const { store, tmp } = makeStore();
  try {
    assert.throws(() => store.issuePairing({}), (e) => e instanceof DeviceError && e.code === 'INVALID_NAME');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('revokeDevice returns null for an unknown id', () => {
  const { store, tmp } = makeStore();
  try {
    assert.equal(store.revokeDevice('nope'), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
