/**
 * A picture on a board keeps its own pixels in dark mode (2026-10-30): Excalidraw 0.18 counters
 * its dark-mode canvas filter for images through `CanvasRenderingContext2D.filter`, which WebKit
 * (the desktop app) does not have, so every screenshot came out inverted. The shim in
 * `dashboard/src/lib/excalidrawImageTheme.ts` takes that one filter value over (only where the
 * engine lacks ctx.filter) and rewrites the drawn pixels with the exact inverse of the canvas
 * filter, in JS.
 *
 * No DOM here: the canvas filter is modelled as the spec defines it (invert(93%), then
 * hue-rotate(180deg), each channel clamped), and the 2D context is a stand-in that records
 * what reaches the "engine".
 */
import { describe, it, expect } from 'vitest';
import {
  EXCALIDRAW_IMAGE_FILTER,
  compensateForDarkCanvas,
  destinationBox,
  installImageThemeShim,
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

describe('destinationBox', () => {
  it('maps the drawn rect through the transform and clips it to the canvas', () => {
    const t = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 5 };
    expect(destinationBox(t, 0, 0, 50, 20, 1000, 1000)).toEqual({ x: 10, y: 5, w: 100, h: 40 });
    expect(destinationBox(t, 0, 0, 50, 20, 60, 30)).toEqual({ x: 10, y: 5, w: 50, h: 25 });
    expect(destinationBox(t, 0, 0, 0, 20, 100, 100)).toBeNull();
  });

  it('covers a rotated rect with its bounding box', () => {
    const t = { a: 0, b: 1, c: -1, d: 0, e: 50, f: 0 }; // 90°
    expect(destinationBox(t, 0, 0, 30, 10, 100, 100)).toEqual({ x: 40, y: 0, w: 10, h: 30 });
  });
});

/** A 2D context stand-in: one RGBA buffer, an identity transform, and a native-like `filter`. */
function fakeContextClass(withNativeFilter: boolean) {
  const engineFilter: string[] = [];
  class Ctx {
    canvas = { width: 4, height: 1 };
    pixels = new Uint8ClampedArray(16);
    save() {}
    restore() {}
    scaleX = 1;
    getTransform() { return { a: this.scaleX, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
    drawImage(...args: number[]) {
      const [dx, , dw] = args.length >= 9 ? args.slice(5, 9) : args.slice(1, 5);
      for (let x = dx * this.scaleX; x < (dx + dw) * this.scaleX; x++) this.pixels.set([28, 30, 40, 255], x * 4);
    }
    getImageData(x: number, _y: number, w: number) {
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
  installImageThemeShim(Ctx.prototype as unknown as CanvasRenderingContext2D);
  return { Ctx, engineFilter };
}

const IMG = { naturalWidth: 2, naturalHeight: 1 };

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
    const make = () => {
      const { Ctx } = fakeContextClass(false);
      return new Ctx() as unknown as CanvasRenderingContext2D & { pixels: Uint8ClampedArray; scaleX: number };
    };
    const shownAt = (px: Uint8ClampedArray, i: number) => darkCanvasShows([...px.slice(i * 4, i * 4 + 3)]);

    it('Excalidraw\'s image filter makes the drawn pixels compensated, so the dark canvas shows the original', () => {
      const ctx = make();
      ctx.save();
      ctx.filter = EXCALIDRAW_IMAGE_FILTER;
      expect(ctx.filter).toBe(EXCALIDRAW_IMAGE_FILTER);
      ctx.drawImage(IMG as unknown as CanvasImageSource, 1, 0, 2, 1);
      ctx.restore();
      // pixels 1..2 were drawn and compensated, 0 and 3 untouched
      expect([...ctx.pixels.slice(0, 4)]).toEqual([0, 0, 0, 0]);
      expect([...ctx.pixels.slice(12, 16)]).toEqual([0, 0, 0, 0]);
      for (const i of [1, 2]) shownAt(ctx.pixels, i).forEach((v, c) => expect(Math.abs(v - [28, 30, 40][c])).toBeLessThanOrEqual(1));
    });

    it('Excalidraw\'s real call shape: 9 arguments under a scaled transform', () => {
      const ctx = make();
      ctx.scaleX = 2;
      ctx.save();
      ctx.filter = EXCALIDRAW_IMAGE_FILTER;
      ctx.drawImage(IMG as unknown as CanvasImageSource, 0, 0, 2880, 1800, 0, 0, 1, 1);
      ctx.restore();
      for (const i of [0, 1]) shownAt(ctx.pixels, i).forEach((v, c) => expect(Math.abs(v - [28, 30, 40][c])).toBeLessThanOrEqual(1));
      expect([...ctx.pixels.slice(8, 16)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
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
