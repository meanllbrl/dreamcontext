/**
 * The default mode of scripts/verify/handsfree-thermal.mjs (run through tsx by it): the REAL
 * governor against REAL processes, with real `ps` and real `taskpolicy`. Only the thermal
 * READING is scripted. The governor's `filter` seam limits roots to this script's own burners,
 * and every ledger write is checked to hold none but this script's pids.
 *
 *   burners A, B      node busy-loops (they yield every 50 ms so signals still land)
 *   claude            the same loop started as `exec -a claude node …`: exempt, never slowed
 *   forker            a burner that forks a child on SIGUSR1: the child is born clamped
 *   control           an unfiltered burner, never slowed: the reference pri
 *
 * Then the overhead check: 60 s of nominal readings, every spawn counted through the run seam.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MacThermalState } from '../../src/lib/handsfree/mac/contract.js';
import {
  BACKGROUND_PRI, MIN_AGE_SEC, OSA_ARGS, OSASCRIPT, ThermalGovernor, defaultThermalRun, readThermalState,
  type LedgerEntry, type ThermalRun,
} from '../../src/lib/handsfree/mac/thermal.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` (${detail})` : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BURN_SRC = 'const b=()=>{const e=Date.now()+50;while(Date.now()<e){}setImmediate(b)};b();';
const FORKER_SRC = `${BURN_SRC}process.on("SIGUSR1",()=>{const c=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(BURN_SRC)}],{stdio:"ignore"});console.log("child "+c.pid)});`;

const kids: ChildProcess[] = [];
const extraPids = new Set<number>();
function burner(src = BURN_SRC): ChildProcess {
  const c = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'] });
  kids.push(c);
  return c;
}
function claudeBurner(): ChildProcess {
  const c = spawn('/bin/bash', ['-c', `exec -a claude ${process.execPath} -e '${BURN_SRC}'`], { stdio: 'ignore' });
  kids.push(c);
  return c;
}
function psOf(pid: number, col: string): string {
  return spawnSync('/bin/ps', ['-o', `${col}=`, '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout.trim();
}
const priOf = (pid: number) => Number(psOf(pid, 'pri'));

/** Whatever happened: every pid this script made goes back to normal and dies. Once: a pid
 *  signalled later could already belong to someone else. */
function cleanup(): void {
  const pids = [...kids.filter((k) => k.exitCode === null && k.signalCode === null).map((k) => k.pid).filter((p): p is number => !!p), ...extraPids];
  for (const pid of pids) spawnSync('/usr/sbin/taskpolicy', ['-B', '-p', String(pid)]);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  kids.length = 0;
  extraPids.clear();
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

async function governorRun(scratch: string): Promise<void> {
  console.log('\n[1] the governor against real processes (real ps, real taskpolicy, scripted readings)');
  const a = burner(); const b = burner(); const forker = burner(FORKER_SRC); const claude = claudeBurner(); const control = burner();
  const ours = [a, b, forker, claude].map((k) => k.pid!);
  const allowed = new Set<number>(ours);
  let lateChild = 0;
  forker.stdout!.on('data', (d: Buffer) => { const m = /child (\d+)/.exec(String(d)); if (m) { lateChild = Number(m[1]); allowed.add(lateChild); extraPids.add(lateChild); } });
  console.log(`  burners A=${a.pid} B=${b.pid} forker=${forker.pid} claude=${claude.pid} control=${control.pid}; waiting ${MIN_AGE_SEC + 2} s for them to age`);
  await sleep((MIN_AGE_SEC + 2) * 1000);
  check('the claude burner runs as argv0 "claude"', psOf(claude.pid!, 'args').startsWith('claude '), psOf(claude.pid!, 'args').slice(0, 40));
  const original = new Map([...ours, control.pid!].map((p) => [p, priOf(p)]));
  console.log(`  original pri: ${JSON.stringify(Object.fromEntries(original))}`);

  const readings: Array<MacThermalState | null> = [];
  let foreign: number[] = [];
  const g = new ThermalGovernor({
    serverPid: process.pid, home: scratch, pollMs: 3_600_000, logPath: join(scratch, 'thermal.log'),
    readThermal: async () => (readings.length ? readings.shift()! : 'nominal'),
    filter: (row) => allowed.has(row.pid),
    onChange: (l: LedgerEntry[]) => { foreign = foreign.concat(l.map((e) => e.pid).filter((p) => !allowed.has(p))); },
  });

  readings.push('serious');
  await g.tick();
  const slowedNow = [a, b, forker].map((k) => priOf(k.pid!));
  check('A, B and the forker are slowed while serious (pri ≤ 10)', slowedNow.every((p) => p <= BACKGROUND_PRI), `pri ${slowedNow.join(',')}`);
  check('the claude burner is untouched', priOf(claude.pid!) === original.get(claude.pid!) && !g.entries().some((e) => e.pid === claude.pid), `pri ${priOf(claude.pid!)}`);
  check('the control burner is untouched', priOf(control.pid!) === original.get(control.pid!));

  process.kill(forker.pid!, 'SIGUSR1');
  for (let i = 0; i < 50 && !lateChild; i++) await sleep(100);
  await sleep(1200);
  check('the forker started a child after it was clamped, and the child was born slowed', lateChild > 0 && priOf(lateChild) <= BACKGROUND_PRI, `child ${lateChild} pri ${lateChild ? priOf(lateChild) : '-'}`);
  readings.push('serious');
  await g.tick();
  const childEntry = g.entries().find((e) => e.pid === lateChild);
  check('the late child is recorded as inherited from the forker', childEntry?.kind === 'inherited' && childEntry.parent === forker.pid, JSON.stringify(childEntry ?? null));
  check('slowed counts the roots and the child', g.snapshot().slowed === 4, `slowed ${g.snapshot().slowed}`);

  for (let i = 0; i < 5; i++) { readings.push('nominal'); await g.tick(); }
  check('after 5 nominal readings they are still slowed (hysteresis)', priOf(a.pid!) <= BACKGROUND_PRI && g.snapshot().slowed === 4);
  readings.push('nominal');
  await g.tick();
  const back = [a, b, forker].map((k) => [priOf(k.pid!), original.get(k.pid!)!]);
  check('after the 6th nominal reading every burner is back at its original pri', back.every(([now, was]) => now === was), JSON.stringify(back));
  const childPri = priOf(lateChild); const controlPri = priOf(control.pid!);
  check('the late child (born slowed, no original) is out of the background band, within ±5 of the control', childPri > BACKGROUND_PRI && Math.abs(childPri - controlPri) <= 5, `child ${childPri}, control ${controlPri}`);
  check('the ledger is empty after the release', g.entries().length === 0);

  readings.push('critical');
  await g.tick();
  check('a fresh hot reading slows them again (the governor is still live)', priOf(a.pid!) <= BACKGROUND_PRI);
  const left = await g.releaseAll();
  readings.push('critical');
  await g.tick();
  const afterStop = [...ours, lateChild].map(priOf);
  check('releaseAll leaves nothing slowed, and nothing is slowed after stop', left.length === 0 && afterStop.every((p) => p > BACKGROUND_PRI), `pri ${afterStop.join(',')}`);
  check('the ledger never held a pid outside this script\'s own', foreign.length === 0, foreign.length ? `foreign ${foreign.join(',')}` : 'checked on every write');
  cleanup();
}

async function overhead(scratch: string): Promise<void> {
  console.log('\n[2] overhead: 60 s of nominal readings at the real 20 s poll');
  const spawns: string[] = [];
  const counting: ThermalRun = (file, args, o) => { spawns.push(file); return defaultThermalRun(file, args, o); };
  const g = new ThermalGovernor({
    serverPid: process.pid, home: scratch, run: counting, logPath: join(scratch, 'thermal-overhead.log'),
    readThermal: async () => { await readThermalState(counting); return 'nominal'; },
  });
  g.start();
  await sleep(61_000);
  g.halt();
  const osa = spawns.filter((f) => f === OSASCRIPT).length;
  const ps = spawns.filter((f) => f.endsWith('/ps')).length;
  check('3 osascript and 0 ps in 60 s', osa === 3 && ps === 0, `osascript ${osa}, ps ${ps}, other ${spawns.length - osa - ps}`);
  const t = spawnSync('/usr/bin/time', ['-p', OSASCRIPT, ...OSA_ARGS], { encoding: 'utf8' });
  const user = Number(/^user\s+([\d.]+)/m.exec(t.stderr)?.[1]);
  const sys = Number(/^sys\s+([\d.]+)/m.exec(t.stderr)?.[1]);
  const perMinute = osa * (user + sys);
  const share = perMinute / 60;
  check('the governor costs under 2% of one core', Number.isFinite(share) && share < 0.02, `one osascript ${(user + sys).toFixed(3)} s CPU (user ${user}, sys ${sys}) × ${osa}/min = ${(share * 100).toFixed(2)}% of one core`);
}

const scratch = mkdtempSync(join(tmpdir(), 'verify-thermal-'));
try {
  await governorRun(scratch);
  await overhead(scratch);
} catch (e) {
  failed++;
  console.log(`  ✗ crashed: ${(e as Error).stack}`);
} finally {
  cleanup();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
