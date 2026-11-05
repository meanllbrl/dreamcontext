import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Just enough PNG for app icons, with nothing but zlib (`apps new` and the Dock must work on any
 * install): read a non-interlaced PNG into RGBA, write RGBA back, and put a full-bleed icon into
 * the one rounded tile every surface draws (app-paylasim-magaza r2, "Tek maske, her yerde").
 */

export interface Rgba { width: number; height: number; data: Buffer }

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 4096;

/** Width and height from the IHDR, without decoding; null when it is not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG) || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** RGBA pixels of a PNG; null for what this reader does not handle (interlaced, broken, huge). */
export function decodePng(buf: Buffer): Rgba | null {
  try {
    const size = pngSize(buf);
    if (!size || !size.width || !size.height || size.width > MAX_SIDE || size.height > MAX_SIDE) return null;
    let depth = 0, color = 0, interlace = 0;
    let palette: Buffer | null = null;
    let trns: Buffer | null = null;
    const idat: Buffer[] = [];
    let i = 8;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const type = buf.subarray(i + 4, i + 8).toString('latin1');
      const body = buf.subarray(i + 8, i + 8 + len);
      if (type === 'IHDR') { depth = body[8]; color = body[9]; interlace = body[12]; }
      else if (type === 'PLTE') palette = body;
      else if (type === 'tRNS') trns = body;
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
      i += 12 + len;
    }
    if (interlace !== 0 || ![8, 16].includes(depth) && !(color === 3 && depth === 8)) return null;
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
    if (!channels || (color === 3 && !palette)) return null;
    const bpp = channels * (depth / 8);
    const { width, height } = size;
    const stride = width * bpp;
    const raw = inflateSync(Buffer.concat(idat));
    if (raw.length < (stride + 1) * height) return null;
    const cur = Buffer.alloc(stride);
    const prev = Buffer.alloc(stride);
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)];
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        const v = row[x];
        cur[x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff;
      }
      for (let x = 0; x < width; x++) {
        const s = (k: number) => cur[(x * channels + k) * (depth / 8)];
        const o = (y * width + x) * 4;
        if (color === 3) {
          const p = cur[x];
          out[o] = palette![p * 3]; out[o + 1] = palette![p * 3 + 1]; out[o + 2] = palette![p * 3 + 2];
          out[o + 3] = trns && p < trns.length ? trns[p] : 255;
        } else if (color === 0 || color === 4) {
          out[o] = out[o + 1] = out[o + 2] = s(0);
          out[o + 3] = color === 4 ? s(1) : 255;
        } else {
          out[o] = s(0); out[o + 1] = s(1); out[o + 2] = s(2);
          out[o + 3] = color === 6 ? s(3) : 255;
        }
      }
      cur.copy(prev);
    }
    return { width, height, data: out };
  } catch {
    return null;
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, body])));
  return Buffer.concat([len, tb, body, crc]);
}

export function encodePng(img: Rgba): Buffer {
  const row = img.width * 4 + 1;
  const raw = Buffer.alloc(row * img.height);
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * row + 1, y * img.width * 4, (y + 1) * img.width * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Does the picture draw its own tile (its four corners see through)? */
export function cornersTransparent(img: Rgba): boolean {
  const at = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
  const w = img.width - 1;
  const h = img.height - 1;
  return [at(0, 0), at(w, 0), at(0, h), at(w, h)].every((a) => a < 16);
}

// The macOS app-icon grid, the same one the default letter uses: an 824 px tile in a 1024 canvas,
// corners rounded at 185 px (22.4 % of the tile, the radius every dashboard surface draws).
const SIDE = 1024;
const TILE = 824;
const RADIUS = 185;

/**
 * A full-bleed square icon placed in the rounded tile, as a 1024 PNG. An icon that already draws
 * its own tile (transparent corners) is returned as null: it is used as it is.
 */
export function maskToTile(img: Rgba): Buffer | null {
  if (cornersTransparent(img)) return null;
  const out = Buffer.alloc(SIDE * SIDE * 4);
  const off = (SIDE - TILE) / 2;
  const half = TILE / 2 - RADIUS;
  const sx = img.width / TILE;
  const sy = img.height / TILE;
  const px = (x: number, y: number, k: number) => img.data[(Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4 + k];
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const qx = Math.abs(x + 0.5 - SIDE / 2) - half;
      const qy = Math.abs(y + 0.5 - SIDE / 2) - half;
      const edge = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RADIUS;
      const cover = Math.max(0, Math.min(1, 0.5 - edge));
      if (cover === 0) continue;
      // Bilinear from the source square.
      const fx = (x - off + 0.5) * sx - 0.5;
      const fy = (y - off + 0.5) * sy - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const o = (y * SIDE + x) * 4;
      for (let k = 0; k < 4; k++) {
        const v = px(x0, y0, k) * (1 - tx) * (1 - ty) + px(x0 + 1, y0, k) * tx * (1 - ty) + px(x0, y0 + 1, k) * (1 - tx) * ty + px(x0 + 1, y0 + 1, k) * tx * ty;
        out[o + k] = Math.round(k === 3 ? v * cover : v);
      }
    }
  }
  return encodePng({ width: SIDE, height: SIDE, data: out });
}
