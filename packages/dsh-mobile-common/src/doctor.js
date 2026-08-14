// Diagnostics: returns a flat list of { level, check, detail } findings so the
// CLI can render them however it likes. Binary/network probes are injectable
// (`probes`) so the suite can run fully offline.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { validateConfig } from './config.js';
import { findTailscale, tailscaleStatus, tailscaleIp4 } from './tailscale.js';
import { resolveDshBinary } from './service.js';
import { mobilePaths } from './home.js';
import { relayBaseUrl } from './url.js';

/**
 * Is a TCP port free on 127.0.0.1? Binds then immediately closes.
 * @param {number} port
 * @returns {Promise<{ free: boolean, error?: string }>}
 */
export function checkPortFree(port) {
  return new Promise((resolve) => {
    if (port == null || !Number.isInteger(port)) {
      resolve({ free: false, error: 'invalid port' });
      return;
    }
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      resolve({
        free: false,
        error: err && err.code === 'EADDRINUSE' ? 'port already in use' : (err && err.message) || String(err),
      });
    });
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve({ free: true }));
    });
  });
}

/**
 * Is a directory writable? Creates it, writes+removes a scratch file.
 * @param {string} dir
 * @returns {{ writable: boolean, error?: string }}
 */
export function checkWritable(dir) {
  const file = path.join(
    dir,
    `.write-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'ok', 'utf8');
    fs.unlinkSync(file);
    return { writable: true };
  } catch (err) {
    return { writable: false, error: err.message };
  }
}

/**
 * GET the relay health endpoint (https://<host>/relay/health).
 * @param {string} host
 * @param {Function} fetchImpl
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function checkRelay(host, fetchImpl, timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://${host}/relay/health`, { signal: controller.signal });
      return { ok: true, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function nodeVersionOk(version) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  return Number.isInteger(major) && major >= 22;
}

function defaultProbes(overrides = {}) {
  return {
    nodeVersion: process.versions.node,
    home: mobilePaths().home,
    findTailscale: () => findTailscale(),
    tailscaleStatus: () => tailscaleStatus(),
    tailscaleIp4: () => tailscaleIp4(),
    resolveDshBinary: () => resolveDshBinary(),
    checkPortFree,
    checkWritable,
    checkRelay,
    fetch: fetch,
    ...overrides,
  };
}

/**
 * Run diagnostics and return findings.
 * @param {{ config?: object, probes?: object }} [params]
 * @returns {Promise<Array<{ level: string, check: string, detail: string }>>}
 */
export async function diagnose({ config, probes } = {}) {
  const p = defaultProbes(probes);
  const results = [];

  // config valid
  if (!config) {
    results.push({ level: 'error', check: 'config', detail: 'no config provided' });
  } else {
    const { valid, errors } = validateConfig(config);
    if (valid) {
      results.push({ level: 'ok', check: 'config', detail: 'config valid' });
    } else {
      results.push({ level: 'error', check: 'config', detail: errors.join('; ') });
    }
  }

  // node version >= 22
  const nv = p.nodeVersion;
  if (nodeVersionOk(nv)) {
    results.push({ level: 'ok', check: 'node', detail: `node ${nv}` });
  } else {
    results.push({ level: 'error', check: 'node', detail: `node ${nv} (need >=22)` });
  }

  // dsh binary
  const dshBin = p.resolveDshBinary();
  if (dshBin) {
    results.push({ level: 'ok', check: 'dsh binary', detail: dshBin });
  } else {
    results.push({ level: 'error', check: 'dsh binary', detail: 'dsh not found; set DSH_BIN or add dsh to PATH' });
  }

  // gateway + web ports free
  const gw = await p.checkPortFree(config && config.gatewayPort);
  results.push(
    gw.free
      ? { level: 'ok', check: 'gateway port', detail: `${config.gatewayPort} free` }
      : { level: 'error', check: 'gateway port', detail: `${config.gatewayPort}: ${gw.error}` },
  );
  const web = await p.checkPortFree(config && config.webPort);
  results.push(
    web.free
      ? { level: 'ok', check: 'web port', detail: `${config.webPort} free` }
      : { level: 'error', check: 'web port', detail: `${config.webPort}: ${web.error}` },
  );

  // mobile home writable
  const w = p.checkWritable(p.home);
  results.push(
    w.writable
      ? { level: 'ok', check: 'mobile home writable', detail: p.home }
      : { level: 'error', check: 'mobile home writable', detail: `${p.home}: ${w.error}` },
  );

  const mode = config && config.mode;
  if (mode === 'relay') {
    const host = relayBaseUrl(config.relay && config.relay.url);
    if (!host) {
      results.push({ level: 'error', check: 'relay url', detail: 'relay.url is not configured' });
    } else {
      const health = await p.checkRelay(host, p.fetch);
      results.push(
        health.ok
          ? { level: 'ok', check: 'relay url', detail: `https://${host}/relay/health → ${health.status}` }
          : { level: 'error', check: 'relay url', detail: `https://${host}/relay/health unreachable: ${health.error}` },
      );
    }
  } else {
    // tailscale binary
    const tsBin = p.findTailscale();
    if (tsBin) {
      results.push({ level: 'ok', check: 'tailscale binary', detail: tsBin });
    } else {
      results.push({
        level: 'error',
        check: 'tailscale binary',
        detail: 'tailscale not found; install tailscale or set TAILSCALE_PATH',
      });
    }

    // tailscale up (status, not `tailscale up` — connecting is a separate command)
    const tsStatus = p.tailscaleStatus();
    if (!tsStatus.ok) {
      results.push({ level: 'warn', check: 'tailscale up', detail: tsStatus.error || 'tailscale status unavailable' });
    } else {
      const backend = tsStatus.data && tsStatus.data.BackendState;
      if (backend === 'Running') {
        results.push({ level: 'ok', check: 'tailscale up', detail: `BackendState=${backend}` });
      } else {
        results.push({ level: 'warn', check: 'tailscale up', detail: `BackendState=${backend || 'unknown'}` });
      }
    }

    // tailscale ip
    const ip = p.tailscaleIp4();
    if (ip) {
      results.push({ level: 'ok', check: 'tailscale ip', detail: ip });
    } else {
      results.push({
        level: 'error',
        check: 'tailscale ip',
        detail: 'no IPv4 address (tailscale down or not authenticated)',
      });
    }
  }

  return results;
}
