/**
 * `session-transcript-cwd.ts` — WHICH checkout a session is in, read from its transcript.
 *
 * Driven against REAL git repositories, REAL `git worktree add` and REAL transcript files, for
 * the same reason `session-cwd.test.ts` is: the whole module is a claim about what git prints
 * from a subdirectory versus a worktree root, and about the shape `claude` actually writes to
 * `~/.claude/projects/**`. A mock would pin my assumptions instead of those behaviours.
 *
 * The transcript ENTRIES below are the captured shape, not an invented one — `cwd` on
 * substantive entries, absent on the `queue-operation` chatter that routinely ends a file. That
 * absence is why this module scans BACKWARD rather than reading the last line, and it is the
 * first thing asserted.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TAIL_STEPS_BYTES, newestCwdIn, resetTranscriptCheckoutCaches, transcriptCheckout,
} from '../../src/lib/session-transcript-cwd.js';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_GIT = gitAvailable();

/** Canonicalised at creation: `transcriptCheckout` answers a REALPATH (it comes from
 *  `git rev-parse --show-toplevel`), and on macOS `mkdtempSync` hands back a `/var/...` path
 *  whose real name is `/private/var/...`. Without this every assertion below would compare the
 *  two spellings of one directory. The realpath property itself is asserted separately. */
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dc-transcript-cwd-')));
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

/** A scratch HOME with a `~/.claude/projects/<slug>/<id>.jsonl`, as `claude` lays it out. */
function makeHome(name: string): string {
  const home = join(SCRATCH, name);
  mkdirSync(join(home, '.claude', 'projects', 'some-project'), { recursive: true });
  return home;
}

function writeTranscript(home: string, id: string, entries: unknown[]): string {
  const file = join(home, '.claude', 'projects', 'some-project', `${id}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return file;
}

/** The two entry shapes that matter, verbatim in structure. */
const noCwd = (i: number) => ({ type: 'queue-operation', sessionId: `s${i}` });
const withCwd = (cwd: string, branch = 'main') => ({
  type: 'assistant', cwd, gitBranch: branch, message: { content: [] },
});

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ID = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('newestCwdIn (pure)', () => {
  it('scans BACKWARD past entries carrying no cwd — the last line is not the answer', () => {
    // Exactly the tail every real transcript in this project ends with: substantive entries,
    // then `queue-operation` chatter. Reading "the last line" would answer null forever.
    const text = [
      JSON.stringify(withCwd('/repo/older')),
      JSON.stringify(withCwd('/repo/newer')),
      JSON.stringify(noCwd(1)),
      JSON.stringify(noCwd(2)),
    ].join('\n');
    expect(newestCwdIn(text, true)).toBe('/repo/newer');
  });

  it('drops the FIRST line when the tail did not start at byte 0 — it is a fragment', () => {
    // A window that opened mid-entry: the fragment happens to be the only thing that would
    // have matched, so a reader that parsed it would answer from half a line.
    const fragment = '{"type":"assistant","cwd":"/repo/truncated-and-unparseable';
    expect(newestCwdIn(fragment, false)).toBeNull();
    // ...and with a whole entry after it, that entry is the answer, not the fragment.
    expect(newestCwdIn(`${fragment}\n${JSON.stringify(withCwd('/repo/whole'))}`, false))
      .toBe('/repo/whole');
  });

  it('ignores a relative cwd and a non-string cwd rather than returning them', () => {
    expect(newestCwdIn(JSON.stringify({ type: 'assistant', cwd: 'relative/path' }), true)).toBeNull();
    expect(newestCwdIn(JSON.stringify({ type: 'assistant', cwd: 42 }), true)).toBeNull();
  });

  it('survives unparseable lines, blank lines and a non-object entry', () => {
    const text = ['not json at all', '', '"a bare string"', JSON.stringify(withCwd('/repo/ok'))].join('\n');
    expect(newestCwdIn(text, true)).toBe('/repo/ok');
  });

  it('answers null for an empty document rather than throwing', () => {
    expect(newestCwdIn('', true)).toBeNull();
  });
});

describe.skipIf(!HAS_GIT)('transcriptCheckout', () => {
  beforeEach(() => { resetTranscriptCheckoutCaches(); });

  it('names the WORKTREE the transcript last reported, not the project root', () => {
    const root = makeRepo('repo-a', 'main');
    const wt = addWorktree(root, 'wt-a', 'feature-a');
    const home = makeHome('home-a');
    writeTranscript(home, ID, [withCwd(root), withCwd(wt, 'feature-a'), noCwd(1)]);

    expect(transcriptCheckout(ID, root, { home })).toBe(wt);
  });

  it('resolves a SUBDIRECTORY to its checkout root — the Bash tool cwd drifts down the tree', () => {
    // The measured case: `.../dashboard/src/components/sleepy/chat`. Git answers the same
    // branch from there, so a naive pass looks right — but `worktreeName` is `basename(dir)`,
    // and the shelf would have gone on to call the checkout "chat".
    const root = makeRepo('repo-b', 'main');
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const home = makeHome('home-b');
    writeTranscript(home, ID, [withCwd(deep)]);

    expect(transcriptCheckout(ID, root, { home })).toBe(root);
  });

  it('resolves a subdirectory of a WORKTREE to the worktree root, not the main checkout', () => {
    const root = makeRepo('repo-c', 'main');
    const wt = addWorktree(root, 'wt-c', 'feature-c');
    const deep = join(wt, 'dashboard', 'src');
    mkdirSync(deep, { recursive: true });
    const home = makeHome('home-c');
    writeTranscript(home, ID, [withCwd(deep, 'feature-c')]);

    expect(transcriptCheckout(ID, root, { home })).toBe(wt);
  });

  it('REFUSES a directory in another repository', () => {
    const root = makeRepo('repo-d', 'main');
    const foreign = makeRepo('repo-d-foreign', 'main');
    const home = makeHome('home-d');
    writeTranscript(home, ID, [withCwd(foreign)]);

    // null, not `foreign` — the caller falls back to the project root rather than pointing the
    // shelf (and the `git` calls behind it) at an unrelated repository.
    expect(transcriptCheckout(ID, root, { home })).toBeNull();
  });

  it('refuses a directory that is not a repository at all, and one that has vanished', () => {
    const root = makeRepo('repo-e', 'main');
    const plain = join(SCRATCH, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    const home = makeHome('home-e');

    writeTranscript(home, ID, [withCwd(plain)]);
    expect(transcriptCheckout(ID, root, { home })).toBeNull();

    resetTranscriptCheckoutCaches();
    writeTranscript(home, ID, [withCwd(join(SCRATCH, 'gone-forever'))]);
    expect(transcriptCheckout(ID, root, { home })).toBeNull();
  });

  it('answers null when there is no transcript, and when the transcript has no cwd', () => {
    const root = makeRepo('repo-f', 'main');
    const home = makeHome('home-f');

    // A pane opened and never used has no file at all.
    expect(transcriptCheckout(OTHER_ID, root, { home })).toBeNull();

    writeTranscript(home, ID, [noCwd(1), noCwd(2)]);
    expect(transcriptCheckout(ID, root, { home })).toBeNull();
  });

  it('answers null for an empty transcript rather than reading past the start of the file', () => {
    const root = makeRepo('repo-g', 'main');
    const home = makeHome('home-g');
    writeFileSync(join(home, '.claude', 'projects', 'some-project', `${ID}.jsonl`), '', 'utf-8');
    expect(transcriptCheckout(ID, root, { home })).toBeNull();
  });

  it('rejects an unsafe id before it can be used to build a path', () => {
    const root = makeRepo('repo-h', 'main');
    const home = makeHome('home-h');
    for (const bad of ['', '../../etc/passwd', 'a/b', 'has space']) {
      expect(transcriptCheckout(bad, root, { home })).toBeNull();
    }
  });

  it('finds a cwd buried behind an entry LARGER than the first tail window', () => {
    // The reason the tail escalates rather than being a fixed 64 KB: one tool result holding a
    // whole file is routine, and a fixed window would then contain no complete entry at all.
    const root = makeRepo('repo-i', 'main');
    const wt = addWorktree(root, 'wt-i', 'feature-i');
    const home = makeHome('home-i');
    const file = writeTranscript(home, ID, [withCwd(wt, 'feature-i')]);
    // One entry comfortably past the first step, with no cwd of its own.
    const huge = { type: 'user', message: { content: 'x'.repeat(TAIL_STEPS_BYTES[0] + 50_000) } };
    appendFileSync(file, JSON.stringify(huge) + '\n', 'utf-8');

    expect(transcriptCheckout(ID, root, { home })).toBe(wt);
  });

  it('re-reads when the transcript GROWS — a cd inside one session must not be memoized away', () => {
    const root = makeRepo('repo-j', 'main');
    const wt = addWorktree(root, 'wt-j', 'feature-j');
    const home = makeHome('home-j');
    const file = writeTranscript(home, ID, [withCwd(root)]);

    expect(transcriptCheckout(ID, root, { home })).toBe(root);
    // Same millisecond is the NORMAL case during a live turn, which is why the memo keys on
    // size as well as mtime. Without the size half this assertion would still read `root`.
    appendFileSync(file, JSON.stringify(withCwd(wt, 'feature-j')) + '\n', 'utf-8');
    expect(transcriptCheckout(ID, root, { home })).toBe(wt);
  });

  it('answers a REALPATH even when the transcript names the symlinked spelling', () => {
    // Not a curiosity: on macOS every path under /tmp arrives this way, so a caller comparing
    // the answer to its own un-canonicalised project root would see two different directories.
    const root = makeRepo('repo-l', 'main');
    const link = join(SCRATCH, 'link-to-repo-l');
    symlinkSync(root, link, 'dir');
    const home = makeHome('home-l');
    writeTranscript(home, ID, [withCwd(link)]);

    expect(transcriptCheckout(ID, root, { home })).toBe(root);
  });

  it('follows a cd back OUT of a worktree — the case the tool-frame reader cannot see', () => {
    const root = makeRepo('repo-k', 'main');
    const wt = addWorktree(root, 'wt-k', 'feature-k');
    const home = makeHome('home-k');
    const file = writeTranscript(home, ID, [withCwd(wt, 'feature-k')]);

    expect(transcriptCheckout(ID, root, { home })).toBe(wt);
    appendFileSync(file, JSON.stringify(withCwd(root)) + '\n', 'utf-8');
    expect(transcriptCheckout(ID, root, { home })).toBe(root);
  });
});
