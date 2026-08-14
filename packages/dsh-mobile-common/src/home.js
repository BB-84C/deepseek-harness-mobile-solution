// Mobile home directory resolution + path helpers.
//
// Everything this CLI writes lives under the "mobile home" directory and
// nowhere else. Precedence for the base:
//   1. `MOBILE_HOME`  — explicit full override: the mobile directory itself.
//   2. `DSH_HOME`     — dsh home; mobile home is `<DSH_HOME>/mobile`.
//   3. `~/.dsh`       — default dsh home; mobile home is `~/.dsh/mobile`.
//
// Layout under the mobile home:
//   config/config.json   config store (configPath)
//   pid.json             resident-service pidfile (pidFilePath)
//   logs/                resident-service logs (logsDir)
//   data/devices.json    paired-device store (devicesPath)
//   data/pairings.json   pending pairing codes (pairingsPath)
//   instances/           per-instance sidecars `<pid>.json` (instancesDir)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homedir]
 * @returns {string} absolute path to the mobile home directory
 */
export function resolveMobileHome(env = process.env, homedir = os.homedir()) {
  if (env && env.MOBILE_HOME) return path.resolve(env.MOBILE_HOME);
  const base = (env && env.DSH_HOME) || path.join(homedir, '.dsh');
  return path.join(base, 'mobile');
}

/**
 * All mobile paths, derived from a single env/homedir snapshot.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homedir]
 * @returns {object}
 */
export function mobilePaths(env = process.env, homedir = os.homedir()) {
  const home = resolveMobileHome(env, homedir);
  return {
    home,
    configDir: path.join(home, 'config'),
    configPath: path.join(home, 'config', 'config.json'),
    pidFilePath: path.join(home, 'pid.json'),
    logsDir: path.join(home, 'logs'),
    dataDir: path.join(home, 'data'),
    devicesPath: path.join(home, 'data', 'devices.json'),
    pairingsPath: path.join(home, 'data', 'pairings.json'),
    instancesDir: path.join(home, 'instances'),
  };
}

export function configPath(env, homedir) {
  return mobilePaths(env, homedir).configPath;
}

export function pidFilePath(env, homedir) {
  return mobilePaths(env, homedir).pidFilePath;
}

export function logsDir(env, homedir) {
  return mobilePaths(env, homedir).logsDir;
}

export function devicesPath(env, homedir) {
  return mobilePaths(env, homedir).devicesPath;
}

export function instancesDir(env, homedir) {
  return mobilePaths(env, homedir).instancesDir;
}

/**
 * Create every directory the CLI needs and return the resolved paths.
 * Creates the home, config/, logs/, data/ and instances/ directories.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homedir]
 * @returns {object} the result of `mobilePaths`
 */
export function ensureMobileDirs(env = process.env, homedir = os.homedir()) {
  const p = mobilePaths(env, homedir);
  for (const dir of [p.home, p.configDir, p.logsDir, p.dataDir, p.instancesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}
