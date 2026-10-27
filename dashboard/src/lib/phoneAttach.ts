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

/** A picked file the phone can re-encode as a photo. SVG is markup, not pixels: it goes as a file. */
export function isPhonePhoto(file: { type: string }): boolean {
  return /^image\//i.test(file.type) && !/svg/i.test(file.type);
}

export interface PhonePicks<F> {
  photos: F[];
  files: F[];
  /** Files over the cap: staged as refused chips, never uploaded. */
  tooLarge: F[];
  /** Some picks were dropped because the message already holds its maximum. */
  overCap: boolean;
}

/** Split `picked` into what to send and how, keeping at most `room` of them in pick order. */
export function splitPhonePicks<F extends { type: string; size: number }>(picked: readonly F[], room: number): PhonePicks<F> {
  const kept = picked.slice(0, Math.max(0, room));
  const out: PhonePicks<F> = { photos: [], files: [], tooLarge: [], overCap: picked.length > kept.length };
  for (const f of kept) {
    if (isPhonePhoto(f)) out.photos.push(f);
    else if (f.size > PHONE_MAX_FILE_BYTES) out.tooLarge.push(f);
    else out.files.push(f);
  }
  return out;
}

/** A file size the way a chip reads it: "812 B", "14 KB", "3.4 MB". */
export function formatFileSize(bytes: number): string {
  if (!(bytes >= 0)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
