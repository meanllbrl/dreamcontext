/**
 * Magic-byte image identification, shared by the agent-drop upload route and the
 * GitHub task-image bridge. The header content-type is advisory; the bytes decide
 * — so we never trust a `.png` extension (or a body's `![](…)` claim) and never
 * upload a non-image file that happens to be referenced as one.
 */

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const EXT_BY_IMAGE_TYPE: Record<ImageMimeType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Identify an image by its MAGIC BYTES (not a trusted header). Returns the
 * canonical content-type, or null for anything outside the allow-list.
 */
export function sniffImageType(buf: Buffer): ImageMimeType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6
    && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'image/gif';
  if (buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
