/**
 * A picture on a board keeps its own pixels in dark mode, in every engine.
 *
 * WHY this exists: `@excalidraw/excalidraw` 0.18 draws dark mode by putting a CSS filter,
 * `invert(93%) hue-rotate(180deg)`, on the whole canvas. To keep a picture from being
 * inverted with everything else, it pre-inverts each raster image while drawing it, by setting
 * `context.filter = "invert(100%) hue-rotate(180deg) saturate(1.25)"` on the 2D context.
 * WebKit — the desktop app's engine — has no `CanvasRenderingContext2D.filter`: the assignment
 * is a silent no-op, so every screenshot on a board came out inverted in dark mode (a dark
 * UI shot turned light, a light one turned dark) while Chromium looked fine (2026-10-30).
 *
 * Fix, only in an engine without `context.filter`: own that one filter value. When Excalidraw
 * sets its image pre-inversion filter, the picture is drawn from a COPY of its source whose
 * pixels were rewritten once with the exact inverse of the canvas's dark-mode CSS filter, in
 * plain JS. The map is per channel and linear, so compensating the source and then scaling it
 * shows the same pixels as scaling and then compensating. An engine that has `context.filter`
 * (Chromium) keeps Excalidraw's own GPU path untouched: it is already right to the eye and far
 * cheaper.
 *
 * WHY the source and not the drawn pixels (2026-11-12, measured in WKWebView, dark mode): the
 * first version rewrote the pixels just painted, which are the picture's cached element bitmap.
 * Excalidraw rebuilds that bitmap at every zoom settle at element size × zoom × screen density,
 * up to 16.7 MP, so between 200 % and 800 % each settle read, rewrote and wrote back up to
 * 16.7 MP on the main thread: a 250-320 ms freeze per pinch on a picture. The copy costs the
 * source's size once (a preview, or a full picture while it is held) and then nothing per zoom.
 *
 * The limit, stated: the canvas filter can only output 7 %–93 % of each channel, so in dark
 * mode a picture's pure white shows as #ededed and pure black as #121212 (the canvas's own
 * white and black do the same); every mid-tone is exact. Transparent pixels stay transparent:
 * a picture's own see-through corners and backgrounds show the board behind them, as in light.
 * Every other filter value, and every other canvas in the app, is passed through untouched.
 */

/** The value Excalidraw 0.18 assigns before drawing a raster image in dark mode. */
export const EXCALIDRAW_IMAGE_FILTER = 'invert(100%) hue-rotate(180deg) saturate(1.25)';

/** `invert(93%)`, the first half of Excalidraw's dark-mode canvas filter (THEME_FILTER). */
const INVERT_AMOUNT = 0.93;

/** `hue-rotate(180deg)` as the Filter Effects spec defines it (cos = -1, sin = 0). */
const HUE_ROTATE_180: readonly (readonly number[])[] = [
  [0.213 - 0.787, 0.715 + 0.715, 0.072 + 0.072],
  [0.213 + 0.213, 0.715 - 0.285, 0.072 + 0.072],
  [0.213 + 0.213, 0.715 + 0.715, 0.072 - 0.928],
];

function invert3(m: readonly (readonly number[])[]): number[][] {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/**
 * The canvas shows `hueRotate(invert93(p))`, with invert93(p) = 0.93 - 0.86·p. For an original
 * colour o we want p with that equal to o: q = hueRotate⁻¹(o), p = (0.93 - q) / 0.86.
 * Folded into one affine map per channel: p = OFFSET - Σ K[c][j]·o[j] (0..255 space).
 */
const SPAN = 2 * INVERT_AMOUNT - 1; // 0.86
const K = invert3(HUE_ROTATE_180).map((row) => row.map((v) => v / SPAN));
const OFFSET = (INVERT_AMOUNT / SPAN) * 255;

/** Rewrite RGBA pixels in place so the dark-mode canvas filter shows them as they were. */
export function compensateForDarkCanvas(data: Uint8ClampedArray): void {
  const [k0, k1, k2] = K;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Uint8ClampedArray rounds and clamps on write.
    data[i] = OFFSET - (k0[0] * r + k0[1] * g + k0[2] * b);
    data[i + 1] = OFFSET - (k1[0] * r + k1[1] * g + k1[2] * b);
    data[i + 2] = OFFSET - (k2[0] * r + k2[1] * g + k2[2] * b);
  }
}

interface CtxState { on: boolean; stack: boolean[] }
type Ctx = CanvasRenderingContext2D;
type Draw = (...args: unknown[]) => void;

const INSTALLED = Symbol.for('dreamcontext.excalidrawImageTheme');

/** The pixel size of an image source, or null when it has none yet (an unloaded image). */
export function sourceSize(src: { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }): { w: number; h: number } | null {
  const w = src.naturalWidth || src.width || 0;
  const h = src.naturalHeight || src.height || 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Make a dark-compensated copy of `src` at its own pixel size, drawn with the engine's own
 * `drawImage` (never a patched one, so no picture swaps in a smaller copy). Null when it cannot
 * be read back: a cross-origin picture taints the canvas.
 */
export type CompensatedCopyMaker = (src: object, rawDraw: Draw) => CanvasImageSource | null;

const canvasCopy: CompensatedCopyMaker = (src, rawDraw) => {
  const size = sourceSize(src as never);
  if (!size || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    rawDraw.call(ctx, src, 0, 0);
    const img = ctx.getImageData(0, 0, size.w, size.h);
    compensateForDarkCanvas(img.data);
    ctx.putImageData(img, 0, 0);
    return canvas;
  } catch {
    return null;
  }
};

/**
 * Patch a 2D-context prototype (the real one in the app, a stand-in in tests) when its engine
 * has no `filter`. Idempotent; a no-op where `filter` exists. Only the exact
 * EXCALIDRAW_IMAGE_FILTER value changes behaviour.
 */
export function installImageThemeShim(
  proto: Ctx = globalThis.CanvasRenderingContext2D?.prototype,
  makeCopy: CompensatedCopyMaker = canvasCopy,
): void {
  if (!proto || (proto as unknown as Record<symbol, boolean>)[INSTALLED]) return;
  if (Object.getOwnPropertyDescriptor(proto, 'filter')?.set) return; // the engine does it itself
  (proto as unknown as Record<symbol, boolean>)[INSTALLED] = true;

  const states = new WeakMap<Ctx, CtxState>();
  const stateOf = (ctx: Ctx): CtxState => {
    let s = states.get(ctx);
    if (!s) { s = { on: false, stack: [] }; states.set(ctx, s); }
    return s;
  };
  // Without a native accessor a plain assignment only ever made an expando on the instance;
  // `plain` keeps any other value readable back the same way.
  const plain = new WeakMap<Ctx, string>();

  Object.defineProperty(proto, 'filter', {
    configurable: true,
    enumerable: true,
    get(this: Ctx) {
      return stateOf(this).on ? EXCALIDRAW_IMAGE_FILTER : (plain.get(this) ?? 'none');
    },
    set(this: Ctx, value: string) {
      const s = stateOf(this);
      s.on = value === EXCALIDRAW_IMAGE_FILTER;
      plain.set(this, s.on ? 'none' : value);
    },
  });

  const save = proto.save;
  const restore = proto.restore;
  proto.save = function (this: Ctx) {
    const s = stateOf(this);
    s.stack.push(s.on);
    return save.call(this);
  };
  proto.restore = function (this: Ctx) {
    const s = stateOf(this);
    if (s.stack.length) s.on = s.stack.pop()!;
    return restore.call(this);
  };

  // One copy per source object, let go with it: a full picture the sharpener releases takes its
  // copy along. `null` = it could not be made (tainted), so it is never tried again.
  const copies = new WeakMap<object, CanvasImageSource | null>();
  const drawImage = proto.drawImage as Draw;
  proto.drawImage = function (this: Ctx, ...args: unknown[]) {
    if (!stateOf(this).on) { drawImage.apply(this, args); return; }
    const src = args[0] as object;
    let copy = copies.get(src);
    if (copy === undefined) {
      copy = sourceSize(src as never) ? makeCopy(src, drawImage) : null;
      // An unloaded image has no size yet: ask again on its next draw rather than remember a miss.
      if (copy || sourceSize(src as never)) copies.set(src, copy);
    }
    // The copy has the source's own pixel size, so every call shape (3, 5 or 9 arguments, a
    // source rect included) means the same pixels on it.
    if (copy) { drawImage.apply(this, [copy, ...args.slice(1)]); return; }
    drawImage.apply(this, args); // a tainted picture is left as drawn rather than break the board
  } as Ctx['drawImage'];
}
