import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runAutomation, type RunOutcome } from '../lib/automations/runner.js';
import { enqueueFire } from '../lib/automations/queue.js';
import {
  announceTurn, appendThreadEntry, newThreadEntryId, readThread,
} from '../lib/automations/threads.js';
import {
  getAutomation, listAutomations, lockPathFor, readRunSidecar,
} from '../lib/automations/store.js';
import { resumeWithAnswer, resumeWithMessage, type TalkOutcome } from '../lib/automations/verdict.js';
import { pendingQuestion } from '../lib/automations/hitl.js';
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
  blocked: 'It did not run. This agent is not approved on this machine yet. Approve it, then ask again.',
  deferred: 'It did not run. A sleep cycle holds the lock right now. Ask again once it finishes.',
  orphaned: 'It did not run. The run was orphaned before it started.',
  'awaiting-review': 'It did not run. An earlier run of this agent is still waiting on your verdict. Clear that first.',
  'awaiting-approval': 'It did not run. The agent was edited since you approved it, so it asked about the change instead.',
};

/**
 * contextRoot → slug → that AGENT's latest job.
 *
 * One slot per agent, not per project (owner decision 2026-09-25): two different agents
 * run side by side, and only a second run of the SAME agent is refused, because both
 * would write into one thread and resume one session. Same-agent overlap that does not
 * come through here — a scheduler fire, a CLI run, a reply turn — is still refused by the
 * per-slug run lock inside the runner (`runner.ts`, the lock check after the sleep lock).
 */
const jobs = new Map<string, Map<string, AutomationJobState>>();

/** Settled jobs older than this are pruned — the server runs indefinitely. */
const JOB_TTL_MS = 60 * 60 * 1000;

function pruneSettledJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [root, bySlug] of jobs) {
    for (const [slug, job] of bySlug) {
      if (job.status !== 'running' && (job.finishedAt ?? 0) < cutoff) bySlug.delete(slug);
    }
    if (bySlug.size === 0) jobs.delete(root);
  }
}

/**
 * One agent's job when `slug` is given. Without it, the project's NEWEST job — a running
 * one before any settled one — which is what the single-slot callers (`GET /runs`, the
 * "run now" poll) always read, so they keep their meaning.
 */
export function currentAutomationJob(contextRoot: string, slug?: string): AutomationJobState | null {
  pruneSettledJobs();
  const bySlug = jobs.get(contextRoot);
  if (!bySlug) return null;
  if (slug !== undefined) return bySlug.get(slug) ?? null;
  let best: AutomationJobState | null = null;
  for (const job of bySlug.values()) {
    if (!best) { best = job; continue; }
    const running = job.status === 'running';
    const bestRunning = best.status === 'running';
    if (running !== bestRunning ? running : job.startedAt > best.startedAt) best = job;
  }
  return best;
}

/** Every agent with a run in flight in this project, oldest first. */
export function runningAutomationJobs(contextRoot: string): AutomationJobState[] {
  pruneSettledJobs();
  return [...(jobs.get(contextRoot)?.values() ?? [])]
    .filter((j) => j.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Start a background "run now" job for one agent (or adopt that agent's job when it is
 * already running — never two engines for one AGENT; different agents run in parallel).
 * Returns immediately; poll `currentAutomationJob` for progress. Approval, the sleep-lock
 * deferral, and the orphan guard are all enforced INSIDE `runAutomation` — this function
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
  let bySlug = jobs.get(contextRoot);
  const existing = bySlug?.get(slug);
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
  if (!bySlug) { bySlug = new Map(); jobs.set(contextRoot, bySlug); }
  bySlug.set(slug, job);
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
    ?? `It did not run. ${error
      // A runner error can start lower-case; it follows a full stop here.
      ? `${error.charAt(0).toUpperCase()}${error.slice(1)}`
      : `The run ended as "${status}" without starting.`}`;
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
      answerIfSilent(contextRoot, job.slug, job.runId, 'It did not run. The run could not be started on this machine.');
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

// ─── Reply jobs — a human's words into the run's own session ────────────────

/**
 * When THIS server process started.
 *
 * It is what makes reconciliation's race closure exact rather than approximate:
 * every `user` entry this process wrote has a {@link ReplyJobState} whose `finally`
 * will close it, so only an entry written by a PREVIOUS process can be an orphan.
 * Without it, reconciliation would race the entry-before-spawn window and close a
 * reply that is still running.
 */
export const PROCESS_STARTED_AT = Date.now();

/** One in-flight (or recently settled) reply turn. */
export interface ReplyJobState {
  id: string;
  slug: string;
  /** The run whose session this reply resumes — `RunEvent.firedAt`. */
  runId: string;
  /** The `user` entry this job is delivering. What reconciliation keys on. */
  entryId: string;
  status: 'running' | 'ok' | 'refused' | 'failed';
  /** While `running`: `waiting` behind the turn that holds this agent's run lock, or
   *  `delivering` once it holds the lock itself. Meaningless once settled. */
  phase: 'waiting' | 'delivering';
  /** The server's own sentence on a non-ok settle — never a generic "failed".
   *  On `refused` this is `resumeWithMessage`'s reason, already written for a human. */
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Keyed by JOB ID, not by `contextRoot`.
 *
 * `jobs` above is ONE SLOT per agent and ADOPTS that agent's job when it is already
 * running — correct for "run now" (never two engines for one agent) and exactly wrong
 * here, where a job is one reply turn and its id is what the client polls. Concurrency is not
 * this map's business at all: it is owned end to end by the per-slug run lock inside
 * `resumeWithMessage`, which refuses with its own sentence when a run holds it.
 */
const replyJobs = new Map<string, ReplyJobState>();

/** Settled reply jobs older than this are pruned. */
const REPLY_JOB_TTL_MS = 60 * 60 * 1000;

/**
 * SETTLEMENT-based, never age-based: a `running` job is kept no matter how old it is.
 * A reply resume legitimately runs as long as the automation's own timeout allows, so
 * pruning by age would drop the registry entry for a job still in flight and answer its
 * poll with 404 — which the client reads as "the server restarted", the one thing that
 * is not happening.
 */
function pruneSettledReplyJobs(now: number = Date.now()): void {
  const cutoff = now - REPLY_JOB_TTL_MS;
  for (const [id, job] of replyJobs) {
    if (job.status === 'running') continue;
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
    if (Number.isFinite(finished) && finished < cutoff) replyJobs.delete(id);
  }
}

/** The job behind a poll, or null once it has been pruned (which the client reads as
 *  "this server no longer knows" — a terminal state, not a retry). */
export function currentReplyJob(jobId: string): ReplyJobState | null {
  pruneSettledReplyJobs();
  return replyJobs.get(jobId) ?? null;
}

/**
 * WHAT ONE AGENT IS DOING RIGHT NOW, for the thread and the channel to draw.
 *
 * Asked of the subject, not of this process's bookkeeping: the per-slug RUN LOCK is held by
 * every turn of an agent whatever started it (a scheduled fire, the CLI, "run now", a reply
 * resume, an answer), so it is the one place "is it working" has a true answer. `runSlots`
 * only ever knew the runs this server started, which is why a reply turn or a scheduled run
 * used to look idle in its own thread.
 *
 * `runId` is the thread that turn writes into: the reply job holding the lock knows its own,
 * and a run's sidecar carries its fire time, which IS its thread's run id. Null when neither
 * says (the moment before a run's child spawns).
 *
 * `queued` is every reply still WAITING for the lock, oldest first, so the thread can mark
 * the message the reader just sent as queued rather than leave them guessing.
 */
export interface AgentActivity {
  /** When the turn holding the lock began, epoch ms. */
  since: number;
  runId: string | null;
  queued: { entryId: string; runId: string }[];
}

/** The run lock's holder, or null when it is free, unreadable, dead or past its window. */
function liveLockSince(contextRoot: string, slug: string, staleMs: number, nowMs: number): number | null {
  let info: { pid?: unknown; at?: unknown };
  try {
    info = JSON.parse(readFileSync(lockPathFor(contextRoot, slug), 'utf-8')) as typeof info;
  } catch {
    return null;
  }
  const at = typeof info.at === 'number' && Number.isFinite(info.at) ? info.at : null;
  if (at === null || nowMs - at > staleMs) return null;
  if (typeof info.pid === 'number' && Number.isInteger(info.pid) && info.pid > 0) {
    try {
      process.kill(info.pid, 0);
    } catch (err) {
      // ESRCH: the holder is gone and the lock is litter. EPERM: alive, just not ours.
      if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return null;
    }
  }
  return at;
}

export function agentActivity(
  contextRoot: string,
  slug: string,
  nowMs: number = Date.now(),
): AgentActivity | null {
  pruneSettledReplyJobs(nowMs);
  const manifest = getAutomation(contextRoot, slug);
  const staleMs = ((manifest?.timeoutMinutes ?? 30) * 60_000) + 300_000;
  const mine = [...replyJobs.values()]
    .filter((j) => j.slug === slug && j.status === 'running')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const delivering = mine.find((j) => j.phase === 'delivering') ?? null;
  const waiting = mine.filter((j) => j.phase === 'waiting');
  const since = liveLockSince(contextRoot, slug, staleMs, nowMs);
  const queued = waiting.map((j) => ({ entryId: j.entryId, runId: j.runId }));
  if (since === null) {
    // Nothing holds the lock, but a reply is about to take it (it polls): the agent is
    // about to work on it, which is what the reader needs to hear.
    if (waiting.length === 0) return null;
    const [next, ...rest] = waiting;
    return {
      since: Date.parse(next.startedAt) || nowMs,
      runId: next.runId,
      queued: rest.map((j) => ({ entryId: j.entryId, runId: j.runId })),
    };
  }
  const runJob = jobs.get(contextRoot)?.get(slug);
  const runId = delivering?.runId
    ?? readRunSidecar(contextRoot, slug)?.fireAt
    ?? (runJob?.status === 'running' ? runJob.runId : null);
  return { since, runId, queued };
}

/** {@link agentActivity} for every agent in the project that is doing something. */
export function agentActivities(contextRoot: string, nowMs: number = Date.now()): Record<string, AgentActivity> {
  const out: Record<string, AgentActivity> = {};
  for (const m of listAutomations(contextRoot)) {
    const a = agentActivity(contextRoot, m.slug, nowMs);
    if (a) out[m.slug] = a;
  }
  return out;
}

/**
 * Same shape as the runner's own row (`formatRunDuration`), duplicated rather than
 * imported: that one is private to `runner.ts` and this is six lines. Keeping the two
 * identical matters more than sharing them — a reply turn and a run report their length
 * into the same channel, and two spellings of "1m 12s" in one thread reads as a bug.
 */
function formatTurnDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * What the turn cost, or null when there is nothing honest to say.
 *
 * TWO DECIMALS, matching the CHANNEL — `AgentMessage`'s own `cost()` renders a run's cost
 * the same way, and this row sits directly under those messages. The CLI's run-history
 * table spends four (`automations.ts`), which is right for a table you read to audit spend
 * and wrong for a one-line status row.
 *
 * Inlined rather than shared because there is no cost formatter in `src/lib/automations`
 * or `src/server` to reuse: the only two in the tree are the dashboard's (a different
 * bundle this cannot import) and the CLI's (a different precision for a different job).
 * Same reasoning as `formatTurnDuration` above.
 *
 * Null — not `$0.00` — when the envelope reported nothing: a turn whose cost is UNKNOWN
 * and a turn that was FREE are different claims, and only one of them is ever true here.
 */
function formatTurnCost(usd: number | null | undefined): string | null {
  return typeof usd === 'number' && Number.isFinite(usd) ? `$${usd.toFixed(2)}` : null;
}

/** The ms prefix `newThreadEntryId` encodes — 9 base36 chars, then `_`. Returns NaN for
 *  anything that is not one of our ids, and every caller treats NaN as "not ours". */
function entryIdMs(id: string): number {
  return Number.parseInt(id.slice(0, 9), 36);
}

/**
 * THE JOB'S OWN COMPLETION — run from `finally`, never from a client callback.
 *
 * That placement is the whole guarantee: a browser tab closed mid-reply changes nothing,
 * because nothing here is waiting on the client. Best-effort as a block, like every other
 * thread write on a run path — a channel that cannot be written must not change what the
 * job reports.
 */
function settleReplyThread(
  contextRoot: string,
  job: ReplyJobState,
  outcome: TalkOutcome | null,
  home?: string,
): void {
  try {
    const ms = Date.parse(job.finishedAt ?? '') - Date.parse(job.startedAt);
    const took = Number.isFinite(ms) ? formatTurnDuration(ms) : null;
    // `?? null` because `costUsd` is OPTIONAL on TalkOutcome — it arrived after the type
    // had several producers, including doubles in other lanes' suites, so a consumer reads
    // it defensively rather than assuming every producer sets it.
    const spent = formatTurnCost(outcome?.costUsd ?? null);

    // EXACTLY ONE terminal entry, and its EVENT carries the outcome. `replied` maps to
    // the `done` status word; anything else maps to `failed` — which is what stops a
    // fresh-runId @mention from reading "running" for ever, since that run has no cache
    // record for `statusFor` to fall back to.
    const ok = job.status === 'ok';
    appendThreadEntry(contextRoot, job.slug, {
      runId: job.runId,
      kind: 'system',
      event: ok ? 'replied' : 'failed',
      via: 'runner',
      text: ok
        ? `Reply delivered${took ? ` · ${took}` : ''}${spent ? ` · ${spent}` : ''}.`
        : `Reply not delivered${took ? ` · ${took}` : ''}${spent ? ` · ${spent}` : ''}${job.reason ? `: ${job.reason}` : ''}`,
    });

    // THE ZERO-POST MIRROR. The resumed child is told to answer by POSTING, and a good
    // one does — but a reply that produced an answer and posted nothing would otherwise
    // look unanswered for ever. Mirrored only when it genuinely said nothing of its own,
    // and marked `via: 'runner'` so a reader can tell "the agent said this" from "the
    // runner said it on the agent's behalf".
    if (ok && outcome?.result) {
      const spokeSince = readThread(contextRoot, job.slug, { runId: job.runId })
        .some((e) => e.kind === 'agent' && e.id > job.entryId);
      if (!spokeSince) {
        appendThreadEntry(contextRoot, job.slug, {
          runId: job.runId, kind: 'agent', via: 'runner', text: outcome.result,
        });
      }
    }

    // One banner for the turn, judged on the AGENT'S post being unread — see `announceTurn`.
    // Nothing else announces a reply-turn post: the run's own completion banner fired
    // long ago.
    if (ok) announceTurn(contextRoot, job.slug, job.entryId, outcome?.result ?? null, home);
  } catch {
    // The job's own status still carries the truth, and the poll still reports it.
  }
}

/**
 * Deliver a human's reply into the run's bound session, as a job.
 *
 * ALWAYS starts — it never adopts another job, because two agents replying at once is
 * the normal case in a channel. What it does NOT do is take a lock: `resumeWithMessage`
 * owns the per-slug run lock. A reply to a busy slug WAITS for it (bounded by the run's
 * timeout) and is delivered when the turn ahead of it ends; a reply to a different slug
 * runs beside it. A reply to an agent waiting on a question answers that question.
 */
export function startAutomationReplyJob(
  contextRoot: string,
  slug: string,
  opts: { runId: string; text: string; entryId: string; home?: string; lockPollMs?: number },
): ReplyJobState {
  pruneSettledReplyJobs();
  const job: ReplyJobState = {
    // Sortable and unique, the same generator the entries use — a job id that sorts is
    // one less thing to explain when two are in flight.
    id: newThreadEntryId(),
    slug,
    runId: opts.runId,
    entryId: opts.entryId,
    status: 'running',
    phase: 'waiting',
    reason: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  replyJobs.set(job.id, job);
  void runReplyJob(contextRoot, job, opts);
  return job;
}

/**
 * A reply in the thread of an agent that is WAITING ON A QUESTION is the answer to it.
 *
 * The owner does not distinguish "the answer box" from "the reply box", and should not have
 * to: both are them talking to the agent about this run. Refusing a reply with "answer its
 * question first" sent them hunting for a second field that says the same thing. So a
 * pending `flow-hitl` question takes the reply as its answer, through the one path every
 * answer uses (`resumeWithAnswer`: claim, resume, note). An `approval` question is the
 * manifest-diff ask, which takes an explicit decision and never prose, so it keeps the
 * refusal. Checked again after a queued message got the lock: the turn it waited behind can
 * have asked the question.
 */
async function replyOrAnswer(
  contextRoot: string,
  slug: string,
  text: string,
  verdictOpts: Parameters<typeof resumeWithMessage>[3] & object,
): Promise<TalkOutcome> {
  // Synchronous up to the first resume call, on purpose: the job starts its turn in the
  // same tick it was created, exactly as it did before this routing existed.
  const openQuestion = () => {
    const q = pendingQuestion(contextRoot, slug);
    return q && q.kind === 'flow-hitl' ? q : null;
  };
  const answer = async (q: NonNullable<ReturnType<typeof openQuestion>>): Promise<TalkOutcome> => {
    const answered = await resumeWithAnswer(contextRoot, q, text, 'dashboard', verdictOpts);
    return { status: answered.status, error: answered.error, result: answered.result, costUsd: null };
  };
  const first = openQuestion();
  if (first) return answer(first);
  const talked = await resumeWithMessage(contextRoot, slug, text, verdictOpts);
  if (talked.status === 'refused') {
    const late = openQuestion();
    if (late) return answer(late);
  }
  return talked;
}

async function runReplyJob(
  contextRoot: string,
  job: ReplyJobState,
  opts: { text: string; home?: string; lockPollMs?: number },
): Promise<void> {
  let outcome: TalkOutcome | null = null;
  try {
    const manifest = getAutomation(contextRoot, job.slug);
    const verdictOpts = {
      surface: 'thread' as const,
      ...(opts.home ? { home: opts.home } : {}),
      // The two run-binding HINTS, so the resumed child's `automations post` lands in
      // THIS run's thread with no ids to pass. `VerdictOptions.env` is typed to exactly
      // these two keys, so nothing else can ride along into a bypassPermissions child.
      env: { DREAMCONTEXT_AUTOMATION_SLUG: job.slug, DREAMCONTEXT_AUTOMATION_RUN: job.runId },
      // QUEUED, never refused, behind whatever holds the lock: the run itself, or the
      // resume an answer started a moment ago. Bounded by the run's own envelope plus a
      // minute, which is the longest the turn ahead of it can legitimately take.
      lockWaitMs: ((manifest?.timeoutMinutes ?? 30) + 1) * 60_000,
      ...(opts.lockPollMs ? { lockPollMs: opts.lockPollMs } : {}),
      onLockAcquired: () => { job.phase = 'delivering'; },
    };
    outcome = await replyOrAnswer(contextRoot, job.slug, opts.text, verdictOpts);
    job.status = outcome.status === 'ok' ? 'ok' : outcome.status === 'refused' ? 'refused' : 'failed';
    job.reason = outcome.error;
  } catch (err) {
    job.status = 'failed';
    job.reason = (err as Error).message ?? String(err);
  } finally {
    job.finishedAt = new Date().toISOString();
    settleReplyThread(contextRoot, job, outcome, opts.home);
  }
}

/**
 * In-process de-duplication, memoizing the PROMISE rather than a flag.
 *
 * A flag is set before the work finishes, so two concurrent first requests both see
 * "not yet done" and both reconcile. Storing the promise makes the second caller await
 * the first one's work instead of repeating it.
 */
const reconciling = new Map<string, Promise<void>>();

/**
 * Close reply turns a PREVIOUS process left open.
 *
 * A server restart kills the `finally` that would have written the terminal entry, and
 * the detached child keeps running with nobody left to report it. This notices on the
 * next threads-overview request for that vault and says so, once.
 *
 * IDEMPOTENT BY CONSTRUCTION, across processes as well as within one: the entry's id is
 * DERIVED from the orphaned user entry (`<id>~r`), so two servers closing the same orphan
 * write byte-identical ids and `readThread`'s dedupe collapses them to a single entry —
 * no lock, no pre-read, no cross-process coordination.
 *
 * Best-effort: a vault that cannot be reconciled must not take down the feed that asked.
 */
export function reconcileReplyThreads(
  contextRoot: string,
  opts: { processStartedAt?: number; now?: () => Date } = {},
): Promise<void> {
  const existing = reconciling.get(contextRoot);
  if (existing) return existing;
  const started = doReconcileReplyThreads(contextRoot, opts).catch(() => {
    // A rejected reconcile is DELETED from the memo so the next request retries it —
    // caching a failure would mean one bad read silences reconciliation for the life of
    // the process. Swallowed rather than rethrown: the caller is a GET the user is
    // waiting on, and an unreconciled thread is a missing note, not a broken feed.
    reconciling.delete(contextRoot);
  });
  reconciling.set(contextRoot, started);
  return started;
}

async function doReconcileReplyThreads(
  contextRoot: string,
  opts: { processStartedAt?: number; now?: () => Date },
): Promise<void> {
  const cutoff = opts.processStartedAt ?? PROCESS_STARTED_AT;
  for (const manifest of listAutomations(contextRoot)) {
    // A live sidecar means a child is STILL WORKING on this slug — its reply may yet
    // report. Skipped rather than closed; a later process's first request closes it if
    // it never does.
    if (readRunSidecar(contextRoot, manifest.slug)) continue;

    const entries = readThread(contextRoot, manifest.slug);
    const byId = new Set(entries.map((e) => e.id));
    for (const entry of entries) {
      if (entry.kind !== 'user') continue;
      // Only a PREVIOUS process can have orphaned it — see PROCESS_STARTED_AT.
      const at = entryIdMs(entry.id);
      if (!Number.isFinite(at) || at >= cutoff) continue;
      // Already closed by this same derived id, in this process or another.
      if (byId.has(`${entry.id}~r`)) continue;
      // Anything the run said AFTER the reply landed means the turn reported for itself.
      const answered = entries.some(
        (e) => e.runId === entry.runId && e.kind !== 'user' && e.id > entry.id,
      );
      if (answered) continue;
      try {
        appendThreadEntry(contextRoot, manifest.slug, {
          id: `${entry.id}~r`,
          runId: entry.runId,
          kind: 'system',
          event: 'replied',
          via: 'runner',
          text: 'Outcome unknown: the server restarted during this reply.',
        });
      } catch {
        // One slug that refuses the write must not stop the rest of the vault.
      }
    }
  }
}
