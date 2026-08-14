#!/usr/bin/env node
/**
 * Read-only analyzer for dsh session logs (session.jsonl.zstd).
 * Decodes the zstd-compressed log and reports seq continuity problems
 * (gaps / backward jumps = duplicated regions) with line numbers and context,
 * so a repair can be planned offline. NEVER modifies the input file.
 *
 * Usage: node scripts/analyze-session-log.mjs <path-to-session.jsonl.zstd>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/analyze-session-log.mjs <session.jsonl.zstd>');
  process.exit(2);
}

const compressed = fs.readFileSync(file);
let text;
try {
  text = zlib.zstdDecompressSync(compressed).toString('utf8');
} catch (error) {
  console.error(`zstd decode failed: ${error.message}`);
  process.exit(1);
}

const lines = text.split(/\r?\n/);
let anomalies = 0;
let lastSeq = null;
let lastLine = 0;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (line === '') continue;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.log(`line ${i + 1}: not JSON (${line.slice(0, 80)}...)`);
    continue;
  }
  const seq = parsed.seq ?? parsed.sequence ?? parsed.event?.seq;
  if (typeof seq !== 'number') continue;
  if (lastSeq !== null) {
    if (seq !== lastSeq + 1) {
      anomalies += 1;
      console.log(`ANOMALY at line ${i + 1}: expected ${lastSeq + 1}, got ${seq} (after line ${lastLine})`);
      // context
      console.log(`  prev: ${lines[lastLine - 1].slice(0, 200)}`);
      console.log(`  cur : ${line.slice(0, 200)}`);
    }
  }
  lastSeq = seq;
  lastLine = i + 1;
}

console.log(`\ntotal non-empty lines: ${lines.filter((l) => l !== '').length}`);
console.log(`seq anomalies: ${anomalies}`);
console.log(`last seq seen: ${lastSeq} (line ${lastLine})`);
