/**
 * `session-edits.ts` — where a session's WRITES are landing, and the disagreement that makes.
 *
 * Real repositories and a real `git worktree add`, for the reason `session-cwd.test.ts` gives:
 * the gate is git's own answer about repository identity, and a mock would pin my assumption
 * about it rather than git's behaviour.
 *
 * The assertion that matters most here is the SILENCE. This warning is only worth anything if
 * it stays off during a session that is behaving correctly — and the single most common thing
 * a correctly-behaving session does is write into the brain from a worktree.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSessionEdits, editsElsewhere, isBrainPath, recordSessionEdit, resetSessionEdits,
} from '../../src/lib/session-edits.js';
import { resetSessionCheckouts } from '../../src/lib/session-cwd.js';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_GIT = gitAvailable();

/** Canonicalised at creation: `recordSessionEdit` attributes a write to git's own
 *  `--show-toplevel`, which is a REALPATH, and on macOS `/var/...` is `/private/var/...`. */
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dc-session-edits-')));
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(name: string): string {
  const root = join(SCRATCH, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
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

const SESSION = 'edits-session';

describe('isBrainPath', () => {
  it('matches a path SEGMENT, so the brain is excluded and lookalikes are not', () => {
    expect(isBrainPath('/repo/_dream_context/state/a-task.md')).toBe(true);
    expect(isBrainPath('/repo/_dream_context')).toBe(true);
    expect(isBrainPath('/repo/src/index.ts')).toBe(false);
    // Neither of these is the brain: one is a directory that merely ends in the word, the
    // other a file named after it.
    expect(isBrainPath('/repo/my_dream_context/src/a.ts')).toBe(false);
    expect(isBrainPath('/repo/docs/_dream_context.md')).toBe(false);
  });
});

describe.skipIf(!HAS_GIT)('session-edits', () => {
  beforeEach(() => { resetSessionEdits(); resetSessionCheckouts(); });

  it('counts a write into a sibling worktree and reports it against the current checkout', () => {
    const root = makeRepo('edits-main');
    const wt = addWorktree(root, 'edits-wt', 'feat/side');

    expect(recordSessionEdit(SESSION, join(wt, 'src', 'index.ts'), root)).toBe(wt);
    expect(editsElsewhere(SESSION, root)).toEqual({ dir: wt, name: 'edits-wt', count: 1 });
  });

  it('says NOTHING when the writes are in the checkout the shelf already names', () => {
    const root = makeRepo('edits-same');
    const wt = addWorktree(root, 'edits-same-wt', 'feat/here');

    recordSessionEdit(SESSION, join(wt, 'src', 'index.ts'), root);
    // The session is IN the worktree, which is where it wrote — there is no disagreement.
    expect(editsElsewhere(SESSION, wt)).toBeNull();
  });

  it('IGNORES brain writes — the thing a correct session does constantly', () => {
    // The regression this test exists for: a session working in a worktree logs tasks and
    // changelog entries into the brain's own checkout, by design. Counted, this warning would
    // be on during every well-behaved session.
    const root = makeRepo('edits-brain');
    const wt = addWorktree(root, 'edits-brain-wt', 'feat/brain');

    expect(recordSessionEdit(SESSION, join(root, '_dream_context', 'state', 'a.md'), wt)).toBeNull();
    expect(editsElsewhere(SESSION, wt)).toBeNull();
  });

  it('ignores a write outside every repository this vault governs', () => {
    const root = makeRepo('edits-gate');
    const stranger = makeRepo('edits-gate-stranger');
    const plain = join(SCRATCH, 'edits-gate-plain');
    mkdirSync(plain, { recursive: true });

    expect(recordSessionEdit(SESSION, join(stranger, 'src.ts'), root)).toBeNull();
    expect(recordSessionEdit(SESSION, join(plain, 'src.ts'), root)).toBeNull();
    expect(recordSessionEdit(SESSION, 'relative/path.ts', root)).toBeNull();
    expect(editsElsewhere(SESSION, root)).toBeNull();
  });

  it('names the BUSIEST other checkout, not the newest', () => {
    const root = makeRepo('edits-busiest');
    const a = addWorktree(root, 'edits-busy-a', 'feat/a');
    const b = addWorktree(root, 'edits-busy-b', 'feat/b');

    for (let i = 0; i < 4; i += 1) recordSessionEdit(SESSION, join(a, `f${i}.ts`), root);
    recordSessionEdit(SESSION, join(b, 'one.ts'), root); // the newest, and not the answer

    expect(editsElsewhere(SESSION, root)).toEqual({ dir: a, name: 'edits-busy-a', count: 4 });
  });

  it('is per session, and dies with it', () => {
    const root = makeRepo('edits-scope');
    const wt = addWorktree(root, 'edits-scope-wt', 'feat/scope');

    recordSessionEdit(SESSION, join(wt, 'a.ts'), root);
    expect(editsElsewhere('another-session', root)).toBeNull();
    expect(editsElsewhere(null, root)).toBeNull();

    clearSessionEdits(SESSION);
    expect(editsElsewhere(SESSION, root)).toBeNull();
  });

  it('reports against the CLAIMED checkout too — a declaration does not excuse the writes', () => {
    const root = makeRepo('edits-claim');
    const declared = addWorktree(root, 'edits-claim-said', 'feat/said');
    const actual = addWorktree(root, 'edits-claim-did', 'feat/did');

    recordSessionEdit(SESSION, join(actual, 'src.ts'), root);
    // `current` is whatever won in resolveSessionDir — here, the claim. The writes went
    // somewhere else, and that is exactly as wrong as declaring nothing.
    expect(editsElsewhere(SESSION, declared)?.name).toBe('edits-claim-did');
  });
});
