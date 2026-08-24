/**
 * `readSessionFacts` (src/lib/session-facts.ts) — the branch/worktree facts behind the chat
 * shelf's resting tag line.
 *
 * Driven against REAL git repositories under a temp dir, not a mocked `execFileSync`: the
 * whole subtlety here is what `git rev-parse --git-common-dir` actually prints from a main
 * checkout (relative) versus a linked worktree (absolute), and a mock would encode my
 * assumption about that rather than test it.
 *
 * These tests are skipped when git is unavailable, since a machine without git is exactly
 * the case the module already answers with `isRepo:false` — asserting against a missing
 * binary would be testing the harness.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSessionFacts, SESSION_FACTS_TTL_MS, UNKNOWN_SESSION_FACTS,
} from '../../src/lib/session-facts.js';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_GIT = gitAvailable();

const SCRATCH = mkdtempSync(join(tmpdir(), 'dc-session-facts-'));
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A real repo with one commit, on a named branch. Returns its path. */
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

describe.skipIf(!HAS_GIT)('readSessionFacts', () => {
  it('reports the branch of a plain checkout, and does not call it a worktree', () => {
    // REGRESSION: the scratch dir is under `/var/folders/…`, which on macOS is a symlink to
    // `/private/var/…`. git's `--absolute-git-dir` realpaths its answer and
    // `--git-common-dir` does not, so an uncanonicalised comparison reported this plain
    // checkout as a worktree — and would have done so for every project under /tmp, a
    // symlinked home, or an APFS firmlink.
    const root = makeRepo('main-checkout', 'feat/pin-surface');
    const facts = readSessionFacts(root);
    expect(facts.isRepo).toBe(true);
    expect(facts.branch).toBe('feat/pin-surface');
    expect(facts.worktree).toBe(false);
    expect(facts.mainRoot).toBeNull();
  });

  it('detects a LINKED worktree and names the main checkout it belongs to', () => {
    const root = makeRepo('with-worktree', 'main');
    const wt = join(SCRATCH, 'linked-wt');
    git(root, 'worktree', 'add', '-q', '-b', 'feat/side', wt);

    const facts = readSessionFacts(wt);
    expect(facts.isRepo).toBe(true);
    expect(facts.branch).toBe('feat/side');
    expect(facts.worktree).toBe(true);
    // dirname of the SHARED git dir — i.e. the checkout the worktree was created from,
    // as a REALPATH (documented on SessionFacts.mainRoot).
    expect(facts.mainRoot).toBe(realpathSync(root));

    // …and the main checkout of that same repo still reports false, so the comparison is
    // really about THIS tree and not about "the repo has worktrees somewhere".
    expect(readSessionFacts(root).worktree).toBe(false);
  });

  it('an unborn branch still reports its name — symbolic-ref, not rev-parse', () => {
    // `git rev-parse --abbrev-ref HEAD` degrades to the literal "HEAD" on a repo with zero
    // commits; `currentBranch` uses symbolic-ref precisely so this case is not a null.
    const root = join(SCRATCH, 'unborn');
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'trunk');
    expect(readSessionFacts(root).branch).toBe('trunk');
  });

  it('a detached HEAD has no branch, but is still a repo', () => {
    const root = makeRepo('detached', 'main');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
    git(root, 'checkout', '-q', '--detach', sha);
    const facts = readSessionFacts(root);
    expect(facts.isRepo).toBe(true);
    expect(facts.branch).toBeNull();
  });

  it('a non-repo directory answers the unknown shape and does not throw', () => {
    const plain = join(SCRATCH, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    expect(() => readSessionFacts(plain)).not.toThrow();
    expect(readSessionFacts(plain)).toEqual(UNKNOWN_SESSION_FACTS);
  });

  it('a path that does not exist at all answers the unknown shape', () => {
    const gone = join(SCRATCH, 'no', 'such', 'place');
    expect(() => readSessionFacts(gone)).not.toThrow();
    expect(readSessionFacts(gone).isRepo).toBe(false);
  });

  it('memoizes within the TTL, and re-reads past it', () => {
    const root = makeRepo('memo', 'before');
    const t0 = 1_000_000;

    expect(readSessionFacts(root, t0).branch).toBe('before');

    // Change the truth on disk, then ask again INSIDE the window. A cached answer is the
    // observable proof that git was not forked a second time — no spy required.
    git(root, 'checkout', '-q', '-b', 'after');
    expect(readSessionFacts(root, t0 + SESSION_FACTS_TTL_MS - 1).branch).toBe('before');

    // Past the window the next poll sees the real branch. The TTL is shorter than the
    // shelf's 15s poll for exactly this reason: it collapses concurrent panes, it never
    // masks a switch from the next tick.
    expect(readSessionFacts(root, t0 + SESSION_FACTS_TTL_MS).branch).toBe('after');
  });

  it('caches per project root — one project cannot answer for another', () => {
    const a = makeRepo('cache-a', 'branch-a');
    const b = makeRepo('cache-b', 'branch-b');
    const t = 2_000_000;
    expect(readSessionFacts(a, t).branch).toBe('branch-a');
    expect(readSessionFacts(b, t).branch).toBe('branch-b');
  });

  it('the TTL is shorter than the shelf poll it serves', () => {
    // Guards the p-n4 reasoning against a future "let's make the cache last longer".
    expect(SESSION_FACTS_TTL_MS).toBeLessThan(15_000);
  });
});
