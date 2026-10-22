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
 *
 * Card sizes (owner 2026-10-22, "like Apple widgets"): a floating card may be medium (2×1 tiles),
 * large (2×2) or wide (3×2). A stage of small cards only is laid out exactly as before (pinned
 * by a snapshot); one sized card switches the float pass to `solveSized`, where each side takes
 * the width its widest card needs and the centre narrows for it, staying in the middle while it
 * can, never under CENTRE_MIN. A size
 * that does not fit is DRAWN smaller (the plan's `size`), the record is never touched.
 */
import {
  CONTAINER_SIZES, MAX_CONTAINERS, MAX_PRESENT, SIZE_UNITS, applyGroupOp, dissolveGroups, leaveGroups, normalizeGroups, viewWithout,
  type ContainerShape, type ContainerSize, type GroupOp, type SuperContainer, type SuperGroup, type SuperView,
} from '../../../lib/superTypes';

export interface Rect { x: number; y: number; width: number; height: number }

/** Every constant of the stage, in one place (tested by invariants, not pixels). */
export const STAGE = {
  /** Outer margin, and the one gap between the centre, every card and every column (O1). */
  MARGIN: 24,
  GAP: 24,
  /** The two thin bands above and below the centre: the job bar on top, dock + Others below.
   *  The top one is always reserved; the bottom one only while it holds something (terminals in
   *  the dock, a card in Others) or the stage is narrow: otherwise the centre and its columns run
   *  down to the margin (owner 2026-10-21: the centre takes the height, its width unchanged). */
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
  /** A floating card: the size it is DRAWN at (its record's, or smaller when that does not fit). */
  size?: ContainerSize;
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
  /** The record's size preset (absent = small; a group is always small). */
  size?: ContainerSize;
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
    const size = sizeOf(c);
    if (!g || shown.has(c.id)) out.push({ id: c.id, kind: c.kind, shape: c.shape, place: c.place, ...(c.pos ? { pos: c.pos } : {}), slot: i, ...(size !== 'small' ? { size } : {}) });
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
  /** Terminal pills in the dock: the bottom band is reserved for them. */
  terminals?: number;
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

// ─── Sized cards (owner 2026-10-22) ──────────────────────────────────────────────

interface SizedSlot extends Slot { size: ContainerSize; z: number }

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
 * Both sides around the centre when a card is sized. Each side is as wide as its widest card
 * (in tiles) and the centre takes what is left, between CENTRE_MIN and its preferred width,
 * narrowing evenly so it stays in the middle; off the middle only when that would take it under
 * CENTRE_MIN. Too wide even then: the wider side (on a tie, the one
 * whose widest card comes later in the record) is capped one tile narrower and its cards are
 * drawn at the largest size that fits it. Within a side, cards run top to bottom in record order
 * against the inner (centre) edge: a sized card is a block of its own, a run of small cards fills
 * rows of the side's width. A side taller than the stage first widens (when the centre can
 * spare it and it has small cards to pair); then the auto-placed cards give way, the latest
 * first (their height: wide/large → medium, medium → small; then their place, to Others, any
 * card before a chat); only then the owner's own cards, the same way. A one-column side of
 * small cards keeps its orbit.
 */
function solveSized(f: Frame, left: readonly SizedSlot[], right: readonly SizedSlot[]): SizedSolution {
  const { GAP, MARGIN, TILE: T, ORBIT_DEPTH } = STAGE;
  const W = f.width;
  const span = f.content.height;
  const preferred = preferredCentre(W);
  const drawn = new Map<string, ContainerSize>();
  for (const s of [...left, ...right]) drawn.set(s.id, s.size);
  const overflow = new Set<string>();
  const sides = { left: [...left], right: [...right] };
  const live = (side: 'left' | 'right') => sides[side].filter((s) => !overflow.has(s.id));
  const widest = (side: 'left' | 'right') => live(side).reduce((m, s) => Math.max(m, SIZE_UNITS[drawn.get(s.id)!].w), 0);
  const cols = { left: widest('left'), right: widest('right') };
  const avail = () => W - 2 * MARGIN - unitsPx(cols.left) - unitsPx(cols.right) - (cols.left ? GAP : 0) - (cols.right ? GAP : 0);
  const capSide = (side: 'left' | 'right', cap: number) => {
    cols[side] = cap;
    for (const s of live(side)) drawn.set(s.id, shrinkToWidth(drawn.get(s.id)!, cap));
  };
  // Width: narrow the wider side until the centre keeps its floor.
  while (avail() < STAGE.CENTRE_MIN && (cols.left > 1 || cols.right > 1)) {
    const lastWide = (side: 'left' | 'right') => Math.max(-1, ...live(side).filter((s) => SIZE_UNITS[drawn.get(s.id)!].w === cols[side]).map((s) => s.z));
    const side = cols.left !== cols.right ? (cols.left > cols.right ? 'left' : 'right') : (lastWide('left') > lastWide('right') ? 'left' : 'right');
    capSide(side, cols[side] - 1);
  }
  // Rows of one side at its width.
  type Row = { h: number; items: SizedSlot[] };
  const rowsOf = (side: 'left' | 'right'): Row[] => {
    const rows: Row[] = [];
    let run: Row | null = null;
    for (const s of live(side)) {
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
    for (let guard = 0; guard < 200 && heightOfRows(rowsOf(side)) > span; guard++) {
      const items = live(side);
      const smalls = items.filter((s) => drawn.get(s.id) === 'small').length;
      // 1. Widen, when the centre can spare a tile and there are small cards to pair up.
      if (cols[side] < STAGE.MAX_COLS + 1 && smalls >= 2 && avail() - T - GAP >= STAGE.CENTRE_MIN && cols[side] >= 1) {
        cols[side] += 1;
        continue;
      }
      // 2. The auto-placed cards give way first, the latest first: their height, then their place
      //    (to Others, any card before a chat). Only then does the owner's own card give up
      //    height, and last its place: he chose its size and where it stands.
      const latest = [...items].reverse();
      const shrink = (owner: boolean) => latest.find((s) => s.owner === owner && SIZE_UNITS[drawn.get(s.id)!].h > 1)
        ?? latest.find((s) => s.owner === owner && drawn.get(s.id) === 'medium' && cols[side] >= 2);
      const drop = (owner: boolean) => latest.find((s) => s.owner === owner && !s.chat) ?? latest.find((s) => s.owner === owner);
      const step = shrink(false) ?? null;
      if (step) { drawn.set(step.id, HEIGHT_STEP[drawn.get(step.id)!]!); continue; }
      const auto = drop(false);
      if (auto) { overflow.add(auto.id); continue; }
      const own = shrink(true);
      if (own) { drawn.set(own.id, HEIGHT_STEP[drawn.get(own.id)!]!); continue; }
      const last = drop(true);
      if (!last) break;
      overflow.add(last.id);
    }
  }
  // The centre stays IN THE MIDDLE while it can (owner 2026-10-22: "I made a card bigger and the
  // agent in the centre was no longer centred; no need, there is room"): it narrows evenly on
  // both sides for the wider side, never over its preferred width. Only when even that would
  // take it under CENTRE_MIN does it move off the middle, right after the left side.
  const need = Math.max(unitsPx(cols.left) + (cols.left ? GAP : 0), unitsPx(cols.right) + (cols.right ? GAP : 0));
  const centred = Math.min(preferred, W - 2 * MARGIN - 2 * need);
  const centreW = centred >= STAGE.CENTRE_MIN - 1e-9 ? centred : Math.max(STAGE.CENTRE_MIN, Math.min(preferred, avail()));
  const x = centred >= STAGE.CENTRE_MIN - 1e-9
    ? (W - centreW) / 2
    : MARGIN + unitsPx(cols.left) + (cols.left ? GAP : 0) + Math.max(0, (avail() - centreW) / 2);
  const centre: Rect = { x, y: f.content.y, width: centreW, height: f.content.height };
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
 *  asked (the size menu and the corner handle offer only what this says). */
export function fitsNow(
  containers: readonly StageItem[], view: SuperView, stage: { width: number; height: number }, id: string, size: ContainerSize, opts: PlanOptions = {},
): boolean {
  const next = containers.map((c) => (c.id === id ? { ...c, ...(size === 'small' ? { size: undefined } : { size }) } : c));
  const p = planStage(next, view, stage, opts).cards[id];
  return !!p && p.where === 'float' && (p.size ?? 'small') === size;
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

/** The stage's frame. `bottomBand`: the bottom band is reserved (the content stops above it);
 *  without it the content runs down to the bottom margin. */
function frameOf(width: number, height: number, bottomBand = true): Frame {
  const { MARGIN, BAND } = STAGE;
  const below = bottomBand ? MARGIN + BAND : MARGIN;
  const content: Rect = { x: MARGIN, y: MARGIN + BAND, width: Math.max(0, width - 2 * MARGIN), height: Math.max(0, height - (MARGIN + BAND) - below) };
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
  // The bottom band only while it holds something (owner 2026-10-21): plan with the content down
  // to the margin first; a dock with terminals, a narrow stage, or a plan that draws a card in
  // Others reserves the band and plans again (the same inputs always give the same screen).
  // An empty stage keeps the band: its first-run hint is drawn there (review Major).
  const narrow = Math.max(0, stage.width) < NARROW_STAGE_PX;
  if (!narrow && !(opts.terminals ?? 0) && containers.length > 0) {
    const tall = planWith(containers, view, stage, opts, false);
    if (tall.others.length === 0) return tall;
  }
  return planWith(containers, view, stage, opts, true);
}

function planWith(
  containers: readonly StageItem[],
  view: SuperView,
  stage: { width: number; height: number },
  opts: PlanOptions,
  bottomBand: boolean,
): StagePlan {
  // Items: at most the record's MAX_CONTAINERS cards, plus a grouped card the view presents beside its group.
  const list = containers.slice(0, MAX_CONTAINERS + MAX_PRESENT);
  const f = frameOf(Math.max(0, stage.width), Math.max(0, stage.height), bottomBand);
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
  const sizeById = new Map(floating.map((c) => [c.id, sizeOf(c)] as const));
  const withSize = (sl: Slot): SizedSlot => ({ ...sl, size: sizeById.get(sl.id) ?? 'small', z: z.get(sl.id) ?? 0 });

  // One pass with every item on its side's orbit, the owner's included where they would stand:
  // it sets the stage. An owner tile is drawn at the one tile size wherever he dropped it.
  // A stage of small cards keeps the orbit exactly as it was; one sized card packs the sides by
  // size (solveSized).
  const sized = floating.some((c) => sizeOf(c) !== 'small');
  const sol = sized
    ? solveSized(f, slotsOn('left').map(withSize), slotsOn('right').map(withSize))
    : { ...solveFloat(f, slotsOn('left'), slotsOn('right')), drawn: new Map<string, ContainerSize>(), uRight: undefined };
  const drawnOf = (id: string): ContainerSize => sol.drawn.get(id) ?? 'small';
  const centre = sol.centre;
  const ownerRects = new Map<string, Rect>();
  for (const c of owned) {
    if (c.id === drag?.id) { ownerRects.set(c.id, drag.rect); continue; }
    const px = sizePx(drawnOf(c.id));
    ownerRects.set(c.id, pushOut(rectFromPos(f.free, c.pos!, px.width, px.height), centre, f.free));
  }

  // The owner's cards sit where they were dropped. An auto card clear of them keeps its place;
  // one they cover moves to the free spot of its own column nearest where it stood (at its
  // size, else 1:1), else it is drawn in Others: the stage moves as few cards as it can.
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
  for (const c of moved) {
    const rect = reseat(sol.rects.get(c.id)!, f, blocks);
    if (!rect) { toOthers(c); continue; }
    blocks.push(rect);
    auto(c, rect);
  }
  for (const c of owned) {
    const rect = ownerRects.get(c.id) ?? EMPTY;
    // Owner-placed cards paint above the auto-placed ones (they may sit over each other).
    cards[c.id] = { id: c.id, rect, where: 'float', shape: drawnShape(rect), size: drawnOf(c.id), owner: true, z: MAX_CONTAINERS + (z.get(c.id) ?? 0) };
  }
  const width = (side: 'left' | 'right') => (floating.some((c) => sideOf.get(c.id) === side && cards[c.id]?.where === 'float')
    ? (side === 'right' ? sol.uRight ?? sol.u : sol.u) : 0);
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
  /** The owner's size for a card (a group is never sized); `null` hands it back. */
  size?: ContainerSize | null;
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
  /** Cards or groups the owner opened (a group's panel, full screen): the server's tidying
   *  counts them as touched. Changes nothing on the record. */
  touch?: string[];
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
  if (patch.ungroup?.length) dissolveGroups(st, patch.ungroup);
  const gone = new Set(patch.closed ?? []);
  for (const id of gone) unshown.add(id);
  if (gone.size) st.containers = st.containers.filter((x) => !gone.has(x.id));
  const { containers, groups } = normalizeGroups(st.containers, st.groups);
  const live = new Set(containers.map((c) => c.id));
  const v = patch.view ?? viewWithout(state.view, unshown);
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
    // A size the server ignores (a group's) counts as echoed; a card's echoes as its record.
    if ('kind' in k && p.size === null && (k.size || k.sizeBy)) return false;
    if ('kind' in k && p.size && (CONTAINER_SIZES as readonly string[]).includes(p.size)
      && (sizeOf(k) !== p.size || k.sizeBy !== 'owner')) return false;
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
