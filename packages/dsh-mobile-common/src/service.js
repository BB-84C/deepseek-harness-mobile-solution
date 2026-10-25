// Resident-service management: start/stop/status/restart/logs for the
// persistent local dsh web instance (the mobile gateway lives inside it).
//
// SAFETY (user red line): stop/restart must NEVER kill a non-mobile dsh
// instance. Before killing we require a per-instance sidecar written by the
// gateway plugin ($DSH_HOME/mobile/instances/<pid>.json) whose {pid, token}
// matches the pidfile. A missing/mismatched sidecar means the pid may belong
// to an unrelated dsh instance and stop() refuses loudly.
//
// The command-line entry (commands.js) calls the synchronous top-level
// exports (startService/stopService/serviceStatus/serviceLogs). The factory
// createService() + pure helpers are the testable core.
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobilePaths } from './home.js';
import { atomicWriteJson } from './fsutil.js';
import { whichCommand } from './which.js';
import { supportsNoOpen } from './version.js';

/**
 * Absolute path of the Windows "no console window" preload.
 *
 * The resident instance is spawned detached, so it owns no console; Windows
 * then allocates a VISIBLE console window for every console-subsystem child it
 * spawns (the agent's `pwsh` tool calls, git, taskkill, …). Preloading this
 * shim with `--require` makes every spawn in that process pass
 * `windowsHide: true` (CREATE_NO_WINDOW). See src/no-console-window.cjs.
 *
 * A `--require` preload is required rather than an in-process patch: builtin
 * ESM named imports (`import { spawn } from 'node:child_process'`, which is how
 * dsh's subprocess layer imports it) are snapshotted on first import, so a
 * later monkey-patch would be invisible.
 */
export const NO_CONSOLE_WINDOW_SHIM = fileURLToPath(new URL('./no-console-window.cjs', import.meta.url));

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing without spawning anything)
// ---------------------------------------------------------------------------

/**
 * Is a pid currently alive? signal 0 probes without delivering a signal.
 * @param {number|null} pid
 * @param {NodeJS.Platform} [platform]
 * @param {Function} [killImpl]
 * @returns {boolean}
 */
export function isPidAlive(pid, platform = process.platform, killImpl = process.kill) {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission → still alive.
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * Verify a pidfile against its sidecar. This is the kill-safety gate.
 * @param {{ pidfile?: object|null, sidecar?: object|null }} input
 * @returns {{ valid: boolean, reason: string }}
 */
export function verifyPidfile({ pidfile, sidecar } = {}) {
  if (!pidfile || typeof pidfile !== 'object') return { valid: false, reason: 'no-pidfile' };
  if (!sidecar || typeof sidecar !== 'object') return { valid: false, reason: 'missing-sidecar' };
  if (sidecar.pid !== pidfile.pid) return { valid: false, reason: 'pid-mismatch' };
  if (sidecar.token !== pidfile.token) return { valid: false, reason: 'token-mismatch' };
  return { valid: true, reason: 'ok' };
}

const REASON_TEXT = {
  'no-pidfile': 'no pidfile present',
  'missing-sidecar': 'no instance sidecar found',
  'pid-mismatch': 'sidecar pid does not match the pidfile',
  'token-mismatch': 'sidecar token does not match the pidfile',
};

/**
 * Loud refusal message shown when stop() refuses to kill a pid.
 * @param {number} pid
 * @param {string} reason
 * @returns {string}
 */
export function refusalMessage(pid, reason) {
  const detail = REASON_TEXT[reason] || reason || 'unknown reason';
  return (
    `Refusing to stop process ${pid}: ${detail}. ` +
    `This pid may belong to a NON-mobile dsh instance and will NOT be killed. ` +
    `If you are certain it is safe, stop it manually ` +
    `(POSIX: \`kill ${pid}\`; Windows: \`taskkill /PID ${pid} /T /F\`).`
  );
}

/** @param {string} pidFilePath @returns {object|null} */
export function readPidFile(pidFilePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // missing or corrupt → treat as absent (never kill unverified)
  }
}

/** @param {string} instancesDir @param {number} pid @returns {object|null} */
export function readSidecar(instancesDir, pid) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(instancesDir, `${pid}.json`), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the last N lines of a log file.
 * @param {string} logPath
 * @param {number} [tailN]
 * @returns {string[]}
 */
export function readLogTail(logPath, tailN = 50) {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-Math.max(0, tailN));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Resolve the real dsh CLI binary.
 * Order: `DSH_BIN` env (explicit) → `dsh` on PATH (where/which).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {Function} [spawnImpl]
 * @returns {string|null}
 */
export function resolveDshBinary(env = process.env, platform = process.platform, spawnImpl = nodeSpawnSync) {
  if (env && env.DSH_BIN) return path.resolve(env.DSH_BIN);
  const found = whichCommand('dsh', platform, spawnImpl);
  if (found === null || platform !== 'win32') return found;
  // `where.exe dsh` lists the extensionless sh shim first on Windows; that file
  // is a POSIX script and spawning it fails. Prefer the cmd/exe sibling, which
  // CreateProcess can actually execute.
  if (path.extname(found) !== '') return found;
  for (const extension of ['.cmd', '.exe', '.ps1']) {
    const candidate = `${found}${extension}`;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable candidates
    }
  }
  return found;
}

/**
 * The dsh CLI's JavaScript entry, when the resolved binary is an npm shim.
 *
 * The npm global layout puts `dsh`/`dsh.cmd` beside
 * `node_modules/@deepseek-ai/dsh/lib/bin.js`; running that entry with the
 * current node avoids batch-file quoting entirely (used both for the
 * `--version` probe and for the resident spawn).
 * @param {string} bin resolved `dsh` binary
 * @returns {string|null} absolute path of lib/bin.js, or null when unknown
 */
export function resolveDshEntry(bin) {
  if (typeof bin !== 'string' || bin === '') return null;
  try {
    if (/\.js$/i.test(bin)) return bin;
    const entry = path.join(path.dirname(bin), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Read the installed dsh version by asking the launcher itself.
 * @param {{ env?: object, platform?: NodeJS.Platform, spawnImpl?: Function }} [options]
 * @returns {string|null} e.g. "0.2.1-rc.2", or null when unavailable
 */
export function readDshVersion(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? nodeSpawnSync;
  const bin = resolveDshBinary(env, platform, spawnImpl);
  if (bin === null) return null;
  const spawnOptions = { encoding: 'utf8', timeout: 20000, windowsHide: true };
  try {
    const entry = resolveDshEntry(bin);
    let result;
    if (entry !== null) result = spawnImpl(process.execPath, [entry, '--version'], spawnOptions);
    else if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      // A batch shim cannot be spawned directly; cmd.exe resolves it. `/s` is
      // omitted on purpose — it would require the nested-quote form that cmd
      // then rejects for a quoted path.
      result = spawnImpl(env.ComSpec || 'cmd.exe', ['/d', '/c', `${bin} --version`], spawnOptions);
    } else result = spawnImpl(bin, ['--version'], spawnOptions);
    const text = `${(result && result.stdout) ?? ''}${(result && result.stderr) ?? ''}`.trim();
    const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(text);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * npm package carrying the browser-based directory-picker dialog.
 *
 * On dsh >= 0.2 the picker's browser half lives in its own package, discovered
 * through its `dsh.client` declaration; the host row
 * (`dsh-host-directory-picker-browse`) provides only the filesystem primitives.
 * Without it a mobile browser has no dialog at all, so the workspace flow
 * cannot ask for a directory.
 */
export const PICKER_UI_PACKAGE = '@deepseek-ai/dsh-client-ui-directory-picker-browse';

/**
 * Whether the running dsh installation ships the browse-picker dialog package.
 * Older releases predate it and must not get a composed row referencing it.
 * @param {string} bin resolved `dsh` binary
 * @returns {boolean}
 */
export function hasPickerUi(bin) {
  const entry = resolveDshEntry(bin);
  if (entry === null) return false;
  const segments = PICKER_UI_PACKAGE.split('/');
  // The dsh package directory itself (`…/@deepseek-ai/dsh`) and the project
  // root that owns the first `node_modules` in the path (npm) — pnpm keeps the
  // package's own dependencies beside it instead.
  const packageDir = path.dirname(path.dirname(entry));
  const parts = entry.split(path.sep);
  const nodeModulesIndex = parts.indexOf('node_modules');
  const installRoot = nodeModulesIndex > 0 ? parts.slice(0, nodeModulesIndex).join(path.sep) : null;
  const candidates = [path.join(packageDir, 'node_modules', ...segments, 'package.json')];
  if (installRoot !== null) {
    candidates.push(
      path.join(installRoot, 'node_modules', ...segments, 'package.json'),
      path.join(installRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'node_modules', ...segments, 'package.json'),
    );
  }
  return candidates.some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

/**
 * The newest authenticated desktop URL the resident web printed
 * (`dsh web: http://127.0.0.1:3080/?token=...`).
 *
 * dsh >= 0.1.2-rc.1 gates the loopback index on a per-process launch token, and
 * the resident instance starts with `--no-open`, so this URL is the only
 * automatic hand-off for THIS machine's browser (the phone goes through the
 * gateway's own handshake instead).
 * @param {string} logText tail of the resident service log
 * @returns {string|null} the token URL, or null when the log has none
 */
export function latestDesktopUrl(logText) {
  if (typeof logText !== 'string' || logText === '') return null;
  const pattern = /dsh web: (https?:\/\/[^\s]+[?&]token=[^\s]+)/g;
  let newest = null;
  for (const match of logText.matchAll(pattern)) newest = match[1];
  return newest;
}

/**
 * Async gateway health check (fetch). Reference implementation with a 2s
 * timeout; returns true on any HTTP response, false on any error.
 * @param {number} port
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function checkGateway(port, { fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  if (port == null) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetchImpl(`http://127.0.0.1:${port}/mobile/health`, { signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Synchronous gateway health check: runs the same `fetch` probe in a short
 * child node process so the CLI can report reachability without awaiting.
 * @param {number} port
 * @param {{ spawnImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {boolean}
 */
export function checkGatewaySync(port, { spawnImpl = nodeSpawnSync, timeoutMs = 2000 } = {}) {
  if (port == null) return false;
  const script =
    `fetch('http://127.0.0.1:${port}/mobile/health',{signal:AbortSignal.timeout(${timeoutMs})})` +
    `.then(()=>process.exit(0)).catch(()=>process.exit(1));`;
  try {
    const res = spawnImpl(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: timeoutMs + 1000,
      windowsHide: true,
    });
    return Boolean(res && res.status === 0);
  } catch {
    return false;
  }
}

/** Blocking sleep (bounded waits only). Falls back to a spin loop. */
export function syncSleep(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // spin
    }
  }
}

// ---------------------------------------------------------------------------
// Service factory (testable core)
// ---------------------------------------------------------------------------

/**
 * Read a variable from the Windows registry environment scopes
 * (HKLM machine scope, then HKCU user scope) — the system environment the
 * user expects to "pass through". A stale shell (opened before the variable
 * was set) misses machine-level vars in its snapshot, so this fallback makes
 * the launcher independent of shell freshness.
 * @param {string} name
 * @param {Function} spawnImpl - spawnSync-like
 * @returns {string|null} trimmed value, or null
 */
export function readWindowsEnv(name, spawnImpl = nodeSpawnSync) {
  const scopes = [
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', name],
    ['query', 'HKCU\\Environment', '/v', name],
  ];
  for (const args of scopes) {
    let res;
    try {
      res = spawnImpl('reg', args, { encoding: 'utf8', windowsHide: true });
    } catch {
      continue;
    }
    if (res && res.status === 0) {
      const match = /\sREG(?:_EXPAND)?_SZ\s+(.+)$/m.exec(res.stdout ?? '');
      if (match) return match[1].trim();
    }
  }
  return null;
}

/**
 * Resolve the launch environment for the resident instance. Inherits the
 * launching process environment; on Windows, falls back to the registry
 * scopes for DEEPSEEK_API_KEY so a stale shell snapshot cannot strip the key.
 * @returns {{ env: object, fallbackKey: boolean }}
 */
function buildChildEnv(env, platform, spawnImpl, extra) {
  const childEnv = { ...env, ...extra };
  if (platform === 'win32' && !childEnv.DEEPSEEK_API_KEY) {
    const fromRegistry = readWindowsEnv('DEEPSEEK_API_KEY', spawnImpl);
    if (fromRegistry) {
      childEnv.DEEPSEEK_API_KEY = fromRegistry;
      return { env: childEnv, fallbackKey: true };
    }
  }
  return { env: childEnv, fallbackKey: false };
}
export function createService(deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    paths = () => mobilePaths(env),
    now = () => Date.now(),
    randomToken = () => randomBytes(16).toString('hex'),
    spawnImpl = nodeSpawn,
    spawnSyncImpl = nodeSpawnSync,
    killImpl = process.kill,
    sleepImpl = syncSleep,
    gatewayProbe = (port) => checkGatewaySync(port, { spawnImpl: spawnSyncImpl }),
    // Installed dsh version, used to pick only the web-profile flags that
    // release understands (an unknown version gets the conservative set).
    dshVersionImpl = () => readDshVersion({ env, platform, spawnImpl: spawnSyncImpl }),
  } = deps;

  const pidFilePath = () => paths().pidFilePath;
  const instancesDir = () => paths().instancesDir;
  const defaultLogPath = () => path.join(paths().logsDir, 'service.log');

  function clearPidFile() {
    try {
      fs.unlinkSync(pidFilePath());
    } catch {
      // already gone
    }
  }

  function isRunning() {
    const pf = readPidFile(pidFilePath());
    if (!pf) return false;
    return isPidAlive(pf.pid, platform, killImpl);
  }

  function spawnDetached(bin, args, logPath, childEnv) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.mkdirSync(instancesDir(), { recursive: true });
    const fd = fs.openSync(logPath, 'a');
    try {
      return spawnImpl(bin, args, {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: childEnv,
      });
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // child keeps its own handle
      }
    }
  }

  /**
   * Start the resident dsh web instance (detached). Synchronous.
   * @param {{ config: object, logPath?: string, authorities?: string[] }} params
   * @returns {object}
   */
  function start({ config, logPath = defaultLogPath(), authorities = [] } = {}) {
    if (!config) return { ok: false, error: 'config is required' };
    if (isRunning()) {
      const pf = readPidFile(pidFilePath());
      return { ok: false, alreadyRunning: true, pid: pf ? pf.pid : null, error: `service already running (pid ${pf ? pf.pid : null})` };
    }
    const bin = resolveDshBinary(env, platform, spawnSyncImpl);
    if (!bin) return { ok: false, error: 'dsh binary not found; set DSH_BIN or add dsh to PATH' };
    if (!fs.existsSync(bin)) return { ok: false, error: `dsh binary not found at ${bin}` };

    const token = randomToken();
    // npm's Windows shims (dsh.cmd / dsh.ps1 / the extensionless `dsh`) cannot
    // be spawned detached without a shell. When we run inside dsh ourselves,
    // process.argv[1] is the real JS entry — spawn it with the current node
    // executable instead. An explicit DSH_BIN is trusted as-is.
    let launchBin = bin;
    const args = [];
    if (platform === 'win32' && !env?.DSH_BIN && process.argv[1]) {
      // A detached instance owns no console, so Windows would allocate a
      // visible console window for every child it spawns. The preload turns
      // every spawn in that process into CREATE_NO_WINDOW. Guarded: a missing
      // shim must not stop the resident instance from starting.
      let shim = null;
      try {
        if (fs.existsSync(NO_CONSOLE_WINDOW_SHIM)) shim = NO_CONSOLE_WINDOW_SHIM;
      } catch {
        shim = null;
      }
      if (shim !== null) args.push('--require', shim);
      args.push(process.argv[1]);
      launchBin = process.execPath;
    }
    args.push('--profile', 'web');
    // The resident instance ALWAYS owns the official port 3080 (one-instance
    // principle). No config knob exists on purpose: a second dsh web on 3090
    // would reintroduce the split-brain that corrupts live session logs.
    for (const authority of authorities || []) {
      args.push('--trusted-host', authority);
    }
    // No browser handoff on the host desktop: a resident start must not open a
    // window (the mobile UI is reached through the gateway, and this machine's
    // own browser gets the authenticated URL from `service start` output).
    // Only releases that know the flag accept it (dsh-web-app >= 0.1.1-rc.1).
    const version = dshVersionImpl();
    if (supportsNoOpen(version)) args.push('--no-open');
    // The browse directory picker's dialog is its own package on dsh >= 0.2;
    // the bundle patch composes that row only when this flag says it exists.
    const pickerUi = hasPickerUi(bin);
    const { env: childEnv, fallbackKey } = buildChildEnv(env, platform, spawnSyncImpl, {
      DSH_MOBILE_INSTANCE: '1',
      DSH_MOBILE_TOKEN: token,
      DSH_MOBILE_GATEWAY_PORT: String(config.gatewayPort ?? 3081),
      ...(pickerUi ? { DSH_MOBILE_PICKER_UI: '1' } : {}),
    });
    try {
      const envHas = Boolean(env && typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.length > 0);
      const registryHas = platform === 'win32' ? (fallbackKey ? 'yes (used)' : 'no') : 'n/a';
      fs.appendFileSync(
        logPath,
        `[dsh-mobile-cli] start: DEEPSEEK_API_KEY in launching shell env: ${envHas}; in Windows registry: ${registryHas}; child gets key: ${Boolean(childEnv.DEEPSEEK_API_KEY)}; picker dialog ui: ${pickerUi}\n`,
      );
    } catch {
      // log may be gone
    }
    if (fallbackKey) {
      try {
        fs.appendFileSync(logPath, '[dsh-mobile-cli] DEEPSEEK_API_KEY not present in this shell — inherited from the Windows registry (machine/user environment)\n');
      } catch {
        // log may be gone
      }
    }

    let child;
    try {
      child = spawnDetached(launchBin, args, logPath, childEnv);
    } catch (err) {
      return { ok: false, error: `failed to spawn dsh: ${err.message}` };
    }

    if (child && typeof child.on === 'function') {
      child.on('error', (err) => {
        try {
          fs.appendFileSync(logPath, `[dsh-mobile-cli] spawn error: ${err.message}\n`);
        } catch {
          // log may be gone
        }
      });
    }

    const pid = child && child.pid;
    if (pid == null) return { ok: false, error: 'spawned process has no pid' };

    const pf = { pid, startedAt: now(), token, cmdline: `${launchBin} ${args.join(' ')}` };
    atomicWriteJson(pidFilePath(), pf);
    if (typeof child.unref === 'function') child.unref();
    return { ok: true, pid, startedAt: pf.startedAt, token, cmdline: pf.cmdline };
  }

  function terminateProcess(pid) {
    if (platform === 'win32') {
      try {
        spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        // taskkill missing — nothing more we can do
      }
      sleepImpl(200);
      return;
    }
    try {
      killImpl(pid, 'SIGTERM');
    } catch {
      // already gone
    }
    const deadline = now() + 5000;
    while (isPidAlive(pid, platform, killImpl) && now() < deadline) {
      sleepImpl(200);
    }
    if (isPidAlive(pid, platform, killImpl)) {
      try {
        killImpl(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  /**
   * Stop the resident service — only after pidfile↔sidecar verification.
   * Synchronous.
   * @returns {object}
   */
  function stop() {
    const pf = readPidFile(pidFilePath());
    if (!pf) return { ok: true, status: 'not-running', pid: null };
    const pid = pf.pid;
    if (!isPidAlive(pid, platform, killImpl)) {
      clearPidFile();
      return { ok: true, status: 'stale-cleared', pid };
    }
    const sidecar = readSidecar(instancesDir(), pid);
    const verdict = verifyPidfile({ pidfile: pf, sidecar });
    if (!verdict.valid) {
      return { ok: false, status: 'refused', pid, error: refusalMessage(pid, verdict.reason) };
    }
    terminateProcess(pid);
    clearPidFile();
    return { ok: true, status: 'stopped', pid };
  }

  /**
   * Resident-service status (synchronous).
   * @param {{ gatewayPort?: number }} [params]
   * @returns {{ running: boolean, pid: number|null, startedAt: number|null, gatewayReachable: boolean }}
   */
  function status({ gatewayPort } = {}) {
    const pf = readPidFile(pidFilePath());
    if (!pf) return { running: false, pid: null, startedAt: null, gatewayReachable: false };
    if (!isPidAlive(pf.pid, platform, killImpl)) {
      return { running: false, pid: null, startedAt: null, gatewayReachable: false };
    }
    const gatewayReachable = gatewayProbe(gatewayPort);
    return { running: true, pid: pf.pid, startedAt: pf.startedAt, gatewayReachable };
  }

  /**
   * Stop then start (synchronous). Never starts a second instance on refusal.
   * @param {object} params
   * @returns {object}
   */
  function restart(params = {}) {
    const stopRes = stop();
    if (!stopRes.ok) return stopRes;
    return start(params);
  }

  /**
   * @param {number} [tailN]
   * @param {string} [logPath]
   * @returns {string[]}
   */
  function logs(tailN = 50, logPath = defaultLogPath()) {
    return readLogTail(logPath, tailN);
  }

  return { isRunning, start, stop, status, restart, logs, pidFilePath, instancesDir, defaultLogPath };
}

// ---------------------------------------------------------------------------
// Default singleton + command-line-facing exports (the contract commands.js
// imports). All synchronous so the CLI can use them directly.
// ---------------------------------------------------------------------------

let _defaultService;
function defaultService() {
  if (!_defaultService) _defaultService = createService();
  return _defaultService;
}

/**
 * @param {{ config: object, authorities?: string[], logPath?: string }} params
 * @param {object} [svc]
 * @returns {{ started: boolean, alreadyRunning: boolean, pid: number|null, startedAt?: number, token?: string, error: string|null }}
 */
export function startService(params = {}, svc = defaultService()) {
  const r = svc.start(params);
  if (r.ok) {
    return { started: true, alreadyRunning: false, pid: r.pid, startedAt: r.startedAt, token: r.token, error: null };
  }
  return { started: false, alreadyRunning: Boolean(r.alreadyRunning), pid: r.alreadyRunning ? r.pid : null, error: r.error };
}

/**
 * @param {object} [_params]
 * @param {object} [svc]
 * @returns {{ stopped: boolean, pid: number|null, error: string|null }}
 */
export function stopService(_params = {}, svc = defaultService()) {
  const r = svc.stop();
  if (r.ok) return { stopped: r.status === 'stopped', pid: r.pid, error: null };
  return { stopped: false, pid: r.pid, error: r.error };
}

/**
 * @param {{ config?: object }} [params]
 * @param {object} [svc]
 * @returns {{ running: boolean, pid: number|null, startedAt: number|null, gatewayReachable: boolean }}
 */
export function serviceStatus({ config } = {}, svc = defaultService()) {
  return svc.status({ gatewayPort: config ? config.gatewayPort : undefined });
}

/**
 * @param {{ logPath?: string, tail?: number }} [params]
 * @param {object} [svc]
 * @returns {string[]}
 */
export function serviceLogs({ logPath, tail = 50 } = {}, svc = defaultService()) {
  return svc.logs(tail, logPath);
}

/**
 * @param {{ config: object, authorities?: string[], logPath?: string }} params
 * @param {object} [svc]
 * @returns {object}
 */
export function restartService(params = {}, svc = defaultService()) {
  const stopped = stopService({}, svc);
  if (stopped.error) return { stopped: false, started: false, pid: stopped.pid, error: stopped.error };
  const started = startService(params, svc);
  return { stopped: true, started: started.started, pid: started.pid, error: started.error };
}

// Convenience default singleton (process-env bound).
export const service = createService();
