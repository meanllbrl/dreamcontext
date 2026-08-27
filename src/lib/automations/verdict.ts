/**
 * The verdict engine — what happens when a human answers a question.
 *
 * `resumeWithAnswer` resumes the claude session that WROTE the proposal. That
 * is the single decision the whole HITL design rests on, ported from a sibling project's
 * Concierge (where the drafting session travels with the card and every steer
 * `--resume`s it): because answering means "keep going" rather than "execute
 * what this card is carrying", a question never has to hold an action, and the
 * feature adds no capability on top of the `bypassPermissions` the approved
 * prompt already bought.
 *
 * Two orderings in this file are load-bearing and pull in opposite directions;
 * both are honoured, and the boundary between them is precise:
 *
 *   - The answer is persisted BEFORE the resume spawns, so a crash in that
 *     window cannot replay the act.
 *   - A resume that never SPAWNED reopens the question, because provably
 *     nothing was carried out and the human's tap is owed a retry.
 *   - A resume that spawned and then failed does NOT reopen it. An agent that
 *     ran for a while may have done half the work; re-answering would act
 *     twice. The failure is recorded ON the question instead, so it can never
 *     be mistaken for a clean success.
 *
 * The review-card half of this file (`resumeWithVerdict`, `applySteer`, and
 * everything they alone depended on) is retired: every surface that could
 * answer a card is gone (the CLI's `review` verb, the dashboard queue, the
 * server routes, Telegram), so `resumeWithAnswer` is now the ONE path an
 * answer takes, whatever channel it arrived through.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { latestBoundSession, readAutomationSession, retireAutomationSession } from './session-registry.js';
import {
  canResume as canResumeQuestion,
  claimQuestion,
  createQuestion,
  noteResolution as noteQuestionResolution,
  pendingQuestion,
  refreshQuestion,
  reopenQuestion,
} from './hitl.js';
import {
  clearRunSidecar,
  getAutomation,
  lockPathFor,
  readRunSidecar,
  writeRunSidecar,
} from './store.js';
import {
  executeClaudeDetached,
  sanitizeAutomationPrompt,
  type ClaudeExecution,
  type SpawnImpl,
} from './runner.js';
import {
  REVIEW_BODY_MAX_CHARS,
  type AutomationManifest,
  type AutomationQuestion,
  type ReviewChannel,
} from './types.js';

// ─── The propose guard ──────────────────────────────────────────────────────

export type PgidProbe = (pid: number) => number | null;

/**
 * The caller's process-group id.
 *
 * Node exposes no `getpgrp`, so this shells out. `ps` is guaranteed present
 * wherever this subsystem runs at all (it already requires POSIX process-group
 * signalling), and a probe that cannot answer returns null — which the guard
 * below treats as a REFUSAL, never as a pass.
 */
export function defaultPgidProbe(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const n = Number.parseInt(out.trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface ProposeInput {
  title: string;
  summary?: string;
  body: string;
}

/**
 * `card` for the CLI's sake, unchanged since before this module retired the
 * review-card store: `src/cli/commands/automations.ts`'s `propose` verb reads
 * `result.card.id` and is not this task's file to touch. What it now holds is
 * an {@link AutomationQuestion}, not a `ReviewCard` — a proposal is a question
 * like any other from here on, just one a RUNNING agent asked on its own
 * behalf instead of the runner asking on the manifest's.
 */
export type ProposeResult =
  | { ok: true; card: AutomationQuestion }
  | { ok: false; reason: string };

/**
 * Create a question ON BEHALF OF A RUNNING RUN — the `automations propose` verb.
 *
 * THE GUARD: the caller's process group must equal the one recorded in this
 * automation's run sidecar. A detached run gets its own process group, and
 * every descendant of that run — including the `dreamcontext` process the agent
 * itself invokes — inherits it, so this is precise in both directions: it
 * admits the run's own calls and rejects a human's shell, another project's
 * run, and any other process on the machine.
 *
 * Why it needs to be this strong: an answer resumes the session id the
 * question names. A planted question is therefore a request to run an arbitrary
 * conversation with `bypassPermissions` on the operator's tap — the exact thing
 * the approval tripwire exists to prevent, arriving by a different door.
 *
 * `kind: 'flow-hitl'`, always — never `'approval'`. The guard above already
 * proves the caller IS this automation's own, already-approved, already-running
 * session, which is exactly the condition {@link QUESTION_KINDS} requires before
 * an answer may resume it. An `'approval'` question is reserved for the
 * manifest-diff ask the runner raises on an UNAPPROVED manifest (step 6.5 of
 * `runAutomation`) — a call this guard can never reach, since it requires a live
 * sidecar for an approved run in the first place.
 */
export function proposeFromRun(
  contextRoot: string,
  slug: string,
  input: ProposeInput,
  opts: { pgidProbe?: PgidProbe; callerPid?: number; nowISO?: string; sessionId?: string | null } = {},
): ProposeResult {
  const sidecar = readRunSidecar(contextRoot, slug);
  if (!sidecar) {
    return { ok: false, reason: `no run of "${slug}" is in flight — \`propose\` is for a run to call about itself` };
  }
  const probe = opts.pgidProbe ?? defaultPgidProbe;
  const callerPgid = probe(opts.callerPid ?? process.pid);
  if (callerPgid === null) {
    // Fail CLOSED. An unverifiable caller is exactly the case this guard exists
    // for; treating "could not check" as "must be fine" would make the guard
    // decorative on any machine where the probe happens to break.
    return { ok: false, reason: 'could not verify the calling process group — refusing to record a proposal' };
  }
  if (callerPgid !== sidecar.childPgid) {
    return {
      ok: false,
      reason: `\`propose\` may only be called from inside "${slug}"'s own run (process group ${sidecar.childPgid})`,
    };
  }
  const open = pendingQuestion(contextRoot, slug);
  if (open) {
    return { ok: false, reason: `"${slug}" already has a question awaiting an answer (${open.id})` };
  }
  const question = createQuestion(contextRoot, {
    slug,
    runFiredAt: sidecar.fireAt,
    kind: 'flow-hitl',
    // Not taken from the caller: a run knows its own id, but accepting it here
    // would hand the guard's whole point back as an argument. Resolved from the
    // run's cache record by the caller that has one (the CLI passes it
    // explicitly from the run event) — see `backfillQuestionSession` for the
    // common case where it is not known yet at propose time.
    sessionId: opts.sessionId ?? null,
    channel: 'chat',
    question: [input.title, input.summary, input.body]
      .map((s) => s?.trim())
      .filter((s): s is string => Boolean(s))
      .join('\n\n'),
    choices: [],
    nowISO: opts.nowISO,
  });
  return { ok: true, card: question };
}

// ─── The resume preamble ────────────────────────────────────────────────────

const COMMON_FRAME = [
  'This is a scheduled dreamcontext automation resuming after a HUMAN REVIEWED the proposal you made.',
  'NO user is available now: do not ask anything, finish autonomously.',
].join(' ');

/** Fence the human's words so they read as a quoted correction rather than as
 *  more of the framing above them. Ordered AFTER the verdict, the same way the
 *  pattern is ordered after the approved prompt. */
function fenceCorrection(text: string): string {
  return ['--- THE HUMAN\'S CORRECTION (verbatim) ---', text.trim(), '--- END CORRECTION ---'].join('\n');
}

// ─── The resume runs under the SAME guards a scheduled run does ─────────────
//
// A verdict resume spawns a detached `claude --resume` child with
// bypassPermissions — the same kind of process `runAutomation` spawns, and
// therefore owed the same two protections:
//
//   1. NO SIDECAR ⇒ an untrackable orphan. If the process driving the resume
//      dies, the detached child group survives with no record anywhere, and
//      `automations kill <slug>` — which reads the sidecar — can never find it.
//      This is precisely the failure the sidecar-before-await contract exists
//      to prevent, and it does not stop mattering because the spawn came from a
//      human's tap instead of a timer.
//   2. NO RUN LOCK ⇒ concurrent claude processes on one automation. Answering
//      the question clears the review gate, so the very next tick is free to
//      start a scheduled run while the resume is still going — two agents
//      writing the same output directory, which is exactly the self-overlap
//      the per-slug lock was added to prevent.

/** Take the automation's run lock, or null if a run (or another resume) holds
 *  it. Same staleness window and liveness probe `runAutomation` uses. */
function acquireRunLock(contextRoot: string, m: AutomationManifest, nowMs: number): string | null {
  const lockPath = lockPathFor(contextRoot, m.slug);
  const staleMs = m.timeoutMinutes * 60_000 + 300_000;
  return acquireFileLock(lockPath, nowMs, staleMs, { verifyPidLiveness: true }) ? lockPath : null;
}

/** Release the lock and clear the sidecar — but ONLY when the sidecar is this
 *  invocation's own, never unconditionally, or a still-live orphan from some
 *  other runner would lose its only record. Mirrors `runAutomation`'s finally. */
function releaseRunLock(contextRoot: string, slug: string, lockPath: string): void {
  releaseFileLock(lockPath);
  const current = readRunSidecar(contextRoot, slug);
  if (current && current.runnerPid === process.pid) clearRunSidecar(contextRoot, slug);
}

const LOCK_BUSY_REASON =
  'a run for this automation is still in progress — nothing was changed, try again in a moment';

function buildResumeArgs(m: AutomationManifest, sessionId: string, prompt: string): string[] {
  const args = [
    '--resume',
    sessionId,
    '-p',
    prompt,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'json',
  ];
  // Same envelope the run was approved with — a verdict must not quietly grant
  // a bigger model or a higher effort than the hash covers.
  if (m.model) args.push('--model', m.model);
  if (m.effort) args.push('--effort', m.effort);
  return args;
}

export interface VerdictOptions {
  now?: () => Date;
  /** Machine-local home holding the automation session bindings. Injectable so
   *  no test reaches the developer's real ~/.dreamcontext. */
  home?: string;
  spawnImpl?: SpawnImpl;
  killImpl?: (pid: number, signal: NodeJS.Signals | 0) => void;
  log?: (line: string) => void;
  /** Overrides the manifest's timeout. Used by nothing in production — a
   *  verdict resume is bounded by the same envelope the run was approved with. */
  timeoutMinutes?: number;
}

/** What answering a question produced. */
export interface QuestionOutcome {
  question: AutomationQuestion;
  status: 'ok' | 'failed' | 'timeout' | 'not-spawned' | 'refused';
  /** Null on `ok`. On `refused` this is the reason nothing was attempted. */
  error: string | null;
  /** The agent's final message after the answer resumed it. */
  result: string | null;
}

// ─── Questions ───────────────────────────────────────────────────────────────
//
// `resumeWithAnswer` is the ONE path an answer takes, whatever channel it
// arrived through — the HTTP route, the CLI verb, and the Telegram handler all
// land here. That placement is the whole point of R1: the CLI does not go
// through the server (`cli/commands/automations.ts` imports this module
// directly) and Telegram reaches it by a third, independent route, so a refusal
// living in the HTTP handler would guard exactly one of three doors.

/**
 * THE KIND GATE. An `approval` question must never be resumed.
 *
 * `buildResumeArgs` hardcodes `--permission-mode bypassPermissions`, and at the
 * moment an `approval` question exists the manifest is BY DEFINITION unapproved
 * — that is what the question is asking about. Resuming it would let an
 * unapproved manifest bootstrap its own elevated execution, which is precisely
 * the attack the sha256 tripwire exists to prevent, arriving through a door the
 * tripwire does not watch.
 *
 * Answering one "yes" calls `approveAutomation` and starts a FRESH run; the
 * question's own session is discarded, never continued. That work belongs to the
 * caller — this function's job is to make the wrong path impossible rather than
 * merely undocumented.
 */
const APPROVAL_QUESTION_REFUSAL =
  'an approval question is answered by approving the manifest, not by resuming its session';

function buildAnswerPreamble(q: AutomationQuestion, answer: string): string {
  return [
    COMMON_FRAME,
    '',
    `A human answered the question you stopped to ask ("${q.question}").`,
    '',
    fenceCorrection(answer),
    '',
    'That text is their ANSWER. Continue the job accordingly, and do not ask the same thing again.',
    'Your final message is recorded as what actually happened, so state the RESULT plainly: what you',
    'did, and anything that did not go as expected.',
  ].join('\n');
}

/**
 * Was this session ever opened as a chat tab on this machine?
 *
 * Condition (b) of the retention rule. The roster is the vault's own
 * `state/.agent-sessions.json`, which this module already has a `contextRoot`
 * for — read directly rather than through the server route that owns it, since
 * `src/lib` must not depend on `src/server`.
 *
 * A MISSING roster means no tab was ever opened, which is the common case on a
 * machine that answers from Telegram or the CLI — so it correctly reports false
 * and the binding retires. A CORRUPT roster reports false too, and that is the
 * deliberate trade: the cost is one session that cannot be reopened as a tab
 * (its output document still exists), against the cost of a standing
 * `bypassPermissions` grant nobody asked for. Never throws.
 */
function sessionIsInTabRoster(contextRoot: string, sessionId: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(contextRoot, 'state', '.agent-sessions.json'), 'utf-8'));
    const entries = Array.isArray(raw) ? raw : Array.isArray((raw as { sessions?: unknown })?.sessions) ? (raw as { sessions: unknown[] }).sessions : [];
    return entries.some((e) => e && typeof e === 'object' && (e as { sessionId?: unknown }).sessionId === sessionId);
  } catch {
    return false;
  }
}

/**
 * Retire a binding once it is provably done with — the capability-lifetime rule.
 *
 * The card store this replaces dropped its binding the instant a card stopped
 * being pending, because "a resolvable session is a capability, and it should
 * not outlive the decision it existed for". This store cannot do that: it is
 * deliberately plural, so Telegram can talk to the latest run and the app can
 * reopen past ones as tabs. But retiring NOTHING would leave an automation that
 * fires daily with ~90 simultaneously resumable sessions — a widening of the old
 * model rather than a port of it.
 *
 * So: retire only when the question is settled AND nobody kept the tab. If they
 * did keep it, the lifetime hands off to the roster, which is machine-local,
 * user-visible, and already what tab restore reads — rather than staying an
 * indefinite grant.
 */
function retireIfDone(contextRoot: string, q: AutomationQuestion, sessionId: string, home: string): void {
  const latest = refreshQuestion(contextRoot, q);
  // (a) settled, with nothing further pending for this automation.
  if (!latest || latest.state === 'pending') return;
  if (pendingQuestion(contextRoot, q.slug)) return;
  // (b) never opened as a chat tab.
  if (sessionIsInTabRoster(contextRoot, sessionId)) return;
  retireAutomationSession(q.slug, sessionId, home);
}

/**
 * Answer a question and resume the session that asked it.
 *
 * The same two orderings this file's header describes: the lock is taken
 * BEFORE the claim (resolving something we then cannot act on would burn the
 * human's answer), and the answer is persisted BEFORE the spawn (a crash in
 * that window must not replay the act). A resume that never SPAWNED reopens
 * the question, because provably nothing happened; one that spawned and then
 * failed does not, because it may have done half the work.
 */
export async function resumeWithAnswer(
  contextRoot: string,
  question: AutomationQuestion,
  answer: string,
  via: ReviewChannel,
  opts: VerdictOptions = {},
): Promise<QuestionOutcome> {
  const nowFn = opts.now ?? (() => new Date());
  const home = opts.home ?? homedir();

  // THE KIND GATE, first and unconditional — before the manifest is read, before
  // disk is touched, before anything can decide otherwise.
  if (question.kind !== 'flow-hitl') {
    return { question, status: 'refused', error: APPROVAL_QUESTION_REFUSAL, result: null };
  }

  // NULs only - an answer is prose, and its spaces and newlines are the
  // human's, not noise to flatten (same reasoning as sanitizeAutomationPrompt).
  const text = answer.replace(/\u0000/g, '').trim();
  if (!text) {
    return { question, status: 'refused', error: 'an empty answer resolves nothing', result: null };
  }

  const manifest = getAutomation(contextRoot, question.slug);
  if (!manifest) {
    return { question, status: 'refused', error: `no such automation: ${question.slug}`, result: null };
  }

  // Disk is the authority, not the caller's copy — several surfaces can each be
  // holding one they believe is pending.
  const current = refreshQuestion(contextRoot, question);
  if (!current) {
    return { question, status: 'refused', error: 'this question no longer exists', result: null };
  }
  question = current;
  // Re-checked after the fresh read: the kind is what the FILE says now, and a
  // stale in-memory copy is exactly what the gate above cannot rely on alone.
  if (question.kind !== 'flow-hitl') {
    return { question, status: 'refused', error: APPROVAL_QUESTION_REFUSAL, result: null };
  }
  if (question.state !== 'pending') {
    return { question, status: 'refused', error: `this question was already ${question.state}`, result: null };
  }

  // THE MACHINE-LOCAL BINDING IS THE AUTHORITY, never `question.sessionId` — a
  // question is a file in the project directory, so what it names is an
  // assertion by whoever wrote it. Only the runner records a binding.
  const sessionId = question.sessionId ? readAutomationSession(question.slug, question.sessionId, home) : null;
  if (!sessionId) {
    return {
      question,
      status: 'refused',
      error: canResumeQuestion(question)
        ? 'this question is not registered on this machine — it cannot be resumed here'
        : 'the run that asked this left no session to reply to',
      result: null,
    };
  }

  const lockPath = acquireRunLock(contextRoot, manifest, nowFn().getTime());
  if (!lockPath) {
    return { question, status: 'refused', error: LOCK_BUSY_REASON, result: null };
  }

  try {
    const claim = claimQuestion(contextRoot, question, text, via, nowFn().toISOString());
    if (!claim.claimed) {
      return { question: claim.question ?? question, status: 'refused', error: claim.reason, result: null };
    }
    const claimed = claim.question;

    const execution = await spawnSessionResume(contextRoot, manifest, question.runFiredAt, sessionId, buildAnswerPreamble(question, text), opts);

    if (!execution.spawned) {
      // Provably nothing ran, so the answer is owed a retry — the ONE path that
      // may put a settled question back to pending.
      return {
        question: reopenQuestion(contextRoot, claimed, 'the claude binary could not be launched — your answer was not carried out, try again'),
        status: 'not-spawned',
        error: 'spawn failed — the claude binary could not be launched',
        result: null,
      };
    }
    if (execution.timedOut) {
      return {
        question: noteQuestionResolution(contextRoot, claimed, {
          error: `the resumed session exceeded its ${manifest.timeoutMinutes}-minute timeout — it may have done part of the work`,
        }),
        status: 'timeout',
        error: 'the resumed session timed out',
        result: null,
      };
    }
    const parsed = execution.result;
    if (!parsed?.parsed || parsed.isError) {
      const detail = execution.stderrTail || (parsed?.parsed ? 'claude reported is_error: true' : 'unparseable CLI output');
      return {
        question: noteQuestionResolution(contextRoot, claimed, { error: detail }),
        status: 'failed',
        error: detail,
        result: null,
      };
    }

    const note = (parsed.result ?? '').trim();
    return {
      question: noteQuestionResolution(contextRoot, claimed, { note: note.slice(0, REVIEW_BODY_MAX_CHARS) || null, error: null }),
      status: 'ok',
      error: null,
      result: note,
    };
  } finally {
    releaseRunLock(contextRoot, manifest.slug, lockPath);
    retireIfDone(contextRoot, question, sessionId, home);
  }
}

/** The resume spawn both an answer and a talk share — sidecar-before-await
 *  contract, the resume envelope, `buildResumeArgs`. `fireAt` is the fire this
 *  resume belongs to: the asking run's for an answer, the moment of the
 *  message for a talk (which belongs to no scheduled fire at all). */
function spawnSessionResume(
  contextRoot: string,
  m: AutomationManifest,
  fireAt: string,
  sessionId: string,
  prompt: string,
  opts: VerdictOptions,
): Promise<ClaudeExecution> {
  const nowFn = opts.now ?? (() => new Date());
  const timeoutMs = (opts.timeoutMinutes ?? m.timeoutMinutes) * 60_000;
  return executeClaudeDetached(buildResumeArgs(m, sessionId, sanitizeAutomationPrompt(prompt)), {
    cwd: dirname(contextRoot),
    timeoutMs,
    spawnImpl: opts.spawnImpl,
    killImpl: opts.killImpl,
    log: opts.log,
    now: nowFn,
    onSpawned: (child, startedAt) => {
      writeRunSidecar(contextRoot, m.slug, {
        slug: m.slug,
        runnerPid: process.pid,
        childPid: child.pid as number,
        childPgid: child.pid as number, // detached ⇒ setsid() ⇒ pgid === pid
        fireAt,
        startedAt: startedAt.toISOString(),
        timeoutAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
      });
    },
  });
}

// ─── Talking to the latest run ──────────────────────────────────────────────

/** What talking to the latest run produced. Deliberately question-free: a talk
 *  answers nothing and settles nothing, so there is no question to thread. */
export interface TalkOutcome {
  status: 'ok' | 'failed' | 'timeout' | 'not-spawned' | 'refused';
  /** Null on `ok`. On `refused` this is the reason nothing was attempted. */
  error: string | null;
  /** The session's reply to the human. */
  result: string | null;
}

function buildMessagePreamble(message: string): string {
  return [
    'This is a scheduled dreamcontext automation resuming because the HUMAN WHO OPERATES IT sent it a message.',
    '',
    "--- THE HUMAN'S MESSAGE (verbatim) ---",
    message.trim(),
    '--- END MESSAGE ---',
    '',
    'That text is a MESSAGE to answer from what this run already knows and did — it is not a new job.',
    'Do only what it asks: do not re-run the job, and do not widen it. Your final message is delivered',
    'back to the human on their phone, so write it as a direct, plain-text reply with no meta-commentary',
    'and no markdown tables.',
  ].join('\n');
}

/**
 * Send a human's free-form message into the automation's LATEST session and
 * return its reply — the "talk to the run" path behind a bare Telegram message.
 *
 * The same trust chain as `resumeWithAnswer`, minus the question: the session
 * id comes from `latestBoundSession` (the machine-local store only the runner
 * writes), never from the caller and never from the brain-synced cache — so an
 * inbound message can only ever CONTINUE a conversation this machine itself
 * produced, and can never become a run trigger. It spawns the same detached
 * bypassPermissions child a scheduled run does, so it runs under the same two
 * guards: the per-slug run lock and the sidecar.
 */
export async function resumeWithMessage(
  contextRoot: string,
  slug: string,
  message: string,
  opts: VerdictOptions = {},
): Promise<TalkOutcome> {
  const nowFn = opts.now ?? (() => new Date());
  const home = opts.home ?? homedir();

  // NULs only — a message is prose, same reasoning as an answer's text.
  const text = message.replace(/\u0000/g, '').trim();
  if (!text) return { status: 'refused', error: 'an empty message asks nothing', result: null };

  const manifest = getAutomation(contextRoot, slug);
  if (!manifest) return { status: 'refused', error: `no such automation: ${slug}`, result: null };

  // A pending question outranks a chat: the run stopped and is owed an ANSWER,
  // and a parallel conversation with the same session would race the answer's
  // own resume. The Telegram handler already routes that case to the question;
  // this guard covers every other caller.
  if (pendingQuestion(contextRoot, slug)) {
    return {
      status: 'refused',
      error: 'this automation is waiting for your answer to its own question — answer that first',
      result: null,
    };
  }

  // THE MACHINE-LOCAL BINDING IS THE AUTHORITY, same rule as an answer. Null
  // means no run on THIS machine ever produced a session, and a talk must
  // refuse rather than fall back to what the synced cache claims.
  const sessionId = latestBoundSession(slug, home);
  if (!sessionId) {
    return {
      status: 'refused',
      error: 'this automation has no session to talk to yet — it has not completed a run on this machine',
      result: null,
    };
  }

  const lockPath = acquireRunLock(contextRoot, manifest, nowFn().getTime());
  if (!lockPath) return { status: 'refused', error: LOCK_BUSY_REASON, result: null };

  try {
    const execution = await spawnSessionResume(
      contextRoot,
      manifest,
      nowFn().toISOString(),
      sessionId,
      buildMessagePreamble(text),
      opts,
    );
    if (!execution.spawned) {
      return { status: 'not-spawned', error: 'spawn failed — the claude binary could not be launched', result: null };
    }
    if (execution.timedOut) {
      return {
        status: 'timeout',
        error: `the resumed session exceeded its ${manifest.timeoutMinutes}-minute timeout`,
        result: null,
      };
    }
    const parsed = execution.result;
    if (!parsed?.parsed || parsed.isError) {
      const detail = execution.stderrTail || (parsed?.parsed ? 'claude reported is_error: true' : 'unparseable CLI output');
      return { status: 'failed', error: detail, result: null };
    }
    return { status: 'ok', error: null, result: (parsed.result ?? '').trim() || null };
  } finally {
    releaseRunLock(contextRoot, manifest.slug, lockPath);
  }
}
