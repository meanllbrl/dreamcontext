/**
 * `super clean`'s sweep of ~/.claude-worktrees (CPU RCA K1): a dry-run plan of what goes and
 * what stays, with sizes, categories and reasons; a real run only re-checks and acts on it.
 * Every case here runs on scratch fixtures: never on the machine's real worktrees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILD_IDLE_MS, RELEASE_IDLE_MS, STALE_IDLE_MS, applySweep, childHolds, classify, globalCliTargets, inspectWorktree,
  nodeModulesDirs, planSweep, renderPlan, type SweepGuards, type WorktreeFacts,
} from '../../src/lib/super/worktree-sweep.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const W = '/h/.claude-worktrees';

const facts = (name: string, over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  path: `${W}/${name}`, shape: 'worktree', repo: '/h/code/app', branch: `super/${name}`, dirty: false, safe: true, merged: true,
  lastActive: NOW - 30 * DAY, heavy: [], ...over,
});
const guards = (over: Partial<SweepGuards> = {}): SweepGuards => ({ inUse: [], commands: [], cliTargets: [], held: new Map(), ended: new Map(), ...over });

describe('classify', () => {
  it.each([
    ['a process cwd inside it', facts('a'), guards({ inUse: [`${W}/a/src`] }), 'in-use'],
    ['a command line naming it', facts('a'), guards({ commands: [`node ${W}/a/dist/index.js dashboard`] }), 'in-use'],
    ['process listing failed', facts('a'), guards({ inUse: null }), 'in-use'],
    ['the global CLI link target', facts('app-super-yayin-0360'), guards({ cliTargets: [`${W}/app-super-yayin-0360/dist/index.js`] }), 'global-cli'],
    ['a live or asking child', facts('a'), guards({ held: new Map([[`${W}/a`, 'child x is not ended']]) }), 'live-child'],
    ['uncommitted changes', facts('a', { dirty: true }), guards(), 'dirty'],
    ['status unreadable', facts('a', { dirty: null }), guards(), 'dirty'],
    ['commits on no other ref', facts('a', { safe: false, merged: false }), guards(), 'unmerged'],
    ['recently active', facts('a', { lastActive: NOW - DAY / 2, heavy: [`${W}/a/node_modules`] }), guards(), 'recent'],
    ['a main checkout', facts('a', { shape: 'main-checkout' }), guards(), 'main-checkout'],
    ['no .git', facts('a', { shape: 'not-a-worktree' }), guards(), 'not-a-worktree'],
    ['admin dir gone', facts('a', { shape: 'broken' }), guards(), 'unreadable'],
  ] as const)('keeps a worktree with %s', (_label, f, g, reason) => {
    const v = classify(f, g, NOW);
    expect(v).toMatchObject({ action: 'keep', reason });
  });

  it('does not mistake a sibling whose name starts the same for in use', () => {
    const g = guards({ inUse: [`${W}/app-surum-03550/x`], commands: [`node ${W}/app-surum-03550/dist/index.js`] });
    expect(classify(facts('app-surum-0355'), g, NOW).action).toBe('remove');
  });

  it('removes an ended child\'s merged worktree at once, whatever its age', () => {
    const g = guards({ ended: new Map([[`${W}/a`, { child: 'kid', endedAt: NOW - 1000 }]]) });
    expect(classify(facts('a', { lastActive: NOW }), g, NOW)).toMatchObject({ action: 'remove', category: 'child-worktree' });
    // Ended but only pushed (not merged): waits for the stale bar like any other.
    expect(classify(facts('a', { lastActive: NOW, merged: false }), g, NOW)).toMatchObject({ action: 'keep', reason: 'recent' });
  });

  it('removes a release worktree after 2 days idle, any other after 7, strips build output after 1', () => {
    const at = (ms: number) => NOW - ms;
    expect(classify(facts('app-super-surum-0355', { lastActive: at(RELEASE_IDLE_MS) }), guards(), NOW)).toMatchObject({ action: 'remove', category: 'release-worktree' });
    expect(classify(facts('app-super-pano', { lastActive: at(RELEASE_IDLE_MS) }), guards(), NOW)).toMatchObject({ action: 'keep', reason: 'recent' });
    expect(classify(facts('app-super-pano', { lastActive: at(STALE_IDLE_MS), merged: false }), guards(), NOW)).toMatchObject({ action: 'remove', category: 'stale-worktree' });
    expect(classify(facts('app-super-pano', { lastActive: at(BUILD_IDLE_MS), heavy: [`${W}/app-super-pano/node_modules`] }), guards(), NOW)).toMatchObject({ action: 'strip' });
  });
});

describe('childHolds', () => {
  it('holds a not-ended child\'s tree and an ended one with an open question, in any vault', () => {
    const { held, ended } = childHolds([
      { vault: 'own', own: true, state: {
        children: {
          a: { worktree: '/w/a' },
          b: { worktree: '/w/b', endedAt: 5 },
          c: { worktree: '/w/c', endedAt: 5, branch: 'super/c' },
          d: { worktree: '/w/a', endedAt: 5 },
        },
        queue: [{ sessionId: 'b', state: 'escalated' }, { sessionId: 'c', state: 'done' }],
      } },
      { vault: 'other', state: { children: { z: { worktree: '/w/z' }, y: { worktree: '/w/y', endedAt: 1 } } } },
    ]);
    expect([...held.keys()].sort()).toEqual(['/w/a', '/w/b', '/w/z']);
    // Only this vault's ended children are recorded (their state gets cleared after removal);
    // a successor (a) still holds what an ended predecessor (d) names.
    expect([...ended.keys()]).toEqual(['/w/c']);
    expect(ended.get('/w/c')).toEqual({ child: 'c', branch: 'super/c', endedAt: 5 });
  });
});

describe('globalCliTargets', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'super-sweep-cli-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('follows nvm links and the desktop app\'s recorded CLI path to their real files', async () => {
    const target = join(home, '.claude-worktrees', 'app-yayin-1', 'dist');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'index.js'), '');
    const bin = join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(target, 'index.js'), join(bin, 'dreamcontext'));
    const out = await globalCliTargets(home, '');
    expect(out.some((p) => p.endsWith(join('app-yayin-1', 'dist', 'index.js')))).toBe(true);
  });
});

// ── on real git fixtures ────────────────────────────────────────────────────────────

describe('planSweep and applySweep on a scratch root', () => {
  let base: string;
  let repo: string;
  let root: string;
  const savedEnv = { ...process.env };
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  const fill = (dir: string, kb: number) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'blob'), Buffer.alloc(kb * 1024, 1)); };
  const wt = (name: string, from = 'main') => { const p = join(root, name); g(repo, 'worktree', 'add', '-q', '-b', `super/${name}`, p, from); return p; };
  const commit = (p: string, file: string) => { writeFileSync(join(p, file), `${file}\n`); g(p, 'add', '.'); g(p, 'commit', '-q', '-m', file); };
  /** Age a worktree: its folder and its admin dir's HEAD / index / reflog. */
  const age = (p: string, days: number) => {
    const t = (Date.now() - days * DAY) / 1000;
    const admin = join(repo, '.git', 'worktrees', p.split('/').pop()!);
    for (const f of [p, join(admin, 'HEAD'), join(admin, 'index'), join(admin, 'logs', 'HEAD')]) if (existsSync(f)) utimesSync(f, t, t);
  };

  beforeEach(() => {
    Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' });
    base = mkdtempSync(join(tmpdir(), 'super-sweep-base-'));
    repo = join(base, 'code', 'app');
    root = join(base, '.claude-worktrees');
    mkdirSync(repo, { recursive: true });
    mkdirSync(root);
    g(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ntarget/\n');
    commit(repo, 'README.md');
    mkdirSync(join(repo, 'desktop'));
    commit(repo, join('desktop', 'Cargo.toml'));
    g(base, 'init', '-q', '--bare', 'remote.git');
    g(repo, 'remote', 'add', 'origin', join(base, 'remote.git'));
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    rmSync(base, { recursive: true, force: true });
  });

  it('plans every folder into one row, then removes only those rows and keeps every branch', { timeout: 60_000 }, async () => {
    const release = wt('app-super-surum-0101');
    fill(join(release, 'node_modules', 'x'), 300);
    const pushed = wt('app-super-old-pushed');
    commit(pushed, 'pushed.txt');
    g(pushed, 'push', '-q', 'origin', 'super/app-super-old-pushed');
    const unmerged = wt('app-super-old-local');
    commit(unmerged, 'local.txt');
    fill(join(unmerged, 'node_modules', 'y'), 200);
    const dirty = wt('app-super-old-dirty');
    writeFileSync(join(dirty, 'wip.txt'), 'x\n');
    const building = wt('app-super-building');
    fill(join(building, 'node_modules', 'z'), 400);
    fill(join(building, 'desktop', 'target', 'debug'), 500);
    // A shared node_modules link is never followed nor removed.
    const shared = join(base, 'shared-node-modules');
    fill(shared, 100);
    mkdirSync(join(building, 'dashboard'), { recursive: true });
    symlinkSync(shared, join(building, 'dashboard', 'node_modules'));
    const fresh = wt('app-super-fresh');
    fill(join(fresh, 'node_modules', 'w'), 100);
    const inUse = wt('app-super-surum-0102');
    const loose = join(root, 'loose-folder');
    fill(loose, 10);
    age(release, 3); age(pushed, 8); age(unmerged, 8); age(dirty, 8); age(building, 1.5); age(inUse, 9);

    const gd = guards({ inUse: [join(inUse, 'src')] });
    const plan = await planSweep({ root, guards: gd });
    const row = (p: string) => plan.items.find((i) => i.path === p) ?? plan.kept.find((k) => k.path === p);
    expect(row(release)).toMatchObject({ category: 'release-worktree' });
    expect(row(pushed)).toMatchObject({ category: 'stale-worktree' });
    expect(row(building)).toMatchObject({ category: 'build-output' });
    expect((row(building) as { remove: string[] }).remove.sort()).toEqual([join(building, 'desktop', 'target'), join(building, 'node_modules')].sort());
    expect(row(unmerged)).toMatchObject({ reason: 'unmerged' });
    expect((row(unmerged) as { heavyBytes?: number }).heavyBytes).toBeGreaterThan(150 * 1024);
    expect(row(dirty)).toMatchObject({ reason: 'dirty' });
    expect(row(fresh)).toMatchObject({ reason: 'recent' });
    expect(row(inUse)).toMatchObject({ reason: 'in-use' });
    expect(row(loose)).toMatchObject({ reason: 'not-a-worktree' });
    expect(plan.items.length + plan.kept.length).toBe(8);
    expect(plan.totals['release-worktree']).toMatchObject({ count: 1 });
    expect(plan.totals['release-worktree'].bytes).toBeGreaterThan(300 * 1024);
    expect(plan.bytes).toBe(plan.items.reduce((n, i) => n + i.bytes, 0));
    expect(renderPlan(plan)).toContain('release-worktree');
    // Planning removed nothing.
    for (const p of [release, pushed, join(building, 'node_modules')]) expect(existsSync(p)).toBe(true);

    const result = await applySweep(plan, gd);
    expect(result.failed).toEqual([]);
    expect(result.removed.sort()).toEqual([release, pushed, building].sort());
    expect(existsSync(release)).toBe(false);
    expect(existsSync(pushed)).toBe(false);
    expect(existsSync(building)).toBe(true);
    expect(existsSync(join(building, 'node_modules'))).toBe(false);
    expect(existsSync(join(building, 'desktop', 'target'))).toBe(false);
    expect(existsSync(join(building, 'desktop', 'Cargo.toml'))).toBe(true);
    expect(existsSync(join(shared, 'blob'))).toBe(true);
    for (const p of [unmerged, dirty, fresh, inUse, loose]) expect(existsSync(p)).toBe(true);
    expect(g(repo, 'branch', '--list', 'super/app-super-surum-0101')).toContain('super/app-super-surum-0101');
    expect(g(repo, 'branch', '--list', 'super/app-super-old-pushed')).toContain('super/app-super-old-pushed');
  });

  it('a real run skips a row whose facts changed after the plan', { timeout: 30_000 }, async () => {
    const release = wt('app-super-yayin-0200');
    age(release, 5);
    const plan = await planSweep({ root, guards: guards() });
    expect(plan.items.map((i) => i.path)).toEqual([release]);
    writeFileSync(join(release, 'late-edit.txt'), 'x\n');
    const r1 = await applySweep(plan, guards());
    expect(r1.removed).toEqual([]);
    expect(r1.failed[0].message).toContain('changed since the plan');
    rmSync(join(release, 'late-edit.txt'));
    // A process started working in it: kept too.
    const r2 = await applySweep(plan, guards({ commands: [`vitest --root ${release}`] }), { now: Date.now() });
    expect(r2.removed).toEqual([]);
    expect(existsSync(release)).toBe(true);
  });

  it('inspectWorktree reads git\'s facts and finds only real node_modules', async () => {
    const p = wt('app-super-facts');
    fill(join(p, 'node_modules', 'a', 'node_modules', 'b'), 1);
    fill(join(p, 'dashboard', 'node_modules', 'c'), 1);
    const f = await inspectWorktree(p);
    expect(f).toMatchObject({ shape: 'worktree', branch: 'super/app-super-facts', dirty: false, safe: true, merged: true });
    expect(f.repo).toBe(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf-8' }).trim());
    expect((await nodeModulesDirs(p)).sort()).toEqual([join(p, 'dashboard', 'node_modules'), join(p, 'node_modules')].sort());
    expect((await inspectWorktree(repo)).shape).toBe('main-checkout');
  });
});
