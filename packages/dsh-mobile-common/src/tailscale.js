// Tailscale CLI integration. Wraps the platform `tailscale` binary via
// spawnSync (this is library code for the dsh process, not the sandboxed
// agent tool). All parse helpers defend against tailscale JSON schema drift.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { whichCommand } from './which.js';

export const TAILSCALE_CANDIDATES = {
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
};

/** @param {NodeJS.Platform} [platform] */
export function tailscaleCandidates(platform = process.platform) {
  return TAILSCALE_CANDIDATES[platform] || [];
}

/**
 * Locate the tailscale binary.
 * Order: `TAILSCALE_PATH` env, then per-platform well-known candidates, then
 * `tailscale` on PATH (resolved to an absolute path via which/where).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {typeof spawnSync} [spawnImpl] injectable for tests (PATH fallback)
 * @returns {string|null}
 */
export function findTailscale(env = process.env, platform = process.platform, spawnImpl = spawnSync) {
  if (env && env.TAILSCALE_PATH) return path.resolve(env.TAILSCALE_PATH);
  for (const candidate of tailscaleCandidates(platform)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return whichCommand('tailscale', platform, spawnImpl);
}

function notFoundMessage(env, platform) {
  const checked = [...tailscaleCandidates(platform), 'tailscale on PATH'];
  return `tailscale not found at ${checked.join(' or ')}; install tailscale or set TAILSCALE_PATH`;
}

/**
 * Run the tailscale binary.
 * @param {string[]} args
 * @param {{ timeoutMs?: number, bin?: string|null, env?: object, platform?: string, spawn?: Function }} [opts]
 * @returns {{ ok: boolean, stdout: string, stderr: string, status: number|null, error: string|null }}
 */
export function run(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const platform = opts.platform ?? process.platform;
  const spawnImpl = opts.spawn ?? spawnSync;
  const bin = opts.bin !== undefined ? opts.bin : findTailscale(opts.env, platform, spawnImpl);

  if (!bin) {
    return { ok: false, stdout: '', stderr: '', status: null, error: notFoundMessage(opts.env, platform) };
  }

  let res;
  try {
    res = spawnImpl(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', status: null, error: `failed to run tailscale: ${err.message}` };
  }

  const ok = !res.error && res.status === 0;
  let error = null;
  if (res.error) {
    error = res.error.message || String(res.error);
  } else if (!ok) {
    const signal = res.signal ? ` (signal ${res.signal})` : '';
    error = `tailscale ${args[0]} exited with status ${res.status}${signal}`;
  }
  return { ok, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? null, error };
}

/**
 * `tailscale status --json` parsed.
 * @returns {{ ok: boolean, json?: object, raw?: string, error?: string|null }}
 */
export function tailscaleStatus(opts = {}) {
  const r = run(['status', '--json'], opts);
  if (!r.ok) return { ok: false, raw: r.stdout, error: r.error };
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, raw: r.stdout, error: 'tailscale status returned invalid JSON' };
  }
}

/**
 * `tailscale ip -4`, trimmed. Returns null when tailscale is down.
 * @returns {string|null}
 */
export function tailscaleIp4(opts = {}) {
  const r = run(['ip', '-4'], opts);
  if (!r.ok) return null;
  const ip = r.stdout.trim();
  return ip || null;
}

/**
 * MagicDNS hostname from `tailscale status --json` (`Self.DNSName`),
 * trailing dot stripped. Returns null when unknown.
 * @returns {string|null}
 */
export function tailscaleHostname(opts = {}) {
  const s = tailscaleStatus(opts);
  if (!s.ok || !s.json) return null;
  const dns = s.json.Self && s.json.Self.DNSName;
  if (typeof dns !== 'string' || !dns) return null;
  return dns.replace(/\.$/, '');
}

/**
 * `tailscale ping <target>`.
 * @param {string} target
 * @returns {object} run result
 */
export function tailscalePing(target, opts = {}) {
  return run(['ping', target], opts);
}

/**
 * `tailscale up`. May require interactive login — returns the raw output.
 * @returns {object} run result
 */
export function tailscaleUp(opts = {}) {
  return run(['up'], opts);
}

/**
 * `tailscale serve status --json` parsed. May fail on old versions — degrades
 * gracefully to `{ ok: false }` instead of throwing.
 * @returns {{ ok: boolean, json?: object, raw?: string, error?: string|null }}
 */
export function tailscaleServeStatus(opts = {}) {
  const r = run(['serve', 'status', '--json'], opts);
  if (!r.ok) return { ok: false, raw: r.stdout, error: r.error };
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, raw: r.stdout, error: 'tailscale serve status returned invalid JSON' };
  }
}

/**
 * Enable `tailscale serve` HTTPS for the mobile gateway: the node's MagicDNS
 * name gets a Let's-Encrypt-backed cert and forwards :443 to the loopback
 * gateway. `--bg` keeps the config active across tailscaled restarts.
 *
 * When the tailnet has not enabled Serve yet, the CLI prints a one-time
 * enablement link and WAITS for the user — detect that instead of hanging:
 * the result then carries `needsTailnetEnablement: true` and `enableUrl`.
 */
export function tailscaleServeOn(targetPort = 3081, opts = {}) {
  const r = run(['serve', '--bg', '--https=443', `http://127.0.0.1:${targetPort}`], { ...opts, timeoutMs: opts.timeoutMs ?? 45000 });
  const combined = `${r.stdout}\n${r.stderr}`;
  const enableMatch = /https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9]+/.exec(combined);
  if (enableMatch) {
    return {
      ...r,
      ok: false,
      needsTailnetEnablement: true,
      enableUrl: enableMatch[0],
      error: 'tailscale Serve is not enabled on this tailnet',
    };
  }
  return r;
}

/** Disable the tailscale serve HTTPS mapping. */
export function tailscaleServeOff(opts = {}) {
  return run(['serve', '--https=443', 'off'], { ...opts, timeoutMs: opts.timeoutMs ?? 60000 });
}

/**
 * Whether `tailscale serve` is currently serving HTTPS for the gateway.
 * Defensive against the JSON shape drifting between tailscale versions.
 * @param {object} [opts]
 * @returns {boolean}
 */
export function isServeActive(opts = {}) {
  const status = tailscaleServeStatus(opts);
  if (!status.ok || !status.json) return false;
  const tcp443 = status.json.TCP && status.json.TCP['443'];
  const web443 = status.json.Web && status.json.Web['443'];
  return Boolean(tcp443?.HTTPS) || Boolean(web443?.HTTPS);
}
