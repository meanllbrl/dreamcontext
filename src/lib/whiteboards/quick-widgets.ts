/**
 * The quick edit's live widgets (owner 12 Nov: "Hızlı düzenle buraya HTML web sayfası, insight
 * vs. de ekleyebilmeli"). The model still runs with NO tools: it answers `widgets: [{kind, ...}]`
 * and the server does the rest here, outside the board's lock:
 *
 * - every name is resolved against the vault (`widgetRefExists`); an unknown one is refused with
 *   the name, never guessed;
 * - a web card shows an `https:` page or a file INSIDE this project only (no localhost, no
 *   absolute path, no symlink, no `..`): a board syncs to teammates, so a local secret must never
 *   ride onto one;
 * - every text is bounded (an html card is the sandboxed, network-less block it always is);
 * - the payload is then built by the one engine `whiteboard add` uses (widget-add.ts).
 *
 * Placement (`placeQuickWidgets`) runs inside the apply: in the chosen area at the widgets'
 * natural size, else beside the selection or the content, never on top of anything.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { elementBBox, liveElements, unionBBox, type BBox } from './ops.js';
import { nextIndices } from './store.js';
import { classifyWebTarget } from './validate.js';
import { widgetBox, widgetElementAt, widgetPayloadFor, widgetRefExists, WidgetInputError } from './widget-add.js';
import {
  WIDGET_GRID, isCardColor, isWidgetKind, isWidgetSize, pageRefKind,
  type CardColor, type WhiteboardElement, type WidgetKind, type WidgetPayload, type WidgetSize,
} from './widgets.js';

export const QUICK_WIDGET_MAX = 4;
export const QUICK_WIDGET_TITLE_MAX = 120;
export const QUICK_NOTE_MAX = 4000;
export const QUICK_HTML_MAX = 40_000;
export const QUICK_WIDGET_URL_MAX = 1024;
export const QUICK_TODO_MAX = 30;
export const QUICK_TODO_TEXT_MAX = 200;
/** Past this an answer is not read at all (unreadable); under it a too-long field is refused by name. */
const HARD_TEXT = 200_000;
const HARD_ITEMS = 200;

export interface QuickWidget {
  kind: WidgetKind;
  ref?: string;
  title?: string;
  text?: string;
  url?: string;
  items?: string[];
  size?: WidgetSize;
  color?: CardColor;
}

/** One `widgets` entry in shape, or null (the answer is then not read). */
export function readQuickWidget(raw: unknown): QuickWidget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const known = new Set(['kind', 'ref', 'title', 'text', 'url', 'items', 'size', 'color']);
  if (Object.keys(o).some((k) => !known.has(k))) return null;
  if (!isWidgetKind(o.kind)) return null;
  const out: QuickWidget = { kind: o.kind };
  for (const k of ['ref', 'title', 'text', 'url'] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > HARD_TEXT) return null;
    out[k] = v;
  }
  if (o.items !== undefined) {
    if (!Array.isArray(o.items) || o.items.length > HARD_ITEMS || !o.items.every((x) => typeof x === 'string' && x.length <= HARD_TEXT)) return null;
    out.items = o.items as string[];
  }
  if (o.size !== undefined) { if (!isWidgetSize(o.size)) return null; out.size = o.size; }
  if (o.color !== undefined) { if (!isCardColor(o.color)) return null; out.color = o.color; }
  return out;
}

export type WidgetRefusalWhy = 'not_found' | 'web' | 'too_long' | 'bad';

/** A widget the quick edit will not add: the page words it from `kind`, `why` and `name`. */
export class QuickWidgetRefusal extends Error {
  readonly code = 'widget';
  constructor(readonly kind: WidgetKind, readonly why: WidgetRefusalWhy, readonly name: string) {
    super(`quick edit refused a ${kind} widget (${why})`);
  }
}

// eslint-disable-next-line no-control-regex
const shown = (s: string | undefined): string => (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);

/**
 * A project file a card may show: a relative path with no `..` or empty step, every step a real
 * folder or file (never a symlink), a regular file whose real path stays inside the project.
 */
export function projectFileInside(root: string, rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\u0000')) return false;
  const parts = rel.replace(/^(\.\/)+/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  const project = dirname(root);
  let realProject: string;
  try { realProject = realpathSync(project); } catch { return false; }
  let cur = project;
  try {
    for (const p of parts) {
      cur = join(cur, p);
      if (lstatSync(cur).isSymbolicLink()) return false;
    }
    if (!statSync(cur).isFile()) return false;
    const real = realpathSync(cur);
    return real === realProject || real.startsWith(realProject + sep);
  } catch {
    return false;
  }
}

/** Something the apply places: its natural box, and how to make its element at a spot. */
export interface Placeable {
  w: number;
  h: number;
  make(pos: { x: number; y: number }, index: string, now: number): WhiteboardElement;
}

export interface PreparedWidget extends Placeable {
  kind: WidgetKind;
  payload: Omit<WidgetPayload, 'v' | 'kind'>;
}

function checkLengths(w: QuickWidget): void {
  const long = (v: string | undefined, max: number) => v !== undefined && v.length > max;
  const textMax = w.kind === 'html' ? QUICK_HTML_MAX : QUICK_NOTE_MAX;
  if (long(w.title, QUICK_WIDGET_TITLE_MAX) || long(w.text, textMax) || long(w.url, QUICK_WIDGET_URL_MAX) || long(w.ref, QUICK_WIDGET_URL_MAX)
    || (w.items && (w.items.length > QUICK_TODO_MAX || w.items.some((t) => t.length > QUICK_TODO_TEXT_MAX)))) {
    throw new QuickWidgetRefusal(w.kind, 'too_long', shown(w.title ?? w.ref ?? w.url));
  }
}

/**
 * Every widget of an answer, checked and built into a payload (no board needed, no lock held).
 * Throws {@link QuickWidgetRefusal} on the first one that may not be added: all or nothing.
 */
export function prepareQuickWidgets(root: string, widgets: readonly QuickWidget[], opts: { selfOrigin?: string } = {}): PreparedWidget[] {
  const out: PreparedWidget[] = [];
  for (const w of widgets) {
    checkLengths(w);
    const title = w.title?.trim() || undefined;
    if (w.kind === 'insight' || w.kind === 'task' || w.kind === 'lab-card' || w.kind === 'agent' || w.kind === 'knowledge') {
      const ref = w.ref?.trim();
      if (!ref) throw new QuickWidgetRefusal(w.kind, 'bad', '');
      // A page may also be a project file: the same inside-the-project rule as a web card.
      const isPath = w.kind === 'knowledge' && pageRefKind(ref) !== 'knowledge';
      const exists = isPath ? projectFileInside(root, ref) : widgetRefExists(root, w.kind, ref);
      if (!exists) throw new QuickWidgetRefusal(w.kind, 'not_found', shown(ref));
    }
    let url: string | undefined;
    if (w.kind === 'web') {
      const t = classifyWebTarget(w.url, opts.selfOrigin);
      const ok = t.ok && (t.kind === 'url' ? new URL(t.href).protocol === 'https:' : !t.absolute && projectFileInside(root, t.path));
      if (!ok) throw new QuickWidgetRefusal('web', 'web', shown(w.url));
      url = w.url!.trim();
    }
    let payload: Omit<WidgetPayload, 'v' | 'kind'>;
    try {
      payload = widgetPayloadFor(root, w.kind, {
        ref: w.ref?.trim(), title, text: w.text, url, items: w.items?.map((s) => s.trim()).filter(Boolean),
        size: w.size, color: w.color,
      }, opts);
    } catch (err) {
      if (err instanceof WidgetInputError) {
        const why: WidgetRefusalWhy = err.problem === 'not_found' ? 'not_found' : err.problem === 'web' ? 'web' : 'bad';
        throw new QuickWidgetRefusal(w.kind, why, shown(w.ref ?? w.url ?? w.title));
      }
      throw err;
    }
    const [bw, bh] = widgetBox(w.kind, payload);
    const kind = w.kind;
    out.push({ kind, payload, w: bw, h: bh, make: (pos, index, now) => widgetElementAt(kind, payload, pos, index, undefined, now) });
  }
  return out;
}

const overlaps = (a: BBox, b: BBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Lay boxes out in rows from (x, y), wrapping past `width`. */
function flow(sizes: readonly { w: number; h: number }[], x: number, y: number, width: number): BBox[] {
  const gap = WIDGET_GRID.gap;
  const out: BBox[] = [];
  let cx = x; let cy = y; let rowH = 0;
  for (const s of sizes) {
    if (cx > x && cx + s.w > x + width) { cx = x; cy += rowH + gap; rowH = 0; }
    out.push({ x: cx, y: cy, w: s.w, h: s.h });
    cx += s.w + gap;
    rowH = Math.max(rowH, s.h);
  }
  return out;
}

/**
 * Place prepared widgets on a board (inside the apply): in `area` from its top-left at natural
 * size; else to the right of the selection (`focus`), else of the content. When the group would
 * cover anything, it moves to the free side right of everything, level with where it started (the
 * drawings' rule). `grew`: the group is larger than the area the owner chose.
 */
export function placeQuickWidgets(
  prepared: readonly Placeable[],
  existing: readonly WhiteboardElement[],
  where: { area: { x: number; y: number; w: number; h: number } | null; focus: BBox | null },
  now: number,
): { elements: WhiteboardElement[]; grew: boolean } {
  if (!prepared.length) return { elements: [], grew: false };
  const live = liveElements(existing).map(elementBBox);
  const content = unionBBox(live);
  const gap = 40;
  let boxes: BBox[];
  if (where.area) {
    boxes = flow(prepared, where.area.x, where.area.y, where.area.w);
  } else {
    const anchor = where.focus ?? content;
    boxes = anchor ? flow(prepared, anchor.x + anchor.w + gap, anchor.y, 800) : flow(prepared, 0, 0, 800);
  }
  const group = unionBBox(boxes)!;
  const grew = !!where.area && (group.w > where.area.w + 0.5 || group.h > where.area.h + 0.5);
  if (live.some((b) => boxes.some((m) => overlaps(m, b))) && content) {
    const dx = content.x + content.w + gap - group.x;
    boxes = boxes.map((b) => ({ ...b, x: b.x + dx }));
  }
  const indices = nextIndices(existing, prepared.length);
  const elements = prepared.map((p, i) => p.make({ x: Math.round(boxes[i].x), y: Math.round(boxes[i].y) }, indices[i], now));
  return { elements, grew };
}
