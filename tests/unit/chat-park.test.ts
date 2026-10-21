/**
 * Idle chats are parked when the machine is under load (src/server/chat-park.ts): the policy
 * (thresholds, never-park list, longest idle first, no pressure = no-op), the sweep (one timer
 * only while a chat lives, setting off = today, one notice per sweep) and the park primitive
 * (idempotent, refuses what must never be parked).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FOCUS_GRACE_MS, HARD_IDLE_MS, SOFT_IDLE_MS,
  _resetChatParkForTests, _sweepArmedForTests, parkChat, parkNoticeText, parkPressure, pickChatsToPark,
  pidsWithShellDescendant, registerParkable, sweepOnce,
  type ParkCandidate, type Parkable, type ParkOutcome, type SweepDeps,
} from '../../src/server/chat-park.js';
import type { CapacityFacts } from '../../src/lib/super/capacity.js';

const NOW = 10_000_000;
const MIN = 60_000;
const quiet: CapacityFacts = { availMemGb: 6, diskFreeGb: 80, load1: 1, totalMemGb: 16, swapUsedGb: 1, swapTotalGb: 4, claudeSessions: 3 };
/** Soft: swap 80 % (15.2 of 19 GB). */
const soft: CapacityFacts = { ...quiet, swapUsedGb: 15.2, swapTotalGb: 19 };
/** Today's planning reading: swap 18.4/19.0 GB, disk 8 GB, 27 claude -> hard. */
const today: CapacityFacts = { availMemGb: 2.5, diskFreeGb: 8, load1: 4, totalMemGb: 16, swapUsedGb: 18.4, swapTotalGb: 19, claudeSessions: 27 };

const cand = (id: string, idleMin: number, over: Partial<ParkCandidate> = {}): ParkCandidate => ({
  id, exempt: null, busy: false, asking: false, backgroundTasks: 0, idleSince: NOW - idleMin * MIN, focusedAt: 0, ...over,
});

describe('parkPressure', () => {
  it('no memory/swap/disk pressure is none, even over the session count or in light mode', () => {
    expect(parkPressure(quiet).level).toBe('none');
    expect(parkPressure({ ...quiet, claudeSessions: 40 }).level).toBe('none');
  });
  it('soft swap -> soft with the shortfall over 75 %; today -> hard', () => {
    const p = parkPressure(soft);
    expect(p.level).toBe('soft');
    expect(p.deficitGb).toBeCloseTo(15.2 - 0.75 * 19, 5);
    expect(parkPressure(today).level).toBe('hard');
    expect(parkPressure({ ...quiet, availMemGb: 1.5 })).toMatchObject({ level: 'soft', limits: ['availMem'] });
    expect(parkPressure({ ...quiet, diskFreeGb: 7 })).toMatchObject({ level: 'hard', limits: ['disk'] });
  });
});

describe('pickChatsToPark', () => {
  const all = [cand('a', 2), cand('b', 12), cand('c', 45), cand('d', 9.9), cand('e', 5)];

  it('no pressure parks nothing', () => {
    expect(pickChatsToPark(all, parkPressure(quiet), NOW)).toEqual([]);
  });

  it('soft pressure parks exactly the chats idle >= 10 min, longest idle first', () => {
    expect(pickChatsToPark(all, { ...parkPressure(soft), deficitGb: 99 }, NOW)).toEqual(['c', 'b']);
  });

  it('hard pressure (today) parks the chats idle >= 3 min, longest idle first', () => {
    expect(pickChatsToPark(all, parkPressure(today), NOW)).toEqual(['c', 'b', 'd', 'e']);
  });

  it('stops at the shortfall: ~0.23 GB per chat, at least one', () => {
    const many = Array.from({ length: 10 }, (_, i) => cand(`x${i}`, 20 + i));
    const small = { level: 'soft' as const, deficitGb: 0.5, limits: ['swap' as const] };
    expect(pickChatsToPark(many, small, NOW)).toEqual(['x9', 'x8', 'x7']);
    expect(pickChatsToPark(many, { ...small, deficitGb: 0 }, NOW)).toEqual(['x9']);
  });

  it('never parks: busy, asking, background work, focused within 2 min, Assistant / super / phone', () => {
    const p = { ...parkPressure(today), deficitGb: 99 };
    const never = [
      cand('busy', 60, { busy: true }),
      cand('asking', 60, { asking: true }),
      cand('bg', 60, { backgroundTasks: 1 }),
      cand('focused', 60, { focusedAt: NOW - FOCUS_GRACE_MS + 1000 }),
      cand('assistant', 60, { exempt: 'assistant' }),
      cand('super', 60, { exempt: 'super' }),
      cand('phone', 60, { exempt: 'phone' }),
    ];
    expect(pickChatsToPark([...never, cand('ok', 60, { focusedAt: NOW - FOCUS_GRACE_MS })], p, NOW)).toEqual(['ok']);
  });

  it('the thresholds are 10 and 3 minutes', () => {
    expect(SOFT_IDLE_MS).toBe(10 * MIN);
    expect(HARD_IDLE_MS).toBe(3 * MIN);
  });
});

describe('pidsWithShellDescendant (a terminal running a background command)', () => {
  const ps = [
    '  100     1 claude',
    '  101   100 node',
    '  102   101 /bin/zsh',
    '  200     1 /Users/x/.local/bin/claude',
    '  201   200 npx',
    '  300     1 claude',
  ].join('\n');
  it('finds a shell anywhere under the tab process', () => {
    expect([...pidsWithShellDescendant(ps, [100, 200, 300])]).toEqual([100]);
  });
});

describe('parkNoticeText', () => {
  it('one line per sweep, in the system language', () => {
    expect(parkNoticeText(3, parkPressure(soft), true).body).toBe('3 sohbet park edildi: bellek baskısı');
    expect(parkNoticeText(1, parkPressure({ ...quiet, diskFreeGb: 10 }), false).body).toBe('1 idle chat parked: low disk');
  });
});

// ── The registry, the primitive and the sweep ──────────────────────────────────────────

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

function deps(facts: CapacityFacts, over: Partial<SweepDeps> = {}): SweepDeps & { notices: number[] } {
  const notices: number[] = [];
  return {
    now: () => NOW, enabled: () => true, readFacts: async () => facts, ps: async () => '',
    activity: () => ({ readable: true, at: 0, subagentAt: 0 }), notice: (n) => { notices.push(n); }, notices, ...over,
  } as SweepDeps & { notices: number[] };
}

describe('the sweep', () => {
  beforeEach(() => _resetChatParkForTests());

  it('arms one timer only while a chat lives', () => {
    expect(_sweepArmedForTests()).toBe(false);
    const un1 = registerParkable({ ...parkable('x', 0), id: 'x' });
    expect(_sweepArmedForTests()).toBe(true);
    _resetChatParkForTests();
    expect(_sweepArmedForTests()).toBe(false);
    const a = registerParkable(cand('a', 0) as unknown as Parkable);
    const b = registerParkable(cand('b', 0) as unknown as Parkable);
    expect(_sweepArmedForTests()).toBe(true);
    a(); expect(_sweepArmedForTests()).toBe(true);
    b(); expect(_sweepArmedForTests()).toBe(false);
    un1();
  });

  it("today's reading parks the idle chats (>= 3 min, hard) and leaves one notice", async () => {
    const a = parkable('a', 45); const b = parkable('b', 12); const c = parkable('c', 2);
    const busy = parkable('busy', 60, { busy: () => true });
    const d = deps(today);
    const r = await sweepOnce(d);
    expect(r.parked).toEqual(['a', 'b']);
    expect(a.parked).toEqual(['machine-hard']);
    expect(c.parked).toEqual([]);
    expect(busy.parked).toEqual([]);
    expect(d.notices).toEqual([2]);
  });

  it('soft pressure parks exactly the idle >= 10 min ones', async () => {
    parkable('a', 45); parkable('b', 12); parkable('c', 9);
    const r = await sweepOnce(deps({ ...soft, swapUsedGb: 16 }));
    expect(r.parked).toEqual(['a', 'b']);
  });

  it('no pressure parks nothing and posts nothing', async () => {
    const a = parkable('a', 45);
    const d = deps(quiet);
    expect((await sweepOnce(d)).parked).toEqual([]);
    expect(a.parked).toEqual([]);
    expect(d.notices).toEqual([]);
  });

  it('setting off restores today: nothing is read or parked', async () => {
    const a = parkable('a', 45);
    const readFacts = vi.fn(async () => today);
    expect((await sweepOnce(deps(today, { enabled: () => false, readFacts }))).parked).toEqual([]);
    expect(readFacts).not.toHaveBeenCalled();
    expect(a.parked).toEqual([]);
  });

  it('a transcript or sub-agent written inside the idle window keeps the chat', async () => {
    const a = parkable('a', 45, { transcriptPath: () => '/t/a.jsonl' });
    const r = await sweepOnce(deps(today, { activity: () => ({ readable: true, at: NOW - MIN, subagentAt: 0 }) }));
    expect(r.parked).toEqual([]);
    expect(a.parked).toEqual([]);
  });

  it('a terminal with a shell under it is never parked', async () => {
    const t = parkable('t', 45, { kind: 'terminal', pid: 100 });
    const u = parkable('u', 30, { kind: 'terminal', pid: 300 });
    const r = await sweepOnce(deps(today, { ps: async () => '101 100 zsh\n301 300 node\n' }));
    expect(r.parked).toEqual(['u']);
    expect(t.parked).toEqual([]);
  });

  it('a terminal whose sub-agent wrote since its last turn started is kept, however long ago', async () => {
    const t = parkable('t', 45, { kind: 'terminal', pid: 100, lastTurnStartedAt: () => NOW - 60 * MIN });
    const u = parkable('u', 45, { kind: 'terminal', pid: 300, lastTurnStartedAt: () => NOW - 60 * MIN });
    const r = await sweepOnce(deps(today, {
      activity: (p) => (p.id === 't'
        ? { readable: true, at: NOW - 50 * MIN, subagentAt: NOW - 50 * MIN }   // a sub-agent of the last turn
        : { readable: true, at: NOW - 70 * MIN, subagentAt: NOW - 70 * MIN }), // an older turn's sub-agent
    }));
    expect(r.parked).toEqual(['u']);
    expect(t.parked).toEqual([]);
  });

  it('a terminal whose transcript cannot be read is kept (unknown is not idle)', async () => {
    const t = parkable('t', 45, { kind: 'terminal', pid: 100 });
    expect((await sweepOnce(deps(today, { activity: () => ({ readable: false, at: 0, subagentAt: 0 }) }))).parked).toEqual([]);
    expect(t.parked).toEqual([]);
  });

  it('a window refusal is not counted and posts no notice', async () => {
    parkable('a', 45, {}, 'focused');
    const d = deps(today);
    expect((await sweepOnce(d)).parked).toEqual([]);
    expect(d.notices).toEqual([]);
  });
});

describe('parkChat (the primitive super end reuses)', () => {
  beforeEach(() => _resetChatParkForTests());

  it('is idempotent: a parked tab answers already', async () => {
    const a = parkable('a', 45);
    expect(await parkChat('a', 'super-end')).toBe('parked');
    expect(await parkChat('a', 'super-end')).toBe('already');
    expect(a.parked).toEqual(['super-end']);
  });

  it('refuses busy, asking, background and exempt chats without asking the window', async () => {
    const b = parkable('b', 45, { busy: () => true });
    parkable('q', 45, { asking: () => true });
    parkable('g', 45, { backgroundTasks: () => 2 });
    parkable('s', 45, { exempt: () => 'super' });
    expect(await parkChat('b', 'x')).toBe('busy');
    expect(await parkChat('q', 'x')).toBe('asking');
    expect(await parkChat('g', 'x')).toBe('background');
    expect(await parkChat('s', 'x')).toBe('exempt');
    expect(b.park).not.toHaveBeenCalled();
  });
});

describe('the done-child backstop (orchestration plan r5 D13)', () => {
  beforeEach(() => _resetChatParkForTests());

  it('a DELEGATED super child idle >= 10 min is parked with no load and the setting off; adopted, younger or busy ones are not; twice is a no-op', async () => {
    const { noteSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
    const { emptySuperState } = await import('../../src/lib/super/types.js');
    resetSuperIndex();
    const child = (adopted: boolean) => ({ sessionId: '', brief: '', adopted, startedAt: 1 });
    noteSuperState('/vault/_dream_context', {
      ...emptySuperState(), session: 'sup', enabled: true,
      children: { kid: { ...child(false), sessionId: 'kid' }, young: { ...child(false), sessionId: 'young' }, busy: { ...child(false), sessionId: 'busy' }, mine: { ...child(true), sessionId: 'mine' } },
    });
    const kid = parkable('kid', 11);
    const young = parkable('young', 9);
    const busy = parkable('busy', 30, { busy: () => true });
    const mine = parkable('mine', 60);
    const stranger = parkable('stranger', 60);
    const r = await sweepOnce(deps(quiet, { enabled: () => false }));
    expect(r.parked).toEqual([]);
    expect(kid.parked).toEqual(['super-done']);
    for (const p of [young, busy, mine, stranger]) expect(p.parked).toEqual([]);
    // Parking twice: the tab is no longer registered, so the primitive answers `already`.
    expect(await parkChat('kid', 'super-done')).toBe('already');
    resetSuperIndex();
  });
});
