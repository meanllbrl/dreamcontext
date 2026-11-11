import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runAutomation, type RunOptions, type RunOutcome } from '../lib/automations/runner.js';
import { enqueueFire } from '../lib/automations/queue.js';
import {
  announceTurn, appendThreadEntry, newThreadEntryId, readThread,
} from '../lib/automations/threads.js';
import {
  getAutomation, listAutomations, listRunSlots, lockPathFor, readRunSidecar,
} from '../lib/automations/store.js';
import {
  resumeWithAnswer, resumeWithMessage, type TalkOutcome, type VerdictOptions,
} from '../lib/automations/verdict.js';
import type { BoardTurnInput, RunKind, RunStatus, SpawnModelOverride, ThreadEntry } from '../lib/automations/types.js';
import type { TaskRef } from '../lib/automations/runner.js';
import type { AppRunBrief } from '../lib/apps/brief.js';
import { getAgent } from '../lib/agents/store.js';
import { logAssignmentResult } from '../lib/agents/task-assignment.js';
import { pendingQuestionOfRun } from '../lib/automations/hitl.js';
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
  /** A person's ask: it took its own slot and runs beside this agent's other work. */
  parallel?: boolean;
  /** The ask's own settings, for what arrives while it runs (`runLeavesNoSession`). */
  override?: SpawnModelOverride | null;
}

/** What turns a "run now" into an ASK: the human's words, and the fire time the
 *  caller has already used as a thread root. Both or neither. `board` is the
 *  whiteboard the ask came from (an agent card), when it came from one. */
export interface AutomationAsk extends BoardTurnInput {
  text: string;
  fireAt: Date;
  /** A task assigned to this agent: the run gets the task as data and keeps every
   *  gate, and its result is logged back on the task when the run settles. */
  task?: TaskRef;
  /** `'agent'` runs the agent's call target even when a same-slug automation
   *  exists (a task assignment). Omitted ⇒ what `getAutomation` resolves. */
  target?: RunKind;
  /** The owner's temporary model for this ask (AI Team), already validated. */
  override?: SpawnModelOverride | null;
  /** The app this message came from: the run gets its fenced `'app'` brief. */
  app?: AppRunBrief | null;
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
 * contextRoot → job id → one job.
 *
 * Every ask is its own job in its own session, so one agent has as many running here as it
 * was asked (owner decision 2026-11-01, replacing one slot per agent): each ask holds its own
 * run slot, and its thread run is its own. Only a plain "run now" stays single: it replays the
 * stored job, so a second one adopts the first, and a scheduled fire or a CLI run of the same
 * job is refused by the per-slug lock in the runner.
 */
const jobs = new Map<string, Map<string, AutomationJobState>>();

/** Settled jobs older than this are pruned — the server runs indefinitely. */
const JOB_TTL_MS = 60 * 60 * 1000;

function pruneSettledJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [root, bySlug] of jobs) {
    for (const [id, job] of bySlug) {
      if (job.status !== 'running' && (job.finishedAt ?? 0) < cutoff) bySlug.delete(id);
    }
    if (bySlug.size === 0) jobs.delete(root);
  }
}

/** Each run job's settlement, for a caller that must know when it ended (the Super Agent's team
 *  card). Dropped a minute after it settles. */
const runSettled = new Map<string, Promise<AutomationJobState>>();

/** Resolves with the run job once it settled; null for a job this process does not know. */
export function whenRunSettles(jobId: string): Promise<AutomationJobState> | null {
  return runSettled.get(jobId) ?? null;
}

/**
 * The newest job, a running one before any settled one: of one agent when `slug` is given,
 * else of the project, which is what `GET /runs` and the "run now" poll read.
 */
export function currentAutomationJob(contextRoot: string, slug?: string): AutomationJobState | null {
  pruneSettledJobs();
  const bySlug = jobs.get(contextRoot);
  if (!bySlug) return null;
  let best: AutomationJobState | null = null;
  for (const job of bySlug.values()) {
    if (slug !== undefined && job.slug !== slug) continue;
    if (!best) { best = job; continue; }
    const running = job.status === 'running';
    const bestRunning = best.status === 'running';
    if (running !== bestRunning ? running : job.startedAt > best.startedAt) best = job;
  }
  return best;
}

/** One job by its id, or null once it is pruned: what a caller holding its own job reads. */
export function automationJobById(contextRoot: string, jobId: string): AutomationJobState | null {
  pruneSettledJobs();
  return jobs.get(contextRoot)?.get(jobId) ?? null;
}

/** A fire time no other job of this agent holds: it is the run's thread and its slot, so two asks
 *  in one millisecond must not share them. Call it in the same tick as the job start. */
export function freshFireAt(contextRoot: string, slug: string, now: Date = new Date()): Date {
  const taken = new Set([...(jobs.get(contextRoot)?.values() ?? [])].filter((j) => j.slug === slug).map((j) => j.runId));
  let at = now.getTime();
  while (taken.has(new Date(at).toISOString())) at += 1;
  return new Date(at);
}

/** Turns this server has in flight, every project and member: what the general limit counts. */
export function liveTurnCount(): number {
  pruneSettledJobs();
  let n = 0;
  for (const bySlug of jobs.values()) for (const j of bySlug.values()) if (j.status === 'running') n += 1;
  for (const j of replyJobs.values()) if (j.status === 'running') n += 1;
  return n;
}

/** Every run in flight in this project, oldest first. */
export function runningAutomationJobs(contextRoot: string): AutomationJobState[] {
  pruneSettledJobs();
  return [...(jobs.get(contextRoot)?.values() ?? [])]
    .filter((j) => j.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Start a background job. An ask always starts: it is a new question with its own session. A
 * plain "run now" adopts that agent's "run now" already running.
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
  const parallel = !!ask?.text.trim() && !ask.task;
  const existing = parallel ? undefined : [...(bySlug?.values() ?? [])].find((j) => j.slug === slug && !j.parallel && j.status === 'running');
  if (existing) return { job: existing, started: false };
  const job: AutomationJobState = {
    id: `aj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    slug,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    outcome: null,
    error: null,
    runId: ask ? ask.fireAt.toISOString() : null,
    ...(parallel ? { parallel: true } : {}),
    ...(ask?.override ? { override: ask.override } : {}),
  };
  if (!bySlug) { bySlug = new Map(); jobs.set(contextRoot, bySlug); }
  bySlug.set(job.id, job);
  const settled = runJob(contextRoot, job, ask).then(() => job, () => job);
  runSettled.set(job.id, settled);
  void settled.then(() => { setTimeout(() => runSettled.delete(job.id), 60_000).unref?.(); });
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

/** The one result line on an assigned task. Best-effort: the run happened, and a
 *  task file that cannot be written must not change the job's disposition. */
function logTaskResult(
  contextRoot: string,
  slug: string,
  ask: AutomationAsk,
  status: RunStatus,
  outputPath: string | null,
): void {
  if (!ask.task) return;
  try {
    const title = getAgent(contextRoot, slug)?.title ?? slug;
    logAssignmentResult(contextRoot, ask.task.slug, { slug, title }, { status, outputPath, runId: ask.fireAt.toISOString() });
  } catch (err) {
    console.error(`automation "${slug}": result not logged on task "${ask.task.slug}" — ${(err as Error).message}`);
  }
}

async function runJob(contextRoot: string, job: AutomationJobState, ask?: AutomationAsk): Promise<void> {
  try {
    // A declared variable, not an inline literal, so `board` type-checks against
    // `BoardTurnInput` whether or not `RunOptions` itself carries it yet.
    const runOpts: RunOptions & BoardTurnInput = {
      host: 'server',
      ...(ask ? { ask: ask.text, fireAt: ask.fireAt } : {}),
      ...(job.parallel ? { parallel: true } : {}),
      ...(ask?.board ? { board: ask.board } : {}),
      ...(ask?.target ? { target: ask.target } : {}),
      ...(ask?.task ? { task: ask.task } : {}),
      ...(ask?.override ? { override: ask.override } : {}),
      ...(ask?.app ? { app: ask.app } : {}),
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
    };
    const outcome = await runAutomation(contextRoot, job.slug, runOpts);
    job.outcome = outcome;
    job.status = outcome.status === 'ok' ? 'success' : 'error';
    if (outcome.status !== 'ok') job.error = outcome.error;
    // An ask that produced no run leaves a question in the channel with
    // nothing under it — and, because no `started` entry was ever written
    // either, a message that reads "running" for ever. Answer it.
    if (ask && job.runId && outcome.status !== 'ok') {
      answerIfSilent(contextRoot, job.slug, job.runId, skipText(outcome.status, outcome.error));
    }
    if (ask?.task) logTaskResult(contextRoot, job.slug, ask, outcome.status, outcome.outputPath);
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message ?? String(err);
    if (ask?.task) logTaskResult(contextRoot, job.slug, ask, 'failed', null);
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
    // Never for a run that names its target or carries a task: a replayed bare
    // slug would fire a same-slug pair's job, or the agent without its task.
    if (!ask?.target && !ask?.task && !ask?.override?.light) {
      try {
        enqueueFire(dirname(contextRoot), job.slug, new Date(job.startedAt).toISOString());
      } catch {
        // a queue that cannot be written leaves the fire simply not owed —
        // the same degrade `runAutomation`'s own enqueue failure accepts.
      }
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
  /** While `running`: `waiting` behind the turn of ITS conversation, or `delivering` once it
   *  holds that conversation's slot. Meaningless once settled. */
  phase: 'waiting' | 'delivering';
  /** The server's own sentence on a non-ok settle — never a generic "failed".
   *  On `refused` this is `resumeWithMessage`'s reason, already written for a human. */
  reason: string | null;
  startedAt: string;
  /** When it got the slot and began delivering (ISO). A queued reply's own words in the
   *  thread start here; everything before it is the turn it waited behind. */
  deliveredAt?: string;
  finishedAt: string | null;
}

/**
 * Keyed by JOB ID, not by `contextRoot`.
 *
 * A job is one reply turn and its id is what the client polls. Concurrency is not this map's
 * business at all: it is owned end to end by the conversation's slot inside
 * `resumeWithMessage`, which refuses with its own sentence when a turn holds it.
 */
const replyJobs = new Map<string, ReplyJobState>();
/** Each reply job's settlement, for a caller that records the outcome where it outlives this
 *  process's registry (the Super Agent's team job). Pruned with the job. */
const replySettled = new Map<string, Promise<ReplyJobState>>();

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
    if (Number.isFinite(finished) && finished < cutoff) { replyJobs.delete(id); replySettled.delete(id); }
  }
}

/** The job behind a poll, or null once it has been pruned (which the client reads as
 *  "this server no longer knows" — a terminal state, not a retry). */
export function currentReplyJob(jobId: string): ReplyJobState | null {
  pruneSettledReplyJobs();
  return replyJobs.get(jobId) ?? null;
}

/** Resolves with the job once it settled (its terminal entry is written); null for a job this
 *  process does not know. Never rejects. */
export function whenReplySettles(jobId: string): Promise<ReplyJobState> | null {
  return replySettled.get(jobId) ?? null;
}

/**
 * WHAT ONE AGENT IS DOING RIGHT NOW, for the thread and the channel to draw.
 *
 * Asked of the subject, not of this process's bookkeeping: every turn of an agent holds a lock
 * whatever started it, the per-slug run lock (a scheduled fire, the CLI, "run now") or its own
 * slot (an ask, a reply resume, an answer), so the files are where "is it working, on how
 * many things" has a true answer. Asks of this server still before their slot are read from
 * their jobs, so a job counts from the moment it starts.
 *
 * `runs` is every turn in flight, oldest first; `count` its length, what a row shows. `since`
 * and `runId` are the oldest turn's start and the newest turn's thread, for a reader that draws
 * one line. A run's id is null only in the moment before an exclusive run's child spawns.
 *
 * `queued` is every reply still WAITING behind the turn of its own conversation, oldest first,
 * so the thread can mark the message the reader just sent as queued.
 */
export interface AgentActivity {
  /** When the oldest turn began, epoch ms. */
  since: number;
  runId: string | null;
  queued: { entryId: string; runId: string }[];
  runs: { runId: string | null; since: number }[];
  count: number;
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
  const queued = waiting.map((j) => ({ entryId: j.entryId, runId: j.runId }));
  const running = [...(jobs.get(contextRoot)?.values() ?? [])].filter((j) => j.slug === slug && j.status === 'running');
  const runs: AgentActivity['runs'] = listRunSlots(contextRoot, slug).map((s) => ({ runId: s.run, since: s.at }));
  const exclusive = liveLockSince(contextRoot, slug, staleMs, nowMs);
  if (exclusive !== null) {
    const plain = running.find((j) => !j.parallel);
    runs.push({ runId: delivering?.runId ?? readRunSidecar(contextRoot, slug, '')?.fireAt ?? plain?.runId ?? null, since: exclusive });
  }
  // Started here, its slot not taken yet.
  for (const j of running) {
    if (j.runId && !runs.some((r) => r.runId === j.runId)) runs.push({ runId: j.runId, since: j.startedAt });
  }
  const held = [...new Map(runs.map((r) => [r.runId ?? `?${r.since}`, r])).values()].sort((a, b) => a.since - b.since);
  if (held.length === 0) {
    // Nothing holds a lock, but a reply is about to take it (it polls): the agent is about
    // to work on it, which is what the reader needs to hear.
    if (waiting.length === 0) return null;
    const [next, ...rest] = waiting;
    const since = Date.parse(next.startedAt) || nowMs;
    return {
      since,
      runId: next.runId,
      queued: rest.map((j) => ({ entryId: j.entryId, runId: j.runId })),
      runs: [{ runId: next.runId, since }],
      count: 1,
    };
  }
  const newest = held[held.length - 1].runId;
  return { since: held[0].since, runId: delivering?.runId ?? newest, queued, runs: held, count: held.length };
}

/** Could this thread run be among the agent's turns in flight? A turn that does not yet say which
 *  run it is counts: "lost" and "stale" are never concluded on a guess. */
export function runIsActive(activity: AgentActivity | null, runId: string): boolean {
  return !!activity && (activity.runs?.some((r) => r.runId === runId || r.runId === null) ?? true);
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
 * ALWAYS starts — it never adopts another job. What it does NOT do is take a lock:
 * `resumeWithMessage` owns the conversation's slot. A reply to a run still in flight, or to a
 * session mid-turn, WAITS (bounded by the run's timeout) and is delivered when the turn ahead of
 * it in THAT conversation ends; every other conversation runs beside it, this agent's too. A
 * reply in the thread of a run waiting on a question answers that question.
 */
export function startAutomationReplyJob(
  contextRoot: string,
  slug: string,
  opts: {
    runId: string; text: string; entryId: string; home?: string; lockPollMs?: number;
    /** The owner's temporary model for this reply (AI Team), already validated. */
    override?: SpawnModelOverride | null;
    /** These words are never an ANSWER (plan-r10 1b, security r8-1): the Super Agent's follow-up.
     *  A question of the run, even one that appears while the reply waits, stays the owner's: the
     *  reply goes as a plain message or is refused, never through `resumeWithAnswer`. */
    noAnswer?: boolean;
  } & BoardTurnInput,
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
  replySettled.set(job.id, runReplyJob(contextRoot, job, opts).then(() => job, () => job));
  return job;
}

/**
 * A reply in the thread of a run WAITING ON A QUESTION is the answer to it.
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
  verdictOpts: VerdictOptions & BoardTurnInput,
  noAnswer = false,
): Promise<TalkOutcome> {
  // Synchronous up to the first resume call, on purpose: the job starts its turn in the
  // same tick it was created, exactly as it did before this routing existed.
  // Never a light job: read-only, it would spend the answer on a turn that cannot act on it.
  // It goes to `resumeWithMessage`, whose refusal reaches the Super as this job's failure.
  const openQuestion = () => {
    if (noAnswer) return null;
    const q = pendingQuestionOfRun(contextRoot, slug, verdictOpts.run as string);
    return q && q.kind === 'flow-hitl' && !verdictOpts.override?.light ? q : null;
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
  opts: { text: string; home?: string; lockPollMs?: number; override?: SpawnModelOverride | null; noAnswer?: boolean } & BoardTurnInput,
): Promise<void> {
  let outcome: TalkOutcome | null = null;
  try {
    const manifest = getAutomation(contextRoot, job.slug);
    const verdictOpts: VerdictOptions & BoardTurnInput = {
      surface: 'thread' as const,
      ...(opts.home ? { home: opts.home } : {}),
      // The two run-binding HINTS, so the resumed child's `automations post` lands in
      // THIS run's thread with no ids to pass. `VerdictOptions.env` is typed to exactly
      // these two keys, so nothing else can ride along into a bypassPermissions child.
      env: { DREAMCONTEXT_AUTOMATION_SLUG: job.slug, DREAMCONTEXT_AUTOMATION_RUN: job.runId },
      // Which conversation these words continue.
      run: job.runId,
      // QUEUED, never refused, behind the turn of this conversation: the run itself, or
      // the resume an answer started a moment ago. Bounded by the run's own envelope plus a
      // minute, which is the longest the turn ahead of it can legitimately take.
      lockWaitMs: ((manifest?.timeoutMinutes ?? 30) + 1) * 60_000,
      ...(opts.lockPollMs ? { lockPollMs: opts.lockPollMs } : {}),
      onLockAcquired: () => { job.phase = 'delivering'; job.deliveredAt = new Date().toISOString(); },
      // The board the reply came from, so the resumed turn carries its context.
      ...(opts.board ? { board: opts.board } : {}),
      ...(opts.override ? { override: opts.override } : {}),
    };
    outcome = await replyOrAnswer(contextRoot, job.slug, opts.text, verdictOpts, opts.noAnswer === true);
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

// ─── Who started the turn in flight (app-araclari plan r3 §4.2 (b), security re-review) ──────

/** Only the owner's own page writes these: an app's or the Super Agent's words never count here
 *  (an app's own member is let through for that app only, by `runStartedByApp`). */
const OWNER_VIA: readonly ThreadEntry['via'][] = ['dashboard'];

/**
 * Did the OWNER start the turn of `slug`'s run `runId` that is in flight right now? The one
 * reply job of that run that is `running` AND `delivering` (exactly one; any other count is
 * false), its own entry; with none delivering, the run's own job while it is `running`, its
 * opening user entry. That entry must be `kind: 'user'` and `via` in {@link OWNER_VIA}.
 * A settled job (its phase stays `delivering`), an earlier turn, the run's first entry under a
 * later Super `team ask` turn, and a scheduled fire with no job here: all false.
 */
export function jobStartedByOwner(contextRoot: string, slug: string, runId: string): boolean {
  if (!slug || !runId) return false;
  const delivering = [...replyJobs.values()].filter((j) => j.slug === slug && j.runId === runId && j.status === 'running' && j.phase === 'delivering');
  let entryId: string | null = null;
  if (delivering.length > 1) return false;
  if (delivering.length === 1) entryId = delivering[0].entryId;
  else {
    const live = [...(jobs.get(contextRoot)?.values() ?? [])].filter((j) => j.slug === slug && j.runId === runId && j.status === 'running');
    if (live.length !== 1) return false;
    // A reply waiting behind this turn does not make it its own: the opening entry decides.
    const opening = readThread(contextRoot, slug, { runId }).find((e) => e.runId === runId && e.kind === 'user');
    if (!opening) return false;
    return OWNER_VIA.includes(opening.via) && !opening.app;
  }
  const entry = readThread(contextRoot, slug, { runId }).find((e) => e.id === entryId);
  return !!entry && entry.runId === runId && entry.kind === 'user' && OWNER_VIA.includes(entry.via) && !entry.app;
}

/**
 * Which app started `slug`'s run `runId`, while its own job runs here (app-arac-izin, owner
 * 2026-11-11): the run's opening entry was written by the server's own `/__dc/team/say` path
 * (`via: 'app'`, `app: <slug>`), never by a caller. Null for any other run, for a run with no
 * live job in this process, and while a reply turn of someone else's is being delivered into it.
 */
export function runStartedByApp(contextRoot: string, slug: string, runId: string): string | null {
  if (!slug || !runId) return null;
  if ([...replyJobs.values()].some((j) => j.slug === slug && j.runId === runId && j.status === 'running' && j.phase === 'delivering')) return null;
  const live = [...(jobs.get(contextRoot)?.values() ?? [])].filter((j) => j.slug === slug && j.runId === runId && j.status === 'running');
  if (live.length !== 1) return null;
  const opening = readThread(contextRoot, slug, { runId }).find((e) => e.runId === runId && e.kind === 'user');
  return opening && opening.via === 'app' && typeof opening.app === 'string' && opening.app ? opening.app : null;
}

/** Tests stand in for jobs this process would have started: a reply job, or a run's own job. */
export function __seedJobForTest(contextRoot: string, j: { reply?: ReplyJobState; run?: AutomationJobState }): void {
  if (j.reply) replyJobs.set(j.reply.id, j.reply);
  if (j.run) {
    const bySlug = jobs.get(contextRoot) ?? new Map<string, AutomationJobState>();
    bySlug.set(j.run.id, j.run);
    jobs.set(contextRoot, bySlug);
  }
}

/** Tests: forget every seeded job. */
export function __clearJobsForTest(): void {
  replyJobs.clear();
  jobs.clear();
}
