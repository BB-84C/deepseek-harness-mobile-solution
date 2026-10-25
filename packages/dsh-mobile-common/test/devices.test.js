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

/** Write a devices.json fixture directly so each rule can be exercised. */
function seedDevices(tmp, records) {
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'devices.json'), JSON.stringify(records, null, 2), 'utf8');
}

function device(id, name, overrides = {}) {
  return {
    id,
    name,
    tokenHash: sha256Hex(`token-${id}`),
    createdAt: 1_000,
    lastSeenAt: 1_000,
    revoked: false,
    revokedAt: null,
    ...overrides,
  };
}

test('pruneDevices drops revoked, invalid, duplicate-name and expired records', () => {
  const { store, tmp } = makeStore();
  try {
    const day = 86_400_000;
    const now = 1_000 + 90 * day;
    seedDevices(tmp, [
      device('a', 'iPhone', { lastSeenAt: 1_000 + 89 * day }), // newest iPhone -> kept
      device('b', 'iPhone', { lastSeenAt: 1_000 + 1 * day }), // older duplicate -> dropped
      device('c', 'Pixel', { revoked: true, revokedAt: 1_000 }), // revoked -> dropped
      device('d', 'Tablet', { tokenHash: 'not-a-hash' }), // unusable hash -> dropped
      device('e', 'Old', { lastSeenAt: 1_000 + 1 * day }), // inactive > 30 days -> dropped
      device('f', 'Laptop', { lastSeenAt: 1_000 + 80 * day }), // kept
    ]);
    const report = store.pruneDevices({ now });
    assert.equal(report.kept, 2);
    const reasons = Object.fromEntries(report.removed.map((entry) => [entry.id, entry.reason]));
    assert.deepEqual(reasons, { b: 'duplicate', c: 'revoked', d: 'invalid', e: 'expired' });
    assert.deepEqual(store.listDevices().map((entry) => entry.id).sort(), ['a', 'f']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pruneDevices keeps records regardless of age when maxAgeDays is 0', () => {
  const { store, tmp } = makeStore();
  try {
    seedDevices(tmp, [device('a', 'Old', { lastSeenAt: 1_000 }), device('b', 'New', { lastSeenAt: 1_000 + 400 * 86_400_000 })]);
    const report = store.pruneDevices({ now: 1_000 + 500 * 86_400_000, maxAgeDays: 0 });
    assert.deepEqual(report.removed, []);
    assert.equal(report.kept, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pruneDevices leaves the file untouched when nothing is stale', () => {
  const { store, tmp } = makeStore();
  try {
    seedDevices(tmp, [device('a', 'iPhone')]);
    const before = fs.readFileSync(path.join(tmp, 'data', 'devices.json'), 'utf8');
    const report = store.pruneDevices({ now: 2_000 });
    assert.deepEqual(report.removed, []);
    assert.equal(report.kept, 1);
    assert.equal(fs.readFileSync(path.join(tmp, 'data', 'devices.json'), 'utf8'), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
