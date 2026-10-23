/**
 * The machine facts the Super Agent reads must be true and must not mislead (field, Tilki
 * 2026-10-21): `claudeSessions` showed 0 while `claude` processes ran (a 60 s memo read before
 * the first chats spawned) and its meaning was unclear; "light mode is on" was shown as a hold
 * the owner must switch off; disk cleanup was offered for a RAM/swap squeeze.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_SESSIONS_MEANS, LIGHT_LOW_BATTERY_PERCENT, LIGHT_LOW_MEMORY_GB, countClaudeSessions, lightModeNote, lightModeNow,
  lightModeState, machineNotes, machineRoom, readCapacityFacts, readCapacityFactsForState, readClaudeSessionsNow,
  resetCapacityForTests, setCapacityFactsForTests, setPowerFactsForTests, type CapacityDeps, type CapacityFacts,
} from '../../src/lib/super/capacity.js';
import { computeLightMode, LOW_BATTERY_PERCENT, LOW_MEMORY_GB } from '../../dashboard/src/lib/lightMode.js';

const GB = 1024 ** 3;
const ROOT = join(__dirname, '..', '..');

describe('claudeSessions counts processes, and says so', () => {
  const base: CapacityDeps = {
    platform: 'darwin', vmStat: async () => 'nope', freeMem: () => 4 * GB,
    statfs: async () => ({ bavail: 0, bsize: 4096 }), loadavg: () => [1], worktreeRoot: '/', now: () => 1,
  };

  it('counts every claude process of every project and the Super itself; a starting child has none', () => {
    // 8 chats still `starting` spawned nothing; the Super and two app chats and a terminal tab did.
    const ps = ['/sbin/launchd', 'claude', 'claude', '/Users/x/.local/bin/claude', 'claude', '/Applications/Claude.app/Contents/Helpers/chrome-native-host', 'node'].join('\n');
    expect(countClaudeSessions(ps)).toBe(4);
    expect(CLAUDE_SESSIONS_MEANS).toMatch(/processes named claude/);
    expect(CLAUDE_SESSIONS_MEANS).toMatch(/every project/);
    expect(CLAUDE_SESSIONS_MEANS).toMatch(/starting, parked or ended has none/);
    expect(CLAUDE_SESSIONS_MEANS).toMatch(/not the number of children/);
  });

  it('the state reading is fresh: a memoized 0 from before the chats spawned does not survive', async () => {
    resetCapacityForTests();
    let procs = '';
    const deps: CapacityDeps = { ...base, psComm: async () => procs };
    expect((await readCapacityFacts(deps)).claudeSessions).toBe(0); // the memo now holds 0 for 60 s
    procs = 'claude\nclaude\n';
    expect((await readCapacityFacts(deps)).claudeSessions).toBe(0); // the stale memo (what the field showed)
    expect(await readClaudeSessionsNow(deps)).toBe(2); // the fresh read the state route uses
    expect((await readCapacityFactsForState(deps)).claudeSessions).toBe(2); // what super state shows
    expect(await readClaudeSessionsNow({ psComm: async () => { throw new Error('ps failed'); } })).toBeNull();
    resetCapacityForTests();
  });

  it('readCapacityFactsForState keeps the override intact (tests never run ps)', async () => {
    const facts: CapacityFacts = { availMemGb: 9, diskFreeGb: 80, load1: 1, totalMemGb: 16, swapUsedGb: 1, swapTotalGb: 4, claudeSessions: 7 };
    setCapacityFactsForTests(facts);
    expect((await readCapacityFactsForState()).claudeSessions).toBe(7);
  });
});

describe('light mode: why it is on, what ends it, and that nothing needs closing', () => {
  const sixteen = { totalMemGb: 16 };
  it('mirrors the app\'s rule on a grid (drift test against dashboard computeLightMode)', () => {
    expect([LIGHT_LOW_MEMORY_GB, LIGHT_LOW_BATTERY_PERCENT]).toEqual([LOW_MEMORY_GB, LOW_BATTERY_PERCENT]);
    for (const setting of ['auto', 'on', 'off'] as const) {
      for (const totalMemGb of [8, 8.5, 8.6, 16]) {
        for (const onBattery of [null, false, true]) {
          for (const batteryPercent of [null, 15, 20, 21]) {
            for (const lowPowerMode of [null, false, true]) {
              const power = { onBattery, batteryPercent, lowPowerMode };
              const server = lightModeState(setting, { totalMemGb }, power);
              const app = computeLightMode(setting, { totalMemGb, ...power });
              expect({ on: server.on, reason: server.reason }).toEqual(app);
            }
          }
        }
      }
    }
  });

  it('Tilki\'s Mac (16 GB, Auto, plugged in or charged) is not in light mode; on battery at 18 % it is, because of the battery', () => {
    expect(lightModeState('auto', sixteen, { onBattery: false, batteryPercent: 90, lowPowerMode: false }).on).toBe(false);
    const l = lightModeState('auto', sixteen, { onBattery: true, batteryPercent: 18, lowPowerMode: false });
    expect(l).toMatchObject({ on: true, reason: 'battery', batteryPercent: 18, setting: 'auto' });
    const note = lightModeNote(l);
    expect(note).toMatch(/Auto turned it on/);
    expect(note).toMatch(/battery at 18 %/);
    expect(note).toMatch(/turns itself off when the Mac is plugged in or charged/);
  });

  it('every reason names its cause and what ends it, holds nothing, and asks the owner for nothing', () => {
    const cases = [
      lightModeState('on', sixteen),
      lightModeState('auto', { totalMemGb: 8 }),
      lightModeState('auto', sixteen, { lowPowerMode: true }),
      lightModeState('auto', sixteen, { onBattery: true, batteryPercent: 12 }),
    ];
    expect(cases.map((c) => c.reason)).toEqual(['setting', 'ram', 'low-power', 'battery']);
    for (const c of cases) {
      const note = lightModeNote(c);
      expect(note).toMatch(/^light mode is on \(/);
      expect(note).toMatch(/holds no job and nothing needs switching off/);
      expect(note).not.toMatch(/\b(please|ask the owner|tell the owner|close|quit|disable|turn it off)\b/i);
    }
    expect(lightModeNote(cases[0])).toMatch(/Settings → Performance is set to On/);
    expect(lightModeNote(cases[1])).toMatch(/16|8 GB RAM/);
    expect(lightModeNote(cases[2])).toMatch(/Low Power Mode/);
  });

  it('lightModeNow reads the power facts only when Auto could still turn light mode on by them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'super-pool-'));
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    let reads = 0;
    const power = async () => { reads += 1; return { onBattery: true, batteryPercent: 10, lowPowerMode: false }; };
    try {
      // The test override is on (isolate-spawn-env): no pmset, the injected test power answers.
      setPowerFactsForTests({ onBattery: true, batteryPercent: 10, lowPowerMode: false });
      expect((await lightModeNow(sixteen, power, home)).reason).toBe('battery');
      writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ lightMode: 'off' }));
      expect((await lightModeNow(sixteen, power, home)).on).toBe(false);
      writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ lightMode: 'on' }));
      expect((await lightModeNow(sixteen, power, home)).reason).toBe('setting');
      expect(reads).toBe(0);
    } finally { setPowerFactsForTests(null); rmSync(home, { recursive: true, force: true }); }
  });
});

describe('a stalled power read cannot stall super state', () => {
  it('Auto answers without power facts after the wait, and a failing read does the same', async () => {
    const home = mkdtempSync(join(tmpdir(), 'super-pool-'));
    setCapacityFactsForTests(null); // production path: the real race, no test override
    try {
      const t0 = Date.now();
      const stalled = await lightModeNow({ totalMemGb: 16 }, () => new Promise(() => {}), home, 40);
      expect(stalled).toMatchObject({ on: false, reason: null, setting: 'auto' });
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect((await lightModeNow({ totalMemGb: 16 }, async () => { throw new Error('pmset'); }, home, 40)).on).toBe(false);
      const quick = await lightModeNow({ totalMemGb: 16 }, async () => ({ onBattery: true, batteryPercent: 9 }), home, 1_000);
      expect(quick.reason).toBe('battery');
    } finally {
      setCapacityFactsForTests({ availMemGb: 12, diskFreeGb: 200, load1: 1, totalMemGb: 32, swapUsedGb: 0, swapTotalGb: 4, claudeSessions: 1, heavySteps: 0 });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('notes never send RAM or swap pressure to disk cleanup', () => {
  const squeezed: CapacityFacts = { availMemGb: 1.5, diskFreeGb: 40, load1: 4, totalMemGb: 16, swapUsedGb: 3.1, swapTotalGb: 4, claudeSessions: 12 };
  it('swap and free-memory lines say disk cleanup frees disk, not memory; the disk line does not say it', () => {
    const notes = machineNotes(machineRoom(squeezed, { platform: 'darwin' }));
    expect(notes.filter((n) => /frees disk, not memory/.test(n))).toHaveLength(2);
    const disk = machineNotes(machineRoom({ ...squeezed, availMemGb: 9, swapUsedGb: 0, diskFreeGb: 6, claudeSessions: 3 }, { platform: 'darwin' }));
    expect(disk).toEqual(['6 GB disk free (line 8 GB)']);
    expect(notes.join(' ')).not.toMatch(/delete|clean up|free up (space|disk)/i);
  });

  it('the orchestration guide states it, and recommends no disk cleanup for a memory squeeze', () => {
    const raw = readFileSync(join(ROOT, 'skill/references/super-orchestration.md'), 'utf-8');
    const guide = raw.replace(/\s+/g, ' ');
    expect(guide).toMatch(/Removing worktrees or files frees disk, never memory or swap/);
    expect(guide).toMatch(/`claudeSessions` counts running `claude` processes/);
    // The guide's own size budget (super-orchestration-guide.test.ts): +500 on 2026-10-22 for §2's
    // "ask the way any agent asks", +150 on 2026-10-23 for a child's pictures (`--for <child>`).
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(14_650);
  });
});
