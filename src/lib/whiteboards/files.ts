import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { WhiteboardNotFoundError, WhiteboardValidationError } from './errors.js';
import { resolveWhiteboardPath } from './store.js';
import { isValidFileId } from './validate.js';
import { newElementId, randomInteger, type WhiteboardElement } from './widgets.js';

/**
 * A board's pictures (owner, 2026-10-06: "free Excalidraw images, files stored in the board's
 * folder"). The scene holds only an `image` element naming a `fileId`; the bytes live beside the
 * board at `whiteboards/<slug>/files/<fileId>.<ext>`, so they travel with the board through
 * brain sync and never bloat the board file. Written once per id (a picture never changes under
 * its id), read back by the dashboard and by the agent a board element is dropped on.
 *
 * Only raster pictures a browser draws safely: PNG, JPEG, GIF, WebP, recognised by their bytes,
 * never by a name or a declared type. SVG is refused: served from the dashboard's origin it is a
 * document that can run script.
 *
 * Paths are never followed through a symlink: the board folder comes from the store's own
 * resolver, `files/` and each file are `lstat`ed, and the realpath must stay inside the board.
 */

export { FILE_ID_RE, isValidFileId } from './validate.js';

export const FILES_DIR = 'files';

/** The largest picture a board takes. */
export const WHITEBOARD_MAX_FILE_BYTES = 10 * 1024 * 1024;


export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const;

export type ImageMime = keyof typeof IMAGE_TYPES;

const MIME_OF_EXT: Record<string, ImageMime> = Object.fromEntries(
  Object.entries(IMAGE_TYPES).map(([mime, ext]) => [ext, mime as ImageMime]),
);

/** What the bytes are, read from their header; null for anything but the four pictures. */
export function sniffImageType(bytes: Uint8Array): ImageMime | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** A picture's pixel size from its header, or null when the header does not say. */
export function imageSize(bytes: Uint8Array, mime: ImageMime): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : null);
  try {
    switch (mime) {
      case 'image/png':
        // IHDR is the first chunk: width and height at bytes 16 and 20.
        return b.length >= 24 ? ok(b.readUInt32BE(16), b.readUInt32BE(20)) : null;
      case 'image/gif':
        return b.length >= 10 ? ok(b.readUInt16LE(6), b.readUInt16LE(8)) : null;
      case 'image/webp': {
        const chunk = b.toString('ascii', 12, 16);
        if (chunk === 'VP8 ' && b.length >= 30) return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
        if (chunk === 'VP8L' && b.length >= 25) {
          const bits = b.readUInt32LE(21);
          return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
        }
        if (chunk === 'VP8X' && b.length >= 30) return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
        return null;
      }
      case 'image/jpeg': {
        // Walk the markers to the first start-of-frame.
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) { i += 1; continue; }
          const marker = b[i + 1]!;
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
          const len = b.readUInt16BE(i + 2);
          const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (sof) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
          i += 2 + len;
        }
        return null;
      }
    }
  } catch {
    return null;
  }
}

/** The id the CLI gives a picture: its content hash, so the same picture added twice is one file. */
export function fileIdFor(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** The board's `files/` folder (not created), refusing a symlinked one. */
function filesDirOf(root: string, slug: string): { boardDir: string; dir: string } {
  const { dir: boardDir } = resolveWhiteboardPath(root, slug);
  const dir = join(boardDir, FILES_DIR);
  if (isSymlink(dir)) throw new WhiteboardValidationError(`whiteboards/${slug}/${FILES_DIR} is a symlink; refusing to use it`);
  return { boardDir, dir };
}

/**
 * Store a picture under `id` in the board's folder. The type comes from the bytes; anything but
 * the four pictures, an empty or oversized file, or a bad id is refused. Idempotent: a picture
 * already stored under the id is kept as it is (an id never changes what it names).
 */
export function writeBoardFile(root: string, slug: string, id: string, bytes: Uint8Array): { id: string; mimeType: ImageMime; file: string } {
  if (!isValidFileId(id)) throw new WhiteboardValidationError(`invalid file id '${String(id).slice(0, 80)}'`);
  if (bytes.byteLength === 0) throw new WhiteboardValidationError('the picture is empty');
  if (bytes.byteLength > WHITEBOARD_MAX_FILE_BYTES) {
    throw new WhiteboardValidationError(`the picture is ${bytes.byteLength} bytes (max ${WHITEBOARD_MAX_FILE_BYTES})`);
  }
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new WhiteboardValidationError('a board takes PNG, JPEG, GIF or WebP pictures only');
  const { dir } = filesDirOf(root, slug);
  const existing = findBoardFile(dir, id);
  if (existing) return { id, mimeType: existing.mimeType, file: existing.file };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.${IMAGE_TYPES[mimeType]}`);
  const tmp = join(dir, `.${id}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  return { id, mimeType, file };
}

/** The stored file for `id` in `dir`, by its extension; never a symlink. */
function findBoardFile(dir: string, id: string): { file: string; mimeType: ImageMime } | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || name.slice(0, dot) !== id) continue;
    const mimeType = MIME_OF_EXT[name.slice(dot + 1)];
    const file = join(dir, name);
    if (!mimeType || isSymlink(file)) continue;
    return { file, mimeType };
  }
  return null;
}

/** Read a board's picture. Throws not-found for a bad id, a missing file or one outside the board. */
export function readBoardFile(root: string, slug: string, id: string): { bytes: Buffer; mimeType: ImageMime; file: string } {
  if (!isValidFileId(id)) throw new WhiteboardNotFoundError(`no picture '${String(id).slice(0, 80)}'`);
  const { boardDir, dir } = filesDirOf(root, slug);
  const found = findBoardFile(dir, id);
  if (!found) throw new WhiteboardNotFoundError(`no picture '${id}' on board '${slug}'`);
  const real = realpathSync(found.file);
  if (!real.startsWith(realpathSync(boardDir) + sep)) throw new WhiteboardNotFoundError(`no picture '${id}' on board '${slug}'`);
  return { bytes: readFileSync(found.file), mimeType: found.mimeType, file: found.file };
}

/** The project-relative path of a board's stored picture (for an agent to read), or null. */
export function boardFileRelPath(root: string, slug: string, id: string): string | null {
  try {
    const { dir } = filesDirOf(root, slug);
    const found = isValidFileId(id) ? findBoardFile(dir, id) : null;
    return found ? `whiteboards/${slug}/${FILES_DIR}/${found.file.slice(dir.length + 1)}` : null;
  } catch {
    return null;
  }
}

/** Longest side a picture comes in at on the board (it keeps its shape; resizable after). */
export const IMAGE_MAX_SIDE = 640;

/** The box a picture of `size` comes in at: its own size, scaled down to fit {@link IMAGE_MAX_SIDE}. */
export function imageBox(size: { width: number; height: number } | null): { width: number; height: number } {
  if (!size) return { width: IMAGE_MAX_SIDE, height: Math.round(IMAGE_MAX_SIDE * 0.75) };
  const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}

/** An Excalidraw `image` element for a stored picture, the shape Excalidraw itself writes. */
export function makeImageElement(
  fileId: string,
  box: { x: number; y: number; width: number; height: number },
  index: string,
  now: number = Date.now(),
): WhiteboardElement {
  return {
    id: newElementId(),
    type: 'image',
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    seed: randomInteger(),
    version: 1,
    versionNonce: randomInteger(),
    index,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    fileId,
    status: 'saved',
    scale: [1, 1],
    crop: null,
  };
}
