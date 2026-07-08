import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local embedding model wrapper — pure Node, offline after first download,
 * zero daemons. Loads @huggingface/transformers (ONNX/WASM) via dynamic
 * import(): it is an optionalDependency (native onnxruntime binaries, same
 * treatment as node-pty), so recall degrades gracefully to BM25-only when it
 * is not installed.
 *
 * Model: multilingual-e5-small — 384-dim, ~113 MB quantized (q8), best
 * TR/EN quality-per-MB (spike-validated 2026-07-07: no token_type_ids error,
 * ~1s cached cold-start, ~22 ms warm single embed, ~3 ms/doc batched).
 *
 * E5 contract: queries are prefixed `query: `, documents `passage: ` — the
 * model was trained with these markers and retrieval quality drops without them.
 */
export const EMBED_MODEL = process.env.DREAMCONTEXT_EMBED_MODEL ?? 'Xenova/multilingual-e5-small';
export const EMBED_DIMS = 384;

/** Where the model files are cached — survives npm reinstalls (the library
 *  default is node_modules/.cache, wiped on install). */
export const EMBED_MODEL_CACHE_DIR = join(homedir(), '.dreamcontext', 'models');

/** Batch size for passage embedding — spike showed ~3 ms/doc at 16. */
const BATCH_SIZE = 16;

type Extractor = (
  texts: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor | null> | null = null;

// ─── Model download / readiness status (drives the Settings "Hybrid" card) ────
//
// The model is a one-time ~113 MB download shared across every process via the
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

/**
 * True when the model files are cached on disk (a completed download). We check
 * the big ONNX weights plus the two small metadata files transformers.js writes
 * alongside them — all three present means the download finished, not a partial.
 */
export function isEmbedModelDownloaded(): boolean {
  const root = join(EMBED_MODEL_CACHE_DIR, EMBED_MODEL);
  return (
    existsSync(join(root, 'onnx', 'model_quantized.onnx')) &&
    existsSync(join(root, 'config.json')) &&
    existsSync(join(root, 'tokenizer.json'))
  );
}

/** Snapshot the model download/readiness status for the dashboard. */
export function getEmbedModelStatus(): EmbedModelStatus {
  const downloaded = isEmbedModelDownloaded();
  const files = [...modelStatus.files.values()];
  const totalBytes = files.reduce((s, f) => s + (f.total || 0), 0);
  const loadedBytes = files.reduce((s, f) => s + (f.loaded || 0), 0);

  // Precedence: an explicit failure is the most useful thing to show; otherwise a
  // model on disk is ready (a cache load is instant, so there's no download to
  // report); a live fetch with nothing on disk yet is 'downloading'.
  let state: EmbedModelState;
  if (modelStatus.state === 'error') state = 'error';
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
    error: modelStatus.error ?? null,
    errorCode: modelStatus.errorCode ?? null,
  };
}

/**
 * Kick off (or resume) the model download and return the current status. Idempotent:
 * a ready or in-flight model is left untouched; a previous failure is reset so the
 * user can retry. The heavy work runs in the background via {@link getExtractor} —
 * the caller polls {@link getEmbedModelStatus} for progress.
 */
export function startEmbedModelDownload(): EmbedModelStatus {
  if (modelStatus.state === 'not_downloaded' || modelStatus.state === 'error') {
    // Fresh start or retry-after-error: clear the memoised (failed/unstarted)
    // promise so getExtractor re-attempts. Never disturb an in-flight or ready load.
    extractorPromise = null;
    modelStatus.files.clear();
    modelStatus.error = undefined;
    modelStatus.errorCode = undefined;
  }
  void getExtractor();
  return getEmbedModelStatus();
}

/**
 * Lazily load the feature-extraction pipeline. Returns null (never throws)
 * when @huggingface/transformers is unavailable — callers fall back to BM25.
 * Also records download/readiness status into {@link modelStatus} so the
 * dashboard can surface progress, failures, and the already-downloaded state.
 */
async function getExtractor(): Promise<Extractor | null> {
  if (extractorPromise === null) {
    modelStatus.state = 'downloading';
    modelStatus.startedAt = Date.now();
    modelStatus.endedAt = undefined;
    extractorPromise = (async () => {
      try {
        const tf = await import('@huggingface/transformers');
        tf.env.cacheDir = EMBED_MODEL_CACHE_DIR;
        const pipe = await tf.pipeline('feature-extraction', EMBED_MODEL, {
          dtype: 'q8',
          progress_callback: recordProgress,
        });
        modelStatus.state = 'ready';
        modelStatus.endedAt = Date.now();
        return pipe as unknown as Extractor;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        modelStatus.state = 'error';
        modelStatus.error = msg;
        modelStatus.errorCode = /cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(msg)
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

/** True when the embedding model can be loaded on this machine. */
export async function embeddingsAvailable(): Promise<boolean> {
  return (await getExtractor()) !== null;
}

/**
 * Embed document passages (batched, `passage: ` prefix). Returns one
 * L2-normalized 384-dim vector per input, or null when the model is
 * unavailable. Output order matches input order.
 *
 * `onProgress(done, total)` (optional) fires after each batch so a long first
 * index build can report progress — additive, no effect on the returned vectors.
 */
export async function embedPassages(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[] | null> {
  const extractor = await getExtractor();
  if (extractor === null) return null;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => `passage: ${t}`);
    const res = await extractor(batch, { pooling: 'mean', normalize: true });
    const dims = res.dims[res.dims.length - 1];
    for (let j = 0; j < batch.length; j++) {
      out.push(res.data.slice(j * dims, (j + 1) * dims));
    }
    onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }
  return out;
}

/** Embed a search query (`query: ` prefix). Null when the model is unavailable. */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const extractor = await getExtractor();
  if (extractor === null) return null;
  const res = await extractor(`query: ${text}`, { pooling: 'mean', normalize: true });
  return res.data.slice(0, res.dims[res.dims.length - 1]);
}
