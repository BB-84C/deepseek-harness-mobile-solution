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
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
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
    const rawList = loadPairings();
    const list = pruneExpired(rawList, t);
    // persist pruning of expired records even when the code is not found
    if (list.length !== rawList.length) atomicWriteJson(paths().pairingsPath, list);
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
    const presented = Buffer.from(hash, 'hex');
    const devices = loadDevices();
    let device = null;
    // Constant-time: compare against every active token hash without
    // short-circuiting, so lookup time leaks nothing.
    for (const d of devices) {
      if (d.revoked || typeof d.tokenHash !== 'string') continue;
      if (Buffer.byteLength(d.tokenHash, 'hex') !== presented.length) continue;
      if (timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), presented)) {
        device = d;
        break;
      }
    }
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

  /** Default inactivity horizon for automatic device cleanup (days; 0 disables). */
  const DEFAULT_PRUNE_DAYS = 30;

  /**
   * Remove dead device records and collapse re-pairing duplicates.
   *
   * The store only ever appended, so a phone that re-paired (new pairing code,
   * new token) left the previous record behind under the same display name —
   * `status` then listed the same few devices over and over. Entries are
   * dropped when they are revoked, carry no usable token hash, duplicate a
   * newer record with the same name, or have not been seen for `maxAgeDays`.
   *
   * @param {{ now?: number, maxAgeDays?: number }} [opts]
   *   `maxAgeDays` 0 disables the inactivity rule; defaults to 30 days.
   * @returns {{ removed: Array<{ id: string, name: string, reason: string }>, kept: number }}
   */
  function pruneDevices(opts = {}) {
    const t = opts.now ?? now();
    const maxAgeDays = typeof opts.maxAgeDays === 'number' ? opts.maxAgeDays : DEFAULT_PRUNE_DAYS;
    const devices = loadDevices();
    const removed = [];

    // Newest activity first: the first active record for a name wins, and a
    // duplicate that is newer than the one it replaces keeps the name.
    const order = devices
      .map((device, index) => ({ device, index }))
      .sort((a, b) => {
        const seenA = activityOf(a.device);
        const seenB = activityOf(b.device);
        if (seenB !== seenA) return seenB - seenA;
        return a.index - b.index;
      });

    const keptNames = new Set();
    const keep = new Set();
    for (const { device } of order) {
      if (!device || typeof device !== 'object' || typeof device.id !== 'string') continue;
      const name = typeof device.name === 'string' ? device.name : '';
      const reason = (() => {
        if (device.revoked === true) return 'revoked';
        if (typeof device.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(device.tokenHash)) return 'invalid';
        if (keptNames.has(name)) return 'duplicate';
        if (maxAgeDays > 0 && t - activityOf(device) > maxAgeDays * 86400 * 1000) return 'expired';
        return null;
      })();
      if (reason !== null) {
        removed.push({ id: device.id, name, reason });
        continue;
      }
      keptNames.add(name);
      keep.add(device);
    }

    if (removed.length > 0) {
      atomicWriteJson(paths().devicesPath, devices.filter((device) => keep.has(device)));
    }
    return { removed, kept: keep.size };
  }

  /** Most recent evidence that this device still exists, in epoch ms. */
  function activityOf(device) {
    if (!device || typeof device !== 'object') return 0;
    const seen = typeof device.lastSeenAt === 'number' ? device.lastSeenAt : 0;
    const created = typeof device.createdAt === 'number' ? device.createdAt : 0;
    return Math.max(seen, created);
  }

  /**
   * Revoke a device by id (sets revoked + revokedAt). Idempotent for an
   * already-revoked device. Returns null when the id is unknown.
   * @param {string} id
   * @param {{ now?: number }} [opts]
   * @returns {object|null} the updated device entry, or null
   */
  function revokeDevice(id, opts = {}) {
    const t = opts.now ?? now();
    const devices = loadDevices();
    const device = devices.find((d) => d.id === id);
    if (!device) return null;
    device.revoked = true;
    device.revokedAt = t;
    atomicWriteJson(paths().devicesPath, devices);
    return device;
  }

  /**
   * Rotate an existing device's long-lived token (gateway `POST /mobile/api/token`,
   * owner-only recovery). Generates a fresh raw token, persists only its SHA-256
   * hash, and returns the raw token once — it is never written to disk and cannot
   * be recovered afterwards. Returns null when the id is unknown.
   * @param {string} id
   * @param {{ now?: number, rawToken?: string }} [opts]
   * @returns {{ rawToken: string, device: object }|null}
   */
  function rotateDeviceToken(id, opts = {}) {
    const t = opts.now ?? now();
    const rawToken = opts.rawToken ?? random.token();
    const devices = loadDevices();
    const device = devices.find((d) => d.id === id);
    if (!device) return null;
    device.tokenHash = sha256Hex(rawToken);
    device.lastSeenAt = t;
    atomicWriteJson(paths().devicesPath, devices);
    return { rawToken, device };
  }

  return { issuePairing, completePairing, verifyDevice, listDevices, revokeDevice, rotateDeviceToken, pruneDevices };
}

// Convenience default store bound to the process environment.
export const { issuePairing, completePairing, verifyDevice, listDevices, revokeDevice, rotateDeviceToken, pruneDevices } = createDeviceStore();
