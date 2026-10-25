#!/usr/bin/env node
/**
 * Hands-free on a PHONE while the Super Agent is handed over
 * (task hands-free-de-super-agent-aciksa-telefonda-yalniz-super-agent-sohbeti-gorunur, AC1-AC7).
 *
 *   npm run build && node scripts/verify/handsfree-super-phone.mjs
 *
 * WHAT IT DRIVES — the real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1, the power
 * runner that only LOGS) with Mac mode started over the loopback stand-in for cloudflared
 * (DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL=1: the address IS the phone listener, nothing leaves the
 * machine). The phone (Chromium, iPhone 13, 390x844, touch) signs in with the one-time QR link,
 * so every request it makes goes through the phone listener's route policy and every socket it
 * opens is a phone socket. The "window" is a laptop chat socket opened the way the desktop opens
 * the Super Agent's chat (`mode=super`, pin = the recorded session).
 *
 *   1. Super OFF: the Sohbetler list as before (search, chips, the Mac's running chat as a row).
 *   2. Super ON (POST /api/super/enable, the window's super socket live): ONE Super Agent row,
 *      no other chat of the project (the one list over every chosen project keeps its search and
 *      chips, hands-free sekmeler W3); the wire says the same.
 *   3. A tap opens it as a MIRROR: the window's socket is not closed, the phone's message reaches
 *      the Super Agent and its answer comes back; the owner's words show on the other surface.
 *   4. Super OFF again (take-back): the old list returns.
 *   Across the run: no console error, and no 403 on any request the phone made.
 *
 * FAILURE POLICY — collect, don't fail fast; exit 0 iff every check passed.
 * Screenshots: tmp/verify-handsfree-super-phone/*.png
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-super-phone');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-super-phone');
const CLI = join(REPO, 'dist', 'index.js');

/** Inert stand-in for `claude -p --input-format stream-json`: it echoes every user turn. */
const STANDIN = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
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
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text)[0] || '';
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    const said = text.startsWith('[super') ? 'Two chats are running; nothing needs you.' : 'ECHO ' + text;
    const message = { role: 'assistant', content: [{ type: 'text', text: said }] };
    row({ type: 'assistant', message }); out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
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

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  mkdirSync(join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the Super Agent phone check']);
  const r = cli(['vaults', 'add', 'proj', PROJ]);
  if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
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

async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'X-Dreamcontext-Vault': 'proj', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let server = null;
let browser = null;
const sockets = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  const { WebSocket: NodeWs } = await import('ws');
  console.log('· scratch vault, server, Mac mode over the loopback stand-in…');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const setup = await api(port, 'POST', '/api/handsfree/mac/setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));
  const started = await api(port, 'POST', '/api/handsfree/mac/start', { vaults: ['proj'] });
  report.check('Mac mode starts for the chosen project', started.status === 200 && JSON.stringify(started.json.exposedVaults) === '["proj"]', JSON.stringify(started.json).slice(0, 200));
  const qr = (await api(port, 'POST', '/api/handsfree/mac/qr')).json.url;
  report.check('a one-time sign-in link on the phone listener', typeof qr === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(qr) && !qr.includes(`:${port}/`), qr);

  /** A laptop chat socket, the way the desktop opens one. */
  const laptop = (q) => {
    const ws = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&${q}`);
    const s = { ws, frames: [], closed: null };
    ws.on('message', (d) => { try { s.frames.push(JSON.parse(String(d))); } catch { /* partial */ } });
    ws.on('close', (code) => { s.closed = code; });
    ws.on('error', () => {});
    sockets.push(s);
    return new Promise((resolve) => { ws.on('open', () => resolve(s)); ws.on('close', () => resolve(s)); });
  };

  // A chat running on the Mac, as any desktop tab: the old list shows it as a row.
  const MAC_ID = crypto.randomUUID();
  const plain = await laptop(`sessionId=${MAC_ID}`);
  await sleep(1000);
  plain.ws.send(JSON.stringify({ type: 'user', text: 'tidy the release notes' }));

  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  // The What's New popup would cover the list a few seconds in: seen already, like a returning owner.
  await markAnnouncementsSeen(ctx, `http://127.0.0.1:${port}`);
  const phone = await ctx.newPage();
  const errors = []; const forbidden = []; const phoneSockets = [];
  phone.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  phone.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  phone.on('response', (r) => { if (r.status() === 403) forbidden.push(`${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  phone.on('websocket', (w) => phoneSockets.push(w.url()));
  const vis = (sel) => phone.locator(`${sel}:visible`);
  const onList = async () => (await vis('[data-testid="phone-list"]').count()) === 1;
  const listShape = () => phone.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="phone-list"]')].find((e) => e.getBoundingClientRect().height > 0);
    return {
      super: el?.getAttribute('data-super') === 'true',
      rows: [...(el?.querySelectorAll('.mlist-row') ?? [])].map((r) => ({ kind: r.getAttribute('data-kind'), id: r.getAttribute('data-id'), text: (r.textContent || '').replace(/\s+/g, ' ').trim() })),
      search: !!el?.querySelector('[data-testid="list-search"]'),
      chips: !!el?.querySelector('[data-testid="list-filter-all"]'),
      newChat: !!el?.querySelector('[data-testid="list-new"]'),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  const wire = () => phone.evaluate(async () => (await fetch('/api/agent/live-chats', { credentials: 'same-origin', headers: { 'X-Dreamcontext-Vault': 'proj' } })).json());

  console.log('\n── 1. Super OFF: the old list');
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('signed in through the phone listener, landed in the project', await until(async () => phone.url().includes('vault=proj'), 25000), phone.url());
  report.check('the page is the Mac phone surface (its meta flag)', await until(() => phone.evaluate(() => document.querySelector('meta[name="dreamcontext-surface"]')?.getAttribute('content') === 'mac'), 10000));
  for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
  report.check('the phone opens on the Sohbetler list', await until(onList, 20000));
  let shape;
  report.check('super off: search, chips, New chat, and the Mac\'s running chat as a row', await until(async () => {
    shape = await listShape();
    return !shape.super && shape.search && shape.chips && shape.newChat && shape.rows.some((r) => r.id === MAC_ID);
  }, 20000), JSON.stringify(shape));
  const w0 = await wire();
  report.check('super off: the wire is today\'s (no supers field)', Array.isArray(w0.chats) && !('supers' in w0), JSON.stringify(w0).slice(0, 200));
  await phone.screenshot({ path: join(SHOTS, '390x844-super-off.png') });

  console.log('\n── 2. Super ON: one row');
  const en = await api(port, 'POST', '/api/super/enable', { adopt: [MAC_ID], titles: { [MAC_ID]: 'Release notes' } });
  const SUPER = en.json.session;
  report.check('the hand-over records a super session', en.status === 200 && typeof SUPER === 'string', JSON.stringify(en.json).slice(0, 200));
  const win = await laptop(`mode=super&sessionId=${SUPER}`);
  report.check('the window\'s Super Agent socket is open', win.closed === null);
  // The list is the ONE list over every chosen project (hands-free sekmeler W3): its search and
  // chips stay; the handed-over project contributes its one Super row and nothing else.
  report.check('super on: ONE row, the Super Agent; no New chat, no other chat (the one list keeps its search)', await until(async () => {
    shape = await listShape();
    return shape.super && shape.rows.length === 1 && shape.rows[0].kind === 'super' && shape.rows[0].id === SUPER
      && /Super Agent/.test(shape.rows[0].text) && shape.search && !shape.newChat && !shape.overflowX;
  }, 20000), JSON.stringify(shape));
  const w1 = await wire();
  report.check('super on: the wire lists no chat of the project and one live super row', Array.isArray(w1.chats) && w1.chats.length === 0
    && w1.supers?.length === 1 && w1.supers[0].conversationId === SUPER && w1.supers[0].live === true, JSON.stringify(w1).slice(0, 240));
  const rowH = await phone.evaluate(() => Math.round(document.querySelector('[data-testid="super-row"]')?.getBoundingClientRect().height ?? 0));
  report.check(`the row is a touch target (${rowH}px >= 44)`, rowH >= 44);
  await phone.screenshot({ path: join(SHOTS, '390x844-super-on.png') });

  console.log('\n── 3. A tap opens it as a mirror');
  await vis('[data-testid="super-row"]').click();
  report.check('the Super Agent\'s chat opens over the list', await until(async () => !(await onList()) && (await vis('.chat-cmp-input').count()) > 0, 15000));
  report.check('the phone\'s socket names the super session', await until(async () => phoneSockets.some((u) => u.includes(SUPER)), 10000), JSON.stringify(phoneSockets));
  await phone.waitForTimeout(1500);
  report.check('the window keeps its socket (never 4409, still open)', win.closed === null && win.ws.readyState === 1, String(win.closed));
  const box = vis('.chat-cmp-input').first();
  await box.click();
  await box.fill('what is running?');
  await phone.waitForTimeout(150);
  await phone.keyboard.press('Enter');
  const paneText = async () => (await vis('.chat-pane').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  report.check('the phone\'s message reaches the Super Agent and its answer comes back', await until(async () => (await paneText()).includes('ECHO what is running?'), 20000), (await paneText()).slice(-200));
  report.check('the window sees the owner\'s words (owner_echo) and the answer', await until(async () =>
    win.frames.some((f) => f.type === '_meta' && f.subtype === 'owner_echo' && f.text === 'what is running?')
    && win.frames.some((f) => f.type === 'assistant' && JSON.stringify(f).includes('ECHO what is running?')), 10000));
  win.ws.send(JSON.stringify({ type: 'user', text: 'typed at the desk' }));
  report.check('the phone shows the words typed at the desk, then their answer', await until(async () => {
    const t = await paneText();
    return t.includes('typed at the desk') && t.includes('ECHO typed at the desk') && t.indexOf('typed at the desk') < t.indexOf('ECHO typed at the desk');
  }, 20000), (await paneText()).slice(-240));
  await phone.screenshot({ path: join(SHOTS, '390x844-super-chat.png') });

  console.log('\n── 4. Super OFF again: the old list');
  const dis = await api(port, 'POST', '/api/super/disable', {});
  report.check('take-back', dis.status === 200, JSON.stringify(dis.json).slice(0, 160));
  await vis('[data-testid="chat-back"]').click().catch(async () => { await phone.goBack(); });
  report.check('back on the list', await until(onList, 10000));
  report.check('super off: search, chips and New chat are back; no super row', await until(async () => {
    shape = await listShape();
    return !shape.super && shape.search && shape.chips && shape.newChat && !shape.rows.some((r) => r.kind === 'super');
  }, 20000), JSON.stringify(shape));
  await phone.screenshot({ path: join(SHOTS, '390x844-super-off-again.png') });

  report.check('no console error on the phone', errors.length === 0, errors.slice(0, 5).join(' | '));
  report.check('no 403 on any request the phone made', forbidden.length === 0, forbidden.slice(0, 8).join(' | '));
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  for (const s of sockets) { try { s.ws.close(); } catch { /* gone */ } }
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `:\n  - ${report.fails.join('\n  - ')}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(report.fails.length ? 1 : 0);
