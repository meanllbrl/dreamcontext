#!/usr/bin/env node
/**
 * The Super Agent's agenda on the hands-free PHONE (task hands-free-telefonda-super-agent-
 * sohbeti-ajandayi…, AC3-AC9; the owner's pick A: a strip under the chat's header, a sheet from
 * the bottom).
 *
 *   npm run build && node scripts/verify/super-phone-agenda.mjs
 *
 * The rig of super-reply-phone.mjs (scratch HOME, Mac mode over the loopback stand-in, an iPhone
 * 13 at 390x844 with touch). The stand-in Super writes its notepad with the real CLI
 * (`super note add|done`, `super ask`) when the phone asks it to, and answers an event turn with
 * a command and a line. Checks: the strip's counts; the sheet holds the desktop's rows in the
 * desktop's order (from GET /api/super/state on the Mac); a note written on the Mac reaches the
 * open sheet within 2 s; ↩ stages the About chip in the phone's composer and the message goes
 * with the agenda reference; Escape, the backdrop, ✕ and a swipe down close the sheet; the
 * Super's own question row keeps the sheet open when no card is drawn, or lands on its card; an
 * event turn is ONE line; a `[super answer]` draws as a receipt and never as raw text; no
 * horizontal overflow, no page error, light AND dark.
 *
 * Collect, don't fail fast; exit 0 iff every check passed. Screenshots: tmp/verify-super-phone-agenda
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-super-phone-agenda');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-super-phone-agenda');
const CLI = join(REPO, 'dist', 'index.js');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');

/** Stand-in `claude -p --input-format stream-json`. The Super writes its notepad with the real
 *  CLI on the phone's word; an event turn gets a command and a line (what folds); anything
 *  else is one line. */
const STANDIN = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const say = (text) => { const message = { role: 'assistant', content: [{ type: 'text', text }] }; row({ type: 'assistant', message }); out({ type: 'assistant', message }); };
const tool = (id, command, result) => {
  const a = { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Run it' } }] };
  row({ type: 'assistant', message: a }); out({ type: 'assistant', message: a });
  const u = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }] };
  row({ type: 'user', message: u }); out({ type: 'user', message: u });
};
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  fs.appendFileSync(${JSON.stringify(join(SCRATCH, 'cli.ndjson'))}, JSON.stringify({ args, status: r.status, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 300), t: Date.now() }) + '\\n');
  return r;
};
const received = ${JSON.stringify(join(SCRATCH, 'received.ndjson'))};
let inited = false; let buf = ''; let n = 0;
const end = (said) => out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const blocks = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text);
    const text = blocks[0] || '';
    fs.appendFileSync(received, JSON.stringify({ sid, blocks }) + '\\n');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    let said = 'Not aldım.';
    if (text.startsWith('NOTLAR')) {
      cli('super', 'note', 'add', 'now', 'Ödeme sayfasının yeni fiyat kartı');
      cli('super', 'note', 'add', 'now', 'Giriş ekranının metinleri');
      cli('super', 'note', 'add', 'waiting', 'İki ödeme tasarımı arasında seçimin');
      cli('super', 'note', 'add', 'done', 'Sürüm notları yayında');
      cli('super', 'ask', 'Yeni fiyat kartı bu akşam yayına girsin mi?', '--options', 'Evet|Yarın');
      said = 'Notlarımı yazdım.';
    } else if (text.startsWith('BITIR')) {
      cli('super', 'note', 'done', 'n1');
      cli('super', 'note', 'add', 'now', 'Bildirim zilinin sesi');
      said = 'Güncelledim.';
    } else if (text.startsWith('[super')) {
      tool('toolu_ev' + (++n), 'git log --oneline -3', 'ok');
      said = 'Nothing needs you.';
    }
    say(said); end(said);
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
  report.check('Mac mode starts for the chosen project', started.status === 200, JSON.stringify(started.json).slice(0, 200));
  const qr = (await api(port, 'POST', '/api/handsfree/mac/qr')).json.url;

  const laptop = (q) => {
    const ws = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&${q}`);
    const s = { ws, frames: [], closed: null };
    ws.on('message', (d) => { try { s.frames.push(JSON.parse(String(d))); } catch { /* partial */ } });
    ws.on('close', (code) => { s.closed = code; });
    ws.on('error', () => {});
    sockets.push(s);
    return new Promise((resolve) => { ws.on('open', () => resolve(s)); ws.on('close', () => resolve(s)); });
  };

  // A chat on the Mac the Super adopts: its finished turn becomes an event turn later.
  const MAC_ID = crypto.randomUUID();
  const plain = await laptop(`sessionId=${MAC_ID}`);
  await sleep(1000);
  plain.ws.send(JSON.stringify({ type: 'user', text: 'sürüm notlarını hazırla' }));
  await sleep(1500);
  let SUPER = ''; let win = null;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  await markAnnouncementsSeen(ctx, `http://127.0.0.1:${port}`);
  const phone = await ctx.newPage();
  const errors = []; const forbidden = [];
  phone.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); if (process.env.VERBOSE) console.log('   [console]', m.type(), m.text().slice(0, 200)); });
  phone.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  phone.on('response', (r) => { if (r.status() === 403) forbidden.push(`${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  const vis = (sel) => phone.locator(`${sel}:visible`);
  const noOverflow = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const received = () => { try { return readFileSync(join(SCRATCH, 'received.ndjson'), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const superState = async () => (await api(port, 'GET', '/api/super/state')).json;
  const shot = (name) => phone.screenshot({ path: join(SHOTS, name) });

  console.log('\n── 1. The Super chat on the phone: the strip');
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('signed in through the phone listener', await until(async () => phone.url().includes('vault=proj'), 25000), phone.url());
  for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
  report.check('the phone lands on its list (Super off)', await until(async () => (await vis('[data-testid="phone-list"]').count()) === 1, 20000));
  const en = await api(port, 'POST', '/api/super/enable', { adopt: [MAC_ID], titles: { [MAC_ID]: 'Sürüm notları' } });
  SUPER = en.json.session;
  report.check('the hand-over records a super session', en.status === 200 && typeof SUPER === 'string', JSON.stringify(en.json).slice(0, 200));
  win = await laptop(`mode=super&sessionId=${SUPER}`);
  report.check('the window\'s Super Agent socket is open', win.closed === null);

  report.check('the Super row is listed', await until(async () => (await vis('[data-testid="super-row"]').count()) === 1, 20000));
  await vis('[data-testid="super-row"]').click();
  report.check('the Super chat opens', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 15000),
    JSON.stringify(await phone.evaluate(() => ({ inputs: document.querySelectorAll('.chat-cmp-input').length, panes: [...document.querySelectorAll('.agent-panes, .agent-pane, .chat-pane')].map((e) => [e.className.slice(0, 40), JSON.stringify(e.getBoundingClientRect())]) }))) + ' errors: ' + errors.join(' | ') + ' 403: ' + forbidden.join(' | ') + ' html: ' + (await phone.evaluate(() => document.querySelector('.agent-pane')?.innerHTML.slice(0, 400))));
  const strip = vis('[data-testid="phone-agenda-strip"]');
  report.check('the agenda strip sits under the header, saying nothing is noted yet', await until(async () => (await strip.count()) === 1
    && (await vis('[data-testid="phone-agenda-empty"]').count()) === 1, 10000), await strip.innerText().catch(() => ''));
  const box = vis('.chat-cmp-input').first();
  const sendText = async (t) => { await box.click(); await box.fill(t); await phone.waitForTimeout(150); await phone.keyboard.press('Enter'); };
  await sendText('NOTLAR: ajandanı yaz.');
  const counts = () => phone.evaluate(() => ({
    waiting: document.querySelector('[data-testid="phone-agenda-waiting"]')?.textContent ?? '',
    now: document.querySelector('[data-testid="phone-agenda-now"]')?.textContent ?? '',
    done: document.querySelector('[data-testid="phone-agenda-done"]')?.textContent ?? '',
  }));
  let c;
  report.check('the strip counts what the Mac wrote: 2 waiting on you, Now 2, Done 1', await until(async () => {
    c = await counts();
    return /2 waiting on you/.test(c.waiting) && /Now 2/.test(c.now) && /Done 1/.test(c.done);
  }, 20000), JSON.stringify(c));
  const stripBox = await strip.boundingBox();
  const headBox = await vis('.agent-overlay-head').first().boundingBox();
  report.check(`the strip is one line under the header (${Math.round(stripBox?.height ?? 0)}px)`, !!stripBox && !!headBox && stripBox.height <= 48 && Math.abs(stripBox.y - (headBox.y + headBox.height)) <= 2 && stripBox.width <= 390);
  report.check('no horizontal overflow with the strip', await noOverflow());
  await shot('390x844-light-strip.png');

  console.log('\n── 2. The sheet: the desktop\'s rows, in the desktop\'s order');
  await strip.tap();
  const sheet = vis('[data-testid="phone-agenda-sheet"]');
  report.check('a tap opens the sheet as a modal dialog', await until(async () => (await sheet.count()) === 1 && (await sheet.getAttribute('aria-modal')) === 'true', 5000));
  const st = await superState();
  const ask = (st.queue ?? []).find((q) => q.kind === 'ask' && q.state === 'escalated');
  const pad = st.pad ?? [];
  const id = (sec, text) => pad.find((p) => p.section === sec && p.text === text)?.id;
  const expected = [
    `q:${ask?.id}`, `n:${id('waiting', 'İki ödeme tasarımı arasında seçimin')}`,
    `n:${id('now', 'Ödeme sayfasının yeni fiyat kartı')}`, `n:${id('now', 'Giriş ekranının metinleri')}`,
    `n:${id('done', 'Sürüm notları yayında')}`,
  ];
  const rowKeys = () => sheet.evaluate((el) => [...el.querySelectorAll('[data-testid="super-agenda-row"]')].map((r) => r.getAttribute('data-row')));
  const keys = await rowKeys();
  report.check('the sheet\'s rows are the Mac record\'s, in the stage\'s order (Waiting, Now, Done)', JSON.stringify(keys) === JSON.stringify(expected), `${JSON.stringify(keys)} vs ${JSON.stringify(expected)}`);
  const secs = await sheet.evaluate((el) => [...el.querySelectorAll('[data-testid^="super-agenda-section-"]')].map((s) => s.getAttribute('data-section')));
  report.check('the same three sections as the desktop', JSON.stringify(secs) === '["waiting","now","done"]', JSON.stringify(secs));
  const askText = await sheet.locator(`[data-row="q:${ask?.id}"]`).innerText().catch(() => '');
  report.check('the Super\'s own question reads its words under "Claude"', /Claude/.test(askText) && /bu akşam yayına/.test(askText), askText);
  report.check('every row\'s ↩ is a 44px touch target', await sheet.evaluate((el) => [...el.querySelectorAll('[data-testid="super-agenda-about"]')].every((b) => b.getBoundingClientRect().height >= 44)));
  await phone.waitForTimeout(500);
  report.check('no horizontal overflow with the sheet open', await noOverflow());
  await shot('390x844-light-sheet.png');
  // The Super's own question, while it is open (his next message settles it).
  const hasCard = (await phone.locator(`[data-testid="super-question-card"][data-item="${ask?.id}"]`).count()) > 0;
  await sheet.locator(`[data-row="q:${ask?.id}"] .super-agenda-row-btn`).tap();
  if (hasCard) {
    report.check('the question row lands on its card in the chat (the sheet closes)', await until(async () => (await sheet.count()) === 0, 3000));
  } else {
    await phone.waitForTimeout(500);
    report.check('the question row with no card drawn keeps the sheet open', (await sheet.count()) === 1);
  }
  if ((await sheet.count()) === 0) { await strip.tap(); await until(async () => (await sheet.count()) === 1, 3000); }

  console.log('\n── 3. Live: a note written on the Mac reaches the open sheet');
  const before = statSync(RECORD).mtimeMs;
  await phone.evaluate(() => { window.__agendaSeen = null; const el = document.querySelector('[data-testid="phone-agenda-sheet"]'); new MutationObserver(() => { if (!window.__agendaSeen && /Bildirim zilinin sesi/.test(el.textContent || '')) window.__agendaSeen = Date.now(); }).observe(el, { subtree: true, childList: true, characterData: true }); });
  // The sheet is open: send through the window's socket (the owner's other surface).
  win.ws.send(JSON.stringify({ type: 'user', text: 'BITIR: n1 bitti.' }));
  let wrote = 0;
  await until(async () => { const r = statSync(RECORD).mtimeMs; if (r > before && /Bildirim zilinin sesi/.test(readFileSync(RECORD, 'utf-8'))) { wrote = Date.now(); return true; } return false; }, 20000, 25);
  const seenAt = await until(() => phone.evaluate(() => window.__agendaSeen !== null), 5000, 50) ? await phone.evaluate(() => window.__agendaSeen) : null;
  report.check(`the new note shows without a reload within 2 s of the Mac's write (${seenAt && wrote ? seenAt - wrote : '—'} ms)`, !!seenAt && !!wrote && seenAt - wrote <= 2000);
  report.check('…and n1 moved to Done', await until(async () => JSON.stringify(await rowKeys()).includes('"n:n1"') && (await sheet.locator('[data-section="done"] [data-row="n:n1"]').count()) === 1, 5000));

  console.log('\n── 4. Closing: Escape, the backdrop, ✕, a swipe down');
  await phone.keyboard.press('Escape');
  report.check('Escape closes it and the strip takes the focus back', await until(async () => (await sheet.count()) === 0, 3000)
    && await until(() => phone.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'phone-agenda-strip'), 2000));
  await strip.tap();
  await until(async () => (await sheet.count()) === 1, 3000);
  await phone.locator('[data-testid="phone-agenda-backdrop"]').tap({ position: { x: 20, y: 40 } });
  report.check('a tap on the backdrop closes it', await until(async () => (await sheet.count()) === 0, 3000));
  await strip.tap();
  await until(async () => (await sheet.count()) === 1, 3000);
  await vis('[data-testid="phone-agenda-close"]').tap();
  report.check('✕ closes it', await until(async () => (await sheet.count()) === 0, 3000));
  await strip.tap();
  await until(async () => (await sheet.count()) === 1, 3000);
  await phone.evaluate(() => {
    const grip = document.querySelector('[data-testid="phone-agenda-grip"]');
    const r = grip.getBoundingClientRect();
    const touch = (y) => new Touch({ identifier: 1, target: grip, clientX: r.left + 40, clientY: y });
    grip.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(r.top + 10)] }));
    grip.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(r.top + 140)] }));
    grip.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
  });
  report.check('a swipe down on its handle closes it', await until(async () => (await sheet.count()) === 0, 3000));

  console.log('\n── 5. The Super\'s own question row, and ↩');
  await strip.tap();
  await until(async () => (await sheet.count()) === 1, 3000);
  if ((await sheet.count()) === 0) { await strip.tap(); await until(async () => (await sheet.count()) === 1, 3000); }
  const wId = id('waiting', 'İki ödeme tasarımı arasında seçimin');
  await sheet.locator(`[data-row="n:${wId}"] [data-testid="super-agenda-about"]`).tap();
  const chip = vis('.chat-cmp-attachment-about');
  report.check('↩ closes the sheet and stages ONE About chip in the phone\'s composer', await until(async () => (await sheet.count()) === 0 && (await chip.count()) === 1, 5000), await chip.innerText().catch(() => ''));
  await shot('390x844-light-about-chip.png');
  await box.click(); await box.fill('ikincisi olsun'); await phone.waitForTimeout(150); await phone.keyboard.press('Enter');
  const aboutRe = new RegExp(`^\\[About agenda line note=${wId} section=waiting\\]\\nline: "İki ödeme tasarımı arasında seçimin"\\n\\nikincisi olsun$`);
  report.check('the message reaches the Super with the agenda reference, as the desktop sends it', await until(async () => received().some((x) => x.sid === SUPER && aboutRe.test(x.blocks[0])), 15000), JSON.stringify(received().filter((x) => x.sid === SUPER).slice(-1)));

  console.log('\n── 6. An event turn is ONE line; an answer is a receipt');
  plain.ws.send(JSON.stringify({ type: 'user', text: 'sürüm notlarını topla' }));
  const line = vis('[data-testid="super-event-line"]');
  report.check('the child\'s finished turn reaches the phone as ONE event line (its command folded)', await until(async () => (await line.count()) >= 1, 90000)
    && !(await vis('.chat-pane').first().innerText()).includes('git log --oneline -3'), (await vis('.chat-pane').first().innerText().catch(() => '')).slice(-300));
  await line.first().locator('.super-event-line-name').first().tap().catch(() => {});
  await phone.waitForTimeout(400);
  report.check('a tap on the child\'s name opens nothing and throws nothing', errors.filter((e) => e.startsWith('pageerror')).length === 0);
  win.ws.send(JSON.stringify({ type: 'user', text: `[super answer] item=${ask?.id}\nUser has answered your questions: "Yeni fiyat kartı bu akşam yayına girsin mi?"="Evet". You can now continue with the user's answers in mind.` }));
  const receipt = vis('[data-testid="super-answer-receipt"]');
  report.check('the answer draws as a receipt on the phone', await until(async () => (await receipt.count()) >= 1, 15000));
  report.check('no "[super answer]" text anywhere on the page', await phone.evaluate(() => !document.body.innerText.includes('[super answer]')));
  await receipt.last().scrollIntoViewIfNeeded().catch(() => {});
  report.check('no horizontal overflow in the chat', await noOverflow());
  await shot('390x844-light-events-receipt.png');

  console.log('\n── 7. Dark');
  await phone.emulateMedia({ colorScheme: 'dark' });
  await phone.waitForTimeout(600);
  const bgLight = await phone.evaluate(() => getComputedStyle(document.body).backgroundColor);
  report.check('the page follows the dark scheme', await phone.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), bgLight);
  await shot('390x844-dark-strip.png');
  await strip.tap();
  await until(async () => (await sheet.count()) === 1, 3000);
  await phone.waitForTimeout(500); // the sheet's one-shot entrance settles before the shot
  report.check('dark: no horizontal overflow with the sheet open', await noOverflow());
  await shot('390x844-dark-sheet.png');
  await phone.keyboard.press('Escape');

  report.check('no page error on the phone', errors.length === 0, errors.slice(0, 5).join(' | '));
  report.check('no 403 on any request the phone made', forbidden.length === 0, forbidden.slice(0, 8).join(' | '));
} catch (err) {
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {});
  report.check('the run completed', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  for (const s of sockets) { try { s.ws.close(); } catch { /* gone */ } }
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `:\n  - ${report.fails.join('\n  - ')}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(report.fails.length ? 1 : 0);
