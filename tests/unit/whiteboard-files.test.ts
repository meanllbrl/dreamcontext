import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  boardFileRelPath, fileIdFor, imageBox, imageSize, isValidFileId, makeImageElement, readBoardFile, sniffImageType,
  WHITEBOARD_MAX_FILE_BYTES, writeBoardFile,
} from '../../src/lib/whiteboards/files.js';
import { createWhiteboard } from '../../src/lib/whiteboards/store.js';
import { validateElement } from '../../src/lib/whiteboards/validate.js';
import { WhiteboardNotFoundError, WhiteboardValidationError } from '../../src/lib/whiteboards/errors.js';
import { expandBoardRefs } from '../../src/lib/whiteboards/board-refs.js';
import { mutateWhiteboard } from '../../src/lib/whiteboards/store.js';
import { renderBoardContext } from '../../src/lib/whiteboards/board-context.js';
import { assertPicturesHeld } from '../../src/lib/whiteboards/ops.js';

// ─── picture headers, each naming its own pixel size ────────────────────────────────────────

const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...Buffer.from(s, 'ascii')];

const png = (w: number, h: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0]);
const gif = (w: number, h: number) => Buffer.from([...ascii('GIF89a'), ...u16le(w), ...u16le(h), 0, 0, 0]);
const riff = (chunk: string, body: number[]) => Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), ...body]);
const webpX = (w: number, h: number) => riff('VP8X', [10, 0, 0, 0, 0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);
const webpL = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff('VP8L', [0, 0, 0, 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
};
const webpLossy = (w: number, h: number) => riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h)]);
/** SOI, an APP0 segment, then a baseline start-of-frame: height before width. */
const jpeg = (w: number, h: number) => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, ...u16be(6), ...ascii('JFIF'),
  0xff, 0xc0, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

describe('pictures: type and size from the bytes', () => {
  it('knows the four raster types by their header, and nothing else', () => {
    expect(sniffImageType(png(1, 1))).toBe('image/png');
    expect(sniffImageType(gif(1, 1))).toBe('image/gif');
    expect(sniffImageType(webpX(1, 1))).toBe('image/webp');
    expect(sniffImageType(jpeg(1, 1))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('reads each type\'s pixel size from its header', () => {
    expect(imageSize(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(imageSize(gif(33, 21), 'image/gif')).toEqual({ width: 33, height: 21 });
    expect(imageSize(webpX(1920, 1080), 'image/webp')).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(webpL(300, 200), 'image/webp')).toEqual({ width: 300, height: 200 });
    expect(imageSize(webpLossy(800, 600), 'image/webp')).toEqual({ width: 800, height: 600 });
    expect(imageSize(jpeg(1024, 768), 'image/jpeg')).toEqual({ width: 1024, height: 768 });
  });

  it('says null for a header that does not name a size, never throws', () => {
    expect(imageSize(png(0, 10), 'image/png')).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull();
    expect(imageSize(riff('JUNK', []), 'image/webp')).toBeNull();
  });

  it('comes in at its own shape, longest side at most 640', () => {
    expect(imageBox({ width: 1920, height: 1080 })).toEqual({ width: 640, height: 360 });
    expect(imageBox({ width: 200, height: 100 })).toEqual({ width: 200, height: 100 });
    expect(imageBox({ width: 300, height: 3000 })).toEqual({ width: 64, height: 640 });
    expect(imageBox(null)).toEqual({ width: 640, height: 480 });
  });

  it('a file id is a content hash or an Excalidraw id, never a path', () => {
    expect(fileIdFor(png(1, 1))).toMatch(/^[0-9a-f]{40}$/);
    expect(fileIdFor(png(1, 1))).toBe(fileIdFor(png(1, 1)));
    expect(fileIdFor(png(1, 2))).not.toBe(fileIdFor(png(1, 1)));
    for (const ok of ['a'.repeat(40), 'V1StGXR8_Z5jdHi6B-myT']) expect(isValidFileId(ok)).toBe(true);
    for (const bad of ['short', '../../etc/passwd', 'a/b/c/d/e', 'x'.repeat(129), 'abc def ghi', 42, null]) expect(isValidFileId(bad)).toBe(false);
  });
});

describe('pictures: stored beside the board', () => {
  let root: string;
  let slug: string;
  const id = 'f'.repeat(40);
  beforeEach(() => {
    root = join(realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-files-'))), '_dream_context');
    mkdirSync(root, { recursive: true });
    slug = createWhiteboard(root, 'Pictures').slug;
  });
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  it('writes once under the id, by the type the bytes say, and reads back', () => {
    const w = writeBoardFile(root, slug, id, png(3, 2));
    expect(w.mimeType).toBe('image/png');
    expect(w.file).toBe(join(root, 'whiteboards', slug, 'files', `${id}.png`));
    const r = readBoardFile(root, slug, id);
    expect(r.bytes.equals(png(3, 2))).toBe(true);
    expect(r.mimeType).toBe('image/png');
    expect(boardFileRelPath(root, slug, id)).toBe(`whiteboards/${slug}/files/${id}.png`);
    // Idempotent: the id already names a picture, so new bytes under it change nothing.
    writeBoardFile(root, slug, id, gif(9, 9));
    expect(readBoardFile(root, slug, id).bytes.equals(png(3, 2))).toBe(true);
    expect(readdirSync(join(root, 'whiteboards', slug, 'files'))).toEqual([`${id}.png`]);
  });

  it('refuses a bad id, empty or oversized bytes, and anything that is not one of the four', () => {
    expect(() => writeBoardFile(root, slug, '../x', png(1, 1))).toThrow(WhiteboardValidationError);
    expect(() => writeBoardFile(root, slug, id, Buffer.alloc(0))).toThrow(/empty/);
    expect(() => writeBoardFile(root, slug, id, Buffer.concat([png(1, 1), Buffer.alloc(WHITEBOARD_MAX_FILE_BYTES)]))).toThrow(/max/);
    expect(() => writeBoardFile(root, slug, id, Buffer.from('<svg/>'))).toThrow(/PNG, JPEG, GIF or WebP/);
    expect(existsSync(join(root, 'whiteboards', slug, 'files'))).toBe(false);
  });

  it('never follows a symlink: not the files folder, not a stored file', () => {
    const outside = join(root, '..', 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, `${id}.png`), png(1, 1));
    symlinkSync(outside, join(root, 'whiteboards', slug, 'files'));
    expect(() => writeBoardFile(root, slug, id, png(1, 1))).toThrow(/symlink/);
    expect(() => readBoardFile(root, slug, id)).toThrow(WhiteboardValidationError);
    rmSync(join(root, 'whiteboards', slug, 'files'));
    mkdirSync(join(root, 'whiteboards', slug, 'files'));
    symlinkSync(join(outside, `${id}.png`), join(root, 'whiteboards', slug, 'files', `${id}.png`));
    expect(() => readBoardFile(root, slug, id)).toThrow(WhiteboardNotFoundError);
    expect(boardFileRelPath(root, slug, id)).toBeNull();
  });

  it('a missing picture or board is not found', () => {
    expect(() => readBoardFile(root, slug, id)).toThrow(WhiteboardNotFoundError);
    expect(() => readBoardFile(root, slug, 'bad id')).toThrow(WhiteboardNotFoundError);
    expect(boardFileRelPath(root, 'no-such-board', id)).toBeNull();
  });

  it('an image element is the shape Excalidraw writes, and validates', () => {
    const el = makeImageElement(id, { x: 1, y: 2, width: 3, height: 4 }, 'a0', 7);
    expect(el).toMatchObject({ type: 'image', fileId: id, x: 1, y: 2, width: 3, height: 4, status: 'saved', scale: [1, 1], updated: 7 });
    expect(validateElement(el)).toBe(el);
    expect(() => validateElement({ ...el, fileId: 'nope' })).toThrow(/fileId/);
    // A tombstone is never re-validated for its file.
    expect(() => validateElement({ ...el, fileId: undefined, isDeleted: true })).not.toThrow();
  });

  it('an agent is told the picture\'s file: in a dropped reference and in its home board', async () => {
    writeBoardFile(root, slug, id, png(3, 2));
    const el = makeImageElement(id, { x: 0, y: 0, width: 3, height: 2 }, 'a0');
    await mutateWhiteboard(root, slug, (b) => { b.elements.push(el); });
    const refs = expandBoardRefs(root, `look dcref:wb/${slug}/${el.id}`, 'n0nce');
    expect(refs.display).toBe('look [Picture]');
    expect(refs.block).toContain(`Read more: Read _dream_context/whiteboards/${slug}/files/${id}.png`);
    const ctx = renderBoardContext(root, slug, 'n0nce');
    expect(ctx).toContain(`"pictures":[{"id":"${el.id}","file":"_dream_context/whiteboards/${slug}/files/${id}.png"}]`);
  });
});

describe('pictures: a save never names a picture the board cannot show', () => {
  const fid = (c: string) => c.repeat(40);
  const img = (id: string, fileId: string, extra: Record<string, unknown> = {}) => ({ id, type: 'image', version: 1, fileId, ...extra });
  const onDisk = new Set([fid('d')]);
  const hasFile = (fileId: string) => onDisk.has(fileId);

  it('takes a picture whose file is stored, or one the board already names', () => {
    expect(() => assertPicturesHeld([img('a', fid('d'))], [], hasFile)).not.toThrow();
    // Another window's picture, its file lost: the board already names it, so this save keeps it.
    expect(() => assertPicturesHeld([img('a', fid('k'))], [img('a', fid('k'))], hasFile)).not.toThrow();
    // A tombstone still names its picture, so undoing the delete is not refused.
    expect(() => assertPicturesHeld([img('a', fid('k'))], [img('a', fid('k'), { isDeleted: true })], hasFile)).not.toThrow();
  });

  it('refuses a live picture neither stored nor on the board, and ignores a deleted one', () => {
    expect(() => assertPicturesHeld([img('a', fid('m'))], [img('b', fid('d'))], hasFile)).toThrow(WhiteboardValidationError);
    expect(() => assertPicturesHeld([img('a', fid('m'))], [], hasFile)).toThrow(/image a names a picture this board does not hold/);
    expect(() => assertPicturesHeld([img('a', fid('m'), { isDeleted: true })], [], hasFile)).not.toThrow();
    expect(() => assertPicturesHeld([{ id: 'r', type: 'rectangle', version: 1 }], [], hasFile)).not.toThrow();
  });
});
