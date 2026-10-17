// AC16: whose conversation is a transcript? The launch dir (the FIRST record's cwd) decides, and
// the closest registered owner wins: a chosen project's worktree is its own, a nested or sibling
// project is not, a project inside a parent repo never inherits that repo's worktrees, and a
// transcript whose owner cannot be read is refused (fail closed).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOwnerCandidates, transcriptLaunchCwd, transcriptOwnerCheck, OWNER_SCAN_LINES } from '../../src/lib/transcript-locate.js';

let base: string;
const p = (...s: string[]) => join(base, ...s);

/** The head real transcripts start with: records with no cwd, then the first one carrying it. */
function transcript(name: string, cwds: string[], opts: { leadIn?: number } = {}): string {
  const lines = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-16T10:00:00Z' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'A chat' }),
    JSON.stringify({ type: 'mode', mode: 'default' }),
    ...Array.from({ length: opts.leadIn ?? 0 }, (_, i) => JSON.stringify({ type: 'summary', i })),
    ...cwds.map((cwd, i) => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: `turn ${i}` } })),
  ];
  const f = p('t', `${name}.jsonl`);
  writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'owner-')));
  for (const d of ['t', 'p/foo/src', 'p/foo-bar', 'p/foo/sub', 'wt/foo-feature/src', 'parent/inner', 'parent-wt', 'other']) mkdirSync(p(d), { recursive: true });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A fake git: foo is its repo's top level with one worktree; inner sits inside parent's repo. */
const git = (cwd: string, args: string[]): string => {
  if (args[0] === 'rev-parse') {
    if (cwd === p('p/foo')) return p('p/foo') + '\n';
    if (cwd === p('parent/inner')) return p('parent') + '\n';
    throw new Error('not a repo');
  }
  if (cwd === p('p/foo')) return `worktree ${p('p/foo')}\nHEAD abc\n\nworktree ${p('wt/foo-feature')}\nHEAD def\n`;
  if (cwd === p('parent/inner')) return `worktree ${p('parent')}\n\nworktree ${p('parent-wt')}\n`;
  return '';
};

describe('transcriptOwnerCheck', () => {
  const roots = () => [p('p/foo'), p('p/foo-bar'), p('p/foo/sub'), p('parent/inner'), p('other')];
  const cands = () => buildOwnerCandidates(roots(), git);

  it('the launch dir is the FIRST record carrying cwd, found past the cwd-less head', () => {
    const f = transcript('head', [p('p/foo/src'), p('other')]);
    expect(transcriptLaunchCwd(f)).toBe(p('p/foo/src'));
  });

  it('a chosen project\'s own chat (and a subdir of it) is mine; another project\'s is other', () => {
    expect(transcriptOwnerCheck(transcript('mine', [p('p/foo/src')]), [p('p/foo')], cands())).toBe('mine');
    expect(transcriptOwnerCheck(transcript('theirs', [p('other')]), [p('p/foo')], cands())).toBe('other');
  });

  it('a worktree of a chosen project is mine', () => {
    expect(transcriptOwnerCheck(transcript('wt', [p('wt/foo-feature/src')]), [p('p/foo')], cands())).toBe('mine');
  });

  it('/p/foo never owns /p/foo-bar, and a registered /p/foo/sub inside the chosen /p/foo is other', () => {
    expect(transcriptOwnerCheck(transcript('sibling', [p('p/foo-bar')]), [p('p/foo')], cands())).toBe('other');
    expect(transcriptOwnerCheck(transcript('nested', [p('p/foo/sub')]), [p('p/foo')], cands())).toBe('other');
    expect(transcriptOwnerCheck(transcript('nested2', [p('p/foo/sub')]), [p('p/foo/sub')], cands())).toBe('mine');
  });

  it('a project inside a parent git repo does not adopt the parent\'s worktrees', () => {
    expect(cands().some((c) => c.path === p('parent-wt'))).toBe(false);
    expect(transcriptOwnerCheck(transcript('parentwt', [p('parent-wt')]), [p('parent/inner')], cands())).toBe('other');
  });

  it('starting in an unchosen project and later cd-ing into the chosen one is other', () => {
    expect(transcriptOwnerCheck(transcript('cd', [p('other'), p('p/foo')]), [p('p/foo')], cands())).toBe('other');
  });

  it('fail closed: no cwd within the bound, an unparseable file, or a launch dir that no longer exists is other', () => {
    expect(transcriptOwnerCheck(transcript('nocwd', []), [p('p/foo')], cands())).toBe('other');
    expect(transcriptOwnerCheck(transcript('late', [p('p/foo')], { leadIn: OWNER_SCAN_LINES }), [p('p/foo')], cands())).toBe('other');
    const junk = p('t', 'junk.jsonl');
    writeFileSync(junk, 'not json\n{also not\n');
    expect(transcriptOwnerCheck(junk, [p('p/foo')], cands())).toBe('other');
    expect(transcriptOwnerCheck(transcript('gone', [p('p/foo/removed-worktree')]), [p('p/foo')], cands())).toBe('other');
    expect(transcriptOwnerCheck(transcript('nowhere', [p('t')]), [p('p/foo')], cands())).toBe('other');
  });

  it('no transcript is none (a new tab, an unflushed live chat): the caller decides', () => {
    expect(transcriptOwnerCheck(null, [p('p/foo')], cands())).toBe('none');
    expect(transcriptOwnerCheck(p('t', 'missing.jsonl'), [p('p/foo')], cands())).toBe('none');
  });
});
