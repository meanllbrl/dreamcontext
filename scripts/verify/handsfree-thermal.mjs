#!/usr/bin/env node
/**
 * Hands-free thermal governor — real-process verify.
 *
 * TWO MODES
 *
 *   --observe [--minutes 10] [--every 5] [--load "<shell command>"]
 *     The premise probe (task AC0). Reads the REAL macOS thermalState every few seconds while a
 *     load runs, prints every reading, and exits 0 only when the state left `nominal` at least
 *     once. Exit 3 = it never left nominal: the governor would never act on this machine under
 *     this load, so the run stops and the owner is offered a lid-closed re-run first.
 *
 *   (default)
 *     Drives the REAL governor (src/lib/handsfree/mac/thermal.ts, loaded through tsx) against
 *     REAL processes with real `ps` and real `taskpolicy`. Only the thermal READING is fake (a
 *     scripted sequence through the reader seam), and the governor's `filter` seam limits it to
 *     this script's own burner pids, so nothing else on the machine is ever touched (asserted).
 *     Then the overhead check: 60 s of nominal readings, spawns counted through the run seam.
 *
 * Every burner is released in `finally` and on SIGINT/SIGTERM, whatever happened.
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const STATES = ['nominal', 'fair', 'serious', 'critical'];
const OSA = ['-l', 'JavaScript', '-e', 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState'];

function readThermalOnce() {
  const r = spawnSync('/usr/bin/osascript', OSA, { encoding: 'utf-8', timeout: 3000 });
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isInteger(n) && n >= 0 && n <= 3 ? STATES[n] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── --observe ────────────────────────────────────────────────────────────────

async function observe() {
  const minutes = Number(opt('--minutes', '10'));
  const everySec = Number(opt('--every', '5'));
  const loadCmd = opt('--load', null);
  const t0 = Date.now();
  let load = null;
  let loadExit = null;
  if (loadCmd) {
    load = spawn('/bin/sh', ['-c', loadCmd], { cwd: REPO, stdio: ['ignore', 'ignore', 'ignore'], detached: true, env: { ...process.env, CI: '1' } });
    load.on('exit', (code) => { loadExit = code; console.log(`[load] exited ${code} after ${((Date.now() - t0) / 1000).toFixed(0)} s`); });
    console.log(`[load] started pid ${load.pid}: ${loadCmd}`);
  }
  const stopLoad = () => { if (load && loadExit === null) { try { process.kill(-load.pid, 'SIGTERM'); } catch { /* gone */ } } };
  process.on('SIGINT', () => { stopLoad(); process.exit(130); });
  process.on('SIGTERM', () => { stopLoad(); process.exit(143); });

  const counts = Object.fromEntries([...STATES, 'null'].map((s) => [s, 0]));
  let firstHot = null;
  const end = t0 + minutes * 60_000;
  while (Date.now() < end) {
    const s = readThermalOnce();
    counts[s ?? 'null'] += 1;
    const at = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
    const load1 = spawnSync('/usr/sbin/sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf-8' }).stdout.trim().replace(/[{}]/g, '').trim().split(/\s+/)[0];
    console.log(`t=${at}s thermal=${s ?? 'null'} load1=${load1}`);
    if (s && s !== 'nominal' && firstHot === null) firstHot = at.trim();
    await sleep(everySec * 1000);
  }
  stopLoad();
  console.log(`SUMMARY readings ${JSON.stringify(counts)}; first non-nominal at ${firstHot === null ? 'never' : `t=${firstHot}s`}`);
  if (firstHot === null) {
    console.log('PREMISE NOT SHOWN: thermalState never left nominal under this load.');
    process.exit(3);
  }
  console.log('PREMISE SHOWN: thermalState left nominal under load.');
}

if (flag('--observe')) {
  await observe();
} else {
  // The default (real governor) mode lives in a sibling file, run under tsx so it can import
  // the TypeScript source directly (there is no dist export for the governor).
  const r = spawnSync('npx', ['tsx', join(REPO, 'scripts/verify/handsfree-thermal.real.ts'), ...argv], { cwd: REPO, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
