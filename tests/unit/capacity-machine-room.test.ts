/**
 * The machine signal (orchestration plan r5 D11, built by the parking task): swap, RAM and
 * the machine-wide `claude` count, and `machineRoom()` — one pure function for the idle-chat
 * park sweep and the information notes of `super state` (it never holds a delegate).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  countClaudeSessions, machineNotes, machineRoom, parseProcMeminfoSwap, parseSwapUsage, readCapacityFacts, resetCapacityForTests,
  type CapacityDeps, type CapacityFacts,
} from '../../src/lib/super/capacity.js';

const GB = 1024 ** 3;

describe('machine facts parsers', () => {
  it('reads sysctl vm.swapusage', () => {
    const r = parseSwapUsage('vm.swapusage: total = 20480.00M  used = 19316.50M  free = 1163.50M  (encrypted)');
    expect(r!.totalGb).toBe(20);
    expect(r!.usedGb).toBeCloseTo(18.86, 2);
    expect(parseSwapUsage('nonsense')).toBeNull();
  });

  it('reads /proc/meminfo swap', () => {
    const r = parseProcMeminfoSwap('MemTotal: 1 kB\nSwapTotal:       2097152 kB\nSwapFree:         524288 kB\n');
    expect(r).toEqual({ totalGb: 2, usedGb: 1.5 });
    expect(parseProcMeminfoSwap('MemTotal: 1 kB')).toBeNull();
  });

  it('counts claude by command basename only (never Claude.app helpers)', () => {
    const ps = ['claude', '/Users/x/.local/bin/claude', '/Applications/Claude.app/Contents/MacOS/Claude', 'Claude Helper (Renderer)', 'node', 'claude-code-helper', ''].join('\n');
    expect(countClaudeSessions(ps)).toBe(2);
  });

  it('measure() fills the new facts from injected readers, null when a reader is missing or fails', async () => {
    resetCapacityForTests();
    const base: CapacityDeps = {
      platform: 'darwin', vmStat: async () => 'nope', freeMem: () => 4 * GB,
      statfs: async () => ({ bavail: 0, bsize: 4096 }), loadavg: () => [1], worktreeRoot: '/', now: () => 1,
    };
    const f = await readCapacityFacts({
      ...base, totalMem: () => 16 * GB,
      swapUsage: async () => 'total = 19456.00M  used = 18841.60M  free = 614.40M',
      psComm: async () => 'claude\nclaude\nzsh\n',
    });
    expect(f.totalMemGb).toBe(16);
    expect(f.swapTotalGb).toBe(19);
    expect(f.swapUsedGb).toBe(18.4);
    expect(f.claudeSessions).toBe(2);
    resetCapacityForTests();
    const g = await readCapacityFacts({ ...base, swapUsage: async () => { throw new Error('no sysctl'); } });
    expect(g.swapUsedGb).toBeNull();
    expect(g.claudeSessions).toBeNull();
  });
});

describe('machineRoom', () => {
  beforeEach(() => resetCapacityForTests());
  const ok: CapacityFacts = { availMemGb: 6, diskFreeGb: 80, load1: 1, totalMemGb: 16, swapUsedGb: 1, swapTotalGb: 4, claudeSessions: 3 };

  it('a quiet machine has room', () => {
    expect(machineRoom(ok, { platform: 'darwin' })).toEqual({ ok: true, hard: false, reasons: [] });
  });

  it("both of today's measurements are held AND hard", () => {
    // The owner's reading and the sysctl/df reading taken while planning (2026-10-20).
    const owner: CapacityFacts = { availMemGb: 1.9, diskFreeGb: 6.7, load1: 4, totalMemGb: 16, swapUsedGb: 18.5, swapTotalGb: 21.5, claudeSessions: 25 };
    const planning: CapacityFacts = { availMemGb: 2.5, diskFreeGb: 8, load1: 4, totalMemGb: 16, swapUsedGb: 18.4, swapTotalGb: 19, claudeSessions: 27 };
    for (const f of [owner, planning]) {
      const r = machineRoom(f, { platform: 'darwin' });
      expect(r.ok).toBe(false);
      expect(r.hard).toBe(true);
    }
    const limits = machineRoom(owner, { platform: 'darwin' }).reasons.map((r) => r.limit);
    expect(limits).toEqual(expect.arrayContaining(['sessions', 'swap', 'disk', 'availMem']));
  });

  it('soft limits: sessions >= RAM/1.6, swap >= 75 %, disk < 15 GB, availMem < 2 GB, light mode', () => {
    expect(machineRoom({ ...ok, claudeSessions: 10 }).reasons.map((r) => r.limit)).toEqual(['sessions']);
    expect(machineRoom({ ...ok, claudeSessions: 9 }).ok).toBe(true);
    const swap = machineRoom({ ...ok, swapUsedGb: 3, swapTotalGb: 4 });
    expect(swap.ok).toBe(false);
    expect(swap.hard).toBe(false);
    expect(machineRoom({ ...ok, diskFreeGb: 14.9 }).reasons[0]).toMatchObject({ limit: 'disk', hard: false });
    expect(machineRoom({ ...ok, availMemGb: 1.9 }).reasons[0]).toMatchObject({ limit: 'availMem', hard: false });
    expect(machineRoom(ok, { lightMode: true }).reasons[0].limit).toBe('light');
  });

  it('hard limits: swap >= 90 % or disk < 8 GB', () => {
    expect(machineRoom({ ...ok, swapUsedGb: 3.6, swapTotalGb: 4 }).hard).toBe(true);
    expect(machineRoom({ ...ok, diskFreeGb: 7.9 }).hard).toBe(true);
    expect(machineRoom({ ...ok, diskFreeGb: 8 }).hard).toBe(false);
  });

  it('a null fact never blocks alone; an unreadable swap on macOS is reported, not blocking', () => {
    const blind: CapacityFacts = { availMemGb: 6, diskFreeGb: null, load1: 1, swapUsedGb: null, swapTotalGb: null, claudeSessions: null };
    const mac = machineRoom(blind, { platform: 'darwin' });
    expect(mac.ok).toBe(true);
    expect(mac.reasons.map((r) => r.limit)).toEqual(['swapUnknown']);
    expect(machineRoom(blind, { platform: 'linux' }).reasons).toEqual([]);
  });
});

describe('machineNotes (information for super state, never a hold)', () => {
  const ok: CapacityFacts = { availMemGb: 6, diskFreeGb: 80, load1: 1, totalMemGb: 16, swapUsedGb: 1, swapTotalGb: 4, claudeSessions: 3 };
  it('a quiet machine has no notes', () => {
    expect(machineNotes(machineRoom(ok, { platform: 'darwin' }))).toEqual([]);
  });
  it('one short fact per line crossed, soft and hard alike; an unreadable swap adds none', () => {
    expect(machineNotes(machineRoom({ ...ok, claudeSessions: 12, swapUsedGb: 3.8, diskFreeGb: 12, availMemGb: 1.5 }, { lightMode: true }))).toEqual([
      '12 Claude sessions are open on this machine (about 10 fit its RAM)',
      'swap is 95 % full (line 90 %)',
      '12 GB disk free (line 15 GB)',
      '1.5 GB memory free (line 2 GB)',
      'light mode is on',
    ]);
    expect(machineNotes(machineRoom({ ...ok, swapUsedGb: null, swapTotalGb: null }, { platform: 'darwin' }))).toEqual([]);
  });
});
