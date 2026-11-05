/**
 * Every git call the server runs on a shared app's repos goes through here (paylasilan-app-ler
 * plan r2 K3, security C3 / critic C2): the installed copy's source repo
 * (`~/.dreamcontext/apps/sources/<installId>.git`), an install preview's incoming repo, and the
 * owner's publish mirror. The repo came from someone else, so nothing in it is trusted:
 *
 * - `--git-dir` (+ `--work-tree`) given explicitly, never discovered from a cwd;
 * - no global or system config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`);
 * - hooks, fsmonitor, sshCommand, credential helpers and LFS off on every call;
 * - only the protocol the host needs (`https`, or `file` for the local test host);
 * - the remote address is passed on every networked call from the registry, never read from the
 *   repo's own config.
 */

import { execFileSync } from 'node:child_process';

export interface HardGitOptions {
  workTree?: string;
  env?: NodeJS.ProcessEnv;
  /** The local test host clones over `file://`; the GitHub host never does. */
  allowFile?: boolean;
  input?: string | Buffer;
  timeoutMs?: number;
  /** Return stdout as a Buffer (blob reads). */
  binary?: boolean;
}

const HARD_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=',
  '-c', 'core.sshCommand=',
  '-c', 'credential.helper=',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ext.allow=never',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
  '-c', 'core.symlinks=false',
  '-c', 'submodule.recurse=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'advice.detachedHead=false',
  '-c', 'init.defaultBranch=main',
];

export class ShareGitError extends Error {
  constructor(message: string, public stderr: string) { super(message); }
}

function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'USER', 'SystemRoot']) if (process.env[k]) base[k] = process.env[k];
  return {
    ...base,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    ...extra,
  };
}

export function installedGit(gitDir: string, args: string[], opts: HardGitOptions & { binary: true }): Buffer;
export function installedGit(gitDir: string, args: string[], opts?: HardGitOptions): string;
export function installedGit(gitDir: string, args: string[], opts: HardGitOptions = {}): string | Buffer {
  const argv = [
    ...HARD_CONFIG,
    ...(opts.allowFile ? ['-c', 'protocol.file.allow=always'] : []),
    `--git-dir=${gitDir}`,
    ...(opts.workTree ? [`--work-tree=${opts.workTree}`] : []),
    ...args,
  ];
  try {
    const out = execFileSync('git', argv, {
      env: gitEnv(opts.env),
      input: opts.input,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.workTree ? { cwd: opts.workTree } : {}),
    });
    return opts.binary ? out : out.toString('utf-8');
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    const stderr = err.stderr ? err.stderr.toString('utf-8') : '';
    throw new ShareGitError(`git ${args[0]} failed: ${stderr.trim().split('\n').slice(-2).join(' ') || err.message}`, stderr);
  }
}

/** A fresh repo for a source, a preview or a publish mirror. Never a hook template. */
export function initHardRepo(gitDir: string, bare: boolean): void {
  execFileSync('git', [...HARD_CONFIG, 'init', '-q', '--template=', ...(bare ? ['--bare'] : []), gitDir], { env: gitEnv(), stdio: 'ignore' });
}

/** One line of `git ls-tree -r -z --long`. */
export interface TreeEntry {
  mode: string;
  type: 'blob' | 'commit' | 'tree';
  sha: string;
  size: number;
  path: string;
}

export function lsTree(gitDir: string, ref: string, opts: { allowFile?: boolean } = {}): TreeEntry[] {
  const out = installedGit(gitDir, ['ls-tree', '-r', '-z', '--long', '--full-tree', ref], opts);
  const rows: TreeEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, sha, size] = rec.slice(0, tab).trim().split(/\s+/);
    rows.push({ mode, type: type as TreeEntry['type'], sha, size: size === '-' ? 0 : Number(size), path: rec.slice(tab + 1) });
  }
  return rows;
}

export function readBlob(gitDir: string, sha: string): Buffer {
  return installedGit(gitDir, ['cat-file', 'blob', sha], { binary: true });
}

export function revParse(gitDir: string, ref: string): string | null {
  try { return installedGit(gitDir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).trim() || null; } catch { return null; }
}

export function isAncestor(gitDir: string, a: string, b: string): boolean {
  try { installedGit(gitDir, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
}
