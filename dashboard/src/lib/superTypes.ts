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
  /** The agenda only: minimised to the pill in the stage's bottom-left corner. */
  min?: true;
  /** A live child's chat card the owner put away himself (server-written, epoch ms). */
  heldAt?: number;
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
  /** `present` only: its layout (always resolved by the store, {@link resolveLayout}). */
  layout?: PresentLayout;
  /** `present` only: the OWNER picked this layout for these cards; an agent `present` of the same
   *  set keeps it. */
  layoutBy?: 'owner';
  /** `present` only: the owner folded the agent's chat to its composer bar. */
  chat?: 'bar';
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
    return cards.length === (view.cards ?? []).length ? view : { ...view, cards };
  }
  return view;
}

/**
 * A presentation's named layout (task super-sahnesinde-adli-sunum-duzenleri…, owner 2026-10-23:
 * "sometimes we want the site wide"): `spotlight` one big card with the agent as a small square
 * bottom-left, `compare` two equal cards, `grid` 2-4, `filmstrip` one big card over a strip of
 * the rest, `review` a child's page with its chat (and browser) under it.
 */
export const PRESENT_LAYOUTS = ['spotlight', 'compare', 'grid', 'filmstrip', 'review'] as const;
export type PresentLayout = typeof PRESENT_LAYOUTS[number];
/** A filmstrip shows at most this many cards; every other layout {@link MAX_PRESENT}. */
export const MAX_FILMSTRIP = 8;

/** How many cards a layout shows. */
export function presentRange(layout: PresentLayout): { min: number; max: number } {
  switch (layout) {
    case 'spotlight': return { min: 1, max: 1 };
    case 'compare': return { min: 2, max: 2 };
    case 'grid': return { min: 2, max: MAX_PRESENT };
    case 'filmstrip': return { min: 2, max: MAX_FILMSTRIP };
    case 'review': return { min: 2, max: 3 };
  }
}

type LayoutCard = Pick<SuperContainer, 'kind' | 'ref' | 'of'>;

/**
 * A child's page under review: exactly one chat, plus that child's site (a web card it owns,
 * `of`) and/or its live browser (`ref` = the chat's session), and nothing else. The agenda never
 * makes one.
 */
export function isReviewSet(cards: readonly LayoutCard[]): boolean {
  if (cards.length < 2 || cards.length > 3) return false;
  const chats = cards.filter((c) => c.kind === 'chat');
  if (chats.length !== 1) return false;
  const child = chats[0].ref;
  let web = 0;
  let browser = 0;
  for (const c of cards) {
    if (c.kind === 'chat') continue;
    if (c.kind === 'web' && c.of === child) web += 1;
    else if (c.kind === 'browser' && c.ref === child) browser += 1;
    else return false;
  }
  return web <= 1 && browser <= 1 && web + browser >= 1;
}

/** Does this layout take these cards (its count, and for review what they are)? */
export function layoutFits(layout: PresentLayout, cards: readonly LayoutCard[]): boolean {
  const r = presentRange(layout);
  if (cards.length < r.min || cards.length > r.max) return false;
  return layout !== 'review' || isReviewSet(cards);
}

/** The layout the cards pick when none is given: 1 spotlight, a child's page with its chat
 *  review, 2 compare, 3-4 grid, 5-8 filmstrip. */
export function defaultLayout(cards: readonly LayoutCard[]): PresentLayout {
  if (cards.length <= 1) return 'spotlight';
  if (isReviewSet(cards)) return 'review';
  if (cards.length === 2) return 'compare';
  return cards.length <= MAX_PRESENT ? 'grid' : 'filmstrip';
}

/** The ONE resolver (store, route and window): an asked layout that takes the cards, else the
 *  cards' default. */
export function resolveLayout(asked: unknown, cards: readonly LayoutCard[]): PresentLayout {
  return typeof asked === 'string' && (PRESENT_LAYOUTS as readonly string[]).includes(asked)
    && layoutFits(asked as PresentLayout, cards) ? asked as PresentLayout : defaultLayout(cards);
}

/**
 * A present view read against the record: up to {@link MAX_FILMSTRIP} known cards, the layout
 * resolved, then cut to that layout's most. The owner's mark and the chat bar stay only while the
 * layout read is the layout kept (a closed card that changed it drops both). Null: no card left.
 */
export function resolvePresent(raw: { cards?: unknown; layout?: unknown; layoutBy?: unknown; chat?: unknown }, containers: readonly (LayoutCard & { id: string })[]): SuperView | null {
  const byId = new Map(containers.map((c) => [c.id, c] as const));
  const cards: string[] = [];
  for (const x of Array.isArray(raw.cards) ? raw.cards : []) {
    if (typeof x === 'string' && byId.has(x) && !cards.includes(x)) cards.push(x);
    if (cards.length >= MAX_FILMSTRIP) break;
  }
  if (!cards.length) return null;
  const layout = resolveLayout(raw.layout, cards.map((id) => byId.get(id)!));
  const shown = cards.slice(0, presentRange(layout).max);
  const kept = raw.layout === layout;
  return {
    mode: 'present', cards: shown, layout,
    ...(kept && raw.layoutBy === 'owner' ? { layoutBy: 'owner' as const } : {}),
    ...(kept && raw.chat === 'bar' ? { chat: 'bar' as const } : {}),
  };
}

/** Two card lists name the same cards (in any order). */
export function sameCardSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
}

/** What a layout takes, in words (the `present` refusal names it). */
export function layoutRule(layout: PresentLayout): string {
  if (layout === 'review') return 'review shows a child\'s page (web or browser) with that child\'s chat, optionally its browser: 2-3 cards';
  const r = presentRange(layout);
  return r.min === r.max ? `${layout} shows exactly ${r.min} card${r.min === 1 ? '' : 's'}` : `${layout} shows ${r.min}-${r.max} cards`;
}

/**
 * The owner's presentation gestures, each naming the cards he SAW (plan-r2 D9, R2-E3): the
 * layout he picked, the chat folded to its bar or opened again, and leaving the presentation.
 * Each applies only to a presentation of that same set, so one that lands after the agent
 * presented other cards is dropped, never laid over them.
 */
export interface OwnerViewFields {
  presentLayout?: { layout: PresentLayout; cards: string[] };
  chat?: { value: 'bar' | null; cards: string[] };
  /** `closing`: cards his window closed in a request still on its way (close, then Esc). */
  exit?: { cards: string[]; closing: string[] };
}

const idList = (v: unknown, max: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string') ? [...v as string[]] : null;

/** The fields read from a layout body; a malformed one is left out. */
export function readOwnerViewFields(body: Record<string, unknown>): OwnerViewFields {
  const out: OwnerViewFields = {};
  const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const pl = rec(body.presentLayout);
  const plCards = pl ? idList(pl.cards, MAX_FILMSTRIP) : null;
  if (pl && plCards && typeof pl.layout === 'string' && (PRESENT_LAYOUTS as readonly string[]).includes(pl.layout)) {
    out.presentLayout = { layout: pl.layout as PresentLayout, cards: plCards };
  }
  const ch = rec(body.chat);
  const chCards = ch ? idList(ch.cards, MAX_FILMSTRIP) : null;
  if (ch && chCards && (ch.value === 'bar' || ch.value === null)) out.chat = { value: ch.value, cards: chCards };
  const ex = rec(body.exit);
  const exCards = ex ? idList(ex.cards, MAX_FILMSTRIP) : null;
  const closing = ex && ex.closing !== undefined ? idList(ex.closing, MAX_CONTAINERS) : [];
  if (ex && exCards && closing) out.exit = { cards: exCards, closing };
  return out;
}

/** The view after the owner's fields: unchanged unless it presents the set they name. */
export function applyOwnerViewFields(view: SuperView, f: OwnerViewFields): SuperView {
  // A malformed whole view (null, a string) is left for the store's sanitize, which floats it.
  if (!view || typeof view !== 'object' || view.mode !== 'present') return view;
  const shown = view.cards ?? [];
  // An exit also lands when a close he made just before it has not reached the record yet.
  if (f.exit && (sameCardSet(shown, f.exit.cards)
    || sameCardSet(shown.filter((id) => !f.exit!.closing.includes(id)), f.exit.cards))) return { mode: 'float' };
  let next = view;
  if (f.presentLayout && sameCardSet(shown, f.presentLayout.cards)) {
    next = { ...next, layout: f.presentLayout.layout, layoutBy: 'owner' };
  }
  if (f.chat && sameCardSet(shown, f.chat.cards)) {
    next = { ...next };
    if (f.chat.value === 'bar') next.chat = 'bar'; else delete next.chat;
  }
  return next;
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
  /** A team job's ending item: the job's id (its `sessionId` is the super's own). */
  team?: string;
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
  /** The owner asked for it through the super: its result goes to him. */
  awaited?: true;
  /** The last ending event already queued for the super. */
  told?: 'done' | 'stuck' | 'question';
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
/** The owner wrote about one agenda line: the header his message opens with (MIRRORED from the
 *  server, `src/lib/super/types.ts`, pinned by super-types-mirror.test.ts). */
export const ABOUT_AGENDA_RE = /^\[About agenda line (note|item)=([A-Za-z0-9_-]{1,40}) section=(waiting|now|done)\]/;
export const MAX_ABOUT_LINE = 200;
/** A message's reference: six base-36 characters derived from its words (MIRRORED from the
 *  server, which hashes what a turn received; the window hashes what it sent). */
export function msgRef(text: string): string {
  let h = 0x811c9dc5;
  const s = (text ?? '').trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % MSG_REF_SPACE).toString(36).padStart(6, '0');
}
const MSG_REF_SPACE = 2_176_782_336;
/** The owner replies to one message: the header his message opens with, and its quote's cap. */
export const REPLY_TO_RE = /^\[Reply to message ref=([0-9a-z]{6}) from=(super|owner)\]/;
export const MAX_REPLY_QUOTE = 100;
/** The super's mark on an answer's first line, `<!-- re:<ref> -->` (lib/replyMark.ts parses it). */
export const REPLY_MARK_RE = /^\s*<!--\s*re:([^\n>]*?)-->[ \t]*(?:\r?\n)?/;
export const REPLY_MARK_HEAD_MAX = 120;
export const REPLY_MARK_LINE_RE = /(^|\n)[ \t]*<!--\s*re:([^\n>]*?)-->[ \t]*(?:\r?\n)?/g;

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
  // A card in a group is drawn as the group's tile, never also as the agenda's pill.
  for (const c of state.containers) if (cards.includes(c.id)) delete c.min;
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
function readView(v: unknown, containers: readonly SuperContainer[]): SuperView {
  const ids = new Set(containers.map((c) => c.id));
  if (!isRecord(v) || !oneOf(VIEW_MODES, v.mode)) return { mode: 'float' };
  if (v.mode === 'half') {
    if (typeof v.card !== 'string' || !ids.has(v.card)) return { mode: 'float' };
    return v.auto === true ? { mode: 'half', card: v.card, auto: true } : { mode: 'half', card: v.card };
  }
  if (v.mode === 'present') {
    // The server resolved it already; the same resolver keeps an older push (no layout) and
    // this window agreeing on what is drawn.
    return resolvePresent(v, containers) ?? { mode: 'float' };
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
  const view = readView(v.view, containers);
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
