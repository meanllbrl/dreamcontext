import {
  normalizeSyncForce,
  syncAll,
  type LabSyncProgress,
  type SyncForce,
  type SyncResult,
} from '../lib/lab/sync.js';

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
 * per-insight progress, retries the failures once (user/hard runs only), and
 * always settles.
 *
 * Per vault there is at most ONE running job and ONE queued follow-up. A
 * request the running job already covers (its slugs and a force at least as
 * strong) adopts it; any other request merges into the queued job (union of
 * slugs, the STRONGER force wins), which starts in the running job's `finally`
 * — so it runs even when the running job throws.
 */

export interface LabSyncJobState {
  id: string;
  /** `queued` = waiting for the running job to settle; it then starts itself. */
  status: 'queued' | 'running' | 'success' | 'error';
  /** Insights settled so far, and how many the run covers. */
  done: number;
  total: number;
  /** Which pass is running (the retry pass bumps it — see MAX_PASSES). */
  attempt: number;
  /** When the job was created (queued jobs: when they were queued; reset on start). */
  startedAt: number;
  finishedAt: number | null;
  /** Every insight's latest outcome, newest write wins (manifest order).
   *  Filled LIVE as each insight settles, so a board card flips from syncing
   *  to its outcome mid-run, not only at the end. */
  results: SyncResult[];
  /** Slugs still failing after the last pass. */
  failed: string[];
  /** Set only when the job itself broke (not when individual insights failed). */
  error: string | null;
  /** The slugs this run is scoped to (one board's insights), or null = every insight. */
  slugs: string[] | null;
  /** How hard this run pushes past the freshness gate; null = automatic
   *  (TTL + error backoff apply, no retry pass). */
  force: SyncForce | null;
  /** The insight that settled most recently ("now syncing …" copy). */
  current: string | null;
}

/** Both slots of one vault, for the route layer. `running` is the most recent
 *  STARTED job (its status says whether it is still running); `queued` is the
 *  follow-up waiting for it, or null. */
export interface LabSyncJobSlots {
  running: LabSyncJobState | null;
  queued: LabSyncJobState | null;
}

/** What a start request produced. `job` is the job that serves the request:
 *  a new one (`started`), the running one it adopted, or the queued follow-up
 *  (`queued: true`). */
export interface LabSyncJobStart {
  job: LabSyncJobState;
  started: boolean;
  queued: boolean;
  running: LabSyncJobState | null;
  pending: LabSyncJobState | null;
}

/** Failures get exactly one more pass — enough for a transient 429/blip,
 *  short of tripling the wall-clock on a board with a permanently broken source. */
const MAX_PASSES = 2;

/** Settled jobs older than this are pruned — the server runs indefinitely. */
const JOB_TTL_MS = 60 * 60 * 1000;

const FORCE_RANK: Record<'auto' | SyncForce, number> = { auto: 0, user: 1, hard: 2 };
const rank = (force: SyncForce | null): number => FORCE_RANK[force ?? 'auto'];

const vaults = new Map<string, LabSyncJobSlots>(); // contextRoot → slots

function pruneSettledJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [root, slots] of vaults) {
    const job = slots.running;
    if (job && job.status !== 'running' && (job.finishedAt ?? 0) < cutoff && !slots.queued) vaults.delete(root);
  }
}

export function currentLabSyncJob(contextRoot: string): LabSyncJobState | null {
  pruneSettledJobs();
  return vaults.get(contextRoot)?.running ?? null;
}

/** Both slots (running + queued) for the route layer. */
export function labSyncJobSlots(contextRoot: string): LabSyncJobSlots {
  pruneSettledJobs();
  const slots = vaults.get(contextRoot);
  return { running: slots?.running ?? null, queued: slots?.queued ?? null };
}

/** Test seam — the unit suite starts from a clean registry. */
export function _resetLabSyncJobs(): void {
  vaults.clear();
}

/** Test seam — the engine the job layer drives (syncAll by default). */
type SyncAllFn = typeof syncAll;
let syncAllImpl: SyncAllFn = syncAll;
export function _setLabSyncAllImpl(impl: SyncAllFn | null): void {
  syncAllImpl = impl ?? syncAll;
}

interface JobRequest {
  force: SyncForce | null;
  slugs: string[] | null;
}

function newJob(req: JobRequest, status: 'queued' | 'running'): LabSyncJobState {
  return {
    id: `lsj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    status,
    done: 0,
    total: 0,
    attempt: 1,
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    failed: [],
    error: null,
    slugs: req.slugs ? [...req.slugs] : null,
    force: req.force,
    current: null,
  };
}

/** Does the running job already do what this request asks? Its force must be
 *  at least as strong and its slugs a superset. */
function covers(job: LabSyncJobState, req: JobRequest): boolean {
  if (rank(job.force) < rank(req.force)) return false;
  if (job.slugs !== null) {
    if (req.slugs === null) return false;
    const have = new Set(job.slugs);
    if (!req.slugs.every((s) => have.has(s))) return false;
  }
  return true;
}

/** Fold a later request into the queued job: union of slugs (null = every
 *  insight absorbs any subset) and the stronger force. */
function mergeInto(queued: LabSyncJobState, req: JobRequest): void {
  if (queued.slugs === null || req.slugs === null) queued.slugs = null;
  else queued.slugs = [...new Set([...queued.slugs, ...req.slugs])];
  if (rank(req.force) > rank(queued.force)) queued.force = req.force;
}

/**
 * Start a bulk sync, adopt the running one when it covers this request (two
 * engines writing the same cache files is how a double-click corrupts a
 * snapshot), or queue ONE follow-up that later requests merge into. Returns
 * immediately; poll `currentLabSyncJob` / `labSyncJobSlots` for progress.
 *
 * `force` absent (or false) = automatic; `true` is read as `'user'`.
 */
export function startLabSyncJob(
  contextRoot: string,
  opts: { force?: boolean | SyncForce; slugs?: string[] } = {},
): LabSyncJobStart {
  pruneSettledJobs();
  const req: JobRequest = {
    force: normalizeSyncForce(opts.force) ?? null,
    slugs: opts.slugs && opts.slugs.length > 0 ? [...opts.slugs] : null,
  };
  let slots = vaults.get(contextRoot);
  if (!slots) {
    slots = { running: null, queued: null };
    vaults.set(contextRoot, slots);
  }
  const running = slots.running;
  if (running?.status === 'running') {
    if (covers(running, req)) {
      return { job: running, started: false, queued: false, running, pending: slots.queued };
    }
    if (slots.queued) mergeInto(slots.queued, req);
    else slots.queued = newJob(req, 'queued');
    return { job: slots.queued, started: false, queued: true, running, pending: slots.queued };
  }

  const job = newJob(req, 'running');
  slots.running = job;
  void runLabSyncJob(contextRoot, job);
  return { job, started: true, queued: false, running: job, pending: slots.queued };
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

/** Promote the vault's queued follow-up to running. Never throws. */
function startQueued(contextRoot: string): void {
  const slots = vaults.get(contextRoot);
  const next = slots?.queued;
  if (!slots || !next) return;
  slots.queued = null;
  slots.running = next;
  next.status = 'running';
  next.startedAt = Date.now();
  void runLabSyncJob(contextRoot, next);
}

async function runLabSyncJob(
  contextRoot: string,
  job: LabSyncJobState,
): Promise<void> {
  const force = job.force ?? undefined;
  try {
    const onProgress = (ev: LabSyncProgress): void => {
      job.done = ev.done;
      job.total = ev.total;
      job.current = ev.slug;
      // Live per-insight results: a board card shows ITS outcome the moment
      // its insight settles, mid-run.
      job.results = mergeLabResults(job.results, [
        {
          slug: ev.slug,
          status: ev.status,
          ...(ev.error !== undefined ? { error: ev.error } : {}),
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
        },
      ]);
    };

    let pass = await syncAllImpl(contextRoot, {
      force,
      only: job.slugs ?? undefined,
      onProgress,
    });
    job.results = pass.results;
    job.failed = pass.failed.map((r) => r.slug);
    job.total = pass.results.length;
    job.done = pass.results.length;

    // One retry pass over the stragglers only, and only for a run someone
    // asked for ('user'/'hard', inheriting its force). A source that 429'd or
    // dropped a socket while four insights hammered it in parallel deserves a
    // second look before the board tells the user it failed; an AUTOMATIC run
    // never retries — the error backoff is what keeps it off a broken source.
    while (force && job.failed.length > 0 && job.attempt < MAX_PASSES) {
      job.attempt++;
      const retrying = job.failed;
      job.done = 0;
      job.total = retrying.length;
      pass = await syncAllImpl(contextRoot, {
        force,
        only: retrying,
          onProgress,
      });
      job.results = mergeLabResults(job.results, pass.results);
      job.failed = pass.failed.map((r) => r.slug);
      job.done = job.total;
    }

    // Individual insight failures are NOT a job error — they are reported per
    // tile with their own message, and the run itself did its job. The job is
    // only `error` when the engine could not run at all.
    job.status = 'success';
    job.current = null;
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error)?.message ?? String(err);
  } finally {
    job.finishedAt = Date.now();
    // The queued follow-up starts HERE, so it runs even when this job threw.
    startQueued(contextRoot);
  }
}
