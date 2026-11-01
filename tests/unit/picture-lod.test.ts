import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FULL, PREVIEW_EDGE, Sharpener, adoptImages, catchImages, chooseCopy, deviceSize, entryOf,
  installPictureLod, makePreview, pngSize, previewSize, type Bitmap, type PictureEntry,
} from '../../dashboard/src/components/whiteboard/pictureLod';

const bitmap = (width: number, height = width): Bitmap & { closed: boolean } => {
  const b = { width, height, closed: false, close() { b.closed = true; } };
  return b;
};

function standIn(scale = 1) {
  const calls: unknown[][] = [];
  class Ctx {
    drawImage(...args: unknown[]) { calls.push(args); }
    getTransform() { return { a: scale, b: 0, c: 0, d: scale }; }
  }
  installPictureLod(Ctx.prototype as unknown as CanvasRenderingContext2D);
  return { ctx: new Ctx() as unknown as CanvasRenderingContext2D, calls };
}

function timers() {
  let run: (() => void) | null = null;
  return {
    setTimer: (fn: () => void) => { run = fn; return 1; },
    clearTimer: () => { run = null; },
    fire: () => { const r = run; run = null; r?.(); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('choosing a copy', () => {
  const natural = { width: 2880, height: 1800 };
  const preview = { width: 800, height: 500 };
  it('takes the preview while it holds enough pixels, whichever way the picture is cropped', () => {
    expect(chooseCopy({ width: 760, height: 475 }, natural, natural, preview, false)).toBe('preview');
    expect(chooseCopy({ width: 801, height: 500 }, natural, natural, preview, false)).toBe('soft');
    expect(chooseCopy({ width: 801, height: 500 }, natural, natural, preview, true)).toBe('full');
    // A quarter of the picture holds a quarter of the preview's pixels.
    expect(chooseCopy({ width: 300, height: 100 }, { width: 720, height: 450 }, natural, preview, false)).toBe('soft');
  });

  it('a stretched element is judged on both axes', () => {
    expect(chooseCopy({ width: 760, height: 2400 }, natural, natural, preview, false)).toBe('soft');
  });

  it('measures the destination in device pixels, rotation included', () => {
    expect(deviceSize({ a: 2, b: 0, c: 0, d: 2 }, 380, 240)).toEqual({ width: 760, height: 480 });
    expect(deviceSize({ a: 0, b: 2, c: -2, d: 0 }, 380, 240)).toEqual({ width: 760, height: 480 });
  });

  it('sizes a preview by the long edge and leaves a small picture alone', () => {
    expect(previewSize(2880, 1800)).toEqual({ resizeWidth: 800, resizeHeight: 500 });
    expect(previewSize(1000, 4000)).toEqual({ resizeWidth: 200, resizeHeight: 800 });
    expect(previewSize(PREVIEW_EDGE, 100)).toBeNull();
    expect(previewSize(null, null)).toEqual({ resizeWidth: PREVIEW_EDGE });
  });

  it('reads a PNG header, and nothing else', () => {
    const head = new Uint8Array(24);
    head.set([0x89, 0x50, 0x4e, 0x47]);
    new DataView(head.buffer).setUint32(16, 2880);
    new DataView(head.buffer).setUint32(20, 1800);
    expect(pngSize(head)).toEqual({ width: 2880, height: 1800 });
    expect(pngSize(new Uint8Array(24))).toEqual({ width: null, height: null });
  });
});

describe('catching the canvas images', () => {
  it('sees only what is built during the call and restores the constructor', () => {
    class Real { src = ''; }
    const host = { Image: Real as unknown };
    const caught = catchImages(() => { new (host.Image as typeof Real)(); }, host);
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(Real);
    expect(host.Image).toBe(Real);
  });

  it('restores the constructor when the call throws', () => {
    class Real {}
    const host = { Image: Real as unknown };
    expect(() => catchImages(() => { throw new Error('x'); }, host)).toThrow('x');
    expect(host.Image).toBe(Real);
  });

  it('an Image it did not catch has no entry: an export draws the full picture', () => {
    const t = timers();
    const sharpener = new Sharpener({ decodeFull: async () => bitmap(10), refresh: () => {}, ...t });
    const ours = { src: 'data:a', naturalWidth: 2880, naturalHeight: 1800 };
    const exportsOwn = { src: 'data:a', naturalWidth: 2880, naturalHeight: 1800 };
    adoptImages([ours], new Map([['data:a', { fileId: 'a', preview: bitmap(800, 500) }]]), sharpener);
    expect(entryOf(ours)?.fileId).toBe('a');
    expect(entryOf(exportsOwn)).toBeUndefined();

    const { ctx, calls } = standIn(3);
    ctx.drawImage(exportsOwn as never, 0, 0, 2880, 1800, 0, 0, 380, 240);
    expect(calls[0]![0]).toBe(exportsOwn);
  });
});

describe('drawing', () => {
  const setup = (scale: number, opts: { full?: boolean } = {}) => {
    const t = timers();
    const refresh = vi.fn();
    const sharpener = new Sharpener({ decodeFull: async () => bitmap(2880, 1800), refresh, ...t });
    const image = { src: 'data:a', naturalWidth: 2880, naturalHeight: 1800 };
    const preview = bitmap(800, 500);
    adoptImages([image], new Map([['data:a', { fileId: 'a', preview }]]), sharpener);
    const entry = entryOf(image) as PictureEntry;
    if (opts.full) entry.full = bitmap(2880, 1800);
    return { ...standIn(scale), image, preview, entry, t, refresh, sharpener };
  };

  it('a draw the preview covers uses it, with the source rectangle scaled', () => {
    const { ctx, calls, image, preview } = setup(2);
    ctx.drawImage(image as never, 288, 180, 1440, 900, 1, 2, 380, 240);
    const [src, sx, sy, sw, sh, dx, dy, dw, dh] = calls[0]!;
    expect(src).toBe(preview);
    expect([sx, sy, sw, sh].map((n) => Math.round(n as number))).toEqual([80, 50, 400, 250]);
    expect([dx, dy, dw, dh]).toEqual([1, 2, 380, 240]);
  });

  it('a larger draw shows the preview at once, then sharpens and rebuilds', async () => {
    const { ctx, calls, image, preview, entry, t, refresh } = setup(4);
    ctx.drawImage(image as never, 0, 0, 2880, 1800, 0, 0, 380, 240);
    expect(calls[0]![0]).toBe(preview);
    expect(refresh).not.toHaveBeenCalled();
    t.fire();
    await flush();
    expect(entry.full).not.toBeNull();
    expect(refresh).toHaveBeenCalledWith(['a']);
    ctx.drawImage(image as never, 0, 0, 2880, 1800, 0, 0, 380, 240);
    expect(calls[1]![0]).toBe(entry.full);
  });

  it('a smaller twin of the same picture leaves the shared full copy alone', () => {
    const { ctx, calls, image, preview, entry } = setup(4, { full: true });
    const full = entry.full;
    ctx.drawImage(image as never, 0, 0, 2880, 1800, 0, 0, 100, 62);
    ctx.drawImage(image as never, 0, 0, 2880, 1800, 0, 0, 380, 240);
    expect(calls[0]![0]).toBe(preview);
    expect(entry.full).toBe(full);
    expect(calls[1]![0]).toBe(full);
  });

  it('a picture no larger than its preview draws as it is', () => {
    const { ctx, calls, image, entry } = setup(1);
    (image as { naturalWidth: number }).naturalWidth = 200;
    entry.preview = bitmap(800, 1600);
    ctx.drawImage(image as never, 0, 0, 200, 400, 0, 0, 100, 200);
    expect(calls[0]![0]).toBe(image);
  });

  it('leaves every other draw exactly as it came', () => {
    const { ctx, calls } = standIn(2);
    const canvas = {};
    ctx.drawImage(canvas as never, 1, 2);
    expect(calls[0]).toEqual([canvas, 1, 2]);
  });
});

describe('the sharpener', () => {
  const entryFor = (sharpener: Sharpener, fileId: string): PictureEntry => ({ fileId, preview: bitmap(800), full: null, failed: false, sharpener });

  it('sharpens more pictures than it can hold, a chunk at a time, none lost', async () => {
    const t = timers();
    const refreshed: string[] = [];
    const sharpener = new Sharpener({ decodeFull: async () => bitmap(2880), refresh: (ids) => { refreshed.push(...ids); }, ...t });
    const all = Array.from({ length: MAX_FULL + 4 }, (_, i) => entryFor(sharpener, `f${i}`));
    for (const e of all) sharpener.want(e, {});
    t.fire();
    await flush();
    await flush();
    expect(new Set(refreshed).size).toBe(all.length);
    expect(all.filter((e) => e.full).length).toBeLessThanOrEqual(MAX_FULL);
  });

  it('a picture let go can be sharpened again at once', async () => {
    const t = timers();
    const decodeFull = vi.fn(async () => bitmap(2880));
    const sharpener = new Sharpener({ decodeFull, refresh: () => {}, ...t });
    const all = Array.from({ length: MAX_FULL + 1 }, (_, i) => entryFor(sharpener, `f${i}`));
    for (const e of all) { sharpener.want(e, {}); t.fire(); await flush(); }
    expect(all[0]!.full).toBeNull();
    sharpener.want(all[0]!, {});
    t.fire();
    await flush();
    expect(all[0]!.full).not.toBeNull();
  });

  it('a failed decode stays a preview, and is not retried on every draw', async () => {
    const t = timers();
    const refresh = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decodeFull = vi.fn(async () => { throw new Error('no'); });
    const sharpener = new Sharpener({ decodeFull, refresh, ...t });
    const e = entryFor(sharpener, 'a');
    sharpener.want(e, {});
    t.fire();
    await flush();
    sharpener.want(e, {});
    t.fire();
    await flush();
    warn.mockRestore();
    expect(decodeFull).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(e.full).toBeNull();
  });

  it('dispose lets go of what it holds and refreshes nothing afterwards', async () => {
    const t = timers();
    const refresh = vi.fn();
    const full = bitmap(2880);
    let finish: (b: Bitmap) => void = () => {};
    const sharpener = new Sharpener({ decodeFull: () => new Promise((r) => { finish = r; }), refresh, ...t });
    const e = entryFor(sharpener, 'a');
    sharpener.want(e, {});
    t.fire();
    await flush();
    sharpener.dispose();
    finish(full);
    await flush();
    expect(full.closed).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('works again after an effect replay', async () => {
    const t = timers();
    const decodeFull = vi.fn(async () => bitmap(2880));
    const sharpener = new Sharpener({ decodeFull, refresh: () => {}, ...t });
    sharpener.dispose();
    sharpener.start();
    const e = entryFor(sharpener, 'a');
    sharpener.want(e, {});
    t.fire();
    await flush();
    expect(e.full).not.toBeNull();
  });
});

describe('a preview', () => {
  it('a decode that fails leaves the picture on its full path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blob = new Blob([new Uint8Array(4)]);
    expect(await makePreview(blob, async () => { throw new Error('no'); })).toBeNull();
    warn.mockRestore();
  });
});

describe('the decode worker', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('a worker that never answers falls back to the page and stops being used', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const posted = vi.fn();
    vi.stubGlobal('Worker', class { postMessage = posted; terminate = terminate; });
    const page = vi.fn(async () => bitmap(800));
    vi.stubGlobal('createImageBitmap', page);
    const { DECODE_TIMEOUT_MS, decodeBitmap } = await import('../../dashboard/src/components/whiteboard/pictureLod');
    const decoding = decodeBitmap(new Blob([]));
    await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS);
    await expect(decoding).resolves.toMatchObject({ width: 800 });
    expect(terminate).toHaveBeenCalledOnce();
    await decodeBitmap(new Blob([]));
    expect(posted).toHaveBeenCalledOnce();
    expect(page).toHaveBeenCalledTimes(2);
  });
});
