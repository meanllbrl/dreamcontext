import { dirname } from 'node:path';
import { runAutomation, type RunOutcome } from '../lib/automations/runner.js';
import { enqueueFire } from '../lib/automations/queue.js';
import { trackChild } from './lifecycle.js';

/**
 * Background "run now" jobs for the dashboard's Automations page — the exact
 * `sync-job.ts` polling pattern applied to `runAutomation`: the POST only
 * STARTS the run in the server process (a headless `claude -p` call can run
 * for up to an hour) and the UI polls `currentAutomationJob` for its outcome.
 */
export interface AutomationJobState {
  id: string;
  slug: string;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  finishedAt: number | null;
  outcome: RunOutcome | null;
  error: string | null;
}

const jobs = new Map<string, AutomationJobState>(); // contextRoot → latest job

/** Settled jobs older than this are pruned — the server runs indefinitely. */
const JOB_TTL_MS = 60 * 60 * 1000;

function pruneSettledJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [root, job] of jobs) {
    if (job.status !== 'running' && (job.finishedAt ?? 0) < cutoff) jobs.delete(root);
  }
}

export function currentAutomationJob(contextRoot: string): AutomationJobState | null {
  pruneSettledJobs();
  return jobs.get(contextRoot) ?? null;
}

/**
 * Start a background "run now" job (or adopt the one already running — never
 * two engines for one project, mirroring `startSyncJob`). Returns immediately;
 * poll `currentAutomationJob` for progress. Approval, the sleep-lock deferral,
 * and the orphan guard are all enforced INSIDE `runAutomation` — this function
 * carries no prompt and no bypass of its own.
 */
export function startAutomationJob(contextRoot: string, slug: string): { job: AutomationJobState; started: boolean } {
  pruneSettledJobs();
  const existing = jobs.get(contextRoot);
  if (existing?.status === 'running') return { job: existing, started: false };
  const job: AutomationJobState = {
    id: `aj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    slug,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    outcome: null,
    error: null,
  };
  jobs.set(contextRoot, job);
  void runJob(contextRoot, job);
  return { job, started: true };
}

async function runJob(contextRoot: string, job: AutomationJobState): Promise<void> {
  try {
    const outcome = await runAutomation(contextRoot, job.slug, {
      host: 'server',
      // CALLBACK form — NEVER trackChild(child). trackChild's ChildProcess
      // branch does `child.kill()`, which signals the PID only; the automation
      // child is `detached: true`, so a PID-only kill leaves its process group
      // (and any grandchildren) alive — a cosmetic no-op that looks correct and
      // does nothing. Mirrors agent-terminal.ts:1329 (callback form), NOT
      // agent-chat.ts:336 (ChildProcess form — valid there only because that
      // child is not detached). The runner itself calls this and invokes the
      // returned untrack function in its own cleanup — nothing further to do
      // here, and this scope never even holds a reference to the ChildProcess.
      registerChild: (killGroup) => trackChild(killGroup),
    });
    job.outcome = outcome;
    job.status = outcome.status === 'ok' ? 'success' : 'error';
    if (outcome.status !== 'ok') job.error = outcome.error;
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message ?? String(err);
    // `runAutomation` REJECTS only for the two precondition violations it
    // documents (a non-POSIX platform, a broken `host:"server"` contract) —
    // every operational outcome, lock-busy included, RESOLVES and is handled
    // above. A rejection here means no RunEvent was ever recorded and no
    // watermark advanced, so without this the fire is silently dropped: the
    // job just shows `error` and nothing ever retries it. Queue it exactly
    // like the runner's own lock-busy path does, so the next dispatcher tick's
    // `drainQueue` catches it up, bounded by `catchupHours` like any other
    // deferred fire. Best-effort: a queue write failure must not mask the
    // original error, which is why this is its own try/catch.
    try {
      enqueueFire(dirname(contextRoot), job.slug, new Date(job.startedAt).toISOString());
    } catch {
      // a queue that cannot be written leaves the fire simply not owed —
      // the same degrade `runAutomation`'s own enqueue failure accepts.
    }
  } finally {
    job.finishedAt = Date.now();
  }
}
