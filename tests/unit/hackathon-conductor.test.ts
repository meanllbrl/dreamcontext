/**
 * Hackathon criteria 3 and 6 (conductor half): Başlat is bound to the design the card showed; a
 * restart with an edited `.conductor/design.json` stops the run before any team turn; the weekly
 * share ceiling stops new rounds (the running one finishes); the 5-hour guard pauses new turns
 * until the reading drops or the owner says Devam; stop kills the running turns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { conduct, conductorLockPath, conductorStatus, designCopyPath, earliestEnd, ownerStart, stopRun, takeConductorLock, releaseConductorLock, type ConductorDeps, type TurnHandle, type TurnRequest } from '../../src/lib/hackathon/conductor.js';
import { roundsPhase } from '../../src/lib/hackathon/phases.js';
import { createRun, designHash, newRunId, readRun, updateRun, type RunRecord, type UsageReading } from '../../src/lib/hackathon/run-store.js';
import { validateDesign, type Design } from '../../src/lib/hackathon/designer.js';

let root: string;
let ctx: string;
let ws: string;
let design: Design;
const RESET = Date.parse('2026-11-20T00:00:00Z');
const reading = (weekly: number, session: number): UsageReading => ({ weeklyPercent: weekly, weeklyResetsAt: RESET, sessionPercent: session, sessionResetsAt: RESET, at: 0 });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hk-cond-'));
  ctx = join(root, '_dream_context');
  mkdirSync(ctx);
  ws = join(root, 'ws');
  design = validateDesign({
    kind: 'plan', problem: 'Ana sayfanın daha iyi hali', target: root,
    teams: [{ id: 'alfa', name: 'Alfa', tool: 'claude' }, { id: 'beta', name: 'Beta', tool: 'claude' }],
    rounds: 3, roundMinutes: 20, limit: { endsAt: '2026-11-18T18:00:00Z' },
  }, { codexUsable: false }, new Date('2026-11-18T10:00:00Z')).design;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(): RunRecord {
  const id = newRunId(ctx, design.problem, new Date('2026-11-18T10:00:00Z'));
  const r: RunRecord = { version: 1, id, problem: design.problem, state: 'awaiting-owner', createdAt: '2026-11-18T10:00:00Z', design };
  createRun(ctx, r);
  return r;
}

function start(r: RunRecord, usage: UsageReading | null = reading(10, 20)) {
  return ownerStart(ctx, r.id, designHash(r), { wsHome: ws, baseSha: () => 'a'.repeat(40), usage: () => usage, now: () => new Date('2026-11-18T10:05:00Z') });
}

interface Harness { deps: ConductorDeps; turns: TurnRequest[]; sleeps: number; }

function harness(o: { usage?: () => UsageReading | null; onSleep?: (n: number, clock: number) => void; turn?: (req: TurnRequest) => TurnHandle; onAbort?: (k: () => void) => void } = {}): Harness {
  const h: Harness = { turns: [], sleeps: 0, deps: undefined as unknown as ConductorDeps };
  let clock = Date.parse('2026-11-18T10:05:00Z');
  h.deps = {
    contextRoot: ctx, brainRoot: root, linkedRepos: [], wsHome: ws,
    now: () => clock,
    sleep: async (ms) => { h.sleeps++; clock += ms; o.onSleep?.(h.sleeps, clock); },
    startTurn: (req) => {
      h.turns.push(req);
      return o.turn ? o.turn(req) : { done: Promise.resolve(0), kill() {} };
    },
    readUsage: o.usage ?? (() => reading(10, 20)),
    prepare: () => ({}),
    snapshot: () => {},
    onAbort: o.onAbort,
  };
  return h;
}

const phases = () => [roundsPhase({ modelCall: async () => '{"score":0.1}' })];

describe('Başlat bound to the design', () => {
  it('a card drawn before an edit cannot start the edited design', () => {
    const r = seed();
    const shown = designHash(r);
    updateRun(ctx, r.id, (x) => ({ ...x, design: { ...x.design, rounds: 5 } }));
    const out = ownerStart(ctx, r.id, shown, { wsHome: ws, baseSha: () => 'a'.repeat(40), usage: () => null });
    expect(out).toMatchObject({ ok: false, status: 409, reason: 'tasarım değişti' });
    expect(readRun(ctx, r.id)?.state).toBe('awaiting-owner');
  });

  it('a card started long after its drafting gets an end time counted from Başlat', () => {
    const r = seed();
    const at = new Date('2026-11-19T09:00:00Z');
    const out = ownerStart(ctx, r.id, designHash(r), { wsHome: ws, baseSha: () => 'a'.repeat(40), usage: () => null, now: () => at });
    expect(out.ok).toBe(true);
    const got = readRun(ctx, r.id)!;
    expect(Date.parse(got.design.limit.endsAt)).toBe(earliestEnd(design, at).getTime());
    expect(Date.parse(got.design.limit.endsAt)).toBeGreaterThan(at.getTime() + design.rounds * design.roundMinutes * 60_000);
    expect((got.moments ?? []).map((m) => m.text).join('\n')).toContain('bitiş başlangıca göre');
    // The conductor's copy carries the same end, so its hash check still holds.
    expect(JSON.parse(readFileSync(designCopyPath(r.id, ws), 'utf-8')).design.limit.endsAt).toBe(got.design.limit.endsAt);
  });

  it('starts with the base SHA in the design and a conductor copy of it', () => {
    const r = seed();
    const out = start(r);
    expect(out.ok).toBe(true);
    const copy = JSON.parse(readFileSync(designCopyPath(r.id, ws), 'utf-8'));
    expect(copy.design.baseSha).toBe('a'.repeat(40));
    expect(readRun(ctx, r.id)?.startedHash).toBe(copy.hash);
  });
});

describe('conductor', () => {
  it('stops before any team turn when the design copy was edited after Başlat', async () => {
    const r = seed();
    start(r);
    const p = designCopyPath(r.id, ws);
    const copy = JSON.parse(readFileSync(p, 'utf-8'));
    copy.design.rounds = 9;
    writeFileSync(p, JSON.stringify(copy));
    const h = harness();
    const final = await conduct(r.id, h.deps, phases());
    expect(final.state).toBe('stopped');
    expect(final.stopReason).toContain('değişti');
    expect(h.turns).toHaveLength(0);
  });

  it('runs every round with one turn per team when nothing holds it', async () => {
    const r = seed();
    start(r);
    const h = harness();
    await conduct(r.id, h.deps, phases());
    expect(h.turns.map((t) => `${t.round}:${t.team.id}`)).toEqual(['1:alfa', '1:beta', '2:alfa', '2:beta', '3:alfa', '3:beta']);
  });

  it('the weekly share ceiling stops new rounds; the running round finishes', async () => {
    const r = seed();
    start(r, reading(10, 20));
    let full = false;
    const h = harness({
      usage: () => (full ? reading(10 + design.limit.weeklyShareCeiling, 20) : reading(10, 20)),
      // The share fills while round 1 runs.
      turn: () => { full = true; return { done: Promise.resolve(0), kill() {} }; },
    });
    const final = await conduct(r.id, h.deps, phases());
    expect(h.turns.map((t) => t.round)).toEqual([1, 1]);
    expect((final.moments ?? []).map((m) => m.text).join('\n')).toContain('yeni tur yok');
  });

  it('the 5-hour guard pauses new turns until the reading drops', async () => {
    const r = seed();
    start(r, reading(10, 20));
    let high = true;
    const h = harness({ usage: () => reading(10, high ? 85 : 30), onSleep: (n) => { if (n >= 2) high = false; } });
    const final = await conduct(r.id, h.deps, phases());
    expect(h.sleeps).toBeGreaterThanOrEqual(2);
    const texts = (final.moments ?? []).map((m) => m.text).join('\n');
    expect(texts).toContain('5 saatlik pencere');
    expect(final.paused ?? null).toBeNull();
    expect(h.turns.length).toBe(6);
  });

  it('Devam (guard override) lets turns run while the window is high', async () => {
    const r = seed();
    start(r, reading(10, 20));
    updateRun(ctx, r.id, (x) => ({ ...x, guardOverride: true }));
    const h = harness({ usage: () => reading(10, 95) });
    await conduct(r.id, h.deps, phases());
    expect(h.turns.length).toBe(6);
  });

  it('stop kills the running turns and no further round starts', async () => {
    const r = seed();
    start(r);
    const killed: string[] = [];
    const h = harness({
      turn: (req) => {
        let end!: (c: number | null) => void;
        const done = new Promise<number | null>((res) => { end = res; });
        return { done, kill() { killed.push(req.team.id); end(null); } };
      },
      onSleep: (n) => { if (n === 1) stopRun(ctx, r.id, 'sahip durdurdu'); },
    });
    const final = await conduct(r.id, h.deps, phases());
    expect(final.state).toBe('stopped');
    expect(killed.sort()).toEqual(['alfa', 'beta']);
    expect(h.turns.every((t) => t.round === 1)).toBe(true);
  });
});

describe('conductor lifecycle', () => {
  it('a round\'s clock starts when its turns start, after a long session-guard wait', async () => {
    const r = seed();
    start(r);
    const t0 = Date.parse('2026-11-18T10:05:00Z');
    let clock = t0;
    // The 5-hour window holds new turns for 40 minutes (longer than a round plus its overrun);
    // each turn then ends after a few ticks of work.
    let releases: (() => void)[] = [];
    let ticks = 0;
    const h = harness({
      usage: () => reading(10, clock < t0 + 40 * 60_000 ? 85 : 30),
      onSleep: (_n, c) => { clock = c; if (releases.length && ++ticks > 3) { for (const f of releases) f(); releases = []; ticks = 0; } },
      turn: () => ({ done: new Promise<number | null>((res) => { releases.push(() => res(0)); }), kill() {} }),
    });
    const final = await conduct(r.id, h.deps, [roundsPhase({ modelCall: async () => '{"score":0.1}' })]);
    const texts = (final.moments ?? []).map((m) => m.text).join('\n');
    expect(texts).toContain('5 saatlik pencere');
    expect(texts).not.toContain('süre doldu');
  });

  it('the abort hook kills every live team turn', async () => {
    const r = seed();
    start(r);
    let killAll: (() => void) | null = null;
    let killed = 0;
    let atFirstTick = -1;
    const h = harness({
      onAbort: (k) => { killAll = k; },
      // Without the hook only the round's overrun (25 minutes of ticks later) would kill them.
      onSleep: (n) => { killAll?.(); if (n === 1) atFirstTick = killed; },
      turn: () => {
        let res!: (c: number | null) => void;
        const done = new Promise<number | null>((r2) => { res = r2; });
        return { done, kill() { killed++; res(null); } };
      },
    });
    await conduct(r.id, h.deps, [roundsPhase({ modelCall: async () => '{"score":0.1}' })]);
    expect(atFirstTick).toBe(2);
  });

  it('a dead holder\'s lock is reclaimed at once; a live one is not', () => {
    const r = seed();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    mkdirSync(join(conductorLockPath(r.id, ws), '..'), { recursive: true });
    writeFileSync(conductorLockPath(r.id, ws), JSON.stringify({ pid: dead, at: Date.now() }));
    expect(takeConductorLock(r.id, ws)).toBe(true);
    // Now this process holds it: a second take is refused.
    expect(takeConductorLock(r.id, ws)).toBe(false);
    releaseConductorLock(r.id, ws);
  });

  it('a running run with no live conductor reads as gone (Sürdür), after the launch grace', () => {
    const r = seed();
    start(r);
    const run = updateRun(ctx, r.id, (x) => ({ ...x, launchedAt: '2026-11-18T10:05:00Z' }));
    expect(conductorStatus(ctx, run, { wsHome: ws, now: Date.parse('2026-11-18T10:05:10Z') })).toBe('starting');
    expect(conductorStatus(ctx, run, { wsHome: ws, now: Date.parse('2026-11-18T10:10:00Z') })).toBe('gone');
    expect(takeConductorLock(r.id, ws)).toBe(true);
    expect(conductorStatus(ctx, run, { wsHome: ws, now: Date.parse('2026-11-18T10:10:00Z') })).toBe('alive');
    releaseConductorLock(r.id, ws);
    expect(conductorStatus(ctx, stopRun(ctx, r.id, 'x'), { wsHome: ws })).toBeNull();
  });
});
