// Device store: one-time pairing-code redemption + long-term device tokens.
//
// devices.json  — array of { id, name, tokenHash, createdAt, lastSeenAt,
//                 revokedAt, revoked }
// data/pairings.json — array of pending { code, name, createdAt, expiresAt }
//                 (single-use, 5-minute TTL)
//
// Only SHA-256 hashes of device tokens are ever persisted. Raw tokens are
// returned to the caller (the CLI / gateway) and never written to disk here.
// All functions accept an injectable `now` clock and `random` source so the
// pairing flow is deterministic under test.
import fs from 'node:fs';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mobilePaths } from './home.js';
import { atomicWriteJson } from './fsutil.js';

export const PAIRING_TTL_MS = 5 * 60 * 1000;

export class DeviceError extends Error {
  constructor(message, code = 'DEVICE_ERROR') {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
  }
}

/** @param {string} input @returns {string} lowercase sha256 hex */
export function sha256Hex(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

const DEFAULT_RANDOM = {
  code: () => String(randomInt(0, 1000000)).padStart(6, '0'),
  token: () => randomBytes(16).toString('hex'),
  id: () => randomUUID(),
};

/**
 * Create a device store bound to a set of paths/clock/random sources.
 * @param {{ paths?: Function, now?: Function, random?: object }} [deps]
 */
export function createDeviceStore(deps = {}) {
  const paths = deps.paths || (() => mobilePaths());
  const now = deps.now || (() => Date.now());
  const random = { ...DEFAULT_RANDOM, ...(deps.random || {}) };

  function loadJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  function loadPairings() {
    const v = loadJson(paths().pairingsPath);
    return Array.isArray(v) ? v : [];
  }

  function loadDevices() {
    const v = loadJson(paths().devicesPath);
    return Array.isArray(v) ? v : [];
  }

  function pruneExpired(pairings, t) {
    return pairings.filter((p) => p && typeof p.expiresAt === 'number' && p.expiresAt > t);
  }

  /**
   * Issue a one-time pairing code + raw device token.
   * @param {{ name: string }} params
   * @param {{ now?: number }} [opts]
   * @returns {{ pairingCode: string, rawToken: string, expiresAt: number }}
   */
  function issuePairing({ name } = {}, opts = {}) {
    const t = opts.now ?? now();
    if (typeof name !== 'string' || !name.trim()) {
      throw new DeviceError('name is required', 'INVALID_NAME');
    }
    const pairingCode = random.code();
    const rawToken = random.token();
    const record = {
      code: pairingCode,
      name: name.trim(),
      createdAt: t,
      expiresAt: t + PAIRING_TTL_MS,
    };
    const list = pruneExpired(loadPairings(), t);
    list.push(record);
    atomicWriteJson(paths().pairingsPath, list);
    return { pairingCode, rawToken, expiresAt: record.expiresAt };
  }

  /**
   * Redeem a pairing code: validate code match + TTL, create a device with the
   * SHA-256 hash of `rawToken`, and delete the single-use pairing record.
   * @param {{ pairingCode: string, rawToken: string }} params
   * @param {{ now?: number }} [opts]
   * @returns {object} the created device entry
   */
  function completePairing({ pairingCode, rawToken } = {}, opts = {}) {
    const t = opts.now ?? now();
    if (typeof pairingCode !== 'string' || !pairingCode) {
      throw new DeviceError('pairingCode is required', 'INVALID_CODE');
    }
    if (typeof rawToken !== 'string' || !rawToken) {
      throw new DeviceError('rawToken is required', 'INVALID_TOKEN');
    }
    const list = pruneExpired(loadPairings(), t);
    const idx = list.findIndex((p) => p.code === pairingCode);
    if (idx === -1) {
      throw new DeviceError('invalid or expired pairing code', 'INVALID_CODE');
    }
    const pending = list[idx];
    // single-use: consume the record before creating the device
    list.splice(idx, 1);
    atomicWriteJson(paths().pairingsPath, list);

    const device = {
      id: random.id(),
      name: pending.name,
      tokenHash: sha256Hex(rawToken),
      createdAt: t,
      lastSeenAt: t,
      revokedAt: null,
      revoked: false,
    };
    const devices = loadDevices();
    devices.push(device);
    atomicWriteJson(paths().devicesPath, devices);
    return device;
  }

  /**
   * Look up a device by raw token (valid + not revoked). Updates lastSeenAt.
   * @param {string} rawToken
   * @param {{ now?: number }} [opts]
   * @returns {object|null} device entry, or null
   */
  function verifyDevice(rawToken, opts = {}) {
    const t = opts.now ?? now();
    if (typeof rawToken !== 'string' || !rawToken) return null;
    const hash = sha256Hex(rawToken);
    const devices = loadDevices();
    const device = devices.find((d) => d.tokenHash === hash && !d.revoked);
    if (!device) return null;
    device.lastSeenAt = t;
    atomicWriteJson(paths().devicesPath, devices);
    return device;
  }

  /**
   * @returns {object[]} all device entries (including revoked).
   */
  function listDevices() {
    return loadDevices();
  }

  /**
   * Revoke a device by id (sets revoked + revokedAt). Idempotent for an
   * already-revoked device.
   * @param {string} id
   * @param {{ now?: number }} [opts]
   * @returns {object} the updated device entry
   */
  function revokeDevice(id, opts = {}) {
    const t = opts.now ?? now();
    const devices = loadDevices();
    const device = devices.find((d) => d.id === id);
    if (!device) throw new DeviceError(`device not found: ${id}`, 'NOT_FOUND');
    device.revoked = true;
    device.revokedAt = t;
    atomicWriteJson(paths().devicesPath, devices);
    return device;
  }

  return { issuePairing, completePairing, verifyDevice, listDevices, revokeDevice };
}

// Convenience default store bound to the process environment.
export const { issuePairing, completePairing, verifyDevice, listDevices, revokeDevice } = createDeviceStore();
