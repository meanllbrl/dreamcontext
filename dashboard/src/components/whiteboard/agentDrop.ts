/**
 * Drag-to-ask: an element dragged onto an agent card (or the agent panel) goes back where it was
 * and lands in that agent's composer on the board, the panel's, as a reference chip (`dcref:wb/<board>/<id>`, expanded by the server's
 * `board-refs.ts`). Pure decisions over plain element shapes; `WhiteboardCanvas` applies them.
 *
 * Undo (amendment 2), against @excalidraw/excalidraw 0.18.1. The drop runs synchronously inside
 * the pointer-up callback, which Excalidraw fires BEFORE it schedules and commits the drag's
 * history capture. So:
 *   1. the restore goes in with `NEVER`: the store snapshot keeps the pre-drag elements;
 *   2. the card's activation goes in as a plain state change (no capture of its own);
 *   3. Excalidraw's own commit diffs snapshot against scene. History ignores `id`, `updated`,
 *      `version`, `versionNonce` and `seed` (`ElementsChange.stripIrrelevantProps`), and every
 *      other field is back to its pre-drag value ({@link historyDiff} is empty), so the drag's
 *      entry holds only the selection moving to the card.
 * One Cmd+Z then reverts that selection change, which is visible, so `History.perform` stops
 * there: the element never was on the card in any entry, and an edit before the drop survives.
 * No hidden step: the drop adds no entry beyond the one the drag itself makes.
 *
 * No React, no CSS, no Excalidraw import: root vitest imports this file.
 */
import type { WidgetKind } from './widgetModel';
import { readWidgetPayload } from './widgetModel';

/** At most this many elements become chips per drop (the server expands no more per message). */
export const DROP_UNITS_MAX = 4;

/** Mirrors `TOKEN_RE` in `src/lib/whiteboards/board-refs.ts`: a token it would not match is
 *  never staged, since the agent would get nothing for it. */
const BOARD_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ELEMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const TITLE_MAX = 60;

/** The element fields a drag can change, which a restore puts back. */
const RESTORE_KEYS = ['x', 'y', 'width', 'height', 'angle', 'points', 'startBinding', 'endBinding', 'boundElements', 'frameId'] as const;
type RestoreKey = (typeof RESTORE_KEYS)[number];

/** The slice of an Excalidraw element these decisions read. */
export interface DropElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted?: boolean;
  angle?: number;
  containerId?: string | null;
  text?: string;
  originalText?: string;
  customData?: unknown;
  points?: unknown;
  startBinding?: unknown;
  endBinding?: unknown;
  boundElements?: unknown;
  frameId?: unknown;
}

/** An element as it was at pointer-down: its version and every field a restore writes. */
export type PreGesture = Pick<DropElement, 'id' | 'version'> & Partial<Pick<DropElement, RestoreKey>>;

/** A copy taken at pointer-down. Excalidraw mutates elements in place during a drag, so a
 *  reference would read the dragged geometry by pointer-up. */
export function snapshotElement(el: DropElement): PreGesture {
  const copy: PreGesture = { id: el.id, version: el.version };
  for (const key of RESTORE_KEYS) {
    if (!(key in el)) continue;
    const value = el[key];
    (copy as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
  }
  return copy;
}

/** Live elements whose version changed since pointer-down: what the gesture moved, including
 *  bound text and arrows that followed it. Null when the gesture made an element that was not
 *  there before (an Alt-drag duplicate), which is never a drop. */
export function movedIds(before: ReadonlyMap<string, PreGesture>, elements: readonly DropElement[]): Set<string> | null {
  const moved = new Set<string>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const pre = before.get(el.id);
    if (!pre) return null;
    if (pre.version !== el.version) moved.add(el.id);
  }
  return moved;
}

/** The live agent card under `point` that can take a drop: topmost first, never one the gesture
 *  moved, never rotated. Any size: the chip lands in the panel, not on the card. */
export function agentCardUnder(
  elements: readonly DropElement[],
  moved: ReadonlySet<string>,
  point: { x: number; y: number },
): DropElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    if (el.isDeleted || moved.has(el.id) || el.type !== 'embeddable' || el.angle) continue;
    const payload = readWidgetPayload(el);
    if (payload?.kind !== 'agent') continue;
    const inside = point.x >= el.x && point.x <= el.x + el.width && point.y >= el.y && point.y <= el.y + el.height;
    if (inside) return el;
  }
  return null;
}

/** One chip's worth: the element the reference names, what it is, and its title (may be ''). */
export interface DropUnit {
  id: string;
  /** A widget's kind, or the element's own type ('text', 'rectangle', 'arrow', 'freedraw', …). */
  kind: WidgetKind | string;
  title: string;
}

function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

function textOf(el: DropElement): string {
  return typeof el.originalText === 'string' ? el.originalText : typeof el.text === 'string' ? el.text : '';
}

function unitOf(el: DropElement, live: readonly DropElement[]): DropUnit {
  const payload = readWidgetPayload(el);
  if (payload) return { id: el.id, kind: payload.kind, title: oneLine(payload.title || payload.ref || payload.url || '') };
  if (el.type === 'text') return { id: el.id, kind: 'text', title: oneLine(textOf(el)) };
  const label = live.find((e) => !e.isDeleted && e.type === 'text' && e.containerId === el.id);
  return { id: el.id, kind: el.type, title: label ? oneLine(textOf(label)) : '' };
}

/**
 * What a drop references: each dragged element once, a bound text folded into its container,
 * topmost first (scene order is paint order, last on top), at most {@link DROP_UNITS_MAX}.
 */
export function dropUnits(elements: readonly DropElement[], dragged: ReadonlySet<string>): DropUnit[] {
  const live = elements.filter((el) => !el.isDeleted);
  const byId = new Map(live.map((el) => [el.id, el]));
  const order = new Map(live.map((el, i) => [el.id, i]));
  const unitIds = new Set<string>();
  for (const id of dragged) {
    const el = byId.get(id);
    if (!el) continue;
    const container = el.type === 'text' && el.containerId ? byId.get(el.containerId) : undefined;
    unitIds.add(container ? container.id : el.id);
  }
  return [...unitIds]
    .sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0))
    .slice(0, DROP_UNITS_MAX)
    .map((id) => unitOf(byId.get(id)!, live));
}

/** The ids a selection reference carries at most (the page block's cap). */
export const SELECTION_IDS_MAX = 12;

/** What the writing field sends for the canvas's current selection (plan K5). */
export interface SelectionRef {
  /** Every selected unit, counted (a bound text folds into its container). */
  n: number;
  /** Topmost first, at most {@link SELECTION_IDS_MAX}. */
  ids: string[];
  /** Rounded scene bounds `[x, y, w, h]` of the selected elements and their bound text. */
  box: [number, number, number, number];
  /** The one unit, when exactly one is selected (its chip shows its title or kind). */
  one: DropUnit | null;
}

function pointsOf(el: DropElement): Array<[number, number]> | null {
  if (!Array.isArray(el.points) || el.points.length === 0) return null;
  const out: Array<[number, number]> = [];
  for (const p of el.points as unknown[]) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1])) out.push([p[0], p[1]]);
  }
  return out.length ? out : null;
}

/** An element's axis-aligned scene bounds: a line's points, a rotated shape's corners. */
function boundsOf(el: DropElement): [number, number, number, number] | null {
  const pts = pointsOf(el);
  const local: Array<[number, number]> = pts ?? [[0, 0], [el.width, 0], [el.width, el.height], [0, el.height]];
  const angle = typeof el.angle === 'number' && Number.isFinite(el.angle) ? el.angle : 0;
  // Rotation is about the element's box centre (Excalidraw's rule for shapes and lines alike).
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [px, py] of local) {
    let x = el.x + px;
    let y = el.y + py;
    if (angle) {
      const dx = x - cx; const dy = y - cy;
      x = cx + dx * cos - dy * sin;
      y = cy + dx * sin + dy * cos;
    }
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1) ? [x0, y0, x1, y1] : null;
}

/**
 * The selection as the writing field sends it, or null when nothing live is selected. Units fold
 * like {@link dropUnits} (a bound text is its container), all are counted, the ids run topmost
 * first up to {@link SELECTION_IDS_MAX}, and `box` is the union of the selected elements and their
 * bound text, so a selection larger than the id cap is still located. `dropUnits` is unchanged.
 */
export function selectionRef(elements: readonly DropElement[], selectedIds: Iterable<string>): SelectionRef | null {
  const live = elements.filter((el) => !el.isDeleted);
  const byId = new Map(live.map((el) => [el.id, el]));
  const order = new Map(live.map((el, i) => [el.id, i]));
  const unitIds = new Set<string>();
  for (const id of selectedIds) {
    const el = byId.get(id);
    if (!el) continue;
    const container = el.type === 'text' && el.containerId ? byId.get(el.containerId) : undefined;
    unitIds.add(container ? container.id : el.id);
  }
  if (unitIds.size === 0) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const el of live) {
    const inUnit = unitIds.has(el.id) || (el.type === 'text' && !!el.containerId && unitIds.has(el.containerId));
    if (!inUnit) continue;
    const b = boundsOf(el);
    if (!b) continue;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  const box: [number, number, number, number] = Number.isFinite(x0)
    ? [Math.round(x0), Math.round(y0), Math.max(0, Math.round(x1 - x0)), Math.max(0, Math.round(y1 - y0))]
    : [0, 0, 0, 0];
  const sorted = [...unitIds].sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0));
  return {
    n: sorted.length,
    ids: sorted.slice(0, SELECTION_IDS_MAX),
    box,
    one: sorted.length === 1 ? unitOf(byId.get(sorted[0])!, live) : null,
  };
}

/** The reference the server expands, or null when board or id would not match its token. */
export function refToken(board: string, elementId: string): string | null {
  if (!BOARD_RE.test(board) || !ELEMENT_ID_RE.test(elementId)) return null;
  return `dcref:wb/${board}/${elementId}`;
}

/** What Excalidraw's history leaves out when it diffs two copies of an element
 *  (`ElementsChange.stripIrrelevantProps`, 0.18.1). */
const HISTORY_IGNORED_KEYS: ReadonlySet<string> = new Set(['id', 'updated', 'version', 'versionNonce', 'seed']);

/** The fields Excalidraw's history would record between two copies of an element. Empty means
 *  a capture between them holds nothing for it: what a restore must achieve before the drag's
 *  commit, so no history entry ever carries the move. */
export function historyDiff(prev: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((key) => !HISTORY_IGNORED_KEYS.has(key) && JSON.stringify(prev[key]) !== JSON.stringify(next[key]));
}

/** A restore for one element: its pre-gesture fields, at a version above the one it has now. */
export type RestorePatch = Partial<Pick<DropElement, RestoreKey>> & { version: number };

/** Every moved element back to its pre-gesture geometry and bindings. The version is one above
 *  the CURRENT one, so a save and the poll's reconcile take the restore over the drag. */
export function restorePatches(
  before: ReadonlyMap<string, PreGesture>,
  elements: readonly DropElement[],
  moved: ReadonlySet<string>,
): Map<string, RestorePatch> {
  const patches = new Map<string, RestorePatch>();
  for (const el of elements) {
    const pre = moved.has(el.id) ? before.get(el.id) : undefined;
    if (!pre || el.isDeleted) continue;
    const { id: _id, version: _version, ...fields } = pre;
    patches.set(el.id, { ...fields, version: el.version + 1 });
  }
  return patches;
}
