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
export const CONTAINER_KINDS = ['chat', 'insight', 'task', 'knowledge', 'whiteboard', 'board', 'web', 'image', 'browser', 'team'] as const;
export type ContainerKind = typeof CONTAINER_KINDS[number];

/** A card's recorded shape, square (1:1) or tall (3:4): plan-r8 F1 and stage v2. Since the
 *  2026-10-20 redesign every FLOATING card is drawn as one 1:1 tile whatever its shape; the field
 *  stays so older records and scripts read and run unchanged. */
export const CONTAINER_SHAPES = ['square', 'tall'] as const;
export type ContainerShape = typeof CONTAINER_SHAPES[number];

/** A floating card's size preset, the way a widget is sized (owner 2026-10-22): units of the
 *  stage's 1:1 tile, wide by tall. A card with no size is `small`, so every record written
 *  before sizes reads as the 1:1 tile it was. */
export const CONTAINER_SIZES = ['small', 'medium', 'large', 'wide'] as const;
export type ContainerSize = typeof CONTAINER_SIZES[number];
export const SIZE_UNITS: Readonly<Record<ContainerSize, { w: number; h: number }>> = {
  small: { w: 1, h: 1 }, medium: { w: 2, h: 1 }, large: { w: 2, h: 2 }, wide: { w: 3, h: 2 },
};

/** Floating around the centre, or in the bottom-right "Others" stack (plan-r8 F1, O4). */
export const CONTAINER_PLACES = ['float', 'others'] as const;
export type ContainerPlace = typeof CONTAINER_PLACES[number];

/** How the stage is arranged: floating cards, one card side by side (half page), or the
 *  presentation (the agent left, 1-4 cards right). plan-r8 F1, O5, O8. */
export const VIEW_MODES = ['float', 'half', 'present'] as const;
export type ViewMode = typeof VIEW_MODES[number];

/** Every card the record holds, Others and group members included (jarvis plan r9): the 49th
 *  is refused. The stage limit is {@link MAX_FLOAT}. */
export const MAX_CONTAINERS = 48;
/** Top-level FLOATING items an `open` may add to: an ungrouped floating card, or a group (one
 *  item, however many cards). Others does not count. Applied only when opening. */
export const MAX_FLOAT = 12;
/** A presentation shows at most this many cards. */
export const MAX_PRESENT = 4;
/** Live children (starting/working/asking) `super delegate` may run at once (D11). The ONLY
 *  limit a new delegation has: the machine's facts are information, never a hold (owner,
 *  2026-10-21: 15, up from 8). The briefing, the guide and the CLI text name this number. */
export const MAX_LIVE_CHILDREN = 15;

/** A card's default shape: a chat and a web page are tall, everything else square (a live
 *  browser card is a 1:1 tile like the rest). */
export function defaultShape(kind: ContainerKind): ContainerShape {
  return kind === 'chat' || kind === 'web' ? 'tall' : 'square';
}

/** A page (a site, a project web page, a child's live browser) is opened to be LOOKED AT (owner
 *  2026-10-22: "it opened as a small card; it should have shown it directly"): an agent or the
 *  server never sizes one under this. The owner's own size is his and is never raised. */
export function minSizeFor(kind: ContainerKind): ContainerSize {
  return kind === 'web' || kind === 'browser' ? 'large' : 'small';
}

/** The larger of two sizes (the list runs small → wide). */
export function atLeastSize(size: ContainerSize, min: ContainerSize): ContainerSize {
  return CONTAINER_SIZES.indexOf(size) >= CONTAINER_SIZES.indexOf(min) ? size : min;
}

/** A page card: opening one shows it side by side (`isPageKind`), see `super open`. */
export function isPageKind(kind: ContainerKind): boolean {
  return kind === 'web' || kind === 'browser';
}

export interface SuperContainer {
  /** Stable id, `[a-z0-9-]{1,40}`. */
  id: string;
  kind: ContainerKind;
  /** What it shows: a session id (chat), an insight/task/knowledge/whiteboard/board slug, a
   *  URL (web) or a project-relative path (image). Validated per kind at `open`. */
  ref: string;
  shape: ContainerShape;
  /** The size preset it floats at (absent = small). */
  size?: ContainerSize;
  /** The owner chose the size: an agent verb never changes it (only the owner's own layout). */
  sizeBy?: 'owner';
  place: ContainerPlace;
  /** Where the OWNER dropped it: the card's top-left as fractions (0..1) of the stage's free
   *  area. Absent = placed automatically. No agent verb writes it. */
  pos?: { x: number; y: number };
  title?: string;
  /** Opened by the server itself (a child's dev-server pin, its live browser), never by a verb:
   *  only the server writes it; the agent's `open` and the owner's layout cannot carry it. */
  by?: 'auto';
  /** The child an automatic card belongs to (its dev server, its browser): the card goes to
   *  Others when the child withdraws the pin or ends. Server-written, like `by`. */
  of?: string;
}

/** The owner closed an automatic card: the same (kind, ref) is not opened again automatically
 *  until `until` (G5). */
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

/** The stage's arrangement. `card` names the half-page card; `cards` the presented ones. */
export interface SuperView {
  mode: ViewMode;
  card?: string;
  cards?: string[];
  /** `half` only: the SERVER put this page side by side on its own (a dev server or a child's
   *  browser appeared), so automation may take it back when that page settles. Any view the
   *  owner or the agent sets carries no mark. */
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
  /** The chat's pin id (what the chat registry and the tab roster key it by). */
  sessionId: string;
  /** The one-line reminder its container shows (`super brief`); the tab title until then. */
  brief: string;
  /** The owner's own chat, adopted at hand-over or by `super adopt` on his word (true), or
   *  started by `super delegate` (false). */
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
  /** The owner waits on this job's result: the super agent started it in the owner's own turn,
   *  not in an event turn. Its done/stuck/gone event asks the super to tell him; spent when that
   *  turn ends. */
  awaited?: true;
  /** What it runs with (`super delegate`, then `super update --mode/--model/--effort`), so
   *  `super resume` reopens it the same way. Absent = basic, the default model and effort. */
  mode?: string;
  model?: string;
  effort?: string;
  /** The MCP servers it was started with (`delegate --mcp`, plan r5 D14): a delegated child
   *  runs lean, with only these; Resume keeps the same set. */
  mcp?: string[];
  /** `super end` closed it (epoch ms): no process, no tab, no card; the transcript stays and
   *  `super resume` reopens it (which clears this). Absent = a child that may be running. */
  endedAt?: number;
  /** `super delegate --succeeds` handed its card, brief and task to this child (one job, one
   *  owner); it is ended, and `super state` warns while it still runs. */
  succeededBy?: string;
}

/** Ended children the record keeps (newest first); older ones drop out of it, except one that
 *  still owns a worktree (it leaves when `super worktree remove` clears it). */
export const MAX_ENDED_CHILDREN = 30;

/** A child's row in the job list. `asking` = the super agent is handling its question. */
export const CHILD_ROWS = ['working', 'asking', 'done', 'stuck', 'gone'] as const;
export type ChildRow = typeof CHILD_ROWS[number];
export const STUCK_REASONS = ['error', 'stale'] as const;
export type StuckReason = typeof STUCK_REASONS[number];

/**
 * What reaches the queue. `idle` left with plan r4 (a child's turn end updates its row and spends
 * no super turn); an older record's idle items drop on first read. `done` = settled idle for
 * DONE_SETTLE_MS, `stuck` = an error turn or a stale one, `ask` = the super agent's own question
 * to the owner (`super ask`). `ended` = `super end` closed the child: born `done`, a record of
 * its last brief, never delivered as a turn. `approval`: an AI Team member the super gave a job to
 * is not approved on this machine. The server writes it (never the super agent's words, like a
 * permission) and the owner settles it in AI Team; it closes once the member is approved, turned
 * off or gone, or by `super queue done`. `fresh`: the owner pressed "New session" — one solo
`[super fresh]` turn in which the super writes its handoff file, after which its pane rotates into
a fresh session (super/fresh-session.ts). Its `sessionId` is the super's own.
 */
export const QUEUE_KINDS = ['permission', 'question', 'done', 'gone', 'stuck', 'ask', 'recap', 'handover', 'ended', 'approval', 'fresh'] as const;
export type QueueKind = typeof QUEUE_KINDS[number];

export const QUEUE_STATES = ['pending', 'delivered', 'escalated', 'done'] as const;
export type QueueState = typeof QUEUE_STATES[number];

export interface SuperQueueItem {
  id: string;
  /** The child it is about (`recap`/`handover`/`fresh` items name the super session itself). */
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
  /** An `ask`'s answers, each one line of at most MAX_ASK_OPTION characters (never cut). Derived
   *  from `ask` when that is one single-choice question with short labels (the notch's buttons). */
  options?: string[];
  /** An `ask` in AskUserQuestion's own shape (`cleanAskSpec`): the chat draws it with the same
   *  card a normal agent's question gets. An older record has only `ownerText`/`options`. */
  ask?: SuperAskSpec;
  /** Process exits that ended a turn carrying it (server-only, plan r4 D10). */
  exits?: number;
  /** An `ended` item's record of the child's last brief (who and when are `sessionId` and
   *  `createdAt`). Born `done`: a record, never delivered as a turn. */
  brief?: string;
  /** An `approval` item's AI Team member (its agent slug). Its `sessionId` is the super's own. */
  member?: string;
}

/**
 * A job the super gave one of the project's AI Team members (`super team ask`): it went into the
 * member's OWN thread through the AI Team's say path, so the member's model, approval and queue
 * rule it. The record names where it landed; its status and last line are read from that thread
 * (`lib/super/team.ts`), never stored.
 */
export interface SuperTeamJob {
  /** `team-…`, also its card's id. */
  id: string;
  /** The member's agent slug (the say target). */
  member: string;
  /** The thread run it landed in: a fresh run, or the member's live run when it was busy. */
  runId: string;
  /** Its own entry in that run (the ask), when the say path named it. */
  entryId?: string;
  /** The say path's job: a fresh `run`, or a `reply` resuming the member's session (a busy
   *  member's queue, or a scheduled member's last conversation). Its id answers while the job is
   *  in memory; the thread answers after that. */
  jobKind: 'run' | 'reply';
  jobId?: string;
  /** The member was busy: the job waits in its own queue behind the run in flight. */
  queued: boolean;
  brief: string;
  startedAt: number;
  /** A reply job's own ending, recorded when the say path's job settles: the member's thread
   *  cannot tell a queued reply's ending from the busy turn's it waited behind. */
  outcome?: 'done' | 'failed';
  /** When that reply got the member's lock and when it settled (ms): its last line is the
   *  member's posts between the two. */
  deliveredAt?: number;
  endedAt?: number;
}

/** What a team job's card and `super state` say, read from the member's thread. */
export const TEAM_JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type TeamJobStatus = typeof TEAM_JOB_STATUSES[number];

/** Team jobs the record keeps (newest first). */
export const MAX_TEAM_JOBS = 30;
export const TEAM_JOB_ID_RE = /^team-[a-z0-9-]{1,35}$/;

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
  mcp?: string[];
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
  /** Automatic cards the owner closed, not reopened automatically for a while (G5). */
  dismissed: SuperDismissed[];
  /** Jobs kept for later (plan r4 D9). Absent in an older record = none. */
  pool: SuperPoolItem[];
  /** Batch ids of event turns in which the super agent asked the owner something (`queue ask`,
   *  `super ask`): those turns render in full. A ring of MAX_OWNER_BATCHES, never mutated after. */
  ownerBatches: string[];
  /** Jobs given to AI Team members (`super team ask`), newest first. Absent in an older record = none. */
  team: SuperTeamJob[];
  /** What piled up while the owner had a question open (`SuperHeldEvent`): told to the super agent
   *  with his answer, never dropped silently. Absent = none. */
  held?: SuperHeldEvent[];
}

/**
 * One event that arrived while a question was open with the owner (the single-question rule
 * holds every event turn back). The ledger outlives the queue item's own life: an item the pump
 * later finds stale (the child moved on) is still told, as moved on, never dropped unseen.
 * The Super ajanda reads it from the record as "while you were asked".
 */
export interface SuperHeldEvent {
  /** The queue item. */
  item: string;
  /** The child it is about. */
  child: string;
  kind: 'question' | 'done' | 'stuck' | 'gone';
  at: number;
}
export const MAX_HELD = 40;

export function emptySuperState(): SuperState {
  return { v: SUPER_STATE_VERSION, session: null, enabled: false, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [] };
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

/** Top-level floating items on the stage: ungrouped floating cards plus floating groups (a
 *  group is ONE item). Others is not counted. Pure. */
export function floatCount(state: { containers: readonly SuperContainer[]; groups: readonly SuperGroup[] }): number {
  const grouped = new Set(state.groups.flatMap((g) => g.cards));
  return state.containers.filter((c) => c.place === 'float' && !grouped.has(c.id)).length
    + state.groups.filter((g) => g.place === 'float').length;
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
export { TASK_SLUG_RE } from '../task-slug.js';
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

// ─── `super ask` in AskUserQuestion's shape (MIRRORED in the window's superTypes.ts) ──

export interface SuperAskOption { label: string; description?: string; preview?: string }
export interface SuperAskQuestion {
  question: string;
  header?: string;
  description?: string;
  multiSelect?: boolean;
  /** None = a question answered in words (the card's text box). */
  options: SuperAskOption[];
}
/** AskUserQuestion's input: `title`, `questions[]`, `metadata.source` (stored as `source`). */
export interface SuperAskSpec { title?: string; questions: SuperAskQuestion[]; source?: string }

export const MAX_ASK_QUESTIONS = 4;
export const MAX_ASK_LABEL = 60;
export const MAX_ASK_HEADER = 24;
export const MAX_ASK_TITLE = 160;
export const MAX_ASK_DESCRIPTION = 600;
export const MAX_ASK_PREVIEW = 16_384;
export const MAX_ASK_PREVIEWS = 32_768;

const askObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An optional one-line field: absent/empty = undefined; over `max` characters = refused. */
function askField(raw: unknown, max: number, what: string): { v?: string; err?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return { err: `${what} must be text` };
  const v = askLine(raw);
  if (!v) return {};
  return [...v].length <= max ? { v } : { err: `${what} is at most ${max} characters (never cut)` };
}

/**
 * A `super ask` in AskUserQuestion's own input shape — `{title, questions: [{question, header,
 * description, multiSelect, options: [{label, description, preview}]}], metadata: {source}}` —
 * or the reason it is refused. Every line is one clean line (`askLine`); a preview is HTML the
 * card draws in its sandbox, kept whole. Anything too long is refused, never cut.
 */
export function cleanAskSpec(raw: unknown): { ok: true; spec: SuperAskSpec } | { ok: false; error: string } {
  if (!askObj(raw)) return { ok: false, error: 'the question must be an object: {"questions":[…]}' };
  const title = askField(raw.title, MAX_ASK_TITLE, 'title');
  if (title.err) return { ok: false, error: title.err };
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > MAX_ASK_QUESTIONS) {
    return { ok: false, error: `1-${MAX_ASK_QUESTIONS} questions` };
  }
  const questions: SuperAskQuestion[] = [];
  const asked = new Set<string>();
  let previews = 0;
  for (const rq of raw.questions as unknown[]) {
    if (!askObj(rq)) return { ok: false, error: 'each question is an object' };
    const q = typeof rq.question === 'string' ? askLine(rq.question) : '';
    if (!q) return { ok: false, error: 'each question needs its `question` text' };
    if (q.length > MAX_OWNER_TEXT) return { ok: false, error: `a question is at most ${MAX_OWNER_TEXT} characters` };
    if (asked.has(q)) return { ok: false, error: 'two questions with the same text' };
    asked.add(q);
    const header = askField(rq.header, MAX_ASK_HEADER, 'header');
    const description = askField(rq.description, MAX_ASK_DESCRIPTION, 'description');
    if (header.err || description.err) return { ok: false, error: (header.err ?? description.err) as string };
    const rawOpts = rq.options === undefined ? [] : rq.options;
    if (!Array.isArray(rawOpts) || rawOpts.length > MAX_ASK_OPTIONS) return { ok: false, error: `at most ${MAX_ASK_OPTIONS} options a question` };
    const options: SuperAskOption[] = [];
    for (const ro of rawOpts as unknown[]) {
      const o = typeof ro === 'string' ? { label: ro } : ro;
      if (!askObj(o)) return { ok: false, error: 'each option is an object with a `label`' };
      const label = typeof o.label === 'string' ? askLine(o.label) : '';
      if (!label || [...label].length > MAX_ASK_LABEL) return { ok: false, error: `each option label is one line of 1-${MAX_ASK_LABEL} characters (never cut)` };
      if (options.some((x) => x.label === label)) return { ok: false, error: 'two options with the same label' };
      const od = askField(o.description, MAX_ASK_DESCRIPTION, 'option description');
      if (od.err) return { ok: false, error: od.err };
      let preview: string | undefined;
      if (o.preview !== undefined && o.preview !== null) {
        if (typeof o.preview !== 'string') return { ok: false, error: 'a preview is HTML text' };
        if (o.preview.length > MAX_ASK_PREVIEW) return { ok: false, error: `a preview is at most ${MAX_ASK_PREVIEW} characters` };
        previews += o.preview.length;
        if (o.preview.trim()) preview = o.preview;
      }
      options.push({ label, ...(od.v ? { description: od.v } : {}), ...(preview ? { preview } : {}) });
    }
    if (previews > MAX_ASK_PREVIEWS) return { ok: false, error: `the previews together are at most ${MAX_ASK_PREVIEWS} characters` };
    questions.push({
      question: q,
      ...(header.v ? { header: header.v } : {}),
      ...(description.v ? { description: description.v } : {}),
      ...(rq.multiSelect === true && options.length > 1 ? { multiSelect: true } : {}),
      options,
    });
  }
  const meta = askObj(raw.metadata) ? raw.metadata : {};
  const rawSource = typeof raw.source === 'string' ? raw.source : meta.source;
  const source = typeof rawSource === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(rawSource) ? rawSource : undefined;
  return { ok: true, spec: { ...(title.v ? { title: title.v } : {}), questions, ...(source ? { source } : {}) } };
}

/** The old `super ask "<text>" --options a|b`, in the same shape. */
export function askSpecFromLegacy(text: string, options: readonly string[]): SuperAskSpec {
  return { questions: [{ question: text, options: options.map((label) => ({ label })) }] };
}

/** What the notch, a banner, a phone push and the event texts show of an `ask`: its first
 *  question (one line), and its labels as buttons when they are one short single choice. */
export function askSummary(spec: SuperAskSpec): { ownerText: string; options: string[] } {
  const [first] = spec.questions;
  const more = spec.questions.length - 1;
  const ownerText = more > 0 ? `${first.question} (+${more})` : first.question;
  const labels = first.options.map((o) => o.label);
  const short = spec.questions.length === 1 && !first.multiSelect && labels.length > 0
    && labels.every((l) => [...l].length <= MAX_ASK_OPTION);
  return { ownerText, options: short ? labels : [] };
}

// ─── The agent's verbs (`dreamcontext super <verb>` → POST /api/super/v/:verb) ────

export const SUPER_VERBS = [
  'state', 'delegate', 'open', 'shape', 'half', 'present', 'stack', 'float', 'close', 'group', 'ungroup', 'brief', 'read',
  'answer', 'send', 'queue-list', 'queue-ask', 'queue-done', 'merge', 'worktree-list', 'worktree-remove',
  'pool-add', 'pool-remove', 'pool-list', 'ask',
  'end', 'resume', 'update', 'adopt',
  'clean', 'team-ask',
] as const;
export type SuperVerb = typeof SUPER_VERBS[number];

/** The verbs the WINDOW runs (sent down the super chat's own socket as `super_command`). */
export const SUPER_WINDOW_VERBS = ['delegate', 'answer', 'resume'] as const;
export type SuperWindowVerb = typeof SUPER_WINDOW_VERBS[number];

// ─── Frames (`_meta` subtypes on the super chat's socket) ──────────────────────

export const SUPER_FRAME_COMMAND = 'super_command' as const;
export const SUPER_FRAME_RESULT = 'super_command_result' as const;
export const SUPER_FRAME_STATE = 'super_state' as const;
export const SUPER_FRAME_EVENT = 'super_event' as const;
/** A verb landed: what the window shows for it (AC16), `{verb, ids}`. */
export const SUPER_FRAME_CUE = 'super_cue' as const;

/** The prefixes an injected super turn starts with; history replay renders them as event lines.
 *  `[super event]` stays for a transcript written before plan r4. */
export const SUPER_EVENT_PREFIXES = ['[super event]', '[super recap]', '[super handover]', '[super events]', '[super fresh]'] as const;

/** What a `super_event` frame says about the turn it opened: `batch` since plan r4 (the other
 *  kinds stay for replay of older transcripts). */
export const SUPER_EVENT_KINDS = ['question', 'idle', 'gone', 'recap', 'handover', 'batch', 'fresh'] as const;
export type SuperEventKind = typeof SUPER_EVENT_KINDS[number];

// ─── Server-side constants (wave 2; not mirrored: the window never needs them) ───

/**
 * The fixed, server-authored note a child's next OWNER message carries (D17), as a second text
 * block starting with `<` so history replay drops it and the owner's bubble keeps his text.
 * Nothing is interpolated.
 */
export const SUPER_NOTE_TEXT: Record<SuperNote, string> = {
  handover: '<super-agent-note> From now on the owner talks to you through the Super Agent; it relays your questions and answers. Ask it with AskUserQuestion (the card goes to its queue); never look for it with ListAgents or SendMessage. </super-agent-note>',
  takeback: '<super-agent-note> The Super Agent mode is over; you talk directly with the owner again. </super-agent-note>',
};

/**
 * The Super Agent briefing's revision (jarvis plan r9, K9). A super session is born once per
 * vault and resumed for months, and `--resume` restores the system prompt it was born with, so a
 * briefing change reaches a running session as SUPER_BRIEF_TEXT (chat-modes.ts) on its next owner message
 * (and again after a compaction drops that message). The fixed `<super-brief rev=N>` marker is
 * how the transcript tells whether this revision already arrived. Whoever changes the sections
 * bumps the number. The update text is the whole current briefing (`SUPER_BRIEF_TEXT` in
 * src/server/chat-modes.ts).
 */
export const SUPER_BRIEF_REV = 5;
export const SUPER_BRIEF_MARKER = `<super-brief rev=${SUPER_BRIEF_REV}>`;

/** S4-S8: show, don't tell. */
export const SUPER_SHOW_SECTION = `## Show, don't tell
- The owner asks to see a set of things ("show my tasks", insights, boards): every item is a
  card. More than 3: ONE group, \`dreamcontext super open task <slug…> --group "Tasks"\`. Never
  write the items as a list in the chat, and never name them in a sentence either, not even
  three: the cards show them. At most two sentences ("5 open tasks are on the stage, in
  'Tasks'"). Stage full (409 too_many_containers): first \`super stack\` finished or idle
  cards into Others, then open. Never close a card to make room and never skip an item. A full
  stage changes nothing in the reply: still at most two sentences, and do not tell what you
  moved to make room: never name or count what went to Others, never say that nothing was
  closed. Only when the record itself is full, open what fits and say in one sentence how
  many did not.
- A tracked metric comes up: \`super open insight <slug>\` instead of writing the number.
- The owner has to decide something visual (a mockup, a layout): open the options as cards
  (png, svg, html, a board), \`super present <card…>\`, then ask with \`super ask --json\` (an option
  \`preview\` draws each choice in the card itself); after his
  answer, \`super present --off\`.
- Your answer would describe something he can look at: open it and write one line.
- The server opens a child's dev-server site and its live browser as cards by itself; you see
  them in \`super state\`. Do not reopen or describe them. A child says its dev server runs but
  did not pin it: \`super open web <url>\`.`;

/** The spoken reply rule (K1). The block rides only while the owner's speech switch is on
 *  (the composer's speaker button), so with it off a dictated message is answered like a typed
 *  one: the rule must not ask for a short reply to every message the owner happened to say. */
export const SUPER_VOICE_SECTION = `## Voice
Only a message carrying an \`<owner-voice>\` block is read aloud: answer it in one or two short
sentences, any detail on a card. Every other message, typed or dictated, is only read on screen:
give it your usual reply, as long as it needs.`;

/** Rides on a spoken owner message to the super agent (a second block, never stored). */
export const OWNER_VOICE_TEXT = '<owner-voice> The owner spoke this message; your reply is read aloud. Answer in one or two short spoken sentences; put any detail on a card. </owner-voice>';

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
  /** Each AI Team job on the stage (a `team` card): its status and last line, read now from the
   *  member's thread. Absent when no team card is open. */
  teamLive?: Record<string, { status: TeamJobStatus; lastLine: string }>;
  /** Queue items whose banner the server posted (lib/super/owner-question.ts): the job bar posts
   *  no second one. Absent: none. */
  bannered?: string[];
  /** The super's pane is rotating into a fresh session ("New session"): the window greys the
   *  button and nothing is delivered until it has answered. Absent: false. */
  rotating?: boolean;
}
