/**
 * The hand-over stage, pure (plan-r8 F4 + §0 C1/C2/D1, owner decisions O1-O8, stage v2, the
 * 2026-10-20 redesign): the Super Agent's window EXACTLY in the centre and the larger share of the
 * stage, every other card a small 1:1 tile on an ORBIT around it (a side's tiles on an arc, the
 * middle one standing out, the ends tucked in toward the centre), groups drawn as one tile, an
 * "Others" stack bottom-right, the queue pill above the centre and the terminals dock
 * bottom-left. `half` puts one card beside the centre, `present` shows 1-8 cards in a named layout
 * (spotlight, compare, grid, filmstrip, review; compare and grid move the centre to a left column,
 * the other three shrink it to a mini chat bottom-left); a narrow stage puts every card in Others
 * and opens a presentation as a sheet over a composer bar.
 *
 * `planStage` turns the record (cards, view) and the stage's size into a rect for everything
 * the window draws. The window positions cards absolutely from it and the layout motion reads
 * its LAST rects from it, so the screen, the motion and these numbers never disagree.
 *
 * Coordinates are the stage's own (origin = its top-left), in CSS px.
 *
 * Card sizes (owner 2026-10-22, "like Apple widgets"): a floating card may be medium (2×1 tiles),
 * large (2×2) or wide (3×2). A stage of small cards only is laid out exactly as before (pinned
 * by a snapshot); one sized card switches the float pass to `solveSized`, where the sides share
 * the room the chat leaves (its width comes from the stage alone, owner 2026-11-06) and the chat
 * steps off the middle only as far as a wide side needs. A size
 * that does not fit is DRAWN smaller (the plan's `size`), the record is never touched.
 */
import {
  CONTAINER_SIZES, MAX_CONTAINERS, MAX_FILMSTRIP, MAX_PRESENT, PRESENT_LAYOUTS, SIZE_UNITS, applyGroupOp, applyOwnerViewFields, dissolveGroups,
  leaveGroups, normalizeGroups, presentRange, resolvePresent, viewWithout,
  type ContainerShape, type ContainerSize, type GroupOp, type OwnerViewFields, type PresentLayout, type SuperContainer, type SuperGroup, type SuperState, type SuperView,
} from '../../../lib/superTypes';

export interface Rect { x: number; y: number; width: number; height: number }

/** Every constant of the stage, in one place (tested by invariants, not pixels). */
export const STAGE = {
  /** Outer margin, and the one gap between the centre, every card and every column (O1). */
  MARGIN: 24,
  GAP: 24,
  /** The two thin bands above and below the centre: the job bar on top, dock + Others below.
   *  Side cards keep both; the floating chat gives up each one unless it holds something (the
   *  queue pill on top; the terminals' dock or the first-run hint below): no band is decoration
   *  (owner 2026-10-21, 2026-11-01). */
  BAND: 40,
  /** The queue pill's widest: no card is ever in the top band, so it may outgrow the centre and
   *  keep one row (a who, the text, two or three buttons) inside the band. */
  QUEUE_MAX: 720,
  /** A floating card is ONE 1:1 tile this wide, whatever it shows (owner 2026-10-20: small square
   *  cards; the stage v2 3:4 cards stood half empty). A group is one tile too. */
  TILE: 160,
  /** The orbit (owner 2026-10-20): how far the middle of a side's arc stands out from its ends,
   *  at most; never more than the side's free room. */
  ORBIT_DEPTH: 112,
  /** The centre's share of the stage: put whatever opens or closes. */
  CENTRE_FRAC: 0.56,
  /** From this share up, the chat leaves two columns on each side (owner 2026-11-06). */
  FOUR_COLS_FRAC: 0.53,
  CENTRE_MIN: 560,
  CENTRE_MAX: 1120,
  /** Columns per side: an outer one only once the inner one is full and the side has the room. */
  MAX_COLS: 2,
  /** `present`: the centre's left column. */
  PRESENT_FRAC: 0.34,
  /** The rail's one-line job card (a status dot in a ~44 px strip, owner 2026-10-31: "save width,
   *  not height"), the gap between two, and the stage width under which a presentation is tight
   *  enough to use it. */
  MINI_RAIL_W: 44,
  /** What the one-line rail took before it became a strip: the cards keep laying out against it,
   *  so the strip's saving goes to the chat and the presented cards do not shrink. */
  MINI_RAIL_W_WIDE: 124,
  MINI_RAIL_H: 40,
  MINI_RAIL_GAP: 8,
  MINI_RAIL_STAGE: 1560,
  /** The chat's floor beside cards or a page (owner 2026-10-28: "a comfortable minimum width",
   *  its head keeps one row with Agenda and New session); the cards' region keeps it too. */
  PRESENT_MIN: 480,
  /** The page's (or the presented cards' region's) floor beside the chat when live jobs share the row. */
  REGION_MIN: 400,
  PRESENT_MAX: 560,
  /** The Others drop target in the bottom-right corner (lit during a drag), and the stack. */
  OTHERS_ZONE_W: 168,
  OTHERS_ZONE_H: 128,
  OTHERS_W: 172,
  /** The narrowest the Others stack (and the agenda's pill) may be drawn so it fits BESIDE the
   *  centre and the centre keeps the stage's height (owner 2026-10-28, a windowed app). */
  OTHERS_MIN_W: 128,
  /** The minimised agenda's pill in the bottom-left corner (owner 2026-10-22 23:44), mirroring
   *  the Others stack; the terminals dock starts after it. */
  AGENDA_PILL_W: 172,
  /** A narrow stage's sheet sits this far inside the centre. */
  SHEET_INSET: 16,
  /** Spotlight, filmstrip, review: the agent's chat is a mini square bottom-left of the content,
   *  this share of the stage, clamped. */
  MINI_FRAC_W: 0.24,
  MINI_MIN_W: 300,
  MINI_MAX_W: 380,
  MINI_FRAC_H: 0.46,
  MINI_MIN_H: 320,
  MINI_MAX_H: 460,
  /** The chat folded to its composer bar (and a narrow sheet's composer under it): the chat's
   *  whole composer card (its field and its row of controls), nothing else of the chat. */
  CHAT_BAR_H: 128,
  /** Filmstrip: the strip of thumbs under the big card; a thumb at most this wide. */
  STRIP_H: 112,
  THUMB_MAX_W: 168,
  /** A thumb never narrower than this: more cards than fit scroll (owner 2026-10-29). */
  THUMB_MIN_W: 120,
  /** The strip's scroll buttons at its two ends, while it holds more than fit. */
  STRIP_NAV_W: 32,
  /** Review: the row of the child's own cards under its page. */
  REVIEW_ROW_FRAC: 0.34,
  REVIEW_ROW_MIN: 200,
  REVIEW_ROW_MAX: 320,
  /** A phone stage's queue pill: this far from the edges and the chat under it. */
  PHONE_BAND_INSET: 8,
  /** A narrow sheet's tab row (2+ cards). */
  TAB_H: 36,
  /** The top band's presentation controls at its right end: the exit, and one segment per layout
   *  the switcher offers (none for a single choice). */
  EXIT_W: 132,
  /** An opened group's two text buttons (close group, minimize) take the exit's place. */
  GROUP_EXIT_W: 232,
  SWITCH_SEG_W: 96,
  /** A card's own chrome around what it shows: the 1 px border on each side and the 36 px header
   *  (SuperSurface.css `.super-card-clip`, `.super-card-head`; drift-tested). A picture card in
   *  compare/grid is shrunk to its picture plus this (owner 2026-10-24). */
  CARD_CHROME: { w: 2, h: 38 },
  /** A fitted picture card's smallest: the header's buttons and the title still fit. An
   *  arrangement whose slots are under it is not offered (today's always is). */
  FIT_MIN: { w: 200, h: 140 },
  /** A web card's widget border around its page (widgets.css `.wb-widget`): a measured page is
   *  given exactly its width. */
  WIDGET_BORDER_W: 2,
} as const;

/**
 * The floating cards' band in the stage's ONE stacking order (SuperSurface.css `--sz-cards` and
 * `--sz-dock`; drift-tested). A card's plan z is its record order, +MAX_CONTAINERS when the owner
 * placed it, +2 x MAX_CONTAINERS and its turn for the one he moved last: always under the agenda's
 * slot, the band's highest but one (owner 2026-10-23: above ordinary stage cards, under anything
 * opened over the stage: a group's panel, Others, a sheet, a dragged card).
 */
export const CARD_Z_BASE = 10;
export const CARD_Z_SPAN = 290;
export function cardZIndex(z: number, agenda = false): number {
  // The band's last slot is left to the Others drop corner (--sz-dock-zone): the agenda is under it.
  const slot = agenda ? CARD_Z_SPAN - 2 : Math.min(Math.max(0, Math.round(z)), CARD_Z_SPAN - 3);
  return CARD_Z_BASE + slot;
}

/** Below this stage width every card is drawn in Others and side by side opens as a sheet (§0 C2). */
export const NARROW_STAGE_PX = 1040;
/** The same line on a remote touch screen (hands-free sekmeler W2): a 1024×768 landscape tablet
 *  with the rail folded has a 968 px stage, which floats its cards like the Mac (owner's 7a). */
export const TOUCH_REMOTE_NARROW_STAGE_PX = 940;
/** …and its centre's floor: 560 px would leave a 968 px stage 156 px a side, under one tile, and
 *  every card would still land in Others; 480 leaves each side room for a column of tiles. */
export const TOUCH_REMOTE_CENTRE_MIN = 480;
/** Below this stage width the floating view is the chat alone, edge to edge (owner 2026-10-31):
 *  no margins, no card chrome, and Others opens from the chat's head instead of a pill under it. */
export const PHONE_STAGE_PX = 640;

/** Where a card is drawn this time (its record may say otherwise: overflow is drawn, not written). */
export type CardWhere = 'float' | 'others' | 'half' | 'present' | 'sheet' | 'thumb' | 'tab';

/** How the agent's chat is drawn: the centre window, the mini square, or its composer bar. */
export type ChatDraw = 'column' | 'mini' | 'bar';

export interface CardPlan {
  id: string;
  rect: Rect;
  where: CardWhere;
  /** The shape it is DRAWN in: a floating tile is always 'square'; a large view keeps the record's. */
  shape: ContainerShape;
  /** A floating card: the size it is DRAWN at (its record's, or smaller when that does not fit). */
  size?: ContainerSize;
  /** Placed by the owner's drop (or held by a running drag), not by the stage. */
  owner: boolean;
  /** Paint order: record order, owner-placed cards above the auto-placed ones (the window lifts
   *  the card dropped last on top of those for the session). */
  z: number;
  /** A filmstrip thumb scrolled out of the strip's window: drawn nowhere until scrolled back. */
  hidden?: boolean;
  /** A rail job drawn as one line (status and short name) on a tight presentation. */
  mini?: boolean;
  /** Presented at its page's own width (StageItem.fit): the page is laid out in the card, never
   *  at the desktop width and scaled down to it. */
  fitted?: boolean;
}

/** A filmstrip's strip (owner 2026-10-29: "every time I select one, it swaps places"): every
 *  presented card has ONE slot, in the order presented, the big one's included; selecting never
 *  reorders. More than fit: a window of `visible` slots from `start`, scrolled by the window. */
export interface StripPlan {
  rect: Rect;
  big: string;
  /** Every card of the strip, in its fixed order. */
  ids: string[];
  /** The first slot shown, and how many show at once. */
  start: number;
  visible: number;
  /** The big card's own slot, marked (absent while scrolled out of view). */
  current?: Rect;
  /** The scroll buttons' rects, while the strip holds more than fit. */
  prev?: Rect;
  next?: Rect;
}

export interface StagePlan {
  width: number;
  height: number;
  narrow: boolean;
  /** The edge-to-edge chat of a phone-width floating stage ({@link PHONE_STAGE_PX}): Others and
   *  the agenda are reached from the chat's head, so neither draws its pill. */
  phone: boolean;
  /** No room beside the chat (owner 2026-11-01: a pill must not cost the chat its height): Others
   *  is its button in the chat's head, the same panel. */
  othersInHead: boolean;
  /** The same for the minimised agenda: its pill is not drawn, the head's Agenda button stands in. */
  agendaInHead: boolean;
  mode: SuperView['mode'];
  centre: Rect;
  cards: Record<string, CardPlan>;
  /** Cards drawn in the Others stack, in record order. */
  others: string[];
  othersRect: Rect;
  othersZone: Rect;
  /** The minimised agenda's pill, bottom-left (drawn only while it is minimised). */
  agendaPill: Rect;
  /** The agenda drawn as that pill (its id), or null: it flies there and back like a card to Others. */
  pill: string | null;
  queue: Rect;
  dock: Rect;
  /** The free area an owner's `pos` is a fraction of (the stage minus margins and bands). */
  free: Rect;
  centreWidth: number;
  /** Card width per side (0 for an empty side): both sides share one width. */
  unit: { left: number; right: number };
  /** Card ids in record order (the hand-over flights' stagger order). */
  order: string[];
  /** Each side's orbit, for the faint path drawn through its inner column (none on a side
   *  with fewer than two tiles there). */
  orbit: OrbitArc[];
  /** `present` only: the layout drawn; null otherwise. */
  layout: PresentLayout | null;
  /** How the agent's chat is drawn (the centre rect is its rect). */
  chat: ChatDraw;
  /** A narrow sheet of 2+ cards (not a filmstrip): its tab row and the cards in tab order; the
   *  selected one is drawn `sheet`, the rest `tab` (kept, not shown). */
  tabs?: { rect: Rect; ids: string[] };
  /** Filmstrip: the strip under the big card, and which card is big. */
  strip?: StripPlan;
  /** While presenting: the top band's switcher and exit, at its right end. */
  controls?: Rect;
  /** The live jobs with no room: beside a page or a presentation, the ones the one rail column
   *  cannot hold, in a temporary tile at its foot; on the floating stage, the ones its sides cannot
   *  hold at the chat's width, in a pill beside Others (owner 2026-11-06). Its cards are drawn
   *  'others' at its rect, never in `others`. */
  more?: { rect: Rect; ids: string[] };
  /** The one-line rail while it holds more jobs than fit: a window of `visible` from `start`. */
  rail?: { rect: Rect; start: number; visible: number; total: number };
}

/** A side's orbit: x = x0 + dir * depth * (1 - ((y - cy) / ymax)^2), through tile centres. */
export interface OrbitArc { side: 'left' | 'right'; x0: number; cy: number; ymax: number; depth: number; dir: -1 | 1 }

/** What the stage places: a card, or a group drawn as one tile (`kind: 'group'`). `slot` is its
 *  place in the record (a group's is its first card's), so sides never shift under a grouping. */
export interface StageItem {
  id: string;
  /** Who sized it: the owner's size is never overruled for the rail's sake. */
  sizeBy?: SuperContainer['sizeBy'];
  kind: SuperContainer['kind'] | 'group';
  shape: ContainerShape;
  place: SuperContainer['place'];
  pos?: { x: number; y: number };
  slot?: number;
  /** The record's size preset (absent = small; a group is always small). */
  size?: ContainerSize;
  /** A live child's chat card, or a group holding one (task super-canli-kart-sahnede): the last
   *  to be drawn in Others, and kept beside a side-by-side page or a presentation. */
  live?: boolean;
  /** A picture's width/height, server-read from its file header; a web page's, from the device
   *  width the owner picked on it (phone, tablet, desktop). Absent = unknown / fills its box. */
  aspect?: number;
  /** A project page's own measured width (lib/pageFit.ts), never read on a card the owner sized
   *  or gave a device width. Absent = it needs the width it is given. */
  fit?: number;
}

/** A card's size from its record: a preset, or small. */
export function sizeOf(c: { size?: unknown }): ContainerSize {
  return (CONTAINER_SIZES as readonly unknown[]).includes(c.size) && c.size !== undefined ? c.size as ContainerSize : 'small';
}

/** A size in px: units of the tile, one gap between them. */
export function sizePx(size: ContainerSize): { width: number; height: number } {
  const u = SIZE_UNITS[size];
  return { width: u.w * STAGE.TILE + (u.w - 1) * STAGE.GAP, height: u.h * STAGE.TILE + (u.h - 1) * STAGE.GAP };
}

/**
 * A live job (the server's rule, src/lib/super/live.ts): a child of the record, not ended or
 * succeeded, whose row works, asks, is stuck or waits on the owner, or with an open question,
 * stuck or owner item, or whose chat session works or asks right now (`session`: its status kind).
 */
export function childIsLive(
  s: Pick<SuperState, 'children' | 'queue'>, sid: string, session: string | null | undefined,
): boolean {
  const ch = Object.prototype.hasOwnProperty.call(s.children, sid) ? s.children[sid] : undefined;
  // `succeededBy` is in the server's record, not the window's mirror type: read through a cast.
  if (!ch || ch.endedAt !== undefined || (ch as { succeededBy?: string }).succeededBy) return false;
  if (ch.row === 'working' || ch.row === 'asking' || ch.row === 'stuck' || ch.row === 'waiting') return true;
  if (s.queue.some((q) => q.sessionId === sid && q.state !== 'done' && (q.kind === 'permission' || q.kind === 'question' || q.kind === 'stuck' || q.kind === 'owner'))) return true;
  return session === 'working' || session === 'asking';
}

/**
 * The record as the stage sees it: an ungrouped card is itself; a group is one item standing at
 * its first card's place in the record, with the group's own place and drop; its cards are drawn
 * inside it. A grouped card the view shows side by side or presents is drawn there too.
 */
export function stageItems(
  containers: readonly SuperContainer[], groups: readonly SuperGroup[], view: SuperView,
  isLive: (c: SuperContainer) => boolean = () => false,
  /** A web card's shape from its device width (window state, never the record); absent = none. */
  pageAspect: (c: SuperContainer) => number | undefined = () => undefined,
  /** A web card's page width as measured (window state, never the record); absent = none. */
  pageFit: (c: SuperContainer) => number | undefined = () => undefined,
): StageItem[] {
  const shown = new Set(view.mode === 'half' && view.card ? [view.card] : view.mode === 'present' ? view.cards ?? [] : []);
  const index = new Map(containers.map((c, i) => [c.id, i] as const));
  const groupOf = new Map<string, SuperGroup>();
  for (const g of groups) for (const id of g.cards) if (index.has(id)) groupOf.set(id, g);
  const out: StageItem[] = [];
  const placed = new Set<string>();
  containers.forEach((c, i) => {
    const g = groupOf.get(c.id);
    const size = sizeOf(c);
    // A minimised agenda is its pill in the corner, not a card on the stage (unless the view shows it).
    if (c.min && !shown.has(c.id)) return;
    const live = c.kind === 'chat' && isLive(c);
    const page = c.kind === 'web' ? pageAspect(c) : undefined;
    const aspect = c.kind === 'image' && typeof c.aspect === 'number' && Number.isFinite(c.aspect) && c.aspect > 0 ? c.aspect
      : typeof page === 'number' && Number.isFinite(page) && page > 0 ? page : undefined;
    const fit = c.kind === 'web' && !aspect && c.sizeBy !== 'owner' ? pageFit(c) : undefined;
    if (!g || shown.has(c.id)) out.push({ id: c.id, kind: c.kind, shape: c.shape, place: c.place, ...(c.pos ? { pos: c.pos } : {}), slot: i, ...(size !== 'small' ? { size } : {}), ...(c.sizeBy ? { sizeBy: c.sizeBy } : {}), ...(live ? { live } : {}), ...(aspect ? { aspect } : {}), ...(fit ? { fit } : {}) });
    if (g && !placed.has(g.id) && g.cards[0] !== undefined && index.has(g.cards[0])) {
      placed.add(g.id);
      const gLive = g.cards.some((id) => { const k = containers[index.get(id) ?? -1]; return !!k && k.kind === 'chat' && isLive(k); });
      out.push({ id: g.id, kind: 'group', shape: 'square', place: g.place, ...(g.pos ? { pos: g.pos } : {}), slot: index.get(g.cards[0])!, ...(gLive ? { live: true } : {}) });
    }
  });
  return out.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

export interface PlanOptions {
  /** A running drag: that card stays at its drag-start rect, and the others route around it (D1). */
  dragging?: { id: string; rect: Rect } | null;
  /** Terminal pills in the dock: the bottom band is reserved for them. */
  terminals?: number;
  /** The minimised agenda's id: its pill holds the bottom band's left end (the band is reserved). */
  agendaPill?: string | null;
  /** The card the owner made big (filmstrip) or picked in a narrow sheet's tabs; the first when
   *  absent or no longer presented. Window state, never the record. */
  selected?: string | null;
  /** A filmstrip's first slot shown, while it holds more than fit (window state; clamped). */
  stripStart?: number;
  /** The one-line rail's first job shown, while it holds more than fit (window state; clamped). */
  railStart?: number;
  /** A Super question for the owner is open: a chat folded to its bar is drawn as the mini. */
  asking?: boolean;
  /** How many layouts the switcher offers (the window knows the cards' kinds); absent = those
   *  whose count fits. */
  layoutChoices?: number;
  /** The presentation shows one group whole: its close and minimize buttons replace the exit. */
  groupExit?: boolean;
  /** The queue pill is showing in the top band: the float centre keeps its place under it. */
  queueUp?: boolean;
  /** The bar's MEASURED height (JobBar publishes it, superJobsStore `useQueueHeight`). A card row
   *  wraps to show its whole command (sahip-karti-yerinde K7), so the top band is never assumed
   *  one line tall: everything under it (the centre, a sheet, the agenda) starts below the bar's
   *  actual bottom. Absent or smaller than the band: the band. */
  queueHeight?: number;
  /** The owner's drops this window session, the last dropped last: when two of his cards would
   *  overlap, the one he dropped later keeps its place (window state, never the record). */
  recent?: readonly string[];
  /** Internal: this pass already gave his unseated sized cards their spots back (one retry). */
  reclaimed?: boolean;
  /** The narrow line for this screen; absent = {@link NARROW_STAGE_PX}. */
  narrowPx?: number;
  /** The centre's floor for this screen; absent = `STAGE.CENTRE_MIN`. */
  centreMin?: number;
  /** A presentation on a tight stage draws the live jobs as one-line cards (owner 2026-10-31):
   *  the width goes to the chat. Off: the classic rail of tiles. */
  miniRail?: boolean;
  /** The new shell's chat drawer stands beside the stage (owner 2026-10-31). The chat's width
   *  comes from the stage's width alone, the drawer open or not (owner 2026-11-06): the plan is
   *  the same either way; kept so callers need not know. */
  leanRight?: boolean;
  /** The agenda drawn at most this many tiles wide: set by `planStage` itself while it picks the
   *  agenda's width (callers leave it out). */
  agendaCap?: number;
  /** An owner's card a side is too tall for leaves the column at his size instead of shrinking:
   *  set by `planStage` itself, which keeps that plan only when it is no worse (callers leave it out). */
  ownerAside?: boolean;
}


/** A floating tile's height: every tile is 1:1 (2026-10-20). Kept for callers sizing a ghost. */
export function heightOf(_shape: ContainerShape, u: number): number {
  return u;
}

/**
 * The chat's width on this stage, from the stage's width ALONE (owner 2026-11-06, "genişliği
 * pencere belirlesin"): no card opening, closing, moving or resizing ever changes it, nor the
 * drawer beside the stage. A wide stage keeps two columns on each side (W - 784: ~920-960 px on a
 * 1800 window) while that leaves the chat at least FOUR_COLS_FRAC of it; below that the chat
 * takes its share while three columns stay beside it (two on one side, one on the other: 775 px
 * on a 1440 window), so a 2x2 card still fits on a small window. Between its floor and its ceiling.
 */
export function preferredCentre(width: number, min: number = STAGE.CENTRE_MIN): number {
  const { MARGIN, GAP, TILE: T } = STAGE;
  const twoCols = 2 * T + GAP + GAP;
  const four = width - 2 * MARGIN - 2 * twoCols;
  const three = width - 2 * MARGIN - twoCols - (T + GAP);
  const w = four >= STAGE.FOUR_COLS_FRAC * width ? four : Math.min(STAGE.CENTRE_FRAC * width, three);
  return Math.min(STAGE.CENTRE_MAX, Math.max(min, w));
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
export const contains = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

// ─── The orbit (2026-10-20) ─────────────────────────────────────────────────────

/** One item in a side's list, in record order. `chat`: a child chat (or a group), kept longest. */
interface Slot { id: string; owner: boolean; chat: boolean; live?: boolean; /** The owner chose its size (`sizeBy`), not a running drag. */ sized?: boolean }

/** Which item gives way first when a side is too full (lower goes first): every other card, then
 *  a chat or group, the auto-placed before the owner's; a LIVE job last of all (owner 2026-10-23:
 *  live jobs win over pictures, tasks and finished cards). */
const keepRank = (s: Slot): number => (s.live ? 4 : 0) + (s.owner ? 2 : 0) + (s.chat ? 1 : 0);

/** How many tiles one column holds in a column `span` tall. */
function capacity(span: number): number {
  return Math.max(0, Math.floor((span + STAGE.GAP) / (STAGE.TILE + STAGE.GAP) + 1e-9));
}

interface FloatSolution {
  centre: Rect;
  u: number;
  rects: Map<string, Rect>;
  /** Ids that fit nowhere: drawn in Others. */
  overflow: Set<string>;
  orbit: OrbitArc[];
}

/**
 * Both sides around the centre: every item one 1:1 tile, a side's tiles in its inner column
 * first (an outer column only once that is full and the side has the room), each column a stack
 * one gap apart centred on the centre's midline, bent into an arc (the ORBIT): a tile stands out
 * from the centre by depth * (1 - (dy / ymax)^2), dy its distance from the midline and ymax the
 * column's farthest, so the middle stands out and the ends tuck in. Items past what a side holds
 * overflow: the side's last, the auto-placed ones before the owner's and, among those, every other
 * card before a chat (the chats are why the owner handed over: they stay on the stage longest).
 */
function solveFloat(f: Frame, left: readonly Slot[], right: readonly Slot[]): FloatSolution {
  const { GAP, MARGIN, TILE: T, MAX_COLS, ORBIT_DEPTH } = STAGE;
  const W = f.width;
  const span = f.content.height;
  const centre = centreAt(f, preferredCentre(W, f.centreMin));
  const room = (W - centre.width) / 2 - GAP - MARGIN;
  const cols = Math.max(0, Math.min(MAX_COLS, Math.floor((room + GAP) / (T + GAP) + 1e-9)));
  const perCol = capacity(span);
  const rects = new Map<string, Rect>();
  const overflow = new Set<string>();
  const orbit: OrbitArc[] = [];
  if (cols < 1 || perCol < 1) {
    for (const s of [...left, ...right]) overflow.add(s.id);
    return { centre, u: 0, rects, overflow, orbit };
  }
  const keep = (slots: readonly Slot[]) => {
    const roomFor = perCol * cols;
    const out = [...slots];
    // Drop from the end, by keepRank: auto-placed before the owner's, any other card before a
    // chat, and a live job only once nothing else is left.
    for (let rank = 0; rank < 8; rank++) {
      for (let i = out.length - 1; i >= 0 && out.length > roomFor; i--) {
        if (keepRank(out[i]) === rank) { overflow.add(out[i].id); out.splice(i, 1); }
      }
    }
    return out;
  };
  const mid = centre.y + centre.height / 2;
  const kept = { left: keep(left), right: keep(right) };
  for (const [side, slots] of [['left', kept.left], ['right', kept.right]] as const) {
    if (!slots.length) continue;
    const used = Math.ceil(slots.length / perCol);
    const depth = Math.max(0, Math.min(ORBIT_DEPTH, room - used * T - (used - 1) * GAP));
    const dir = side === 'left' ? -1 : 1;
    for (let k = 0; k < used; k++) {
      const col = slots.slice(k * perCol, (k + 1) * perCol);
      const total = col.length * T + (col.length - 1) * GAP;
      const y0 = mid - total / 2;
      const x0 = side === 'left' ? centre.x - GAP - T - k * (T + GAP) : centre.x + centre.width + GAP + k * (T + GAP);
      const ymax = (total - T) / 2;
      col.forEach((s, i) => {
        const y = y0 + i * (T + GAP);
        const dy = y + T / 2 - mid;
        // The inner column bends into the orbit; an outer one stands out by the orbit's whole depth,
        // so the inner column's middle never reaches it (owner 2026-10-28: no card under another).
        const off = k > 0 ? depth : ymax > 0 ? depth * (1 - (dy / ymax) ** 2) : 0;
        rects.set(s.id, { x: x0 + dir * off, y, width: T, height: T });
      });
      if (k === 0 && col.length >= 2 && depth > 0) orbit.push({ side, x0: x0 + T / 2, cy: mid, ymax, depth, dir });
    }
  }
  return { centre, u: T, rects, overflow, orbit };
}

// ─── Sized cards (owner 2026-10-22) ──────────────────────────────────────────────

interface SizedSlot extends Slot { size: ContainerSize; z: number; agenda?: boolean }

/** The largest size, at most `cap` tiles wide, a card of `size` may be drawn at. */
function shrinkToWidth(size: ContainerSize, cap: number): ContainerSize {
  const prefs: Record<ContainerSize, ContainerSize[]> = {
    wide: ['wide', 'large', 'medium', 'small'], large: ['large', 'medium', 'small'], medium: ['medium', 'small'], small: ['small'],
  };
  return prefs[size].find((s) => SIZE_UNITS[s].w <= Math.max(1, cap)) ?? 'small';
}

/** One step lower: a 2-tall card first gives up its height (wide/large → medium), then medium → small. */
const HEIGHT_STEP: Record<ContainerSize, ContainerSize | null> = { wide: 'medium', large: 'medium', medium: 'small', small: null };

const unitsPx = (n: number) => (n > 0 ? n * STAGE.TILE + (n - 1) * STAGE.GAP : 0);

interface SizedSolution extends FloatSolution {
  /** Each placed card's drawn size. */
  drawn: Map<string, ContainerSize>;
  /** The right side's width (`u` is the left's). */
  uRight: number;
}

/**
 * Both sides around the centre when a card is sized. The centre's width is the stage's
 * ({@link preferredCentre}, owner 2026-11-06); each side is as wide as its widest card (in tiles)
 * while both fit in the room left, the centre in the middle or, for a side wider than its half,
 * off it only as far as that side needs. Too wide: the wider side (a side whose widest card the
 * owner sized gives way last; on a tie, the one whose widest card comes later in the record) is
 * capped one tile narrower and its cards are drawn at the largest size that fits it. Within a side, cards run top to bottom in record order
 * against the inner (centre) edge: a sized card is a block of its own, a run of small cards fills
 * rows of the side's width. A side taller than the stage first widens (when the room beside the
 * centre has a column and it has small cards to pair); then the auto-placed cards give way, the latest
 * first (their height: wide/large → medium, medium → small; then their place, to Others, any
 * card before a chat); only then the owner's own cards, the same way. A one-column side of
 * small cards keeps its orbit.
 */
function solveSized(f: Frame, left: readonly SizedSlot[], right: readonly SizedSlot[], agendaCap?: number, ownerAside = false): SizedSolution {
  return solveSizedAt(f, left, right, agendaCap ?? null, ownerAside);
}

/** `solveSized` with the agenda drawn at most `agendaCap` tiles wide (null: its own size). */
function solveSizedAt(f: Frame, left: readonly SizedSlot[], right: readonly SizedSlot[], agendaCap: number | null, ownerAside: boolean): SizedSolution {
  const { GAP, MARGIN, TILE: T, ORBIT_DEPTH } = STAGE;
  const W = f.width;
  const span = f.content.height;
  // The chat's width is the stage's, never the cards' (owner 2026-11-06): the sides share what
  // is left beside it, and a card that does not fit there is drawn smaller or waits.
  const chat = preferredCentre(W, f.centreMin);
  const drawn = new Map<string, ContainerSize>();
  for (const s of [...left, ...right]) drawn.set(s.id, s.size);
  const overflow = new Set<string>();
  // An owner's card set aside from its column (owner 2026-10-29, "alan var mı?"): it stands where
  // he dropped it, not in the column, so a side too tall for it no longer shrinks or drops it; it
  // keeps its size and its width, and the placement below seats it at its spot or in Others.
  const aside = new Set<string>();
  const sides = { left: [...left], right: [...right] };
  const live = (side: 'left' | 'right') => sides[side].filter((s) => !overflow.has(s.id));
  const inColumn = (side: 'left' | 'right') => live(side).filter((s) => !aside.has(s.id));
  const widest = (side: 'left' | 'right') => live(side).reduce((m, s) => Math.max(m, SIZE_UNITS[drawn.get(s.id)!].w), 0);
  const cols = { left: widest('left'), right: widest('right') };
  const avail = () => W - 2 * MARGIN - unitsPx(cols.left) - unitsPx(cols.right) - (cols.left ? GAP : 0) - (cols.right ? GAP : 0);
  const capSide = (side: 'left' | 'right', cap: number) => {
    cols[side] = cap;
    for (const s of live(side)) drawn.set(s.id, shrinkToWidth(drawn.get(s.id)!, cap));
  };
  // The agenda sizes itself (owner 2026-10-28: "the agenda hurts the centre"; 2026-10-29: "Agenda
  // büyümüyor?" with half the stage free): its size, the default or the owner's, is its LARGEST;
  // it is drawn at the widest whose column fits beside the chat, down to the 1x1 counts only on a
  // window too small for that. A side another card already makes wide costs nothing more: the
  // agenda keeps it.
  const ag = [...left, ...right].find((s) => s.agenda);
  if (ag) {
    const side = left.includes(ag) ? 'left' : 'right';
    const other = side === 'left' ? 'right' : 'left';
    const sidePx = (n: number) => (n > 0 ? unitsPx(n) + GAP : 0);
    const rest = live(side).filter((s) => s !== ag).reduce((m, s) => Math.max(m, SIZE_UNITS[drawn.get(s.id)!].w), 0);
    // A tried cap never draws it narrower than its side already is (that costs the centre nothing).
    let cap = Math.min(SIZE_UNITS[drawn.get(ag.id)!].w, Math.max(agendaCap ?? Infinity, rest));
    // An agenda the owner sized keeps his size before the other side's auto cards keep theirs.
    const firmOther = ag.sized ? live(other).filter((s) => s.sized).reduce((m, s) => Math.max(m, SIZE_UNITS[drawn.get(s.id)!].w), Math.min(1, cols[other])) : cols[other];
    while (cap > 1 && cap > rest && W - 2 * MARGIN - sidePx(Math.max(cap, rest)) - sidePx(firmOther) < chat - 1e-9) cap -= 1;
    drawn.set(ag.id, shrinkToWidth(drawn.get(ag.id)!, cap));
    cols[side] = widest(side);
  }
  // Width: narrow the wider side until the sides fit beside the chat.
  while (avail() < chat - 1e-9 && (cols.left > 1 || cols.right > 1)) {
    const lastWide = (side: 'left' | 'right') => Math.max(-1, ...live(side).filter((s) => SIZE_UNITS[drawn.get(s.id)!].w === cols[side]).map((s) => s.z));
    let side: 'left' | 'right' = cols.left !== cols.right ? (cols.left > cols.right ? 'left' : 'right') : (lastWide('left') > lastWide('right') ? 'left' : 'right');
    // What the owner sized keeps its width while the other side's widest are the stage's own.
    const firm = (sd: 'left' | 'right') => live(sd).some((s) => s.sized && SIZE_UNITS[drawn.get(s.id)!].w === cols[sd]);
    const flip = side === 'left' ? 'right' : 'left';
    if (firm(side) && !firm(flip) && cols[flip] > 1) side = flip;
    capSide(side, cols[side] - 1);
  }
  // Rows of one side at its width.
  type Row = { h: number; items: SizedSlot[] };
  const rowsOf = (side: 'left' | 'right'): Row[] => {
    const rows: Row[] = [];
    let run: Row | null = null;
    for (const s of inColumn(side)) {
      const u = SIZE_UNITS[drawn.get(s.id)!];
      if (u.w === 1 && u.h === 1) {
        if (run && run.items.length < Math.max(1, cols[side])) run.items.push(s);
        else { run = { h: 1, items: [s] }; rows.push(run); }
      } else {
        run = null;
        rows.push({ h: u.h, items: [s] });
      }
    }
    return rows;
  };
  const heightOfRows = (rows: Row[]) => rows.reduce((t, r) => t + unitsPx(r.h), 0) + Math.max(0, rows.length - 1) * GAP;

  for (const side of ['left', 'right'] as const) {
    const other = side === 'left' ? 'right' : 'left';
    for (let guard = 0; guard < 200 && heightOfRows(rowsOf(side)) > span; guard++) {
      const items = inColumn(side);
      const smalls = items.filter((s) => drawn.get(s.id) === 'small').length;
      // 1. The other side has room: its latest small auto card crosses over, at its size, when
      //    the other side keeps its width and still fits (that column re-centres around it): the
      //    chat stays in the middle while it can (owner 2026-10-22).
      const crosser = [...items].reverse().find((s) => !s.owner && !s.agenda && drawn.get(s.id) === 'small');
      if (crosser) {
        const before = { list: sides[other], from: sides[side], cols: cols[other] };
        sides[other] = [...sides[other], crosser].sort((a, b) => a.z - b.z);
        sides[side] = sides[side].filter((s) => s !== crosser);
        cols[other] = Math.max(1, cols[other]);
        if (heightOfRows(rowsOf(other)) <= span + 1e-9 && avail() >= chat - 1e-9) continue;
        sides[other] = before.list;
        sides[side] = before.from;
        cols[other] = before.cols;
      }
      // 1b. Widen, when there are small cards to pair up and the column fits in the room beside
      //     the chat (its width is the stage's; it steps aside for a second column only as far as
      //     needed, once; a third only where its half of the stage holds it, so never again).
      const third = unitsPx(cols[side] + 1) + GAP <= (W - chat) / 2 - MARGIN + 1e-9;
      if ((cols[side] < STAGE.MAX_COLS || (cols[side] < STAGE.MAX_COLS + 1 && third)) && smalls >= 2 && avail() - T - GAP >= chat - 1e-9 && cols[side] >= 1) {
        cols[side] += 1;
        continue;
      }
      // 2. The auto-placed cards give way first, the latest first: their height, then their place
      //    (to Others, any card before a chat). Only then does the owner's own card give up
      //    height, and last its place: he chose its size and where it stands.
      //    `ownerAside` (asked by planStage only, owner 2026-10-29 "alan var mı?"): instead of
      //    giving up height, the owner's card leaves the column at the size he chose (it stands
      //    where he dropped it, not in the column), when that height fits the stage at all.
      //    A card the owner SIZED keeps its size and its place while any live job can wait in the
      //    pill instead (owner 2026-11-06: the chat stays, his size is kept, extra jobs go to the
      //    pill).
      const latest = [...items].reverse();
      const shrink = (owner: boolean) => latest.find((s) => s.owner === owner && !s.sized && SIZE_UNITS[drawn.get(s.id)!].h > 1)
        ?? latest.find((s) => s.owner === owner && !s.sized && drawn.get(s.id) === 'medium' && cols[side] >= 2);
      // A live job gives its place last of all, after the owner's own cards (owner 2026-10-23).
      const drop = (owner: boolean, live: boolean) => latest.find((s) => s.owner === owner && !!s.live === live && !s.chat && !s.sized)
        ?? latest.find((s) => s.owner === owner && !!s.live === live && !s.sized);
      const step = shrink(false) ?? null;
      if (step) { drawn.set(step.id, HEIGHT_STEP[drawn.get(step.id)!]!); continue; }
      const auto = drop(false, false);
      if (auto) { overflow.add(auto.id); continue; }
      if (ownerAside) {
        const out = latest.find((s) => s.owner && sizePx(drawn.get(s.id)!).height <= span + 1e-9);
        if (out) { aside.add(out.id); continue; }
      }
      // 3. Before a live job or the owner's card gives way here, the other side gives way for a
      //    small auto card to cross (live jobs win over pictures and finished cards on the whole
      //    stage, owner 2026-10-23): the height of its auto cards that are not live, then their
      //    place (to Others); the stage's own agenda gives height before a job is hidden.
      if (crosser) {
        const o = [...inColumn(other)].reverse();
        const tall = o.find((s) => !s.owner && !s.sized && !s.live && SIZE_UNITS[drawn.get(s.id)!].h > 1)
          ?? o.find((s) => s.agenda && !s.owner && !s.sized && SIZE_UNITS[drawn.get(s.id)!].h > 1);
        if (tall) { drawn.set(tall.id, HEIGHT_STEP[drawn.get(tall.id)!]!); continue; }
        const idle = o.find((s) => !s.owner && !s.sized && !s.live && !s.agenda);
        if (idle) { overflow.add(idle.id); continue; }
      }
      // What the owner sized keeps its size (owner 2026-11-06: "bir sonraki kart açılınca bozulmaz"):
      // an auto-placed live job waits in the "more" pill beside Others first, the agenda excepted.
      const sizedHere = items.some((s) => s.sized && drawn.get(s.id) !== 'small');
      const autoLive = latest.find((s) => !s.owner && !!s.live && !s.agenda && !s.sized);
      if (autoLive && sizedHere) { overflow.add(autoLive.id); continue; }
      const own = shrink(true);
      if (own) { drawn.set(own.id, HEIGHT_STEP[drawn.get(own.id)!]!); continue; }
      // The owner's dropped live jobs wait in the pill before his sized card shrinks.
      const ownLive = sizedHere ? latest.find((s) => s.owner && !!s.live && !s.agenda && !s.sized) : undefined;
      if (ownLive) { overflow.add(ownLive.id); continue; }
      const last = drop(true, false) ?? drop(false, true) ?? drop(true, true);
      if (last) { overflow.add(last.id); continue; }
      // Only his sized cards are left: they give height, then their place, as before.
      const sizedStep = latest.find((s) => s.sized && SIZE_UNITS[drawn.get(s.id)!].h > 1)
        ?? latest.find((s) => s.sized && drawn.get(s.id) === 'medium' && cols[side] >= 2);
      if (sizedStep) { drawn.set(sizedStep.id, HEIGHT_STEP[drawn.get(sizedStep.id)!]!); continue; }
      const sizedLast = latest.find((s) => s.sized && !s.live) ?? latest.find((s) => s.sized);
      if (!sizedLast) break;
      overflow.add(sizedLast.id);
    }
  }
  // The centre stays IN THE MIDDLE while it can (owner 2026-10-22: "I made a card bigger and the
  // agent in the centre was no longer centred; no need, there is room"); a side its cards make
  // wider than the middle leaves moves it toward the other side, at its width (the agenda is never
  // mirrored, owner 2026-11-03), only as far as that side needs.
  const sidePx = (n: number) => (n > 0 ? unitsPx(n) + GAP : 0);
  const lo = MARGIN + sidePx(cols.left);
  const hi = W - MARGIN - sidePx(cols.right) - chat;
  const x = Math.max(lo, Math.min(hi, (W - chat) / 2));
  const centre: Rect = { x: hi < lo ? lo : x, y: f.content.y, width: chat, height: f.content.height };
  const mid = centre.y + centre.height / 2;
  const rects = new Map<string, Rect>();
  const orbit: OrbitArc[] = [];
  for (const side of ['left', 'right'] as const) {
    const rows = rowsOf(side);
    if (!rows.length) continue;
    const total = heightOfRows(rows);
    const dir = side === 'left' ? -1 : 1;
    const inner = side === 'left' ? centre.x - GAP : centre.x + centre.width + GAP;
    // A one-column side of small cards keeps its orbit.
    const oneColumn = rows.every((r) => r.items.length === 1 && drawn.get(r.items[0].id) === 'small');
    const room = side === 'left' ? centre.x - GAP - MARGIN : W - MARGIN - inner;
    const depth = oneColumn && rows.length >= 2 ? Math.max(0, Math.min(ORBIT_DEPTH, room - T)) : 0;
    const ymax = (total - T) / 2;
    let y = mid - total / 2;
    for (const r of rows) {
      r.items.forEach((s, k) => {
        const px = sizePx(drawn.get(s.id)!);
        const dy = y + px.height / 2 - mid;
        const off = depth > 0 && ymax > 0 ? depth * (1 - (dy / ymax) ** 2) : 0;
        const at = side === 'left' ? inner - k * (T + GAP) - px.width : inner + k * (T + GAP);
        rects.set(s.id, { x: at + dir * off, y, width: px.width, height: px.height });
      });
      y += unitsPx(r.h) + GAP;
    }
    if (depth > 0) orbit.push({ side, x0: inner + dir * (T / 2), cy: mid, ymax, depth, dir });
  }
  return { centre, u: unitsPx(cols.left), uRight: unitsPx(cols.right), rects, overflow, orbit, drawn };
}

/** Whether `id` would be drawn floating at `size` on this stage now: the plan with that size,
 *  asked (the size menu and the corner handle offer only what this says). `at`: the card grows
 *  where the owner sees it (its inner top corner held, {@link anchoredPos}) and is his latest
 *  act, exactly what the write will record (owner 2026-10-29, "alan var mı?": the plan asked at
 *  the card's old spot refused a size the empty column beside it could take). */
export function fitsNow(
  containers: readonly StageItem[], view: SuperView, stage: { width: number; height: number }, id: string, size: ContainerSize, opts: PlanOptions = {},
  at?: { free: Rect; rect: Rect; side: 'left' | 'right' },
): boolean {
  const pos = at ? anchoredPos(at.free, at.rect, size, at.side) : undefined;
  // Asked as the write will record it: his size (`sizeBy`), which the stage keeps before its own cards'.
  const next = containers.map((c) => (c.id === id ? { ...c, ...(size === 'small' ? { size: undefined } : { size, sizeBy: 'owner' as const }), ...(pos ? { pos } : {}) } : c));
  const recent = at ? [...(opts.recent ?? []).filter((x) => x !== id), id] : opts.recent;
  const after = planStage(next, view, stage, { ...opts, recent });
  const p = after.cards[id];
  if (!p || p.where !== 'float' || (p.size ?? 'small') !== size) return false;
  // A live job gives its place last of all (owner 2026-10-23): a size that would send one now on
  // the stage to Others does not fit.
  const now = planStage(containers, view, stage, opts);
  return containers.every((c) => !c.live || c.id === id || now.cards[c.id]?.where !== 'float' || after.cards[c.id]?.where === 'float');
}

/**
 * The drop position that keeps an owner-placed card's INNER top corner where it is when it
 * changes size (the corner toward the centre: top-right on the left side, top-left on the right):
 * the card grows away from the centre and never jumps.
 */
export function anchoredPos(free: Rect, rect: Rect, size: ContainerSize, side: 'left' | 'right'): { x: number; y: number } {
  const px = sizePx(size);
  const x = side === 'left' ? rect.x + rect.width - px.width : rect.x;
  return posFromRect(free, { x, y: rect.y, width: px.width, height: px.height });
}

/** Where a pushed-aside tile goes: the free spot of its own column nearest where it stood. */
function reseat(want: Rect, f: Frame, blocks: readonly Rect[]): Rect | null {
  const top = f.content.y;
  const bottom = f.content.y + f.content.height;
  const cuts = blocks
    .map((b) => inflate(b, STAGE.GAP - 0.5))
    .filter((b) => b.x < want.x + want.width && want.x < b.x + b.width)
    .map((b) => [Math.max(top, b.y), Math.min(bottom, b.y + b.height)] as [number, number])
    .filter(([a, z]) => z > a)
    .sort((p, q) => p[0] - q[0]);
  const free: Array<[number, number]> = [];
  let cursor = top;
  for (const [a, z] of cuts) {
    if (a > cursor) free.push([cursor, a]);
    cursor = Math.max(cursor, z);
  }
  if (bottom > cursor) free.push([cursor, bottom]);
  let pick: Rect | null = null;
  for (const [a, z] of free) {
    if (z - a < want.height - 0.01) continue;
    const y = Math.min(Math.max(want.y, a), z - want.height);
    if (!pick || Math.abs(y - want.y) < Math.abs(pick.y - want.y)) pick = { ...want, y };
  }
  return pick;
}

/** Clear of every block by at least the gap. */
function clear(r: Rect, blocks: readonly Rect[]): boolean {
  return !blocks.some((b) => overlaps(r, inflate(b, STAGE.GAP - 0.5)));
}

/**
 * The free spot for `want` (its size) inside `area` nearest where it stands, a gap clear of every
 * block, or null when there is none. The candidates are its own spot, the area's edges, a gap
 * beside each block's edges and in line with them, on both axes.
 */
export function findFree(want: Rect, area: Rect, blocks: readonly Rect[]): Rect | null {
  const { GAP } = STAGE;
  const { width: w, height: h } = want;
  if (w > area.width + 0.01 || h > area.height + 0.01) return null;
  const xs = new Set<number>([want.x, area.x, area.x + area.width - w]);
  const ys = new Set<number>([want.y, area.y, area.y + area.height - h]);
  for (const b of blocks) {
    xs.add(b.x - GAP - w); xs.add(b.x + b.width + GAP); xs.add(b.x); xs.add(b.x + b.width - w);
    ys.add(b.y - GAP - h); ys.add(b.y + b.height + GAP); ys.add(b.y); ys.add(b.y + b.height - h);
  }
  const inX = (x: number) => Math.min(Math.max(x, area.x), area.x + area.width - w);
  const inY = (y: number) => Math.min(Math.max(y, area.y), area.y + area.height - h);
  let best: Rect | null = null;
  let bestD = Infinity;
  for (const x0 of xs) {
    const x = inX(x0);
    for (const y0 of ys) {
      const y = inY(y0);
      const d = (x - want.x) ** 2 + (y - want.y) ** 2;
      if (d >= bestD) continue;
      const r = { x, y, width: w, height: h };
      if (clear(r, blocks)) { best = r; bestD = d; }
    }
  }
  return best;
}

// ─── Owner placement ────────────────────────────────────────────────────────────

/** A drop's rect as the record's `pos`: fractions of the free area minus the card's size (§0 C-minors). */
export function posFromRect(free: Rect, rect: Rect): { x: number; y: number } {
  const span = (room: number, at: number) => (room > 0 ? Math.min(1, Math.max(0, at / room)) : 0);
  return {
    x: span(free.width - rect.width, rect.x - free.x),
    y: span(free.height - rect.height, rect.y - free.y),
  };
}

export function rectFromPos(free: Rect, pos: { x: number; y: number }, width: number, height: number): Rect {
  return {
    x: free.x + Math.max(0, free.width - width) * pos.x,
    y: free.y + Math.max(0, free.height - height) * pos.y,
    width,
    height,
  };
}

/** An owner card overlapping the centre (inflated by the gap) is pushed out to the nearer side. */
function pushOut(rect: Rect, centre: Rect, free: Rect, side?: 'left' | 'right'): Rect {
  const zone = inflate(centre, STAGE.GAP);
  let r = rect;
  if (overlaps(r, zone)) {
    // Toward the side the solve counted it on (its saved pos), else the nearer edge.
    const toLeft = side ? side === 'left' : r.x + r.width / 2 < centre.x + centre.width / 2;
    r = { ...r, x: toLeft ? zone.x - r.width : zone.x + zone.width };
  }
  const x = Math.min(Math.max(r.x, free.x), free.x + free.width - r.width);
  const y = Math.min(Math.max(r.y, free.y), free.y + free.height - r.height);
  return { ...r, x, y };
}

// ─── The plan ───────────────────────────────────────────────────────────────────

interface Frame { width: number; height: number; content: Rect; free: Rect; othersRect: Rect; othersZone: Rect; agendaPill: Rect; bandTop: number; bandBottom: number; centreMin: number; phone?: boolean }

/** The stage's frame. `bottomBand`: the bottom band is reserved (the content stops above it);
 *  without it the content runs down to the bottom margin. */
function frameOf(width: number, height: number, bottomBand = true, centreMin: number = STAGE.CENTRE_MIN, phone?: { queue: boolean; terminals: boolean }, topBand: number = STAGE.BAND): Frame {
  const { MARGIN, BAND } = STAGE;
  if (phone) return phoneFrame(frameOf(width, height, true, centreMin, undefined, topBand), phone, topBand);
  const below = bottomBand ? MARGIN + BAND : MARGIN;
  // The top band is the bar's real height (never less than BAND): nothing is planned under it.
  const top = MARGIN + Math.max(BAND, topBand);
  const content: Rect = { x: MARGIN, y: top, width: Math.max(0, width - 2 * MARGIN), height: Math.max(0, height - top - below) };
  const bandTop = MARGIN / 2;
  const bandBottom = height - MARGIN / 2 - BAND;
  return {
    width, height, content, free: content, bandTop, bandBottom, centreMin,
    othersRect: { x: width - MARGIN - STAGE.OTHERS_W, y: bandBottom, width: STAGE.OTHERS_W, height: BAND },
    othersZone: { x: width - STAGE.OTHERS_ZONE_W, y: height - STAGE.OTHERS_ZONE_H, width: STAGE.OTHERS_ZONE_W, height: STAGE.OTHERS_ZONE_H },
    agendaPill: { x: MARGIN, y: bandBottom, width: STAGE.AGENDA_PILL_W, height: BAND },
  };
}

/** The phone's frame: the content runs to all four edges. Only what is showing takes height: the
 *  queue pill above the chat, the terminals' dock below it. The Others rect stays bottom-right,
 *  it is where a card flies to and what the panel opens above. */
function phoneFrame(f: Frame, { queue, terminals }: { queue: boolean; terminals: boolean }, topBand: number = STAGE.BAND): Frame {
  const bandTop = STAGE.PHONE_BAND_INSET;
  const top = queue ? bandTop + Math.max(STAGE.BAND, topBand) + bandTop : 0;
  const below = terminals ? STAGE.MARGIN + STAGE.BAND : 0;
  const content: Rect = { x: 0, y: top, width: f.width, height: Math.max(0, f.height - top - below) };
  return { ...f, content, free: content, bandTop, phone: true };
}

function centreAt(f: Frame, w: number): Rect {
  return { x: (f.width - w) / 2, y: f.content.y, width: w, height: f.content.height };
}

function bands(f: Frame, centre: Rect, pill = false, controls?: Rect): { queue: Rect; dock: Rect } {
  // Centred on the centre, one width whatever the stage's size (stage v2: the centre follows the
  // stage now, and a band that followed it re-fitted the pill's buttons inside the resize's own
  // ResizeObserver pass). A pill that fits one row never spills over the centre's header (it
  // grows as an overlay only while the owner points at it). A presentation's controls hold the
  // band's right end: the pill stops a gap before them.
  if (f.phone) {
    const i = STAGE.PHONE_BAND_INSET;
    return {
      queue: { x: i, y: f.bandTop, width: Math.max(0, f.width - 2 * i), height: STAGE.BAND },
      dock: { x: STAGE.MARGIN, y: f.bandBottom, width: Math.max(0, f.width - 2 * STAGE.MARGIN), height: STAGE.BAND },
    };
  }
  const right = controls ? Math.max(f.content.x, controls.x - STAGE.GAP) : f.content.x + f.content.width;
  const qw = Math.max(0, Math.min(STAGE.QUEUE_MAX, right - f.content.x));
  const qx = Math.min(Math.max(centre.x + (centre.width - qw) / 2, f.content.x), right - qw);
  return {
    queue: { x: qx, y: f.bandTop, width: qw, height: STAGE.BAND },
    dock: pill
      ? { x: f.agendaPill.x + f.agendaPill.width + STAGE.GAP, y: f.bandBottom, width: Math.max(0, f.othersRect.x - f.agendaPill.x - f.agendaPill.width - 2 * STAGE.GAP), height: STAGE.BAND }
      : { x: STAGE.MARGIN, y: f.bandBottom, width: Math.max(0, f.othersRect.x - STAGE.MARGIN - STAGE.GAP), height: STAGE.BAND },
  };
}

/** A grid of 1-4 rects in a region (1 = whole, 2 = two columns, 3-4 = 2 x 2). */
function grid(region: Rect, n: number): Rect[] {
  const { GAP } = STAGE;
  if (n <= 1) return [region];
  const cols = 2;
  const rows = n <= 2 ? 1 : 2;
  const w = (region.width - GAP) / cols;
  const h = (region.height - (rows - 1) * GAP) / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: region.x + (i % cols) * (w + GAP),
    y: region.y + Math.floor(i / cols) * (h + GAP),
    width: w,
    height: h,
  }));
}

/** A picture of this aspect, contained in a box (0 x 0 for an empty box). */
function containIn(width: number, height: number, aspect: number): { width: number; height: number } {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  if (!w || !h) return { width: 0, height: 0 };
  return w / h > aspect ? { width: h * aspect, height: h } : { width: w, height: w / aspect };
}

/** One way to lay out 2-4 cards; `today` is the one `grid()` draws (columns, 2 x 2). */
interface Arrangement { name: string; today: boolean; slots: Rect[] }

function arrangements(region: Rect, n: number): Arrangement[] {
  const { GAP } = STAGE;
  const { x, y, width: W, height: H } = region;
  const cols = (k: number): Rect[] => Array.from({ length: k }, (_, i) => {
    const w = (W - (k - 1) * GAP) / k;
    return { x: x + i * (w + GAP), y, width: w, height: H };
  });
  const rows = (k: number): Rect[] => Array.from({ length: k }, (_, i) => {
    const h = (H - (k - 1) * GAP) / k;
    return { x, y: y + i * (h + GAP), width: W, height: h };
  });
  if (n === 2) return [{ name: 'columns', today: true, slots: cols(2) }, { name: 'rows', today: false, slots: rows(2) }];
  // 2 x 2; with 3 cards its last row is centred (an all-picture set only; a mixed set keeps grid()).
  const w = (W - GAP) / 2;
  const h = (H - GAP) / 2;
  const square = Array.from({ length: n }, (_, i) => ({
    x: n === 3 && i === 2 ? x + (W - w) / 2 : x + (i % 2) * (w + GAP),
    y: y + Math.floor(i / 2) * (h + GAP),
    width: w,
    height: h,
  }));
  return [{ name: '2x2', today: true, slots: square }, { name: `1x${n}`, today: false, slots: cols(n) }, { name: `${n}x1`, today: false, slots: rows(n) }];
}

/** The picture area a set shows in these slots (contain-fit inside each slot minus the chrome). */
function pictureArea(slots: readonly Rect[], aspects: readonly number[]): number {
  return slots.reduce((sum, r, i) => {
    const p = containIn(r.width - STAGE.CARD_CHROME.w, r.height - STAGE.CARD_CHROME.h, aspects[i]);
    return sum + p.width * p.height;
  }, 0);
}

/** A picture card shrunk to its picture plus chrome, centred in its slot: per axis
 *  min(slot, max(FIT_MIN, fit)); a slot under FIT_MIN on either axis is the whole slot. */
export function fitCard(slot: Rect, aspect: number): Rect {
  const { CARD_CHROME: C, FIT_MIN: M } = STAGE;
  if (slot.width < M.w || slot.height < M.h) return slot;
  const p = containIn(slot.width - C.w, slot.height - C.h, aspect);
  const width = Math.min(slot.width, Math.max(M.w, p.width + C.w));
  const height = Math.min(slot.height, Math.max(M.h, p.height + C.h));
  return { x: slot.x + (slot.width - width) / 2, y: slot.y + (slot.height - height) / 2, width, height };
}

/**
 * Compare and grid by the pictures' shape (owner 2026-10-24): a set whose EVERY card is a
 * picture with a known aspect takes the arrangement that shows the most picture (two wide
 * pictures stack, two tall ones stand side by side, three take a 2 x 2 with the last row
 * centred); an arrangement with a slot under FIT_MIN is not offered, today's always is, and
 * today's wins any tie within 1 %. A set with any other card keeps exactly today's `grid()`.
 * Either way a picture card hugs its picture. Returns the card rects and the slots they sit in.
 */
export function fitArrange(region: Rect, items: readonly Pick<StageItem, 'aspect'>[]): { name: string; slots: Rect[]; rects: Rect[] } {
  const n = items.length;
  const known = (a: number | undefined): a is number => typeof a === 'number' && Number.isFinite(a) && a > 0;
  let chosen: { name: string; slots: Rect[] } = { name: n <= 2 ? 'columns' : '2x2', slots: grid(region, n) };
  if (n >= 2 && n <= 4 && items.every((it) => known(it.aspect))) {
    const aspects = items.map((it) => it.aspect as number);
    const all = arrangements(region, n);
    const today = all.find((a) => a.today)!;
    const fits = (a: Arrangement) => a.slots.every((r) => r.width >= STAGE.FIT_MIN.w && r.height >= STAGE.FIT_MIN.h);
    const todayScore = pictureArea(today.slots, aspects);
    let best = today;
    let bestScore = todayScore;
    for (const a of all) {
      if (a.today || !fits(a)) continue;
      const score = pictureArea(a.slots, aspects);
      if (score > bestScore) { best = a; bestScore = score; }
    }
    chosen = bestScore > todayScore * 1.01 ? best : today;
  }
  const rects = chosen.slots.map((slot, i) => (known(items[i]?.aspect) ? fitCard(slot, items[i].aspect as number) : slot));
  return { name: chosen.name, slots: chosen.slots, rects };
}

/**
 * The stage for these cards and this view at this size. Pure: the same input always draws the
 * same screen. A card that does not fit is DRAWN in Others; the record is never touched.
 */
export function planStage(
  containers: readonly StageItem[],
  view: SuperView,
  stage: { width: number; height: number },
  opts: PlanOptions = {},
): StagePlan {
  // A running drag never picks the plan (owner 2026-11-06, "düzeltmeye çalıştığımda ne kadar salakça
  // davranıyor"): the stage chooses its plan as if nothing were held, and the held card is held
  // inside that plan.
  if (opts.dragging) {
    const { dragging, ...still } = opts;
    const free = planStage(containers, view, stage, still);
    const v = VARIANT.get(free);
    const seats = SEATS.get(free);
    // The order that seated his cards in that plan too (a reclaimed sized card ranks there).
    if (v) return planWith(containers, view, stage, { ...still, ...v.opts, ...(seats?.recent ? { recent: seats.recent } : {}), dragging }, v.band, seats?.demoted, seats?.compact, seats?.agendaHead);
  }
  // A card the owner placed and sized is drawn at his size wherever it fits (owner 2026-10-29,
  // "alan var mı?": a 2x2 he grew into an empty column was drawn smaller, so refused, for a column
  // it does not stand in). The plan that sets such a card aside from its column is kept only when
  // it costs nothing: no card more in Others, none off the stage or over another, the centre no
  // further off the middle. Otherwise the stage is exactly as before.
  const base = planStageAgenda(containers, view, stage, opts);
  if (opts.ownerAside !== undefined) return base;
  const shrunk = containers.some((c) => c.pos && c.place === 'float' && (c.size ?? 'small') !== 'small'
    && base.cards[c.id] && (base.cards[c.id].where !== 'float' || (base.cards[c.id].size ?? 'small') !== c.size));
  if (!shrunk) return base;
  const alt = planStageAgenda(containers, view, stage, { ...opts, ownerAside: true });
  const was = new Set([...base.others, ...(base.more?.ids ?? [])]);
  const a = stageCost(alt);
  const b = stageCost(base);
  const inFree = (r: Rect) => r.x >= alt.free.x - 1e-6 && r.y >= alt.free.y - 1e-6
    && r.x + r.width <= alt.free.x + alt.free.width + 1e-6 && r.y + r.height <= alt.free.y + alt.free.height + 1e-6;
  const sideOf = (p: StagePlan, r: Rect) => r.x + r.width / 2 < p.centre.x + p.centre.width / 2;
  const calm = Object.values(alt.cards).every((c) => {
    if (c.where !== 'float') return true;
    const before = base.cards[c.id];
    // Nothing crosses to the other side of the centre, and a card drawn anew stays in the free area.
    if (before?.where === 'float' && sideOf(base, before.rect) !== sideOf(alt, c.rect)) return false;
    return (before?.where === 'float' && before.rect.x === c.rect.x && before.rect.y === c.rect.y) || inFree(c.rect);
  });
  return calm && [...alt.others, ...(alt.more?.ids ?? [])].every((id) => was.has(id)) && a.unsound === 0 && a.offMid <= b.offMid + 1e-6 ? alt : base;
}

function planStageAgenda(
  containers: readonly StageItem[],
  view: SuperView,
  stage: { width: number; height: number },
  opts: PlanOptions,
): StagePlan {
  // The agenda's width (owner 2026-10-29, "Agenda büyümüyor?": its list whenever there is room) is
  // judged on the WHOLE plan, the owner's dropped cards and every re-plan included: the widest,
  // from its own size down, whose stage is no worse than with the 1x1 counts: no more cards in
  // Others or the pill, none more off the stage or over another. The chat's width is the stage's
  // whatever the agenda's (owner 2026-11-06); beside a wide agenda it may leave the middle.
  const ag = opts.agendaCap === undefined ? containers.find((c) => c.kind === 'agenda' && c.place === 'float') : undefined;
  const own = ag ? SIZE_UNITS[sizeOf(ag)].w : 1;
  // What the owner sized keeps his size (owner 2026-11-06): jobs wait in the pill first.
  if (own <= 1 || ag!.sizeBy === 'owner') return planStageOnce(containers, view, stage, opts);
  const counts = planStageOnce(containers, view, stage, { ...opts, agendaCap: 1 });
  const worse = stageCost(counts);
  // The widest that sends the fewest cards off the stage (the counts when none is better).
  let best = counts;
  let cost = worse;
  for (let cap = own; cap > 1; cap--) {
    const p = planStageOnce(containers, view, stage, { ...opts, agendaCap: cap });
    // A width it is not drawn at buys nothing (its column may still move the chat).
    if (SIZE_UNITS[p.cards[ag!.id]?.size ?? 'small'].w < Math.min(cap, own)) continue;
    const c = stageCost(p);
    if (c.unsound < cost.unsound || (c.unsound === cost.unsound && c.others < cost.others)
      || (best === counts && c.unsound <= worse.unsound && c.others <= worse.others)) { best = p; cost = c; }
  }
  return best;
}

/** What a plan costs the owner: the centre off the middle, cards in Others, floating cards off the stage or over another. */
function stageCost(p: StagePlan): { offMid: number; others: number; unsound: number } {
  const fl = Object.values(p.cards).filter((c) => c.where === 'float');
  let unsound = 0;
  for (const c of fl) {
    const r = c.rect;
    if (r.x < -1e-6 || r.y < -1e-6 || r.x + r.width > p.width + 1e-6 || r.y + r.height > p.height + 1e-6) unsound++;
    if (p.mode === 'float' && overlaps(r, p.centre)) unsound++;
    for (const d of fl) if (c.id < d.id && overlaps(r, d.rect)) unsound++;
  }
  // A live job in the "more" pill is off the stage as much as one in Others.
  return { offMid: Math.abs(p.centre.x + p.centre.width / 2 - p.width / 2), others: p.others.length + (p.more?.ids.length ?? 0), unsound };
}

function planStageOnce(
  containers: readonly StageItem[],
  view: SuperView,
  stage: { width: number; height: number },
  opts: PlanOptions,
): StagePlan {
  // The bottom band only while it holds something (owner 2026-10-21): plan with the content down
  // to the margin first; a dock with terminals, a narrow stage, or a plan that draws a card in
  // Others reserves the band and plans again (the same inputs always give the same screen).
  // An empty stage keeps the band: its first-run hint is drawn there (review Major).
  const narrow = Math.max(0, stage.width) < (opts.narrowPx ?? NARROW_STAGE_PX);
  const tag = (p: StagePlan, band: boolean) => {
    VARIANT.set(p, { band, opts: { agendaCap: opts.agendaCap, ownerAside: opts.ownerAside } });
    return p;
  };
  if (!narrow && !(opts.terminals ?? 0) && !opts.agendaPill && containers.length > 0) {
    const tall = planWith(containers, view, stage, opts, false);
    if (tall.others.length === 0 && !tall.more) return tag(tall, false);
  }
  return tag(planWith(containers, view, stage, opts, true), true);
}

/** The sized cards a float plan drew in Others or at 1x1 after its first pass (planWith). */
const SEATS = new WeakMap<StagePlan, { demoted: ReadonlySet<string>; compact: ReadonlySet<string>; agendaHead: boolean; recent?: readonly string[] }>();
/** Which of planStage's candidates a plan is (its internal options and its bottom band), so a
 *  running drag is held inside the plan the stage drew before the pickup. */
const VARIANT = new WeakMap<StagePlan, { band: boolean; opts: Pick<PlanOptions, 'agendaCap' | 'ownerAside'> }>();

function planWith(
  containers: readonly StageItem[],
  view: SuperView,
  stage: { width: number; height: number },
  opts: PlanOptions,
  bottomBand: boolean,
  /** Sized cards a first float pass could not seat: drawn in Others, and the sides are solved
   *  without them (a side never stays wide, narrowing the centre, for a card it does not show). */
  demoted: ReadonlySet<string> = new Set(),
  /** The same for the agenda or a live job, which never give way for their size: planned again
   *  at 1x1 instead. */
  compact: ReadonlySet<string> = new Set(),
  /** While a card is held: the minimised agenda stood in the head before the pickup (it stays there). */
  agendaHead = false,
): StagePlan {
  // Items: at most the record's MAX_CONTAINERS cards, plus a grouped card the view presents beside its group.
  const list = containers.slice(0, MAX_CONTAINERS + MAX_FILMSTRIP);
  // A page side by side or a presentation keeps its bands: it is drawn over the chat's head, and
  // its exits live there.
  const phone = stage.width > 0 && stage.width < PHONE_STAGE_PX && view.mode === 'float';
  const f = frameOf(Math.max(0, stage.width), Math.max(0, stage.height), bottomBand, opts.centreMin,
    phone ? { queue: !!opts.queueUp, terminals: (opts.terminals ?? 0) > 0 } : undefined, opts.queueUp ? opts.queueHeight ?? STAGE.BAND : STAGE.BAND);
  const narrow = f.width < (opts.narrowPx ?? NARROW_STAGE_PX);
  const ids = new Set(list.map((c) => c.id));
  // An item's place in the RECORD (a group stands at its first card's), not in this list: a
  // grouping removes cards from the list and must not move any other card to the other side.
  const z = new Map(list.map((c, i) => [c.id, c.slot ?? i] as const));
  const liveIds = new Set(list.filter((c) => c.live).map((c) => c.id));
  const cards: Record<string, CardPlan> = {};
  const others: string[] = [];
  /** The corners that found no room beside the chat, on a floating stage. */
  const inHead = { others: false, agenda: false };
  const toOthers = (c: StageItem) => {
    cards[c.id] = { id: c.id, rect: f.othersRect, where: 'others', shape: c.shape, owner: false, z: z.get(c.id) ?? 0 };
    others.push(c.id);
  };
  const finish = (centre: Rect, centreWidth: number, mode: SuperView['mode'], unit = { left: 0, right: 0 }, orbit: OrbitArc[] = [],
    extra: Partial<Pick<StagePlan, 'layout' | 'chat' | 'tabs' | 'strip' | 'controls'>> = {}): StagePlan => {
    // Others in record order, whatever order they were sent there in; a live job leads it (a
    // narrow stage, or one the owner put away himself).
    others.sort((a, b) => Number(liveIds.has(b)) - Number(liveIds.has(a)) || (z.get(a) ?? 0) - (z.get(b) ?? 0));
    return {
      width: f.width, height: f.height, narrow, phone, othersInHead: phone || inHead.others, agendaInHead: phone || inHead.agenda, mode, centre, cards, others,
      othersRect: f.othersRect, othersZone: f.othersZone, agendaPill: f.agendaPill, pill: opts.agendaPill ?? null, ...bands(f, centre, !!opts.agendaPill, extra.controls), free: f.free,
      centreWidth, unit, order: list.map((c) => c.id), orbit, layout: null, chat: 'column', ...(more ? { more } : {}), ...(railPlan ? { rail: railPlan } : {}), ...extra,
    };
  };
  const place = (id: string, rect: Rect, where: CardWhere) => {
    const c = list.find((x) => x.id === id)!;
    cards[id] = { id, rect, where, shape: c.shape, owner: false, z: z.get(id) ?? 0 };
  };

  // Live jobs stay on the stage beside a page or a presentation (owner 2026-10-23): ONE column of
  // tiles at the left edge (owner 2026-10-28: a second column squeezed the chat), and what it leaves
  // is the content the view draws in. Jobs past what the column holds wait in a temporary "more"
  // tile at its foot (Others' pill, lit by their live status), gone when the view ends.
  let more: StagePlan['more'];
  /** What the one-line rail saved over the tiles; the presentation hands it to the chat. */
  let railSaved = 0;
  let railPlan: StagePlan['rail'];
  const besideRail = (picked: readonly string[], presenting = false): Rect => {
    const rail = narrow ? [] : list.filter((c) => c.live && c.kind === 'chat' && c.place === 'float' && !picked.includes(c.id));
    const { TILE: T, GAP, BAND } = STAGE;
    // Tight: every job one line, so the chat reads. A card the owner sized keeps the rail of tiles.
    const tilesFit = f.content.width - (T + GAP) >= STAGE.PRESENT_MIN + GAP + STAGE.REGION_MIN && capacity(f.content.height) >= rail.length;
    const ownerSized = rail.some((c) => c.sizeBy === 'owner' && sizeOf(c) !== 'small');
    if (presenting && opts.miniRail && rail.length && f.width < STAGE.MINI_RAIL_STAGE && !(ownerSized && tilesFit)) {
      const { MINI_RAIL_W: W, MINI_RAIL_H: H, MINI_RAIL_GAP: G } = STAGE;
      const fits = Math.max(0, Math.floor((f.content.height + G) / (H + G)));
      // Past what the column holds the strip scrolls (owner 2026-10-31): none falls to Others.
      const visible = Math.max(1, Math.min(rail.length, fits));
      const start = Math.min(Math.max(0, Math.round(opts.railStart ?? 0)), rail.length - visible);
      const top = f.content.y + (f.content.height - visible * H - (visible - 1) * G) / 2;
      rail.forEach((c, i) => {
        const k = i - start;
        const hidden = k < 0 || k >= visible;
        cards[c.id] = { id: c.id, rect: { x: f.content.x, y: top + Math.min(Math.max(k, 0), visible - 1) * (H + G), width: W, height: H }, where: 'float', shape: 'square', size: 'small', owner: false, z: z.get(c.id) ?? 0, mini: true, ...(hidden ? { hidden: true } : {}) };
      });
      railPlan = { rect: { x: f.content.x, y: top, width: W, height: visible * H + (visible - 1) * G }, start, visible, total: rail.length };
      railSaved = T - W;
      return { ...f.content, x: f.content.x + W + GAP, width: f.content.width - W - GAP };
    }
    // The rail never squeezes what the owner looks at: the centre keeps PRESENT_MIN and the page
    // (or the presented cards' region) REGION_MIN, else there is no rail and its jobs lead Others.
    const keep = STAGE.PRESENT_MIN + GAP + STAGE.REGION_MIN;
    if (!rail.length || capacity(f.content.height) < 1 || f.content.width - (T + GAP) < keep) return f.content;
    const over = rail.length > capacity(f.content.height);
    const shown = over ? rail.slice(0, capacity(f.content.height - BAND - GAP)) : rail;
    const rest = rail.slice(shown.length);
    const total = shown.length * T + Math.max(0, shown.length - 1) * GAP + (rest.length ? (shown.length ? GAP : 0) + BAND : 0);
    let y = f.content.y + (f.content.height - total) / 2;
    for (const c of shown) {
      cards[c.id] = { id: c.id, rect: { x: f.content.x, y, width: T, height: T }, where: 'float', shape: 'square', size: 'small', owner: false, z: z.get(c.id) ?? 0 };
      y += T + GAP;
    }
    if (rest.length) {
      const rect: Rect = { x: f.content.x, y: shown.length ? y : f.content.y + (f.content.height - BAND) / 2, width: T, height: BAND };
      more = { rect, ids: rest.map((c) => c.id) };
      // Drawn inside the tile (as a card in Others is drawn in the stack), never in Others.
      for (const c of rest) cards[c.id] = { id: c.id, rect, where: 'others', shape: c.shape, owner: false, z: z.get(c.id) ?? 0 };
    }
    return { ...f.content, x: f.content.x + T + GAP, width: f.content.width - T - GAP };
  };

  /** A single PORTRAIT picture's shape (owner 2026-11-07: a phone screenshot gets a card as narrow
   *  as it needs, the chat the width it frees). Landscape, several pictures and a card the owner
   *  sized keep today's box. */
  const pictureAspect = (id: string): number | undefined => {
    const it = list.find((x) => x.id === id);
    return it?.kind === 'image' && it.sizeBy !== 'owner' && it.aspect !== undefined && it.aspect < 1 ? it.aspect : undefined;
  };

  /** The card a measured page needs, chrome included; absent = it takes what it is given. */
  const pageWidth = (id: string): number | undefined => {
    const fit = list.find((x) => x.id === id)?.fit;
    return fit ? Math.max(fit + STAGE.CARD_CHROME.w + STAGE.WIDGET_BORDER_W, STAGE.FIT_MIN.w) : undefined;
  };

  // ── half (a narrow stage opens it as a sheet over the centre) ──
  const half = view.mode === 'half' && view.card && ids.has(view.card) ? view.card : null;
  if (half) {
    const content = besideRail([half]);
    let centre: Rect;
    let region: Rect;
    if (narrow) {
      centre = { ...f.content };
      const i = STAGE.SHEET_INSET;
      region = { x: centre.x + i, y: centre.y + i, width: centre.width - 2 * i, height: centre.height - 2 * i };
    } else {
      // A web page with a device width picked (owner 2026-10-28): the CARD takes the device's shape,
      // as presentation's fitCard does for a picture: a phone is a narrow tall card and the centre
      // takes the width it frees, a desktop a wide one and the centre narrows beside it, never under
      // PRESENT_MIN. No device: the two halves, as before.
      const item = list.find((x) => x.id === half)!;
      const C = STAGE.CARD_CHROME;
      // A picture only ever gives width: never wider than its half, narrower when its shape is.
      const pic = pictureAspect(half);
      const w = item.kind === 'web' && item.aspect
        ? Math.max(Math.min(STAGE.FIT_MIN.w, content.width / 2), Math.min(content.width - STAGE.GAP - STAGE.PRESENT_MIN, (content.height - C.h) * item.aspect + C.w))
        : pic
          ? Math.min((content.width - STAGE.GAP) / 2, Math.max(Math.min(STAGE.FIT_MIN.w, content.width / 2), (content.height - C.h) * pic + C.w))
          : Math.min((content.width - STAGE.GAP) / 2, pageWidth(half) ?? Infinity);
      centre = { x: content.x, y: content.y, width: content.width - w - STAGE.GAP, height: content.height };
      region = { x: content.x + content.width - w, y: content.y, width: w, height: content.height };
      if (item.kind === 'web' && item.aspect) region = fitCard(region, item.aspect);
      else if (pic) region = fitCard(region, pic);
    }
    place(half, region, narrow ? 'sheet' : 'half');
    for (const c of list) if (!cards[c.id]) toOthers(c);
    return finish(centre, centre.width, 'half');
  }

  // ── present: a named layout (a narrow stage opens it as a sheet over a composer bar) ──
  const pool = view.mode === 'present' ? [...new Set((view.cards ?? []).filter((id) => ids.has(id)))] : [];
  if (pool.length) {
    const layout = drawnLayout(view.layout, pool.length);
    // The agenda is never a filmstrip's big card: drawn last there (the record keeps its order).
    const kindOf = (id: string) => list.find((x) => x.id === id)?.kind;
    const shown = pool.slice(0, presentRange(layout).max);
    const ordered = layout === 'filmstrip' ? [...shown.filter((id) => kindOf(id) !== 'agenda'), ...shown.filter((id) => kindOf(id) === 'agenda')] : shown;
    const selected = opts.selected && ordered.includes(opts.selected) ? opts.selected : ordered[0];
    const choices = opts.layoutChoices ?? PRESENT_LAYOUTS.filter((p) => p !== 'review' && shown.length >= presentRange(p).min && shown.length <= presentRange(p).max).length;
    const cw = (opts.groupExit ? STAGE.GROUP_EXIT_W : STAGE.EXIT_W) + (choices > 1 ? STAGE.GAP / 2 + choices * STAGE.SWITCH_SEG_W : 0);
    const controls: Rect = { x: f.content.x + Math.max(0, f.content.width - cw), y: f.bandTop, width: Math.min(cw, f.content.width), height: STAGE.BAND };
    const strip = (main: Rect): StripPlan => {
      // The big card over one row holding a slot for EVERY card, in their fixed order: the big
      // one's slot is marked, never given to another card (selecting never reorders).
      const row: Rect = { x: main.x, y: main.y + main.height - STAGE.STRIP_H, width: main.width, height: STAGE.STRIP_H };
      place(selected, { x: main.x, y: main.y, width: main.width, height: Math.max(0, main.height - STAGE.STRIP_H - STAGE.GAP) }, narrow ? 'sheet' : 'present');
      const n = ordered.length;
      const fitW = (w: number) => (w - (n - 1) * STAGE.GAP) / n;
      const overflow = fitW(row.width) < STAGE.THUMB_MIN_W;
      // More than fit: scroll buttons at both ends, the slots at their floor width between them.
      const nav = overflow ? STAGE.STRIP_NAV_W + STAGE.GAP / 2 : 0;
      const inner: Rect = { x: row.x + nav, y: row.y, width: Math.max(0, row.width - 2 * nav), height: row.height };
      const tw = overflow ? STAGE.THUMB_MIN_W : Math.min(STAGE.THUMB_MAX_W, fitW(inner.width));
      const visible = overflow ? Math.max(1, Math.floor((inner.width + STAGE.GAP) / (tw + STAGE.GAP))) : n;
      const start = Math.min(Math.max(0, Math.round(opts.stripStart ?? 0)), n - visible);
      let current: Rect | undefined;
      ordered.forEach((id, i) => {
        const k = i - start;
        const rect: Rect = { x: inner.x + k * (tw + STAGE.GAP), y: row.y, width: tw, height: row.height };
        if (id === selected) { if (k >= 0 && k < visible) current = rect; return; }
        place(id, rect, 'thumb');
        if (k < 0 || k >= visible) cards[id] = { ...cards[id], hidden: true };
      });
      return {
        rect: row, big: selected, ids: ordered, start, visible, ...(current ? { current } : {}),
        ...(overflow ? {
          prev: { x: row.x, y: row.y, width: STAGE.STRIP_NAV_W, height: row.height },
          next: { x: row.x + row.width - STAGE.STRIP_NAV_W, y: row.y, width: STAGE.STRIP_NAV_W, height: row.height },
        } : {}),
      };
    };

    if (narrow) {
      // Any layout is the sheet; the agent's composer is a bar under it (D14). A question of his
      // open: the chat at the mini's height, its transcript shown, so the question is there (D7).
      const i = STAGE.SHEET_INSET;
      const barH = opts.asking ? Math.min(STAGE.MINI_MAX_H, Math.max(STAGE.MINI_MIN_H, STAGE.MINI_FRAC_H * f.height), f.content.height / 2) : STAGE.CHAT_BAR_H;
      const bar: Rect = { x: f.content.x, y: f.content.y + f.content.height - barH, width: f.content.width, height: barH };
      const sheet: Rect = { x: f.content.x + i, y: f.content.y + i, width: f.content.width - 2 * i, height: Math.max(0, f.content.height - barH - STAGE.GAP - i) };
      const extra = { layout, chat: opts.asking ? 'mini' as const : 'bar' as const, controls };
      if (layout === 'filmstrip') {
        const st = strip(sheet);
        for (const c of list) if (!cards[c.id]) toOthers(c);
        return finish(bar, bar.width, 'present', undefined, undefined, { ...extra, strip: st });
      }
      if (ordered.length === 1) {
        place(ordered[0], sheet, 'sheet');
        for (const c of list) if (!cards[c.id]) toOthers(c);
        return finish(bar, bar.width, 'present', undefined, undefined, extra);
      }
      const tabs: Rect = { x: sheet.x, y: sheet.y, width: sheet.width, height: STAGE.TAB_H };
      const body: Rect = { x: sheet.x, y: sheet.y + STAGE.TAB_H + STAGE.GAP / 2, width: sheet.width, height: Math.max(0, sheet.height - STAGE.TAB_H - STAGE.GAP / 2) };
      for (const id of ordered) place(id, body, id === selected ? 'sheet' : 'tab');
      for (const c of list) if (!cards[c.id]) toOthers(c);
      return finish(bar, bar.width, 'present', undefined, undefined, { ...extra, tabs: { rect: tabs, ids: ordered } });
    }

    // A wide stage keeps the live jobs beside the presentation; the layouts draw in what they leave.
    const content = besideRail(ordered, true);
    if (layout === 'compare' || layout === 'grid') {
      // The centre as a left column, the cards in a grid on the right (as before layouts); the
      // centre's share is of what the rail leaves (the rail narrows the centre and the cards alike).
      // The chat's floor gives way (down to REGION_MIN) only so two cards keep FIT_MIN side by side
      // (a 968 px touch stage).
      const share = Math.min(STAGE.PRESENT_MAX, Math.max(STAGE.PRESENT_MIN, STAGE.PRESENT_FRAC * (content.width + 2 * STAGE.MARGIN)));
      const plainW = Math.max(STAGE.REGION_MIN, Math.min(share, content.width - 2 * STAGE.GAP - 2 * STAGE.FIT_MIN.w));
      // A one-line rail hands its width to the chat; two cards keep FIT_MIN side by side.
      const w = railSaved ? Math.max(plainW, Math.min(Math.max(plainW + railSaved, STAGE.PRESENT_MIN), content.width - 2 * STAGE.GAP - 2 * STAGE.FIT_MIN.w)) : plainW;
      const items = ordered.map((id) => ({ aspect: list.find((x) => x.id === id)?.aspect }));
      const regionAt = (cw: number): Rect => ({ x: content.x + cw + STAGE.GAP, y: content.y, width: content.width - cw - STAGE.GAP, height: content.height });
      // Every card a measured page: the region is as wide as they need, the chat takes the rest.
      const needs = ordered.map(pageWidth);
      let chatW = w;
      if (needs.every((n) => n !== undefined)) {
        const cols = new Set(fitArrange(regionAt(w), items).slots.map((r) => r.x)).size;
        const need = cols * Math.max(...(needs as number[])) + (cols - 1) * STAGE.GAP;
        chatW = Math.max(w, content.width - STAGE.GAP - need);
      }
      const centre: Rect = { x: content.x, y: content.y, width: chatW, height: content.height };
      const { rects } = fitArrange(regionAt(chatW), items);
      ordered.forEach((id, k) => place(id, rects[k], 'present'));
      for (const c of list) if (!cards[c.id]) toOthers(c);
      return finish(centre, centre.width, 'present', undefined, undefined, { layout, chat: 'column', controls });
    }

    // Spotlight, filmstrip, review: the agent is a mini square bottom-left (or its composer bar,
    // when the owner folded it and no question of his is open), the cards take the rest.
    const c = content;
    const chat: ChatDraw = view.chat === 'bar' && !opts.asking ? 'bar' : 'mini';
    const plainMiniW = Math.min(STAGE.MINI_MAX_W, Math.max(STAGE.MINI_MIN_W, STAGE.MINI_FRAC_W * f.width));
    // With a one-line rail the chat reads at its comfortable width, and the cards keep their floor.
    const gain = railSaved ? STAGE.MINI_RAIL_W_WIDE - STAGE.MINI_RAIL_W : 0;
    const roomyMiniW = railSaved ? Math.max(plainMiniW + railSaved, Math.min(STAGE.PRESENT_MIN, c.width - STAGE.GAP - STAGE.REGION_MIN - gain) + gain) : plainMiniW;
    // The review's page, or the one big card: narrower than what the cards are left, a measured
    // page gives the rest to the chat beside it (a chat folded to its bar has no use for it).
    // A review's row keeps its cards at their floor under it.
    const page = layout === 'review' ? ordered.find((id) => kindOf(id) === 'web') ?? ordered.find((id) => kindOf(id) === 'browser') ?? ordered[0] : ordered[0];
    const rowFloor = layout === 'review' && ordered.length > 1 ? (ordered.length - 1) * (STAGE.FIT_MIN.w + STAGE.GAP) - STAGE.GAP : 0;
    const pageNeed = layout !== 'filmstrip' && chat === 'mini' ? pageWidth(page) : undefined;
    const fitted = pageNeed !== undefined && c.width - roomyMiniW - STAGE.GAP > Math.max(pageNeed, rowFloor);
    const reviewRowH = (h: number) => Math.min(STAGE.REVIEW_ROW_MAX, Math.max(STAGE.REVIEW_ROW_MIN, STAGE.REVIEW_ROW_FRAC * h));
    // A web page with a device width picked (owner 2026-10-31), as half does: the CARD takes the
    // device's shape and the chat the width that leaves, down to its own floor. Its page has no
    // measured width (stageItems), so this and `fitted` never meet. A folded chat wants no width:
    // the card sits in the middle of what it leaves.
    const pageItem = list.find((x) => x.id === page);
    const device = layout !== 'filmstrip' && pageItem?.kind === 'web' ? pageItem.aspect : undefined;
    // One portrait picture in the spotlight (owner 2026-11-07) hugs its shape the same way, but only
    // ever GIVES width: the chat never drops under its own width.
    const pic = layout === 'spotlight' && !device ? pictureAspect(page) : undefined;
    const shape = device ?? pic;
    const deviceW = shape && chat === 'mini'
      ? Math.min(c.width - STAGE.GAP - (device ? STAGE.MINI_MIN_W : roomyMiniW), Math.max(
        Math.min(STAGE.FIT_MIN.w, c.width / 2),
        rowFloor,
        ((layout === 'review' ? c.height - reviewRowH(c.height) - STAGE.GAP : c.height) - STAGE.CARD_CHROME.h) * shape + STAGE.CARD_CHROME.w,
      ))
      : undefined;
    const pageRect = (r: Rect): Rect => (shape ? fitCard(r, shape) : r);
    const miniW = deviceW !== undefined ? c.width - STAGE.GAP - deviceW : fitted ? c.width - STAGE.GAP - Math.max(pageNeed, rowFloor) : roomyMiniW;
    // The chat takes the whole left column (owner 2026-10-25): a short mini left an unused gap above it.
    const miniH = c.height;
    const centre: Rect = chat === 'bar'
      ? { x: c.x, y: c.y + c.height - STAGE.CHAT_BAR_H, width: miniW, height: STAGE.CHAT_BAR_H }
      : { x: c.x, y: c.y + c.height - miniH, width: miniW, height: miniH };
    const main: Rect = chat === 'bar'
      ? { x: c.x, y: c.y, width: c.width, height: Math.max(0, c.height - STAGE.CHAT_BAR_H - STAGE.GAP) }
      : { x: c.x + miniW + STAGE.GAP, y: c.y, width: Math.max(0, c.width - miniW - STAGE.GAP), height: c.height };
    const extra = { layout, chat, controls };
    if (layout === 'filmstrip') {
      const st = strip(main);
      for (const k of list) if (!cards[k.id]) toOthers(k);
      return finish(centre, centre.width, 'present', undefined, undefined, { ...extra, strip: st });
    }
    if (layout === 'review') {
      // The child's page big on top (its site, else its browser), its other cards in a row under it.
      const rest = ordered.filter((id) => id !== page);
      const rowH = reviewRowH(main.height);
      place(page, pageRect({ x: main.x, y: main.y, width: main.width, height: Math.max(0, main.height - rowH - STAGE.GAP) }), 'present');
      const rw = rest.length ? (main.width - (rest.length - 1) * STAGE.GAP) / rest.length : 0;
      rest.forEach((id, k) => place(id, { x: main.x + k * (rw + STAGE.GAP), y: main.y + main.height - rowH, width: rw, height: rowH }, 'present'));
      if (fitted) cards[page] = { ...cards[page], fitted };
      for (const k of list) if (!cards[k.id]) toOthers(k);
      return finish(centre, centre.width, 'present', undefined, undefined, extra);
    }
    place(ordered[0], pageRect(main), 'present');
    if (fitted) cards[page] = { ...cards[page], fitted };
    for (const k of list) if (!cards[k.id]) toOthers(k);
    return finish(centre, centre.width, 'present', undefined, undefined, extra);
  }

  // ── narrow: the centre takes the width, every card is in Others ──
  if (narrow) {
    for (const c of list) toOthers(c);
    if (phone) return finish({ ...f.content }, f.content.width, 'float');
    // No side room at all, whatever the window's proportions: both corners go to the chat's head
    // and the chat runs margin to margin. Only the terminals' dock or the first-run hint keeps the
    // bottom band, and neither is a reason to give up the top.
    const docked = (list.length === 0 && !opts.agendaPill) || (opts.terminals ?? 0) > 0;
    inHead.others = inHead.agenda = !docked;
    const top = opts.queueUp ? f.content.y : STAGE.MARGIN;
    const bottom = docked ? f.content.y + f.content.height : f.height - STAGE.MARGIN;
    return finish({ ...f.content, y: top, height: Math.max(0, bottom - top) }, f.content.width, 'float');
  }

  // ── float ──
  const drag = opts.dragging && ids.has(opts.dragging.id) ? opts.dragging : null;
  // The card under the owner's hand is never drawn in Others mid-drag, even when the plan held
  // for the drag would seat it there: it stays at its rect and stays out of the solve.
  const heldOut = drag && demoted.has(drag.id) ? drag.id : null;
  const floating = list.filter((c) => c.place === 'float' && (!demoted.has(c.id) || c.id === heldOut));
  for (const c of list) if (c.id !== heldOut && (c.place !== 'float' || demoted.has(c.id))) toOthers(c);
  const isOwner = (c: StageItem) => !!c.pos || c.id === drag?.id;
  const owned = floating.filter(isOwner);

  // Every floating card has a side by its place in the WHOLE record (Others included),
  // alternating left/right; an owner-placed card counts on the side it sits on (its saved pos,
  // the same test pushOut uses). A card sent to Others or brought back (neither reorders the
  // record) and a drop on the side the card stood on change no other card's side. Only when one
  // side ends up two or more cards heavier does that side's last card WITHOUT a saved pos cross
  // over, one at a time: the stage stays balanced and moves as few cards as it can. The running
  // drag is not read here, so a drag start never changes the plan.
  const sideOf = new Map<string, 'left' | 'right'>(floating.map((c) => [
    c.id, c.pos ? (c.pos.x < 0.5 ? 'left' : 'right') : (z.get(c.id) ?? 0) % 2 === 0 ? 'left' : 'right',
  ] as const));
  for (;;) {
    const onLeft = floating.filter((c) => c.id !== heldOut && sideOf.get(c.id) === 'left');
    const onRight = floating.filter((c) => c.id !== heldOut && sideOf.get(c.id) === 'right');
    if (Math.abs(onLeft.length - onRight.length) <= 1) break;
    const [heavy, to] = onLeft.length > onRight.length ? [onLeft, 'right' as const] : [onRight, 'left' as const];
    const mover = [...heavy].reverse().find((c) => !c.pos);
    if (!mover) break;
    sideOf.set(mover.id, to);
  }
  // The agenda stays on the stage like a live job (owner 2026-10-28: on a small window it is the
  // compact counts, never sent to Others): it gives way as late as a live job does.
  const keeps = (c: StageItem) => !!c.live || c.kind === 'agenda';
  const slotsOn = (side: 'left' | 'right'): Slot[] =>
    // The solve sees the stage as it was before a pickup (a drag start never changes the plan);
    // only the placement below holds the dragged card at its rect.
    floating.filter((c) => sideOf.get(c.id) === side && c.id !== heldOut).map((c) => ({ id: c.id, owner: !!c.pos, chat: c.kind === 'chat' || c.kind === 'group' || c.kind === 'agenda', ...(keeps(c) ? { live: true } : {}), ...(c.sizeBy === 'owner' ? { sized: true } : {}) }));
  const sizeById = new Map(floating.map((c) => [c.id, compact.has(c.id) ? 'small' as const : sizeOf(c)] as const));
  const agendaIds = new Set(floating.filter((c) => c.kind === 'agenda').map((c) => c.id));
  const withSize = (sl: Slot): SizedSlot => ({ ...sl, size: sizeById.get(sl.id) ?? 'small', z: z.get(sl.id) ?? 0, ...(agendaIds.has(sl.id) ? { agenda: true } : {}) });

  // One pass with every item on its side's orbit, the owner's included where they would stand:
  // it sets the stage. An owner tile is drawn at the one tile size wherever he dropped it.
  // A stage of small cards keeps the orbit exactly as it was; one sized card packs the sides by
  // size (solveSized).
  const sized = floating.some((c) => c.id !== heldOut && sizeById.get(c.id) !== 'small');
  const sol = sized
    ? solveSized(f, slotsOn('left').map(withSize), slotsOn('right').map(withSize), opts.agendaCap, !!opts.ownerAside)
    : { ...solveFloat(f, slotsOn('left'), slotsOn('right')), drawn: new Map<string, ContainerSize>(), uRight: undefined };
  const drawnOf = (id: string): ContainerSize => sol.drawn.get(id) ?? (id === heldOut ? sizeById.get(id) ?? 'small' : 'small');
  // The float centre takes the stage's height (owner 2026-10-25; 2026-10-28 for a windowed app):
  // from the top margin to the bottom margin, its width unchanged, the side cards where they were.
  // The top band is kept only while the queue pill shows there. The bottom band's corners (the
  // Others stack, the agenda's pill) narrow into the side room beside the centre, down to
  // OTHERS_MIN_W; a corner with no room there moves to the chat's head (owner 2026-11-01, a centre
  // leaning right leaves none), so neither ever takes the centre's height. It keeps the bottom
  // band only while the terminals dock runs under it or the stage is empty (its hint).
  const sc = sol.centre;
  const rightRoom = f.width - STAGE.MARGIN - (sc.x + sc.width + STAGE.GAP);
  const leftRoom = sc.x - STAGE.GAP - STAGE.MARGIN;
  const othersFit = rightRoom >= STAGE.OTHERS_MIN_W - 1e-9;
  const pillFits = leftRoom >= STAGE.OTHERS_MIN_W - 1e-9;
  // A minimised agenda is out of the list but the stage is not empty: no hint, no band.
  const tallBottom = (list.length > 0 || !!opts.agendaPill) && !(opts.terminals ?? 0);
  if (tallBottom) {
    inHead.others = !othersFit;
    inHead.agenda = !!opts.agendaPill && !pillFits;
    if (othersFit) f.othersRect = { ...f.othersRect, x: f.width - STAGE.MARGIN - Math.min(STAGE.OTHERS_W, rightRoom), width: Math.min(STAGE.OTHERS_W, rightRoom) };
    if (pillFits) f.agendaPill = { ...f.agendaPill, width: Math.min(STAGE.AGENDA_PILL_W, leftRoom) };
    // The drop corner stays beside the chat (a pointer over the chat asks about the card): with
    // no stack there it still holds the strip to the stage's edge.
    const zx = Math.max(f.othersZone.x, sc.x + sc.width + (othersFit ? STAGE.GAP : 0));
    f.othersZone = { ...f.othersZone, x: zx, width: f.width - zx };
  }
  const top = opts.queueUp ? sc.y : STAGE.MARGIN;
  const bottom = tallBottom ? f.height - STAGE.MARGIN : sc.y + sc.height;
  const centre: Rect = { ...sc, y: top, height: Math.max(0, bottom - top) };

  // The owner's cards sit where he dropped them, pushed out of the centre and into the stage.
  // Two of his cards never overlap (owner 2026-10-28: "a card ends up under another"): the one
  // he dropped later this session (else the later in the record) keeps its place, an earlier
  // one moves to the nearest free spot, else it is drawn in Others. A running drag holds its
  // drag-start rect and is never moved.
  const recent = opts.recent ?? [];
  const rank = (id: string) => { const i = recent.indexOf(id); return i >= 0 ? MAX_CONTAINERS * 2 + i : (z.get(id) ?? 0); };
  const ownerRects = new Map<string, Rect>();
  const autoSpots = [...sol.rects.entries()].filter(([id]) => !sol.overflow.has(id) && !owned.some((c) => c.id === id)).map(([, r]) => r);
  const ownerBlocks: Rect[] = [centre];
  if (drag && owned.some((c) => c.id === drag.id)) { ownerRects.set(drag.id, drag.rect); ownerBlocks.push(drag.rect); }
  for (const c of [...owned].filter((c) => c.id !== drag?.id).sort((a, b) => rank(b.id) - rank(a.id))) {
    const px = sizePx(drawnOf(c.id));
    const want = pushOut(rectFromPos(f.free, c.pos!, px.width, px.height), centre, f.free, sideOf.get(c.id));
    // Free of his other cards: where he dropped it; else the nearest spot clear of the auto
    // cards too (so it moves as few of them as it can), else the nearest clear of his alone.
    const rect = clear(want, ownerBlocks) ? want : findFree(want, f.free, [...ownerBlocks, ...autoSpots]) ?? findFree(want, f.free, ownerBlocks);
    if (!rect) { toOthers(c); continue; }
    ownerRects.set(c.id, rect);
    ownerBlocks.push(rect);
  }

  // An auto card clear of the owner's keeps its place; one they cover moves to the free spot of
  // its own column nearest where it stood (at its size, else 1:1), else to the nearest free spot
  // anywhere on the stage, else it is drawn in Others: the stage moves as few cards as it can.
  const owners = [...ownerRects.values()];
  const covered = (r: Rect) => owners.some((b) => overlaps(r, inflate(b, STAGE.GAP - 0.5)));
  const blocks: Rect[] = [...owners];
  const moved: StageItem[] = [];
  const auto = (c: StageItem, rect: Rect) => {
    cards[c.id] = { id: c.id, rect, where: 'float', shape: drawnShape(rect), size: drawnOf(c.id), owner: false, z: z.get(c.id) ?? 0 };
  };
  for (const c of floating) {
    if (isOwner(c)) continue;
    const at = sol.rects.get(c.id);
    if (!at || sol.overflow.has(c.id)) toOthers(c);
    else if (covered(at)) moved.push(c);
    else { blocks.push(at); auto(c, at); }
  }
  // A live job (and the agenda) finds its free spot first: it is the last to be drawn in Others.
  moved.sort((a, b) => Number(keeps(b)) - Number(keeps(a)));
  // Every one first tries its own column (as before), then the ones left over try the stage.
  const homeless: StageItem[] = [];
  for (const c of moved) {
    const rect = reseat(sol.rects.get(c.id)!, f, blocks);
    if (!rect) { homeless.push(c); continue; }
    blocks.push(rect);
    auto(c, rect);
  }
  for (const c of homeless) {
    const want = sol.rects.get(c.id)!;
    let rect = findFree(want, f.free, [centre, ...blocks]);
    // No room left for the agenda or a live job: the latest ordinary auto card gives it its place
    // and is drawn in Others instead (they give way last, owner 2026-10-23 and 2026-10-28).
    if (!rect && keeps(c)) {
      const victims = floating
        .filter((v) => cards[v.id]?.where === 'float' && !cards[v.id].owner && !keeps(v))
        .sort((a, b) => (z.get(b.id) ?? 0) - (z.get(a.id) ?? 0));
      for (const v of victims) {
        const freed = cards[v.id].rect;
        rect = findFree(want, f.free, [centre, ...blocks.filter((b) => b !== freed)]);
        if (rect) { blocks.splice(blocks.indexOf(freed), 1); toOthers(v); break; }
      }
    }
    if (!rect) { toOthers(c); continue; }
    blocks.push(rect);
    auto(c, rect);
  }
  for (const c of owned) {
    const rect = ownerRects.get(c.id);
    if (!rect) continue;
    // Owner-placed cards paint above the auto-placed ones.
    cards[c.id] = { id: c.id, rect, where: 'float', shape: drawnShape(rect), size: drawnOf(c.id), owner: true, z: MAX_CONTAINERS + (z.get(c.id) ?? 0) };
  }
  // A sized card the solve gave its width but the placement could not seat: plan again without it.
  const unseated = floating.filter((c) => cards[c.id]?.where === 'others' && !sol.overflow.has(c.id) && SIZE_UNITS[drawnOf(c.id)].w > 1);
  // While a card is held, which cards fit was decided before the pickup (planStage passes those sets).
  if (unseated.length && !drag) {
    // A sized card of his that lost its spot to a card he has NOT dropped this session takes it
    // back first (owner 2026-11-11, "window'a git gel yaptığında"): the record order alone gave
    // the later tile the spot, so a fresh mount (a chat window or another project, then back)
    // drew his 2x2 agenda as the 1x1 counts. Ranked under every drop of this session, so his
    // latest drop still keeps its place; the small tile moves to a free spot instead.
    // Kept only when it costs nothing: no card more in Others or the pill, none off the stage or
    // over another than the plan without it.
    const kept = unseated.filter(keeps).map((c) => c.id);
    const out = unseated.filter((c) => !keeps(c)).map((c) => c.id);
    const without = planWith(containers, view, stage, opts, bottomBand, new Set([...demoted, ...out]), new Set([...compact, ...kept]));
    const reclaim = unseated.filter((c) => !!c.pos && !recent.includes(c.id)).map((c) => c.id);
    if (!reclaim.length || opts.reclaimed) return without;
    const again = planWith(containers, view, stage, { ...opts, reclaimed: true, recent: [...reclaim, ...recent] }, bottomBand, demoted, compact);
    const a = stageCost(again);
    const b = stageCost(without);
    const whole = reclaim.every((id) => again.cards[id]?.where === 'float' && again.cards[id].size === drawnOf(id));
    return whole && a.others <= b.others && a.unsound <= b.unsound ? again : without;
  }
  // Live jobs the stage has no room for wait in the "more" pill beside Others (owner 2026-11-06:
  // the chat never narrows for them, and a running job is never lost in the stack): in the bottom
  // band left of the Others stack, else in the bottom-left corner, else in Others as before.
  const floatIds = new Set(floating.map((c) => c.id));
  // A group stays in Others (its panel opens from there); the pill holds cards.
  const overflowing = () => others.filter((id) => liveIds.has(id) && floatIds.has(id) && !isGroupId(id));
  // A live job never waits while a tile is free (end review 2026-11-07: the side rows pack in
  // record order, so a sized block can leave a tile empty beside them): it takes the free tile
  // nearest where the solve wanted it, clear of the chat, every card and the bottom corners.
  {
    const tile = sizePx('small');
    const corners = [f.othersRect, ...(opts.agendaPill && !inHead.agenda ? [f.agendaPill] : [])];
    const taken = () => [centre, ...corners, ...Object.values(cards).filter((c) => c.where === 'float').map((c) => c.rect)];
    for (const id of overflowing()) {
      const at = sol.rects.get(id);
      const want = { x: at?.x ?? f.free.x, y: at?.y ?? f.free.y, width: tile.width, height: tile.height };
      const rect = findFree(want, f.free, taken());
      if (!rect) continue;
      others.splice(others.indexOf(id), 1);
      cards[id] = { id, rect, where: 'float', shape: drawnShape(rect), size: 'small', owner: false, z: z.get(id) ?? 0 };
    }
    if (!others.length) inHead.others = false;
  }
  // A pickup never moves the agenda (end review 2026-11-07): picking up the one waiting job kept
  // the head's Agenda button only if the pass below still found a job to wait.
  if (drag && agendaHead && opts.agendaPill) inHead.agenda = true;
  const liveOver = overflowing();
  if (liveOver.length) {
    const rest = others.length - liveOver.length;
    const { GAP, OTHERS_MIN_W, OTHERS_W, AGENDA_PILL_W, MARGIN } = STAGE;
    let rect: Rect | null = null;
    // The terminals' dock holds the bottom band under the whole stage: the pill stands left of
    // Others in it, and the dock ends before it.
    if (!tallBottom) rect = rest ? { x: f.othersRect.x - GAP - OTHERS_W, y: f.othersRect.y, width: OTHERS_W, height: f.othersRect.height } : { ...f.othersRect };
    else if (!rest && othersFit) rect = { ...f.othersRect };
    else if (othersFit && rightRoom - f.othersRect.width - GAP >= OTHERS_MIN_W - 1e-9) {
      const w = Math.min(OTHERS_W, rightRoom - f.othersRect.width - GAP);
      rect = { x: f.othersRect.x - GAP - w, y: f.othersRect.y, width: w, height: f.othersRect.height };
    } else if (pillFits && !opts.agendaPill) rect = { x: MARGIN, y: f.othersRect.y, width: Math.min(AGENDA_PILL_W, leftRoom), height: f.othersRect.height };
    else if (opts.agendaPill && !inHead.agenda && leftRoom - f.agendaPill.width - GAP >= OTHERS_MIN_W - 1e-9) {
      // The minimised agenda's pill holds the corner: the more pill stands right after it.
      const x = f.agendaPill.x + f.agendaPill.width + GAP;
      rect = { x, y: f.othersRect.y, width: Math.min(OTHERS_W, leftRoom - f.agendaPill.width - GAP), height: f.othersRect.height };
    } else if (opts.agendaPill && pillFits) {
      // No room for both (owner 2026-11-07): the minimised agenda moves to the head's Agenda
      // button, as on a narrow window, and the waiting jobs take its corner.
      inHead.agenda = true;
      rect = { x: MARGIN, y: f.othersRect.y, width: Math.min(AGENDA_PILL_W, leftRoom), height: f.othersRect.height };
    }
    if (rect) {
      more = { rect, ids: liveOver };
      for (const id of liveOver) {
        cards[id] = { ...cards[id], rect };
        others.splice(others.indexOf(id), 1);
      }
      if (!others.length) inHead.others = false;
    }
  }
  // A card in Others flies to the stack where it is drawn (narrowed beside a tall centre).
  for (const id of others) cards[id] = { ...cards[id], rect: f.othersRect };
  const width = (side: 'left' | 'right') => (floating.some((c) => sideOf.get(c.id) === side && cards[c.id]?.where === 'float')
    ? (side === 'right' ? sol.uRight ?? sol.u : sol.u) : 0);
  const plan = finish(centre, centre.width, 'float', { left: width('left'), right: width('right') }, sol.orbit);
  SEATS.set(plan, { demoted, compact, agendaHead: plan.agendaInHead, recent: opts.recent });
  if (more && more.rect.x < f.othersRect.x && more.rect.y === plan.dock.y) {
    plan.dock = { ...plan.dock, width: Math.max(0, Math.min(plan.dock.width, more.rect.x - STAGE.GAP - plan.dock.x)) };
  }
  return plan;
}

/** The layout a presentation is drawn in: the stored one while it takes this many cards, else the
 *  count's default (an older push carries none; the store resolves review by what the cards are). */
function drawnLayout(stored: PresentLayout | undefined, n: number): PresentLayout {
  if (stored && (PRESENT_LAYOUTS as readonly string[]).includes(stored)) {
    const r = presentRange(stored);
    if (n >= r.min && n <= r.max) return stored;
  }
  return n <= 1 ? 'spotlight' : n === 2 ? 'compare' : n <= MAX_PRESENT ? 'grid' : 'filmstrip';
}

/** Taller than wide by more than a hair: 'tall'. A floating tile is always square. */
function drawnShape(r: Rect): ContainerShape {
  return r.height > r.width * 1.1 ? 'tall' : 'square';
}

// ─── Hit tests (arithmetic on the plan, never `elementFromPoint`; FE1) ──────────

/** The pointer (stage coordinates) over the Others drop target. */
export function overOthersZone(plan: StagePlan, x: number, y: number): boolean {
  return contains(plan.othersZone, x, y);
}

/** The pointer (stage coordinates) inside the centre window: a drop there asks about the card (O11). */
export function overCentre(plan: StagePlan, x: number, y: number): boolean {
  return contains(plan.centre, x, y);
}

/**
 * The floating tile a held card would be grouped with (2026-10-20): the topmost card or group
 * under the pointer, never the held one itself. A group held over anything groups with nothing
 * (groups do not nest).
 */
export function dropTargetAt(plan: StagePlan, x: number, y: number, heldId: string): string | null {
  if (isGroupId(heldId)) return null;
  let best: CardPlan | null = null;
  for (const c of Object.values(plan.cards)) {
    if (c.id === heldId || c.where !== 'float' || !contains(c.rect, x, y)) continue;
    if (!best || c.z > best.z) best = c;
  }
  return best?.id ?? null;
}

export const isGroupId = (id: string) => id.startsWith('grp-');

// ─── The owner's edits as a patch (F3 / §0 C3) ─────────────────────────────────

export interface LayoutPatchCard {
  /** A card's id, or a group's (a drop, Others or back move the whole group). */
  id: string;
  pos?: { x: number; y: number } | null;
  place?: 'float' | 'others';
  order?: 'last';
  /** The owner's size for a card (a group is never sized); `null` hands it back. */
  size?: ContainerSize | null;
}

/** The owner's presentation gestures travel as {@link OwnerViewFields} (each names the card set
 *  he saw), never as a whole view. */
export interface LayoutPatch extends OwnerViewFields {
  cards?: LayoutPatchCard[];
  closed?: string[];
  view?: SuperView;
  /** Cards put in a group: a new id makes one where its first card stands (a drop on a card),
   *  a known id adds to it (a drop on a group). */
  group?: GroupOp;
  /** Cards taken out of their group (dragged out of an open group). */
  leave?: string[];
  /** Groups dissolved (the panel's Ungroup). */
  ungroup?: string[];
  /** What the owner looks at (a group's panel and its cards, a card full screen), reported on open,
   *  every LOOK_RENEW_MS while open and on close: the server's tidying counts them as touched,
   *  and a picture whose job moved on before the report is his. */
  touch?: string[];
  /** The owner reopens the super's agenda card (the centre's Agenda button, its corner pill): the
   *  server makes it if the record has none, or brings it back from its pill, Others or a group.
   *  `min`: its close, which collapses it to the pill in the bottom-left corner (never removed). */
  agenda?: 'open' | 'min';
}

/** How often the window reports the owner's look at an open group or a full-screen card, through
 *  `pollMs` and never slower than twice this (Light mode): inside the server's grace either way
 *  (src/lib/super/tidy.ts LOOK_GRACE_MS, 90 s; a drift test pins it). */
export const LOOK_RENEW_MS = 30_000;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

type Staged = { containers: SuperContainer[]; groups?: SuperGroup[]; view: SuperView };

/**
 * The server's patch semantics, applied locally: what the window shows the moment the owner
 * drops (and keeps showing over a push until the POST's answer echoes it). The server's order:
 * leave, cards, group, ungroup, closed, then the groups settle against the cards. Unknown ids are
 * ignored, the list is never replaced, a view naming no card falls back to float.
 */
export function applyLayoutPatch<S extends Staged>(state: S, patch: LayoutPatch): S {
  // A look changes nothing on the stage: the state stays as the server sent it (its view's
  // `auto` mark too, which a rebuilt view would drop for the length of a request).
  if (Object.keys(patch).every((k) => k === 'touch')) return state;
  const st = { containers: state.containers.map((c) => ({ ...c })), groups: (state.groups ?? []).map((g) => ({ ...g, cards: [...g.cards] })) };
  // Cards that leave what the view shows (the server's rule): to Others, resized, grouped, closed.
  const unshown = new Set<string>();
  if (patch.leave?.length) leaveGroups(st, patch.leave);
  for (const p of patch.cards ?? []) {
    const k: SuperContainer | SuperGroup | undefined = st.containers.find((x) => x.id === p.id) ?? st.groups.find((x) => x.id === p.id);
    if (!k) continue;
    if (p.place === 'others') for (const id of 'kind' in k ? [k.id] : k.cards) unshown.add(id);
    if ('kind' in k && p.size !== undefined) unshown.add(k.id);
    if (p.place === 'float' || p.place === 'others') k.place = p.place;
    if (p.pos === null) delete k.pos;
    else if (p.pos && Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)) k.pos = { x: clamp01(p.pos.x), y: clamp01(p.pos.y) };
    if ('kind' in k && p.size === null) { delete k.size; delete k.sizeBy; }
    else if ('kind' in k && p.size && (CONTAINER_SIZES as readonly string[]).includes(p.size)) {
      if (p.size === 'small') delete k.size; else k.size = p.size;
      k.sizeBy = 'owner';
    }
    if (p.order === 'last' && 'kind' in k) st.containers = [...st.containers.filter((x) => x !== k), k];
  }
  if (patch.group) { applyGroupOp(st, patch.group); for (const id of patch.group.cards) unshown.add(id); }
  // A closed agenda is made by the server (its id is the server's); one in Others or in a group
  // comes back floating, out of its group (the server's rule for the owner's reopen).
  if (patch.agenda === 'open') {
    const agenda = st.containers.find((x) => x.kind === 'agenda');
    if (agenda) { leaveGroups(st, [agenda.id]); agenda.place = 'float'; delete agenda.min; }
  }
  // Its close collapses it to the corner pill (the server's rule): out of its group and the view.
  const agendaId = st.containers.find((x) => x.kind === 'agenda')?.id;
  if (agendaId && (patch.agenda === 'min' || patch.closed?.includes(agendaId))) {
    const agenda = st.containers.find((x) => x.id === agendaId)!;
    leaveGroups(st, [agendaId]);
    agenda.place = 'float';
    agenda.min = true;
    unshown.add(agendaId);
  }
  if (patch.ungroup?.length) dissolveGroups(st, patch.ungroup);
  // A member's own card is never closed (plan r4 G4): the server ignores it, the patch does too.
  const pinned = new Set(st.containers.filter((x) => x.kind === 'member').map((x) => x.id));
  const gone = new Set((patch.closed ?? []).filter((id) => id !== agendaId && !pinned.has(id)));
  for (const id of gone) unshown.add(id);
  if (gone.size) st.containers = st.containers.filter((x) => !gone.has(x.id));
  const { containers, groups } = normalizeGroups(st.containers, st.groups);
  const live = new Set(containers.map((c) => c.id));
  // The server's order: the cards leave, an explicit view wins (without his marks: those travel
  // set-guarded), the set-guarded fields, then the store's sanitize re-resolves the layout.
  let v: SuperView = viewWithout(state.view, unshown);
  if (patch.view) {
    v = { ...patch.view };
    for (const k of ['layoutBy', 'chat', 'ask', 'auto', 'by', 'ownerAt'] as const) delete v[k];
    // A side by side or a presentation he sets is his (the server stamps the same mark).
    if (v.mode === 'half' || v.mode === 'present') v.by = 'owner';
  }
  v = applyOwnerViewFields(v, patch);
  let view: SuperView = { mode: 'float' };
  if (v.mode === 'half' && v.card && live.has(v.card)) view = { mode: 'half', card: v.card, ...(v.by === 'owner' ? { by: 'owner' as const } : {}), ...(v.auto && !patch.view ? { auto: true as const } : {}) };
  else if (v.mode === 'present') view = resolvePresent(v, containers) ?? { mode: 'float' };
  return { ...state, containers, groups, view };
}

/** Does this pushed state already carry the patch (so the pending edit can go)? */
export function patchEchoed(state: Staged, patch: LayoutPatch): boolean {
  const groups = state.groups ?? [];
  for (const p of patch.cards ?? []) {
    const k = state.containers.find((x) => x.id === p.id) ?? groups.find((x) => x.id === p.id);
    if (!k) continue;
    if (p.place && k.place !== p.place) return false;
    if (p.pos === null && k.pos) return false;
    if (p.pos && (!k.pos || Math.abs(k.pos.x - clamp01(p.pos.x)) > 1e-6 || Math.abs(k.pos.y - clamp01(p.pos.y)) > 1e-6)) return false;
    // A size the server ignores (a group's) counts as echoed; a card's echoes as its record.
    if ('kind' in k && p.size === null && (k.size || k.sizeBy)) return false;
    if ('kind' in k && p.size && (CONTAINER_SIZES as readonly string[]).includes(p.size)
      && (sizeOf(k) !== p.size || k.sizeBy !== 'owner')) return false;
  }
  const agenda = state.containers.find((x) => x.kind === 'agenda');
  for (const id of patch.closed ?? []) if (id !== agenda?.id && state.containers.some((x) => x.id === id && x.kind !== 'member')) return false;
  if (patch.agenda === 'open' && (!agenda || agenda.min || agenda.place !== 'float')) return false;
  if ((patch.agenda === 'min' || (agenda && patch.closed?.includes(agenda.id))) && !agenda?.min) return false;
  for (const id of patch.leave ?? []) if (groups.some((g) => g.cards.includes(id))) return false;
  for (const id of patch.ungroup ?? []) if (groups.some((g) => g.id === id)) return false;
  if (patch.group) {
    // Echoed once the server's groups read the same as the patch applied to them (a group that
    // dissolved again meanwhile reads the same on both sides too).
    const want = applyLayoutPatch(state, { group: patch.group }).groups;
    if (JSON.stringify(want) !== JSON.stringify(groups)) return false;
  }
  // The whole view, not its mode: a push still on `half A` must not swallow the owner's
  // `half B` (end review r8). Compared as the server would store it (a gone card is float). A
  // set-guarded field over another card set changes nothing there, so it reads as echoed and
  // is dropped, never laid over the agent's new set.
  if ((patch.view || patch.presentLayout || patch.chat || patch.exit) && !sameView(applyLayoutPatch(state, patch).view, state.view)) return false;
  return true;
}

/**
 * A push with the owner's edits not yet echoed laid over it: each edit is checked against the push
 * WITH the earlier pending edits applied, in the order he made them (an Esc after a close that has
 * not landed reads against the closed set, so a push in between never drops it). Returns what to
 * draw and the edits still pending.
 */
export function withPendingPatches<S extends Staged>(pushed: S, pending: readonly LayoutPatch[]): { state: S; keep: LayoutPatch[] } {
  let state = pushed;
  const keep: LayoutPatch[] = [];
  for (const p of pending) {
    if (patchEchoed(state, p)) continue;
    keep.push(p);
    state = applyLayoutPatch(state, p);
  }
  return { state, keep };
}

/** Two views draw the same: mode, card (half), cards in order, layout and chat bar (present). */
export function sameView(a: SuperView, b: SuperView): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'half') return a.card === b.card;
  if (a.mode === 'present') return (a.cards ?? []).join('\n') === (b.cards ?? []).join('\n') && a.layout === b.layout && a.chat === b.chat;
  return true;
}

/**
 * The agent just put NEW cards in front of the owner (owner 2026-11-08: "a presentation stays
 * open and another does not replace it, so I never saw what you talked about"): the view now
 * presents, or shows side by side, cards it did not show before, and it is not his own view nor
 * the server's automatic page. The stage then closes what it draws OVER the view (a card full
 * screen, a group's or Others' panel), so the new thing is really in front of him. Pure.
 */
export function agentShowsNew(prev: SuperView, next: SuperView): boolean {
  if (next.by === 'owner' || next.auto) return false;
  if (next.mode !== 'present' && next.mode !== 'half') return false;
  const cardsOf = (v: SuperView) => (v.mode === 'half' && v.card ? [v.card] : v.mode === 'present' ? v.cards ?? [] : []);
  const before = new Set(cardsOf(prev));
  return cardsOf(next).some((id) => !before.has(id));
}
