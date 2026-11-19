/**
 * `whiteboard export` (owner, 2026-11-17): the board reaches his phone as the app draws it. The
 * app's own renderer draws it in a headless browser (board-shots.ts, dashboard BoardPrint.tsx);
 * a long board is cut into phone pictures, each section whole (split.ts); every board PNG says in
 * its bytes whether it is a layout check or the real look (render-mark.ts).
 */
import { describe, it, expect } from 'vitest';
import { Raster, withPngText } from '../../src/lib/whiteboards/raster.js';
import { renderScene } from '../../src/lib/whiteboards/render.js';
import { isLayoutRender, layoutRenderWarning, pngTextChunks, RENDER_KIND_KEY } from '../../src/lib/whiteboards/render-mark.js';
import { BoardShotError, PipeFramer, shootBoard, shotArgs, shotGateRefusal, shotHeight } from '../../src/lib/whiteboards/board-shots.js';
import {
  bodyFontSize, cutAxis, exportShots, EXPORT_MAX_WIDTH, EXPORT_MIN_SCALE, EXPORT_WIDTH, PHOTO_MAX_SIDES, splitBoard, tileSize, TILE_COLUMNS,
} from '../../src/lib/whiteboards/split.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

const el = (o: Partial<WhiteboardElement>): WhiteboardElement => ({ version: 1, isDeleted: false, opacity: 100, ...o }) as WhiteboardElement;

describe('the render kind lives in the PNG bytes', () => {
  const board = [el({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 50, height: 50, backgroundColor: '#ff0000', fillStyle: 'solid', index: 'a0' })];

  it('render is a layout check; a browser shot marked export is not', () => {
    const layout = renderScene(board, { region: { x: 0, y: 0, w: 60, h: 60 }, scale: 1 }).png;
    expect(isLayoutRender(layout)).toBe(true);
    expect(pngTextChunks(layout)[RENDER_KIND_KEY]).toBe('layout');
    // A PNG another encoder wrote (no text chunks), marked after the fact.
    const shot = withPngText(new Raster(3, 2).toPng(), { [RENDER_KIND_KEY]: 'export' });
    expect(isLayoutRender(shot)).toBe(false);
    expect(pngTextChunks(shot)[RENDER_KIND_KEY]).toBe('export');
    expect(shot.subarray(0, 8)).toEqual(new Raster(1, 1).toPng().subarray(0, 8));
  });

  it('a PNG from anywhere else is not a layout check, and the warning names export', () => {
    expect(isLayoutRender(new Raster(2, 2).toPng())).toBe(false);
    expect(isLayoutRender(Buffer.from([1, 2, 3]))).toBe(false);
    expect(withPngText(Buffer.from([1, 2, 3]), { a: 'b' })).toEqual(Buffer.from([1, 2, 3]));
    expect(layoutRenderWarning('board.png')).toContain('whiteboard export');
  });
});

describe('the browser camera', () => {
  it('reads NUL-framed messages across chunk boundaries', () => {
    const f = new PipeFramer();
    expect(f.push('{"id":1}\0{"id"')).toEqual(['{"id":1}']);
    expect(f.push(':2}\0\0')).toEqual(['{"id":2}', '']);
  });

  it('the browser reaches only the page port, through a pipe, with a throwaway profile', () => {
    const args = shotArgs('/tmp/profile-x', 4321);
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--user-data-dir=/tmp/profile-x');
    expect(args).toContain('--proxy-server=http://127.0.0.1:9');
    expect(args).toContain('--proxy-bypass-list=<-loopback>;127.0.0.1:4321');
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
  });

  it('no browser: a plain error, nothing drawn some other way', async () => {
    await expect(shootBoard({ contextRoot: '/nonexistent', slug: 'b', plans: [], chromium: null })).rejects.toBeInstanceOf(BoardShotError);
    await expect(shootBoard({ contextRoot: '/nonexistent', slug: 'b', plans: [], chromium: null })).rejects.toThrow(/DREAMCONTEXT_CHROMIUM/);
  });

  it('the one-off page server: reads only, its own Host, never another vault', () => {
    const req = (o: { method?: string; host?: string; url?: string; vault?: string }) => ({
      method: o.method ?? 'GET', url: o.url ?? '/api/whiteboards/b',
      headers: { host: o.host ?? '127.0.0.1:5555', ...(o.vault ? { 'x-dreamcontext-vault': o.vault } : {}) },
    });
    expect(shotGateRefusal(req({}), 5555)).toBeNull();
    expect(shotGateRefusal(req({ method: 'POST' }), 5555)).toBe(405);
    expect(shotGateRefusal(req({ host: 'evil.example:5555' }), 5555)).toBe(403);
    expect(shotGateRefusal(req({ vault: 'other' }), 5555)).toBe(403);
    expect(shotGateRefusal(req({ url: '/api/x?vault=other' }), 5555)).toBe(403);
  });

  it('a shot keeps the region\'s shape', () => {
    expect(shotHeight({ region: { x: 0, y: 0, w: 1000, h: 500 }, width: 1170 })).toBe(585);
  });
});

describe('export keeps each section whole and sizes it for a phone', () => {
  const tagged = (o: Partial<WhiteboardElement>, tag: string) => el({ ...o, customData: { dc: { v: 1, kind: 'note', tag } } });

  it('a section wider than a tile is still ONE picture: title, text, picture and widget together', () => {
    // The owner's blank band: the text column and its picture went to two images.
    const els = [
      tagged({ id: 'title', type: 'text', x: 0, y: 0, width: 700, height: 35, fontSize: 28, text: 'Section', index: 'a' }, 's'),
      tagged({ id: 'body', type: 'text', x: 0, y: 56, width: 700, height: 120, fontSize: 16, text: 'a long body paragraph that sets the body size', index: 'b' }, 's'),
      tagged({ id: 'pic', type: 'image', x: 784, y: 0, width: 640, height: 640, fileId: 'f1', index: 'c' }, 's'),
      tagged({ id: 'w', type: 'embeddable', x: 0, y: 784, width: 376, height: 180, index: 'd' }, 's'),
    ];
    const s = splitBoard(els, 'tags', { wholeGroups: true });
    expect(s).toHaveLength(1);
    expect([...s[0].ids!].sort()).toEqual(['body', 'pic', 'title', 'w']);
    // Trimmed to what it holds: a 20-unit margin, no more.
    expect(s[0].region).toEqual({ x: -20, y: -20, w: 1424 + 40, h: 964 + 40 });
  });

  it('1170 pixels across; wider only when the body text would be too small; a small one not blown up', () => {
    const text = (id: string, w: number, fontSize = 16) => el({ id, type: 'text', x: 0, y: 0, width: w, height: 100, fontSize, text: 'body text of the board', index: id });
    const one = (w: number) => exportShots([text('t', w)], [{ label: 'a', region: { x: 0, y: 0, w, h: 400 } }])[0];
    expect(one(800).width).toBe(EXPORT_WIDTH);
    expect(one(800).height).toBe(Math.round(400 * EXPORT_WIDTH / 800));
    expect(one(1600).width).toBeGreaterThan(EXPORT_WIDTH); // 16px text at 1170/1600 is ~12px: widened
    expect(one(5000).width).toBe(EXPORT_MAX_WIDTH);
    expect(one(200).width).toBe(600); // at most 3x the board
  });

  it('a section too tall for one photo is paged at its gaps, in order', () => {
    const els = Array.from({ length: 40 }, (_, i) => el({ id: `t${i}`, type: 'text', x: 0, y: i * 300, width: 800, height: 200, fontSize: 16, text: 'body text here', index: `a${i}` }));
    const shots = exportShots(els, [{ label: '#long', region: { x: 0, y: 0, w: 800, h: 12000 } }]);
    expect(shots.length).toBeGreaterThan(1);
    expect(shots.every((s) => s.width + s.height <= PHOTO_MAX_SIDES)).toBe(true);
    expect(shots[0].label).toBe(`#long (1/${shots.length})`);
    // Each cut falls in a gap (y mod 300 in 200..300), never through a text.
    for (const s of shots.slice(1)) expect(((s.region.y % 300) + 300) % 300).toBeGreaterThanOrEqual(200);
  });

  it('fit: the whole board as one overview photo, shrunk, never paged', () => {
    const els = Array.from({ length: 40 }, (_, i) => el({ id: `t${i}`, type: 'text', x: 0, y: i * 300, width: 800, height: 200, fontSize: 16, text: 'body text here', index: `a${i}` }));
    const shots = exportShots(els, [{ label: 'board', region: { x: 0, y: 0, w: 800, h: 12000 } }], { fit: true });
    expect(shots).toHaveLength(1);
    expect(shots[0].width + shots[0].height).toBeLessThanOrEqual(PHOTO_MAX_SIDES);
  });

  it('fit never goes below the zoom the canvas draws at: a giant board is paged instead', () => {
    const els = Array.from({ length: 200 }, (_, i) => el({ id: `t${i}`, type: 'text', x: 0, y: i * 400, width: 800, height: 200, fontSize: 16, text: 'body text here', index: `a${i}` }));
    const shots = exportShots(els, [{ label: 'board', region: { x: 0, y: 0, w: 800, h: 80000 } }], { fit: true });
    expect(shots.length).toBeGreaterThan(1);
    expect(shots.every((s) => s.width / 800 >= EXPORT_MIN_SCALE - 1e-9)).toBe(true);
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
