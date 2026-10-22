import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  AGENDA_REF, MAX_PAD, PAD_ID_RE, PAD_SECTIONS, cleanPadText, CHILD_ROWS, CONTAINER_ID_RE, CONTAINER_KINDS, CONTAINER_PLACES, CONTAINER_SHAPES, MAX_BRIEF, MAX_WAIT_KEY, MAX_CONTAINERS, MAX_DISMISSED, MAX_ENDED_CHILDREN,
  MAX_PRESENT, MAX_OWNER_BATCHES, MAX_OWNER_TEXT, MAX_POOL, MAX_POOL_BYTES, MAX_POOL_PROMPT, MAX_QUEUE, MAX_REF, MAX_TEAM_JOBS, MAX_TITLE,
  CONTAINER_SIZES, POOL_ID_RE, QUEUE_ID_RE, QUEUE_KINDS, QUEUE_STATES, STUCK_REASONS, TASK_SLUG_RE, TEAM_JOB_ID_RE, VIEW_MODES, askLine, cleanAskOptions, cleanAskSpec, defaultShape, MAX_HELD,
  SESSION_ID_RE, SUPER_BRANCH_RE, SUPER_NOTES, SUPER_STATE_VERSION, emptySuperState, normalizeGroups,
  type SuperChild, type SuperContainer, type SuperPadItem, type SuperDismissed, type SuperNote, type SuperPoolItem, type SuperQueueItem, type SuperState, type SuperTeamJob, type SuperView, type SuperHeldEvent,
} from './types.js';
import { parseJob, promptHash } from './jobs.js';
import { OWNER_WAIT_KINDS, type OwnerWaitKind } from './owner-wait.js';
import { parseMcpNames } from './lean-mcp.js';
import { isSafeAutomationSlug } from '../agents/slot.js';

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
      place: oneOf(CONTAINER_PLACES, c.place) ? c.place : 'float',
      ...(pos && pos.x !== undefined && pos.y !== undefined ? { pos: { x: pos.x, y: pos.y } } : {}),
      ...(title ? { title: stripControls(title) } : {}),
      ...(c.by === 'auto' ? { by: 'auto' as const } : {}),
      ...(c.by === 'auto' && typeof c.of === 'string' && Object.prototype.hasOwnProperty.call(children, c.of) ? { of: c.of } : {}),
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
    return raw.auto === true ? { mode: 'half', card: raw.card, auto: true } : { mode: 'half', card: raw.card };
  }
  if (raw.mode === 'present') {
    const cards: string[] = [];
    for (const x of Array.isArray(raw.cards) ? raw.cards : []) {
      if (typeof x === 'string' && ids.has(x) && !cards.includes(x)) cards.push(x);
      if (cards.length >= MAX_PRESENT) break;
    }
    return cards.length ? { mode: 'present', cards } : { mode: 'float' };
  }
  return { mode: 'float' };
}

function sanitizeChildren(raw: unknown, session: string | null, opts: SanitizeOpts): Record<string, SuperChild> {
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
    if (c.awaited === true) child.awaited = true;
    // The agenda's two stamps (epoch ms): a non-finite or negative value is dropped.
    for (const k of ['finishedAt', 'seenAt'] as const) {
      const v = finite(c[k]);
      // A "seen" from the future would hide every later finish: never past now (as the route clamps).
      if (v !== undefined && v >= 0) child[k] = k === 'seenAt' ? Math.min(v, Date.now()) : v;
    }
    out[key] = child;
  }
  // Ended children are history: only the newest MAX_ENDED_CHILDREN stay in the record. One that
  // still owns a worktree always stays (`super merge` and `worktree remove` reach it by child).
  const ended = Object.values(out).filter((c) => c.endedAt !== undefined && !c.worktree).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const c of ended.slice(MAX_ENDED_CHILDREN)) delete out[c.sessionId];
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
    // agent's words never caption one, so none survive on a permission item.
    // An approval item exists only for its member; one naming none (or a hostile one) is dropped.
    const member = q.kind === 'approval' && typeof q.member === 'string' && okMember(q.member) ? q.member : undefined;
    if (q.kind === 'approval' && !member) continue;
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
    const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, 9) : 0);
    ids.add(q.id);
    out.push({
      id: q.id, sessionId: q.sessionId, kind: q.kind, state: q.state, createdAt,
      ...(member ? { member } : {}),
      ...(wait ? { wait } : {}),
      ...(requestId ? { requestId } : {}),
      ...(ownerText ? { ownerText } : {}),
      ...(q.kind === 'ended' && typeof q.brief === 'string' ? { brief: stripControls(cap(q.brief, MAX_BRIEF) ?? '') } : {}),
      // How many delivered turns ended with the item unsettled (wave 2, M1), and how many process
      // exits ended a turn that carried it (plan r4 D10).
      ...(count(q.attempts) ? { attempts: count(q.attempts) } : {}),
      ...(count(q.exits) ? { exits: count(q.exits) } : {}),
      ...(batch ? { batch } : {}),
      ...(options.length ? { options } : {}),
      ...(askSpec && askSpec.ok ? { ask: askSpec.spec } : {}),
    });
  }
  // Over the cap: the oldest finished items go first, then the oldest of the rest.
  while (out.length > MAX_QUEUE) {
    const done = out.findIndex((q) => q.state === 'done');
    out.splice(done >= 0 ? done : 0, 1);
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
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_TEAM_JOBS);
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
    out.push({ id: p.id, section: p.section, text, at });
  }
  return out;
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
export function sanitizeSuperState(raw: unknown, opts: SanitizeOpts = {}): SuperState {
  const base = emptySuperState();
  if (!isRecord(raw) || raw.v !== SUPER_STATE_VERSION) return base;
  const session = typeof raw.session === 'string' && okSessionId(raw.session) ? raw.session : null;
  const children = sanitizeChildren(raw.children, session, opts);
  // Groups settle against the cards (a closed card leaves its group, a group of one dissolves
  // into its card), so they come back with the cards they may have changed.
  // A team card shows a recorded job: one whose job fell off the record goes with it.
  const team = sanitizeTeam(raw.team);
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
  const rawSeq = finite(raw.padSeq);
  const padSeq = rawSeq !== undefined && rawSeq > 0 && rawSeq < 1e6 ? Math.floor(rawSeq) : 0;
  const since = finite(away.since);
  const events = finite(away.events);
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
    ownerBatches: sanitizeOwnerBatches(raw.ownerBatches),
    team,
    ...(held.length ? { held } : {}),
    ...(pad.length ? { pad } : {}),
    ...(padSeq ? { padSeq } : {}),
  };
}

// ─── Containment ────────────────────────────────────────────────────────────────

/** Refuse a symlinked state file, or a `state/` directory that resolves outside the vault. */
async function assertContained(contextRoot: string): Promise<string> {
  const path = superStatePath(contextRoot);
  const stateDir = dirname(path);
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = await fsp.realpath(contextRoot);
    realDir = await fsp.realpath(stateDir);
  } catch {
    throw new SuperStoreRefused('outside', 'the vault has no state directory');
  }
  if (realDir !== join(realRoot, 'state')) throw new SuperStoreRefused('outside', 'state/ resolves outside the vault');
  try {
    const st = await fsp.lstat(path);
    if (st.isSymbolicLink()) throw new SuperStoreRefused('symlink', '.super-agent.json is a symlink; refusing it');
    if (!st.isFile()) throw new SuperStoreRefused('symlink', '.super-agent.json is not a file; refusing it');
    if (st.size > MAX_FILE_BYTES) throw new SuperStoreRefused('too_large', '.super-agent.json is too large');
  } catch (err) {
    if (err instanceof SuperStoreRefused) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return path;
}

/** The record on disk, sanitized, with no effect on the index. */
async function loadSuperState(contextRoot: string, opts: SanitizeOpts): Promise<SuperState> {
  const path = await assertContained(contextRoot);
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptySuperState();
    throw err;
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return sanitizeSuperState(parsed, opts);
}

/**
 * The vault's record, sanitized. Absent → an empty state. A symlinked file → SuperStoreRefused.
 *
 * A read takes no lock, so it can START before a write and FINISH after it holding the old
 * record. It refreshes the in-memory index only when nothing changed the vault's entry while
 * it ran ({@link generation}): otherwise a slow `super state` racing the owner's Take back
 * would put `enabled: true` back in memory (children hidden from the notch again), or put a
 * cleared note back (a second message would carry it).
 */
export async function readSuperState(contextRoot: string, opts: SanitizeOpts = {}): Promise<SuperState> {
  const key = resolve(contextRoot);
  const startedAt = generation.get(key) ?? 0;
  const state = await loadSuperState(contextRoot, opts);
  if ((generation.get(key) ?? 0) === startedAt) indexState(key, state);
  return state;
}

async function writeSuperState(contextRoot: string, state: SuperState): Promise<void> {
  const path = await assertContained(contextRoot);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  // Measured in UTF-8 bytes, as the read's `st.size` is: never write what the read refuses.
  if (Buffer.byteLength(text, 'utf-8') > MAX_FILE_BYTES) throw new SuperStoreRefused('too_large', 'this change would make .super-agent.json too large; nothing was written');
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, text, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  try {
    await fsp.rename(tmp, path);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => { /* already gone */ });
    throw err;
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` under the vault's lock. */
function withVaultLock<T>(contextRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(contextRoot);
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  locks.set(key, settled);
  void settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return run;
}

/**
 * Read, change, sanitize and write the vault's record as one step. `fn` mutates the draft (or
 * returns a replacement); what it produces is sanitized again before it is written, so no
 * caller can persist a field a read would drop. Returns what was written.
 */
export function updateSuperState(
  contextRoot: string,
  fn: (draft: SuperState) => SuperState | void,
  opts: SanitizeOpts = {},
): Promise<SuperState> {
  return withVaultLock(contextRoot, async () => {
    const draft = await loadSuperState(contextRoot, opts);
    const next = sanitizeSuperState(fn(draft) ?? draft, opts);
    await writeSuperState(contextRoot, next);
    noteSuperState(contextRoot, next);
    return next;
  });
}

// ─── The in-memory index (D4b, D16, D17) ─────────────────────────────────────

interface IndexEntry {
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

const index = new Map<string, IndexEntry>();
/** Bumped by every change to a vault's entry (a write, a note cleared in memory). A read that
 *  saw a different value when it started is older than the index and is not indexed. */
const generation = new Map<string, number>();

/** Notes delivered and cleared in memory whose persist has not finished: vault → session →
 *  the note that was delivered. Until that persist lands, disk still holds the note, so NO
 *  index of the vault — a read, another locked write that loaded it, the boot prime — may put
 *  it back (it would ride a second message, D17). Filtering every path is consistent with disk:
 *  the persist deletes exactly that value, whoever wrote it. */
const clearing = new Map<string, Map<string, SuperNote>>();

function indexState(key: string, state: SuperState): void {
  const pending = clearing.get(key);
  const notes = new Map(Object.entries(state.notes));
  if (pending) for (const [sid, note] of pending) if (notes.get(sid) === note) notes.delete(sid);
  index.set(key, {
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

/** Make the vault's in-memory entry this record — authoritative: the record was just WRITTEN,
 *  so any read still in flight is now older than it. Only for a record already on disk. */
export function noteSuperState(contextRoot: string, state: SuperState): void {
  const key = resolve(contextRoot);
  bump(key);
  indexState(key, state);
}

/** At server boot, before the first registry event: load every vault's record. A refused or
 *  unreadable one is indexed as empty (the mode is simply off there). */
export async function primeSuperIndex(contextRoots: readonly string[], opts: SanitizeOpts = {}): Promise<void> {
  await Promise.all(contextRoots.map(async (root) => {
    const key = resolve(root);
    const startedAt = generation.get(key) ?? 0;
    let state: SuperState;
    try { state = await loadSuperState(root, opts); } catch { state = emptySuperState(); }
    if ((generation.get(key) ?? 0) === startedAt) indexState(key, state);
  }));
}

/** The vault's entry: its super session, whether it is handed over, its children. */
export function superIndex(contextRoot: string): { session: string | null; enabled: boolean; children: ReadonlySet<string> } {
  const e = index.get(resolve(contextRoot));
  return e ? { session: e.session, enabled: e.enabled, children: e.children } : { session: null, enabled: false, children: new Set() };
}

/** Is `sessionId` some vault's recorded super session (handed over or parked)? */
export function isSuperSessionId(sessionId: string): boolean {
  for (const e of index.values()) if (e.session === sessionId) return true;
  return false;
}

/** The context root whose recorded super session `sessionId` is, or null. */
export function superRootOfSession(sessionId: string): string | null {
  for (const [root, e] of index) if (e.session === sessionId) return root;
  return null;
}

/** A recorded child of a vault that is handed over RIGHT NOW (D16: the owner is not pinged). */
export function isSuperChild(sessionId: string): boolean {
  for (const e of index.values()) if (e.enabled && e.children.has(sessionId)) return true;
  return false;
}

/**
 * The MCP servers a child `super delegate` started runs with (orchestration plan r5 D14), from
 * its record: [] = none. Null = not such a child (the owner's adopted chats, the super, any
 * other chat). Handed over or not, live or ended: a delegated child is lean for its whole life,
 * whichever window or reload spawns it (the server decides, never the URL alone).
 */
export function delegatedChildMcp(sessionId: string): string[] | null {
  if (!sessionId) return null;
  for (const e of index.values()) { const m = e.leanMcp.get(sessionId); if (m) return [...m]; }
  return null;
}

/** A child `super delegate` started, of a vault handed over right now (never an adopted chat
 *  of the owner's): what the done-child park backstop may park (orchestration plan r5 D13). */
export function isDelegatedSuperChild(sessionId: string): boolean {
  for (const e of index.values()) if (e.enabled && e.delegated.has(sessionId)) return true;
  return false;
}

/** The context root that has `sessionId` as a recorded child (handed over or not), or null. */
export function superRootOfChild(sessionId: string): string | null {
  for (const [root, e] of index) if (e.children.has(sessionId)) return root;
  return null;
}

/** The vault whose record names `sessionId` an ENDED child, or null. */
export function superRootOfEnded(sessionId: string): string | null {
  for (const [root, e] of index) if (e.ended.has(sessionId)) return root;
  return null;
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
 * meanwhile (Take back while the hand-over note was riding) stays.
 *
 * Nothing that could still hold the delivered note may index it: a read already in flight sees
 * the generation move, and every index taken before the persist lands (a read, another locked
 * write, the boot prime) is filtered through the `clearing` set.
 */
export async function clearSuperNote(contextRoot: string, sessionId: string, delivered: SuperNote, opts: SanitizeOpts = {}): Promise<void> {
  const key = resolve(contextRoot);
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
}
