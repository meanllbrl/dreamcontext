/**
 * A picture card's shape (task a-picture-question…, D10a): width / height read from the file's
 * header, so the stage lays a presented picture out by its shape on the first frame (no re-layout
 * once it loads). Read by the server whenever an agent opens, presents or asks with a picture;
 * never written by the owner's layout.
 *
 * PNG, GIF and WEBP: the first 64 KB through `sniffImageType` + `imageSize`. JPEG: a marker walk
 * with positional reads (at most 1 MB in), so a big ICC/XMP block before the frame header is
 * fine; the first APP1 that starts `Exif\0\0` gives the orientation, and 5-8 swap width and height
 * because the browser draws the picture rotated. An Exif block that is there but unreadable gives
 * no aspect (neutral), never a guess. Accepted limit: an orientation inside a PNG or WEBP is not
 * read. SVG, an unreadable header, a missing file, a symlink out of the project: no aspect.
 */
import { promises as fsp } from 'node:fs';
import { join, sep } from 'node:path';
import { imageSize, sniffImageType } from '../whiteboards/files.js';
import { ASPECT_MAX, ASPECT_MIN } from './types.js';

const HEAD_BYTES = 64 * 1024;
const JPEG_WALK_MAX = 1024 * 1024;

type FileHandle = Awaited<ReturnType<typeof fsp.open>>;

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/**
 * The orientation (1-8) an `Exif\0\0` APP1 payload says; 1 when it names none; null when the
 * block is there but cannot be read (a broken TIFF header, an offset out of the block).
 */
export function exifOrientation(seg: Buffer): number | null {
  // seg starts at "Exif\0\0"; the TIFF header follows.
  const t = seg.subarray(6);
  if (t.length < 8) return null;
  const order = t.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > t.length) return null;
  const count = u16(ifd);
  if (ifd + 2 + count * 12 > t.length) return null;
  for (let i = 0; i < count; i += 1) {
    const e = ifd + 2 + i * 12;
    if (u16(e) !== 0x0112) continue;
    // SHORT (3), one value, left-justified in the value field.
    if (u16(e + 2) !== 3) return null;
    const v = u16(e + 8);
    return v >= 1 && v <= 8 ? v : null;
  }
  return 1;
}

/** A JPEG's drawn size: its frame header, turned by its Exif orientation; null when unknown. */
async function jpegSize(fh: FileHandle): Promise<{ width: number; height: number } | null> {
  let pos = 2;
  let orientation = 1;
  let exifSeen = false;
  while (pos < JPEG_WALK_MAX) {
    const h = await readAt(fh, pos, 4);
    if (h.length < 2) return null;
    if (h[0] !== 0xff) return null;
    const marker = h[1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) { pos += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    // End of image or start of scan before any frame header: nothing to read.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (h.length < 4) return null;
    const len = h.readUInt16BE(2);
    if (len < 2) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      const f = await readAt(fh, pos + 4, 5);
      if (f.length < 5) return null;
      const height = f.readUInt16BE(1);
      const width = f.readUInt16BE(3);
      if (!width || !height) return null;
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xe1 && !exifSeen) {
      const seg = await readAt(fh, pos + 4, len - 2);
      if (seg.length >= 6 && seg.toString('latin1', 0, 6) === 'Exif\0\0') {
        exifSeen = true;
        const o = exifOrientation(seg);
        if (o === null) return null;
        orientation = o;
      }
    }
    pos += 2 + len;
  }
  return null;
}

/** width / height, 3 decimals, or undefined outside [ASPECT_MIN, ASPECT_MAX]. */
export function aspectOf(size: { width: number; height: number } | null): number | undefined {
  if (!size || !(size.width > 0) || !(size.height > 0)) return undefined;
  const a = Math.round((size.width / size.height) * 1000) / 1000;
  return Number.isFinite(a) && a >= ASPECT_MIN && a <= ASPECT_MAX ? a : undefined;
}

/**
 * The aspect of a project-relative picture, or undefined. The file must be a regular file whose
 * real path is inside the project's real path (a symlink cannot point the read elsewhere).
 */
export async function imageAspect(projectRoot: string, ref: string): Promise<number | undefined> {
  let fh: FileHandle | undefined;
  try {
    const base = await fsp.realpath(projectRoot);
    const real = await fsp.realpath(join(base, ref));
    if (!real.startsWith(base + sep)) return undefined;
    const st = await fsp.stat(real);
    if (!st.isFile()) return undefined;
    fh = await fsp.open(real, 'r');
    const head = await readAt(fh, 0, HEAD_BYTES);
    const mime = sniffImageType(head);
    if (!mime) return undefined;
    if (mime === 'image/jpeg') return aspectOf(await jpegSize(fh));
    return aspectOf(imageSize(head, mime));
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** The aspects of the image cards among these refs, read in parallel (ref → aspect | undefined). */
export async function imageAspects(projectRoot: string, refs: readonly string[]): Promise<Map<string, number | undefined>> {
  const uniq = [...new Set(refs)];
  const out = await Promise.all(uniq.map(async (r) => [r, await imageAspect(projectRoot, r)] as const));
  return new Map(out);
}

/** Writes (or clears) a card's aspect from a freshly read map; images only. */
export function setAspect(card: { kind: string; ref: string; aspect?: number }, aspects: ReadonlyMap<string, number | undefined>): void {
  if (card.kind !== 'image' || !aspects.has(card.ref)) return;
  const a = aspects.get(card.ref);
  if (a === undefined) delete card.aspect; else card.aspect = a;
}
