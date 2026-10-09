import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildCorpus } from '../recall.js';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { resolveRecallMode } from '../../cli/commands/sleep.js';
import {
  MODEL_DOWNLOAD_LOCK_PATH,
  MODEL_DOWNLOAD_LOCK_STALE_MS,
  MODEL_DOWNLOAD_LOCK_WAIT_MS,
  embeddingsAvailable,
  getEmbedLoadError,
  isEmbedModelComplete,
  isEmbedPackageInstalled,
  withModelDownloadLock,
} from './embedder.js';
import { EmbeddingLockBusyError, embeddingCacheUsable, refreshEmbeddings } from './store.js';

/**
 * Making hybrid recall (the default mode) actually engage on a machine that has
 * never used it: fetch the embedding model once and build the vault's index —
 * both in the BACKGROUND, never in front of a prompt. The per-prompt hook only
 * ever reads `hybridReady` and falls back to BM25; this module is what turns
 * that gate green. SessionStart, `init`, `update`, `doctor --fix` and the
 * explicit `embed ensure` call it.
 *
 * Model-agnostic on purpose: the model id, cache dir and the "is it on disk"
 * probe all come from embedder.ts, so a different default model needs no change
 * here.
 *
 * `DREAMCONTEXT_EMBED_AUTO=0` switches every automatic provisioning step off
 * (ensure, the spawn, the post-sleep refresh) — tests set it, and it is the
 * user's "never download anything on my behalf" door.
 */

export type EnsureOutcome =
  | 'ready'
  | 'downloaded'
  | 'indexed'
  | 'skipped:mode'
  | 'skipped:package'
  | 'skipped:optout'
  | 'failed';

/** After a failed attempt an AUTOMATIC retry waits this long (the explicit command never does). */
export const EMBED_ENSURE_RETRY_MS = 24 * 60 * 60 * 1000;
/** An ensure run older than this is a crashed one — its lock may be reclaimed. */
export const EMBED_ENSURE_LOCK_STALE_MS = 60 * 60 * 1000;
// The model-download lock lives in embedder.ts (its loader is the only door to the network);
// re-exported here for the callers that import it from provisioning.
export { MODEL_DOWNLOAD_LOCK_STALE_MS, MODEL_DOWNLOAD_LOCK_WAIT_MS };

const MARKER_FILE = 'ensure.json';
const LOCK_FILE = 'ensure.lock';

/** Test seams: every default is the real implementation. */
export interface EnsureDeps {
  isPackageInstalled?: () => boolean;
  /** The model is fully on disk — graph AND weights ({@link isEmbedModelComplete}). */
  isModelComplete?: () => boolean;
  /** Loads (and, when the model is incomplete, downloads — this is an opted-in door) the model. False = unavailable. */
  loadModel?: () => Promise<boolean>;
  cacheUsable?: (root: string) => boolean;
  /** Authoritative full-corpus refresh; null = model unavailable. */
  refresh?: (root: string) => Promise<{ index: { chunks: unknown[] } } | null>;
  modelLockPath?: string;
  now?: () => number;
}

export function embedAutoDisabled(): boolean {
  return process.env.DREAMCONTEXT_EMBED_AUTO === '0';
}

function embeddingsDir(root: string): string {
  return join(root, '.embeddings');
}

/**
 * Create `<root>/.embeddings/` with the same self-ignoring `.gitignore` the
 * store writes, so the ensure marker/lock can never reach a repo even when a
 * failed run never got as far as saving a cache.
 */
function ensureEmbeddingsDir(root: string): void {
  const dir = embeddingsDir(root);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
}

interface EnsureMarker { at: number; reason: string }

function readMarker(root: string): EnsureMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(join(embeddingsDir(root), MARKER_FILE), 'utf-8')) as Partial<EnsureMarker>;
    return typeof parsed.at === 'number' ? { at: parsed.at, reason: String(parsed.reason ?? '') } : null;
  } catch {
    return null;
  }
}

function writeMarker(root: string, marker: EnsureMarker): void {
  ensureEmbeddingsDir(root);
  const path = join(embeddingsDir(root), MARKER_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, path);
}

function clearMarker(root: string): void {
  try { rmSync(join(embeddingsDir(root), MARKER_FILE), { force: true }); } catch { /* already gone */ }
}

/** The ensure lock's recorded start, or null when no run holds it. */
function ensureLockHeldSince(root: string): number | null {
  try {
    const info = JSON.parse(readFileSync(join(embeddingsDir(root), LOCK_FILE), 'utf-8')) as { at?: unknown };
    return typeof info.at === 'number' ? info.at : null;
  } catch {
    return null;
  }
}

/** Why provisioning should not even be attempted for this vault, or null when it should. */
function skipReason(root: string, deps: EnsureDeps): EnsureOutcome | null {
  if (embedAutoDisabled()) return 'skipped:optout';
  if (resolveRecallMode(root) !== 'hybrid') return 'skipped:mode';
  if (!(deps.isPackageInstalled ?? isEmbedPackageInstalled)()) return 'skipped:package';
  return null;
}

async function defaultRefresh(root: string): Promise<{ index: { chunks: unknown[] } } | null> {
  return refreshEmbeddings(root, buildCorpus(root), undefined, { waitForLock: true });
}

/**
 * Bring a vault to "hybrid recall engages": model on disk, index usable.
 * Idempotent and safe to run concurrently — one ensure run per vault (a lock),
 * one model download per machine (a lock), and the index build goes through the
 * store's own cache lock.
 *
 * `allowDownload: false` never fetches the model; with no model on disk that
 * returns 'failed' WITHOUT writing the retry marker (it is the caller's choice,
 * not a fault). `repair: true` wipes the model directory under the download lock and
 * fetches it afresh even when every file looks present (damaged files). A real fault (download failed, model unavailable) writes the
 * marker so an automatic retry waits {@link EMBED_ENSURE_RETRY_MS}; contention
 * with another run does not.
 */
export async function ensureHybridReady(
  root: string,
  opts: { allowDownload?: boolean; repair?: boolean } = {},
  deps: EnsureDeps = {},
): Promise<EnsureOutcome> {
  const skipped = skipReason(root, deps);
  if (skipped !== null) return skipped;

  const now = deps.now ?? Date.now;
  // COMPLETE, not merely downloaded: a download killed after the small graph file leaves the
  // old three-file probe satisfied with no weights behind it. Only the complete probe sends a
  // half-fetched model through the download lock below, which is what serializes the repair.
  const modelOnDisk = deps.isModelComplete ?? isEmbedModelComplete;
  const cacheUsable = deps.cacheUsable ?? embeddingCacheUsable;

  ensureEmbeddingsDir(root);
  const runLock = join(embeddingsDir(root), LOCK_FILE);
  const held = await acquireFileLockWithin(runLock, {
    waitMs: 0, staleMs: EMBED_ENSURE_LOCK_STALE_MS, verifyPidLiveness: true, now,
  });
  if (!held) return 'failed'; // another ensure run owns this vault right now — nothing to record

  try {
    let downloaded = false;
    // `repair` treats a model whose files are all "present" as damaged: wipe, then fetch afresh.
    const repair = opts.repair === true;
    if (repair || !modelOnDisk()) {
      if (opts.allowDownload === false) return 'failed';
      const lockPath = deps.modelLockPath ?? MODEL_DOWNLOAD_LOCK_PATH;
      // The shared helper also guards the loader's own fetch, so this is one lock, not two:
      // the default loadModel re-enters it (same async chain) instead of waiting on itself.
      const locked = await withModelDownloadLock(async () => {
        // The process we waited behind may have finished the download.
        if (!repair && modelOnDisk()) return 'present' as const;
        const loaded = await (deps.loadModel ?? (() => embeddingsAvailable({ allowDownload: true, repair, lockPath, now })))();
        return loaded && modelOnDisk() ? 'fetched' as const : 'failed' as const;
      }, { lockPath, waitMs: MODEL_DOWNLOAD_LOCK_WAIT_MS, staleMs: MODEL_DOWNLOAD_LOCK_STALE_MS, now });
      if (!locked.held) return 'failed'; // another process is still downloading; retry next time
      if (locked.value === 'failed') {
        // The loader knows WHY (a session that would not start, a network error): the marker the
        // 24 h retry throttle reads carries it, so `doctor` and the next session can say so.
        writeMarker(root, { at: now(), reason: getEmbedLoadError() ?? 'model download failed' });
        return 'failed';
      }
      downloaded = locked.value === 'fetched';
    }

    if (cacheUsable(root)) {
      clearMarker(root);
      return downloaded ? 'downloaded' : 'ready';
    }

    let built: { index: { chunks: unknown[] } } | null;
    try {
      built = await (deps.refresh ?? defaultRefresh)(root);
    } catch (err) {
      // A busy cache lock is contention, not a fault: the next run just tries again.
      if (!(err instanceof EmbeddingLockBusyError)) {
        writeMarker(root, { at: now(), reason: err instanceof Error ? err.message : String(err) });
      }
      return 'failed';
    }
    if (built === null) {
      writeMarker(root, { at: now(), reason: 'embedding model unavailable' });
      return 'failed';
    }
    clearMarker(root);
    return 'indexed';
  } finally {
    releaseFileLock(runLock);
  }
}

/**
 * Start {@link ensureHybridReady} as a DETACHED `dreamcontext embed ensure`
 * process and return at once — for the hooks and installers that must never
 * wait on a model download or an index build. Returns whether a process was
 * started. Declines (false) when provisioning is opted out, the mode is not
 * hybrid, the runtime package is missing, hybrid already engages, a recent
 * attempt failed, or another run is in flight.
 */
export function spawnEmbedEnsure(
  root: string,
  deps: EnsureDeps & { spawn?: typeof spawn } = {},
): boolean {
  try {
    if (skipReason(root, deps) !== null) return false;
    const now = (deps.now ?? Date.now)();
    const ready = (deps.isModelComplete ?? isEmbedModelComplete)()
      && (deps.cacheUsable ?? embeddingCacheUsable)(root);
    if (ready) return false;

    const failed = readMarker(root);
    if (failed !== null && now - failed.at < EMBED_ENSURE_RETRY_MS) return false;
    const running = ensureLockHeldSince(root);
    if (running !== null && now - running < EMBED_ENSURE_LOCK_STALE_MS) return false;

    const cliEntry = process.argv[1];
    if (!cliEntry) return false;
    const child = (deps.spawn ?? spawn)(process.execPath, [cliEntry, 'embed', 'ensure', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      cwd: dirname(root),
    });
    // A spawn failure (ENOENT) surfaces as an 'error' event; unhandled it would crash the caller.
    child.on('error', () => { /* best-effort: the next session retries */ });
    child.unref();
    return true;
  } catch {
    return false; // provisioning is best-effort — it must never break a hook or an installer
  }
}
