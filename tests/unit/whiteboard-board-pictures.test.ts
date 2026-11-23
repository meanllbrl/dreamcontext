import { describe, it, expect } from 'vitest';
import {
  BoardPictures, dataUrlBytes, isPictureOf, liveFileIds, openViewCentre, picturesNearestFirst, type PictureFile,
} from '../../dashboard/src/components/whiteboard/boardPictures.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const img = (id: string, fileId: string, extra: Record<string, unknown> = {}) => ({ id, type: 'image', version: 1, fileId, ...extra });
const file = (id: string, mimeType = 'image/png', body = 'AQID'): PictureFile => ({ id, mimeType, dataURL: `data:${mimeType};base64,${body}` });
const httpError = (status: number, message = 'no') => Object.assign(new Error(message), { status, code: 'invalid' });

function harness(opts: { fail?: Record<string, unknown>; files?: Record<string, PictureFile | Error> } = {}) {
  const uploads: { id: string; bytes: number[]; mimeType: string }[] = [];
  const downloads: string[] = [];
  const pictures = new BoardPictures({
    upload: async (id, bytes, mimeType) => {
      uploads.push({ id, bytes: [...bytes], mimeType });
      if (opts.fail?.[id]) throw opts.fail[id];
    },
    download: async (id) => {
      downloads.push(id);
      const f = opts.files?.[id];
      if (!f) throw httpError(404);
      if (f instanceof Error) throw f;
      return f;
    },
  });
  return { pictures, uploads, downloads };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('board pictures: what the scene names', () => {
  it('lists each live picture\'s file once, never a deleted one or another element', () => {
    expect(liveFileIds([
      img('1', A), img('2', A), img('3', B, { isDeleted: true }), { id: 'r', type: 'rectangle', version: 1 }, null, img('4', ''),
    ])).toEqual([A]);
    expect(isPictureOf(img('1', A), new Set([A]))).toBe(true);
    expect(isPictureOf(img('1', B), new Set([A]))).toBe(false);
    expect(isPictureOf({ id: 'r', type: 'rectangle', fileId: A }, new Set([A]))).toBe(false);
  });

  it('reads a base64 data URL\'s bytes, and only that', () => {
    expect([...dataUrlBytes('data:image/png;base64,AQID')!]).toEqual([1, 2, 3]);
    expect(dataUrlBytes('data:image/png,abc')).toBeNull();
    expect(dataUrlBytes('https://example.com/x.png')).toBeNull();
    expect(dataUrlBytes('data:image/png;base64,***')).toBeNull();
  });
});

describe('board pictures: up, before the save that carries them', () => {
  it('sends a picture the page holds once, and never one the board already has', async () => {
    const h = harness();
    h.pictures.markStored([B]);
    h.pictures.remember({ [A]: file(A), [B]: file(B) });
    expect(await h.pictures.uploadPending([img('1', A), img('2', B)])).toEqual([]);
    expect(h.uploads).toEqual([{ id: A, bytes: [1, 2, 3], mimeType: 'image/png' }]);
    expect(await h.pictures.uploadPending([img('1', A), img('2', B)])).toEqual([]);
    expect(h.uploads).toHaveLength(1);
  });

  it('a picture the page never held (another window\'s) is not this page\'s to send', async () => {
    const h = harness();
    expect(await h.pictures.uploadPending([img('1', C)])).toEqual([]);
    expect(h.uploads).toHaveLength(0);
  });

  it('a refusal that cannot change is reported once per save and never sent again', async () => {
    const h = harness({ fail: { [A]: httpError(413, 'the picture is too large') } });
    h.pictures.remember({ [A]: file(A) });
    expect(await h.pictures.uploadPending([img('1', A)])).toEqual([A]);
    expect(h.pictures.refusal(A)).toBe('the picture is too large');
    expect(await h.pictures.uploadPending([img('1', A)])).toEqual([A]);
    expect(h.uploads).toHaveLength(1);
  });

  it('a type the board does not take is refused in the page, without a request', async () => {
    const h = harness();
    h.pictures.remember({ [A]: file(A, 'image/svg+xml') });
    expect(await h.pictures.uploadPending([img('1', A)])).toEqual([A]);
    expect(h.pictures.refusal(A)).toMatch(/PNG, JPEG, GIF or WebP/);
    expect(h.uploads).toHaveLength(0);
  });

  it('a failure that may pass throws (the save retries), and the next try sends it', async () => {
    const fail: Record<string, unknown> = { [A]: httpError(503) };
    const h = harness({ fail });
    h.pictures.remember({ [A]: file(A) });
    await expect(h.pictures.uploadPending([img('1', A)])).rejects.toMatchObject({ status: 503 });
    fail[A] = Object.assign(new Error('offline'), {});
    await expect(h.pictures.uploadPending([img('1', A)])).rejects.toThrow('offline');
    delete fail[A];
    expect(await h.pictures.uploadPending([img('1', A)])).toEqual([]);
    expect(h.uploads).toHaveLength(3);
    expect(h.pictures.refusal(A)).toBeUndefined();
  });
});

describe('board pictures: down, for every picture the page lacks', () => {
  it('fetches each missing picture once and hands it over; skips the ones held', async () => {
    const h = harness({ files: { [A]: file(A), [B]: file(B) } });
    const got: string[] = [];
    const scene = [img('1', A), img('2', A), img('3', B)];
    h.pictures.load(scene, (id) => id === B, (f) => got.push(f.id));
    h.pictures.load(scene, (id) => id === B, (f) => got.push(f.id));
    await flush();
    expect(h.downloads).toEqual([A]);
    expect(got).toEqual([A]);
    // Downloaded means stored: never sent back up.
    h.pictures.remember({ [A]: file(A) });
    expect(await h.pictures.uploadPending(scene)).toEqual([]);
    expect(h.uploads).toHaveLength(0);
  });

  it('one gone on disk stays a placeholder; one that failed otherwise is asked again', async () => {
    const h = harness({ files: { [B]: Object.assign(new Error('offline'), {}) } });
    const scene = [img('1', A), img('2', B)];
    h.pictures.load(scene, () => false, () => {});
    await flush();
    h.pictures.load(scene, () => false, () => {});
    await flush();
    expect(h.downloads).toEqual([A, B, B]);
  });

  it('never fetches the page\'s own picture before it is sent', async () => {
    const h = harness({ files: {} });
    h.pictures.remember({ [A]: file(A) });
    h.pictures.load([img('1', A)], () => false, () => {});
    await flush();
    expect(h.downloads).toEqual([]);
  });
});

describe('picturesNearestFirst (a board opens with the pictures on screen first)', () => {
  const at = (id: string, fileId: string, x: number, y: number) => img(id, fileId, { x, y, width: 100, height: 100 });

  it('orders by the distance from the view middle to each picture box, inside first', () => {
    const els = [at('1', A, 5000, 5000), at('2', B, 0, 0), at('3', C, 900, 0)];
    expect(picturesNearestFirst(els, { x: 50, y: 50 })).toEqual([B, C, A]);
    expect(picturesNearestFirst(els, { x: 5050, y: 5050 })).toEqual([A, C, B]);
  });

  it('a picture used twice counts its nearest copy; deleted ones are left out', () => {
    const els = [at('1', A, 9000, 0), at('2', B, 300, 0), at('3', A, 0, 0), at('4', C, 0, 0)];
    els[3] = { ...els[3], isDeleted: true };
    expect(picturesNearestFirst(els, { x: 0, y: 0 })).toEqual([A, B]);
  });

  it('without a point it keeps the drawing order', () => {
    const els = [at('1', C, 0, 0), at('2', A, 10, 0)];
    expect(picturesNearestFirst(els, null)).toEqual(liveFileIds(els));
  });
});

describe('BoardPictures.load asks nearest first', () => {
  it('issues the downloads in the order of the distance to the view middle', () => {
    const h = harness({ files: { [A]: file(A), [B]: file(B), [C]: file(C) } });
    const box = (id: string, fileId: string, x: number) => img(id, fileId, { x, y: 0, width: 10, height: 10 });
    h.pictures.load([box('1', A, 2000), box('2', B, 0), box('3', C, 500)], () => false, () => {}, { x: 5, y: 5 });
    expect(h.downloads).toEqual([B, C, A]);
  });
});

describe('openViewCentre (where a board opens, before the canvas has placed its view)', () => {
  const box = (id: string, x: number, y: number, w = 100, h = 100) => ({ id, type: 'rectangle', x, y, width: w, height: h });

  it('with no saved view: the middle of the content, however far from the origin', () => {
    const els = [box('a', 10_000, 20_000), box('b', 12_000, 22_000)];
    expect(openViewCentre(els, null, 1440, 900)).toEqual({ x: 11_050, y: 21_050 });
  });

  it('a saved view that shows an element wins; one that shows nothing falls back to the content', () => {
    const els = [box('a', 0, 0), box('b', 5000, 5000)];
    // scroll -4800,-4800 at zoom 1 over 1440x900: shows b.
    expect(openViewCentre(els, { scrollX: -4800, scrollY: -4800, zoom: 1 }, 1440, 900)).toEqual({ x: 4800 + 720, y: 4800 + 450 });
    expect(openViewCentre(els, { scrollX: -90_000, scrollY: -90_000, zoom: 1 }, 1440, 900)).toEqual({ x: 2550, y: 2550 });
  });

  it('an empty board has no centre; deleted elements do not count', () => {
    expect(openViewCentre([], null, 1440, 900)).toBeNull();
    expect(openViewCentre([{ ...box('a', 0, 0), isDeleted: true }], null, 1440, 900)).toBeNull();
  });
});
