import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { EMBED_PROFILE } from './profiles.js';

/**
 * Local embedding model wrapper — pure Node, offline after first download,
 * zero daemons. Loads @huggingface/transformers (ONNX/WASM) via dynamic
 * import(): it is an optionalDependency (native onnxruntime binaries, same
 * treatment as node-pty), so recall degrades gracefully to BM25-only when it
 * is not installed.
 *
 * Which model: the active profile in ./profiles.ts — EmbeddingGemma-300m (q8) by default,
 * multilingual-e5-small via `DREAMCONTEXT_EMBED_MODEL=e5-small`. The profile fixes the
 * weights to fetch, the prompt markers, the pooling and the dimensions; this module only
 * runs it. Both models want their prompt markers (e5: `query: ` / `passage: `; Gemma:
 * `task: search result | query: ` / `title: none | text: `) — retrieval quality drops
 * without them.
 *
 * e5-small spike numbers (2026-07-07): ~1 s cached cold start, ~22 ms warm single embed,
 * ~3 ms/doc batched. Gemma q8 is slower on every axis (measured in
 * eval/runs/2026-10-07-models.json) — which is why the hook decides, per query, whether
 * the dense channel is worth its cost at all (hybrid.ts `denseGate`).
 */
export { EMBED_PROFILE };
/** HF repo id of the active model — also the directory under {@link EMBED_MODEL_CACHE_DIR}. */
export const EMBED_MODEL = EMBED_PROFILE.model;
export const EMBED_DIMS = EMBED_PROFILE.dims;

/** Where the model files are cached — survives npm reinstalls (the library
 *  default is node_modules/.cache, wiped on install). */
export const EMBED_MODEL_CACHE_DIR = join(homedir(), '.dreamcontext', 'models');

/** Batch size for passage embedding — spike showed ~3 ms/doc at 16. */
const BATCH_SIZE = 16;

/** One L2-normalized vector per text, in input order. Prompt markers are the caller's job. */
type EmbedBatch = (texts: string[]) => Promise<Float32Array[]>;

/** transformers.js surface this module touches, typed locally (the library's own overloads are unwieldy). */
type MeanExtractor = (
  texts: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;
interface TfTensor { data: ArrayLike<number | bigint>; dims: number[] }
type TfTokenizer = (
  texts: string[],
  opts: { padding: boolean; truncation: boolean; max_length: number },
) => Record<string, unknown>;
type TfModel = (inputs: Record<string, unknown>) => Promise<Record<string, TfTensor | undefined>>;

let extractorPromise: Promise<EmbedBatch | null> | null = null;

// ─── Model download / readiness status (drives the Settings "Hybrid" card) ────
//
// The model is a one-time download (~113 MB e5-small, ~300 MB Gemma q8) shared across every process via the
// cache dir above. The dashboard warms it explicitly (POST /api/embeddings/download)
// so a user who switches to Hybrid mode SEES the download instead of it silently
// happening — and later failing — on their next CLI prompt. This module is the
// single source of truth for that status; the route layer just serialises it.

export type EmbedModelState = 'not_downloaded' | 'downloading' | 'ready' | 'error';

export interface EmbedModelFileProgress {
  /** Filename being fetched (e.g. `onnx/model_quantized.onnx`). */
  file: string;
  /** transformers.js phase: 'initiate' | 'download' | 'progress' | 'done'. */
  status: string;
  loaded: number;
  total: number;
  /** 0–100 for this file. */
  progress: number;
}

export interface EmbedModelStatus {
  model: string;
  state: EmbedModelState;
  /** The model files are present on disk (usable offline). */
  downloaded: boolean;
  /** The @huggingface/transformers runtime is installed on this machine. */
  packageInstalled: boolean;
  /** 0–100 overall (byte-weighted across in-flight files). */
  progress: number;
  loadedBytes: number;
  totalBytes: number;
  files: EmbedModelFileProgress[];
  error: string | null;
  errorCode: 'package_missing' | 'download_failed' | null;
}

interface ModelStatusInternal {
  state: EmbedModelState;
  files: Map<string, EmbedModelFileProgress>;
  error?: string;
  errorCode?: 'package_missing' | 'download_failed';
  startedAt?: number;
  endedAt?: number;
}

const modelStatus: ModelStatusInternal = { state: 'not_downloaded', files: new Map() };

interface TfProgressEvent {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

/** Fold one transformers.js progress event into the per-file map. */
function recordProgress(p: TfProgressEvent): void {
  if (!p.file) return;
  const prev = modelStatus.files.get(p.file);
  modelStatus.files.set(p.file, {
    file: p.file,
    status: p.status,
    loaded: p.loaded ?? prev?.loaded ?? 0,
    total: p.total ?? prev?.total ?? 0,
    progress: p.status === 'done' ? 100 : (p.progress ?? prev?.progress ?? 0),
  });
}

let pkgInstalledCache: boolean | null = null;

/** True when @huggingface/transformers resolves on disk (cheap, cached). Resolves
 *  the BARE specifier — the package's `exports` map blocks the `/package.json`
 *  subpath (ERR_PACKAGE_PATH_NOT_EXPORTED), which would false-negative. */
export function isEmbedPackageInstalled(): boolean {
  if (pkgInstalledCache !== null) return pkgInstalledCache;
  try {
    createRequire(import.meta.url).resolve('@huggingface/transformers');
    pkgInstalledCache = true;
  } catch {
    pkgInstalledCache = false;
  }
  return pkgInstalledCache;
}

const modelDir = (): string => join(EMBED_MODEL_CACHE_DIR, EMBED_PROFILE.model);

// ─── The one door to the network ──────────────────────────────────────────────
//
// transformers.js writes each model file straight to its final path (a createWriteStream, no
// temp-and-rename), so a fetch that dies half way leaves files that EXIST yet are torn — and an
// existence probe cannot tell. Two rules keep that, and a double download, impossible:
//
//  1. {@link getExtractor} never turns remote models on unless its caller opts in
//     (`allowDownload`) — every recall, index and dedup path loads offline or gets null (BM25).
//  2. An opted-in fetch runs under the machine-wide download lock, and while it runs the model
//     dir carries a `.downloading` sentinel that {@link isEmbedModelComplete} treats as
//     "incomplete". The sentinel is removed only once the ONNX session has loaded, so a killed
//     or failed download keeps the model incomplete; the next locked attempt wipes the torn
//     dir and fetches afresh.
//
// "Fetched" and "session loads" are different questions. A fetch that finished (every expected
// file reported whole) whose ONNX session then fails to start — a native binary or CPU the
// runtime cannot use — is NOT a torn download: the sentinel is rewritten to phase `fetched`
// with the load error, the files stay, and the next attempt retries the LOAD offline instead of
// wiping and re-downloading 300 MB for the same failure. The model stays "incomplete" (hybrid
// does not engage, nobody retries the load per prompt) and the error is surfaced in the status.

/** Marker inside the model dir: a fetch started here and has not finished loading. */
const DOWNLOAD_SENTINEL = '.downloading';
/** A model download older than this is a crashed one — its lock may be reclaimed. */
export const MODEL_DOWNLOAD_LOCK_STALE_MS = 30 * 60 * 1000;
/** How long a second process waits for another process's model download before giving up. */
export const MODEL_DOWNLOAD_LOCK_WAIT_MS = 15 * 60 * 1000;
/**
 * Hard age ceiling of the download lock: past it the lock is reclaimed even if its recorded PID
 * looks alive (a PID recycled by an unrelated process would otherwise hold it forever). Far above
 * the wait and above any real download of a few hundred MB.
 */
export const MODEL_DOWNLOAD_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** A `fetched` model's external-data file smaller than this is damaged, not a model (they are hundreds of MB). */
export const MIN_PLAUSIBLE_DATA_FILE_BYTES = 1024 * 1024;
/** The machine-wide download lock (one fetch per machine, whoever starts it). */
export const MODEL_DOWNLOAD_LOCK_PATH = join(EMBED_MODEL_CACHE_DIR, '.download.lock');

export interface DownloadLockOptions {
  lockPath?: string;
  waitMs?: number;
  staleMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}

/** Lock paths the current async chain already holds, so a holder can call back into the loader. */
const heldDownloadLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Run `fn` holding the machine-wide model-download lock. Re-entrant within one async chain
 * (`ensureHybridReady` holds the lock and then calls the loader, which asks for it again);
 * two independent callers — even in one process — serialize. `{ held: false }` = another
 * process kept the lock past `waitMs`; `fn` did not run.
 */
export async function withModelDownloadLock<T>(
  fn: () => Promise<T>,
  opts: DownloadLockOptions = {},
): Promise<{ held: true; value: T } | { held: false }> {
  const lockPath = opts.lockPath ?? MODEL_DOWNLOAD_LOCK_PATH;
  const already = heldDownloadLocks.getStore();
  if (already?.has(lockPath)) return { held: true, value: await fn() };
  const got = await acquireFileLockWithin(lockPath, {
    waitMs: opts.waitMs ?? MODEL_DOWNLOAD_LOCK_WAIT_MS,
    staleMs: opts.staleMs ?? MODEL_DOWNLOAD_LOCK_STALE_MS,
    maxAgeMs: opts.maxAgeMs ?? MODEL_DOWNLOAD_LOCK_MAX_AGE_MS,
    verifyPidLiveness: true,
    now: opts.now,
  });
  if (!got) return { held: false };
  try {
    const value = await heldDownloadLocks.run(new Set([...(already ?? []), lockPath]), fn);
    return { held: true, value };
  } finally {
    releaseFileLock(lockPath);
  }
}

interface DownloadSentinel {
  /** `fetching`: a fetch began and never reported whole (killed, or failed mid-way) — torn until proven otherwise. */
  phase: 'fetching' | 'fetched';
  /** Set in phase `fetched`: why the ONNX session would not start. */
  loadError?: string;
}

const sentinelPath = (): string => join(modelDir(), DOWNLOAD_SENTINEL);

/** The sentinel's content, or null when there is none. An unreadable or pre-phase one counts as `fetching`. */
function readSentinel(): DownloadSentinel | null {
  let raw: string;
  try { raw = readFileSync(sentinelPath(), 'utf-8'); } catch { return null; }
  try {
    const parsed = JSON.parse(raw) as Partial<DownloadSentinel>;
    if (parsed.phase === 'fetched') {
      return { phase: 'fetched', loadError: typeof parsed.loadError === 'string' ? parsed.loadError : undefined };
    }
  } catch { /* torn marker: fall through */ }
  return { phase: 'fetching' };
}

function writeSentinel(marker: DownloadSentinel & { pid?: number; at?: number }): void {
  mkdirSync(modelDir(), { recursive: true });
  writeFileSync(sentinelPath(), JSON.stringify({ ...marker, pid: process.pid, at: Date.now() }));
}

/** Begin a fetch: a torn leftover from an earlier attempt is wiped, then the sentinel goes down. */
function beginModelFetch(): void {
  if (readSentinel() !== null) rmSync(modelDir(), { recursive: true, force: true });
  writeSentinel({ phase: 'fetching' });
}

/** The ONNX session loaded: the files are whole and usable. */
function endModelFetch(): void {
  rmSync(sentinelPath(), { force: true });
}

/**
 * Every file the profile expects was reported WHOLE by this attempt's progress events (status
 * `done`, or fully written to its announced size). Only then is a failing load a load problem
 * rather than an interrupted download.
 */
function everyExpectedFileFetched(): boolean {
  const root = modelDir();
  return [...EMBED_PROFILE.files, ...EMBED_PROFILE.dataFiles].every((f) => {
    const seen = modelStatus.files.get(f);
    if (seen === undefined) return false;
    if (seen.status === 'done') return true;
    try { return seen.total > 0 && statSync(join(root, f)).size >= seen.total; } catch { return false; }
  });
}

/**
 * A `fetched` model is worth an offline retry only while its files are still all there: the
 * three small ones, and every external-data file at a plausible size. Files a disk cleaner or a
 * partial `rm` took since are not a load problem — they need the wipe-and-refetch path.
 */
function fetchedFilesPlausible(): boolean {
  if (!isEmbedModelDownloaded()) return false;
  const root = modelDir();
  return EMBED_PROFILE.dataFiles.every((f) => {
    try { return statSync(join(root, f)).size >= MIN_PLAUSIBLE_DATA_FILE_BYTES; } catch { return false; }
  });
}

/** The way out of a model that is on disk but will not load, appended to every surfaced load error. */
const REPAIR_HINT = 'If the model files are damaged, run `dreamcontext embed ensure --repair` (wipes them and downloads afresh).';

function withRepairHint(message: string): string {
  return message.includes('embed ensure --repair') ? message : `${message} — ${REPAIR_HINT}`;
}

/** Why the last attempt to bring the model up failed — in this process, or recorded by an earlier one. */
export function getEmbedLoadError(): string | null {
  return modelStatus.error ?? readSentinel()?.loadError ?? null;
}

/**
 * True when the model files are cached on disk (a completed download). We check
 * the ONNX graph plus the two small metadata files transformers.js writes
 * alongside it — all three present means the download finished, not a partial.
 * (Which three is the active profile's call: each model has its own directory and graph file.)
 */
export function isEmbedModelDownloaded(): boolean {
  const root = modelDir();
  return EMBED_PROFILE.files.every((f) => existsSync(join(root, f)));
}

/**
 * {@link isEmbedModelDownloaded} AND the ONNX external-data weights. The graph file of a
 * large model is tiny and lands first, so a download killed mid-way leaves the three-file
 * gate satisfied with no weights behind it. The load path asks THIS question: not complete →
 * remote stays allowed for that load, so the next explicit load (`embed ensure`) fetches the
 * missing part instead of failing offline forever.
 */
export function isEmbedModelComplete(): boolean {
  const root = modelDir();
  return (
    isEmbedModelDownloaded()
    && EMBED_PROFILE.dataFiles.every((f) => existsSync(join(root, f)))
    && !existsSync(join(root, DOWNLOAD_SENTINEL))
  );
}

/** Snapshot the model download/readiness status for the dashboard. */
export function getEmbedModelStatus(): EmbedModelStatus {
  // COMPLETE, not merely the three small files: a graph without its weights, a fetch still in
  // flight, or files whose session would not load are not a usable model, and Settings, the
  // index route and hybridReady must all say the same thing about it.
  const downloaded = isEmbedModelComplete();
  const loadError = modelStatus.error ?? readSentinel()?.loadError ?? null;
  const files = [...modelStatus.files.values()];
  const totalBytes = files.reduce((s, f) => s + (f.total || 0), 0);
  const loadedBytes = files.reduce((s, f) => s + (f.loaded || 0), 0);

  // Precedence: an explicit failure is the most useful thing to show; otherwise a
  // model on disk is ready (a cache load is instant, so there's no download to
  // report); a live fetch with nothing on disk yet is 'downloading'.
  let state: EmbedModelState;
  if (modelStatus.state === 'error' || loadError !== null) state = 'error';
  else if (downloaded) state = 'ready';
  else if (modelStatus.state === 'downloading') state = 'downloading';
  else state = 'not_downloaded';

  const progress =
    state === 'ready' ? 100
    : totalBytes > 0 ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100))
    : 0;

  return {
    model: EMBED_MODEL,
    state,
    downloaded,
    packageInstalled: isEmbedPackageInstalled(),
    progress,
    loadedBytes,
    totalBytes,
    files,
    error: loadError,
    // A load failure persisted by an earlier process has no in-process code; it is still "the model
    // could not be brought up", the one failure code the dashboard knows besides a missing package.
    errorCode: modelStatus.errorCode ?? (loadError !== null ? 'download_failed' : null),
  };
}

/**
 * Kick off (or resume) the model download and return the current status. Idempotent:
 * a ready or in-flight model is left untouched; a previous failure is reset so the
 * user can retry. The heavy work runs in the background via {@link getExtractor} —
 * the caller polls {@link getEmbedModelStatus} for progress.
 */
export function startEmbedModelDownload(opts: { repair?: boolean } = {}): EmbedModelStatus {
  // A repair re-fetches whatever is on disk, so it must not restart a load already in flight.
  const repair = opts.repair === true && modelStatus.state !== 'downloading';
  if (repair) {
    extractorPromise = null;
    modelStatus.state = 'not_downloaded';
    modelStatus.files.clear();
    modelStatus.error = undefined;
    modelStatus.errorCode = undefined;
  } else {
    resetFailedLoad();
  }
  void getExtractor({ allowDownload: true, repair });
  return getEmbedModelStatus();
}

/**
 * Retry-after-error: forget a memoised failed (or never-started) load so the next opted-in
 * {@link getExtractor} re-attempts. Never disturbs an in-flight or ready load.
 */
function resetFailedLoad(): void {
  if (modelStatus.state === 'not_downloaded' || modelStatus.state === 'error') {
    extractorPromise = null;
    modelStatus.files.clear();
    modelStatus.error = undefined;
    modelStatus.errorCode = undefined;
  }
}

/** Rows of a `[batch, dims]` tensor as L2-normalized Float32Arrays. */
function tensorRows(t: TfTensor, rows: number): Float32Array[] {
  const dims = t.dims[t.dims.length - 1];
  const out: Float32Array[] = [];
  for (let b = 0; b < rows; b++) {
    const row = new Float32Array(dims);
    let sumSq = 0;
    for (let j = 0; j < dims; j++) {
      const v = Number(t.data[b * dims + j]);
      row[j] = v;
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let j = 0; j < dims; j++) row[j] /= norm;
    out.push(row);
  }
  return out;
}

/**
 * Load the active profile's model and return its batch embedder. 'mean' profiles run
 * the feature-extraction pipeline exactly as before the profile table existed (so e5
 * vectors are unchanged); 'sentence_embedding' profiles run the tokenizer + graph
 * directly and read the graph's own pooled output.
 */
async function loadEmbedBatch(tf: typeof import('@huggingface/transformers')): Promise<EmbedBatch> {
  const { model, dtype, pooling, maxTokens } = EMBED_PROFILE;
  if (pooling === 'mean') {
    const pipe = (await tf.pipeline('feature-extraction', model, {
      dtype,
      progress_callback: recordProgress,
    })) as unknown as MeanExtractor;
    return async (texts) => {
      const res = await pipe(texts, { pooling: 'mean', normalize: true });
      const dims = res.dims[res.dims.length - 1];
      return texts.map((_, j) => res.data.slice(j * dims, (j + 1) * dims));
    };
  }
  const tokenizer = (await tf.AutoTokenizer.from_pretrained(model, {
    progress_callback: recordProgress,
  })) as unknown as TfTokenizer;
  const graph = (await tf.AutoModel.from_pretrained(model, {
    dtype,
    progress_callback: recordProgress,
  })) as unknown as TfModel;
  return async (texts) => {
    const out = await graph(tokenizer(texts, { padding: true, truncation: true, max_length: maxTokens }));
    const pooled = out.sentence_embedding;
    if (pooled === undefined) throw new Error(`${model}: the graph has no sentence_embedding output`);
    return tensorRows(pooled, texts.length);
  };
}

/** What a caller of the loader may do about a model that is not fully on disk. */
export interface LoadOptions extends DownloadLockOptions {
  /**
   * Fetch the model if it is incomplete — under the machine-wide download lock. Only the
   * explicit doors pass it (`embed ensure` via provision.ts, the server's download route).
   * Everyone else gets `null` for an incomplete model and falls back to BM25.
   */
  allowDownload?: boolean;
  /**
   * Wipe the model directory and download it afresh (implies `allowDownload`), under the lock —
   * the way out of damaged files that `embed ensure` alone treats as "present".
   */
  repair?: boolean;
}

/**
 * Lazily load the embedding model. Returns null (never throws) when
 * @huggingface/transformers is unavailable, or when the model is not fully on disk and the
 * caller did not opt into a download — callers fall back to BM25. A refusal is not a failure:
 * it leaves the memo and the status untouched, so a later opted-in call still downloads.
 * Also records download/readiness status into {@link modelStatus} so the dashboard can
 * surface progress, failures, and the already-downloaded state.
 */
async function getExtractor(opts: LoadOptions = {}): Promise<EmbedBatch | null> {
  const complete = isEmbedModelComplete();
  const repair = opts.repair === true;
  const allowDownload = opts.allowDownload === true || repair;
  // A fetch is possible only for an opted-in caller whose model needs one (or who asked for a
  // repair). A WHOLE model — complete, no sentinel — loads offline with no lock and no fetch even
  // for an opted-in caller: nothing is being downloaded, so there is nothing to serialize (and a
  // stale lock must never keep a good model waiting).
  const mayFetch = allowDownload && (!complete || repair);
  if (!complete && !allowDownload) return null;
  if (repair && modelStatus.state !== 'downloading') {
    // A repair re-fetches whatever a memoised earlier load used; never restart one still in flight.
    extractorPromise = null;
    modelStatus.state = 'not_downloaded';
    modelStatus.files.clear();
    modelStatus.error = undefined;
    modelStatus.errorCode = undefined;
  } else if (mayFetch && !complete) {
    resetFailedLoad();
  }
  if (extractorPromise === null) {
    modelStatus.state = 'downloading';
    modelStatus.startedAt = Date.now();
    modelStatus.endedAt = undefined;
    extractorPromise = (async () => {
      try {
        const tf = await import('@huggingface/transformers');
        tf.env.cacheDir = EMBED_MODEL_CACHE_DIR;
        const loadOnce = async (): Promise<EmbedBatch> => {
          // Offline unless THIS caller may fetch AND the model still needs one: the hook and
          // the index build must never touch the network (a revalidation fetch is seconds in front
          // of a prompt), and the probe above is stale by now — the dynamic import yielded, and
          // another process may have changed the files since. A load that may not fetch therefore
          // fails offline (null → BM25) rather than turning the fetch on. For one that may, the
          // model is probed again HERE, under the lock: the process we waited behind may have
          // finished the download. A model whose files were fully fetched but whose session
          // would not start (phase `fetched`) is retried OFFLINE while its files are still all
          // there — wiping it would only re-download the same bytes for the same failure — and
          // goes down the wipe-and-refetch path once they are not. A repair wipes first.
          if (repair) rmSync(modelDir(), { recursive: true, force: true });
          const marker = mayFetch ? readSentinel() : null;
          const retryOffline = marker?.phase === 'fetched' && fetchedFilesPlausible();
          const fetching = mayFetch && !retryOffline && !isEmbedModelComplete();
          // Set right before EVERY load because tf.env is process-global; this load is memoized per process.
          tf.env.allowRemoteModels = fetching;
          if (fetching) beginModelFetch();
          let embed: EmbedBatch;
          try {
            embed = await loadEmbedBatch(tf);
          } catch (err) {
            // Fetched-but-won't-load: keep the files, record why (with the way out). A fetch that
            // did not finish keeps the `fetching` sentinel, so the next locked attempt wipes and
            // refetches. (Only a load that may fetch ever touches the model dir's markers.)
            if (mayFetch && ((fetching && everyExpectedFileFetched()) || retryOffline)) {
              const hinted = withRepairHint(err instanceof Error ? err.message : String(err));
              writeSentinel({ phase: 'fetched', loadError: hinted });
              throw new Error(hinted, { cause: err });
            }
            throw err;
          }
          if (fetching || retryOffline) endModelFetch();
          return embed;
        };
        let embed: EmbedBatch;
        if (!mayFetch) {
          embed = await loadOnce();
        } else {
          const locked = await withModelDownloadLock(loadOnce, opts);
          if (!locked.held) throw new Error('another process is still downloading the embedding model');
          embed = locked.value;
        }
        modelStatus.state = 'ready';
        modelStatus.error = undefined;
        modelStatus.errorCode = undefined;
        modelStatus.endedAt = Date.now();
        return embed;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const packageMissing = /cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(raw);
        // Model files are on disk yet the load failed — including a whole, sentinel-free model whose
        // weights were damaged, which fails in the offline branch above with a raw error. Name the
        // way out (a missing runtime package is a different problem: repairing files would not help).
        const msg = !packageMissing && isEmbedModelDownloaded() ? withRepairHint(raw) : raw;
        modelStatus.state = 'error';
        modelStatus.error = msg;
        modelStatus.errorCode = packageMissing
          ? 'package_missing'
          : 'download_failed';
        modelStatus.endedAt = Date.now();
        if (process.env.DREAMCONTEXT_DEBUG) {
          console.error(`[embed] model load failed: ${msg}`);
        }
        return null;
      }
    })();
  }
  return extractorPromise;
}

/**
 * True when the embedding model can be loaded on this machine. With the model incomplete this
 * is FALSE and nothing is fetched — pass `{ allowDownload: true }` (the explicit doors only)
 * to download it under the machine-wide lock.
 */
export async function embeddingsAvailable(opts: LoadOptions = {}): Promise<boolean> {
  return (await getExtractor(opts)) !== null;
}

/**
 * Embed document passages (batched, the profile's passage prefix). Returns one
 * L2-normalized vector per input (EMBED_DIMS wide), or null when the model is
 * unavailable or an inference fails — callers fall back to BM25. Output order
 * matches input order.
 *
 * A 'sentence_embedding' profile batches by text length (longest first): its
 * inputs are padded to the longest text in the batch, so mixed lengths waste most
 * of the compute — measured at several times the cost of the sorted order on a
 * first index build. Row order is restored before returning. 'mean' profiles keep
 * the input order, so e5 vectors are exactly what they always were.
 *
 * `onProgress(done, total)` (optional) fires after each batch so a long first
 * index build can report progress — additive, no effect on the returned vectors.
 */
export async function embedPassages(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[] | null> {
  const embed = await getExtractor();
  if (embed === null) return null;
  const prefixed = texts.map((t) => `${EMBED_PROFILE.passagePrefix}${t}`);
  const order = prefixed.map((_, i) => i);
  if (EMBED_PROFILE.pooling === 'sentence_embedding') order.sort((a, b) => prefixed[b].length - prefixed[a].length);
  const out: Float32Array[] = new Array(texts.length);
  try {
    for (let i = 0; i < order.length; i += BATCH_SIZE) {
      const slot = order.slice(i, i + BATCH_SIZE);
      const rows = await embed(slot.map((k) => prefixed[k]));
      slot.forEach((k, j) => { out[k] = rows[j]; });
      onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
    }
  } catch (err) {
    if (process.env.DREAMCONTEXT_DEBUG) console.error(`[embed] passage embedding failed: ${(err as Error).message}`);
    return null;
  }
  return out;
}

/** Embed a search query (the profile's query prefix). Null when the model is unavailable or inference fails. */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const embed = await getExtractor();
  if (embed === null) return null;
  try {
    return (await embed([`${EMBED_PROFILE.queryPrefix}${text}`]))[0];
  } catch (err) {
    if (process.env.DREAMCONTEXT_DEBUG) console.error(`[embed] query embedding failed: ${(err as Error).message}`);
    return null;
  }
}
