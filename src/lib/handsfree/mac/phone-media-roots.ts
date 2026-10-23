/**
 * Which pictures OUTSIDE the project a hands-free phone may see, and which it may never see
 * (task hands-free-phone-shows-every-picture…, D1; owner 2026-10-23).
 *
 * The Super Agent's pictures almost never live in the brain project it runs in: they sit in its
 * children's worktrees (`~/.claude-worktrees/…`), in the linked code repo, or in `/tmp`. The
 * phone used to refuse every one of them. Three answers now, decided on REAL paths:
 *
 *   • `auto`   — under the request project's own worktrees, one of its OWN linked repos (its
 *                link config, never the machine-wide map) or one of THEIR worktrees: shown;
 *   • `ask`    — anywhere else: the phone may show it after a one-tap grant for that file;
 *   • `other`  — inside a registered project the owner did NOT choose at start, its worktrees,
 *                or a repo only it links: refused outright, no card, no grant. Checked FIRST,
 *                so a chosen linked root that CONTAINS an unchosen project (a monorepo) cannot
 *                auto-serve it. The closest root decides (a project nested in another belongs
 *                to the inner one), and a repo both a chosen and an unchosen project link
 *                belongs to the chosen one.
 *
 * Read server-side only, never from the client. The roots are rebuilt at most every 30 s, one
 * build in flight per (project, chosen set), so a worktree created after start counts and a
 * transcript with thirty pictures costs one `git worktree list` per repo, not thirty.
 *
 * A root that is too broad (`/`, the home folder or a parent of it) never auto-serves: a linked
 * repo registered there would otherwise show the whole disk without asking.
 */

import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { listVaults } from '../../vaults.js';
import { resolveLinkedRepos } from '../../linked-repos.js';
import { listedWorktrees } from '../../super/worktrees.js';

export type PhoneMediaVerdict = 'auto' | 'ask' | 'other';

interface Owned { path: string; chosen: boolean }

export interface PhoneMediaRoots {
  /** Real paths the phone may read media under without asking. */
  auto: readonly string[];
  /** Every registered project's roots (root, worktrees, linked repos and theirs), real paths. */
  owners: readonly Owned[];
}

/** How long one build of the roots is reused. */
export const PHONE_MEDIA_ROOTS_TTL_MS = 30_000;

const realOf = async (p: string): Promise<string | null> => {
  try { return await realpath(p); } catch { return null; }
};

/** `p` is `root` itself or lies under it (both real paths). */
export function isWithin(p: string, root: string): boolean {
  if (p === root) return true;
  return p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** `/`, the home folder, or any folder that contains it. */
export function isTooBroad(root: string, home: string = homedir()): boolean {
  if (root === sep || root === dirname(root)) return true;
  return isWithin(home, root);
}

/** A repo's root plus every worktree git lists for it, as real paths. A path that is not a git
 *  repo is just itself. */
async function repoAndWorktrees(path: string): Promise<string[]> {
  const out = new Set<string>();
  const r = await realOf(path);
  if (r) out.add(r);
  try {
    for (const p of await listedWorktrees(path)) {
      const rp = await realOf(p);
      if (rp) out.add(rp);
    }
  } catch { /* not a repo, or git refused: the folder alone */ }
  return [...out];
}

/** Everything one project owns: its root, its worktrees, its linked repos and their worktrees. */
async function projectFootprint(projectRoot: string, home?: string): Promise<{ root: string[]; linked: string[] }> {
  const root = await repoAndWorktrees(projectRoot);
  const linked: string[] = [];
  let repos: ReturnType<typeof resolveLinkedRepos> = [];
  try { repos = resolveLinkedRepos(projectRoot, home); } catch { /* unreadable config: none */ }
  for (const repo of repos) {
    if (!repo.present || !repo.path) continue;
    linked.push(...await repoAndWorktrees(repo.path));
  }
  return { root, linked };
}

/**
 * Build the roots for one phone request. `projectRoot`: the request project (the folder holding
 * `_dream_context/`). `chosen`: the registered names the owner chose at start.
 */
export async function buildPhoneMediaRoots(
  projectRoot: string,
  chosen: readonly string[],
  opts: { home?: string; vaults?: ReadonlyArray<{ name: string; path: string }> } = {},
): Promise<PhoneMediaRoots> {
  const home = opts.home ?? homedir();
  const vaults = opts.vaults ?? listVaults(opts.home);
  const requestReal = await realOf(projectRoot);

  const owners = new Map<string, boolean>(); // real path → chosen
  const own = (p: string, isChosen: boolean): void => {
    // A path both a chosen and an unchosen project claim (a shared linked repo) is the chosen one's.
    owners.set(p, (owners.get(p) ?? false) || isChosen);
  };
  for (const v of vaults) {
    const isChosen = chosen.includes(v.name);
    const fp = await projectFootprint(v.path, opts.home);
    for (const p of [...fp.root, ...fp.linked]) own(p, isChosen);
  }

  // The request project's own footprint, even when it is not (or not yet) in the registry.
  const mine = await projectFootprint(projectRoot, opts.home);
  for (const p of [...mine.root, ...mine.linked]) own(p, true);
  const auto = [...mine.root.filter((p) => p !== requestReal), ...mine.linked].filter((p) => !isTooBroad(p, home));

  return { auto: [...new Set(auto)], owners: [...owners].map(([path, isChosen]) => ({ path, chosen: isChosen })) };
}

/**
 * The verdict for one REAL file path. `other` wins whenever the closest owning root is an
 * unchosen project's; otherwise `auto` under an auto root, else `ask`.
 */
export function phoneMediaVerdict(realFile: string, roots: PhoneMediaRoots): PhoneMediaVerdict {
  let best: Owned | null = null;
  for (const o of roots.owners) {
    if (isWithin(realFile, o.path) && (!best || o.path.length > best.path.length)) best = o;
  }
  if (best && !best.chosen) return 'other';
  return roots.auto.some((r) => isWithin(realFile, r)) ? 'auto' : 'ask';
}

// ─── The 30 s single-flight cache ───────────────────────────────────────────

const cache = new Map<string, { at: number; roots: Promise<PhoneMediaRoots> }>();

/** The roots for (project, chosen set), built at most once per {@link PHONE_MEDIA_ROOTS_TTL_MS}. */
export function phoneMediaRoots(projectRoot: string, chosen: readonly string[], now = Date.now()): Promise<PhoneMediaRoots> {
  const key = `${projectRoot}\0${[...chosen].sort().join('\0')}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < PHONE_MEDIA_ROOTS_TTL_MS) return hit.roots;
  const roots = buildPhoneMediaRoots(projectRoot, chosen);
  cache.set(key, { at: now, roots });
  // A failed build is not cached: the next request tries again.
  roots.catch(() => { if (cache.get(key)?.roots === roots) cache.delete(key); });
  // Bounded: a handful of chosen projects, but never let a stream of keys grow it forever.
  if (cache.size > 32) cache.delete(cache.keys().next().value as string);
  return roots;
}

/** Forget every cached build (Mac mode started or stopped; tests). */
export function resetPhoneMediaRoots(): void {
  cache.clear();
}
