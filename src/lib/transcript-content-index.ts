/**
 * transcript-content-index — what was SAID in each past conversation, so the history search
 * can find a session by its content and not only by its title.
 *
 * `transcript-sessions.ts` only ever reads a transcript's bounded head and tail, which is right
 * for a list but means a word said in the middle of a long session is unfindable. This module
 * keeps the rest: the owner's messages and the agent's TEXT replies, nothing else. Tool calls,
 * tool output, thinking, hook attachments and sub-agent turns are dropped — they are where the
 * bytes are. Measured on this repo's own history (2026-10-30): 388 transcripts, 3.26 GB on
 * disk, 13.3 MB of conversation text. So the index is ~0.4% of the corpus.
 *
 * The cost rules, because these files are big and the server is long-lived:
 *
 *   • ASYNC and in slices. Every read is a `FileHandle.read` of {@link CHUNK_BYTES}, so the
 *     event loop gets a turn between slices and the server never freezes, even on the first
 *     build over gigabytes. A line is JSON-parsed only when a cheap byte test says it can hold
 *     conversation text: a tool result or a tool-only reply is recognised on its unescaped
 *     marker (a person typing that marker would see it escaped in the JSON), and a giant line
 *     is decided on its first {@link LINE_PEEK_BYTES} and then skipped without being kept.
 *   • INCREMENTAL. A transcript is append-only, so each entry remembers the byte offset it has
 *     consumed; a session that grew pays only for its new bytes, an unchanged one for nothing.
 *     A file that SHRANK was rewritten, and is read again from zero.
 *   • BOUNDED. Per session about {@link MAX_SESSION_CHARS} (the first half kept, the rest a
 *     rolling window of the most recent text; trimmed in batches, so up to 1.5× between
 *     trims), and across the index at most
 *     {@link MAX_TOTAL_CHARS}, counting BOTH copies held (the text and its folded twin). When
 *     the budget is spent, the least recently active sessions are evicted for newer ones —
 *     never the other way round.
 *   • SERIALIZED per transcript: two builds over overlapping sets (a new session appearing
 *     mid-build changes the set) queue on the same file instead of both consuming it.
 *   • The fold for search is done INSIDE the async build, one transcript per turn, so a search
 *     request only folds what changed since (a live session's last lines).
 *
 * A search that arrives mid-build waits a short budget and then answers from what is indexed
 * so far, saying so (`indexing`), never blocking.
 */

import { open } from 'node:fs/promises';

/** Bytes per read. Big enough that a 20 MB transcript is ~20 awaits, small enough that one
 *  slice's parse work is a few ms. */
const CHUNK_BYTES = 1024 * 1024;
/** A line longer than this with no newline yet is decided on its opening bytes and, unless it
 *  can hold conversation text, skipped to its end without being buffered. */
const LINE_PEEK_BYTES = 64 * 1024;
/** A conversational line longer than this is not a message anyone typed or read; drop it. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Text kept per session: the first half verbatim, then a rolling window of the newest. */
export const MAX_SESSION_CHARS = 256 * 1024;
const HEAD_CHARS = MAX_SESSION_CHARS / 2;
/** A full session is trimmed back to {@link MAX_SESSION_CHARS} only once it reaches this, so
 *  the cut (a copy of the whole text) is paid once per ~128K chars of new talk, not per message. */
const TRIM_AT_CHARS = MAX_SESSION_CHARS * 1.5;
/** Chars held across the whole index (every project the server has searched), both copies
 *  counted: ~24M chars of conversation, against ~13M measured on a 3.3 GB history. */
export const MAX_TOTAL_CHARS = 48 * 1024 * 1024;
/** One message is at most this long in the index — a pasted log is not worth a megabyte. */
const MAX_MESSAGE_CHARS = 16 * 1024;

const NL = 0x0a;

/** Transcript reads started — a test seam for "this file was not read again". */
let reads = 0;
export function contentReadsForTest(): number { return reads; }

/** What one transcript said, in its own case and case-folded (same length; see foldCase). */
export interface ContentEntry {
  mtimeMs: number;
  size: number;
  /** Bytes consumed: always just past a newline, so an append resumes on a line start. */
  offset: number;
  /** Messages, one per line. The first {@link HEAD_CHARS} are kept for good; past them the
   *  oldest messages after the head are cut away, back to {@link MAX_SESSION_CHARS}, each time
   *  the text reaches {@link TRIM_AT_CHARS}. */
  text: string;
  /** Where the kept head ends in `text` (-1 while everything still fits in the head). */
  headEnd: number;
  /** foldCase(`text`), same length; stale while `dirty`. */
  folded: string;
  dirty: boolean;
}

export interface ContentFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface IndexProgress {
  done: number;
  total: number;
}

/**
 * Search case folding, Turkish-aware and length-preserving (İ, I, ı → i). Kept identical to
 * `transcript-sessions.ts#foldCase`; duplicated rather than imported to keep this module free
 * of the listing's import graph.
 */
function fold(s: string): string {
  return s.replace(/[İIı]/g, 'i').toLowerCase();
}

/**
 * The conversation text of one transcript line, '' when it holds none. Exported for tests.
 *
 * Owner messages: a `user` entry that is not meta/synthetic/compaction and whose text does not
 * open with `<` (command stubs, reminders) — the same rules as `transcript-history.userPromptOf`.
 * Agent replies: the `text` blocks of an `assistant` entry. Sub-agent turns (`isSidechain`) are
 * someone else's conversation and are dropped.
 */
export function messageTextOf(line: string): string {
  // Cheap gates first: most lines are tool traffic and never need parsing.
  const isUser = line.includes('"type":"user"');
  const isAssistant = !isUser && line.includes('"type":"assistant"');
  if (!isUser && !isAssistant) return '';
  if (line.includes('"isSidechain":true')) return '';
  if (isUser && line.includes('"type":"tool_result"')) return '';
  if (isAssistant && !line.includes('"type":"text"')) return '';
  let obj: {
    type?: unknown; isSidechain?: unknown; isMeta?: unknown; isSynthetic?: unknown;
    isCompactSummary?: unknown; message?: { content?: unknown };
  };
  try { obj = JSON.parse(line); } catch { return ''; }
  if (!obj || typeof obj !== 'object' || obj.isSidechain === true) return '';
  if (obj.type === 'user' && (obj.isMeta === true || obj.isSynthetic === true || obj.isCompactSummary === true)) return '';
  if (obj.type !== 'user' && obj.type !== 'assistant') return '';
  const content = obj.message?.content;
  const parts: string[] = [];
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
        const t = (b as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
  }
  const kept = obj.type === 'user'
    ? parts.map((p) => p.trim()).filter((p) => p && !p.startsWith('<'))
    : parts;
  const text = kept.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text;
}

function emptyEntry(): ContentEntry {
  // Stamped with the file's stat only after a read SUCCEEDS, so a failed one is retried.
  return { mtimeMs: -1, size: -1, offset: 0, text: '', headEnd: -1, folded: '', dirty: false };
}

function pushMessage(e: ContentEntry, msg: string): void {
  e.dirty = true;
  e.text = e.text ? `${e.text}\n${msg}` : msg;
  if (e.headEnd < 0) {
    if (e.text.length <= HEAD_CHARS) return;
    // This message no longer fits the head: the head ends before it.
    e.headEnd = e.text.length - msg.length - 1;
  }
  if (e.text.length <= TRIM_AT_CHARS) return;
  const excess = e.text.length - MAX_SESSION_CHARS;
  // Cut the oldest messages after the head, on a line boundary — but never the newest one.
  const lastNl = e.text.lastIndexOf('\n');
  let cut = e.text.indexOf('\n', e.headEnd + 1 + excess);
  if (cut < 0 || cut > lastNl) cut = lastNl;
  if (cut > e.headEnd) e.text = e.text.slice(0, e.headEnd) + e.text.slice(cut);
}

/** Chars this entry holds: its text and the folded twin. */
function charsOf(e: ContentEntry): number {
  return e.text.length * 2;
}

/** Make `folded` current. Cheap when nothing changed. */
function settle(e: ContentEntry): void {
  if (!e.dirty) return;
  e.folded = fold(e.text);
  // fold() must preserve length for snippet offsets to cut the original; if a script ever
  // breaks that, keep the folded copy as the shown text too rather than mis-cutting.
  if (e.folded.length !== e.text.length) e.text = e.folded;
  e.dirty = false;
}

/**
 * Read `f` from `entry.offset` to EOF, appending every message found; `entry.offset` always
 * ends on a line boundary, so a half-written last line is read next time. False when the file
 * could not be read (the caller then leaves the entry unstamped, to be retried).
 */
async function consume(f: ContentFile, entry: ContentEntry): Promise<boolean> {
  reads++;
  let fh;
  try {
    fh = await open(f.path, 'r');
  } catch {
    return false;
  }
  try {
    const size = (await fh.stat()).size;
    let pos = entry.offset;
    let carry: Buffer | null = null;
    /** Inside a line already decided to be skipped: drop bytes until its newline. */
    let skipping = false;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, size - pos), pos);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(NL, start);
        if (nl < 0) break;
        if (skipping) {
          skipping = false;
        } else {
          const piece = chunk.subarray(start, nl);
          const lineBuf: Buffer = carry ? Buffer.concat([carry, piece]) : piece;
          if (lineBuf.length <= MAX_LINE_BYTES) {
            const msg = messageTextOf(lineBuf.toString('utf8'));
            if (msg) pushMessage(entry, msg);
          }
        }
        carry = null;
        start = nl + 1;
        entry.offset = pos + start;
      }
      if (!skipping && start < chunk.length) {
        const rest = chunk.subarray(start);
        carry = carry ? Buffer.concat([carry, rest]) : Buffer.from(rest);
        if (carry.length > LINE_PEEK_BYTES) {
          // A giant line. Keep it only if its opening says it can hold conversation text and
          // it is not past the hard ceiling; otherwise skip it unbuffered.
          const peek = carry.subarray(0, 4096).toString('utf8');
          const conversational =
            (peek.includes('"type":"user"') && !peek.includes('"type":"tool_result"'))
            || (peek.includes('"type":"assistant"') && peek.includes('"type":"text"'));
          if (!conversational || carry.length > MAX_LINE_BYTES) {
            carry = null;
            skipping = true;
          }
        }
      }
      pos += bytesRead;
    }
  } catch {
    /* an unreadable transcript is a session without content, never an error */
    return false;
  } finally {
    await fh.close().catch(() => {});
  }
  return true;
}

// ─── The index ───────────────────────────────────────────────────────────────

const entries = new Map<string, ContentEntry>();
let totalChars = 0;
let budget = MAX_TOTAL_CHARS;
/** Bumped by {@link clearContentIndex}: a read still running from before must not book its
 *  chars into the fresh index. */
let generation = 0;
/** Transcripts that did not fit the budget (nothing older left to evict), by the stat they
 *  had: skipped until they change, so a full index does not re-read its oldest files on every
 *  build. */
const rejected = new Map<string, string>();
/** One running build per transcript set (keyed by its first path + count). */
const builds = new Map<string, { promise: Promise<void>; progress: IndexProgress }>();
/** The refresh running on each transcript — a second one waits for it. */
const inflight = new Map<string, Promise<void>>();

/** Test seam — the index is process-lifetime by design. */
export function clearContentIndex(): void {
  entries.clear();
  builds.clear();
  inflight.clear();
  rejected.clear();
  totalChars = 0;
  budget = MAX_TOTAL_CHARS;
  generation++;
}

/** Test seam: a smaller global budget, and what is held against it. */
export function setContentBudgetForTest(chars: number): void { budget = chars; }
export function contentCharsHeld(): number { return totalChars; }

function drop(path: string): void {
  const e = entries.get(path);
  if (!e) return;
  totalChars -= charsOf(e);
  entries.delete(path);
}

/**
 * Make room for `need` more chars by evicting sessions last active BEFORE `mtimeMs` (oldest
 * first), never one being read right now. True when the room is there.
 */
function makeRoom(need: number, mtimeMs: number, self: string): boolean {
  if (totalChars + need <= budget) return true;
  const older = [...entries.entries()]
    .filter(([p, e]) => p !== self && e.mtimeMs < mtimeMs && !inflight.has(p))
    .sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  for (const [p] of older) {
    drop(p);
    if (totalChars + need <= budget) return true;
  }
  return totalChars + need <= budget;
}

/** Bring one transcript's entry up to date, one refresh per transcript at a time. */
async function refresh(f: ContentFile): Promise<void> {
  for (let p = inflight.get(f.path); p; p = inflight.get(f.path)) await p;
  const run: Promise<void> = refreshNow(f).finally(() => {
    if (inflight.get(f.path) === run) inflight.delete(f.path);
  });
  inflight.set(f.path, run);
  return run;
}

async function refreshNow(f: ContentFile): Promise<void> {
  const gen = generation;
  let e = entries.get(f.path);
  if (e && e.mtimeMs === f.mtimeMs && e.size === f.size) return;
  const stamp = `${f.mtimeMs}:${f.size}`;
  if (!e && rejected.get(f.path) === stamp) return;
  // Rewritten, not appended: start over.
  if (e && f.size < e.offset) { drop(f.path); e = undefined; }
  if (!e) {
    // Room for at least a small session, taken from older ones; none older = skip this one.
    if (!makeRoom(64 * 1024, f.mtimeMs, f.path)) { rejected.set(f.path, stamp); return; }
    e = emptyEntry();
    entries.set(f.path, e);
  }
  const before = charsOf(e);
  const ok = await consume(f, e);
  if (gen !== generation) return;
  settle(e);
  totalChars += charsOf(e) - before;
  if (ok) { e.mtimeMs = f.mtimeMs; e.size = f.size; }
  // A session that grew past what is left gives way only to older ones; if there are none,
  // it is dropped itself rather than overrunning the budget.
  if (!makeRoom(0, f.mtimeMs, f.path)) { drop(f.path); rejected.set(f.path, stamp); }
}

/**
 * Index `files` (pass them newest first — the global budget is spent in that order).
 * Concurrent calls for the same set share one build. Resolves when every file is current.
 */
export function ensureContentIndex(files: readonly ContentFile[]): { promise: Promise<void>; progress: IndexProgress } {
  const key = `${files[0]?.path ?? ''}#${files.length}`;
  const running = builds.get(key);
  if (running) return running;
  const progress: IndexProgress = { done: 0, total: files.length };
  const promise = (async () => {
    for (const f of files) {
      await refresh(f);
      progress.done++;
    }
  })().finally(() => { builds.delete(key); });
  const build = { promise, progress };
  builds.set(key, build);
  return build;
}

/** The current text of one transcript, or undefined when it has not been indexed yet. */
export function contentOf(path: string): { text: string; folded: string } | undefined {
  const e = entries.get(path);
  if (!e || e.mtimeMs < 0) return undefined;
  settle(e);
  return { text: e.text, folded: e.folded };
}

/** Is `path` indexed up to its current size? */
export function isContentCurrent(f: ContentFile): boolean {
  const e = entries.get(f.path);
  return !!e && e.mtimeMs === f.mtimeMs && e.size === f.size;
}
