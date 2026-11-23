/**
 * kesim-geri-donus K2, K5 server, K7, K8 (C7, C8, C10, C15) through the real verbs on scratch
 * repos and a scratch vault: `super merge` of an ended child whose worktree is gone merges from
 * its branch and carries `returns`; `super worktree remove` keeps the branch in the record;
 * `super returns ask` opens ONE card with the report page, never asks the same answered list
 * again, and `super queue done` on it counts as answered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { linkedReposFilePath } from '../../src/lib/linked-repos.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';
import { createChildWorktree } from '../../src/lib/super/worktrees.js';
import { emptySuperState, type SuperChild, type SuperState } from '../../src/lib/super/types.js';

const URL_ = 'https://github.com/acme/product.git';
let home: string;
let repo: string;
let remote: string;
let project: string;
let root: string;
const savedEnv = { ...process.env };
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitIn = (dir: string, file: string) => { writeFileSync(join(dir, file), `${file}\n`); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', `edit ${file}`); };

beforeEach(() => {
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'super-merge-ret-')));
  process.env.HOME = home;
  repo = join(home, 'code', 'product');
  mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'one\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
  g(repo, 'branch', 'dev');
  // A local bare remote holding dev: no GitHub slug, so no PR listing is ever asked.
  remote = join(home, 'remote.git');
  g(home, 'init', '-q', '--bare', remote);
  g(repo, 'remote', 'add', 'origin', remote);
  g(repo, 'push', '-q', 'origin', 'dev');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(linkedReposFilePath(home), JSON.stringify({ repos: { [canonicalRemote(URL_) ?? URL_]: repo } }));
  project = join(home, 'vault');
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', linkedRepos: [{ name: 'product', gitRemoteUrl: URL_ }] }));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(home, { recursive: true, force: true });
});

async function harness(children: Record<string, Partial<SuperChild>>, extra: Partial<SuperState> = {}) {
  const store = await import('../../src/lib/super/store.js');
  const wc = await import('../../src/lib/window-control.js');
  const { handleSuperVerb } = await import('../../src/server/routes/super.js');
  wc.resetWindowControl(); store.resetSuperIndex();
  const full: Record<string, SuperChild> = {};
  for (const [k, c] of Object.entries(children)) full[k] = { sessionId: k, brief: k, adopted: false, startedAt: 1, ...c } as SuperChild;
  writeFileSync(join(root, store.SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true, children: full, ...extra }));
  const token = wc.mintWindowToken({ send: () => true, vault: 'vault', contextRoot: root, sessionId: 'sup-1', mode: 'super' }).token;
  const call = async (verb: string, body: unknown) => {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => (r as unknown as PassThrough).end(JSON.stringify(body)));
    const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s) => { out.status = s; };
    (out as unknown as { end: (b?: string) => void }).end = (b) => { out.json = b ? JSON.parse(b) : {}; };
    await handleSuperVerb(r, out, { verb });
    return out;
  };
  const state = () => store.readSuperState(root);
  return { call, state };
}

describe('super merge (K2, D15)', () => {
  it('an ended child whose worktree is gone merges from its branch; the reply carries returns; --base opens a new topic', { timeout: 60_000 }, async () => {
    const a = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'a', home });
    commitIn(a.path, 'a.txt');
    const b = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'b', home });
    commitIn(b.path, 'b.txt');
    // a's worktree is gone (the janitor), its branch and repo stay in the record.
    g(repo, 'worktree', 'remove', a.path);
    const { call } = await harness({
      a: { branch: a.branch, repo: 'product', endedAt: 2 },
      b: { worktree: b.path, branch: b.branch, repo: 'product' },
    });
    const r = await call('merge', { children: ['a', 'b'], into: 'cut', base: 'origin/dev' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const res = r.json.result as { results: Array<{ sessionId: string; merged: boolean }>; baseNote?: string; returns: { awaiting: Array<{ name: string }>; dev: { ref: string } | null } };
    expect(res.results.map((x) => [x.sessionId, x.merged])).toEqual([['a', true], ['b', true]]);
    expect(res.baseNote).toMatch(/opened at origin\/dev/);
    expect(res.returns.dev?.ref).toBe('origin/dev');
    expect(res.returns.awaiting.map((x) => x.name).sort()).toEqual([a.branch, b.branch].sort());
    // Two merges: the first merge commit's first parent is the base.
    expect(g(repo, 'rev-parse', 'super/cut^1^1')).toBe(g(repo, 'rev-parse', 'origin/dev'));
  });

  it('a child with neither a live worktree nor a branch git has is refused by name', { timeout: 30_000 }, async () => {
    const { call } = await harness({ a: { branch: 'super/gone', repo: 'product', endedAt: 2 } });
    const r = await call('merge', { children: ['a'], into: 'cut' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('missing_branch');
  });
});

describe('super worktree remove / list (K5, K7)', () => {
  it('removes the clean worktree, keeps the branch in git and in the record; list shows the branch-only child', { timeout: 60_000 }, async () => {
    const a = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'a', home });
    commitIn(a.path, 'a.txt');
    const { call, state } = await harness({ a: { worktree: a.path, branch: a.branch, repo: 'product', endedAt: 2 } });
    const r = await call('worktree-remove', { child: 'a' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(existsSync(a.path)).toBe(false);
    expect(g(repo, 'log', '-1', '--format=%s', a.branch)).toBe('edit a.txt');
    const s = await state();
    expect(s.children.a.worktree).toBeUndefined();
    expect(s.children.a.branch).toBe(a.branch);
    const l = await call('worktree-list', {});
    expect((l.json.result as { worktrees: Array<{ child: string; worktree: string | null; branch: string }> }).worktrees).toEqual([
      expect.objectContaining({ child: 'a', worktree: null, branch: a.branch, repo: 'product' }),
    ]);
  });

  it('review r2: a worktree moved to fix/x removed by the verb records movedTo; the next merge refuses naming fix/x instead of merging super/<slug> alone', { timeout: 60_000 }, async () => {
    const a = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'a', home });
    commitIn(a.path, 'a.txt');
    g(a.path, 'checkout', '-q', '-b', 'fix/x');
    commitIn(a.path, 'x.txt');
    const { call, state } = await harness({ a: { worktree: a.path, branch: a.branch, repo: 'product', endedAt: 2 } });
    const r = await call('worktree-remove', { child: 'a' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await state()).children.a).toMatchObject({ branch: a.branch, movedTo: 'fix/x' });
    const m = await call('merge', { children: ['a'], into: 'cut' });
    expect(m.status).toBe(409);
    expect(m.json.error).toBe('work_elsewhere');
    expect(JSON.stringify(m.json)).toContain('fix/x');
  });
});

describe('super returns ask (K8, D16)', () => {
  it('nothing awaiting: no card', { timeout: 30_000 }, async () => {
    g(repo, 'branch', 'super/cut', 'dev');
    const { call, state } = await harness({});
    const r = await call('returns-ask', { topic: 'cut' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json.result as { nothing: boolean }).nothing).toBe(true);
    expect((await state()).queue).toHaveLength(0);
  });

  it('ONE card with the report page; the same open list is refused while open; queue done counts as answered and the same list is never asked again; a changed list is', { timeout: 60_000 }, async () => {
    const a = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'a', home });
    commitIn(a.path, 'a.txt');
    g(repo, 'checkout', '-q', '-b', 'super/cut', 'dev');
    g(repo, 'merge', '-q', '--no-ff', '-m', `Merge branch '${a.branch}'`, a.branch);
    g(repo, 'checkout', '-q', 'main');
    const { call, state } = await harness({});
    const r = await call('returns-ask', { topic: 'cut' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const res = r.json.result as { askId: string; item: string; card: string; key: string; branches: string[] };
    expect(res.askId).toBe(res.item);
    expect(res.branches).toEqual([`1. ${a.branch}`]);
    const page = readFileSync(join(root, 'tmp', 'super', 'returns-cut.html'), 'utf-8');
    expect(page).toContain('Kesim cut → dev\'e dönüş');
    expect(page).toContain(a.branch);
    expect(page).toContain('edit a.txt');
    let s = await state();
    const ask = s.queue.find((q) => q.id === res.askId);
    expect(ask?.ask?.title).toBe('Kesim cut → dev\'e dönüş');
    expect(ask?.ask?.source).toBe('returns');
    expect(ask?.ask?.questions[0].question).toBe('1 dal dev\'e dönmedi, hepsine taslak PR açayım mı?');
    expect(ask?.ask?.questions[0].options.map((o) => o.label)).toEqual(['Hepsine aç', 'Seçeyim', 'Şimdi değil']);
    expect(s.containers.some((k) => k.id === res.card && k.kind === 'web')).toBe(true);
    expect(s.returnsAsked?.cut).toMatchObject({ key: res.key, askId: res.askId });
    expect(s.returnsAsked?.cut.answer).toBeUndefined();

    // Still open: the one-open-ask rule refuses, and the record is unchanged.
    const again = await call('returns-ask', { topic: 'cut' });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('ask_open');

    // The Super closes it: answered as "done", the same list is never asked again.
    expect((await call('queue-done', { item: res.askId })).status).toBe(200);
    s = await state();
    expect(s.returnsAsked?.cut.answer).toBe('done');
    const third = await call('returns-ask', { topic: 'cut' });
    expect(third.status).toBe(409);
    expect(third.json.error).toBe('returns_asked');
    expect(third.json.answer).toBe('done');

    // A new branch in the cut: a new list, a new card.
    const b = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'b', home });
    commitIn(b.path, 'b.txt');
    g(repo, 'checkout', '-q', 'super/cut');
    g(repo, 'merge', '-q', '--no-ff', '-m', `Merge branch '${b.branch}'`, b.branch);
    g(repo, 'checkout', '-q', 'main');
    const fourth = await call('returns-ask', { topic: 'cut' });
    expect(fourth.status, JSON.stringify(fourth.json)).toBe(200);
    expect((fourth.json.result as { branches: string[] }).branches).toHaveLength(2);
    expect((await state()).returnsAsked?.cut.answer).toBeUndefined();
  });

  it('a bad topic and an unknown topic are refused', { timeout: 30_000 }, async () => {
    const { call } = await harness({});
    expect((await call('returns-ask', { topic: '../x' })).status).toBe(400);
    expect((await call('returns-ask', { topic: 'nope' })).json.error).toBe('unknown_topic');
  });
});
