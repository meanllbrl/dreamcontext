import { dirname } from 'node:path';
import { runAutomation, type RunOutcome } from '../lib/automations/runner.js';
import { enqueueFire } from '../lib/automations/queue.js';
import { appendThreadEntry, readThread } from '../lib/automations/threads.js';
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
  /** The run this job's fire belongs to (`RunEvent.firedAt`), known BEFORE the
   *  run starts because the caller fixes `fireAt`. It is how a caller that
   *  already wrote into this run's thread — the `#agents` composer — addresses
   *  the message it just posted. `null` for a plain "run now". */
  runId: string | null;
}

/** What turns a "run now" into an ASK: the human's words, and the fire time the
 *  caller has already used as a thread root. Both or neither. */
export interface AutomationAsk {
  text: string;
  fireAt: Date;
}

/**
 * Why a fire never became a run, in the words the person who asked for it
 * needs. Every one of these dispositions writes NOTHING to the thread on the
 * scheduled path, deliberately — see `ThreadSystemEvent`.
 *
 * NOT the test for whether to write one — see `answerIfSilent`. This is a
 * lookup for a better sentence when the status happens to be one we have
 * words for, and a status missing from it is not a bug.
 */
const SKIP_REASON: Record<string, string> = {
  blocked: 'It did not run — this agent is not approved on this machine yet. Approve it and ask again.',
  deferred: 'It did not run — a sleep cycle holds the lock right now. Ask again once it finishes.',
  orphaned: 'It did not run — the run was orphaned before it started.',
  'awaiting-review': 'It did not run — an earlier run of this agent is still waiting on your verdict. Clear that first.',
  'awaiting-approval': 'It did not run — the agent was edited since you approved it, so it asked about the change instead.',
};

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
export function startAutomationJob(
  contextRoot: string,
  slug: string,
  /** Present when a human called this agent by name from `#agents`. Adds the
   *  ask to the prompt and makes the job accountable for saying so in the
   *  thread if the fire never becomes a run. */
  ask?: AutomationAsk,
): { job: AutomationJobState; started: boolean } {
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
    runId: ask ? ask.fireAt.toISOString() : null,
  };
  jobs.set(contextRoot, job);
  void runJob(contextRoot, job, ask);
  return { job, started: true };
}

/**
 * Make sure an ASK got an answer of some kind, and say why not when it did
 * not. ONLY for an ask — a scheduled fire that is blocked or deferred stays
 * silent on purpose, because it is still due and would post the same line
 * every five minutes forever. An ask happens once, so this happens at most
 * once.
 *
 * THE TEST IS "DID THE RUN SAY ANYTHING", NOT "WHICH STATUS IS THIS", and
 * that distinction is the whole function. Enumerating statuses gets it wrong
 * in both directions, which a first cut proved:
 *
 *  - TOO FEW — `RunStatus` has eight members and the obvious three
 *    (`blocked`/`deferred`/`orphaned`) are not all of the silent ones. A slug
 *    with an unanswered question already open short-circuits BEFORE any child
 *    spawns (runner.ts, step 4.5) as `awaiting-approval`/`awaiting-review`,
 *    writing no `started` and no terminal entry — so the owner's words sat
 *    under a message that read "running" for ever, with the answer only
 *    reachable through `automations questions <slug>`.
 *  - TOO MANY — but `awaiting-review` is ALSO what the two MID-RUN review
 *    paths settle to, and those DO write their own `asked` entry. Adding the
 *    status to the list would have posted "it did not run" onto a run that
 *    ran and stopped to ask, so one message would carry both "needs you" and
 *    a denial that anything happened.
 *
 * Asking the thread what is in it answers both, and keeps answering for a
 * status added after this was written.
 *
 * Best-effort, like every other thread write on a run path: a channel that
 * cannot be written must not change what the job reports.
 */
function answerIfSilent(contextRoot: string, slug: string, runId: string, text: string): void {
  try {
    // Everything except the ask itself. The ask is the question; a question
    // left alone in a run is exactly the state this exists to close.
    const spoken = readThread(contextRoot, slug, { runId }).some((e) => e.kind !== 'user');
    if (spoken) return;
    appendThreadEntry(contextRoot, slug, { runId, kind: 'system', event: 'skipped', text, via: 'dashboard' });
  } catch {
    // nothing to do — the job's own status still carries the truth
  }
}

/** The sentence for a fire that said nothing, best available. */
function skipText(status: string, error: string | null): string {
  return SKIP_REASON[status]
    ?? `It did not run${error ? ` — ${error}` : ` — the run ended as "${status}" without starting.`}`;
}

async function runJob(contextRoot: string, job: AutomationJobState, ask?: AutomationAsk): Promise<void> {
  try {
    const outcome = await runAutomation(contextRoot, job.slug, {
      host: 'server',
      ...(ask ? { ask: ask.text, fireAt: ask.fireAt } : {}),
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
    // An ask that produced no run leaves a question in the channel with
    // nothing under it — and, because no `started` entry was ever written
    // either, a message that reads "running" for ever. Answer it.
    if (ask && job.runId && outcome.status !== 'ok') {
      answerIfSilent(contextRoot, job.slug, job.runId, skipText(outcome.status, outcome.error));
    }
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message ?? String(err);
    if (ask && job.runId) {
      answerIfSilent(contextRoot, job.slug, job.runId, 'It did not run — the run could not be started on this machine.');
    }
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
