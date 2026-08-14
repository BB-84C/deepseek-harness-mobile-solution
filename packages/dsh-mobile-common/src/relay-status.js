// Relay tunnel status sidecar: the gateway plugin (dsh-mobile-server) writes
// $DSH_HOME/mobile/data/relay-status.json; the CLI's `relay status` reads it.
import fs from 'node:fs';
import { mobilePaths } from './home.js';
import { atomicWriteJson } from './fsutil.js';

/**
 * @param {object} [env]
 * @param {string} [homedir]
 * @returns {object|null} { connected, since, instanceId, lastError } or null
 */
export function readRelayStatus(env = process.env, homedir = undefined) {
  try {
    const p = mobilePaths(env, homedir);
    const parsed = JSON.parse(fs.readFileSync(`${p.dataDir}/relay-status.json`, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} status { connected, since, instanceId, lastError }
 * @param {object} [env]
 * @param {string} [homedir]
 */
export function writeRelayStatus(status, env = process.env, homedir = undefined) {
  const p = mobilePaths(env, homedir);
  fs.mkdirSync(p.dataDir, { recursive: true });
  atomicWriteJson(`${p.dataDir}/relay-status.json`, status);
}
