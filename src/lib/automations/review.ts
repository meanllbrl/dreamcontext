/**
 * Review cards — the human-in-the-loop store.
 *
 * This is the half of the automations gate that the sha256 tripwire does not
 * cover. Approval answers "may this prompt run unattended?" once and holds
 * forever; a card answers "should THIS thing take effect?" every time and holds
 * nothing. Ported from Tilki's WhatsApp Concierge, whose actual lesson is not
 * the approve button but three properties underneath it:
 *
 *   1. the verdict RESUMES the session that produced the proposal, so a
 *      correction lands in the conversation that wrote the text rather than in
 *      a cold re-bootstrap — which is why a card stores a `sessionId` and
 *      nothing resembling an executable payload;
 *   2. free text is a STEER, never the thing that goes out (a card can be
 *      corrected in words without a human ever hand-editing the artifact);
 *   3. a slug with an unanswered card does not produce another one, so the
 *      machine runs at the human's speed instead of the clock's.
 *
 * Cards are MACHINE-LOCAL and never brain-synced, the same boundary as the
 * approval registry and for a sharper reason: a card holds a resumable session
 * id, so a synced card invites another machine to resolve your capability.
 *
 * Reads are LENIENT and never throw — a corrupt card is ignored, exactly like a
 * corrupt run sidecar, because "inert" is the only safe failure mode for a
 * record that gates a spawn. Writes are atomic (tmp + rename), so a crash
 * mid-write can never leave a half-card that reads as pending forever.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateId } from '../id.js';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { isSafeSessionId } from '../transcript-locate.js';
import {
  REVIEW_BODY_MAX_CHARS,
  REVIEW_CARD_STATES,
  REVIEW_CHANNELS,
  REVIEW_DIR,
  REVIEW_STEER_LIMIT,
  type ReviewCard,
  type ReviewCardState,
  type ReviewChannel,
  type ReviewSteer,
  type ReviewVerdict,
} from './types.js';

// ─── Paths ───────────────────────────────────────────────────────────────────

export function reviewDir(contextRoot: string): string {
  return join(contextRoot, 'automations', REVIEW_DIR);
}

export function reviewSlugDir(contextRoot: string, slug: string): string {
  return join(reviewDir(contextRoot), slug);
}

export function reviewCardPath(contextRoot: string, slug: string, id: string): string {
  return join(reviewSlugDir(contextRoot, slug), `${id}.json`);
}

/** The staged document a `kind: 'output'` card is judging — it reaches the real
 *  output directory only on approve. Kept beside its card so discarding a card
 *  disposes of the artifact it was about, with no second cleanup path. */
export function reviewStagedPath(contextRoot: string, slug: string, id: string): string {
  return join(reviewSlugDir(contextRoot, slug), `${id}.md`);
}

// ─── Read ────────────────────────────────────────────────────────────────────

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asChannel(v: unknown): ReviewChannel | null {
  return (REVIEW_CHANNELS as readonly unknown[]).includes(v) ? (v as ReviewChannel) : null;
}

function parseSteers(v: unknown): ReviewSteer[] {
  if (!Array.isArray(v)) return [];
  const out: ReviewSteer[] = [];
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

/**
 * Read one card. Returns null for missing, unparseable, or structurally
 * implausible content — never throws.
 *
 * The `sessionId` whitelist is applied HERE, on the way in, not at every use
 * site: a card is a file on disk, and a planted one whose session id is
 * `../../something` must be inert from the moment it is read rather than
 * dangerous at whichever call site forgets to check. Note the degradation is to
 * `null`, not to rejecting the card: a card with an unusable session id can
 * still be discarded by a human, which is exactly what you want to be able to
 * do to a card you did not expect.
 */
export function readReviewCard(path: string): ReviewCard | null {
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
  const state = (REVIEW_CARD_STATES as readonly unknown[]).includes(raw.state)
    ? (raw.state as ReviewCardState)
    : 'pending';
  const sessionId = asString(raw.sessionId) || null;
  const refs = raw.channelRefs;
  return {
    id,
    slug,
    runFiredAt: asString(raw.runFiredAt),
    sessionId: isSafeSessionId(sessionId) ? sessionId : null,
    kind: raw.kind === 'output' ? 'output' : 'agent',
    title: asString(raw.title, id),
    summary: asString(raw.summary),
    body: asString(raw.body),
    stagedPath: asString(raw.stagedPath) || null,
    state,
    steers: parseSteers(raw.steers),
    createdAt: asString(raw.createdAt),
    resolvedAt: asString(raw.resolvedAt) || null,
    resolvedVia: asChannel(raw.resolvedVia),
    resolutionNote: asString(raw.resolutionNote) || null,
    resolutionError: asString(raw.resolutionError) || null,
    channelRefs:
      refs && typeof refs === 'object' && !Array.isArray(refs)
        ? Object.fromEntries(
            Object.entries(refs as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
          ) as Record<string, string>
        : {},
  };
}

/** Every card for one slug, oldest first. Missing directory ⇒ `[]`. */
export function listReviewCards(contextRoot: string, slug: string): ReviewCard[] {
  const dir = reviewSlugDir(contextRoot, slug);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const cards: ReviewCard[] = [];
  for (const name of names.sort()) {
    const card = readReviewCard(join(dir, name));
    if (card) cards.push(card);
  }
  return cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * THE serial gate's question: does this slug have a card nobody has answered?
 *
 * Oldest pending card wins when there is somehow more than one — the human
 * should be answering the thing that has been waiting longest, and a newer
 * proposal from the same automation is by construction less informed than the
 * verdict still outstanding on the older one.
 */
export function pendingReviewCard(contextRoot: string, slug: string): ReviewCard | null {
  return listReviewCards(contextRoot, slug).find((c) => c.state === 'pending') ?? null;
}

/** Every slug with an unanswered card — what the snapshot, `list` and the tick
 *  report from. Cheap: one shallow readdir plus one per slug that has a
 *  directory at all. */
export function allPendingReviewCards(contextRoot: string): ReviewCard[] {
  let slugs: string[];
  try {
    slugs = readdirSync(reviewDir(contextRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return slugs
    .flatMap((slug) => listReviewCards(contextRoot, slug))
    .filter((c) => c.state === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ─── Write ───────────────────────────────────────────────────────────────────

/** Atomic: a crash mid-write must never leave a truncated card that reads as
 *  pending forever and wedges the automation. */
export function writeReviewCard(contextRoot: string, card: ReviewCard): string {
  const dir = reviewSlugDir(contextRoot, card.slug);
  mkdirSync(dir, { recursive: true });
  const path = reviewCardPath(contextRoot, card.slug, card.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
  return path;
}

/** Resolved cards to keep per slug. The trail of what an automation proposed
 *  and what you decided is worth having; an unbounded pile of it is not. */
export const RESOLVED_CARD_KEEP = 20;

/**
 * Drop the oldest ANSWERED cards for a slug, and the staged documents they
 * refer to.
 *
 * Pending cards are never touched, at any count: a card is the only record that
 * an automation is waiting on you, and deleting one would silently unwedge the
 * automation and lose the proposal. Called at card creation, so pruning happens
 * exactly when the pile grows and never on a read path.
 */
export function pruneResolvedCards(contextRoot: string, slug: string, keep = RESOLVED_CARD_KEEP): number {
  const resolved = listReviewCards(contextRoot, slug).filter((c) => c.state !== 'pending');
  const excess = resolved.slice(0, Math.max(0, resolved.length - keep));
  for (const card of excess) {
    try {
      if (card.stagedPath) rmSync(card.stagedPath, { force: true });
      rmSync(reviewCardPath(contextRoot, slug, card.id), { force: true });
    } catch {
      /* a card that will not delete is not worth failing a run over */
    }
  }
  return excess.length;
}

export interface CreateReviewCardInput {
  slug: string;
  runFiredAt: string;
  sessionId: string | null;
  kind: 'output' | 'agent';
  title: string;
  summary?: string;
  body: string;
  /** Content of the staged document for a `kind: 'output'` card. Written beside
   *  the card, never into the output directory — that move IS the approval. */
  stagedBody?: string;
  /** Injected for determinism in tests; defaults to now. */
  nowISO?: string;
}

/**
 * Create a pending card (and stage its document, when it has one).
 *
 * Deliberately does NOT check whether a pending card already exists — that is
 * the runner's gate to enforce before it ever spawns, and duplicating the check
 * here would put the same rule in two places that can disagree. This function's
 * job is to record a proposal correctly.
 */
export function createReviewCard(contextRoot: string, input: CreateReviewCardInput): ReviewCard {
  pruneResolvedCards(contextRoot, input.slug);
  const id = generateId('rev');
  const now = input.nowISO ?? new Date().toISOString();
  const body = truncate(input.body, REVIEW_BODY_MAX_CHARS);
  let stagedPath: string | null = null;
  if (input.stagedBody !== undefined) {
    mkdirSync(reviewSlugDir(contextRoot, input.slug), { recursive: true });
    const p = reviewStagedPath(contextRoot, input.slug, id);
    writeFileSync(p, input.stagedBody, 'utf-8');
    stagedPath = p;
  }
  const card: ReviewCard = {
    id,
    slug: input.slug,
    runFiredAt: input.runFiredAt,
    sessionId: isSafeSessionId(input.sessionId) ? input.sessionId : null,
    kind: input.kind,
    title: input.title.trim() || id,
    summary: truncate(input.summary ?? firstLine(body), 200),
    body,
    stagedPath,
    state: 'pending',
    steers: [],
    createdAt: now,
    resolvedAt: null,
    resolvedVia: null,
    resolutionNote: null,
    resolutionError: null,
    channelRefs: {},
  };
  writeReviewCard(contextRoot, card);
  return card;
}

/**
 * Record a human's correction and the redrafted proposal it produced.
 *
 * The card STAYS pending — this is the property the Tilki incident bought at
 * cost: free text re-drafts, it never sends. A steer that also resolved the
 * card would collapse "help me fix this" and "ship it" into one gesture, which
 * is precisely how an instruction meant for the agent ends up delivered to the
 * world verbatim.
 */
export function recordSteer(
  contextRoot: string,
  card: ReviewCard,
  opts: { text: string; via: ReviewChannel; newBody: string; lesson?: string | null; nowISO?: string },
): ReviewCard {
  const next: ReviewCard = {
    ...card,
    body: truncate(opts.newBody, REVIEW_BODY_MAX_CHARS),
    steers: [
      ...card.steers,
      {
        at: opts.nowISO ?? new Date().toISOString(),
        via: opts.via,
        text: opts.text,
        lesson: opts.lesson ?? null,
      },
    ].slice(-REVIEW_STEER_LIMIT),
  };
  writeReviewCard(contextRoot, next);
  return next;
}

const VERDICT_STATE: Record<ReviewVerdict, ReviewCardState> = {
  approve: 'approved',
  discard: 'discarded',
  drop: 'dropped',
};

/** How long a claim lock may be held before it is considered abandoned. A claim
 *  is a read plus a write — microseconds — so anything past this means the
 *  claiming process died mid-claim. */
const CLAIM_STALE_MS = 30_000;

export type ClaimResult =
  | { claimed: true; card: ReviewCard }
  | { claimed: false; reason: string; card: ReviewCard | null };

/**
 * Take a card from `pending` to a verdict, exactly once.
 *
 * THE AUTHORITY IS DISK, NEVER THE CALLER'S COPY. A card object can be held by
 * several surfaces at the same time — the dashboard has one rendered, the
 * Telegram poller has one in a message, the CLI has one from a `list` — and
 * every one of them believes it is `pending` until it re-reads. Trusting the
 * in-memory copy means two taps a second apart both resume the session and the
 * approved work happens twice; for an automation that sends, publishes, or
 * spends, that is the worst outcome this whole feature can produce.
 *
 * So: an O_EXCL claim lock, then a fresh read, then the state check, then the
 * write. Losing the race is a REFUSAL with the current card attached, so the
 * caller can tell the human what actually became of it rather than failing
 * blankly.
 */
export function claimReviewCard(
  contextRoot: string,
  card: ReviewCard,
  verdict: ReviewVerdict,
  via: ReviewChannel,
  nowISO?: string,
): ClaimResult {
  const lockPath = join(reviewSlugDir(contextRoot, card.slug), `${card.id}.claim`);
  mkdirSync(reviewSlugDir(contextRoot, card.slug), { recursive: true });
  // `verifyPidLiveness` so a crashed claimer's lock is reclaimed at once while a
  // merely SLOW one keeps it: age alone would hand the card to a second surface
  // the moment a GC pause crossed the window.
  if (!acquireFileLock(lockPath, Date.now(), CLAIM_STALE_MS, { verifyPidLiveness: true })) {
    return { claimed: false, reason: 'another surface is answering this card right now', card: null };
  }
  try {
    const fresh = readReviewCard(reviewCardPath(contextRoot, card.slug, card.id));
    if (!fresh) return { claimed: false, reason: 'this card no longer exists', card: null };
    if (fresh.state !== 'pending') {
      return { claimed: false, reason: `this card was already ${fresh.state}`, card: fresh };
    }
    return { claimed: true, card: resolveReviewCard(contextRoot, fresh, verdict, via, nowISO) };
  } finally {
    releaseFileLock(lockPath);
  }
}

/**
 * The freshest copy of a card, or null if it is gone.
 *
 * Same reasoning as `claimReviewCard`, for the paths that do not resolve
 * anything: a steer arriving from one channel must not be applied on top of a
 * body another channel already rewrote.
 */
export function refreshReviewCard(contextRoot: string, card: ReviewCard): ReviewCard | null {
  return readReviewCard(reviewCardPath(contextRoot, card.slug, card.id));
}

/**
 * Resolve a card.
 *
 * Called BEFORE the resuming child is spawned, never after. A crash in the
 * window between a human's tap and the agent acting on it must not leave a card
 * that still reads pending — replaying that verdict would act twice, and for an
 * approve that is the double-send this ordering exists to make impossible.
 * Concierge writes its state the instant a button resolves for exactly this
 * reason.
 */
export function resolveReviewCard(
  contextRoot: string,
  card: ReviewCard,
  verdict: ReviewVerdict,
  via: ReviewChannel,
  nowISO?: string,
): ReviewCard {
  const next: ReviewCard = {
    ...card,
    state: VERDICT_STATE[verdict],
    resolvedAt: nowISO ?? new Date().toISOString(),
    resolvedVia: via,
  };
  writeReviewCard(contextRoot, next);
  return next;
}

/**
 * Fill in the session id of cards a run proposed, once the run has finished.
 *
 * A run does not know its own conversation id while it is running — that value
 * only exists in the `--output-format json` envelope the runner parses after
 * the child exits. So `propose` writes a card with `sessionId: null` and the
 * runner backfills it here.
 *
 * The alternative was to let `propose` take a `--session-id` argument, which is
 * worse for a precise reason: the propose guard's whole job is to prove the
 * caller is the run itself, and a card is only as trustworthy as the session id
 * it names. Handing that value back as user input would make the most sensitive
 * field on the card the one field nothing verified.
 *
 * Matches on `runFiredAt` (which the sidecar supplied at propose time) and only
 * ever fills a NULL — a card that already names a session is never repointed.
 */
export function backfillCardSession(
  contextRoot: string,
  slug: string,
  runFiredAt: string,
  sessionId: string | null,
): ReviewCard[] {
  if (!isSafeSessionId(sessionId)) return [];
  const updated: ReviewCard[] = [];
  for (const card of listReviewCards(contextRoot, slug)) {
    if (card.sessionId !== null || card.runFiredAt !== runFiredAt) continue;
    const next: ReviewCard = { ...card, sessionId };
    writeReviewCard(contextRoot, next);
    updated.push(next);
  }
  return updated;
}

/** Record what the agent said (or how it failed) once a verdict has been acted
 *  on. Separate from `resolveReviewCard` because the two happen at different
 *  times ON PURPOSE: the verdict is written before the resume spawns, the
 *  outcome only exists after it finishes. */
export function noteResolution(
  contextRoot: string,
  card: ReviewCard,
  outcome: { note?: string | null; error?: string | null },
): ReviewCard {
  const next: ReviewCard = {
    ...card,
    resolutionNote: outcome.note !== undefined ? outcome.note : card.resolutionNote,
    resolutionError: outcome.error !== undefined ? outcome.error : card.resolutionError,
  };
  writeReviewCard(contextRoot, next);
  return next;
}

/**
 * Put a resolved card back to pending.
 *
 * Legitimate on EXACTLY ONE path: the verdict's resume never spawned, so
 * provably nothing was carried out and the human's tap is owed a retry. It must
 * NOT be used when a resume started and then failed — an agent that ran for a
 * while with bypassPermissions may have done half the work, and re-approving
 * that would act twice. See `resumeWithVerdict`, which is the only caller.
 */
export function reopenReviewCard(contextRoot: string, card: ReviewCard, reason: string): ReviewCard {
  const next: ReviewCard = {
    ...card,
    state: 'pending',
    resolvedAt: null,
    resolvedVia: null,
    resolutionError: reason,
  };
  writeReviewCard(contextRoot, next);
  return next;
}

/** Attach a channel's handle for an already-rendered card, so a steer edits the
 *  existing card in place rather than posting a second copy of a proposal that
 *  has not changed identity. */
export function setChannelRef(
  contextRoot: string,
  card: ReviewCard,
  channel: ReviewChannel,
  ref: string,
): ReviewCard {
  const next: ReviewCard = { ...card, channelRefs: { ...card.channelRefs, [channel]: ref } };
  writeReviewCard(contextRoot, next);
  return next;
}

/** Is this card actionable beyond discarding it? A card whose run produced no
 *  usable session id has nothing to resume, so approve and steer cannot work —
 *  surfaces must say so rather than offering a button that silently fails. */
export function canResume(card: ReviewCard): boolean {
  return isSafeSessionId(card.sessionId);
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  const t = (s ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function firstLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return s.split('\n')[0]?.trim() ?? '';
}

/** Does a card file exist for this id? Used by the propose guard to refuse a
 *  duplicate write rather than silently clobbering an open proposal. */
export function reviewCardExists(contextRoot: string, slug: string, id: string): boolean {
  return existsSync(reviewCardPath(contextRoot, slug, id));
}
