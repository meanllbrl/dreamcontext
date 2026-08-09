/**
 * The verdict engine — what happens when a human answers a review card.
 *
 * Every path here resumes the claude session that WROTE the proposal. That is
 * the single decision the whole HITL design rests on, ported from Tilki's
 * Concierge (where the drafting session travels with the card and every steer
 * `--resume`s it): because approving means "keep going" rather than "execute
 * what this card is carrying", a card never has to hold an action, and the
 * feature adds no capability on top of the `bypassPermissions` the approved
 * prompt already bought.
 *
 * Two orderings in this file are load-bearing and pull in opposite directions;
 * both are honoured, and the boundary between them is precise:
 *
 *   - The verdict is persisted BEFORE the resume spawns, so a crash in that
 *     window cannot replay the act.
 *   - A resume that never SPAWNED reopens the card, because provably nothing
 *     was carried out and the human's tap is owed a retry.
 *   - A resume that spawned and then failed does NOT reopen it. An agent that
 *     ran for a while may have done half the work; re-approving would act
 *     twice. The failure is recorded ON the card instead, so it can never be
 *     mistaken for a clean success.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { homedir } from 'node:os';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { forgetCardSession, readCardSession } from './card-registry.js';
import {
  clearRunSidecar,
  getAutomation,
  lockPathFor,
  parsePattern,
  readRunSidecar,
  recordLesson,
  writeRunSidecar,
} from './store.js';
import {
  executeClaudeDetached,
  outputPathFor,
  sanitizeAutomationPrompt,
  type ClaudeExecution,
  type SpawnImpl,
} from './runner.js';
import {
  canResume,
  claimReviewCard,
  createReviewCard,
  noteResolution,
  pendingReviewCard,
  recordSteer,
  refreshReviewCard,
  reopenReviewCard,
  resolveReviewCard,
  writeReviewCard,
} from './review.js';
import {
  PATTERN_LESSON_MAX_CHARS,
  REVIEW_BODY_MAX_CHARS,
  type AutomationManifest,
  type ReviewCard,
  type ReviewChannel,
  type ReviewVerdict,
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
  stagedBody?: string;
  kind?: 'output' | 'agent';
}

export type ProposeResult =
  | { ok: true; card: ReviewCard }
  | { ok: false; reason: string };

/**
 * Create a card ON BEHALF OF A RUNNING RUN — the `automations propose` verb.
 *
 * THE GUARD: the caller's process group must equal the one recorded in this
 * automation's run sidecar. A detached run gets its own process group, and
 * every descendant of that run — including the `dreamcontext` process the agent
 * itself invokes — inherits it, so this is precise in both directions: it
 * admits the run's own calls and rejects a human's shell, another project's
 * run, and any other process on the machine.
 *
 * Why it needs to be this strong: a card's approval resumes the session id the
 * card names. A planted card is therefore a request to run an arbitrary
 * conversation with `bypassPermissions` on the operator's tap — the exact thing
 * the approval tripwire exists to prevent, arriving by a different door.
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
  const open = pendingReviewCard(contextRoot, slug);
  if (open) {
    return { ok: false, reason: `"${slug}" already has a card awaiting review (${open.id})` };
  }
  const card = createReviewCard(contextRoot, {
    slug,
    runFiredAt: sidecar.fireAt,
    // The session id is NOT taken from the caller: a run knows its own id, but
    // accepting it here would let the guard's whole point be handed back as an
    // argument. It is resolved from the run's cache record by the caller that
    // has one (the CLI passes it explicitly from the run event).
    sessionId: opts.sessionId ?? null,
    kind: input.kind ?? (input.stagedBody === undefined ? 'agent' : 'output'),
    title: input.title,
    summary: input.summary,
    body: input.body,
    stagedBody: input.stagedBody,
    nowISO: opts.nowISO,
  });
  return { ok: true, card };
}

// ─── The resume preambles ───────────────────────────────────────────────────

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

export function buildApprovePreamble(card: ReviewCard): string {
  return [
    COMMON_FRAME,
    '',
    `VERDICT: APPROVED. A human read your proposal ("${card.title}") and approved it.`,
    'Carry it out now, exactly as proposed. Do not re-propose it, do not ask for confirmation again,',
    'and do not widen it beyond what was approved — the approval covers what you described, nothing more.',
    'Your final message is recorded against the card as what actually happened, so state the RESULT',
    'plainly: what you did, and anything that did not go as proposed.',
  ].join('\n');
}

export function buildDiscardPreamble(card: ReviewCard): string {
  return [
    COMMON_FRAME,
    '',
    `VERDICT: REJECTED. A human read your proposal ("${card.title}") and declined it.`,
    'Do NOT carry it out. Do not act on it, do not do a smaller version of it, and do not propose',
    'a variation of it now. Stop here.',
    'Your final message is recorded against the card: acknowledge briefly, in one or two sentences.',
  ].join('\n');
}

/**
 * The verdict people forget, and the one that makes review compound.
 *
 * `drop` does not judge this proposal — it judges the KIND. Concierge's third
 * button writes the lead to a do-not-contact list that the cold queue, the
 * follow-ups and the day-end planner all filter forever; the equivalent here is
 * a durable lesson, because the pattern is the only thing a future run reads.
 */
export function buildDropPreamble(card: ReviewCard, m: AutomationManifest): string {
  const lines = [
    COMMON_FRAME,
    '',
    `VERDICT: REJECTED, PERMANENTLY. A human read your proposal ("${card.title}"), declined it, and does`,
    'not want this KIND of proposal again. Do NOT carry it out.',
  ];
  if (m.learning) {
    lines.push(
      '',
      'BEFORE YOU FINISH — record ONE durable lesson so no future run proposes this again. State the',
      'CLASS of proposal to avoid, not this one instance, and say it as an instruction to your future self:',
      `  dreamcontext automations learn ${m.slug} --lesson "<never propose ...>"`,
    );
  } else {
    // Honest rather than silent: without learning there is no file a future run
    // reads, so "never again" cannot actually be remembered.
    lines.push(
      '',
      'NOTE: this automation has learning off, so there is no pattern for a future run to read.',
      'The rejection applies to this proposal only — nothing durable can be recorded.',
    );
  }
  lines.push(
    '',
    'Your final message is recorded against the card: acknowledge briefly, and say what you recorded.',
  );
  return lines.join('\n');
}

/**
 * A steer is NOT a verdict — the card stays pending afterwards.
 *
 * This preamble is the load-bearing half of the 2026-07-12 Tilki incident, in
 * which a reply meant as an instruction was delivered verbatim to a teacher.
 * The human's text is framed here as an instruction to REVISE, never as content
 * to emit, and the resumed agent is told in as many words that nothing has been
 * approved yet.
 */
export function buildSteerPreamble(card: ReviewCard, m: AutomationManifest, correction: string): string {
  const lines = [
    COMMON_FRAME,
    '',
    `VERDICT: NOT YET. A human read your proposal ("${card.title}") and wants it CHANGED before deciding.`,
    'Nothing has been approved and nothing has been carried out. Do not act on the proposal now.',
    '',
    fenceCorrection(correction),
    '',
    'That text is an INSTRUCTION TO YOU about how to revise the proposal. It is never content to emit,',
    'to send, or to write into a document as-is.',
    'Revise the proposal accordingly and reply with the REVISED PROPOSAL ITSELF as your final message —',
    'no preamble, no "here is the revision", just the proposal as it should now read. It replaces the',
    'card body and goes back to the human for the same three buttons.',
  ];
  if (m.learning) {
    lines.push(
      '',
      'ALSO — this correction is not a one-off. Distill the GENERAL rule behind it and record it, so your',
      'next run applies it without being told again:',
      `  dreamcontext automations learn ${m.slug} --lesson "<the general rule>"`,
      'One line, imperative, about the class of mistake — not a restatement of this particular fix.',
    );
  }
  return lines.join('\n');
}

// ─── Resuming ───────────────────────────────────────────────────────────────

export interface VerdictOptions {
  now?: () => Date;
  /** Machine-local home holding the card→session bindings. Injectable so no
   *  test reaches the developer's real ~/.dreamcontext. */
  home?: string;
  spawnImpl?: SpawnImpl;
  killImpl?: (pid: number, signal: NodeJS.Signals | 0) => void;
  log?: (line: string) => void;
  /** Overrides the manifest's timeout. Used by nothing in production — a
   *  verdict resume is bounded by the same envelope the run was approved with. */
  timeoutMinutes?: number;
}

export interface VerdictOutcome {
  card: ReviewCard;
  status: 'ok' | 'failed' | 'timeout' | 'not-spawned' | 'refused';
  /** Null on `ok`. On `refused` this is the reason nothing was attempted. */
  error: string | null;
  /** The agent's final message. On a steer this is the revised proposal. */
  result: string | null;
  /** Set on a steer when a durable lesson was recorded. */
  lesson: string | null;
}

// ─── The resume runs under the SAME guards a scheduled run does ─────────────
//
// A verdict resume spawns a detached `claude --resume` child with
// bypassPermissions — the same kind of process `runAutomation` spawns, and
// therefore owed the same two protections. The first version of this file
// inherited the shared spawn core but NOT its guards, which cost two things:
//
//   1. NO SIDECAR ⇒ an untrackable orphan. If the process driving the resume
//      dies, the detached child group survives with no record anywhere, and
//      `automations kill <slug>` — which reads the sidecar — can never find it.
//      This is precisely the failure the sidecar-before-await contract exists
//      to prevent, and it does not stop mattering because the spawn came from a
//      human's tap instead of a timer.
//   2. NO RUN LOCK ⇒ concurrent claude processes on one automation. Answering
//      the card clears the review gate, so the very next tick is free to start
//      a scheduled run while the resume is still going — two agents writing the
//      same output directory, which is exactly the self-overlap the per-slug
//      lock was added to prevent.

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

/** Spawn the resume, recording it in the sidecar synchronously before any await
 *  so the child stays findable if this process dies. */
function spawnResume(
  contextRoot: string,
  m: AutomationManifest,
  card: ReviewCard,
  /** The MACHINE-LOCAL session, resolved by `authoritativeSession` — never
   *  `card.sessionId`, which is an assertion by whoever wrote the card file. */
  sessionId: string,
  prompt: string,
  opts: VerdictOptions,
): Promise<ClaudeExecution> {
  const nowFn = opts.now ?? (() => new Date());
  const timeoutMs = (opts.timeoutMinutes ?? m.timeoutMinutes) * 60_000;
  return executeClaudeDetached(
    buildResumeArgs(m, sessionId, sanitizeAutomationPrompt(prompt)),
    {
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
          // The fire this resume answers for — it belongs to the card's run, not
          // to the moment a human happened to tap.
          fireAt: card.runFiredAt,
          startedAt: startedAt.toISOString(),
          timeoutAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
        });
      },
    },
  );
}

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

/**
 * Move an approved staged document into the automation's real output directory.
 *
 * This move IS the approval, in the literal sense: until it happens the file
 * lives under `automations/review/`, where the notification does not point at
 * it, sleep's `pendingOutputsSince` does not scan for it, and autoSync has no
 * reason to commit it. One rename opens all three gates at once, which is why
 * there is exactly one of them rather than a flag on each.
 *
 * `renameSync` first, copy+unlink as the fallback: the two paths are normally
 * on the same filesystem (both inside the brain), but a brain whose output dir
 * is a symlink to another volume would make rename fail with EXDEV, and losing
 * an approved document to a filesystem detail is not an acceptable outcome.
 */
function publishStagedDocument(
  contextRoot: string,
  manifest: AutomationManifest,
  card: ReviewCard,
  now: Date,
): string {
  // `outputPathFor` suffixes `-2`, `-3` rather than clobbering, so a same-day
  // re-run (or a second approved card) never overwrites an earlier document.
  const destination = outputPathFor(contextRoot, manifest, new Date(Date.parse(card.runFiredAt) || now.getTime()));
  mkdirSync(dirname(destination), { recursive: true });
  const staged = card.stagedPath as string;
  try {
    renameSync(staged, destination);
  } catch {
    copyFileSync(staged, destination);
    rmSync(staged, { force: true });
  }
  return destination;
}

/**
 * The session a verdict may actually resume — read from the MACHINE-LOCAL
 * binding, never from the card.
 *
 * The card is a file in the project directory, so its `sessionId` is an
 * assertion by whoever wrote that file, not a fact. Only the runner records a
 * binding, and only for a card it created itself, so a card that was planted
 * (or hand-edited to name a different conversation) resolves to null here and
 * cannot be approved or steered at all.
 */
function authoritativeSession(card: ReviewCard, home: string): string | null {
  const bound = readCardSession(card.id, card.slug, home);
  if (!bound) return null;
  // A card whose FILE disagrees with the binding has been tampered with since
  // it was written; refuse rather than silently preferring one of them.
  if (card.sessionId && card.sessionId !== bound) return null;
  return bound;
}

/** The newest lesson text, or null. Used to detect whether a resumed agent
 *  actually recorded one, rather than trusting that it did. */
function newestLesson(m: AutomationManifest | null): string | null {
  if (!m) return null;
  const lessons = parsePattern(m.pattern).lessons;
  return lessons.length > 0 ? lessons[0].text : null;
}

/**
 * Answer a card with a verdict: approve, discard, or drop.
 *
 * The card is resolved on disk BEFORE anything spawns. See this file's header
 * for why that ordering wins over "a failed send keeps the card open", and for
 * the one case (`not-spawned`) where the card is put back.
 */
export async function resumeWithVerdict(
  contextRoot: string,
  card: ReviewCard,
  verdict: ReviewVerdict,
  via: ReviewChannel,
  opts: VerdictOptions = {},
): Promise<VerdictOutcome> {
  const nowFn = opts.now ?? (() => new Date());
  const home = opts.home ?? homedir();
  const manifest = getAutomation(contextRoot, card.slug);
  if (!manifest) {
    return { card, status: 'refused', error: `no such automation: ${card.slug}`, result: null, lesson: null };
  }
  // Disk is the authority, not the caller's copy — see `claimReviewCard`. Two
  // surfaces can each be holding a card they believe is pending.
  const current = refreshReviewCard(contextRoot, card);
  if (!current) {
    return { card, status: 'refused', error: 'this card no longer exists', result: null, lesson: null };
  }
  card = current;
  if (card.state !== 'pending') {
    return { card, status: 'refused', error: `this card was already ${card.state}`, result: null, lesson: null };
  }

  // A card with no resumable session can still be REFUSED — that is the whole
  // point of being able to throw away a proposal you did not expect — but it
  // can never be approved, because there is nothing to carry it out.
  //
  // "Resumable" means THIS MACHINE recorded the binding, not that the card
  // claims a session: a planted or hand-edited card resolves to null here and
  // is therefore only ever discardable.
  const sessionId = authoritativeSession(card, home);
  if (!sessionId) {
    if (verdict === 'approve') {
      return {
        card,
        status: 'refused',
        error: canResume(card)
          ? 'this card is not registered on this machine — it can be discarded, but not approved'
          : 'this card has no resumable session — it can be discarded, but not approved',
        result: null,
        lesson: null,
      };
    }
    const resolved = resolveReviewCard(contextRoot, card, verdict, via, nowFn().toISOString());
    return {
      card: noteResolution(contextRoot, resolved, {
        note: 'Closed without resuming — the proposing run left no session to reply to.',
      }),
      status: 'ok',
      error: null,
      result: null,
      lesson: null,
    };
  }

  // APPROVING A DOCUMENT IS A FILE MOVE, NOT A CONVERSATION.
  //
  // A `kind: 'output'` card already holds the finished artifact — the human
  // read the very text that publishes. Resuming the session to "carry it out"
  // would spend tokens re-deriving something that exists on disk, and give the
  // agent a chance to produce something OTHER than what was approved, which is
  // the one thing an approval must rule out. So this path publishes and stops.
  // (Discard and drop still resume, because a rejection is worth telling the
  // agent about — and `drop` has a lesson to record.)
  if (verdict === 'approve' && card.kind === 'output') {
    if (!card.stagedPath || !existsSync(card.stagedPath)) {
      return {
        card,
        status: 'refused',
        error: 'the staged document is missing — nothing to publish',
        result: null,
        lesson: null,
      };
    }
    // The lock, even though nothing spawns here: publishing WRITES into the
    // output directory, which is the one place a still-finishing run of this
    // same automation is also writing. Taken before the claim for the same
    // reason as the resume path — a verdict that cannot act must not be spent.
    const publishLock = acquireRunLock(contextRoot, manifest, nowFn().getTime());
    if (!publishLock) {
      return { card, status: 'refused', error: LOCK_BUSY_REASON, result: null, lesson: null };
    }
    try {
      const claimed = claimReviewCard(contextRoot, card, 'approve', via, nowFn().toISOString());
      if (!claimed.claimed) {
        return { card: claimed.card ?? card, status: 'refused', error: claimed.reason, result: null, lesson: null };
      }
      const destination = publishStagedDocument(contextRoot, manifest, claimed.card, nowFn());
      return {
        card: noteResolution(contextRoot, { ...claimed.card, stagedPath: destination }, {
          note: `Published to ${relative(contextRoot, destination)}.`,
          error: null,
        }),
        status: 'ok',
        error: null,
        result: null,
        lesson: null,
      };
    } catch (err) {
      // The move failed, so nothing published — but the card is already
      // `approved` and must not be reopened blindly, because "approved" is a
      // decision the human made and did not retract. Record the failure; the
      // staged document is still there to retry from. Re-read rather than
      // closing over the claim, which is now scoped inside the try above.
      const detail = `could not publish the approved document: ${(err as Error).message}`;
      const latest = refreshReviewCard(contextRoot, card) ?? card;
      return {
        card: noteResolution(contextRoot, latest, { error: detail }),
        status: 'failed',
        error: detail,
        result: null,
        lesson: null,
      };
    } finally {
      releaseRunLock(contextRoot, manifest.slug, publishLock);
    }
  }

  const prompt =
    verdict === 'approve'
      ? buildApprovePreamble(card)
      : verdict === 'discard'
        ? buildDiscardPreamble(card)
        : buildDropPreamble(card, manifest);

  // THE RUN LOCK COMES BEFORE THE CLAIM. Resolving a card we then cannot act on
  // would burn the human's verdict: the card would read `approved` while
  // nothing ran and nothing could be retried. So the lock is taken first, and
  // failing to get it changes nothing at all.
  const lockPath = acquireRunLock(contextRoot, manifest, nowFn().getTime());
  if (!lockPath) {
    return { card, status: 'refused', error: LOCK_BUSY_REASON, result: null, lesson: null };
  }

  try {
    // THE ORDERING: resolve first, spawn second — and resolve ATOMICALLY, so two
    // surfaces answering the same card cannot both reach the spawn below. Losing
    // that race is a refusal, never a second resume.
    const claim = claimReviewCard(contextRoot, card, verdict, via, nowFn().toISOString());
    if (!claim.claimed) {
      return { card: claim.card ?? card, status: 'refused', error: claim.reason, result: null, lesson: null };
    }
    const resolved = claim.card;

    const execution = await spawnResume(contextRoot, manifest, card, sessionId, prompt, opts);

    if (!execution.spawned) {
      // Provably nothing ran, so the human's tap is owed a retry — the ONE path
      // that may put a resolved card back to pending.
      const reopened = reopenReviewCard(
        contextRoot,
        resolved,
        'the claude binary could not be launched — your verdict was not carried out, try again',
      );
      return {
        card: reopened,
        status: 'not-spawned',
        error: 'spawn failed — the claude binary could not be launched',
        result: null,
        lesson: null,
      };
    }

    if (execution.timedOut) {
      return {
        card: noteResolution(contextRoot, resolved, {
          error: `the resumed session exceeded its ${manifest.timeoutMinutes}-minute timeout — it may have done part of the work`,
        }),
        status: 'timeout',
        error: 'the resumed session timed out',
        result: null,
        lesson: null,
      };
    }

    const parsed = execution.result;
    if (!parsed?.parsed || parsed.isError) {
      const detail = execution.stderrTail || (parsed?.parsed ? 'claude reported is_error: true' : 'unparseable CLI output');
      return {
        card: noteResolution(contextRoot, resolved, { error: detail }),
        status: 'failed',
        error: detail,
        result: null,
        lesson: null,
      };
    }

    const note = (parsed.result ?? '').trim();
    let lesson: string | null = null;
    if (verdict === 'drop' && manifest.learning) {
      // `drop` asks the agent to record the class of proposal to avoid. Verified,
      // not assumed — see `applySteer` for why trusting the ask is not enough.
      const after = newestLesson(getAutomation(contextRoot, card.slug));
      if (after && after !== newestLesson(manifest)) lesson = after;
    }
    return {
      card: noteResolution(contextRoot, resolved, {
        note: note.slice(0, REVIEW_BODY_MAX_CHARS) || null,
        error: null,
      }),
      status: 'ok',
      error: null,
      result: note,
      lesson,
    };
  } finally {
    // The lock and the sidecar are released on EVERY exit from the resume,
    // including the early returns above — same discipline as `runAutomation`'s
    // own finally, and the reason this is a try/finally rather than a cleanup
    // call at the bottom.
    releaseRunLock(contextRoot, manifest.slug, lockPath);
    // Retire the binding once the card is no longer pending: a resolvable
    // session is a capability, and it should not outlive the decision it
    // existed for. Re-read rather than trusting the in-memory copy, because the
    // `not-spawned` path deliberately puts the card BACK to pending.
    if (refreshReviewCard(contextRoot, card)?.state !== 'pending') {
      forgetCardSession(card.id, home);
    }
  }
}

/**
 * Correct a pending card in words.
 *
 * The card STAYS pending — a steer revises, it never ships. Learning fires
 * HERE, at correction time, and not when the card is eventually approved: that
 * is the exact fix Tilki made when its first version learned at send time from
 * raw before/after examples and read, correctly, as "not learning".
 */
export async function applySteer(
  contextRoot: string,
  card: ReviewCard,
  correction: string,
  via: ReviewChannel,
  opts: VerdictOptions = {},
): Promise<VerdictOutcome> {
  const nowFn = opts.now ?? (() => new Date());
  // NULs only — a correction is prose, and its newlines are the human's, not
  // noise to flatten (same reasoning as sanitizeAutomationPrompt).
  const text = correction.replace(/\u0000/g, '').trim();
  if (!text) {
    return { card, status: 'refused', error: 'an empty correction steers nothing', result: null, lesson: null };
  }
  const home = opts.home ?? homedir();
  const manifest = getAutomation(contextRoot, card.slug);
  if (!manifest) {
    return { card, status: 'refused', error: `no such automation: ${card.slug}`, result: null, lesson: null };
  }
  // Disk is the authority here too: a steer must not be applied on top of a
  // body another channel already rewrote, or onto a card someone just answered.
  const current = refreshReviewCard(contextRoot, card);
  if (!current) {
    return { card, status: 'refused', error: 'this card no longer exists', result: null, lesson: null };
  }
  card = current;
  if (card.state !== 'pending') {
    return { card, status: 'refused', error: `this card was already ${card.state}`, result: null, lesson: null };
  }
  const sessionId = authoritativeSession(card, home);
  if (!sessionId) {
    return {
      card,
      status: 'refused',
      error: canResume(card)
        ? 'this card is not registered on this machine — there is nobody to give the correction to'
        : 'this card has no resumable session — there is nobody to give the correction to',
      result: null,
      lesson: null,
    };
  }

  // Same two guards a scheduled run gets: a steer spawns a real detached child,
  // so it must be trackable (sidecar) and must not run alongside another claude
  // on the same automation (run lock). A steer resolves nothing, so failing to
  // take the lock simply leaves the card exactly as it was.
  const lockPath = acquireRunLock(contextRoot, manifest, nowFn().getTime());
  if (!lockPath) {
    return { card, status: 'refused', error: LOCK_BUSY_REASON, result: null, lesson: null };
  }

  const lessonBefore = newestLesson(manifest);
  let execution: ClaudeExecution;
  try {
    execution = await spawnResume(contextRoot, manifest, card, sessionId, buildSteerPreamble(card, manifest, text), opts);
  } finally {
    releaseRunLock(contextRoot, manifest.slug, lockPath);
  }

  // Every failure below leaves the card exactly as it was: still pending, still
  // holding the previous proposal. Nothing was consumed, so there is nothing to
  // reopen and nothing to warn about beyond "that did not work, try again".
  if (!execution.spawned) {
    return {
      card,
      status: 'not-spawned',
      error: 'spawn failed — the claude binary could not be launched; the card is unchanged',
      result: null,
      lesson: null,
    };
  }
  if (execution.timedOut) {
    return {
      card,
      status: 'timeout',
      error: `the rewrite exceeded its ${manifest.timeoutMinutes}-minute timeout; the card is unchanged`,
      result: null,
      lesson: null,
    };
  }
  const parsed = execution.result;
  const revised = (parsed?.result ?? '').trim();
  if (!parsed?.parsed || parsed.isError || !revised) {
    const detail =
      execution.stderrTail ||
      (parsed?.parsed ? 'the rewrite came back empty' : 'unparseable CLI output');
    return { card, status: 'failed', error: `${detail}; the card is unchanged`, result: null, lesson: null };
  }

  const lesson = distillLesson(contextRoot, card.slug, manifest, lessonBefore, text);

  let next = recordSteer(contextRoot, card, { text, via, newBody: revised, lesson, nowISO: nowFn().toISOString() });
  // A resume may hand back a different conversation id; the NEXT steer has to
  // continue from where this one left off, not from the original proposal.
  if (parsed.sessionId && parsed.sessionId !== card.sessionId) {
    next = { ...next, sessionId: parsed.sessionId };
    writeReviewCard(contextRoot, next);
  }
  return { card: next, status: 'ok', error: null, result: revised, lesson };
}

/**
 * What the correction taught, as one durable line — or null.
 *
 * VERIFIED, not assumed. The steer preamble asks the agent to distill and
 * record the general rule, but an ask is not a guarantee, and a correction that
 * silently taught nothing is exactly the failure mode Tilki shipped first and
 * had to fix. So: if the ledger grew, take what the agent wrote (it had the
 * full context and can generalise better than a string copy). If it did not,
 * record the human's own words rather than lose them — a verbatim correction is
 * a weaker lesson than a distilled rule, and infinitely better than none.
 */
function distillLesson(
  contextRoot: string,
  slug: string,
  before: AutomationManifest,
  lessonBefore: string | null,
  correction: string,
): string | null {
  // Nothing reads the pattern when learning is off, so writing to it would be
  // an automation quietly accumulating a file it never opens — the same reason
  // the `learn` CLI verb refuses outright.
  if (!before.learning) return null;
  const after = newestLesson(getAutomation(contextRoot, slug));
  if (after && after !== lessonBefore) return after;
  const fallback = correction.replace(/\s+/g, ' ').trim().slice(0, PATTERN_LESSON_MAX_CHARS);
  if (!fallback) return null;
  try {
    recordLesson(contextRoot, slug, { lesson: fallback });
    return fallback;
  } catch {
    // A pattern write that fails must not fail the steer — the revision is the
    // thing the human asked for; the lesson is the bonus.
    return null;
  }
}
