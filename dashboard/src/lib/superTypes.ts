/**
 * The Super Agent's state as the window sees it (`_meta{subtype:'super_state'}` on the super
 * chat's socket). The server is the only writer; the window renders and never polls.
 *
 * MIRRORED from `src/lib/super/types.ts`, which owns the record and its validation. Change one,
 * change the other; `tests/unit/super-types-mirror.test.ts` pins the lists and limits.
 *
 * Deliberately React-free with no runtime imports, so root vitest can load it beside the server
 * file (the `chatModes.ts` trick). The one type-only import below is erased at build.
 */

import type { ChecklistViewSpec, McpViewSpec, RunViewSpec, SecretViewSpec } from './chatViewSpec';

export const SUPER_STATE_VERSION = 1 as const;

export const CONTAINER_KINDS = ['chat', 'insight', 'task', 'knowledge', 'whiteboard', 'board', 'web', 'image', 'pdf', 'video', 'browser', 'team', 'agenda', 'member'] as const;
export type ContainerKind = typeof CONTAINER_KINDS[number];
/** A member stage's own cards (plan r4 K1, MIRROR of src/lib/super/types.ts): the owner's, pinned. */
export const MEMBER_CARD_REFS = ['routines', 'instructions', 'settings'] as const;
export type MemberCardRef = typeof MEMBER_CARD_REFS[number];

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
  /** A picture's width/height, server-read from its file header (absent = unknown). */
  aspect?: number;
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
  keptBy?: 'owner';
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
  /** `present` only: the question whose pictures this presentation shows (server-written). */
  ask?: string;
  /** `half`/`present`: the owner set this view himself (server-stamped). */
  by?: 'owner';
  /** When the owner last set this view or picked its layout (server-stamped, epoch ms). */
  ownerAt?: number;
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
/** A filmstrip shows at most this many cards (owner 2026-10-29: "the strip must not be limited":
 *  a group is presented whole, its strip scrolls); every other layout {@link MAX_PRESENT}. */
export const MAX_FILMSTRIP = MAX_CONTAINERS;
/** A picture at least this much wider than tall is landscape (16:9 is 1.78, 4:3 1.33). */
export const LANDSCAPE_ASPECT = 1.3;

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

type LayoutCard = Pick<SuperContainer, 'kind' | 'ref' | 'of'> & { aspect?: number };

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
 *  review, 2 compare, 3-4 grid, 5+ filmstrip; 2+ clips (all video) or 2+ landscape pictures a
 *  filmstrip. */
export function defaultLayout(cards: readonly LayoutCard[]): PresentLayout {
  if (cards.length <= 1) return 'spotlight';
  // Clips: one big player over a strip of the rest.
  if (cards.length <= MAX_FILMSTRIP && cards.every((c) => c.kind === 'video')) return 'filmstrip';
  if (isReviewSet(cards)) return 'review';
  // Landscape pictures (owner 2026-10-29: "if they are 16:9 use filmstrip, not grid, so we can see
  // them"): a grid cell is too small for a wide shot, one big over a strip shows it.
  if (cards.every((c) => c.kind === 'image' && (c.aspect ?? 0) >= LANDSCAPE_ASPECT)) return 'filmstrip';
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
export function resolvePresent(raw: { cards?: unknown; layout?: unknown; layoutBy?: unknown; chat?: unknown; ask?: unknown; by?: unknown; ownerAt?: unknown }, containers: readonly (LayoutCard & { id: string })[]): SuperView | null {
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
    ...(typeof raw.ask === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.ask) ? { ask: raw.ask } : {}),
    ...(raw.by === 'owner' ? { by: 'owner' as const } : {}),
    ...((raw.by === 'owner' || (kept && raw.layoutBy === 'owner')) && typeof raw.ownerAt === 'number' && Number.isFinite(raw.ownerAt)
      ? { ownerAt: raw.ownerAt } : {}),
  };
}

/**
 * A group shown all at once (owner 2026-10-27: "open every picture of the group together"): its
 * cards the record still holds, in group order, at most {@link MAX_FILMSTRIP}. `super present
 * <group>` and the window's "open all" both present these.
 */
export function groupPresentCards(g: Pick<SuperGroup, 'cards'>, containers: readonly Pick<SuperContainer, 'id'>[]): string[] {
  const known = new Set(containers.map((c) => c.id));
  return [...new Set(g.cards)].filter((id) => known.has(id)).slice(0, MAX_FILMSTRIP);
}

/** The group a presentation shows whole, if any: "back to the group" returns there. */
export function presentedGroup<G extends Pick<SuperGroup, 'id' | 'cards'>>(shown: readonly string[], groups: readonly G[], containers: readonly Pick<SuperContainer, 'id'>[]): G | undefined {
  if (shown.length < 2) return undefined;
  return groups.find((g) => sameCardSet(groupPresentCards(g, containers), shown));
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
  /** The app restarted mid-job: the server resumes it with a continue turn; it is not done. */
  resuming?: number;
  task?: string;
  stuckReason?: StuckReason;
  /** Why this child never started, in the server's words. */
  startError?: string;
  mode?: string;
  model?: string;
  effort?: string;
  /** The MCP servers it runs with (`delegate --mcp`): a delegated child is LEAN, only these. */
  mcp?: string[];
  /** The tool it runs on (`delegate --tool`); absent = Claude. */
  tool?: 'codex' | 'antigravity';
  /** `super end` closed it: no process, tab or card; `super resume` clears it. */
  endedAt?: number;
  /** The agenda (server-written): when its job last finished, and what the owner saw. */
  finishedAt?: number;
  seenAt?: number;
}

/** `waiting`: its turn ended on something only the owner can do (an `owner` item is open). */
export const CHILD_ROWS = ['working', 'asking', 'done', 'stuck', 'gone', 'waiting'] as const;
export type ChildRow = typeof CHILD_ROWS[number];
export const STUCK_REASONS = ['error', 'stale', 'no_start'] as const;
export type StuckReason = typeof STUCK_REASONS[number];

/** `approval`: an AI Team member the Super Agent chose is not approved here (server-written). */
/** `owner`: a child left something only the owner can do (a `run` card, a `secret`, a
 *  `checklist`): his from birth, closed when his answer reaches the child. */
/** `request`: a job main Super gave a member's Super (server-written, in the MEMBER's queue);
 *  `reply`: main Super's answer to a member's question (plan-r10 1, MIRROR of src/lib/super/types.ts). */
/** `member`: something the owner must answer in an AI Team member's own record, mirrored into
 *  main's queue (`member` the slug, `answers` its item, `of` that item's kind). */
/** `nudge`: the server's one turn into a member Super that stopped without closing its job or
 *  asking (never mirrored, never counted). `routine`: something a routine waits on the owner for,
 *  derived from disk (`routine` its slug, `fact` the fact, drawn by the routine's own title).
 *  An OWN item (`own`) is a question, permission or owner wait of the record's own session
 *  (MIRROR of src/lib/super/types.ts, uye-bildirim K1/K6/K7). */
export const QUEUE_KINDS = ['permission', 'question', 'done', 'gone', 'stuck', 'ask', 'recap', 'handover', 'ended', 'approval', 'fresh', 'owner', 'automation', 'request', 'reply', 'owed', 'restarted', 'schedule', 'member', 'nudge', 'routine', 'parked', 'owner-result'] as const;
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
  /** An `automation` item's automation slug and the owner's card decision (MIRROR of
   *  src/lib/super/types.ts). */
  automation?: string;
  decision?: 'approved' | 'rejected';
  /** An `owner` item's wait: the child's card he must act on; a refusal's refused call. */
  wait?: { kind: OwnerWaitKind; id: string; key?: string; refusal?: RefusalFact };
  /** A team job's ending item: the job's id (its `sessionId` is the super's own). */
  team?: string;
  /** A child's question shown to the owner from birth: his bar opens the child's chat, where its
   *  own card answers it (MIRROR of src/lib/super/types.ts `SuperQueueItem.direct`). */
  direct?: true;
  /** A Bypass child's permission its Super Agent decides first (MIRROR of src/lib/super/types.ts
   *  `SuperQueueItem.toSuper`): no owner head, count or alarm while it holds. */
  toSuper?: true;
  /** A Super `ask`'s report cards, read to answer it: his card points at them (MIRROR of
   *  src/lib/super/types.ts `SuperQueueItem.read`). */
  read?: string[];
  /** A `request`'s job or a `reply`'s answer; a request's per-job model, effort, light flag, its
   *  `team done` result and when its carrying turn ended; a reply's ask (MIRROR, plan-r10 1). */
  text?: string;
  model?: string;
  effort?: string;
  light?: true;
  result?: string;
  acceptedAt?: number;
  answers?: string;
  /** Whose work it is; absent = the owner's. */
  workOrigin?: SuperWorkOrigin;
  /** A `member` item: the kind of the member's item it mirrors. */
  of?: typeof MEMBER_OFS[number];
  /** An OWN item: the record's own session asks (answered through its own window). */
  own?: true;
  /** A `routine` item's routine slug, its fact on disk, and that it already rang once. */
  routine?: string;
  fact?: string;
  shown?: true;
  /** What a surface may offer (server-computed for a permission or a refusal, copied onto its
   *  mirror): draw exactly these sizes; absent = Allow once and Deny / Not needed only (MIRROR of
   *  src/lib/super/types.ts `SuperQueueItem.offer`). */
  offer?: GrantOffer;
  /** A `permission` item's call (tool and canonical input; `whole` false = cut), copied onto its
   *  `member` mirror: drawn whole before any Allow; absent = no Allow, only Open (MIRROR of
   *  src/lib/super/types.ts `SuperQueueItem.call`). */
  call?: { tool: string; input: string; whole: boolean };
  /** Already allowed at this size, waiting for the call to run: draw that line, no Allow buttons
   *  (MIRROR of src/lib/super/types.ts `SuperQueueItem.allowed`). */
  allowed?: GrantSize;
  /** A crew child's card wait: the record it stands for, drawn from the record, never from chat
   *  text (MIRROR of src/lib/super/types.ts `SuperQueueItem.card`). */
  card?: OwnerCardHandle;
  /** Telegram's Remind mark (MIRROR of `SuperQueueItem.remindAt`). */
  remindAt?: number;
  /** The slot's one true result line (MIRROR of `SuperQueueItem.delivery`). */
  delivery?: OwnerDeliveryState;
  /** An `owner-result` item's fact (MIRROR of `SuperQueueItem.ownerResult`). */
  ownerResult?: OwnerResultFact;
}

// ─── Owner cards done where the owner is (MIRROR of src/lib/super/types.ts, sahip-karti-yerinde
// K1-K7; pinned by tests/unit/owner-card-types.test.ts). The only import here is type-only and
// erased at build: the card spec is the chat's own (src/lib/chat-view-spec.ts). ─────────────

/** The owner-only card kinds (MIRROR of src/lib/super/owner-wait.ts `OWNER_CARD_KINDS`). */
export const OWNER_CARD_KINDS = ['run', 'secret', 'checklist', 'mcp'] as const;
export type OwnerCardKind = typeof OWNER_CARD_KINDS[number];

export type OwnerCardSpec = RunViewSpec | SecretViewSpec | ChecklistViewSpec | McpViewSpec;

/** The record an owner item stands for (MIRROR of `OwnerCardHandle`). */
export interface OwnerCardHandle {
  cardRef: string;
  postingSession: string;
  vault: string;
  postingConversationId: string;
  spec: OwnerCardSpec;
  childRecordId: string;
  childId: string;
  deliverTo: string;
}

export const OWNER_WAKE_OUTCOMES = ['woken', 'live', 'held:cap', 'held:no_window', 'held:phone', 'ended'] as const;
export type OwnerWakeOutcome = typeof OWNER_WAKE_OUTCOMES[number];

export const OWNER_DELIVERY_STATES = ['sent', 'waking', 'held:cap', 'held:no_window', 'held:phone', 'ended'] as const;
export type OwnerDeliveryState = typeof OWNER_DELIVERY_STATES[number];

export interface OwnerResultFact {
  card: OwnerCardKind;
  cardRef: string;
  outcome: number | null | 'submitted';
  text: string;
}

export const OWNER_RECEIPT_VIEW_STATES = ['held', 'running', 'kept', 'cut_off'] as const;
export type OwnerReceiptViewState = typeof OWNER_RECEIPT_VIEW_STATES[number];
/** A held receipt as the slot draws it (MIRROR of `OwnerReceiptView`): `kept` and `cut_off` are
 *  read-only plain text, never markdown. */
export interface OwnerReceiptView {
  id: string;
  cardRef: string;
  kind: OwnerCardKind;
  at: number;
  state: OwnerReceiptViewState;
  text: string;
}

export const CARD_TICKET_ACTIONS = ['start', 'attach', 'rerun'] as const;
export type CardTicketAction = typeof CARD_TICKET_ACTIONS[number];
export const CARD_TICKET_TTL_MS = 30_000;
export interface CardTicketMintRequest { session: string; card: string; action: CardTicketAction; shown: string }
export interface CardTicketMintResponse { ticket: string; expiresAt: number }

/** A refused tool call (MIRROR of src/lib/super/types.ts `RefusalFact`): `whole` false = the
 *  input was cut, and no grant may be offered for it. */
export const REFUSAL_SOURCES = ['classifier', 'rule', 'mode', 'bridge', 'unknown'] as const;
export type RefusalSource = typeof REFUSAL_SOURCES[number];
export interface RefusalFact {
  tool: string;
  input: string;
  whole: boolean;
  source: RefusalSource;
  category?: string;
  reason?: string;
  scriptSha?: string;
  interpreter?: { name: string; path: string };
  cwd?: string;
}

/** Owner answers and grants on the wire (MIRROR of src/lib/super/types.ts, uye-bildirim K3-K5). */
export const GRANT_SIZES = ['once', 'job', 'member'] as const;
export type GrantSize = typeof GRANT_SIZES[number];
export type OwnerAnswer =
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'permission'; behavior: 'allow' | 'deny'; size?: GrantSize }
  | { kind: 'refusal'; action: 'allow' | 'not_needed'; size?: GrantSize }
  | { kind: 'ask'; text: string }
  | { kind: 'dismiss' };
export const OWNER_ANSWER_VIAS = ['bar', 'chat', 'member-chat', 'phone', 'telegram'] as const;
export type OwnerAnswerVia = typeof OWNER_ANSWER_VIAS[number];
export interface OwnerAnswerRequest {
  record: string; item: string; answer: OwnerAnswer; via: OwnerAnswerVia;
  /** An Allow carries the call the surface DREW (its tool and input as shown), or `shownKey`, the
   *  `shownKeyOf` of it (Telegram keeps the key of what its card showed). The server allows only
   *  when it equals what it would allow now: the record is agent-writable, so a call rewritten
   *  between his look and his tap is refused as `changed`, never allowed unseen (G2). */
  shown?: { tool: string; input: string };
  shownKey?: string;
}
export type OwnerAnswerResult =
  | { ok: true; outcome: 'answered' | 'allowed' | 'allowed_waiting' | 'dismissed' }
  | { ok: false; error: 'already_answered' | 'not_found' | 'owner_page_only' | 'not_offered' | 'no_window' | 'invalid' | 'changed'; message: string };
export interface GrantOffer { sizes: GrantSize[]; onceOnlyReason?: string; notChecked?: string; rule?: string }
export interface PermissionRuleView { id: string; member: string; form: 'script'; rule: string; createdAt: number }

/** Which super a record, a token or a window verb belongs to (plan-r10 1): the project's own
 *  (`main`) or an AI Team member's (`m:<member slug>`). Absent anywhere = `main`. MIRROR of
 *  src/lib/super/types.ts. */
export type SuperId = 'main' | `m:${string}`;
export const MEMBER_SUPER_PREFIX = 'm:';
/** The member slug charset (src/lib/agents/types.ts `isSafeAutomationSlug`: lowercase letters,
 *  digits, single inner dashes, at most 100). The server's parser also refuses reserved slugs. */
const MEMBER_SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,99}$/;
/** A super id from the wire: absent / '' / `main` = main; `m:<slug>` = that member; else null. */
export function parseSuperId(raw: unknown): SuperId | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'main') return 'main';
  if (typeof raw !== 'string' || !raw.startsWith(MEMBER_SUPER_PREFIX)) return null;
  const slug = raw.slice(MEMBER_SUPER_PREFIX.length);
  return slug.length <= 100 && MEMBER_SLUG_RE.test(slug) ? `m:${slug}` : null;
}

/** Whose work a member Super's turn, child or question is (MIRROR of src/lib/super/types.ts). */
export type SuperWorkOrigin = 'owner' | 'routine' | `main:${string}`;

/** A member's Super: at most two live children; the vault-wide ceiling over every super. */
export const MAX_MEMBER_LIVE_CHILDREN = 2;
export const MAX_VAULT_LIVE_CHILDREN = 15;

/** One member in `GET /api/agent/sessions?summary=1` `members` (plan-r10 1, 1f; MIRROR of
 *  src/lib/super/types.ts `SuperMemberSummary`): owner and routine work only. */
export interface SuperMemberSummary {
  slug: string;
  global: boolean;
  enabled: boolean;
  ownerWorking: number;
  asking: boolean;
  approval: boolean;
  unread: number;
  superOnly: boolean;
  lastAt: number;
  /** Main's `request`/`reply` items still waiting for this member's Super to be attached: the
   *  window spawns a cold member's Super when above 0 and no live chat holds it. Not a count. */
  pending: number;
}

/** A Super verb the window runs, as its frame names it (MIRROR of src/lib/window-control.ts):
 *  `superId` absent = main's (a member's Super names itself). */
export interface SuperWindowCommand {
  id: string;
  verb: SuperWindowVerb;
  args: Record<string, unknown>;
  superId?: SuperId;
}

/** What an `owner` item waits on (MIRROR of src/lib/super/owner-wait.ts `OWNER_WAIT_KINDS`):
 *  `refusal` a refused tool call, `stalled` a member that stopped without finishing or asking. */
export const OWNER_WAIT_KINDS = ['run', 'secret', 'checklist', 'mcp', 'refusal', 'stalled'] as const;
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
  /** The model and effort the job runs on, and whether it is a light (read-only) job. */
  model?: string;
  effort?: string;
  light?: true;
  /** The owner asked for it through the super: its result goes to him. */
  awaited?: true;
  /** The last ending event already queued for the super. */
  told?: 'done' | 'stuck' | 'question';
  /** Which of its run's questions the `question` was. */
  toldQuestion?: string;
  /** Its ending is still owed to the super (watched). */
  open?: true;
  /** A stuck its watch concluded: the member left, or its turn was lost with the server. */
  concluded?: 'gone' | 'lost';
  /** A follow-up on the member's conversation: the root job it continues (no card of its own). */
  followUpOf?: string;
  /** `super`: the Super Agent asked the same member again (MIRROR of `SuperTeamJob.by`). */
  by?: 'super';
  /** A job given to the member's OWN Super (plan-r10 1, Wave 2): its `request` item's id there. */
  request?: string;
  /** Window-only, derived when the record is read (`teamChainOf`), never stored: the member's one
   *  card's whole story (plan-r10 1b). Set on a member's current root only. */
  chain?: TeamChain;
}

/** What a member's one card says beyond its root job: how many jobs it holds ("3 iş"), the newest
 *  one (its brief, model, whether it waits its turn) and the run before a rotation. */
export interface TeamChain {
  jobs: number;
  newest: Pick<SuperTeamJob, 'id' | 'brief' | 'model' | 'effort' | 'light' | 'queued' | 'startedAt'>;
  /** The member's previous root ("önceki konuşma"): its run, and its session when this Mac knows it. */
  previous?: { id: string; runId: string; sessionId?: string };
}

/**
 * A member's one card's chain (plan-r10 1b): every job of the member in the record (roots after a
 * rotation and their follow-ups), its newest job, and the root before the current one. `team` is
 * newest first, as the record keeps it. Pure.
 */
export function teamChainOf(team: readonly SuperTeamJob[], root: SuperTeamJob, prevSessionId?: string): TeamChain {
  const mine = team.filter((j) => j.member === root.member);
  const newest = mine[0] ?? root;
  const roots = mine.filter((j) => !j.followUpOf);
  const at = roots.findIndex((j) => j.id === root.id);
  const prev = at >= 0 ? roots[at + 1] : undefined;
  return {
    jobs: Math.max(1, mine.length),
    newest: {
      id: newest.id, brief: newest.brief, queued: newest.queued, startedAt: newest.startedAt,
      ...(newest.model ? { model: newest.model } : {}), ...(newest.effort ? { effort: newest.effort } : {}), ...(newest.light ? { light: true as const } : {}),
    },
    ...(prev ? { previous: { id: prev.id, runId: prev.runId, ...(prevSessionId ? { sessionId: prevSessionId } : {}) } } : {}),
  };
}

export const TEAM_JOB_STATUSES = ['queued', 'running', 'asking', 'done', 'failed'] as const;
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
  /** Children the record no longer holds, still the Super's: a chat window never shows them. */
  formerChildren?: string[];
  /** Children alive at turn-off: the owner's chats until the next hand-over (server types.ts). */
  released?: string[];
  formerAdopted?: string[];
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
  /** A member Super's record: its slug (absent = main's). */
  member?: string;
  /** A member Super's main-origin turns (the owner's unread skips them). Absent = none. */
  mainBatches?: string[];
  /** What the Super still owes the owner (server owed.ts): open debts and the newest closed. */
  owed?: SuperOwed[];
}

/** One thing the Super owes the owner. MIRRORS `SuperOwed` in src/lib/super/types.ts
 *  (super-types-mirror.test.ts): the agenda's "Cevaplanmadı" rows read it. */
export interface SuperOwed {
  id: string;
  kind: 'msg' | 'result';
  ref: string;
  parts?: string[];
  seq: number;
  at: number;
  item?: string;
  child?: string;
  team?: string;
  gist: string;
  sent?: string[];
  nudges: number;
  parked?: 'stop' | 'limit';
  parkedAt?: number;
  closed?: { at: number; by: 'mark' | 'owner' | 'takeback' };
}
/** Mirrors OWED_NUDGES and OWED_PARK_MS (server types.ts). */
export const OWED_NUDGES = 2;
export const OWED_PARK_MS = 10 * 60_000;
/** Shown on his agenda: nudged OWED_NUDGES times, or parked by his Stop or a limit for
 *  OWED_PARK_MS. MIRRORS `owedVisible` in src/lib/super/owed.ts. */
export function owedVisible(d: Pick<SuperOwed, 'nudges' | 'parked' | 'parkedAt' | 'closed'>, now = Date.now()): boolean {
  if (d.closed !== undefined) return false;
  if (d.nudges >= OWED_NUDGES) return true;
  return !!d.parked && d.parkedAt !== undefined && now - d.parkedAt >= OWED_PARK_MS;
}
/** The earliest moment a parked debt becomes visible, after `now`. MIRRORS owed.ts. */
export function nextOwedReveal(owed: readonly Pick<SuperOwed, 'nudges' | 'parked' | 'parkedAt' | 'closed'>[] | undefined, now = Date.now()): number | null {
  let at: number | null = null;
  for (const d of owed ?? []) {
    if (d.closed !== undefined || d.nudges >= OWED_NUDGES || !d.parked || d.parkedAt === undefined) continue;
    const t = d.parkedAt + OWED_PARK_MS;
    if (t > now && (at === null || t < at)) at = t;
  }
  return at;
}
/** A debt as the window reads it from a push or a digest: checked, the rest dropped. */
export function readOwed(raw: unknown, max = 200): SuperOwed[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperOwed[] = [];
  for (const d of raw) {
    if (out.length >= max) break;
    if (!isRecord(d) || typeof d.id !== 'string' || (d.kind !== 'msg' && d.kind !== 'result') || typeof d.ref !== 'string') continue;
    if (typeof d.seq !== 'number' || typeof d.at !== 'number' || typeof d.gist !== 'string' || typeof d.nudges !== 'number') continue;
    const o: SuperOwed = { id: d.id, kind: d.kind, ref: d.ref, seq: d.seq, at: d.at, gist: d.gist, nudges: d.nudges };
    if (d.parked === 'stop' || d.parked === 'limit') { o.parked = d.parked; if (typeof d.parkedAt === 'number') o.parkedAt = d.parkedAt; }
    if (Array.isArray(d.sent)) o.sent = d.sent.filter((x): x is string => typeof x === 'string');
    if (isRecord(d.closed) && typeof d.closed.at === 'number' && (d.closed.by === 'mark' || d.closed.by === 'owner' || d.closed.by === 'takeback')) o.closed = { at: d.closed.at, by: d.closed.by };
    if (typeof d.item === 'string') o.item = d.item;
    if (typeof d.child === 'string') o.child = d.child;
    out.push(o);
  }
  return out;
}

/** The agenda notepad (owner 2026-10-22 19:15): lines the super agent writes itself, in three
 *  sections. Not a mirror of its children. */
export const PAD_SECTIONS = ['now', 'waiting', 'done'] as const;
export type PadSection = typeof PAD_SECTIONS[number];
export interface SuperPadItem {
  id: string; section: PadSection; text: string; at: number;
  /** The job (child session id) the line follows; `by` who last moved it when not the super. */
  for?: string; by?: 'auto' | 'owner'; why?: PadAutoWhy; toldAt?: number;
}
export const PAD_AUTO_WHY = ['done', 'ended', 'gone', 'answered'] as const;
export type PadAutoWhy = typeof PAD_AUTO_WHY[number];
/** A Now line with no job behind it, unchanged this long, is stale (the card flags it). */
export const PAD_STALE_MS = 2 * 60 * 60 * 1000;
export const MAX_PAD = 40;
export const MAX_PAD_TEXT = 160;
/** The owner wrote about one agenda line: the header his message opens with (MIRRORED from the
 *  server, `src/lib/super/types.ts`, pinned by super-types-mirror.test.ts). */
export const ABOUT_AGENDA_RE = /^\[About agenda line (note|item|owed)=([A-Za-z0-9_-]{1,40}) section=(waiting|now|done|unanswered)\]/;
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
/**
 * A passage he selected and commented on (owner 2026-10-31). In a message it is that message's
 * `[Reply to message …]` header with the passage as `quote:` (a passage may run longer than the
 * first words a ↩ quotes); on a stage card it is this header, then the same `quote:` line. The
 * quote is what the page showed him: data, never his instruction. Not `[super `.
 */
export const ABOUT_CARD_RE = /^\[About card @card:([A-Za-z0-9_-]{1,64})\]/;
/** The task a member stage's strip is about (plan-r10 1c): the header alone, no second line. The
 *  task-slug charset, no 64 cap (slugs reach ~100 characters). Never closes an open ask. */
export const ABOUT_TASK_RE = /^\[About task ([a-z0-9][a-z0-9-]{0,251})\]/;
export const MAX_SELECTION_QUOTE = 1000;

/** A hidden technical ceiling on references (agenda lines, replied messages) in one owner
 *  message, so a malformed or hostile message cannot make the parser walk without bound; a
 *  header past it is plain text. Owner 2026-11-04: he never sees a limit, so it sits far above
 *  any real message and no surface ever names it. */
export const MAX_MESSAGE_REFS = 100;
/** One reference header in an owner message: what it names, where it starts, and where its
 *  block (the header and its `line:`/`quote:` line) ends. */
export interface AboutHead { kind: 'note' | 'item' | 'owed' | 'reply' | 'card' | 'task'; id: string; at: number; end: number }

/**
 * Every reference header in an owner message, in order (owner 2026-10-24: several references in
 * one message). One rule on both sides of the wire: a header counts only at offset 0 or right
 * after a blank line (`\n\n`); a note's header must be followed by its well-formed `line:` JSON
 * line, a reply's and a card's by its `quote:` line; an item's header has no second line; and the block
 * ends the text or a line. Anything else is plain text. At most MAX_MESSAGE_REFS (hidden). MIRRORED in
 * dashboard/src/lib/superTypes.ts (super-types-mirror.test.ts).
 */
export function aboutHeads(text: string): AboutHead[] {
  const out: AboutHead[] = [];
  if (typeof text !== 'string') return out;
  const starts = [0];
  for (let i = text.indexOf('\n\n'); i >= 0; i = text.indexOf('\n\n', i + 1)) starts.push(i + 2);
  for (const at of starts) {
    if (out.length >= MAX_MESSAGE_REFS) break;
    const s = text.slice(at);
    const a = ABOUT_AGENDA_RE.exec(s);
    const c = a ? null : ABOUT_CARD_RE.exec(s);
    const t = a || c ? null : ABOUT_TASK_RE.exec(s);
    const r = a || c || t ? null : REPLY_TO_RE.exec(s);
    if (!a && !c && !t && !r) continue;
    const kind = a ? (a[1] as 'note' | 'item' | 'owed') : c ? 'card' : t ? 'task' : 'reply';
    let len = (a ?? c ?? t ?? r as RegExpExecArray)[0].length;
    const second = /^\n(line|quote): ([^\n]*)/.exec(s.slice(len));
    if (kind === 'item' || kind === 'owed' || kind === 'task') {
      if (second?.[1] === 'line') continue;
    } else {
      if (!second || second[1] !== (kind === 'note' ? 'line' : 'quote')) continue;
      try { if (typeof JSON.parse(second[2]) !== 'string') continue; } catch { continue; }
      len += second[0].length;
    }
    if (len < s.length && s[len] !== '\n') continue;
    out.push({ kind, id: a ? a[2] : (c ?? t ?? r as RegExpExecArray)[1], at, end: at + len });
  }
  return out;
}

/** Each part's reference, in order, for a message with two or more parts (`aboutHeads`): the
 *  message reference with `#<i>` hashed again. [] for a message with one part or none, whose
 *  sections the super marks with the message reference as before. MIRRORED in the window. */
export function partRefs(text: string, baseRef?: string): string[] {
  const n = aboutHeads(text).length;
  if (n < 2) return [];
  const base = baseRef && /^[0-9a-z]{6}$/.test(baseRef) ? baseRef : msgRef(text);
  return Array.from({ length: n }, (_, i) => msgRef(`${base}#${i + 1}`));
}
/**
 * The page the owner wrote from (super dock, owner 2026-10-25): a message sent from the dock
 * ends with this block as its WHOLE last paragraph (`\n\n` + the block, end of text), so the
 * About/Reply heads at the start still match. A reference to what he looked at, never an
 * instruction. MIRRORED from the server, src/lib/super/types.ts (super-types-mirror.test.ts).
 */
export const PAGE_CONTEXT_RE = /\n\n\[On page ([a-z][a-z-]{0,31})(?: view="([^"\]\n]{1,60})")?(?: filters=([0-9]{1,3}))?(?: board=([a-z0-9][a-z0-9-]{0,63}))?(?: insight=([a-z0-9][a-z0-9-]{0,63}))?\]$/;
export const MAX_PAGE_VIEW = 60;
export interface PageContextRef { page: string; view?: string; filters?: number; board?: string; insight?: string }
const PAGE_ID_RE = /^[a-z][a-z-]{0,31}$/;
const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The block for a page, or '' when the page is not a page id. A field that is not clean is left out. */
export function pageContextBlock(ctx: PageContextRef | null | undefined): string {
  if (!ctx || !PAGE_ID_RE.test(ctx.page)) return '';
  let out = `[On page ${ctx.page}`;
  const view = typeof ctx.view === 'string' ? ctx.view.replace(/[\u0000-\u001f\u007f"\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_VIEW).trim() : '';
  if (view) out += ` view="${view}"`;
  if (typeof ctx.filters === 'number' && Number.isInteger(ctx.filters) && ctx.filters > 0 && ctx.filters < 1000) out += ` filters=${ctx.filters}`;
  if (typeof ctx.board === 'string' && PAGE_SLUG_RE.test(ctx.board)) out += ` board=${ctx.board}`;
  if (typeof ctx.insight === 'string' && PAGE_SLUG_RE.test(ctx.insight)) out += ` insight=${ctx.insight}`;
  return `${out}]`;
}
/** A message's words and the page block it ends with (null: none, the text is unchanged). */
export function splitPageContext(text: string): { text: string; page: PageContextRef | null } {
  const raw = text ?? '';
  const m = PAGE_CONTEXT_RE.exec(raw);
  if (!m) return { text: raw, page: null };
  const page: PageContextRef = { page: m[1] };
  if (m[2]) page.view = m[2];
  if (m[3]) page.filters = Number(m[3]);
  if (m[4]) page.board = m[4];
  if (m[5]) page.insight = m[5];
  return { text: raw.slice(0, m.index), page };
}
/** The super's mark on an answer's first line, `<!-- re:<ref> -->` (lib/replyMark.ts parses it). */
export const REPLY_MARK_RE = /^\s*<!--\s*re:([^\n>]*?)-->[ \t]*(?:\r?\n)?/;
export const REPLY_MARK_HEAD_MAX = 120;
/** A mark line keeps its newline when the next line is another mark, so marks stacked one per
 *  line (a section answering several parts, rev 12) are each read; one would otherwise eat the
 *  newline the next one starts with. */
export const REPLY_MARK_LINE_RE = /(^|\n)[ \t]*<!--\s*re:([^\n>]*?)-->[ \t]*(?:\r?\n(?![ \t]*<!--\s*re:))?/g;

export interface SuperStateView extends SuperState {
  vault: string;
  /** Each AI Team job on the stage (a `team` card): its status and last line, read now from the
   *  member's thread. Absent when no team card is open. */
  teamLive?: Record<string, { status: TeamJobStatus; lastLine: string; sessionId?: string; resumable?: boolean; prevSessionId?: string }>;
  /** Queue items whose banner the server posted (lib/super/owner-question.ts): the job bar posts
   *  no second one. Absent: none. */
  bannered?: string[];
  /** The super's pane is rotating into a fresh session ("New session"). Absent: false. */
  rotating?: boolean;
  /** Events have waited undelivered for a few minutes: why, and since when (ms). Absent: no. */
  blocked?: { reason: string; since: number };
}

export const SUPER_WINDOW_VERBS = ['delegate', 'answer', 'resume', 'allow'] as const;
export type SuperWindowVerb = typeof SUPER_WINDOW_VERBS[number];

export const SUPER_EVENT_PREFIXES = ['[super event]', '[super recap]', '[super handover]', '[super events]', '[super fresh]', '[super owed]', '[super schedule]'] as const;

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
    groups.push({ id: g.id, name: cleanGroupName(g.name) || nextGroupName(groups), cards, place, ...(pos ? { pos } : {}), ...(g.keptBy === 'owner' ? { keptBy: 'owner' as const } : {}) });
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
/** The member items a `member` mirror stands for (MIRROR of src/lib/super/types.ts MEMBER_ITEM_OF). */
export const MEMBER_OFS = ['ask', 'question', 'permission', 'owner', 'approval'] as const;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** A pushed view, or `float` when it names no card this state holds. */
function readView(v: unknown, containers: readonly SuperContainer[]): SuperView {
  const ids = new Set(containers.map((c) => c.id));
  if (!isRecord(v) || !oneOf(VIEW_MODES, v.mode)) return { mode: 'float' };
  if (v.mode === 'half') {
    if (typeof v.card !== 'string' || !ids.has(v.card)) return { mode: 'float' };
    if (v.auto === true) return { mode: 'half', card: v.card, auto: true };
    // The owner's mark: a new presentation of the agent's is told apart from his own (SuperSurface).
    return v.by === 'owner' ? { mode: 'half', card: v.card, by: 'owner' } : { mode: 'half', card: v.card };
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
  const read = (Array.isArray(v.team) ? v.team : []).filter((j): j is SuperTeamJob =>
    isRecord(j) && typeof j.id === 'string' && typeof j.member === 'string' && typeof j.runId === 'string'
    && typeof j.brief === 'string' && typeof j.startedAt === 'number' && typeof j.queued === 'boolean'
    && (j.jobKind === 'run' || j.jobKind === 'reply'));
  // A member's one card (plan-r10 1b): the root its card shows carries the chain, only when there
  // is more than the root itself to say (a follow-up, or a root before it).
  const shownRoots = new Set(containers.filter((c) => c.kind === 'team').map((c) => c.ref));
  const liveRows = isRecord(v.teamLive) ? v.teamLive as Record<string, unknown> : {};
  const team = read.map((j) => {
    if (!shownRoots.has(j.id) || j.followUpOf) return j;
    const row = liveRows[j.id];
    const prevSession = isRecord(row) && typeof row.prevSessionId === 'string' ? row.prevSessionId : undefined;
    const chain = teamChainOf(read, j, prevSession);
    return chain.jobs > 1 || chain.previous ? { ...j, chain } : j;
  });
  // Each team card's status now: only a known job, a known status and a string line survive.
  let teamLive: SuperStateView['teamLive'];
  if (isRecord(v.teamLive)) {
    teamLive = {};
    for (const j of team) {
      const row = (v.teamLive as Record<string, unknown>)[j.id];
      if (isRecord(row) && oneOf(TEAM_JOB_STATUSES, row.status) && typeof row.lastLine === 'string') teamLive[j.id] = { status: row.status, lastLine: row.lastLine, ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}), ...(row.resumable === true ? { resumable: true } : {}), ...(typeof row.prevSessionId === 'string' ? { prevSessionId: row.prevSessionId } : {}) };
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
  const mainBatches = Array.isArray(v.mainBatches) ? v.mainBatches.filter((b): b is string => typeof b === 'string') : [];
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
    ...(Array.isArray(v.formerChildren) ? { formerChildren: v.formerChildren.filter((x): x is string => typeof x === 'string') } : {}),
    ...(Array.isArray(v.released) ? { released: v.released.filter((x): x is string => typeof x === 'string') } : {}),
    ownerBatches,
    ...(mainBatches.length ? { mainBatches } : {}),
    ...(typeof v.member === 'string' && v.member ? { member: v.member } : {}),
    ...(held.length ? { held } : {}),
    ...(pad.length ? { pad } : {}),
    ...(Array.isArray(v.owed) && readOwed(v.owed).length ? { owed: readOwed(v.owed) } : {}),
    team,
    ...(teamLive ? { teamLive } : {}),
    ...(Array.isArray(v.bannered) ? { bannered: v.bannered.filter((b): b is string => typeof b === 'string') } : {}),
    // The pane is rotating into a fresh session ("New session"): absent or not `true` = false.
    ...(v.rotating === true ? { rotating: true } : {}),
    // Events waiting undelivered for minutes: why and since when. Any other shape = absent.
    ...(isRecord(v.blocked) && typeof v.blocked.reason === 'string' && typeof v.blocked.since === 'number'
      ? { blocked: { reason: v.blocked.reason, since: v.blocked.since } } : {}),
  };
}

// ─── The phone's agenda digest (src/lib/super/phone-mirror.ts `superDigest`) ───────────

/** Mirrors `SUPER_DIGEST_FIELDS` in src/lib/super/phone-mirror.ts (super-types-mirror test). */
export const SUPER_DIGEST_FIELDS = ['pad', 'waiting', 'ownerBatches', 'mainBatches', 'names', 'owed', 'key'] as const;

/** What a phone mirror is told of the Super Agent's agenda (a `super_digest` frame): enough to
 *  draw the desktop's `SuperAgenda` and fold the event turns, never the record. */
export interface SuperDigestWire {
  pad: SuperPadItem[];
  /** Open with the owner, or queued behind an open question. `text`: the item's `ownerText`
   *  (plain text; an `owner` item's is a child's card, untrusted), '' on a permission. */
  waiting: Array<{ id: string; kind: QueueKind; state: QueueState; createdAt: number; sessionId: string; text: string; member?: string; of?: SuperQueueItem['of'];
    /** An `owner` item's wait kind, or a mirror's whose `of` is `owner` (a refusal, a stall, a card). */
    wait?: OwnerWaitKind;
    /** A `routine` item's routine slug. */
    routine?: string;
    /** An own item: the record's own session asks. */
    own?: true;
    /** The member's title on a mirror, the routine's title on a routine item (flattened, at most
     *  DIGEST_MAX_TITLE characters): the phone names the row by it. Absent = name it by the slug. */
    title?: string }>;
  ownerBatches: string[];
  /** A member Super's main-origin turns (the phone's unread skips them, plan-r10 1). Absent in a
   *  digest from an older server. */
  mainBatches?: string[];
  /** Child session id → the Mac's job card title. */
  names: Record<string, string>;
  /** The open debts (server owed.ts), read only. Absent in a digest from an older server. */
  owed?: SuperOwed[];
  key: string;
}

/** The most of a member's or a routine's title a digest row carries (phone-mirror.ts caps it the same). */
export const DIGEST_MAX_TITLE = 80;
/** A title as a remote screen draws it: one line, no control or line-separator characters, capped. */
function digestTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, DIGEST_MAX_TITLE).join('').trim();
}

/** A `super_digest` frame's body, or null when it is not one. Drops what it does not know. */
export function readSuperDigest(v: unknown): SuperDigestWire | null {
  if (!isRecord(v) || typeof v.key !== 'string' || !v.key) return null;
  const pad = Array.isArray(v.pad) ? v.pad.filter((p): p is SuperPadItem => isRecord(p) && typeof p.id === 'string'
    && oneOf(PAD_SECTIONS, p.section) && typeof p.text === 'string' && p.text !== '' && typeof p.at === 'number').slice(0, 40) : [];
  const waiting = Array.isArray(v.waiting) ? v.waiting.filter((q): q is SuperDigestWire['waiting'][number] => isRecord(q)
    && typeof q.id === 'string' && oneOf(QUEUE_KINDS, q.kind) && oneOf(QUEUE_STATES, q.state)
    && typeof q.createdAt === 'number' && typeof q.sessionId === 'string' && typeof q.text === 'string').slice(0, 40) : [];
  const ownerBatches = Array.isArray(v.ownerBatches) ? v.ownerBatches.filter((b): b is string => typeof b === 'string').slice(-50) : [];
  const mainBatches = Array.isArray(v.mainBatches) ? v.mainBatches.filter((b): b is string => typeof b === 'string').slice(-50) : [];
  const names: Record<string, string> = {};
  if (isRecord(v.names)) {
    for (const [sid, name] of Object.entries(v.names).slice(0, 40)) if (typeof name === 'string' && name) names[sid] = name;
  }
  return {
    // `for` and `by` roll a day over and flag a stale line on the phone as the desktop does.
    pad: pad.map((p) => ({
      id: p.id, section: p.section, text: p.text, at: p.at,
      ...(typeof p.for === 'string' && p.for ? { for: p.for } : {}),
      ...(p.by === 'auto' || p.by === 'owner' ? { by: p.by } : {}),
    })),
    waiting: waiting.map((q) => ({
      id: q.id, kind: q.kind, state: q.state, createdAt: q.createdAt, sessionId: q.sessionId, text: q.text,
      ...(q.kind === 'member' && typeof q.member === 'string' && q.member ? { member: q.member.slice(0, 64) } : {}),
      ...(q.kind === 'member' && oneOf(MEMBER_OFS, q.of) ? { of: q.of } : {}),
      // Each new field only on the kind that can carry it, so a hostile row cannot dress a
      // question as a refusal or a routine.
      ...((q.kind === 'owner' || (q.kind === 'member' && q.of === 'owner')) && oneOf(OWNER_WAIT_KINDS, q.wait) ? { wait: q.wait } : {}),
      ...(q.kind === 'routine' && typeof q.routine === 'string' && MEMBER_SLUG_RE.test(q.routine) ? { routine: q.routine } : {}),
      ...(q.own === true && (q.kind === 'question' || q.kind === 'permission' || q.kind === 'owner') ? { own: true as const } : {}),
      ...((q.kind === 'member' || q.kind === 'routine') && digestTitle(q.title) ? { title: digestTitle(q.title) } : {}),
    })),
    ownerBatches, mainBatches, names,
    // Checked and capped; only open ones travel (the phone draws and never drops them).
    ...(Array.isArray(v.owed) ? { owed: readOwed(v.owed, 40).filter((d) => d.closed === undefined) } : {}),
    key: v.key,
  };
}
