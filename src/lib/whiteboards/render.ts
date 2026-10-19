import { sortElements } from './format.js';
import { boxesOverlap } from './layout.js';
import { elementBBox, liveElements, unionBBox, type BBox } from './ops.js';
import { FONT_ADVANCE, FONT_ROWS, lineRuns } from './pixel-font.js';
import { Raster, ellipsePoly, roundRectPoly, strokePolys, type Pt, type RGB } from './raster.js';
import { widgetPayloadOf, type WhiteboardElement } from './widgets.js';

/**
 * `whiteboard render`: a board (or one region of it) as a PNG, drawn in-process. It exists so
 * an agent can LOOK at what it placed without a browser — never the user's open dashboard.
 *
 * It draws geometry faithfully (boxes, ellipses, diamonds, lines, arrows and their heads,
 * frames, z-order, rotation, opacity, dashes) and text with a pixel font at each element's
 * own size, alignment and line breaks. Widgets are cards with their title and kind, not
 * their live content; a picture is a placeholder box. Hachure fills are drawn as a light
 * solid fill. It is a layout proof: where things are, what covers what, what fits.
 */

export interface RenderOptions {
  /** The board rectangle to draw. */
  region: BBox;
  /** Output pixels per board unit. */
  scale: number;
  /** A group to outline in red with a label, e.g. the tag just drawn. */
  outline?: { box: BBox; label: string };
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  /** Elements that fell inside the region and were drawn. */
  drawn: number;
}

/** The longest side a render gets when no `--scale` is asked for. */
export const DEFAULT_MAX_SIDE = 2000;
/** Hard cap on either side of the output, whatever the scale (4096² RGB is ~50MB in memory). */
export const MAX_SIDE = 4096;

/** The box around every live element, padded; a small empty box for an empty board. */
export function contentRegion(elements: readonly WhiteboardElement[], pad = 40): BBox {
  const box = unionBBox(liveElements(elements).map(elementBBox));
  if (!box) return { x: 0, y: 0, w: 400, h: 200 };
  return { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
}

/** 1:1 unless that would pass `maxSide`; then the scale that fits. */
export function fitScale(region: BBox, maxSide = DEFAULT_MAX_SIDE): number {
  const side = Math.max(region.w, region.h, 1);
  return side <= maxSide ? 1 : maxSide / side;
}

// ─── colours ──────────────────────────────────────────────────────────────

const NAMED: Record<string, RGB> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [224, 49, 49], green: [47, 158, 68], blue: [25, 113, 194],
  gray: [134, 142, 150], grey: [134, 142, 150], orange: [247, 103, 7], yellow: [245, 159, 0],
  purple: [112, 72, 232], pink: [214, 51, 108], cyan: [16, 152, 173],
};

/** A CSS colour as RGB plus its own alpha, or null for transparent / unreadable. */
function parseColor(raw: unknown): { rgb: RGB; a: number } | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'none') return null;
  if (NAMED[s]) return { rgb: NAMED[s], a: 1 };
  const m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], a: hex.length === 8 ? n(6) / 255 : 1 };
}

const INK: RGB = [30, 30, 30];
const MUTED: RGB = [134, 142, 150];
const LINE: RGB = [173, 181, 189];
const HIGHLIGHT: RGB = [224, 49, 49];

/** Card tints by `dc.color`: a light surface and a stronger border, like the dashboard's. */
const TINTS: Record<string, [RGB, RGB]> = {
  grey: [[241, 243, 245], [173, 181, 189]],
  blue: [[231, 245, 255], [116, 192, 252]],
  red: [[255, 245, 245], [255, 168, 168]],
  yellow: [[255, 249, 219], [255, 212, 59]],
  green: [[235, 251, 238], [140, 233, 154]],
  pink: [[255, 240, 246], [250, 162, 193]],
  purple: [[243, 240, 255], [177, 151, 252]],
  cyan: [[227, 250, 252], [102, 217, 232]],
};
const CARD: [RGB, RGB] = [[248, 249, 250], [173, 181, 189]];

// ─── drawing ──────────────────────────────────────────────────────────────

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

type Map2 = (p: Pt) => Pt;

interface Ctx {
  r: Raster;
  scale: number;
  region: BBox;
}

/** Board → pixel, rotating around `center` by `angle` first. */
function mapper(ctx: Ctx, angle = 0, center: Pt = [0, 0]): Map2 {
  const { region, scale } = ctx;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return ([x, y]) => {
    let bx = x;
    let by = y;
    if (angle) {
      const dx = x - center[0];
      const dy = y - center[1];
      bx = center[0] + dx * cos - dy * sin;
      by = center[1] + dx * sin + dy * cos;
    }
    return [(bx - region.x) * scale, (by - region.y) * scale];
  };
}

function strokeWidthPx(ctx: Ctx, el: WhiteboardElement): number {
  return Math.max(1, num(el.strokeWidth, 2) * ctx.scale);
}

function dashFor(ctx: Ctx, el: WhiteboardElement): readonly [number, number] | undefined {
  const sw = num(el.strokeWidth, 2);
  if (el.strokeStyle === 'dashed') return [8 * ctx.scale, (8 + sw) * ctx.scale];
  if (el.strokeStyle === 'dotted') return [Math.max(1, 1.5 * ctx.scale), (6 + sw) * ctx.scale];
  return undefined;
}

function fillShape(ctx: Ctx, el: WhiteboardElement, poly: Pt[], alpha: number): void {
  const bg = parseColor(el.backgroundColor);
  if (!bg) return;
  const solid = el.fillStyle === 'solid' || el.fillStyle === undefined;
  ctx.r.fill([poly], bg.rgb, alpha * bg.a * (solid ? 1 : 0.5));
}

function strokeShape(ctx: Ctx, el: WhiteboardElement, poly: Pt[], alpha: number, closed = true): void {
  const c = parseColor(el.strokeColor);
  if (!c || num(el.strokeWidth, 2) <= 0) return;
  ctx.r.fill(strokePolys(poly, strokeWidthPx(ctx, el), { closed, dash: dashFor(ctx, el) }), c.rgb, alpha * c.a);
}

interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextStyle {
  fontSize: number;
  lineHeight?: number;
  align?: string;
  valign?: string;
  color: RGB;
  alpha?: number;
  /** squeeze: narrow every line evenly to fit `w`; clip: cut lines that do not fit, with … */
  fit?: 'squeeze' | 'clip';
  map: Map2;
}

/** Lines of text in a box, in the pixel font, at the given board font size. */
function drawText(ctx: Ctx, lines: string[], box: TextBox, style: TextStyle): void {
  const u = style.fontSize / 10;
  const lineBox = style.fontSize * (style.lineHeight ?? 1.25);
  let shown = lines;
  let sx = 1;
  if (style.fit === 'clip' && box.w > 0) {
    const maxChars = Math.max(1, Math.floor((box.w / u + 1) / FONT_ADVANCE));
    shown = lines.map((l) => ([...l].length > maxChars ? [...l].slice(0, Math.max(1, maxChars - 1)).join('') + '…' : l));
  }
  const laid = shown.map((l) => lineRuns(l));
  const widest = Math.max(0, ...laid.map((l) => l.width)) * u;
  if (style.fit === 'squeeze' && box.w > 0 && widest > box.w) sx = box.w / widest;
  const total = laid.length * lineBox;
  const top = style.valign === 'middle' ? box.y + (box.h - total) / 2 : style.valign === 'bottom' ? box.y + box.h - total : box.y;
  laid.forEach((line, i) => {
    if (line.runs.length === 0) return;
    const cellTop = top + i * lineBox + (lineBox - FONT_ROWS * u) / 2;
    const lineW = line.width * u * sx;
    const left = style.align === 'center' ? box.x + (box.w - lineW) / 2 : style.align === 'right' ? box.x + box.w - lineW : box.x;
    const polys = line.runs.map(([x0, x1, row]): Pt[] => {
      const ax = left + x0 * u * sx;
      const bx = left + x1 * u * sx;
      const ay = cellTop + row * u;
      const by = ay + u;
      return [style.map([ax, ay]), style.map([bx, ay]), style.map([bx, by]), style.map([ax, by])];
    });
    ctx.r.fill(polys, style.color, style.alpha ?? 1);
  });
}

/** Excalidraw's corner radius for a rounded rectangle. */
function cornerRadius(el: WhiteboardElement, w: number, h: number): number {
  const round = el.roundness as { type?: number; value?: number } | null | undefined;
  if (!round || typeof round !== 'object') return 0;
  const side = Math.min(w, h);
  if (round.type === 3) return typeof round.value === 'number' ? round.value : side <= 128 ? side * 0.25 : 32;
  return side * 0.25;
}

function arrowhead(kind: string, tip: Pt, from: Pt, size: number): { fill?: Pt[]; stroke?: Pt[][] } {
  const len = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1;
  const ux = (tip[0] - from[0]) / len;
  const uy = (tip[1] - from[1]) / len;
  const back: Pt = [tip[0] - ux * size, tip[1] - uy * size];
  const side = (k: number): Pt => [back[0] - uy * size * k, back[1] + ux * size * k];
  const sideOf = (k: number): Pt => [back[0] + uy * size * k, back[1] - ux * size * k];
  switch (kind) {
    case 'triangle':
      return { fill: [tip, side(0.45), sideOf(0.45)] };
    case 'triangle_outline':
      return { stroke: [[tip, side(0.45), sideOf(0.45), tip]] };
    case 'dot':
    case 'circle':
      return { fill: ellipsePoly(tip[0], tip[1], size * 0.3, size * 0.3, 16) };
    case 'circle_outline':
      return { stroke: [[...ellipsePoly(tip[0], tip[1], size * 0.3, size * 0.3, 16), ellipsePoly(tip[0], tip[1], size * 0.3, size * 0.3, 16)[0]]] };
    case 'bar':
      return { stroke: [[[tip[0] - uy * size * 0.45, tip[1] + ux * size * 0.45], [tip[0] + uy * size * 0.45, tip[1] - ux * size * 0.45]]] };
    case 'diamond': {
      const mid: Pt = [tip[0] - ux * size * 0.5, tip[1] - uy * size * 0.5];
      return { fill: [tip, [mid[0] - uy * size * 0.25, mid[1] + ux * size * 0.25], back, [mid[0] + uy * size * 0.25, mid[1] - ux * size * 0.25]] };
    }
    default: {
      const a = 25 * (Math.PI / 180);
      const wing = (s: number): Pt => [
        tip[0] - size * (ux * Math.cos(a) - s * uy * Math.sin(a)),
        tip[1] - size * (uy * Math.cos(a) + s * ux * Math.sin(a)),
      ];
      return { stroke: [[wing(1), tip, wing(-1)]] };
    }
  }
}

function drawLinear(ctx: Ctx, el: WhiteboardElement, alpha: number, map: Map2): void {
  const x = num(el.x);
  const y = num(el.y);
  const raw = Array.isArray(el.points) ? (el.points as unknown[]) : [];
  const board: Pt[] = raw.map((p) => [x + num((p as number[])[0]), y + num((p as number[])[1])] as Pt);
  if (board.length < 2) return;
  const pts = board.map(map);
  const closed = el.type === 'line' && (el.polygon === true || (board.length > 2 && Math.hypot(board[0][0] - board[board.length - 1][0], board[0][1] - board[board.length - 1][1]) < 1));
  if (closed) fillShape(ctx, el, pts, alpha);
  const c = parseColor(el.strokeColor);
  if (!c) return;
  const sw = el.type === 'freedraw' ? Math.max(1, num(el.strokeWidth, 2) * 1.2 * ctx.scale) : strokeWidthPx(ctx, el);
  ctx.r.fill(strokePolys(pts, sw, { dash: el.type === 'freedraw' ? undefined : dashFor(ctx, el) }), c.rgb, alpha * c.a);
  if (el.type !== 'arrow') return;
  const size = (12 + 3 * num(el.strokeWidth, 2)) * ctx.scale;
  const heads: [unknown, Pt, Pt][] = [
    [el.endArrowhead, pts[pts.length - 1], pts[pts.length - 2]],
    [el.startArrowhead, pts[0], pts[1]],
  ];
  for (const [kind, tip, from] of heads) {
    if (typeof kind !== 'string' || !kind) continue;
    const head = arrowhead(kind, tip, from, size);
    if (head.fill) ctx.r.fill([head.fill], c.rgb, alpha * c.a);
    if (head.stroke) ctx.r.fill(head.stroke.flatMap((s) => strokePolys(s, sw)), c.rgb, alpha * c.a);
  }
}

/** A widget (or any embed) as a card: its surface, its title, and what it is. */
function drawCard(ctx: Ctx, el: WhiteboardElement, box: BBox, alpha: number, map: Map2): void {
  const dc = widgetPayloadOf(el);
  const [surface, border] = (dc?.color && TINTS[dc.color]) || CARD;
  const poly = roundRectPoly(box.x, box.y, box.w, box.h, Math.min(12, box.w / 4, box.h / 4)).map(map);
  ctx.r.fill([poly], surface, alpha);
  ctx.r.fill(strokePolys(poly, Math.max(1, 1.5 * ctx.scale), { closed: true }), border, alpha);
  const firstLine = (md: unknown) => (typeof md === 'string' ? md.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) : undefined);
  const kind = dc?.kind ?? (el.type === 'image' ? 'image' : 'embed');
  const title = dc?.title || (dc?.kind === 'note' ? firstLine(dc.markdown) : undefined) || (dc?.ref ?? kind);
  const done = dc?.items ? ` · ${dc.items.filter((i) => i.done).length}/${dc.items.length} done` : '';
  const sub = dc ? `${kind}${dc.ref && dc.ref !== title ? ` · ${dc.ref}` : ''}${done}` : typeof el.link === 'string' ? el.link : '';
  const pad = 12;
  const inner = { x: box.x + pad, w: Math.max(1, box.w - 2 * pad) };
  drawText(ctx, [title], { ...inner, y: box.y + 10, h: 20 }, { fontSize: 16, color: INK, alpha, fit: 'clip', map });
  if (sub && box.h >= 56) drawText(ctx, [sub], { ...inner, y: box.y + 34, h: 16 }, { fontSize: 12, color: MUTED, alpha, fit: 'clip', map });
}

function drawElement(ctx: Ctx, el: WhiteboardElement): void {
  const alpha = Math.max(0, Math.min(1, num(el.opacity, 100) / 100));
  if (alpha === 0) return;
  const box = elementBBox(el);
  const angle = num(el.angle);
  const map = mapper(ctx, angle, [box.x + box.w / 2, box.y + box.h / 2]);
  const x = num(el.x);
  const y = num(el.y);
  const w = Math.abs(num(el.width));
  const h = Math.abs(num(el.height));
  switch (el.type) {
    case 'rectangle': {
      const poly = roundRectPoly(x, y, w, h, cornerRadius(el, w, h)).map(map);
      fillShape(ctx, el, poly, alpha);
      strokeShape(ctx, el, poly, alpha);
      return;
    }
    case 'diamond': {
      const poly = ([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]] as Pt[]).map(map);
      fillShape(ctx, el, poly, alpha);
      strokeShape(ctx, el, poly, alpha);
      return;
    }
    case 'ellipse': {
      const poly = ellipsePoly(x + w / 2, y + h / 2, w / 2, h / 2).map(map);
      fillShape(ctx, el, poly, alpha);
      strokeShape(ctx, el, poly, alpha);
      return;
    }
    case 'line':
    case 'arrow':
    case 'freedraw':
      drawLinear(ctx, el, alpha, map);
      return;
    case 'text': {
      const text = typeof el.text === 'string' ? el.text : typeof el.originalText === 'string' ? el.originalText : '';
      const color = parseColor(el.strokeColor);
      drawText(ctx, text.replace(/\r/g, '').split('\n'), { x, y, w, h }, {
        fontSize: num(el.fontSize, 20),
        lineHeight: num(el.lineHeight, 1.25),
        align: typeof el.textAlign === 'string' ? el.textAlign : 'left',
        valign: typeof el.verticalAlign === 'string' ? el.verticalAlign : 'top',
        color: color?.rgb ?? INK,
        alpha: alpha * (color?.a ?? 1),
        fit: 'squeeze',
        map,
      });
      return;
    }
    case 'image': {
      const poly = ([[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as Pt[]).map(map);
      ctx.r.fill([poly], [241, 243, 245], alpha);
      ctx.r.fill([...strokePolys(poly, 1, { closed: true }), ...strokePolys([poly[0], poly[2]], 1), ...strokePolys([poly[1], poly[3]], 1)], LINE, alpha);
      drawText(ctx, ['image'], { x, y, w, h }, { fontSize: 14, align: 'center', valign: 'middle', color: MUTED, alpha, fit: 'clip', map });
      return;
    }
    case 'frame':
    case 'magicframe': {
      const poly = ([[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as Pt[]).map(map);
      ctx.r.fill(strokePolys(poly, Math.max(1, ctx.scale), { closed: true }), MUTED, alpha);
      const name = typeof el.name === 'string' && el.name ? el.name : 'Frame';
      drawText(ctx, [name], { x, y: y - 22, w, h: 18 }, { fontSize: 14, color: MUTED, alpha, fit: 'clip', map });
      return;
    }
    case 'embeddable':
    case 'iframe':
      drawCard(ctx, el, { x, y, w, h }, alpha, map);
      return;
    default: {
      const poly = ([[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as Pt[]).map(map);
      ctx.r.fill(strokePolys(poly, 1, { closed: true, dash: [6, 4] }), LINE, alpha);
    }
  }
}

/** Draw every live element that reaches into `opts.region`, in z-order. */
export function renderScene(elements: readonly WhiteboardElement[], opts: RenderOptions): RenderResult {
  const { region, scale } = opts;
  const width = Math.min(MAX_SIDE, Math.max(1, Math.ceil(region.w * scale)));
  const height = Math.min(MAX_SIDE, Math.max(1, Math.ceil(region.h * scale)));
  const ctx: Ctx = { r: new Raster(width, height), scale, region };
  const reach = { x: region.x - 40, y: region.y - 40, w: region.w + 80, h: region.h + 80 };
  let drawn = 0;
  for (const el of sortElements(liveElements(elements))) {
    const b = elementBBox(el);
    if (!boxesOverlap({ x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1) }, reach)) continue;
    drawElement(ctx, el);
    drawn++;
  }
  if (opts.outline) {
    const pad = 8;
    const o = opts.outline.box;
    const map = mapper(ctx);
    const poly = ([[o.x - pad, o.y - pad], [o.x + o.w + pad, o.y - pad], [o.x + o.w + pad, o.y + o.h + pad], [o.x - pad, o.y + o.h + pad]] as Pt[]).map(map);
    ctx.r.fill(strokePolys(poly, 2, { closed: true, dash: [10, 6] }), HIGHLIGHT, 0.9);
    // Label size in pixels stays readable whatever the scale.
    const fs = 14 / scale;
    drawText(ctx, [opts.outline.label], { x: o.x - pad, y: o.y - pad - fs * 1.5, w: Math.max(o.w, fs * 20), h: fs * 1.25 }, { fontSize: fs, color: HIGHLIGHT, map });
  }
  return { png: ctx.r.toPng(), width, height, drawn };
}
