import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { resolveAgentSession } from '../lib/agent-session-map.js';
import { readSuperState, acceptableWorktree, superWorktreeRoot } from '../lib/super/store.js';
import { isGovernedCheckout } from '../lib/session-cwd.js';
import { resolveSessionDir } from './routes/agent-shelf.js';

/**
 * The worktree a chat session works in — the one extra root `/agent/file` and `/agent/reveal`
 * may read besides the project.
 *
 * A child session (`super delegate --worktree`) runs with its cwd in its own
 * `~/.claude-worktrees/<name>`, so the paths its agent writes — `![shot](out/a.png)` or an
 * absolute `/Users/…/.claude-worktrees/<name>/out/a.png` — name files there. The file routes
 * knew only the project root: a relative path resolved against the wrong tree and an absolute
 * one counted as "outside", so the picture degraded to a chip ("this file isn't there any
 * more" + Open).
 *
 * This is a widening of ONE session's reach, so it is narrow: the directory must be the one
 * the session is registered with (the Super store's `worktree` for it, or the checkout the
 * session itself moved into), strictly directly under `~/.claude-worktrees`, a checkout of a
 * repository the vault governs, and — by its REAL path — still there and not a symlink out.
 * Anything that fails any of those is no worktree: null, and the caller keeps the
 * project-root-only rules.
 */
export async function sessionWorktreeRoot(
  contextRoot: string,
  projectRoot: string,
  session: string | null,
  opts: { home?: string } = {},
): Promise<string | null> {
  if (!session) return null;
  const home = opts.home ?? homedir();
  const ids = [...new Set([session, resolveAgentSession(contextRoot, session) || session])];

  const candidates: string[] = [];
  try {
    const state = await readSuperState(contextRoot, { home });
    for (const id of ids) {
      const wt = Object.hasOwn(state.children, id) ? state.children[id]?.worktree : undefined;
      if (wt) candidates.push(wt);
    }
  } catch { /* no readable record: the session's own checkout below may still answer */ }
  const moved = resolveSessionDir(session, projectRoot, { home });
  if (moved !== projectRoot) candidates.push(moved);

  for (const cand of candidates) {
    if (!acceptableWorktree(cand, { home }) || !isGovernedCheckout(cand, projectRoot, { home })) continue;
    try {
      if (!statSync(cand).isDirectory()) continue;
      // The REAL path must still sit directly under the real worktree home: a symlinked
      // `<name>` pointing elsewhere is not a worktree this feature created.
      const real = realpathSync.native(cand);
      const base = realpathSync.native(superWorktreeRoot(home));
      if (!real.startsWith(base + sep) || real.slice(base.length + 1).includes(sep)) continue;
      return resolve(cand);
    } catch { /* removed or unreadable — not a root */ }
  }
  return null;
}
