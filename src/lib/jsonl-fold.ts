import { open, stat, type FileHandle } from 'node:fs/promises';

/**
 * Fold an append-only JSONL file INCREMENTALLY — the bytes already folded are never read again.
 *
 * Why it exists (task: the desktop app stays light on an 8GB MacBook Air): a live chat pane
 * polls its session stats every 5 s, and a Claude Code transcript is 20–53 MB. Re-reading and
 * re-parsing the whole file per poll per pane was the dashboard server's single biggest cost
 * (13 % of a 30 s CPU profile). A transcript only ever grows by whole lines at the end, so the
 * state folded so far is kept with the byte offset of the last newline it consumed, and the
 * next call reads only what was appended since.
 *
 * An entry is resumed only when the file is provably the SAME file grown at the end: same
 * inode, size ≥ the folded offset, and the byte just before that offset is still a newline
 * (one 1-byte read — it catches an in-place rewrite to a larger size). Anything else (a
 * rotation to a new inode, a truncation, a rewrite) folds again from byte 0.
 *
 * Reads go in 1 MB chunks (the first fold of a 50 MB file too), lines are split on the byte
 * 0x0A so a multibyte character cut by a chunk boundary is reassembled before decoding, an
 * incomplete last line is left unfolded (the offset stops at its start, so it is read again,
 * whole, once its newline lands), and a line that is not JSON is skipped. One fold per
 * (path, key) runs at a time; concurrent callers share it.
 */

/** Read granularity. */
const CHUNK = 1024 * 1024;
/** Folded files kept. An entry being folded is never evicted. */
const MAX_ENTRIES = 64;

interface Entry<S> {
  ino: number;
  /** Byte offset just past the last newline folded. */
  offset: number;
  state: S;
}

const entries = new Map<string, Entry<unknown>>();
const running = new Map<string, Promise<unknown>>();

function entryKey(path: string, key: string): string {
  return `${key}\0${path}`;
}

/** Keep the map bounded, least-recently-used first, never touching an entry mid-fold. */
function evict(): void {
  for (const k of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) return;
    if (!running.has(k)) entries.delete(k);
  }
}

/** Feed every whole line in `buf` to `step`; returns how many bytes were consumed (up to and
 *  including the last newline). */
function feedLines<S>(buf: Buffer, state: S, step: (s: S, row: unknown) => void): number {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) return start;
    const line = buf.toString('utf-8', start, nl).trim();
    start = nl + 1;
    if (!line) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    step(state, row);
  }
}

/** True when the byte just before `offset` is a newline (offset 0: trivially true). */
async function newlineBefore(fh: FileHandle, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const b = Buffer.alloc(1);
  const { bytesRead } = await fh.read(b, 0, 1, offset - 1);
  return bytesRead === 1 && b[0] === 0x0a;
}

async function foldOnce<S>(k: string, path: string, init: () => S, step: (s: S, row: unknown) => void): Promise<S> {
  const st = await stat(path);
  const fh = await open(path, 'r');
  try {
    let e = entries.get(k) as Entry<S> | undefined;
    if (e && (e.ino !== st.ino || st.size < e.offset || !(await newlineBefore(fh, e.offset)))) e = undefined;
    if (!e) e = { ino: st.ino, offset: 0, state: init() };
    // Re-insert so iteration order is least-recently-used first.
    entries.delete(k);
    entries.set(k, e as Entry<unknown>);
    let carry = Buffer.alloc(0);
    let pos = e.offset;
    while (pos < st.size) {
      const want = Math.min(CHUNK, st.size - pos);
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await fh.read(chunk, 0, want, pos);
      // Nothing left (truncated between the stat and the read): stop at what was read. A short
      // read just continues from where it ended.
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const used = feedLines(data, e.state, step);
      e.offset += used;
      // The unterminated tail carries into the next chunk (a copy: a view would pin the chunk).
      carry = Buffer.from(data.subarray(used));
    }
    return e.state;
  } catch (err) {
    // The state was mutated line by line: a half-folded entry must never be resumed.
    entries.delete(k);
    throw err;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * The state folded over every complete line of `path`, under `key` (one file can carry several
 * independent folds). `init` builds a fresh state; `step` mutates it with one parsed row. The
 * returned state is the cached one — callers derive their answer from it and never mutate it.
 * Rejects when the file cannot be stat'd or read (the caller decides what "no file" means).
 */
export function foldJsonl<S>(path: string, key: string, init: () => S, step: (s: S, row: unknown) => void): Promise<S> {
  const k = entryKey(path, key);
  const inflight = running.get(k) as Promise<S> | undefined;
  if (inflight) return inflight;
  const p = foldOnce(k, path, init, step).finally(() => {
    running.delete(k);
    evict();
  });
  running.set(k, p);
  return p;
}

/** Tests only: forget every folded file. */
export function resetJsonlFoldsForTests(): void {
  entries.clear();
  running.clear();
}

/** Tests only: how many folds are cached. */
export function jsonlFoldCount(): number {
  return entries.size;
}
