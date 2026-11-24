/**
 * An agent photo, shrunk before it is uploaded: the longest side at most {@link PHOTO_MAX_PX}.
 *
 * Faces are drawn at 18-72 px (144 on a Retina profile), yet uploads arrived as 0.5-1 MB camera
 * PNGs that every side-panel row downloaded and decoded (owner 2026-11-21). 256 px covers the
 * largest face at 2x with room to spare.
 *
 * Returned unchanged: a GIF (shrinking would drop its animation), an image already small enough,
 * and anything the browser cannot decode or encode, so the server's own type check still has the
 * last word and a failed shrink never blocks an upload.
 */
export const PHOTO_MAX_PX = 256;

export async function shrinkPhoto(file: Blob): Promise<Blob> {
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const { width, height } = bitmap;
    const scale = PHOTO_MAX_PX / Math.max(width, height);
    if (!(scale < 1)) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // WebP keeps transparency and is small; a WebView that cannot encode it hands back PNG.
    const out = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/webp', 0.9));
    return out && out.size > 0 && out.size < file.size ? out : file;
  } finally {
    bitmap.close();
  }
}
