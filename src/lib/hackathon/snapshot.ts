/**
 * Team workspaces and their snapshots (plan C4, Decision 14). A team's work is its snapshots:
 * after every round the conductor mirrors the team's `repo/` tree, as bytes, into its OWN work
 * tree and commits it on `team/<team>` in its OWN repo, on top of the run's base commit.
 *
 * Never a git call with a team directory as git dir or work tree (a team could plant hooks,
 * fsmonitor or config there): the team clone is only ever read file by file, symlinks recorded
 * as links (never followed), `.git` and the recorded install paths skipped.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { conductorDir, teamWorkspace } from './run-store.js';

/** Over this a file keeps its previous version in the mirror and is listed (never dropped). */
export const SNAPSHOT_FILE_MAX = 5 * 1024 * 1024;
/** Over this the snapshot is refused with a reason. */
export const SNAPSHOT_TREE_MAX = 400 * 1024 * 1024;
export const SKIP_ALWAYS = ['.git'] as const;

/** The environment every conductor git call runs with: no user or system config. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: base.PATH, HOME: base.HOME, LANG: base.LANG, TMPDIR: base.TMPDIR,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'dreamcontext hackathon', GIT_AUTHOR_EMAIL: 'hackathon@dreamcontext.local',
    GIT_COMMITTER_NAME: 'dreamcontext hackathon', GIT_COMMITTER_EMAIL: 'hackathon@dreamcontext.local',
  };
}

export const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=true', '-c', 'protocol.file.allow=always'];

export function git(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  return execFileSync('git', [...SAFE_GIT, ...args], {
    cwd: o.cwd, env: { ...gitEnv(), ...(o.env ?? {}) }, encoding: 'utf-8', input: o.input,
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20,
  }).trim();
}

export interface SnapPaths { gitDir: string; workTree: string; index: string }

export function snapPaths(runId: string, team: string, wsHome?: string): SnapPaths {
  const c = conductorDir(runId, wsHome);
  return { gitDir: join(c, 'snap.git'), workTree: join(c, 'mirror', team), index: join(c, 'index', `${team}.idx`) };
}

const inSnap = (p: SnapPaths) => ['--git-dir', p.gitDir, '--work-tree', p.workTree];

/** The target's HEAD commit: the run's base SHA. */
export function headSha(target: string): string {
  return git(['-C', target, 'rev-parse', 'HEAD^{commit}']);
}

/**
 * The conductor's repo: a `--no-local` bare clone of the target holding the base commit, a
 * `team/<team>` branch per team at the base, and each team's mirror checked out at the base.
 */
export function initSnapshots(runId: string, target: string, baseSha: string, teams: readonly string[], wsHome?: string): void {
  const c = conductorDir(runId, wsHome);
  const gitDir = join(c, 'snap.git');
  if (!existsSync(gitDir)) {
    mkdirSync(c, { recursive: true });
    git(['clone', '--quiet', '--no-local', '--bare', target, gitDir]);
  }
  for (const team of teams) {
    const p = snapPaths(runId, team, wsHome);
    mkdirSync(p.workTree, { recursive: true });
    mkdirSync(join(c, 'index'), { recursive: true });
    git(['--git-dir', gitDir, 'update-ref', `refs/heads/team/${team}`, baseSha]);
    git([...inSnap(p), 'read-tree', baseSha], { env: { GIT_INDEX_FILE: p.index } });
    git([...inSnap(p), 'checkout-index', '-a', '-f'], { env: { GIT_INDEX_FILE: p.index } });
  }
}

/**
 * The team's clone: a full object copy (`--no-local`: no hardlinks, no alternates) checked out at
 * the base SHA. Dependencies are installed by the conductor before the team starts, lockfile-frozen
 * and with `--ignore-scripts`; the installed paths are returned and skipped by every snapshot.
 */
export function prepareWorkspace(runId: string, team: string, target: string, baseSha: string, o: { wsHome?: string; install?: boolean } = {}): { installPaths: string[]; note?: string } {
  const ws = teamWorkspace(runId, team, o.wsHome);
  mkdirSync(ws.out, { recursive: true });
  if (!existsSync(join(ws.repo, '.git'))) {
    git(['clone', '--quiet', '--no-local', '--no-checkout', target, ws.repo]);
  }
  // The team clone is the team's: these two calls run before the team ever starts, on a clone
  // the conductor just made, so nothing the team planted can be in it yet.
  git(['-C', ws.repo, 'checkout', '--quiet', '--detach', baseSha]);
  const installPaths: string[] = [];
  let note: string | undefined;
  if (o.install !== false && existsSync(join(ws.repo, 'package-lock.json'))) {
    try {
      execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: ws.repo, stdio: 'ignore', timeout: 15 * 60_000 });
      installPaths.push('node_modules');
    } catch {
      note = 'bağımlılıklar kurulamadı: ekip bağımlılıksız başlar';
    }
  }
  return { installPaths, note };
}

export interface SnapshotResult { ok: boolean; commit?: string; changed: number; kept: string[]; reason?: string }

/**
 * Mirror the team tree into the conductor's work tree as bytes, deletions included, then commit
 * a child of `team/<team>`. A file over {@link SNAPSHOT_FILE_MAX} keeps its previous version.
 */
export function takeSnapshot(runId: string, team: string, message: string, o: { wsHome?: string; skip?: readonly string[] } = {}): SnapshotResult {
  const src = teamWorkspace(runId, team, o.wsHome).repo;
  const p = snapPaths(runId, team, o.wsHome);
  const skip = new Set<string>([...SKIP_ALWAYS, ...(o.skip ?? [])]);
  const kept: string[] = [];
  let total = 0;
  let changed = 0;
  const seen = new Set<string>();

  const walk = (rel: string): string | null => {
    const from = join(src, rel);
    let names: string[];
    try { names = readdirSync(from); } catch { return null; }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && skip.has(name)) continue;
      if (skip.has(r)) continue;
      const abs = join(src, r);
      const dst = join(p.workTree, r);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) {
        seen.add(r);
        const to = readlinkSync(abs);
        let cur: string | null = null;
        try { if (lstatSync(dst).isSymbolicLink()) cur = readlinkSync(dst); } catch { /* none */ }
        if (cur !== to) {
          rmSync(dst, { recursive: true, force: true });
          mkdirSync(join(dst, '..'), { recursive: true });
          symlinkSync(to, dst);
          changed++;
        }
      } else if (st.isDirectory()) {
        try { if (lstatSync(dst).isSymbolicLink() || lstatSync(dst).isFile()) rmSync(dst, { force: true }); } catch { /* none */ }
        mkdirSync(dst, { recursive: true });
        const err = walk(r);
        if (err) return err;
      } else if (st.isFile()) {
        seen.add(r);
        if (st.size > SNAPSHOT_FILE_MAX) {
          // Only a changed over-size file is left behind; an unchanged one is already in the copy.
          let same = false;
          try { const d = lstatSync(dst); same = d.isFile() && d.size === st.size && readFileSync(dst).equals(readFileSync(abs)); } catch { /* not in the copy */ }
          if (!same) kept.push(r);
          continue;
        }
        total += st.size;
        if (total > SNAPSHOT_TREE_MAX) return `ekip ağacı ${Math.round(SNAPSHOT_TREE_MAX / 1048576)} MB sınırını aştı`;
        let same = false;
        try {
          const d = lstatSync(dst);
          same = d.isFile() && d.size === st.size && readFileSync(dst).equals(readFileSync(abs));
        } catch { /* new */ }
        if (!same) {
          try { if (lstatSync(dst).isDirectory() || lstatSync(dst).isSymbolicLink()) rmSync(dst, { recursive: true, force: true }); } catch { /* none */ }
          mkdirSync(join(dst, '..'), { recursive: true });
          copyFileSync(abs, dst);
          changed++;
        }
      }
    }
    return null;
  };
  const err = walk('');
  if (err) return { ok: false, changed: 0, kept, reason: err };

  // Deletions: what the mirror has and the team tree no longer does (kept over-size files stay).
  const prune = (rel: string): void => {
    const dir = join(p.workTree, rel);
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && skip.has(name)) continue;
      const abs = join(p.workTree, r);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        prune(r);
        if (!readdirSync(abs).length && !existsSync(join(src, r))) rmSync(abs, { recursive: true, force: true });
      } else if (!seen.has(r)) {
        unlinkSync(abs);
        changed++;
      }
    }
  };
  prune('');

  const env = { GIT_INDEX_FILE: p.index };
  git([...inSnap(p), 'add', '-A', '--', '.'], { env });
  const tree = git([...inSnap(p), 'write-tree'], { env });
  const parent = git(['--git-dir', p.gitDir, 'rev-parse', `refs/heads/team/${team}`]);
  const parentTree = git(['--git-dir', p.gitDir, 'rev-parse', `${parent}^{tree}`]);
  if (tree === parentTree) return { ok: true, commit: parent, changed: 0, kept };
  const commit = git(['--git-dir', p.gitDir, 'commit-tree', tree, '-p', parent, '-m', message.slice(0, 200)]);
  git(['--git-dir', p.gitDir, 'update-ref', `refs/heads/team/${team}`, commit, parent]);
  return { ok: true, commit, changed, kept };
}

/** The team branch's latest snapshot commit. */
export function snapshotHead(runId: string, team: string, wsHome?: string): string | null {
  try {
    return git(['--git-dir', snapPaths(runId, team, wsHome).gitDir, 'rev-parse', `refs/heads/team/${team}`]);
  } catch {
    return null;
  }
}

/** Paths a team changed against the base (names only), from the conductor's repo. */
export function changedPaths(runId: string, team: string, baseSha: string, wsHome?: string): { status: string; path: string }[] {
  const head = snapshotHead(runId, team, wsHome);
  if (!head) return [];
  const out = git(['--git-dir', snapPaths(runId, team, wsHome).gitDir, 'diff', '--name-status', '--no-renames', '-z', baseSha, head]);
  const parts = out.split('\0').filter(Boolean);
  const rows: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) rows.push({ status: parts[i]!, path: parts[i + 1]! });
  return rows;
}
