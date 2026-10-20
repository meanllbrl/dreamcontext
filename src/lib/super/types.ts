/**
 * The Super Agent's state — one project's lead chat while the owner has handed the Chat screen
 * over to it (task chat-gets-a-super-agent-mode-sub-agents-as-containers-one-question-queue,
 * plan-r7 D2). The server is the ONLY writer (`store.ts`); the window renders what the server
 * pushes as `_meta{subtype:'super_state'}` and never polls.
 *
 * MIRRORED in `dashboard/src/lib/superTypes.ts` (the shapes and lists the window needs). Change
 * one, change the other; `tests/unit/super-types-mirror.test.ts` pins the pair.
 */

export const SUPER_STATE_VERSION = 1 as const;

/** What a container can show. `chat` is a child chat's card; the rest are read-only views. */
export const CONTAINER_KINDS = ['chat', 'insight', 'task', 'knowledge', 'whiteboard', 'board', 'web', 'image'] as const;
export type ContainerKind = typeof CONTAINER_KINDS[number];

/** A card's recorded shape, square (1:1) or tall (3:4): plan-r8 F1 and stage v2. Since the
 *  2026-10-20 redesign every FLOATING card is drawn as one 1:1 tile whatever its shape; the field
 *  stays so older records and scripts read and run unchanged. */
export const CONTAINER_SHAPES = ['square', 'tall'] as const;
export type ContainerShape = typeof CONTAINER_SHAPES[number];

/** Floating around the centre, or in the bottom-right "Others" stack (plan-r8 F1, O4). */
export const CONTAINER_PLACES = ['float', 'others'] as const;
export type ContainerPlace = typeof CONTAINER_PLACES[number];

/** How the stage is arranged: floating cards, one card side by side (half page), or the
 *  presentation (the agent left, 1-4 cards right). plan-r8 F1, O5, O8. */
export const VIEW_MODES = ['float', 'half', 'present'] as const;
export type ViewMode = typeof VIEW_MODES[number];

/** The 13th container is refused (AC4). */
export const MAX_CONTAINERS = 12;
/** A presentation shows at most this many cards. */
export const MAX_PRESENT = 4;
/** Live children (starting/working/asking) `super delegate` may run at once (D11). */
export const MAX_LIVE_CHILDREN = 8;

/** A card's default shape: a chat and a web page are tall, everything else square. */
export function defaultShape(kind: ContainerKind): ContainerShape {
  return kind === 'chat' || kind === 'web' ? 'tall' : 'square';
}

export interface SuperContainer {
  /** Stable id, `[a-z0-9-]{1,40}`. */
  id: string;
  kind: ContainerKind;
  /** What it shows: a session id (chat), an insight/task/knowledge/whiteboard/board slug, a
   *  URL (web) or a project-relative path (image). Validated per kind at `open`. */
  ref: string;
  shape: ContainerShape;
  place: ContainerPlace;
  /** Where the OWNER dropped it: the card's top-left as fractions (0..1) of the stage's free
   *  area. Absent = placed automatically. No agent verb writes it. */
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

/** The stage's arrangement. `card` names the half-page card; `cards` the presented ones. */
export interface SuperView {
  mode: ViewMode;
  card?: string;
  cards?: string[];
}

export interface SuperChild {
  /** The chat's pin id (what the chat registry and the tab roster key it by). */
  sessionId: string;
  /** The one-line reminder its container shows (`super brief`); the tab title until then. */
  brief: string;
  /** Adopted at hand-over (true) or started by `super delegate` (false). */
  adopted: boolean;
  /** Its own worktree, when `super delegate --worktree` made one: under `~/.claude-worktrees/`. */
  worktree?: string;
  /** `super/<slug>`, beside `worktree`. */
  branch?: string;
  startedAt: number;
  /** The job list's row (plan r4 D5, D6, D15): written by the SERVER from the registry, never
   *  by an agent verb. Absent in an older record: derived from the live status until reconciled. */
  row?: ChildRow;
  /** When `row` last moved (epoch ms). */
  rowAt?: number;
  /** The 30 s settle window after a turn end is running (the list's "bitiyor" chip). */
  settling?: boolean;
  /** The task this job belongs to (`super brief --task`, `delegate --task`): a slug under state/. */
  task?: string;
  /** Why the row is `stuck`: an error turn, or a working turn silent past the stale bar. */
  stuckReason?: StuckReason;
}

/** A child's row in the job list. `asking` = the super agent is handling its question. */
export const CHILD_ROWS = ['working', 'asking', 'done', 'stuck', 'gone'] as const;
export type ChildRow = typeof CHILD_ROWS[number];
export const STUCK_REASONS = ['error', 'stale'] as const;
export type StuckReason = typeof STUCK_REASONS[number];

/**
 * What reaches the queue. `idle` left with plan r4 (a child's turn end updates its row and spends
 * no super turn); an older record's idle items drop on first read. `done` = settled idle for
 * DONE_SETTLE_MS, `stuck` = an error turn or a stale one, `ask` = the super agent's own question
 * to the owner (`super ask`).
 */
export const QUEUE_KINDS = ['permission', 'question', 'done', 'gone', 'stuck', 'ask', 'recap', 'handover'] as const;
export type QueueKind = typeof QUEUE_KINDS[number];

export const QUEUE_STATES = ['pending', 'delivered', 'escalated', 'done'] as const;
export type QueueState = typeof QUEUE_STATES[number];

export interface SuperQueueItem {
  id: string;
  /** The child it is about (`recap`/`handover` items name the super session itself). */
  sessionId: string;
  kind: QueueKind;
  /** The pending AskUserQuestion / permission request it answers. */
  requestId?: string;
  state: QueueState;
  /** What the super agent wrote for the owner (`super queue ask`). Never on a permission. */
  ownerText?: string;
  createdAt: number;
  /** Delivered turns that ended with this question unsettled (server-only bookkeeping). */
  attempts?: number;
  /** The `[super events]` turn that carried it (or, on an `ask`, the turn it was asked in). */
  batch?: string;
  /** An `ask`'s answers, each one line of at most MAX_ASK_OPTION characters (never cut). */
  options?: string[];
  /** Process exits that ended a turn carrying it (server-only, plan r4 D10). */
  exits?: number;
}

/**
 * A job the super agent keeps for later (`super pool add`, or a `delegate` refused at the cap):
 * the list's "Havuz". `worktree` here is the REPO to make a worktree in, as `delegate --worktree`
 * takes it; `startedIn`/`startedBranch` name the worktree a `delegate --from` that the window did
 * not confirm may have opened (`maybeStarted`).
 */
export interface SuperPoolItem {
  id: string;
  title: string;
  prompt: string;
  /** sha1 of the prompt: the same job is pooled once. */
  hash: string;
  note?: string;
  task?: string;
  mode?: string;
  model?: string;
  effort?: string;
  worktree?: string;
  slug?: string;
  base?: string;
  /** Kept because `delegate` hit the cap. */
  held?: boolean;
  /** A `delegate --from` went unconfirmed: the child may be running. */
  maybeStarted?: boolean;
  startedIn?: string;
  startedBranch?: string;
  createdAt: number;
}

/** The note a child's next OWNER message carries (D17). */
export const SUPER_NOTES = ['handover', 'takeback'] as const;
export type SuperNote = typeof SUPER_NOTES[number];

export interface SuperState {
  v: typeof SUPER_STATE_VERSION;
  /** The vault's one super session (pin id), minted by the first hand-over and resumed after. */
  session: string | null;
  /** Handed over right now. */
  enabled: boolean;
  containers: SuperContainer[];
  /** Cards drawn together as one tile (2026-10-20). Absent in an older record = none. */
  groups: SuperGroup[];
  view: SuperView;
  children: Record<string, SuperChild>;
  queue: SuperQueueItem[];
  notes: Record<string, SuperNote>;
  /** The owner's absence, for the return recap (D13). */
  away: { since: number | null; events: number };
  /** Jobs kept for later (plan r4 D9). Absent in an older record = none. */
  pool: SuperPoolItem[];
  /** Batch ids of event turns in which the super agent asked the owner something (`queue ask`,
   *  `super ask`): those turns render in full. A ring of MAX_OWNER_BATCHES, never mutated after. */
  ownerBatches: string[];
}

export function emptySuperState(): SuperState {
  return { v: SUPER_STATE_VERSION, session: null, enabled: false, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, pool: [], ownerBatches: [] };
}

// ─── Groups (MIRRORED in the window, behaviour pinned by super-types-mirror.test.ts) ──

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

// ─── Identifiers ────────────────────────────────────────────────────────────────

/** A session id as the chat registry and the roster hold it. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const CONTAINER_ID_RE = /^[a-z0-9-]{1,40}$/;
export const QUEUE_ID_RE = /^[a-z0-9-]{1,40}$/;
/** A child's branch: the only branches `super` verbs ever create or merge into (D12). */
export const SUPER_BRANCH_RE = /^super\/[a-z0-9-]{1,60}$/;
/** A worktree slug or a merge topic (D12). */
export const SUPER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const MAX_BRIEF = 200;
export const MAX_TITLE = 120;
export const MAX_REF = 2048;
export const MAX_OWNER_TEXT = 2000;
export const MAX_QUEUE = 200;
/** A child row's task link: a task slug, its file `state/<slug>.md` (checked at the verb). */
export const TASK_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const POOL_ID_RE = /^p-[a-z0-9-]{1,40}$/;
/** The pool (plan r4 D9): rows, one prompt's UTF-8 bytes, and the pool's serialized total. */
export const MAX_POOL = 30;
export const MAX_POOL_PROMPT = 16_384;
export const MAX_POOL_BYTES = 524_288;
export const MAX_OWNER_BATCHES = 100;
/** `super ask`: at most this many options, each at most this many characters (refused, never cut). */
export const MAX_ASK_OPTIONS = 4;
export const MAX_ASK_OPTION = 24;
/** A child's turn end is "done" once it has stayed idle this long (plan r4 D5). */
export const DONE_SETTLE_MS = 30_000;
/** How often the stale sweep looks at working rows (plan r4 D17). */
export const STALE_SWEEP_MS = 60_000;
/** At most this many events go in one `[super events]` turn (plan r4 D10). */
export const MAX_BATCH = 8;

/** An `ask` text or option as one clean line: the invisible Unicode format characters
 *  (zero-width, bidi overrides and isolates, BOM) removed, control characters made spaces. */
export function askLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  // Every Unicode format character (Cf: zero-width, bidi marks and isolates, soft hyphen, BOM)
  // goes; C0 and C1 controls become a space (security review Minor 2).
  return raw.replace(/\p{Cf}/gu, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** One `ask` option as stored: format characters stripped, one line, trimmed. Empty or longer
 *  than MAX_ASK_OPTION = refused (null), never cut. */
export function cleanAskOption(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = askLine(raw);
  return v && [...v].length <= MAX_ASK_OPTION ? v : null;
}

/** An `ask`'s options, or null when any of them is refused (empty, too long, a duplicate, too many). */
export function cleanAskOptions(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ASK_OPTIONS) return null;
  const out: string[] = [];
  for (const o of raw) {
    const v = cleanAskOption(o);
    if (!v || out.includes(v)) return null;
    out.push(v);
  }
  return out;
}

// ─── The agent's verbs (`dreamcontext super <verb>` → POST /api/super/v/:verb) ────

export const SUPER_VERBS = [
  'state', 'delegate', 'open', 'shape', 'half', 'present', 'stack', 'float', 'close', 'group', 'ungroup', 'brief', 'read',
  'answer', 'send', 'queue-list', 'queue-ask', 'queue-done', 'merge', 'worktree-list', 'worktree-remove',
  'pool-add', 'pool-remove', 'pool-list', 'ask',
] as const;
export type SuperVerb = typeof SUPER_VERBS[number];

/** The verbs the WINDOW runs (sent down the super chat's own socket as `super_command`). */
export const SUPER_WINDOW_VERBS = ['delegate', 'answer'] as const;
export type SuperWindowVerb = typeof SUPER_WINDOW_VERBS[number];

// ─── Frames (`_meta` subtypes on the super chat's socket) ──────────────────────

export const SUPER_FRAME_COMMAND = 'super_command' as const;
export const SUPER_FRAME_RESULT = 'super_command_result' as const;
export const SUPER_FRAME_STATE = 'super_state' as const;
export const SUPER_FRAME_EVENT = 'super_event' as const;

/** The prefixes an injected super turn starts with; history replay renders them as event lines.
 *  `[super event]` stays for a transcript written before plan r4. */
export const SUPER_EVENT_PREFIXES = ['[super event]', '[super recap]', '[super handover]', '[super events]'] as const;

/** What a `super_event` frame says about the turn it opened: `batch` since plan r4 (the other
 *  kinds stay for replay of older transcripts). */
export const SUPER_EVENT_KINDS = ['question', 'idle', 'gone', 'recap', 'handover', 'batch'] as const;
export type SuperEventKind = typeof SUPER_EVENT_KINDS[number];

// ─── Server-side constants (wave 2; not mirrored: the window never needs them) ───

/**
 * The fixed, server-authored note a child's next OWNER message carries (D17), as a second text
 * block starting with `<` so history replay drops it and the owner's bubble keeps his text.
 * Nothing is interpolated.
 */
export const SUPER_NOTE_TEXT: Record<SuperNote, string> = {
  handover: '<super-agent-note> From now on the owner talks to you through the Super Agent; it relays your questions and answers. </super-agent-note>',
  takeback: '<super-agent-note> The Super Agent mode is over; you talk directly with the owner again. </super-agent-note>',
};

/** The owner typed in the super composer this recently: no event is delivered (D7). */
export const OWNER_LEASE_MS = 15_000;
/** `super read` never reads more than this from the end of a transcript (D10). */
export const MAX_READ_BYTES = 256 * 1024;
/** After a server restart, a recorded child absent from the registry has this long to register
 *  again before it is reported `gone` (D7). */
export const READOPT_GRACE_MS = 2 * 60_000;

/**
 * The state the window gets (`super_state`): the store's record and the vault it belongs to.
 * A child's live status and last line come from its own `ChatSession` in the window (D10: 0
 * requests per card), not from here. `brief` is the super agent's words about a child, rendered
 * as text, never as markup.
 */
export interface SuperStateView extends SuperState {
  vault: string;
}
