// Hands-free git snapshot S (Transport 1, sender half) with real git in temp repos:
// refs/stash order + messages, index vs worktree trees, unborn repos, nested worktree
// exclusion, mode-160000 refusal, the preflight, the tolerant recovery snapshot, bundles
// (file + stream, empty, missing prerequisites) and the fetch ref allow-list.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Real git, many spawns per snapshot: generous per-test budget on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BundlePrerequisiteError, HandsfreeRefusal, createBundle, createSpawnRunner, fetchBundle, gitPreflight, incomingRefFor,
  lsTree, parseRepoSnapshot, snapIndexRef, snapStashRef, snapWorktreeRef, snapshotBundleRefs, snapshotId, snapshotRepo,
  type ProcessRunner, type RepoSnapshot,
} from '../../src/lib/handsfree/git-snapshot.js';
import { rootIdFor } from '../../src/lib/handsfree/manifest.js';

let home: string;
let env: Record<string, string>;
let run: ProcessRunner;

function gitEnv(h: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) e[k] = v;
  const cfg = join(h, '.gitconfig');
  writeFileSync(cfg, '[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[protocol "file"]\n\tallow = always\n');
  return { ...e, HOME: h, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };
}
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const put = (root: string, rel: string, data: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), data);
};
const ids = (abs: string) => rootIdFor(abs);
const snap = (repo: string, extra: Partial<Parameters<typeof snapshotRepo>[2]> = {}) => snapshotRepo(run, repo, { trip: 't1', checkoutIdFor: ids, ...extra });

function makeRepo(name = 'repo'): string {
  const r = join(home, name);
  mkdirSync(r);
  sh(r, 'init', '-q');
  put(r, 'a.txt', 'a1\n');
  put(r, 'b.txt', 'b1\n');
  sh(r, 'add', '.');
  sh(r, 'commit', '-qm', 'c1');
  return r;
}

beforeEach(() => {
  // git reports realpaths (macOS /var -> /private/var); checkout ids are taken from them.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-gsnap-')));
  env = gitEnv(home);
  run = createSpawnRunner({ baseEnv: env });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('snapshotRepo', () => {
  it('W2: a worktree nested under a path info/exclude ignores (**/.claude/worktrees/) is a checkout, not a failed add', async () => {
    const r = makeRepo();
    writeFileSync(join(r, '.git', 'info', 'exclude'), '**/.claude/worktrees/\n');
    mkdirSync(join(r, '.claude', 'worktrees'), { recursive: true });
    sh(r, 'worktree', 'add', '-q', '-b', 'wt', join(r, '.claude', 'worktrees', 'wt-one'));
    put(join(r, '.claude', 'worktrees', 'wt-one'), 'only-in-wt.txt', 'w\n');
    const s = await snap(r);
    expect(s.checkouts.map((c) => c.path).sort()).toEqual([r, join(r, '.claude', 'worktrees', 'wt-one')].sort());
    const main = s.checkouts.find((c) => c.isMain)!;
    expect((await lsTree(run, r, main.worktreeTree)).map((e) => e.path)).not.toContain('.claude/worktrees/wt-one/only-in-wt.txt');
  });

  it('captures refs, the stash list (order + messages), HEAD, index and worktree trees', async () => {
    const r = makeRepo();
    sh(r, 'branch', 'feature');
    sh(r, 'tag', '-a', 'v1', '-m', 'v1');
    sh(r, 'notes', 'add', '-m', 'a note', 'HEAD');
    put(r, 'a.txt', 'stash one\n');
    sh(r, 'stash', 'push', '-m', 'first stash');
    put(r, 'b.txt', 'stash two\n');
    sh(r, 'stash', 'push', '-m', 'second: with colon');
    put(r, 'a.txt', 'staged\n');
    sh(r, 'add', 'a.txt');
    put(r, 'a.txt', 'staged then edited\n');
    put(r, 'untracked.txt', 'u\n');
    rmSync(join(r, 'b.txt'));

    const s = await snap(r);
    expect(Object.keys(s.refs).sort()).toEqual(['refs/heads/feature', 'refs/heads/main', 'refs/notes/commits', 'refs/tags/v1']);
    expect(s.stash.map((e) => e.message)).toEqual(['On main: second: with colon', 'On main: first stash']);
    expect(s.stash.map((e) => e.oid)).toEqual(sh(r, 'log', '-g', '--format=%H', 'refs/stash').trim().split('\n'));
    const c = s.checkouts[0];
    expect(c.head).toEqual({ kind: 'symref', ref: 'refs/heads/main', oid: sh(r, 'rev-parse', 'HEAD').trim() });
    expect(c.indexTree).toBe(sh(r, 'write-tree').trim());
    const idx = await lsTree(run, r, c.indexTree);
    const wt = await lsTree(run, r, c.worktreeTree);
    expect(idx.map((e) => e.path)).toEqual(['a.txt', 'b.txt']);
    expect(wt.map((e) => e.path)).toEqual(['a.txt', 'untracked.txt']);
    expect(sh(r, 'cat-file', 'blob', `${c.worktreeTree}:a.txt`)).toBe('staged then edited\n');
    expect(sh(r, 'cat-file', 'blob', `${c.indexTree}:a.txt`)).toBe('staged\n');
    // The snapshot did not touch the real index or the working tree.
    const st = sh(r, 'status', '--porcelain=v2');
    expect(st).toContain('1 MM ');
    expect(st).toContain('1 .D ');
    expect(st).toContain('? untracked.txt');
    // Snap refs carry the trees and the stash so a bundle can.
    expect(sh(r, 'rev-parse', `${snapIndexRef('t1', c.checkoutId)}^{tree}`).trim()).toBe(c.indexTree);
    expect(sh(r, 'rev-parse', `${snapWorktreeRef('t1', c.checkoutId)}^{tree}`).trim()).toBe(c.worktreeTree);
    expect(sh(r, 'rev-parse', snapStashRef('t1', 1)).trim()).toBe(s.stash[1].oid);
    // Deterministic: a second snapshot of the same state has the same id.
    expect(snapshotId(await snap(r))).toBe(snapshotId(s));
  });

  it('handles an unborn repository with a staged file', async () => {
    const r = join(home, 'unborn');
    mkdirSync(r);
    sh(r, 'init', '-q');
    put(r, 'first.txt', 'x\n');
    sh(r, 'add', 'first.txt');
    put(r, 'loose.txt', 'y\n');
    const s = await snap(r);
    expect(s.refs).toEqual({});
    expect(s.checkouts[0].head).toEqual({ kind: 'symref', ref: 'refs/heads/main', oid: null });
    expect((await lsTree(run, r, s.checkouts[0].indexTree)).map((e) => e.path)).toEqual(['first.txt']);
    expect((await lsTree(run, r, s.checkouts[0].worktreeTree)).map((e) => e.path)).toEqual(['first.txt', 'loose.txt']);
  });

  it('every worktree is its own checkout and nested worktrees are excluded from the parent walk', async () => {
    const r = makeRepo();
    const wt = join(r, '.claude', 'worktrees', 'fix-1');
    sh(r, 'worktree', 'add', '-q', '-b', 'fix-1', wt);
    put(wt, 'only-in-wt.txt', 'w\n');
    put(r, 'main-untracked.txt', 'm\n');
    const s = await snap(r);
    expect(s.checkouts.map((c) => c.checkoutId).sort()).toEqual([ids(r), ids(wt)].sort());
    const main = s.checkouts.find((c) => c.isMain)!;
    const mainPaths = (await lsTree(run, r, main.worktreeTree)).map((e) => e.path);
    expect(mainPaths).toContain('main-untracked.txt');
    expect(mainPaths.some((p) => p.startsWith('.claude/'))).toBe(false);
    const w = s.checkouts.find((c) => !c.isMain)!;
    expect(w.head).toMatchObject({ kind: 'symref', ref: 'refs/heads/fix-1' });
    expect((await lsTree(run, wt, w.worktreeTree)).map((e) => e.path)).toContain('only-in-wt.txt');
    // A checkout filter (e.g. "under HOME") drops a worktree but never the main checkout.
    const filtered = await snap(r, { checkoutFilter: (p) => p !== wt });
    expect(filtered.checkouts.map((c) => c.checkoutId)).toEqual([ids(r)]);
  });

  it('refuses a nested clone (mode 160000) and names it', async () => {
    const r = makeRepo();
    const nested = join(r, 'vendor', 'lib');
    mkdirSync(nested, { recursive: true });
    sh(nested, 'init', '-q');
    put(nested, 'x', 'x');
    sh(nested, 'add', '.');
    sh(nested, 'commit', '-qm', 'n');
    const err = await snap(r).catch((e) => e);
    expect(err).toBeInstanceOf(HandsfreeRefusal);
    expect(err.kind).toBe('submodule');
    expect(err.message).toContain('vendor/lib');
    expect(err.message).toMatch(/gitignore/);
  });

  it('refuses a staged gitlink too', async () => {
    const r = makeRepo();
    const head = sh(r, 'rev-parse', 'HEAD').trim();
    sh(r, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    await expect(snap(r)).rejects.toMatchObject({ kind: 'submodule', path: 'sub' });
  });
});

describe('preflight + tolerant recovery', () => {
  async function conflicted(): Promise<string> {
    const r = makeRepo();
    sh(r, 'checkout', '-qb', 'other');
    put(r, 'a.txt', 'other\n');
    sh(r, 'commit', '-qam', 'other');
    sh(r, 'checkout', '-q', 'main');
    put(r, 'a.txt', 'main\n');
    sh(r, 'commit', '-qam', 'main');
    try { sh(r, 'merge', 'other'); } catch { /* conflict expected */ }
    return r;
  }

  it('reports a merge in progress, unmerged entries, held locks and filter drivers', async () => {
    const r = await conflicted();
    const kinds = (await gitPreflight(run, r)).map((p) => p.kind);
    expect(kinds).toContain('unmerged');
    expect(kinds).toContain('in_progress');
    const clean = makeRepo('clean');
    expect(await gitPreflight(run, clean)).toEqual([]);
    put(clean, '.gitattributes', '*.secret filter=crypt\n');
    sh(clean, 'add', '-f', '.gitattributes');
    writeFileSync(join(clean, '.git', 'index.lock'), '');
    const p2 = (await gitPreflight(run, clean)).map((p) => p.kind);
    expect(p2).toContain('lock');
    expect(p2).toContain('filter');
  });

  it('a normal snapshot refuses a merge in progress; a tolerant one captures it', async () => {
    const r = await conflicted();
    await expect(snap(r)).rejects.toBeInstanceOf(HandsfreeRefusal);
    const s = await snap(r, { tolerant: true });
    const c = s.checkouts[0];
    expect(s.tolerant).toBe(true);
    expect(c.inProgress?.MERGE_HEAD).toBe(sh(r, 'rev-parse', 'other').trim());
    expect(sh(r, 'cat-file', 'blob', `${c.worktreeTree}:a.txt`)).toMatch(/<<<<<<<[\s\S]*>>>>>>>/);
    expect(sh(r, 'rev-parse', `refs/handsfree/snap/t1/${c.checkoutId}/inprogress/MERGE_HEAD`).trim()).toBe(c.inProgress!.MERGE_HEAD);
    expect(snapshotBundleRefs(s)).toContain(`refs/handsfree/snap/t1/${c.checkoutId}/inprogress/MERGE_HEAD`);
  });
});

describe('bundles', () => {
  it('creates to a file and to a stream, fetches into the quarantine with only allow-listed refs', async () => {
    const r = makeRepo();
    sh(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    sh(r, 'update-ref', 'refs/replace/evil', 'HEAD');
    sh(r, 'stash', 'list');
    const s = await snap(r, { includeRemotes: true });
    const refs = [...snapshotBundleRefs(s), 'refs/replace/evil'];
    const file = join(home, 'b.bundle');
    expect((await createBundle(run, r, { refs, knownTips: [], out: file })).created).toBe(true);
    const streamed = join(home, 's.bundle');
    expect((await createBundle(run, r, { refs, knownTips: [], out: createWriteStream(streamed) })).created).toBe(true);
    expect(readFileSync(streamed).subarray(0, 20).toString()).toMatch(/^# v[23] git bundle/);

    const dst = join(home, 'dst');
    mkdirSync(dst);
    sh(dst, 'init', '-q');
    const fetched = await fetchBundle(run, dst, streamed, { trip: 't1' });
    expect(Object.keys(fetched).sort()).toEqual([
      'refs/heads/main',
      snapIndexRef('t1', s.checkouts[0].checkoutId),
      snapWorktreeRef('t1', s.checkouts[0].checkoutId),
    ].sort());
    expect(sh(dst, 'for-each-ref', '--format=%(refname)').trim().split('\n').sort()).toEqual(
      Object.keys(fetched).map((x) => incomingRefFor('t1', x)).sort(),
    );
    // Remote-tracking refs are accepted only when asked (the cloud at go).
    const withRemotes = await fetchBundle(run, dst, file, { trip: 't1', acceptRemotes: true });
    expect(withRemotes['refs/remotes/origin/main']).toBeDefined();
    expect(withRemotes['refs/replace/evil']).toBeUndefined();
  });

  it('nothing new → no bundle; a tip the sender lacks is dropped; a receiver missing prerequisites is refused', async () => {
    const r = makeRepo();
    const head = sh(r, 'rev-parse', 'HEAD').trim();
    const none = await createBundle(run, r, { refs: ['refs/heads/main'], knownTips: [head], out: join(home, 'x.bundle') });
    expect(none.created).toBe(false);
    expect(existsSync(join(home, 'x.bundle'))).toBe(false);
    put(r, 'c.txt', 'c');
    sh(r, 'add', '.');
    sh(r, 'commit', '-qm', 'c2');
    const unknown = 'f'.repeat(40);
    const delta = await createBundle(run, r, { refs: ['refs/heads/main'], knownTips: [head, unknown], out: join(home, 'd.bundle') });
    expect(delta).toEqual({ created: true, droppedTips: [unknown] });
    const empty = join(home, 'empty');
    mkdirSync(empty);
    sh(empty, 'init', '-q');
    await expect(fetchBundle(run, empty, join(home, 'd.bundle'), { trip: 't1' })).rejects.toBeInstanceOf(BundlePrerequisiteError);
  });
});

describe('parseRepoSnapshot (untrusted side)', () => {
  it('accepts a real snapshot and refuses bad HEADs, refs and ids', async () => {
    const r = makeRepo();
    const s = JSON.parse(JSON.stringify(await snap(r))) as RepoSnapshot;
    expect(parseRepoSnapshot(s, 't1')).toBeTruthy();
    const bad = (mut: (x: RepoSnapshot) => void) => {
      const c = JSON.parse(JSON.stringify(s)) as RepoSnapshot;
      mut(c);
      return () => parseRepoSnapshot(c, 't1');
    };
    expect(bad((x) => { x.checkouts[0].head = { kind: 'symref', ref: 'refs/tags/v1', oid: null }; })).toThrow(/refs\/heads/);
    expect(bad((x) => { x.checkouts[0].head = { kind: 'detached', oid: 'HEAD~1' }; })).toThrow(/commit id/);
    expect(bad((x) => { x.refs['refs/replace/abc'] = x.refs['refs/heads/main']; })).toThrow(/not allowed/);
    expect(bad((x) => { x.refs['refs/heads/../../x'] = x.refs['refs/heads/main']; })).toThrow(/not allowed/);
    // W2: `tolerant` must be a real boolean (a string 'false' is truthy downstream).
    expect(bad((x) => { (x as unknown as { tolerant: unknown }).tolerant = 'false'; })).toThrow(/tolerant must be a boolean/);
    expect(bad((x) => { delete (x as unknown as { tolerant?: unknown }).tolerant; })).toThrow(/tolerant must be a boolean/);
    expect(bad((x) => { x.stash.push({ oid: x.refs['refs/heads/main'], message: 'a\nb' }); })).toThrow(/stash/);
    expect(bad((x) => { x.checkouts[0].checkoutId = '../x'; })).toThrow(/checkout id/);
    expect(() => parseRepoSnapshot(s, 't2')).toThrow(/trip/);
  });
});

describe('D19: links that cannot travel', () => {
  it('gitPreflight refuses a tracked /abs link (and a/../b), naming the file; a ./x link passes', async () => {
    const r = makeRepo();
    execFileSync('ln', ['-s', './a.txt', join(r, 'dot')]);
    sh(r, 'add', 'dot');
    sh(r, 'commit', '-qm', 'dot');
    expect(await gitPreflight(run, r)).toEqual([]);
    expect((await snap(r)).checkouts).toHaveLength(1);

    execFileSync('ln', ['-s', '/usr/bin/python3', join(r, 'py')]);
    sh(r, 'add', 'py');
    execFileSync('ln', ['-s', 'sub/../a.txt', join(r, 'alias')]); // untracked, in the worktree
    const problems = await gitPreflight(run, r);
    expect(problems.filter((p) => p.kind === 'bad_link').map((p) => p.path).sort()).toEqual(['alias', 'py']);
    expect(problems.find((p) => p.path === 'py')!.detail).toMatch(/rewrite it as a relative link or ignore it/);
    await expect(snap(r)).rejects.toMatchObject({ kind: 'bad_link' });
  });
});

describe('D19 amended: the cloud checks links lexically only', () => {
  it('a tracked link that escapes only through cloud-only content does not refuse the cloud snapshot', async () => {
    const r = makeRepo();
    put(r, '.gitignore', 'node_modules/\n');
    execFileSync('ln', ['-s', 'node_modules/pkg/skill', join(r, 'skill')]);
    sh(r, 'add', '.gitignore', 'skill');
    sh(r, 'commit', '-qm', 'skill link');
    // Cloud-only: the install made node_modules/pkg an absolute link outside the repo.
    mkdirSync(join(r, 'node_modules'));
    mkdirSync(join(home, 'outside', 'pkg', 'skill'), { recursive: true });
    execFileSync('ln', ['-s', join(home, 'outside', 'pkg'), join(r, 'node_modules', 'pkg')]);
    expect((await gitPreflight(run, r, { side: 'cloud' })).filter((p) => p.kind === 'bad_link')).toEqual([]);
    expect((await snap(r, { side: 'cloud' })).checkouts).toHaveLength(1);
    // The laptop keeps the physical check.
    expect((await gitPreflight(run, r)).map((p) => p.path)).toContain('skill');
    await expect(snap(r)).rejects.toMatchObject({ kind: 'bad_link', path: 'skill' });
    // A non-canonical target is still refused on the cloud (lexical).
    execFileSync('ln', ['-s', '/usr/bin/python3', join(r, 'py')]);
    sh(r, 'add', 'py');
    await expect(snap(r, { side: 'cloud' })).rejects.toMatchObject({ kind: 'bad_link', path: 'py' });
  });
});
