/**
 * The Super Agent's state as the window sees it (`_meta{subtype:'super_state'}` on the super
 * chat's socket). The server is the only writer; the window renders and never polls.
 *
 * MIRRORED from `src/lib/super/types.ts`, which owns the record and its validation. Change one,
 * change the other; `tests/unit/super-types-mirror.test.ts` pins the lists and limits.
 *
 * Deliberately React-free with no imports, so root vitest can load it beside the server file
 * (the `chatModes.ts` trick).
 */

export const SUPER_STATE_VERSION = 1 as const;

export const CONTAINER_KINDS = ['chat', 'insight', 'task', 'knowledge', 'whiteboard', 'board', 'web', 'image'] as const;
export type ContainerKind = typeof CONTAINER_KINDS[number];

export const CONTAINER_SHAPES = ['square', 'tall'] as const;
export type ContainerShape = typeof CONTAINER_SHAPES[number];

export const CONTAINER_PLACES = ['float', 'others'] as const;
export type ContainerPlace = typeof CONTAINER_PLACES[number];

export const VIEW_MODES = ['float', 'half', 'present'] as const;
export type ViewMode = typeof VIEW_MODES[number];

export const MAX_CONTAINERS = 12;
export const MAX_PRESENT = 4;
export const MAX_LIVE_CHILDREN = 8;

export function defaultShape(kind: ContainerKind): ContainerShape {
  return kind === 'chat' || kind === 'web' ? 'tall' : 'square';
}

export interface SuperContainer {
  id: string;
  kind: ContainerKind;
  ref: string;
  shape: ContainerShape;
  place: ContainerPlace;
  /** Where the owner dropped it, as fractions (0..1) of the stage's free area. */
  pos?: { x: number; y: number };
  title?: string;
}

/**
 * Cards put together, drawn on the stage as ONE tile (owner decision 2026-10-20): the owner
 * drops a card on another (or on a group), the agent runs `super group`. Membership lives here,
 * never on the card: a card is in at most one group, a group holds at least two cards, and it
 * stands in the record where its FIRST card stands (so grouping moves no other card to the other
 * side). Others is not one of these: it is the stage's own group, derived from `place`.
 */
export interface SuperGroup {
  /** `grp-…`: never a container id (those start with their kind). */
  id: string;
  name: string;
  /** Its cards in order; the first one's place in the record is the group's. */
  cards: string[];
  place: ContainerPlace;
  /** The owner's drop, like a card's. */
  pos?: { x: number; y: number };
}

export const GROUP_ID_RE = /^grp-[a-z0-9-]{1,36}$/;
export const MAX_GROUP_NAME = 60;
export const MIN_GROUP_CARDS = 2;

export interface SuperView {
  mode: ViewMode;
  card?: string;
  cards?: string[];
}

export interface SuperChild {
  sessionId: string;
  brief: string;
  adopted: boolean;
  worktree?: string;
  branch?: string;
  startedAt: number;
  /** The job list's row, written by the server from the registry (absent in an older record). */
  row?: ChildRow;
  rowAt?: number;
  /** The 30 s settle window runs ("bitiyor"). */
  settling?: boolean;
  task?: string;
  stuckReason?: StuckReason;
}

export const CHILD_ROWS = ['working', 'asking', 'done', 'stuck', 'gone'] as const;
export type ChildRow = typeof CHILD_ROWS[number];
export const STUCK_REASONS = ['error', 'stale'] as const;
export type StuckReason = typeof STUCK_REASONS[number];

export const QUEUE_KINDS = ['permission', 'question', 'done', 'gone', 'stuck', 'ask', 'recap', 'handover'] as const;
export type QueueKind = typeof QUEUE_KINDS[number];

export const QUEUE_STATES = ['pending', 'delivered', 'escalated', 'done'] as const;
export type QueueState = typeof QUEUE_STATES[number];

export interface SuperQueueItem {
  id: string;
  sessionId: string;
  kind: QueueKind;
  requestId?: string;
  state: QueueState;
  ownerText?: string;
  createdAt: number;
  /** The event turn that carried it (an `ask`: the turn it was asked in). */
  batch?: string;
  /** An `ask`'s answers, validated by the server: drawn whole or not at all. */
  options?: string[];
}

/** A job kept for later (the list's "Havuz"). The prompt never reaches the window. */
export interface SuperPoolItem {
  id: string;
  title: string;
  prompt?: string;
  note?: string;
  task?: string;
  mode?: string;
  held?: boolean;
  maybeStarted?: boolean;
  createdAt: number;
}

export const MAX_ASK_OPTIONS = 4;
export const MAX_ASK_OPTION = 24;
export const DONE_SETTLE_MS = 30_000;
export const MAX_BATCH = 8;

export const SUPER_NOTES = ['handover', 'takeback'] as const;
export type SuperNote = typeof SUPER_NOTES[number];

export interface SuperState {
  v: typeof SUPER_STATE_VERSION;
  session: string | null;
  enabled: boolean;
  containers: SuperContainer[];
  groups: SuperGroup[];
  view: SuperView;
  children: Record<string, SuperChild>;
  queue: SuperQueueItem[];
  notes: Record<string, SuperNote>;
  away: { since: number | null; events: number };
  pool: SuperPoolItem[];
  /** Batch ids of event turns that render in full (the super agent asked the owner). */
  ownerBatches: string[];
}

export interface SuperStateView extends SuperState {
  vault: string;
}

export const SUPER_WINDOW_VERBS = ['delegate', 'answer'] as const;
export type SuperWindowVerb = typeof SUPER_WINDOW_VERBS[number];

export const SUPER_EVENT_PREFIXES = ['[super event]', '[super recap]', '[super handover]', '[super events]'] as const;

export const SUPER_EVENT_KINDS = ['question', 'idle', 'gone', 'recap', 'handover', 'batch'] as const;
export type SuperEventKind = typeof SUPER_EVENT_KINDS[number];

// ─── Groups (MIRRORED from the server, behaviour pinned by super-types-mirror.test.ts) ──

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clampUnit = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined);

/** A group's name as stored: one line, no control characters, at most MAX_GROUP_NAME. */
export function cleanGroupName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME).trim();
}

/** "Group N" with the smallest N no group is named. */
export function nextGroupName(groups: readonly Pick<SuperGroup, 'name'>[], word = 'Group'): string {
  const used = new Set(groups.map((g) => g.name));
  for (let n = 1; ; n++) if (!used.has(`${word} ${n}`)) return `${word} ${n}`;
}

/**
 * The groups a record may hold, against its cards: an id once, a card in one group at most (the
 * first group that names it keeps it), a closed card dropped from its group. A group left with
 * fewer than two cards dissolves; its one remaining card takes the group's place and spot, so
 * the tile the owner was looking at stays where it was. Pure: returns new lists.
 */
export function normalizeGroups(containers: readonly SuperContainer[], raw: unknown): { containers: SuperContainer[]; groups: SuperGroup[] } {
  const out = containers.map((c) => ({ ...c }));
  const byId = new Map(out.map((c) => [c.id, c] as const));
  const taken = new Set<string>();
  const seen = new Set<string>();
  const groups: SuperGroup[] = [];
  for (const g of Array.isArray(raw) ? raw : []) {
    if (!isObj(g) || typeof g.id !== 'string' || !GROUP_ID_RE.test(g.id) || seen.has(g.id)) continue;
    seen.add(g.id);
    const cards: string[] = [];
    for (const id of Array.isArray(g.cards) ? g.cards : []) {
      if (typeof id === 'string' && byId.has(id) && !taken.has(id) && !cards.includes(id)) cards.push(id);
    }
    const place: ContainerPlace = (CONTAINER_PLACES as readonly unknown[]).includes(g.place) ? g.place as ContainerPlace : 'float';
    const px = isObj(g.pos) ? clampUnit(g.pos.x) : undefined;
    const py = isObj(g.pos) ? clampUnit(g.pos.y) : undefined;
    const pos = px !== undefined && py !== undefined ? { x: px, y: py } : undefined;
    if (cards.length < MIN_GROUP_CARDS) {
      const last = cards.length === 1 ? byId.get(cards[0]) : undefined;
      if (last) {
        last.place = place;
        if (pos) last.pos = pos; else delete last.pos;
      }
      continue;
    }
    for (const id of cards) taken.add(id);
    groups.push({ id: g.id, name: cleanGroupName(g.name) || nextGroupName(groups), cards, place, ...(pos ? { pos } : {}) });
  }
  return { containers: out, groups };
}

/** Put cards in a group: `id` names an existing group (they join it; `name` renames it) or a new
 *  one (made of them, standing where its first card stood). A card leaves any other group. */
export interface GroupOp { id: string; cards: readonly string[]; name?: string }

/** A card leaving its group floats again, placed automatically. */
export function leaveGroups(state: { containers: SuperContainer[]; groups: SuperGroup[] }, ids: readonly string[]): void {
  const gone = new Set(ids);
  const left = new Set<string>();
  for (const g of state.groups) {
    for (const c of g.cards) if (gone.has(c)) left.add(c);
    g.cards = g.cards.filter((c) => !gone.has(c));
  }
  for (const c of state.containers) if (left.has(c.id)) { c.place = 'float'; delete c.pos; }
}

/** Apply a GroupOp in place (unknown cards ignored); `normalizeGroups` settles the rest. */
export function applyGroupOp(state: { containers: SuperContainer[]; groups: SuperGroup[] }, op: GroupOp): void {
  if (!GROUP_ID_RE.test(op.id)) return;
  const live = new Set(state.containers.map((c) => c.id));
  const cards = [...new Set(op.cards)].filter((id) => live.has(id));
  const name = cleanGroupName(op.name);
  for (const g of state.groups) if (g.id !== op.id) g.cards = g.cards.filter((c) => !cards.includes(c));
  const have = state.groups.find((g) => g.id === op.id);
  if (have) {
    for (const id of cards) if (!have.cards.includes(id)) have.cards.push(id);
    if (name) have.name = name;
    return;
  }
  if (!cards.length) return;
  const first = state.containers.find((c) => c.id === cards[0]);
  state.groups.push({
    id: op.id, name: name || nextGroupName(state.groups), cards,
    place: first?.place ?? 'float', ...(first?.pos ? { pos: { ...first.pos } } : {}),
  });
}

/** Dissolve groups: their cards take the group's place, the first one its spot too. */
export function dissolveGroups(state: { containers: SuperContainer[]; groups: SuperGroup[] }, ids: readonly string[]): void {
  for (const g of state.groups.filter((x) => ids.includes(x.id))) {
    g.cards.forEach((id, i) => {
      const c = state.containers.find((k) => k.id === id);
      if (!c) return;
      c.place = g.place;
      if (i === 0 && g.pos) c.pos = { ...g.pos }; else delete c.pos;
    });
  }
  state.groups = state.groups.filter((g) => !ids.includes(g.id));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** A pushed view, or `float` when it names no card this state holds. */
function readView(v: unknown, ids: ReadonlySet<string>): SuperView {
  if (!isRecord(v) || !oneOf(VIEW_MODES, v.mode)) return { mode: 'float' };
  if (v.mode === 'half') return typeof v.card === 'string' && ids.has(v.card) ? { mode: 'half', card: v.card } : { mode: 'float' };
  if (v.mode === 'present') {
    const cards = Array.isArray(v.cards) ? v.cards.filter((x): x is string => typeof x === 'string' && ids.has(x)).slice(0, MAX_PRESENT) : [];
    return cards.length ? { mode: 'present', cards } : { mode: 'float' };
  }
  return { mode: 'float' };
}

/**
 * Read a pushed `super_state` payload, or null when it is not one. The server already
 * validated it; this keeps a malformed frame from reaching a render as half a state.
 */
export function readSuperStateView(v: unknown): SuperStateView | null {
  if (!isRecord(v) || v.v !== SUPER_STATE_VERSION || typeof v.vault !== 'string') return null;
  if (typeof v.enabled !== 'boolean' || !(v.session === null || typeof v.session === 'string')) return null;
  if (!Array.isArray(v.containers) || !Array.isArray(v.queue) || !isRecord(v.children) || !isRecord(v.notes) || !isRecord(v.away)) return null;
  const rows = v.containers.filter((c): c is SuperContainer =>
    isRecord(c) && typeof c.id === 'string' && oneOf(CONTAINER_KINDS, c.kind) && typeof c.ref === 'string'
    && oneOf(CONTAINER_SHAPES, c.shape) && oneOf(CONTAINER_PLACES, c.place)
    && (c.pos === undefined || (isRecord(c.pos) && isUnit(c.pos.x) && isUnit(c.pos.y))));
  // The server already settled them; read the same way, a row dropped above leaves its group.
  const { containers, groups } = normalizeGroups(rows, v.groups);
  const view = readView(v.view, new Set(containers.map((c) => c.id)));
  const queue = v.queue.filter((q): q is SuperQueueItem =>
    isRecord(q) && typeof q.id === 'string' && typeof q.sessionId === 'string' && oneOf(QUEUE_KINDS, q.kind)
    && oneOf(QUEUE_STATES, q.state) && typeof q.createdAt === 'number');
  const children: Record<string, SuperChild> = {};
  for (const [k, c] of Object.entries(v.children)) {
    if (isRecord(c) && c.sessionId === k && typeof c.brief === 'string' && typeof c.adopted === 'boolean' && typeof c.startedAt === 'number') {
      children[k] = c as unknown as SuperChild;
    }
  }
  const notes: Record<string, SuperNote> = {};
  for (const [k, n] of Object.entries(v.notes)) if (oneOf(SUPER_NOTES, n)) notes[k] = n;
  const since = v.away.since;
  // Absent in a push from an older server: no pool, nothing renders in full.
  const pool = Array.isArray(v.pool) ? v.pool.filter((p): p is SuperPoolItem =>
    isRecord(p) && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.createdAt === 'number') : [];
  const ownerBatches = Array.isArray(v.ownerBatches) ? v.ownerBatches.filter((b): b is string => typeof b === 'string') : [];
  return {
    v: SUPER_STATE_VERSION,
    vault: v.vault,
    session: v.session,
    enabled: v.enabled,
    containers,
    groups,
    view,
    children,
    queue,
    notes,
    away: { since: typeof since === 'number' ? since : null, events: typeof v.away.events === 'number' ? v.away.events : 0 },
    pool,
    ownerBatches,
  };
}
