/**
 * K3 (sahip-karti-yerinde criterion 1): a child waiting on an owner card keeps its process under
 * the done-child backstop, under soft pressure and for an un-forced park; hard pressure parks it;
 * `super end`, succession and retire (end) end it; `force` parks it. Red on 6fece93a: the park
 * policy knew no owner card (the 11 Nov loss: parked 3-10 min after idle with the card unrun).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  END_PARK_CONTEXT, NO_PRESSURE_CONTEXT,
  _resetChatParkForTests, keepReason, parkChat, pickChatsToPark, registerParkable, sweepOnce,
  type ParkCandidate, type Parkable, type ParkOutcome, type SweepDeps,
} from '../../src/server/chat-park.js';
import type { CapacityFacts } from '../../src/lib/super/capacity.js';

const NOW = 50_000_000;
const MIN = 60_000;
const quiet: CapacityFacts = { availMemGb: 6, diskFreeGb: 80, load1: 1, totalMemGb: 16, swapUsedGb: 1, swapTotalGb: 4, claudeSessions: 3 };
const soft: CapacityFacts = { ...quiet, swapUsedGb: 15.2, swapTotalGb: 19 };
/** 11 Nov: swap 97 %. */
const hard: CapacityFacts = { ...quiet, swapUsedGb: 18.4, swapTotalGb: 19 };

const cand = (id: string, idleMin: number, over: Partial<ParkCandidate> = {}): ParkCandidate => ({
  id, exempt: null, busy: false, asking: false, ownerWait: false, backgroundTasks: 0, idleSince: NOW - idleMin * MIN, focusedAt: 0, ...over,
});

describe('keepReason with an open owner card', () => {
  const waiting = cand('w', 60, { ownerWait: true });
  it.each([
    ['no pressure (the done-child backstop)', NO_PRESSURE_CONTEXT, 'owner'],
    ['soft pressure', { pressure: 'soft' } as const, 'owner'],
    ['hard pressure', { pressure: 'hard' } as const, null],
    ['super end / succession / retire', END_PARK_CONTEXT, null],
    ['end under soft pressure', { pressure: 'soft', end: true } as const, null],
  ])('%s -> %s', (_name, ctx, want) => {
    expect(keepReason(waiting, 0, NOW, undefined, ctx)).toBe(want);
  });
  it('the default context is no pressure (an un-forced caller keeps it)', () => {
    expect(keepReason(waiting, 0, NOW)).toBe('owner');
  });
  it('busy, asking and background still come first; a child with no card is unchanged', () => {
    expect(keepReason({ ...waiting, busy: true }, 0, NOW, undefined, END_PARK_CONTEXT)).toBe('busy');
    expect(keepReason(cand('n', 60), 0, NOW)).toBeNull();
  });
});

describe('pickChatsToPark', () => {
  it('soft pressure never picks a waiting child; hard pressure does', () => {
    const all = [cand('w', 60, { ownerWait: true }), cand('n', 30)];
    expect(pickChatsToPark(all, { level: 'soft', deficitGb: 99, limits: ['swap'] }, NOW)).toEqual(['n']);
    expect(pickChatsToPark(all, { level: 'hard', deficitGb: 99, limits: ['swap'] }, NOW)).toEqual(['w', 'n']);
  });
});

function parkable(id: string, idleMin: number, over: Partial<Parkable> = {}, outcome: ParkOutcome = 'parked'): Parkable & { parked: string[] } {
  const parked: string[] = [];
  const p: Parkable & { parked: string[] } = {
    id, kind: 'chat', projectRoot: '/p', parked,
    exempt: () => null, busy: () => false, asking: () => false, backgroundTasks: () => 0,
    idleSince: () => NOW - idleMin * MIN, focusedAt: () => 0,
    park: vi.fn(async (reason: string) => { parked.push(reason); unregister(); return outcome; }),
    ...over,
  };
  const unregister = registerParkable(p);
  return p;
}

function deps(facts: CapacityFacts, over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    now: () => NOW, enabled: () => true, readFacts: async () => facts, ps: async () => '',
    activity: () => ({ readable: true, at: 0, subagentAt: 0 }), notice: () => {}, ...over,
  };
}

describe('parkChat (the primitive) with an open owner card', () => {
  beforeEach(() => _resetChatParkForTests());

  it('an un-forced park with no end keeps it', async () => {
    const p = parkable('w', 60, { ownerWait: () => true });
    expect(await parkChat('w', 'x')).toBe('owner');
    expect(p.park).not.toHaveBeenCalled();
  });
  it('`super end` (opts.end, as super.ts passes it) ends it', async () => {
    const p = parkable('w', 60, { ownerWait: () => true });
    expect(await parkChat('w', 'super-end', { end: true })).toBe('parked');
    expect(p.parked).toEqual(['super-end']);
  });
  it('succession and retire (END_PARK_CONTEXT) end it', async () => {
    const p = parkable('w', 60, { ownerWait: () => true });
    expect(await parkChat('w', 'super-retire', {}, END_PARK_CONTEXT)).toBe('parked');
    expect(p.parked).toEqual(['super-retire']);
  });
  it('hard pressure parks it', async () => {
    parkable('w', 60, { ownerWait: () => true });
    expect(await parkChat('w', 'machine-hard', {}, { pressure: 'hard' })).toBe('parked');
  });
  it('force parks it', async () => {
    parkable('w', 60, { ownerWait: () => true });
    expect(await parkChat('w', 'owner', { force: true })).toBe('parked');
  });
});

describe('the sweep with an open owner card', () => {
  beforeEach(() => _resetChatParkForTests());

  it('the done-child backstop keeps a delegated child that waits on the owner, and parks one that does not', async () => {
    const { noteSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
    const { emptySuperState } = await import('../../src/lib/super/types.js');
    resetSuperIndex();
    const child = (sessionId: string) => ({ sessionId, brief: '', adopted: false, startedAt: 1 });
    noteSuperState('/vault/_dream_context', { ...emptySuperState(), session: 'sup', enabled: true, children: { wkid: child('wkid'), dkid: child('dkid') } });
    const waiting = parkable('wkid', 30, { ownerWait: () => true });
    const done = parkable('dkid', 30);
    await sweepOnce(deps(quiet, { enabled: () => false }));
    expect(waiting.parked).toEqual([]);
    expect(done.parked).toEqual(['super-done']);
    resetSuperIndex();
  });
  it('soft pressure keeps it', async () => {
    const w = parkable('w', 60, { ownerWait: () => true });
    expect((await sweepOnce(deps(soft))).parked).toEqual([]);
    expect(w.parked).toEqual([]);
  });
  it('hard pressure parks it after 3 minutes idle (D1)', async () => {
    const w = parkable('w', 4, { ownerWait: () => true });
    expect((await sweepOnce(deps(hard))).parked).toEqual(['w']);
    expect(w.parked).toEqual(['machine-hard']);
  });
});
