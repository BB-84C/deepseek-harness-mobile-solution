// Diagnostics: returns a flat list of { level, check, detail } findings so the
// CLI can render them however it likes. Binary/network probes are injectable
// (`probes`) so the suite can run fully offline.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
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

/**
 * dsh releases this solution has been verified against.
 * @see docs/research/upstream-0.2-impact.md
 */
export const VERIFIED_DSH_VERSIONS = ['0.1.0-rc.6', '0.2.1-rc.2'];

/**
 * First dsh release whose official web gates the browser index on a launch
 * token (`@deepseek-ai/dsh-client-connection` 0.1.2-rc.1). Our gateway performs
 * the token handshake, so both sides of this boundary are supported — the note
 * only tells the operator which world they are in when debugging.
 */
export const LAUNCH_TOKEN_SINCE = '0.1.2-rc.1';

/** Parse `major.minor.patch[-prerelease]` into comparable numbers. */
function parseDshVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version).trim());
  if (!match) return null;
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])];
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  return { numbers, prerelease };
}

/**
 * SemVer ordering for dsh releases (prerelease sorts before its release).
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b
 */
export function compareDshVersions(a, b) {
  const left = parseDshVersion(a);
  const right = parseDshVersion(b);
  if (left === null || right === null) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] - right.numbers[index];
  }
  // A prerelease is lower than the release it leads to.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = Number.parseInt(l, 10);
    const rn = Number.parseInt(r, 10);
    if (Number.isInteger(ln) && Number.isInteger(rn) && ln !== rn) return ln - rn;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Report the running dsh version and whether our gateway's browser-token
 * handshake applies (upstream >= LAUNCH_TOKEN_SINCE).
 * @param {string|null} version `dsh --version` output, or null when unknown
 * @returns {{ level: string, check: string, detail: string }}
 */
export function checkDshVersion(version) {
  const parsed = version === null || version === undefined ? null : parseDshVersion(version);
  if (parsed === null) {
    return {
      level: 'warn',
      check: 'dsh version',
      detail: 'unavailable — run `dsh --version` yourself; gateway features are chosen by feature detection',
    };
  }
  const tokenGate = compareDshVersions(version, LAUNCH_TOKEN_SINCE) >= 0;
  const mode = tokenGate ? 'browser-token handshake active' : 'no browser token (transparent proxy)';
  if (VERIFIED_DSH_VERSIONS.includes(version)) {
    return { level: 'ok', check: 'dsh version', detail: `${version} (verified) — ${mode}` };
  }
  return {
    level: 'warn',
    check: 'dsh version',
    detail: `${version} is not in the verified list (${VERIFIED_DSH_VERSIONS.join(', ')}) — ${mode}; smoke-test the phone flow, see docs/research/upstream-0.2-impact.md`,
  };
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Does the resident dsh instance have a way to obtain the DeepSeek API key?
 * The key can live in several places; a key that only exists in ANOTHER
 * launcher's process environment is invisible to the mobile-spawned instance,
 * which is the classic "works locally, fails on the phone" trap.
 * @param {{ env?: object, home?: string, cwd?: string, homedir?: string }} [probes]
 * @returns {{ level: string, check: string, detail: string }}
 */
export function checkLlmCredentials(probes = {}) {
  const env = probes.env ?? process.env;
  const mobileHome = probes.home ?? mobilePaths().home;
  const dshHome = path.dirname(mobileHome);
  const cwd = probes.cwd ?? process.cwd();
  const homedir = probes.homedir ?? os.homedir();
  const sources = [];
  if (typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.length > 0) {
    sources.push('env DEEPSEEK_API_KEY');
  }
  if (fs.existsSync(path.join(dshHome, '.credentials.yaml'))) sources.push('.credentials.yaml');
  const settings = readText(path.join(dshHome, 'settings.yaml'));
  if (settings && /^llm-deepseek:/m.test(settings)) sources.push('settings.yaml llm-deepseek');
  for (const envFile of [path.join(cwd, '.env'), path.join(homedir, '.env')]) {
    const text = readText(envFile);
    if (text && /^\s*DEEPSEEK_API_KEY\s*=/m.test(text)) sources.push(envFile);
  }
  if (sources.length > 0) {
    return { level: 'ok', check: 'llm credentials', detail: sources.join(', ') };
  }
  return {
    level: 'error',
    check: 'llm credentials',
    detail: 'no DeepSeek API key visible to the resident instance — configure it once in the dsh Web UI (Settings → Models, works from the phone too) or set DEEPSEEK_API_KEY when starting the service',
  };
}

function defaultProbes(overrides = {}) {
  return {
    nodeVersion: process.versions.node,
    home: mobilePaths().home,
    findTailscale: () => findTailscale(),
    tailscaleStatus: () => tailscaleStatus(),
    tailscaleIp4: () => tailscaleIp4(),
    resolveDshBinary: () => resolveDshBinary(),
    dshVersion: () => null,
    checkPortFree,
    checkWritable,
    checkRelay,
    fetch: fetch,
    llmCredentials: () => checkLlmCredentials(),
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

  // dsh version + which upstream contract world we are in
  results.push(checkDshVersion(p.dshVersion()));

  // gateway + web ports free
  const gw = await p.checkPortFree(config && config.gatewayPort);
  results.push(
    gw.free
      ? { level: 'ok', check: 'gateway port', detail: `${config.gatewayPort} free` }
      : { level: 'error', check: 'gateway port', detail: `${config.gatewayPort}: ${gw.error}` },
  );
  const web = await p.checkPortFree(3080);
  results.push(
    web.free
      ? { level: 'ok', check: 'web port', detail: '3080 free' }
      : { level: 'error', check: 'web port', detail: `3080: ${web.error}` },
  );

  // mobile home writable
  const w = p.checkWritable(p.home);
  results.push(
    w.writable
      ? { level: 'ok', check: 'mobile home writable', detail: p.home }
      : { level: 'error', check: 'mobile home writable', detail: `${p.home}: ${w.error}` },
  );

  // llm credentials for the resident instance
  results.push(p.llmCredentials());

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
