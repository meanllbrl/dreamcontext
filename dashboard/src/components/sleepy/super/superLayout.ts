/**
 * The hand-over stage, pure (plan-r8 F4 + §0 C1/C2/D1, owner decisions O1-O8, stage v2, the
 * 2026-10-20 redesign): the Super Agent's window EXACTLY in the centre and the larger share of the
 * stage, every other card a small 1:1 tile on an ORBIT around it (a side's tiles on an arc, the
 * middle one standing out, the ends tucked in toward the centre), groups drawn as one tile, an
 * "Others" stack bottom-right, the queue pill above the centre and the terminals dock
 * bottom-left. `half` puts one card beside the centre, `present` moves the centre left and shows
 * 1-4 cards on the right; a narrow stage puts every card in Others.
 *
 * `planStage` turns the record (cards, view) and the stage's size into a rect for everything
 * the window draws. The window positions cards absolutely from it and the layout motion reads
 * its LAST rects from it, so the screen, the motion and these numbers never disagree.
 *
 * Coordinates are the stage's own (origin = its top-left), in CSS px.
 */
import {
  MAX_CONTAINERS, MAX_PRESENT, applyGroupOp, dissolveGroups, leaveGroups, normalizeGroups,
  type ContainerShape, type GroupOp, type SuperContainer, type SuperGroup, type SuperView,
} from '../../../lib/superTypes';

export interface Rect { x: number; y: number; width: number; height: number }

/** Every constant of the stage, in one place (tested by invariants, not pixels). */
export const STAGE = {
  /** Outer margin, and the one gap between the centre, every card and every column (O1). */
  MARGIN: 24,
  GAP: 24,
  /** The two thin bands above and below the centre: queue pill on top, dock + Others below.
   *  Always reserved, so the centre is centred in both axes and nothing jumps. */
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
  CENTRE_MIN: 560,
  CENTRE_MAX: 1120,
  /** Columns per side: an outer one only once the inner one is full and the side has the room. */
  MAX_COLS: 2,
  /** `present`: the centre's left column. */
  PRESENT_FRAC: 0.34,
  PRESENT_MIN: 400,
  PRESENT_MAX: 560,
  /** The Others drop target in the bottom-right corner (lit during a drag), and the stack. */
  OTHERS_ZONE_W: 168,
  OTHERS_ZONE_H: 128,
  OTHERS_W: 172,
  /** A narrow stage's sheet sits this far inside the centre. */
  SHEET_INSET: 16,
} as const;

/** Below this stage width every card is drawn in Others and side by side opens as a sheet (§0 C2). */
export const NARROW_STAGE_PX = 1040;

/** Where a card is drawn this time (its record may say otherwise: overflow is drawn, not written). */
export type CardWhere = 'float' | 'others' | 'half' | 'present' | 'sheet';

export interface CardPlan {
  id: string;
  rect: Rect;
  where: CardWhere;
  /** The shape it is DRAWN in: a floating tile is always 'square'; a large view keeps the record's. */
  shape: ContainerShape;
  /** Placed by the owner's drop (or held by a running drag), not by the stage. */
  owner: boolean;
  /** Paint order: record order, owner-placed cards above the auto-placed ones (the window lifts
   *  the card dropped last on top of those for the session). */
  z: number;
}

export interface StagePlan {
  width: number;
  height: number;
  narrow: boolean;
  mode: SuperView['mode'];
  centre: Rect;
  cards: Record<string, CardPlan>;
  /** Cards drawn in the Others stack, in record order. */
  others: string[];
  othersRect: Rect;
  othersZone: Rect;
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
}

/** A side's orbit: x = x0 + dir * depth * (1 - ((y - cy) / ymax)^2), through tile centres. */
export interface OrbitArc { side: 'left' | 'right'; x0: number; cy: number; ymax: number; depth: number; dir: -1 | 1 }

/** What the stage places: a card, or a group drawn as one tile (`kind: 'group'`). `slot` is its
 *  place in the record (a group's is its first card's), so sides never shift under a grouping. */
export interface StageItem {
  id: string;
  kind: SuperContainer['kind'] | 'group';
  shape: ContainerShape;
  place: SuperContainer['place'];
  pos?: { x: number; y: number };
  slot?: number;
}

/**
 * The record as the stage sees it: an ungrouped card is itself; a group is one item standing at
 * its first card's place in the record, with the group's own place and drop; its cards are drawn
 * inside it. A grouped card the view shows side by side or presents is drawn there too.
 */
export function stageItems(containers: readonly SuperContainer[], groups: readonly SuperGroup[], view: SuperView): StageItem[] {
  const shown = new Set(view.mode === 'half' && view.card ? [view.card] : view.mode === 'present' ? view.cards ?? [] : []);
  const index = new Map(containers.map((c, i) => [c.id, i] as const));
  const groupOf = new Map<string, SuperGroup>();
  for (const g of groups) for (const id of g.cards) if (index.has(id)) groupOf.set(id, g);
  const out: StageItem[] = [];
  const placed = new Set<string>();
  containers.forEach((c, i) => {
    const g = groupOf.get(c.id);
    if (!g || shown.has(c.id)) out.push({ id: c.id, kind: c.kind, shape: c.shape, place: c.place, ...(c.pos ? { pos: c.pos } : {}), slot: i });
    if (g && !placed.has(g.id) && g.cards[0] !== undefined && index.has(g.cards[0])) {
      placed.add(g.id);
      out.push({ id: g.id, kind: 'group', shape: 'square', place: g.place, ...(g.pos ? { pos: g.pos } : {}), slot: index.get(g.cards[0])! });
    }
  });
  return out.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

export interface PlanOptions {
  /** A running drag: that card stays at its drag-start rect, and the others route around it (D1). */
  dragging?: { id: string; rect: Rect } | null;
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** A floating tile's height: every tile is 1:1 (2026-10-20). Kept for callers sizing a ghost. */
export function heightOf(_shape: ContainerShape, u: number): number {
  return u;
}

/** The centre's width on this stage: its share, between its floor and its ceiling. */
export function preferredCentre(width: number): number {
  return Math.min(STAGE.CENTRE_MAX, Math.max(STAGE.CENTRE_MIN, STAGE.CENTRE_FRAC * width));
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
export const contains = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

// ─── The orbit (2026-10-20) ─────────────────────────────────────────────────────

/** One item in a side's list, in record order. `chat`: a child chat (or a group), kept longest. */
interface Slot { id: string; owner: boolean; chat: boolean }

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
  const centre = centreAt(f, preferredCentre(W));
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
    // Drop from the end: auto-placed before the owner's, any other card before a chat.
    for (const [owner, chat] of [[false, false], [false, true], [true, false], [true, true]]) {
      for (let i = out.length - 1; i >= 0 && out.length > roomFor; i--) {
        if (out[i].owner === owner && out[i].chat === chat) { overflow.add(out[i].id); out.splice(i, 1); }
      }
    }
    return out;
  };
  const mid = centre.y + centre.height / 2;
  for (const [side, slots] of [['left', keep(left)], ['right', keep(right)]] as const) {
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
        const off = ymax > 0 ? depth * (1 - (dy / ymax) ** 2) : 0;
        rects.set(s.id, { x: x0 + dir * off, y, width: T, height: T });
      });
      if (k === 0 && col.length >= 2 && depth > 0) orbit.push({ side, x0: x0 + T / 2, cy: mid, ymax, depth, dir });
    }
  }
  return { centre, u: T, rects, overflow, orbit };
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
function pushOut(rect: Rect, centre: Rect, free: Rect): Rect {
  const zone = inflate(centre, STAGE.GAP);
  let r = rect;
  if (overlaps(r, zone)) {
    const toLeft = r.x + r.width / 2 < centre.x + centre.width / 2;
    r = { ...r, x: toLeft ? zone.x - r.width : zone.x + zone.width };
  }
  const x = Math.min(Math.max(r.x, free.x), free.x + free.width - r.width);
  const y = Math.min(Math.max(r.y, free.y), free.y + free.height - r.height);
  return { ...r, x, y };
}

// ─── The plan ───────────────────────────────────────────────────────────────────

interface Frame { width: number; height: number; content: Rect; free: Rect; othersRect: Rect; othersZone: Rect; bandTop: number; bandBottom: number }

function frameOf(width: number, height: number): Frame {
  const { MARGIN, BAND } = STAGE;
  const content: Rect = { x: MARGIN, y: MARGIN + BAND, width: Math.max(0, width - 2 * MARGIN), height: Math.max(0, height - 2 * (MARGIN + BAND)) };
  const bandTop = MARGIN / 2;
  const bandBottom = height - MARGIN / 2 - BAND;
  return {
    width, height, content, free: content, bandTop, bandBottom,
    othersRect: { x: width - MARGIN - STAGE.OTHERS_W, y: bandBottom, width: STAGE.OTHERS_W, height: BAND },
    othersZone: { x: width - STAGE.OTHERS_ZONE_W, y: height - STAGE.OTHERS_ZONE_H, width: STAGE.OTHERS_ZONE_W, height: STAGE.OTHERS_ZONE_H },
  };
}

function centreAt(f: Frame, w: number): Rect {
  return { x: (f.width - w) / 2, y: f.content.y, width: w, height: f.content.height };
}

function bands(f: Frame, centre: Rect): { queue: Rect; dock: Rect } {
  // Centred on the centre, one width whatever the stage's size (stage v2: the centre follows the
  // stage now, and a band that followed it re-fitted the pill's buttons inside the resize's own
  // ResizeObserver pass). A pill that fits one row never spills over the centre's header (it
  // grows as an overlay only while the owner points at it).
  const qw = Math.min(STAGE.QUEUE_MAX, f.content.width);
  const qx = Math.min(Math.max(centre.x + (centre.width - qw) / 2, f.content.x), f.content.x + f.content.width - qw);
  return {
    queue: { x: qx, y: f.bandTop, width: qw, height: STAGE.BAND },
    dock: { x: STAGE.MARGIN, y: f.bandBottom, width: Math.max(0, f.othersRect.x - STAGE.MARGIN - STAGE.GAP), height: STAGE.BAND },
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
  // Items: at most the record's MAX_CONTAINERS cards, plus a grouped card the view presents beside its group.
  const list = containers.slice(0, MAX_CONTAINERS + MAX_PRESENT);
  const f = frameOf(Math.max(0, stage.width), Math.max(0, stage.height));
  const narrow = f.width < NARROW_STAGE_PX;
  const ids = new Set(list.map((c) => c.id));
  // An item's place in the RECORD (a group stands at its first card's), not in this list: a
  // grouping removes cards from the list and must not move any other card to the other side.
  const z = new Map(list.map((c, i) => [c.id, c.slot ?? i] as const));
  const cards: Record<string, CardPlan> = {};
  const others: string[] = [];
  const toOthers = (c: StageItem) => {
    cards[c.id] = { id: c.id, rect: f.othersRect, where: 'others', shape: c.shape, owner: false, z: z.get(c.id) ?? 0 };
    others.push(c.id);
  };
  const finish = (centre: Rect, centreWidth: number, mode: SuperView['mode'], unit = { left: 0, right: 0 }, orbit: OrbitArc[] = []): StagePlan => {
    // Others in record order, whatever order they were sent there in.
    others.sort((a, b) => (z.get(a) ?? 0) - (z.get(b) ?? 0));
    return {
      width: f.width, height: f.height, narrow, mode, centre, cards, others,
      othersRect: f.othersRect, othersZone: f.othersZone, ...bands(f, centre), free: f.free,
      centreWidth, unit, order: list.map((c) => c.id), orbit,
    };
  };

  // ── half / present (a narrow stage opens them as a sheet over the centre) ──
  const half = view.mode === 'half' && view.card && ids.has(view.card) ? view.card : null;
  const shown = view.mode === 'present' ? (view.cards ?? []).filter((id) => ids.has(id)).slice(0, MAX_PRESENT) : [];
  if (half || shown.length) {
    const picked = half ? [half] : shown;
    let centre: Rect;
    let region: Rect;
    if (narrow) {
      centre = { ...f.content };
      const i = STAGE.SHEET_INSET;
      region = { x: centre.x + i, y: centre.y + i, width: centre.width - 2 * i, height: centre.height - 2 * i };
    } else if (half) {
      const w = (f.content.width - STAGE.GAP) / 2;
      centre = { x: f.content.x, y: f.content.y, width: w, height: f.content.height };
      region = { x: f.content.x + w + STAGE.GAP, y: f.content.y, width: w, height: f.content.height };
    } else {
      const w = Math.min(STAGE.PRESENT_MAX, Math.max(STAGE.PRESENT_MIN, STAGE.PRESENT_FRAC * f.width));
      centre = { x: f.content.x, y: f.content.y, width: w, height: f.content.height };
      region = { x: f.content.x + w + STAGE.GAP, y: f.content.y, width: f.content.width - w - STAGE.GAP, height: f.content.height };
    }
    const rects = grid(region, picked.length);
    const where: CardWhere = narrow ? 'sheet' : half ? 'half' : 'present';
    picked.forEach((id, i) => {
      const c = list.find((x) => x.id === id)!;
      cards[id] = { id, rect: rects[i], where, shape: c.shape, owner: false, z: z.get(id) ?? 0 };
    });
    for (const c of list) if (!cards[c.id]) toOthers(c);
    return finish(centre, centre.width, half ? 'half' : 'present');
  }

  // ── narrow: the centre takes the width, every card is in Others ──
  if (narrow) {
    for (const c of list) toOthers(c);
    return finish({ ...f.content }, f.content.width, 'float');
  }

  // ── float ──
  const floating = list.filter((c) => c.place === 'float');
  for (const c of list) if (c.place !== 'float') toOthers(c);
  const drag = opts.dragging && ids.has(opts.dragging.id) ? opts.dragging : null;
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
    const onLeft = floating.filter((c) => sideOf.get(c.id) === 'left');
    const onRight = floating.filter((c) => sideOf.get(c.id) === 'right');
    if (Math.abs(onLeft.length - onRight.length) <= 1) break;
    const [heavy, to] = onLeft.length > onRight.length ? [onLeft, 'right' as const] : [onRight, 'left' as const];
    const mover = [...heavy].reverse().find((c) => !c.pos);
    if (!mover) break;
    sideOf.set(mover.id, to);
  }
  const slotsOn = (side: 'left' | 'right'): Slot[] =>
    floating.filter((c) => sideOf.get(c.id) === side).map((c) => ({ id: c.id, owner: isOwner(c), chat: c.kind === 'chat' || c.kind === 'group' }));

  // One pass with every item on its side's orbit, the owner's included where they would stand:
  // it sets the stage. An owner tile is drawn at the one tile size wherever he dropped it.
  const sol = solveFloat(f, slotsOn('left'), slotsOn('right'));
  const centre = sol.centre;
  const ownerRects = new Map<string, Rect>();
  for (const c of owned) {
    if (c.id === drag?.id) { ownerRects.set(c.id, drag.rect); continue; }
    ownerRects.set(c.id, pushOut(rectFromPos(f.free, c.pos!, STAGE.TILE, STAGE.TILE), centre, f.free));
  }

  // The owner's cards sit where they were dropped. An auto card clear of them keeps its place;
  // one they cover moves to the free spot of its own column nearest where it stood (at its
  // size, else 1:1), else it is drawn in Others: the stage moves as few cards as it can.
  const owners = [...ownerRects.values()];
  const covered = (r: Rect) => owners.some((b) => overlaps(r, inflate(b, STAGE.GAP - 0.5)));
  const blocks: Rect[] = [...owners];
  const moved: StageItem[] = [];
  const auto = (c: StageItem, rect: Rect) => {
    cards[c.id] = { id: c.id, rect, where: 'float', shape: drawnShape(rect), owner: false, z: z.get(c.id) ?? 0 };
  };
  for (const c of floating) {
    if (isOwner(c)) continue;
    const at = sol.rects.get(c.id);
    if (!at || sol.overflow.has(c.id)) toOthers(c);
    else if (covered(at)) moved.push(c);
    else { blocks.push(at); auto(c, at); }
  }
  for (const c of moved) {
    const rect = reseat(sol.rects.get(c.id)!, f, blocks);
    if (!rect) { toOthers(c); continue; }
    blocks.push(rect);
    auto(c, rect);
  }
  for (const c of owned) {
    const rect = ownerRects.get(c.id) ?? EMPTY;
    // Owner-placed cards paint above the auto-placed ones (they may sit over each other).
    cards[c.id] = { id: c.id, rect, where: 'float', shape: drawnShape(rect), owner: true, z: MAX_CONTAINERS + (z.get(c.id) ?? 0) };
  }
  const width = (side: 'left' | 'right') => (floating.some((c) => sideOf.get(c.id) === side && cards[c.id]?.where === 'float') ? sol.u : 0);
  return finish(centre, centre.width, 'float', { left: width('left'), right: width('right') }, sol.orbit);
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
}

export interface LayoutPatch {
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
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

type Staged = { containers: SuperContainer[]; groups?: SuperGroup[]; view: SuperView };

/**
 * The server's patch semantics, applied locally: what the window shows the moment the owner
 * drops (and keeps showing over a push until the POST's answer echoes it). The server's order:
 * leave, cards, group, ungroup, closed, then the groups settle against the cards. Unknown ids are
 * ignored, the list is never replaced, a view naming no card falls back to float.
 */
export function applyLayoutPatch<S extends Staged>(state: S, patch: LayoutPatch): S {
  const st = { containers: state.containers.map((c) => ({ ...c })), groups: (state.groups ?? []).map((g) => ({ ...g, cards: [...g.cards] })) };
  if (patch.leave?.length) leaveGroups(st, patch.leave);
  for (const p of patch.cards ?? []) {
    const k: SuperContainer | SuperGroup | undefined = st.containers.find((x) => x.id === p.id) ?? st.groups.find((x) => x.id === p.id);
    if (!k) continue;
    if (p.place === 'float' || p.place === 'others') k.place = p.place;
    if (p.pos === null) delete k.pos;
    else if (p.pos && Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)) k.pos = { x: clamp01(p.pos.x), y: clamp01(p.pos.y) };
    if (p.order === 'last' && 'kind' in k) st.containers = [...st.containers.filter((x) => x !== k), k];
  }
  if (patch.group) applyGroupOp(st, patch.group);
  if (patch.ungroup?.length) dissolveGroups(st, patch.ungroup);
  const gone = new Set(patch.closed ?? []);
  if (gone.size) st.containers = st.containers.filter((x) => !gone.has(x.id));
  const { containers, groups } = normalizeGroups(st.containers, st.groups);
  const live = new Set(containers.map((c) => c.id));
  const v = patch.view ?? state.view;
  let view: SuperView = { mode: 'float' };
  if (v.mode === 'half' && v.card && live.has(v.card)) view = { mode: 'half', card: v.card };
  else if (v.mode === 'present') {
    const cards = [...new Set((v.cards ?? []).filter((id) => live.has(id)))].slice(0, MAX_PRESENT);
    if (cards.length) view = { mode: 'present', cards };
  }
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
  }
  for (const id of patch.closed ?? []) if (state.containers.some((x) => x.id === id)) return false;
  for (const id of patch.leave ?? []) if (groups.some((g) => g.cards.includes(id))) return false;
  for (const id of patch.ungroup ?? []) if (groups.some((g) => g.id === id)) return false;
  if (patch.group) {
    // Echoed once the server's groups read the same as the patch applied to them (a group that
    // dissolved again meanwhile reads the same on both sides too).
    const want = applyLayoutPatch(state, { group: patch.group }).groups;
    if (JSON.stringify(want) !== JSON.stringify(groups)) return false;
  }
  // The whole view, not its mode: a push still on `half A` must not swallow the owner's
  // `half B` (end review r8). Compared as the server would store it (a gone card is float).
  if (patch.view && !sameView(applyLayoutPatch(state, patch).view, state.view)) return false;
  return true;
}

function sameView(a: SuperView, b: SuperView): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'half') return a.card === b.card;
  if (a.mode === 'present') return (a.cards ?? []).join('\n') === (b.cards ?? []).join('\n');
  return true;
}
