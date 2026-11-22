/**
 * Pictures in an owner message, as images the tool sees (TABLO row 12).
 *
 * The composer writes a picture as a `[Picture N: <path>]` line (chat-surface.ts). Claude opens
 * the path itself; Codex and Antigravity take images as turn attachments, so the bridge copies
 * each picture into T3's attachment folder and names it on the turn. The line stays in the words,
 * so the model still knows which picture the owner wrote about.
 */
import { copyFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const LINE = /^\[Picture (\d+): ('(?:[^']|'\\'')*'|[^\n\]]+)\]$/gm;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** T3's own cap (`PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`). */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PICTURES = 8;

export interface PictureAttachment {
  readonly type: 'image';
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** The picture files a message names, resolved against the project; only real image files. */
export function picturePaths(text: string, cwd: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LINE)) {
    let p = m[2]!.trim();
    if (p.startsWith("'") && p.endsWith("'")) p = p.slice(1, -1).split("'\\''").join("'");
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    if (!MIME[extname(abs).toLowerCase()]) continue;
    try {
      const st = lstatSync(abs);
      if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) continue;
    } catch { continue; }
    if (!out.includes(abs)) out.push(abs);
    if (out.length >= MAX_PICTURES) break;
  }
  return out;
}

/** Copy each picture into the attachment folder; what the turn names. A copy that fails is left out. */
export function pictureAttachments(text: string, cwd: string, attachmentsDir: string): PictureAttachment[] {
  const out: PictureAttachment[] = [];
  for (const path of picturePaths(text, cwd)) {
    const ext = extname(path).toLowerCase();
    const id = `dc-pic-${randomUUID().replace(/-/g, '')}`;
    try {
      mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });
      copyFileSync(path, join(attachmentsDir, `${id}${ext === '.jpeg' ? '.jpg' : ext}`));
      out.push({ type: 'image', id, name: basename(path).slice(0, 255), mimeType: MIME[ext]!, sizeBytes: lstatSync(path).size });
    } catch { /* left out: the line still names the path */ }
  }
  return out;
}

/** A bare path line (a Telegram drop, a pasted drop path) or an element chip's `picture: <path>`. */
const BARE_LINE = /^(?:picture:\s*)?(\/[^\n]+?)\s*$/gim;

/**
 * S3 (plan iyilesme-360): is `abs` a picture he sent that may ride to a child? A regular file (no
 * symlink), an image extension, at most 10 MiB, its real path inside `<contextRoot>/tmp/agent-drops/`.
 * Run at intake and again just before the copy. Never throws.
 */
export function ownerPictureOk(abs: string, contextRoot: string): boolean {
  try {
    if (!isAbsolute(abs) || !MIME[extname(abs).toLowerCase()]) return false;
    const st = lstatSync(abs);
    if (!st.isFile() || st.isSymbolicLink() || st.size === 0 || st.size > MAX_BYTES) return false;
    const drops = realpathSync(join(contextRoot, 'tmp', 'agent-drops'));
    return realpathSync(abs).startsWith(drops + sep);
  } catch { return false; }
}

/**
 * C8: the pictures an owner message carries, for a Super job (`[Picture N: …]` lines, bare path
 * lines and `picture: <path>` chips), each passing {@link ownerPictureOk}; at most 8, in order.
 * `picturePaths` (Codex, Antigravity attachments) is unchanged. Never throws.
 */
export function ownerPicturePaths(text: string, contextRoot: string): string[] {
  const out: string[] = [];
  if (typeof text !== 'string' || !contextRoot) return out;
  const cands: string[] = [];
  for (const m of text.matchAll(LINE)) {
    let p = m[2]!.trim();
    if (p.startsWith("'") && p.endsWith("'")) p = p.slice(1, -1).split("'\\''").join("'");
    cands.push(isAbsolute(p) ? p : resolve(dirname(contextRoot), p));
  }
  for (const m of text.matchAll(BARE_LINE)) cands.push(m[1]!.trim());
  for (const abs of cands) {
    if (out.length >= MAX_PICTURES) break;
    if (!out.includes(abs) && ownerPictureOk(abs, contextRoot)) out.push(abs);
  }
  return out;
}
