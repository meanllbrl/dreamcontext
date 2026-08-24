/**
 * `session-cwd.ts` — WHICH checkout a chat session is working in.
 *
 * Driven against REAL git repositories and REAL `git worktree add`, for the same reason
 * `session-facts.test.ts` is: the entire gate is what `git rev-parse --git-common-dir` prints
 * from a main checkout versus a linked worktree versus a second repository, and a mock would
 * pin my assumption about that instead of git's behaviour.
 *
 * The property that earns the most attention here is the REFUSAL. Accepting a directory that
 * is not a sibling checkout would let a frame point the shelf — and the `git` invocations
 * behind it — anywhere on disk. Every rejection below is asserted to leave the session on the
 * checkout it already had, not merely to return false.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TRACKED_SESSIONS, clearSessionCheckout, enterSessionCheckout, exitSessionCheckout,
  isSameRepository, resetSessionCheckouts, sessionCheckout,
} from '../../src/lib/session-cwd.js';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_GIT = gitAvailable();

const SCRATCH = mkdtempSync(join(tmpdir(), 'dc-session-cwd-'));
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(name: string, branch: string): string {
  const root = join(SCRATCH, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.email', 'verify@example.com');
  git(root, 'config', 'user.name', 'Verify');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf-8');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  return root;
}

function addWorktree(root: string, name: string, branch: string): string {
  const path = join(SCRATCH, name);
  git(root, 'worktree', 'add', '-q', '-b', branch, path);
  return path;
}

const SESSION = '11111111-2222-3333-4444-555555555555';

describe.skipIf(!HAS_GIT)('session-cwd', () => {
  beforeEach(() => { resetSessionCheckouts(); });

  describe('isSameRepository', () => {
    it('a linked worktree IS the same repository as its main checkout', () => {
      const root = makeRepo('same-main', 'main');
      const wt = addWorktree(root, 'same-wt', 'feat/x');
      expect(isSameRepository(wt, root)).toBe(true);
      // …and symmetrically, so the gate does not depend on which side you ask from.
      expect(isSameRepository(root, wt)).toBe(true);
    });

    it('a DIFFERENT repository is not', () => {
      const a = makeRepo('other-a', 'main');
      const b = makeRepo('other-b', 'main');
      expect(isSameRepository(b, a)).toBe(false);
    });

    it('a plain directory and a missing path are not', () => {
      const root = makeRepo('plain-main', 'main');
      const plain = join(SCRATCH, 'not-a-repo');
      mkdirSync(plain, { recursive: true });
      expect(isSameRepository(plain, root)).toBe(false);
      expect(isSameRepository(join(SCRATCH, 'does-not-exist'), root)).toBe(false);
    });
  });

  describe('enterSessionCheckout', () => {
    it('accepts a sibling worktree, and the session then reads as being in it', () => {
      const root = makeRepo('accept-main', 'main');
      const wt = addWorktree(root, 'accept-wt', 'feat/accept');
      expect(enterSessionCheckout(SESSION, wt, root)).toBe(true);
      expect(sessionCheckout(SESSION, root)).toBe(wt);
    });

    it('REFUSES a foreign repo, and the session keeps the checkout it had', () => {
      const root = makeRepo('refuse-main', 'main');
      const wt = addWorktree(root, 'refuse-wt', 'feat/keep');
      const foreign = makeRepo('refuse-foreign', 'main');
      enterSessionCheckout(SESSION, wt, root);

      expect(enterSessionCheckout(SESSION, foreign, root)).toBe(false);
      expect(sessionCheckout(SESSION, root)).toBe(wt);
    });

    it('REFUSES a non-repo directory, a missing path, and a file', () => {
      const root = makeRepo('refuse2-main', 'main');
      const plain = join(SCRATCH, 'refuse2-plain');
      mkdirSync(plain, { recursive: true });
      const file = join(root, 'README.md');

      for (const bad of [plain, join(SCRATCH, 'nope'), file]) {
        expect(enterSessionCheckout(SESSION, bad, root), bad).toBe(false);
      }
      expect(sessionCheckout(SESSION, root)).toBe(root);
    });

    it('REFUSES a relative path — it would resolve against the SERVER’s cwd, not the session’s', () => {
      const root = makeRepo('rel-main', 'main');
      addWorktree(root, 'rel-wt', 'feat/rel');
      expect(enterSessionCheckout(SESSION, 'rel-wt', root)).toBe(false);
      expect(enterSessionCheckout(SESSION, '../rel-wt', root)).toBe(false);
      expect(sessionCheckout(SESSION, root)).toBe(root);
    });

    it('REFUSES an empty session key or an empty path', () => {
      const root = makeRepo('empty-main', 'main');
      const wt = addWorktree(root, 'empty-wt', 'feat/empty');
      expect(enterSessionCheckout('', wt, root)).toBe(false);
      expect(enterSessionCheckout(SESSION, '', root)).toBe(false);
    });

    it('the MAIN checkout is an acceptable target too (a session can enter the root worktree)', () => {
      const root = makeRepo('root-main', 'main');
      const wt = addWorktree(root, 'root-wt', 'feat/root');
      enterSessionCheckout(SESSION, wt, root);
      expect(enterSessionCheckout(SESSION, root, root)).toBe(true);
      expect(sessionCheckout(SESSION, root)).toBe(root);
    });
  });

  describe('sessionCheckout', () => {
    it('an unknown session, and a null id, answer the project root — the pre-existing behaviour', () => {
      const root = makeRepo('unknown-main', 'main');
      expect(sessionCheckout('never-seen', root)).toBe(root);
      expect(sessionCheckout(null, root)).toBe(root);
      expect(sessionCheckout('', root)).toBe(root);
    });

    it('a REMOVED worktree falls back instead of freezing the tag on a dead branch', () => {
      const root = makeRepo('gone-main', 'main');
      const wt = addWorktree(root, 'gone-wt', 'feat/gone');
      enterSessionCheckout(SESSION, wt, root);
      expect(sessionCheckout(SESSION, root)).toBe(wt);

      // Somebody removes it in another terminal while the pane is still open.
      git(root, 'worktree', 'remove', '--force', wt);
      expect(sessionCheckout(SESSION, root)).toBe(root);
      // …and the dead entry is dropped, not re-probed on every poll.
      expect(sessionCheckout(SESSION, root)).toBe(root);
    });

    it('two sessions in two worktrees do not read each other’s answer', () => {
      const root = makeRepo('two-main', 'main');
      const one = addWorktree(root, 'two-wt-a', 'feat/a');
      const two = addWorktree(root, 'two-wt-b', 'feat/b');
      enterSessionCheckout('sess-a', one, root);
      enterSessionCheckout('sess-b', two, root);
      expect(sessionCheckout('sess-a', root)).toBe(one);
      expect(sessionCheckout('sess-b', root)).toBe(two);
    });
  });

  describe('exit and clear', () => {
    it('exit puts the session back in the project root', () => {
      const root = makeRepo('exit-main', 'main');
      const wt = addWorktree(root, 'exit-wt', 'feat/exit');
      enterSessionCheckout(SESSION, wt, root);
      exitSessionCheckout(SESSION);
      expect(sessionCheckout(SESSION, root)).toBe(root);
    });

    it('clear drops the entry, so a RESUMED conversation of the same id starts at the root', () => {
      const root = makeRepo('clear-main', 'main');
      const wt = addWorktree(root, 'clear-wt', 'feat/clear');
      enterSessionCheckout(SESSION, wt, root);
      clearSessionCheckout(SESSION);
      expect(sessionCheckout(SESSION, root)).toBe(root);
    });
  });

  describe('the registry is bounded', () => {
    it(`evicts oldest-first past ${MAX_TRACKED_SESSIONS}, and an evicted session falls back`, () => {
      const root = makeRepo('cap-main', 'main');
      const wt = addWorktree(root, 'cap-wt', 'feat/cap');

      for (let i = 0; i < MAX_TRACKED_SESSIONS; i += 1) {
        expect(enterSessionCheckout(`sess-${i}`, wt, root)).toBe(true);
      }
      expect(sessionCheckout('sess-0', root)).toBe(wt);

      // One past the cap: the oldest goes.
      enterSessionCheckout('sess-overflow', wt, root);
      expect(sessionCheckout('sess-0', root)).toBe(root);
      expect(sessionCheckout('sess-1', root)).toBe(wt);
      expect(sessionCheckout('sess-overflow', root)).toBe(wt);
    });

    it('re-entering refreshes a session’s place in the queue, so a live session is not evicted', () => {
      const root = makeRepo('refresh-main', 'main');
      const wt = addWorktree(root, 'refresh-wt', 'feat/refresh');

      enterSessionCheckout('oldest', wt, root);
      for (let i = 0; i < MAX_TRACKED_SESSIONS - 1; i += 1) {
        enterSessionCheckout(`filler-${i}`, wt, root);
      }
      // `oldest` moves again — it is now the newest, so the next overflow must not drop it.
      enterSessionCheckout('oldest', wt, root);
      enterSessionCheckout('one-more', wt, root);

      expect(sessionCheckout('oldest', root)).toBe(wt);
      expect(sessionCheckout('filler-0', root)).toBe(root);
    });
  });
});
