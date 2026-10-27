/**
 * What the hands-free phone does with each thing picked from its attach sheet (owner 2026-10-27:
 * "handsfree de telefonda zip ve dosya da yükleyebilelim").
 *
 * A PHOTO (a raster image type the browser reports) goes the photo path: re-encoded on the phone
 * (lib/phonePhoto.ts) and sent as a small JPEG. ANYTHING ELSE — a zip, a PDF, a text file, a
 * video, an SVG — is sent as its own bytes under its own name, so the agent gets a path that
 * still reads `.zip`/`.pdf`. The Mac stores it as it came and never extracts it
 * (src/server/routes/agent-drop.ts, phone branch).
 *
 * A file over {@link PHONE_MAX_FILE_BYTES} is refused here, before a byte crosses the tunnel.
 */

/** Mirror of `PHONE_MAX_FILE_BYTES` (src/lib/handsfree/mac/photo-limits.ts); the dashboard cannot
 *  import from `src/`. tests/unit/phone-attach.test.ts fails when the two disagree. */
export const PHONE_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** How long one phone FILE may take to reach the Mac: 25 MB on a slow uplink is minutes, not the
 *  90 s a re-encoded photo gets. */
export const PHONE_FILE_UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** The photo types a phone browser decodes, so they can be re-encoded. ANY other image type (a
 *  PSD, a DNG, a TIFF, an SVG, which is markup) goes as a file: refusing it as "can't be opened"
 *  would undo the point of taking any file. */
const PHOTO_TYPE_RE = /^image\/(jpeg|pjpeg|png|webp|gif|heic|heif|avif|bmp)$/i;

/** A picked file the phone re-encodes as a photo. */
export function isPhonePhoto(file: { type: string }): boolean {
  return PHOTO_TYPE_RE.test(file.type);
}

/** How one pick is sent: re-encoded as a photo, uploaded as its bytes, or refused before upload. */
export type PhonePickRoute = 'photo' | 'file' | 'too-large' | 'empty';

export interface PhonePick<F> { file: F; route: PhonePickRoute }

/** Route `picked`, in pick order, keeping at most `room` of them; `overCap` says some were dropped. */
export function splitPhonePicks<F extends { type: string; size: number }>(picked: readonly F[], room: number): { picks: PhonePick<F>[]; overCap: boolean } {
  const kept = picked.slice(0, Math.max(0, room));
  const picks = kept.map((file): PhonePick<F> => ({
    file,
    route: isPhonePhoto(file) ? 'photo' : file.size === 0 ? 'empty' : file.size > PHONE_MAX_FILE_BYTES ? 'too-large' : 'file',
  }));
  return { picks, overCap: picked.length > kept.length };
}

/** A file size the way a chip reads it: "812 B", "14 KB", "3.4 MB". */
export function formatFileSize(bytes: number): string {
  if (!(bytes >= 0)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
