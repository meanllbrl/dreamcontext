import { deflateSync } from 'node:zlib';

/**
 * A small software rasterizer: an RGB canvas that fills polygons with anti-aliased edges and
 * encodes itself as a PNG. Everything `whiteboard render` draws (boxes, ellipses, strokes,
 * arrowheads, pixel-font glyphs) is a list of polygons, so this one fill is the whole engine:
 * no browser, no native module, no font file.
 *
 * Coverage is exact horizontally and sampled on {@link SUBROWS} sub-scanlines vertically;
 * polygons in one call are unioned by the non-zero winding rule (each is normalised to the
 * same orientation first), so overlapping stroke segments do not double-darken.
 */

export type Pt = readonly [number, number];
export type RGB = readonly [number, number, number];

const SUBROWS = 4;

function signedArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

interface Edge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dir: number;
}

export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, background: RGB = [255, 255, 255]) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.data = new Uint8Array(this.width * this.height * 3);
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = background[0];
      this.data[i + 1] = background[1];
      this.data[i + 2] = background[2];
    }
  }

  /** Fill the union of `polys` (pixel coordinates) with `color` at `alpha` (0..1). */
  fill(polys: readonly (readonly Pt[])[], color: RGB, alpha = 1): void {
    if (alpha <= 0) return;
    const edges: Edge[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const raw of polys) {
      if (raw.length < 3) continue;
      const poly = signedArea(raw) < 0 ? [...raw].reverse() : raw;
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
        minX = Math.min(minX, x1, x2);
        maxX = Math.max(maxX, x1, x2);
        minY = Math.min(minY, y1, y2);
        maxY = Math.max(maxY, y1, y2);
        if (y1 === y2) continue;
        edges.push(y1 < y2 ? { x1, y1, x2, y2, dir: 1 } : { x1: x2, y1: y2, x2: x1, y2: y1, dir: -1 });
      }
    }
    if (edges.length === 0) return;
    const bx0 = Math.max(0, Math.floor(minX));
    const bx1 = Math.min(this.width, Math.ceil(maxX));
    const by0 = Math.max(0, Math.floor(minY));
    const by1 = Math.min(this.height, Math.ceil(maxY));
    if (bx0 >= bx1 || by0 >= by1) return;
    edges.sort((a, b) => a.y1 - b.y1);
    const span = bx1 - bx0;
    const cov = new Float32Array(span + 1);
    const hits: { x: number; dir: number }[] = [];
    let first = 0;
    const [r, g, b] = color;

    for (let py = by0; py < by1; py++) {
      cov.fill(0);
      let any = false;
      while (first < edges.length && edges[first].y2 <= py) first++;
      for (let s = 0; s < SUBROWS; s++) {
        const sy = py + (s + 0.5) / SUBROWS;
        hits.length = 0;
        for (let i = first; i < edges.length; i++) {
          const e = edges[i];
          if (e.y1 > sy) break;
          if (sy >= e.y2) continue;
          hits.push({ x: e.x1 + ((sy - e.y1) * (e.x2 - e.x1)) / (e.y2 - e.y1), dir: e.dir });
        }
        if (hits.length < 2) continue;
        hits.sort((p, q) => p.x - q.x);
        let winding = 0;
        for (let i = 0; i < hits.length - 1; i++) {
          winding += hits[i].dir;
          if (winding === 0) continue;
          const xa = Math.max(bx0, hits[i].x);
          const xb = Math.min(bx1, hits[i + 1].x);
          if (xb <= xa) continue;
          any = true;
          const pa = Math.floor(xa);
          const pb = Math.floor(xb);
          const w = 1 / SUBROWS;
          if (pa === pb) {
            cov[pa - bx0] += (xb - xa) * w;
          } else {
            cov[pa - bx0] += (pa + 1 - xa) * w;
            for (let p = pa + 1; p < pb; p++) cov[p - bx0] += w;
            if (pb < bx1) cov[pb - bx0] += (xb - pb) * w;
          }
        }
      }
      if (!any) continue;
      const row = py * this.width;
      for (let p = 0; p < span; p++) {
        const c = cov[p];
        if (c <= 0) continue;
        const a = Math.min(1, c) * alpha;
        const i = (row + bx0 + p) * 3;
        this.data[i] = Math.round(this.data[i] * (1 - a) + r * a);
        this.data[i + 1] = Math.round(this.data[i + 1] * (1 - a) + g * a);
        this.data[i + 2] = Math.round(this.data[i + 2] * (1 - a) + b * a);
      }
    }
  }

  /** The canvas as a PNG file (8-bit RGB, no interlace). */
  toPng(): Buffer {
    const stride = this.width * 3;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (stride + 1)] = 0;
      raw.set(this.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

// ─── shapes as polygons ───────────────────────────────────────────────────

/** A closed ellipse outline through `n` points (n scales with the size when left out). */
export function ellipsePoly(cx: number, cy: number, rx: number, ry: number, n?: number): Pt[] {
  const steps = n ?? Math.max(16, Math.min(128, Math.round((Math.abs(rx) + Math.abs(ry)) / 2)));
  const out: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

/** A rectangle with rounded corners of radius `r` (0 = square). */
export function roundRectPoly(x: number, y: number, w: number, h: number, r: number): Pt[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const out: Pt[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 6; i++) {
      const t = from + (i / 6) * (Math.PI / 2);
      out.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
    }
  };
  corner(x + w - rr, y + rr, -Math.PI / 2);
  corner(x + w - rr, y + h - rr, 0);
  corner(x + rr, y + h - rr, Math.PI / 2);
  corner(x + rr, y + rr, Math.PI);
  return out;
}

/**
 * A stroke along `pts` as polygons: one quad per segment plus a round join at every vertex
 * and a round cap at each open end. `dash` (on, off lengths) breaks it into dashes.
 */
export function strokePolys(pts: readonly Pt[], width: number, opts: { closed?: boolean; dash?: readonly [number, number] } = {}): Pt[][] {
  const path = opts.closed && pts.length > 2 ? [...pts, pts[0]] : [...pts];
  const runs = opts.dash ? dashRuns(path, opts.dash) : [path];
  const half = width / 2;
  const out: Pt[][] = [];
  const dot = (p: Pt) => ellipsePoly(p[0], p[1], half, half, half < 2 ? 8 : 12);
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      const [x1, y1] = run[i];
      const [x2, y2] = run[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len === 0) continue;
      const nx = (-(y2 - y1) / len) * half;
      const ny = ((x2 - x1) / len) * half;
      out.push([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]);
    }
    if (half >= 0.75) for (const p of run) out.push(dot(p));
  }
  return out;
}

function dashRuns(path: readonly Pt[], [on, off]: readonly [number, number]): Pt[][] {
  const runs: Pt[][] = [];
  let drawing = true;
  let left = on;
  let cur: Pt[] = [path[0]];
  for (let i = 0; i < path.length - 1; i++) {
    let [x, y] = path[i];
    const [x2, y2] = path[i + 1];
    let seg = Math.hypot(x2 - x, y2 - y);
    while (seg > 0) {
      const step = Math.min(seg, left);
      const t = step / seg;
      x += (x2 - x) * t;
      y += (y2 - y) * t;
      seg -= step;
      left -= step;
      if (drawing) cur.push([x, y]);
      if (left <= 1e-9) {
        if (drawing && cur.length > 1) runs.push(cur);
        drawing = !drawing;
        left = drawing ? on : off;
        cur = [[x, y]];
      }
    }
  }
  if (drawing && cur.length > 1) runs.push(cur);
  return runs;
}
