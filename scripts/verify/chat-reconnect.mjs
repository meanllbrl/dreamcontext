#!/usr/bin/env node
/**
 * Chat socket-resilience end-to-end verification (AC15 minus the real-phone sentence).
 *
 * Proves that a dropped chat socket no longer ends the session:
 *   R1  killing the socket MID-TURN reconnects on its own (no Resume tap), the server ADOPTS
 *       the SAME `claude` process (one spawn, one pid), the turn keeps running while detached
 *       for longer than the idle window, and the output streamed while away is replayed ONCE;
 *   R2  an IDLE detached child is reaped after the idle window (stdin EOF → it exits);
 *   R3  a BUSY detached child is never reaped by the idle window, only by the busy cap;
 *   R4  a REAL process exit still shows the Session-ended banner (and does not reconnect).
 *
 *   npm run build && node scripts/verify/chat-reconnect.mjs
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/api/agent/chat` route and the real
 * React surface in Chromium. The 15 min idle and 4 h busy windows are shortened through the
 * server's verify-only env overrides (DREAMCONTEXT_CHAT_DETACH_IDLE_MS / _BUSY_CAP_MS), never
 * waited out.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is a scripted stand-in in an isolated fake HOME
 * (`$SCRATCH/home/.local/bin/claude`) that speaks stream-json, writes its transcript where the
 * real CLI does (so chat-history can replay it), prints its own pid, and logs every spawn and
 * exit to `$SCRATCH/spawns.log`.
 *
 * HOW THE SOCKET IS KILLED — an init script wraps the page's WebSocket so the check can close
 * the live chat socket (exactly what a locked phone does to it) and hold reconnects back for a
 * few seconds, so real output is missed and has to be replayed.
 *
 * FAILURE POLICY — collect, don't fail fast (as verify/chat-steer.mjs): every check prints ✓/✗
 * with evidence; exit code 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-reconnect');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SPAWN_LOG = join(SCRATCH, 'spawns.log');

// Shortened windows (production: 15 min idle, 4 h busy cap).
const IDLE_MS = 6000;
const BUSY_CAP_MS = 14000;

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-reconnect.mjs. */
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const LOG = ${JSON.stringify(SPAWN_LOG)};
const log = (s) => fs.appendFileSync(LOG, s + '\\n');
const argv = process.argv.slice(2);
// The server runs \`claude\` for more than chat (auth/usage probes, titles): only a stream-json
// chat process is logged and scripted; anything else answers empty and leaves.
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
log('spawn ' + process.pid + ' ' + sid);
process.on('exit', () => log('exit ' + process.pid));
const enc = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const dir = path.join(process.env.HOME, '.claude', 'projects', enc);
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => {
  const message = { role: 'assistant', content: [{ type: 'text', text }] };
  row({ type: 'assistant', message });
  out({ type: 'assistant', message });
};
const done = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
let inited = false;
async function turn(text) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const slow = /^SLOW (\\d+)/.exec(text);
  if (slow) {
    say('START pid=' + process.pid);
    for (let i = 1; i <= Number(slow[1]); i++) { await sleep(1000); say('[TICK-' + String(i).padStart(2, '0') + ']'); }
    say('FINISH pid=' + process.pid);
    done('FINISH');
    return;
  }
  if (text === 'HANG') { say('HANGING pid=' + process.pid); await new Promise(() => {}); }
  if (text === 'EXIT') { say('BYE pid=' + process.pid); done('BYE'); setTimeout(() => process.exit(0), 200); return; }
  say('ECHO ' + text + ' pid=' + process.pid);
  done('ECHO');
}
let chain = Promise.resolve(); let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) chain = chain.then(() => turn(text));
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ─── page instrumentation: the socket a phone would lose ─────────────────────────────
const INIT_SCRIPT = `(() => {
  const Real = window.WebSocket;
  window.__chatSockets = [];
  window.__blockChat = false;
  class Tracked extends Real {
    constructor(url, protocols) {
      const isChat = String(url).includes('/api/agent/chat');
      // Blocked = the network is still gone: the attempt fails like a dead route would.
      super(isChat && window.__blockChat ? 'ws://127.0.0.1:9/' : url, protocols);
      if (isChat) window.__chatSockets.push({ url: String(url), ws: this, blocked: !!window.__blockChat });
    }
  }
  window.WebSocket = Tracked;
})();`;

// ─── setup ────────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port, env) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

/** The scripted claude's own record: spawn/exit lines, per pid. */
function spawnLog() {
  const lines = existsSync(SPAWN_LOG) ? readFileSync(SPAWN_LOG, 'utf-8').trim().split('\n').filter(Boolean) : [];
  return {
    spawns: lines.filter((l) => l.startsWith('spawn ')).map((l) => l.split(' ')[1]),
    exits: lines.filter((l) => l.startsWith('exit ')).map((l) => l.split(' ')[1]),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── driving the surface ──────────────────────────────────────────────────────────────

async function openChat(browser, base, report) {
  // A clean roster, so a restored pane can never shadow the new one.
  rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  await page.addInitScript(INIT_SCRIPT);
  const vis = (sel) => page.locator(`${sel}:visible`);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const opened = await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000);
  const pane = () => vis('.chat-pane').first();
  const paneText = async () => (await pane().innerText().catch(() => '')).replace(/\s+/g, ' ');
  const send = async (t) => {
    const c = vis('.chat-cmp-input').first();
    await c.click(); await c.fill(t); await page.waitForTimeout(120); await page.keyboard.press('Enter');
  };
  return { page, vis, until, paneText, send, opened };
}

const count = (hay, needle) => hay.split(needle).length - 1;

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0, fails: [], notes: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

let server = null;
let browser = null;
try {
  const { chromium } = await import('@playwright/test');
  console.log('· setting up scratch vault + scripted claude…');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`· starting the real dashboard server on ${port} (idle ${IDLE_MS} ms, busy cap ${BUSY_CAP_MS} ms)…`);
  server = await startServer(port, {
    DREAMCONTEXT_CHAT_DETACH_IDLE_MS: String(IDLE_MS),
    DREAMCONTEXT_CHAT_DETACH_BUSY_CAP_MS: String(BUSY_CAP_MS),
  });
  browser = await chromium.launch();

  // ── R1: kill the socket mid-turn ────────────────────────────────────────────────
  console.log('\n── R1: socket killed mid-turn → reconnect, same child adopted, missed output replayed once');
  const c1 = await openChat(browser, base, report);
  report.check('a chat session opens against the real WS route', c1.opened);
  await c1.send('SLOW 12');
  report.check('the turn starts streaming', await c1.until(async () => (await c1.paneText()).includes('[TICK-02]'), 15000));
  const before = spawnLog();
  const pid = /START pid=(\d+)/.exec(await c1.paneText())?.[1] ?? '?';
  report.check('exactly one chat process so far, and it is the one streaming',
    before.spawns.length === 1 && before.spawns[0] === pid, JSON.stringify({ ...before, pid }));

  // The phone locks: the socket dies, and the network stays gone for a few seconds.
  const dropAt = Date.now();
  await c1.page.evaluate(() => { window.__blockChat = true; window.__chatSockets[window.__chatSockets.length - 1].ws.close(); });
  report.check('the pane says Reconnecting…, not Session ended',
    await c1.until(async () => (await c1.vis('.chat-banner-reconnecting').count()) > 0, 5000)
      && (await c1.vis('.chat-banner-ended-title').count()) === 0);
  // Hold the network away past the idle window while the turn is still running on the server.
  await sleep(IDLE_MS + 1500);
  const whileAway = spawnLog();
  report.check('while detached and BUSY for longer than the idle window, the child is still alive',
    !whileAway.exits.includes(pid), JSON.stringify(whileAway));
  await c1.page.evaluate(() => { window.__blockChat = false; });
  report.check('the client reconnects on its own (no Resume tap)',
    await c1.until(async () => (await c1.page.evaluate(() => {
      const s = window.__chatSockets[window.__chatSockets.length - 1];
      return !s.blocked && s.ws.readyState === 1;
    })), 40000));
  const urls = await c1.page.evaluate(() => window.__chatSockets.map((s) => s.url));
  const reattachUrl = urls[urls.length - 1];
  report.check('the reconnect asks to reattach the same conversation (resume=<id>&reattach=1)',
    /[?&]resume=[0-9a-f-]{36}/.test(reattachUrl) && /[?&]reattach=1/.test(reattachUrl), reattachUrl);
  report.check('the reconnect does not resend an opening prompt', !/[?&](prompt|promptToken)=/.test(reattachUrl));
  report.check('the turn finishes in the pane', await c1.until(async () => (await c1.paneText()).includes(`FINISH pid=${pid}`), 30000));
  await c1.page.waitForTimeout(1500);
  const after = spawnLog();
  report.check('the SAME process was adopted: still one chat spawn, and it finished the turn',
    after.spawns.length === 1 && !after.exits.includes(pid), JSON.stringify(after));
  report.note(`(socket was away ${(Date.now() - dropAt) / 1000 | 0}s+ including the turn tail)`);
  const text = await c1.paneText();
  const ticks = Array.from({ length: 12 }, (_, i) => `[TICK-${String(i + 1).padStart(2, '0')}]`);
  const counts = ticks.map((t) => count(text, t));
  report.check('every tick, including those streamed while away, shows exactly ONCE', counts.every((n) => n === 1),
    ticks.map((t, i) => `${t}×${counts[i]}`).join(' '));
  report.check('the user message shows once', count(text, 'SLOW 12') === 1, `×${count(text, 'SLOW 12')}`);
  report.check('the reconnecting chip is gone', (await c1.vis('.chat-banner-reconnecting').count()) === 0);
  await c1.send('after reconnect');
  report.check('the adopted process takes the next turn', await c1.until(async () => (await c1.paneText()).includes(`ECHO after reconnect pid=${pid}`), 15000));

  // ── R2: idle detached child reaped ──────────────────────────────────────────────
  console.log('\n── R2: an idle detached child is reaped after the idle window');
  await c1.page.close();   // no goodbye frame: the socket just vanishes, like a killed browser
  await sleep(IDLE_MS / 2);
  report.check('half-way through the idle window the detached child is still alive', !spawnLog().exits.includes(pid));
  let reaped = false;
  const reapDeadline = Date.now() + IDLE_MS + 6000;
  while (Date.now() < reapDeadline) { if (spawnLog().exits.includes(pid)) { reaped = true; break; } await sleep(250); }
  report.check('after the idle window the child got stdin EOF and exited', reaped, JSON.stringify(spawnLog()));

  // ── R3: busy detached child: idle window never reaps it, the busy cap does ─────
  console.log('\n── R3: a busy detached child survives the idle window and is reaped only at the busy cap');
  const c3 = await openChat(browser, base, report);
  await c3.send('HANG');
  report.check('the hanging turn starts', await c3.until(async () => (await c3.paneText()).includes('HANGING pid='), 15000));
  const pid3 = /HANGING pid=(\d+)/.exec(await c3.paneText())?.[1];
  const goneAt = Date.now();
  await c3.page.close();
  await sleep(IDLE_MS + 2000);
  report.check('past the idle window the busy child is still alive', !!pid3 && !spawnLog().exits.includes(pid3), JSON.stringify(spawnLog()));
  let capped = false;
  const capDeadline = goneAt + BUSY_CAP_MS + 8000;
  while (Date.now() < capDeadline) { if (spawnLog().exits.includes(pid3)) { capped = true; break; } await sleep(250); }
  report.check('at the busy cap it is ended', capped, `${(Date.now() - goneAt) / 1000 | 0}s after the socket went`);

  // ── R4: a real exit still ends the session ──────────────────────────────────────
  console.log('\n── R4: a real process exit still shows Session ended and does not reconnect');
  const c4 = await openChat(browser, base, report);
  await c4.send('EXIT');
  report.check('the Session-ended banner shows', await c4.until(async () => (await c4.vis('.chat-banner-ended-title').count()) > 0, 15000));
  const socketsAtExit = await c4.page.evaluate(() => window.__chatSockets.length);
  await c4.page.waitForTimeout(3500);
  report.check('no reconnect is attempted after a real exit',
    (await c4.page.evaluate(() => window.__chatSockets.length)) === socketsAtExit);
  await c4.page.close();
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
