/**
 * The hand-over stage, pure (plan-r8 F4 + §0 C1/C2/D1, owner decisions O1-O8, stage v2): the
 * Super Agent's window EXACTLY in the centre and the larger share of the stage, every other card
 * on one calm rhythm around it (a column per side, one card width, one gap, a full column
 * spanning the centre's height, each card between 1:1 and 3:4), an "Others" stack bottom-right,
 * the queue pill above the centre and the terminals dock bottom-left. `half` puts one card beside the centre, `present` moves the
 * centre left and shows 1-4 cards on the right; a narrow stage puts every card in Others.
 *
 * `planStage` turns the record (cards, view) and the stage's size into a rect for everything
 * the window draws. The window positions cards absolutely from it and the layout motion reads
 * its LAST rects from it, so the screen, the motion and these numbers never disagree.
 *
 * Coordinates are the stage's own (origin = its top-left), in CSS px.
 */
import {
  MAX_CONTAINERS, MAX_PRESENT,
  type ContainerShape, type SuperContainer, type SuperView,
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
  /** A card's width: never under what its title and line still read at (what does not fit goes
   *  to Others instead), never over what a lone card would dwarf the centre at. */
  U_MIN: 176,
  U_MAX: 360,
  /** Height : width. A chat (and a web page) prefers 3:4, the rest 1:1; any card may be drawn
   *  between 1:1 and 3:4 so a column spans the centre's height exactly, never taller (stage v2). */
  TALL: 4 / 3,
  RATIO_MIN: 1,
  RATIO_MAX: 4 / 3,
  /** The centre's share of the stage. It narrows toward `CENTRE_FLOOR` (at most 1% of the stage)
   *  only to let a column of cards span its height, so a card opening or closing moves it by that
   *  much at most; otherwise it stays put whatever opens or closes. */
  CENTRE_FRAC: 0.56,
  CENTRE_FLOOR: 0.55,
  CENTRE_MIN: 560,
  CENTRE_MAX: 1120,
  /** Columns per side: one, a second only on a stage wide enough for two readable ones. */
  MAX_COLS: 2,
  /** `present`: the centre's left column. */
  PRESENT_FRAC: 0.34,
  PRESENT_MIN: 400,
  PRESENT_MAX: 560,
  /** The Others drop target in the bottom-right corner (lit during a drag), and the stack. */
  OTHERS_ZONE_W: 168,
  OTHERS_ZONE_H: 128,
  OTHERS_W: 148,
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
  /** The shape it is DRAWN in: 'tall' when drawn taller than wide (room for its last lines). */
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
}

export interface PlanOptions {
  /** A running drag: that card stays at its drag-start rect, and the others route around it (D1). */
  dragging?: { id: string; rect: Rect } | null;
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** A shape's preferred height : width. */
export function ratioOf(shape: ContainerShape): number {
  return shape === 'tall' ? STAGE.TALL : STAGE.RATIO_MIN;
}

export function heightOf(shape: ContainerShape, u: number): number {
  return u * ratioOf(shape);
}

/** The centre's preferred width on this stage (it narrows to `centreFloor` at most). */
export function preferredCentre(width: number): number {
  return Math.min(STAGE.CENTRE_MAX, Math.max(STAGE.CENTRE_MIN, STAGE.CENTRE_FRAC * width));
}

/** The narrowest the centre goes to let a column span its height. */
export function centreFloor(width: number): number {
  return Math.min(preferredCentre(width), Math.max(STAGE.CENTRE_MIN, STAGE.CENTRE_FLOOR * width));
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
export const contains = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

// ─── The columns (stage v2) ─────────────────────────────────────────────────────

/** One card in a side's list, in record order. `chat`: a child chat, kept on the stage first. */
interface Slot { id: string; ratio: number; owner: boolean; chat: boolean }

/** The room `n` cards share in a column `span` tall, once the gaps between them are taken. */
const roomOf = (n: number, span: number) => span - (n - 1) * STAGE.GAP;

/** The widths at which `n` cards span `span` exactly, each drawn between 1:1 and 3:4. */
function spanRange(n: number, span: number): [number, number] {
  const room = roomOf(n, span);
  return [room / (n * STAGE.RATIO_MAX), room / (n * STAGE.RATIO_MIN)];
}

/** How many cards one column holds at width `u` (each at 1:1, its shortest). */
function capacity(u: number, span: number): number {
  return Math.max(0, Math.floor((span + STAGE.GAP) / (u * STAGE.RATIO_MIN + STAGE.GAP) + 1e-9));
}

/**
 * The heights of one column's cards at width `u`. When they can (each between 1:1 and 3:4) they
 * span `span` exactly, each moved from its preferred shape in proportion to the room it has;
 * when they cannot (too few cards), they keep their preferred shapes and the column is short.
 */
export function columnHeights(ratios: readonly number[], u: number, span: number): { heights: number[]; short: boolean } {
  const pref = ratios.map((r) => r * u);
  const room = roomOf(ratios.length, span);
  const lo = ratios.length * u * STAGE.RATIO_MIN;
  const hi = ratios.length * u * STAGE.RATIO_MAX;
  if (!ratios.length || room > hi + 0.01 || room < lo - 0.01) return { heights: pref, short: true };
  const sum = pref.reduce((a, b) => a + b, 0);
  const grow = room >= sum;
  const head = pref.map((p) => (grow ? u * STAGE.RATIO_MAX - p : p - u * STAGE.RATIO_MIN));
  const total = head.reduce((a, b) => a + b, 0);
  const k = total > 0 ? Math.abs(room - sum) / total : 0;
  return { heights: pref.map((p, i) => (grow ? p + head[i] * k : p - head[i] * k)), short: false };
}

/** A side's cards split into `cols` columns, inner column first, the fuller columns inside. */
function splitColumns<T>(items: readonly T[], cols: number): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (let k = 0; k < cols; k++) {
    const n = Math.ceil((items.length - at) / (cols - k));
    out.push(items.slice(at, at + n));
    at += n;
  }
  return out;
}

interface FloatSolution {
  centre: Rect;
  u: number;
  cols: number;
  rects: Map<string, Rect>;
  /** Ids that fit nowhere: drawn in Others. */
  overflow: Set<string>;
}

/**
 * Both sides around the centre (stage v2): one column per side (two on a very wide stage), the
 * same card width on both, every gap `GAP`, the inner column `GAP` from the centre. A column
 * full enough spans the centre's height exactly; a shorter one sits centred on its midline.
 * Cards past what a column holds at `U_MIN` overflow: the side's last, the auto-placed ones
 * before the owner's and, among those, every other card before a chat (the chats are why the
 * owner handed over: they stay on the stage longest).
 */
function solveFloat(f: Frame, left: readonly Slot[], right: readonly Slot[]): FloatSolution {
  const { GAP, MARGIN, U_MIN, U_MAX } = STAGE;
  const W = f.width;
  const span = f.content.height;
  const pref = preferredCentre(W);
  const floor = centreFloor(W);
  const sideRoom = (cw: number) => (W - cw) / 2 - GAP - MARGIN;
  const uCap = (cw: number, c: number) => Math.min(U_MAX, (sideRoom(cw) - (c - 1) * GAP) / c);
  const centreFor = (u: number, c: number) => Math.min(pref, W - 2 * (MARGIN + c * u + c * GAP));

  type Try = { c: number; u: number; cols: { side: 'left' | 'right'; slots: Slot[] }[]; overflow: Set<string> };
  let best: Try | null = null;
  for (let c = 1; c <= STAGE.MAX_COLS; c++) {
    const hi = uCap(floor, c);
    if (hi < U_MIN - 1e-9) continue;
    const perCol = capacity(U_MIN, span);
    const overflow = new Set<string>();
    const keep = (slots: readonly Slot[]) => {
      const room = perCol * c;
      if (slots.length <= room) return [...slots];
      // Drop from the end: auto-placed before the owner's, any other card before a chat.
      const out = [...slots];
      for (const [owner, chat] of [[false, false], [false, true], [true, false], [true, true]]) {
        for (let i = out.length - 1; i >= 0 && out.length > room; i--) {
          if (out[i].owner === owner && out[i].chat === chat) { overflow.add(out[i].id); out.splice(i, 1); }
        }
      }
      return out;
    };
    const cols = [
      ...splitColumns(keep(left), c).map((slots) => ({ side: 'left' as const, slots })),
      ...splitColumns(keep(right), c).map((slots) => ({ side: 'right' as const, slots })),
    ].filter((k) => k.slots.length);
    const fullest = Math.max(0, ...cols.map((k) => k.slots.length));
    let u = Math.min(uCap(pref, c), U_MAX);
    if (fullest) {
      const [lo, top] = spanRange(fullest, span);
      const a = Math.max(lo, U_MIN);
      const z = Math.min(top, hi);
      if (a <= z + 1e-9) {
        // The fullest columns span: at the width where their cards are nearest their own shapes.
        const spanning = cols.filter((k) => k.slots.length === fullest);
        const want = spanning.reduce((s, k) => s + roomOf(fullest, span) / k.slots.reduce((r, x) => r + x.ratio, 0), 0) / spanning.length;
        u = Math.min(z, Math.max(a, want));
      }
    }
    u = Math.max(U_MIN, u);
    const t: Try = { c, u, cols, overflow };
    if (!best || overflow.size < best.overflow.size) best = t;
    if (!overflow.size) break;
  }

  const rects = new Map<string, Rect>();
  if (!best) {
    // Not even one readable column beside the centre: every card is drawn in Others.
    const overflow = new Set([...left, ...right].map((s) => s.id));
    return { centre: centreAt(f, pref), u: 0, cols: 0, rects, overflow };
  }
  const { c, u } = best;
  const centre = centreAt(f, centreFor(u, c));
  const colIndex = { left: 0, right: 0 };
  for (const col of best.cols) {
    const k = colIndex[col.side]++;
    const x = col.side === 'left'
      ? centre.x - GAP - u - k * (u + GAP)
      : centre.x + centre.width + GAP + k * (u + GAP);
    const { heights, short } = columnHeights(col.slots.map((s) => s.ratio), u, span);
    const total = heights.reduce((a, b) => a + b, 0) + (heights.length - 1) * GAP;
    let y = f.content.y + (short ? (span - total) / 2 : 0);
    col.slots.forEach((s, i) => {
      rects.set(s.id, { x, y, width: u, height: heights[i] });
      y += heights[i] + GAP;
    });
  }
  return { centre, u, cols: c, rects, overflow: best.overflow };
}

/** Where a pushed-aside card goes: the free spot of its own column nearest where it stood. */
function reseat(want: Rect, f: Frame, blocks: readonly Rect[], u: number): Rect | null {
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
  for (const h of [want.height, u * STAGE.RATIO_MIN]) {
    let pick: Rect | null = null;
    for (const [a, z] of free) {
      if (z - a < h - 0.01) continue;
      const y = Math.min(Math.max(want.y, a), z - h);
      if (!pick || Math.abs(y - want.y) < Math.abs(pick.y - want.y)) pick = { ...want, y, height: h };
    }
    if (pick) return pick;
  }
  return null;
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
  containers: readonly SuperContainer[],
  view: SuperView,
  stage: { width: number; height: number },
  opts: PlanOptions = {},
): StagePlan {
  const list = containers.slice(0, MAX_CONTAINERS);
  const f = frameOf(Math.max(0, stage.width), Math.max(0, stage.height));
  const narrow = f.width < NARROW_STAGE_PX;
  const ids = new Set(list.map((c) => c.id));
  const z = new Map(list.map((c, i) => [c.id, i] as const));
  const cards: Record<string, CardPlan> = {};
  const others: string[] = [];
  const toOthers = (c: SuperContainer) => {
    cards[c.id] = { id: c.id, rect: f.othersRect, where: 'others', shape: c.shape, owner: false, z: z.get(c.id) ?? 0 };
    others.push(c.id);
  };
  const finish = (centre: Rect, centreWidth: number, mode: SuperView['mode'], unit = { left: 0, right: 0 }): StagePlan => {
    // Others in record order, whatever order they were sent there in.
    others.sort((a, b) => (z.get(a) ?? 0) - (z.get(b) ?? 0));
    return {
      width: f.width, height: f.height, narrow, mode, centre, cards, others,
      othersRect: f.othersRect, othersZone: f.othersZone, ...bands(f, centre), free: f.free,
      centreWidth, unit, order: list.map((c) => c.id),
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
  const isOwner = (c: SuperContainer) => !!c.pos || c.id === drag?.id;
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
    floating.filter((c) => sideOf.get(c.id) === side).map((c) => ({ id: c.id, ratio: ratioOf(c.shape), owner: isOwner(c), chat: c.kind === 'chat' }));

  // One pass with every card in its column, the owner's cards included where they would stand:
  // it sets the stage (the card width, the centre) and the size an owner card is drawn at, the
  // one it had before it was dropped, so a drop never resizes the card under the hand and a
  // reload draws it at the same size again.
  const sol = solveFloat(f, slotsOn('left'), slotsOn('right'));
  const centre = sol.centre;
  const ownerRects = new Map<string, Rect>();
  for (const c of owned) {
    if (c.id === drag?.id) { ownerRects.set(c.id, drag.rect); continue; }
    const at = sol.rects.get(c.id);
    const u = sol.u || STAGE.U_MIN;
    const w = at?.width ?? u;
    const h = at?.height ?? heightOf(c.shape, u);
    ownerRects.set(c.id, pushOut(rectFromPos(f.free, c.pos!, w, h), centre, f.free));
  }

  // The owner's cards sit where they were dropped. An auto card clear of them keeps its place;
  // one they cover moves to the free spot of its own column nearest where it stood (at its
  // size, else 1:1), else it is drawn in Others: the stage moves as few cards as it can.
  const owners = [...ownerRects.values()];
  const covered = (r: Rect) => owners.some((b) => overlaps(r, inflate(b, STAGE.GAP - 0.5)));
  const blocks: Rect[] = [...owners];
  const moved: SuperContainer[] = [];
  const auto = (c: SuperContainer, rect: Rect) => {
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
    const rect = reseat(sol.rects.get(c.id)!, f, blocks, sol.u);
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
  return finish(centre, centre.width, 'float', { left: width('left'), right: width('right') });
}

/** Taller than wide by more than a hair: drawn as a tall card (room for its last lines). */
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

// ─── The owner's edits as a patch (F3 / §0 C3) ─────────────────────────────────

export interface LayoutPatchCard {
  id: string;
  pos?: { x: number; y: number } | null;
  place?: 'float' | 'others';
  order?: 'last';
}

export interface LayoutPatch {
  cards?: LayoutPatchCard[];
  closed?: string[];
  view?: SuperView;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The server's patch semantics, applied locally: what the window shows the moment the owner
 * drops (and keeps showing over a push until the POST's answer echoes it). Unknown ids are
 * ignored, the list is never replaced, a view naming no card falls back to float.
 */
export function applyLayoutPatch<S extends { containers: SuperContainer[]; view: SuperView }>(state: S, patch: LayoutPatch): S {
  let containers = state.containers.map((c) => ({ ...c }));
  for (const p of patch.cards ?? []) {
    const k = containers.find((x) => x.id === p.id);
    if (!k) continue;
    if (p.place === 'float' || p.place === 'others') k.place = p.place;
    if (p.pos === null) delete k.pos;
    else if (p.pos && Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)) k.pos = { x: clamp01(p.pos.x), y: clamp01(p.pos.y) };
    if (p.order === 'last') containers = [...containers.filter((x) => x !== k), k];
  }
  const gone = new Set(patch.closed ?? []);
  if (gone.size) containers = containers.filter((x) => !gone.has(x.id));
  const live = new Set(containers.map((c) => c.id));
  const v = patch.view ?? state.view;
  let view: SuperView = { mode: 'float' };
  if (v.mode === 'half' && v.card && live.has(v.card)) view = { mode: 'half', card: v.card };
  else if (v.mode === 'present') {
    const cards = [...new Set((v.cards ?? []).filter((id) => live.has(id)))].slice(0, MAX_PRESENT);
    if (cards.length) view = { mode: 'present', cards };
  }
  return { ...state, containers, view };
}

/** Does this pushed state already carry the patch (so the pending edit can go)? */
export function patchEchoed(state: { containers: SuperContainer[]; view: SuperView }, patch: LayoutPatch): boolean {
  for (const p of patch.cards ?? []) {
    const k = state.containers.find((x) => x.id === p.id);
    if (!k) continue;
    if (p.place && k.place !== p.place) return false;
    if (p.pos === null && k.pos) return false;
    if (p.pos && (!k.pos || Math.abs(k.pos.x - clamp01(p.pos.x)) > 1e-6 || Math.abs(k.pos.y - clamp01(p.pos.y)) > 1e-6)) return false;
  }
  for (const id of patch.closed ?? []) if (state.containers.some((x) => x.id === id)) return false;
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
