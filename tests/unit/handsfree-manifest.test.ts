// Hands-free manifest: lstat walk that never follows symlinks, lazy sha256, the non-git
// selection rules, and the root-id destination contract (AC10).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DestinationError, allowedNewWorktreePath, buildManifest, diffManifests, encodeProjectDir, isNeverTravel, isSecretClass,
  isTranscriptDirAllowed, manifestFromJSON, manifestToJSON, prefixPathMap, resolveDestination, rootFor, rootIdFor,
  selectNonGitEntries, transcriptDirsFor, walk, type GoManifest,
} from '../../src/lib/handsfree/manifest.js';
import { createSpawnRunner } from '../../src/lib/handsfree/git-snapshot.js';

let tmp: string;
let env: Record<string, string>;

function gitEnv(home: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) e[k] = v;
  const cfg = join(home, '.gitconfig');
  writeFileSync(cfg, '[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n');
  return { ...e, HOME: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };
}
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const put = (root: string, rel: string, data = rel) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), data);
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hf-manifest-'));
  env = gitEnv(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('walk + buildManifest', () => {
  it('never follows symlinks and refuses nested .git paths', async () => {
    const root = join(tmp, 'r');
    const outside = join(tmp, 'outside');
    put(outside, 'secret.txt', 'nope');
    put(root, 'a.txt', 'A');
    put(root, 'nested/.git/config', 'x');
    symlinkSync(outside, join(root, 'out-link'));
    symlinkSync('a.txt', join(root, 'in-link'));
    const w = walk(root, [''], { side: 'laptop' });
    expect(w.entries).toEqual([
      { path: 'a.txt', type: 'file' },
      { path: 'in-link', type: 'symlink' },
    ]);
    // D19: a link to outside the root stays on the laptop (reported, never in the manifest).
    expect(w.refused).toEqual([
      { path: 'nested/.git', reason: 'dot_git' },
      { path: 'out-link', reason: 'stays on the laptop' },
    ]);
    const m = await buildManifest(root, w.entries);
    expect(m.get('in-link')!.linkTarget).toBe('a.txt');
    expect(m.has('out-link')).toBe(false);
    expect(m.has('outside/secret.txt')).toBe(false);
  });

  it('reuses the previous sha256 when size and mtime are unchanged (lazy), rehashes otherwise', async () => {
    const root = join(tmp, 'r');
    put(root, 'f.txt', 'aaaa');
    const t = new Date('2026-01-01T00:00:00Z');
    utimesSync(join(root, 'f.txt'), t, t);
    const first = await buildManifest(root, walk(root, [''], { side: 'laptop' }).entries);
    // Same size + same mtime, different bytes: the cached hash is reused (proves laziness).
    writeFileSync(join(root, 'f.txt'), 'bbbb');
    utimesSync(join(root, 'f.txt'), t, t);
    const lazy = await buildManifest(root, walk(root, [''], { side: 'laptop' }).entries, first);
    expect(lazy.get('f.txt')!.sha256).toBe(first.get('f.txt')!.sha256);
    const t2 = new Date('2026-01-02T00:00:00Z');
    utimesSync(join(root, 'f.txt'), t2, t2);
    const fresh = await buildManifest(root, walk(root, [''], { side: 'laptop' }).entries, first);
    expect(fresh.get('f.txt')!.sha256).not.toBe(first.get('f.txt')!.sha256);
    expect(diffManifests(first, fresh)).toEqual({ added: [], changed: ['f.txt'], deleted: [] });
  });

  it('manifestFromJSON validates untrusted entries', async () => {
    const root = join(tmp, 'r');
    put(root, 'ok.txt');
    const json = manifestToJSON(await buildManifest(root, walk(root, [''], { side: 'laptop' }).entries));
    expect(manifestFromJSON(json).size).toBe(1);
    expect(() => manifestFromJSON([{ ...json[0], path: '../x' }])).toThrow(/refused/);
    expect(() => manifestFromJSON([{ ...json[0], path: '.GIT/config' }])).toThrow(/refused/);
    expect(() => manifestFromJSON([{ ...json[0], sha256: 'zz' }])).toThrow(/sha256/);
    expect(() => manifestFromJSON([json[0], json[0]])).toThrow(/duplicate/);
  });
});

describe('selection rules', () => {
  it('classifies secret-class and never-travel files', () => {
    expect(isSecretClass('.env')).toBe(true);
    expect(isSecretClass('functions/.env.local')).toBe(true);
    expect(isSecretClass('keys/service-account-prod.json')).toBe(true);
    expect(isSecretClass('a/server.KEY')).toBe(true);
    expect(isSecretClass('src/env.ts')).toBe(false);
    expect(isNeverTravel('_dream_context/state/.secrets.json')).toBe(true);
    expect(isNeverTravel('_dream_context/lab/credentials.json')).toBe(true);
    expect(isNeverTravel('_dream_context/state/tasks.json')).toBe(false);
  });

  it('selects only ignored vault/.claude content, the secret class and opt-ins in a git repo', async () => {
    const root = join(tmp, 'repo');
    mkdirSync(root);
    sh(root, 'init', '-q');
    put(root, '.gitignore', '_dream_context/state/\n_dream_context/marketing/\nnode_modules/\n.env\n.claude/\nbig/\n');
    put(root, 'src/tracked.ts');
    sh(root, 'add', '.');
    sh(root, 'commit', '-qm', 'init');
    put(root, '_dream_context/state/task.md');
    put(root, '_dream_context/state/.secrets.json');
    put(root, '_dream_context/marketing/video.mp4');
    put(root, '.claude/settings.local.json');
    put(root, '.env', 'K=V');
    put(root, 'node_modules/pkg/index.js');
    put(root, 'big/keep/me.bin');
    put(root, 'big/skip.bin');
    put(root, 'untracked.txt');
    const res = await selectNonGitEntries(createSpawnRunner({ baseEnv: env }), root, { isGitRepo: true, include: ['big/keep'], side: 'laptop' });
    expect(res.entries.map((e) => e.path).sort()).toEqual([
      '.claude/settings.local.json',
      '.env',
      '_dream_context/state/task.md',
      'big/keep/me.bin',
    ]);
  });

  it('walks the vault directly when the root is not a git repo', async () => {
    const root = join(tmp, 'vault');
    put(root, '_dream_context/core/1.soul.md');
    put(root, '_dream_context/tmp/scratch');
    put(root, '_dream_context/.embeddings/x');
    put(root, 'other.txt');
    const res = await selectNonGitEntries(createSpawnRunner({ baseEnv: env }), root, { isGitRepo: false, side: 'laptop' });
    expect(res.entries.map((e) => e.path)).toEqual(['_dream_context/core/1.soul.md']);
  });
});

describe('root-id destination contract', () => {
  const home = '/Users/someone';
  const repo = `${home}/projects/app`;
  const go = (): GoManifest => ({
    version: 1, tripId: 't1', laptopId: 'l1', createdAt: '2026-10-03T00:00:00Z', home,
    roots: [
      { rootId: rootIdFor(repo), kind: 'repo', absPath: repo, allowedWorktreeParents: [`${repo}/.claude/worktrees`, `${home}/.claude-worktrees`] },
      { rootId: rootIdFor(`${home}/.claude/projects`), kind: 'transcripts', absPath: `${home}/.claude/projects` },
    ],
  });

  it('root ids are stable and destinations come only from the go manifest', () => {
    expect(rootIdFor(repo)).toBe(rootIdFor(repo + '/'));
    expect(rootIdFor(repo)).toMatch(/^r-[0-9a-f]{16}$/);
    expect(resolveDestination(go(), rootIdFor(repo), 'src/a.ts')).toBe(`${repo}/src/a.ts`);
    expect(() => resolveDestination(go(), 'r-0000000000000000', 'a')).toThrow(DestinationError);
    expect(() => resolveDestination(go(), rootIdFor(repo), '../escape')).toThrow(DestinationError);
    expect(() => resolveDestination(go(), rootIdFor(repo), 'x/.git/config')).toThrow(DestinationError);
  });

  it('a harness path map relocates destinations (no env flag)', () => {
    const map = prefixPathMap(home, '/tmp/scratch-home');
    expect(rootFor(go(), rootIdFor(repo), map).localPath).toBe('/tmp/scratch-home/projects/app');
    expect(resolveDestination(go(), rootIdFor(repo), 'a', map)).toBe('/tmp/scratch-home/projects/app/a');
  });

  it('transcripts only into the encoded dirs of manifest roots', () => {
    expect(encodeProjectDir('/Users/some.one/my_app')).toBe('-Users-some-one-my-app');
    const dirs = transcriptDirsFor(go(), `${home}/.claude/projects`);
    expect([...dirs.keys()]).toEqual([encodeProjectDir(repo)]);
    expect(isTranscriptDirAllowed(go(), encodeProjectDir(repo))).toBe(true);
    expect(isTranscriptDirAllowed(go(), encodeProjectDir(`${home}/elsewhere`))).toBe(false);
  });

  it('new worktrees only under allowed parents with a [a-z0-9-] leaf', () => {
    const scratch = join(tmp, 'h');
    mkdirSync(join(scratch, 'projects/app/.claude/worktrees'), { recursive: true });
    const map = prefixPathMap(home, scratch);
    const ok = allowedNewWorktreePath(go(), rootIdFor(repo), `${repo}/.claude/worktrees/fix-1`, map);
    expect(ok.endsWith('/projects/app/.claude/worktrees/fix-1')).toBe(true);
    expect(() => allowedNewWorktreePath(go(), rootIdFor(repo), `${repo}/.claude/worktrees/Fix_1`, map)).toThrow(/leaf/);
    expect(() => allowedNewWorktreePath(go(), rootIdFor(repo), `${home}/elsewhere/fix-1`, map)).toThrow(/allowed parent/);
    expect(() => allowedNewWorktreePath(go(), rootIdFor(repo), `${home}/.claude-worktrees/fix-1`, map)).toThrow(/does not exist/);
    mkdirSync(join(scratch, 'projects/app/.claude/worktrees/taken'));
    expect(() => allowedNewWorktreePath(go(), rootIdFor(repo), `${repo}/.claude/worktrees/taken`, map)).toThrow(/exists/);
    expect(statSync(join(scratch, 'projects/app/.claude/worktrees')).isDirectory()).toBe(true);
  });
});
