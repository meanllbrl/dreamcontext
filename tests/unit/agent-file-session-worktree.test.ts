/**
 * `/agent/file` for a session that works in its OWN git worktree.
 *
 * The 2026-10-25 report: a child session whose cwd is `~/.claude-worktrees/<name>` writes
 * `![shot](out/a.png)`; the route resolved that against the PROJECT root and counted an
 * absolute path into the worktree as "outside", so the picture became a chip. The fix widens
 * ONE session's reach to its own registered worktree — these tests pin both the widening and
 * every edge of it that must stay shut. Real git repos and a real `git worktree add`, a fake HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAgentFile } from '../../src/server/routes/agent-chat.js';
import { sessionWorktreeRoot } from '../../src/server/session-worktree.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'ignore' });
}

function makeRes() {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; return res; },
    setHeader() {},
    end(data?: string) { if (data) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } } },
    on() { return res; },
    once() { return res; },
    emit() { return false; },
    write() { return true; },
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

function req(path: string, session?: string): IncomingMessage {
  const q = `path=${encodeURIComponent(path)}${session ? `&session=${session}` : ''}`;
  return { url: `/api/agent/file?${q}`, headers: { host: 'localhost' } } as unknown as IncomingMessage;
}

let scratch: string;
let home: string;
let projectRoot: string;
let contextRoot: string;
let worktree: string;
let realHome: string | undefined;
let realDesktop: string | undefined;

function registerChild(sessionId: string, wt: string): void {
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(join(contextRoot, 'state', '.super-agent.json'), JSON.stringify({
    v: 1, session: null, enabled: true,
    children: { [sessionId]: { sessionId, brief: 'b', adopted: false, startedAt: 1, worktree: wt, branch: 'super/x' } },
  }), 'utf-8');
}

beforeEach(() => {
  realHome = process.env.HOME;
  realDesktop = process.env.DREAMCONTEXT_DESKTOP;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wtfile-')));
  home = join(scratch, 'home');
  process.env.HOME = home;
  projectRoot = join(scratch, 'project');
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'README.md'), 'hi\n', 'utf-8');
  execFileSync('git', ['init', '-q', projectRoot]);
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-qm', 'init');
  mkdirSync(join(home, '.claude-worktrees'), { recursive: true });
  worktree = join(home, '.claude-worktrees', 'child-one');
  git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/x', worktree);
  mkdirSync(join(worktree, 'out'), { recursive: true });
  writeFileSync(join(worktree, 'out', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(projectRoot, 'proj.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  registerChild(SESSION, worktree);
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
  rmSync(scratch, { recursive: true, force: true });
});

describe('sessionWorktreeRoot', () => {
  it('returns the registered worktree for its own session only', async () => {
    expect(await sessionWorktreeRoot(contextRoot, projectRoot, SESSION)).toBe(worktree);
    expect(await sessionWorktreeRoot(contextRoot, projectRoot, OTHER)).toBeNull();
    expect(await sessionWorktreeRoot(contextRoot, projectRoot, null)).toBeNull();
  });

  it('refuses a registered worktree that is not under ~/.claude-worktrees', async () => {
    const stray = join(scratch, 'stray');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/y', stray);
    registerChild(SESSION, stray);
    expect(await sessionWorktreeRoot(contextRoot, projectRoot, SESSION)).toBeNull();
  });

  it('refuses a symlink under ~/.claude-worktrees that points elsewhere', async () => {
    const elsewhere = join(scratch, 'elsewhere');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'super/z', elsewhere);
    const link = join(home, '.claude-worktrees', 'sneaky');
    symlinkSync(elsewhere, link);
    registerChild(SESSION, link);
    expect(await sessionWorktreeRoot(contextRoot, projectRoot, SESSION)).toBeNull();
  });

  it('refuses a worktree of a repository the vault does not govern', async () => {
    const foreign = join(scratch, 'foreign');
    execFileSync('git', ['init', '-q', foreign]);
    writeFileSync(join(foreign, 'f'), 'x');
    git(foreign, 'add', '.');
    git(foreign, 'commit', '-qm', 'i');
    const fwt = join(home, '.claude-worktrees', 'foreign-wt');
    git(foreign, 'worktree', 'add', '-q', '-b', 'super/f', fwt);
    registerChild(SESSION, fwt);
    expect(await sessionWorktreeRoot(contextRoot, projectRoot, SESSION)).toBeNull();
  });
});

describe('GET /api/agent/file — a session in its own worktree', () => {
  it('serves a RELATIVE path that exists only in the session worktree', async () => {
    const { res, status } = makeRes();
    await handleAgentFile(req('out/a.png', SESSION), res, {}, contextRoot);
    expect(status()).toBe(200);
  });

  it('serves an ABSOLUTE path inside the session worktree without a grant', async () => {
    const { res, status } = makeRes();
    await handleAgentFile(req(join(worktree, 'out', 'a.png'), SESSION), res, {}, contextRoot);
    expect(status()).toBe(200);
  });

  it('still serves project files for that session', async () => {
    const { res, status } = makeRes();
    await handleAgentFile(req('proj.png', SESSION), res, {}, contextRoot);
    expect(status()).toBe(200);
  });

  it('without the session the same paths keep their old answers (404 / needs_grant)', async () => {
    const a = makeRes();
    await handleAgentFile(req('out/a.png'), a.res, {}, contextRoot);
    expect(a.status()).toBe(404);
    const b = makeRes();
    await handleAgentFile(req(join(worktree, 'out', 'a.png')), b.res, {}, contextRoot);
    expect(b.status()).toBe(403);
    expect(b.body().error).toBe('needs_grant');
  });

  it("another session cannot read a session's worktree", async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(req(join(worktree, 'out', 'a.png'), OTHER), res, {}, contextRoot);
    expect(status()).toBe(403);
    expect(body().error).toBe('needs_grant');
  });

  it('does not let `..` climb out of the worktree', async () => {
    writeFileSync(join(home, '.claude-worktrees', 'secret.png'), 'x');
    const { res, status } = makeRes();
    await handleAgentFile(req('../secret.png', SESSION), res, {}, contextRoot);
    expect(status()).not.toBe(200);
  });

  it('does not serve a symlink inside the worktree that points outside both roots', async () => {
    const outside = join(scratch, 'outside.png');
    writeFileSync(outside, 'x');
    symlinkSync(outside, join(worktree, 'out', 'link.png'));
    const { res, status, body } = makeRes();
    await handleAgentFile(req('out/link.png', SESSION), res, {}, contextRoot);
    expect(status()).toBe(403);
    expect(body().error).toBe('needs_grant');
  });

  it('does not widen to arbitrary absolute paths for a worktree session', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(req(join(scratch, 'home', '.claude-worktrees', '..', 'project2.png'), SESSION), res, {}, contextRoot);
    expect(status()).not.toBe(200);
    expect(['needs_grant', 'not_found', undefined]).toContain(body()?.error as string | undefined);
  });
});
