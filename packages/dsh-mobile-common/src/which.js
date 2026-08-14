// Cross-platform "which" lookup used to resolve bare command names on PATH.
// Uses `where.exe` on Windows and `which` on POSIX, both via spawnSync so the
// result is a concrete absolute path (no shell involved).
import { spawnSync } from 'node:child_process';

/**
 * Resolve a command name to its first absolute path on PATH.
 * @param {string} name command name (e.g. "dsh", "tailscale")
 * @param {NodeJS.Platform} [platform]
 * @param {typeof spawnSync} [spawnImpl] injectable for tests
 * @returns {string|null} absolute path, or null when not found
 */
export function whichCommand(name, platform = process.platform, spawnImpl = spawnSync) {
  try {
    if (platform === 'win32') {
      const r = spawnImpl('where.exe', [name], { encoding: 'utf8' });
      if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) {
        return r.stdout.trim().split(/\r?\n/)[0].trim();
      }
    } else {
      const r = spawnImpl('which', [name], { encoding: 'utf8' });
      if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) {
        return r.stdout.trim().split(/\r?\n/)[0].trim();
      }
    }
  } catch {
    // treat any spawn failure as "not found"
  }
  return null;
}
