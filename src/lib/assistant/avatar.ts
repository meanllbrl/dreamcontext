import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assistantProjectRoot } from './home.js';

/**
 * The assistant's avatar — one image at a FIXED name, `assets/avatar.<ext>`.
 *
 * The client never names the file: the extension comes from the MAGIC BYTES, and the
 * path is built from a whitelist and then containment-checked, so there is no filename to
 * traverse with. SVG is refused outright (it is a document that can carry script, and the
 * avatar is drawn in more than one webview). 2 MB is plenty for a face.
 */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_EXTS = ['png', 'jpg', 'webp'] as const;
export type AvatarExt = typeof AVATAR_EXTS[number];

export class AvatarError extends Error {
  constructor(public code: 'too_large' | 'bad_type' | 'empty' | 'bad_path', message: string) {
    super(message);
  }
}

/** Sniff PNG / JPEG / WebP from the first bytes. Anything else — SVG included — is null. */
export function sniffImage(buf: Buffer): AvatarExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function assistantAssetsDir(home: string = homedir()): string {
  return join(assistantProjectRoot(home), 'assets');
}

/** The one path an avatar may live at. Throws for anything outside the whitelist or the
 *  assets directory — the containment check is the backstop, not the primary guard. */
export function avatarPath(ext: string, home: string = homedir()): string {
  if (!(AVATAR_EXTS as readonly string[]).includes(ext)) throw new AvatarError('bad_path', 'not an avatar extension');
  const dir = resolve(assistantAssetsDir(home));
  const p = resolve(dir, `avatar.${ext}`);
  if (!p.startsWith(dir + sep)) throw new AvatarError('bad_path', 'avatar path escapes the assets directory');
  return p;
}

export function writeAvatar(buf: Buffer, home: string = homedir()): { ext: AvatarExt; path: string } {
  if (buf.length === 0) throw new AvatarError('empty', 'the image is empty');
  if (buf.length > AVATAR_MAX_BYTES) throw new AvatarError('too_large', 'the image is over 2 MB');
  const ext = sniffImage(buf);
  if (!ext) throw new AvatarError('bad_type', 'only PNG, JPEG or WebP images are accepted');
  const dir = assistantAssetsDir(home);
  mkdirSync(dir, { recursive: true });
  // One avatar at a time: drop the others so a format change cannot leave two.
  for (const e of AVATAR_EXTS) {
    if (e !== ext) rmSync(avatarPath(e, home), { force: true });
  }
  const path = avatarPath(ext, home);
  writeFileSync(path, buf);
  return { ext, path };
}

export function findAvatar(home: string = homedir()): { ext: AvatarExt; path: string } | null {
  const dir = assistantAssetsDir(home);
  if (!existsSync(dir)) return null;
  const names = new Set(readdirSync(dir));
  for (const ext of AVATAR_EXTS) {
    if (names.has(`avatar.${ext}`)) return { ext, path: avatarPath(ext, home) };
  }
  return null;
}
