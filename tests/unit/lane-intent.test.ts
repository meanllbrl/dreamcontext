import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LANE_INTENT_FILE, laneHere, laneIntentAt, opsRootFromIntent, raiseLaneIntentToFull, writeLaneIntent } from '../../src/lib/lane-intent.js';

/** The lane's one home (plan sirket-yavaslik D3, C2, C3, C9; AC9, AC10). */
describe('lane intent', () => {
  let dir: string;
  let repo: string;
  let wt: string;
  let base: string;
  const oldHome = process.env.HOME;
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();
  const who = { contextRoot: '/nowhere/_dream_context', superId: 'main', child: 'c1' };
  const adminFile = (w: string) => join(git(w, 'rev-parse', '--absolute-git-dir'), LANE_INTENT_FILE);

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'lane-intent-')));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@e.st'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.css'), '.a{}\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
    base = git(repo, 'rev-parse', 'HEAD');
    wt = join(dir, 'wt-one');
    git(repo, 'worktree', 'add', '-q', '-b', 'super/one', wt, base);
    process.env.HOME = join(dir, 'home');
  });
  afterEach(() => { process.env.HOME = oldHome; rmSync(dir, { recursive: true, force: true }); });

  it('no file: no intent', () => {
    expect(laneIntentAt(wt)).toBeNull();
  });

  it('a written fast intent is read by the worktree, outside its working tree', () => {
    writeLaneIntent(repo, wt, { intent: 'fast', base, ...who });
    expect(laneIntentAt(wt)).toEqual({ intent: 'fast', base });
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('the same worktree reads it whatever the session or tool (no env gives an intent)', () => {
    writeLaneIntent(repo, wt, { intent: 'full', base, ...who });
    process.env.DREAMCONTEXT_AGENT_TOOL = 'codex';
    try { expect(laneIntentAt(wt)?.intent).toBe('full'); } finally { delete process.env.DREAMCONTEXT_AGENT_TOOL; }
  });

  it('a broken file, a bad base or a base that is no ancestor reads full, never fast', () => {
    writeLaneIntent(repo, wt, { intent: 'fast', base, ...who });
    const f = adminFile(wt);
    writeFileSync(f, '{"intent":"fast",');
    expect(laneIntentAt(wt)).toEqual({ intent: 'full', base: null });
    writeFileSync(f, JSON.stringify({ intent: 'fast', base: 'HEAD' }));
    expect(laneIntentAt(wt)).toEqual({ intent: 'full', base: null });
    writeFileSync(f, JSON.stringify({ intent: 'fast', base: 'a'.repeat(40) }));
    expect(laneIntentAt(wt)).toEqual({ intent: 'full', base: null });
    writeFileSync(f, JSON.stringify({ intent: 'full', base: 'zz' }));
    expect(laneIntentAt(wt)?.intent).toBe('full');
  });

  it('a symlink in the file\'s place is refused, never followed', () => {
    const f = adminFile(wt);
    writeFileSync(join(dir, 'target.json'), '{}');
    symlinkSync(join(dir, 'target.json'), f);
    expect(() => writeLaneIntent(repo, wt, { intent: 'fast', base, ...who })).toThrow(/not a plain file/);
    expect(readFileSync(join(dir, 'target.json'), 'utf-8')).toBe('{}');
    expect(laneIntentAt(wt)).toEqual({ intent: 'full', base: null });
  });

  it('a worktree whose .git points elsewhere is not written', () => {
    const other = join(dir, 'fake');
    mkdirSync(other);
    writeFileSync(join(other, '.git'), `gitdir: ${join(dir, 'elsewhere')}\n`);
    expect(() => writeLaneIntent(repo, other, { intent: 'fast', base, ...who })).toThrow();
  });

  it('a suffixed admin folder (two worktrees with one name) gets the right file', () => {
    const second = join(dir, 'b', 'wt-one');
    mkdirSync(join(dir, 'b'));
    git(repo, 'worktree', 'add', '-q', '-b', 'super/two', second, base);
    writeLaneIntent(repo, second, { intent: 'fast', base, ...who });
    expect(laneIntentAt(second)?.intent).toBe('fast');
    expect(laneIntentAt(wt)).toBeNull();
  });

  it('raising to full keeps the base and never comes back to fast', () => {
    writeLaneIntent(repo, wt, { intent: 'fast', base, ...who });
    raiseLaneIntentToFull(repo, wt, who);
    expect(laneIntentAt(wt)).toEqual({ intent: 'full', base });
    raiseLaneIntentToFull(repo, wt, who);
    expect(laneIntentAt(wt)?.intent).toBe('full');
  });

  it('a gone worktree cannot be raised', () => {
    expect(() => raiseLaneIntentToFull(repo, join(dir, 'gone'), who)).toThrow();
  });

  it('laneHere reads from the recorded base, not the default branch', () => {
    // The branch moves far ahead before the worktree was cut: only its own change counts.
    for (let i = 0; i < 5; i++) { writeFileSync(join(wt, `big${i}.ts`), 'x\n'.repeat(80)); }
    git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'ahead');
    const cut = git(wt, 'rev-parse', 'HEAD');
    writeLaneIntent(repo, wt, { intent: 'fast', base: cut, ...who });
    writeFileSync(join(wt, 'a.css'), '.a{color:#2e7d32}\n');
    expect(laneHere(wt).pick.lane).toBe('fast');
  });

  it('opsRootFromIntent accepts only a registered project\'s brain', () => {
    const brain = join(dir, 'proj', '_dream_context');
    mkdirSync(brain, { recursive: true });
    writeLaneIntent(repo, wt, { intent: 'fast', base, superId: 'main', child: 'c1', contextRoot: brain });
    expect(opsRootFromIntent(wt)).toBeNull();
    mkdirSync(join(dir, 'home', '.dreamcontext'), { recursive: true });
    writeFileSync(join(dir, 'home', '.dreamcontext', 'automations.json'), JSON.stringify({ projects: { [join(dir, 'proj')]: { approvals: {} } } }));
    expect(opsRootFromIntent(wt)).toBe(brain);
  });
});
