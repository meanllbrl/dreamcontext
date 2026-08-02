import { syncAll, type LabSyncProgress, type SyncResult } from '../lib/lab/sync.js';

/**
 * Background bulk-insight sync jobs for the dashboard Insights board.
 *
 * WHY THIS EXISTS: `POST /api/lab/sync {all:true}` held the browser socket open
 * for the ENTIRE run, and the server caps a request at 30s of socket inactivity
 * (`server.setTimeout(30000)` in server/index.ts). A board with more than a
 * handful of insights blows that wall every time — the socket is destroyed, the
 * mutation rejects, the board's `invalidateQueries` never fires, and the user
 * reads the stale tiles as "Sync all only synced some of them".
 *
 * So the POST only STARTS the job here in the server process and the UI polls
 * its state. The job owns the run: it survives navigation, reports live
 * per-insight progress, retries the failures once, and always settles.
 */

export interface LabSyncJobState {
  id: string;
  status: 'running' | 'success' | 'error';
  /** Insights settled so far, and how many the run covers. */
  done: number;
  total: number;
  /** Which pass is running (the retry pass bumps it — see MAX_PASSES). */
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
  /** Every insight's latest outcome, newest write wins (manifest order). */
  results: SyncResult[];
  /** Slugs still failing after the last pass. */
  failed: string[];
  /** Set only when the job itself broke (not when individual insights failed). */
  error: string | null;
}

/** Failures get exactly one more pass — enough for a transient 429/blip,
 *  short of tripling the wall-clock on a board with a permanently broken source. */
const MAX_PASSES = 2;

/** Settled jobs older than this are pruned — the server runs indefinitely. */
const JOB_TTL_MS = 60 * 60 * 1000;

const jobs = new Map<string, LabSyncJobState>(); // contextRoot → latest job

function pruneSettledJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [root, job] of jobs) {
    if (job.status !== 'running' && (job.finishedAt ?? 0) < cutoff) jobs.delete(root);
  }
}

export function currentLabSyncJob(contextRoot: string): LabSyncJobState | null {
  pruneSettledJobs();
  return jobs.get(contextRoot) ?? null;
}

/** Test seam — the unit suite starts from a clean registry. */
export function _resetLabSyncJobs(): void {
  jobs.clear();
}

/**
 * Start a bulk sync (or adopt the one already running — two engines writing the
 * same cache files is how a double-click corrupts a snapshot). Returns
 * immediately; poll `currentLabSyncJob` for progress.
 */
export function startLabSyncJob(
  contextRoot: string,
  opts: { force?: boolean } = {},
): { job: LabSyncJobState; started: boolean } {
  pruneSettledJobs();
  const existing = jobs.get(contextRoot);
  if (existing?.status === 'running') return { job: existing, started: false };

  const job: LabSyncJobState = {
    id: `lsj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    done: 0,
    total: 0,
    attempt: 1,
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    failed: [],
    error: null,
  };
  jobs.set(contextRoot, job);
  void runLabSyncJob(contextRoot, job, opts.force !== false);
  return { job, started: true };
}

/** Merge a pass's results into the job, letting the newer outcome win per slug
 *  while keeping the first pass's ordering (the retry pass carries only failures). */
export function mergeLabResults(prior: SyncResult[], next: SyncResult[]): SyncResult[] {
  if (prior.length === 0) return next;
  const bySlug = new Map(next.map((r) => [r.slug, r]));
  const merged = prior.map((r) => bySlug.get(r.slug) ?? r);
  const seen = new Set(merged.map((r) => r.slug));
  return [...merged, ...next.filter((r) => !seen.has(r.slug))];
}

async function runLabSyncJob(
  contextRoot: string,
  job: LabSyncJobState,
  force: boolean,
): Promise<void> {
  try {
    const onProgress = (ev: LabSyncProgress): void => {
      job.done = ev.done;
      job.total = ev.total;
    };

    let pass = await syncAll(contextRoot, { force, onProgress });
    job.results = pass.results;
    job.failed = pass.failed.map((r) => r.slug);
    job.total = pass.results.length;
    job.done = pass.results.length;

    // One retry pass over the stragglers only. A source that 429'd or dropped a
    // socket while four insights hammered it in parallel deserves a second look
    // before the board tells the user it failed.
    while (job.failed.length > 0 && job.attempt < MAX_PASSES) {
      job.attempt++;
      const retrying = job.failed;
      job.done = 0;
      job.total = retrying.length;
      pass = await syncAll(contextRoot, { force: true, only: retrying, onProgress });
      job.results = mergeLabResults(job.results, pass.results);
      job.failed = pass.failed.map((r) => r.slug);
      job.done = job.total;
    }

    // Individual insight failures are NOT a job error — they are reported per
    // tile with their own message, and the run itself did its job. The job is
    // only `error` when the engine could not run at all.
    job.status = 'success';
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message ?? String(err);
  } finally {
    job.finishedAt = Date.now();
  }
}
