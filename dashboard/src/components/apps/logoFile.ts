/**
 * The owner's logo pick, before upload. An SVG is drawn HERE into a 1024 PNG: a browser draws an
 * SVG opened as an image with no script and no outside resource (the image security mode), so
 * the server only ever takes PNG or JPEG and never parses or renders SVG (owner decision
 * 2026-11-09, after a server-side SVG filter was broken three review rounds running).
 */

export const LOGO_SIZE = 1024;

export function isSvgFile(file: File): boolean {
  return file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
}

/** The SVG centred in a transparent 1024 square, as a PNG file. Rejects when it cannot be drawn. */
export async function svgToPng(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((done, fail) => {
      img.onload = () => done();
      img.onerror = () => fail(new Error('This SVG could not be drawn.'));
      img.src = url;
    });
    const w = img.naturalWidth || LOGO_SIZE;
    const h = img.naturalHeight || LOGO_SIZE;
    const scale = Math.min(LOGO_SIZE / w, LOGO_SIZE / h);
    const canvas = document.createElement('canvas');
    canvas.width = LOGO_SIZE;
    canvas.height = LOGO_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This SVG could not be drawn.');
    ctx.drawImage(img, (LOGO_SIZE - w * scale) / 2, (LOGO_SIZE - h * scale) / 2, w * scale, h * scale);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
    if (!blob) throw new Error('This SVG could not be drawn.');
    return new File([blob], `${file.name.replace(/\.svg$/i, '') || 'logo'}.png`, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
