/**
 * A picture on a board keeps its own pixels in dark mode (2026-10-30): Excalidraw 0.18 counters
 * its dark-mode canvas filter for images through `CanvasRenderingContext2D.filter`, which WebKit
 * (the desktop app) does not have, so every screenshot came out inverted. The shim in
 * `dashboard/src/lib/excalidrawImageTheme.ts` takes that one filter value over (only where the
 * engine lacks ctx.filter) and draws the picture from a copy of its SOURCE compensated once with
 * the exact inverse of the canvas filter, in JS (2026-11-12: compensating the drawn pixels cost
 * up to 16.7 MP of JS at every zoom settle, a 250-320 ms freeze per pinch in WKWebView).
 *
 * No DOM here: the canvas filter is modelled as the spec defines it (invert(93%), then
 * hue-rotate(180deg), each channel clamped), and the 2D context is a stand-in that records
 * what reaches the "engine".
 */
import { describe, it, expect } from 'vitest';
import {
  EXCALIDRAW_IMAGE_FILTER,
  compensateForDarkCanvas,
  installImageThemeShim,
  sourceSize,
} from '../../dashboard/src/lib/excalidrawImageTheme.js';

/** What the canvas's `invert(93%) hue-rotate(180deg)` CSS filter shows for one 0..255 pixel. */
function darkCanvasShows([r, g, b]: number[]): number[] {
  const inv = [r, g, b].map((c) => 0.93 * 255 - 0.86 * c);
  const H = [
    [-0.574, 1.43, 0.144],
    [0.426, 0.43, 0.144],
    [0.426, 1.43, -0.856],
  ];
  return H.map((row) => Math.round(Math.min(255, Math.max(0, row[0] * inv[0] + row[1] * inv[1] + row[2] * inv[2]))));
}

function throughDarkCanvas(rgb: number[], alpha = 255): number[] {
  const px = new Uint8ClampedArray([...rgb, alpha]);
  compensateForDarkCanvas(px);
  return darkCanvasShows([px[0], px[1], px[2]]);
}

describe('compensateForDarkCanvas', () => {
  it('a mid-tone picture pixel comes out of the dark canvas as it went in', () => {
    for (const c of [[128, 128, 128], [30, 31, 42], [90, 110, 160], [200, 120, 90], [60, 140, 80], [240, 240, 245].map((v) => v - 20)]) {
      const shown = throughDarkCanvas(c);
      shown.forEach((v, i) => expect(Math.abs(v - c[i])).toBeLessThanOrEqual(1));
    }
  });

  it('is NOT the plain inversion: a dark UI screenshot stays dark, a light one stays light', () => {
    expect(throughDarkCanvas([28, 30, 40]).every((v) => v < 60)).toBe(true);
    expect(throughDarkCanvas([235, 236, 240]).every((v) => v > 220)).toBe(true);
  });

  it('pure white and black land on the canvas filter\'s own limits (#ededed / #121212)', () => {
    expect(throughDarkCanvas([255, 255, 255])).toEqual([237, 237, 237]);
    expect(throughDarkCanvas([0, 0, 0])).toEqual([18, 18, 18]);
  });

  it('leaves fully transparent pixels alone (see-through stays see-through)', () => {
    const px = new Uint8ClampedArray([12, 34, 56, 0]);
    compensateForDarkCanvas(px);
    expect([...px]).toEqual([12, 34, 56, 0]);
  });
});

describe('sourceSize', () => {
  it('reads an image by its natural size, a bitmap or canvas by its size, and refuses an empty one', () => {
    expect(sourceSize({ naturalWidth: 2880, naturalHeight: 1800, width: 100, height: 60 })).toEqual({ w: 2880, h: 1800 });
    expect(sourceSize({ width: 800, height: 500 })).toEqual({ w: 800, h: 500 });
    expect(sourceSize({ naturalWidth: 0, naturalHeight: 0 })).toBeNull();
  });
});

type Rgba = number[];

/**
 * A 2D context stand-in: one RGBA row, a scalable transform, and a native-like `filter`. A source
 * is one flat colour (`rgba`); drawing it paints that colour over the destination pixels.
 */
function fakeContextClass(withNativeFilter: boolean) {
  const engineFilter: string[] = [];
  const copiesMade: object[] = [];
  class Ctx {
    canvas = { width: 4, height: 1 };
    pixels = new Uint8ClampedArray(16);
    pixelReads = 0;
    save() {}
    restore() {}
    scaleX = 1;
    getTransform() { return { a: this.scaleX, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
    drawImage(...args: unknown[]) {
      const src = args[0] as { rgba?: Rgba };
      const [dx, , dw] = (args.length >= 9 ? args.slice(5, 9) : args.slice(1, 5)) as number[];
      for (let x = dx * this.scaleX; x < (dx + dw) * this.scaleX; x++) this.pixels.set(src.rgba ?? [28, 30, 40, 255], x * 4);
    }
    getImageData(x: number, _y: number, w: number) {
      this.pixelReads += 1;
      return { data: this.pixels.slice(x * 4, (x + w) * 4) };
    }
    putImageData(img: { data: Uint8ClampedArray }, x: number) {
      this.pixels.set(img.data, x * 4);
    }
  }
  if (withNativeFilter) {
    const store = new WeakMap<object, string>();
    Object.defineProperty(Ctx.prototype, 'filter', {
      configurable: true,
      get(this: object) { return store.get(this) ?? 'none'; },
      set(this: object, v: string) { store.set(this, v); engineFilter.push(v); },
    });
  }
  // The app's copy maker draws the source with the engine's own drawImage and compensates its
  // pixels; here the same on a flat colour. A `tainted` source cannot be read back.
  const makeCopy = (src: object) => {
    const s = src as { rgba?: Rgba; naturalWidth?: number; naturalHeight?: number; tainted?: boolean };
    if (s.tainted) return null;
    const px = new Uint8ClampedArray(s.rgba ?? [28, 30, 40, 255]);
    compensateForDarkCanvas(px);
    const copy = { rgba: [...px], width: s.naturalWidth, height: s.naturalHeight };
    copiesMade.push(copy);
    return copy as unknown as CanvasImageSource;
  };
  const raw = Ctx.prototype.drawImage;
  installImageThemeShim(Ctx.prototype as unknown as CanvasRenderingContext2D, (src, rawDraw) => {
    expect(rawDraw).toBe(raw); // never a patched drawImage: a picture's smaller copy must not swap in
    return makeCopy(src);
  });
  return { Ctx, engineFilter, copiesMade };
}

const IMG = { naturalWidth: 2, naturalHeight: 1, rgba: [28, 30, 40, 255] };

describe('installImageThemeShim', () => {
  it('leaves an engine that has ctx.filter (Chromium) alone: Excalidraw\'s own GPU path stays', () => {
    const { Ctx, engineFilter } = fakeContextClass(true);
    const ctx = new Ctx() as unknown as CanvasRenderingContext2D & { pixels: Uint8ClampedArray };
    ctx.filter = EXCALIDRAW_IMAGE_FILTER;
    ctx.drawImage(IMG as unknown as CanvasImageSource, 0, 0, 1, 1);
    expect(engineFilter).toEqual([EXCALIDRAW_IMAGE_FILTER]);
    expect([...ctx.pixels.slice(0, 4)]).toEqual([28, 30, 40, 255]);
  });

  describe('engine without ctx.filter (WebKit)', () => {
    type Fake = CanvasRenderingContext2D & { pixels: Uint8ClampedArray; scaleX: number; pixelReads: number };
    let copiesMade: object[] = [];
    const make = () => {
      const made = fakeContextClass(false);
      copiesMade = made.copiesMade;
      return new made.Ctx() as unknown as Fake;
    };
    const shownAt = (px: Uint8ClampedArray, i: number) => darkCanvasShows([...px.slice(i * 4, i * 4 + 3)]);
    const near = (px: Uint8ClampedArray, i: number, rgb: number[]) =>
      shownAt(px, i).forEach((v, c) => expect(Math.abs(v - rgb[c])).toBeLessThanOrEqual(1));

    it('Excalidraw\'s image filter makes the drawn pixels compensated, so the dark canvas shows the original', () => {
      const ctx = make();
      ctx.save();
      ctx.filter = EXCALIDRAW_IMAGE_FILTER;
      expect(ctx.filter).toBe(EXCALIDRAW_IMAGE_FILTER);
      ctx.drawImage(IMG as unknown as CanvasImageSource, 1, 0, 2, 1);
      ctx.restore();
      // pixels 1..2 were drawn compensated, 0 and 3 untouched
      expect([...ctx.pixels.slice(0, 4)]).toEqual([0, 0, 0, 0]);
      expect([...ctx.pixels.slice(12, 16)]).toEqual([0, 0, 0, 0]);
      for (const i of [1, 2]) near(ctx.pixels, i, [28, 30, 40]);
    });

    it('Excalidraw\'s real call shape: 9 arguments under a scaled transform', () => {
      const ctx = make();
      ctx.scaleX = 2;
      ctx.save();
      ctx.filter = EXCALIDRAW_IMAGE_FILTER;
      ctx.drawImage(IMG as unknown as CanvasImageSource, 0, 0, 2880, 1800, 0, 0, 1, 1);
      ctx.restore();
      for (const i of [0, 1]) near(ctx.pixels, i, [28, 30, 40]);
      expect([...ctx.pixels.slice(8, 16)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('a rebuild at a new zoom costs nothing per pixel: one copy per source, the drawn pixels never read back', () => {
      const ctx = make();
      const picture = { naturalWidth: 2880, naturalHeight: 1800, rgba: [90, 110, 160, 255] };
      for (const zoom of [1, 2, 3, 4]) {
        ctx.scaleX = zoom;
        ctx.pixels.fill(0);
        ctx.save();
        ctx.filter = EXCALIDRAW_IMAGE_FILTER;
        ctx.drawImage(picture as unknown as CanvasImageSource, 0, 0, 2880, 1800, 0, 0, 1, 1);
        ctx.restore();
        near(ctx.pixels, 0, [90, 110, 160]);
      }
      expect(copiesMade).toHaveLength(1);
      expect(ctx.pixelReads).toBe(0);
    });

    it('a picture that cannot be read back (tainted) draws as it is, and is not tried again', () => {
      const ctx = make();
      const foreign = { ...IMG, tainted: true };
      for (let i = 0; i < 2; i++) {
        ctx.save();
        ctx.filter = EXCALIDRAW_IMAGE_FILTER;
        ctx.drawImage(foreign as unknown as CanvasImageSource, 0, 0, 1, 1);
        ctx.restore();
      }
      expect([...ctx.pixels.slice(0, 4)]).toEqual([28, 30, 40, 255]);
      expect(copiesMade).toHaveLength(0);
    });

    it('an image that has not loaded yet draws as it is and gets its copy once it has a size', () => {
      const ctx = make();
      const loading = { naturalWidth: 0, naturalHeight: 0, rgba: [28, 30, 40, 255] };
      ctx.save();
      ctx.filter = EXCALIDRAW_IMAGE_FILTER;
      ctx.drawImage(loading as unknown as CanvasImageSource, 0, 0, 1, 1);
      expect(copiesMade).toHaveLength(0);
      Object.assign(loading, { naturalWidth: 2, naturalHeight: 1 });
      ctx.drawImage(loading as unknown as CanvasImageSource, 0, 0, 1, 1);
      ctx.restore();
      expect(copiesMade).toHaveLength(1);
      near(ctx.pixels, 0, [28, 30, 40]);
    });

    it('restore() ends it: a later draw is left as drawn', () => {
      const ctx = make();
      ctx.save();
      ctx.filter = EXCALIDRAW_IMAGE_FILTER;
      ctx.restore();
      ctx.drawImage(IMG as unknown as CanvasImageSource, 0, 0, 1, 1);
      expect([...ctx.pixels.slice(0, 4)]).toEqual([28, 30, 40, 255]);
      expect(ctx.filter).toBe('none');
    });

    it('any other filter value reads back and changes nothing', () => {
      const ctx = make();
      ctx.filter = 'blur(2px)';
      expect(ctx.filter).toBe('blur(2px)');
      ctx.drawImage(IMG as unknown as CanvasImageSource, 0, 0, 1, 1);
      expect([...ctx.pixels.slice(0, 4)]).toEqual([28, 30, 40, 255]);
    });

    it('installs once', () => {
      const { Ctx } = fakeContextClass(false);
      const draw = Ctx.prototype.drawImage;
      installImageThemeShim(Ctx.prototype as unknown as CanvasRenderingContext2D);
      expect(Ctx.prototype.drawImage).toBe(draw);
    });
  });
});
