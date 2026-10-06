import { parseWhiteboard, sortElements } from './format.js';
import { WhiteboardValidationError } from './errors.js';
import { isValidWidgetRef, validateElement } from './validate.js';
import {
  cliSafeId,
  elementTag,
  newElementId,
  randomInteger,
  widgetPayloadOf,
  WIDGET_GRID,
  WIDGET_SIZES,
  nearestWidgetSize,
  isCardColor,
  CARD_COLORS,
  type CardColor,
  type WidgetSize,
  type TodoItem,
  type WhiteboardElement,
  type WidgetPayload,
  type WikiSection,
} from './widgets.js';
import { nextIndices } from './store.js';
import { readWikiSections } from './nav.js';

/**
 * Element-level operations behind the `dreamcontext whiteboard` verbs, kept out of the CLI so
 * they are testable and reusable. Every edit follows Excalidraw's versioning contract (D4):
 * `version + 1`, a fresh random `versionNonce`, `updated = now` — so the browser's reconcile
 * and the store's merge both see the edit as newer than what they hold.
 */

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Axis-aligned bounds, honouring a linear element's relative `points`. Rotation is ignored. */
export function elementBBox(el: WhiteboardElement): BBox {
  const x = num(el.x);
  const y = num(el.y);
  const pts = Array.isArray(el.points) ? (el.points as unknown[]) : null;
  if (pts && pts.length > 0) {
    const xs = pts.map((p) => num((p as number[])[0]));
    const ys = pts.map((p) => num((p as number[])[1]));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: x + minX, y: y + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  return { x, y, w: num(el.width), h: num(el.height) };
}

export function unionBBox(boxes: readonly BBox[]): BBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function formatBBox(b: BBox): string {
  return `${b.x},${b.y},${b.w},${b.h}`;
}

export function liveElements(elements: readonly WhiteboardElement[]): WhiteboardElement[] {
  return elements.filter((e) => e.isDeleted !== true);
}

const PLACEMENT_GAP = 80;

/** Where a new thing goes without `--at`: to the right of everything live, top-aligned. */
export function autoPlace(elements: readonly WhiteboardElement[]): { x: number; y: number } {
  const box = unionBBox(liveElements(elements).map(elementBBox));
  if (!box) return { x: 0, y: 0 };
  return { x: box.x + box.w + PLACEMENT_GAP, y: box.y };
}

/** How wide a widget row grows before placement wraps below: eight grid cells. */
export const GRID_ROW_CELLS = 8;

/**
 * Where a new widget of size `w`×`h` goes without `--at` (A17): on the grid pitch
 * (cell + gap), in the first grid row — from the content's top row down — where it fits to
 * the right of everything already in that row within {@link GRID_ROW_CELLS} cells, and below
 * all content otherwise (a grid row no element reaches is used from its left edge). It never
 * overlaps a live element and keeps at least one gap from each.
 */
export function gridPlace(elements: readonly WhiteboardElement[], size: { w: number; h: number }): { x: number; y: number } {
  const { gap } = WIDGET_GRID;
  const pitch = WIDGET_GRID.cell + gap;
  const boxes = liveElements(elements).map(elementBBox);
  const content = unionBBox(boxes);
  if (!content) return { x: 0, y: 0 };
  const x0 = Math.floor(content.x / pitch) * pitch;
  const y0 = Math.floor(content.y / pitch) * pitch;
  const rowEnd = x0 + Math.max(GRID_ROW_CELLS * pitch - gap, content.x + content.w - x0);
  const snapUp = (v: number) => x0 + Math.max(0, Math.ceil((v - x0) / pitch)) * pitch;
  const clash = (x: number, y: number, b: BBox) =>
    x < b.x + b.w + gap && b.x < x + size.w + gap && y < b.y + b.h + gap && b.y < y + size.h + gap;
  for (let y = y0; ; y += pitch) {
    const band = boxes.filter((b) => y < b.y + b.h + gap && b.y < y + size.h + gap);
    if (band.length === 0) return { x: x0, y };
    const x = snapUp(Math.max(...band.map((b) => b.x + b.w)) + gap);
    if (x + size.w <= rowEnd && !boxes.some((b) => clash(x, y, b))) return { x, y };
  }
}

/** The versioning bump every edit carries (D4). */
export function bumpVersion(el: WhiteboardElement, now = Date.now()): WhiteboardElement {
  return { ...el, version: num(el.version) + 1, versionNonce: randomInteger(), updated: now };
}

export function tombstone(el: WhiteboardElement, now = Date.now()): WhiteboardElement {
  return bumpVersion({ ...el, isDeleted: true }, now);
}

// ─── show ─────────────────────────────────────────────────────────────────

export const SHOW_TRUNCATE = 500;

export interface ElementView {
  id: string;
  type: string;
  kind?: string;
  ref?: string;
  title?: string;
  text?: string;
  tag?: string;
  bbox: BBox;
  /** A widget's grid size: its `dc.size`, or the preset nearest its width/height when unset. */
  size?: WidgetSize;
  items?: TodoItem[];
  /** A wiki card's list of sections and pages. */
  sections?: WikiSection[];
  /** The card's tint, when it has one. */
  color?: CardColor;
  url?: string;
  markdown?: string;
  html?: string;
  truncated?: true;
}

/** What `show` reports for one element. `full` skips the 500-char cut of markdown/html. */
export function describeElement(el: WhiteboardElement, full = false): ElementView {
  const view: ElementView = { id: el.id, type: el.type, bbox: elementBBox(el) };
  if (el.type === 'text') {
    const t = typeof el.originalText === 'string' ? el.originalText : typeof el.text === 'string' ? el.text : '';
    if (t) view.text = t;
  }
  const tag = elementTag(el);
  if (tag) view.tag = tag;
  const dc = widgetPayloadOf(el);
  if (dc) {
    view.kind = dc.kind;
    view.size = dc.size ?? nearestWidgetSize(view.bbox.w, view.bbox.h);
    if (dc.ref) view.ref = dc.ref;
    if (dc.title) view.title = dc.title;
    if (dc.color) view.color = dc.color;
    if (dc.items) view.items = dc.items;
    if (dc.kind === 'wiki') view.sections = readWikiSections(dc.sections);
    if (dc.url) view.url = dc.url;
    for (const key of ['markdown', 'html'] as const) {
      const v = dc[key];
      if (typeof v !== 'string') continue;
      if (!full && v.length > SHOW_TRUNCATE) {
        view[key] = v.slice(0, SHOW_TRUNCATE);
        view.truncated = true;
      } else {
        view[key] = v;
      }
    }
  }
  return view;
}

// ─── update ───────────────────────────────────────────────────────────────

export interface WidgetUpdate {
  title?: string;
  /** Note markdown / HTML block / a text element's text. */
  text?: string;
  url?: string;
  ref?: string;
  addItems?: string[];
  /** 1-based positions or item ids. */
  check?: string[];
  uncheck?: string[];
  at?: { x: number; y: number };
  /**
   * A preset sets `dc.size` and the preset's width/height (widgets only). A free-form `{w,h}`
   * sets width/height and drops a widget's `dc.size`, so the dashboard derives the nearest.
   */
  size?: WidgetSize | { w: number; h: number };
  /** A card tint, or `'none'` to clear it (widgets only). */
  color?: CardColor | 'none';
}

function findItem(items: TodoItem[], key: string): TodoItem {
  const n = Number(key);
  const byPos = Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : undefined;
  const hit = byPos ?? items.find((i) => i.id === key);
  if (!hit) throw new WhiteboardValidationError(`no todo item '${key}' (use a 1-based position or an item id)`);
  return hit;
}

export function newTodoItem(text: string): TodoItem {
  return { id: cliSafeId(8), text, done: false };
}

/** Apply an update to one live element; returns the new, version-bumped element. */
export function applyUpdate(el: WhiteboardElement, u: WidgetUpdate, now = Date.now()): WhiteboardElement {
  const next: WhiteboardElement = { ...el };
  if (u.at) {
    next.x = u.at.x;
    next.y = u.at.y;
  }
  const dc0 = widgetPayloadOf(el);
  if (typeof u.size === 'string') {
    if (!dc0) throw new WhiteboardValidationError(`size presets (s|m|l|xl) apply to widgets; element ${el.id} is a ${el.type} (use --size w,h)`);
    [next.width, next.height] = WIDGET_SIZES[u.size];
  } else if (u.size) {
    if (!(u.size.w > 0 && u.size.h > 0)) throw new WhiteboardValidationError('size must be positive (w,h > 0)');
    next.width = u.size.w;
    next.height = u.size.h;
  }
  if (dc0) {
    const dc: WidgetPayload = structuredClone(dc0);
    if (typeof u.size === 'string') dc.size = u.size;
    else if (u.size) delete dc.size;
    if (u.title !== undefined) dc.title = u.title;
    if (u.color === 'none') delete dc.color;
    else if (u.color !== undefined) {
      if (!isCardColor(u.color)) throw new WhiteboardValidationError(`invalid card color '${String(u.color)}' (one of ${CARD_COLORS.join(', ')}, or none)`);
      dc.color = u.color;
    }
    if (u.text !== undefined) {
      if (dc.kind === 'note') dc.markdown = u.text;
      else if (dc.kind === 'html') dc.html = u.text;
      else throw new WhiteboardValidationError(`--text applies to note and html widgets, not ${dc.kind}`);
    }
    if (u.url !== undefined) {
      if (dc.kind !== 'web') throw new WhiteboardValidationError('--url applies to web widgets');
      dc.url = u.url;
    }
    if (u.ref !== undefined) {
      if (!['insight', 'knowledge', 'task', 'lab-card'].includes(dc.kind)) throw new WhiteboardValidationError(`--ref does not apply to ${dc.kind} widgets`);
      if (!isValidWidgetRef(dc.kind, u.ref)) throw new WhiteboardValidationError(`invalid ${dc.kind} ref '${u.ref}'`);
      dc.ref = u.ref;
      next.link = `dreamcontext://${dc.kind}/${u.ref}`;
    }
    const itemOps = (u.addItems?.length ?? 0) + (u.check?.length ?? 0) + (u.uncheck?.length ?? 0);
    if (itemOps > 0) {
      if (dc.kind !== 'todo') throw new WhiteboardValidationError('--item/--check/--uncheck apply to todo widgets');
      const items = dc.items ?? [];
      for (const k of u.check ?? []) findItem(items, k).done = true;
      for (const k of u.uncheck ?? []) findItem(items, k).done = false;
      for (const t of u.addItems ?? []) items.push(newTodoItem(t));
      dc.items = items;
    }
    next.customData = { ...(el.customData ?? {}), dc };
  } else {
    if (u.text !== undefined) {
      if (el.type !== 'text') throw new WhiteboardValidationError(`--text does not apply to a ${el.type} element`);
      next.text = u.text;
      next.originalText = u.text;
      if ('rawText' in next) next.rawText = u.text;
    }
    if (u.title !== undefined || u.color !== undefined || u.url !== undefined || u.ref !== undefined || u.addItems?.length || u.check?.length || u.uncheck?.length) {
      throw new WhiteboardValidationError(`element ${el.id} is not a widget`);
    }
  }
  return bumpVersion(next, now);
}

// ─── remove ───────────────────────────────────────────────────────────────

/**
 * Tombstone the targets — by id, or every live element carrying `tag` — plus any text bound
 * inside a removed container. Returns the new element list, the removed ids and their bbox.
 */
export function removeElements(
  elements: readonly WhiteboardElement[],
  target: { ids?: string[]; tag?: string },
  now = Date.now(),
): { elements: WhiteboardElement[]; removed: string[]; bbox: BBox | null } {
  const live = liveElements(elements);
  const targets = new Set<string>();
  if (target.tag !== undefined) {
    for (const el of live) if (elementTag(el) === target.tag) targets.add(el.id);
  }
  for (const id of target.ids ?? []) {
    if (!live.some((e) => e.id === id)) throw new WhiteboardValidationError(`no live element '${id}' on this board`);
    targets.add(id);
  }
  for (const el of live) {
    if (typeof el.containerId === 'string' && targets.has(el.containerId)) targets.add(el.id);
  }
  const bbox = unionBBox(live.filter((e) => targets.has(e.id)).map(elementBBox));
  const out = elements.map((el) => (targets.has(el.id) && el.isDeleted !== true ? tombstone(el, now) : el));
  return { elements: out, removed: [...targets], bbox };
}

// ─── draw (import) ────────────────────────────────────────────────────────

/** Elements from a builder board (`.excalidraw.md`) or a scene / element-array JSON file. */
export function readImportSource(content: string, filename: string): WhiteboardElement[] {
  let raw: unknown;
  if (filename.endsWith('.md')) {
    raw = parseWhiteboard(content).elements;
  } else {
    try {
      const parsed = JSON.parse(content) as unknown;
      raw = Array.isArray(parsed) ? parsed : (parsed as { elements?: unknown })?.elements;
    } catch (err) {
      throw new WhiteboardValidationError(`${filename} is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (!Array.isArray(raw)) throw new WhiteboardValidationError(`${filename} holds no elements array`);
  return raw as WhiteboardElement[];
}

function remapLink(link: unknown, idMap: Map<string, string>): unknown {
  if (typeof link !== 'string') return link;
  // Element links point at another element by id: Excalidraw's `?element=<id>` and
  // Obsidian's `#^<id>` block reference.
  return link.replace(/(element=|\^)([A-Za-z0-9_-]+)/g, (m, p: string, id: string) => (idMap.has(id) ? p + idMap.get(id) : m));
}

/**
 * Prepare imported elements for a board: refuse images (D10), drop tombstones, give every
 * element and group a fresh id while keeping `boundElements`, `containerId`, `groupIds`,
 * `frameId`, arrow bindings and element links consistent, translate the group so its top-left
 * lands at `at`, and assign fresh fractional indices above the board's current max.
 */
export function prepareImport(
  source: readonly WhiteboardElement[],
  board: readonly WhiteboardElement[],
  opts: { at?: { x: number; y: number }; tag?: string; now?: number } = {},
): { elements: WhiteboardElement[]; bbox: BBox | null } {
  const now = opts.now ?? Date.now();
  if (source.some((e) => e && (e as { type?: unknown }).type === 'image' && e.isDeleted !== true)) {
    throw new WhiteboardValidationError('Images are not supported on whiteboards yet (they come in a later version); the file holds an image element');
  }
  const live = sortElements(source.filter((e) => e && typeof e.id === 'string' && e.isDeleted !== true));
  if (live.length === 0) return { elements: [], bbox: null };

  const idMap = new Map<string, string>();
  for (const el of live) idMap.set(el.id, newElementId());
  const groupMap = new Map<string, string>();
  const mapGroup = (g: string): string => {
    if (!groupMap.has(g)) groupMap.set(g, newElementId());
    return groupMap.get(g)!;
  };
  const mapId = (v: unknown): string | null => (typeof v === 'string' && idMap.has(v) ? idMap.get(v)! : null);

  const srcBox = unionBBox(live.map(elementBBox))!;
  const target = opts.at ?? autoPlace(board);
  const dx = target.x - srcBox.x;
  const dy = target.y - srcBox.y;
  const indices = nextIndices(board, live.length);

  const out = live.map((src, i) => {
    const el: WhiteboardElement = structuredClone(src);
    el.id = idMap.get(src.id)!;
    el.x = num(src.x) + dx;
    el.y = num(src.y) + dy;
    el.index = indices[i];
    el.version = 1;
    el.versionNonce = randomInteger();
    el.updated = now;
    el.isDeleted = false;
    if (Array.isArray(src.groupIds)) el.groupIds = (src.groupIds as unknown[]).filter((g): g is string => typeof g === 'string').map(mapGroup);
    if (Array.isArray(src.boundElements)) {
      el.boundElements = (src.boundElements as { id?: unknown; type?: unknown }[])
        .filter((b) => b && mapId(b.id))
        .map((b) => ({ ...b, id: mapId(b.id) }));
    }
    if ('containerId' in src) el.containerId = mapId(src.containerId);
    if ('frameId' in src) el.frameId = mapId(src.frameId);
    for (const key of ['startBinding', 'endBinding'] as const) {
      const b = src[key] as { elementId?: unknown } | null | undefined;
      if (b && typeof b === 'object') el[key] = mapId(b.elementId) ? { ...b, elementId: mapId(b.elementId) } : null;
    }
    if ('link' in src) el.link = remapLink(src.link, idMap);
    if (opts.tag !== undefined) {
      const dc = widgetPayloadOf(el);
      el.customData = dc ? { ...el.customData, dc: { ...dc, tag: opts.tag } } : { ...(el.customData ?? {}), dcTag: opts.tag };
    }
    validateElement(el);
    return el;
  });
  return { elements: out, bbox: unionBBox(out.map(elementBBox)) };
}
