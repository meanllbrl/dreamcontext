/**
 * Which project file may leave the Mac through Telegram, and how it is read (plan "Outbound files").
 *
 * Refused: a path outside every containment root (the project's realpath and its linked repos'
 * realpaths), a symlink, a hardlinked file (`nlink > 1`), anything under a `.git` folder, the
 * secret class (`SAFE_TO_GITIGNORE`: `.env*`, keys, pem, p12, credentials, id_rsa, … plus a few
 * credential dotfiles), a gitignored file outside `_dream_context/tmp/`, a non-regular file,
 * a file over the upload cap. An allowed file is opened O_NOFOLLOW and sent from that fd, whose
 * fstat must be the file that was classified (no swap between check and read).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { SAFE_TO_GITIGNORE } from '../secret-files.js';
import { gitIgnoresPath } from '../git-tracked.js';
import { TG_UPLOAD_MAX_BYTES } from './contract.js';

export type OutboundRefusal =
  | 'not_absolute' | 'missing' | 'symlink' | 'not_file' | 'hardlink' | 'outside_root'
  | 'git_dir' | 'secret_class' | 'gitignored' | 'too_large' | 'changed';

/** Credential files `SAFE_TO_GITIGNORE` does not name (it is about one-click gitignoring). */
const EXTRA_SECRET = /(^|\/)(\.netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|[^/]*\.kdbx|[^/]*\.ovpn)$|(^|\/)\.(ssh|gnupg|aws|docker)\//i;

export interface ClassifyOptions {
  /** Containment roots: the project root and its linked repos (realpath'ed here). */
  roots: readonly string[];
  /** The project root whose `_dream_context/tmp/` is exempt from the gitignore rule. */
  projectRoot?: string;
  /** Injectable for tests; defaults to `git check-ignore`. */
  isGitIgnored?: (root: string, rel: string) => boolean;
  maxBytes?: number;
}

export type Classified =
  | { ok: true; real: string; root: string; rel: string; size: number; dev: number; ino: number }
  | { ok: false; reason: OutboundRefusal };

function realOrNull(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

/** The verdict for one path. Pure apart from lstat/realpath and the gitignore probe. */
export function classifyOutbound(path: string, opts: ClassifyOptions): Classified {
  if (!isAbsolute(path)) return { ok: false, reason: 'not_absolute' };
  let st;
  try { st = lstatSync(path); } catch { return { ok: false, reason: 'missing' }; }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'not_file' };
  if (st.nlink > 1) return { ok: false, reason: 'hardlink' };
  const real = realOrNull(path);
  if (!real) return { ok: false, reason: 'missing' };
  let root: string | null = null;
  for (const r of opts.roots) {
    const rr = realOrNull(r);
    if (rr && (real.startsWith(rr + sep))) { if (!root || rr.length > root.length) root = rr; }
  }
  if (!root) return { ok: false, reason: 'outside_root' };
  const rel = relative(root, real).split(sep).join('/');
  if (rel.split('/').includes('.git')) return { ok: false, reason: 'git_dir' };
  if (SAFE_TO_GITIGNORE.test(rel) || EXTRA_SECRET.test(rel)) return { ok: false, reason: 'secret_class' };
  const projectReal = opts.projectRoot ? realOrNull(opts.projectRoot) : null;
  const inTmp = projectReal !== null && root === projectReal && rel.startsWith('_dream_context/tmp/');
  const ignored = opts.isGitIgnored ?? gitIgnoresPath;
  if (!inTmp && ignored(root, rel)) return { ok: false, reason: 'gitignored' };
  const max = opts.maxBytes ?? TG_UPLOAD_MAX_BYTES;
  if (st.size > max) return { ok: false, reason: 'too_large' };
  return { ok: true, real, root, rel, size: st.size, dev: st.dev, ino: st.ino };
}

export interface OutboundFile { name: string; data: Buffer; rel: string }

/** Classifies, then reads the file from an O_NOFOLLOW fd that must still be the classified file. */
export function readOutbound(path: string, opts: ClassifyOptions): { ok: true; file: OutboundFile } | { ok: false; reason: OutboundRefusal } {
  const c = classifyOutbound(resolve(path), opts);
  if (!c.ok) return c;
  let fd: number;
  try { fd = openSync(c.real, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return { ok: false, reason: 'symlink' }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.dev !== c.dev || st.ino !== c.ino) return { ok: false, reason: 'changed' };
    const max = opts.maxBytes ?? TG_UPLOAD_MAX_BYTES;
    if (st.size > max) return { ok: false, reason: 'too_large' };
    const data = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, data, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { ok: true, file: { name: basename(c.real), data: data.subarray(0, off), rel: c.rel } };
  } finally {
    closeSync(fd);
  }
}

/** One line the bot shows instead of a refused file (no path beyond the base name). */
export function refusalLine(name: string, reason: OutboundRefusal): string {
  const why: Record<OutboundRefusal, string> = {
    not_absolute: 'yol geçersiz',
    missing: 'bulunamadı',
    symlink: 'kısayol dosyası',
    not_file: 'dosya değil',
    hardlink: 'bağlı dosya',
    outside_root: 'proje dışında',
    git_dir: 'git klasöründe',
    secret_class: 'gizli dosya',
    gitignored: 'git dışı bırakılmış',
    too_large: '50 MB üstü',
    changed: 'okunurken değişti',
  };
  return `Mac'te: ${name} (${why[reason]})`;
}
