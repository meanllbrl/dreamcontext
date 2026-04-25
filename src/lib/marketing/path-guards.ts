/**
 * Path guards for marketing-protected files. Used by the PreToolUse hook
 * to block direct edits/writes that should only happen via `mk init` or
 * the user editing `.env` manually outside an agent session.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { resolveContextRoot } from '../context-path.js';

/**
 * Returns true if `filePath` resolves to `_dream_context/marketing/.env`
 * inside the resolved `_dream_context/` root. Always false when no
 * `_dream_context/` exists.
 *
 * The .env file holds Meta access tokens; agents must never write it directly.
 * Setup happens via `mk init`; rotation is a manual user action.
 *
 * Scoped to the resolved context root to avoid false positives on unrelated
 * paths that happen to end with `marketing/.env` (e.g. /usr/local/marketing/.env).
 * Both sides are realpath'd so macOS symlinks (/var → /private/var) compare
 * equal — without this the guard rejects legitimate writes when the agent
 * passes a non-realpath'd path.
 */
export function isMarketingEnvPath(filePath: string, from?: string): boolean {
  if (!filePath) return false;
  const root = resolveContextRoot(from);
  if (!root) return false;
  const realRoot = realpathOrSelf(root);
  const target = resolve(realRoot, 'marketing', '.env');
  const realCandidate = realpathOfNearestAncestor(resolve(filePath));
  if (realCandidate === target) return true;
  // Scope: only match candidates inside the resolved context root.
  if (!realCandidate.startsWith(realRoot + sep)) return false;
  return realCandidate.endsWith(`${sep}marketing${sep}.env`);
}

function realpathOrSelf(p: string): string {
  try { return existsSync(p) ? realpathSync(p) : p; }
  catch { return p; }
}

/**
 * Realpath whatever ancestor of `p` exists, then re-attach the missing tail.
 * Lets us scope a path that doesn't exist yet (a write target) to a real
 * directory tree.
 */
function realpathOfNearestAncestor(p: string): string {
  let current = p;
  const tail: string[] = [];
  while (current && current !== sep && !existsSync(current)) {
    tail.unshift(basename(current));
    current = dirname(current);
  }
  if (!current || current === sep) return p;
  try {
    const real = realpathSync(current);
    return tail.length === 0 ? real : real + sep + tail.join(sep);
  } catch {
    return p;
  }
}
