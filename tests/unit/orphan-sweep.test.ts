import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOrphanSweeper,
  startOrphanSweep,
  orphanLedgerPath,
  ORPHAN_SWEEP_INTERVAL_MS,
  type OrphanSweepDeps,
} from '../../src/server/orphan-sweep.js';
import { createRunPs, PsError, type RunPs } from '../../src/lib/orphan-processes.js';

// Drives createOrphanSweeper with a fake clock, kill, ps and home. Never signals a real
// process and never touches the real HOME.

const UID = 501;
const SELF = 56232;
const DEAD_SERVER = 77418;
const MIN = 60_000;
const INTERVAL = ORPHAN_SWEEP_INTERVAL_MS;

const id = (n: number, kind = 'a'): string => `${kind.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEAD_TAB = id(1);
const SESSION = id(2, 'b');

interface Fx {
  uid?: number;
  pid: number;
  ppid: number;
  pgid: number;
  lstart?: string;
  args: string;
  env?: string;
}

const pad = (n: number): string => String(n).padStart(5);
const tableLine = (r: Fx): string =>
  `${pad(r.uid ?? UID)} ${pad(r.pid)} ${pad(r.ppid)} ${pad(r.pgid)} ${r.lstart ?? 'Sat Oct  3 15:35:39 2026'}     ${r.args}`;
const envLine = (r: Fx): string => `${pad(r.pid)} ${r.args}${r.env ? ` ${r.env}` : ''}`;
const marked = (tab: string, extra = ''): string =>
  `PATH=/usr/bin DREAMCONTEXT_SERVER_PID=${DEAD_SERVER} DREAMCONTEXT_TAB_SESSION=${tab} CLAUDE_CODE_SESSION_ID=${SESSION}${extra ? ` ${extra}` : ''} HOME=/Users/dev`;

const BASE: Fx[] = [
  { uid: 0, pid: 1, ppid: 0, pgid: 1, args: '/sbin/launchd' },
  { pid: SELF, ppid: 56219, pgid: SELF, args: 'node /Users/dev/.nvm/bin/dreamcontext dashboard --launcher', env: 'PATH=/usr/bin' },
];

/** A leftover `next dev` tree of a tab whose claude is gone. */
const leftover = (pgid = 5000, tab = DEAD_TAB): Fx[] => [
  { pid: pgid + 1, ppid: 1, pgid, args: 'node /Users/dev/projects/acme-shop/node_modules/.bin/next dev -p 3000', env: marked(tab) },
  { pid: pgid + 2, ppid: pgid + 1, pgid, args: 'next-server (v16.1.1) ' },
];

/** A mutable fake world: `world.rows` is read on every call; `world.fail` aborts the next calls. */
function fakeWorld(rows: Fx[]) {
  const world = {
    rows,
    fail: null as null | 'table' | 'env',
    calls: 0,
    gate: null as null | Promise<void>,
  };
  const run: RunPs = async (args) => {
    world.calls++;
    if (world.gate && args[0] === '-axww') await world.gate;
    if (args[0] === '-axww') {
      if (world.fail === 'table') throw new PsError('timeout');
      return world.rows.map(tableLine).join('\n') + '\n';
    }
    if (world.fail === 'env') throw new PsError('enobufs');
    const wanted = new Set(args[args.length - 1].split(',').map(Number));
    return world.rows.filter((r) => wanted.has(r.pid)).map(envLine).join('\n') + '\n';
  };
  return { world, run };
}

let home: string;
let t: number;
let kills: { pid: number; sig: string; ledgerLines: number }[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-orphan-sweep-'));
  t = 0;
  kills = [];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ledger = (): Record<string, unknown>[] => {
  const path = orphanLedgerPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};

function sweeper(run: RunPs, extra: OrphanSweepDeps = {}) {
  return createOrphanSweeper({
    home,
    now: () => t,
    runPs: run,
    isPidAlive: () => false,
    selfPid: SELF,
    selfEnv: {},
    uid: UID,
    intervalMs: INTERVAL,
    kill: (pid, sig) => { kills.push({ pid, sig, ledgerLines: ledger().length }); },
    ...extra,
  });
}

/** Tick at each minute mark in `marks`. */
async function tickAt(sw: { tick(): Promise<void> }, ...marks: number[]): Promise<void> {
  for (const m of marks) {
    t = m * MIN;
    await sw.tick();
  }
}

const range = (from: number, to: number, step = 5): number[] => {
  const out: number[] = [];
  for (let m = from; m <= to; m += step) out.push(m);
  return out;
};

describe('grace and two-phase escalation', () => {
  it('nothing before 30 min of observed time; SIGTERM at 30 with the ledger line written first', async () => {
    const { run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 25));
    expect(kills).toEqual([]);
    await tickAt(sw, 30);
    expect(kills).toEqual([{ pid: -5000, sig: 'SIGTERM', ledgerLines: 1 }]);
    expect(ledger()[0]).toMatchObject({ signal: 'SIGTERM', pgid: 5000, tabId: DEAD_TAB, sessionId: SESSION, memberCount: 2 });
  });

  it('SIGKILL on the next tick if still a candidate, then nothing for 1 h', async () => {
    const { run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 35));
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(kills[1].ledgerLines).toBe(2);
    await tickAt(sw, ...range(40, 90));
    expect(kills).toHaveLength(2);
    await tickAt(sw, 95);
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM']);
  });

  it('no SIGKILL when the group is gone after SIGTERM', async () => {
    const { world, run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 30));
    world.rows = [...BASE];
    await tickAt(sw, ...range(35, 60));
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);
  });

  it('EPERM on SIGTERM still records the attempt — no re-signal loop', async () => {
    const { run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run, {
      kill: (pid, sig) => {
        kills.push({ pid, sig, ledgerLines: ledger().length });
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
    });
    await tickAt(sw, ...range(0, 50));
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(ledger().map((l) => l.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('a ledger append failure → no signal', async () => {
    const { run } = fakeWorld([...BASE, ...leftover()]);
    const blocked = join(home, 'not-a-dir');
    writeFileSync(blocked, 'x');
    const sw = sweeper(run, { home: blocked });
    await tickAt(sw, ...range(0, 60));
    expect(kills).toEqual([]);
  });

  it('pgid 0/1 groups and a live leader are never signalled', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 6001, ppid: 1, pgid: 0, args: 'node a.js', env: marked(id(10)) },
      { pid: 6002, ppid: 1, pgid: 1, args: 'node b.js', env: marked(id(11)) },
      { pid: 6100, ppid: 1, pgid: 6100, args: 'node leader.js', env: marked(id(12)) },
      { pid: 6101, ppid: 6100, pgid: 6100, args: 'node child.js', env: marked(id(12)) },
    ];
    const { run } = fakeWorld(rows);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 90));
    expect(kills).toEqual([]);
  });

  it('a member line with two different DREAMCONTEXT_TAB_SESSION values keeps the group', async () => {
    const rows: Fx[] = [
      ...BASE,
      { pid: 5001, ppid: 1, pgid: 5000, args: 'node a.js', env: marked(DEAD_TAB, `NOTE=x DREAMCONTEXT_TAB_SESSION=${id(20)}`) },
    ];
    const { run } = fakeWorld(rows);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 60));
    expect(kills).toEqual([]);
  });

  it('a SERVER_PID naming another live process pauses grace without resetting it', async () => {
    const other = 5555;
    const owned = (server: number): Fx[] => [
      ...BASE,
      { pid: other, ppid: 1, pgid: other, args: '/usr/sbin/cfprefsd agent' },
      { pid: 5001, ppid: 1, pgid: 5000, args: 'node a.js', env: `PATH=/usr/bin DREAMCONTEXT_SERVER_PID=${server} DREAMCONTEXT_TAB_SESSION=${DEAD_TAB}` },
    ];
    const { world, run } = fakeWorld(owned(DEAD_SERVER));
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 20)); // observed 20
    world.rows = owned(other);
    await tickAt(sw, ...range(25, 60)); // paused: observed stays 20
    expect(kills).toEqual([]);
    world.rows = owned(DEAD_SERVER);
    await tickAt(sw, 65); // +5 (the paused ticks were successes) → 25
    expect(kills).toEqual([]);
    await tickAt(sw, 70); // 30
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);
  });
});

describe('identity across ticks', () => {
  it('continuity survives member churn but breaks once no prior member remains', async () => {
    const { world, run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 15));
    // 5001 replaced by 5003; 5002 still there → same entry
    world.rows = [...BASE, { ...leftover()[1] }, { pid: 5003, ppid: 1, pgid: 5000, args: 'node restart.js', env: marked(DEAD_TAB) }];
    await tickAt(sw, 20);
    // every member new (same pgid) → a new entry from 0
    world.rows = [...BASE, { pid: 5004, ppid: 1, pgid: 5000, args: 'node again.js', env: marked(DEAD_TAB) }];
    await tickAt(sw, ...range(25, 50));
    expect(kills).toEqual([]);
    await tickAt(sw, 55);
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);
  });

  it('a same pid with a different lstart is a different process', async () => {
    const { world, run } = fakeWorld([...BASE, { pid: 5001, ppid: 1, pgid: 5000, args: 'node a.js', env: marked(DEAD_TAB) }]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 25));
    world.rows = [...BASE, { pid: 5001, ppid: 1, pgid: 5000, lstart: 'Sat Oct  3 18:00:00 2026', args: 'node a.js', env: marked(DEAD_TAB) }];
    await tickAt(sw, 30);
    expect(kills).toEqual([]);
  });

  it('a break in candidacy deletes the entry', async () => {
    const live: Fx = { pid: 46000, ppid: SELF, pgid: SELF, args: 'claude -p go', env: `PATH=/usr/bin DREAMCONTEXT_TAB_SESSION=${DEAD_TAB}` };
    const { world, run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 25));
    world.rows = [...BASE, live, ...leftover()];
    await tickAt(sw, 30);
    world.rows = [...BASE, ...leftover()];
    await tickAt(sw, ...range(35, 60));
    expect(kills).toEqual([]);
    await tickAt(sw, 65);
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);
  });
});

describe('aborts and gaps', () => {
  it('one aborted tick between two successes keeps every entry', async () => {
    const { world, run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await tickAt(sw, ...range(0, 25)); // observed 25
    world.fail = 'table';
    await tickAt(sw, 30);
    expect(kills).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/tick aborted \(table\), 1 in a row/);
    world.fail = null;
    await tickAt(sw, 35); // +min(10, 6) = 31
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);
  });

  it('an aborted tick never signals, even when one is due', async () => {
    const { world, run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await tickAt(sw, ...range(0, 25));
    world.fail = 'env';
    await tickAt(sw, 30);
    expect(kills).toEqual([]);
    world.fail = null;
    await tickAt(sw, 31);
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);
  });

  it('a gap of exactly 3 × interval clears; just under does not', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const run1 = fakeWorld([...BASE, ...leftover()]);
    const a = sweeper(run1.run);
    await tickAt(a, ...range(0, 20)); // observed 20
    run1.world.fail = 'table';
    await tickAt(a, 25, 30);
    run1.world.fail = null;
    await tickAt(a, 35); // gap 15 = 3 × 5 → cleared, restarts at 0
    await tickAt(a, ...range(40, 60));
    expect(kills).toEqual([]);
    await tickAt(a, 65);
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);

    kills = [];
    t = 0;
    const run2 = fakeWorld([...BASE, ...leftover()]);
    const b = sweeper(run2.run);
    await tickAt(b, ...range(0, 20));
    run2.world.fail = 'table';
    await tickAt(b, 25, 30);
    run2.world.fail = null;
    t = 35 * MIN - 1; // gap just under 15 min → +6 (capped) = 26
    await b.tick();
    expect(kills).toEqual([]);
    await tickAt(b, 40); // +5 - ε → 31
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);
  });

  it('a sleep gap ≥ 3 × interval and a backward clock both clear entries', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 25));
    await tickAt(sw, 100); // long gap
    await tickAt(sw, 105, 110, 115, 120, 125);
    expect(kills).toEqual([]);
    await tickAt(sw, 120); // clock moved back
    await tickAt(sw, ...range(125, 145));
    expect(kills).toEqual([]);
    await tickAt(sw, 150);
    expect(kills.map((k) => k.sig)).toEqual(['SIGTERM']);
    expect(log.mock.calls.flat().join('\n')).toMatch(/clock moved back/);
  });

  it('six consecutive aborts log one "sweep stuck" warning', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { world, run } = fakeWorld([...BASE]);
    world.fail = 'env';
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 45));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/sweep stuck/);
  });

  it("a runPs rejection carrying env tokens never reaches console output", async () => {
    const SECRET = `DREAMCONTEXT_TAB_SESSION=${id(30)} TOKEN=SECRET`;
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const leaky = (fields: Record<string, unknown>) => createRunPs(async () => {
      throw Object.assign(new Error(`Command failed: ps ${SECRET}`), { stdout: SECRET, stderr: SECRET, cmd: `ps ${SECRET}` }, fields);
    });
    for (const fields of [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, { code: 2 }, { killed: true }]) {
      await sweeper(leaky(fields)).tick();
    }
    // a raw (non-PsError) rejection too
    await sweeper(async () => { throw Object.assign(new Error(SECRET), { stdout: SECRET }); }).tick();
    const printed = spies.flatMap((s) => s.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))).join('\n');
    expect(printed).toMatch(/tick aborted/);
    expect(printed).not.toContain('SECRET');
    expect(printed).not.toContain(id(30));
  });
});

describe('concurrency and shutdown', () => {
  it('ticks never overlap', async () => {
    const { world, run } = fakeWorld([...BASE]);
    let release!: () => void;
    world.gate = new Promise<void>((r) => { release = r; });
    const sw = sweeper(run);
    const first = sw.tick();
    await sw.tick();
    await sw.tick();
    expect(world.calls).toBe(1);
    release();
    await first;
    expect(world.calls).toBe(2); // the first tick's env call
  });

  it('stop() during an in-flight tick → no signal and no ledger line', async () => {
    const { world, run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 25));
    let release!: () => void;
    world.gate = new Promise<void>((r) => { release = r; });
    t = 30 * MIN;
    const inFlight = sw.tick();
    sw.stop();
    release();
    await inFlight;
    await tickAt(sw, 35, 40);
    expect(kills).toEqual([]);
    expect(ledger()).toEqual([]);
  });
});

describe('ledger', () => {
  it('JSONL at ~/.dreamcontext/orphan-sweep.log, mode 0600, dir 0700, inside the injected home only', async () => {
    const realLedgerBefore = existsSync(orphanLedgerPath(homedir()));
    const { run } = fakeWorld([...BASE, ...leftover()]);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 30));
    expect(orphanLedgerPath(home)).toBe(join(home, '.dreamcontext', 'orphan-sweep.log'));
    expect(statSync(orphanLedgerPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.dreamcontext')).mode & 0o777).toBe(0o700);
    expect(existsSync(orphanLedgerPath(homedir()))).toBe(realLedgerBefore);
  });

  it('names only time, signal, pgid, tab, session, count and ≤20 {pid, lstart, program}', async () => {
    const rows: Fx[] = [...BASE];
    for (let i = 0; i < 25; i++) {
      rows.push({
        pid: 5001 + i, ppid: 1, pgid: 5000,
        args: `/opt/homebrew/bin/node /Users/dev/projects/acme-shop/server.js --secret API_KEY=x Bearer y --cwd /Users/dev/projects/acme-shop`,
        env: marked(DEAD_TAB, 'API_TOKEN=tok_live_zzz'),
      });
    }
    rows.push({ pid: 5100, ppid: 1, pgid: 5000, args: '/Applications/Weird App.app/Contents/MacOS/Weird App --flag' });
    const { run } = fakeWorld(rows);
    const sw = sweeper(run);
    await tickAt(sw, ...range(0, 30));
    const raw = readFileSync(orphanLedgerPath(home), 'utf-8');
    const [line] = ledger();
    expect(Object.keys(line).sort()).toEqual(['at', 'memberCount', 'members', 'pgid', 'sessionId', 'signal', 'tabId']);
    expect(line.memberCount).toBe(26);
    const members = line.members as { pid: number; lstart: string; program: string }[];
    expect(members).toHaveLength(20);
    expect(members[0]).toEqual({ pid: 5001, lstart: 'Sat Oct  3 15:35:39 2026', program: 'node' });
    expect(typeof line.at).toBe('string');
    for (const needle of ['API_KEY', 'Bearer', 'acme-shop', 'server.js', 'tok_live', 'secret', '/Users/dev']) {
      expect(raw).not.toContain(needle);
    }
  });
});

describe('startOrphanSweep gate', () => {
  const APP_ENV = { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: '56219' };
  const deps: OrphanSweepDeps = { home: '/nonexistent-never-used', runPs: async () => { throw new PsError('spawn'); }, kill: () => { throw new Error('must not signal'); } };

  const gate = (over: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; ppid?: number }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stop = startOrphanSweep({ env: APP_ENV, platform: 'darwin', ppid: 56219, deps, ...over });
    const lines = log.mock.calls.map((c) => String(c[0]));
    stop?.();
    log.mockRestore();
    return { started: !!stop, lines };
  };

  it('is on for the app-owned desktop server, with one boot line', () => {
    const r = gate({});
    expect(r.started).toBe(true);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/orphan-sweep\] enabled/);
  });

  it.each([
    ['under VITEST', { env: { ...APP_ENV, VITEST: 'true' } }, /test run/],
    ['under NODE_ENV=test', { env: { ...APP_ENV, NODE_ENV: 'test' } }, /test run/],
    ['off darwin', { platform: 'linux' as NodeJS.Platform }, /platform linux/],
    ['without DREAMCONTEXT_DESKTOP', { env: { DREAMCONTEXT_PARENT_PID: '56219' } }, /not the desktop app/],
    ['in a builder-launched server (ppid ≠ PARENT_PID)', { ppid: 90450 }, /ppid is not DREAMCONTEXT_PARENT_PID/],
    ['without DREAMCONTEXT_PARENT_PID', { env: { DREAMCONTEXT_DESKTOP: '1' } }, /ppid is not/],
    ['with the kill switch', { env: { ...APP_ENV, DREAMCONTEXT_ORPHAN_SWEEP: '0' } }, /DREAMCONTEXT_ORPHAN_SWEEP=0/],
  ])('is off %s, logging the reason once', (_label, over, reason) => {
    const r = gate(over);
    expect(r.started).toBe(false);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/orphan-sweep\] disabled/);
    expect(r.lines[0]).toMatch(reason);
  });

  it('defaults to process env, which is a test run here', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(startOrphanSweep()).toBeUndefined();
    expect(String(log.mock.calls[0][0])).toMatch(/disabled/);
  });
});
