import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { docKey, type CorpusDoc, type CorpusType } from '../recall.js';
import { chunkDoc, type Chunk } from './chunker.js';
import { embedPassages } from './embedder.js';
import { embedCacheModelKey } from './profiles.js';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';

/**
 * Content-hash-addressed embedding cache — the "embed on change" engine.
 *
 * On every refresh: re-chunk (mtime pre-filter skips unchanged files), embed
 * ONLY chunks whose content hash has no cached vector, evict vectors no chunk
 * references any more. CPU cost scales with the size of the CHANGE, not the
 * corpus (LlamaIndex IngestionPipeline / Continue.dev getComputeDeleteAddRemove
 * pattern). The content hash is the source of truth — it survives git checkout;
 * mtime is only ever a cheap pre-filter.
 *
 * Storage: `<contextRoot>/.embeddings/cache.json`. Vectors are partially
 * invertible → credential-class: the directory ships with a `.gitignore`
 * containing `*` so no repo (project or brain) can ever commit it, and it must
 * stay out of the npm files list.
 *
 * Checkpoints and partial caches: a FULL refresh (non-additive: `embed ensure`,
 * `embed refresh`, the index build, sleep) saves the cache every few hundred
 * newly embedded chunks (or ~30 s), so a killed first build resumes from its last
 * checkpoint instead of from zero — vectors are content-hash keyed, so everything
 * already embedded is reused. A checkpoint that lands on a cache which was NOT yet
 * a usable index (first build, or a model switch) is flagged `partial` and is NOT
 * usable: hybrid recall keeps answering from BM25 until a full run completes and
 * clears the flag. Why not "partial is usable": a dense channel that covers only
 * the indexed slice of the corpus promotes those docs over equally relevant
 * unindexed ones (quality regresses with coverage), every prompt would re-chunk
 * the unfinished docs, and provisioning (`ensureHybridReady`, the Settings status)
 * gates on usability — a usable partial cache would never be finished. A
 * checkpoint on an already-usable index (an incremental update) leaves it usable.
 *
 * The recall path (`additive` + `waitForLock: false`) embeds at most
 * {@link HOOK_MAX_INLINE_CHUNKS} missing chunks inline and searches the vectors it
 * has; the rest is left to ensure/sleep.
 *
 * Parse cost: the file is plain JSON (~12 MB on a 1.4k-doc vault, ~24 MB on a
 * 2.2k-doc one — measured 40–80 ms per parse). The hybrid prompt path reads it
 * twice in one process (the readiness gate, then the refresh), so read-only
 * callers share ONE parse per file version through {@link loadCacheShared}.
 */

const CACHE_VERSION = 1;
const CACHE_DIR = '.embeddings';
const CACHE_FILE = 'cache.json';

interface CacheDocEntry {
  path: string;
  mtimeMs: number;
  /** File size at index time — second pre-filter signal alongside mtime (an
   *  mtime collision with a DIFFERENT size still triggers re-chunking). */
  sizeBytes?: number;
  hashes: string[]; // chunk content hashes in seq order
}

interface CacheFile {
  version: number;
  model: string;
  docs: Record<string, CacheDocEntry>; // keyed by docKey
  vectors: Record<string, string>;     // contentHash → base64 Float32Array
  /** Set by a mid-run checkpoint of a first/rebuilt index, cleared by the full run that
   *  finishes it. Absent on every complete cache (and on caches from older builds). */
  partial?: boolean;
}

/** One embedded chunk in the in-memory dense index. */
export interface IndexedChunk {
  docKey: string;
  seq: number;
  hash: string;
  vector: Float32Array;
}

export interface DenseIndex {
  chunks: IndexedChunk[];
  dims: number;
}

export interface RefreshStats {
  embedded: number; // chunks newly embedded this refresh
  reused: number;   // chunks served from cache
  evicted: number;  // stale vectors dropped
}

function encodeVector(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cachePath(contextRoot: string): string {
  return join(contextRoot, CACHE_DIR, CACHE_FILE);
}

function loadCache(contextRoot: string): CacheFile {
  const empty: CacheFile = { version: CACHE_VERSION, model: embedCacheModelKey(), docs: {}, vectors: {} };
  const path = cachePath(contextRoot);
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CacheFile;
    // A version or model change invalidates every vector (different spaces
    // must never be mixed in one index).
    if (parsed.version !== CACHE_VERSION || parsed.model !== embedCacheModelKey()) return empty;
    if (!parsed.docs || !parsed.vectors) return empty;
    return parsed;
  } catch {
    return empty;
  }
}

// In-process memo of the PARSED cache, keyed by file path and validated by the
// file's mtime + size (a rewrite that keeps the mtime still changes the size
// unless it is byte-identical in length — the same two-signal pre-filter the
// doc entries use). The returned object is SHARED: every holder must treat it as
// read-only. The one mutating path, `refreshEmbeddings`, never mutates it: it
// works on copies and reloads a private cache under the writer lock. The memo
// entry is dropped before that reload and again after the save, so a refresh —
// finished, failed or lock-busy — cannot leave a stale or dirty cache behind.
// Bounded small because each entry holds a whole parsed cache, unlike the
// boolean/number memos below.
const parsedMemo = new Map<string, { mtimeMs: number; size: number; cache: CacheFile }>();
const PARSED_MEMO_MAX = 4;

function forgetParsed(contextRoot: string): void {
  parsedMemo.delete(cachePath(contextRoot));
}

/** Read-only view of the cache, parsed at most once per file version per process. */
function loadCacheShared(contextRoot: string): CacheFile {
  const path = cachePath(contextRoot);
  let stat: { mtimeMs: number; size: number };
  try {
    const s = statSync(path);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    parsedMemo.delete(path);
    return loadCache(contextRoot); // missing file → the empty cache
  }
  const memo = parsedMemo.get(path);
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.cache;
  const cache = loadCache(contextRoot);
  parsedMemo.delete(path); // re-insert at the tail so eviction order is LRU-ish
  parsedMemo.set(path, { ...stat, cache });
  if (parsedMemo.size > PARSED_MEMO_MAX) {
    const oldest = parsedMemo.keys().next().value;
    if (oldest !== undefined) parsedMemo.delete(oldest);
  }
  return cache;
}

function saveCache(contextRoot: string, cache: CacheFile): void {
  const dir = join(contextRoot, CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  // Self-ignoring directory: works for BOTH the project repo and a brain-sync
  // git repo rooted at _dream_context/ without touching either .gitignore.
  const ignorePath = join(dir, '.gitignore');
  if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n');
  // Atomic write — a killed process must never leave a torn cache.
  const tmp = cachePath(contextRoot) + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, cachePath(contextRoot));
}

function statOf(path: string): { mtimeMs: number; sizeBytes: number } {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size };
  } catch {
    return { mtimeMs: -1, sizeBytes: -1 };
  }
}

/** True when a vault has an embedding cache on disk — i.e. the hybrid index has
 *  been built here at least once. A cheap existence check for callers that must
 *  not trigger a first-time build (it says nothing about the cache being usable
 *  for the current model — see {@link embeddingCacheUsable}). */
export function embeddingCacheExists(contextRoot: string): boolean {
  return existsSync(cachePath(contextRoot));
}

/**
 * Number of indexed chunk-slots in the vault's embedding cache (sum of each
 * doc's chunk hashes — matches the materialized DenseIndex size), or 0 when
 * there's no readable cache. Cheap enough for an occasional status read; used to
 * show "N sections indexed" without running a build.
 */
export function embeddingCacheChunkCount(contextRoot: string): number {
  try {
    const cache = loadCacheShared(contextRoot);
    let n = 0;
    for (const doc of Object.values(cache.docs)) n += doc.hashes.length;
    return n;
  } catch {
    return 0;
  }
}

// Memoize the validity verdict by cache-file mtime so `embeddingCacheUsable`
// stays cheap when called per-keystroke on the live search path — a re-check
// happens only when the cache file actually changes (and then shares the
// process's single parse, see loadCacheShared). Keyed per-vault (bounded) so
// multiple concurrently-open vaults don't thrash.
const usableMemo = new Map<string, { mtimeMs: number; usable: boolean }>();
const USABLE_MEMO_MAX = 32;

/**
 * True when the vault's embedding cache is present AND USABLE for hybrid recall
 * RIGHT NOW: it exists, its `model`/`version` still match the current build, it
 * holds vectors, and it is not an unfinished first build (`partial`). This is stronger than {@link embeddingCacheExists} on
 * purpose — a cache left over from a previous model (or CACHE_VERSION) still
 * exists on disk, but `loadCache` would discard it and `refreshEmbeddings` would
 * re-embed the WHOLE corpus inline. Gating hybrid on THIS (not mere existence)
 * keeps that multi-minute rebuild off the keystroke/prompt path — it falls back
 * to BM25 until the index is explicitly rebuilt.
 */
export function embeddingCacheUsable(contextRoot: string): boolean {
  const path = cachePath(contextRoot);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    usableMemo.delete(path);
    return false; // no cache file
  }
  const memo = usableMemo.get(path);
  if (memo && memo.mtimeMs === mtimeMs) return memo.usable;
  // loadCache returns an EMPTY cache on a version/model mismatch (or parse error),
  // so a non-empty vector set proves the on-disk cache is valid for this build.
  // An unfinished first build (`partial`) is not usable — see the header.
  const parsed = loadCacheShared(contextRoot);
  const usable = Object.keys(parsed.vectors).length > 0 && !parsed.partial;
  usableMemo.set(path, { mtimeMs, usable });
  if (usableMemo.size > USABLE_MEMO_MAX) {
    const oldest = usableMemo.keys().next().value;
    if (oldest !== undefined) usableMemo.delete(oldest);
  }
  return usable;
}

// ─── Per-TYPE coverage (the "is this corpus warm?" gate) ────────────────────

/**
 * Fraction of a type's corpus that must already be vectorised before a caller
 * may treat an inline additive refresh as an INCREMENT rather than a cold build.
 */
export const TYPE_COVERAGE_MIN = 0.8;

/**
 * Cached per-type covered-doc count, keyed by vault+type and invalidated by the
 * cache file's mtime — parsing a multi-MB cache is the expensive half. The
 * ON-DISK file count is deliberately re-read on EVERY call and never memoised,
 * so a task file written since the last refresh can never be masked by a stale
 * memo into reporting a warm corpus.
 */
const coverageMemo = new Map<string, { mtimeMs: number; cached: number }>();
const COVERAGE_MEMO_MAX = 32;

/**
 * Docs that make up the `task` corpus ON DISK. The SAME glob the corpus loader
 * uses for that type (recall.ts `loadMarkdownDocs(join(root, 'state'), 'task')`):
 * recursive, so `state/archive/` counts, and fast-glob's default `dot: false`
 * keeps `state/.session-digests/` out — matching the capture docs excluded on the
 * cache side, so both halves of the ratio describe the same population.
 */
function countTaskDocsOnDisk(contextRoot: string): number {
  const dir = join(contextRoot, 'state');
  if (!existsSync(dir)) return 0;
  try {
    return fg.sync('**/*.md', { cwd: dir, onlyFiles: true }).length;
  } catch {
    return 0;
  }
}

/** Docs of `type` in the cache whose every chunk still has a vector, EXCLUDING
 *  capture docs (`<type>/digest#…`) — they are not part of the on-disk count. */
function countCoveredDocsInCache(cache: CacheFile, type: CorpusType): number {
  const prefix = `${type}/`;
  const capturePrefix = `${type}/digest#`;
  let covered = 0;
  for (const [key, entry] of Object.entries(cache.docs)) {
    if (!key.startsWith(prefix) || key.startsWith(capturePrefix)) continue;
    // A doc with no chunk hashes contributes no vectors — it is not "covered".
    if (entry.hashes.length === 0) continue;
    if (entry.hashes.every((h) => cache.vectors[h] !== undefined)) covered++;
  }
  return covered;
}

/**
 * True when the cache ALREADY covers (nearly) the whole `type` corpus, so a
 * caller may run an inline additive refresh without paying a cold build.
 *
 * WHY THIS IS NOT {@link embeddingCacheUsable}. That one answers "does this cache
 * match the current model/version" — it is satisfied by a cache holding ONLY
 * knowledge+feature vectors, which every hybrid-recall path can produce on its
 * own (recall refreshes a TYPE-SCOPED corpus in `additive` mode, and additive
 * never prunes). A caller that gated on `usable` alone and then dedup'd against
 * the `task` corpus would embed that whole corpus INLINE: measured on this brain,
 * 3,501 task chunk slots at ~89 ms/chunk ≈ 310 s inside a single `tasks create`,
 * past the Bash timeout of the sleep sub-agent that invoked it. This gate is what
 * makes that path unreachable: false → the caller skips the semantic work and says
 * so, instead of hanging.
 *
 * Two honesty notes about the ratio:
 *  - `docKey` is `type/slug`, so a slug present in BOTH `state/` and
 *    `state/archive/` collapses to ONE cache key while counting as TWO files on
 *    disk. That is a small under-report, harmless at a 0.8 bar.
 *  - additive refreshes never prune, so cache entries for DELETED tasks linger
 *    and make this OPTIMISTIC. It can therefore over-report coverage on a vault
 *    that deleted many tasks — never under-report one that is genuinely warm.
 *
 * Only the `task` layout is implemented; every other type answers `false` rather
 * than guessing a directory, so a future caller gets a conservative "not warm",
 * never a wrong "warm".
 */
export function embeddingCacheCoversType(
  contextRoot: string,
  type: CorpusType,
  minCoverage: number = TYPE_COVERAGE_MIN,
): boolean {
  if (type !== 'task') return false;

  const expected = countTaskDocsOnDisk(contextRoot);
  if (expected === 0) return false; // nothing on disk to compare against → nothing to trust

  const memoKey = `${contextRoot}|${type}`;
  const path = cachePath(contextRoot);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    coverageMemo.delete(memoKey);
    return false; // no cache file at all
  }

  const memo = coverageMemo.get(memoKey);
  let covered: number;
  if (memo && memo.mtimeMs === mtimeMs) {
    covered = memo.cached;
  } else {
    // loadCache returns an EMPTY cache on a model/version mismatch, so a stale
    // cache scores 0 here exactly as it scores unusable above.
    covered = countCoveredDocsInCache(loadCacheShared(contextRoot), type);
    coverageMemo.set(memoKey, { mtimeMs, cached: covered });
    if (coverageMemo.size > COVERAGE_MEMO_MAX) {
      const oldest = coverageMemo.keys().next().value;
      if (oldest !== undefined) coverageMemo.delete(oldest);
    }
  }

  // ZERO covered docs is never "warm", whatever ratio the caller asked for — a
  // minCoverage of 0 must not turn the cold-build guard off.
  if (covered === 0) return false;
  const bar = Math.max(0, Math.min(1, minCoverage));
  return covered >= Math.ceil(expected * bar);
}

export interface RefreshOptions {
  /**
   * Bypass the mtime+size pre-filter and re-chunk EVERY doc, making the
   * content hash fully authoritative. Vectors for unchanged content are still
   * reused (hash-keyed), so force costs CPU for chunking only, not embedding.
   * Used by eager triggers (sleep, `dreamcontext embed refresh --force`) to
   * catch the pre-filter's one blind spot: an edit that lands within the same
   * mtime granularity AND the same byte size.
   */
  force?: boolean;
  /**
   * Fires as chunks are embedded (`done` of `total` this refresh) so a long
   * first-time index build can report progress. Only meaningful with the
   * default embedder; ignored otherwise.
   */
  onProgress?: (done: number, total: number) => void;
  /**
   * ADD-ONLY reconcile: merge the given docs in and NEVER evict. Set this on the
   * recall path (which may pass a type-scoped corpus) so a partial view can't
   * delete out-of-scope vectors and force a full inline re-embed later. Leave it
   * false for the authoritative full-corpus refreshers (`embed refresh`, the
   * index-build endpoint, sleep), which SHOULD prune deleted docs.
   */
  additive?: boolean;
  /**
   * How a writer that finds the vault's cache lock held behaves. `true` (default — the
   * index build, sleep, `embed refresh`, dedup): spin up to {@link lockWaitMs}, then throw
   * {@link EmbeddingLockBusyError} and write nothing. `false` (the recall hook's additive
   * refresh, which must never block a prompt): one try; busy → its freshly computed vectors
   * are not persisted (a later prompt recomputes them) and it searches what it loaded.
   */
  waitForLock?: boolean;
  /** Bounded-spin budget for `waitForLock`. Default {@link EMBED_LOCK_WAIT_MS}; tests shorten it. */
  lockWaitMs?: number;
  /**
   * Upper bound on chunks embedded by THIS call; the rest stay missing and are left to a
   * later refresh. Default: {@link HOOK_MAX_INLINE_CHUNKS} for the recall path (`additive`
   * with `waitForLock: false` — a prompt must never wait on a model), unlimited otherwise
   * (explicit refreshers, and additive callers that wait for the lock and gate themselves
   * on a warm cache, like dedup).
   */
  maxInline?: number;
  /** Full (non-additive) refresh only: save a checkpoint after this many newly embedded
   *  chunks. Default {@link CHECKPOINT_EVERY_CHUNKS}; 0 disables checkpointing. */
  checkpointEvery?: number;
  /** Full refresh only: …or after this many ms since the last save, whichever first.
   *  Default {@link CHECKPOINT_EVERY_MS}. */
  checkpointMs?: number;
}

/** Newly embedded chunks between checkpoints of a full refresh. */
export const CHECKPOINT_EVERY_CHUNKS = 256;
/** Wall-clock bound between checkpoints of a full refresh. */
export const CHECKPOINT_EVERY_MS = 30_000;
/** Chunks per embedder call while checkpointing — small enough that the time bound is
 *  honoured (~6 chunks/s on the default model ⇒ ~5 s per slice). */
const CHECKPOINT_SLICE = 32;
/** A checkpoint is best-effort: it waits this long for the cache lock, then skips. */
const CHECKPOINT_LOCK_WAIT_MS = 5_000;
/** Missing chunks the recall path embeds inline. At the default model's ~6 chunks/s
 *  this bounds the worst inline cost to ~1.3 s, paid once per edit burst. */
export const HOOK_MAX_INLINE_CHUNKS = 8;

/** Bounded spin a waiting writer gives the cache lock before it gives up. */
export const EMBED_LOCK_WAIT_MS = 30_000;
/** A lock older than this belongs to a crashed holder. The critical section is a reload,
 *  a merge and a rename — milliseconds — because embedding happens OUTSIDE the lock, so a
 *  slow first build can never hold it anywhere near this long. */
export const EMBED_LOCK_STALE_MS = 60_000;

/** The bounded spin ran out: another writer held the vault's cache lock. Nothing was written. */
export class EmbeddingLockBusyError extends Error {
  constructor() {
    super('Another embedding-index write is in progress for this vault — try again shortly.');
    this.name = 'EmbeddingLockBusyError';
  }
}

/** `<contextRoot>/.embeddings/cache.lock` — one writer per vault, across processes. */
export function embeddingCacheLockPath(contextRoot: string): string {
  return join(contextRoot, CACHE_DIR, 'cache.lock');
}

function sameEntry(a: CacheDocEntry | undefined, b: CacheDocEntry): boolean {
  return !!a && a.path === b.path && a.mtimeMs === b.mtimeMs && a.sizeBytes === b.sizeBytes
    && a.hashes.length === b.hashes.length && a.hashes.every((h, i) => h === b.hashes[i]);
}

/**
 * Bring the embedding cache up to date with `corpus` and return the in-memory
 * dense index. Incremental: unchanged chunks reuse cached vectors; only
 * new/changed chunk hashes are embedded; vectors and doc entries that no longer
 * correspond to any corpus chunk are evicted.
 *
 * WRITES ARE SERIALIZED PER VAULT. Several processes refresh one cache (a hook per prompt,
 * the server's index build, sleep, `embed refresh`), and a plain load → modify → save lets
 * the later save drop the earlier one's vectors. So: embeddings are COMPUTED outside the
 * lock against a snapshot; then, under `<cache>/cache.lock`, the cache is RELOADED from
 * disk, the new vectors merged in (add-only; a prune may also evict, but only what was
 * already in the snapshot — a vector another writer added mid-refresh is never pruned by a
 * stale view), saved by tmp + rename, and the lock released.
 *
 * Returns null when the embedding model is unavailable (caller falls back to
 * BM25-only). `embed` is injectable for tests. Throws {@link EmbeddingLockBusyError} when a
 * waiting writer's bounded spin runs out.
 */
export async function refreshEmbeddings(
  contextRoot: string,
  corpus: CorpusDoc[],
  embed: (texts: string[], onProgress?: (done: number, total: number) => void) => Promise<Float32Array[] | null> = embedPassages,
  opts: RefreshOptions = {},
): Promise<{ index: DenseIndex; stats: RefreshStats } | null> {
  // The snapshot this refresh computes against: the process-shared parse, so the
  // readiness gate that ran just before us costs no second parse. READ-ONLY —
  // every mutation below goes to a copy (`dry`) or to the private reload under
  // the lock; the snapshot is never written back as-is.
  const cache = loadCacheShared(contextRoot);

  // 1. Chunk every corpus doc. mtime+size pre-filter: when a doc's file stat is
  //    unchanged AND every cached hash still has a vector, reuse the cached
  //    hashes without re-chunking. (Several docKeys can share one path — memory
  //    sections, changelog entries — each keeps its own entry.) The content
  //    hash stays the source of truth: any stat mismatch or missing vector
  //    falls through to re-chunking, and `force` skips the pre-filter entirely.
  const wanted = new Map<string, { entry: CacheDocEntry; chunks: Chunk[] | null }>();
  const chunkTextByHash = new Map<string, string>();
  const statByPath = new Map<string, { mtimeMs: number; sizeBytes: number }>();

  for (const doc of corpus) {
    const key = docKey(doc);
    let stat = statByPath.get(doc.path);
    if (stat === undefined) {
      stat = statOf(doc.path);
      statByPath.set(doc.path, stat);
    }

    const prior = cache.docs[key];
    if (
      !opts.force &&
      prior &&
      prior.path === doc.path &&
      prior.mtimeMs === stat.mtimeMs &&
      prior.sizeBytes === stat.sizeBytes &&
      stat.mtimeMs >= 0 &&
      prior.hashes.every((h) => cache.vectors[h] !== undefined)
    ) {
      wanted.set(key, { entry: prior, chunks: null });
      continue;
    }

    const chunks = chunkDoc(doc.title, doc.body, doc.description);
    for (const c of chunks) chunkTextByHash.set(c.hash, c.text);
    wanted.set(key, {
      entry: {
        path: doc.path,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.sizeBytes,
        hashes: chunks.map((c) => c.hash),
      },
      chunks,
    });
  }

  // 2. Compute the missing set: hashes referenced by the wanted docs that have
  //    no cached vector yet.
  const missing: string[] = [];
  const missingSet = new Set<string>();
  for (const { entry } of wanted.values()) {
    for (const h of entry.hashes) {
      if (cache.vectors[h] === undefined && !missingSet.has(h)) {
        missingSet.add(h);
        missing.push(h);
      }
    }
  }

  // 3. Embed only the missing chunks — OUTSIDE the lock, so a multi-minute first
  //    build never holds it. Capped on the recall path (see RefreshOptions.maxInline);
  //    a full refresh embeds in slices and checkpoints as it goes.
  const waitForLock = opts.waitForLock ?? true;
  const lockPath = embeddingCacheLockPath(contextRoot);
  const maxInline = opts.maxInline ?? (opts.additive && opts.waitForLock === false ? HOOK_MAX_INLINE_CHUNKS : Infinity);
  const toEmbed = missing.length > maxInline ? missing.slice(0, Math.max(0, maxInline)) : missing;
  const checkpointEvery = opts.additive ? 0 : (opts.checkpointEvery ?? CHECKPOINT_EVERY_CHUNKS);
  const checkpointMs = opts.checkpointMs ?? CHECKPOINT_EVERY_MS;
  let embeddedCount = 0;
  const added: Record<string, string> = {};

  // Add-only save of what has been embedded so far. Never evicts. Skipped (false) when the
  // lock stays busy or the write fails: the final reconcile still persists everything, and a
  // killed run merely resumes from the previous checkpoint.
  const checkpoint = async (): Promise<boolean> => {
    const held = await acquireFileLockWithin(lockPath, {
      waitMs: waitForLock ? Math.min(opts.lockWaitMs ?? EMBED_LOCK_WAIT_MS, CHECKPOINT_LOCK_WAIT_MS) : 0,
      staleMs: EMBED_LOCK_STALE_MS,
    });
    if (!held) return false;
    try {
      forgetParsed(contextRoot);
      const fresh = loadCache(contextRoot);
      // An index that is already usable stays usable through an incremental update.
      const wasUsable = Object.keys(fresh.vectors).length > 0 && !fresh.partial;
      for (const [h, v] of Object.entries(added)) fresh.vectors[h] = v;
      for (const [key, { entry }] of wanted) {
        if (entry.hashes.every((h) => fresh.vectors[h] !== undefined)) fresh.docs[key] = entry;
      }
      if (!wasUsable) fresh.partial = true;
      saveCache(contextRoot, fresh);
      return true;
    } catch (err) {
      if (process.env.DREAMCONTEXT_DEBUG) console.error('[embed] checkpoint skipped:', (err as Error).message ?? err);
      return false;
    } finally {
      forgetParsed(contextRoot);
      releaseFileLock(lockPath);
    }
  };

  if (toEmbed.length > 0) {
    const slice = checkpointEvery > 0 ? Math.max(1, Math.min(checkpointEvery, CHECKPOINT_SLICE)) : toEmbed.length;
    let savedAt = 0;
    let lastSaveMs = Date.now();
    // Persist whatever the run produced before it gives up (model vanished, embedder threw).
    const flush = async (): Promise<void> => {
      if (checkpointEvery > 0 && embeddedCount > savedAt) await checkpoint();
    };
    for (let start = 0; start < toEmbed.length; start += slice) {
      const hashes = toEmbed.slice(start, start + slice);
      let vectors: Float32Array[] | null;
      try {
        vectors = await embed(
          hashes.map((h) => chunkTextByHash.get(h) ?? ''),
          opts.onProgress ? (done) => opts.onProgress!(start + done, toEmbed.length) : undefined,
        );
      } catch (err) {
        await flush();
        throw err;
      }
      if (vectors === null) { // model unavailable → BM25-only fallback
        await flush();
        return null;
      }
      for (let i = 0; i < hashes.length; i++) added[hashes[i]] = encodeVector(vectors[i]);
      embeddedCount += hashes.length;
      const more = start + slice < toEmbed.length;
      if (checkpointEvery > 0 && more
        && (embeddedCount - savedAt >= checkpointEvery || Date.now() - lastSaveMs >= checkpointMs)) {
        if (await checkpoint()) { savedAt = embeddedCount; lastSaveMs = Date.now(); }
      }
    }
  }
  // A full run that embedded everything it was missing finishes the index.
  const completesIndex = !opts.additive && toEmbed.length === missing.length;

  // 4. Reconcile.
  //
  // ADDITIVE mode (recall time): merge the wanted docs in and keep everything
  // else. Recall may be handed a TYPE-SCOPED corpus (the dashboard's Knowledge
  // search asks only for knowledge+feature), and evicting "unreferenced" vectors
  // then would delete every task/memory/changelog vector — so the next FULL-corpus
  // query would re-embed the whole corpus inline on a keystroke. Recall must never
  // shrink the cache; only add.
  //
  // PRUNE mode (default — explicit `embed refresh`, the index-build endpoint,
  // sleep): the corpus is authoritative and whole, so drop docs/vectors that no
  // longer exist. This is the only place the cache is allowed to shrink.
  //
  // `apply` is run against a cache and mutates it; it is run first against the
  // snapshot as a dry run (nothing changed → no lock, no write — the common prompt
  // case), then for real against the cache RELOADED under the lock.
  const snapshotDocKeys = new Set(Object.keys(cache.docs));
  const snapshotVectorKeys = new Set(Object.keys(cache.vectors));
  const apply = (target: CacheFile): { changed: boolean; evicted: number } => {
    let changed = false;
    for (const [h, v] of Object.entries(added)) {
      if (target.vectors[h] === undefined) { target.vectors[h] = v; changed = true; }
    }
    for (const [key, { entry }] of wanted) {
      // A reused hash another writer's prune dropped meanwhile comes back from the snapshot.
      for (const h of entry.hashes) {
        if (target.vectors[h] === undefined && cache.vectors[h] !== undefined) {
          target.vectors[h] = cache.vectors[h];
          changed = true;
        }
      }
      // A doc some of whose chunks were not embedded (the inline cap) is not recorded, so a
      // later refresh re-chunks it and finishes it; recording it would only churn the file.
      if (!entry.hashes.every((h) => target.vectors[h] !== undefined)) continue;
      if (!sameEntry(target.docs[key], entry)) { target.docs[key] = entry; changed = true; }
    }
    if (completesIndex && target.partial) { delete target.partial; changed = true; }
    let evictedHere = 0;
    if (!opts.additive) {
      // Only what THIS refresh saw before it started may be pruned.
      for (const key of Object.keys(target.docs)) {
        if (!wanted.has(key) && snapshotDocKeys.has(key)) { delete target.docs[key]; changed = true; }
      }
      const referenced = new Set<string>();
      for (const d of Object.values(target.docs)) for (const h of d.hashes) referenced.add(h);
      for (const h of Object.keys(target.vectors)) {
        if (!referenced.has(h) && snapshotVectorKeys.has(h)) { delete target.vectors[h]; evictedHere++; changed = true; }
      }
    }
    return { changed, evicted: evictedHere };
  };

  const dry: CacheFile = { ...cache, docs: { ...cache.docs }, vectors: { ...cache.vectors } };
  let { changed, evicted } = apply(dry);
  let final = dry;
  if (changed) {
    const held = await acquireFileLockWithin(lockPath, {
      waitMs: waitForLock ? (opts.lockWaitMs ?? EMBED_LOCK_WAIT_MS) : 0,
      staleMs: EMBED_LOCK_STALE_MS,
    });
    if (!held) {
      if (waitForLock) throw new EmbeddingLockBusyError();
      // Hook path: never waits. Nothing is persisted; the index below is built from the
      // snapshot plus this refresh's vectors, held in memory for this one search.
      evicted = 0;
    } else {
      try {
        // Forget the shared parse BEFORE touching the file, and again after (finally),
        // so no read can pair the old parse with the new file — and a save that throws
        // part-way leaves nothing memoised. The reload is a private, uncached read:
        // `apply` mutates it, and it must reflect what another writer saved meanwhile.
        forgetParsed(contextRoot);
        const fresh = loadCache(contextRoot);
        ({ changed, evicted } = apply(fresh));
        if (changed) saveCache(contextRoot, fresh);
        final = fresh;
      } finally {
        forgetParsed(contextRoot);
        releaseFileLock(lockPath);
      }
    }
  }

  // 5. Materialize the in-memory index (brute-force cosine downstream — exact
  //    and sub-millisecond at this corpus scale; ANN only pays past ~50k chunks).
  const chunks: IndexedChunk[] = [];
  let dims = 0;
  for (const [key, { entry }] of wanted) {
    for (let seq = 0; seq < entry.hashes.length; seq++) {
      const hash = entry.hashes[seq];
      const b64 = final.vectors[hash];
      if (b64 === undefined) continue;
      const vector = decodeVector(b64);
      if (dims === 0) dims = vector.length;
      chunks.push({ docKey: key, seq, hash, vector });
    }
  }

  // reused = distinct referenced chunk hashes now in the index minus the ones we
  // just embedded (computed from the index so it holds in both reconcile modes).
  const distinctHashes = new Set(chunks.map((c) => c.hash)).size;
  return {
    index: { chunks, dims },
    stats: { embedded: embeddedCount, reused: Math.max(0, distinctHashes - embeddedCount), evicted },
  };
}
