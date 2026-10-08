import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * `termFreq`/`fieldFreq` maps as parallel arrays, the token list as one space-joined
 * string of term indexes — which parses ~4x faster than per-entry pairs. The `tokens` array of a revived
 * doc is rebuilt lazily (only reflection-style callers read it; BM25 needs the count).
 *
 * Invalidation: a different format version, a different {@link corpusBuildFingerprint}
 * (tokenizer / stemmer / loader changes), or a different context root discards the whole
 * file. A corrupt or unreadable file is treated as absent. Never throws into the caller:
 * on any cache failure the plain `buildCorpus` result is returned.
 */

const FORMAT_VERSION = 2;
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

/** The four collections stored in columnar form instead of as part of the doc object. */
const DERIVED_KEYS = new Set(['tokens', 'tokenSet', 'termFreq', 'fieldFreq']);

interface StoredDoc {
  /** Every other CorpusDoc field, verbatim. */
  [field: string]: unknown;
  terms: string[];
  tf: number[];
  ff: number[];
  /** Token count. */
  tc: number;
  /** The token sequence as space-joined indexes into `terms` (much smaller than the words). */
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
  entries: StoredEntry[];
}

function debug(message: string, err?: unknown): void {
  if (process.env.DREAMCONTEXT_DEBUG) {
    console.error(`[recall-cache] ${message}`, err instanceof Error ? err.message : err ?? '');
  }
}

// ── doc <-> stored form ──────────────────────────────────────────────────────

/** The stored form of a built doc, or null when it would not survive the round trip exactly. */
function toStored(doc: CorpusDoc): StoredDoc | null {
  if (!doc.fieldFreq) return null;
  const terms: string[] = [];
  const tf: number[] = [];
  const ff: number[] = [];
  for (const [term, count] of doc.termFreq) {
    const weighted = doc.fieldFreq.get(term);
    if (weighted === undefined || !doc.tokenSet.has(term)) return null;
    terms.push(term);
    tf.push(count);
    ff.push(weighted);
  }
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

  const stored: StoredDoc = { terms, tf, ff, tc: tokens.length, tk: ids.join(' ') };
  for (const [field, value] of Object.entries(doc)) {
    if (!DERIVED_KEYS.has(field)) stored[field] = value;
  }
  return stored;
}

/** Revive a stored doc: real Maps/Set, `tokens` rebuilt lazily, `tokenCount` set. */
function reviveDoc(stored: StoredDoc): CorpusDoc {
  const { terms, tf, ff, tc, tk, ...rest } = stored;
  const doc = rest as unknown as CorpusDoc;
  const termFreq = new Map<string, number>();
  const fieldFreq = new Map<string, number>();
  for (let i = 0; i < terms.length; i++) {
    termFreq.set(terms[i], tf[i]);
    fieldFreq.set(terms[i], ff[i]);
  }
  doc.termFreq = termFreq;
  doc.fieldFreq = fieldFreq;
  doc.tokenSet = new Set(terms);
  // Non-enumerable: a revived doc must still compare equal to a freshly built one.
  Object.defineProperty(doc, 'tokenCount', { value: tc, enumerable: false });
  const settle = (value: string[]): string[] => {
    Object.defineProperty(doc, 'tokens', { value, enumerable: true, writable: true, configurable: true });
    return value;
  };
  Object.defineProperty(doc, 'tokens', {
    enumerable: true,
    configurable: true,
    get: () => settle(tc === 0 ? [] : tk.split(' ').map((id) => terms[Number(id)])),
    set: (value: string[]) => { settle(value); },
  });
  return doc;
}

// ── the on-disk file ─────────────────────────────────────────────────────────

function cachePath(cacheDir: string): string {
  return join(cacheDir, CACHE_FILE);
}

function readCacheFile(cacheDir: string, contextRoot: string, fingerprint: string): Map<string, StoredEntry> {
  const loaded = new Map<string, StoredEntry>();
  const path = cachePath(cacheDir);
  if (!existsSync(path)) return loaded;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CacheFile>;
    if (
      parsed.v !== FORMAT_VERSION || parsed.fp !== fingerprint
      || parsed.root !== contextRoot || !Array.isArray(parsed.entries)
    ) {
      return loaded;
    }
    for (const entry of parsed.entries) {
      if (typeof entry?.k === 'string' && typeof entry.s === 'string' && Array.isArray(entry.docs)) {
        loaded.set(entry.k, entry);
      }
    }
  } catch (err) {
    debug('unreadable corpus cache, rebuilding', err);
    loaded.clear();
  }
  return loaded;
}

function writeCacheFile(dir: string, contextRoot: string, fingerprint: string, entries: StoredEntry[]): void {
  mkdirSync(dir, { recursive: true });
  // Self-ignoring, like `.embeddings/`: neither the project repo nor a brain-sync repo
  // rooted at _dream_context/ ever sees it, without touching either .gitignore.
  const ignorePath = join(dir, '.gitignore');
  if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n');
  const file: CacheFile = { v: FORMAT_VERSION, fp: fingerprint, root: contextRoot, entries };
  // Atomic and per-process: concurrent hooks each write a whole file, the last rename wins.
  const tmp = `${cachePath(dir)}.${process.pid}.tmp`;
  try {
    // 0600: the file holds the text of the vault it caches, which may be another project's.
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, cachePath(dir));
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

// ── the memo the loaders consult ─────────────────────────────────────────────

class CorpusCacheStore implements CorpusSourceMemo {
  private readonly loaded: Map<string, StoredEntry>;
  private readonly revived = new Map<string, CorpusSourceEntry>();
  private readonly fresh = new Map<string, { sig: string; entry: CorpusSourceEntry }>();
  private readonly touched = new Set<string>();

  constructor(
    private readonly cacheDir: string,
    private readonly contextRoot: string,
    private readonly fingerprint: string,
  ) {
    this.loaded = readCacheFile(cacheDir, contextRoot, fingerprint);
  }

  lookup(key: string, sig: string): CorpusSourceEntry | undefined {
    const stored = this.loaded.get(key);
    if (!stored || stored.s !== sig) return undefined;
    this.touched.add(key);
    let entry = this.revived.get(key);
    if (!entry) {
      entry = { indexable: stored.ix, docs: stored.docs.map(reviveDoc) };
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
    for (const [key, { sig, entry }] of this.fresh) {
      const docs: StoredDoc[] = [];
      let storable = true;
      for (const doc of entry.docs) {
        const stored = toStored(doc);
        if (!stored) { storable = false; break; }
        docs.push(stored);
      }
      if (storable) keep.push({ k: key, s: sig, ix: entry.indexable, docs });
      dirty = true;
    }
    if (dirty) writeCacheFile(this.cacheDir, this.contextRoot, this.fingerprint, keep);
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
