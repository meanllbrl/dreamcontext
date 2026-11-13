/**
 * The folders outside the project a Super's picture may come from on its way to Telegram (owner
 * 2026-11-13, "telegramdan attıklarını": a child's report showed `/tmp/…/shot.png`, the stage
 * showed screenshots from a child's worktree, and the phone got nothing). Media files only
 * (`files.ts` `mediaRoots`): the project's linked repos, every git worktree git lists for the
 * project and for those repos (the children's checkouts, `~/.claude-worktrees/…`), and the OS
 * temp folder. Never `/` or the home folder itself. Read once per send; a repo git cannot list
 * adds only its own path.
 */
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { resolveLinkedRepos } from '../../lib/linked-repos.js';
import { listedWorktreesFor } from '../../lib/super/worktrees.js';

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

export async function superMediaRoots(contextRoot: string, home?: string): Promise<string[]> {
  const projectRoot = dirname(contextRoot);
  let repos: string[] = [];
  try { repos = resolveLinkedRepos(projectRoot, home).flatMap((r) => (r.present && r.path ? [r.path] : [])); } catch { repos = []; }
  let trees: string[] = [];
  try { trees = [...await listedWorktreesFor([projectRoot, ...repos])]; } catch { trees = []; }
  const broad = new Set(['/', real(home ?? homedir()) ?? '']);
  const out = new Set<string>();
  for (const p of [...repos, ...trees, '/tmp', tmpdir()]) {
    const r = real(p);
    if (r && !broad.has(r)) out.add(r);
  }
  return [...out];
}
