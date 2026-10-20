import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  CONTAINER_ID_RE, CONTAINER_KINDS, CONTAINER_PLACES, CONTAINER_SHAPES, MAX_BRIEF, MAX_CONTAINERS, MAX_PRESENT,
  MAX_OWNER_TEXT, MAX_QUEUE, MAX_REF, MAX_TITLE, QUEUE_ID_RE, QUEUE_KINDS, QUEUE_STATES, VIEW_MODES, defaultShape,
  SESSION_ID_RE, SUPER_BRANCH_RE, SUPER_NOTES, SUPER_STATE_VERSION, emptySuperState, normalizeGroups,
  type SuperChild, type SuperContainer, type SuperNote, type SuperQueueItem, type SuperState, type SuperView,
} from './types.js';

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
const MAX_FILE_BYTES = 2 * 1024 * 1024;

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
function sanitizeContainers(raw: unknown): SuperContainer[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperContainer[] = [];
  const ids = new Set<string>();
  for (const c of raw) {
    if (out.length >= MAX_CONTAINERS) break;
    if (!isRecord(c)) continue;
    if (typeof c.id !== 'string' || !CONTAINER_ID_RE.test(c.id) || ids.has(c.id)) continue;
    if (!oneOf(CONTAINER_KINDS, c.kind)) continue;
    if (typeof c.ref !== 'string' || !c.ref || c.ref.length > MAX_REF || /[\u0000-\u001f\u007f]/.test(c.ref)) continue;
    const title = cap(c.title, MAX_TITLE);
    const pos = isRecord(c.pos) ? { x: unit(c.pos.x), y: unit(c.pos.y) } : null;
    ids.add(c.id);
    out.push({
      id: c.id, kind: c.kind, ref: c.ref,
      shape: oneOf(CONTAINER_SHAPES, c.shape) ? c.shape : defaultShape(c.kind),
      place: oneOf(CONTAINER_PLACES, c.place) ? c.place : 'float',
      ...(pos && pos.x !== undefined && pos.y !== undefined ? { pos: { x: pos.x, y: pos.y } } : {}),
      ...(title ? { title: stripControls(title) } : {}),
    });
  }
  return out;
}

/**
 * The stage's arrangement (plan-r8 F1): it may only name cards the record holds. A half page
 * naming a closed card, or a presentation left with none, is the floating stage again.
 */
export function sanitizeView(raw: unknown, containers: readonly SuperContainer[]): SuperView {
  if (!isRecord(raw) || !oneOf(VIEW_MODES, raw.mode)) return { mode: 'float' };
  const ids = new Set(containers.map((c) => c.id));
  if (raw.mode === 'half') {
    return typeof raw.card === 'string' && ids.has(raw.card) ? { mode: 'half', card: raw.card } : { mode: 'float' };
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
    // A worktree and its branch travel together; either one hostile drops both.
    if (c.worktree !== undefined || c.branch !== undefined) {
      if (acceptableWorktree(c.worktree, opts) && typeof c.branch === 'string' && SUPER_BRANCH_RE.test(c.branch)) {
        child.worktree = c.worktree;
        child.branch = c.branch;
      }
    }
    out[key] = child;
  }
  return out;
}

function sanitizeQueue(raw: unknown): SuperQueueItem[] {
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
    const requestId = typeof q.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(q.requestId) ? q.requestId : undefined;
    // A permission is rendered only from the child's own tool name and input (D7): the super
    // agent's words never caption one, so none survive on a permission item.
    const ownerText = q.kind === 'permission' ? undefined : cap(q.ownerText, MAX_OWNER_TEXT);
    ids.add(q.id);
    out.push({
      id: q.id, sessionId: q.sessionId, kind: q.kind, state: q.state, createdAt,
      ...(requestId ? { requestId } : {}),
      ...(ownerText ? { ownerText } : {}),
      // How many delivered turns ended with the item unsettled (wave 2, M1).
      ...(typeof q.attempts === 'number' && Number.isInteger(q.attempts) && q.attempts > 0 ? { attempts: Math.min(q.attempts, 9) } : {}),
    });
  }
  // Over the cap: the oldest finished items go first, then the oldest of the rest.
  while (out.length > MAX_QUEUE) {
    const done = out.findIndex((q) => q.state === 'done');
    out.splice(done >= 0 ? done : 0, 1);
  }
  return out;
}

/** A record read from disk (or built by a caller), with everything hostile dropped. */
export function sanitizeSuperState(raw: unknown, opts: SanitizeOpts = {}): SuperState {
  const base = emptySuperState();
  if (!isRecord(raw) || raw.v !== SUPER_STATE_VERSION) return base;
  const session = typeof raw.session === 'string' && okSessionId(raw.session) ? raw.session : null;
  const children = sanitizeChildren(raw.children, session, opts);
  // Groups settle against the cards (a closed card leaves its group, a group of one dissolves
  // into its card), so they come back with the cards they may have changed.
  const { containers, groups } = normalizeGroups(sanitizeContainers(raw.containers), raw.groups);
  const notes: Record<string, SuperNote> = {};
  if (isRecord(raw.notes)) {
    for (const [k, n] of Object.entries(raw.notes)) {
      if (okSessionId(k) && k !== session && oneOf(SUPER_NOTES, n)) notes[k] = n;
    }
  }
  const away = isRecord(raw.away) ? raw.away : {};
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
    queue: sanitizeQueue(raw.queue),
    notes,
    away: { since: since ?? null, events: events !== undefined && events > 0 ? Math.floor(events) : 0 },
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
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
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
    children: new Set(Object.keys(state.children)),
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

/** The context root that has `sessionId` as a recorded child (handed over or not), or null. */
export function superRootOfChild(sessionId: string): string | null {
  for (const [root, e] of index) if (e.children.has(sessionId)) return root;
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
