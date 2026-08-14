// config.json store: defaults, validation, atomic load/save, and dotted-key
// get/set for the future `dsh mobile config get|set|show` command.
//
// config.json shape (version 1):
// {
//   "version": 1,
//   "mode": "tailscale" | "relay",
//   "webPort": 3080,
//   "gatewayPort": 3081,
//   "hostname": "",
//   "tailscale": { "interfaceIp": "" },
//   "relay": { "url": "", "instanceId": "", "instanceToken": "", "displayName": "" },
//   "auth": { "sessionTtlDays": 30 }
// }
import fs from 'node:fs';
import { mobilePaths } from './home.js';
import { atomicWriteFile } from './fsutil.js';

export const CONFIG_VERSION = 1;
export const MODES = ['tailscale', 'relay'];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** @returns {object} a fresh config with all defaults. */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    mode: 'tailscale',
    gatewayPort: 3081,
    hostname: '',
    tailscale: { interfaceIp: '' },
    relay: { url: '', instanceId: '', instanceToken: '', displayName: '' },
    auth: { sessionTtlDays: 30 },
  };
}

function isPort(v) {
  return Number.isInteger(v) && v >= 1 && v <= 65535;
}

/**
 * Merge a (possibly partial / user-edited) config over the defaults,
 * keeping only the known structure. Returns a complete config object.
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeConfig(raw) {
  const d = defaultConfig();
  if (!raw || typeof raw !== 'object') return d;
  const out = { ...d };
  if (typeof raw.version === 'number') out.version = raw.version;
  if (typeof raw.mode === 'string') out.mode = raw.mode;
  if (raw.gatewayPort !== undefined) out.gatewayPort = raw.gatewayPort;
  if (typeof raw.hostname === 'string') out.hostname = raw.hostname;
  out.tailscale = { ...d.tailscale, ...(raw.tailscale && typeof raw.tailscale === 'object' ? raw.tailscale : {}) };
  out.relay = { ...d.relay, ...(raw.relay && typeof raw.relay === 'object' ? raw.relay : {}) };
  out.auth = { ...d.auth, ...(raw.auth && typeof raw.auth === 'object' ? raw.auth : {}) };
  return out;
}

/**
 * Validate a complete config object.
 * @param {unknown} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }
  if (config.version !== CONFIG_VERSION) {
    errors.push(`unsupported config version: ${config.version}`);
  }
  if (!MODES.includes(config.mode)) {
    errors.push(`mode must be one of: ${MODES.join(', ')}`);
  }
  if (!isPort(config.gatewayPort)) errors.push('gatewayPort must be an integer 1-65535');
  if (typeof config.hostname !== 'string') errors.push('hostname must be a string');

  if (!config.tailscale || typeof config.tailscale !== 'object') {
    errors.push('tailscale must be an object');
  } else if (typeof config.tailscale.interfaceIp !== 'string') {
    errors.push('tailscale.interfaceIp must be a string');
  }

  if (!config.relay || typeof config.relay !== 'object') {
    errors.push('relay must be an object');
  } else {
    for (const k of ['url', 'instanceId', 'instanceToken', 'displayName']) {
      if (typeof config.relay[k] !== 'string') errors.push(`relay.${k} must be a string`);
    }
  }

  if (!config.auth || typeof config.auth !== 'object') {
    errors.push('auth must be an object');
  } else if (!Number.isInteger(config.auth.sessionTtlDays) || config.auth.sessionTtlDays <= 0) {
    errors.push('auth.sessionTtlDays must be a positive integer');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Read config.json, fill defaults, and validate.
 * Missing file is not an error — defaults are returned with source "default".
 * @param {{ env?: object, homedir?: string, paths?: object }} [opts]
 * @returns {{ config: object, errors: string[], valid: boolean, source: string, path: string }}
 */
export function loadConfig(opts = {}) {
  const p = opts.paths || mobilePaths(opts.env, opts.homedir);
  let config = defaultConfig();
  let source = 'default';
  const errors = [];
  try {
    const raw = JSON.parse(fs.readFileSync(p.configPath, 'utf8'));
    source = 'file';
    config = normalizeConfig(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      errors.push(`cannot read config: ${err.message}`);
    }
  }
  const v = validateConfig(config);
  return {
    config,
    errors: [...errors, ...v.errors],
    valid: v.valid && errors.length === 0,
    source,
    path: p.configPath,
  };
}

/**
 * Validate and atomically write a config to config.json.
 * @param {object} config
 * @param {{ env?: object, homedir?: string, paths?: object }} [opts]
 * @returns {string} the written path
 * @throws {ConfigError} when the config is invalid
 */
export function saveConfig(config, opts = {}) {
  const p = opts.paths || mobilePaths(opts.env, opts.homedir);
  const normalized = normalizeConfig(config);
  const { valid, errors } = validateConfig(normalized);
  if (!valid) throw new ConfigError(`invalid config: ${errors.join('; ')}`);
  atomicWriteFile(p.configPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return p.configPath;
}

/**
 * Read a value by dotted key (e.g. "relay.url").
 * @param {object} config
 * @param {string} key
 * @returns {unknown} value, or undefined when the path does not exist
 */
export function getConfigValue(config, key) {
  const parts = String(key).split('.');
  let cur = config;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

const KEY_VALIDATORS = {
  mode: (v) => (MODES.includes(v) ? null : `mode must be one of: ${MODES.join(', ')}`),
  gatewayPort: (v) => (isPort(v) ? null : 'gatewayPort must be an integer 1-65535'),
  hostname: (v) => (typeof v === 'string' ? null : 'hostname must be a string'),
  'tailscale.interfaceIp': (v) => (typeof v === 'string' ? null : 'tailscale.interfaceIp must be a string'),
  'relay.url': (v) => (typeof v === 'string' ? null : 'relay.url must be a string'),
  'relay.instanceId': (v) => (typeof v === 'string' ? null : 'relay.instanceId must be a string'),
  'relay.instanceToken': (v) => (typeof v === 'string' ? null : 'relay.instanceToken must be a string'),
  'relay.displayName': (v) => (typeof v === 'string' ? null : 'relay.displayName must be a string'),
  'auth.sessionTtlDays': (v) =>
    Number.isInteger(v) && v > 0 ? null : 'auth.sessionTtlDays must be a positive integer',
};

/**
 * Validate a single dotted key's value.
 * @param {string} key
 * @param {unknown} value
 * @returns {string|null} error message, or null when valid
 */
export function validateKey(key, value) {
  const validator = KEY_VALIDATORS[key];
  if (!validator) return `unknown config key: ${key}`;
  return validator(value);
}

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Deep-set a value by dotted key, validating the key and value first.
 * Creates intermediate objects as needed and returns a NEW config object
 * (the input is not mutated).
 * @param {object} config
 * @param {string} key
 * @param {unknown} value
 * @returns {object} new config
 * @throws {ConfigError} on unknown key or invalid value
 */
export function setConfigValue(config, key, value) {
  const parts = String(key).split('.');
  if (parts.length === 0 || parts.some((p) => p === '')) {
    throw new ConfigError(`invalid config key: ${key}`);
  }
  const err = validateKey(key, value);
  if (err) throw new ConfigError(err);

  const out = deepClone(config);
  let cur = out;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  return out;
}
