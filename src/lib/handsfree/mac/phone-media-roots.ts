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
import { realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
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
  /** Git could not list some registered repo's worktrees, so an unchosen project's worktree may
   *  be missing from `owners`: nothing outside the auto roots is offered then (fail closed). */
  degraded?: boolean;
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

/** A repo's root plus every worktree git lists for it, as real paths. A folder with no `.git`
 *  is just itself; a repo git cannot list is flagged `failed` (its worktrees are unknown). */
async function repoAndWorktrees(path: string): Promise<{ paths: string[]; failed: boolean }> {
  const out = new Set<string>();
  const r = await realOf(path);
  if (r) out.add(r);
  let failed = false;
  try {
    const listed = await listedWorktrees(path);
    // Only a repo's own top (or one of its worktrees) owns the repo's worktrees: git lists the
    // ENCLOSING repo's from any subfolder, and a project registered in a subfolder of a monorepo
    // must not claim the whole repo (transcript-locate.ts buildOwnerCandidates keeps the same rule).
    if (r && [...listed].some((p) => p === path || p === r)) {
      for (const p of listed) {
        const rp = await realOf(p);
        if (rp) out.add(rp);
      }
    }
  } catch {
    // Not a repo: the folder alone. A repo whose listing failed (git missing from PATH, a
    // "dubious ownership" refusal, a timeout): its worktrees are unknown, so say so.
    failed = await stat(join(path, '.git')).then(() => true, () => false);
  }
  return { paths: [...out], failed };
}

/** Everything one project owns: its root and worktrees, its linked repos and theirs. */
async function projectFootprint(projectRoot: string, home?: string): Promise<{ root: string[]; linked: string[]; failed: boolean }> {
  const own = await repoAndWorktrees(projectRoot);
  let failed = own.failed;
  const linked: string[] = [];
  let repos: ReturnType<typeof resolveLinkedRepos> = [];
  try { repos = resolveLinkedRepos(projectRoot, home); } catch { /* unreadable config: none */ }
  for (const repo of repos) {
    if (!repo.present || !repo.path) continue;
    const r = await repoAndWorktrees(repo.path);
    linked.push(...r.paths);
    failed ||= r.failed;
  }
  return { root: own.paths, linked, failed };
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

  // A PROJECT's own root and worktrees belong to it, whoever else links the folder; only a
  // linked repo that a chosen and an unchosen project both link is the chosen one's.
  const projects = new Map<string, boolean>(); // real path → chosen
  const linked = new Map<string, boolean>();
  const claim = (m: Map<string, boolean>, p: string, isChosen: boolean): void => { m.set(p, (m.get(p) ?? false) || isChosen); };
  let degraded = false;
  // Every project at once: one slow volume must not serialise the rest.
  const prints = await Promise.all(vaults.map(async (v) => ({ isChosen: chosen.includes(v.name), fp: await projectFootprint(v.path, opts.home) })));
  for (const { isChosen, fp } of prints) {
    for (const p of fp.root) claim(projects, p, isChosen);
    for (const p of fp.linked) claim(linked, p, isChosen);
    degraded ||= fp.failed;
  }

  // The request project's own footprint, even when it is not (or not yet) in the registry.
  const mine = await projectFootprint(projectRoot, opts.home);
  for (const p of mine.root) claim(projects, p, true);
  for (const p of mine.linked) claim(linked, p, true);
  degraded ||= mine.failed;

  const owners = new Map<string, boolean>(linked);
  for (const [p, isChosen] of projects) owners.set(p, isChosen);
  // A linked root that IS an unchosen project's root never auto-serves.
  const auto = [...mine.root.filter((p) => p !== requestReal), ...mine.linked]
    .filter((p) => !isTooBroad(p, home) && owners.get(p) !== false);

  return {
    auto: [...new Set(auto)],
    owners: [...owners].map(([path, isChosen]) => ({ path, chosen: isChosen })),
    ...(degraded ? { degraded: true } : {}),
  };
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
  if (roots.auto.some((r) => isWithin(realFile, r))) return 'auto';
  // Some project's worktrees could not be listed: an unknown file might be inside one.
  return roots.degraded ? 'other' : 'ask';
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
