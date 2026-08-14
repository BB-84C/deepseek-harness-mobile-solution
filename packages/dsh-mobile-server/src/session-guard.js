/**
 * Session-live guard: prevents the cross-instance resume race that corrupts
 * session logs ("seq gap in committed region").
 *
 * dsh session logs are single-writer. When the phone (attached to the
 * resident instance) opens a session whose log is being actively written by
 * ANOTHER dsh instance (the desktop's), the official resume path races that
 * writer and can corrupt the log permanently.
 *
 * Heuristic (cheap, no dsh internals):
 *  - A session is DANGEROUS to open from here when BOTH
 *    1. it is not live in OUR session store (`sessions.get(id)` undefined), and
 *    2. its persisted log (a file/dir named <sessionId> under
 *       $DSH_HOME/sessions) was modified within the last WINDOW_MS —
 *       i.e. something else is writing it RIGHT NOW.
 *  - Once the other instance stops writing (its run finished or it closed),
 *    the log goes stale and the session becomes safely openable from here.
 */

import fs from 'node:fs';
import path from 'node:path';

const WINDOW_MS = 10_000;
const MAX_DEPTH = 4;

export function findSessionLog(dshHome, sessionId) {
  const root = path.join(dshHome, 'sessions');
  const stack = [root];
  const candidates = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name === sessionId) candidates.push(full);
      if (entry.isDirectory() && full.split(path.sep).length - root.split(path.sep).length < MAX_DEPTH) {
        stack.push(full);
      }
    }
  }
  return candidates[0] ?? null;
}

/**
 * Freshness of a session log: the newest mtime among its files. The session
 * directory's OWN mtime is useless here — appends to an existing log file do
 * not update it, while the sharded layout adds files rarely.
 */
function logMtimeMs(logPath) {
  let best = 0;
  const stat = (p) => {
    try {
      best = Math.max(best, fs.statSync(p).mtimeMs);
    } catch {
      /* ignore */
    }
  };
  let isDir = false;
  try {
    isDir = fs.statSync(logPath).isDirectory();
  } catch {
    return null;
  }
  if (!isDir) {
    stat(logPath);
    return best === 0 ? null : best;
  }
  const stack = [logPath];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && full.split(path.sep).length - logPath.split(path.sep).length < 2) {
        stack.push(full);
      } else {
        stat(full);
      }
    }
  }
  return best === 0 ? null : best;
}

/**
 * @param {object} deps
 * @param {string} deps.dshHome  harness home ($DSH_HOME)
 * @param {{ get(id: string): unknown }} deps.sessions  the live session store
 * @param {number} [deps.windowMs]  freshness window (default 10s)
 * @param {() => number} [deps.now]
 * @returns {Promise<{ safe: boolean, reason: string }>}
 */
export async function checkResumeSafe(deps, sessionId) {
  const { dshHome, sessions, windowMs = WINDOW_MS, now = () => Date.now() } = deps;
  if (typeof sessionId !== 'string' || sessionId === '') return { safe: true, reason: 'no-session' };
  if (sessions?.get?.(sessionId) !== undefined) return { safe: true, reason: 'live-here' };
  const logPath = findSessionLog(dshHome, sessionId);
  if (logPath === null) return { safe: true, reason: 'unknown-session' };
  const mtimeMs = logMtimeMs(logPath);
  if (mtimeMs === null) return { safe: true, reason: 'stat-failed' };
  if (now() - mtimeMs < windowMs) {
    return {
      safe: false,
      reason:
        'this session is being written right now by another dsh instance (probably the desktop one); ' +
        'opening it from here would race its writer and can corrupt the log — wait for that run to finish and try again',
    };
  }
  return { safe: true, reason: 'stale-log' };
}
