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
}

export const QUEUE_KINDS = ['permission', 'question', 'idle', 'gone', 'recap', 'handover'] as const;
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
}

export const SUPER_NOTES = ['handover', 'takeback'] as const;
export type SuperNote = typeof SUPER_NOTES[number];

export interface SuperState {
  v: typeof SUPER_STATE_VERSION;
  session: string | null;
  enabled: boolean;
  containers: SuperContainer[];
  view: SuperView;
  children: Record<string, SuperChild>;
  queue: SuperQueueItem[];
  notes: Record<string, SuperNote>;
  away: { since: number | null; events: number };
}

export interface SuperStateView extends SuperState {
  vault: string;
}

export const SUPER_WINDOW_VERBS = ['delegate', 'answer'] as const;
export type SuperWindowVerb = typeof SUPER_WINDOW_VERBS[number];

export const SUPER_EVENT_PREFIXES = ['[super event]', '[super recap]', '[super handover]'] as const;

export const SUPER_EVENT_KINDS = ['question', 'idle', 'gone', 'recap', 'handover'] as const;
export type SuperEventKind = typeof SUPER_EVENT_KINDS[number];

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
  const containers = v.containers.filter((c): c is SuperContainer =>
    isRecord(c) && typeof c.id === 'string' && oneOf(CONTAINER_KINDS, c.kind) && typeof c.ref === 'string'
    && oneOf(CONTAINER_SHAPES, c.shape) && oneOf(CONTAINER_PLACES, c.place)
    && (c.pos === undefined || (isRecord(c.pos) && isUnit(c.pos.x) && isUnit(c.pos.y))));
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
  return {
    v: SUPER_STATE_VERSION,
    vault: v.vault,
    session: v.session,
    enabled: v.enabled,
    containers,
    view,
    children,
    queue,
    notes,
    away: { since: typeof since === 'number' ? since : null, events: typeof v.away.events === 'number' ? v.away.events : 0 },
  };
}
