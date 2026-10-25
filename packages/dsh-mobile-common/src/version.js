// Upstream dsh release identity: parsing, ordering, and the version boundaries
// this solution branches on.
//
// Kept dependency-free and separate from doctor/service so both can use it
// without importing each other (doctor already imports service).
/** dsh releases this solution has been verified against. @see docs/research/upstream-0.2-impact.md */
export const VERIFIED_DSH_VERSIONS = ['0.1.0-rc.6', '0.2.1-rc.2'];

/**
 * First dsh release whose official web gates the browser index on a process
 * launch token (`dsh-client-connection` 0.1.2-rc.1). Our gateway performs the
 * token handshake, so both sides of this boundary are supported; it only
 * changes which behaviour `doctor` reports.
 */
export const LAUNCH_TOKEN_SINCE = '0.1.2-rc.1';

/**
 * First dsh release whose `dsh --profile web` accepts `--no-open`
 * (`dsh-web-app` 0.1.1-rc.1; 0.1.0-rc.x lacks it and would fail its own
 * command-line parse). The resident service passes the flag so a detached,
 * headless start does not pop a browser window on the host desktop.
 */
export const NO_OPEN_SINCE = '0.1.1-rc.1';

/**
 * Parse `major.minor.patch[-prerelease]` into comparable numbers.
 * @param {string} version raw version string
 * @returns {{ numbers: number[], prerelease: string[] }|null}
 */
export function parseDshVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version ?? '').trim());
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * SemVer ordering for dsh releases (a prerelease sorts before its release).
 * @param {string} a left version
 * @param {string} b right version
 * @returns {number} negative when a < b, 0 when equal or unparsable
 */
export function compareDshVersions(a, b) {
  const left = parseDshVersion(a);
  const right = parseDshVersion(b);
  if (left === null || right === null) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] - right.numbers[index];
  }
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
 * Whether this dsh accepts `--no-open` on its web profile command line.
 * An unknown version is treated as unsupported, which keeps the resident start
 * on the flags every release understands.
 * @param {string|null|undefined} version `dsh --version` output
 * @returns {boolean}
 */
export function supportsNoOpen(version) {
  if (parseDshVersion(version) === null) return false;
  return compareDshVersions(version, NO_OPEN_SINCE) >= 0;
}

/**
 * Whether this dsh gates the browser index on a launch token.
 * @param {string|null|undefined} version `dsh --version` output
 * @returns {boolean}
 */
export function needsLaunchToken(version) {
  if (parseDshVersion(version) === null) return false;
  return compareDshVersions(version, LAUNCH_TOKEN_SINCE) >= 0;
}
