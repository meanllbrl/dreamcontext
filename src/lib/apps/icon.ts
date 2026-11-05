import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { cornersTransparent, decodePng, pngSize } from './png.js';

/**
 * An app's icon: the default every new app is born with, and the check that an icon can do its
 * two jobs, a card that shows it and a Dock that tells the app apart from dreamcontext.
 *
 * The default is a coloured tile with the name's first letter, drawn here with nothing but
 * zlib: `apps new` must work on any install. The colour comes from the slug alone, so the same
 * app keeps its colour through a rename. The letters are strokes rather than a font, because a
 * font file is one more thing to ship and macOS is not the only place this runs.
 */

export const DEFAULT_ICON_FILE = 'icon.png';

const SIZE = 1024;
// The macOS app-icon grid: an 824 px tile in a 1024 canvas, its corners rounded at 185 px.
const TILE_MARGIN = 100;
const TILE_RADIUS = 185;
const LETTER_HEIGHT = 440;
const LETTER_WIDTH = 350;
const STROKE = 84;

type Point = [number, number];

/** Points along an ellipse; angles in degrees, y grows downward (-90 is the top). */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Point[] {
  const steps = 24;
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/** A-Z as polylines in a unit box. */
const GLYPHS: Record<string, Point[][]> = {
  A: [[[0, 1], [0.5, 0], [1, 1]], [[0.18, 0.64], [0.82, 0.64]]],
  B: [[[0, 0], [0, 1]], [[0, 0], [0.5, 0], ...arc(0.5, 0.25, 0.36, 0.25, -90, 90), [0, 0.5]], [[0, 0.5], [0.55, 0.5], ...arc(0.55, 0.75, 0.42, 0.25, -90, 90), [0, 1]]],
  C: [arc(0.55, 0.5, 0.55, 0.5, -45, -315)],
  D: [[[0, 0], [0, 1]], [[0, 0], [0.35, 0], ...arc(0.35, 0.5, 0.62, 0.5, -90, 90), [0, 1]]],
  E: [[[0.9, 0], [0, 0], [0, 1], [0.9, 1]], [[0, 0.5], [0.75, 0.5]]],
  F: [[[0.9, 0], [0, 0], [0, 1]], [[0, 0.5], [0.75, 0.5]]],
  G: [[...arc(0.52, 0.5, 0.52, 0.5, -45, -360), [0.6, 0.5]]],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  I: [[[0.5, 0], [0.5, 1]]],
  J: [[[0.8, 0], [0.8, 0.68], ...arc(0.42, 0.68, 0.38, 0.32, 0, 170)]],
  K: [[[0, 0], [0, 1]], [[0.95, 0], [0, 0.6]], [[0.33, 0.4], [1, 1]]],
  L: [[[0, 0], [0, 1], [0.9, 1]]],
  M: [[[0, 1], [0, 0], [0.5, 0.65], [1, 0], [1, 1]]],
  N: [[[0, 1], [0, 0], [1, 1], [1, 0]]],
  O: [arc(0.5, 0.5, 0.5, 0.5, 0, 360)],
  P: [[[0, 1], [0, 0], [0.5, 0], ...arc(0.5, 0.29, 0.42, 0.29, -90, 90), [0, 0.58]]],
  Q: [arc(0.5, 0.5, 0.5, 0.5, 0, 360), [[0.6, 0.68], [1, 1.04]]],
  R: [[[0, 1], [0, 0], [0.5, 0], ...arc(0.5, 0.28, 0.42, 0.28, -90, 90), [0, 0.56]], [[0.45, 0.56], [0.95, 1]]],
  S: [[...arc(0.5, 0.25, 0.42, 0.25, -25, -270), ...arc(0.5, 0.75, 0.46, 0.25, -90, 155)]],
  T: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]],
  U: [[[0, 0], [0, 0.64], ...arc(0.5, 0.64, 0.5, 0.36, 180, 0), [1, 0]]],
  V: [[[0, 0], [0.5, 1], [1, 0]]],
  W: [[[0, 0], [0.25, 1], [0.5, 0.3], [0.75, 1], [1, 0]]],
  X: [[[0, 0], [1, 1]], [[1, 0], [0, 1]]],
  Y: [[[0, 0], [0.5, 0.5], [1, 0]], [[0.5, 0.5], [0.5, 1]]],
  Z: [[[0, 0], [1, 0], [0, 1], [1, 1]]],
};

/** The marks Turkish needs (and the rest of Latin mostly): combining code point → strokes. */
const MARKS: Record<string, Point[][]> = {
  '̇': [[[0.5, -0.3], [0.5, -0.3]]], // dot above: İ, Ż
  '̈': [[[0.28, -0.3], [0.28, -0.3]], [[0.72, -0.3], [0.72, -0.3]]], // diaeresis: Ö, Ü
  '̆': [arc(0.5, -0.42, 0.28, 0.18, 170, 10)], // breve: Ğ
  '̧': [[[0.5, 1.02], [0.5, 1.14], [0.38, 1.3]]], // cedilla: Ç, Ş
};

/**
 * The name's first drawable letter with its marks: 'Ş' from "Şube", 'I' from "işler" (the same
 * upper-casing the card's blank state uses). A name with no Latin letter takes the slug's.
 */
export function iconLetter(name: string, slug: string): string {
  for (const source of [name, slug]) {
    for (const ch of source.normalize('NFC')) {
      const parts = Array.from(ch.toUpperCase().normalize('NFD'));
      if (parts[0] && GLYPHS[parts[0]]) return parts.filter((p) => GLYPHS[p] || MARKS[p]).join('').normalize('NFC');
    }
  }
  return 'A';
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255)) as [number, number, number];
}

/** WCAG contrast of a colour against the white letter. */
export function contrastWithWhite([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05);
}

/** The tile's colour: from the slug alone, and always dark enough for the white letter. */
export function iconColor(slug: string): [number, number, number] {
  const hue = createHash('sha256').update(slug).digest().readUInt16BE(0) % 360;
  let lightness = 0.46;
  while (contrastWithWhite(hslToRgb(hue, 0.62, lightness)) < 3.6) lightness -= 0.01;
  return hslToRgb(hue, 0.62, lightness);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Straight-line segments of the letter, in pixels, centred on the tile. */
function letterSegments(letter: string): Array<[Point, Point]> {
  const parts = Array.from(letter.normalize('NFD'));
  const strokes = parts.flatMap((p) => GLYPHS[p] ?? MARKS[p] ?? []);
  const narrow = parts[0] === 'I';
  const ys = strokes.flat().map((p) => p[1]);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const xs = strokes.flat().map((p) => p[0]);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const midY = (top + bottom) / 2;
  const toPixel = ([x, y]: Point): Point => [
    SIZE / 2 + (x - (narrow ? 0.5 : midX)) * LETTER_WIDTH,
    SIZE / 2 + (y - midY) * LETTER_HEIGHT,
  ];
  const segments: Array<[Point, Point]> = [];
  for (const line of strokes) {
    for (let i = 0; i < line.length - 1; i++) segments.push([toPixel(line[i]), toPixel(line[i + 1])]);
  }
  return segments;
}

function distanceToSegment(x: number, y: number, [a, b]: [Point, Point]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** The default icon as PNG bytes: the same input always gives the same bytes. */
export function renderDefaultIcon(slug: string, name: string): Buffer {
  const [r, g, b] = iconColor(slug);
  const segments = letterSegments(iconLetter(name, slug));
  const half = SIZE / 2 - TILE_MARGIN - TILE_RADIUS;
  const pad = STROKE / 2 + 2;
  const points = segments.flat();
  const minX = Math.floor(Math.min(...points.map((p) => p[0])) - pad);
  const maxX = Math.ceil(Math.max(...points.map((p) => p[0])) + pad);
  const minY = Math.floor(Math.min(...points.map((p) => p[1])) - pad);
  const maxY = Math.ceil(Math.max(...points.map((p) => p[1])) + pad);

  const row = 1 + SIZE * 4;
  const raw = Buffer.alloc(row * SIZE);
  for (let y = 0; y < SIZE; y++) {
    // A faint top-to-bottom fall, so the tile does not read as a flat placeholder.
    const shade = 1.12 - (0.24 * y) / SIZE;
    for (let x = 0; x < SIZE; x++) {
      const qx = Math.abs(x + 0.5 - SIZE / 2) - half;
      const qy = Math.abs(y + 0.5 - SIZE / 2) - half;
      const edge = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - TILE_RADIUS;
      const alpha = Math.max(0, Math.min(1, 0.5 - edge));
      if (alpha === 0) continue;
      let ink = 0;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        let nearest = Infinity;
        for (const s of segments) nearest = Math.min(nearest, distanceToSegment(x + 0.5, y + 0.5, s));
        ink = Math.max(0, Math.min(1, STROKE / 2 - nearest + 0.5));
      }
      const mix = (c: number) => Math.round(Math.min(255, c * shade) * (1 - ink) + 255 * ink);
      const at = y * row + 1 + x * 4;
      raw[at] = mix(r);
      raw[at + 1] = mix(g);
      raw[at + 2] = mix(b);
      raw[at + 3] = Math.round(alpha * 255);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Write the default icon into the app folder; the manifest names it `icon.png`. */
export function writeDefaultIcon(appRoot: string, slug: string, name: string): string {
  const path = join(appRoot, DEFAULT_ICON_FILE);
  writeFileSync(path, renderDefaultIcon(slug, name));
  return path;
}

/** The icon the dashboard can serve: raster only, never SVG (on that origin it would run script). */
export function servableIcon(icon: string | null | undefined): string | null {
  return icon && /\.(png|jpe?g)$/i.test(icon) ? icon : null;
}

function sameContent(a: string, b: string): boolean {
  try {
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

export interface IconIssue {
  code: 'dreamcontext_logo' | 'not_servable';
  problem: string;
  fix: string;
}

const OWN_ICON_FIX = 'Draw an icon.png for this app\'s subject (1024x1024, see /apps) and set "icon": "icon.png"';

/**
 * What is wrong with an app's icon, or null. A finding never stops the app: it opens as before
 * and the Dock gets the default letter when the icon is the logo. `logoPath` is the
 * dreamcontext logo (assets/notify-icon.icns).
 */
export function iconIssue(icon: string | null | undefined, logoPath: string | null): IconIssue | null {
  if (!icon) return null;
  if (logoPath && sameContent(icon, logoPath)) {
    return { code: 'dreamcontext_logo', problem: 'the icon is the dreamcontext logo, so the Dock cannot tell this app from dreamcontext', fix: OWN_ICON_FIX };
  }
  if (!servableIcon(icon)) {
    return { code: 'not_servable', problem: 'the Apps card cannot show this icon (it draws PNG and JPEG only) and falls back to the first letter', fix: OWN_ICON_FIX };
  }
  return null;
}

/** The same check on bytes already read (a repo blob before install). */
export function isDefaultIconBytes(data: Buffer | null | undefined, slug: string, name: string): boolean {
  if (!data || data.length < 100) return false;
  try { return data.equals(renderDefaultIcon(slug, name)); } catch { return false; }
}

/** Has nobody replaced the letter `apps new` drew? */
export function isDefaultIcon(icon: string | null | undefined, slug: string, name: string): boolean {
  if (!icon) return false;
  try {
    return readFileSync(icon).equals(renderDefaultIcon(slug, name));
  } catch {
    return false;
  }
}

const defaultIconSeen = new Map<string, boolean>();

/**
 * `isDefaultIcon`, remembered per file state: the Apps page polls every few seconds and drawing
 * the letter to compare costs a 1024 render. A changed file (size or time) is checked again.
 */
export function isDefaultIconCached(icon: string | null | undefined, slug: string, name: string): boolean {
  if (!icon) return false;
  let key: string;
  try { const st = statSync(icon); key = `${icon}\0${st.size}\0${st.mtimeMs}\0${slug}\0${name}`; } catch { return false; }
  const hit = defaultIconSeen.get(key);
  if (hit !== undefined) return hit;
  const v = isDefaultIcon(icon, slug, name);
  if (defaultIconSeen.size > 200) defaultIconSeen.clear();
  defaultIconSeen.set(key, v);
  return v;
}

/**
 * What `apps validate` says about an icon's shape (warnings only): smaller than 1024, not square,
 * or a picture that draws its own rounded tile (transparent corners) when dreamcontext now draws
 * the one mask everywhere.
 */
export function iconShapeWarnings(icon: string | null | undefined): string[] {
  if (!icon || !/\.png$/i.test(icon)) return [];
  let buf: Buffer;
  try { buf = readFileSync(icon); } catch { return []; }
  const size = pngSize(buf);
  if (!size) return [];
  const out: string[] = [];
  if (size.width !== size.height) out.push(`${size.width}x${size.height} is not square. Draw a 1024x1024 square`);
  else if (size.width < 1024) out.push(`${size.width}x${size.height} is smaller than 1024x1024. Draw it at 1024`);
  const img = decodePng(buf);
  if (img && cornersTransparent(img)) out.push('its corners are transparent: it draws its own tile. Fill the whole square to its edges; dreamcontext rounds the corners everywhere (card, store, Dock)');
  return out;
}
