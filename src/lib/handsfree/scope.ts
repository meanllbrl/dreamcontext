/**
 * Which roots a trip carries (D2): the active vault root, its PRESENT linked code repos and
 * their git worktrees under HOME, plus the Claude transcript dir of each of them. Every
 * root gets a stable id ({@link rootIdFor} of its realpath) in the laptop's go manifest,
 * from which every later laptop destination is derived (AC10).
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveLinkedRepos } from '../linked-repos.js';
import { gitOut, listWorktrees, type ProcessRunner } from './git-snapshot.js';
import { encodeProjectDir, rootIdFor, type GoManifest, type RootSpec } from './manifest.js';

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

export interface TripScope {
  vaultRoot: string;
  roots: RootSpec[];
  /** Repo roots (main checkouts) with the other in-scope roots nested inside them. */
  repos: Array<{ rootId: string; path: string; nested: string[] }>;
  /** `handsfree.include` opt-ins from the vault's `.config.json`. */
  include: string[];
}

function real(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

function inside(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

async function gitTop(run: ProcessRunner, dir: string): Promise<string | null> {
  try {
    const out = (await gitOut(run, dir, ['rev-parse', '--show-toplevel'])).trim();
    return out ? real(out) : null;
  } catch {
    return null;
  }
}

/** `handsfree.include` from `<vault>/_dream_context/state/.config.json` (relative paths only). */
export function readHandsfreeInclude(vaultRoot: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(vaultRoot, '_dream_context', 'state', '.config.json'), 'utf8')) as { handsfree?: { include?: unknown } };
    const inc = raw?.handsfree?.include;
    return Array.isArray(inc) ? inc.filter((x): x is string => typeof x === 'string' && !x.startsWith('/') && !x.split('/').includes('..')) : [];
  } catch {
    return [];
  }
}

export async function computeScope(o: { run: ProcessRunner; home: string; contextRoot: string; claudeProjectsDir: string }): Promise<TripScope> {
  const home = real(o.home);
  const vaultRoot = real(dirname(o.contextRoot));
  if (!inside(home, vaultRoot)) throw new ScopeError(`the vault ${vaultRoot} is outside your home folder; hands-free mode only carries paths under HOME`);
  const roots: RootSpec[] = [];
  const repos: TripScope['repos'] = [];
  const seen = new Set<string>();

  const addRepoOrVault = async (path: string, label: string) => {
    const p = real(path);
    if (seen.has(p)) return;
    if (!inside(home, p)) throw new ScopeError(`${label} ${p} is outside your home folder`);
    const top = await gitTop(o.run, p);
    if (top && top !== p) {
      throw new ScopeError(`${label} ${p} sits inside the git repository ${top}; hands-free mode carries whole repositories only (link ${top} instead)`);
    }
    seen.add(p);
    if (!top) {
      roots.push({ rootId: rootIdFor(p), kind: 'vault', absPath: p });
      return;
    }
    const wts = (await listWorktrees(o.run, p)).filter((w) => !w.isMain && !w.bare && !w.prunable && existsSync(w.path));
    const parents = new Set<string>([join(p, '.claude', 'worktrees'), join(home, '.claude-worktrees')].map(real));
    const spec: RootSpec = { rootId: rootIdFor(p), kind: 'repo', absPath: p, allowedWorktreeParents: [] };
    roots.push(spec);
    for (const w of wts) {
      const wp = real(w.path);
      if (!inside(home, wp) || seen.has(wp)) continue;
      seen.add(wp);
      parents.add(dirname(wp));
      roots.push({ rootId: rootIdFor(wp), kind: 'worktree', absPath: wp, repoRootId: spec.rootId });
    }
    spec.allowedWorktreeParents = [...parents].sort();
  };

  await addRepoOrVault(vaultRoot, 'the vault');
  for (const r of resolveLinkedRepos(vaultRoot, o.home)) {
    if (r.present && r.path) await addRepoOrVault(r.path, `linked repo ${r.name}`);
  }
  for (const r of roots.filter((x) => x.kind === 'repo')) {
    repos.push({ rootId: r.rootId, path: r.absPath, nested: roots.filter((x) => x !== r && x.kind !== 'worktree' && inside(r.absPath, x.absPath)).map((x) => x.absPath) });
  }
  // Transcripts: the encoded dir of EVERY code root, whether or not it exists on the laptop yet
  // (smoke #6, AC5): a project never opened in Claude here has no dir, and a session started on
  // the phone must still come home. A missing dir walks as empty on both sides; Return creates
  // it (journaled `dir.ensure`) only when the cloud holds something in it. Anything that exists
  // there but is not a real directory (a link, even a dangling one) is never a root: lstat only.
  for (const r of [...roots]) {
    const dir = join(o.claudeProjectsDir, encodeProjectDir(r.absPath));
    const kind = transcriptDirKind(dir, o.claudeProjectsDir);
    if (kind === 'missing' || kind === 'dir') roots.push({ rootId: rootIdFor(dir), kind: 'transcripts', absPath: dir });
  }
  return { vaultRoot, roots, repos, include: readHandsfreeInclude(vaultRoot) };
}

/** What is at `p` itself, never following a link: nothing, a real directory, or anything else. */
export function lstatKind(p: string): 'missing' | 'dir' | 'other' {
  try {
    return lstatSync(p).isDirectory() ? 'dir' : 'other';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

/**
 * What is at a transcript dir `root`, judged against the configured Claude projects dir `base`
 * (r25). The base itself is TRUSTED and may be a link (moved to another disk; the account dirs
 * link to it): it is followed. Everything BELOW it (the encoded dir, and any segment between) is
 * checked by lstat: a link or a file there is `other`, never written through. A truly absent
 * base (under a real directory), or a missing segment below it, is `missing` (created by
 * Return); a base that is or sits under a DANGLING link is `other` (r26). A root outside the
 * base is `other`.
 */
export function transcriptDirKind(root: string, base: string): 'missing' | 'dir' | 'other' {
  const rel = relative(base, root);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'other';
  try {
    if (!statSync(base).isDirectory()) return 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'other';
    // r26: the base does not resolve. `missing` only when it, and every absent ancestor up to the
    // first one that exists, is truly absent by lstat AND that first existing ancestor is a
    // directory by stat; a dangling link anywhere there (an unmounted disk) is `other`.
    let cur = base;
    while (lstatKind(cur) === 'missing') {
      const up = dirname(cur);
      if (up === cur) return 'other';
      cur = up;
    }
    try { return statSync(cur).isDirectory() ? 'missing' : 'other'; } catch { return 'other'; }
  }
  let cur = base;
  for (const seg of rel.split(sep)) {
    cur = join(cur, seg);
    const k = lstatKind(cur);
    if (k !== 'dir') return k;
  }
  return 'dir';
}

export function goManifestFor(scope: TripScope, o: { tripId: string; laptopId: string; home: string; now?: Date }): GoManifest {
  return { version: 1, tripId: o.tripId, laptopId: o.laptopId, createdAt: (o.now ?? new Date()).toISOString(), home: real(o.home), roots: scope.roots };
}

/** Rough bytes a repo occupies once mirrored: packed + loose objects + untracked non-ignored files. */
export async function estimateRepoBytes(run: ProcessRunner, repo: string): Promise<number> {
  let bytes = 0;
  try {
    const out = await gitOut(run, repo, ['count-objects', '-v']);
    for (const l of out.split('\n')) {
      const m = /^(size|size-pack): (\d+)/.exec(l);
      if (m) bytes += Number(m[2]) * 1024;
    }
    const files = (await gitOut(run, repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
    for (const f of files) {
      try { bytes += statSync(join(repo, f)).size; } catch { /* deleted in the worktree */ }
    }
  } catch { /* estimate only */ }
  return bytes;
}

/** Size of a directory tree (no symlinks followed), for transcript roots. */
export function dirBytes(dir: string): number {
  let total = 0;
  const walkDir = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) walkDir(p);
        else if (st.isFile()) total += st.size;
      } catch { /* vanished */ }
    }
  };
  walkDir(dir);
  return total;
}
