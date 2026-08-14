#!/usr/bin/env node
/**
 * repair-session.cjs — diagnose and repair dsh session-log corruption caused
 * by concurrent writers (two dsh instances appending the same session.jsonl.zstd).
 *
 * What it fixes: the dual-writer overlap pattern, where a stale writer inserted
 * a block of events whose `seq` range duplicates events already committed by
 * the surviving writer. The surviving tail (everything from the first mismatch
 * onward) is itself contiguous, so dropping the stale block heals the log.
 *
 * Modes:
 *   check [path]             report health of one file, one directory, or all
 *                            sessions under $DSH_HOME/sessions (default).
 *                            Exit code: 0 healthy, 1 corrupt, 2 other error.
 *   repair <file.zstd>       back up (<file>.corrupt-<ts>.bak), drop the stale
 *                            block, verify, and write the repaired log back.
 *   repair --dry-run <file>  same, but write to <file>.repaired.zstd and leave
 *                            the original untouched.
 *
 * Safety: never mutates the original without a timestamped backup; refuses to
 * write unless the repaired log passes full seq-contiguity + turn-flow checks.
 * Exit code for repair: 0 repaired, 1 could not repair (manual help needed),
 * 2 other error.
 *
 * No dependencies beyond Node's built-ins (node:zlib zstd support, Node >= 22).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zstdCompressSync, zstdDecompressSync, constants } = require('node:zlib');

const ZSTD_MAGIC = 4247762216;
const CHUNK_ROWS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

// ---------- zstd frame scanning (mirrors dsh-session-persistence-jsonl) ----------
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

function decompress(file) {
  const buf = fs.readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(buf);
  let plain = Buffer.alloc(0);
  for (const f of frames) plain = Buffer.concat([plain, zstdDecompressSync(buf.subarray(f.start, f.end))]);
  return { plain, frames: frames.length, tornStart };
}

/**
 * dsh boot contract (assertZstdHeaderFrame in dsh-session-persistence-jsonl):
 * the FIRST frame of a session log must decode to exactly one header line.
 * A whole-file single frame violates this and crashes dsh at boot with
 * "corrupt Zstandard session log: first frame is not exactly one header line"
 * even though every content check passes. Returns the violation, or null.
 */
function firstFrameViolation(file) {
  const buf = fs.readFileSync(file);
  if (buf.length === 0) return 'empty file';
  const { frames } = scanZstdFrames(buf, 1);
  if (frames.length === 0) return 'no complete first frame (torn)';
  const plain = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end));
  if (plain.length === 0 || plain.indexOf(10) !== plain.length - 1) {
    return `first frame is not exactly one header line (decodes to ${plain.length} bytes)`;
  }
  return null;
}

const BODY_FRAME_BUDGET = 1024 * 1024; // 1 MiB plaintext per body frame

/**
 * Encode content in dsh's required frame layout: frame 1 = header line only,
 * remaining lines follow in whole-line chunks. Single-frame whole-file
 * compression is what historically broke dsh boot after a repair.
 */
function compress(plain) {
  const checksumOpts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  const nl = plain.indexOf(10);
  if (nl === -1) throw new Error('no newline in repaired content');
  const frames = [zstdCompressSync(plain.subarray(0, nl + 1), checksumOpts)];
  let start = nl + 1;
  while (start < plain.length) {
    let end = Math.min(plain.length, start + BODY_FRAME_BUDGET);
    if (end < plain.length) {
      const nlAt = plain.lastIndexOf(10, end - 1);
      if (nlAt === -1 || nlAt < start) throw new Error('no line boundary within budget window');
      end = nlAt + 1;
    }
    frames.push(zstdCompressSync(plain.subarray(start, end), checksumOpts));
    start = end;
  }
  return Buffer.concat(frames);
}

// ---------- chunk-row expansion (mirrors dsh-session decodeStorageRecord) ----------
function decodeRow(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return [rec];
  if (!CHUNK_ROWS.has(rec.type)) return [rec];
  const payload = rec.type === 'tool-call-chunks' ? rec?.data?.args : rec?.data?.texts;
  if (!Number.isSafeInteger(rec.seq0) || !Array.isArray(payload) || payload.length === 0) {
    throw new Error(`malformed ${rec.type} storage row`);
  }
  const count = payload.length;
  return [{ seq0: rec.seq0, count }]; // [firstSeq, count] pair
}

/** Parse one JSONL line into [firstSeq, eventCount] coverage, or null for header/no-seq. */
function coverageOf(line) {
  const rec = JSON.parse(line);
  if (rec === null || typeof rec !== 'object') return null;
  if (CHUNK_ROWS.has(rec.type)) {
    const payload = rec.type === 'tool-call-chunks' ? rec?.data?.args : rec?.data?.texts;
    if (!Number.isSafeInteger(rec.seq0) || !Array.isArray(payload) || payload.length === 0) {
      throw new Error(`malformed ${rec.type} storage row`);
    }
    return [rec.seq0, payload.length];
  }
  if (typeof rec.seq === 'number') return [rec.seq, 1];
  return null;
}

function typeOf(line) {
  try { return JSON.parse(line)?.type ?? null; } catch { return null; }
}

/** Find the first seq discontinuity. Returns {line, expected, first} or null. */
function firstMismatch(covs) {
  let expected = 0;
  for (let i = 0; i < covs.length; i++) {
    const c = covs[i];
    if (c === null) continue;
    if (c[0] !== expected) return { line: i + 2, expected, first: c[0] };
    expected = c[0] + c[1];
  }
  return null;
}

/** Verify whole file: contiguity + turn flow. Returns {events, turnIssues}. */
function verify(lines) {
  const covs = [];
  for (let i = 1; i < lines.length; i++) covs.push(coverageOf(lines[i]));
  const mm = firstMismatch(covs);
  if (mm) throw new Error(`seq mismatch at line ${mm.line}: expected ${mm.expected}, got ${mm.first}`);

  let events = 0;
  for (const c of covs) if (c !== null) events += c[1];

  // turn flow audit over raw event rows (chunk rows never carry turn/start|end)
  const issues = [];
  let openTurn = null;
  let nextTurn = 1;
  for (let i = 1; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]);
    if (rec.type === 'turn/start') {
      if (openTurn !== null) issues.push(`turn/start ${rec.data?.turn} while turn ${openTurn} open`);
      if (rec.data?.turn !== nextTurn) issues.push(`turn/start expected ${nextTurn}, got ${rec.data?.turn}`);
      openTurn = rec.data?.turn;
    } else if (rec.type === 'turn/end') {
      if (openTurn !== rec.data?.turn) issues.push(`turn/end ${rec.data?.turn} closes open turn ${openTurn}`);
      openTurn = null;
      nextTurn = (rec.data?.turn ?? 0) + 1;
    }
  }
  return { events, turnIssues: issues };
}

// ---------- repair ----------
/**
 * Drop the stale block. In the dual-writer pattern, the lines immediately
 * before the first mismatch decode to exactly `expected - first` events and
 * duplicate the tail's start; removing them makes the whole file contiguous.
 */
function autoRepair(lines) {
  const covs = [];
  for (let i = 1; i < lines.length; i++) covs.push(coverageOf(lines[i]));

  let fixups = 0;
  for (let pass = 0; pass < 32; pass++) {
    const mm = firstMismatch(covs);
    if (mm === null) break;
    const gap = mm.expected - mm.first;
    if (gap <= 0) throw new Error(
      `cannot auto-repair: mismatch at line ${mm.line} jumps forward (expected ${mm.expected}, got ${mm.first}); events were lost, not duplicated`);
    // count events in the rows immediately preceding the mismatch line (file line = mm.line -> index mm.line-2)
    let idx = mm.line - 2; // index of the row just before the mismatch
    const removeIdxs = [];
    let events = 0;
    while (idx >= 1 && events < gap) {
      const c = covs[idx - 1]; // covs index = file line - 2
      if (c === null) break;
      removeIdxs.push(idx - 1);
      events += c[1];
      idx--;
    }
    if (events !== gap) throw new Error(
      `cannot auto-repair: ${gap} duplicated events at line ${mm.line} do not line up with a removable block (found ${events})`);
    const removed = [...removeIdxs].reverse().sort((a, b) => a - b); // ascending covs indexes to remove
    // covs index i corresponds to lines[i+1]; removing lines[i+1]
    for (let k = removed.length - 1; k >= 0; k--) {
      lines.splice(removed[k] + 1, 1);
    }
    // rebuild covs for the spliced array (just rebuild everything; files are small enough)
    covs.length = 0;
    for (let i = 1; i < lines.length; i++) covs.push(coverageOf(lines[i]));
    fixups++;
  }
  return { lines, fixups };
}

// ---------- CLI ----------
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function listSessionFiles(root) {
  const out = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('--') || e.name.startsWith('_')) {
        for (const s of fs.readdirSync(p, { withFileTypes: true })) {
          if (!s.isDirectory()) continue;
          const f = path.join(p, s.name, 'session.jsonl.zstd');
          if (fs.existsSync(f)) out.push(f);
        }
      } else {
        out.push(...listSessionFiles(p));
      }
    } else if (e.name === 'session.jsonl.zstd') {
      out.push(p);
    }
  }
  return out;
}

function checkFile(file) {
  try {
    const { plain, frames, tornStart } = decompress(file);
    const lines = plain.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0 || !/^\{/.test(lines[0])) throw new Error('empty or header-less log');
    const { events, turnIssues } = verify(lines);
    const tail = tornStart !== undefined ? `, torn tail @${tornStart}` : '';
    const bootIssue = firstFrameViolation(file);
    return { ok: true, events, frames, tail, turnIssues, bootIssue };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function main() {
  const [mode, target, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes('--dry-run') || target === '--dry-run';

  if (mode === 'check') {
    let files = [];
    if (target && target !== '--dry-run') {
      const st = fs.statSync(target);
      files = st.isDirectory() ? listSessionFiles(target) : [target];
    } else {
      files = listSessionFiles(path.join(dshHome(), 'sessions'));
    }
    if (files.length === 0) { console.log('no session logs found'); return 0; }
    let bad = 0;
    for (const f of files) {
      const r = checkFile(f);
      if (r.ok) {
        if (r.bootIssue) {
          bad++;
          console.log(`BOOT-BLOCKING ${f}  (${r.bootIssue})`);
          for (const t of r.turnIssues) console.log(`        turn-issue: ${t}`);
        } else {
          console.log(`OK      ${f}  (${r.events} events, ${r.frames} frames${r.tail})`);
          for (const t of r.turnIssues) console.log(`        turn-issue: ${t}`);
        }
      } else {
        bad++;
        console.log(`CORRUPT ${f}  (${r.error})`);
      }
    }
    return bad > 0 ? 1 : 0;
  }

  if (mode === 'repair') {
    const file = dryRun ? rest.find((a) => a !== '--dry-run') ?? target : target;
    if (!file || file === '--dry-run') { console.error('usage: repair [--dry-run] <session.jsonl.zstd>'); return 2; }
    console.log(`repairing ${file}`);
    const { plain, tornStart } = decompress(file);
    if (tornStart !== undefined) console.log(`note: torn final frame at byte ${tornStart} (will be kept as-is)`);
    const lines = plain.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0 || !/^\{/.test(lines[0])) { console.error('empty or header-less log'); return 2; }

    let result;
    try {
      result = autoRepair(lines);
    } catch (e) {
      console.error(`auto-repair failed: ${e.message}`);
      console.error('manual repair needed — see docs/plan.md §8 for the procedure.');
      return 1;
    }
    if (result.fixups === 0) console.log('log was already healthy; nothing to fix');
    else console.log(`dropped ${result.fixups} stale block(s)`);

    const { events, turnIssues } = verify(result.lines);
    if (turnIssues.length > 0) {
      console.error('turn-flow audit failed; refusing to write:');
      for (const t of turnIssues) console.error('  ' + t);
      return 1;
    }
    console.log(`verified: ${events} events, contiguous seq, turn flow clean`);

    const out = dryRun ? file.replace(/\.zstd$/, '') + '.repaired.zstd' : file;
    if (!dryRun) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = `${file}.corrupt-${ts}.bak`;
      fs.copyFileSync(file, bak);
      console.log(`backup written: ${bak}`);
    }
    fs.writeFileSync(out, compress(Buffer.from(result.lines.join('\n') + '\n', 'utf8')));
    console.log(`wrote: ${out}`);
    return 0;
  }

  console.error('usage:\n  node repair-session.cjs check [path]\n  node repair-session.cjs repair [--dry-run] <session.jsonl.zstd>');
  return 2;
}

process.exit(main());
