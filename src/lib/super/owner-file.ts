import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BOARD_EXT_RE } from './board-ref.js';

/**
 * Which card a project file makes when the OWNER names it (`POST /api/super/open { path }`, task
 * sahip-super-sahnesinde-…). The agent names a kind and a project-relative ref; the owner's window
 * has a file from a picker or a page list, often absolute, so the mapping lives here, once.
 *
 * The answer is only what the agent could have asked for: a kind and a ref that the agent's own
 * `open` then validates. Nothing here widens a rule. A plain `.md` has no card, and a `.html` with
 * a space in its name is refused because the web card's rule refuses it (`web-url.ts`).
 *
 * Both sides are resolved with `realpath` first, so a symlink cannot walk out of the project and
 * the ref is the file's real project-relative path.
 */

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
export const PDF_EXT_RE = /\.pdf$/i;
/** The clips the window's player takes (`MEDIA_KIND_BY_EXT` video in chatEntities.ts). */
export const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm)$/i;
const HTML_EXT_RE = /\.html?$/i;

export type OwnerFileKind = 'web' | 'pdf' | 'image' | 'video' | 'board';
export type OwnerFileRefusal = 'outside_project' | 'unknown_file' | 'not_a_file' | 'unsupported_file' | 'file_name_space';
export type OwnerFileTarget = { kind: OwnerFileKind; ref: string } | { error: OwnerFileRefusal };

export function ownerFileTarget(projectRoot: string, raw: string): OwnerFileTarget {
  let root: string;
  let real: string;
  try {
    root = realpathSync.native(projectRoot);
    real = realpathSync.native(isAbsolute(raw) ? raw : join(projectRoot, raw));
  } catch { return { error: 'unknown_file' }; }
  const rel = relative(root, real);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { error: rel ? 'outside_project' : 'not_a_file' };
  }
  let isFile: boolean;
  try { isFile = statSync(real).isFile(); } catch { return { error: 'unknown_file' }; }
  if (!isFile) return { error: 'not_a_file' };
  const ref = rel.split(sep).join('/');
  if (BOARD_EXT_RE.test(ref)) return { kind: 'board', ref };
  if (HTML_EXT_RE.test(ref)) return /\s/.test(ref) ? { error: 'file_name_space' } : { kind: 'web', ref };
  if (PDF_EXT_RE.test(ref)) return { kind: 'pdf', ref };
  if (IMAGE_EXT_RE.test(ref)) return { kind: 'image', ref };
  if (VIDEO_EXT_RE.test(ref)) return { kind: 'video', ref };
  return { error: 'unsupported_file' };
}
