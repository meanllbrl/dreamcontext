/**
 * The owner's own logo for an app on this Mac (owner, 2026-11-09: "config'de logo değişimi de bir
 * opsiyon olmalı"). It sits beside the app's settings, `~/.dreamcontext/apps/logo/<configId>.png|jpg`,
 * never in the app's repo or its data folder, so an update from the original never touches it and
 * neither the app nor its assistant can write it (`~/.dreamcontext/apps` is denied to both).
 *
 * The upload is typed by its bytes: PNG or JPEG only. An SVG the owner picks is drawn into a PNG
 * by the page (a browser draws an SVG opened as an image with no script and no outside resource),
 * so the server never parses or renders SVG: a server-side filter in front of QuickLook was broken
 * three review rounds running (owner decision 2026-11-09). Reading it back refuses a symlink and
 * anything whose realpath leaves the logo folder.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { sniffImageType } from '../image-sniff.js';
import { pngSize } from './png.js';
import { appsHome } from './registry.js';

/** The upload's cap: a 1024 photo-like PNG fits with room; the Dock never needs more. */
export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const CONFIG_ID_RE = /^[0-9a-f]{16,64}$/;
const EXTS = ['.png', '.jpg'] as const;

export class LogoError extends Error {
  constructor(public code: 'logo_type' | 'logo_too_large' | 'logo_empty' | 'logo_unsafe' | 'logo_bad_id', message: string) {
    super(message);
    this.name = 'LogoError';
  }
}

export function appLogoDir(home: string): string {
  return join(appsHome(home), 'logo');
}

function idOk(configId: string | undefined): configId is string {
  return typeof configId === 'string' && CONFIG_ID_RE.test(configId);
}

/** The stored logo, or null: none, a symlink, not a plain file, or outside the logo folder. */
export function appLogoPath(home: string, configId: string | undefined): string | null {
  if (!idOk(configId)) return null;
  const dir = appLogoDir(home);
  let realDir: string;
  try {
    if (lstatSync(dir).isSymbolicLink()) return null;
    realDir = realpathSync(dir);
  } catch {
    return null;
  }
  for (const ext of EXTS) {
    const p = join(dir, `${configId}${ext}`);
    try {
      const st = lstatSync(p);
      if (!st.isFile()) continue;
      const r = realpathSync(p);
      if (!r.startsWith(realDir + sep)) continue;
      return p;
    } catch { /* not this one */ }
  }
  return null;
}

/** A cache key for the card's `<img>`: changes when the logo does. */
export function appLogoStamp(path: string | null): number | null {
  if (!path) return null;
  try { return Math.round(lstatSync(path).mtimeMs); } catch { return null; }
}

/** The bytes the logo is kept as, with their extension. Throws a LogoError the owner can read. */
export function logoBytes(buf: Buffer): { data: Buffer; ext: '.png' | '.jpg' } {
  if (!buf.length) throw new LogoError('logo_empty', 'No image was received.');
  if (buf.length > MAX_LOGO_BYTES) throw new LogoError('logo_too_large', 'The logo is larger than 5 MB.');
  const type = sniffImageType(buf);
  if (type === 'image/png') {
    if (!pngSize(buf)) throw new LogoError('logo_type', 'That PNG cannot be read.');
    return { data: buf, ext: '.png' };
  }
  if (type === 'image/jpeg') return { data: buf, ext: '.jpg' };
  throw new LogoError('logo_type', 'Pick a PNG or JPG image (the Settings page turns an SVG into a PNG first).');
}

/**
 * A logo file an AGENT names (app-onay-karti D15), read once by the server into memory. Only a
 * plain file inside one of `roots` (real paths; a root's `_dream_context/tmp` is not one of them),
 * opened with O_NOFOLLOW and checked on the open handle (the same dev/inode as its realpath, a
 * regular file, at most 5 MB), PNG or JPEG by its bytes. An SVG is refused: the owner's Settings
 * page draws one into a PNG, the server never renders SVG.
 */
export function readAgentLogoFile(path: string, roots: readonly string[]): { data: Buffer; ext: '.png' | '.jpg'; type: 'image/png' | 'image/jpeg' } {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) throw new LogoError('logo_unsafe', 'Name the image by its absolute path.');
  let real: string;
  try { real = realpathSync(path); } catch { throw new LogoError('logo_unsafe', 'That file is not there.'); }
  const inside = roots.some((r) => {
    let rr: string;
    try { rr = realpathSync(r); } catch { return false; }
    const rel = relative(rr, real);
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  });
  // The brain's scratch folder is anyone's: never a source for the owner's logo.
  if (`${real}${sep}`.includes(`${sep}_dream_context${sep}tmp${sep}`)) throw new LogoError('logo_unsafe', 'The image must be inside the app, its project or its brain (not its tmp folder).');
  if (!inside) throw new LogoError('logo_unsafe', 'The image must be inside the app, its project or its brain.');
  if (/\.svgz?$/i.test(real)) throw new LogoError('logo_type', 'An SVG is not taken from an agent: convert it to PNG first.');
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new LogoError('logo_unsafe', 'That file is a link or cannot be opened.'); }
  try {
    const st = fstatSync(fd);
    const want = statSync(real);
    if (!st.isFile() || st.dev !== want.dev || st.ino !== want.ino) throw new LogoError('logo_unsafe', 'That file changed while it was read; refusing it.');
    if (st.size > MAX_LOGO_BYTES) throw new LogoError('logo_too_large', 'The logo is larger than 5 MB.');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (!n) break; off += n; }
    const head = buf.subarray(0, Math.min(buf.length, 512)).toString('utf-8').trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) throw new LogoError('logo_type', 'An SVG is not taken from an agent: convert it to PNG first.');
    const { data, ext } = logoBytes(buf.subarray(0, off));
    return { data, ext, type: ext === '.png' ? 'image/png' : 'image/jpeg' };
  } finally {
    closeSync(fd);
  }
}

function logoDirReady(home: string): string {
  const dir = appLogoDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new LogoError('logo_unsafe', 'The logo folder is a symlink; refusing it.');
  return dir;
}

/** Keep `buf` as this app's logo (temp + rename, 0600). The other format's file goes with it. */
export function setAppLogo(home: string, configId: string, buf: Buffer): string {
  if (!idOk(configId)) throw new LogoError('logo_bad_id', 'bad config id');
  const { data, ext } = logoBytes(buf);
  const dir = logoDirReady(home);
  const dest = join(dir, `${configId}${ext}`);
  try { if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest); } catch { /* none */ }
  const tmp = join(dir, `.${configId}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, dest);
  for (const other of EXTS) if (other !== ext) { try { unlinkSync(join(dir, `${configId}${other}`)); } catch { /* none */ } }
  return dest;
}

/** Back to the app's own icon. True when a logo was there. */
export function clearAppLogo(home: string, configId: string | undefined): boolean {
  if (!idOk(configId)) return false;
  let gone = false;
  for (const ext of EXTS) {
    try { unlinkSync(join(appLogoDir(home), `${configId}${ext}`)); gone = true; } catch { /* none */ }
  }
  return gone;
}
