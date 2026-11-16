/**
 * `whiteboard export` (owner, 2026-11-17: a board reached his phone as empty crossed boxes and
 * unreadable 2000px text). The export draws the board's OWN pictures (png-decode.ts,
 * board-pictures.ts), widgets with their last cached content (widget-face.ts), cuts a long board
 * into phone-readable pictures (split.ts), and every board PNG says in its bytes whether it is a
 * layout check or the real look (render-mark.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { decodePng, downscale } from '../../src/lib/whiteboards/png-decode.js';
import { Raster } from '../../src/lib/whiteboards/raster.js';
import { renderScene, wrapLines } from '../../src/lib/whiteboards/render.js';
import { isLayoutRender, layoutRenderWarning, pngTextChunks, RENDER_KIND_KEY } from '../../src/lib/whiteboards/render-mark.js';
import { loadBoardPictures, neededSides } from '../../src/lib/whiteboards/board-pictures.js';
import { markdownLines, widgetFace } from '../../src/lib/whiteboards/widget-face.js';
import { bodyFontSize, cutAxis, splitBoard, tileSize, TILE_COLUMNS } from '../../src/lib/whiteboards/split.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

const el = (o: Partial<WhiteboardElement>): WhiteboardElement => ({ version: 1, isDeleted: false, opacity: 100, ...o }) as WhiteboardElement;

/** An RGBA picture, left half red and right half blue. */
async function halves(w: number, h: number, format: 'png' | 'jpeg' = 'png', opts: Record<string, unknown> = {}): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    raw[i] = x < w / 2 ? 255 : 0;
    raw[i + 2] = x < w / 2 ? 0 : 255;
    raw[i + 3] = 255;
  }
  const img = sharp(raw, { raw: { width: w, height: h, channels: 4 } });
  return format === 'png' ? img.png(opts).toBuffer() : img.jpeg({ quality: 95 }).toBuffer();
}

const px = (bmp: { width: number; data: Uint8Array }, x: number, y: number) => {
  const i = (y * bmp.width + x) * 4;
  return [bmp.data[i], bmp.data[i + 1], bmp.data[i + 2], bmp.data[i + 3]];
};

describe('decodePng', () => {
  it('reads what the raster writes, pixel for pixel', () => {
    const r = new Raster(5, 3, [10, 20, 30]);
    r.fill([[[0, 0], [2, 0], [2, 3], [0, 3]]], [200, 0, 0]);
    const bmp = decodePng(r.toPng({ a: 'b' }));
    expect([bmp.width, bmp.height]).toEqual([5, 3]);
    expect(px(bmp, 0, 0)).toEqual([200, 0, 0, 255]);
    expect(px(bmp, 4, 2)).toEqual([10, 20, 30, 255]);
  });

  it.each([
    ['rgba', {}],
    ['palette', { palette: true, colours: 4 }],
    ['interlaced (Adam7)', { progressive: true }],
  ])('reads a %s PNG', async (_name, opts) => {
    const bmp = decodePng(await halves(17, 9, 'png', opts));
    expect([bmp.width, bmp.height]).toEqual([17, 9]);
    expect(px(bmp, 1, 4).slice(0, 3)).toEqual([255, 0, 0]);
    expect(px(bmp, 15, 8).slice(0, 3)).toEqual([0, 0, 255]);
  });

  it('reads 16-bit and grey PNGs', async () => {
    const g = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 128, g: 128, b: 128 } } }).greyscale().png().toBuffer();
    expect(px(decodePng(g), 2, 2).slice(0, 3)).toEqual([128, 128, 128]);
    const deep = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toColourspace('rgb16').toBuffer();
    expect(px(decodePng(deep), 1, 1).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('refuses what is not a PNG, and shrinks by averaging, never enlarging', () => {
    expect(() => decodePng(Buffer.from('not a png at all, just some text here'))).toThrow();
    const big = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4).fill(255) };
    expect(downscale(big, 2, 2)).toMatchObject({ width: 2, height: 1 });
    expect(downscale(big, 10, 10)).toBe(big);
  });
});

describe('the render kind lives in the PNG bytes', () => {
  const board = [el({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 50, height: 50, backgroundColor: '#ff0000', fillStyle: 'solid', index: 'a0' })];

  it('render is a layout check; export (pictures or faces given) is not', () => {
    const layout = renderScene(board, { region: { x: 0, y: 0, w: 60, h: 60 }, scale: 1 }).png;
    expect(isLayoutRender(layout)).toBe(true);
    expect(pngTextChunks(layout)[RENDER_KIND_KEY]).toBe('layout');
    const real = renderScene(board, { region: { x: 0, y: 0, w: 60, h: 60 }, scale: 1, pictures: () => null, faces: () => null }).png;
    expect(isLayoutRender(real)).toBe(false);
    expect(pngTextChunks(real)[RENDER_KIND_KEY]).toBe('export');
  });

  it('a PNG from anywhere else is not a layout check, and the warning names export', () => {
    expect(isLayoutRender(new Raster(2, 2).toPng())).toBe(false);
    expect(isLayoutRender(Buffer.from([1, 2, 3]))).toBe(false);
    expect(layoutRenderWarning('board.png')).toContain('whiteboard export');
  });
});

describe('pictures are drawn from their pixels', () => {
  const bmp = { width: 4, height: 2, data: new Uint8Array([
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
  ]) };
  const pic = (o: Partial<WhiteboardElement> = {}) => el({ id: 'p', type: 'image', x: 0, y: 0, width: 100, height: 50, fileId: 'f1', index: 'a0', ...o });
  const at = (png: Buffer, x: number, y: number) => px(decodePng(png), x, y).slice(0, 3);

  it('in its box, left red and right blue; a missing picture stays the placeholder', () => {
    const png = renderScene([pic()], { region: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, pictures: (id) => (id === 'f1' ? bmp : null) }).png;
    expect(at(png, 10, 25)).toEqual([255, 0, 0]);
    expect(at(png, 90, 25)).toEqual([0, 0, 255]);
    const none = renderScene([pic()], { region: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, pictures: () => null }).png;
    expect(at(none, 10, 25)).toEqual([241, 243, 245]);
  });

  it('honours a horizontal flip and a crop', () => {
    const flipped = renderScene([pic({ scale: [-1, 1] })], { region: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, pictures: () => bmp }).png;
    expect(at(flipped, 10, 25)).toEqual([0, 0, 255]);
    // Only the right half of the natural picture: all blue.
    const crop = { x: 2, y: 0, width: 2, height: 2, naturalWidth: 4, naturalHeight: 2 };
    const cropped = renderScene([pic({ crop })], { region: { x: 0, y: 0, w: 100, h: 50 }, scale: 1, pictures: () => bmp }).png;
    expect(at(cropped, 50, 25)).toEqual([0, 0, 255]);
    expect(at(cropped, 90, 25)).toEqual([0, 0, 255]);
  });

  it('asks for as many pixels as the scale needs, crop included', () => {
    const need = neededSides([pic(), pic({ id: 'q', fileId: 'f2', crop: { x: 0, y: 0, width: 50, height: 50, naturalWidth: 100, naturalHeight: 100 } })], 2);
    expect(need.get('f1')).toBe(200);
    expect(need.get('f2')).toBe(400); // half the natural picture fills the box: twice the pixels
  });
});

describe('loadBoardPictures reads only the board\'s own files', () => {
  let root: string;
  beforeEach(() => {
    root = join(realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-export-'))), '_dream_context');
    mkdirSync(join(root, 'whiteboards', 'b', 'files'), { recursive: true });
    writeFileSync(join(root, 'whiteboards', 'b', 'b.excalidraw.md'), '');
  });
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  const pic = (fileId: string) => el({ id: fileId, type: 'image', x: 0, y: 0, width: 40, height: 20, fileId, index: 'a0' });

  it('decodes a PNG, converts a JPEG through the converter, lists what it could not draw', async () => {
    writeFileSync(join(root, 'whiteboards', 'b', 'files', 'aaaa1111.png'), await halves(40, 20));
    writeFileSync(join(root, 'whiteboards', 'b', 'files', 'bbbb2222.jpg'), await halves(40, 20, 'jpeg'));
    writeFileSync(join(root, 'whiteboards', 'b', 'files', 'cccc3333.jpg'), await halves(40, 20, 'jpeg'));
    const pics = loadBoardPictures(root, 'b', [pic('aaaa1111'), pic('bbbb2222'), pic('dddd4444')], 1, () => null);
    expect(pics.get('aaaa1111')).toMatchObject({ width: 40, height: 20 });
    expect(pics.get('bbbb2222')).toBeNull();
    expect(pics.missing.map((m) => m.fileId).sort()).toEqual(['bbbb2222', 'dddd4444']);
    expect(pics.missing.find((m) => m.fileId === 'bbbb2222')!.why).toContain('converter');
    const converted = await halves(40, 20);
    const ok = loadBoardPictures(root, 'b', [pic('cccc3333')], 1, () => converted);
    expect(ok.loaded).toBe(1);
  });

  it('never follows a symlinked picture out of the board', async () => {
    const outside = join(root, '..', 'secret.png');
    writeFileSync(outside, await halves(8, 8));
    symlinkSync(outside, join(root, 'whiteboards', 'b', 'files', 'eeee5555.png'));
    const pics = loadBoardPictures(root, 'b', [pic('eeee5555')], 1, () => null);
    expect(pics.get('eeee5555')).toBeNull();
    expect(pics.missing).toHaveLength(1);
  });
});

describe('widget faces come from what is on disk', () => {
  let root: string;
  beforeEach(() => {
    root = join(realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-face-'))), '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    mkdirSync(join(root, 'lab', 'cache'), { recursive: true });
    writeFileSync(join(root, 'state', 'demo-task.md'), '---\nname: Demo task\nstatus: in_progress\npriority: high\n---\n');
    writeFileSync(join(root, 'lab', 'insights', 'demo-metric.md'), '---\ntitle: Demo metric\nunit: "%"\n---\n');
    writeFileSync(join(root, 'lab', 'cache', 'demo-metric.json'), JSON.stringify({ slug: 'demo-metric', fetchedAt: '2026-11-16T09:00:00Z', tweaks: {}, granularity: 'daily', unit: '%', series: [{ name: 's', points: [{ t: '2026-11-15', v: 10 }, { t: '2026-11-16', v: 12.5 }] }], latest: 12.5, error: null, errorAt: null, scriptHash: null }));
  });
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  const widget = (customData: Record<string, unknown>) => el({ id: 'w', type: 'embeddable', x: 0, y: 0, width: 376, height: 180, customData: { dc: { v: 1, ...customData } }, index: 'a0' });

  it('note, todo, insight (cached value + as of + sparkline), task status', () => {
    expect(widgetFace(root, widget({ kind: 'note', markdown: '# Başlık\n- **bir**\n- [x] iki' }))!.lines).toEqual(['Başlık', '• bir', '[x] iki']);
    expect(widgetFace(root, widget({ kind: 'todo', items: [{ id: '1', text: 'a', done: true }, { id: '2', text: 'b', done: false }] }))).toMatchObject({ sub: '1/2 done', lines: ['[x] a', '[ ] b'] });
    expect(widgetFace(root, widget({ kind: 'insight', ref: 'demo-metric' }))).toMatchObject({ title: 'Demo metric', value: '12.5 %', sub: 'insight · as of 2026-11-16', spark: [10, 12.5] });
    expect(widgetFace(root, widget({ kind: 'insight', ref: 'no-such' }))!.sub).toContain('no cached value');
    expect(widgetFace(root, widget({ kind: 'task', ref: 'demo-task' }))).toMatchObject({ title: 'Demo task', sub: 'task · in_progress · high' });
    expect(widgetFace(root, el({ id: 'x', type: 'rectangle' }))).toBeNull();
  });

  it('a widget with a face draws its content, not only its title', () => {
    const w = widget({ kind: 'note', markdown: 'line one\nline two' });
    const titled = renderScene([w], { region: { x: 0, y: 0, w: 376, h: 180 }, scale: 1 }).png;
    const full = renderScene([w], { region: { x: 0, y: 0, w: 376, h: 180 }, scale: 1, faces: (e) => widgetFace(root, e) }).png;
    const ink = (png: Buffer) => { const b = decodePng(png); let n = 0; for (let i = 0; i < b.data.length; i += 4) if (b.data[i] < 100) n++; return n; };
    expect(ink(full)).toBeGreaterThan(ink(titled));
  });

  it('markdown lines drop markers and blank runs; wrapping keeps words whole', () => {
    expect(markdownLines('## A\n\n\n> b\n---\n[link](https://x.test)')).toEqual(['A', '', 'b', '', 'link']);
    expect(wrapLines(['aaa bbb ccc'], 50, 10)).toEqual(['aaa bbb', 'ccc']);
  });
});

describe('splitBoard cuts by what the board holds', () => {
  const text = (id: string, x: number, y: number, tag: string, fontSize = 16, t = 'body text here') =>
    el({ id, type: 'text', x, y, width: 300, height: 40, fontSize, text: t, customData: { dc: { v: 1, kind: 'note', tag } }, index: id });

  it('body size is where half the characters are, titles do not lift it', () => {
    expect(bodyFontSize([text('t', 0, 0, 'a', 40, 'Title'), text('b', 0, 50, 'a', 16, 'a much longer body paragraph of text')])).toBe(16);
    expect(tileSize([]).w).toBe(16 * TILE_COLUMNS);
  });

  it('cuts in the gap between elements, not through them', () => {
    // Spans 0-100 and 120-300: a cut at most 200 from 0 lands in the gap 100-120.
    const cuts = cutAxis(0, 300, 200, [[0, 100], [120, 300]]);
    expect(cuts[1]).toBeGreaterThanOrEqual(100);
    expect(cuts[1]).toBeLessThanOrEqual(120);
    expect(cuts[cuts.length - 1]).toBe(300);
  });

  it('tags: one picture per group, top to bottom, each drawing only its own group', () => {
    const els = [text('b1', 0, 1000, 'second'), text('a1', 0, 0, 'first'), text('a2', 0, 60, 'first'), text('b2', 0, 1060, 'second')];
    const s = splitBoard(els, 'tags');
    expect(s.map((x) => x.label)).toEqual(['#first', '#second']);
    expect([...s[0].ids!].sort()).toEqual(['a1', 'a2']);
  });

  it('a group far larger than a phone picture is cut into several, numbered', () => {
    const els = Array.from({ length: 12 }, (_, i) => text(`t${i}`, 0, i * 400, 'tall'));
    const s = splitBoard(els, 'tags');
    expect(s.length).toBeGreaterThan(1);
    expect(s[0].label).toBe(`#tall (1/${s.length})`);
  });

  it('a hand-pasted picture (no tag) inside a large group lands in one of its pictures', () => {
    // The review's repro: a tall tagged column, a wide tagged header, an untagged picture between.
    const els = [
      ...Array.from({ length: 8 }, (_, i) => text(`c${i}`, 0, 200 + i * 600, 'big')),
      el({ id: 'head', type: 'text', x: 0, y: 0, width: 2400, height: 40, fontSize: 16, text: 'header', customData: { dc: { v: 1, kind: 'note', tag: 'big' } }, index: 'h' }),
      el({ id: 'pic', type: 'image', x: 1500, y: 1000, width: 600, height: 400, fileId: 'f1', index: 'p' }),
    ];
    const s = splitBoard(els, 'tags');
    const overlaps = (r: { x: number; y: number; w: number; h: number }) => r.x < 2100 && r.x + r.w > 1500 && r.y < 1400 && r.y + r.h > 1000;
    expect(s.some((x) => x.ids!.has('pic') && overlaps(x.region))).toBe(true);
  });

  it('a section wider than a tile splits at its gap: the text column whole, the picture beside it', () => {
    // 700-wide text (wider than the 640 tile) beside a 640 picture, a widget below the text.
    const els = [
      el({ id: 'title', type: 'text', x: 0, y: 0, width: 700, height: 35, fontSize: 28, text: 'Section', customData: { dc: { v: 1, kind: 'note', tag: 's' } }, index: 'a' }),
      el({ id: 'body', type: 'text', x: 0, y: 56, width: 700, height: 120, fontSize: 16, text: 'a long body paragraph that sets the body size', customData: { dc: { v: 1, kind: 'note', tag: 's' } }, index: 'b' }),
      el({ id: 'pic', type: 'image', x: 784, y: 0, width: 640, height: 640, fileId: 'f1', customData: { dc: { v: 1, kind: 'note', tag: 's' } }, index: 'c' }),
      el({ id: 'w', type: 'embeddable', x: 0, y: 784, width: 376, height: 180, customData: { dc: { v: 1, kind: 'note', tag: 's' } }, index: 'd' }),
    ];
    const s = splitBoard(els, 'tags');
    expect(s).toHaveLength(2);
    const holds = (r: { x: number; w: number }, x0: number, x1: number) => r.x <= x0 && r.x + r.w >= x1;
    expect(s.some((x) => holds(x.region, 0, 700))).toBe(true); // the text is never cut sideways
    expect(s.some((x) => holds(x.region, 784, 1424))).toBe(true);
  });

  it('a frame or full-width divider around two columns does not glue them into one wide picture', () => {
    const col = (id: string, x: number) => el({ id, type: 'text', x, y: 100, width: 600, height: 300, fontSize: 16, text: 'column body text that sets the size', customData: { dc: { v: 1, kind: 'note', tag: 'two' } }, index: id });
    const frame = el({ id: 'fr', type: 'rectangle', x: 0, y: 0, width: 1500, height: 500, customData: { dc: { v: 1, kind: 'note', tag: 'two' } }, index: 'f' });
    const line = el({ id: 'ln', type: 'line', x: 0, y: 60, width: 1500, height: 0, points: [[0, 0], [1500, 0]], customData: { dc: { v: 1, kind: 'note', tag: 'two' } }, index: 'l' });
    expect(splitBoard([frame, col('a', 20), col('b', 860)], 'tags').length).toBeGreaterThan(1);
    expect(splitBoard([line, col('a', 20), col('b', 860)], 'tags').length).toBeGreaterThan(1);
  });

  it('a zero-width divider exactly on a cut still lands in a picture', () => {
    const col = (id: string, x: number) => el({ id, type: 'text', x, y: 0, width: 600, height: 300, fontSize: 16, text: 'column body text that sets the size', customData: { dc: { v: 1, kind: 'note', tag: 'cols' } }, index: id });
    // Columns 20-620 and 800-1400: the cut between them falls at 710, where the divider is.
    const divider = el({ id: 'dv', type: 'line', x: 710, y: 0, width: 0, height: 300, points: [[0, 0], [0, 300]], customData: { dc: { v: 1, kind: 'note', tag: 'cols' } }, index: 'd' });
    const s = splitBoard([col('a', 20), col('b', 800), divider], 'tags');
    expect(s.length).toBeGreaterThan(1);
    expect(s.some((x) => x.region.x <= 710 && x.region.x + x.region.w >= 710)).toBe(true);
  });

  it('bands cover the board in reading order; an empty board has none', () => {
    const els = Array.from({ length: 12 }, (_, i) => el({ id: `r${i}`, type: 'rectangle', x: 0, y: i * 400, width: 300, height: 100, index: `a${i}` }));
    const s = splitBoard(els, 'bands');
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x, i) => i === 0 || x.region.y >= s[i - 1].region.y)).toBe(true);
    expect(splitBoard([], 'bands')).toEqual([]);
  });
});
