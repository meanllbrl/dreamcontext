/**
 * Which project file may leave the Mac through Telegram, and how it is read (plan "Outbound files").
 *
 * Refused: a path outside every containment root (the project's realpath and its linked repos'
 * realpaths), a symlink, a hardlinked file (`nlink > 1`), anything under a `.git` folder, the
 * secret class (`SAFE_TO_GITIGNORE`: `.env*`, keys, pem, p12, credentials, id_rsa, … plus a few
 * credential dotfiles), a gitignored file outside the working folders (`ignoredButSendable`), a
 * non-regular file, a file over the upload cap. An allowed file is opened O_NOFOLLOW and sent from that fd, whose
 * fstat must be the file that was classified (no swap between check and read).
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { SAFE_TO_GITIGNORE } from '../secret-files.js';
import { TG_UPLOAD_MAX_BYTES } from './contract.js';
import { realPath } from '../real-path.js';

export type OutboundRefusal =
  | 'not_absolute' | 'missing' | 'symlink' | 'not_file' | 'hardlink' | 'outside_root'
  | 'git_dir' | 'secret_class' | 'gitignored' | 'too_large' | 'changed' | 'not_media';

/** Credential files `SAFE_TO_GITIGNORE` does not name (it is about one-click gitignoring). */
const EXTRA_SECRET = /(^|\/)(\.netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|[^/]*\.kdbx|[^/]*\.ovpn)$|(^|\/)\.(ssh|gnupg|aws|docker)\//i;

export interface ClassifyOptions {
  /** Containment roots: the project root and its linked repos (realpath'ed here). */
  roots: readonly string[];
  /**
   * Roots where only a MEDIA file may leave (a picture, clip or PDF whose bytes are what its name
   * says, `mediaMagicOk`), the git-ignore rule not applied: the folders a Super shows the owner
   * pictures from that are not the project (owner 2026-11-13, "telegramdan attıklarını"): its linked
   * repos, every git worktree of the project and of those repos, the OS temp folder. Every other
   * rule (symlink, hardlink, `.git`, the secret class, the size cap, containment by realpath) applies.
   */
  mediaRoots?: readonly string[];
  /** The project root whose `_dream_context/tmp/` is exempt from the gitignore rule. */
  projectRoot?: string;
  /** Injectable for tests; defaults to `git check-ignore`. */
  isGitIgnored?: (root: string, rel: string) => boolean;
  maxBytes?: number;
}

export type Classified =
  | { ok: true; real: string; root: string; rel: string; size: number; dev: number; ino: number; mediaOnly?: boolean }
  | { ok: false; reason: OutboundRefusal };

/**
 * True unless git PROVES the path is not ignored (exit 1). Exit 0 (ignored), 128 (not a repo,
 * dubious ownership) and a missing git all refuse: a file leaving the Mac fails closed, unlike
 * `gitIgnoresPath`, whose callers fail toward writing an extra ignore line.
 */
export function gitIgnoredOrUnproven(cwd: string, relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (err) {
    return (err as { status?: number | null }).status !== 1;
  }
}

/** Pictures, clips and PDFs: what a Super shows on its stage. */
export const MEDIA_FILE = /\.(png|jpe?g|gif|webp|mp4|m4v|mov|webm|pdf)$/i;
/**
 * The project's own working folders, git-ignored by design (machine-local), where agents put the
 * pictures they show the owner: an app's data (`_dream_context/apps/<slug>/`, apps/data-dir.ts),
 * a task's assets (`_dream_context/state/assets/`), a child's worktree copy (`.claude/worktrees/`).
 * Owner 2026-11-11: the kitup Super opened five screenshots from its app's data on the stage
 * and Telegram got five "(Mac'te)" lines. Only MEDIA files there; everything else in them stays
 * refused, and every other rule (symlink, hardlink, `.git`, the secret class, the size cap,
 * containment by realpath) still applies first.
 */
export const IGNORED_MEDIA_HOMES: readonly string[] = ['_dream_context/apps/', '_dream_context/state/assets/', '.claude/worktrees/'];

/** A git-ignored project path that may still leave: anything under `_dream_context/tmp/`, a
 *  media file under one of `IGNORED_MEDIA_HOMES`. `rel` is the REAL path's, '/'-separated. */
export function ignoredButSendable(rel: string): boolean {
  if (rel.startsWith('_dream_context/tmp/')) return true;
  return MEDIA_FILE.test(rel) && IGNORED_MEDIA_HOMES.some((h) => rel.startsWith(h));
}

function realOrNull(p: string): string | null {
  try { return realPath(p); } catch { return null; }
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
  let mediaOnly = false;
  if (!root) {
    for (const r of opts.mediaRoots ?? []) {
      const rr = realOrNull(r);
      if (rr && rr !== sep && real.startsWith(rr + sep)) { if (!root || rr.length > root.length) root = rr; }
    }
    if (!root) return { ok: false, reason: 'outside_root' };
    if (!MEDIA_FILE.test(real)) return { ok: false, reason: 'not_media' };
    mediaOnly = true;
  }
  const rel = relative(root, real).split(sep).join('/');
  // APFS ignores case by default: `.GIT/config` IS `.git/config`.
  if (rel.split('/').some((seg) => seg.toLowerCase() === '.git')) return { ok: false, reason: 'git_dir' };
  if (SAFE_TO_GITIGNORE.test(rel) || EXTRA_SECRET.test(rel)) return { ok: false, reason: 'secret_class' };
  const projectReal = opts.projectRoot ? realOrNull(opts.projectRoot) : null;
  const working = projectReal !== null && root === projectReal && ignoredButSendable(rel);
  const ignored = opts.isGitIgnored ?? gitIgnoredOrUnproven;
  if (!mediaOnly && !working && ignored(root, rel)) return { ok: false, reason: 'gitignored' };
  const max = opts.maxBytes ?? TG_UPLOAD_MAX_BYTES;
  if (st.size > max) return { ok: false, reason: 'too_large' };
  return { ok: true, real, root, rel, size: st.size, dev: st.dev, ino: st.ino, mediaOnly };
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
    const bytes = data.subarray(0, off);
    // Outside the project only what IS a picture, clip or PDF leaves, by its bytes, not its name.
    if (c.mediaOnly && !mediaMagicOk(c.real, bytes)) return { ok: false, reason: 'not_media' };
    return { ok: true, file: { name: basename(c.real), data: bytes, rel: c.rel } };
  } finally {
    closeSync(fd);
  }
}

/** The file's first bytes are the kind its extension names (PNG, JPEG, GIF, WebP, PDF, an
 *  ISO-BMFF clip: mp4/m4v/mov, WebM). Anything else under a media-only root stays on the Mac. */
export function mediaMagicOk(name: string, b: Buffer): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const at = (off: number, hex: string): boolean => b.length >= off + hex.length / 2 && b.subarray(off, off + hex.length / 2).toString('hex') === hex;
  switch (ext) {
    case 'png': return at(0, '89504e470d0a1a0a');
    case 'jpg': case 'jpeg': return at(0, 'ffd8ff');
    case 'gif': return at(0, '474946383761') || at(0, '474946383961');
    case 'webp': return at(0, '52494646') && at(8, '57454250');
    case 'pdf': return at(0, '255044462d');
    case 'mp4': case 'm4v': case 'mov': return at(4, '66747970') || at(4, '6d6f6f76') || at(4, '77696465') || at(4, '6d646174');
    case 'webm': return at(0, '1a45dfa3');
    default: return false;
  }
}

/**
 * Why a file did not leave the Mac, in his words (owner 2026-11-11: never a bare "(Mac'te)").
 * One short clause, no path; the caller adds what HE can do where there is one (a Super's card:
 * ask it to copy the file into `_dream_context/tmp/`, `cards.ts`).
 */
export const REFUSAL_WHY: Record<OutboundRefusal, string> = {
  not_absolute: 'yolu geçersiz',
  missing: 'dosya bulunamadı, silinmiş ya da taşınmış olabilir',
  symlink: 'kısayol dosyası, güvenlik için gönderilmez; asıl dosyayı açtır',
  not_file: 'bir dosya değil',
  hardlink: 'başka bir yere bağlı dosya, güvenlik için gönderilmez',
  outside_root: 'proje klasörünün dışında',
  git_dir: 'git klasöründe, gönderilmez',
  secret_class: 'gizli dosya sayılıyor, gönderilmez',
  gitignored: 'yalnız bu Mac\'te tutulan bir klasörde',
  too_large: 'Telegram için çok büyük',
  changed: 'okunurken değişti; tekrar iste',
  not_media: 'resim, video ya da PDF değil, gönderilmez',
};

/** One line the bot shows instead of a refused file (no path beyond the base name). */
export function refusalLine(name: string, reason: OutboundRefusal): string {
  return `Mac'te: ${name} (${REFUSAL_WHY[reason]})`;
}
