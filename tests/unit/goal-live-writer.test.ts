import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  GOAL_LIVE_CAPS,
  applyGoalLiveEvent,
  goalLivePath,
  goalLiveSessionId,
  readGoalLive,
  sweepAbandonedGoalLive,
  writeGoalLiveAtomic,
  type GoalLiveEvent,
  type GoalLiveState,
} from '../../src/lib/goal-live.js';
import {
  goalLiveActor,
  goalLiveClear,
  goalLivePhase,
  goalLiveStart,
  goalLiveState,
  parseActorSpec,
  parseStatePairs,
  registerGoalLiveCommand,
  type GoalLiveDeps,
} from '../../src/cli/commands/goal-live.js';

const T0 = '2026-09-25T10:00:00.000Z';
const SID = '11111111-2222-3333-4444-555555555555';

function fold(events: GoalLiveEvent[], start: GoalLiveState | null = null): GoalLiveState {
  let s = start;
  events.forEach((ev, i) => { s = applyGoalLiveEvent(s, ev, new Date(Date.parse(T0) + i * 1000).toISOString()); });
  return s as GoalLiveState;
}

// ─── The reducer ─────────────────────────────────────────────────────────────────

describe('applyGoalLiveEvent', () => {
  it('start writes a fresh plan-phase run, stamping the session only when there is one', () => {
    expect(applyGoalLiveEvent(null, { type: 'start', goal: 'quest', session: SID }, T0))
      .toEqual({ goal: 'quest', session: SID, started: T0, updated: T0, phase: 'plan' });
    const solo = applyGoalLiveEvent(null, { type: 'start', goal: 'quest', session: null }, T0);
    expect('session' in solo).toBe(false);
  });

  it('start discards the previous run instead of merging into it', () => {
    const old = fold([{ type: 'start', goal: 'a', session: null }, { type: 'phase', phase: 'impl' }]);
    const fresh = applyGoalLiveEvent(old, { type: 'start', goal: 'b', session: null }, T0);
    expect(fresh.history).toBeUndefined();
    expect(fresh.goal).toBe('b');
  });

  it('counts a phase once per ENTRY, appends history, and ignores a restated phase', () => {
    const s = fold([
      { type: 'start', goal: 'g', session: null },
      { type: 'phase', phase: 'plan' },
      { type: 'phase', phase: 'plan' },           // restated in a chain: not a new round
      { type: 'phase', phase: 'review' },
      { type: 'phase', phase: 'plan' },           // loop-back: round 2
      { type: 'phase', phase: 'review' },
    ]);
    expect(s.iters).toEqual({ plan: 2, review: 2 });
    expect(s.history!.map((h) => h.p)).toEqual(['plan', 'review', 'plan', 'review']);
    expect(s.phase).toBe('review');
  });

  it('a phase change resets the judges; a restated phase does not', () => {
    const seated = fold([
      { type: 'phase', phase: 'review' },
      { type: 'actor', id: 'critic', role: 'critic', kind: 'fresh', round: 1 },
    ]);
    expect(applyGoalLiveEvent(seated, { type: 'phase', phase: 'review' }, T0).judges).toHaveLength(1);
    expect(applyGoalLiveEvent(seated, { type: 'phase', phase: 'task' }, T0).judges).toBeUndefined();
  });

  it('records wave numbers without disturbing the forks', () => {
    const s = fold([
      { type: 'phase', phase: 'impl', wave: 1, waves: 3 },
      { type: 'actor', id: 'T1', role: 'implementer', kind: 'fork', from: 'planner' },
      { type: 'phase', phase: 'impl', wave: 2 },
    ]);
    expect(s.impl).toMatchObject({ wave: 2, waves: 3 });
    expect(s.impl!.forks).toHaveLength(1);
  });

  it('an implementer upserts a fork and appends lineage, keeping ctx on the fork event', () => {
    const s = fold([
      { type: 'actor', id: 'T1', role: 'implementer', kind: 'fork', from: 'planner', name: 'Role registry', ctx: 182000 },
      { type: 'actor', id: 'T1', role: 'implementer', kind: 'resume', round: 2, ctx: 999 },
    ]);
    expect(s.impl!.forks).toEqual([{ s: 'run', id: 'T1', role: 'implementer', name: 'Role registry' }]);
    expect(s.lineage).toHaveLength(2);
    expect(s.lineage![0]).toMatchObject({ a: 'T1', k: 'fork', from: 'planner', ctx: 182000 });
    // A resume inherits nothing to count: the number is dropped, not carried.
    expect(s.lineage![1]).toMatchObject({ a: 'T1', k: 'resume', r: 2 });
    expect('ctx' in s.lineage![1]).toBe(false);
  });

  it('ctx never survives on a spawn or fresh event', () => {
    const s = fold([
      { type: 'actor', id: 'planner', role: 'planner', kind: 'spawn', ctx: 5 },
      { type: 'actor', id: 'critic', role: 'critic', kind: 'fresh', ctx: 5 },
    ]);
    expect(s.lineage!.every((e) => !('ctx' in e))).toBe(true);
  });

  it('a judge role is seated in judges; a planner only appends lineage', () => {
    const s = fold([
      { type: 'actor', id: 'planner', role: 'planner', kind: 'spawn' },
      { type: 'actor', id: 'planner', role: 'planner', kind: 'resume', round: 2 },
      { type: 'actor', id: 'reviewer', role: 'reviewer', kind: 'fresh', round: 1 },
    ]);
    expect(s.impl).toBeUndefined();
    expect(s.judges).toEqual([{ s: 'run', id: 'reviewer', role: 'reviewer' }]);
    expect(s.lineage!.map((e) => `${e.a}:${e.k}`)).toEqual(['planner:spawn', 'planner:resume', 'reviewer:fresh']);
  });

  it('a verdict word finishes a judge; a state word sets a fork; an unseated id is ignored', () => {
    const seated = fold([
      { type: 'actor', id: 'critic', role: 'critic', kind: 'fresh' },
      { type: 'actor', id: 'T1', role: 'implementer', kind: 'fork' },
    ]);
    const s = fold([
      { type: 'state', id: 'critic', verdict: 'NEEDS_WORK' },
      { type: 'state', id: 'T1', state: 'fail' },
      { type: 'state', id: 'planner', state: 'done' },
    ], seated);
    expect(s.judges![0]).toMatchObject({ s: 'done', v: 'NEEDS_WORK' });
    expect(s.impl!.forks![0]).toMatchObject({ s: 'fail' });
    expect(s.lineage).toHaveLength(2);
  });

  it('caps forks, judges, history and lineage, keeping the newest', () => {
    const events: GoalLiveEvent[] = [];
    for (let i = 0; i < 30; i += 1) events.push({ type: 'actor', id: `T${i}`, role: 'implementer', kind: 'fork' });
    for (let i = 0; i < 20; i += 1) events.push({ type: 'actor', id: `j${i}`, role: 'critic', kind: 'fresh' });
    for (let i = 0; i < 20; i += 1) events.push({ type: 'actor', id: `p${i}`, role: 'planner', kind: 'resume' });
    const s = fold([{ type: 'phase', phase: 'impl' }, ...events]);
    expect(s.impl!.forks).toHaveLength(GOAL_LIVE_CAPS.forks);
    expect(s.impl!.forks!.at(-1)!.id).toBe('T29');
    expect(s.judges).toHaveLength(GOAL_LIVE_CAPS.judges);
    expect(s.lineage).toHaveLength(GOAL_LIVE_CAPS.lineage);
    expect(s.lineage!.at(-1)!.a).toBe('p19');
    const phases: GoalLiveEvent[] = [];
    for (let i = 0; i < 50; i += 1) phases.push({ type: 'phase', phase: i % 2 ? 'plan' : 'review' });
    const h = fold(phases);
    expect(h.history).toHaveLength(GOAL_LIVE_CAPS.history);
    expect(h.iters).toEqual({ review: 25, plan: 25 });
  });

  it('bumps updated on every event', () => {
    const s = applyGoalLiveEvent({ phase: 'plan', updated: T0 }, { type: 'phase', phase: 'review' }, '2026-09-25T11:00:00.000Z');
    expect(s.updated).toBe('2026-09-25T11:00:00.000Z');
  });
});

// ─── Session, path, file I/O ────────────────────────────────────────────────────

describe('session id and path', () => {
  it('reads CLAUDE_CODE_SESSION_ID, and falls back to null when unset, empty or unsafe', () => {
    expect(goalLiveSessionId({ CLAUDE_CODE_SESSION_ID: SID })).toBe(SID);
    expect(goalLiveSessionId({})).toBeNull();
    expect(goalLiveSessionId({ CLAUDE_CODE_SESSION_ID: '  ' })).toBeNull();
    expect(goalLiveSessionId({ CLAUDE_CODE_SESSION_ID: '../../etc' })).toBeNull();
  });

  it('names the file by session, or solo', () => {
    expect(goalLivePath('/v/_dream_context', SID)).toBe(`/v/_dream_context/tmp/.goal-skill-live.${SID}.json`);
    expect(goalLivePath('/v/_dream_context', null)).toBe('/v/_dream_context/tmp/.goal-skill-live.solo.json');
  });
});

describe('file I/O', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'goal-live-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes atomically (no temp file left behind) and reads back', () => {
    const path = goalLivePath(root, SID);
    writeGoalLiveAtomic(path, { phase: 'plan', goal: 'g' });
    expect(readGoalLive(path)).toEqual({ phase: 'plan', goal: 'g' });
    expect(readdirSync(join(root, 'tmp'))).toEqual([`.goal-skill-live.${SID}.json`]);
  });

  it('reads a malformed or phaseless file as no file', () => {
    const path = goalLivePath(root, null);
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(path, '{not json');
    expect(readGoalLive(path)).toBeNull();
    writeFileSync(path, '{"goal":"x"}');
    expect(readGoalLive(path)).toBeNull();
  });

  it('sweeps live files older than 3h and nothing else', () => {
    const dir = join(root, 'tmp');
    mkdirSync(dir, { recursive: true });
    const now = Date.parse(T0);
    const stale = join(dir, '.goal-skill-live.old.json');
    const fresh = join(dir, '.goal-skill-live.new.json');
    const other = join(dir, '.council-live.json');
    for (const p of [stale, fresh, other]) writeFileSync(p, '{}');
    const old = (now - 4 * 3600 * 1000) / 1000;
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    utimesSync(fresh, now / 1000, now / 1000);
    expect(sweepAbandonedGoalLive(root, now)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});

// ─── The CLI ─────────────────────────────────────────────────────────────────────

describe('argument parsing', () => {
  it('expands an id[=name] list', () => {
    expect(parseActorSpec('T1=Role registry, T2=Tokens,critic')).toEqual([
      { id: 'T1', name: 'Role registry' }, { id: 'T2', name: 'Tokens' }, { id: 'critic' },
    ]);
    expect(() => parseActorSpec('../x')).toThrow(/actor id/);
  });

  it('reads lower-case words as states and upper-case words as verdicts', () => {
    expect(parseStatePairs(['T1=fail', 'critic=FAIL'])).toEqual([
      { type: 'state', id: 'T1', state: 'fail' },
      { type: 'state', id: 'critic', verdict: 'FAIL' },
    ]);
    expect(() => parseStatePairs(['critic=solid'])).toThrow(/not one of/);
    expect(() => parseStatePairs(['critic'])).toThrow(/id=word/);
  });
});

describe('commands', () => {
  let home: string;
  let root: string;
  const deps = (env: NodeJS.ProcessEnv): GoalLiveDeps => ({
    resolveRoot: () => root, env, home, now: () => new Date(T0),
  });
  const read = (id: string | null) => JSON.parse(readFileSync(goalLivePath(root, id), 'utf-8')) as GoalLiveState;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'goal-live-home-'));
    root = mkdtempSync(join(tmpdir(), 'goal-live-root-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('with the session env set: writes .goal-skill-live.<id>.json stamped with session', () => {
    goalLiveStart(deps({ CLAUDE_CODE_SESSION_ID: SID }), 'quest');
    expect(read(SID)).toMatchObject({ goal: 'quest', session: SID, phase: 'plan' });
  });

  it('with the session env unset: writes .goal-skill-live.solo.json with no session key', () => {
    goalLiveStart(deps({}), 'quest');
    const state = read(null);
    expect(state.goal).toBe('quest');
    expect('session' in state).toBe(false);
  });

  it('runs a whole review round and a fork in the skill\'s own syntax', () => {
    const d = deps({ CLAUDE_CODE_SESSION_ID: SID });
    goalLiveStart(d, 'quest');
    goalLivePhase(d, 'review', {});
    goalLiveActor(d, 'critic,pragmatist,edge-cases', { kind: 'fresh', round: '1' });
    goalLiveState(d, ['critic=NEEDS_WORK', 'pragmatist=SOLID', 'edge-cases=SOLID']);
    goalLivePhase(d, 'impl', { wave: '1', waves: '3' });
    goalLiveActor(d, 'T1=Role registry,T2=Tokens', { kind: 'fork', role: 'implementer', from: 'planner' });
    const s = read(SID);
    expect(s.phase).toBe('impl');
    expect(s.judges).toBeUndefined();
    expect(s.impl).toMatchObject({ wave: 1, waves: 3 });
    expect(s.impl!.forks!.map((f) => f.name)).toEqual(['Role registry', 'Tokens']);
    expect(s.lineage!.filter((e) => e.k === 'fresh').map((e) => e.role)).toEqual(['critic', 'pragmatist', 'edge-cases']);
    // No transcript was named, so no number exists.
    expect(s.lineage!.some((e) => 'ctx' in e)).toBe(false);
  });

  it('--context-of measures the inherited session from its own transcript, once, for every fork', () => {
    const planner = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const dir = join(home, '.claude', 'projects', 'scratch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${planner}.jsonl`), [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 10 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 900, cache_read_input_tokens: 180900, output_tokens: 100 } } }),
    ].join('\n') + '\n');
    const d = deps({ CLAUDE_CODE_SESSION_ID: SID });
    goalLiveActor(d, 'T1,T2,T3', { kind: 'fork', role: 'implementer', from: 'planner', contextOf: planner });
    expect(read(SID).lineage!.map((e) => e.ctx)).toEqual([182000, 182000, 182000]);
  });

  it('--context-of on a missing transcript records no number, and a non-fork never measures', () => {
    const d = deps({ CLAUDE_CODE_SESSION_ID: SID });
    goalLiveActor(d, 'T1', { kind: 'fork', role: 'implementer', contextOf: 'no-such-session' });
    goalLiveActor(d, 'planner', { kind: 'resume', contextOf: 'no-such-session' });
    expect(read(SID).lineage!.some((e) => 'ctx' in e)).toBe(false);
  });

  it('requires --role for an id that is not a role, and a valid --kind', () => {
    const d = deps({});
    expect(() => goalLiveActor(d, 'T1', { kind: 'fork' })).toThrow(/--role is required/);
    expect(() => goalLiveActor(d, 'critic', { kind: 'bogus' })).toThrow(/--kind/);
    expect(() => goalLivePhase(d, 'lunch', {})).toThrow(/phase must be/);
  });

  it('clear removes only this session\'s file', () => {
    goalLiveStart(deps({ CLAUDE_CODE_SESSION_ID: SID }), 'a');
    goalLiveStart(deps({}), 'b');
    goalLiveClear(deps({ CLAUDE_CODE_SESSION_ID: SID }));
    expect(existsSync(goalLivePath(root, SID))).toBe(false);
    expect(existsSync(goalLivePath(root, null))).toBe(true);
  });
});

describe('the command line: silent on success, exit 0 always', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const exitBefore = process.exitCode;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'goal-live-cli-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = exitBefore;
    rmSync(root, { recursive: true, force: true });
  });

  function program(resolveRoot: () => string | null): Command {
    const p = new Command();
    p.exitOverride();
    registerGoalLiveCommand(p, { resolveRoot, env: { CLAUDE_CODE_SESSION_ID: SID }, now: () => new Date(T0) });
    return p;
  }

  it('prints nothing and sets no exit code when the write succeeds', async () => {
    const p = program(() => root);
    await p.parseAsync(['goal-live', 'start', '--goal', 'quest'], { from: 'user' });
    await p.parseAsync(['goal-live', 'actor', 'critic,pragmatist', '--kind', 'fresh', '--round', '2'], { from: 'user' });
    await p.parseAsync(['goal-live', 'state', 'critic=SOLID', 'pragmatist=NEEDS_WORK'], { from: 'user' });
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitBefore);
    expect(JSON.parse(readFileSync(goalLivePath(root, SID), 'utf-8')).judges).toHaveLength(2);
  });

  it('on an unwritable path: prints one ✗ line, throws nothing, and exits 0', async () => {
    // A FILE where the vault's tmp/ directory should be makes every write fail.
    writeFileSync(join(root, 'tmp'), 'not a directory');
    const p = program(() => root);
    await expect(p.parseAsync(['goal-live', 'phase', 'review'], { from: 'user' })).resolves.toBeDefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('goal-live:');
    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitBefore);
  });

  it('with no vault in reach: reports it and still exits 0', async () => {
    const p = program(() => null);
    await p.parseAsync(['goal-live', 'clear'], { from: 'user' });
    expect(String(errSpy.mock.calls[0][0])).toContain('no _dream_context/');
    expect(process.exitCode).toBe(exitBefore);
  });
});
