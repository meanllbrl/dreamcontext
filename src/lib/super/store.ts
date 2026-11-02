import { promises as fsp } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  AGENDA_REF, MAX_PAD, PAD_AUTO_WHY, PAD_ID_RE, PAD_SECTIONS, cleanPadText, CHILD_ROWS, CONTAINER_ID_RE, CONTAINER_KINDS, CONTAINER_PLACES, CONTAINER_SHAPES, MAX_BRIEF, MAX_WAIT_KEY, MAX_CONTAINERS, MAX_DISMISSED, MAX_ENDED_CHILDREN,
  MAX_OWNER_BATCHES, MAX_MAIN_BATCHES, MAX_OWNER_TEXT, MAX_REQUEST_TEXT, MAX_REQUEST_RESULT, MEMBER_SUPER_PREFIX, parseWorkOrigin, MAX_POOL, MAX_POOL_BYTES, MAX_POOL_PROMPT, MAX_QUEUE, MAX_REF, MAX_TEAM_JOBS, MAX_TITLE,
  CONTAINER_SIZES, MAX_START_ERROR, MSG_REF_RE, POOL_ID_RE, QUEUE_ID_RE, QUEUE_KINDS, QUEUE_STATES, STUCK_REASONS, TASK_SLUG_RE, TEAM_JOB_ID_RE, VIEW_MODES, askLine, cleanAskOptions, cleanAskSpec, defaultShape, isMediaKind, MAX_HELD,
  ASK_SHOW_VIAS, ASPECT_MAX, ASPECT_MIN, MAX_ASK_PICTURES, MAX_FORMER_CHILDREN, MAX_ASK_READS, SESSION_ID_RE, SUPER_BRANCH_RE, SUPER_NOTES, SUPER_STATE_VERSION, emptySuperState, normalizeGroups, resolvePresent, trimTeamJobs, viewWithout,
  type AskShow, type SuperId, type SuperChild, type SuperContainer, type SuperPadItem, type SuperDismissed, type SuperNote, type SuperPoolItem, type SuperQueueItem, type SuperState, type SuperTeamJob, type SuperView, type SuperHeldEvent,
} from './types.js';
import { JOB_EFFORTS, parseJob, promptHash } from './jobs.js';
import { sanitizeModel } from '../claude-args.js';
import { capAskShows } from './ask-show.js';
import { OWNER_WAIT_KINDS, type OwnerWaitKind } from './owner-wait.js';
import { parseMcpNames } from './lean-mcp.js';
import { isSafeAutomationSlug } from '../agents/slot.js';
import { renameWithRetry } from '../fs-retry.js';

/**
 * The Super Agent's state file — `state/.super-agent.json`, one per vault (plan-r7 D2).
 *
 * The server is the ONLY writer. Reads are async; writes are atomic (a temp file in the same
 * directory, then a rename) and serialized per vault by an in-process lock, so the pump, the
 * agent's verbs and the owner's routes never interleave a read-modify-write. The file is
 * LOCAL-ONLY (both lists in `git-sync/brain-repo.ts`): it holds this machine's live session ids.
 *
 * It is also hand-editable by anyone with a shell, so every read goes through
 * {@link sanitizeSuperState}: a symlinked file (or state directory) is refused outright, and a
 * field that would widen what the super agent's token can reach — a worktree outside
 * `~/.claude-worktrees/`, a branch outside `super/*`, a child that is the super session itself
 * or another mode's chat — is dropped before anything acts on it.
 *
 * The children set the window-token checks (D4b) and the notch filtering (D16) read is kept IN
 * MEMORY beside the file ({@link superIndex}), refreshed on every read and write here, and
 * primed at server boot before the first registry event.
 */

export const SUPER_STATE_REL = join('state', '.super-agent.json');
/** The read cap; a write that would exceed it is refused before the rename (plan r4 D9), so no
 *  write can ever leave a record the next read refuses. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class SuperStoreRefused extends Error {
  constructor(public readonly reason: 'symlink' | 'outside' | 'too_large', message: string) {
    super(message);
    this.name = 'SuperStoreRefused';
  }
}

export interface SanitizeOpts {
  /** The home whose `.claude-worktrees/` a child's worktree must live under. Tests inject one. */
  home?: string;
  /** A session the registry knows as a `super`/`assistant` chat or an Assistant delegation:
   *  never a child (D2, D17). Absent = no registry view (boot before any chat registers). */
  isExcludedChat?: (sessionId: string) => boolean;
  /** Real paths of the worktrees `git worktree list --porcelain` reports for the vault's linked
   *  repos. When given, a child's worktree outside it is dropped (D2). Absent = not checked
   *  here; the caller checks before running git in it. */
  listedWorktrees?: ReadonlySet<string>;
  /** The clock a dismissal expires against. Tests inject one. */
  now?: number;
}

/** Ids the session-id pattern allows but no record may key by: they name Object.prototype's
 *  own slots (`state.children` and `state.notes` are plain objects). */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
export function isReservedId(id: string): boolean {
  return RESERVED_IDS.has(id);
}
const okSessionId = (id: string): boolean => SESSION_ID_RE.test(id) && !RESERVED_IDS.has(id);

export function superStatePath(contextRoot: string): string {
  return join(contextRoot, SUPER_STATE_REL);
}

// ─── Which super (plan-r10 1: one Super per AI Team member beside the project's own) ─────────

/** Where every member Super's files live: `state/.super/members/` (local-only, brain-repo.ts). */
export const MEMBER_SUPER_DIR = join('state', '.super', 'members');

/**
 * A super id from the wire: absent or '' = `main`; `m:<slug>` with the agent slug charset
 * (`isSafeAutomationSlug`, at most 100 characters: `..`, `/` and anything else refused) = that
 * member; anything else = null (the caller answers 400). Whether the member EXISTS is the caller's
 * check (no manifest: 404).
 */
export function parseSuperId(raw: unknown): SuperId | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'main') return 'main';
  if (typeof raw !== 'string' || !raw.startsWith(MEMBER_SUPER_PREFIX)) return null;
  const slug = raw.slice(MEMBER_SUPER_PREFIX.length);
  return okMember(slug) ? `m:${slug}` : null;
}

/** The member slug of a member super id; null for `main`. */
export function memberOfSuperId(id: SuperId): string | null {
  return id === 'main' ? null : id.slice(MEMBER_SUPER_PREFIX.length);
}

/** A member's super id (the slug unchecked: the caller passes a known member). */
export function superIdOfMember(slug: string): SuperId {
  return `m:${slug}`;
}

/** The record of `id`: main's is today's `state/.super-agent.json`, unchanged on disk. */
export function superRecordPath(contextRoot: string, id: SuperId = 'main'): string {
  const member = memberOfSuperId(id);
  return member === null ? superStatePath(contextRoot) : join(contextRoot, MEMBER_SUPER_DIR, `${member}.json`);
}

/** `id`'s read marks: main's `state/.super/read-marks.json`, a member's beside its record. */
export function superReadMarksPath(contextRoot: string, id: SuperId = 'main'): string {
  const member = memberOfSuperId(id);
  return member === null ? join(contextRoot, 'state', '.super', 'read-marks.json') : join(contextRoot, MEMBER_SUPER_DIR, `${member}.read-marks.json`);
}

/** `id`'s handoff file: main's `state/.super/handoff.md`, a member's beside its record. */
export function superHandoffPath(contextRoot: string, id: SuperId = 'main'): string {
  const member = memberOfSuperId(id);
  return member === null ? join(contextRoot, 'state', '.super', 'handoff.md') : join(contextRoot, MEMBER_SUPER_DIR, `${member}.handoff.md`);
}

/**
 * The key every in-memory map of one super is kept under (locks, index, the inbox's maps): main's
 * is the resolved context root itself (so every map keyed by root before Wave 2 still names main),
 * a member's the root, a NUL (never in a path) and its id. Decoded by {@link parseSuperKey}.
 */
export function superKey(contextRoot: string, id: SuperId = 'main'): string {
  const root = resolve(contextRoot);
  return id === 'main' ? root : `${root}\u0000${id}`;
}

/**
 * A root or a super key, with the super it names: a key's own id wins over `id` (the inbox passes
 * a super's key everywhere a root went before Wave 2, so one call shape serves every super).
 */
export function splitSuperRoot(rootOrKey: string, id: SuperId = 'main'): { root: string; superId: SuperId } {
  return rootOrKey.includes('\u0000') ? parseSuperKey(rootOrKey) : { root: rootOrKey, superId: id };
}

/** A super key back to its root and id; a plain root is main's. */
export function parseSuperKey(key: string): { root: string; superId: SuperId } {
  const at = key.indexOf('\u0000');
  if (at < 0) return { root: key, superId: 'main' };
  const id = parseSuperId(key.slice(at + 1));
  return { root: key.slice(0, at), superId: id ?? 'main' };
}

/** The directory every child worktree lives under. */
export function superWorktreeRoot(home: string = homedir()): string {
  return join(home, '.claude-worktrees');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const cap = (v: unknown, n: number): string | undefined => (typeof v === 'string' ? v.slice(0, n) : undefined);
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// eslint-disable-next-line no-control-regex
const stripControls = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ');

/** A child worktree path that may stand in the record: absolute, normalized, strictly under
 *  `~/.claude-worktrees/`, and (when the listing is known) one git really lists. */
export function acceptableWorktree(path: unknown, opts: SanitizeOpts = {}): path is string {
  if (typeof path !== 'string' || !path || path.length > 1024 || !isAbsolute(path)) return false;
  if (path.includes('\u0000') || normalize(path) !== path) return false;
  const root = superWorktreeRoot(opts.home);
  const abs = resolve(path);
  if (!abs.startsWith(root + sep) || abs.slice(root.length + 1).includes(sep)) return false;
  if (opts.listedWorktrees && !opts.listedWorktrees.has(abs)) return false;
  return true;
}

const unit = (v: unknown): number | undefined => {
  const n = finite(v);
  return n === undefined ? undefined : Math.min(1, Math.max(0, n));
};

/**
 * The cards (plan-r8 F1). A shape or place that is not in its list falls back to the kind's
 * default shape and `float`, so a record written before the floating-card surface (sizes,
 * regions, a focus flag) reads back as floating cards. A drop position needs two finite
 * numbers, clamped into [0, 1]; anything else is no position (placed automatically).
 */
function sanitizeContainers(raw: unknown, children: Readonly<Record<string, SuperChild>>, teamIds: ReadonlySet<string>): SuperContainer[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperContainer[] = [];
  const ids = new Set<string>();
  for (const c of raw) {
    if (out.length >= MAX_CONTAINERS) break;
    if (!isRecord(c)) continue;
    if (typeof c.id !== 'string' || !CONTAINER_ID_RE.test(c.id) || ids.has(c.id)) continue;
    if (!oneOf(CONTAINER_KINDS, c.kind)) continue;
    if (typeof c.ref !== 'string' || !c.ref || c.ref.length > MAX_REF || /[\u0000-\u001f\u007f]/.test(c.ref)) continue;
    // A live browser card shows a recorded child's frames: any other ref names nothing.
    if (c.kind === 'browser' && !(okSessionId(c.ref) && Object.prototype.hasOwnProperty.call(children, c.ref))) continue;
    // A team card shows one of the super's AI Team jobs, by its id.
    if (c.kind === 'team' && !(TEAM_JOB_ID_RE.test(c.ref) && teamIds.has(c.ref))) continue;
    // The agenda is one card with one ref.
    if (c.kind === 'agenda' && c.ref !== AGENDA_REF) continue;
    const title = cap(c.title, MAX_TITLE);
    const pos = isRecord(c.pos) ? { x: unit(c.pos.x), y: unit(c.pos.y) } : null;
    ids.add(c.id);
    out.push({
      id: c.id, kind: c.kind, ref: c.ref,
      shape: oneOf(CONTAINER_SHAPES, c.shape) ? c.shape : defaultShape(c.kind),
      // A size preset only when it is one (small is the absence of one). The owner's mark stands
      // with or without a size: he may have chosen small.
      ...(oneOf(CONTAINER_SIZES, c.size) && c.size !== 'small' ? { size: c.size } : {}),
      ...(c.sizeBy === 'owner' ? { sizeBy: 'owner' as const } : {}),
      ...(c.keptBy === 'owner' ? { keptBy: 'owner' as const } : {}),
      place: oneOf(CONTAINER_PLACES, c.place) ? c.place : 'float',
      ...(pos && pos.x !== undefined && pos.y !== undefined ? { pos: { x: pos.x, y: pos.y } } : {}),
      ...(title ? { title: stripControls(title) } : {}),
      ...(c.by === 'auto' ? { by: 'auto' as const } : {}),
      ...(c.by === 'auto' && typeof c.of === 'string' && Object.prototype.hasOwnProperty.call(children, c.of) ? { of: c.of } : {}),
      ...(c.kind === 'agenda' && c.min === true ? { min: true as const } : {}),
      ...(c.kind === 'chat' && typeof c.heldAt === 'number' && Number.isFinite(c.heldAt) && c.heldAt > 0 ? { heldAt: Math.min(c.heldAt, Date.now()) } : {}),
      // Media shown for a child's job: only a media card, only a child the record holds.
      ...(isMediaKind(c.kind) && typeof c.forChild === 'string' && Object.prototype.hasOwnProperty.call(children, c.forChild) && (finite(c.forAt) ?? -1) >= 0
        ? { forChild: c.forChild, forAt: finite(c.forAt) as number } : {}),
      // A picture's shape (server-read): finite and in range, else dropped (drawn as today).
      ...(c.kind === 'image' && typeof c.aspect === 'number' && Number.isFinite(c.aspect) && c.aspect >= ASPECT_MIN && c.aspect <= ASPECT_MAX
        ? { aspect: Math.round(c.aspect * 1000) / 1000 } : {}),
    });
  }
  return out;
}

/** The owner's "no" to automatic cards (G5): at most MAX_DISMISSED, an expired one dropped. */
function sanitizeDismissed(raw: unknown, now: number): SuperDismissed[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperDismissed[] = [];
  for (const d of raw) {
    if (!isRecord(d) || !oneOf(CONTAINER_KINDS, d.kind)) continue;
    if (typeof d.ref !== 'string' || !d.ref || d.ref.length > MAX_REF || /[\u0000-\u001f\u007f]/.test(d.ref)) continue;
    const until = finite(d.until);
    if (until === undefined || until <= now) continue;
    out.push({ kind: d.kind, ref: d.ref, until });
  }
  return out.slice(-MAX_DISMISSED);
}

/**
 * The stage's arrangement (plan-r8 F1): it may only name cards the record holds. A half page
 * naming a closed card, or a presentation left with none, is the floating stage again.
 */
export function sanitizeView(raw: unknown, containers: readonly SuperContainer[]): SuperView {
  if (!isRecord(raw) || !oneOf(VIEW_MODES, raw.mode)) return { mode: 'float' };
  const ids = new Set(containers.map((c) => c.id));
  if (raw.mode === 'half') {
    if (typeof raw.card !== 'string' || !ids.has(raw.card)) return { mode: 'float' };
    if (raw.auto === true) return { mode: 'half', card: raw.card, auto: true };
    return raw.by === 'owner' ? { mode: 'half', card: raw.card, by: 'owner' } : { mode: 'half', card: raw.card };
  }
  // A presentation always carries its resolved layout, and so every path that removes a card
  // (close, end, Others, a hand-over) re-resolves it here (plan-r2 D4, R2-E1/E2).
  if (raw.mode === 'present') return resolvePresent(raw, containers) ?? { mode: 'float' };
  return { mode: 'float' };
}

/** Picture questions' cards (ask-show.ts): known item ids, cards the record holds, a few. */
function sanitizeAskShows(raw: unknown, containers: readonly SuperContainer[]): AskShow[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(containers.map((c) => c.id));
  const cardsOf = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter((id): id is string => typeof id === 'string' && ids.has(id)))].slice(0, MAX_ASK_PICTURES) : []);
  const out: AskShow[] = [];
  for (const e of raw) {
    if (!isRecord(e) || typeof e.item !== 'string' || !QUEUE_ID_RE.test(e.item) || !oneOf(ASK_SHOW_VIAS, e.via)) continue;
    if (out.some((x) => x.item === e.item)) continue;
    out.push({
      item: e.item, cards: cardsOf(e.cards), opened: cardsOf(e.opened), via: e.via,
      ...(e.presented === true ? { presented: true as const } : {}),
      ...(e.skipped === 'owner_layout' ? { skipped: 'owner_layout' as const } : {}),
    });
  }
  return capAskShows(out);
}

function sanitizeChildren(raw: unknown, session: string | null, opts: SanitizeOpts, trimmed?: string[]): Record<string, SuperChild> {
  const out: Record<string, SuperChild> = {};
  if (!isRecord(raw)) return out;
  for (const [key, c] of Object.entries(raw)) {
    if (!okSessionId(key) || !isRecord(c) || c.sessionId !== key) continue;
    // The super never adopts itself, and no other mode's chat becomes a child (D2, D17).
    if (key === session || opts.isExcludedChat?.(key)) continue;
    const startedAt = finite(c.startedAt);
    if (startedAt === undefined) continue;
    const child: SuperChild = {
      sessionId: key,
      brief: stripControls(cap(c.brief, MAX_BRIEF) ?? ''),
      adopted: c.adopted === true,
      startedAt,
    };
    const endedAt = finite(c.endedAt);
    if (endedAt !== undefined) child.endedAt = endedAt;
    if (typeof c.succeededBy === 'string' && okSessionId(c.succeededBy) && c.succeededBy !== key) child.succeededBy = c.succeededBy;
    if (c.mode === 'basic' || c.mode === 'plan' || c.mode === 'develop') child.mode = c.mode;
    if (typeof c.model === 'string' && /^[A-Za-z0-9._[\]-]{1,60}$/.test(c.model)) child.model = c.model;
    if (typeof c.effort === 'string' && /^(low|medium|high|xhigh|max)$/.test(c.effort)) child.effort = c.effort;
    // The tool it runs on: kept, or every write turned a Codex or Antigravity child into Claude
    // (`super state`, its card and `super resume` all read it from here).
    if (c.tool === 'codex' || c.tool === 'antigravity') child.tool = c.tool;
    if (c.mcp !== undefined) { const m = parseMcpNames(c.mcp); if (!('error' in m) && m.names.length) child.mcp = m.names; }
    // A worktree and its branch travel together; either one hostile drops both.
    if (c.worktree !== undefined || c.branch !== undefined) {
      if (acceptableWorktree(c.worktree, opts) && typeof c.branch === 'string' && SUPER_BRANCH_RE.test(c.branch)) {
        child.worktree = c.worktree;
        child.branch = c.branch;
      }
    }
    // The job list's row (plan r4): every field to its own list or pattern, or dropped.
    if (oneOf(CHILD_ROWS, c.row)) child.row = c.row;
    const rowAt = finite(c.rowAt);
    if (rowAt !== undefined) child.rowAt = rowAt;
    if (c.settling === true) child.settling = true;
    if (typeof c.task === 'string' && TASK_SLUG_RE.test(c.task)) child.task = c.task;
    if (child.row === 'stuck' && oneOf(STUCK_REASONS, c.stuckReason)) child.stuckReason = c.stuckReason;
    if (child.row === 'stuck' && typeof c.startError === 'string') child.startError = c.startError.slice(0, MAX_START_ERROR);
    if (c.awaited === true) child.awaited = true;
    if (typeof c.origin === 'string' && MSG_REF_RE.test(c.origin)) child.origin = c.origin;
    const wo = parseWorkOrigin(c.workOrigin);
    if (wo) child.workOrigin = wo;
    // The agenda's two stamps (epoch ms): a non-finite or negative value is dropped.
    const sentAt = finite(c.sentAt);
    if (sentAt !== undefined && sentAt >= 0) child.sentAt = sentAt;
    const succeededAt = finite(c.succeededAt);
    if (child.succeededBy && succeededAt !== undefined && succeededAt >= 0) child.succeededAt = succeededAt;
    for (const k of ['finishedAt', 'seenAt', 'seenMarkedAt'] as const) {
      const v = finite(c[k]);
      // A "seen" from the future would hide every later finish: never past now (as the route clamps).
      if (v !== undefined && v >= 0) child[k] = k === 'finishedAt' ? v : Math.min(v, Date.now());
    }
    if (child.seenAt === undefined) delete child.seenMarkedAt;
    out[key] = child;
  }
  // Ended children are history: only the newest MAX_ENDED_CHILDREN stay in the record. One that
  // still owns a worktree always stays (`super merge` and `worktree remove` reach it by child).
  const ended = Object.values(out).filter((c) => c.endedAt !== undefined && !c.worktree).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const c of ended.slice(MAX_ENDED_CHILDREN)) { trimmed?.push(c.sessionId); delete out[c.sessionId]; }
  return out;
}

function sanitizeQueue(raw: unknown, session: string | null): SuperQueueItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperQueueItem[] = [];
  const ids = new Set<string>();
  for (const q of raw) {
    if (!isRecord(q)) continue;
    if (typeof q.id !== 'string' || !QUEUE_ID_RE.test(q.id) || ids.has(q.id)) continue;
    if (typeof q.sessionId !== 'string' || !okSessionId(q.sessionId)) continue;
    if (!oneOf(QUEUE_KINDS, q.kind) || !oneOf(QUEUE_STATES, q.state)) continue;
    const createdAt = finite(q.createdAt);
    if (createdAt === undefined) continue;
    // The super agent's own question (`super ask`) is always about the super session itself, and
    // answers no child request (plan r4 D7).
    const isAsk = q.kind === 'ask';
    if (isAsk && q.sessionId !== session) continue;
    const requestId = !isAsk && typeof q.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(q.requestId) ? q.requestId : undefined;
    // A permission is rendered only from the child's own tool name and input (D7): the super
    // agent's words never caption one (not even a Bypass child's it hands to the owner), so none
    // survive on a permission item.
    // An approval item exists only for its member; one naming none (or a hostile one) is dropped.
    const member = q.kind === 'approval' && typeof q.member === 'string' && okMember(q.member) ? q.member : undefined;
    if (q.kind === 'approval' && !member) continue;
    // An automation item exists only for its automation and a decision the owner made.
    const automation = q.kind === 'automation' && typeof q.automation === 'string' && okMember(q.automation) ? q.automation : undefined;
    const decision = q.kind === 'automation' && (q.decision === 'approved' || q.decision === 'rejected') ? q.decision : undefined;
    if (q.kind === 'automation' && (!automation || !decision)) continue;
    // An owner item exists only for its wait (which card of the child he must act on).
    const wait = q.kind === 'owner' ? cleanOwnerWait(q.wait) : undefined;
    if (q.kind === 'owner' && !wait) continue;
    const rawText = q.kind === 'permission' ? undefined : cap(q.ownerText, MAX_OWNER_TEXT);
    const ownerText = rawText && isAsk ? askLine(rawText) : rawText;
    // An ask's options are re-validated whole: one refused option drops them all (the bar then
    // offers Reply only), never a cut one.
    const options = isAsk ? cleanAskOptions(q.options) ?? [] : [];
    // Its AskUserQuestion-shaped spec, re-validated whole: a refused one is dropped (the card
    // then draws the question from its text and options). Kept only while the question is open:
    // nothing draws a closed one, and its previews (up to 32 KB) would ride every write and push.
    const askSpec = isAsk && q.ask !== undefined && q.state !== 'done' ? cleanAskSpec(q.ask) : null;
    const batch = typeof q.batch === 'string' && QUEUE_ID_RE.test(q.batch) ? q.batch : undefined;
    // A team job's ending names its job; only an ending kind does.
    const team = (q.kind === 'done' || q.kind === 'stuck' || q.kind === 'question') && typeof q.team === 'string' && TEAM_JOB_ID_RE.test(q.team) ? q.team : undefined;
    // A request carries its job; a reply its answer and the ask it answers. Neither without its text.
    const isRequest = q.kind === 'request';
    const isReply = q.kind === 'reply';
    // A team event about a member Super's job (its result, a note, its question to main) carries text too.
    const teamText = !!team && (q.kind === 'done' || q.kind === 'question');
    const text = isRequest || isReply || teamText ? cap(q.text, MAX_REQUEST_TEXT) : undefined;
    if ((isRequest || isReply) && !text) continue;
    const answers = (isReply || (q.kind === 'question' && !!team)) && typeof q.answers === 'string' && QUEUE_ID_RE.test(q.answers) ? q.answers : undefined;
    const result = isRequest ? cap(q.result, MAX_REQUEST_RESULT) : undefined;
    const acceptedAt = isRequest ? finite(q.acceptedAt) : undefined;
    const workOrigin = parseWorkOrigin(q.workOrigin);
    const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, 9) : 0);
    // An ask's report cards, while it is open (nothing points at them after his answer).
    const read = isAsk && q.state !== 'done' && Array.isArray(q.read)
      ? [...new Set(q.read.filter((r): r is string => typeof r === 'string' && CONTAINER_ID_RE.test(r)))].slice(0, MAX_ASK_READS)
      : [];
    ids.add(q.id);
    out.push({
      id: q.id, sessionId: q.sessionId, kind: q.kind, state: q.state, createdAt,
      ...(member ? { member } : {}),
      ...(automation && decision ? { automation, decision } : {}),
      ...(wait ? { wait } : {}),
      ...(requestId ? { requestId } : {}),
      ...(ownerText ? { ownerText } : {}),
      ...(q.kind === 'ended' && typeof q.brief === 'string' ? { brief: stripControls(cap(q.brief, MAX_BRIEF) ?? '') } : {}),
      // How many delivered turns ended with the item unsettled (wave 2, M1), and how many process
      // exits ended a turn that carried it (plan r4 D10).
      ...(count(q.attempts) ? { attempts: count(q.attempts) } : {}),
      ...(count(q.exits) ? { exits: count(q.exits) } : {}),
      ...(batch ? { batch } : {}),
      ...(team ? { team } : {}),
      ...(team && isRecord(q.posts) ? { posts: {
        ...(typeof q.posts.after === 'string' && ENTRY_ID_RE.test(q.posts.after) ? { after: q.posts.after } : {}),
        ...(typeof q.posts.upto === 'string' && ENTRY_ID_RE.test(q.posts.upto) ? { upto: q.posts.upto } : {}),
      } } : {}),
      ...(team && q.partial === true ? { partial: true as const } : {}),
      ...(q.kind === 'question' && !team && q.direct === true ? { direct: true as const } : {}),
      ...(q.kind === 'permission' && q.toSuper === true ? { toSuper: true as const } : {}),
      ...(options.length ? { options } : {}),
      ...(askSpec && askSpec.ok ? { ask: askSpec.spec } : {}),
      ...(read.length ? { read } : {}),
      ...(text ? { text } : {}),
      ...(isRequest && typeof q.model === 'string' && sanitizeModel(q.model) ? { model: q.model } : {}),
      ...(isRequest && typeof q.effort === 'string' && (JOB_EFFORTS as readonly string[]).includes(q.effort) ? { effort: q.effort } : {}),
      ...(isRequest && q.light === true ? { light: true as const } : {}),
      ...(result ? { result } : {}),
      ...(acceptedAt !== undefined && acceptedAt >= 0 ? { acceptedAt } : {}),
      ...(answers ? { answers } : {}),
      ...(workOrigin ? { workOrigin } : {}),
    });
  }
  // Over the cap: the oldest finished items go first, then the oldest of the rest. An OPEN request
  // is never pruned (only `team done` closes it); open requests are capped per member at the verb.
  while (out.length > MAX_QUEUE) {
    const done = out.findIndex((q) => q.state === 'done');
    const other = out.findIndex((q) => q.kind !== 'request');
    const at = done >= 0 ? done : other;
    if (at < 0) break;
    out.splice(at, 1);
  }
  return out;
}

/** An owner item's wait, re-validated: a known kind and a card id of the chat's own shape. */
function cleanOwnerWait(raw: unknown): { kind: OwnerWaitKind; id: string; key?: string } | undefined {
  if (!isRecord(raw) || !oneOf(OWNER_WAIT_KINDS, raw.kind)) return undefined;
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(raw.id)) return undefined;
  const key = typeof raw.key === 'string' && raw.key.length <= MAX_WAIT_KEY && !/[\r\n]/.test(raw.key) ? raw.key : undefined;
  return { kind: raw.kind, id: raw.id, ...(key ? { key } : {}) };
}

/** An AI Team member's agent slug, as the automation store accepts it (a path segment there). */
export function okMember(slug: string): boolean {
  return slug.length <= 100 && isSafeAutomationSlug(slug);
}

/** A thread run id is its fire time, an ISO string; an entry id is time-prefixed and sortable. */
const RUN_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{1,20}Z$/;
const ENTRY_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

function sanitizeTeam(raw: unknown): SuperTeamJob[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperTeamJob[] = [];
  const ids = new Set<string>();
  for (const j of raw) {
    if (!isRecord(j) || typeof j.id !== 'string' || !TEAM_JOB_ID_RE.test(j.id) || ids.has(j.id)) continue;
    if (typeof j.member !== 'string' || !okMember(j.member)) continue;
    if (typeof j.runId !== 'string' || !RUN_ID_RE.test(j.runId)) continue;
    const startedAt = finite(j.startedAt);
    if (startedAt === undefined) continue;
    ids.add(j.id);
    out.push({
      id: j.id, member: j.member, runId: j.runId,
      ...(typeof j.entryId === 'string' && ENTRY_ID_RE.test(j.entryId) ? { entryId: j.entryId } : {}),
      jobKind: j.jobKind === 'reply' ? 'reply' : 'run',
      ...(typeof j.jobId === 'string' && ENTRY_ID_RE.test(j.jobId) ? { jobId: j.jobId } : {}),
      queued: j.queued === true,
      brief: stripControls(cap(j.brief, MAX_BRIEF) ?? ''),
      startedAt,
      ...(j.outcome === 'done' || j.outcome === 'failed' ? { outcome: j.outcome } : {}),
      ...(finite(j.deliveredAt) !== undefined ? { deliveredAt: finite(j.deliveredAt) } : {}),
      ...(finite(j.endedAt) !== undefined ? { endedAt: finite(j.endedAt) } : {}),
      ...(j.awaited === true ? { awaited: true as const } : {}),
      ...(typeof j.origin === 'string' && MSG_REF_RE.test(j.origin) ? { origin: j.origin } : {}),
      ...(typeof j.model === 'string' && sanitizeModel(j.model) ? { model: j.model } : {}),
      ...(typeof j.effort === 'string' && (JOB_EFFORTS as readonly string[]).includes(j.effort) ? { effort: j.effort } : {}),
      ...(j.light === true ? { light: true as const } : {}),
      ...(j.told === 'done' || j.told === 'stuck' || j.told === 'question' ? { told: j.told } : {}),
      ...(j.told === 'question' && typeof j.toldQuestion === 'string' && ENTRY_ID_RE.test(j.toldQuestion) ? { toldQuestion: j.toldQuestion } : {}),
      ...(j.open === true ? { open: true as const } : {}),
      ...(j.concluded === 'gone' || j.concluded === 'lost' ? { concluded: j.concluded } : {}),
      ...(typeof j.toldPost === 'string' && ENTRY_ID_RE.test(j.toldPost) ? { toldPost: j.toldPost } : {}),
      ...(finite(j.toldEndAt) !== undefined ? { toldEndAt: finite(j.toldEndAt) } : {}),
      ...(typeof j.followUpOf === 'string' && TEAM_JOB_ID_RE.test(j.followUpOf) ? { followUpOf: j.followUpOf } : {}),
      ...(j.by === 'super' && typeof j.followUpOf === 'string' ? { by: 'super' as const } : {}),
      ...(typeof j.request === 'string' && QUEUE_ID_RE.test(j.request) ? { request: j.request } : {}),
    });
  }
  // Over the cap the oldest follow-ups go first; a member's current root never does (plan-r10 1b).
  return trimTeamJobs(out.sort((a, b) => b.startedAt - a.startedAt), MAX_TEAM_JOBS);
}

/** The one card of a member on the stage (plan-r10 1b): `containerIdFor('team', 'member:' + slug)`,
 *  computed here the same way (this module imports nothing of the inbox). */
export function memberTeamCardId(member: string): string {
  return `team-${createHash('sha1').update(`member:${member}`).digest('hex').slice(0, 12)}`;
}

/**
 * ONE team card per member (plan-r10 1b; the owner's nine Gantt cards, i74xj5). Every read runs
 * it and it is idempotent, so the first boot after the upgrade collapses the record and every later
 * read finds nothing to do: the team cards of one member become one, the NEWEST card survives with
 * its place, drop and size, re-keyed to the member's card id and pointed at the member's current
 * root; the others retire (machine-made cards, never an owner's placement of anything else). Groups
 * and the view follow the new id; a retired card leaves them. Works on the raw record, before
 * the containers are sanitized.
 */
export function collapseTeamCards(raw: Record<string, unknown>, team: readonly SuperTeamJob[]): Record<string, unknown> {
  const list = raw.containers;
  if (!Array.isArray(list)) return raw;
  const byId = new Map(team.map((j) => [j.id, j] as const));
  const current = new Map<string, SuperTeamJob>();
  for (const j of team) if (!j.followUpOf && !current.has(j.member)) current.set(j.member, j);
  // The member a team card belongs to, and when its job started.
  const cards: { i: number; member: string; at: number }[] = [];
  list.forEach((c: unknown, i: number) => {
    if (!isRecord(c) || c.kind !== 'team' || typeof c.ref !== 'string') return;
    const job = byId.get(c.ref);
    if (job) cards.push({ i, member: job.member, at: job.startedAt });
  });
  if (cards.length === 0) return raw;
  const rename = new Map<string, string>();
  const retire = new Set<string>();
  const next: unknown[] = [...list];
  let changed = false;
  const members = new Set(cards.map((c) => c.member));
  for (const member of members) {
    const mine = cards.filter((c) => c.member === member).sort((a, b) => b.at - a.at);
    const keep = mine[0];
    const want = memberTeamCardId(member);
    const root = current.get(member);
    const kept = next[keep.i] as Record<string, unknown>;
    const already = mine.length === 1 && kept.id === want && (!root || kept.ref === root.id);
    if (already) continue;
    changed = true;
    if (typeof kept.id === 'string' && kept.id !== want) rename.set(kept.id, want);
    next[keep.i] = { ...kept, id: want, ...(root ? { ref: root.id } : {}) };
    for (const c of mine.slice(1)) {
      const id = (next[c.i] as Record<string, unknown>).id;
      if (typeof id === 'string') retire.add(id);
      next[c.i] = null;
    }
  }
  if (!changed) return raw;
  const map = (id: unknown): string | null => (typeof id !== 'string' ? null : retire.has(id) ? null : rename.get(id) ?? id);
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map((g: unknown) => (isRecord(g) && Array.isArray(g.cards) ? { ...g, cards: g.cards.map(map).filter((x): x is string => x !== null) } : g))
    : raw.groups;
  let view = raw.view;
  if (isRecord(view)) {
    const v: Record<string, unknown> = { ...view };
    if (v.card !== undefined) { const m = map(v.card); if (m) v.card = m; else delete v.card; }
    if (Array.isArray(v.cards)) v.cards = v.cards.map(map).filter((x): x is string => x !== null);
    view = v;
  }
  return { ...raw, containers: next.filter((c) => c !== null), groups, view };
}

/**
 * The pool (plan r4 D9): every row read back through the verbs' own job parser, a prompt of at
 * most MAX_POOL_PROMPT bytes, at most MAX_POOL rows and MAX_POOL_BYTES serialized (the oldest
 * rows win: a row past either cap is dropped). A worktree a `--from` may have opened travels
 * with its branch, under the same rule as a child's.
 */
/** The agenda notepad: known sections, one id each, a non-empty line, a finite time. */
function sanitizePad(raw: unknown): SuperPadItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperPadItem[] = [];
  const ids = new Set<string>();
  for (const p of raw) {
    if (out.length >= MAX_PAD) break;
    if (!isRecord(p) || typeof p.id !== 'string' || !PAD_ID_RE.test(p.id) || ids.has(p.id)) continue;
    if (!oneOf(PAD_SECTIONS, p.section)) continue;
    const text = cleanPadText(p.text);
    const at = finite(p.at);
    if (!text || at === undefined || at < 0) continue;
    ids.add(p.id);
    const toldAt = finite(p.toldAt);
    const by = p.by === 'auto' || p.by === 'owner' ? p.by : undefined;
    out.push({
      id: p.id, section: p.section, text, at,
      ...(typeof p.for === 'string' && SESSION_ID_RE.test(p.for) ? { for: p.for } : {}),
      ...(by ? { by } : {}),
      ...(by === 'auto' && oneOf(PAD_AUTO_WHY, p.why) ? { why: p.why } : {}),
      ...(toldAt !== undefined && toldAt >= 0 ? { toldAt } : {}),
    });
  }
  return out;
}

/** Pin ids only, newest kept. */
function sanitizeFormerChildren(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && SESSION_ID_RE.test(id)))].slice(-MAX_FORMER_CHILDREN);
}

function sanitizePool(raw: unknown, opts: SanitizeOpts): SuperPoolItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperPoolItem[] = [];
  const ids = new Set<string>();
  let bytes = 2;
  for (const p of raw) {
    if (out.length >= MAX_POOL) break;
    if (!isRecord(p) || typeof p.id !== 'string' || !POOL_ID_RE.test(p.id) || ids.has(p.id)) continue;
    const createdAt = finite(p.createdAt);
    if (createdAt === undefined) continue;
    if (typeof p.prompt !== 'string' || Buffer.byteLength(p.prompt, 'utf-8') > MAX_POOL_PROMPT) continue;
    const parsed = parseJob({ ...p, brief: p.title });
    if ('error' in parsed) continue;
    const j = parsed.job;
    const note = stripControls(cap(p.note, MAX_BRIEF) ?? '').trim();
    const row: SuperPoolItem = {
      id: p.id, title: j.title, prompt: j.prompt, hash: promptHash(j.prompt), createdAt,
      ...(note ? { note } : {}),
      ...(j.task ? { task: j.task } : {}),
      ...(j.mode !== 'basic' ? { mode: j.mode } : {}),
      ...(j.model ? { model: j.model } : {}),
      ...(j.effort ? { effort: j.effort } : {}),
      ...(j.worktree ? { worktree: j.worktree } : {}),
      ...(j.slug ? { slug: j.slug } : {}),
      ...(j.base ? { base: j.base } : {}),
      ...(j.mcp ? { mcp: j.mcp } : {}),
      ...(j.tool ? { tool: j.tool } : {}),
      ...(p.held === true ? { held: true } : {}),
      ...(p.maybeStarted === true ? { maybeStarted: true } : {}),
    };
    if (row.maybeStarted && acceptableWorktree(p.startedIn, opts) && typeof p.startedBranch === 'string' && SUPER_BRANCH_RE.test(p.startedBranch)) {
      row.startedIn = p.startedIn;
      row.startedBranch = p.startedBranch;
    }
    const size = Buffer.byteLength(JSON.stringify(row), 'utf-8') + 1;
    if (bytes + size > MAX_POOL_BYTES) break;
    bytes += size;
    ids.add(p.id);
    out.push(row);
  }
  return out;
}

/** Batch ids of the turns that render in full: unique, newest MAX_OWNER_BATCHES kept. */
function sanitizeOwnerBatches(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const b of raw) if (typeof b === 'string' && QUEUE_ID_RE.test(b) && !out.includes(b)) out.push(b);
  return out.slice(-MAX_OWNER_BATCHES);
}

/** A member Super's main-origin batch ids: unique, newest MAX_MAIN_BATCHES kept. */
function sanitizeMainBatches(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const b of raw) if (typeof b === 'string' && QUEUE_ID_RE.test(b) && !out.includes(b)) out.push(b);
  return out.slice(-MAX_MAIN_BATCHES);
}

/** The held ledger: well-formed entries of items still on the queue, unique, newest MAX_HELD. */
function sanitizeHeld(raw: unknown, queue: readonly SuperQueueItem[]): SuperHeldEvent[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(queue.map((q) => q.id));
  const out: SuperHeldEvent[] = [];
  for (const h of raw) {
    if (!isRecord(h) || typeof h.item !== 'string' || !ids.has(h.item) || out.some((x) => x.item === h.item)) continue;
    if (typeof h.child !== 'string' || !okSessionId(h.child)) continue;
    if (h.kind !== 'question' && h.kind !== 'done' && h.kind !== 'stuck' && h.kind !== 'gone' && h.kind !== 'owner') continue;
    const at = finite(h.at);
    if (at === undefined) continue;
    out.push({ item: h.item, child: h.child, kind: h.kind, at });
  }
  return out.slice(-MAX_HELD);
}

/** A record read from disk (or built by a caller), with everything hostile dropped. */
export function sanitizeSuperState(input: unknown, opts: SanitizeOpts = {}): SuperState {
  const base = emptySuperState();
  if (!isRecord(input) || input.v !== SUPER_STATE_VERSION) return base;
  const session = typeof input.session === 'string' && okSessionId(input.session) ? input.session : null;
  // A child trimmed from the history is still the Super's: its id stays in `formerChildren`.
  const trimmedChildren: string[] = [];
  const children = sanitizeChildren(input.children, session, opts, trimmedChildren);
  // Groups settle against the cards (a closed card leaves its group, a group of one dissolves
  // into its card), so they come back with the cards they may have changed.
  // A team card shows a recorded job: one whose job fell off the record goes with it.
  const team = sanitizeTeam(input.team);
  // One card per member, the owner's old pile of cards collapsed once (idempotent, every read).
  const raw: Record<string, unknown> = collapseTeamCards(input, team);
  const { containers, groups } = normalizeGroups(sanitizeContainers(raw.containers, children, new Set(team.map((j) => j.id))), raw.groups);
  const notes: Record<string, SuperNote> = {};
  if (isRecord(raw.notes)) {
    for (const [k, n] of Object.entries(raw.notes)) {
      if (okSessionId(k) && k !== session && oneOf(SUPER_NOTES, n)) notes[k] = n;
    }
  }
  const away = isRecord(raw.away) ? raw.away : {};
  const queue = sanitizeQueue(raw.queue, session);
  const held = sanitizeHeld(raw.held, queue);
  const pad = sanitizePad(raw.pad);
  const released = sanitizeFormerChildren(Array.isArray(raw.released) ? raw.released : []);
  const formerChildren = sanitizeFormerChildren([...(Array.isArray(raw.formerChildren) ? raw.formerChildren : []), ...trimmedChildren]);
  const rawChildren = isRecord(raw.children) ? raw.children : {};
  const trimmedAdopted = trimmedChildren.filter((id) => { const c = rawChildren[id]; return isRecord(c) && c.adopted === true; });
  const formerAdopted = sanitizeFormerChildren([...(Array.isArray(raw.formerAdopted) ? raw.formerAdopted : []), ...trimmedAdopted]);
  const askShows = sanitizeAskShows(raw.askShows, containers);
  const rawSeq = finite(raw.padSeq);
  const padSeq = rawSeq !== undefined && rawSeq > 0 && rawSeq < 1e6 ? Math.floor(rawSeq) : 0;
  const since = finite(away.since);
  const events = finite(away.events);
  const mainBatches = sanitizeMainBatches(raw.mainBatches);
  const member = typeof raw.member === 'string' && okMember(raw.member) ? raw.member : undefined;
  return {
    v: SUPER_STATE_VERSION,
    session,
    enabled: raw.enabled === true && session !== null,
    containers,
    groups,
    view: sanitizeView(raw.view, containers),
    children,
    queue,
    notes,
    away: { since: since ?? null, events: events !== undefined && events > 0 ? Math.floor(events) : 0 },
    dismissed: sanitizeDismissed(raw.dismissed, opts.now ?? Date.now()),
    pool: sanitizePool(raw.pool, opts),
    ...(formerChildren.length ? { formerChildren } : {}),
    ...(released.length ? { released } : {}),
    ...(formerAdopted.length ? { formerAdopted } : {}),
    ownerBatches: sanitizeOwnerBatches(raw.ownerBatches),
    team,
    ...(held.length ? { held } : {}),
    ...(pad.length ? { pad } : {}),
    ...(padSeq ? { padSeq } : {}),
    ...(askShows.length ? { askShows } : {}),
    ...(member ? { member } : {}),
    ...(mainBatches.length ? { mainBatches } : {}),
  };
}

// ─── Containment ────────────────────────────────────────────────────────────────

/**
 * Refuse a symlinked record file, a `state/` directory that resolves outside the vault, and, for a
 * member Super, a `state/.super/` or `state/.super/members/` that is a link or resolves anywhere
 * but where it stands (lstat + realpath-contain). `create`: a write may make the members folder
 * (0700) first; a read never does.
 */
async function assertContained(contextRoot: string, id: SuperId = 'main', create = false): Promise<string> {
  const path = superRecordPath(contextRoot, id);
  const stateDir = join(contextRoot, 'state');
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = await fsp.realpath(contextRoot);
    realDir = await fsp.realpath(stateDir);
  } catch {
    throw new SuperStoreRefused('outside', 'the vault has no state directory');
  }
  if (realDir !== join(realRoot, 'state')) throw new SuperStoreRefused('outside', 'state/ resolves outside the vault');
  if (id !== 'main') {
    for (const rel of [join('state', '.super'), MEMBER_SUPER_DIR]) {
      const dir = join(contextRoot, rel);
      let st: Awaited<ReturnType<typeof fsp.lstat>>;
      try { st = await fsp.lstat(dir); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (!create) return path;
        await fsp.mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
        st = await fsp.lstat(dir);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new SuperStoreRefused('symlink', `${rel} is not a plain folder; refusing it`);
      const real = await fsp.realpath(dir);
      if (real !== join(realRoot, rel)) throw new SuperStoreRefused('outside', `${rel} resolves outside the vault`);
    }
  }
  const name = id === 'main' ? '.super-agent.json' : `members/${memberOfSuperId(id)}.json`;
  try {
    const st = await fsp.lstat(path);
    if (st.isSymbolicLink()) throw new SuperStoreRefused('symlink', `${name} is a symlink; refusing it`);
    if (!st.isFile()) throw new SuperStoreRefused('symlink', `${name} is not a file; refusing it`);
    if (st.size > MAX_FILE_BYTES) throw new SuperStoreRefused('too_large', `${name} is too large`);
  } catch (err) {
    if (err instanceof SuperStoreRefused) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return path;
}

/** A record as it belongs to `id`: a member's always names its own member (whatever the file
 *  says), main's never names one. */
function ownedBy(state: SuperState, id: SuperId): SuperState {
  const member = memberOfSuperId(id);
  if (member === null) { if (state.member !== undefined) delete state.member; return state; }
  state.member = member;
  return state;
}

/** The record on disk, sanitized, with no effect on the index. */
async function loadSuperState(contextRoot: string, opts: SanitizeOpts, id: SuperId = 'main'): Promise<SuperState> {
  const path = await assertContained(contextRoot, id);
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ownedBy(emptySuperState(), id);
    throw err;
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return ownedBy(sanitizeSuperState(parsed, opts), id);
}

const isSuperId = (v: unknown): v is SuperId => v === 'main' || (typeof v === 'string' && v.startsWith(MEMBER_SUPER_PREFIX));

/**
 * The vault's record (main's, or `id`'s), sanitized. Absent → an empty state. A symlinked file →
 * SuperStoreRefused. `readSuperState(root, opts)` stays main's (every caller before Wave 2).
 *
 * A read takes no lock, so it can START before a write and FINISH after it holding the old
 * record. It refreshes the in-memory index only when nothing changed that super's entry while
 * it ran ({@link generation}): otherwise a slow `super state` racing the owner's Take back
 * would put `enabled: true` back in memory (children hidden from the notch again), or put a
 * cleared note back (a second message would carry it).
 */
export async function readSuperState(rootOrKey: string, idOrOpts?: SuperId | SanitizeOpts, maybeOpts: SanitizeOpts = {}): Promise<SuperState> {
  const { root: contextRoot, superId: id } = splitSuperRoot(rootOrKey, isSuperId(idOrOpts) ? idOrOpts : 'main');
  const opts: SanitizeOpts = isSuperId(idOrOpts) ? maybeOpts : (idOrOpts ?? {});
  const key = superKey(contextRoot, id);
  const startedAt = generation.get(key) ?? 0;
  const state = await loadSuperState(contextRoot, opts, id);
  if ((generation.get(key) ?? 0) === startedAt) indexState(key, state);
  return state;
}

async function writeSuperState(contextRoot: string, state: SuperState, id: SuperId = 'main'): Promise<void> {
  const path = await assertContained(contextRoot, id, true);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  // Measured in UTF-8 bytes, as the read's `st.size` is: never write what the read refuses.
  if (Buffer.byteLength(text, 'utf-8') > MAX_FILE_BYTES) throw new SuperStoreRefused('too_large', 'this change would make the Super record too large; nothing was written');
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, text, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  try {
    await renameWithRetry(tmp, path);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => { /* already gone */ });
    throw err;
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` under one super's lock (main's is keyed by the vault root, as before). */
function withVaultLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  locks.set(key, settled);
  void settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return run;
}

// ─── A phone never holds a Super child (hands-free sekmeler plan r8) ─────────

/** Thrown inside a write's callback by a caller that names a chat a phone holds (`adopt`,
 *  `resume`): nothing is written; the route answers `409 phone_held`. */
export class PhoneHeldError extends Error {
  constructor(readonly sessionId: string) { super('a remote screen holds this chat'); this.name = 'PhoneHeldError'; }
}

/** Is a chat held (or being opened) by a phone socket right now? agent-chat.ts registers it at
 *  load (a lib module never imports a route). Absent = nothing is phone-held. */
let phoneHoldsProbe: ((sessionId: string) => boolean) | null = null;
export function setPhoneHoldsProbe(fn: ((sessionId: string) => boolean) | null): void { phoneHoldsProbe = fn; }

/** The probe's answer; one that throws counts as held (fail closed). */
export function phoneHeld(sessionId: string): boolean {
  if (!phoneHoldsProbe) return false;
  try { return phoneHoldsProbe(sessionId); } catch { return true; }
}

/** The children a record ARMS: not ended, of an enabled record (the socket gate's reading). */
function armedChildren(s: SuperState): Set<string> {
  return s.enabled ? new Set(Object.keys(s.children).filter((k) => s.children[k].endedAt === undefined)) : new Set();
}

interface WriteBefore { armed: Set<string>; containers: Set<string>; notes: Record<string, SuperNote>; open: Set<string> }

function beforeWrite(s: SuperState): WriteBefore {
  return {
    armed: armedChildren(s),
    containers: new Set(s.containers.map((c) => c.id)),
    notes: { ...s.notes },
    open: new Set(s.queue.filter((q) => q.state !== 'done').map((q) => q.id)),
  };
}

/**
 * The record-side invariant: no child is ARMED by this write while a phone holds it. Every child
 * armed in `next` and not in `before` (an `endedAt` cleared, or `enabled` false→true over kept
 * children) that the probe calls phone-held is set back to ended, and what this write added for
 * it goes: its new cards, its new note, every open queue item about it. A card or note the
 * record already had stays. Mutates `next`; returns the demoted ids.
 */
function demotePhoneHeld(before: WriteBefore, next: SuperState): string[] {
  const demoted = [...armedChildren(next)].filter((id) => !before.armed.has(id) && phoneHeld(id));
  if (!demoted.length) return demoted;
  const now = Date.now();
  const gone = new Set<string>();
  for (const id of demoted) {
    next.children[id].endedAt = now;
    for (const c of next.containers) {
      if (before.containers.has(c.id)) continue;
      if ((c.kind === 'chat' && c.ref === id) || c.forChild === id) gone.add(c.id);
    }
    if (Object.prototype.hasOwnProperty.call(before.notes, id)) next.notes[id] = before.notes[id];
    else delete next.notes[id];
  }
  const ids = new Set(demoted);
  for (const q of next.queue) if (ids.has(q.sessionId) && q.state !== 'done') q.state = 'done';
  if (next.held) next.held = next.held.filter((h) => !ids.has(h.child));
  if (gone.size) {
    next.containers = next.containers.filter((c) => !gone.has(c.id));
    next.groups = next.groups.map((g) => ({ ...g, cards: g.cards.filter((c) => !gone.has(c)) }));
    next.view = viewWithout(next.view, gone);
  }
  return demoted;
}

/** Per super (its key), what the write in flight is about to make true: the socket gate reads it
 *  beside the index, so a phone open racing a hand-over write is judged by the record being written. */
const pendingArm = new Map<string, { enabled: boolean; children: Set<string> }>();

export interface UpdateOpts extends SanitizeOpts {
  /** Told which children the phone-held invariant ended in this write (none: not called). */
  onDemoted?: (ids: string[]) => void;
}

/**
 * Read, change, sanitize and write ONE super's record as one step, under its lock. `fn` mutates the
 * draft (or returns a replacement); what it produces is sanitized again before it is written, so no
 * caller can persist a field a read would drop. Returns what was written.
 *
 * Every write keeps the phone-held invariant ({@link demotePhoneHeld}), whoever the caller is. A
 * member's record keeps naming its member; main's never names one.
 */
export function withSuperState(
  rootOrKey: string,
  idIn: SuperId,
  fn: (draft: SuperState) => SuperState | void,
  opts: UpdateOpts = {},
): Promise<SuperState> {
  const { root: contextRoot, superId: id } = splitSuperRoot(rootOrKey, idIn);
  const key = superKey(contextRoot, id);
  return withVaultLock(key, async () => {
    const draft = await loadSuperState(contextRoot, opts, id);
    const before = beforeWrite(draft);
    const out = fn(draft) ?? draft;
    const demoted = demotePhoneHeld(before, out);
    const next = ownedBy(sanitizeSuperState(out, opts), id);
    const mine = { enabled: next.enabled, children: new Set([...armedChildren(next)].map((cid) => cid.toLowerCase())) };
    pendingArm.set(key, mine);
    try {
      await writeSuperState(contextRoot, next, id);
      noteSuperState(contextRoot, next, id);
    } finally {
      if (pendingArm.get(key) === mine) pendingArm.delete(key);
    }
    if (demoted.length) opts.onDemoted?.(demoted);
    return next;
  });
}

/** Main's record, as every caller before Wave 2 writes it ({@link withSuperState} with `main`). */
export function updateSuperState(
  contextRoot: string,
  fn: (draft: SuperState) => SuperState | void,
  opts: UpdateOpts = {},
): Promise<SuperState> {
  return withSuperState(contextRoot, 'main', fn, opts);
}

// ─── The in-memory index (D4b, D16, D17) ─────────────────────────────────────

interface IndexEntry {
  /** The resolved context root and the super this entry is. */
  root: string;
  superId: SuperId;
  session: string | null;
  enabled: boolean;
  children: Set<string>;
  /** The live children `super delegate` started (never the owner's adopted chats). */
  delegated: Set<string>;
  /** Every child `super delegate` started (live or ended), with the MCP servers it runs with. */
  leanMcp: Map<string, string[]>;
  /** Children `super end` closed: a NEW process of one is the owner reopening it. */
  ended: Set<string>;
  notes: Map<string, SuperNote>;
}

/** Keyed by {@link superKey}: main's entry under the resolved root, each member's beside it. */
const index = new Map<string, IndexEntry>();
/** Bumped by every change to a super's entry (a write, a note cleared in memory). A read that
 *  saw a different value when it started is older than the index and is not indexed. */
const generation = new Map<string, number>();

/** Notes delivered and cleared in memory whose persist has not finished: key → session →
 *  the note that was delivered. Until that persist lands, disk still holds the note, so NO
 *  index of the vault — a read, another locked write that loaded it, the boot prime — may put
 *  it back (it would ride a second message, D17). Filtering every path is consistent with disk:
 *  the persist deletes exactly that value, whoever wrote it. */
const clearing = new Map<string, Map<string, SuperNote>>();

function indexState(key: string, state: SuperState): void {
  const pending = clearing.get(key);
  const notes = new Map(Object.entries(state.notes));
  if (pending) for (const [sid, note] of pending) if (notes.get(sid) === note) notes.delete(sid);
  const { root, superId } = parseSuperKey(key);
  index.set(key, {
    root,
    superId,
    session: state.session,
    enabled: state.enabled,
    // An ended child is history, not a child: no events, the notch shows it if reopened.
    children: new Set(Object.keys(state.children).filter((k) => state.children[k].endedAt === undefined)),
    delegated: new Set(Object.keys(state.children).filter((k) => state.children[k].endedAt === undefined && !state.children[k].adopted)),
    leanMcp: new Map(Object.keys(state.children).filter((k) => !state.children[k].adopted).map((k) => [k, state.children[k].mcp ?? []])),
    ended: new Set(Object.keys(state.children).filter((k) => state.children[k].endedAt !== undefined)),
    notes,
  });
}

function bump(key: string): void {
  generation.set(key, (generation.get(key) ?? 0) + 1);
}

/** Make one super's in-memory entry this record — authoritative: the record was just WRITTEN,
 *  so any read still in flight is now older than it. Only for a record already on disk. */
export function noteSuperState(rootOrKey: string, state: SuperState, idIn: SuperId = 'main'): void {
  const { root: contextRoot, superId: id } = splitSuperRoot(rootOrKey, idIn);
  const key = superKey(contextRoot, id);
  bump(key);
  indexState(key, state);
}

/** The member records of a vault on disk (their slugs), sorted; none when the folder is missing,
 *  a link or unreadable (a refused folder is never read). */
export async function listMemberSupers(contextRoot: string): Promise<string[]> {
  const dir = join(contextRoot, MEMBER_SUPER_DIR);
  try {
    for (const rel of [join('state', '.super'), MEMBER_SUPER_DIR]) {
      const st = await fsp.lstat(join(contextRoot, rel));
      if (st.isSymbolicLink() || !st.isDirectory()) return [];
    }
    const names = await fsp.readdir(dir);
    return names.filter((n) => n.endsWith('.json') && !n.endsWith('.read-marks.json'))
      .map((n) => n.slice(0, -'.json'.length)).filter(okMember).sort();
  } catch { return []; }
}

/** At server boot, before the first registry event: load every vault's records, main's and each
 *  member's (`state/.super/members/*.json`), so a member session resolves after a restart. A
 *  refused or unreadable one is indexed as empty (the mode is simply off there). */
export async function primeSuperIndex(contextRoots: readonly string[], opts: SanitizeOpts = {}): Promise<void> {
  const prime = async (root: string, id: SuperId) => {
    const key = superKey(root, id);
    const startedAt = generation.get(key) ?? 0;
    let state: SuperState;
    try { state = await loadSuperState(root, opts, id); } catch { state = ownedBy(emptySuperState(), id); }
    if ((generation.get(key) ?? 0) === startedAt) indexState(key, state);
  };
  await Promise.all(contextRoots.map(async (root) => {
    const members = await listMemberSupers(root);
    await Promise.all([prime(root, 'main'), ...members.map((m) => prime(root, superIdOfMember(m)))]);
  }));
}

/** One super's entry as the index holds it. */
export interface SuperIndexEntry { session: string | null; enabled: boolean; children: ReadonlySet<string> }
const EMPTY_ENTRY = (): SuperIndexEntry => ({ session: null, enabled: false, children: new Set() });

/**
 * Every super of the vault the index knows: main's entry ALWAYS (empty when none), and each
 * member's that has a record. Ordered main first.
 */
export function superIndex(rootOrKey: string): Map<SuperId, SuperIndexEntry> {
  const root = resolve(splitSuperRoot(rootOrKey).root);
  const out = new Map<SuperId, SuperIndexEntry>();
  const main = index.get(root);
  out.set('main', main ? { session: main.session, enabled: main.enabled, children: main.children } : EMPTY_ENTRY());
  for (const e of index.values()) {
    if (e.root !== root || e.superId === 'main') continue;
    out.set(e.superId, { session: e.session, enabled: e.enabled, children: e.children });
  }
  return out;
}

/** One super's entry (main's by default); an empty one when the index has none. */
export function superEntry(rootOrKey: string, idIn: SuperId = 'main'): SuperIndexEntry {
  const { root, superId } = splitSuperRoot(rootOrKey, idIn);
  return superIndex(root).get(superId) ?? EMPTY_ENTRY();
}

/** The key of a super ref (null stays null): what every per-super map of the inbox is keyed by. */
export function keyOfRef(ref: SuperRef | null): string | null {
  return ref ? superKey(ref.root, ref.superId) : null;
}

/** Forget one super's in-memory entry (a member record retired or turned off): its keys die with it. */
export function dropSuperIndex(contextRoot: string, id: SuperId): void {
  if (id === 'main') return;
  const key = superKey(contextRoot, id);
  index.delete(key);
  generation.delete(key);
  clearing.delete(key);
  pendingArm.delete(key);
}

/** Every super ref the index knows of one vault, main first. */
export function supersOf(contextRoot: string): SuperRef[] {
  const root = resolve(splitSuperRoot(contextRoot).root);
  return [...superIndex(root).keys()].map((superId) => ({ root, superId }));
}

/** A super of some vault: its root (resolved) and its id. */
export interface SuperRef { root: string; superId: SuperId }

/** The root of a ref when it is main's, else null (the callers that stay main-only until A2). */
export function mainRootOf(ref: SuperRef | null): string | null {
  return ref && ref.superId === 'main' ? ref.root : null;
}

/** THE resolver of a super's OWN session (handed over or parked): which vault and which super. */
export function superOfSession(sessionId: string): SuperRef | null {
  if (!sessionId) return null;
  for (const e of index.values()) if (e.session === sessionId) return { root: e.root, superId: e.superId };
  return null;
}

/** THE resolver of a recorded LIVE child (handed over or not): the super that owns it. */
export function superOfChild(sessionId: string): SuperRef | null {
  if (!sessionId) return null;
  for (const e of index.values()) if (e.children.has(sessionId)) return { root: e.root, superId: e.superId };
  return null;
}

/** The super whose record names `sessionId` an ENDED child, or null. */
export function superOfEnded(sessionId: string): SuperRef | null {
  if (!sessionId) return null;
  for (const e of index.values()) if (e.ended.has(sessionId)) return { root: e.root, superId: e.superId };
  return null;
}

/** Is `sessionId` some super's recorded session (main's or a member's, handed over or parked)? */
export function isSuperSessionId(sessionId: string): boolean {
  return superOfSession(sessionId) !== null;
}

/** A recorded child of a super that is on RIGHT NOW (D16: the owner is not pinged). */
export function isSuperChild(sessionId: string): boolean {
  for (const e of index.values()) if (e.enabled && e.children.has(sessionId)) return true;
  return false;
}

/**
 * THE gate for "a child while handed over" (any super of any vault, ids compared case-blind): the
 * index (not ended children of an enabled record) OR the write in flight's pending entry. A
 * take-back flips the index only after its commit, so a stale "on" fails closed.
 */
export function isHandedOverChild(sessionId: string): boolean {
  return handedOverChildRoot(sessionId) !== null;
}

/** The super (resolved root and id) whose handed-over record names `sessionId` a child — the
 *  index or the write in flight — or null. Case-blind. */
export function handedOverChildRoot(sessionId: string): SuperRef | null {
  const id = sessionId.toLowerCase();
  if (!id) return null;
  for (const e of index.values()) {
    if (!e.enabled) continue;
    for (const c of e.children) if (c.toLowerCase() === id) return { root: e.root, superId: e.superId };
  }
  for (const [key, p] of pendingArm) if (p.enabled && p.children.has(id)) return parseSuperKey(key);
  return null;
}

/**
 * The MCP servers a child `super delegate` started runs with (orchestration plan r5 D14), from
 * its record: [] = none. Null = not such a child (the owner's adopted chats, a super, any other
 * chat). Handed over or not, live or ended: a delegated child is lean for its whole life,
 * whichever window or reload spawns it (the server decides, never the URL alone). Any super's.
 */
export function delegatedChildMcp(sessionId: string): string[] | null {
  if (!sessionId) return null;
  for (const e of index.values()) { const m = e.leanMcp.get(sessionId); if (m) return [...m]; }
  return null;
}

/** A child `super delegate` started, of a super that is on right now (never an adopted chat of
 *  the owner's): what the done-child park backstop may park (orchestration plan r5 D13). */
export function isDelegatedSuperChild(sessionId: string): boolean {
  for (const e of index.values()) if (e.enabled && e.delegated.has(sessionId)) return true;
  return false;
}

/** The note `sessionId`'s next owner message carries, read from memory (never from disk on the
 *  per-message path, D17). */
export function peekSuperNote(sessionId: string): SuperNote | null {
  for (const e of index.values()) {
    const n = e.notes.get(sessionId);
    if (n) return n;
  }
  return null;
}

/**
 * A note was delivered: forget it in memory at once (so a second message cannot carry it),
 * then persist. Only the note that was DELIVERED is cleared — a different one written
 * meanwhile (Take back while the hand-over note was riding) stays. Main's record (only a
 * hand-over writes notes).
 *
 * Nothing that could still hold the delivered note may index it: a read already in flight sees
 * the generation move, and every index taken before the persist lands (a read, another locked
 * write, the boot prime) is filtered through the `clearing` set.
 */
export async function clearSuperNote(contextRoot: string, sessionId: string, delivered: SuperNote, opts: SanitizeOpts = {}): Promise<void> {
  const key = superKey(contextRoot);
  const notes = index.get(key)?.notes;
  if (notes?.get(sessionId) === delivered) notes.delete(sessionId);
  let pending = clearing.get(key);
  if (!pending) { pending = new Map(); clearing.set(key, pending); }
  pending.set(sessionId, delivered);
  bump(key);
  try {
    await updateSuperState(contextRoot, (s) => { if (s.notes[sessionId] === delivered) delete s.notes[sessionId]; }, opts);
  } finally {
    if (pending.get(sessionId) === delivered) pending.delete(sessionId);
    if (pending.size === 0 && clearing.get(key) === pending) clearing.delete(key);
  }
}

/** Tests only. */
export function resetSuperIndex(): void {
  index.clear();
  generation.clear();
  clearing.clear();
  locks.clear();
  pendingArm.clear();
}
