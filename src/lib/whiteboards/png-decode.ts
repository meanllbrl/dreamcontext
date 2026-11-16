import { inflateSync } from 'node:zlib';

/**
 * A PNG decoder, enough for the pictures on a board: every colour type (grey, RGB, palette,
 * grey+alpha, RGBA), bit depths 1-16, `tRNS` transparency and Adam7 interlacing, decoded to
 * 8-bit RGBA. No native module and no dependency: `whiteboard export` draws a board's own
 * pictures with it (other formats are converted to PNG first, see `board-pictures.ts`).
 *
 * It throws on anything it cannot read (a bad signature, a missing chunk, a truncated or
 * oversized image); the caller draws the placeholder and says which picture it was.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, row by row. */
  data: Uint8Array;
}

/** The most pixels one decoded picture may hold (40 MP is 160 MB of RGBA; a larger one is shrunk first or left out). */
export const PNG_MAX_PIXELS = 40_000_000;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Adam7 passes: x start, y start, x step, y step. */
const ADAM7: readonly [number, number, number, number][] = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo the scanline filters of one (sub-)image in place; returns the raw rows. */
function unfilter(src: Uint8Array, offset: number, rowBytes: number, rows: number, bpp: number): { rows: Uint8Array[]; end: number } {
  const out: Uint8Array[] = [];
  let prev = new Uint8Array(rowBytes);
  let at = offset;
  for (let y = 0; y < rows; y++) {
    if (at + 1 + rowBytes > src.length) throw new Error('truncated image data');
    const type = src[at];
    const line = src.slice(at + 1, at + 1 + rowBytes);
    at += 1 + rowBytes;
    switch (type) {
      case 0: break;
      case 1: for (let i = bpp; i < rowBytes; i++) line[i] = (line[i] + line[i - bpp]) & 0xff; break;
      case 2: for (let i = 0; i < rowBytes; i++) line[i] = (line[i] + prev[i]) & 0xff; break;
      case 3: for (let i = 0; i < rowBytes; i++) line[i] = (line[i] + (((i >= bpp ? line[i - bpp] : 0) + prev[i]) >> 1)) & 0xff; break;
      case 4: for (let i = 0; i < rowBytes; i++) line[i] = (line[i] + paeth(i >= bpp ? line[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 0xff; break;
      default: throw new Error(`unknown filter ${type}`);
    }
    out.push(line);
    prev = line;
  }
  return { rows: out, end: at };
}

export function decodePng(buf: Uint8Array): Bitmap {
  if (buf.length < 33 || SIGNATURE.some((b, i) => buf[i] !== b)) throw new Error('not a PNG');
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  let at = 8;
  while (at + 8 <= view.length) {
    const len = view.readUInt32BE(at);
    const type = view.toString('latin1', at + 4, at + 8);
    const body = view.subarray(at + 8, at + 8 + len);
    if (body.length !== len) throw new Error('truncated chunk');
    at += 12 + len;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = new Uint8Array(body);
    else if (type === 'tRNS') trns = new Uint8Array(body);
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('unsupported PNG header');
  if (width * height > PNG_MAX_PIXELS) throw new Error(`picture is ${width}x${height}, too large to draw`);
  if (colorType === 3 && !palette) throw new Error('palette image without PLTE');
  const bitsPerPixel = channels * depth;
  // Never unpack more than the header's image can hold (a small file can claim gigabytes).
  let expected = 0;
  if (interlace === 0) expected = height * (1 + Math.ceil((width * bitsPerPixel) / 8));
  else for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw > 0 && ph > 0) expected += ph * (1 + Math.ceil((pw * bitsPerPixel) / 8));
  }
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: Math.max(1, expected) });
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const out = new Uint8Array(width * height * 4);
  const maxv = (1 << Math.min(depth, 8)) - 1;

  // A sample at `index` (in samples) of a raw row, scaled to 0..255.
  const sample = (row: Uint8Array, index: number): number => {
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2];
    const bit = index * depth;
    const v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxv;
    return colorType === 3 ? v : Math.round((v * 255) / maxv);
  };
  // The raw (unscaled) 16-bit or n-bit value, for comparing with tRNS.
  const rawSample = (row: Uint8Array, index: number): number => {
    if (depth === 16) return (row[index * 2] << 8) | row[index * 2 + 1];
    if (depth === 8) return row[index];
    const bit = index * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxv;
  };
  const trnsAt = (i: number) => (trns && trns.length >= i * 2 + 2 ? (trns[i * 2] << 8) | trns[i * 2 + 1] : -1);

  const put = (row: Uint8Array, sx: number, x: number, y: number) => {
    const o = (y * width + x) * 4;
    const s = sx * channels;
    switch (colorType) {
      case 0: {
        const g = sample(row, s);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = trns && rawSample(row, s) === trnsAt(0) ? 0 : 255;
        break;
      }
      case 2:
        out[o] = sample(row, s);
        out[o + 1] = sample(row, s + 1);
        out[o + 2] = sample(row, s + 2);
        out[o + 3] = trns && rawSample(row, s) === trnsAt(0) && rawSample(row, s + 1) === trnsAt(1) && rawSample(row, s + 2) === trnsAt(2) ? 0 : 255;
        break;
      case 3: {
        const i = sample(row, s);
        out[o] = palette![i * 3] ?? 0;
        out[o + 1] = palette![i * 3 + 1] ?? 0;
        out[o + 2] = palette![i * 3 + 2] ?? 0;
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
        break;
      }
      case 4: {
        const g = sample(row, s);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = sample(row, s + 1);
        break;
      }
      default:
        out[o] = sample(row, s);
        out[o + 1] = sample(row, s + 1);
        out[o + 2] = sample(row, s + 2);
        out[o + 3] = sample(row, s + 3);
    }
  };

  if (interlace === 0) {
    const { rows } = unfilter(raw, 0, Math.ceil((width * bitsPerPixel) / 8), height, bpp);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(rows[y], x, x, y);
  } else {
    let offset = 0;
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = Math.ceil((width - x0) / dx);
      const ph = Math.ceil((height - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const { rows, end } = unfilter(raw, offset, Math.ceil((pw * bitsPerPixel) / 8), ph, bpp);
      offset = end;
      for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) put(rows[j], i, x0 + i * dx, y0 + j * dy);
    }
  }
  return { width, height, data: out };
}

/**
 * A smaller copy, each output pixel the average of the source block under it (alpha-weighted),
 * so a large photo drawn small stays smooth instead of aliased. Never enlarges.
 */
export function downscale(src: Bitmap, maxW: number, maxH: number): Bitmap {
  const k = Math.min(1, maxW / src.width, maxH / src.height);
  if (k >= 0.999) return src;
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const out = new Uint8Array(w * h * 4);
  const fx = src.width / w;
  const fy = src.height / h;
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * fy);
    const sy1 = Math.max(sy0 + 1, Math.min(src.height, Math.floor((y + 1) * fy)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * fx);
      const sx1 = Math.max(sx0 + 1, Math.min(src.width, Math.floor((x + 1) * fx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * src.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, i += 4) {
          const al = src.data[i + 3];
          r += src.data[i] * al;
          g += src.data[i + 1] * al;
          b += src.data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}
