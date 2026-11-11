import { execFile } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { resolveAgentSession } from '../lib/agent-session-map.js';
import { readSuperState, acceptableWorktree, listMemberSupers, superIdOfMember, superWorktreeRoot } from '../lib/super/store.js';
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
  const candidates = await worktreeCandidates(contextRoot, projectRoot, session, home);
  for (const cand of candidates) if (acceptedWorktree(cand, projectRoot, home)) return resolve(cand);
  return null;
}

/** Every directory the session is RECORDED to work in (Super records, then its own checkout),
 *  before any check. */
async function worktreeCandidates(contextRoot: string, projectRoot: string, session: string, home: string): Promise<string[]> {
  const ids = [...new Set([session, resolveAgentSession(contextRoot, session) || session])];

  const candidates: string[] = [];
  // Main's record, then each member Super's (plan-r10 1): a member's child has its worktree too.
  const ids2 = ['main' as const, ...(await listMemberSupers(contextRoot)).map(superIdOfMember)];
  for (const sid of ids2) {
    try {
      const state = await readSuperState(contextRoot, sid, { home });
      for (const id of ids) {
        const wt = Object.hasOwn(state.children, id) ? state.children[id]?.worktree : undefined;
        if (wt) candidates.push(wt);
      }
    } catch { /* no readable record: the session's own checkout below may still answer */ }
  }
  const moved = resolveSessionDir(session, projectRoot, { home });
  if (moved !== projectRoot) candidates.push(moved);
  return candidates;
}

/** The widening rules: registered, directly under `~/.claude-worktrees`, a governed checkout,
 *  still there, and by its REAL path not a symlink out. */
function acceptedWorktree(cand: string, projectRoot: string, home: string): boolean {
  if (!acceptableWorktree(cand, { home }) || !isGovernedCheckout(cand, projectRoot, { home })) return false;
  try {
    if (!statSync(cand).isDirectory()) return false;
    // The REAL path must still sit directly under the real worktree home: a symlinked
    // `<name>` pointing elsewhere is not a worktree this feature created.
    const real = realpathSync.native(cand);
    const base = realpathSync.native(superWorktreeRoot(home));
    return real.startsWith(base + sep) && !real.slice(base.length + 1).includes(sep);
  } catch { return false; /* removed or unreadable — not a root */ }
}

// ─── The folder an owner card runs and writes in (sahip-karti-yerinde K5) ───────────────────

/** Why a card's working folder was refused: the run does not start, the secret is not written. */
export type CardRootRefusal = 'symlink' | 'missing' | 'not_same_repo' | 'git_failed' | 'not_accepted';
export class CardRootRefused extends Error {
  readonly code: CardRootRefusal;
  constructor(code: CardRootRefusal) {
    super(`The card's working folder was refused (${code}).`);
    this.code = code;
    this.name = 'CardRootRefused';
  }
}

const run = promisify(execFile);

/** The project's git worktrees, by real path (`git worktree list --porcelain`). */
export async function gitWorktreePaths(projectRoot: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  const out: string[] = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    try { out.push(realpathSync.native(line.slice('worktree '.length))); } catch { /* listed but gone */ }
  }
  return out;
}

/**
 * The folder an owner card of `postingSession` runs in and writes its secret under (K5, D5):
 * the child's working folder, read at action time from the SERVER's state (the Super records
 * and the session's own checkout directive), never from a request or a card.
 *
 *  - No recorded worktree: the project root (realpath-resolved).
 *  - A recorded one: it must pass {@link sessionWorktreeRoot}'s rules AND be narrowed: its real
 *    path, not a symlink itself, and one of the project's own `git worktree list` entries (the
 *    same repository). A linked repo, another governed checkout, a symlink or a folder that is
 *    gone is REFUSED ({@link CardRootRefused}): the card never silently runs somewhere else.
 *
 * `listWorktrees` is injectable for tests; the real one runs git with an argument array and a
 * timeout.
 */
export async function cardWorkingRoot(
  contextRoot: string,
  projectRoot: string,
  postingSession: string,
  opts: { home?: string; listWorktrees?: (projectRoot: string) => Promise<string[]> } = {},
): Promise<string> {
  const home = opts.home ?? homedir();
  let realProject: string;
  try { realProject = realpathSync.native(projectRoot); } catch { throw new CardRootRefused('missing'); }
  const candidates = postingSession ? await worktreeCandidates(contextRoot, projectRoot, postingSession, home) : [];
  if (!candidates.length) return realProject;
  const cand = candidates[0];
  try {
    if (lstatSync(cand).isSymbolicLink()) throw new CardRootRefused('symlink');
  } catch (e) {
    if (e instanceof CardRootRefused) throw e;
    throw new CardRootRefused('missing');
  }
  if (!acceptedWorktree(cand, projectRoot, home)) throw new CardRootRefused('not_accepted');
  let real: string;
  try { real = realpathSync.native(cand); } catch { throw new CardRootRefused('missing'); }
  if (real === realProject) return realProject;
  let listed: string[];
  try {
    const raw = await (opts.listWorktrees ?? gitWorktreePaths)(realProject);
    listed = raw.map((p) => { try { return realpathSync.native(p); } catch { return resolve(p); } });
  } catch { throw new CardRootRefused('git_failed'); }
  if (!listed.includes(real)) throw new CardRootRefused('not_same_repo');
  return real;
}
