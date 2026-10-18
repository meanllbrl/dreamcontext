#!/usr/bin/env node
/**
 * Hands-free: a chat opened on the phone lands on the desktop when Mac mode ends.
 *
 *   npm run build && node scripts/verify/handsfree-return-tabs.mjs
 *
 * THE BUG (owner, 2026-10-18: "Hands free modu telefonda açtığım session hands free kapanınca
 * bilgisayara düşmüyor"): the phone keeps its own roster (`.agent-sessions.phone.json`) while Mac
 * mode is on, and Return never moved it into the desktop's, so a chat started on the phone had no
 * tab on the desktop afterwards. The desktop window also only noticed a Return its own sheet sent.
 *
 * WHAT IT DRIVES: the real dashboard server (scratch HOME, a `claude` stand-in that logs every
 * spawn, the power runner only logging, `DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL=1` so the "tunnel" is
 * the phone listener on loopback: nothing leaves the machine). A desktop window (Chromium with the
 * Tauri marker) holds one chat; a Chromium phone signs in with the one-time QR link and opens a new
 * chat. Return is pressed from the CLI (`dreamcontext handsfree mac stop`), NOT the desktop sheet.
 *
 * CHECKS: before Return the desktop roster lacks the phone's chat; after it the desktop roster holds
 * it (as Auto) and the phone's roster no longer does; the open desktop window shows its tab and
 * attaches to it by itself; the Mac started no second `claude` for it (the detached child was
 * adopted); the desktop's own chat is still there.
 *
 * `DC_CLI=<dist/index.js>` runs another build (the pre-fix one must fail the landing checks).
 * FAILURE POLICY: collect, don't fail fast; exit 0 iff every check passed.
 * Screenshots: tmp/verify-handsfree-return-tabs/*.png
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-return-tabs');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const POWER_LOG = join(SCRATCH, 'power.log');
const SPAWNS = join(HOME, 'spawns.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-return-tabs');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');
const STATE = join(PROJ, '_dream_context', 'state');
const DESK_ROSTER = join(STATE, '.agent-sessions.json');
const PHONE_ROSTER = join(STATE, '.agent-sessions.phone.json');

const STANDIN = `#!${process.execPath}
/** Inert stand-in for \`claude -p --input-format stream-json\` that logs every spawn. */
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
fs.appendFileSync(path.join(process.env.HOME, 'spawns.log'), JSON.stringify({ pid: process.pid, sid, resume: !!at('--resume') }) + '\\n');
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ECHO ' + text }] };
    row({ type: 'assistant', message }); out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ECHO', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** Every chat socket a page opens, by URL (a tab's socket names its conversation). */
const SOCKETS = `(() => {
  const Real = window.WebSocket;
  window.__chatUrls = [];
  window.WebSocket = class extends Real {
    constructor(url, protocols) { super(url, protocols); if (String(url).includes('/api/agent/chat')) window.__chatUrls.push(String(url)); }
  };
})();`;

const report = {
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
const spawns = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const rosterOf = (file) => { try { return JSON.parse(readFileSync(file, 'utf-8')).sessions ?? []; } catch { return null; } };
const rosterIds = (file) => (rosterOf(file) ?? []).map((m) => m.sessionId);

const DESK = crypto.randomUUID();
const DESK_TITLE = 'Desktop invoice export';

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the Return tabs check']);
  const r = cli(['vaults', 'add', 'proj', PROJ]);
  if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
  // The desktop window's own chat, restored (and resumed) when the window opens.
  writeFileSync(DESK_ROSTER, JSON.stringify({
    sessions: [{ title: DESK_TITLE, bypass: false, minimized: false, size: 1, sessionId: DESK, kind: 'chat', pane: 0, active: true }],
    activePane: 0, chatPermissionMode: 'auto',
  }, null, 2));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: POWER_LOG, DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`[server] ${s}`); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function mac(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
};

let server = null;
let browser = null;
let port = 0;
const errors = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  console.log(`· build: ${CLI}`);
  setupScratch();
  port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();

  // ── The desktop window, with its one chat ─────────────────────────────────────────
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await deskCtx.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
  await deskCtx.addInitScript(SOCKETS);
  const desk = await deskCtx.newPage();
  desk.on('pageerror', (e) => errors.push(`desktop pageerror: ${String(e).slice(0, 200)}`));
  await desk.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  const deskSockets = () => desk.evaluate(() => window.__chatUrls ?? []);
  report.check('the desktop window restores its own chat', await until(async () => (await deskSockets()).some((u) => u.includes(DESK)), 25000), JSON.stringify(await deskSockets().catch(() => [])));
  await dismiss(desk);

  // ── Mac mode on, the phone opens a new chat ───────────────────────────────────────
  const setup = await mac(port, 'POST', 'setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));
  const started = await mac(port, 'POST', 'start', { vaults: ['proj'] });
  report.check('Mac mode starts for the project (loopback stand-in tunnel)', started.status === 200 && !!started.json.url, JSON.stringify(started.json).slice(0, 200));
  const qr = (await mac(port, 'POST', 'qr')).json.url;
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => errors.push(`phone pageerror: ${String(e).slice(0, 200)}`));
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('the phone signs in and lands in the project', await until(async () => phone.url().includes('vault=proj'), 25000), phone.url());
  report.check('the phone opens on the Sohbetler list', await until(async () => (await phone.locator('[data-testid="phone-list"]:visible').count()) === 1, 25000));
  await phone.waitForTimeout(2500);
  await dismiss(phone);
  const before = spawns().length;
  await phone.locator('[data-testid="list-new"]').click();
  report.check('"New chat" on the phone starts one chat on the Mac', await until(() => spawns().length === before + 1, 15000), JSON.stringify(spawns().slice(before)));
  const PHONE = spawns()[before]?.sid;
  report.check('the phone\'s roster holds it', await until(() => rosterIds(PHONE_ROSTER).includes(PHONE), 10000), JSON.stringify(rosterOf(PHONE_ROSTER)));
  report.check('before Return the desktop roster does not', !rosterIds(DESK_ROSTER).includes(PHONE), JSON.stringify(rosterIds(DESK_ROSTER)));
  await phone.screenshot({ path: join(SHOTS, 'phone-390-new-chat.png') });
  // Mac mode was started over the API, so the window learns it is on at its next status poll
  // (30 s while off). A real run lasts far longer than that.
  report.check('the desktop window shows Mac mode on', await until(async () => (await desk.locator('[data-testid="hf-button"][data-phase="mac"]').count()) > 0, 40000));

  // ── Return from the CLI (not the desktop's sheet) ─────────────────────────────────
  const stop = cli(['handsfree', 'mac', 'stop']);
  report.check('Return from the CLI succeeds', stop.status === 0, (stop.stderr || stop.stdout).slice(0, 300));
  const landed = (rosterOf(DESK_ROSTER) ?? []).find((m) => m.sessionId === PHONE);
  report.check('the desktop roster now holds the phone\'s chat, as Auto, beside the desktop\'s own', !!landed && landed.bypass === false && rosterIds(DESK_ROSTER).includes(DESK), JSON.stringify(rosterOf(DESK_ROSTER)));
  report.check('the phone\'s roster no longer holds it', !rosterIds(PHONE_ROSTER).includes(PHONE), JSON.stringify(rosterOf(PHONE_ROSTER)));
  report.check('the open desktop window attaches to the phone\'s chat by itself', await until(async () => (await deskSockets()).some((u) => u.includes(PHONE)), 20000), JSON.stringify(await deskSockets()));
  const tabTitles = () => desk.evaluate(() => [...document.querySelectorAll('.agent-tab')].map((t) => (t.textContent ?? '').replace(/\s+/g, ' ').trim()));
  report.check('the desktop window shows two tabs: its own and the phone\'s', await until(async () => {
    const t = await tabTitles();
    return t.length >= 2 && t.some((x) => x.includes(DESK_TITLE));
  }, 10000), JSON.stringify(await tabTitles()));
  await desk.waitForTimeout(1500);
  const phoneSpawns = spawns().filter((s) => s.sid === PHONE);
  report.check('the Mac started no second claude for it (the detached child was adopted)', phoneSpawns.length === 1, JSON.stringify(phoneSpawns));
  await desk.screenshot({ path: join(SHOTS, 'desktop-1440-after-return.png') });

  const errs = errors.filter((e) => !/__TAURI/.test(e));
  report.check('no page errors', errs.length === 0, errs.slice(0, 8).join('\n      '));
  console.log(`\n  screenshots: ${SHOTS}`);
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  if (port) { try { await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/stop`, { method: 'POST' }); } catch { /* gone */ } }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
if (report.fails.length) { for (const f of report.fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
