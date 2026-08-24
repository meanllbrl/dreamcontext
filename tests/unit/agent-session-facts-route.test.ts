/**
 * `GET /api/agent/session-facts` (src/server/routes/agent-shelf.ts) — the branch and worktree
 * marker on the chat shelf's resting tag line.
 *
 * The property under test is the one the route got WRONG until 2026-08-24: it answered for
 * the folder the app has open rather than for the checkout the SESSION is working in. So every
 * case here drives the real handler against real git repositories and real `git worktree add`,
 * with the session registry in the state a live `EnterWorktree` frame would have left it in.
 *
 * The compatibility arms matter as much as the new behaviour. A caller that sends no session
 * id — a fresh pane, a resumed conversation the server has seen no frame from, the terminal
 * view — must still get the project root's branch rather than nothing.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAgentSessionFacts } from '../../src/server/routes/agent-shelf.js';
import type { SessionFacts } from '../../src/lib/session-facts.js';
import { resetSessionFactsCaches } from '../../src/lib/session-facts.js';
import { enterSessionCheckout, resetSessionCheckouts } from '../../src/lib/session-cwd.js';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_GIT = gitAvailable();

const SCRATCH = mkdtempSync(join(tmpdir(), 'dc-facts-route-'));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_DESKTOP;
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A real repo with a `_dream_context/` beside the code, i.e. the default vault layout the
 *  route's `projectRootOf` is written for. */
function makeProject(name: string, branch: string): { root: string; contextRoot: string } {
  const root = join(SCRATCH, name);
  mkdirSync(join(root, '_dream_context'), { recursive: true });
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.email', 'verify@example.com');
  git(root, 'config', 'user.name', 'Verify');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf-8');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'initial');
  return { root, contextRoot: join(root, '_dream_context') };
}

function addWorktree(root: string, name: string, branch: string): string {
  const path = join(SCRATCH, name);
  git(root, 'worktree', 'add', '-q', '-b', branch, path);
  return path;
}

function fakeRes(): { res: ServerResponse; captured: { status: number; body: unknown } } {
  const captured = { status: 0, body: null as unknown };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function get(contextRoot: string | null, session?: string): Promise<SessionFacts> {
  const qs = session === undefined ? '' : `?session=${encodeURIComponent(session)}`;
  const req = {
    url: `/api/agent/session-facts${qs}`,
    headers: { host: '127.0.0.1:1234' },
  } as unknown as IncomingMessage;
  const { res, captured } = fakeRes();
  await handleAgentSessionFacts(req, res, {}, contextRoot);
  expect(captured.status).toBe(200);
  return captured.body as SessionFacts;
}

const SESSION_A = '11111111-2222-3333-4444-555555555555';
const SESSION_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe.skipIf(!HAS_GIT)('GET /api/agent/session-facts', () => {
  beforeEach(() => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    resetSessionCheckouts();
    resetSessionFactsCaches();
  });

  it('with NO session id, answers for the project root — the pre-existing behaviour', async () => {
    const { root, contextRoot } = makeProject('no-id', 'main');
    addWorktree(root, 'no-id-wt', 'feat/elsewhere');

    const facts = await get(contextRoot);
    expect(facts.isRepo).toBe(true);
    expect(facts.branch).toBe('main');
    expect(facts.worktree).toBe(false);
    expect(facts.worktreeName).toBeNull();
  });

  it('with an id the server has seen no move from, also answers for the project root', async () => {
    const { contextRoot } = makeProject('unmoved', 'main');
    expect((await get(contextRoot, SESSION_A)).branch).toBe('main');
  });

  it('after the session enters a worktree, it answers for the WORKTREE', async () => {
    const { root, contextRoot } = makeProject('moved', 'main');
    const wt = addWorktree(root, 'moved-wt', 'fix/pushme-streak-paused-contradiction');
    expect(enterSessionCheckout(SESSION_A, wt, root)).toBe(true);

    const facts = await get(contextRoot, SESSION_A);
    expect(facts.branch).toBe('fix/pushme-streak-paused-contradiction');
    expect(facts.worktree).toBe(true);
    expect(facts.worktreeName).toBe('moved-wt');
    expect(facts.mainRoot).not.toBeNull();
  });

  it('two sessions in two worktrees get two different branches from the same project', async () => {
    const { root, contextRoot } = makeProject('two', 'main');
    const one = addWorktree(root, 'two-wt-a', 'feat/a');
    const two = addWorktree(root, 'two-wt-b', 'feat/b');
    enterSessionCheckout(SESSION_A, one, root);
    enterSessionCheckout(SESSION_B, two, root);

    expect((await get(contextRoot, SESSION_A)).branch).toBe('feat/a');
    expect((await get(contextRoot, SESSION_B)).branch).toBe('feat/b');
    // …and a third pane that never moved still reads the root.
    expect((await get(contextRoot)).branch).toBe('main');
  });

  it('a session param that is not a UUID is ignored, not used as a key', async () => {
    const { root, contextRoot } = makeProject('hostile', 'main');
    const wt = addWorktree(root, 'hostile-wt', 'feat/hostile');
    // Register the move under the hostile string itself: if the route used the raw param, this
    // is the entry it would find.
    const raw = '../../etc';
    enterSessionCheckout(raw, wt, root);

    for (const bad of [raw, '', 'not-a-uuid', 'a'.repeat(200)]) {
      expect((await get(contextRoot, bad)).branch, bad).toBe('main');
    }
  });

  it('off-desktop and no-project both answer the unknown shape, never a 500', async () => {
    const { contextRoot } = makeProject('gated', 'main');

    expect(await get(null, SESSION_A)).toMatchObject({ isRepo: false, branch: null });

    delete process.env.DREAMCONTEXT_DESKTOP;
    expect(await get(contextRoot, SESSION_A)).toMatchObject({ isRepo: false, branch: null });
  });

  it('a contextRoot that is already the project root is handled too (full-repo layout)', async () => {
    const { root } = makeProject('full-repo', 'main');
    expect((await get(root)).branch).toBe('main');
  });
});
