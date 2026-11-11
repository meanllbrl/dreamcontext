import { execFile } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { resolveAgentSession } from '../lib/agent-session-map.js';
import { readSuperState, listMemberSupers, superIdOfMember, superWorktreeRoot } from '../lib/super/store.js';
import { isGovernedCheckout } from '../lib/session-cwd.js';
import { gitCommonDir } from '../lib/session-facts.js';
import { resolveLinkedRepos } from '../lib/linked-repos.js';
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
  // The session's own checkout, unless it IS the project root. By REAL path: a transcript's cwd
  // is realpath'd (`/private/var/…`) while the project root may be spelled through a symlink
  // (`/var/…`), and the same folder must never read as a second candidate.
  const moved = resolveSessionDir(session, projectRoot, { home });
  if (!samePath(moved, projectRoot)) candidates.push(moved);
  return candidates;
}

/** Real path, or null when it is gone or unreadable. */
function realOf(p: string): string | null {
  try { return realpathSync.native(p); } catch { return null; }
}

/** The same folder, by REAL path (a spelling through a symlink is the same folder). */
function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const ra = realOf(a);
  return ra !== null && ra === realOf(b);
}

/** Is this REAL path directly under the REAL worktree home (`~/.claude-worktrees/<name>`)? Both
 *  sides resolved: a home under a symlinked path (`/var` → `/private/var`) is still the home. */
function underWorktreeHome(real: string, home: string): boolean {
  const base = realOf(superWorktreeRoot(home));
  return !!base && real.startsWith(base + sep) && !real.slice(base.length + 1).includes(sep);
}

/** The widening rules: registered (a candidate), an absolute normalised path, a governed checkout,
 *  still a directory, and by its REAL path directly under the REAL worktree home (a symlinked
 *  `<name>` pointing elsewhere is not a worktree this feature created). */
function acceptedWorktree(cand: string, projectRoot: string, home: string): boolean {
  if (!cand || cand.length > 1024 || cand.includes('\u0000') || resolve(cand) !== cand) return false;
  if (!isGovernedCheckout(cand, projectRoot, { home })) return false;
  try {
    if (!statSync(cand).isDirectory()) return false;
    const real = realpathSync.native(cand);
    return underWorktreeHome(real, home);
  } catch { return false; /* removed or unreadable — not a root */ }
}

// ─── The folder an owner card runs and writes in (sahip-karti-yerinde K5) ───────────────────

/** Why a card's working folder was refused: the run does not start, the secret is not written.
 *  `not_governed`: not a real worktree of any repository this project governs (its own or a
 *  linked one), by that repository's own `git worktree list`. */
export type CardRootRefusal = 'symlink' | 'missing' | 'not_governed' | 'git_failed';
export class CardRootRefused extends Error {
  readonly code: CardRootRefusal;
  constructor(code: CardRootRefusal) {
    super(`The card's working folder was refused (${code}).`);
    this.code = code;
    this.name = 'CardRootRefused';
  }
}

const run = promisify(execFile);

/** A repository's git worktrees, by real path (`git worktree list --porcelain`). */
export async function gitWorktreePaths(repoRoot: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  const out: string[] = [];
  for (const line of String(stdout).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const real = realOf(line.slice('worktree '.length));
    if (real) out.push(real);
  }
  return out;
}

/** The repositories this project governs, as a checkout to ask: the project itself, then each
 *  linked repo present on this machine (session-cwd.ts `governedCommonDirs`' set, with paths). */
function governedRepoRoots(projectRoot: string, home: string): string[] {
  const roots = [projectRoot];
  try {
    for (const repo of resolveLinkedRepos(projectRoot, home)) if (repo.path) roots.push(repo.path);
  } catch { /* a malformed config leaves the project's own repo governed */ }
  return roots;
}

/**
 * The folder an owner card of `postingSession` runs in and writes its secret under (K5, D5, and
 * the decisions of 11 Nov): the session's working folder, read at action time from the SERVER's
 * state (the Super records, the session's claimed or transcript checkout), never from a request
 * or a card. Any chat's card, a Super child's or an ordinary chat's.
 *
 * THE FOLDER IS PROVEN BY THE GOVERNED REPOSITORY, not by where it lives on disk. Every identity
 * decision compares REAL paths, so a project under a symlinked path (macOS `/var`, `/tmp`) is
 * itself.
 *
 *  - No candidate, or one whose real path IS the project's: the project root (real).
 *  - Otherwise the candidate must not be a symlink itself, must be a real directory, must share its
 *    git common dir with a repository the project GOVERNS (its own or a linked repo), and THAT
 *    repository's own `git worktree list` must name its real path. So a linked repo's main
 *    checkout passes, and so does a worktree anywhere (`~/.claude-worktrees/<x>`,
 *    `<repo>/.claude/worktrees/<x>`); a folder inside a repository that is not a worktree root,
 *    an ungoverned repository's checkout, a symlink or a folder that is gone is REFUSED
 *    ({@link CardRootRefused}): the card never silently runs somewhere else.
 *
 * `listWorktrees` is injectable for tests; the real one runs git with an argument array and a
 * timeout, against the governed repository the candidate belongs to. (The file routes'
 * {@link sessionWorktreeRoot} is a different widening and keeps its `~/.claude-worktrees` rule.)
 */
export async function cardWorkingRoot(
  contextRoot: string,
  projectRoot: string,
  postingSession: string,
  opts: { home?: string; listWorktrees?: (repoRoot: string) => Promise<string[]> } = {},
): Promise<string> {
  const home = opts.home ?? homedir();
  const realProject = realOf(projectRoot);
  if (!realProject) throw new CardRootRefused('missing');
  const candidates = postingSession ? await worktreeCandidates(contextRoot, projectRoot, postingSession, home) : [];
  if (!candidates.length) return realProject;
  const cand = candidates[0];
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(cand); } catch { throw new CardRootRefused('missing'); }
  if (st.isSymbolicLink()) throw new CardRootRefused('symlink');
  if (!st.isDirectory()) throw new CardRootRefused('missing');
  const real = realOf(cand);
  if (!real) throw new CardRootRefused('missing');
  if (real === realProject) return realProject;
  // The governed repository this checkout belongs to: the one sharing its git common dir.
  const common = gitCommonDir(real);
  if (!common) throw new CardRootRefused('not_governed');
  const repo = governedRepoRoots(realProject, home).find((r) => gitCommonDir(r) === common);
  if (!repo) throw new CardRootRefused('not_governed');
  let listed: string[];
  try {
    const raw = await (opts.listWorktrees ?? gitWorktreePaths)(repo);
    listed = raw.map((p) => realOf(p) ?? resolve(p));
  } catch { throw new CardRootRefused('git_failed'); }
  if (!listed.includes(real)) throw new CardRootRefused('not_governed');
  return real;
}
