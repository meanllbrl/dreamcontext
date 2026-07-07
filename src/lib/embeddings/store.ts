import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docKey, type CorpusDoc } from '../recall.js';
import { chunkDoc, type Chunk } from './chunker.js';
import { EMBED_MODEL, embedPassages } from './embedder.js';

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
  const empty: CacheFile = { version: CACHE_VERSION, model: EMBED_MODEL, docs: {}, vectors: {} };
  const path = cachePath(contextRoot);
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CacheFile;
    // A version or model change invalidates every vector (different spaces
    // must never be mixed in one index).
    if (parsed.version !== CACHE_VERSION || parsed.model !== EMBED_MODEL) return empty;
    if (!parsed.docs || !parsed.vectors) return empty;
    return parsed;
  } catch {
    return empty;
  }
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

/** True when a vault has an embedding cache on disk — i.e. the hybrid layer has
 *  been used here at least once. Gate for EAGER refresh triggers (sleep): they
 *  must never cold-start a 113 MB model download on a vault that never opted in. */
export function embeddingCacheExists(contextRoot: string): boolean {
  return existsSync(cachePath(contextRoot));
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
}

/**
 * Bring the embedding cache up to date with `corpus` and return the in-memory
 * dense index. Incremental: unchanged chunks reuse cached vectors; only
 * new/changed chunk hashes are embedded; vectors and doc entries that no longer
 * correspond to any corpus chunk are evicted.
 *
 * Returns null when the embedding model is unavailable (caller falls back to
 * BM25-only). `embed` is injectable for tests.
 */
export async function refreshEmbeddings(
  contextRoot: string,
  corpus: CorpusDoc[],
  embed: (texts: string[]) => Promise<Float32Array[] | null> = embedPassages,
  opts: RefreshOptions = {},
): Promise<{ index: DenseIndex; stats: RefreshStats } | null> {
  const cache = loadCache(contextRoot);

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

  // 3. Embed only the missing chunks.
  let embeddedCount = 0;
  if (missing.length > 0) {
    const texts = missing.map((h) => chunkTextByHash.get(h) ?? '');
    const vectors = await embed(texts);
    if (vectors === null) return null; // model unavailable → BM25-only fallback
    for (let i = 0; i < missing.length; i++) {
      cache.vectors[missing[i]] = encodeVector(vectors[i]);
    }
    embeddedCount = missing.length;
  }

  // 4. Evict: docs gone from the corpus, then vectors nothing references.
  const referenced = new Set<string>();
  const newDocs: Record<string, CacheDocEntry> = {};
  for (const [key, { entry }] of wanted) {
    newDocs[key] = entry;
    for (const h of entry.hashes) referenced.add(h);
  }
  let evicted = 0;
  const newVectors: Record<string, string> = {};
  for (const [h, v] of Object.entries(cache.vectors)) {
    if (referenced.has(h)) newVectors[h] = v;
    else evicted++;
  }
  const docsChanged =
    Object.keys(newDocs).length !== Object.keys(cache.docs).length ||
    Object.keys(newDocs).some((k) => cache.docs[k] !== newDocs[k]);

  cache.docs = newDocs;
  cache.vectors = newVectors;
  if (embeddedCount > 0 || evicted > 0 || docsChanged) saveCache(contextRoot, cache);

  // 5. Materialize the in-memory index (brute-force cosine downstream — exact
  //    and sub-millisecond at this corpus scale; ANN only pays past ~50k chunks).
  const chunks: IndexedChunk[] = [];
  let dims = 0;
  for (const [key, { entry }] of wanted) {
    for (let seq = 0; seq < entry.hashes.length; seq++) {
      const hash = entry.hashes[seq];
      const b64 = cache.vectors[hash];
      if (b64 === undefined) continue;
      const vector = decodeVector(b64);
      if (dims === 0) dims = vector.length;
      chunks.push({ docKey: key, seq, hash, vector });
    }
  }

  return {
    index: { chunks, dims },
    stats: { embedded: embeddedCount, reused: referenced.size - embeddedCount, evicted },
  };
}
