import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefState } from '../../src/lib/super/state-brief.js';
import { handoffDir, writeHandoffRecord } from '../../src/lib/context-watch.js';
import { DIGEST_MAX_CHARS, SUPER_BRIEF_LINE, resumeDigest, storeResumeDigest, withResumeDigest } from '../../src/lib/super/resume-digest.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A real repo under ~/.claude-worktrees (the only place a child's worktree is accepted). */
function repo(): string {
  const base = join(homedir(), '.claude-worktrees');
  mkdirSync(base, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(base, 'b14-digest-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

describe('briefState (super state --brief)', () => {
  const full = {
    children: {
      s1: { status: 'working', task: 'x', brief: 'fenced brief', lastLine: 'did it', model: 'opus', sessionId: 'drop', startedAt: 5, elapsedMs: 9, worktree: '/w', branch: 'super/x' },
      s2: { status: 'ended', brief: '' },
    },
    queue: [{ id: 'q1', state: 'pending', kind: 'ask' }, { id: 'q2', state: 'done', kind: 'ask' }],
    containers: [{ id: 'c' }], machine: { huge: 'x'.repeat(5000) }, cards: {}, team: [{ id: 't1', status: 'running' }, { id: 't2', status: 'done' }],
    pool: [], warnings: ['w'], owed: [{ id: 'o1' }], held: [], status: [{ sessionId: 's1' }], mcp: ['a'], pad: [{ id: 'p', text: 'waiting on you' }], padStale: { ids: ['p'] },
  };

  it('keeps children and the open queue, drops the stage, the machine and the older-reader duplicate', () => {
    const b = briefState(full) as any;
    expect(b.brief).toBe(true);
    expect(Object.keys(b.children)).toEqual(['s1', 's2']);
    expect(b.children.s1).toMatchObject({ status: 'working', task: 'x', worktree: '/w', branch: 'super/x', lastLine: 'did it' });
    expect(b.children.s1.sessionId).toBeUndefined();
    expect(b.children.s2).toEqual({ status: 'ended' });
    expect(b.queue.map((q: any) => q.id)).toEqual(['q1']);
    expect(b.team).toEqual([{ id: 't1', status: 'running' }]);
    expect(b.warnings).toEqual(['w']);
    expect(b.pad).toEqual([{ id: 'p', text: 'waiting on you' }]);
    expect(b.owed).toEqual([{ id: 'o1' }]);
    expect(b.held).toBeUndefined();
    for (const k of ['containers', 'machine', 'cards', 'status', 'mcp']) expect(b[k]).toBeUndefined();
    expect(b.more).toContain('dreamcontext super state');
    expect(JSON.stringify(b).length).toBeLessThan(JSON.stringify(full).length / 3);
  });

  it('survives an empty or odd reply', () => {
    expect(briefState({})).toMatchObject({ brief: true, children: {}, queue: [] });
    expect(() => briefState({ children: 'x', queue: 3, team: {} } as any)).not.toThrow();
  });
});

describe('resumeDigest', () => {
  it('is empty without a worktree, or for one outside ~/.claude-worktrees', () => {
    expect(resumeDigest({ task: 'x' })).toBe('');
    const outside = mkdtempSync(join(tmpdir(), 'b14-out-'));
    dirs.push(outside);
    expect(resumeDigest({ task: 'x', worktree: outside, branch: 'super/x' })).toBe('');
  });

  it('names START, HEAD, the changed paths (committed and not) and the next step', () => {
    const wt = repo();
    const base = git(wt, 'rev-parse', 'HEAD');
    git(wt, 'checkout', '-qb', 'super/b14-x');
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'b');
    writeFileSync(join(wt, 'a.txt'), 'changed\n');
    const d = resumeDigest({ task: 'some-task', worktree: wt, branch: 'super/b14-x' });
    expect(d).toContain(`START tree: ${base}`);
    expect(d).toContain('A b.txt');
    expect(d).toContain('~ a.txt');
    expect(d).toContain('1 not committed');
    expect(d).toContain('Open review: none');
    expect(d.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it('reads an open review round from the loop ledger and prints its next command', () => {
    const wt = repo();
    const start = git(wt, 'rev-parse', 'HEAD');
    const dir = join(wt, 'tmp', 'develop', 'some-task', 'review', 'end');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({
      v: 1, plan: 'end', goal: 'g', task: 'some-task', lenses: ['reviewer'], budget: { base: 0, extra: 0, unlimited: true },
      createdAt: new Date().toISOString(), seq: 0, events: [], rounds: [], mode: 'code', start, criteria: 'c',
    }));
    const d = resumeDigest({ task: 'some-task', worktree: wt });
    expect(d).toContain(`START tree: ${start}`);
    expect(d).toContain('Open review: loop end');
    expect(d).toContain('Next command: Next:');
  });

  it('caps a huge change list', () => {
    const wt = repo();
    for (let i = 0; i < 80; i++) writeFileSync(join(wt, `file-with-a-long-name-${i}.txt`), 'x');
    const d = resumeDigest({ task: 'some-task', worktree: wt });
    expect(d).toContain('+60 more');
    expect(d.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });
});

describe('withResumeDigest (reads what the hand-over stored; runs no git)', () => {
  const root = () => { const r = mkdtempSync(join(tmpdir(), 'b14-ctx-')); dirs.push(r); mkdirSync(join(r, 'state'), { recursive: true }); return r; };
  const rec = (wt: string, at = '2026-11-12T01:00:00.000Z') => ({ task: 'x', title: 'X', at, contextTokens: null, fromSession: 's', tab: 'pane1', worktree: wt, branch: 'super/b14-x' });

  it('sends a Super successor to the brief state', () => {
    expect(withResumeDigest('Handoff: you are the Super.', { kind: 'super', at: 'a' }, '/nowhere', 'k')).toBe(`Handoff: you are the Super. ${SUPER_BRIEF_LINE}`);
  });
  it('leaves a child prompt alone when nothing was stored', () => {
    expect(withResumeDigest('Handoff: continue task X.', { at: 'a' }, root(), 'pane1')).toBe('Handoff: continue task X.');
  });
  it('appends the digest the hand-over stored, and only for that record', () => {
    const r = root();
    const wt = repo();
    writeHandoffRecord(r, 'pane1', rec(wt));
    storeResumeDigest(r, 'pane1');
    const out = withResumeDigest('Handoff: continue task X.', { at: '2026-11-12T01:00:00.000Z' }, r, 'pane1');
    expect(out.startsWith('Handoff: continue task X.\n\nResume digest')).toBe(true);
    // A newer hand-over (different `at`) never serves the older digest.
    expect(withResumeDigest('P', { at: '2026-11-12T02:00:00.000Z' }, r, 'pane1')).toBe('P');
    expect(handoffDir(r)).toContain('.handoff-requests');
  });
  it('stores nothing for a Super record', () => {
    const r = root();
    writeHandoffRecord(r, 'pane1', { ...rec('/x'), kind: 'super' });
    storeResumeDigest(r, 'pane1');
    expect(withResumeDigest('P', { at: '2026-11-12T01:00:00.000Z' }, r, 'pane1')).toBe('P');
  });
});
