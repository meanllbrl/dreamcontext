/**
 * The hand-over stage, pure (plan-r8 F4 + §0 C1/C2/D1, owner decisions O1-O8): the Super
 * Agent's window EXACTLY in the centre, every other card floating around it as a 1:1 or 9:16
 * card at a fixed gap, an "Others" stack bottom-right, the queue pill above the centre and the
 * terminals dock bottom-left. `half` puts one card beside the centre, `present` moves the
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
  /** Outer margin, and the fixed gap between the centre and every card (O1). */
  MARGIN: 24,
  GAP: 24,
  /** The two thin bands above and below the centre: queue pill on top, dock + Others below.
   *  Always reserved, so the centre is centred in both axes and nothing jumps. */
  BAND: 40,
  /** The queue pill's widest: no card is ever in the top band, so it may outgrow the centre and
   *  keep one row (a who, the text, two or three buttons) inside the band. */
  QUEUE_MAX: 720,
  /** A card's unit width: square u x u, tall u x 16u/9. */
  U_MIN: 150,
  U_MAX: 232,
  TALL: 16 / 9,
  /** The centre's preferred width, then the fixed steps it narrows through (§0 C1, round 2). */
  CENTRE_FRAC: 0.46,
  CENTRE_MIN: 480,
  CENTRE_MAX: 860,
  CENTRE_STEPS: [860, 720, 600, 480] as readonly number[],
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
  /** The shape it is DRAWN in (a tall card can be drawn square to fit; the record keeps tall). */
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
  /** The centre width chosen, handed back as `prevCentre` next time (hysteresis). */
  centreWidth: number;
  /** Unit width per side (0 for an empty side). */
  unit: { left: number; right: number };
  /** Card ids in record order (the hand-over flights' stagger order). */
  order: string[];
}

export interface PlanOptions {
  /** A running drag: that card stays at its drag-start rect, and the others route around it (D1). */
  dragging?: { id: string; rect: Rect } | null;
  /** The centre width of the previous plan: it widens back only with a card to spare. */
  prevCentre?: number | null;
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

export function heightOf(shape: ContainerShape, u: number): number {
  return shape === 'tall' ? u * STAGE.TALL : u;
}

export function preferredCentre(width: number): number {
  return Math.min(STAGE.CENTRE_MAX, Math.max(STAGE.CENTRE_MIN, STAGE.CENTRE_FRAC * width));
}

/** The centre widths to try, widest first: the preferred one, then every fixed step under it. */
export function centreCandidates(width: number): number[] {
  const pref = preferredCentre(width);
  return [pref, ...STAGE.CENTRE_STEPS.filter((s) => s < pref - 0.5)];
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
export const contains = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

// ─── One side of the centre ─────────────────────────────────────────────────────

interface SideInput {
  side: 'left' | 'right';
  shapes: ContainerShape[];
  centre: Rect;
  content: Rect;
  blocks: Rect[];
}

interface SideFit {
  u: number;
  cols: number;
  squared: boolean;
  rects: Rect[];
  /** Indexes (into `shapes`) that did not fit. */
  overflow: number[];
}

function columnX(input: SideInput, u: number, col: number): number {
  const { GAP } = STAGE;
  return input.side === 'left'
    ? input.centre.x - GAP - u - col * (u + GAP)
    : input.centre.x + input.centre.width + GAP + col * (u + GAP);
}

/** Free vertical intervals of one column: the content box minus the blocks crossing it. */
function freeIntervals(input: SideInput, x: number, u: number): Array<[number, number]> {
  const top = input.content.y;
  const bottom = input.content.y + input.content.height;
  const cuts = input.blocks
    .map((b) => inflate(b, STAGE.GAP))
    .filter((b) => b.x < x + u && x < b.x + b.width)
    .map((b) => [Math.max(top, b.y), Math.min(bottom, b.y + b.height)] as [number, number])
    .filter(([a, z]) => z > a)
    .sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  let cursor = top;
  for (const [a, z] of cuts) {
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, z);
  }
  if (bottom > cursor) out.push([cursor, bottom]);
  return out;
}

/**
 * Fill the columns top-down, inner column first (§0 C1). A column with no blocks is centred
 * on the centre's midline. `partial` keeps going past a card that does not fit (it overflows).
 */
function fill(input: SideInput, u: number, cols: number, squared: boolean, partial: boolean): SideFit | null {
  const { GAP } = STAGE;
  const rects: Rect[] = new Array(input.shapes.length);
  const overflow: number[] = [];
  let col = 0;
  let cursor = -Infinity;
  const colCards: number[][] = Array.from({ length: cols }, () => []);
  const colBlocked: boolean[] = [];
  const intervalsOf = (c: number) => freeIntervals(input, columnX(input, u, c), u);
  const full = (iv: Array<[number, number]>) =>
    iv.length === 1 && iv[0][0] <= input.content.y + 0.01 && iv[0][1] >= input.content.y + input.content.height - 0.01;
  let intervals = cols > 0 ? intervalsOf(0) : [];
  colBlocked[0] = !full(intervals);
  for (let i = 0; i < input.shapes.length; i++) {
    const h = heightOf(squared ? 'square' : input.shapes[i], u);
    let placed = false;
    while (col < cols && !placed) {
      for (const [a, z] of intervals) {
        const y = Math.max(a, cursor === -Infinity ? a : cursor + GAP);
        if (y + h <= z + 0.01) {
          rects[i] = { x: columnX(input, u, col), y, width: u, height: h };
          colCards[col].push(i);
          cursor = y + h;
          placed = true;
          break;
        }
      }
      if (!placed) {
        col++;
        cursor = -Infinity;
        if (col < cols) {
          intervals = intervalsOf(col);
          colBlocked[col] = !full(intervals);
        }
      }
    }
    if (!placed) {
      if (!partial) return null;
      // Every column is full; the cards after this one overflow too.
      overflow.push(i);
    }
  }
  // Centre each unblocked column on the midline.
  for (let c = 0; c < cols; c++) {
    const ids = colCards[c];
    if (!ids.length || colBlocked[c]) continue;
    const first = rects[ids[0]];
    const last = rects[ids[ids.length - 1]];
    const stack = last.y + last.height - first.y;
    const dy = input.content.y + (input.content.height - stack) / 2 - first.y;
    for (const i of ids) rects[i] = { ...rects[i], y: rects[i].y + dy };
  }
  return { u, cols, squared, rects, overflow };
}

function sideWidth(input: SideInput): number {
  return input.side === 'left'
    ? input.centre.x - STAGE.GAP - STAGE.MARGIN
    : input.content.x + input.content.width - (input.centre.x + input.centre.width + STAGE.GAP);
}

/** The largest u (1 column, then 2) that fits every card; null when none does. */
function fitSide(input: SideInput, squared: boolean): SideFit | null {
  if (!input.shapes.length) return { u: 0, cols: 0, squared, rects: [], overflow: [] };
  const w = sideWidth(input);
  for (const cols of [1, 2]) {
    const uMax = Math.min(STAGE.U_MAX, (w - (cols - 1) * STAGE.GAP) / cols);
    if (uMax < STAGE.U_MIN) continue;
    for (let u = uMax; u >= STAGE.U_MIN; u = u === uMax && u !== Math.floor(u) ? Math.floor(u) : u - 1) {
      const f = fill(input, u, cols, squared, false);
      if (f) return f;
    }
  }
  return null;
}

/** The last resort: the smallest cards in as many columns as fit, the rest drawn in Others. */
function overflowSide(input: SideInput): SideFit {
  const w = sideWidth(input);
  const cols = w >= 2 * STAGE.U_MIN + STAGE.GAP ? 2 : w >= STAGE.U_MIN ? 1 : 0;
  if (!cols) return { u: 0, cols: 0, squared: true, rects: [], overflow: input.shapes.map((_, i) => i) };
  return fill(input, STAGE.U_MIN, cols, true, true) ?? { u: 0, cols: 0, squared: true, rects: [], overflow: input.shapes.map((_, i) => i) };
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
  // Centred on the centre, as wide as the band allows: a pill that fits one row never spills
  // over the centre's header (it grows as an overlay only while the owner points at it).
  const qw = Math.min(Math.max(centre.width, STAGE.QUEUE_MAX), f.content.width);
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
  const auto = floating.filter((c) => !isOwner(c));
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
  const autoOn = (side: 'left' | 'right') => auto.filter((c) => sideOf.get(c.id) === side);

  /**
   * Fit both sides around `blocks`. With `phantoms`, each owner card also takes its slot on its
   * side as if it were auto-placed: that pass gives the UNIT an owner card is drawn at, the one
   * it had before it was dropped, so a drop never resizes the card under the hand, and a reload
   * draws it at the same size again.
   */
  const solve = (blocks: Rect[], phantoms = false) => {
    const sides = (cw: number, extra = false) => {
      const centre = centreAt(f, cw);
      const left: ContainerShape[] = [];
      const right: ContainerShape[] = [];
      for (const c of floating) {
        const side = isOwner(c) && !phantoms ? undefined : sideOf.get(c.id);
        if (side) (side === 'left' ? left : right).push(c.shape);
      }
      if (extra) (left.length <= right.length ? left : right).push('tall');
      const mk = (side: 'left' | 'right', s: ContainerShape[]): SideInput => ({ side, shapes: s, centre, content: f.content, blocks });
      return { centre, L: mk('left', left), R: mk('right', right) };
    };
    const fitsAt = (cw: number, extra = false) => {
      const s = sides(cw, extra);
      const L = fitSide(s.L, false);
      const R = L ? fitSide(s.R, false) : null;
      return L && R ? { ...s, Lf: L, Rf: R } : null;
    };
    const candidates = centreCandidates(f.width);
    let chosen: ReturnType<typeof fitsAt> = null;
    for (const cw of candidates) { chosen = fitsAt(cw); if (chosen) break; }
    // Hysteresis: never widen past the previous width unless the wider step fits with one card
    // to spare, so one card opening and closing never makes the owner's chat wobble.
    const prev = opts.prevCentre;
    if (chosen && prev && chosen.centre.width > prev + 0.5 && candidates.some((w) => Math.abs(w - prev) < 0.5)) {
      let widened: ReturnType<typeof fitsAt> = null;
      for (const cw of candidates) {
        if (cw <= prev + 0.5) break;
        if (fitsAt(cw, true)) { widened = fitsAt(cw); break; }
      }
      chosen = widened ?? fitsAt(prev) ?? chosen;
    }
    if (chosen) return { centre: chosen.centre, L: chosen.Lf, R: chosen.Rf };
    // Nothing fits at the narrowest centre: tall cards drawn square, then overflow into Others.
    const s = sides(candidates[candidates.length - 1]);
    const L = fitSide(s.L, true) ?? overflowSide(s.L);
    const R = fitSide(s.R, true) ?? overflowSide(s.R);
    return { centre: s.centre, L, R };
  };

  let sol = solve([], owned.length > 0);
  let ownerRects = new Map<string, Rect>();
  if (owned.length) {
    const unitSol = sol;
    const unitFor = (id: string) => {
      const u = (sideOf.get(id) === 'left' ? unitSol.L.u : unitSol.R.u) || Math.max(unitSol.L.u, unitSol.R.u) || STAGE.U_MAX;
      return Math.min(STAGE.U_MAX, Math.max(STAGE.U_MIN, u));
    };
    const place = (centre: Rect) => {
      const m = new Map<string, Rect>();
      for (const c of owned) {
        if (c.id === drag?.id) { m.set(c.id, drag.rect); continue; }
        const u = unitFor(c.id);
        m.set(c.id, pushOut(rectFromPos(f.free, c.pos!, u, heightOf(c.shape, u)), centre, f.free));
      }
      return m;
    };
    ownerRects = place(sol.centre);
    sol = solve([...ownerRects.values()]);
    // The centre may have narrowed around the owner's cards: push them out of its new gap.
    ownerRects = place(sol.centre);
  }

  const lay = (side: 'left' | 'right', fit: SideFit) => {
    autoOn(side).forEach((c, k) => {
      if (fit.overflow.includes(k) || !fit.rects[k]) { toOthers(c); return; }
      cards[c.id] = { id: c.id, rect: fit.rects[k], where: 'float', shape: fit.squared ? 'square' : c.shape, owner: false, z: z.get(c.id) ?? 0 };
    });
  };
  lay('left', sol.L);
  lay('right', sol.R);
  for (const c of owned) {
    const rect = ownerRects.get(c.id) ?? EMPTY;
    // Owner-placed cards paint above the auto-placed ones (they may sit over each other).
    cards[c.id] = { id: c.id, rect, where: 'float', shape: c.shape, owner: true, z: MAX_CONTAINERS + (z.get(c.id) ?? 0) };
  }
  return finish(sol.centre, sol.centre.width, 'float', { left: sol.L.u, right: sol.R.u });
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
