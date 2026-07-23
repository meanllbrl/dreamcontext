import { getTaskBackend } from '../lib/task-backend/index.js';
import { hardRefreshTasks } from '../lib/task-backend/hard-refresh.js';
import type { SyncDirection, SyncProgressEvent, SyncReport } from '../lib/task-backend/types.js';

/**
 * Background task-sync jobs for the dashboard. A bulk first sync (or a hard
 * refresh) runs for many minutes — far longer than a browser request should be
 * held open — so the POST only STARTS the job here in the server process and
 * the UI polls its state. Navigating away changes nothing: the job belongs to
 * the server, keeps running until it settles, and the Tasks page re-adopts it
 * (and its live progress) on the next poll.
 */
export interface SyncJobState {
  id: string;
  kind: 'sync' | 'hard-refresh';
  status: 'running' | 'success' | 'error';
  /** Live progress (mirrors SyncProgressEvent; phase null before the first tick). */
  phase: 'push' | 'pull' | null;
  current: number;
  total: number;
  bootstrap: boolean;
  /** Which sync pass is running (retries bump it — see MAX_PASSES). */
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
  report: SyncReport | null;
  error: string | null;
  /** hard-refresh only: where the pre-refresh mirrors were backed up. */
  backupDir: string | null;
}

/** Failed pushes are re-selected on the next pass — bounded, not a loop. */
const MAX_PASSES = 3;
/** A lock-skipped start (CLI/hook sync mid-flight) waits and retries this often… */
const LOCK_RETRY_MS = 5_000;
/** …for at most this many attempts before the job reports the conflict. */
const MAX_LOCK_RETRIES = 24;

const jobs = new Map<string, SyncJobState>(); // contextRoot → latest job

/** Settled jobs older than this are pruned — the server runs indefinitely. */
const JOB_TTL_MS = 60 * 60 * 1000;

function pruneSettledJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [root, job] of jobs) {
    if (job.status !== 'running' && (job.finishedAt ?? 0) < cutoff) jobs.delete(root);
  }
}

export function currentSyncJob(contextRoot: string): SyncJobState | null {
  pruneSettledJobs();
  return jobs.get(contextRoot) ?? null;
}

/**
 * Counters accumulate ACROSS retry passes (each backend.sync() returns a fresh
 * zeroed report — pass 2 re-pushing only the 5 stragglers must not make the
 * dashboard forget pass 1's 50). Diagnostic fields (errors, failedPushes,
 * warnings, watermark) stay from the LAST pass — they describe current state.
 */
export function mergeReports(total: SyncReport | null, next: SyncReport): SyncReport {
  if (!total) return next;
  return {
    ...next,
    pushed: total.pushed + next.pushed,
    pulled: total.pulled + next.pulled,
    created: total.created + next.created,
    deleted: total.deleted + next.deleted,
    mirrorDeleted: total.mirrorDeleted + next.mirrorDeleted,
    mirrorRemapped: total.mirrorRemapped + next.mirrorRemapped,
    commentsAdded: total.commentsAdded + next.commentsAdded,
    reconciled: total.reconciled + next.reconciled,
    conflicts: [...total.conflicts, ...next.conflicts],
  };
}

/**
 * Start a background job (or adopt the one already running — never two engines
 * for one project). Returns immediately; poll `currentSyncJob` for progress.
 */
export function startSyncJob(
  contextRoot: string,
  kind: 'sync' | 'hard-refresh',
  direction: SyncDirection = 'both',
): { job: SyncJobState; started: boolean } {
  pruneSettledJobs();
  const existing = jobs.get(contextRoot);
  if (existing?.status === 'running') return { job: existing, started: false };
  const job: SyncJobState = {
    id: `sj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: 'running',
    phase: null,
    current: 0,
    total: 0,
    bootstrap: false,
    attempt: 1,
    startedAt: Date.now(),
    finishedAt: null,
    report: null,
    error: null,
    backupDir: null,
  };
  jobs.set(contextRoot, job);
  void runJob(contextRoot, job, direction);
  return { job, started: true };
}

async function runJob(contextRoot: string, job: SyncJobState, direction: SyncDirection): Promise<void> {
  const onProgress = (ev: SyncProgressEvent): void => {
    job.phase = ev.phase;
    job.current = ev.current;
    job.total = ev.total;
    if (ev.bootstrap) job.bootstrap = true;
  };
  try {
    const backend = getTaskBackend(contextRoot);
    if (backend.name === 'local') throw new Error('no remote task backend configured.');

    let report: SyncReport;
    if (job.kind === 'hard-refresh') {
      const result = await hardRefreshTasks(backend, contextRoot, { onProgress });
      job.backupDir = result.backupDir;
      report = result.report;
    } else {
      report = await backend.sync(direction, { onProgress });
      // Lock held by a CLI/hook sync: wait for it instead of failing the job.
      for (let i = 0; report.skipped === 'locked' && i < MAX_LOCK_RETRIES; i++) {
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        report = await backend.sync(direction, { onProgress });
      }
      // "Runs until success": failed pushes stay drift-flagged and re-select,
      // and the rate window advances between passes — bounded retries, with
      // counters merged across passes (see mergeReports).
      while (report.failedPushes.length > 0 && job.attempt < MAX_PASSES) {
        job.attempt++;
        report = mergeReports(report, await backend.sync(direction, { onProgress }));
      }
    }

    job.report = report;
    // "Did anything happen" must count EVERY kind of work — a comment-only or
    // reconcile-only sync with one unrelated non-fatal error is a partial
    // success, not a total failure (final-gate review Major).
    const movedNothing =
      report.pushed + report.pulled + report.created + report.deleted +
      report.commentsAdded + report.reconciled + report.mirrorDeleted + report.mirrorRemapped === 0;
    if (report.skipped === 'locked') {
      job.status = 'error';
      job.error = 'another sync held the lock for the whole wait window — try again.';
    } else if (report.failedPushes.length > 0) {
      job.status = 'error';
      job.error = `${report.failedPushes.length} task(s) failed to push after ${job.attempt} pass(es): ${report.failedPushes.join(', ')}`;
    } else if (report.errors.length > 0 && movedNothing) {
      // Total failure (auth, missing list, offline): nothing moved and the
      // engine reported why — a "success" here would hide a dead sync.
      job.status = 'error';
      job.error = report.errors[0];
    } else {
      job.status = 'success';
    }
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message ?? String(err);
  } finally {
    job.finishedAt = Date.now();
  }
}
