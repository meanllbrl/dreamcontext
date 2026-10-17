// Mac mode's thermal governor (AC1-AC5, AC6 halt): the reader, the table, who may be slowed,
// inherited children, the tick and the release procedure — over a fake process table.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_INHERITED, MAX_ROOTS, OSA_ARGS, PS_ARGS, ThermalGovernor, appendThermalLog, findInherited, isExempt,
  lstartToMs, parseEtime, parseHeavyTable, pickClampTargets, readThermalState, releaseLedger, releasePendingThermal,
  serverChainOf, type ExemptCtx, type HeavyRow, type LedgerEntry, type ThermalRun,
} from '../../src/lib/handsfree/mac/thermal.js';
import { BG_PRI, NORMAL_PRI, T0, UID, World, lstartOf, psLine, type FakeProc } from '../helpers/thermal-world.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mac-thermal-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.useRealTimers(); });

const ok = (stdout: string): ThermalRun => async () => ({ code: 0, stdout });

describe('readThermalState (AC1)', () => {
  it('maps 0..3 to nominal/fair/serious/critical, through /usr/bin/osascript', async () => {
    const seen: string[] = [];
    const run: ThermalRun = async (file, args) => { seen.push([file, ...args].join(' ')); return { code: 0, stdout: '2\n' }; };
    expect(await readThermalState(run)).toBe('serious');
    expect(seen[0]).toBe(['/usr/bin/osascript', ...OSA_ARGS].join(' '));
    expect(await readThermalState(ok('0'))).toBe('nominal');
    expect(await readThermalState(ok('1'))).toBe('fair');
    expect(await readThermalState(ok('3\n'))).toBe('critical');
  });

  it('is null, never a throw, on garbage, empty output, a non-zero exit, a throwing runner, or the 3 s timeout', async () => {
    expect(await readThermalState(ok('abc'))).toBeNull();
    expect(await readThermalState(ok('4'))).toBeNull();
    expect(await readThermalState(ok('1.5'))).toBeNull();
    expect(await readThermalState(ok(''))).toBeNull();
    expect(await readThermalState(async () => ({ code: 1, stdout: '2' }))).toBeNull();
    expect(await readThermalState(async () => { throw new Error('spawn ENOENT'); })).toBeNull();
    vi.useFakeTimers();
    const hung = readThermalState(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await hung).toBeNull();
  });
});

describe('the process table', () => {
  it('parses the C-locale UTC table, args with spaces, a padded day, every etime form', () => {
    const out = [
      '  501   812     1   812  97.3  31    02:03:04 Sat Oct  3 15:35:39 2026     /usr/local/bin/node /tmp/a b.js --flag  ',
      '  501   813   812   812   0.0   4       00:21 Sat Oct 17 09:59:59 2026     next-server (v16.1.1) ',
      '    0     1     0     1   0.1  37 12-01:00:00 Mon Oct  5 08:00:00 2026     /sbin/launchd',
    ].join('\n');
    const rows = parseHeavyTable(out)!;
    expect(rows.get(812)).toMatchObject({ uid: 501, ppid: 1, pcpu: 97.3, pri: 31, etimeSec: 7384, lstart: 'Sat Oct  3 15:35:39 2026', args: '/usr/local/bin/node /tmp/a b.js --flag  ' });
    expect(rows.get(813)).toMatchObject({ pri: 4, etimeSec: 21, args: 'next-server (v16.1.1) ' });
    expect(rows.get(1)!.etimeSec).toBe(12 * 86400 + 3600);
    expect(parseEtime('01:05')).toBe(65);
  });

  it('a line that does not parse fails the whole scan (no partial table reads as "dead")', () => {
    expect(parseHeavyTable('  501 812 1 812 97.3 31 02:03 garbage')).toBeNull();
  });

  it('ps runs with the heavy column set', () => {
    expect(PS_ARGS).toEqual(['-axww', '-o', 'uid=,pid=,ppid=,pgid=,pcpu=,pri=,etime=,lstart=,args=']);
  });

  it('lstart is read as UTC with Date.UTC, also under TZ=Europe/Istanbul (Date.parse would be 3 h off)', () => {
    const prior = process.env.TZ;
    process.env.TZ = 'Europe/Istanbul';
    try {
      const s = 'Sat Oct  3 15:35:39 2026';
      expect(lstartToMs(s)).toBe(Date.UTC(2026, 9, 3, 15, 35, 39));
      expect(Date.UTC(2026, 9, 3, 15, 35, 39) - Date.parse(s)).toBe(3 * 3600 * 1000);   // proves the TZ took effect
      expect(lstartToMs(lstartOf(T0 + 1234))).toBe(T0 + 1000);
      expect(lstartToMs('garbage')).toBeNaN();
    } finally {
      if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior;
    }
  });
});

// ─── Who may be slowed ──────────────────────────────────────────────────────

function rowsOf(procs: Array<Partial<FakeProc> & { pid: number }>): Map<number, HeavyRow> {
  const w = new World();
  for (const p of procs) w.add(p);
  return parseHeavyTable([...w.procs.values()].map(psLine).join('\n'))!;
}

describe('pickClampTargets (AC2)', () => {
  const SERVER = 500;
  const base = [
    { pid: 400, ppid: 1, pcpu: 90, args: '/Applications/dreamcontext.app/Contents/MacOS/dreamcontext' },   // the desktop app
    { pid: SERVER, ppid: 400, pcpu: 90, args: '/opt/node /Applications/dreamcontext.app/Contents/Resources/dist/index.js dashboard --port 4000' },
  ];
  function pick(extra: Array<Partial<FakeProc> & { pid: number }>, level: 'fair' | 'serious' | 'critical' | 'nominal' | null, o: { ledger?: Map<number, LedgerEntry>; filter?: (r: HeavyRow) => boolean } = {}) {
    const rows = rowsOf([...base, ...extra]);
    const ctx: ExemptCtx = { serverChain: serverChainOf(rows, SERVER), home };
    return pickClampTargets(rows, { uid: UID, level, ctx, ledger: o.ledger ?? new Map(), filter: o.filter }).map((r) => r.pid);
  }

  it.each([
    ['a heavy own process at fair', { pid: 10, pcpu: 80 }, 'fair', true],
    ['49% at fair (threshold 50)', { pid: 10, pcpu: 49 }, 'fair', false],
    ['50% at fair', { pid: 10, pcpu: 50 }, 'fair', true],
    ['15% at serious', { pid: 10, pcpu: 15 }, 'serious', true],
    ['14% at critical', { pid: 10, pcpu: 14 }, 'critical', false],
    ['15% at critical', { pid: 10, pcpu: 15 }, 'critical', true],
    ['anything at nominal', { pid: 10, pcpu: 99 }, 'nominal', false],
    ['anything with no reading', { pid: 10, pcpu: 99 }, null, false],
    ['19 s old', { pid: 10, etimeSec: 19 }, 'critical', false],
    ['20 s old', { pid: 10, etimeSec: 20 }, 'critical', true],
    ['already in the background band (pri 10)', { pid: 10, pri: 10 }, 'critical', false],
    ['pri 11', { pid: 10, pri: 11 }, 'critical', true],
    ['another user', { pid: 10, uid: 0 }, 'critical', false],
    ['a claude binary', { pid: 10, args: '/Users/x/.local/bin/claude -p --model opus' }, 'critical', false],
    ['the npm claude CLI', { pid: 10, args: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' }, 'critical', false],
    ['a dashboard server', { pid: 10, args: 'node /x/dist/index.js dashboard --no-open' }, 'critical', false],
    ['our cloudflared', { pid: 10, args: 'HOME/.dreamcontext/bin/cloudflared-2026.10.1 tunnel run' }, 'critical', false],
    ['some other cloudflared', { pid: 10, args: '/opt/homebrew/bin/cloudflared tunnel run' }, 'critical', true],
    ['a WebKit XPC service', { pid: 10, args: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent' }, 'critical', false],
    ['Brave', { pid: 10, args: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' }, 'fair', true],
  ] as const)('%s', (_name, proc, level, picked) => {
    const p = { ...proc, args: proc.args?.replace('HOME', home) };
    if (!p.args) delete (p as { args?: string }).args;
    expect(pick([p], level).includes(10)).toBe(picked);
  });

  it('never the server or its ancestor chain (the desktop app), however hot', () => {
    expect(pick([], 'critical')).toEqual([]);
  });

  it('not a pid already in the ledger; the filter seam limits roots', () => {
    const ledger = new Map([[10, { pid: 10, lstart: lstartOf(T0), clampedAt: T0, kind: 'root' as const, state: 'clamped' as const }]]);
    expect(pick([{ pid: 10 }, { pid: 11 }], 'fair', { ledger })).toEqual([11]);
    expect(pick([{ pid: 10 }, { pid: 11 }], 'fair', { filter: (r) => r.pid === 10 })).toEqual([10]);
  });

  it(`at most ${MAX_ROOTS} roots, the heaviest first`, () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ pid: 1000 + i, pcpu: 20 + i }));
    const got = pick(many, 'serious');
    expect(got).toHaveLength(64);
    expect(got[0]).toBe(1069);
    expect(got).not.toContain(1000);
  });

  it('isExempt names every phone-path process', () => {
    const rows = rowsOf(base);
    const ctx: ExemptCtx = { serverChain: serverChainOf(rows, SERVER), home };
    expect([...ctx.serverChain].sort()).toEqual([400, 500]);
    expect(isExempt(rows.get(400)!, ctx)).toBe(true);
  });
});

describe('findInherited (AC3)', () => {
  const clampedAt = T0 + 500;   // 10:00:00.500
  const ledger = () => new Map<number, LedgerEntry>([[100, { pid: 100, lstart: lstartOf(T0 - 60_000), clampedAt, kind: 'root', state: 'clamped' }]]);
  const ctx: ExemptCtx = { serverChain: new Set([500]), home: '/nowhere' };
  const parent = { pid: 100, born: T0 - 60_000, pri: BG_PRI };

  it('records a same-uid background child born after the clamp, and one born in the SAME second', () => {
    const rows = rowsOf([parent, { pid: 101, ppid: 100, born: T0 + 5000, pri: BG_PRI }, { pid: 102, ppid: 100, born: T0 + 900, pri: BG_PRI }]);
    const r = findInherited(rows, ledger(), { uid: UID, ctx });
    expect(r.found.map((f) => [f.row.pid, f.parent])).toEqual([[101, 100], [102, 100]]);
  });

  it('a grandchild is reached through an unrecorded child', () => {
    const rows = rowsOf([parent, { pid: 101, ppid: 100, born: T0 + 5000, pri: NORMAL_PRI }, { pid: 103, ppid: 101, born: T0 + 6000, pri: BG_PRI }]);
    expect(findInherited(rows, ledger(), { uid: UID, ctx }).found.map((f) => f.row.pid)).toEqual([103]);
  });

  it('not: older than the clamp, normal pri, another uid, or an ancestor whose lstart changed (reused pid)', () => {
    const rows = rowsOf([parent,
      { pid: 104, ppid: 100, born: T0 - 1000, pri: BG_PRI },
      { pid: 105, ppid: 100, born: T0 + 5000, pri: NORMAL_PRI },
      { pid: 106, ppid: 100, born: T0 + 5000, pri: BG_PRI, uid: 0 },
    ]);
    expect(findInherited(rows, ledger(), { uid: UID, ctx }).found).toEqual([]);
    const reused = rowsOf([{ pid: 100, born: T0 + 1000 }, { pid: 107, ppid: 100, born: T0 + 5000, pri: BG_PRI }]);
    expect(findInherited(reused, ledger(), { uid: UID, ctx }).found).toEqual([]);
  });

  it('an exempt child (a claude) is reported for immediate release, never recorded', () => {
    const rows = rowsOf([parent, { pid: 108, ppid: 100, born: T0 + 5000, pri: BG_PRI, args: '/Users/x/.local/bin/claude -p' }]);
    const r = findInherited(rows, ledger(), { uid: UID, ctx });
    expect(r.found).toEqual([]);
    expect(r.exempt.map((x) => x.pid)).toEqual([108]);
  });

  it('a ceiling: past it the scan says capped', () => {
    const rows = rowsOf([parent, ...[1, 2, 3].map((i) => ({ pid: 110 + i, ppid: 100, born: T0 + 5000, pri: BG_PRI }))]);
    const r = findInherited(rows, ledger(), { uid: UID, ctx, room: 2 });
    expect(r.found).toHaveLength(2);
    expect(r.capped).toBe(true);
  });
});

// ─── The governor ───────────────────────────────────────────────────────────

const SERVER = 500;
function governor(w: World, over: Partial<ConstructorParameters<typeof ThermalGovernor>[0]> = {}) {
  const changes: LedgerEntry[][] = [];
  const g = new ThermalGovernor({
    serverPid: SERVER, home, uid: UID, run: w.run, now: () => w.clock, pollMs: 60_000, logPath: join(home, 'thermal.log'),
    onChange: (l) => changes.push(l), ...over,
  });
  return { g, changes };
}
const taskpolicies = (w: World) => w.calls.filter((c) => c.includes('taskpolicy')).map((c) => c.replace('/usr/sbin/taskpolicy ', ''));

describe('ThermalGovernor (AC4)', () => {
  it('no ps at all while nominal with an empty ledger', async () => {
    const w = new World();
    w.add({ pid: 10 });
    const { g } = governor(w);
    for (let i = 0; i < 5; i++) await g.tick();
    expect(w.count('/usr/bin/osascript')).toBe(5);
    expect(w.count('/bin/ps')).toBe(0);
    expect(g.snapshot()).toEqual({ state: 'nominal', slowed: 0 });
  });

  it('clamp: false (normal mode) reads the state every tick but never runs ps or taskpolicy, however hot', async () => {
    const w = new World();
    w.add({ pid: 10 }); w.add({ pid: 11 });
    w.steady = 'critical';
    const { g, changes } = governor(w, { clamp: false });
    for (let i = 0; i < 5; i++) await g.tick();
    expect(w.count('/usr/bin/osascript')).toBe(5);
    expect(w.count('/bin/ps')).toBe(0);
    expect(taskpolicies(w)).toEqual([]);
    expect(changes).toEqual([]);
    expect(g.snapshot()).toEqual({ state: 'critical', slowed: 0 });
    expect(w.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(await g.releaseAll()).toEqual([]);
    expect(w.count('/bin/ps')).toBe(0);   // nothing slowed: nothing to release, no scan
  });

  it('hot: a heavy process is written pending in ONE batch, clamped only on exit 0, then scanned every tick', async () => {
    const w = new World();
    w.add({ pid: 10 }); w.add({ pid: 11 }); w.add({ pid: 12, pcpu: 5 });
    w.thermal = ['serious'];
    const { g, changes } = governor(w);
    await g.tick();
    expect(taskpolicies(w)).toEqual(['-b -p 10', '-b -p 11']);
    expect(changes).toHaveLength(2);   // one batch of pending, one at the end — never one write per pid
    expect(changes[0].map((e) => [e.pid, e.state])).toEqual([[10, 'pending'], [11, 'pending']]);
    expect(changes[1].map((e) => [e.pid, e.state])).toEqual([[10, 'clamped'], [11, 'clamped']]);
    expect(w.procs.get(10)!.pri).toBe(BG_PRI);
    expect(g.snapshot()).toEqual({ state: 'serious', slowed: 2 });
    const ps = w.count('/bin/ps');
    await g.tick();   // nominal now, but the ledger is not empty
    expect(w.count('/bin/ps')).toBe(ps + 1);
    expect(changes).toHaveLength(2);   // nothing changed → no write
  });

  it('a pid that dies before -b (taskpolicy exit 70) is dropped, never clamped', async () => {
    const w = new World();
    w.add({ pid: 10 });
    w.thermal = ['fair'];
    w.onTaskpolicy = (flag, pid) => { if (flag === '-b') w.procs.delete(pid); };
    const { g } = governor(w);
    await g.tick();
    expect(g.entries()).toEqual([]);
    expect(g.snapshot().slowed).toBe(0);
  });

  it('releases after 6 consecutive nominal readings, not 5; then stops scanning', async () => {
    const w = new World();
    w.add({ pid: 10 });
    w.thermal = ['serious', 'nominal', 'nominal', 'nominal', 'nominal', 'nominal', 'fair', 'nominal', 'nominal', 'nominal', 'nominal', 'nominal'];
    const { g } = governor(w);
    for (let i = 0; i < 12; i++) await g.tick();
    expect(g.snapshot().slowed).toBe(1);   // the fair reading reset the streak
    expect(w.procs.get(10)!.pri).toBe(BG_PRI);
    await g.tick();   // 6th nominal in a row
    expect(w.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(g.entries()).toEqual([]);
    const ps = w.count('/bin/ps');
    await g.tick();
    expect(w.count('/bin/ps')).toBe(ps);
  });

  it('6 consecutive null readings with a non-empty ledger release everything', async () => {
    const w = new World();
    w.add({ pid: 10 });
    w.thermal = ['critical', null, null, null, null, null, null];
    const { g } = governor(w);
    for (let i = 0; i < 6; i++) await g.tick();   // critical + 5 nulls
    expect(w.procs.get(10)!.pri).toBe(BG_PRI);
    await g.tick();
    expect(w.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(g.snapshot()).toEqual({ state: null, slowed: 0 });
  });

  it('a child born under a clamped parent is recorded as inherited on the next tick', async () => {
    const w = new World();
    w.add({ pid: 10 });
    w.thermal = ['serious'];
    const { g } = governor(w);
    await g.tick();
    w.add({ pid: 20, ppid: 10, born: w.clock + 1000, pri: BG_PRI, etimeSec: 3, pcpu: 90 });
    w.thermal = ['serious'];
    await g.tick();
    expect(g.entries().find((e) => e.pid === 20)).toMatchObject({ kind: 'inherited', parent: 10, state: 'clamped' });
    expect(g.snapshot().slowed).toBe(2);
    expect(taskpolicies(w)).toEqual(['-b -p 10']);   // the child is never clamped itself, it was born so
  });

  it('a claude born under a clamped terminal is released on the same tick, never recorded', async () => {
    const w = new World();
    w.add({ pid: 10 });
    w.thermal = ['serious'];
    const { g } = governor(w);
    await g.tick();
    w.add({ pid: 21, ppid: 10, born: w.clock + 1000, pri: BG_PRI, args: '/Users/x/.local/bin/claude -p' });
    await g.tick();
    expect(w.procs.get(21)!.pri).toBe(NORMAL_PRI);
    expect(g.entries().map((e) => e.pid)).toEqual([10]);
  });

  it(`at most ${MAX_INHERITED} inherited children; past it a skip-cap line is logged and recorded entries stay`, async () => {
    const w = new World();
    w.add({ pid: 10 });
    w.thermal = ['serious'];
    const { g } = governor(w);
    await g.tick();
    for (let i = 0; i < MAX_INHERITED + 3; i++) w.add({ pid: 10_000 + i, ppid: 10, born: w.clock + 1000, pri: BG_PRI, pcpu: 0 });
    await g.tick();
    expect(g.entries().filter((e) => e.kind === 'inherited')).toHaveLength(MAX_INHERITED);
    expect(readFileSync(join(home, 'thermal.log'), 'utf8')).toMatch(/skip-cap inherited/);
  });

  it('single-flight: a tick started while one runs reuses it', async () => {
    const w = new World();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reads = vi.fn(async () => { await gate; return 'nominal' as const; });
    const { g } = governor(w, { readThermal: reads });
    const a = g.tick(); const b = g.tick();
    release();
    await Promise.all([a, b]);
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

describe('the release procedure (AC5)', () => {
  function clampedWorld() {
    const w = new World();
    w.add({ pid: 10 });
    w.add({ pid: 11, ppid: 10, born: T0 + 120_000, pri: BG_PRI, pcpu: 0 });   // inherited
    w.add({ pid: 12, ppid: 11, born: T0 + 121_000, pri: BG_PRI, pcpu: 0 });   // grandchild
    const ledger: LedgerEntry[] = [
      { pid: 12, lstart: lstartOf(T0 + 121_000), clampedAt: T0 + 121_000, kind: 'inherited', parent: 11, state: 'clamped' },
      { pid: 11, lstart: lstartOf(T0 + 120_000), clampedAt: T0 + 120_000, kind: 'inherited', parent: 10, state: 'clamped' },
      { pid: 10, lstart: lstartOf(T0), clampedAt: T0 + 100_000, kind: 'root', state: 'clamped' },
    ];
    w.procs.get(10)!.pri = BG_PRI;
    return { w, ledger };
  }

  it('roots first, then children parent before child; nothing left slowed', async () => {
    const { w, ledger } = clampedWorld();
    const r = await releaseLedger(ledger, { run: w.run, uid: UID, home });
    expect(taskpolicies(w)).toEqual(['-B -p 10', '-B -p 11', '-B -p 12']);
    expect(r).toEqual({ leftover: [], psOk: true });
    expect([10, 11, 12].map((p) => w.procs.get(p)!.pri)).toEqual([NORMAL_PRI, NORMAL_PRI, NORMAL_PRI]);
  });

  it('a child forked DURING the release (before its parent is released) is caught by the sweep', async () => {
    const { w, ledger } = clampedWorld();
    w.onTaskpolicy = (flag, pid) => {
      if (flag === '-B' && pid === 11 && !w.procs.has(13)) w.add({ pid: 13, ppid: 11, born: T0 + 200_000, pri: BG_PRI, pcpu: 0 });
    };
    await releaseLedger(ledger, { run: w.run, uid: UID, home });
    expect(taskpolicies(w)).toContain('-B -p 13');
    expect(w.procs.get(13)!.pri).toBe(NORMAL_PRI);
  });

  it('-B only on an lstart match; absent from a successful ps = dead, dropped', async () => {
    const { w, ledger } = clampedWorld();
    Object.assign(w.procs.get(11)!, { born: T0 + 300_000, ppid: 1 });   // pid 11 reused by an unrelated process
    w.procs.delete(12);
    const r = await releaseLedger(ledger, { run: w.run, uid: UID, home });
    expect(taskpolicies(w)).toEqual(['-B -p 10']);
    expect(r.leftover).toEqual([]);
  });

  it('a -B that fails on a LIVE process (EAGAIN, timeout) keeps the entry; only "no such process" (70) drops it', async () => {
    const { w, ledger } = clampedWorld();
    w.onTaskpolicy = (flag, pid) => { if (flag === '-B' && pid === 11) throw new Error('spawn EAGAIN'); };
    const r = await releaseLedger(ledger, { run: w.run, uid: UID, home });
    expect(r.psOk).toBe(true);
    expect(r.leftover.map((e) => e.pid)).toEqual([11]);
    expect(w.procs.get(11)!.pri).toBe(BG_PRI);
    expect(taskpolicies(w).filter((c) => c === '-B -p 11').length).toBeGreaterThan(1);   // retried on each sweep
  });

  it('the governor keeps a process whose -B failed and releases it on a later tick', async () => {
    const w = new World();
    w.add({ pid: 10 });
    w.thermal = ['serious', 'nominal', 'nominal', 'nominal', 'nominal', 'nominal', 'nominal'];
    let fail = true;
    w.onTaskpolicy = (flag) => { if (flag === '-B' && fail) throw new Error('spawn EAGAIN'); };
    const { g } = governor(w);
    for (let i = 0; i < 7; i++) await g.tick();
    expect(g.entries().map((e) => [e.pid, e.state])).toEqual([[10, 'clamped']]);
    fail = false;
    await g.tick();
    expect(w.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(g.entries()).toEqual([]);
  });

  it('a ps failure keeps every entry for the next try', async () => {
    const { w, ledger } = clampedWorld();
    w.psFails = true;
    const r = await releaseLedger(ledger, { run: w.run, uid: UID, home });
    expect(taskpolicies(w)).toEqual([]);
    expect(r.psOk).toBe(false);
    expect(r.leftover.map((e) => e.pid).sort()).toEqual([10, 11, 12]);
  });

  it('the governor keeps its ledger through a failed ps and releases on the next good tick', async () => {
    const w = new World();
    w.add({ pid: 10 });
    w.thermal = ['serious'];
    const { g } = governor(w);
    await g.tick();
    w.psFails = true;
    for (let i = 0; i < 6; i++) await g.tick();
    expect(g.entries().map((e) => e.pid)).toEqual([10]);
    expect(w.procs.get(10)!.pri).toBe(BG_PRI);
    w.psFails = false;
    await g.tick();
    expect(w.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(g.entries()).toEqual([]);
  });

  it('no -B is started past the deadline; the rest is returned', async () => {
    const { w, ledger } = clampedWorld();
    w.onTaskpolicy = () => { w.clock += 500; };
    const r = await releaseLedger(ledger, { run: w.run, uid: UID, home, now: () => w.clock, deadline: w.clock + 800 });
    expect(taskpolicies(w)).toEqual(['-B -p 10', '-B -p 11']);
    expect(r.leftover.map((e) => e.pid)).toEqual([12]);
  });

  it('past the deadline no ps is started either; everything comes back as leftover', async () => {
    const { w, ledger } = clampedWorld();
    const r = await releaseLedger(ledger, { run: w.run, uid: UID, home, now: () => w.clock, deadline: w.clock });
    expect(w.count('/bin/ps')).toBe(0);
    expect(r.leftover.map((e) => e.pid).sort()).toEqual([10, 11, 12]);
  });

  it('the pending file is deleted only when everything was released, else rewritten with the leftovers', async () => {
    const { w, ledger } = clampedWorld();
    const path = join(home, 'thermal-pending.json');
    writeFileSync(path, JSON.stringify(ledger));
    w.psFails = true;
    expect((await releasePendingThermal({ run: w.run, uid: UID, home, path })).length).toBe(3);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(3);
    w.psFails = false;
    expect(await releasePendingThermal({ run: w.run, uid: UID, home, path })).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
});

describe('stop races (AC6)', () => {
  it('releaseAll mid-tick (the reader still pending): no -b after it, nothing left slowed', async () => {
    const w = new World();
    w.add({ pid: 10 });
    let answer!: (s: 'serious') => void;
    const { g, changes } = governor(w, { readThermal: () => new Promise((r) => { answer = r; }) });
    const tick = g.tick();
    const released = g.releaseAll();
    answer('serious');
    await tick;
    expect(await released).toEqual([]);
    expect(taskpolicies(w).filter((c) => c.startsWith('-b'))).toEqual([]);
    expect(w.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(changes).toEqual([]);   // a late tick never writes after halt
  });

  it('a -b in flight when releaseAll starts: the next -b never runs, and the pending one is released', async () => {
    const w = new World();
    w.add({ pid: 10, pcpu: 90 }); w.add({ pid: 11, pcpu: 80 });
    w.thermal = ['serious'];
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    w.onTaskpolicy = async (flag, pid) => { if (flag === '-b' && pid === 10) await blocked; };
    const { g } = governor(w);
    const tick = g.tick();
    await vi.waitFor(() => expect(taskpolicies(w)).toEqual(['-b -p 10']));
    const released = g.releaseAll();
    unblock();
    await tick;
    expect(await released).toEqual([]);
    expect(taskpolicies(w).filter((c) => c.startsWith('-b'))).toEqual(['-b -p 10']);
    expect(w.procs.get(10)!.pri).toBe(NORMAL_PRI);
    expect(w.procs.get(11)!.pri).toBe(NORMAL_PRI);
  });

  it('halt() is synchronous; a late tick after it changes nothing', async () => {
    const w = new World();
    w.add({ pid: 10 });
    let answer!: (s: 'critical') => void;
    const { g, changes } = governor(w, { readThermal: () => new Promise((r) => { answer = r; }) });
    const tick = g.tick();
    g.halt();
    answer('critical');
    await tick;
    expect(w.count('/bin/ps')).toBe(0);
    expect(changes).toEqual([]);
    await g.tick();
    expect(w.calls).toEqual([]);
  });
});

describe('the log', () => {
  it('0600, one line per action, capped: over the cap the newest half is kept', () => {
    const path = join(home, 'thermal.log');
    for (let i = 0; i < 50; i++) appendThermalLog(path, `line-${String(i).padStart(3, '0')} xxxxxxxxxxxxxxxxxxxx`, 400);
    const text = readFileSync(path, 'utf8');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(text.length).toBeLessThanOrEqual(400 + 40);
    expect(text).toContain('line-049');
    expect(text).not.toContain('line-000');
    expect(text.split('\n')[0]).toMatch(/^line-\d{3} x+$/);   // cut at a line boundary
  });

  it('the governor logs each clamp with time, level, pid, program, action, kind', async () => {
    const w = new World();
    w.add({ pid: 10, args: '/opt/homebrew/bin/node /x/vitest.mjs run' });
    w.thermal = ['fair'];
    const { g } = governor(w);
    await g.tick();
    expect(readFileSync(join(home, 'thermal.log'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z fair 10 node clamp root$/m);
  });
});
