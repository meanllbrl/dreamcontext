/**
 * kesim-geri-donus K5 / D14 / D15 / D17 (C7, C8 i/iii/vii, C19): the ended-child janitor on
 * scratch repos and a scratch vault. A clean ended worktree goes, its branch stays in git and in
 * the record; a dirty one loses only git-ignored build output; a branch home releases the child.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkedReposFilePath } from '../../src/lib/linked-repos.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';
import { createChildWorktree } from '../../src/lib/super/worktrees.js';
import { applySweep, childHolds, holdForResume, planSweep, readSuperRecords, sweepEnded, type SweepGuards } from '../../src/lib/super/worktree-sweep.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, superIdOfMember, superRecordPath } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperChild, type SuperState } from '../../src/lib/super/types.js';

const URL_ = 'https://github.com/acme/product.git';
let home: string;
let repo: string;
let ctx: string;
const savedEnv = { ...process.env };

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commitIn(dir: string, file: string): void {
  writeFileSync(join(dir, file), `${file}\n`);
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', `edit ${file}`);
}
function writeRecord(children: Record<string, Partial<SuperChild>>, id: 'main' | `m:${string}` = 'main', extra: Partial<SuperState> = {}): void {
  const full: Record<string, SuperChild> = {};
  for (const [k, c] of Object.entries(children)) full[k] = { sessionId: k, brief: k, adopted: false, startedAt: 1, ...c } as SuperChild;
  const path = id === 'main' ? join(ctx, SUPER_STATE_REL) : superRecordPath(ctx, id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...emptySuperState(), session: id === 'main' ? 'sup-main' : 'sup-m1', enabled: true, children: full, ...extra }));
}
/** The guards from the vault's own records, no process listing (tests never read the machine). */
const guardsFrom = (o: { inUse?: string[] | null } = {}) => async () => {
  const { records } = readSuperRecords(ctx, home);
  const { held, ended } = childHolds(records);
  const guards: SweepGuards = { inUse: o.inUse === undefined ? [] : o.inUse, commands: [], cliTargets: [], held, ended };
  return { guards, warnings: [], root: join(home, '.claude-worktrees') };
};
const sweep = (o: { only?: string; inUse?: string[] | null; uses?: (p: string) => Promise<{ inUse: readonly string[] | null; commands: readonly string[] }> } = {}) => sweepEnded({
  root: join(home, '.claude-worktrees'), contextRoot: ctx, home, guards: guardsFrom(o), ...(o.only ? { only: o.only } : {}), ...(o.uses ? { uses: o.uses } : {}),
});

beforeEach(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'super-janitor-')));
  process.env.HOME = home;
  repo = join(home, 'code', 'product');
  mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repo, 'README.md'), 'one\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(linkedReposFilePath(home), JSON.stringify({ repos: { [canonicalRemote(URL_) ?? URL_]: repo } }));
  const project = join(home, 'vault');
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', linkedRepos: [{ name: 'product', gitRemoteUrl: URL_ }] }));
  resetSuperIndex();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(home, { recursive: true, force: true });
});

const mk = (slug: string) => createChildWorktree({ projectRoot: join(home, 'vault'), repo: 'product', slug, home });

describe('sweepEnded', () => {
  it('C8(i) a clean ended worktree goes (branch kept in git and the record); a moved one records lastBranch; a dirty one loses only ignored build output', { timeout: 60_000 }, async () => {
    const a = await mk('a'); commitIn(a.path, 'a.txt');
    const b = await mk('b'); commitIn(b.path, 'b.txt'); g(b.path, 'checkout', '-q', '-b', 'super/b-2'); commitIn(b.path, 'b2.txt');
    const c = await mk('c'); commitIn(c.path, 'c.txt');
    mkdirSync(join(c.path, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(c.path, 'node_modules', 'x', 'f'), 'x');
    writeFileSync(join(c.path, 'wip.txt'), 'uncommitted\n');
    const live = await mk('live'); commitIn(live.path, 'l.txt');
    writeRecord({
      a: { worktree: a.path, branch: a.branch, repo: 'product', endedAt: 5 },
      b: { worktree: b.path, branch: b.branch, repo: 'product', endedAt: 5 },
      c: { worktree: c.path, branch: c.branch, repo: 'product', endedAt: 5 },
      live: { worktree: live.path, branch: live.branch, repo: 'product' },
    });
    const r = await sweep();
    expect(r?.removed.sort()).toEqual([a.path, b.path].sort());
    expect(r?.stripped).toEqual([c.path]);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(live.path)).toBe(true);
    expect(existsSync(join(c.path, 'wip.txt'))).toBe(true);
    expect(existsSync(join(c.path, 'node_modules'))).toBe(false);
    expect(g(repo, 'branch', '--list', 'super/a')).toContain('super/a');
    const s = await readSuperState(ctx, { home });
    expect(s.children.a).toMatchObject({ branch: 'super/a', repo: 'product' });
    expect(s.children.a.worktree).toBeUndefined();
    expect(s.children.b).toMatchObject({ branch: 'super/b', lastBranch: 'super/b-2' });
    expect(s.children.c.worktree).toBe(c.path);
    expect(s.children.live.worktree).toBe(live.path);
  });

  it('C8(vii) inUse unknown: nothing removed; a second round while one runs is skipped and its path tried after', { timeout: 60_000 }, async () => {
    const a = await mk('a'); commitIn(a.path, 'a.txt');
    const b = await mk('b'); commitIn(b.path, 'b.txt');
    writeRecord({ a: { worktree: a.path, branch: a.branch, endedAt: 5 }, b: { worktree: b.path, branch: b.branch, endedAt: 5 } });
    const none = await sweep({ inUse: null });
    expect(none?.removed).toEqual([]);
    expect(existsSync(a.path)).toBe(true);
    const first = sweep({ only: a.path });
    const second = await sweep({ only: b.path });
    expect(second).toBeNull();
    const r = await first;
    expect(r?.removed.sort()).toEqual([a.path, b.path].sort());
  });

  it('review r1: a process that opened the worktree after the round read its guards keeps it (listing re-read per path)', { timeout: 60_000 }, async () => {
    const a = await mk('a'); commitIn(a.path, 'a.txt');
    const b = await mk('b'); commitIn(b.path, 'b.txt');
    writeRecord({ a: { worktree: a.path, branch: a.branch, repo: 'product', endedAt: 5 }, b: { worktree: b.path, branch: b.branch, repo: 'product', endedAt: 5 } });
    // The round's guards say nothing runs; the per-path listing finds a dev server in b.
    const r = await sweep({ uses: async (p) => ({ inUse: p === b.path ? [join(b.path, 'server.log')] : [], commands: [] }) });
    expect(r?.removed).toEqual([a.path]);
    expect(existsSync(b.path)).toBe(true);
    expect(r?.warnings.some((w) => w.includes(b.path) && /running process/.test(w))).toBe(true);
    const s = await readSuperState(ctx, { home });
    expect(s.children.b.worktree).toBe(b.path);
    // A listing that fails keeps it too.
    const none = await sweep({ uses: async () => ({ inUse: null, commands: [] }) });
    expect(none?.removed).toEqual([]);
  });

  it('review r1: a child resumed after the round read its guards is left alone (record re-read under the lock)', { timeout: 60_000 }, async () => {
    const a = await mk('a'); commitIn(a.path, 'a.txt');
    writeRecord({ a: { worktree: a.path, branch: a.branch, repo: 'product', endedAt: 5 } });
    const stale = guardsFrom();
    const snapshot = await stale();
    // Resumed after the snapshot was taken.
    writeRecord({ a: { worktree: a.path, branch: a.branch, repo: 'product' } });
    const r = await sweepEnded({ root: join(home, '.claude-worktrees'), contextRoot: ctx, home, guards: async () => snapshot });
    expect(r?.removed).toEqual([]);
    expect(existsSync(a.path)).toBe(true);
    expect(r?.warnings.some((w) => /resumed/.test(w))).toBe(true);
  });

  it('review r2: a resume in flight (record still ended) holds its worktree: neither removed nor stripped', { timeout: 60_000 }, async () => {
    const a = await mk('a'); commitIn(a.path, 'a.txt');
    const c = await mk('c'); commitIn(c.path, 'c.txt');
    mkdirSync(join(c.path, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(c.path, 'node_modules', 'x', 'f'), 'x');
    writeFileSync(join(c.path, 'wip.txt'), 'uncommitted\n');
    writeRecord({ a: { worktree: a.path, branch: a.branch, repo: 'product', endedAt: 5 }, c: { worktree: c.path, branch: c.branch, repo: 'product', endedAt: 5 } });
    holdForResume('a', true); holdForResume('c', true);
    try {
      const r = await sweep();
      expect(r?.removed).toEqual([]);
      expect(r?.stripped).toEqual([]);
      expect(existsSync(a.path)).toBe(true);
      expect(existsSync(join(c.path, 'node_modules'))).toBe(true);
    } finally { holdForResume('a', false); holdForResume('c', false); }
    const after = await sweep();
    expect(after?.removed).toEqual([a.path]);
  });

  it('review r4: super clean --apply re-reads right before acting and writes a member child\'s removal into the MEMBER\'s record', { timeout: 60_000 }, async () => {
    const m = await mk('mem'); commitIn(m.path, 'm.txt');
    g(m.path, 'checkout', '-q', '-b', 'fix/m'); commitIn(m.path, 'm2.txt');
    const r = await mk('res'); commitIn(r.path, 'r.txt');
    writeRecord({ res: { worktree: r.path, branch: r.branch, repo: 'product', endedAt: 5 } });
    const id = superIdOfMember('pm');
    writeRecord({ mk: { worktree: m.path, branch: m.branch, repo: 'product', endedAt: 5 } }, id, { member: 'pm' } as Partial<SuperState>);
    const quiet = async () => ({ inUse: [] as string[], commands: [] as string[] });
    const { guards } = await guardsFrom()();
    const plan = await planSweep({ root: join(home, '.claude-worktrees'), guards, now: Date.now() + 30 * 86_400_000 });
    const paths = plan.items.map((i) => i.path).sort();
    expect(paths).toEqual([m.path, r.path].sort());
    expect(plan.items.find((i) => i.path === m.path)).toMatchObject({ child: 'mk', superId: id });
    // res is resumed after the plan (its record no longer ended): the apply re-reads and keeps it.
    writeRecord({ res: { worktree: r.path, branch: r.branch, repo: 'product' } });
    const out = await applySweep(plan, guards, { contextRoot: ctx, home, uses: quiet, now: Date.now() + 30 * 86_400_000 });
    expect(out.removed).toEqual([m.path]);
    expect(out.failed.find((f) => f.path === r.path)?.message).toMatch(/resumed/);
    expect(existsSync(r.path)).toBe(true);
    const mem = await readSuperState(ctx, id, { home });
    expect(mem.children.mk.worktree).toBeUndefined();
    expect(mem.children.mk).toMatchObject({ branch: 'super/mem', movedTo: 'fix/m' });
  });

  it('C8(iii) a member Super\'s ended child is cleaned and its own record updated', { timeout: 60_000 }, async () => {
    const m = await mk('mem'); commitIn(m.path, 'm.txt');
    writeRecord({});
    const id = superIdOfMember('pm');
    writeRecord({ mk: { worktree: m.path, branch: m.branch, repo: 'product', endedAt: 5 } }, id, { member: 'pm' } as Partial<SuperState>);
    const r = await sweep();
    expect(r?.removed).toEqual([m.path]);
    const s = await readSuperState(ctx, id, { home });
    expect(s.children.mk).toMatchObject({ branch: 'super/mem' });
    expect(s.children.mk.worktree).toBeUndefined();
  });

  it('C19 the release pass: a branch home or gone releases the child; an unreadable repo or a re-attached worktree drops nothing', { timeout: 60_000 }, async () => {
    const remoteDir = join(home, 'remote.git');
    g(home, 'init', '-q', '--bare', remoteDir);
    g(repo, 'remote', 'add', 'origin', remoteDir);
    g(repo, 'branch', 'super/home');
    g(repo, 'checkout', '-q', '-b', 'dev');
    g(repo, 'push', '-q', 'origin', 'dev');
    g(repo, 'checkout', '-q', 'main');
    g(repo, 'checkout', '-q', '-b', 'super/away');
    commitIn(repo, 'away.txt');
    g(repo, 'checkout', '-q', 'main');
    const stale = join(home, '.claude-worktrees', 'product-super-stale');
    writeRecord({
      home: { branch: 'super/home', repo: 'product', endedAt: 5 },
      away: { branch: 'super/away', repo: 'product', endedAt: 5 },
      gone: { branch: 'super/gone', repo: 'product', endedAt: 5 },
      hint: { branch: 'super/away', worktree: stale, repo: 'product', endedAt: 5 },
      elsewhere: { branch: 'super/home', repo: 'nolinked', endedAt: 5 },
    });
    const r = await sweep();
    expect(r?.released.sort()).toEqual(['gone', 'home']);
    const s = await readSuperState(ctx, { home });
    expect(s.children.home.branch).toBeUndefined();
    expect(s.children.gone.branch).toBeUndefined();
    expect(s.children.away.branch).toBe('super/away');
    // A worktree hint git does not list is dropped; the branch, not home, stays.
    expect(s.children.hint.worktree).toBeUndefined();
    expect(s.children.hint.branch).toBe('super/away');
    // A repo that is not on this machine: unknown, nothing dropped.
    expect(s.children.elsewhere.branch).toBe('super/home');
  });
});
