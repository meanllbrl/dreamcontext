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
import { conduct, designCopyPath, ownerStart, stopRun, type ConductorDeps, type TurnHandle, type TurnRequest } from '../../src/lib/hackathon/conductor.js';
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

function harness(o: { usage?: () => UsageReading | null; onSleep?: (n: number) => void; turn?: (req: TurnRequest) => TurnHandle } = {}): Harness {
  const h: Harness = { turns: [], sleeps: 0, deps: undefined as unknown as ConductorDeps };
  let clock = Date.parse('2026-11-18T10:05:00Z');
  h.deps = {
    contextRoot: ctx, brainRoot: root, linkedRepos: [], wsHome: ws,
    now: () => clock,
    sleep: async (ms) => { h.sleeps++; clock += ms; o.onSleep?.(h.sleeps); },
    startTurn: (req) => {
      h.turns.push(req);
      return o.turn ? o.turn(req) : { done: Promise.resolve(0), kill() {} };
    },
    readUsage: o.usage ?? (() => reading(10, 20)),
    prepare: () => ({}),
    snapshot: () => {},
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
