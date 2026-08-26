/**
 * `session-start-branch.ts` — a FRESH chat session starts on the repository's default branch.
 *
 * Driven against REAL repositories, and the guard matrix is exercised with `apply:false` where
 * the outcome is what matters and with `apply:true` where the point is that the tree actually
 * moved. Both, because a guard that reports the right answer and then mutates anyway is exactly
 * the failure mode worth catching: this module runs `git checkout` on the user's working tree.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeFreshStart, freshSessionOnDefaultBranch, trackedChanges,
} from '../../src/lib/session-start-branch.js';
import { resetSessionFactsCaches } from '../../src/lib/session-facts.js';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_GIT = gitAvailable();

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dc-start-branch-')));
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function makeRepo(name: string, branch = 'main'): string {
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

function branchOf(root: string): string {
  return git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
}

describe.skipIf(!HAS_GIT)('freshSessionOnDefaultBranch', () => {
  // `readSessionFacts` memoizes per directory for 12s, and these tests create repos and move
  // their branches well inside that window.
  beforeEach(() => { resetSessionFactsCaches(); });

  it('SWITCHES a clean main checkout off a leftover branch, and the tree really moves', () => {
    // The defect verbatim: a previous session ran `git checkout -b`, nothing put it back.
    const root = makeRepo('switch-me');
    git(root, 'checkout', '-q', '-b', 'feat/left-behind');
    expect(branchOf(root)).toBe('feat/left-behind');

    const out = freshSessionOnDefaultBranch(root);
    expect(out).toEqual({ kind: 'switched', from: 'feat/left-behind', to: 'main' });
    expect(branchOf(root)).toBe('main');
  });

  it('says nothing when it is already on the default branch', () => {
    const root = makeRepo('already-there');
    const out = freshSessionOnDefaultBranch(root);
    expect(out).toEqual({ kind: 'already-default', branch: 'main' });
    // The ordinary case is silent — a banner on every new session would be noise.
    expect(describeFreshStart(out)).toBeNull();
  });

  it('REFUSES a dirty tree and leaves the branch exactly where it was', () => {
    // In this repository `_dream_context/` rides the working tree, so this arm is the COMMON
    // answer, not the edge case — which is why it is reported rather than silently skipped.
    const root = makeRepo('dirty-tree');
    git(root, 'checkout', '-q', '-b', 'feat/wip');
    writeFileSync(join(root, 'README.md'), '# edited, uncommitted\n', 'utf-8');

    const out = freshSessionOnDefaultBranch(root);
    expect(out).toEqual({ kind: 'blocked-dirty', branch: 'feat/wip', to: 'main', changed: 1 });
    expect(branchOf(root)).toBe('feat/wip');
    expect(describeFreshStart(out)).toMatch(/staying on feat\/wip rather than main/);
  });

  it('an UNTRACKED file is not dirt — it never blocks a checkout and carries across it', () => {
    // Refusing on untracked files would refuse forever in any project with a scratch dir;
    // `_dream_context/tmp/agent-drops/` here holds the very screenshots that reported this bug.
    const root = makeRepo('untracked-only');
    git(root, 'checkout', '-q', '-b', 'feat/scratch');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(join(root, 'tmp', 'shot.png'), 'not really a png', 'utf-8');

    expect(trackedChanges(root)).toEqual([]);
    expect(freshSessionOnDefaultBranch(root).kind).toBe('switched');
    expect(branchOf(root)).toBe('main');
  });

  it('a STAGED change counts as dirty just as an unstaged one does', () => {
    const root = makeRepo('staged-change');
    git(root, 'checkout', '-q', '-b', 'feat/staged');
    writeFileSync(join(root, 'new.txt'), 'staged\n', 'utf-8');
    git(root, 'add', 'new.txt');

    const out = freshSessionOnDefaultBranch(root);
    expect(out.kind).toBe('blocked-dirty');
    expect(branchOf(root)).toBe('feat/staged');
  });

  it('never touches a LINKED WORKTREE — its branch is the whole point of it', () => {
    const root = makeRepo('wt-owner');
    const wt = join(SCRATCH, 'wt-owned');
    git(root, 'worktree', 'add', '-q', '-b', 'worktree-thing', wt);

    const out = freshSessionOnDefaultBranch(wt);
    expect(out).toEqual({ kind: 'skipped-worktree', branch: 'worktree-thing' });
    expect(branchOf(wt)).toBe('worktree-thing');
    // A standing property of the project, not an event — so no banner.
    expect(describeFreshStart(out)).toBeNull();
  });

  it('reports unavailable, and mutates nothing, when there is no default branch to go to', () => {
    // No remote and neither `main` nor `master` present: the honest answer is "I cannot tell",
    // and this module never invents a default the user does not have.
    const root = makeRepo('no-default', 'trunk');
    git(root, 'checkout', '-q', '-b', 'feat/x');

    const out = freshSessionOnDefaultBranch(root);
    expect(out).toEqual({ kind: 'unavailable', reason: 'no-default' });
    expect(branchOf(root)).toBe('feat/x');
  });

  it('is not a repository → unavailable, never a throw', () => {
    const plain = join(SCRATCH, 'plain-dir');
    mkdirSync(plain, { recursive: true });
    expect(freshSessionOnDefaultBranch(plain)).toEqual({ kind: 'unavailable', reason: 'not-a-repo' });
  });

  it('a DETACHED HEAD is left alone', () => {
    const root = makeRepo('detached');
    const sha = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'checkout', '-q', sha);
    expect(freshSessionOnDefaultBranch(root)).toEqual({ kind: 'unavailable', reason: 'detached' });
  });

  it('apply:false reports the move it WOULD make without making it', () => {
    const root = makeRepo('dry-run');
    git(root, 'checkout', '-q', '-b', 'feat/dry');

    const out = freshSessionOnDefaultBranch(root, { apply: false });
    expect(out).toEqual({ kind: 'switched', from: 'feat/dry', to: 'main' });
    expect(branchOf(root)).toBe('feat/dry');
  });
});

describe.skipIf(!HAS_GIT)('the default branch is not assumed to be named by `origin`', () => {
  beforeEach(() => { resetSessionFactsCaches(); });

  it('follows a remote called something else entirely — this repo\'s is named `main`', () => {
    // The one-liner everybody writes is `symbolic-ref refs/remotes/origin/HEAD`, and it would
    // have answered null on the very repository this feature was built in.
    const upstream = makeRepo('upstream-repo', 'trunk');
    const clone = join(SCRATCH, 'clone-repo');
    execFileSync('git', ['clone', '-q', '--origin', 'main', upstream, clone], { stdio: 'ignore' });
    git(clone, 'config', 'user.email', 'verify@example.com');
    git(clone, 'config', 'user.name', 'Verify');
    git(clone, 'checkout', '-q', '-b', 'feat/y');

    const out = freshSessionOnDefaultBranch(clone);
    expect(out).toEqual({ kind: 'switched', from: 'feat/y', to: 'trunk' });
    expect(branchOf(clone)).toBe('trunk');
  });
});

describe('describeFreshStart', () => {
  it('speaks for the two outcomes that changed something, or wanted to', () => {
    expect(describeFreshStart({ kind: 'switched', from: 'feat/a', to: 'main' }))
      .toMatch(/moved the main checkout from feat\/a to main/);
    expect(describeFreshStart({ kind: 'failed', branch: 'feat/b', to: 'main', detail: 'index.lock exists' }))
      .toMatch(/could not move from feat\/b to main — index\.lock exists/);
  });

  it('pluralises the refusal honestly', () => {
    const one = describeFreshStart({ kind: 'blocked-dirty', branch: 'b', to: 'main', changed: 1 });
    const many = describeFreshStart({ kind: 'blocked-dirty', branch: 'b', to: 'main', changed: 4 });
    expect(one).toMatch(/1 tracked file have/);
    expect(many).toMatch(/4 tracked files have/);
  });

  it('is silent for every outcome that is a standing property rather than an event', () => {
    expect(describeFreshStart({ kind: 'already-default', branch: 'main' })).toBeNull();
    expect(describeFreshStart({ kind: 'skipped-worktree', branch: 'w' })).toBeNull();
    expect(describeFreshStart({ kind: 'unavailable', reason: 'no-default' })).toBeNull();
  });
});
