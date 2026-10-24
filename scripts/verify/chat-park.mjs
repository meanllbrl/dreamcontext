#!/usr/bin/env node
/**
 * Idle chats parked under machine load — end-to-end (task idle-chats-are-parked-…).
 *
 *   P1  two chats; the one the owner is NOT looking at goes idle -> the sweep parks it: its
 *       `claude` process exits, its tab reads "parked" and shows the parked card;
 *   P2  the tab the owner is looking at (focused, idle too) is never parked;
 *   P3  Resume reopens the SAME conversation (`--resume <same id>`), its history is back in
 *       the pane, and the new process takes the next turn;
 *   P4  a BUSY chat (a long turn) is never parked while its turn runs.
 *
 *   npm run build && node scripts/verify/chat-park.mjs            # Chromium + WebKit
 *
 * The real dashboard server, the real `/api/agent/chat` route and the real React surface, in
 * Chromium AND WebKit. The machine pressure, the 10/3 min idle windows, the 60 s sweep and the
 * 2 min focus grace are shortened through the server's verify-only env overrides
 * (DREAMCONTEXT_PARK_PRESSURE / _IDLE_MS / _SWEEP_MS / _FOCUS_MS); `claude` is the scripted
 * stand-in of verify/chat-reconnect.mjs in a fake HOME (no tokens spent).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-park');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SPAWN_LOG = join(SCRATCH, 'spawns.log');
const SHOTS = join(REPO, 'tmp', 'verify-chat-park');

const IDLE_MS = 4000;
const SWEEP_MS = 1500;
const FOCUS_MS = 3000;

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
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'), '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port, env) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

function spawnLog() {
  const lines = existsSync(SPAWN_LOG) ? readFileSync(SPAWN_LOG, 'utf-8').trim().split('\n').filter(Boolean) : [];
  return {
    spawns: lines.filter((l) => l.startsWith('spawn ')).map((l) => ({ pid: l.split(' ')[1], sid: l.split(' ')[2] })),
    exits: lines.filter((l) => l.startsWith('exit ')).map((l) => l.split(' ')[1]),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  pass: 0, fails: [], notes: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

async function run(browserType, name, base) {
  console.log(`\n══ ${name}`);
  rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
  rmSync(SPAWN_LOG, { force: true });
  const browser = await browserType.launch();
  const consoleErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    const vis = (sel) => page.locator(`${sel}:visible`);
    const until = async (fn, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
      return false;
    };
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
    report.check(`${name}: chat A opens`, await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
    const paneText = async () => (await vis('.chat-pane').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    const send = async (t) => {
      const c = vis('.chat-cmp-input').first();
      await c.click(); await c.fill(t); await page.waitForTimeout(120); await page.keyboard.press('Enter');
    };
    await send('alpha');
    report.check(`${name}: A answers`, await until(async () => /ECHO alpha pid=\d+/.test(await paneText()), 15000));
    const pidA = /ECHO alpha pid=(\d+)/.exec(await paneText())?.[1];
    const sidA = spawnLog().spawns.find((s) => s.pid === pidA)?.sid;

    // Chat B, opened as a second tab and LEFT FOCUSED: the owner is looking at it.
    await page.locator('button[aria-label="New chat"]:visible').first().click();
    await page.waitForTimeout(1500);
    await send('bravo');
    report.check(`${name}: B answers (the focused tab)`, await until(async () => /ECHO bravo pid=\d+/.test(await paneText()), 15000));
    const pidB = /ECHO bravo pid=(\d+)/.exec(await paneText())?.[1];

    // Idle past the window, grace and a few sweeps; nothing touched meanwhile.
    let parkedA = false;
    const deadline = Date.now() + IDLE_MS + FOCUS_MS + 6 * SWEEP_MS + 10000;
    while (Date.now() < deadline) { if (spawnLog().exits.includes(pidA)) { parkedA = true; break; } await sleep(250); }
    report.check(`${name}: P1 the idle, unfocused chat A was parked (its claude exited)`, parkedA, JSON.stringify(spawnLog()));
    const tabA = page.locator('[role="tab"]').filter({ hasText: /./ }).first();
    const titleA = await tabA.getAttribute('title');
    report.check(`${name}: P1 tab A reads "parked"`, /— parked$/.test(titleA ?? ''), titleA ?? '(no tab)');
    report.check(`${name}: P2 the focused chat B is still running`, !!pidB && !spawnLog().exits.includes(pidB), JSON.stringify(spawnLog()));
    await page.screenshot({ path: join(SHOTS, `${name}-1-parked-tab.png`) });

    // Resume: open A's tab, see the parked card, click Resume.
    await tabA.click();
    report.check(`${name}: P1 A shows the parked card`, await until(async () => (await vis('.agent-pane-ended-title').innerText().catch(() => '')).includes('Parked'), 5000),
      await vis('.agent-pane-ended-title').innerText().catch(() => '(none)'));
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOTS, `${name}-2-parked-card.png`) });
    const spawnsBefore = spawnLog().spawns.length;
    await vis('.agent-pane-reconnect').first().click();
    report.check(`${name}: P3 Resume spawns claude again for the SAME conversation`,
      await until(async () => spawnLog().spawns.slice(spawnsBefore).some((s) => s.sid === sidA), 15000), JSON.stringify(spawnLog()));
    report.check(`${name}: P3 the history is back in the pane`, await until(async () => (await paneText()).includes(`ECHO alpha pid=${pidA}`), 15000));
    await send('charlie');
    report.check(`${name}: P3 the resumed chat takes the next turn`, await until(async () => /ECHO charlie pid=\d+/.test(await paneText()), 15000));
    const pidA2 = /ECHO charlie pid=(\d+)/.exec(await paneText())?.[1];
    report.check(`${name}: P3 tab A no longer reads parked`, !/— parked$/.test((await tabA.getAttribute('title')) ?? ''));
    await page.screenshot({ path: join(SHOTS, `${name}-3-resumed.png`) });

    // P4: a busy chat is never parked. Leave A running a long turn and focus B.
    await send('SLOW 14');
    await until(async () => (await paneText()).includes(`START pid=${pidA2}`), 10000);
    await page.locator('[role="tab"]').nth(1).click();
    await sleep(IDLE_MS + FOCUS_MS + 4 * SWEEP_MS);
    report.check(`${name}: P4 the busy chat was not parked mid-turn`, !spawnLog().exits.includes(pidA2), JSON.stringify(spawnLog()));
    report.check(`${name}: no page errors`, consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)).length === 0, consoleErrors.join(' | '));
    await page.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

let server = null;
try {
  const { chromium, webkit } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`· real dashboard on ${port}: pressure forced hard, idle ${IDLE_MS} ms, sweep ${SWEEP_MS} ms, focus grace ${FOCUS_MS} ms`);
  server = await startServer(port, {
    DREAMCONTEXT_PARK_PRESSURE: 'hard',
    DREAMCONTEXT_PARK_IDLE_MS: String(IDLE_MS),
    DREAMCONTEXT_PARK_SWEEP_MS: String(SWEEP_MS),
    DREAMCONTEXT_PARK_FOCUS_MS: String(FOCUS_MS),
  });
  const which = process.argv[2];
  if (!which || which === 'chromium') await run(chromium, 'chromium', base);
  if (!which || which === 'webkit') await run(webkit, 'webkit', base);
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
