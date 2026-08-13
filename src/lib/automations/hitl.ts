/**
 * Questions — the human-in-the-loop store.
 *
 * This is the half of the automations gate the sha256 tripwire does not cover.
 * Approval answers "may this prompt run unattended?" once and holds forever; a
 * question answers "should THIS take effect?" every time and holds nothing.
 *
 * Three properties carry the design, and all three are inherited deliberately
 * from the review-card store this replaces:
 *
 *   1. an answer RESUMES the session that asked, so the reply lands in the
 *      conversation that raised it rather than in a cold re-bootstrap — which is
 *      why a question stores a `sessionId` and nothing resembling an executable
 *      payload. Answering does not run something the record carries; it unblocks
 *      a conversation the approved prompt already bought;
 *   2. free text is a STEER, never the thing that goes out — a question can be
 *      corrected in words without a human hand-editing anything;
 *   3. a slug with an unanswered question does not produce another one, so the
 *      machine runs at the human's speed instead of the clock's.
 *
 * ── THE ONE THING THAT IS NEW: `kind` IS A SECURITY DISCRIMINATOR
 *
 * `flow-hitl` means an already-approved run stopped mid-flight to ask. That is
 * the ONLY kind an answer may resume, because resuming continues a conversation
 * a human already granted `bypassPermissions` to.
 *
 * `approval` means the manifest CHANGED since it was last approved and the run
 * is asking about the diff. At the moment such a question exists the manifest is
 * BY DEFINITION unapproved, so resuming its session would let an unapproved
 * manifest bootstrap its own elevated execution — the exact attack the tripwire
 * exists to prevent, arriving through a door it does not watch.
 *
 * This module enforces the half of that it structurally can: an `approval`
 * question is never given a session id, by construction, on every write path
 * (see {@link createQuestion} and {@link backfillQuestionSession}). The refusal
 * to RESUME one lives inside the verdict engine, where every channel — HTTP,
 * CLI, Telegram — must pass through it. Neither guard is sufficient alone and
 * both are cheap.
 *
 * ── MECHANICS
 *
 * Questions live at `automations/hitl/<slug>/<id>.json`, MACHINE-LOCAL and never
 * brain-synced, the same boundary as the approval registry and for a sharper
 * reason: a question names a resumable session, so a synced question invites
 * another machine to resolve your capability. The gitignore block covering this
 * directory is re-ensured on every run, not just at create time.
 *
 * Reads are LENIENT and never throw — a corrupt question is ignored, exactly
 * like a corrupt run sidecar, because "inert" is the only safe failure mode for
 * a record that gates a spawn. Writes are atomic (tmp + rename), so a crash
 * mid-write can never leave a half-question that reads as pending forever and
 * wedges the automation.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateId } from '../id.js';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { isSafeSessionId } from '../transcript-locate.js';
import { isSafeAutomationSlug } from './store.js';
import {
  HITL_CHANNELS,
  HITL_DIR,
  QUESTION_KINDS,
  QUESTION_STATES,
  REVIEW_BODY_MAX_CHARS,
  REVIEW_CHANNELS,
  REVIEW_STEER_LIMIT,
  type AutomationQuestion,
  type HitlChannel,
  type QuestionKind,
  type QuestionState,
  type QuestionSteer,
  type ReviewChannel,
} from './types.js';

// ─── Paths ───────────────────────────────────────────────────────────────────

export function hitlDir(contextRoot: string): string {
  return join(contextRoot, 'automations', HITL_DIR);
}

/** One automation's questions. The slug is a PATH SEGMENT here, so it is
 *  validated rather than trusted — every caller already validates upstream, and
 *  that is exactly the assumption worth not depending on. */
export function hitlSlugDir(contextRoot: string, slug: string): string {
  if (!isSafeAutomationSlug(slug)) {
    throw new Error(`Refusing to resolve a questions directory for an unsafe slug: "${slug}"`);
  }
  return join(hitlDir(contextRoot), slug);
}

export function questionPath(contextRoot: string, slug: string, id: string): string {
  if (!isSafeQuestionId(id)) {
    throw new Error(`Refusing to resolve a question path for an unsafe id: "${id}"`);
  }
  return join(hitlSlugDir(contextRoot, slug), `${id}.json`);
}

/** Ids are minted by `generateId`, so this only has to reject what a hand-edited
 *  or planted filename could carry into a path. */
function isSafeQuestionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// ─── Read ────────────────────────────────────────────────────────────────────

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asChannel(v: unknown): ReviewChannel | null {
  return (REVIEW_CHANNELS as readonly unknown[]).includes(v) ? (v as ReviewChannel) : null;
}

function parseSteers(v: unknown): QuestionSteer[] {
  if (!Array.isArray(v)) return [];
  const out: QuestionSteer[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const text = asString(r.text);
    if (!text) continue;
    out.push({
      at: asString(r.at),
      via: asChannel(r.via) ?? 'cli',
      text,
      lesson: typeof r.lesson === 'string' ? r.lesson : null,
    });
  }
  return out.slice(-REVIEW_STEER_LIMIT);
}

function parseChoices(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim());
}

/**
 * Read one question. Null for missing, unparseable, or structurally implausible
 * content — never throws.
 *
 * The `sessionId` whitelist is applied HERE, on the way in, not at every use
 * site: a question is a file on disk, and a planted one whose session id is
 * `../../something` must be inert from the moment it is read rather than
 * dangerous at whichever call site forgets to check. Degradation is to `null`
 * for the FIELD, not rejection of the record: a question with an unusable
 * session id can still be closed, which is exactly what you want to be able to
 * do to one you did not expect.
 *
 * An unrecognised `kind` reads as `approval` — the RESTRICTIVE side. `approval`
 * is the kind that may never be resumed, so a corrupt or forged discriminator
 * fails toward "cannot be resumed" rather than toward the elevated path. This is
 * the one place in this file where leniency points at the safe state instead of
 * at the pre-feature behaviour, and it is the opposite of how `state` degrades.
 */
export function readQuestion(path: string): AutomationQuestion | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id);
  const slug = asString(raw.slug);
  if (!id || !slug) return null;

  const state = (QUESTION_STATES as readonly unknown[]).includes(raw.state)
    ? (raw.state as QuestionState)
    : 'pending';
  const kind = (QUESTION_KINDS as readonly unknown[]).includes(raw.kind)
    ? (raw.kind as QuestionKind)
    : 'approval';
  const sessionId = asString(raw.sessionId) || null;
  const refs = raw.channelRefs;

  return {
    id,
    slug,
    runFiredAt: asString(raw.runFiredAt),
    // An `approval` question never has a resumable session, whatever the file
    // says — enforced on the way in so a hand-edited one cannot smuggle a
    // session id into a record the verdict engine would otherwise look at.
    sessionId: kind === 'approval' ? null : isSafeSessionId(sessionId) ? sessionId : null,
    kind,
    channel: (HITL_CHANNELS as readonly unknown[]).includes(raw.channel) ? (raw.channel as HitlChannel) : 'chat',
    question: asString(raw.question),
    choices: parseChoices(raw.choices),
    state,
    answeredAt: asString(raw.answeredAt) || null,
    answeredVia: asChannel(raw.answeredVia),
    answer: asString(raw.answer) || null,
    resolutionNote: asString(raw.resolutionNote) || null,
    resolutionError: asString(raw.resolutionError) || null,
    steers: parseSteers(raw.steers),
    channelRefs:
      refs && typeof refs === 'object' && !Array.isArray(refs)
        ? (Object.fromEntries(
            Object.entries(refs as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
          ) as Record<string, string>)
        : {},
    createdAt: asString(raw.createdAt),
  };
}

/** Every question for one slug, oldest first. Missing directory ⇒ `[]`. */
export function listQuestions(contextRoot: string, slug: string): AutomationQuestion[] {
  if (!isSafeAutomationSlug(slug)) return [];
  let names: string[];
  try {
    names = readdirSync(hitlSlugDir(contextRoot, slug)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: AutomationQuestion[] = [];
  for (const name of names.sort()) {
    const q = readQuestion(join(hitlSlugDir(contextRoot, slug), name));
    if (q) out.push(q);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * THE serial gate's question: does this slug have something nobody has answered?
 *
 * Oldest pending wins when there is somehow more than one — the human should be
 * answering what has been waiting longest, and a newer question from the same
 * automation is by construction less informed than the answer still outstanding
 * on the older one.
 */
export function pendingQuestion(contextRoot: string, slug: string): AutomationQuestion | null {
  return listQuestions(contextRoot, slug).find((q) => q.state === 'pending') ?? null;
}

/** Every slug with something unanswered — what the snapshot, `list` and the tick
 *  report from. Cheap: one shallow readdir plus one per slug that has a
 *  directory at all. */
export function allPendingQuestions(contextRoot: string): AutomationQuestion[] {
  let slugs: string[];
  try {
    slugs = readdirSync(hitlDir(contextRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => isSafeAutomationSlug(name));
  } catch {
    return [];
  }
  return slugs
    .flatMap((slug) => listQuestions(contextRoot, slug))
    .filter((q) => q.state === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Does a question file exist for this id? Used to refuse a duplicate write
 *  rather than silently clobbering one that is still open. */
export function questionExists(contextRoot: string, slug: string, id: string): boolean {
  if (!isSafeAutomationSlug(slug) || !isSafeQuestionId(id)) return false;
  return existsSync(questionPath(contextRoot, slug, id));
}

// ─── Write ───────────────────────────────────────────────────────────────────

/** Atomic: a crash mid-write must never leave a truncated question that reads as
 *  pending forever and wedges the automation. */
export function writeQuestion(contextRoot: string, q: AutomationQuestion): string {
  const dir = hitlSlugDir(contextRoot, q.slug);
  mkdirSync(dir, { recursive: true });
  const path = questionPath(contextRoot, q.slug, q.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(q, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
  return path;
}

/** Answered questions to keep per slug. The trail of what an automation asked
 *  and what you said is worth having; an unbounded pile of it is not. */
export const ANSWERED_QUESTION_KEEP = 20;

/**
 * Drop the oldest ANSWERED questions for a slug.
 *
 * Pending ones are never touched, at any count: a pending question is the only
 * record that an automation is waiting on you, and deleting one would silently
 * unwedge the automation and lose what it asked. Called at creation, so pruning
 * happens exactly when the pile grows and never on a read path.
 */
export function pruneAnsweredQuestions(contextRoot: string, slug: string, keep = ANSWERED_QUESTION_KEEP): number {
  const answered = listQuestions(contextRoot, slug).filter((q) => q.state !== 'pending');
  const excess = answered.slice(0, Math.max(0, answered.length - keep));
  for (const q of excess) {
    try {
      rmSync(questionPath(contextRoot, slug, q.id), { force: true });
    } catch {
      /* a question that will not delete is not worth failing a run over */
    }
  }
  return excess.length;
}

export interface CreateQuestionInput {
  slug: string;
  runFiredAt: string;
  kind: QuestionKind;
  /** Ignored — forced to null — when `kind` is `'approval'`. */
  sessionId: string | null;
  channel: HitlChannel;
  question: string;
  choices?: string[];
  /** Injected for determinism in tests; defaults to now. */
  nowISO?: string;
}

/**
 * Create a pending question.
 *
 * Deliberately does NOT check whether one is already open — that is the runner's
 * gate to enforce before it ever spawns, and duplicating the rule here would put
 * it in two places that can disagree. This function's job is to record the ask
 * correctly.
 */
export function createQuestion(contextRoot: string, input: CreateQuestionInput): AutomationQuestion {
  if (!isSafeAutomationSlug(input.slug)) {
    throw new Error(`Refusing to create a question for an unsafe slug: "${input.slug}"`);
  }
  pruneAnsweredQuestions(contextRoot, input.slug);
  const now = input.nowISO ?? new Date().toISOString();
  const q: AutomationQuestion = {
    id: generateId('q'),
    slug: input.slug,
    runFiredAt: input.runFiredAt,
    // Forced null for `approval`, not merely expected to be null. The caller
    // that has a session id in hand is the runner, and the runner is exactly the
    // component that would otherwise pass it here out of symmetry.
    sessionId: input.kind === 'approval' ? null : isSafeSessionId(input.sessionId) ? input.sessionId : null,
    kind: input.kind,
    channel: input.channel,
    question: truncate(input.question, REVIEW_BODY_MAX_CHARS),
    choices: parseChoices(input.choices),
    state: 'pending',
    answeredAt: null,
    answeredVia: null,
    answer: null,
    resolutionNote: null,
    resolutionError: null,
    steers: [],
    channelRefs: {},
    createdAt: now,
  };
  writeQuestion(contextRoot, q);
  return q;
}

/**
 * Record a human's correction.
 *
 * The question STAYS pending — this is the property that cost an incident to
 * learn: free text re-drafts, it never ships. A steer that also answered would
 * collapse "help me fix this" and "go ahead" into one gesture, which is exactly
 * how an instruction meant for the agent ends up delivered to the world verbatim.
 */
export function recordSteer(
  contextRoot: string,
  q: AutomationQuestion,
  opts: { text: string; via: ReviewChannel; newQuestion?: string; lesson?: string | null; nowISO?: string },
): AutomationQuestion {
  const next: AutomationQuestion = {
    ...q,
    question: opts.newQuestion === undefined ? q.question : truncate(opts.newQuestion, REVIEW_BODY_MAX_CHARS),
    steers: [
      ...q.steers,
      { at: opts.nowISO ?? new Date().toISOString(), via: opts.via, text: opts.text, lesson: opts.lesson ?? null },
    ].slice(-REVIEW_STEER_LIMIT),
  };
  writeQuestion(contextRoot, next);
  return next;
}

/** How long a claim lock may be held before it is considered abandoned. A claim
 *  is a read plus a write — microseconds — so anything past this means the
 *  claiming process died mid-claim. */
const CLAIM_STALE_MS = 30_000;

export type ClaimResult =
  | { claimed: true; question: AutomationQuestion }
  | { claimed: false; reason: string; question: AutomationQuestion | null };

/**
 * Take a question from `pending` to `answered`, exactly once.
 *
 * THE AUTHORITY IS DISK, NEVER THE CALLER'S COPY. A question object can be held
 * by several surfaces at the same time — the chat pane has one rendered, the
 * Telegram poller has one in a message, the CLI has one from a `list` — and
 * every one of them believes it is `pending` until it re-reads. Trusting the
 * in-memory copy means two taps a second apart both resume the session and the
 * approved work happens twice; for an automation that sends, publishes, or
 * spends, that is the worst outcome this whole feature can produce.
 *
 * So: an O_EXCL claim lock, then a fresh read, then the state check, then the
 * write. Losing the race is a REFUSAL with the current record attached, so the
 * caller can tell the human what actually became of it rather than failing
 * blankly.
 */
export function claimQuestion(
  contextRoot: string,
  q: AutomationQuestion,
  answer: string,
  via: ReviewChannel,
  nowISO?: string,
): ClaimResult {
  const dir = hitlSlugDir(contextRoot, q.slug);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, `${q.id}.claim`);
  // `verifyPidLiveness` so a crashed claimer's lock is reclaimed at once while a
  // merely SLOW one keeps it: age alone would hand the question to a second
  // surface the moment a GC pause crossed the window.
  if (!acquireFileLock(lockPath, Date.now(), CLAIM_STALE_MS, { verifyPidLiveness: true })) {
    return { claimed: false, reason: 'another surface is answering this right now', question: null };
  }
  try {
    const fresh = readQuestion(questionPath(contextRoot, q.slug, q.id));
    if (!fresh) return { claimed: false, reason: 'this question no longer exists', question: null };
    if (fresh.state !== 'pending') {
      return { claimed: false, reason: `this question was already ${fresh.state}`, question: fresh };
    }
    return { claimed: true, question: resolveQuestion(contextRoot, fresh, answer, via, nowISO) };
  } finally {
    releaseFileLock(lockPath);
  }
}

/**
 * The freshest copy, or null if it is gone.
 *
 * Same reasoning as {@link claimQuestion}, for the paths that resolve nothing: a
 * steer arriving from one channel must not be applied on top of text another
 * channel already rewrote.
 */
export function refreshQuestion(contextRoot: string, q: AutomationQuestion): AutomationQuestion | null {
  return readQuestion(questionPath(contextRoot, q.slug, q.id));
}

/**
 * Mark a question answered.
 *
 * Called BEFORE the resuming child is spawned, never after. A crash in the
 * window between a human's tap and the agent acting on it must not leave a
 * question that still reads pending — replaying that answer would act twice, and
 * for an approval that is the double-send this ordering exists to make
 * impossible.
 */
export function resolveQuestion(
  contextRoot: string,
  q: AutomationQuestion,
  answer: string,
  via: ReviewChannel,
  nowISO?: string,
): AutomationQuestion {
  const next: AutomationQuestion = {
    ...q,
    state: 'answered',
    answer: truncate(answer, REVIEW_BODY_MAX_CHARS),
    answeredAt: nowISO ?? new Date().toISOString(),
    answeredVia: via,
  };
  writeQuestion(contextRoot, next);
  return next;
}

/** Record what the agent said (or how it failed) once an answer has been acted
 *  on. Separate from {@link resolveQuestion} because the two happen at different
 *  times ON PURPOSE: the answer is written before the resume spawns, the outcome
 *  only exists after it finishes. */
export function noteResolution(
  contextRoot: string,
  q: AutomationQuestion,
  outcome: { note?: string | null; error?: string | null },
): AutomationQuestion {
  const next: AutomationQuestion = {
    ...q,
    resolutionNote: outcome.note !== undefined ? outcome.note : q.resolutionNote,
    resolutionError: outcome.error !== undefined ? outcome.error : q.resolutionError,
  };
  writeQuestion(contextRoot, next);
  return next;
}

/**
 * Put an answered question back to pending.
 *
 * Legitimate on EXACTLY ONE path: the answer's resume never spawned, so provably
 * nothing was carried out and the human's tap is owed a retry. It must NOT be
 * used when a resume started and then failed — an agent that ran for a while
 * with bypassPermissions may have done half the work, and re-answering would act
 * twice. The verdict engine is the only caller.
 */
export function reopenQuestion(contextRoot: string, q: AutomationQuestion, reason: string): AutomationQuestion {
  const next: AutomationQuestion = {
    ...q,
    state: 'pending',
    answer: null,
    answeredAt: null,
    answeredVia: null,
    resolutionError: reason,
  };
  writeQuestion(contextRoot, next);
  return next;
}

/** Attach a channel's handle for an already-rendered question, so a steer edits
 *  it in place rather than posting a second copy of a question that has not
 *  changed identity. */
export function setChannelRef(
  contextRoot: string,
  q: AutomationQuestion,
  channel: ReviewChannel,
  ref: string,
): AutomationQuestion {
  const next: AutomationQuestion = { ...q, channelRefs: { ...q.channelRefs, [channel]: ref } };
  writeQuestion(contextRoot, next);
  return next;
}

/** Is this question actionable beyond closing it? One whose run produced no
 *  usable session has nothing to resume, so surfaces must say so rather than
 *  offering a control that silently fails.
 *
 *  An `approval` question is NEVER resumable — not because it lacks a session,
 *  but because resuming it is the thing that must not happen. */
export function canResume(q: AutomationQuestion): boolean {
  return q.kind === 'flow-hitl' && isSafeSessionId(q.sessionId);
}

/**
 * Fill in the session id of questions a run asked, once the run has finished.
 *
 * A run does not know its own conversation id while running — that value only
 * exists in the `--output-format json` envelope the runner parses after the
 * child exits. So the ask writes `sessionId: null` and the runner backfills here.
 *
 * The alternative was to let the asking verb take a `--session-id` argument,
 * which is worse for a precise reason: the propose guard's whole job is to prove
 * the caller is the run itself, and a question is only as trustworthy as the
 * session id it names. Handing that value back as user input would make the most
 * sensitive field the one nothing verified.
 *
 * Matches on `runFiredAt` and only ever fills a NULL — one that already names a
 * session is never repointed. `approval` questions are SKIPPED entirely: they
 * must never acquire a resumable session, and the backfill is the one path that
 * could otherwise give them one.
 */
export function backfillQuestionSession(
  contextRoot: string,
  slug: string,
  runFiredAt: string,
  sessionId: string | null,
): AutomationQuestion[] {
  if (!isSafeSessionId(sessionId)) return [];
  const updated: AutomationQuestion[] = [];
  for (const q of listQuestions(contextRoot, slug)) {
    if (q.kind === 'approval') continue;
    if (q.sessionId !== null || q.runFiredAt !== runFiredAt) continue;
    const next: AutomationQuestion = { ...q, sessionId };
    writeQuestion(contextRoot, next);
    updated.push(next);
  }
  return updated;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  const t = (s ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
