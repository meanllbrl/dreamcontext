/**
 * `readSessionFactsAsync` (src/lib/session-facts.ts) — the shelf's polled branch/worktree read
 * (task: the desktop app stays light on an 8GB MacBook Air, plan S5, AC3).
 *
 * The sync reader's 12 s memo missed every 15 s shelf poll, so each poll of each pane forked
 * git five or six times on the event loop. The async reader keeps a reading while the
 * checkout's HEAD and the repository's `worktrees/` are unchanged (≤ 60 s), so 20 polls at
 * 15 s read git at most 5 times — and a branch switch still shows on the very next poll.
 *
 * Every case runs against real git repos in a temp dir, in the three layouts the plan names:
 * a plain repo, a main checkout that has a linked worktree, and that linked worktree.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgetSessionFacts, readSessionFactsAsync, resetSessionFactsCaches, sessionFactsGitRuns,
  SESSION_FACTS_ASYNC_MAX_AGE_MS, UNKNOWN_SESSION_FACTS,
} from '../../src/lib/session-facts.js';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_GIT = gitAvailable();

const SCRATCH = mkdtempSync(join(tmpdir(), 'dc-facts-cache-'));
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(name: string, branch = 'main'): string {
  const root = join(SCRATCH, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.email', 'verify@example.com');
  git(root, 'config', 'user.name', 'Verify');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf-8');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'initial');
  return root;
}

/** 20 polls 15 s apart; returns how many times git was read (a read = one compute pass, which
 *  starts with the single rev-parse). */
async function poll20(dir: string): Promise<number> {
  const t0 = Date.now();
  let reads = 0;
  for (let i = 0; i < 20; i++) {
    const before = sessionFactsGitRuns();
    await readSessionFactsAsync(dir, t0 + i * 15_000);
    if (sessionFactsGitRuns() > before) reads += 1;
  }
  return reads;
}

beforeEach(() => { resetSessionFactsCaches(); });

describe.skipIf(!HAS_GIT)('readSessionFactsAsync', () => {
  const plain = HAS_GIT ? makeRepo('plain') : '';
  const main = HAS_GIT ? makeRepo('main-with-wt') : '';
  const linked = join(SCRATCH, 'linked-wt');
  if (HAS_GIT) git(main, 'worktree', 'add', '-q', '-b', 'feat/linked', linked);

  const layouts: Array<[string, () => string, string]> = [
    ['a plain repo', () => plain, 'main'],
    ['a main checkout with a linked worktree', () => main, 'main'],
    ['the linked worktree', () => linked, 'feat/linked'],
  ];

  for (const [label, dirOf, branch] of layouts) {
    it(`${label}: 20 polls at 15 s read git at most 5 times`, async () => {
      const dir = dirOf();
      expect((await readSessionFactsAsync(dir)).branch).toBe(branch);
      resetSessionFactsCaches();
      expect(await poll20(dir)).toBeLessThanOrEqual(5);
    });

    it(`${label}: a branch switch shows on the next poll`, async () => {
      const dir = dirOf();
      const t0 = Date.now();
      expect((await readSessionFactsAsync(dir, t0)).branch).toBe(branch);
      git(dir, 'checkout', '-q', '-b', `switch-${label.length}-${Date.now()}`);
      const next = await readSessionFactsAsync(dir, t0 + 15_000);
      expect(next.branch).toMatch(/^switch-/);
      git(dir, 'checkout', '-q', branch);
      expect((await readSessionFactsAsync(dir, t0 + 30_000)).branch).toBe(branch);
    });
  }

  it('the linked worktree reports itself as one, the main checkout does not', async () => {
    const wt = await readSessionFactsAsync(linked);
    expect(wt.worktree).toBe(true);
    expect(wt.worktreeName).toBe('linked-wt');
    expect((await readSessionFactsAsync(main)).worktree).toBe(false);
  });

  it('matches the shape of the sync reader key for key', async () => {
    const facts = await readSessionFactsAsync(plain);
    expect(Object.keys(facts)).toEqual([
      'branch', 'defaultBranch', 'worktree', 'mainRoot', 'worktreeName', 'worktreeAllowed', 'isRepo', 'elsewhere',
    ]);
    expect(facts.defaultBranch).toBe('main');
  });

  it('a reading older than the max age is re-read even with HEAD unchanged', async () => {
    const t0 = Date.now();
    await readSessionFactsAsync(plain, t0);
    const before = sessionFactsGitRuns();
    await readSessionFactsAsync(plain, t0 + SESSION_FACTS_ASYNC_MAX_AGE_MS - 1);
    expect(sessionFactsGitRuns()).toBe(before);
    await readSessionFactsAsync(plain, t0 + SESSION_FACTS_ASYNC_MAX_AGE_MS + 1);
    expect(sessionFactsGitRuns()).toBeGreaterThan(before);
  });

  it('concurrent callers share one read', async () => {
    await Promise.all([readSessionFactsAsync(plain), readSessionFactsAsync(plain), readSessionFactsAsync(plain)]);
    const oneRead = sessionFactsGitRuns();
    resetSessionFactsCaches();
    await readSessionFactsAsync(plain);
    expect(sessionFactsGitRuns()).toBe(oneRead);
  });

  it('a forgetSessionFacts during an in-flight read does not store that read', async () => {
    const inflight = readSessionFactsAsync(plain);
    forgetSessionFacts(plain);
    await inflight;
    const before = sessionFactsGitRuns();
    await readSessionFactsAsync(plain);
    expect(sessionFactsGitRuns()).toBeGreaterThan(before);
  });

  it('a non-repo answers the unknown shape and is held by age alone', async () => {
    const bare = join(SCRATCH, 'not-a-repo');
    mkdirSync(bare, { recursive: true });
    const t0 = Date.now();
    expect(await readSessionFactsAsync(bare, t0)).toEqual(UNKNOWN_SESSION_FACTS);
    const before = sessionFactsGitRuns();
    expect(await readSessionFactsAsync(bare, t0 + 15_000)).toEqual(UNKNOWN_SESSION_FACTS);
    expect(sessionFactsGitRuns()).toBe(before);
  });
});
