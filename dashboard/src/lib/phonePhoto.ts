/**
 * A photo picked on the hands-free phone, made ready to send (task hands-free-phone-shows-every-
 * picture…, D4).
 *
 * An iPhone hands over a 12-48 MP photo, often HEIC, with its GPS position in the EXIF. None of
 * that should cross a mobile connection: the photo is decoded here (the browser applies its EXIF
 * orientation), drawn at most {@link PHONE_PHOTO_MAX_EDGE} px on its long edge, and re-encoded
 * as a JPEG. That one step turns HEIC into JPEG, drops every metadata block (a canvas carries
 * pixels only, so the location never leaves the phone) and brings a photo to ~0.4-1.5 MB.
 *
 * A photo this browser cannot decode resolves null: the composer says so on its chip and never
 * sends it. The server checks the bytes again and never decodes them.
 */

export const PHONE_PHOTO_MAX_EDGE = 2560;
export const PHONE_PHOTO_QUALITY = 0.9;
export const PHONE_PHOTOS_PER_MESSAGE = 6;

/** The size a `w`×`h` picture is drawn at so its long edge is at most `max` (never enlarged). */
export function fitWithin(w: number, h: number, max: number = PHONE_PHOTO_MAX_EDGE): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** The name a prepared photo is sent under (its extension is the server's to decide anyway). */
export function jpegName(name: string): string {
  const base = (name || 'photo').replace(/\.[^./]+$/, '') || 'photo';
  return `${base}.jpg`;
}

type Drawable = { source: CanvasImageSource; w: number; h: number; done: () => void };

/** Decode `file` with its EXIF orientation applied, or null. */
async function decode(file: Blob): Promise<Drawable | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch { /* an older WebKit without the options bag, or a format it cannot read: try <img> */ }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    // `<img>` honours EXIF orientation (CSS `image-orientation: from-image` is the default).
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

let prepChain: Promise<unknown> = Promise.resolve();

/**
 * {@link preparePhonePhoto}, ONE AT A TIME. A decoded 24 MP photo is ~96 MB before it is
 * shrunk; six decoded together is past what an iPhone tab may hold, and WebKit then reloads the
 * page and the draft with it. The uploads that follow still run in parallel.
 */
export function preparePhonePhotoQueued(file: Blob): Promise<Blob | null> {
  const run = prepChain.then(() => preparePhonePhoto(file));
  prepChain = run.catch(() => null);
  return run;
}

/** How many phone photos upload at once: the server's per-device gate (photo-limits.ts). */
export const PHONE_PHOTO_UPLOADS_AT_ONCE = 2;
let uploading = 0;
const waiting: Array<() => void> = [];

/**
 * Run one upload when a slot is free. The Mac takes two photos in flight per device and refuses
 * the third (429), so six photos picked at once go two at a time instead of four failing.
 */
export async function withPhotoUploadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (uploading >= PHONE_PHOTO_UPLOADS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  uploading += 1;
  try { return await fn(); } finally {
    uploading -= 1;
    waiting.shift()?.();
  }
}

/** The JPEG to send for a picked photo, or null when this browser cannot decode it. */
export async function preparePhonePhoto(file: Blob): Promise<Blob | null> {
  const pic = await decode(file);
  if (!pic) return null;
  try {
    const { w, h } = fitWithin(pic.w, pic.h);
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(pic.source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHONE_PHOTO_QUALITY));
    // Free the canvas's backing store at once: WebKit on a phone counts it against a tight cap.
    canvas.width = 0;
    canvas.height = 0;
    return blob && blob.size > 0 ? blob : null;
  } catch {
    return null;
  } finally {
    pic.done();
  }
}
