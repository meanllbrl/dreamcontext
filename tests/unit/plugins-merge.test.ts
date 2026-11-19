/**
 * Mağaza D1 criterion 3: the installed set travels with the brain. In-tree brains share it
 * through plain git (different ids = different files); full-repo runs the semantic merge's
 * `plugin-entry` class. Both resolve one id chosen on two machines by `pickEntry`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyPath } from '../../src/lib/git-sync/semantic-merge.js';
import {
  installPlugin,
  isPluginInstalled,
  mergePluginEntry,
  readEntry,
  removePlugin,
  PluginEntryConflictError,
} from '../../src/lib/plugins/store.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir(),
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryGit(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let root: string;
let origin: string;
let a: string;
let b: string;
const ctx = (clone: string) => join(clone, '_dream_context');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-plugins-merge-'));
  origin = join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  mkdirSync(join(seed, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(seed, '_dream_context', 'council', 'd1'), { recursive: true });
  writeFileSync(join(seed, '_dream_context', 'council', 'index.json'), JSON.stringify([{ id: 'd1' }]));
  writeFileSync(join(seed, '_dream_context', 'council', 'd1', 'q.md'), 'question');
  writeFileSync(join(seed, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '0.41.22', disableNativeMemory: true }));
  writeFileSync(join(seed, '.gitignore'), '_dream_context/state/.brain-local.json\n_dream_context/state/.locks/\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', 'origin', 'main');
  a = join(root, 'a');
  b = join(root, 'b');
  git(root, 'clone', origin, a);
  git(root, 'clone', origin, b);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function commitAll(clone: string, msg: string): void {
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', msg);
}

describe('in-tree, plain git, two clones', () => {
  it('A installs lab while B installs council: both installed after merge, no conflict', () => {
    installPlugin(ctx(a), 'lab', 'a', new Date('2026-11-17T10:00:00Z'));
    commitAll(a, 'install lab');
    git(a, 'push', 'origin', 'main');
    removePlugin(ctx(b), 'council', 'b', new Date('2026-11-17T10:00:00Z'));
    installPlugin(ctx(b), 'council', 'b', new Date('2026-11-17T10:01:00Z'));
    commitAll(b, 'install council');
    const pull = tryGit(b, 'pull', '--no-rebase', '--no-edit', 'origin', 'main');
    expect(pull.ok).toBe(true);
    expect(isPluginInstalled(ctx(b), 'lab')).toBe(true);
    expect(isPluginInstalled(ctx(b), 'council')).toBe(true);
  });

  it('A installs and commits, B (nothing of its own) pulls cleanly; pins stay machine-local', () => {
    installPlugin(ctx(a), 'lab', 'a');
    commitAll(a, 'install lab');
    git(a, 'push', 'origin', 'main');
    expect(git(a, 'status', '--porcelain')).toBe('');
    const pull = tryGit(b, 'pull', '--no-rebase', '--no-edit', 'origin', 'main');
    expect(pull.ok).toBe(true);
    expect(isPluginInstalled(ctx(b), 'lab')).toBe(true);
    // A's pin (written by its install) never travelled.
    expect(tryGit(b, 'ls-files', '--error-unmatch', '_dream_context/state/.brain-local.json').ok).toBe(false);
  });

  it('A removes council (data kept) and pushes; B pulls: council removed for B, data intact', () => {
    removePlugin(ctx(a), 'council', 'a');
    commitAll(a, 'remove council');
    git(a, 'push', 'origin', 'main');
    git(b, 'pull', '--no-rebase', '--no-edit', 'origin', 'main');
    expect(isPluginInstalled(ctx(b), 'council')).toBe(false);
    expect(readFileSync(join(ctx(b), 'council', 'd1', 'q.md'), 'utf-8')).toBe('question');
  });

  it('A and B both choose council before syncing: a git conflict every reader resolves by later at', () => {
    removePlugin(ctx(a), 'council', 'a', new Date('2026-11-17T10:00:00Z'));
    commitAll(a, 'a removes council');
    git(a, 'push', 'origin', 'main');
    installPlugin(ctx(b), 'lab', 'b', new Date('2026-11-17T09:00:00Z'));
    removePlugin(ctx(b), 'council', 'b', new Date('2026-11-17T09:30:00Z'));
    installPlugin(ctx(b), 'council', 'b', new Date('2026-11-17T11:00:00Z'));
    commitAll(b, 'b installs council');
    const pull = tryGit(b, 'pull', '--no-rebase', '--no-edit', 'origin', 'main');
    expect(pull.ok).toBe(false);
    const read = readEntry(ctx(b), 'council');
    expect(read.conflict).toBe(true);
    expect(read.entry?.state).toBe('installed'); // 11:00 beats 10:00
    expect(isPluginInstalled(ctx(b), 'council')).toBe(true);
    expect(() => installPlugin(ctx(b), 'council', 'b')).toThrow(PluginEntryConflictError);
    expect(isPluginInstalled(ctx(b), 'lab')).toBe(true);
    // The same answer the full-repo semantic merge gives for the two sides.
    const ours = git(b, 'show', ':2:_dream_context/overrides/plugins/council.json');
    const theirs = git(b, 'show', ':3:_dream_context/overrides/plugins/council.json');
    expect(JSON.parse(mergePluginEntry(ours, theirs)!).state).toBe('installed');
  });
});

describe('full-repo semantic merge', () => {
  it('classifies the entry file and merges by pickEntry', () => {
    expect(classifyPath('_dream_context/overrides/plugins/lab.json')).toBe('plugin-entry');
    expect(classifyPath('overrides/plugins/council.json')).toBe('plugin-entry');
    expect(classifyPath('overrides/plugins/x/lab.json')).toBe('other');
    const inst = JSON.stringify({ state: 'installed', at: '2026-11-17T10:00:00Z', by: 'a' });
    const rem = JSON.stringify({ state: 'removed', at: '2026-11-17T12:00:00Z', by: 'b' });
    expect(JSON.parse(mergePluginEntry(inst, rem)!).state).toBe('removed');
    expect(JSON.parse(mergePluginEntry('{broken', inst)!).state).toBe('installed');
    expect(mergePluginEntry('x', 'y')).toBeNull();
  });
});
