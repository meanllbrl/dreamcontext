import { WhiteboardValidationError } from './errors.js';
import { elementBBox, formatBBox, gridPlace, liveElements, unionBBox, type BBox } from './ops.js';
import { elementTag, widgetPayloadOf, WIDGET_GRID, type WhiteboardElement } from './widgets.js';

/**
 * Where things are on a board, and where a new thing may go: the overlap check every
 * `draw` / `add` runs under the board's lock, the per-tag groups `show` summarises, and the
 * free-slot search behind `place` and `--below` / `--right-of`.
 *
 * Boxes are axis-aligned (`elementBBox`, rotation ignored). Two boxes overlap when their
 * interiors meet; sharing an edge is not an overlap, but a zero-height line lying inside a
 * box is.
 */

/** The grid pitch: one 180px cell plus the 16px gap. Placement answers are multiples of it. */
export const GRID_PITCH = WIDGET_GRID.cell + WIDGET_GRID.gap;

export function boxesOverlap(a: BBox, b: BBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** One live element as an overlap report names it. */
export interface Occupant {
  id: string;
  type: string;
  kind?: string;
  tag?: string;
  bbox: BBox;
}

/** Live elements that carry one tag (`tag: null` = untagged), and the box around them. */
export interface TagGroup {
  tag: string | null;
  count: number;
  bbox: BBox;
}

function occupant(el: WhiteboardElement): Occupant {
  const o: Occupant = { id: el.id, type: el.type, bbox: elementBBox(el) };
  const kind = widgetPayloadOf(el)?.kind;
  if (kind) o.kind = kind;
  const tag = elementTag(el);
  if (tag) o.tag = tag;
  return o;
}

function contains(outer: BBox, inner: BBox): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/**
 * Every live element whose box overlaps `box`, in board order. A frame that wholly contains
 * `box` is a container, not an occupant: putting something in a frame's empty space covers
 * nothing (what the frame already holds still counts, element by element).
 */
export function occupantsOf(elements: readonly WhiteboardElement[], box: BBox): Occupant[] {
  return liveElements(elements)
    .filter((el) => {
      const b = elementBBox(el);
      if (!boxesOverlap(b, box)) return false;
      return !((el.type === 'frame' || el.type === 'magicframe') && contains(b, box));
    })
    .map(occupant);
}

/**
 * Live elements grouped by tag: tagged groups top to bottom (then left to right), the
 * untagged rest last.
 */
export function tagGroups(elements: readonly WhiteboardElement[]): TagGroup[] {
  const byTag = new Map<string | null, BBox[]>();
  for (const el of liveElements(elements)) {
    const tag = elementTag(el) ?? null;
    const list = byTag.get(tag) ?? [];
    list.push(elementBBox(el));
    byTag.set(tag, list);
  }
  const groups = [...byTag.entries()].map(([tag, boxes]) => ({ tag, count: boxes.length, bbox: unionBBox(boxes)! }));
  const tagged = groups.filter((g) => g.tag !== null).sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  return [...tagged, ...groups.filter((g) => g.tag === null)];
}

/** Groups occupants by tag, most first. */
function occupantGroups(occupants: readonly Occupant[]): { tag: string | null; count: number }[] {
  const counts = new Map<string | null, number>();
  for (const o of occupants) counts.set(o.tag ?? null, (counts.get(o.tag ?? null) ?? 0) + 1);
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

/** How many occupants a refusal prints before it points at `--json` for the rest. */
const LISTED_OCCUPANTS = 100;

/**
 * A write refused because what it places would cover live elements. Carries everything a
 * caller needs to move it: the box it wanted, who is there, and grouped by tag.
 */
export class WhiteboardOverlapError extends WhiteboardValidationError {
  readonly box: BBox;
  readonly occupants: Occupant[];
  readonly groups: { tag: string | null; count: number; bbox: BBox }[];
  readonly hint: string;

  constructor(opts: { slug: string; what: string; box: BBox; occupants: Occupant[]; elements: readonly WhiteboardElement[]; hint: string }) {
    const { slug, what, box, occupants, hint } = opts;
    const all = tagGroups(opts.elements);
    const groups = occupantGroups(occupants).map((g) => ({
      ...g,
      bbox: all.find((t) => t.tag === g.tag)?.bbox ?? box,
    }));
    const lines = [
      `refusing to ${what}: its box ${formatBBox(box)} overlaps ${occupants.length} live element${occupants.length === 1 ? '' : 's'} on ${slug}`,
      ...groups.map((g) => `  ${g.tag ? `#${g.tag}` : 'untagged'}: ${g.count} overlapping (that group spans ${formatBBox(g.bbox)})`),
      ...occupants.slice(0, LISTED_OCCUPANTS).map((o) => `    ${o.id}  ${o.kind ?? o.type}${o.tag ? `  #${o.tag}` : ''}  @${formatBBox(o.bbox)}`),
      ...(occupants.length > LISTED_OCCUPANTS ? [`    … ${occupants.length - LISTED_OCCUPANTS} more (--json lists every one)`] : []),
      hint,
    ];
    super(lines.join('\n'));
    this.box = box;
    this.occupants = occupants;
    this.groups = groups;
    this.hint = hint;
  }

  toJSON(): Record<string, unknown> {
    return { error: 'overlap', box: this.box, overlaps: this.occupants, groups: this.groups, hint: this.hint };
  }
}

/**
 * Refuse to place `box` over live elements. Call it inside `mutateWhiteboard`, on the board
 * the lock just read, so a write another session made after your last `show` still counts.
 */
export function assertFree(
  elements: readonly WhiteboardElement[],
  box: BBox,
  ctx: { slug: string; what: string },
): void {
  const occupants = occupantsOf(elements, box);
  if (occupants.length === 0) return;
  const size = `${Math.ceil(box.w)},${Math.ceil(box.h)}`;
  const below = occupantGroups(occupants).find((g) => g.tag !== null)?.tag;
  const hint = [
    `  Find free space: dreamcontext whiteboard place ${ctx.slug} --size ${size}${below ? ` --below ${below}` : ''}`,
    `  or let the write place itself (${below ? `--below ${below}` : 'leave out --at'}), or pass --allow-overlap to put it there anyway.`,
  ].join('\n');
  throw new WhiteboardOverlapError({ slug: ctx.slug, what: ctx.what, box, occupants, elements, hint });
}

// ─── free slots ───────────────────────────────────────────────────────────

/** Relative placement: under or beside a tagged group, optionally lined up with another. */
export interface Anchor {
  below?: string;
  rightOf?: string;
  alignLeft?: string;
}

export function hasAnchor(a: Anchor): boolean {
  return a.below !== undefined || a.rightOf !== undefined || a.alignLeft !== undefined;
}

/** The box around every live element tagged `tag`; refuses a tag nothing carries. */
export function tagBBox(elements: readonly WhiteboardElement[], tag: string): BBox {
  const live = liveElements(elements);
  const box = unionBBox(live.filter((el) => elementTag(el) === tag).map(elementBBox));
  if (box) return box;
  const tags = [...new Set(live.map((el) => elementTag(el)).filter((t): t is string => !!t))];
  throw new WhiteboardValidationError(
    `no live element tagged '${tag}' on this board${tags.length ? ` (tags here: ${tags.join(', ')})` : ' (nothing on it is tagged)'}`,
  );
}

const snapUp = (v: number) => Math.ceil(v / GRID_PITCH) * GRID_PITCH;
const snapDown = (v: number) => Math.floor(v / GRID_PITCH) * GRID_PITCH;
const snapNear = (v: number) => Math.round(v / GRID_PITCH) * GRID_PITCH;

/**
 * A grid-aligned top-left (multiples of {@link GRID_PITCH}) where a `w`×`h` box overlaps no
 * live element and keeps a 16px gap from each.
 *
 * - `below: T` — under group T, lined up with T's left edge (or `alignLeft`'s); walks down
 *   a pitch at a time until it is clear.
 * - `rightOf: T` — beside group T, lined up with T's top; walks right until clear.
 * - `alignLeft: A` alone — the first clear slot in A's column, from the top of the board's
 *   content down.
 * - nothing — the same slot `add` picks without `--at` (the first grid row it fits in).
 *
 * The search always ends: past the content's last edge every slot is clear.
 */
export function placeFree(
  elements: readonly WhiteboardElement[],
  size: { w: number; h: number },
  anchor: Anchor = {},
): { x: number; y: number } {
  if (anchor.below !== undefined && anchor.rightOf !== undefined) {
    throw new WhiteboardValidationError('use --below or --right-of, not both');
  }
  if (anchor.rightOf !== undefined && anchor.alignLeft !== undefined) {
    throw new WhiteboardValidationError('--align-left lines a box up under something; it goes with --below, not --right-of');
  }
  const gap = WIDGET_GRID.gap;
  const boxes = liveElements(elements).map(elementBBox);
  const clear = (x: number, y: number) => {
    const padded = { x: x - gap, y: y - gap, w: size.w + 2 * gap, h: size.h + 2 * gap };
    return !boxes.some((b) => boxesOverlap(padded, b));
  };
  const content = unionBBox(boxes);

  if (anchor.below !== undefined) {
    const t = tagBBox(elements, anchor.below);
    const x = snapNear(anchor.alignLeft !== undefined ? tagBBox(elements, anchor.alignLeft).x : t.x);
    let y = snapUp(t.y + t.h + gap);
    while (!clear(x, y)) y += GRID_PITCH;
    return { x, y };
  }
  if (anchor.rightOf !== undefined) {
    const t = tagBBox(elements, anchor.rightOf);
    const y = snapNear(t.y);
    let x = snapUp(t.x + t.w + gap);
    while (!clear(x, y)) x += GRID_PITCH;
    return { x, y };
  }
  if (anchor.alignLeft !== undefined) {
    const x = snapNear(tagBBox(elements, anchor.alignLeft).x);
    let y = content ? snapDown(content.y) : 0;
    while (!clear(x, y)) y += GRID_PITCH;
    return { x, y };
  }
  return gridPlace(elements, size);
}
