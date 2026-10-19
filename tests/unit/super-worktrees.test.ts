/**
 * Worktrees and merge (plan-r7 D12, AC10), on a real scratch git repo linked to a scratch
 * project:
 *  - `delegate --worktree` makes the worktree under ~/.claude-worktrees on `super/<slug>`;
 *  - hostile slugs and hostile or unverifiable bases are refused;
 *  - two clean branches merge into `super/<topic>`; a conflicting one is aborted with its file
 *    list and leaves the integration branch as it was;
 *  - default-branch members, a dirty child and a missing branch are refused;
 *  - `worktree remove` refuses unmerged or dirty;
 *  - repo hooks do not run in server-run git; nothing is ever pushed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkedReposFilePath } from '../../src/lib/linked-repos.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';
import {
  GIT_SAFE_ARGS, WorktreeRefused, createChildWorktree, defaultBranchSet, discardFreshWorktree, mergeChildren, removeChildWorktree,
} from '../../src/lib/super/worktrees.js';

const URL_ = 'https://github.com/acme/product.git';
let home: string;
let repo: string;
let project: string;
const savedEnv = { ...process.env };

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  });
  home = mkdtempSync(join(tmpdir(), 'super-wt-home-'));
  repo = join(home, 'code', 'product');
  mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'line one\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(linkedReposFilePath(home), JSON.stringify({ repos: { [canonicalRemote(URL_) ?? URL_]: repo } }));
  project = mkdtempSync(join(tmpdir(), 'super-wt-proj-'));
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(project, '_dream_context', 'state', '.config.json'), JSON.stringify({
    platforms: [], packs: [], setupVersion: '1', linkedRepos: [{ name: 'product', gitRemoteUrl: URL_ }],
  }));
});
afterEach(() => {
  // Restore IN PLACE: replacing `process.env` with a plain object detaches it from the real
  // environment, and `os.homedir()` (which the routes call) would then stay pinned to whatever
  // HOME was last set while it was attached, e.g. an earlier test's deleted scratch home.
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const create = (slug: unknown, base?: unknown) => createChildWorktree({ projectRoot: project, repo: 'product', slug, base, home });

async function refusedCode(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { if (err instanceof WorktreeRefused) return err.code; throw err; }
  return 'not refused';
}

function commitIn(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text);
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', `edit ${file}`);
  return g(dir, 'rev-parse', 'HEAD');
}

describe('create', () => {
  it('makes the worktree under ~/.claude-worktrees on super/<slug>', async () => {
    const w = await create('feat-a');
    expect(w.path).toBe(join(home, '.claude-worktrees', 'product-super-feat-a'));
    expect(w.branch).toBe('super/feat-a');
    expect(existsSync(join(w.path, 'README.md'))).toBe(true);
    expect(g(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('super/feat-a');
  });

  it('refuses hostile slugs and hostile or unverifiable bases', async () => {
    for (const slug of ['../up', 'Upper', '-flag', 'a/b', 'x'.repeat(61), '', 7]) {
      expect(await refusedCode(create(slug)), String(slug)).toBe('invalid_slug');
    }
    for (const base of ['--upload-pack=touch /tmp/pwned', 'main..HEAD', 'a b', 'no-such-ref', '$(id)']) {
      expect(await refusedCode(create('ok', base)), base).toBe('invalid_base');
    }
  });

  it('refuses an unknown repo, and a project that may not make worktrees', async () => {
    expect(await refusedCode(createChildWorktree({ projectRoot: project, repo: 'nope', slug: 'x', home }))).toBe('unknown_repo');
    writeFileSync(join(project, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1' }));
    expect(await refusedCode(create('x'))).toBe('worktrees_not_allowed');
  });

  it('refuses a slug whose branch already exists', async () => {
    await create('twice');
    expect(await refusedCode(create('twice'))).toBe('branch_exists');
  });
});

describe('discard (the window refused the child)', () => {
  it('removes a fresh, untouched worktree and its branch, without force', async () => {
    const w = await create('fresh');
    await discardFreshWorktree(w);
    expect(existsSync(w.path)).toBe(false);
    expect(g(repo, 'branch', '--list', 'super/fresh')).toBe('');
  });

  it('leaves a worktree that moved past its base, or is dirty', async () => {
    const moved = await create('moved');
    commitIn(moved.path, 'a.txt', 'a\n');
    await discardFreshWorktree(moved);
    expect(existsSync(moved.path)).toBe(true);
    const dirty = await create('dirty');
    writeFileSync(join(dirty.path, 'wip.txt'), 'x');
    await discardFreshWorktree(dirty);
    expect(existsSync(join(dirty.path, 'wip.txt'))).toBe(true);
  });
});

describe('merge', () => {
  it('brings two clean branches into super/<topic>, --no-ff', async () => {
    const a = await create('a');
    const b = await create('b');
    const tipA = commitIn(a.path, 'a.txt', 'a\n');
    const tipB = commitIn(b.path, 'b.txt', 'b\n');
    const r = await mergeChildren({
      projectRoot: project, repo: 'product', topic: 'release', home,
      children: [{ sessionId: 'ca', branch: a.branch, worktree: a.path }, { sessionId: 'cb', branch: b.branch, worktree: b.path }],
    });
    expect(r.branch).toBe('super/release');
    expect(r.results.map((x) => x.merged)).toEqual([true, true]);
    for (const tip of [tipA, tipB]) execFileSync('git', ['merge-base', '--is-ancestor', tip, 'super/release'], { cwd: repo });
    expect(g(repo, 'rev-parse', 'main')).not.toBe(g(repo, 'rev-parse', 'super/release'));
  });

  it('a conflicting branch is aborted with its files; the integration branch stays as it was', async () => {
    const a = await create('a');
    const c = await create('c');
    commitIn(a.path, 'README.md', 'line from a\n');
    const tipC = commitIn(c.path, 'README.md', 'line from c\n');
    const r = await mergeChildren({
      projectRoot: project, repo: 'product', topic: 'mix', home,
      children: [{ sessionId: 'ca', branch: a.branch, worktree: a.path }, { sessionId: 'cc', branch: c.branch, worktree: c.path }],
    });
    expect(r.results[0]).toMatchObject({ merged: true });
    expect(r.results[1]).toMatchObject({ merged: false, conflict: ['README.md'] });
    // Not merged, nothing half-done in the integration worktree.
    expect(() => execFileSync('git', ['merge-base', '--is-ancestor', tipC, 'super/mix'], { cwd: repo, stdio: 'ignore' })).toThrow();
    expect(g(r.worktree, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(r.worktree, 'README.md'), 'utf-8')).toBe('line from a\n');
  });

  it('refuses a dirty child, a missing branch, and a non-super branch', async () => {
    const a = await create('a');
    writeFileSync(join(a.path, 'wip.txt'), 'not committed');
    expect(await refusedCode(mergeChildren({ projectRoot: project, repo: 'product', topic: 't', home, children: [{ sessionId: 'ca', branch: a.branch, worktree: a.path }] }))).toBe('dirty');
    expect(await refusedCode(mergeChildren({ projectRoot: project, repo: 'product', topic: 't', home, children: [{ sessionId: 'cg', branch: 'super/ghost' }] }))).toBe('missing_branch');
    expect(await refusedCode(mergeChildren({ projectRoot: project, repo: 'product', topic: 't', home, children: [{ sessionId: 'cm', branch: 'main' }] }))).toBe('no_branch');
  });

  it('every default-branch member is refused as a target', async () => {
    g(repo, 'remote', 'add', 'origin', 'https://example.invalid/product.git');
    g(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/super/hq');
    g(repo, 'checkout', '-q', '-b', 'super/live');
    const set = await defaultBranchSet(repo);
    for (const b of ['main', 'master', 'trunk', 'super/hq', 'super/live']) expect(set.has(b), b).toBe(true);
    const a = await create('a');
    commitIn(a.path, 'a.txt', 'a\n');
    for (const topic of ['hq', 'live']) {
      expect(await refusedCode(mergeChildren({ projectRoot: project, repo: 'product', topic, home, children: [{ sessionId: 'ca', branch: a.branch, worktree: a.path }] })), topic).toBe('default_branch');
    }
  });

  it('repo hooks do not run in server-run git', async () => {
    const marker = join(home, 'hook-ran');
    for (const hook of ['pre-merge-commit', 'post-merge', 'post-checkout', 'pre-commit']) {
      const p = join(repo, '.git', 'hooks', hook);
      writeFileSync(p, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(p, 0o755);
    }
    const a = await create('hooked');
    // The test's own commit runs the hook (it is not server-run): clear the marker after it.
    commitIn(a.path, 'a.txt', 'a\n');
    rmSync(marker, { force: true });
    await mergeChildren({ projectRoot: project, repo: 'product', topic: 'hooks', home, children: [{ sessionId: 'ca', branch: a.branch, worktree: a.path }] });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('remove', () => {
  it('refuses an unmerged worktree and a dirty one; a merged clean one goes, its branch kept', async () => {
    const a = await create('a');
    commitIn(a.path, 'a.txt', 'a\n');
    expect(await refusedCode(removeChildWorktree({ repoPath: repo, worktree: a.path, branch: a.branch, home }))).toBe('unmerged');
    await mergeChildren({ projectRoot: project, repo: 'product', topic: 'rel', home, children: [{ sessionId: 'ca', branch: a.branch, worktree: a.path }] });
    writeFileSync(join(a.path, 'wip.txt'), 'x');
    expect(await refusedCode(removeChildWorktree({ repoPath: repo, worktree: a.path, branch: a.branch, home }))).toBe('dirty');
    rmSync(join(a.path, 'wip.txt'));
    await removeChildWorktree({ repoPath: repo, worktree: a.path, branch: a.branch, home });
    expect(existsSync(a.path)).toBe(false);
    expect(g(repo, 'branch', '--list', 'super/a')).toContain('super/a');
  });

  it('refuses a path that is not a listed super worktree', async () => {
    expect(await refusedCode(removeChildWorktree({ repoPath: repo, worktree: repo, branch: 'super/a', home }))).toBe('worktree_not_listed');
  });
});

describe('the git invocation itself', () => {
  it('every command carries hooks, fsmonitor and signing off, through one argv-only execFile', () => {
    expect([...GIT_SAFE_ARGS]).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false']);
    const src = readFileSync(new URL('../../src/lib/super/worktrees.ts', import.meta.url), 'utf-8');
    expect(src.match(/execFile\(/g)).toHaveLength(1);
    expect(src).toContain("execFile('git', [...GIT_SAFE_ARGS, ...args]");
    expect(src).not.toMatch(/\bexec\(|execSync|shell:\s*true/);
  });

  it('nothing is ever pushed: no push verb anywhere a super verb runs git', () => {
    for (const f of ['../../src/lib/super/worktrees.ts', '../../src/server/routes/super.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf-8');
      expect(src, f).not.toMatch(/['"]push['"]/);
    }
  });
});

describe('delegate --worktree when the super process ends mid-command (M4)', () => {
  const routes = async () => {
    const { handleSuperVerb } = await import('../../src/server/routes/super.js');
    const wc = await import('../../src/lib/window-control.js');
    const store = await import('../../src/lib/super/store.js');
    const inbox = await import('../../src/lib/super/inbox.js');
    return { handleSuperVerb, wc, store, inbox };
  };
  function fakeReq(token: string, body: unknown) {
    const r = new PassThrough() as unknown as import('node:http').IncomingMessage & InstanceType<typeof PassThrough>;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => { (r as unknown as InstanceType<typeof PassThrough>).end(JSON.stringify(body)); });
    return r;
  }
  function fakeRes() {
    const out = { status: 0, json: {} as Record<string, unknown> } as import('node:http').ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    return out;
  }

  async function setup() {
    const m = await routes();
    process.env.HOME = home;
    m.wc.resetWindowControl();
    m.store.resetSuperIndex();
    m.inbox._resetSuperInbox();
    const root = join(project, '_dream_context');
    writeFileSync(join(root, m.store.SUPER_STATE_REL), JSON.stringify({
      v: 1, session: 'sup-1', enabled: true, containers: [], children: {}, queue: [], notes: {}, away: { since: null, events: 0 },
    }));
    return { ...m, root };
  }

  // Real git (worktree add, then status/remove): as slow as the merge tests under load.
  it('a SENT frame survives the super token\'s release: the window\'s late answer records the child, worktree kept', { timeout: 30_000 }, async () => {
    const { handleSuperVerb, wc, store, root } = await setup();
    const frames: Array<Record<string, unknown>> = [];
    const first = wc.mintWindowToken({ send: (f) => { frames.push(f); return true; }, vault: 'product', contextRoot: root, sessionId: 'sup-1', mode: 'super' });
    const res = fakeRes();
    const done = handleSuperVerb(fakeReq(first.token, { prompt: 'build it', worktree: 'product', slug: 'late' }), res, { verb: 'delegate' });
    await vi.waitFor(() => expect(frames.some((f) => f.subtype === 'super_command')).toBe(true), { timeout: 10_000 });
    const cmd = frames.find((f) => f.subtype === 'super_command') as { id: string };
    // The super process dies; the window answers on the respawned process's socket.
    first.release();
    const second = wc.mintWindowToken({ send: () => true, vault: 'product', contextRoot: root, sessionId: 'sup-1', mode: 'super' });
    expect(wc.deliverSuperResult(second.token, cmd.id, { ok: true, result: { sessionId: 'late-child' } })).toBe(true);
    await done;
    expect(res.status).toBe(200);
    const s = await store.readSuperState(root);
    expect(s.children['late-child']).toMatchObject({ branch: 'super/late' });
    expect(existsSync(s.children['late-child'].worktree as string)).toBe(true);
  });

  it('another chat\'s token still cannot answer it', async () => {
    const { wc, root } = await setup();
    const frames: Array<Record<string, unknown>> = [];
    const sup = wc.mintWindowToken({ send: (f) => { frames.push(f); return true; }, vault: 'product', contextRoot: root, sessionId: 'sup-1', mode: 'super' });
    const pending = wc.sendSuperCommand(sup.token, 'delegate', {}, { timeoutMs: 200 });
    const other = wc.mintWindowToken({ send: () => true, vault: 'product', contextRoot: root, sessionId: 'someone-else', mode: 'basic' });
    expect(wc.deliverSuperResult(other.token, (frames[0] as { id: string }).id, { ok: true, result: {} })).toBe(false);
    expect(await pending).toMatchObject({ ok: false, error: 'no_window', sent: true });
  });

  it('a frame that was never sent still discards the fresh worktree and its branch', { timeout: 30_000 }, async () => {
    const { handleSuperVerb, wc, root } = await setup();
    const path = join(home, '.claude-worktrees', 'product-super-never');
    // Proof the worktree and its branch were really made before the send failed: seen at send time.
    let atSend: { worktree: boolean; branch: string } | null = null;
    const dead = wc.mintWindowToken({
      send: (f) => {
        if (f.subtype === 'super_command') atSend = { worktree: existsSync(path), branch: g(repo, 'branch', '--list', 'super/never') };
        return false;
      },
      vault: 'product', contextRoot: root, sessionId: 'sup-1', mode: 'super',
    });
    const res = fakeRes();
    await handleSuperVerb(fakeReq(dead.token, { prompt: 'build it', worktree: 'product', slug: 'never' }), res, { verb: 'delegate' });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('no_window');
    expect(atSend).toEqual({ worktree: true, branch: expect.stringContaining('super/never') });
    expect(existsSync(path)).toBe(false);
    expect(g(repo, 'branch', '--list', 'super/never')).toBe('');
  });
});
