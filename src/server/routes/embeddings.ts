import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware.js';
import {
  getEmbedModelStatus,
  startEmbedModelDownload,
  isEmbedModelDownloaded,
} from '../../lib/embeddings/embedder.js';
import { buildCorpus } from '../../lib/recall.js';
import { refreshEmbeddings, embeddingCacheUsable, embeddingCacheChunkCount } from '../../lib/embeddings/store.js';

/**
 * Embedding-model + per-vault index routes. Together they back the "Hybrid" recall
 * card in Settings and let hybrid recall become active from the app alone:
 *
 *   - /api/embeddings/status + /download — the shared, one-time ~113 MB MODEL
 *     download (vault-agnostic; the model lives under ~/.dreamcontext/models).
 *   - /api/embeddings/index + /index/status — building THIS vault's embedding
 *     cache (vault-scoped) so hybrid recall can run instantly afterwards.
 *
 * Both are surfaced with progress so the download and the (one-time, possibly
 * multi-minute) index build are VISIBLE, never a surprise on a later prompt.
 */

// ── Model (global) ────────────────────────────────────────────────────────────

/** GET /api/embeddings/status — current download/readiness of the embedding model. */
export async function handleEmbeddingModelStatus(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, getEmbedModelStatus());
}

/**
 * POST /api/embeddings/download — start (or retry) the model download and return
 * the current status. Idempotent: a ready/in-flight model is left as-is. Progress
 * is then polled via GET /api/embeddings/status.
 */
export async function handleEmbeddingModelDownload(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const status = startEmbedModelDownload();
  sendJson(res, 200, { ok: true, ...status });
}

// ── Vault index (per-vault) ───────────────────────────────────────────────────

type IndexState = 'not_built' | 'building' | 'ready' | 'error';

export interface IndexBuildRun {
  state: IndexState;
  done: number;
  total: number;
  chunks: number;
  error: string | null;
  startedAt: number;
  endedAt?: number;
}

// One build at a time per vault (keyed by contextRoot). refreshEmbeddings is
// incremental, so a re-run after the first is cheap.
const indexRuns = new Map<string, IndexBuildRun>();
/** The settle promise of each vault's latest run (one per key, replaced with the run). */
const runFinished = new Map<string, Promise<void>>();

/** Snapshot the vault's embedding-index status: a live build wins, else disk truth. */
function indexStatusFor(contextRoot: string) {
  const run = indexRuns.get(contextRoot);
  // "usable" (not mere existence): a cache left from a prior model/version is NOT
  // ready — it would force a full inline re-index — so it reads as not_built and
  // the card prompts a rebuild.
  const usable = embeddingCacheUsable(contextRoot);
  let state: IndexState;
  if (run?.state === 'building') state = 'building';
  else if (run?.state === 'error' && !usable) state = 'error';
  else if (usable) state = 'ready';
  else state = 'not_built';

  const progress =
    state === 'ready' ? 100
    : state === 'building' && run && run.total > 0 ? Math.min(99, Math.round((run.done / run.total) * 100))
    : 0;

  return {
    state,
    progress,
    done: run?.done ?? 0,
    total: run?.total ?? 0,
    // Prefer the just-built count; else read the real count off the usable cache
    // (fixes a "0 sections indexed" display when the index was built earlier).
    chunks: run?.chunks || (state === 'ready' ? embeddingCacheChunkCount(contextRoot) : 0),
    error: run?.error ?? null,
  };
}

/** GET /api/embeddings/index/status — this vault's embedding-index readiness. */
export async function handleEmbeddingIndexStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
  sendJson(res, 200, indexStatusFor(contextRoot));
}

/**
 * POST /api/embeddings/index — build (or refresh) this vault's embedding cache in
 * the background, so hybrid recall can run instantly afterwards. Requires the model
 * to already be downloaded (so this never silently kicks the 113 MB fetch). Progress
 * is polled via GET /api/embeddings/index/status.
 */
export async function handleEmbeddingIndexBuild(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
  if (!isEmbedModelDownloaded()) {
    sendError(res, 409, 'model_missing', 'Download the embedding model first.');
    return;
  }
  // The owner pressed Build: an explicit retry is never held back by the failure cooldown.
  startIndexBuild(contextRoot, { ignoreCooldown: true });
  sendJson(res, 200, { ok: true, ...indexStatusFor(contextRoot) });
}

/** A build that ended in error is not re-fired automatically for this long (in memory:
 *  a server restart forgets it — a crash-looping server may retry once per restart). */
export const INDEX_BUILD_ERROR_COOLDOWN_MS = 30 * 60_000;

type Embedder = Parameters<typeof refreshEmbeddings>[2];

export interface StartIndexBuildOpts {
  /** The explicit Build button bypasses the error cooldown; automatic callers never do. */
  ignoreCooldown?: boolean;
  /** Injectable for tests; defaults to the real model. */
  embed?: Embedder;
  now?: () => number;
}

/**
 * Start (or join) this vault's background index build and return at once — the single-flight
 * door every build goes through, keyed by contextRoot in {@link indexRuns}. Returns the run
 * and whether THIS call started it. Never downloads the model: refreshEmbeddings only embeds
 * with a model already on disk (see embedder.ts's offline flag); callers check
 * `isEmbedModelDownloaded()` first. Errors land in the run's error state, never thrown.
 */
export function startIndexBuild(
  contextRoot: string,
  opts: StartIndexBuildOpts = {},
): { started: boolean; run: IndexBuildRun; done: Promise<void> } {
  const now = opts.now ?? Date.now;
  const existing = indexRuns.get(contextRoot);
  if (existing?.state === 'building') {
    return { started: false, run: existing, done: runFinished.get(contextRoot) ?? Promise.resolve() };
  }
  if (
    !opts.ignoreCooldown && existing?.state === 'error'
    && existing.endedAt !== undefined && now() - existing.endedAt < INDEX_BUILD_ERROR_COOLDOWN_MS
  ) {
    return { started: false, run: existing, done: Promise.resolve() };
  }

  const run: IndexBuildRun = { state: 'building', done: 0, total: 0, chunks: 0, error: null, startedAt: now() };
  indexRuns.set(contextRoot, run);

  // Fire-and-forget: the caller returns immediately; the client polls status.
  const done = (async () => {
    try {
      const corpus = buildCorpus(contextRoot);
      const result = await refreshEmbeddings(contextRoot, corpus, opts.embed, {
        onProgress: (d, total) => { run.done = d; run.total = total; },
        // A build waits (bounded) for another writer; a timeout lands in `error` below,
        // so the cooldown applies and nothing is written.
        waitForLock: true,
      });
      if (result === null) {
        run.state = 'error';
        run.error = 'Embedding model unavailable — could not build the index.';
      } else {
        run.state = 'ready';
        run.chunks = result.index.chunks.length;
      }
    } catch (err) {
      run.state = 'error';
      run.error = err instanceof Error ? err.message : 'Index build failed.';
    } finally {
      run.endedAt = now();
    }
  })();
  runFinished.set(contextRoot, done);
  return { started: true, run, done };
}

/**
 * The Assistant's own index, built without the owner doing anything: iff the model is on
 * disk and the vault's cache is not usable (never built, or invalidated by a model/version
 * change), start a background build through {@link startIndexBuild}. Never downloads the
 * model, never blocks, and a second call during a build (or inside the error cooldown) starts
 * nothing. Returns whether a build was started.
 */
export function ensureIndexBuilt(
  contextRoot: string,
  deps: { modelOnDisk?: () => boolean; usable?: (root: string) => boolean } & StartIndexBuildOpts = {},
): boolean {
  try {
    const modelOnDisk = (deps.modelOnDisk ?? isEmbedModelDownloaded)();
    if (!modelOnDisk || (deps.usable ?? embeddingCacheUsable)(contextRoot)) return false;
    return startIndexBuild(contextRoot, deps).started;
  } catch {
    return false; // a status read that throws must never fail a spawn
  }
}

/** Test-only: forget every build run (the cooldown is in-memory by design). */
export function _resetIndexRuns(): void {
  indexRuns.clear();
  runFinished.clear();
}
