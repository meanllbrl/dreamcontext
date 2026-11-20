/**
 * Reads an mp4's display size and length from its own boxes (`moov/mvhd`, `moov/trak/tkhd`) so a
 * video sent to Telegram carries `width`, `height`, `duration` and `supports_streaming`; without
 * them the client guesses and shows the clip square or in the wrong ratio. No dependency; an
 * unreadable file yields only what is certain (`{}` when nothing is).
 */

export interface VideoParams { width?: number; height?: number; duration?: number; supports_streaming?: true }

interface Box { type: string; start: number; end: number; body: number }

function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > to) return;
      const big = buf.readBigUInt64BE(p + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(big);
      body = p + 16;
    } else if (size === 0) size = to - p;
    if (size < body - p || p + size > to) return;
    yield { type, start: p, end: p + size, body };
    p += size;
  }
}

function child(buf: Buffer, parent: Box, type: string): Box | null {
  for (const b of boxes(buf, parent.body, parent.end)) if (b.type === type) return b;
  return null;
}

/** Seconds from `mvhd`, or null. */
function readDuration(buf: Buffer, mvhd: Box): number | null {
  const v = buf[mvhd.body];
  const o = mvhd.body + 4;
  let scale: number, dur: number;
  if (v === 1) {
    if (o + 28 > mvhd.end) return null;
    scale = buf.readUInt32BE(o + 16);
    const raw = buf.readBigUInt64BE(o + 20);
    if (raw === 0xFFFF_FFFF_FFFF_FFFFn) return null; // all ones = unknown
    dur = Number(raw);
  } else {
    if (o + 16 > mvhd.end) return null;
    scale = buf.readUInt32BE(o + 8);
    dur = buf.readUInt32BE(o + 12);
    if (dur === 0xFFFF_FFFF) return null; // all ones = unknown
  }
  if (!scale || !Number.isFinite(dur)) return null;
  const s = Math.round(dur / scale);
  return s > 0 && s <= 86_400 ? s : null; // Telegram reads a 32-bit int; a day is far past any card video
}

/** Display size from `tkhd` (16.16 fixed width/height; a 90/270 degree matrix swaps them), or null for a non-visual track. */
function readSize(buf: Buffer, tkhd: Box): { w: number; h: number } | null {
  const v = buf[tkhd.body];
  // after version/flags: times + track id + reserved + duration, then 8 reserved, layer, alt group, volume, 2 reserved, matrix(36), w, h
  const head = tkhd.body + 4 + (v === 1 ? 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4);
  const m = head + 8 + 2 + 2 + 2 + 2;
  if (m + 36 + 8 > tkhd.end) return null;
  const a = buf.readInt32BE(m);
  const b = buf.readInt32BE(m + 4);
  let w = buf.readUInt32BE(m + 36) / 65536;
  let h = buf.readUInt32BE(m + 40) / 65536;
  if (!(w >= 1) || !(h >= 1)) return null;
  if (a === 0 && b !== 0) [w, h] = [h, w];
  return { w: Math.round(w), h: Math.round(h) };
}

export function mp4VideoParams(buf: Buffer): VideoParams {
  try {
    const top = { type: '', start: 0, end: buf.length, body: 0 };
    const moov = child(buf, top, 'moov');
    if (!moov) return {};
    const out: VideoParams = {};
    const mvhd = child(buf, moov, 'mvhd');
    const d = mvhd ? readDuration(buf, mvhd) : null;
    if (d) out.duration = d;
    for (const trak of boxes(buf, moov.body, moov.end)) {
      if (trak.type !== 'trak') continue;
      const tkhd = child(buf, trak, 'tkhd');
      const s = tkhd ? readSize(buf, tkhd) : null;
      if (s) { out.width = s.w; out.height = s.h; break; }
    }
    if (out.width && out.height) out.supports_streaming = true;
    return out;
  } catch {
    return {};
  }
}
