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

export const CONTAINER_KINDS = ['chat', 'insight', 'task', 'knowledge', 'whiteboard', 'board', 'web', 'image', 'browser', 'team', 'agenda'] as const;
export type ContainerKind = typeof CONTAINER_KINDS[number];

/** The agenda card's one ref (one agenda per stage) and the size it opens at. */
export const AGENDA_REF = 'agenda';
export const AGENDA_SIZE: ContainerSize = 'large';

export const CONTAINER_SHAPES = ['square', 'tall'] as const;
export type ContainerShape = typeof CONTAINER_SHAPES[number];

/** A floating card's size preset in tile units, wide by tall; absent = small. */
export const CONTAINER_SIZES = ['small', 'medium', 'large', 'wide'] as const;
export type ContainerSize = typeof CONTAINER_SIZES[number];
export const SIZE_UNITS: Readonly<Record<ContainerSize, { w: number; h: number }>> = {
  small: { w: 1, h: 1 }, medium: { w: 2, h: 1 }, large: { w: 2, h: 2 }, wide: { w: 3, h: 2 },
};

export const CONTAINER_PLACES = ['float', 'others'] as const;
export type ContainerPlace = typeof CONTAINER_PLACES[number];

export const VIEW_MODES = ['float', 'half', 'present'] as const;
export type ViewMode = typeof VIEW_MODES[number];

export const MAX_CONTAINERS = 48;
export const MAX_FLOAT = 12;
export const MAX_PRESENT = 4;
export const MAX_LIVE_CHILDREN = 15;

export function defaultShape(kind: ContainerKind): ContainerShape {
  return kind === 'chat' || kind === 'web' ? 'tall' : 'square';
}

export interface SuperContainer {
  id: string;
  kind: ContainerKind;
  ref: string;
  shape: ContainerShape;
  /** The size preset it floats at (absent = small). */
  size?: ContainerSize;
  /** The owner chose the size: an agent verb never changes it. */
  sizeBy?: 'owner';
  place: ContainerPlace;
  /** Where the owner dropped it, as fractions (0..1) of the stage's free area. */
  pos?: { x: number; y: number };
  title?: string;
  /** Opened by the server itself, not by a verb (a child's dev-server pin, its live browser). */
  by?: 'auto';
  /** The child an automatic card belongs to. */
  of?: string;
  /** A picture shown for this child's job: it goes to Others once the job moves on. */
  forChild?: string;
  forAt?: number;
}

export interface SuperDismissed { kind: ContainerKind; ref: string; until: number }
export const MAX_DISMISSED = 50;

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
  /** `half` only: the server put this page side by side on its own; the stage waits to show it
   *  while the owner types or drags (useStageCues). */
  auto?: true;
}

/**
 * The view once these cards leave it (owner 2026-10-22: "Move to Others on a presented card did
 * not leave the presentation"): a card the owner or the agent moves to Others, closes, groups or
 * resizes is no longer shown. A half page on one floats again; a presentation goes on with the
 * cards it has left, and floats once it has none.
 */
export function viewWithout(view: SuperView, ids: ReadonlySet<string>): SuperView {
  if (!ids.size) return view;
  if (view.mode === 'half') return view.card && ids.has(view.card) ? { mode: 'float' } : view;
  if (view.mode === 'present') {
    const cards = (view.cards ?? []).filter((id) => !ids.has(id));
    if (!cards.length) return { mode: 'float' };
    return cards.length === (view.cards ?? []).length ? view : { mode: 'present', cards };
  }
  return view;
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
  mode?: string;
  model?: string;
  effort?: string;
  /** The MCP servers it runs with (`delegate --mcp`): a delegated child is LEAN, only these. */
  mcp?: string[];
  /** `super end` closed it: no process, tab or card; `super resume` clears it. */
  endedAt?: number;
  /** The agenda (server-written): when its job last finished, and what the owner saw. */
  finishedAt?: number;
  seenAt?: number;
}

/** `waiting`: its turn ended on something only the owner can do (an `owner` item is open). */
export const CHILD_ROWS = ['working', 'asking', 'done', 'stuck', 'gone', 'waiting'] as const;
export type ChildRow = typeof CHILD_ROWS[number];
export const STUCK_REASONS = ['error', 'stale'] as const;
export type StuckReason = typeof STUCK_REASONS[number];

/** `approval`: an AI Team member the Super Agent chose is not approved here (server-written). */
/** `owner`: a child left something only the owner can do (a `run` card, a `secret`, a
 *  `checklist`): his from birth, closed when his answer reaches the child. */
export const QUEUE_KINDS = ['permission', 'question', 'done', 'gone', 'stuck', 'ask', 'recap', 'handover', 'ended', 'approval', 'fresh', 'owner'] as const;
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
  /** An `ask` in AskUserQuestion's own shape (server `cleanAskSpec`): drawn with the same card a
   *  normal agent's question gets. An older record has only `ownerText`/`options`. */
  ask?: SuperAskSpec;
  /** An `ended` item's last brief of the child. */
  brief?: string;
  /** An `approval` item's AI Team member (agent slug). */
  member?: string;
  /** An `owner` item's wait: the child's card he must act on. */
  wait?: { kind: OwnerWaitKind; id: string };
}

/** What an `owner` item waits on (MIRROR of src/lib/super/owner-wait.ts `OWNER_WAIT_KINDS`). */
export const OWNER_WAIT_KINDS = ['run', 'secret', 'checklist'] as const;
export type OwnerWaitKind = typeof OWNER_WAIT_KINDS[number];

/** `super ask` in AskUserQuestion's shape (MIRROR of src/lib/super/types.ts). */
export interface SuperAskOption { label: string; description?: string; preview?: string }
export interface SuperAskQuestion { question: string; header?: string; description?: string; multiSelect?: boolean; options: SuperAskOption[] }
export interface SuperAskSpec { title?: string; questions: SuperAskQuestion[]; source?: string }

/** One event that arrived while a question was open with the owner, held for the super agent
 *  and told with his answer (MIRROR of src/lib/super/types.ts `SuperHeldEvent`). The ajanda's
 *  "while you were asked" reads these from the record. */
export interface SuperHeldEvent { item: string; child: string; kind: 'question' | 'done' | 'stuck' | 'gone' | 'owner'; at: number }

/** A job the Super Agent gave an AI Team member (`super team ask`); status is read from its thread. */
export interface SuperTeamJob {
  id: string;
  member: string;
  runId: string;
  entryId?: string;
  jobKind: 'run' | 'reply';
  jobId?: string;
  queued: boolean;
  brief: string;
  startedAt: number;
  outcome?: 'done' | 'failed';
  deliveredAt?: number;
  endedAt?: number;
}

export const TEAM_JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type TeamJobStatus = typeof TEAM_JOB_STATUSES[number];
export const MAX_TEAM_JOBS = 30;
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
  dismissed: SuperDismissed[];
  pool: SuperPoolItem[];
  /** Batch ids of event turns that render in full (the super agent asked the owner). */
  ownerBatches: string[];
  /** Jobs given to AI Team members, newest first. */
  team: SuperTeamJob[];
  /** What piled up while the owner had a question open (absent = none). */
  held?: SuperHeldEvent[];
  /** The owner's agenda: the super agent's own notepad (`super note`), oldest first. */
  pad?: SuperPadItem[];
  padSeq?: number;
}

/** The agenda notepad (owner 2026-10-22 19:15): lines the super agent writes itself, in three
 *  sections. Not a mirror of its children. */
export const PAD_SECTIONS = ['now', 'waiting', 'done'] as const;
export type PadSection = typeof PAD_SECTIONS[number];
export interface SuperPadItem { id: string; section: PadSection; text: string; at: number }
export const MAX_PAD = 40;
export const MAX_PAD_TEXT = 160;

export interface SuperStateView extends SuperState {
  vault: string;
  /** Each AI Team job on the stage (a `team` card): its status and last line, read now from the
   *  member's thread. Absent when no team card is open. */
  teamLive?: Record<string, { status: TeamJobStatus; lastLine: string }>;
  /** Queue items whose banner the server posted (lib/super/owner-question.ts): the job bar posts
   *  no second one. Absent: none. */
  bannered?: string[];
  /** The super's pane is rotating into a fresh session ("New session"). Absent: false. */
  rotating?: boolean;
}

export const SUPER_WINDOW_VERBS = ['delegate', 'answer', 'resume'] as const;
export type SuperWindowVerb = typeof SUPER_WINDOW_VERBS[number];

export const SUPER_EVENT_PREFIXES = ['[super event]', '[super recap]', '[super handover]', '[super events]', '[super fresh]'] as const;

export const SUPER_EVENT_KINDS = ['question', 'idle', 'gone', 'recap', 'handover', 'batch', 'fresh'] as const;
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
  if (v.mode === 'half') {
    if (typeof v.card !== 'string' || !ids.has(v.card)) return { mode: 'float' };
    return v.auto === true ? { mode: 'half', card: v.card, auto: true } : { mode: 'half', card: v.card };
  }
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
  const team = (Array.isArray(v.team) ? v.team : []).filter((j): j is SuperTeamJob =>
    isRecord(j) && typeof j.id === 'string' && typeof j.member === 'string' && typeof j.runId === 'string'
    && typeof j.brief === 'string' && typeof j.startedAt === 'number' && typeof j.queued === 'boolean'
    && (j.jobKind === 'run' || j.jobKind === 'reply'));
  // Each team card's status now: only a known job, a known status and a string line survive.
  let teamLive: SuperStateView['teamLive'];
  if (isRecord(v.teamLive)) {
    teamLive = {};
    for (const j of team) {
      const row = (v.teamLive as Record<string, unknown>)[j.id];
      if (isRecord(row) && oneOf(TEAM_JOB_STATUSES, row.status) && typeof row.lastLine === 'string') teamLive[j.id] = { status: row.status, lastLine: row.lastLine };
    }
  }
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
  const held = Array.isArray(v.held) ? v.held.filter((h): h is SuperHeldEvent => isRecord(h) && typeof h.item === 'string'
    && typeof h.child === 'string' && typeof h.at === 'number' && (h.kind === 'question' || h.kind === 'done' || h.kind === 'stuck' || h.kind === 'gone')) : [];
  // The agenda notepad: a known section, a string line, a number time (absent in an older push).
  const pad = Array.isArray(v.pad) ? v.pad.filter((p): p is SuperPadItem => isRecord(p) && typeof p.id === 'string'
    && oneOf(PAD_SECTIONS, p.section) && typeof p.text === 'string' && p.text !== '' && typeof p.at === 'number') : [];
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
    dismissed: Array.isArray(v.dismissed)
      ? v.dismissed.filter((d): d is SuperDismissed => isRecord(d) && oneOf(CONTAINER_KINDS, d.kind) && typeof d.ref === 'string' && typeof d.until === 'number')
      : [],
    pool,
    ownerBatches,
    ...(held.length ? { held } : {}),
    ...(pad.length ? { pad } : {}),
    team,
    ...(teamLive ? { teamLive } : {}),
    ...(Array.isArray(v.bannered) ? { bannered: v.bannered.filter((b): b is string => typeof b === 'string') } : {}),
    // The pane is rotating into a fresh session ("New session"): absent or not `true` = false.
    ...(v.rotating === true ? { rotating: true } : {}),
  };
}
