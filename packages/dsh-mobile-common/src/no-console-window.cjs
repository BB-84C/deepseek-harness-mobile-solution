'use strict';
/**
 * no-console-window.cjs — force `CREATE_NO_WINDOW` on Windows child processes.
 *
 * WHY. The resident dsh instance is started detached (`detached: true` →
 * Windows `DETACHED_PROCESS`), so it owns no console. Windows then allocates a
 * brand-new — VISIBLE — console window for every console-subsystem child it
 * spawns: the agent's `pwsh -Command …` tool calls, `git`, `taskkill`, … That
 * is the flashing window users see while the resident instance runs.
 *
 * WHAT. Node's `windowsHide: true` maps to the `CREATE_NO_WINDOW` creation
 * flag, which suppresses that allocation entirely. This preload defaults
 * `windowsHide` to true for the spawn family unless a caller set it
 * explicitly, and nothing else changes: stdio, cwd, env, and argv pass
 * through untouched.
 *
 * HOW IT IS LOADED. `dsh --profile mobile service start` launches the resident
 * instance as `node --require <this file> <dsh bin.js> --profile web …` on
 * Windows only. A `--require` preload runs before any ESM module evaluates, so
 * the builtin named imports (`import { spawn } from 'node:child_process'`)
 * that dsh's subprocess layer snapshots at load time see the patched
 * functions. A later, in-process patch would NOT — builtin ESM named exports
 * are snapshotted on first import.
 *
 * SCOPE. POSIX systems are untouched (no such console-window problem). No
 * env var, no config, no effect on non-Windows platforms.
 */
if (process.platform !== 'win32') {
  module.exports = {};
} else {
  const cp = require('node:child_process');

  /** Mark an options object as already forced, so a double wrap is a no-op. */
  const FORCED = Symbol.for('dsh.mobile.noConsoleWindow');

  /**
   * Copy `options` with `windowsHide: true` unless the caller decided it.
   * @param {object|undefined} options spawn options (may be undefined)
   * @returns {object|undefined} options carrying the creation flag default
   */
  function hidden(options) {
    if (options === undefined || options === null) return { windowsHide: true };
    if (typeof options !== 'object') return options;
    if (options[FORCED] === true) return options;
    if (options.windowsHide !== undefined) return options;
    return Object.assign({}, options, { windowsHide: true, [FORCED]: true });
  }

  /** Wrap one exported spawn-family function: inject windowsHide into its options. */
  function wrapModuleFunction(name, optionsIndex) {
    const original = cp[name];
    if (typeof original !== 'function') return;
    const wrapped = function (...args) {
      args[optionsIndex] = hidden(args[optionsIndex]);
      return original.apply(this, args);
    };
    Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true });
    Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true });
    cp[name] = wrapped;
  }

  // Async and sync child APIs: (command, args?, options?), (file, args?, options?), (command, options?).
  for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork']) {
    wrapModuleFunction(name, 2);
  }

  // Lowest-level funnel: every async ChildProcess goes through this even when a
  // caller reached it through an already-captured reference.
  const ChildProcess = cp.ChildProcess;
  if (ChildProcess && typeof ChildProcess.prototype.spawn === 'function') {
    const originalSpawn = ChildProcess.prototype.spawn;
    ChildProcess.prototype.spawn = function (options) {
      return originalSpawn.call(this, hidden(options));
    };
  }

  module.exports = { windowsHide: true };
}
