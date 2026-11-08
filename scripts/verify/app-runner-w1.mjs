#!/usr/bin/env node
/**
 * W1 gate driver for the dreamcontext App runner (dreamcontext-apps plan r19, W1 KANIT).
 * Runs the REAL runner binary in a REAL ad-hoc app bundle on this Mac against
 * fixtures/fake-desktop-server.mjs and fixtures/fake-shell.app, under a scratch HOME.
 *
 * Proves, without GUI access (no Accessibility / Screen Recording needed):
 *   A cold open with no shell: the runner opens the shell in the background and connects
 *   B single instance: a second `open` keeps one process and opens no second connection
 *   C its own Dock identity (lsappinfo: name, bundle id, Foreground)
 *   D snapshot of the visible page (PNG), then with the window behind another app
 *   E theme pushed by the server reaches the page (data-theme) and the window
 *   F a rev bump reloads the visible page
 *   G dcRunner.copy puts Turkish text on the OS pasteboard intact
 *   H a download lands in ~/Downloads with its basename
 *   I a long confirm() does not stop the heartbeat
 *   J stopped → running resumes with a fresh launch-window
 *   K server gone, shell alive: no `open`; a new server on a new port is joined by itself
 *   L shell + server gone: the window does not bring the shell back; a new shell is joined
 *   M stale file + no shell at first open: the runner opens the shell and connects
 *   N stale file + live shell at first open: no `open`, ends on "reopen dreamcontext"
 * Everything that needs a hand on the keyboard is left to the owner's checklist.
 *
 *   node scripts/verify/app-runner-w1.mjs [--keep]
 *   node scripts/verify/app-runner-w1.mjs --manual   (opens the window and waits for the
 *        owner: type stop | start | rev | dark | light | system | kill | serve | q)
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const W = join(root, 'tmp', 'w1');
const HOME = join(W, 'home');
const SHOTS = join(W, 'shots');
const SHELL_ID = 'com.dreamcontext.fakeshell';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const trySh = (cmd, args) => { try { return sh(cmd, args); } catch (e) { return String(e.stdout || ''); } };

function record(id, ok, evidence) {
  results.push({ id, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
}

async function waitFor(fn, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

function req(port, method, path, timeout = 15000) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end();
  });
}

const serverFile = () => {
  try { return JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'desktop-server.json'), 'utf-8')); } catch { return null; }
};
const fakeLog = async (port = serverFile()?.port) => (port ? req(port, 'GET', '/__fake/log') : null);
const pids = (pattern) => trySh('/usr/bin/pgrep', ['-f', pattern]).split('\n').filter(Boolean).map(Number);
let BUNDLE = '';
const runnerPids = () => pids(`${BUNDLE}/Contents/MacOS/app-runner`);
const shellPids = () => pids('fake-shell.app/Contents/MacOS/applet');

function openRunner() {
  sh('/usr/bin/open', ['--env', `HOME=${HOME}`, '--stderr', join(W, 'runner.log'), BUNDLE]);
}
function killRunner() {
  for (const p of runnerPids()) { try { process.kill(p, 'SIGKILL'); } catch {} }
}
function killShell() {
  for (const p of shellPids()) { try { process.kill(p, 'SIGKILL'); } catch {} }
  const pidFile = join(HOME, 'fake-shell-server.pid');
  if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf-8')), 'SIGKILL'); } catch {} rmSync(pidFile, { force: true }); }
}
function startShell() {
  sh('/usr/bin/open', ['-g', join(W, 'fake-shell.app')]);
}
const direct = [];
function startServerDirect(extra = []) {
  const child = spawn(process.execPath, [join(root, 'scripts/verify/fixtures/fake-desktop-server.mjs'), '--home', HOME, '--app-bundle-id', SHELL_ID, '--shots', SHOTS, ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  direct.push(child);
  return new Promise((resolve) => child.stdout.once('data', (d) => resolve({ child, ...JSON.parse(String(d).split('\n')[0]) })));
}
function killAllServers() {
  for (const c of direct.splice(0)) { try { c.kill('SIGKILL'); } catch {} }
  killShell();
}

async function snapshot(name, port = serverFile()?.port) {
  const r = await req(port, 'POST', '/__fake/snapshot', 15000);
  if (r?.file) {
    const dest = join(SHOTS, `${name}.png`);
    copyFileSync(r.file, dest);
    return { file: dest, bytes: r.bytes };
  }
  return r;
}

function appInfo() {
  const asns = trySh('/usr/bin/lsappinfo', ['find', `bundlepath=${BUNDLE}`]).trim().split(/\s+/).filter(Boolean);
  return asns.map((a) => trySh('/usr/bin/lsappinfo', ['info', a]).split('\n').slice(0, 5).join(' ').trim());
}

// ─── Setup ────────────────────────────────────────────────────────────────────
async function setup() {
  killRunner();
  killShell();
  rmSync(W, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(HOME, 'Downloads'), { recursive: true });
  sh('cargo', ['build', '--release', '--offline', '--target', 'aarch64-apple-darwin'], {
    cwd: join(root, 'desktop/app-runner'),
    env: { ...process.env, CARGO_TARGET_DIR: join(root, 'desktop/src-tauri/target/app-runner') },
  });
  const runner = join(root, 'desktop/src-tauri/target/app-runner/aarch64-apple-darwin/release/app-runner');
  sh(process.execPath, [join(root, 'scripts/verify/fixtures/fake-shell.mjs'), '--out', W, '--home', HOME, '--bundle-id', SHELL_ID, '--server-args', `--shots ${SHOTS}`]);
  const made = JSON.parse(sh(process.execPath, [join(root, 'scripts/dev/make-app-bundle.mjs'), '--runner', runner, '--home', HOME, '--project', HOME, '--vault', 'demo', '--slug', 'fixture-app', '--name', 'Fixture App', '--app-bundle-id', SHELL_ID]));
  BUNDLE = made.path;
  console.log(`bundle ${BUNDLE}`);
}

// ─── Scenarios ────────────────────────────────────────────────────────────────
async function manual() {
  await setup();
  openRunner();
  await waitFor(async () => (await fakeLog())?.beats > 0, 30000);
  console.log(`
The "Fixture App" window is open (its own Dock icon). Try, by hand:
  confirm() OK and İptal · prompt() · copy the Turkish text with Cmd-C, paste with Cmd-V
  file picker · "download rapor.csv" (lands in ${join(HOME, 'Downloads')}) · external link opens the browser
  Cmd-W, then: open "${BUNDLE}"  → a new window
  minimize, then click the Dock icon → the window comes back
  type "stop" here → "Durduruldu" screen → click Başlat → the app comes back
  type "kill" → "Dreamcontext kapandı" after ~6 s; type "serve" → it reconnects by itself
Commands: stop | start | rev | dark | light | system | kill | serve | q
`);
  const rl = (await import('node:readline')).createInterface({ input: process.stdin });
  for await (const line of rl) {
    const cmd = line.trim();
    const port = serverFile()?.port;
    if (cmd === 'q') break;
    if (cmd === 'stop' || cmd === 'start') await req(port, 'POST', `/__fake/state?s=${cmd === 'stop' ? 'stopped' : 'running'}`);
    else if (cmd === 'rev') await req(port, 'POST', '/__fake/rev');
    else if (['dark', 'light', 'system'].includes(cmd)) await req(port, 'POST', `/__fake/theme?t=${cmd}`);
    else if (cmd === 'kill') { if (port) await req(port, 'POST', '/__fake/exit'); }
    else if (cmd === 'serve') { const s = await startServerDirect(); console.log(`server on ${s.port}`); continue; }
    else { console.log('?'); continue; }
    console.log('ok');
  }
  killRunner();
  killAllServers();
  process.exit(0);
}

async function main() {
  if (process.argv.includes('--manual')) return manual();
  await setup();
  const clipBefore = trySh('/usr/bin/pbpaste', []);

  // A: cold open, nothing running → the runner starts the shell, the shell's server is joined.
  openRunner();
  const shellUp = await waitFor(() => shellPids().length > 0, 15000);
  const joined = await waitFor(async () => { const l = await fakeLog(); return l && l.beats > 0 && l; }, 30000);
  record('A cold open starts the shell in the background and connects', !!(shellUp && joined), { shellUp: !!shellUp, beats: joined?.beats, events: joined?.log?.slice(0, 4).map((e) => e.ev) });

  // C: own Dock identity.
  const info = appInfo();
  record('C own Dock app (name, bundle id, Foreground)', info.length === 1 && /^"Fixture App"/.test(info[0]) && /bundleID="com\.dreamcontext\.app\./.test(info[0]) && /type="Foreground"/.test(info[0]), info);

  // B: single instance.
  const before = (await fakeLog()).log.filter((e) => e.ev === 'launch-window').length;
  openRunner();
  await sleep(2500);
  const after = (await fakeLog()).log.filter((e) => e.ev === 'launch-window').length;
  record('B second open keeps one process, no second connection', runnerPids().length === 1 && after === before, { pids: runnerPids(), launchWindows: [before, after] });

  // D: snapshot of the visible page.
  const shot1 = await snapshot('d-visible');
  record('D snapshot of the visible window', !!shot1?.file, shot1);

  // E: theme.
  const port = serverFile().port;
  await req(port, 'POST', '/__fake/theme?t=dark');
  await sleep(3500);
  const shotDark = await snapshot('e-dark');
  await req(port, 'POST', '/__fake/theme?t=light');
  await sleep(3500);
  const shotLight = await snapshot('e-light');
  record('E server theme reaches the page (see e-dark.png / e-light.png)', !!(shotDark?.file && shotLight?.file), { shotDark, shotLight });

  // F: rev bump reloads the visible page.
  const pagesBefore = (await fakeLog()).pages;
  await req(port, 'POST', '/__fake/rev');
  const reloaded = await waitFor(async () => (await fakeLog()).pages > pagesBefore, 6000);
  const shotRev = await snapshot('f-rev2');
  record('F rev bump reloads the visible page within ~3 s', !!reloaded, { pagesBefore, shotRev });

  // G: copy → OS pasteboard, Turkish intact.
  await req(port, 'POST', '/__fake/action?a=copy');
  const want = 'Türkçe: ŞşĞğÜüİıÖöÇç — kopyala bunu';
  const pasted = await waitFor(() => { const v = trySh('/usr/bin/pbpaste', []); return v === want ? v : null; }, 5000);
  record('G dcRunner.copy writes Turkish to the pasteboard intact', !!pasted, { got: trySh('/usr/bin/pbpaste', []) });
  try { execFileSync('/usr/bin/pbcopy', [], { input: clipBefore }); } catch {}

  // H: download → ~/Downloads/rapor.csv.
  await req(port, 'POST', '/__fake/action?a=download');
  const dl = await waitFor(() => existsSync(join(HOME, 'Downloads', 'rapor.csv')), 8000);
  record('H download lands in ~/Downloads by basename', !!dl, { files: readdirSync(join(HOME, 'Downloads')), content: dl ? readFileSync(join(HOME, 'Downloads', 'rapor.csv'), 'utf-8') : null });

  // D2: window behind another app.
  trySh('/usr/bin/open', ['-a', 'Finder']);
  await sleep(1500);
  const shotBehind = await snapshot('d-behind');
  record('D2 snapshot with the window behind another app', !!shotBehind?.file, shotBehind);

  // J: stopped → running resumes with a fresh launch-window.
  const lwBefore = (await fakeLog()).log.filter((e) => e.ev === 'launch-window').length;
  await req(port, 'POST', '/__fake/state?s=stopped');
  await sleep(3000);
  const stoppedShot = await snapshot('j-stopped');
  await req(port, 'POST', '/__fake/state?s=running');
  const resumed = await waitFor(async () => (await fakeLog()).log.filter((e) => e.ev === 'launch-window').length > lwBefore, 8000);
  const shotResumed = await snapshot('j-resumed');
  record('J stopped screen (no app snapshot) then running resumes with a new launch-window', !!(resumed && stoppedShot?.error && shotResumed?.file), { stoppedShot, shotResumed });

  // K: server gone, shell alive → no open; a new server is joined by itself.
  const shellCount = shellPids().length;
  await req(port, 'POST', '/__fake/exit');
  // The shell applet's own server is gone; the shell stays up (pid unchanged).
  await sleep(9000);
  const noOpen = shellPids().length === shellCount;
  const srv2 = await startServerDirect();
  const rejoined = await waitFor(async () => { const l = await req(srv2.port, 'GET', '/__fake/log'); return l && l.beats > 0 && l; }, 15000);
  record('K server gone + shell alive: no open; new server on a new port joined by itself', !!(noOpen && rejoined && srv2.port !== port), { oldPort: port, newPort: srv2.port, shells: [shellCount, shellPids().length], beats: rejoined?.beats });

  // I: a long confirm() does not stop the heartbeat (the modal stays up; the runner is killed after).
  await req(srv2.port, 'POST', '/__fake/action?a=confirm');
  await sleep(2000);
  const b1 = (await req(srv2.port, 'GET', '/__fake/log')).beats;
  await sleep(8000);
  const b2 = (await req(srv2.port, 'GET', '/__fake/log')).beats;
  record('I heartbeats continue while a confirm() is open', b2 - b1 >= 3, { beatsDuring8s: b2 - b1 });

  // L: shell AND server gone → the window never brings the shell back; a new shell is joined.
  killRunner();
  killAllServers();
  await sleep(500);
  startShell();
  await waitFor(() => serverFile(), 10000);
  openRunner();
  await waitFor(async () => (await fakeLog())?.beats > 0, 20000);
  const lPort = serverFile().port;
  killShell(); // kills the applet and its server: both gone
  await sleep(20000);
  const stayedDown = shellPids().length === 0 && runnerPids().length === 1;
  startShell();
  const lJoined = await waitFor(async () => { const f = serverFile(); if (!f || f.port === lPort) return null; const l = await req(f.port, 'GET', '/__fake/log'); return l && l.beats > 0 && l; }, 20000);
  record('L shell + server gone: the window does not relaunch the shell; a new shell is joined', !!(stayedDown && lJoined), { stayedDown, newPort: serverFile()?.port, beats: lJoined?.beats });

  // M: stale file (dead port, reused-looking pid) + no shell at FIRST open → open shell, connect.
  killRunner();
  killShell();
  writeFileSync(join(HOME, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: process.pid, port: 9, launchToken: 'x'.repeat(43), appBundleId: SHELL_ID }), { mode: 0o600 });
  openRunner();
  const mUp = await waitFor(() => shellPids().length > 0, 15000);
  const mJoined = await waitFor(async () => { const f = serverFile(); if (!f || f.port === 9) return null; const l = await req(f.port, 'GET', '/__fake/log'); return l && l.beats > 0 && l; }, 30000);
  record('M stale file + no shell at first open: shell opened, connected', !!(mUp && mJoined), { shellUp: !!mUp, beats: mJoined?.beats });

  // N: stale file + live shell at first open → no open; ends on "reopen dreamcontext".
  killRunner();
  const pidFile = join(HOME, 'fake-shell-server.pid');
  try { process.kill(Number(readFileSync(pidFile, 'utf-8')), 'SIGKILL'); } catch {}
  await sleep(500);
  writeFileSync(join(HOME, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: 1, port: 9, launchToken: 'x'.repeat(43), appBundleId: SHELL_ID }), { mode: 0o600 });
  const shellsN = shellPids();
  openRunner();
  await sleep(24000);
  record('N stale file + live shell at first open: no open, shell untouched', JSON.stringify(shellPids()) === JSON.stringify(shellsN) && runnerPids().length === 1, { shells: [shellsN, shellPids()] });

  // Clean up.
  if (!process.argv.includes('--keep')) {
    killRunner();
    killAllServers();
  }
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(W, 'report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} passed; shots in ${SHOTS}; report ${join(W, 'report.json')}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  killRunner();
  killAllServers();
  process.exit(2);
});
