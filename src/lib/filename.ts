import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

/**
 * Reduce an arbitrary, possibly-hostile filename to a safe basename written inside an
 * upload dir. Strips any path (separators / `../`), drops leading dots, keeps only
 * `[\w.\-]`, and falls back to a random name when nothing usable survives. Always
 * carries an extension (the caller's `ext` when the original lacks one).
 *
 * Shared by the agent terminal drop (`POST /api/agent/drop`) and task attachments
 * (`POST /api/tasks/:slug/assets`).
 */
export function sanitizeDropFilename(raw: string, ext: string): string {
  let base = '';
  try { base = basename(String(raw ?? '').replace(/\\/g, '/').trim()); } catch { base = ''; }
  base = base.replace(/^\.+/, '');            // no leading dots → no hidden/dotfiles, no '..'
  const safe = base.replace(/[^\w.\-]/g, '_'); // collapse anything outside the allow-list
  if (!safe || !/[A-Za-z0-9]/.test(safe)) return `${randomUUID()}${ext}`;
  // Guarantee a sensible extension so the written file is openable by type.
  return /\.[A-Za-z0-9]+$/.test(safe) ? safe : `${safe}${ext}`;
}
