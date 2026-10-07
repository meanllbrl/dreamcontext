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
import { accountEnvFor } from '../claude-accounts.js';
import { ensureSandbox } from '../claude-account-sandbox.js';
import { automationAccountWithoutProbe, pickAutomationAccount, type AutomationAccount } from './account.js';
import { appendThreadEntry } from './threads.js';
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
  extractNotificationSummary,
  sanitizeAutomationPrompt,
  SKIMMABLE_MARKDOWN,
  THREAD_BLOCKS,
  askClause,
  buildBoardTurn,
  buildPatternBlock,
  buildTurnLearningDirective,
  markerNonce,
  newTurnNonce,
  type ClaudeExecution,
  type SpawnImpl,
  type TurnBoardContext,
} from './runner.js';
import {
  boardScopeArgs,
  prepareScopePaths,
  resolveSpawnScope,
  scopeEnv,
  type BoardScope,
  type ScopePaths,
} from './board-scope.js';
import {
  REVIEW_BODY_MAX_CHARS,
  type AutomationManifest,
  type AutomationQuestion,
  type BoardTurnInput,
  type ReviewChannel,
} from './types.js';

/** The reader's WHY for an `is_error` envelope: the result's own opening line,
 *  never the flag itself — "is_error: true" tells a person nothing. */
function errorReason(result: string | null): string {
  return extractNotificationSummary(result ?? '') || 'The session ended with an error and gave no reason.';
}

// ─── The propose guard ──────────────────────────────────────────────────────

export type AncestryProbe = (pid: number) => number[] | null;

/** Hop cap for {@link defaultAncestryProbe}: a real chain is a handful deep, and a
 *  cycle in a racing `ps` snapshot must not spin. */
const ANCESTRY_MAX_HOPS = 64;

/**
 * The caller's ancestor pids, nearest first (parent, grandparent, …), stopping
 * before pid 1.
 *
 * Needed alongside the pgid because a process group is NOT inherited through
 * Claude Code's Bash tool: it runs every command in a fresh group (measured —
 * the tool's shell leads its own pgid, its parent is the `claude` process), so
 * the `dreamcontext` a run invokes never shares the run's pgid. Parentage does
 * survive that, and it is kernel-maintained: a process cannot make itself a
 * descendant of a run it was not spawned by. One `ps` for the whole table, and
 * null — a refusal, like the pgid probe — when it cannot answer.
 */
export function defaultAncestryProbe(pid: number): number[] | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const parentOf = new Map<number, number>();
  for (const line of out.split('\n')) {
    const [a, b] = line.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isInteger(a) && Number.isInteger(b)) parentOf.set(a, b);
  }
  if (!parentOf.has(pid)) return null;
  const chain: number[] = [];
  let cur = parentOf.get(pid);
  while (cur !== undefined && cur > 1 && chain.length < ANCESTRY_MAX_HOPS && !chain.includes(cur)) {
    chain.push(cur);
    cur = parentOf.get(cur);
  }
  return chain;
}

export interface ProposeInput {
  title: string;
  summary?: string;
  body: string;
  /**
   * The options the human may press, when the run wants a decision rather than prose.
   * Empty or omitted ⇒ a free-text answer, which is what every producer did before
   * this existed. Sanitised and capped by `parseChoices` in `hitl.ts`
   * (`QUESTION_CHOICES_MAX` × `QUESTION_CHOICE_MAX_CHARS`) — the CLI refuses an
   * over-cap list loudly rather than letting the silent truncation stand, because a
   * run that believes it offered five options and got four should be told.
   */
  choices?: string[];
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
 * THE GUARD: the caller must be the run's own descendant — the run's child pid
 * (recorded in this automation's run sidecar) must be among its ancestors.
 * Parentage is kernel-maintained: a process cannot make itself a descendant of
 * a run it was not spawned by. So it admits the run's own calls and rejects a
 * human's shell, another project's run, and any other process on the machine.
 *
 * NOT the process group, in either direction (measured 2026-09-29):
 *  - too strict: Claude Code's Bash tool runs each command in a FRESH group, so
 *    the `dreamcontext` the agent invokes never shares the run's pgid — every
 *    real `propose` from a run was refused that way;
 *  - too loose: a process that double-forks out of the run and is reparented to
 *    launchd KEEPS the run's pgid, so a group check admits a daemon that has
 *    left the run. Ancestry breaks at the reparent and refuses it.
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
  opts: { ancestryProbe?: AncestryProbe; callerPid?: number; nowISO?: string; sessionId?: string | null } = {},
): ProposeResult {
  const sidecar = readRunSidecar(contextRoot, slug);
  if (!sidecar) {
    return { ok: false, reason: `no run of "${slug}" is in flight — \`propose\` is for a run to call about itself` };
  }
  const ancestors = (opts.ancestryProbe ?? defaultAncestryProbe)(opts.callerPid ?? process.pid);
  if (ancestors === null) {
    // Fail CLOSED. An unverifiable caller is exactly the case this guard exists
    // for; treating "could not check" as "must be fine" would make the guard
    // decorative on any machine where the probe happens to break.
    return { ok: false, reason: 'could not verify the calling process — refusing to record a proposal' };
  }
  if (!ancestors.includes(sidecar.childPid)) {
    return {
      ok: false,
      reason: `\`propose\` may only be called from inside "${slug}"'s own run (run pid ${sidecar.childPid})`,
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
    // Passed through, never trusted: `parseChoices` strips control characters,
    // truncates each label and caps the count on the way into the record.
    choices: input.choices ?? [],
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

/** {@link acquireRunLock}, waiting up to `opts.lockWaitMs` for it. Zero (the default)
 *  is a single attempt, exactly the old behaviour. */
async function acquireRunLockWaiting(
  contextRoot: string,
  m: AutomationManifest,
  nowFn: () => Date,
  opts: VerdictOptions,
): Promise<string | null> {
  const waitMs = Math.max(0, opts.lockWaitMs ?? 0);
  const pollMs = Math.max(1, opts.lockPollMs ?? 2_000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  for (;;) {
    const lockPath = acquireRunLock(contextRoot, m, nowFn().getTime());
    if (lockPath) {
      opts.onLockAcquired?.();
      return lockPath;
    }
    if (waited >= waitMs) return null;
    await sleep(pollMs);
    waited += pollMs;
  }
}

const LOCK_BUSY_REASON =
  'a run for this automation is still in progress — nothing was changed, try again in a moment';

/** `scopeArgs` (from `boardScopeArgs`) replace `--permission-mode bypassPermissions` for a
 *  home-board agent; absent, the argv is byte-for-byte what it always was. */
export function buildResumeArgs(
  m: AutomationManifest,
  sessionId: string,
  prompt: string,
  scopeArgs?: readonly string[] | null,
): string[] {
  const permission = scopeArgs ? [...scopeArgs] : ['--permission-mode', 'bypassPermissions'];
  const args = ['--resume', sessionId, '-p', prompt, ...permission, '--output-format', 'json'];
  // Same envelope the run was approved with — a verdict must not quietly grant
  // a bigger model or a higher effort than the hash covers.
  if (m.model) args.push('--model', m.model);
  if (m.effort) args.push('--effort', m.effort);
  return args;
}

/**
 * `board` is the whiteboard the message came from (an agent card), when it came from one: an
 * attached agent's turn then carries that board's index. A home-board agent always gets its
 * own board, whatever this says.
 */
export interface VerdictOptions extends BoardTurnInput {
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
  /**
   * Where this resume's final message is DELIVERED, which is the only thing the
   * preamble has to say differently. Default `'telegram'` so every existing caller
   * is byte-for-byte unchanged.
   */
  surface?: 'telegram' | 'thread';
  /**
   * The two run-binding HINTS, and NOTHING else.
   *
   * Deliberately NOT a `Record<string, string>`: `executeClaudeDetached` merges the
   * caller's env LAST over `process.env` (runner.ts), into a child running under
   * `bypassPermissions`. An open record would therefore let a caller set `PATH`,
   * `CLAUDE_CONFIG_DIR`, `NODE_OPTIONS` or `HOME` on that child. Typing the two keys
   * makes the dangerous call unrepresentable rather than merely unwise — and
   * `spawnSessionResume` filters by name as well, so the type is the documentation
   * and the filter is the guard.
   */
  env?: { DREAMCONTEXT_AUTOMATION_SLUG?: string; DREAMCONTEXT_AUTOMATION_RUN?: string };
  /**
   * How long a message may WAIT for the run lock before it gives up, in ms. Default 0:
   * refuse at once, which is what Telegram wants (it says so and the human re-sends).
   *
   * A thread reply waits instead. The owner answers a question and types a follow-up
   * seconds later; the answer's resume holds the lock, and refusing the follow-up in 0s
   * ("still in progress, try again") put a failure into the channel for a message that
   * only needed to take its turn. Queued behind the lock, it runs the moment the turn
   * ahead of it ends.
   */
  lockWaitMs?: number;
  /** Poll interval while waiting for the lock. Injectable for tests. */
  lockPollMs?: number;
  /** The wait itself. Injectable so a test does not sleep in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once, the moment this message stops WAITING and holds the run lock. A queued
   *  thread reply uses it to tell the reader "queued" from "being read". */
  onLockAcquired?: () => void;
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

/** The board and references of a turn, each preceded by a blank line, for a preamble. */
function boardParts(turn: TurnBoardContext): string[] {
  return [turn.board, turn.refs].filter(Boolean).flatMap((block) => ['', block]);
}

/** A resume's permission envelope: null for an ordinary agent. */
interface ResumeScope {
  scope: BoardScope;
  paths: ScopePaths;
}

/**
 * Re-decide the envelope under the lock, right before the spawn: the manifest re-read from
 * disk (a queued message may have waited minutes), approval re-checked (for every agent: the
 * Telegram and answer paths never checked it), the board resolved and its folders prepared.
 * A refusal means nothing spawns.
 */
function resolveResumeScope(
  contextRoot: string,
  slug: string,
  opts: VerdictOptions,
): { ok: true; manifest: AutomationManifest; resume: ResumeScope | null } | { ok: false; reason: string } {
  const manifest = getAutomation(contextRoot, slug);
  if (!manifest) return { ok: false, reason: `no such automation: ${slug}` };
  const scoped = resolveSpawnScope(contextRoot, manifest, opts.home);
  if (!scoped.ok) return { ok: false, reason: scoped.reason };
  if (!scoped.scope) return { ok: true, manifest, resume: null };
  const prepared = prepareScopePaths(contextRoot, scoped.scope);
  if (!prepared.ok) return { ok: false, reason: `could not limit it to its board: ${prepared.reason}` };
  return { ok: true, manifest, resume: { scope: scoped.scope, paths: prepared.paths } };
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

function buildAnswerPreamble(q: AutomationQuestion, answer: string, turn?: TurnBoardContext | null): string {
  if (turn) {
    // A board turn: the board and its references are DATA, so the human's answer moves to
    // the very end, fenced with this turn's nonce, where nothing on the board can follow it.
    const n = markerNonce(turn.nonce);
    return [
      COMMON_FRAME,
      '',
      `A human answered the question you stopped to ask ("${q.question}"). Their ANSWER is the last block below.`,
      'Continue the job accordingly, and do not ask the same thing again. Your final message is recorded',
      'as what actually happened, so state the RESULT plainly: what you did, and anything that did not go',
      'as expected.',
      ...boardParts(turn),
      '',
      `--- THE HUMAN'S ANSWER (verbatim)${n} ---`,
      answer.trim(),
      `--- END ANSWER${n} ---`,
    ].join('\n');
  }
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
  // (c) NOT the agent's latest session. The thread's reply box and Telegram both talk to
  // `latestBoundSession`, so retiring it leaves the conversation the owner is standing in
  // with nothing to reach ("no session to talk to yet" right after he answered). The
  // auto-opened chat tab used to keep it alive by accident, through (b); with that gone,
  // this is the rule said out loud. Older sessions still retire, so the grant stays one
  // live conversation per agent, not one per run.
  if (latestBoundSession(q.slug, home) === sessionId) return;
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

  const lockPath = await acquireRunLockWaiting(contextRoot, manifest, nowFn, opts);
  if (!lockPath) {
    return { question, status: 'refused', error: LOCK_BUSY_REASON, result: null };
  }

  let resume: ResumeScope | null = null;
  try {
    // BEFORE the claim: a refusal here must leave the question pending, since nothing ran.
    const envelope = resolveResumeScope(contextRoot, question.slug, opts);
    if (!envelope.ok) return { question, status: 'refused', error: envelope.reason, result: null };
    resume = envelope.resume;
    // References expand fresh for the prompt; the ANSWER on record is the display text, so
    // no surface ever shows a raw `dcref:` token.
    const { turn, display } = buildBoardTurn(contextRoot, resume?.scope ?? null, opts.board, text);
    const answerText = display ?? text;

    const claim = claimQuestion(contextRoot, question, answerText, via, nowFn().toISOString());
    if (!claim.claimed) {
      return { question: claim.question ?? question, status: 'refused', error: claim.reason, result: null };
    }
    const claimed = claim.question;

    const execution = await spawnSessionResume(
      contextRoot, envelope.manifest, question.runFiredAt, sessionId,
      buildAnswerPreamble(question, answerText, turn), opts, resume,
    );

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
      const detail = execution.stderrTail || (parsed?.parsed ? errorReason(parsed.result) : 'unparseable CLI output');
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
    resume?.paths.dispose();
    releaseRunLock(contextRoot, manifest.slug, lockPath);
    retireIfDone(contextRoot, question, sessionId, home);
    // The channel's own record that this run's question was closed. BEST-EFFORT, like
    // every other thread write on a run path: a channel that cannot be written must not
    // change what answering reports.
    //
    // `flow-hitl` ONLY. An `approval` question is the manifest-diff ask raised before an
    // unapproved run ever starts — it was never a run of the job, so an entry here would
    // open a thread for a fire that never happened (the same exclusion the runner applies
    // to its own approval question).
    //
    // This sentence is the RECORD, not the receipt: it names the channel, because it is
    // read later by someone who was not there. The UI's momentary confirmation under the
    // button is a different string and deliberately so.
    if (question.kind === 'flow-hitl') {
      try {
        appendThreadEntry(contextRoot, question.slug, {
          runId: question.runFiredAt,
          kind: 'system',
          event: 'replied',
          via: 'runner',
          text: `Question answered via ${via}. Session resumed.`,
        });
      } catch {
        // a thread that cannot be written leaves the answer itself untouched
      }
    }
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
  /** The home-board envelope, already resolved under the lock; null for an ordinary agent. */
  resume: ResumeScope | null = null,
): Promise<ClaudeExecution> {
  const nowFn = opts.now ?? (() => new Date());
  const timeoutMs = (opts.timeoutMinutes ?? m.timeoutMinutes) * 60_000;
  // THE SECOND HALF OF THE ENV GUARD. `VerdictOptions.env` is typed to the two hint
  // keys, but a type is not a runtime boundary — `any` at a call site, a JSON body
  // widened by a future route, or plain JS would walk straight past it into a child
  // running under `bypassPermissions`. Filtering by NAME here is what actually holds:
  // nothing outside `DREAMCONTEXT_AUTOMATION_*` can reach the spawn, so `PATH`,
  // `CLAUDE_CONFIG_DIR`, `NODE_OPTIONS` and `HOME` are unreachable by construction.
  const hints = Object.fromEntries(
    Object.entries(opts.env ?? {}).filter(
      ([k, v]) => /^DREAMCONTEXT_AUTOMATION_[A-Z_]+$/.test(k) && v !== undefined,
    ),
  );
  // The same account decision the RUN makes (`account.ts`): the preferred account unless
  // auto-switch says it cannot serve. Sessions are shared by every account, so the resume
  // does not have to go back to the account the run happened on.
  // Synchronous when no probe is needed, so the spawn stays in the caller's tick.
  // AFTER the hint filter, and built from the scope (manifest + approval entry), never from
  // the caller: nothing in `opts.env` can name a board, a self or a scratch folder.
  const scopeVars = resume ? scopeEnv(resume.scope, resume.paths) : {};
  const scopeArgs = resume ? boardScopeArgs(resume.scope, resume.paths) : null;
  const quick = automationAccountWithoutProbe({ home: opts.home });
  return quick
    ? spawnOn(quick)
    : pickAutomationAccount({ home: opts.home }).then(spawnOn);

  function spawnOn(account: AutomationAccount): Promise<ClaudeExecution> {
    ensureSandbox(account.configDir, opts.home);
    return executeClaudeDetached(buildResumeArgs(m, sessionId, sanitizeAutomationPrompt(prompt), scopeArgs), {
      cwd: dirname(contextRoot),
      timeoutMs,
      // `accountEnvFor` FIRST, so a resume runs on the account picked above.
      // This path previously passed no env at all and silently inherited the server's —
      // meaning a resume could be billed to, and read the usage of, whichever account the
      // dashboard process happened to be started under. The hints spread after it cannot
      // clobber `CLAUDE_CONFIG_DIR`: the filter above admits no such key.
      env: { ...accountEnvFor(account.configDir, opts.home), ...hints, ...scopeVars },
      sharedMcpHome: scopeArgs ? undefined : opts.home ?? homedir(),
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
  /**
   * What this turn cost, from the resume child's own JSON envelope (`total_cost_usd` —
   * the same field `parseClaudeJson` reads for a scheduled run). Null whenever there is
   * no envelope to read it from: nothing spawned, the child was force-killed on the
   * timeout, or the output did not parse.
   *
   * Reported on a FAILED turn too when the envelope itself parsed — `is_error: true`
   * still burned tokens, and a channel that silently drops the cost of the turns that
   * went wrong is the one place under-reporting matters most.
   *
   * OPTIONAL on purpose. This field arrived after `TalkOutcome` had several producers,
   * including doubles in test suites owned by other lanes; making it required would have
   * broken files this change has no business touching. Consumers should read it as
   * `outcome.costUsd ?? null`.
   */
  costUsd?: number | null;
}

function buildMessagePreamble(message: string, turn?: TurnBoardContext | null): string {
  if (turn) {
    // A board turn: the human's message moves last, fenced with this turn's nonce, after
    // the board material it must outrank.
    const n = markerNonce(turn.nonce);
    return [
      'This is a scheduled dreamcontext automation resuming because the HUMAN WHO OPERATES IT sent it a message.',
      'Their MESSAGE is the last block below. It is a message to answer from what this run already knows and',
      'did, not a new job. Do only what it asks: do not re-run the job, and do not widen it. Your final message',
      'is delivered back to the human on their phone, so write it as a direct, plain-text reply with no',
      'meta-commentary and no markdown tables.',
      ...boardParts(turn),
      '',
      `--- THE HUMAN'S MESSAGE (verbatim)${n} ---`,
      message.trim(),
      `--- END MESSAGE${n} ---`,
    ].join('\n');
  }
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
 * The THREAD variant of the message preamble.
 *
 * A separate builder rather than a branch inside {@link buildMessagePreamble}: the
 * Telegram wording promises delivery to a phone, and that promise is load-bearing for
 * every existing caller. Here it is false — nothing publishes a thread reply's final
 * message, so an agent that answers and does not POST has answered into the void. The
 * two differ in exactly that claim, and saying so is the whole reason this exists.
 *
 * Exported so the lockstep test can assert both halves: that it names `automations post`,
 * and that it does NOT promise phone delivery.
 */
export function buildThreadMessagePreamble(
  message: string,
  /** Optional so callers written before the ask clause existed keep working; absent reads
   *  as `review: off`, the answer that never names a verb the CLI would refuse. `pattern`
   *  and `learning` add the agent's notes and the learning directive. */
  m?: Pick<AutomationManifest, 'slug' | 'review'> & Partial<Pick<AutomationManifest, 'pattern' | 'learning'>>,
  /** This turn's nonce and board material. The resume always passes one; a test may not. */
  turn?: TurnBoardContext | null,
): string {
  const n = markerNonce(turn?.nonce);
  // ORDER IS LOAD-BEARING, the same rule as a run's prompt: framing and instructions, then
  // DATA (board, references, the agent's own notes), then the HUMAN'S MESSAGE, last, fenced
  // with this turn's nonce, so nothing a teammate or an earlier run wrote can follow it.
  const pattern = m ? buildPatternBlock({ learning: m.learning ?? false, pattern: m.pattern ?? '' }, turn?.nonce) : '';
  const learning = m ? buildTurnLearningDirective(m) : '';
  return [
    'This is a scheduled dreamcontext automation resuming because the HUMAN WHO OPERATES IT',
    'replied in its thread. Their message is the last block below.',
    '',
    'That text is a MESSAGE to answer from what this run already knows and did — it is not a new',
    'job. Do only what it asks: do not re-run the job, and do not widen it. ANSWER IN THE THREAD:',
    'post your reply with `dreamcontext automations post <slug> "<your answer, in markdown>"`. Your',
    'slug and run are already in your environment. Your final message is NOT published anywhere —',
    'if you do not post, nothing reaches them.',
    SKIMMABLE_MARKDOWN.trim(),
    // A reply is where "go ahead" arrives, so it is where a command the human must run, or a
    // decision to put to them, is most often the answer: brief it the way the run was briefed.
    THREAD_BLOCKS.trim(),
    askClause(m ?? { slug: '<slug>', review: 'off' }).trim(),
    ...(turn ? boardParts(turn) : []),
    ...(pattern ? ['', pattern] : []),
    ...(learning ? ['', learning] : []),
    '',
    `--- THE HUMAN'S MESSAGE (verbatim)${n} ---`,
    message.trim(),
    `--- END MESSAGE${n} ---`,
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
  if (!text) return { status: 'refused', error: 'an empty message asks nothing', result: null, costUsd: null };

  const manifest = getAutomation(contextRoot, slug);
  if (!manifest) return { status: 'refused', error: `no such automation: ${slug}`, result: null, costUsd: null };

  // A pending question outranks a chat: the run stopped and is owed an ANSWER,
  // and a parallel conversation with the same session would race the answer's
  // own resume. The Telegram handler already routes that case to the question;
  // this guard covers every other caller.
  if (pendingQuestion(contextRoot, slug)) {
    return {
      status: 'refused',
      error: 'This agent is waiting for your answer to its own question, so answer that first.',
      result: null,
      costUsd: null,
    };
  }

  // THE MACHINE-LOCAL BINDING IS THE AUTHORITY, same rule as an answer. Null
  // means no run on THIS machine ever produced a session, and a talk must
  // refuse rather than fall back to what the synced cache claims.
  //
  // A message that may WAIT is checked again under the lock instead: the run it queues
  // behind can be this agent's first, and that run binds the session the message resumes.
  const noSession: TalkOutcome = {
    status: 'refused',
    error: 'This agent has no session to talk to yet. It needs one finished run on this machine first.',
    result: null,
    costUsd: null,
  };
  const waits = (opts.lockWaitMs ?? 0) > 0;
  const sessionId = latestBoundSession(slug, home);
  if (!sessionId && !waits) return noSession;

  const lockPath = await acquireRunLockWaiting(contextRoot, manifest, nowFn, opts);
  if (!lockPath) return { status: 'refused', error: LOCK_BUSY_REASON, result: null, costUsd: null };

  let resume: ResumeScope | null = null;
  try {
    // RE-CHECKED UNDER THE LOCK when the message waited for it: the turn it queued
    // behind can have asked a question (the question outranks the chat, as above) or
    // bound a newer session (the conversation moved on to that one, and the reply
    // belongs there).
    if ((opts.lockWaitMs ?? 0) > 0 && pendingQuestion(contextRoot, slug)) {
      return {
        status: 'refused',
        error: 'This agent is waiting for your answer to its own question, so answer that first.',
        result: null,
        costUsd: null,
      };
    }
    const liveSessionId = waits ? latestBoundSession(slug, home) ?? sessionId : sessionId;
    if (!liveSessionId) return noSession;
    const envelope = resolveResumeScope(contextRoot, slug, opts);
    if (!envelope.ok) return { status: 'refused', error: envelope.reason, result: null, costUsd: null };
    resume = envelope.resume;
    const thread = (opts.surface ?? 'telegram') === 'thread';
    // A thread reply always gets a nonce (its fence follows the agent's own notes); a
    // Telegram message only in a board turn, so an ordinary one stays exactly as it was.
    const { turn, display } = buildBoardTurn(contextRoot, resume?.scope ?? null, opts.board, text);
    const messageText = display ?? text;
    const execution = await spawnSessionResume(
      contextRoot,
      envelope.manifest,
      nowFn().toISOString(),
      liveSessionId,
      thread
        ? buildThreadMessagePreamble(messageText, envelope.manifest, turn ?? { nonce: newTurnNonce(), board: '', refs: '' })
        : buildMessagePreamble(messageText, turn),
      opts,
      resume,
    );
    if (!execution.spawned) {
      return { status: 'not-spawned', error: 'spawn failed — the claude binary could not be launched', result: null, costUsd: null };
    }
    if (execution.timedOut) {
      return {
        status: 'timeout',
        error: `the resumed session exceeded its ${manifest.timeoutMinutes}-minute timeout`,
        // Force-killed mid-flight, so there is no coherent envelope to read a cost from —
        // the same reason the runner does not parse a timed-out child.
        result: null,
        costUsd: null,
      };
    }
    const parsed = execution.result;
    if (!parsed?.parsed || parsed.isError) {
      const detail = execution.stderrTail || (parsed?.parsed ? errorReason(parsed.result) : 'unparseable CLI output');
      // A parseable envelope that reported is_error STILL carries its cost; an
      // unparseable one has none to give.
      return { status: 'failed', error: detail, result: null, costUsd: parsed?.costUsd ?? null };
    }
    return { status: 'ok', error: null, result: (parsed.result ?? '').trim() || null, costUsd: parsed.costUsd };
  } finally {
    resume?.paths.dispose();
    releaseRunLock(contextRoot, manifest.slug, lockPath);
  }
}
