import { describe, it, expect } from 'vitest';
import {
  BoardPictures, dataUrlBytes, isPictureOf, liveFileIds, type PictureFile,
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
