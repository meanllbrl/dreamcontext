import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_TMP_PREFIXES } from './test-tmp-prefixes.js';

/**
 * What finished super work leaves on disk (field 2026-10-21: the disk fell to 3.7 GB under
 * worktrees, Rust `target/` dirs, Chrome profile copies and test leftovers).
 *
 * MEASURED: the super worktrees under `~/.claude-worktrees/`, the Rust `target/` inside them,
 * Chrome's temp copies, this repo's own test temp folders, and `tmp/develop` run logs. REMOVED
 * (only by `super clean`, never by measuring): an ENDED child's worktree that is merged and clean
 * (git removes it, the branch stays), and our own test temp folders older than a day. Chrome and
 * every file of the system or of another program are only ever measured.
 */

export type LeftoverKind = 'worktree' | 'rust-target' | 'chrome-copy' | 'test-tmp' | 'develop-logs';

export interface Leftover {
  kind: LeftoverKind;
  /** One path, or the folder that holds them (test-tmp, chrome-copy). */
  path: string;
  bytes: number;
  /** How many folders, when one row stands for many. */
  count?: number;
  /** `super clean` may remove it (an ended, merged, clean child's worktree; old test temp). */
  removable: boolean;
}

/** Test temp older than this is a leftover (a running suite's folders are younger). */
export const TEST_TMP_MIN_AGE_MS = 24 * 60 * 60_000;

/** mkdtemp appends exactly 6 characters. A one-word prefix (`push-`) is too generic to claim. */
export function isOurTestTmp(name: string): boolean {
  if (name.length < 7) return false;
  const stem = name.slice(0, -6);
  if (!/^[A-Za-z0-9]{6}$/.test(name.slice(-6))) return false;
  return TEST_TMP_PREFIXES.includes(stem) && stem.split('-').filter(Boolean).length >= 2;
}

/** `du -sk` over paths, in chunks; a path du cannot read counts 0. Bytes per path. */
export function diskUsage(paths: readonly string[], timeoutMs = 60_000): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += 200) chunks.push(paths.slice(i, i + 200));
  return chunks.reduce<Promise<void>>((p, chunk) => p.then(() => new Promise<void>((done) => {
    execFile('du', ['-sk', ...chunk], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      // du exits 1 when one path is unreadable but still prints the others.
      for (const line of String(stdout ?? '').split('\n')) {
        const m = /^(\d+)\t(.+)$/.exec(line);
        if (m) out.set(m[2], Number(m[1]) * 1024);
      }
      done();
    });
  })), Promise.resolve()).then(() => out);
}

async function dirs(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

/** Rust build dirs a few levels down a worktree (a `target/` beside a Cargo.toml). */
async function rustTargets(root: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string, left: number): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'Cargo.toml') && entries.some((e) => e.isDirectory() && e.name === 'target')) {
      found.push(join(d, 'target'));
    }
    if (left <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name === 'node_modules' || e.name === 'target' || e.name.startsWith('.')) continue;
      await walk(join(d, e.name), left - 1);
    }
  };
  await walk(root, depth);
  return found;
}

export interface LeftoverPlaces {
  /** `~/.claude-worktrees`. */
  worktrees: string;
  /** os.tmpdir(). */
  tmp: string;
  /** Project roots whose `tmp/develop` holds run logs. */
  projects: readonly string[];
  /** Worktrees `super clean` may remove (ended, merged, clean children). */
  removableWorktrees?: ReadonlySet<string>;
  now?: number;
}

export function defaultPlaces(projects: readonly string[], removableWorktrees?: ReadonlySet<string>): LeftoverPlaces {
  return { worktrees: join(homedir(), '.claude-worktrees'), tmp: tmpdir(), projects, removableWorktrees };
}

/** Our test temp folders in `tmp`, older than {@link TEST_TMP_MIN_AGE_MS}. */
export async function oldTestTmp(tmp: string, now = Date.now()): Promise<string[]> {
  const out: string[] = [];
  for (const d of await dirs(tmp)) {
    const name = d.slice(tmp.replace(/\/$/, '').length + 1);
    if (!isOurTestTmp(name)) continue;
    try { if (now - (await fsp.stat(d)).mtimeMs >= TEST_TMP_MIN_AGE_MS) out.push(d); } catch { /* raced */ }
  }
  return out;
}

/** Every leftover, largest first. */
export async function measureLeftovers(p: LeftoverPlaces): Promise<Leftover[]> {
  const now = p.now ?? Date.now();
  const worktrees = await dirs(p.worktrees);
  const targets = (await Promise.all(worktrees.map((w) => rustTargets(w)))).flat();
  const tmpDirs = await dirs(p.tmp);
  const chrome = tmpDirs.filter((d) => /\/com\.google\.Chrome\.[^/]*$/.test(d));
  const tests = await oldTestTmp(p.tmp, now);
  const develop = p.projects.map((r) => join(r, 'tmp', 'develop'));
  const sizes = await diskUsage([...worktrees, ...targets, ...chrome, ...tests, ...develop]);
  const size = (x: string) => sizes.get(x) ?? 0;
  const rows: Leftover[] = [
    ...worktrees.map((w) => ({ kind: 'worktree' as const, path: w, bytes: size(w), removable: !!p.removableWorktrees?.has(w) })),
    ...targets.map((t) => ({ kind: 'rust-target' as const, path: t, bytes: size(t), removable: false })),
    ...develop.filter((d) => sizes.has(d)).map((d) => ({ kind: 'develop-logs' as const, path: d, bytes: size(d), removable: false })),
  ];
  if (chrome.length) rows.push({ kind: 'chrome-copy', path: p.tmp, bytes: chrome.reduce((n, d) => n + size(d), 0), count: chrome.length, removable: false });
  if (tests.length) rows.push({ kind: 'test-tmp', path: p.tmp, bytes: tests.reduce((n, d) => n + size(d), 0), count: tests.length, removable: true });
  return rows.filter((r) => r.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

/** `super state` never waits on `du`: it shows the last measurement and starts the next one. */
export const LEFTOVERS_TTL_MS = 10 * 60_000;
let cache: { at: number; top: Leftover[] } | null = null;
let measuring: Promise<void> | null = null;

export function cachedLeftovers(places: () => LeftoverPlaces, now = Date.now()): { measuredAt: number | null; top: Leftover[] } {
  if ((!cache || now - cache.at > LEFTOVERS_TTL_MS) && !measuring) {
    measuring = measureLeftovers(places())
      .then((rows) => { cache = { at: Date.now(), top: rows.slice(0, 5) }; })
      .catch(() => undefined)
      .finally(() => { measuring = null; });
  }
  return { measuredAt: cache?.at ?? null, top: cache?.top ?? [] };
}

/** Forget the last measurement (after a clean, and in tests). */
export function forgetLeftovers(): void {
  cache = null;
}
