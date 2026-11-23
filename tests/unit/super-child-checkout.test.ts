/**
 * kesim-geri-donus K7 / D15 (C8 iv-vi): a child's checkout is read from git, the record's worktree
 * is only a hint. A dal-yalnız child (worktree removed) is merged from its branch and re-attached
 * at its original path by resume.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkedReposFilePath } from '../../src/lib/linked-repos.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';
import {
  WorktreeRefused, childCheckout, createChildWorktree, mergeChildren, reattachChildWorktree, removeChildWorktree,
} from '../../src/lib/super/worktrees.js';
import type { SuperChild } from '../../src/lib/super/types.js';

const URL_A = 'https://github.com/acme/product.git';
const URL_B = 'https://github.com/acme/other.git';
let home: string;
let repo: string;
let other: string;
let project: string;
const savedEnv = { ...process.env };

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function initRepo(p: string): void {
  mkdirSync(p, { recursive: true });
  g(p, 'init', '-q', '-b', 'main');
  writeFileSync(join(p, 'README.md'), 'one\n');
  g(p, 'add', '.');
  g(p, 'commit', '-q', '-m', 'init');
}
function commitIn(dir: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`);
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', `edit ${file}`);
  return g(dir, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  });
  home = mkdtempSync(join(tmpdir(), 'super-co-home-'));
  repo = join(home, 'code', 'product');
  other = join(home, 'code', 'other');
  initRepo(repo);
  initRepo(other);
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(linkedReposFilePath(home), JSON.stringify({ repos: { [canonicalRemote(URL_A) ?? URL_A]: repo, [canonicalRemote(URL_B) ?? URL_B]: other } }));
  project = mkdtempSync(join(tmpdir(), 'super-co-proj-'));
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(project, '_dream_context', 'state', '.config.json'), JSON.stringify({
    platforms: [], packs: [], setupVersion: '1',
    linkedRepos: [{ name: 'product', gitRemoteUrl: URL_A }, { name: 'other', gitRemoteUrl: URL_B }],
  }));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const child = (o: Partial<SuperChild>): SuperChild => ({ sessionId: 'kid', brief: 'x', adopted: false, startedAt: 1, endedAt: 2, ...o });

describe('childCheckout', () => {
  it('a live worktree is live; a removed one is dal-yalnız, merged from its branch', async () => {
    const w = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'kid', home });
    commitIn(w.path, 'a.txt');
    const c = child({ worktree: w.path, branch: w.branch, repo: 'product' });
    expect(await childCheckout(project, c, { home })).toMatchObject({ worktree: w.path, branch: 'super/kid', repo: { name: 'product' } });
    // Being removed: read as gone.
    expect((await childCheckout(project, c, { home, removing: new Set([w.path]) })).worktree).toBeNull();
    await removeChildWorktree({ repoPath: repo, worktree: w.path, branch: w.branch, home });
    const co = await childCheckout(project, c, { home });
    expect(co).toMatchObject({ worktree: null, branch: 'super/kid', repo: { name: 'product' } });
    const m = await mergeChildren({ projectRoot: project, repo: 'product', topic: 'cut', home, children: [{ sessionId: 'kid', branch: co.branch!, worktree: co.worktree ?? undefined }] });
    expect(m.results[0]).toMatchObject({ merged: true, branch: 'super/kid' });
  });

  it('C8(iv) the recorded repo wins; an old record whose branch is in two repos is refused naming both', async () => {
    g(repo, 'branch', 'super/twin');
    g(other, 'branch', 'super/twin');
    expect(await childCheckout(project, child({ branch: 'super/twin', repo: 'other' }), { home })).toMatchObject({ repo: { name: 'other' } });
    const old = await childCheckout(project, child({ branch: 'super/twin' }), { home });
    expect(old.repo).toBeNull();
    expect(old.why).toMatch(/product/);
    expect(old.why).toMatch(/other/);
    g(other, 'branch', '-D', 'super/twin');
    expect(await childCheckout(project, child({ branch: 'super/twin' }), { home })).toMatchObject({ repo: { name: 'product' } });
  });

  it('C8(vi) a worktree moved to fix/x then removed: branch stays super/<slug>, merge takes it', async () => {
    const w = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'mv', home });
    commitIn(w.path, 'm.txt');
    g(w.path, 'checkout', '-q', '-b', 'fix/x');
    const live = await childCheckout(project, child({ worktree: w.path, branch: 'super/mv', repo: 'product' }), { home });
    // The live branch is not super/*: the recorded one names the work.
    expect(live.branch).toBe('super/mv');
    g(w.path, 'checkout', '-q', 'super/mv');
    await removeChildWorktree({ repoPath: repo, worktree: w.path, branch: 'super/mv', home });
    const co = await childCheckout(project, child({ branch: 'super/mv', repo: 'product', movedTo: 'fix/x' }), { home });
    expect(co.branch).toBe('super/mv');
  });

  it('C8(v) resume re-attaches at the original path, checked out; a branch checked out elsewhere is said and nothing made', async () => {
    const w = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'rs', home });
    commitIn(w.path, 'r.txt');
    await removeChildWorktree({ repoPath: repo, worktree: w.path, branch: w.branch, home });
    expect(existsSync(w.path)).toBe(false);
    const c = child({ worktree: w.path, branch: w.branch, repo: 'product' });
    const r = await reattachChildWorktree({ projectRoot: project, child: c, home });
    expect(r).toMatchObject({ worktree: w.path, branch: 'super/rs', repo: 'product' });
    expect(existsSync(join(w.path, 'r.txt'))).toBe(true);
    expect(g(w.path, 'symbolic-ref', '--short', 'HEAD')).toBe('super/rs');
    // Gone again, then the branch checked out somewhere else.
    await removeChildWorktree({ repoPath: repo, worktree: w.path, branch: w.branch, home });
    g(repo, 'checkout', '-q', 'super/rs');
    const r2 = await reattachChildWorktree({ projectRoot: project, child: c, home });
    expect(r2).toMatchObject({ why: expect.stringMatching(/checked out at/) });
    expect(existsSync(w.path)).toBe(false);
  });
});

describe('D10 bases', () => {
  it('a local branch whose remote ref went on starts from the remote ref and says so', async () => {
    const remoteDir = join(home, 'remote.git');
    g(home, 'init', '-q', '--bare', remoteDir);
    g(repo, 'remote', 'add', 'origin', remoteDir);
    g(repo, 'checkout', '-q', '-b', 'dev');
    g(repo, 'push', '-q', 'origin', 'dev');
    commitIn(repo, 'ahead.txt');
    g(repo, 'push', '-q', 'origin', 'dev');
    g(repo, 'reset', '-q', '--hard', 'HEAD~1');
    g(repo, 'checkout', '-q', 'main');
    const w = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'fresh', base: 'dev', home });
    expect(w.base).toBe(g(repo, 'rev-parse', 'origin/dev'));
    expect(w.baseNote).toMatch(/origin\/dev \(1 commit ahead of local dev\)/);
  });

  it('super merge --base opens a NEW topic there; an existing topic ignores it and says so', async () => {
    const tag = g(repo, 'rev-parse', 'HEAD');
    commitIn(repo, 'later.txt');
    g(repo, 'branch', 'basepoint', tag);
    const a = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'ba', home });
    commitIn(a.path, 'ba.txt');
    const m = await mergeChildren({ projectRoot: project, repo: 'product', topic: 'newtopic', base: 'basepoint', home, children: [{ sessionId: 'a', branch: a.branch, worktree: a.path }] });
    expect(m.baseNote).toMatch(/opened at basepoint/);
    // The topic opened at basepoint: the merge commit's first parent is the base, not main.
    expect(g(repo, 'rev-parse', 'super/newtopic^1')).toBe(tag);
    const b = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'bb', home });
    commitIn(b.path, 'bb.txt');
    const m2 = await mergeChildren({ projectRoot: project, repo: 'product', topic: 'newtopic', base: 'main', home, children: [{ sessionId: 'b', branch: b.branch, worktree: b.path }] });
    expect(m2.baseNote).toMatch(/already exists: --base main ignored/);
  });

  it('C12 the merge carries returns; a failing returns hook is returns.error with merged: true', async () => {
    const a = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'rr', home });
    commitIn(a.path, 'rr.txt');
    const m = await mergeChildren({
      projectRoot: project, repo: 'product', topic: 'rt', home, children: [{ sessionId: 'a', branch: a.branch, worktree: a.path }],
      returns: async () => { throw new Error('boom'); },
    });
    expect(m.results[0]).toMatchObject({ merged: true });
    expect(m.returns).toEqual({ error: 'boom' });
    const slow = await mergeChildren({
      projectRoot: project, repo: 'product', topic: 'rt', home, children: [{ sessionId: 'a', branch: a.branch }],
      returns: () => new Promise(() => undefined), returnsMs: 50,
    });
    expect(slow.returns).toMatchObject({ error: expect.stringMatching(/no answer/) });
    void WorktreeRefused;
  });
});
