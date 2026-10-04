// Hands-free git receive (Transport 1) with real git in temp repos. A "laptop" repo goes to
// a "cloud" repo under a second scratch home (the harness path map), the cloud works, and
// Return brings everything back: equality of status/refs/stash (AC2, AC7), divergence park
// (AC8), per-path conflicts, backup + Roll back and crash replay (AC11), and the AC9
// refusals on the receiving side (fsck .GIT, backslash, 160000, root-escaping symlink, HEAD,
// case / NFC collisions, case-only rename).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitError, HandsfreeRefusal, createBundle, createSpawnRunner, fetchBundle, parseRepoSnapshot, snapshotBundleRefs, snapshotId,
  snapshotRepo, type ProcessRunner, type RepoSnapshot,
} from '../../src/lib/handsfree/git-snapshot.js';
import {
  applyIndex, applyWorktreePlan, divergence, gitOpHandlers, planRepoApply, planWorktree, setHead, verifyIncoming,
} from '../../src/lib/handsfree/git-apply.js';
import { BackupStore } from '../../src/lib/handsfree/apply.js';
import { createJournal, journalPath, loadJournal, rollbackJournal, runJournal, tripDir, type OpHandlers } from '../../src/lib/handsfree/journal.js';
import { rootIdFor } from '../../src/lib/handsfree/manifest.js';

vi.setConfig({ testTimeout: 120_000 });

let home: string;
let laptopHome: string;
let cloudHome: string;
let env: Record<string, string>;
let run: ProcessRunner;

function gitEnv(h: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) e[k] = v;
  const cfg = join(h, '.gitconfig');
  writeFileSync(cfg, '[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  return { ...e, HOME: h, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };
}
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const put = (root: string, rel: string, data: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), data);
};
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

/** Checkout ids derive from the LAPTOP path (the cloud maps its path back). */
const idFor = (abs: string) => rootIdFor(abs.startsWith(cloudHome) ? laptopHome + abs.slice(cloudHome.length) : abs);

/** What AC2/AC7 compare: porcelain v2 status, refs and the stash list with messages. */
function state(repo: string) {
  return {
    status: sh(repo, 'status', '--porcelain=v2'),
    refs: sh(repo, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/notes'),
    stash: sh(repo, 'stash', 'list', '--format=%H %gs'),
    head: sh(repo, 'symbolic-ref', '-q', 'HEAD').trim(),
  };
}

function laptopRepo(): string {
  const r = join(laptopHome, 'projects', 'app');
  mkdirSync(r, { recursive: true });
  sh(r, 'init', '-q');
  put(r, 'a.txt', 'a1\n');
  put(r, 'b.txt', 'b1\n');
  put(r, 'README.md', 'readme\n');
  sh(r, 'add', '.');
  sh(r, 'commit', '-qm', 'c1');
  return r;
}

async function snap(repo: string, extra: Partial<Parameters<typeof snapshotRepo>[2]> = {}): Promise<RepoSnapshot> {
  return snapshotRepo(run, repo, { trip: 't1', checkoutIdFor: idFor, ...extra });
}

async function runPlan(side: 'laptop' | 'cloud', direction: 'go' | 'return', ops: Parameters<typeof createJournal>[1]['ops'], wrap?: (h: OpHandlers) => OpHandlers) {
  const dir = tripDir(join(side === 'laptop' ? laptopHome : cloudHome, '.dreamcontext', 'handsfree'), 't1');
  mkdirSync(dir, { recursive: true });
  const p = journalPath(dir, direction);
  createJournal(p, { trip: 't1', direction, ops });
  const base = gitOpHandlers(run, { tripDir: dir });
  const h = wrap ? wrap(base) : base;
  return { dir, path: p, handlers: h, run: () => runJournal(p, h) };
}

/** Go: laptop snapshot → bundle → cloud fetch + verify → journal apply (mirror policy). */
async function go(L: string): Promise<{ C: string; start: RepoSnapshot }> {
  const start = await snap(L, { includeRemotes: true });
  const bundle = join(home, 'go.bundle');
  await createBundle(run, L, { refs: snapshotBundleRefs(start), knownTips: [], out: bundle });
  const C = join(cloudHome, 'projects', 'app');
  mkdirSync(C, { recursive: true });
  sh(C, 'init', '-q');
  const fetched = await fetchBundle(run, C, bundle, { trip: 't1', acceptRemotes: true });
  const incoming = parseRepoSnapshot(JSON.parse(JSON.stringify(start)), 't1');
  await verifyIncoming(run, C, incoming, fetched);
  const plan = await planRepoApply(run, {
    repoPath: C, trip: 't1', incoming, fetched, receiverStart: null, receiverNow: null,
    localCheckouts: { [idFor(C)]: C }, policy: 'overwrite', strict: false,
  });
  await (await runPlan('cloud', 'go', plan.ops)).run();
  return { C, start };
}

/** Return: cloud snapshot → bundle → laptop fetch + verify → S_now → plan → journal. */
async function prepareReturn(L: string, C: string, start: RepoSnapshot, wrap?: (h: OpHandlers) => OpHandlers) {
  const cs = await snap(C);
  const bundle = join(home, 'return.bundle');
  await createBundle(run, C, { refs: snapshotBundleRefs(cs), knownTips: Object.values(start.refs), out: bundle });
  const fetched = await fetchBundle(run, L, bundle, { trip: 't1' });
  const incoming = parseRepoSnapshot(JSON.parse(JSON.stringify(cs)), 't1');
  await verifyIncoming(run, L, incoming, fetched);
  const now = await snap(L, { writeRefs: false });
  const plan = await planRepoApply(run, {
    repoPath: L, trip: 't1', incoming, fetched, receiverStart: start, receiverNow: now,
    localCheckouts: { [idFor(L)]: L }, policy: 'conflict', strict: true,
  });
  const j = await runPlan('laptop', 'return', plan.ops, wrap);
  return { plan, j, cs, fetched };
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-gapply-')));
  laptopHome = join(home, 'laptop-home');
  cloudHome = join(home, 'cloud-home');
  mkdirSync(laptopHome);
  mkdirSync(cloudHome);
  env = gitEnv(home);
  run = createSpawnRunner({ baseEnv: env });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('round trip', () => {
  it('go makes the cloud equal; Return lands commits, branches, tags, stash (order + messages), staged, unstaged, untracked and deletions', async () => {
    const L = laptopRepo();
    sh(L, 'branch', 'feature');
    sh(L, 'tag', '-a', 'v1', '-m', 'v1');
    put(L, 'a.txt', 'stashed 1\n');
    sh(L, 'stash', 'push', '-m', 'laptop stash one');
    put(L, 'b.txt', 'stashed 2\n');
    sh(L, 'stash', 'push', '-m', 'laptop stash two');
    put(L, 'a.txt', 'staged\n');
    sh(L, 'add', 'a.txt');
    put(L, 'a.txt', 'staged + unstaged\n');
    put(L, 'notes/untracked.md', 'u\n');
    rmSync(join(L, 'b.txt'));

    const { C, start } = await go(L);
    expect(state(C)).toEqual(state(L));
    expect(snapshotId(await snap(C))).toBe(snapshotId(start));
    expect(read(C, 'a.txt')).toBe('staged + unstaged\n');

    // The phone drives the cloud.
    sh(C, 'stash', 'push', '-m', 'cloud stash three');
    put(C, 'c.txt', 'from the cloud\n');
    sh(C, 'add', 'c.txt');
    sh(C, 'commit', '-qm', 'cloud commit');
    sh(C, 'branch', 'cloud-branch');
    sh(C, 'tag', 'v2');
    put(C, 'a.txt', 'cloud staged\n');
    sh(C, 'add', 'a.txt');
    put(C, 'README.md', 'cloud unstaged\n');
    put(C, 'scratch/new.txt', 'cloud untracked\n');
    rmSync(join(C, 'notes', 'untracked.md'));

    const { plan, j } = await prepareReturn(L, C, start);
    expect(plan.divergence.kind).toBe('clean');
    await j.run();
    expect(state(L)).toEqual(state(C));
    expect(sh(L, 'stash', 'list', '--format=%gs').trim().split('\n')).toEqual([
      'On main: cloud stash three', 'On main: laptop stash two', 'On main: laptop stash one',
    ]);
    expect(read(L, 'scratch/new.txt')).toBe('cloud untracked\n');
    expect(existsSync(join(L, 'notes'))).toBe(false);
    // Laptop refs were backed up before any update (AC9).
    expect(sh(L, 'rev-parse', 'refs/handsfree/backup/t1/heads/main').trim()).toBe(start.refs['refs/heads/main']);
    expect(sh(L, 'rev-parse', 'refs/handsfree/backup/t1/stash/0').trim()).toBe(start.stash[0].oid);
  });

  it('an unborn repository travels', async () => {
    const L = join(laptopHome, 'projects', 'app');
    mkdirSync(L, { recursive: true });
    sh(L, 'init', '-q');
    put(L, 'first.txt', 'x\n');
    sh(L, 'add', 'first.txt');
    put(L, 'loose.txt', 'y\n');
    const { C } = await go(L);
    expect(state(C)).toEqual(state(L));
    expect(() => sh(C, 'rev-parse', '-q', '--verify', 'HEAD')).toThrow();
    expect(sh(C, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
  });
});

describe('divergence', () => {
  it('a laptop commit while away parks the cloud refs and leaves the laptop untouched', async () => {
    const L = laptopRepo();
    const { C, start } = await go(L);
    put(C, 'c.txt', 'cloud\n');
    sh(C, 'add', '.');
    sh(C, 'commit', '-qm', 'cloud');
    put(L, 'l.txt', 'laptop\n');
    sh(L, 'add', '.');
    sh(L, 'commit', '-qm', 'laptop while away');
    const before = state(L);
    const { plan, j } = await prepareReturn(L, C, start);
    expect(plan.divergence.kind).toBe('diverged');
    expect(plan.ops.map((o) => o.kind)).toEqual(['git.park']);
    await j.run();
    expect(state(L)).toEqual(before);
    expect(sh(L, 'rev-parse', 'refs/handsfree/t1/heads/main').trim()).toBe(sh(C, 'rev-parse', 'main').trim());
    expect(sh(L, 'for-each-ref', '--format=%(refname)', 'refs/handsfree/t1/snap/')).toContain('/worktree');
  });

  it('divergence() classifies worktree-only edits apart from ref/HEAD/stash/index changes', async () => {
    const L = laptopRepo();
    const s0 = await snap(L, { writeRefs: false });
    put(L, 'a.txt', 'edited\n');
    expect(divergence(s0, await snap(L, { writeRefs: false })).kind).toBe('worktree-only');
    sh(L, 'add', 'a.txt');
    expect(divergence(s0, await snap(L, { writeRefs: false }))).toMatchObject({ kind: 'diverged' });
  });

  it('worktree-only laptop edits resolve per path: the laptop keeps its file, the cloud copy goes to conflicts', async () => {
    const L = laptopRepo();
    const { C, start } = await go(L);
    put(C, 'a.txt', 'cloud a\n');
    put(C, 'b.txt', 'cloud b\n');
    put(L, 'a.txt', 'laptop a\n');
    put(L, 'laptop-only.txt', 'mine\n');
    const { plan, j } = await prepareReturn(L, C, start);
    expect(plan.divergence.kind).toBe('worktree-only');
    const done = await j.run();
    expect(read(L, 'a.txt')).toBe('laptop a\n');
    expect(read(L, 'b.txt')).toBe('cloud b\n');
    expect(read(L, 'laptop-only.txt')).toBe('mine\n');
    const wt = done.ops.find((o) => o.kind === 'git.worktree')!;
    const scope = (wt.params as { scope: string }).scope;
    expect(read(join(j.dir, 'conflicts', scope), 'a.txt')).toBe('cloud a\n');
    expect((wt.result as { conflicts: Array<{ path: string; reason: string }> }).conflicts).toEqual([{ path: 'a.txt', reason: 'changed on both sides' }]);
  });
});

describe('crash safety', () => {
  async function scenario() {
    const L = laptopRepo();
    put(L, 'a.txt', 'pre-return unstaged\n');
    sh(L, 'stash', 'push', '-m', 'pre-return stash');
    const { C, start } = await go(L);
    put(C, 'new.txt', 'n\n');
    sh(C, 'add', '.');
    sh(C, 'commit', '-qm', 'cloud');
    sh(C, 'checkout', '-qb', 'cloud-topic');
    sh(C, 'stash', 'list');
    put(C, 'b.txt', 'cloud edit\n');
    put(C, 'tmp/x.txt', 'x\n');
    rmSync(join(C, 'README.md'));
    return { L, C, start };
  }

  it('a crash mid-return resumes from the journal; completed ops are not re-applied', async () => {
    const { L, C, start } = await scenario();
    const calls: string[] = [];
    let crashed = false;
    const wrap = (h: OpHandlers): OpHandlers => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, {
      ...v,
      apply: async (op) => {
        calls.push(op.kind);
        if (k === 'git.index' && !crashed) { crashed = true; throw new Error('killed'); }
        return v.apply(op);
      },
    }]));
    const { j } = await prepareReturn(L, C, start, wrap);
    await expect(j.run()).rejects.toThrow('killed');
    expect(loadJournal(j.path)!.ops.find((o) => o.kind === 'git.index')!.state).toBe('started');
    await j.run();
    expect(calls.filter((c) => c === 'git.refs')).toHaveLength(1);
    expect(calls.filter((c) => c === 'git.worktree')).toHaveLength(1);
    expect(state(L)).toEqual(state(C));
  });

  it('Roll back restores refs, HEAD, the stash list, the index and every file the return wrote', async () => {
    const { L, C, start } = await scenario();
    const before = state(L);
    const files = { a: read(L, 'a.txt'), b: read(L, 'b.txt'), readme: read(L, 'README.md') };
    const { j } = await prepareReturn(L, C, start);
    await j.run();
    expect(state(L)).toEqual(state(C));
    await rollbackJournal(j.path, j.handlers);
    expect(state(L)).toEqual(before);
    expect({ a: read(L, 'a.txt'), b: read(L, 'b.txt'), readme: read(L, 'README.md') }).toEqual(files);
    expect(existsSync(join(L, 'tmp'))).toBe(false);
    expect(existsSync(join(L, 'new.txt'))).toBe(false);
  });

  it('W2: Roll back removes a created file checked out through autocrlf, and reports a created file the owner changed as kept', async () => {
    const L = laptopRepo();
    sh(L, 'config', 'core.autocrlf', 'true');
    const { C, start } = await go(L);
    put(C, 'crlf.txt', 'line one\nline two\n');
    put(C, 'owner-edits.txt', 'from the cloud\n');
    const { j } = await prepareReturn(L, C, start);
    await j.run();
    // The checkout converted LF -> CRLF: the bytes differ from the git blob.
    expect(read(L, 'crlf.txt')).toBe('line one\r\nline two\r\n');
    put(L, 'owner-edits.txt', 'the owner changed it after the Return\n');
    const rolled = await rollbackJournal(j.path, j.handlers);
    expect(existsSync(join(L, 'crlf.txt'))).toBe(false);
    expect(read(L, 'owner-edits.txt')).toBe('the owner changed it after the Return\n');
    const kept = rolled.ops.flatMap((o) => ((o.undoResult as { kept?: Array<{ path: string }> } | undefined)?.kept ?? []).map((k) => k.path));
    expect(kept).toEqual(['owner-edits.txt']);
  });

  it('W2: a second backup in the same trip (a retried Return) replaces the first instead of failing', async () => {
    const L = laptopRepo();
    const { C, start } = await go(L);
    put(C, 'c.txt', 'c\n');
    sh(C, 'add', '.');
    sh(C, 'commit', '-qm', 'cloud');
    const { j } = await prepareReturn(L, C, start);
    await j.run();
    await rollbackJournal(j.path, j.handlers);
    const again = await prepareReturn(L, C, start);
    await again.j.run();
    expect(state(L)).toEqual(state(C));
    expect(sh(L, 'rev-parse', 'refs/handsfree/backup/t1/heads/main').trim()).toBe(start.refs['refs/heads/main']);
  });
});

describe('receiving-side refusals (AC9)', () => {
  function blob(repo: string, data: string): string {
    return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env, input: data, encoding: 'utf8' }).trim();
  }
  function mktree(repo: string, entries: Array<[string, string, string]>): string {
    const input = entries.map(([mode, oid, name]) => `${mode} ${mode === '160000' ? 'commit' : mode === '040000' ? 'tree' : 'blob'} ${oid}\t${name}`).join('\n') + (entries.length ? '\n' : '');
    return execFileSync('git', ['mktree', '--missing'], { cwd: repo, env, input, encoding: 'utf8' }).trim();
  }

  it('the bundle fetch runs fsck: a tree with a .GIT entry is rejected', async () => {
    const src = laptopRepo();
    const evil = mktree(src, [['040000', mktree(src, [['100644', blob(src, '[core]\n'), 'config']]), '.GIT']]);
    const commit = sh(src, 'commit-tree', evil, '-m', 'evil').trim();
    sh(src, 'update-ref', 'refs/heads/evil', commit);
    const b = join(home, 'evil.bundle');
    await createBundle(run, src, { refs: ['refs/heads/evil'], knownTips: [], out: b });
    const dst = join(home, 'dst');
    mkdirSync(dst);
    sh(dst, 'init', '-q');
    await expect(fetchBundle(run, dst, b, { trip: 't1' })).rejects.toBeInstanceOf(GitError);
    expect(sh(dst, 'for-each-ref')).toBe('');
  });

  it('backslash paths are never written; 160000 entries refuse the plan and the index', async () => {
    const r = laptopRepo();
    const empty = mktree(r, []);
    const bad = mktree(r, [['100644', blob(r, 'x'), 'evil\\name'], ['100644', blob(r, 'ok'), 'ok.txt']]);
    const plan = await planWorktree(run, r, { prevTree: empty, newTree: bad, fromTolerant: false });
    expect(plan.refused.map((x) => x.path)).toEqual(['evil\\name']);
    expect(plan.entries.map((e) => e.path)).toEqual(['ok.txt']);
    await expect(applyIndex(run, r, bad)).rejects.toMatchObject({ kind: 'bad_path' });
    const head = sh(r, 'rev-parse', 'HEAD').trim();
    const gitlink = mktree(r, [['160000', head, 'sub']]);
    await expect(planWorktree(run, r, { prevTree: empty, newTree: gitlink, fromTolerant: false })).rejects.toMatchObject({ kind: 'submodule' });
    await expect(applyIndex(run, r, gitlink)).rejects.toMatchObject({ kind: 'submodule' });
  });

  it('a root-escaping symlink in the cloud refuses the cloud snapshot (D19); an in-tree one is written', async () => {
    const L = laptopRepo();
    const { C, start } = await go(L);
    execFileSync('ln', ['-s', '../../../../outside', join(C, 'evil')]);
    execFileSync('ln', ['-s', 'a.txt', join(C, 'good')]);
    await expect(prepareReturn(L, C, start)).rejects.toMatchObject({ kind: 'bad_link', path: 'evil' });
    rmSync(join(C, 'evil'));
    const { j } = await prepareReturn(L, C, start);
    await j.run();
    expect((() => { try { lstatSync(join(L, 'evil')); return true; } catch { return false; } })()).toBe(false);
    expect(lstatSync(join(L, 'good')).isSymbolicLink()).toBe(true);
  });

  it('a ./x link travels and round-trips (D19)', async () => {
    const L = laptopRepo();
    execFileSync('ln', ['-s', './a.txt', join(L, 'dot')]);
    sh(L, 'add', 'dot');
    sh(L, 'commit', '-qm', 'dot link');
    const { C, start } = await go(L);
    expect(readlinkSync(join(C, 'dot'))).toBe('./a.txt');
    expect(state(C)).toEqual(state(L));
    const { j } = await prepareReturn(L, C, start);
    await j.run();
    expect(readlinkSync(join(L, 'dot'))).toBe('./a.txt');
    expect(state(L)).toEqual(state(C));
  });

  it('HEAD is only a symref to refs/heads/* or a commit id', async () => {
    const r = laptopRepo();
    await expect(setHead(run, r, { kind: 'symref', ref: 'refs/tags/v1', oid: null })).rejects.toBeInstanceOf(HandsfreeRefusal);
    await expect(setHead(run, r, { kind: 'detached', oid: 'main' })).rejects.toBeInstanceOf(HandsfreeRefusal);
    await setHead(run, r, { kind: 'detached', oid: sh(r, 'rev-parse', 'HEAD').trim() });
    expect(sh(r, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD');
  });

  it('case and NFC/NFD collisions in the incoming tree go to conflicts, never to disk', async () => {
    const r = laptopRepo();
    const empty = mktree(r, []);
    const t = mktree(r, [
      ['100644', blob(r, '1'), 'A.txt'], ['100644', blob(r, '2'), 'a.txt'],
      ['100644', blob(r, '3'), 'café.md'], ['100644', blob(r, '4'), 'café.md'],
      ['100644', blob(r, '5'), 'fine.txt'],
    ]);
    const plan = await planWorktree(run, r, { prevTree: empty, newTree: t, fromTolerant: false });
    expect(plan.entries.map((e) => e.path)).toEqual(['fine.txt']);
    expect(plan.conflicts.map((c) => c.path).sort()).toEqual(['A.txt', 'a.txt', 'café.md', 'café.md'].sort());
    const res = await applyWorktreePlan(run, plan, { backup: new BackupStore(join(home, 'bk')), conflictsDir: join(home, 'cf'), policy: 'conflict' });
    expect(res.written).toEqual(['fine.txt']);
    expect(readdirSync(r)).not.toContain('A.txt');
    expect(read(r, 'a.txt')).toBe('a1\n'); // the repo's own a.txt is untouched
    expect(readdirSync(r).filter((n) => n.normalize('NFC') === 'café.md')).toEqual([]);
    // Every colliding cloud copy survives in conflicts/, even on a case-insensitive volume.
    const copies = readdirSync(join(home, 'cf')).map((n) => readFileSync(join(home, 'cf', n), 'utf8')).sort();
    expect(copies).toEqual(['1', '2', '3', '4']);
  });

  it('a case-only rename in the cloud lands with the new spelling (delete before add)', async () => {
    const L = laptopRepo();
    const { C, start } = await go(L);
    sh(C, 'mv', 'README.md', 'Readme.md');
    sh(C, 'commit', '-qm', 'rename');
    const { j } = await prepareReturn(L, C, start);
    await j.run();
    expect(readdirSync(L)).toContain('Readme.md');
    expect(readdirSync(L)).not.toContain('README.md');
    expect(state(L)).toEqual(state(C));
  });
});

describe('symlink chains in the git transport (AC9, shared sweep)', () => {
  function blob(repo: string, data: string): string {
    return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env, input: data, encoding: 'utf8' }).trim();
  }
  function mktree(repo: string, entries: Array<[string, string, string]>): string {
    const input = entries.map(([mode, oid, name]) => `${mode} ${mode === '040000' ? 'tree' : 'blob'} ${oid}\t${name}`).join('\n') + (entries.length ? '\n' : '');
    return execFileSync('git', ['mktree', '--missing'], { cwd: repo, env, input, encoding: 'utf8' }).trim();
  }
  const has = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };

  it('d/l1 -> .. and d/l2 -> l1/..: both refused at write time by the canonical rule (D18), nothing behind', async () => {
    const r = laptopRepo();
    const empty = mktree(r, []);
    const d = mktree(r, [['120000', blob(r, '..'), 'l1'], ['120000', blob(r, 'l1/..'), 'l2']]);
    const t = mktree(r, [['040000', d, 'd']]);
    const plan = await planWorktree(run, r, { prevTree: empty, newTree: t, fromTolerant: false });
    const res = await applyWorktreePlan(run, plan, { backup: new BackupStore(join(home, 'bk')), conflictsDir: join(home, 'cf'), policy: 'conflict' });
    expect(res.refused.map((x) => x.path).sort()).toEqual(['d/l1', 'd/l2']);
    expect(res.written).toEqual([]);
    expect(has(join(r, 'd', 'l1')) || has(join(r, 'd', 'l2'))).toBe(false);
  });

  it('a canonical link through an existing escaping laptop symlink is undone and leaves nothing behind', async () => {
    const r = laptopRepo();
    mkdirSync(join(r, 'd'));
    execFileSync('ln', ['-s', '../..', join(r, 'd', 'lap')]);
    const empty = mktree(r, []);
    const d = mktree(r, [['120000', blob(r, 'lap'), 'x']]);
    const t = mktree(r, [['040000', d, 'd']]);
    const plan = await planWorktree(run, r, { prevTree: empty, newTree: t, fromTolerant: false });
    const res = await applyWorktreePlan(run, plan, { backup: new BackupStore(join(home, 'bk')), conflictsDir: join(home, 'cf'), policy: 'conflict' });
    expect(res.refused).toEqual([{ path: 'd/x', reason: 'symlink resolves outside the root' }]);
    expect(res.written).toEqual([]);
    expect(has(join(r, 'd', 'x'))).toBe(false);
    expect(has(join(r, 'd', 'lap'))).toBe(true);
  });

  it('an over-long link target is refused without aborting the phase', async () => {
    const r = laptopRepo();
    const empty = mktree(r, []);
    const t = mktree(r, [['120000', blob(r, 'a'.repeat(4096)), 'z'], ['120000', blob(r, 'a.txt'), 'ok']]);
    const plan = await planWorktree(run, r, { prevTree: empty, newTree: t, fromTolerant: false });
    const res = await applyWorktreePlan(run, plan, { backup: new BackupStore(join(home, 'bk')), conflictsDir: join(home, 'cf'), policy: 'conflict' });
    expect(res.refused.map((x) => x.path)).toEqual(['z']);
    expect(res.written).toEqual(['ok']);
  });
});

describe('D19 amended: the laptop refuses a cloud-retargeted link and keeps its own (git transport)', () => {
  it('a tracked link retargeted to an absolute path in the incoming tree is refused; the laptop link is unchanged', async () => {
    const r = laptopRepo();
    execFileSync('ln', ['-s', 'a.txt', join(r, 'l')]);
    sh(r, 'add', 'l');
    sh(r, 'commit', '-qm', 'link');
    const prev = sh(r, 'rev-parse', 'HEAD^{tree}').trim();
    const abs = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r, env, input: '/etc/passwd', encoding: 'utf8' }).trim();
    const entries = sh(r, 'ls-tree', prev).trim().split('\n').map((line) => (line.endsWith('\tl') ? `120000 blob ${abs}\tl` : line));
    const next = execFileSync('git', ['mktree'], { cwd: r, env, input: entries.join('\n') + '\n', encoding: 'utf8' }).trim();
    const plan = await planWorktree(run, r, { prevTree: prev, newTree: next, nowTree: prev, fromTolerant: false });
    const res = await applyWorktreePlan(run, plan, { backup: new BackupStore(join(home, 'bk')), conflictsDir: join(home, 'cf'), policy: 'conflict' });
    expect(res.refused).toEqual([{ path: 'l', reason: 'symlink target escapes the root' }]);
    expect(res.written).toEqual([]);
    expect(readlinkSync(join(r, 'l'))).toBe('a.txt');
  });
});

describe('D20: a tolerant (recovery) snapshot is never applied to a working tree', () => {
  it('planRepoApply and planWorktree refuse it', async () => {
    const L = laptopRepo();
    const s = await snap(L, { writeRefs: false });
    const tolerant = { ...s, tolerant: true };
    await expect(planRepoApply(run, {
      repoPath: L, trip: 't1', incoming: tolerant, fetched: {}, receiverStart: s, receiverNow: s,
      localCheckouts: { [idFor(L)]: L }, policy: 'conflict', strict: true,
    })).rejects.toThrow(/tolerant \(recovery\) snapshot is never applied/);
    const tree = s.checkouts[0].worktreeTree;
    await expect(planWorktree(run, L, { prevTree: tree, newTree: tree, fromTolerant: true })).rejects.toMatchObject({ kind: 'bad_snapshot' });
  });
});

describe('D20 round 6: the tolerant origin is required and carried', () => {
  function plainPlan(r: string) {
    const head = sh(r, 'rev-parse', 'HEAD^{tree}').trim();
    const empty = execFileSync('git', ['mktree'], { cwd: r, env, input: '', encoding: 'utf8' }).trim();
    return { head, empty };
  }

  it('planWorktree refuses a tolerant snapshot (and an unknown origin)', async () => {
    const r = laptopRepo();
    const { head, empty } = plainPlan(r);
    await expect(planWorktree(run, r, { prevTree: empty, newTree: head, fromTolerant: true })).rejects.toMatchObject({ kind: 'bad_snapshot' });
    await expect(planWorktree(run, r, { prevTree: empty, newTree: head } as never)).rejects.toThrow(/tolerant \(recovery\) snapshot/);
  });

  it('applyWorktreePlan refuses a plan without the stamp or stamped true; the normal path applies', async () => {
    const r = laptopRepo();
    const { head, empty } = plainPlan(r);
    const target = join(home, 'fresh');
    mkdirSync(target);
    sh(target, 'init', '-q');
    sh(target, 'fetch', '-q', r, 'HEAD');
    const plan = await planWorktree(run, target, { prevTree: empty, newTree: head, fromTolerant: false });
    expect(plan.fromTolerant).toBe(false);
    const ctx = { backup: new BackupStore(join(home, 'bk')), conflictsDir: join(home, 'cf'), policy: 'overwrite' as const };
    const { fromTolerant: _drop, ...unstamped } = plan;
    await expect(applyWorktreePlan(run, unstamped as never, ctx)).rejects.toMatchObject({ kind: 'bad_snapshot' });
    await expect(applyWorktreePlan(run, { ...plan, fromTolerant: true } as never, ctx)).rejects.toMatchObject({ kind: 'bad_snapshot' });
    expect(readdirSync(target)).toEqual(['.git']); // nothing landed
    const ok = await applyWorktreePlan(run, plan, ctx);
    expect(ok.written.sort()).toEqual(['README.md', 'a.txt', 'b.txt']);
  });

  it('the git.worktree journal handler refuses an op whose plan lacks the stamp', async () => {
    const r = laptopRepo();
    const { head, empty } = plainPlan(r);
    const plan = await planWorktree(run, r, { prevTree: empty, newTree: head, fromTolerant: false });
    const { fromTolerant: _drop, ...unstamped } = plan;
    const j = await runPlan('laptop', 'return', [
      { id: 'wt', kind: 'git.worktree', writes: true, params: { scope: 'git-x', plan: unstamped, policy: 'conflict' } },
    ]);
    await expect(j.run()).rejects.toMatchObject({ kind: 'bad_snapshot' });
    expect(loadJournal(j.path)!.ops[0].state).toBe('started');
  });
});
