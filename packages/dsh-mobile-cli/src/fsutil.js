// Atomic filesystem helpers shared by the CLI modules.
// All writes go through a temp file + rename so a crash mid-write never leaves
// a half-written JSON/pidfile behind.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomically write UTF-8 text to `filePath` (tmp file + rename).
 * Creates parent directories as needed.
 * @param {string} filePath
 * @param {string} text
 * @returns {string} the written path
 */
export function atomicWriteFile(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
  return filePath;
}

/**
 * Atomically write a JSON-serializable value as pretty-printed JSON.
 * @param {string} filePath
 * @param {unknown} value
 * @returns {string} the written path
 */
export function atomicWriteJson(filePath, value) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
