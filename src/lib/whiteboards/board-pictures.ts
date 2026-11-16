import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_TYPES, imageSize, readBoardFile, type ImageMime } from './files.js';
import { decodePng, downscale, PNG_MAX_PIXELS, type Bitmap } from './png-decode.js';
import type { WhiteboardElement } from './widgets.js';

/**
 * A board's own pictures, decoded for `whiteboard export`. Each is read through
 * {@link readBoardFile} (the board's `files/` folder only: a symlinked folder or file is refused,
 * the realpath must stay inside the board), so an export can never draw a file from elsewhere.
 *
 * PNG is decoded here. JPEG, GIF and WebP (and a PNG too large to decode whole) go through
 * macOS's own `sips` first, run on a private temp copy of the bytes, never on the board file.
 * Where no converter exists (Windows, Linux) such a picture stays a placeholder, and the export
 * says which ones: never a silent empty box.
 */

export interface PictureMiss {
  fileId: string;
  why: string;
}

export interface BoardPictures {
  get(fileId: string): Bitmap | null;
  loaded: number;
  missing: PictureMiss[];
}

/** Turns picture bytes into PNG bytes, at most `maxSide` on the long side; null: cannot. */
export type PictureConverter = (bytes: Buffer, mime: ImageMime, maxSide: number) => Buffer | null;

const SIPS = '/usr/bin/sips';

/** macOS `sips`, on a temp copy; null off macOS or on any failure. */
export const sipsConverter: PictureConverter = (bytes, mime, maxSide) => {
  if (process.platform !== 'darwin' || !existsSync(SIPS)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'dc-wb-pic-'));
  try {
    const input = join(dir, `in.${IMAGE_TYPES[mime]}`);
    const output = join(dir, 'out.png');
    writeFileSync(input, bytes);
    const size = imageSize(bytes, mime);
    const shrink = !size || Math.max(size.width, size.height) > maxSide ? ['-Z', String(Math.max(16, Math.round(maxSide)))] : [];
    execFileSync(SIPS, ['-s', 'format', 'png', ...shrink, input, '--out', output], { stdio: 'ignore', timeout: 30_000 });
    return readFileSync(output);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** How many source pixels the longest side of each picture needs at `scale`. */
export function neededSides(elements: readonly WhiteboardElement[], scale: number): Map<string, number> {
  const need = new Map<string, number>();
  for (const el of elements) {
    if (el.type !== 'image' || typeof el.fileId !== 'string') continue;
    const w = Math.abs(Number(el.width) || 0) * scale;
    const h = Math.abs(Number(el.height) || 0) * scale;
    const crop = el.crop as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | null | undefined;
    const kx = crop && crop.width && crop.naturalWidth ? crop.naturalWidth / crop.width : 1;
    const ky = crop && crop.height && crop.naturalHeight ? crop.naturalHeight / crop.height : 1;
    const side = Math.ceil(Math.max(w * kx, h * ky, 1));
    need.set(el.fileId, Math.max(need.get(el.fileId) ?? 0, side));
  }
  return need;
}

/**
 * Decode every picture the elements name, each shrunk to what `scale` needs (a little over, so
 * resampling stays sharp). A picture that cannot be read or decoded is listed in `missing`.
 */
export function loadBoardPictures(
  root: string,
  slug: string,
  elements: readonly WhiteboardElement[],
  scale: number,
  convert: PictureConverter = sipsConverter,
): BoardPictures {
  const bitmaps = new Map<string, Bitmap>();
  const missing: PictureMiss[] = [];
  for (const [fileId, side] of neededSides(elements, scale)) {
    const maxSide = Math.ceil(side * 1.25);
    let file: { bytes: Buffer; mimeType: ImageMime };
    try {
      file = readBoardFile(root, slug, fileId);
    } catch {
      missing.push({ fileId, why: 'the picture file is not in the board folder' });
      continue;
    }
    try {
      const size = imageSize(file.bytes, file.mimeType);
      const tooBig = !!size && size.width * size.height > PNG_MAX_PIXELS;
      let png: Buffer | null = file.mimeType === 'image/png' && !tooBig ? file.bytes : convert(file.bytes, file.mimeType, maxSide);
      if (!png) {
        missing.push({ fileId, why: `${file.mimeType.slice(6).toUpperCase()} needs a converter this machine does not have (macOS sips)` });
        continue;
      }
      let bmp: Bitmap;
      try {
        bmp = decodePng(png);
      } catch (err) {
        // A PNG this decoder does not read: let the converter re-encode it once.
        if (file.mimeType !== 'image/png' || png !== file.bytes) throw err;
        png = convert(file.bytes, file.mimeType, maxSide);
        if (!png) throw err;
        bmp = decodePng(png);
      }
      bitmaps.set(fileId, downscale(bmp, maxSide, maxSide));
    } catch (err) {
      missing.push({ fileId, why: `could not decode it (${err instanceof Error ? err.message : 'unknown error'})` });
    }
  }
  return { get: (id) => bitmaps.get(id) ?? null, loaded: bitmaps.size, missing };
}
