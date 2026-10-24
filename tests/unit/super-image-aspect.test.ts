/**
 * A picture card's shape from its file header (task a-picture-question…, D10a): PNG, GIF, WEBP,
 * JPEG (with Exif orientation in both byte orders, and a frame header behind a big APP2 block);
 * SVG, truncated, symlinked-out and missing files have none; the record keeps only a sane value.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { imageAspect } from '../../src/lib/super/image-aspect.js';
import { sanitizeSuperState } from '../../src/lib/super/store.js';
import { SUPER_STATE_VERSION } from '../../src/lib/super/types.js';

const root = mkdtempSync(join(tmpdir(), 'dc-aspect-'));
const outside = mkdtempSync(join(tmpdir(), 'dc-aspect-out-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function webp(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'ascii');
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const seg = (marker: number, payload: Buffer) => {
  const h = Buffer.alloc(4);
  h[0] = 0xff; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
};
function exif(orientation: number, order: 'II' | 'MM'): Buffer {
  const le = order === 'II';
  const t = Buffer.alloc(8 + 2 + 12 + 4);
  t.write(order, 0, 'ascii');
  const u16 = (v: number, o: number) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
  const u32 = (v: number, o: number) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
  u16(42, 2); u32(8, 4); u16(1, 8);
  u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
}
function jpeg(w: number, h: number, before: Buffer[] = []): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...before, seg(0xc0, sof), Buffer.from([0xff, 0xd9])]);
}
const put = (name: string, bytes: Buffer | string) => { writeFileSync(join(root, name), bytes); return name; };

describe('imageAspect', () => {
  it('reads png, gif, webp and jpeg', async () => {
    expect(await imageAspect(root, put('a.png', png(1600, 960)))).toBe(1.667);
    expect(await imageAspect(root, put('a.gif', gif(300, 600)))).toBe(0.5);
    expect(await imageAspect(root, put('a.webp', webp(1000, 500)))).toBe(2);
    expect(await imageAspect(root, put('a.jpg', jpeg(1200, 900)))).toBe(1.333);
  });
  it('turns a JPEG with Exif orientation 5-8 (II and MM); 3 stays; no Exif = the frame', async () => {
    for (const order of ['II', 'MM'] as const) {
      const a = await imageAspect(root, put(`o6-${order}.jpg`, jpeg(4032, 3024, [seg(0xe1, exif(6, order))])));
      expect(a).toBe(0.75);
      expect(await imageAspect(root, put(`o8-${order}.jpg`, jpeg(4032, 3024, [seg(0xe1, exif(8, order))])))).toBe(0.75);
      expect(await imageAspect(root, put(`o3-${order}.jpg`, jpeg(4032, 3024, [seg(0xe1, exif(3, order))])))).toBe(1.333);
    }
    expect(await imageAspect(root, put('noexif.jpg', jpeg(4032, 3024)))).toBe(1.333);
  });
  it('skips an XMP APP1 and reads the Exif one; a broken Exif block gives none', async () => {
    const xmp = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>', 'latin1'));
    expect(await imageAspect(root, put('xmp.jpg', jpeg(4032, 3024, [xmp, seg(0xe1, exif(6, 'II'))])))).toBe(0.75);
    const broken = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('XX\0\0\0\0\0\0')]);
    expect(await imageAspect(root, put('broken.jpg', jpeg(4032, 3024, [seg(0xe1, broken)])))).toBeUndefined();
  });
  it('finds the frame header behind a 200 KB APP2 block (positional reads)', async () => {
    const big: Buffer[] = [];
    for (let i = 0; i < 4; i += 1) big.push(seg(0xe2, Buffer.alloc(50_000, 7)));
    expect(await imageAspect(root, put('icc.jpg', jpeg(800, 1600, big)))).toBe(0.5);
  });
  it('none for truncated, svg, missing, a symlink out of the project, outside paths', async () => {
    expect(await imageAspect(root, put('t.png', png(10, 10).subarray(0, 18)))).toBeUndefined();
    expect(await imageAspect(root, put('t.jpg', jpeg(800, 600).subarray(0, 6)))).toBeUndefined();
    expect(await imageAspect(root, put('a.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"/>'))).toBeUndefined();
    expect(await imageAspect(root, 'missing.png')).toBeUndefined();
    writeFileSync(join(outside, 'x.png'), png(100, 50));
    symlinkSync(join(outside, 'x.png'), join(root, 'link.png'));
    expect(await imageAspect(root, 'link.png')).toBeUndefined();
    mkdirSync(join(root, 'dir.png'));
    expect(await imageAspect(root, 'dir.png')).toBeUndefined();
    expect(await imageAspect(root, '../' + outside.split('/').pop() + '/x.png')).toBeUndefined();
  });
  it('out of range is none, never clamped', async () => {
    expect(await imageAspect(root, put('strip.png', png(30, 1000)))).toBeUndefined();
  });
  it('a file overwritten with another shape reads its new shape', async () => {
    put('m.png', png(1600, 960));
    expect(await imageAspect(root, 'm.png')).toBe(1.667);
    put('m.png', png(900, 1600));
    expect(await imageAspect(root, 'm.png')).toBe(0.563);
  });
});

describe('the record keeps a sane aspect on pictures only', () => {
  const card = (id: string, kind: string, aspect: unknown) => ({ id, kind, ref: kind === 'image' ? `${id}.png` : id, shape: 'square', place: 'float', aspect });
  it('drops 1:30, NaN, a string and a non-picture\'s; keeps and rounds a sane one', () => {
    const s = sanitizeSuperState({
      v: SUPER_STATE_VERSION,
      containers: [card('image-a', 'image', 1 / 30), card('image-b', 'image', Number.NaN), card('image-c', 'image', '1.5'),
        card('task-d', 'task', 1.5), card('image-e', 'image', 1.66666)],
    });
    const by = (id: string) => s.containers.find((c) => c.id === id);
    expect(by('image-a')?.aspect).toBeUndefined();
    expect(by('image-b')?.aspect).toBeUndefined();
    expect(by('image-c')?.aspect).toBeUndefined();
    expect(by('task-d')?.aspect).toBeUndefined();
    expect(by('image-e')?.aspect).toBe(1.667);
  });
});
