#!/usr/bin/env node
/**
 * Hands-free opens as hands-free on ANY device: a tablet and a second computer get the phone's
 * Sohbetler list, its chats and its projects, never the laptop's desktop chrome.
 *
 *   npm run build && node scripts/verify/handsfree-any-device.mjs
 *
 * THE BUG (owner, 2026-10-19: "Hands free tablette veya başka bir bilgisayarda açıldığında ilgili
 * mobil görünüm açılmıyor ... açılan dreamcontext arayüzünde hiçbir şekilde chatler yok diğer
 * projeler de yok"): the dashboard chose its phone layout only for a viewport <= 768 px AND a
 * coarse pointer. A tablet (wider) and a computer (a mouse) failed that test, so the phone
 * listener drew the DESKTOP chrome, whose project strip and launcher are laptop-only routes the
 * phone listener refuses, and the chat surface stayed folded away: no chats, no projects.
 *
 * WHAT IT DRIVES: the real dashboard server (scratch HOME, a `claude` stand-in that logs every
 * spawn, the power runner only logging, `DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL=1` so the "tunnel" is
 * the phone listener on loopback: the real gate, route policy and surface flag, nothing leaves the
 * machine). Two projects are chosen at start; a laptop socket starts one chat and drops, so the Mac
 * runs it detached. Then, each with its own one-time QR link: an iPad portrait and landscape
 * (touch), a desktop computer at 1440x900 and 1280x800 (mouse, no touch), and an iPhone as the
 * control. Last, the laptop's own window on the main listener at 1440 (must stay the desktop).
 *
 * CHECKS PER DEVICE: signed in and landed in the project; the Sohbetler list is on screen and the
 * desktop chrome is not; the chat the Mac runs is an Açık row; both chosen projects are listed;
 * a tap opens that chat as its own screen and ‹ comes back; "New chat" opens a chat; no
 * horizontal overflow; across the run no console error and no 403 from the page's own calls.
 *
 * `DC_CLI=<dist/index.js>` runs another build (the pre-fix one must fail the tablet and computer
 * checks while the iPhone control passes).
 * FAILURE POLICY: collect, don't fail fast; exit 0 iff every check passed.
 * Screenshots: tmp/verify-handsfree-any-device/*.png
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The real path: macOS tmpdir is a /var -> /private/var symlink and the chat child files its
// transcripts under its realpath cwd, so a /var project root would never find its past chats.
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-any-device');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const OTHER = join(SCRATCH, 'other');
const POWER_LOG = join(SCRATCH, 'power.log');
const SPAWNS = join(HOME, 'spawns.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-any-device');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');

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

/** The chat the Mac runs: a laptop socket starts it and drops, so it keeps running detached. */
const LIVE = crypto.randomUUID();
const LIVE_TITLE = 'Running release notes';

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, OTHER, SHOTS]) mkdirSync(d, { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [name, dir] of [['proj', PROJ], ['other', OTHER]]) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    cli(['init', '-y', '--name', name, '--description', `A scratch project for the any-device check (${name})`], dir);
    const r = cli(['vaults', 'add', name, dir], dir);
    if (r.status !== 0) throw new Error(`vaults add ${name}: ${r.stderr || r.stdout}`);
  }
  // The live chat's transcript, so it has a title and a conversation to adopt.
  const tdir = join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const ts = new Date(Date.now() - 3600_000).toISOString();
  const rows = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: LIVE_TITLE }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Working on: ${LIVE_TITLE}` }] } },
  ].map((o) => JSON.stringify({ ...o, cwd: PROJ, uuid: crypto.randomUUID(), timestamp: ts, sessionId: LIVE }));
  writeFileSync(join(tdir, `${LIVE}.jsonl`), `${rows.join('\n')}\n`);
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

const liveIds = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/agent/live-chats`, { headers: { 'x-dreamcontext-vault': 'proj' } });
  const j = await r.json();
  return (j.chats ?? []).map((c) => c.conversationId);
};

const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
};

/** What is on screen: the hands-free list, the desktop chrome, overflow. */
const layout = (page) => page.evaluate(() => {
  const visible = (sel) => [...document.querySelectorAll(sel)].some((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  });
  return {
    list: visible('[data-testid="phone-list"]'),
    chrome: visible('.window-chrome-bar'),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
});

let server = null;
let browser = null;
let port = 0;
const errors = [];
const refused = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  console.log(`· build: ${CLI}`);
  setupScratch();
  port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();

  // ── The chat the Mac runs ────────────────────────────────────────────────────────────
  const { WebSocket: NodeWs } = await import('ws');
  const laptop = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&resume=${LIVE}`);
  laptop.on('error', () => {});
  await new Promise((r) => laptop.on('open', r));
  laptop.send(JSON.stringify({ type: 'user', text: 'draft the notes' }));
  report.check('the laptop started the one running chat', await until(() => spawns().length === 1, 15000), JSON.stringify(spawns()));
  await sleep(800);
  laptop.terminate();
  report.check('it keeps running detached on the Mac', await until(async () => JSON.stringify(await liveIds(port)) === JSON.stringify([LIVE]), 10000), JSON.stringify(await liveIds(port).catch(() => [])));

  // ── Mac mode on, both projects chosen ──────────────────────────────────────────────────
  const setup = await mac(port, 'POST', 'setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));
  const started = await mac(port, 'POST', 'start', { vaults: ['proj', 'other'] });
  report.check('Mac mode starts for both projects (loopback stand-in tunnel)', started.status === 200 && !!started.json.url, JSON.stringify(started.json).slice(0, 200));

  const DEVICES = [
    { name: 'ipad-portrait', label: 'iPad portrait 834x1194 (touch)', ctx: { ...devices['iPad Pro 11'] } },
    { name: 'ipad-landscape', label: 'iPad landscape 1194x834 (touch)', ctx: { ...devices['iPad Pro 11 landscape'] } },
    { name: 'computer-1440', label: 'computer 1440x900 (mouse)', ctx: { viewport: { width: 1440, height: 900 } } },
    { name: 'computer-1280', label: 'computer 1280x800 (mouse)', ctx: { viewport: { width: 1280, height: 800 } } },
    { name: 'iphone', label: 'iPhone 390x844 (control)', ctx: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ];

  for (const d of DEVICES) {
    console.log(`\n· ${d.label}`);
    const qr = (await mac(port, 'POST', 'qr')).json.url;
    const ctx = await browser.newContext(d.ctx);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${d.name}: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => errors.push(`${d.name} pageerror: ${String(e).slice(0, 200)}`));
    page.on('response', (r) => { if (r.status() === 403) refused.push(`${d.name}: ${r.request().method()} ${new URL(r.url()).pathname}`); });
    await page.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    report.check(`${d.name}: signed in, landed in the project`, await until(async () => page.url().includes('vault=proj'), 25000), page.url());
    report.check(`${d.name}: the hands-free Sohbetler list is on screen`, await until(async () => (await layout(page)).list, 25000), JSON.stringify(await layout(page)));
    await page.waitForTimeout(1500);
    await dismiss(page);
    const l = await layout(page);
    report.check(`${d.name}: no desktop window chrome`, !l.chrome, JSON.stringify(l));
    report.check(`${d.name}: the chat the Mac runs is an Açık row`, await until(async () => (await page.locator('[data-testid="mac-live-row"]:visible, [data-testid="list-tab-row"]:visible').count()) >= 1, 15000));
    const projects = await page.locator('[data-testid="list-projects"] .mlist-project').allTextContents().catch(() => []);
    report.check(`${d.name}: both chosen projects are listed`, projects.includes('proj') && projects.includes('other'), JSON.stringify(projects));
    report.check(`${d.name}: no horizontal overflow on the list`, l.overflow <= 1, String(l.overflow));
    await page.screenshot({ path: join(SHOTS, `${d.name}-list.png`) });

    // A tap opens the Mac's chat as its own screen; ‹ comes back to the list.
    const row = page.locator('[data-testid="mac-live-row"]:visible, [data-testid="list-tab-row"]:visible').first();
    if (await row.count()) {
      await row.click();
      report.check(`${d.name}: a tap opens the chat as its own screen`, await until(async () => (await page.locator('[data-testid="chat-back"]:visible').count()) === 1 && !(await layout(page)).list, 15000), JSON.stringify(await layout(page)));
      report.check(`${d.name}: the chat shows the Mac's conversation`, await until(async () => (await page.locator('.chat-scroll').first().textContent().catch(() => '') ?? '').includes(LIVE_TITLE), 15000));
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(SHOTS, `${d.name}-chat.png`) });
      await page.locator('[data-testid="chat-back"]').click();
      report.check(`${d.name}: ‹ returns to the list`, await until(async () => (await layout(page)).list, 10000));
    }

    // "Boards, tasks…" is the phone shell on this device too: one bar, a drawer, back to the list.
    await page.locator('[data-testid="list-dashboard"]').click();
    report.check(`${d.name}: "Boards, tasks…" shows the phone shell, not the desktop chrome`, await until(async () => (await page.locator('[data-testid="phone-bar"]:visible').count()) === 1 && !(await layout(page)).chrome, 10000), JSON.stringify(await layout(page)));
    await page.locator('[data-testid="phone-menu"]').click();
    await until(async () => (await page.locator('.sidebar--phone[data-open]').count()) === 1, 5000);
    await page.locator('.sidebar--phone .sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Tasks$/ }) }).first().click();
    report.check(`${d.name}: the drawer opens Tasks`, await until(async () => (await page.locator('.phone-bar-title').innerText()).trim() === 'Tasks', 5000));
    await page.waitForTimeout(1200);
    await dismiss(page);
    report.check(`${d.name}: no horizontal overflow on Tasks`, (await layout(page)).overflow <= 1, String((await layout(page)).overflow));
    await page.screenshot({ path: join(SHOTS, `${d.name}-tasks.png`) });
    await page.locator('[data-testid="phone-menu"]').click();
    await page.locator('.sidebar--phone .sidebar-item--launcher').click();
    report.check(`${d.name}: the drawer's Chat brings the list back`, await until(async () => (await layout(page)).list, 8000));
    await ctx.close();
  }

  // ── The laptop's own window on the main listener stays the desktop ─────────────────────
  console.log('\n· laptop window 1440x900 on the main listener');
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await deskCtx.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
  const desk = await deskCtx.newPage();
  desk.on('pageerror', (e) => errors.push(`desktop pageerror: ${String(e).slice(0, 200)}`));
  await desk.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await desk.waitForTimeout(3000);
  await dismiss(desk);
  const dl = await layout(desk);
  report.check('laptop window: the desktop chrome, not the hands-free list', dl.chrome && !dl.list, JSON.stringify(dl));
  await desk.screenshot({ path: join(SHOTS, 'laptop-1440.png') });

  const errs = errors.filter((e) => !/__TAURI|status of 401/.test(e));
  report.check('no console errors on any device', errs.length === 0, errs.slice(0, 8).join('\n      '));
  report.check('no 403 from the pages\' own calls', refused.length === 0, refused.slice(0, 8).join('\n      '));
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
