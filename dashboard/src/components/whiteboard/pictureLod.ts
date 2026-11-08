/**
 * A board's pictures draw from a small copy until the pixels are really needed.
 *
 * WHY, as measured on a 101-picture board of 2880×1800 PNGs (scripts/verify/whiteboard-perf.mjs):
 * panning was clean, and the freezes (1.1 s in Chromium, 2.5 s in WebKit, each time the wheel
 * rested) were `drawImage` decoding a whole picture on the main thread, for a bitmap a few
 * hundred pixels wide. All of it Excalidraw's element bitmaps, rebuilt at every new zoom.
 *
 * WHAT: `drawImage` is the only thing that changes. Excalidraw keeps the full data URL in its
 * `files`, so saving, the `.excalidraw` export, copy and paste, and the board file never see a
 * preview. Only the `Image` objects Excalidraw builds for the canvas are given one, caught while
 * `addFiles` runs (`adoptImages`): an export builds its own `Image`s, which have no preview and
 * draw at full size, so an exported picture is never soft. Any picture without a preview, or a
 * failed preview, draws as it always did.
 *
 * A destination larger than the preview shows the preview for a moment, while the full picture
 * decodes in a worker (a page-side decode blocks WebKit's main thread); then the element's bitmap
 * is rebuilt (`refresh`), sharp. Elements sharing a picture share its entry, so a copy is only
 * ever let go by the `MAX_FULL` limit, never because one element happens to fit its preview.
 *
 * No React and no Excalidraw import, so root vitest runs it against a stand-in context.
 */

/** Long edge of a preview, in pixels: a 380-wide card at 100% on a 2x screen fits. */
export const PREVIEW_EDGE = 800;
/** Full pictures held at once. A rebuilt element keeps its pixels when its copy is let go. */
export const MAX_FULL = 16;
/** The wheel has rested: Excalidraw rebuilds right after it, and those wants come as one batch. */
const SHARPEN_DELAY_MS = 180;

/** An image source that can be drawn and let go; `ImageBitmap` in the app. */
export interface Bitmap {
  width: number;
  height: number;
  close?: () => void;
}

export interface PictureEntry {
  fileId: string;
  preview: Bitmap;
  full: Bitmap | null;
  /** Could not be decoded: stays on its preview rather than asking on every draw. */
  failed: boolean;
  sharpener: Sharpener;
}

interface LodImage {
  naturalWidth: number;
  naturalHeight: number;
}

const entries = new WeakMap<object, PictureEntry>();

export function entryOf(image: object): PictureEntry | undefined {
  return entries.get(image);
}

/** Device pixels a destination size covers under a 2D transform. */
export function deviceSize(t: { a: number; b: number; c: number; d: number }, width: number, height: number): { width: number; height: number } {
  return { width: Math.abs(width) * Math.hypot(t.a, t.b), height: Math.abs(height) * Math.hypot(t.c, t.d) };
}

/** Which copy of a picture a draw should use. `soft` = the preview stands in for now. */
export function chooseCopy(
  dest: { width: number; height: number },
  source: { width: number; height: number },
  natural: { width: number; height: number },
  preview: { width: number; height: number },
  hasFull: boolean,
): 'preview' | 'full' | 'soft' {
  // What the preview holds of the part being drawn, along each axis: an element can be stretched.
  const heldWidth = source.width * (preview.width / natural.width);
  const heldHeight = source.height * (preview.height / natural.height);
  if (dest.width <= heldWidth && dest.height <= heldHeight) return 'preview';
  return hasFull ? 'full' : 'soft';
}

/**
 * The size of a preview, or null when the picture is no larger than one (it draws as it is).
 * Unknown dimensions (not a PNG) make a preview by width.
 */
export function previewSize(width: number | null, height: number | null): { resizeWidth: number; resizeHeight?: number } | null {
  if (!width || !height) return { resizeWidth: PREVIEW_EDGE };
  const edge = Math.max(width, height);
  if (edge <= PREVIEW_EDGE) return null;
  const k = PREVIEW_EDGE / edge;
  return { resizeWidth: Math.max(1, Math.round(width * k)), resizeHeight: Math.max(1, Math.round(height * k)) };
}

/** Width and height from a PNG's header, or nulls for any other bytes. */
export function pngSize(head: Uint8Array): { width: number | null; height: number | null } {
  const isPng = head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (!isPng) return { width: null, height: null };
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

type Decode = (blob: Blob, options?: ImageBitmapOptions) => Promise<Bitmap>;

/** Long past any real decode: a job past this means the worker has gone silent. */
export const DECODE_TIMEOUT_MS = 20_000;

let worker: Worker | null = null;
let workerBroken = false;
let nextJob = 0;
const jobs = new Map<number, { resolve: (b: Bitmap) => void; reject: (e: unknown) => void }>();

/** Every way a worker can fail ends here: its jobs fall back to the page and none hangs. */
function dropWorker(reason: string): void {
  workerBroken = true;
  worker?.terminate();
  worker = null;
  for (const job of jobs.values()) job.reject(new Error(reason));
  jobs.clear();
}

function decodeWorker(): Worker | null {
  if (worker || workerBroken || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./pictureDecode.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string }>) => {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (data.bitmap) job?.resolve(data.bitmap);
      else job?.reject(new Error(data.error ?? 'decode failed'));
    };
    worker.onerror = () => dropWorker('picture worker failed');
    worker.onmessageerror = () => dropWorker('picture worker sent an unreadable message');
  } catch {
    workerBroken = true;
  }
  return worker;
}

/** Decode in the worker; where there is none, on the page, which still works and only costs more. */
export const decodeBitmap: Decode = (blob, options) => {
  const w = decodeWorker();
  if (!w) return createImageBitmap(blob, options);
  return new Promise<Bitmap>((resolve, reject) => {
    const id = (nextJob += 1);
    const timer = setTimeout(() => dropWorker('picture worker went silent'), DECODE_TIMEOUT_MS);
    jobs.set(id, {
      resolve: (b) => { clearTimeout(timer); resolve(b); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    w.postMessage({ id, blob, options });
  }).catch(() => createImageBitmap(blob, options));
};

/** A picture's preview; null when it needs none or cannot have one (it then draws as it is). */
export async function makePreview(blob: Blob, decode: Decode = decodeBitmap): Promise<Bitmap | null> {
  try {
    const { width, height } = pngSize(new Uint8Array(await blob.slice(0, 24).arrayBuffer()));
    const size = previewSize(width, height);
    if (!size) return null;
    return await decode(blob, { ...size, resizeQuality: 'high' });
  } catch (err) {
    console.warn('whiteboard: no preview for a picture, it draws at full size', err);
    return null;
  }
}

/** Run `add` and hand back every `Image` built while it ran. Synchronous, so nothing else is caught. */
export function catchImages(add: () => void, host: { Image: unknown } = globalThis as never): object[] {
  const caught: object[] = [];
  const Real = host.Image as new (...args: unknown[]) => object;
  host.Image = function CaughtImage(...args: unknown[]) {
    const image = new Real(...args);
    caught.push(image);
    return image;
  };
  try {
    add();
  } finally {
    host.Image = Real;
  }
  return caught;
}

/**
 * Give the canvas's own `Image`s their previews. `images` are read by their source, once;
 * an `Image` for a file with no preview stays out of the map and draws at full size.
 */
export function adoptImages(
  images: readonly object[],
  previews: ReadonlyMap<string, { fileId: string; preview: Bitmap }>,
  sharpener: Sharpener,
): void {
  for (const image of images) {
    const src = (image as { src?: string }).src;
    const hit = src ? previews.get(src) : undefined;
    if (hit) entries.set(image, { ...hit, full: null, failed: false, sharpener });
  }
}

export interface SharpenerDeps {
  /** Decode the full picture away from the main thread. */
  decodeFull: (image: object) => Promise<Bitmap>;
  /** Rebuild these pictures' element bitmaps. */
  refresh: (fileIds: readonly string[]) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** One canvas's waiting list for full pictures. */
export class Sharpener {
  private readonly wanted = new Map<PictureEntry, object>();
  /** Oldest first. */
  private readonly held: PictureEntry[] = [];
  private timer: unknown = null;
  private running = false;
  private disposed = false;

  constructor(private readonly deps: SharpenerDeps) {}

  /** Back in service: a replayed effect (StrictMode, Fast Refresh) keeps the same instance. */
  start(): void {
    this.disposed = false;
  }

  get active(): boolean {
    return !this.disposed;
  }

  want(entry: PictureEntry, image: object): void {
    if (this.disposed || entry.failed) return;
    this.wanted.set(entry, image);
    if (this.timer !== null) return;
    const set = this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.timer = set(() => { this.timer = null; void this.run(); }, SHARPEN_DELAY_MS);
  }

  private release(entry: PictureEntry): void {
    const at = this.held.indexOf(entry);
    if (at >= 0) this.held.splice(at, 1);
    entry.full?.close?.();
    entry.full = null;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.wanted.size && !this.disposed) {
        // A chunk is rebuilt before the next one can push its copies out, and a rebuilt element
        // keeps its pixels, so no count of pictures can leave one soft or set off a loop.
        // Newest first: what the view asked for last is what is on screen.
        const chunk = [...this.wanted].slice(-MAX_FULL).reverse();
        for (const [entry] of chunk) this.wanted.delete(entry);
        const done: string[] = [];
        for (const [entry, image] of chunk) {
          if (this.disposed) break;
          if (entry.full) { done.push(entry.fileId); continue; }
          try {
            const full = await this.deps.decodeFull(image);
            if (this.disposed) { full.close?.(); break; }
            entry.full = full;
            this.held.push(entry);
            done.push(entry.fileId);
            while (this.held.length > MAX_FULL) this.release(this.held[0]!);
          } catch (err) {
            entry.failed = true;
            console.warn('whiteboard: a picture stays on its preview', err);
          }
        }
        if (done.length && !this.disposed) this.deps.refresh(done);
      }
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as never)))(this.timer);
    this.timer = null;
    this.wanted.clear();
    for (const entry of [...this.held]) this.release(entry);
  }
}

type Ctx = CanvasRenderingContext2D;
const INSTALLED = Symbol.for('dreamcontext.pictureLod');

/** Patch a 2D-context prototype's `drawImage`. Idempotent. A draw of anything else only pays one map read. */
export function installPictureLod(proto: Ctx = globalThis.CanvasRenderingContext2D?.prototype): void {
  if (!proto || (proto as unknown as Record<symbol, boolean>)[INSTALLED]) return;
  (proto as unknown as Record<symbol, boolean>)[INSTALLED] = true;
  const drawImage = proto.drawImage as (...args: unknown[]) => void;
  proto.drawImage = function (this: Ctx, ...args: unknown[]) {
    const image = args[0] as object;
    const entry = args.length === 9 ? entries.get(image) : undefined;
    if (!entry) { drawImage.apply(this, args); return; }
    const { naturalWidth, naturalHeight } = image as LodImage;
    const preview = entry.preview;
    // A picture no larger than its preview (a small JPEG, whose size is unknown beforehand).
    if (preview.width >= naturalWidth) { drawImage.apply(this, args); return; }
    const [sx, sy, sw, sh, dx, dy, dw, dh] = args.slice(1) as number[];
    const copy = chooseCopy(
      deviceSize(this.getTransform(), dw!, dh!),
      { width: sw!, height: sh! },
      { width: naturalWidth, height: naturalHeight },
      preview,
      !!entry.full,
    );
    if (copy === 'full') {
      const kx = entry.full!.width / naturalWidth;
      const ky = entry.full!.height / naturalHeight;
      drawImage.call(this, entry.full, sx! * kx, sy! * ky, sw! * kx, sh! * ky, dx, dy, dw, dh);
      return;
    }
    if (copy === 'soft') entry.sharpener.want(entry, image);
    const kx = preview.width / naturalWidth;
    const ky = preview.height / naturalHeight;
    drawImage.call(this, preview, sx! * kx, sy! * ky, sw! * kx, sh! * ky, dx, dy, dw, dh);
  } as Ctx['drawImage'];
}
