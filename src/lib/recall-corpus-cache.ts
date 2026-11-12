import * as nodeBuffer from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CORPUS_TYPES,
  buildCorpus,
  buildCorpusWith,
  corpusBuildFingerprint,
  type BuildCorpusOptions,
  type CorpusDoc,
  type CorpusSourceEntry,
  type CorpusSourceMemo,
  type CorpusType,
} from './recall.js';

/**
 * Disk cache of the BUILT corpus, so the per-prompt recall hook (a fresh process every
 * prompt) stops re-reading, re-parsing and re-tokenizing every markdown file.
 *
 * Measured on the 1449-doc dc brain: ~820 ms of the hook's ~1.7 s was `buildCorpus`,
 * ~85% of it tokenizing text that had not changed since the previous prompt.
 *
 * What is cached: the docs of the heavy source kinds — markdown files (every type
 * built by `loadMarkdownDocs`), `core/CHANGELOG.json`, and the session-digest group.
 * Everything else (memory sections, bookmarks, automation run output, whiteboards) is
 * cheap and volatile — `.sleep.json` is rewritten on nearly every prompt — so it is
 * rebuilt each time. One source file → its docs, validated by mtime + size, so an edit
 * re-parses ONE file (the digests are one entry, keyed by the whole directory listing). The cached and uncached corpora share one code path (`buildCorpusWith`); the
 * cache only stands in for the work on a file that has not changed.
 *
 * Layout: `<root>/.recall-cache/corpus.json`, a self-ignoring directory like
 * `.embeddings/`. A vault that is only READ — a connected peer in cross-vault recall —
 * must never be written into: callers pass `cacheDir` (see {@link peerCacheDir}) and the
 * cache lives under the reader's own home instead. JSON, never a binary serialization:
 * the in-vault file can travel with a brain-sync repo, so it must stay safe to parse. Docs are stored COLUMNAR — the
 * `termFreq`/`fieldFreq` maps as parallel arrays SORTED by term, the token list as one space-joined
 * string of term indexes — which parses ~4x faster than per-entry pairs. A revived doc builds nothing
 * until it is read: BM25 answers `has / tf / field-tf` by binary search over the sorted columns
 * (`termColumns`, see recall.ts), and the `tokenSet` / `termFreq` / `fieldFreq` collections and the `tokens`
 * array materialise on first access (only reflection-style callers read them). Building ~1.6k docs'
 * worth of Maps on every hook process was a third of the cache-load cost.
 *
 * The long text lives OUTSIDE the JSON (format 5): every doc's `body` and its token sequence are bytes in a
 * sibling text file (`corpus-<id>.text`, named by the JSON's `text` field), and the JSON holds their byte
 * offsets. The JSON (term columns, titles, paths) is all a search needs; a body is decoded only when it is read,
 * which a search does for its top hits (snippets) only. Measured on the 2.7k-doc dc brain: the old single file
 * was 47 MB and 174 ms of `JSON.parse` per process, of which body and tokens were 32 MB.
 *
 * A long-lived process (the dashboard server answering the prompt hook) keeps the parsed file in memory and
 * re-reads it only when the JSON's mtime, size or inode changes (`loadedFile`).
 *
 * Invalidation: a different format version, a different {@link corpusBuildFingerprint}
 * (tokenizer / stemmer / loader changes), or a different context root discards the whole
 * file. A corrupt or unreadable file is treated as absent. Never throws into the caller:
 * on any cache failure the plain `buildCorpus` result is returned.
 */

const FORMAT_VERSION = 5;
const CACHE_DIR = '.recall-cache';
const CACHE_FILE = 'corpus.json';

/** Options of {@link buildCorpusCached}: the corpus options, plus where the cache lives. */
export interface CachedCorpusOptions extends BuildCorpusOptions {
  /** Directory holding `corpus.json`. Default: `<contextRoot>/.recall-cache`. */
  cacheDir?: string;
}

/**
 * Where the cache of a vault we only READ lives: under the reader's home, keyed by the
 * peer's real path, so reading a peer never writes a byte into the peer's tree.
 * `home` defaults to the OS home; callers that already carry a home override pass it so
 * tests stay hermetic.
 */
export function peerCacheDir(peerRoot: string, home: string = homedir()): string {
  let real: string;
  try {
    real = realpathSync(peerRoot);
  } catch {
    real = resolve(peerRoot);
  }
  const key = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return join(home, '.dreamcontext', 'recall-cache', key);
}

/** The four collections stored in columnar form instead of as part of the doc object (`body` lives in the text file). */
const DERIVED_KEYS = new Set(['tokens', 'tokenSet', 'termFreq', 'fieldFreq']);

interface StoredDoc {
  /** Every other CorpusDoc field, verbatim. */
  [field: string]: unknown;
  terms: string[];
  tf: number[];
  ff: number[];
  /** Token count. */
  tc: number;
  /** Byte offset and length of the body (utf-8) in the text file. */
  bo: number;
  bl: number;
  /** Byte offset and length of the token sequence (space-joined indexes into `terms`, ASCII) in the text file. */
  to: number;
  tl: number;
}

/** A doc as `toStored` builds it, before its text has a place in a text file. */
interface PendingDoc {
  stored: Omit<StoredDoc, 'bo' | 'bl' | 'to' | 'tl'>;
  body: string;
  tk: string;
}

interface StoredEntry {
  k: string;
  s: string;
  ix: boolean;
  docs: StoredDoc[];
}

interface CacheFile {
  v: number;
  fp: string;
  root: string;
  /** Basename of the text file holding every body and token sequence. */
  text: string;
  entries: StoredEntry[];
}

/** A parsed cache: its entries and the text file their offsets point into. */
interface LoadedFile {
  entries: Map<string, StoredEntry>;
  text: Buffer;
  textName: string | null;
}

function debug(message: string, err?: unknown): void {
  if (process.env.DREAMCONTEXT_DEBUG) {
    console.error(`[recall-cache] ${message}`, err instanceof Error ? err.message : err ?? '');
  }
}

// ── doc <-> stored form ──────────────────────────────────────────────────────

/** The stored form of a built doc, or null when it would not survive the round trip exactly. */
function toStored(doc: CorpusDoc): PendingDoc | null {
  if (!doc.fieldFreq) return null;
  const rows: Array<[string, number, number]> = [];
  for (const [term, count] of doc.termFreq) {
    const weighted = doc.fieldFreq.get(term);
    if (weighted === undefined || !doc.tokenSet.has(term)) return null;
    rows.push([term, count, weighted]);
  }
  // Sorted by UTF-16 code units (what `<` compares): revived docs binary-search these columns.
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const terms = rows.map((r) => r[0]);
  const tf = rows.map((r) => r[1]);
  const ff = rows.map((r) => r[2]);
  // The columnar form assumes one shared key set; anything else is stored uncached.
  if (doc.fieldFreq.size !== terms.length || doc.tokenSet.size !== terms.length) return null;
  // Every token is a key of termFreq (that is what termFreq counts), so the sequence is
  // stored as indexes into `terms`; anything that breaks that is left uncached.
  const index = new Map<string, number>();
  terms.forEach((term, i) => index.set(term, i));
  const tokens = doc.tokens;
  const ids: number[] = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const id = index.get(tokens[i]);
    if (id === undefined) return null;
    ids[i] = id;
  }

  if (typeof doc.body !== 'string') return null;
  const stored: PendingDoc['stored'] = { terms, tf, ff, tc: tokens.length };
  for (const [field, value] of Object.entries(doc)) {
    if (!DERIVED_KEYS.has(field) && field !== 'body') stored[field] = value;
  }
  return { stored, body: doc.body, tk: ids.join(' ') };
}

/**
 * Define `key` as an own enumerable property computed on first read (then a plain writable value).
 * Assigning to a term collection first also drops the doc's `termColumns`, which would no longer describe it.
 */
function defineLazy<T>(doc: CorpusDoc, key: 'tokens' | 'tokenSet' | 'termFreq' | 'fieldFreq' | 'body', build: () => T): void {
  const settle = (value: T): T => {
    Object.defineProperty(doc, key, { value, enumerable: true, writable: true, configurable: true });
    return value;
  };
  Object.defineProperty(doc, key, {
    enumerable: true,
    configurable: true,
    get: () => settle(build()),
    set: (value: T) => {
      if (key !== 'tokens' && key !== 'body') {
        Object.defineProperty(doc, 'termColumns', { value: undefined, enumerable: false, writable: true, configurable: true });
      }
      settle(value);
    },
  });
}

function columnMap(terms: string[], values: number[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < terms.length; i++) map.set(terms[i], values[i]);
  return map;
}

/** Revive a stored doc: nothing is built or decoded until read; `termColumns` and `tokenCount` set (non-enumerable). */
function reviveDoc(stored: StoredDoc, text: Buffer): CorpusDoc {
  const { terms, tf, ff, tc, bo, bl, to, tl, ...rest } = stored;
  const doc = rest as unknown as CorpusDoc;
  // Non-enumerable: a revived doc must still compare equal to a freshly built one.
  Object.defineProperty(doc, 'termColumns', { value: { terms, tf, ff }, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(doc, 'tokenCount', { value: tc, enumerable: false });
  defineLazy(doc, 'tokenSet', () => new Set(terms));
  defineLazy(doc, 'termFreq', () => columnMap(terms, tf));
  defineLazy(doc, 'fieldFreq', () => columnMap(terms, ff));
  defineLazy(doc, 'tokens', () => (tc === 0 ? [] : text.toString('latin1', to, to + tl).split(' ').map((id) => terms[Number(id)])));
  defineLazy(doc, 'body', () => text.toString('utf-8', bo, bo + bl));
  return doc;
}

/** A stored doc whose offsets fit inside the text file: anything else means the two files do not belong together. */
function offsetsFit(d: StoredDoc, size: number): boolean {
  const ok = (o: unknown, l: unknown): boolean =>
    Number.isInteger(o) && Number.isInteger(l) && (o as number) >= 0 && (l as number) >= 0 && (o as number) + (l as number) <= size;
  return ok(d.bo, d.bl) && ok(d.to, d.tl);
}

// ── the on-disk file ─────────────────────────────────────────────────────────

function cachePath(cacheDir: string): string {
  return join(cacheDir, CACHE_FILE);
}

/**
 * The file's text. Our own writer emits pure ASCII (see `serialize`), which reads as a one-byte latin1 string,
 * far cheaper than a decoded utf-8 one. A file anything else wrote (raw non-ASCII, or a Node without
 * `buffer.isAscii`) is decoded as utf-8, so a foreign write is never misread.
 */
function readCacheText(path: string): string {
  const bytes = readFileSync(path);
  return nodeBuffer.isAscii?.(bytes) ? bytes.toString('latin1') : bytes.toString('utf-8');
}

const EMPTY_TEXT = Buffer.alloc(0);
const emptyLoad = (): LoadedFile => ({ entries: new Map(), text: EMPTY_TEXT, textName: null });

/** The name a text file must have: `corpus-<id>.text`, nothing that could leave the directory. */
const TEXT_NAME_RE = /^corpus-[A-Za-z0-9_-]{1,64}\.text$/;

function readCacheFile(cacheDir: string, contextRoot: string, fingerprint: string): LoadedFile {
  const path = cachePath(cacheDir);
  if (!existsSync(path)) return emptyLoad();
  try {
    const parsed = JSON.parse(readCacheText(path)) as Partial<CacheFile>;
    if (
      parsed.v !== FORMAT_VERSION || parsed.fp !== fingerprint
      || parsed.root !== contextRoot || !Array.isArray(parsed.entries)
      || typeof parsed.text !== 'string' || !TEXT_NAME_RE.test(parsed.text)
    ) {
      return emptyLoad();
    }
    // Read right after the JSON: a concurrent writer removes the text file of the JSON it replaced.
    const text = readFileSync(join(cacheDir, parsed.text));
    const entries = new Map<string, StoredEntry>();
    for (const entry of parsed.entries) {
      if (
        typeof entry?.k === 'string' && typeof entry.s === 'string' && Array.isArray(entry.docs)
        && entry.docs.every((d) => offsetsFit(d, text.length))
      ) {
        entries.set(entry.k, entry);
      }
    }
    return { entries, text, textName: parsed.text };
  } catch (err) {
    debug('unreadable corpus cache, rebuilding', err);
    return emptyLoad();
  }
}

/**
 * The parsed cache of each cache directory, for a process that builds the corpus more than once (the dashboard
 * server, or a hook that recalls and then matches the AI Team). Valid while the JSON keeps its mtime, size and
 * inode; a text file never changes under its name (every write picks a new one). Stored entries are never
 * mutated (a revive copies them), so one parse serves every build.
 */
const loadedMemo = new Map<string, { sig: string; fp: string; root: string; file: LoadedFile }>();

function jsonSignature(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}

function loadedFile(cacheDir: string, contextRoot: string, fingerprint: string): LoadedFile {
  const sig = jsonSignature(cachePath(cacheDir));
  const memo = loadedMemo.get(cacheDir);
  if (sig !== null && memo && memo.sig === sig && memo.fp === fingerprint && memo.root === contextRoot) return memo.file;
  const file = readCacheFile(cacheDir, contextRoot, fingerprint);
  if (sig !== null && file.textName !== null) loadedMemo.set(cacheDir, { sig, fp: fingerprint, root: contextRoot, file });
  else loadedMemo.delete(cacheDir);
  return file;
}

/** Test seam: forget every parsed cache. */
export function resetCorpusCacheMemo(): void {
  loadedMemo.clear();
}

/**
 * The file's JSON with every non-ASCII character as a `\uXXXX` escape, so it reads back as a one-byte string
 * (~22 ms off a 22 MB load). Parsing restores the exact text, including surrogate pairs.
 */
function serialize(file: CacheFile): string {
  return JSON.stringify(file).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Text files older than this that the JSON no longer names are left-overs of a lost race: swept on write. */
const STALE_TEXT_MS = 10 * 60_000;

function writeCacheFile(dir: string, contextRoot: string, fingerprint: string, entries: StoredEntry[], text: Buffer, previous: string | null): void {
  mkdirSync(dir, { recursive: true });
  // Self-ignoring, like `.embeddings/`: neither the project repo nor a brain-sync repo
  // rooted at _dream_context/ ever sees it, without touching either .gitignore.
  const ignorePath = join(dir, '.gitignore');
  if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n');
  // A fresh name per write: a reader that parsed the old JSON still finds the old text until it is swept.
  const textName = `corpus-${process.pid}-${Date.now().toString(36)}-${createHash('sha256').update(text).digest('hex').slice(0, 8)}.text`;
  const file: CacheFile = { v: FORMAT_VERSION, fp: fingerprint, root: contextRoot, text: textName, entries };
  // Atomic and per-process: concurrent hooks each write a whole file, the last rename wins.
  const tmp = `${cachePath(dir)}.${process.pid}.tmp`;
  const textPath = join(dir, textName);
  try {
    // 0600: the files hold the text of the vault they cache, which may be another project's.
    writeFileSync(textPath, text, { mode: 0o600 });
    writeFileSync(tmp, serialize(file), { mode: 0o600 });
    renameSync(tmp, cachePath(dir));
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    try { unlinkSync(textPath); } catch { /* never written */ }
    throw err;
  }
  loadedMemo.delete(dir);
  sweepText(dir, textName, previous);
}

/** Remove the text file this write replaced, and any other unnamed one old enough to be a left-over. */
function sweepText(dir: string, keep: string, previous: string | null): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (name === keep || !TEXT_NAME_RE.test(name)) continue;
      const path = join(dir, name);
      if (name === previous) { unlinkSync(path); continue; }
      if (now - statSync(path).mtimeMs > STALE_TEXT_MS) unlinkSync(path);
    }
  } catch (err) {
    debug('could not sweep old corpus text files', err);
  }
}

// ── the memo the loaders consult ─────────────────────────────────────────────

class CorpusCacheStore implements CorpusSourceMemo {
  private readonly loaded: Map<string, StoredEntry>;
  private readonly text: Buffer;
  private readonly textName: string | null;
  private readonly revived = new Map<string, CorpusSourceEntry>();
  private readonly fresh = new Map<string, { sig: string; entry: CorpusSourceEntry }>();
  private readonly touched = new Set<string>();

  constructor(
    private readonly cacheDir: string,
    private readonly contextRoot: string,
    private readonly fingerprint: string,
  ) {
    const file = loadedFile(cacheDir, contextRoot, fingerprint);
    this.loaded = file.entries;
    this.text = file.text;
    this.textName = file.textName;
  }

  lookup(key: string, sig: string): CorpusSourceEntry | undefined {
    const stored = this.loaded.get(key);
    if (!stored || stored.s !== sig) return undefined;
    this.touched.add(key);
    let entry = this.revived.get(key);
    if (!entry) {
      entry = { indexable: stored.ix, docs: stored.docs.map((d) => reviveDoc(d, this.text)) };
      this.revived.set(key, entry);
    }
    return entry;
  }

  record(key: string, sig: string, entry: CorpusSourceEntry): void {
    this.fresh.set(key, { sig, entry });
    this.touched.add(key);
  }

  /** Write the cache back if this run changed what it holds. `scanned` = the types this run walked. */
  flush(scanned: ReadonlySet<string>): void {
    const keep: StoredEntry[] = [];
    let dirty = false;
    for (const [key, stored] of this.loaded) {
      if (this.fresh.has(key)) { dirty = true; continue; }       // replaced below
      if (this.touched.has(key)) { keep.push(stored); continue; } // unchanged, still there
      const type = key.slice(0, key.indexOf('\u0000'));
      if (scanned.has(type)) dirty = true;                        // its file is gone or unreadable
      else keep.push(stored);                                     // a type this run never walked
    }
    if (!dirty && this.fresh.size === 0) return;

    // One new text file: the kept docs' bytes copied over, the fresh docs' text appended.
    const parts: Buffer[] = [];
    let size = 0;
    const place = (bytes: Buffer): [number, number] => {
      parts.push(bytes);
      size += bytes.length;
      return [size - bytes.length, bytes.length];
    };
    const moved: StoredEntry[] = keep.map((entry) => ({
      ...entry,
      docs: entry.docs.map((d) => {
        const [bo, bl] = place(this.text.subarray(d.bo, d.bo + d.bl));
        const [to, tl] = place(this.text.subarray(d.to, d.to + d.tl));
        return { ...d, bo, bl, to, tl };
      }),
    }));
    for (const [key, { sig, entry }] of this.fresh) {
      const pending: PendingDoc[] = [];
      let storable = true;
      for (const doc of entry.docs) {
        const p = toStored(doc);
        if (!p) { storable = false; break; }
        pending.push(p);
      }
      if (!storable) continue;
      const docs: StoredDoc[] = pending.map((p) => {
        const [bo, bl] = place(Buffer.from(p.body, 'utf-8'));
        const [to, tl] = place(Buffer.from(p.tk, 'latin1'));
        return { ...p.stored, bo, bl, to, tl } as StoredDoc;
      });
      moved.push({ k: key, s: sig, ix: entry.indexable, docs });
    }
    writeCacheFile(this.cacheDir, this.contextRoot, this.fingerprint, moved, Buffer.concat(parts, size), this.textName);
  }
}

/**
 * `buildCorpus` with unchanged source files served from the disk cache. Returns a corpus
 * deep-equal to `buildCorpus(contextRoot, opts)` (revived docs defer their `tokens`
 * array — see the header). Any cache failure falls back to the plain build.
 */
export function buildCorpusCached(contextRoot: string, opts: CachedCorpusOptions = {}): CorpusDoc[] {
  const { cacheDir = join(contextRoot, CACHE_DIR), ...corpusOpts } = opts;
  try {
    const store = new CorpusCacheStore(cacheDir, contextRoot, corpusBuildFingerprint());
    const docs = buildCorpusWith(contextRoot, corpusOpts, store);
    try {
      store.flush(new Set<CorpusType>(corpusOpts.types ?? CORPUS_TYPES));
    } catch (err) {
      debug('could not write the corpus cache', err); // read-only vault, full disk: the corpus is still right
    }
    return docs;
  } catch (err) {
    debug('corpus cache failed, building without it', err);
    // A cache that cannot be revived would fail on every prompt: drop it so the next build heals it.
    try { unlinkSync(cachePath(cacheDir)); } catch { /* already gone */ }
    return buildCorpus(contextRoot, corpusOpts);
  }
}
