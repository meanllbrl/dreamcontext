/**
 * `whiteboard render` draws in-process (render.ts, raster.ts, pixel-font.ts): a real PNG, the
 * right pixels where shapes are, the region and scale honoured, text composed for Turkish.
 * No browser is involved anywhere, which is the point of the command.
 */
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { renderScene, contentRegion, fitScale } from '../../src/lib/whiteboards/render.js';
import { glyphCell, lineRuns } from '../../src/lib/whiteboards/pixel-font.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

/** Decode the PNGs this module writes (8-bit RGB, filter 0) back to pixels. */
function decode(png: Buffer): { w: number; h: number; px: (x: number, y: number) => [number, number, number] } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let off = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const body = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      expect([body[8], body[9]]).toEqual([8, 2]);
    }
    if (type === 'IDAT') idat.push(body);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return {
    w,
    h,
    px: (x, y) => {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      return [raw[i], raw[i + 1], raw[i + 2]];
    },
  };
}

const el = (o: Partial<WhiteboardElement>): WhiteboardElement => ({ version: 1, isDeleted: false, opacity: 100, ...o }) as WhiteboardElement;

describe('renderScene', () => {
  const board = [
    el({ id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, strokeColor: '#1e1e1e', backgroundColor: '#ff0000', fillStyle: 'solid', strokeWidth: 2, index: 'a0' }),
    el({ id: 'b', type: 'ellipse', x: 200, y: 0, width: 100, height: 100, strokeColor: '#1e1e1e', backgroundColor: '#0000ff', fillStyle: 'solid', strokeWidth: 2, index: 'a1' }),
    el({ id: 'c', type: 'rectangle', x: 50, y: 50, width: 100, height: 100, strokeColor: '#1e1e1e', backgroundColor: '#00ff00', fillStyle: 'solid', strokeWidth: 2, index: 'a2' }),
    el({ id: 'gone', type: 'rectangle', x: 0, y: 200, width: 100, height: 100, backgroundColor: '#000000', fillStyle: 'solid', isDeleted: true, index: 'a3' }),
  ];

  it('writes a PNG of the region at the scale, fills where shapes are, in z-order, without tombstones', () => {
    const r = renderScene(board, { region: { x: 0, y: 0, w: 300, h: 300 }, scale: 1 });
    const img = decode(r.png);
    expect([img.w, img.h, r.width, r.height]).toEqual([300, 300, 300, 300]);
    expect(r.drawn).toBe(3);
    expect(img.px(25, 25)).toEqual([255, 0, 0]);
    expect(img.px(250, 50)).toEqual([0, 0, 255]);
    expect(img.px(75, 75)).toEqual([0, 255, 0]); // c is above a
    expect(img.px(50, 250)).toEqual([255, 255, 255]); // the tombstone is not drawn
  });

  it('honours region offset and scale', () => {
    const r = renderScene(board, { region: { x: 200, y: 0, w: 100, h: 100 }, scale: 0.5 });
    const img = decode(r.png);
    expect([img.w, img.h]).toEqual([50, 50]);
    expect(img.px(25, 25)).toEqual([0, 0, 255]);
  });

  it('draws widgets as cards and outlines a group in red', () => {
    const card = el({
      id: 'w', type: 'embeddable', x: 0, y: 0, width: 376, height: 180, link: 'dreamcontext://task/ship-it', index: 'b0',
      customData: { dc: { v: 1, kind: 'task', ref: 'ship-it', title: 'Ship it', color: 'blue' } },
    });
    const r = renderScene([card], { region: { x: -40, y: -40, w: 456, h: 260 }, scale: 1, outline: { box: { x: 0, y: 0, w: 376, h: 180 }, label: '#t' } });
    const img = decode(r.png);
    expect(img.px(40 + 300, 40 + 150)).toEqual([231, 245, 255]); // the blue tint surface
    const outline = img.px(40 - 8, 40 + 90);
    expect(outline[0]).toBeGreaterThan(200);
    expect(outline[1]).toBeLessThan(120);
  });

  it('contentRegion pads the content; fitScale keeps the longest side within 2000px', () => {
    expect(contentRegion(board)).toEqual({ x: -40, y: -40, w: 380, h: 230 });
    expect(contentRegion([])).toEqual({ x: 0, y: 0, w: 400, h: 200 });
    expect(fitScale({ x: 0, y: 0, w: 1000, h: 800 })).toBe(1);
    expect(fitScale({ x: 0, y: 0, w: 1000, h: 8000 })).toBe(0.25);
  });
});

describe('pixel font', () => {
  it('composes Turkish letters from a base glyph and its mark', () => {
    const o = glyphCell('o');
    const oUml = glyphCell('ö');
    expect(oUml.slice(4)).toEqual(o.slice(4));
    expect(oUml[2]).not.toBe(0);
    expect(glyphCell('İ')[0]).not.toBe(0); // the dot sits above the capital
    expect(glyphCell('ş')[9]).not.toBe(0); // the cedilla sits below
    expect(glyphCell('ı')).not.toEqual(glyphCell('i'));
    expect(glyphCell('ğ')).not.toEqual(glyphCell('g'));
  });

  it('lays a line out at six pixels a character, with ink', () => {
    const { runs, width } = lineRuns('Çağrı');
    expect(width).toBe(5 * 6 - 1);
    expect(runs.length).toBeGreaterThan(20);
  });
});
