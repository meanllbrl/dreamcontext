/**
 * Path guards for marketing-protected files. Used by the PreToolUse hook
 * to block direct edits/writes that should only happen via `mk init` or
 * the user editing `.env` manually outside an agent session.
 */
import { resolve, sep } from 'node:path';
import { resolveContextRoot } from '../context-path.js';

/**
 * Returns true if `filePath` resolves to `_dream_context/marketing/.env`
 * (anywhere walked up from cwd). Always false when no _dream_context/ exists.
 *
 * The .env file holds Meta access tokens; agents must never write it directly.
 * Setup happens via `mk init`; rotation is a manual user action.
 */
export function isMarketingEnvPath(filePath: string, from?: string): boolean {
  if (!filePath) return false;
  const root = resolveContextRoot(from);
  if (!root) return false;
  const target = resolve(root, 'marketing', '.env');
  const candidate = resolve(filePath);
  if (candidate === target) return true;
  // Also catch shell glob shenanigans: a path that ends with the protected
  // suffix even when written relatively.
  return candidate.endsWith(`${sep}marketing${sep}.env`);
}
