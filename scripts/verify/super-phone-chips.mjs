#!/usr/bin/env node
/**
 * The phone's Super chat with the chips in its bar (task telefon-super-cipler-ust-cubukta…), at
 * 390 and 360 touch over the loopback stand-in for the tunnel, with fake children:
 * one line above the chat, each sheet, one agent, its chat, and the same scroll spot after every
 * way out (backdrop, swipe, Escape, back).
 *
 *   npm run build && node scripts/verify/super-phone-chips.mjs
 *
 * Screenshots: tmp/verify-super-phone-chips/*.png. Exit 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { closeDrawer, drawerShown, openSuper, submit, superRows } from './lib/phone-shell.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-super-phone-chips');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-super-phone-chips');
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


  const MAC_ID = crypto.randomUUID(); const GONE_ID = crypto.randomUUID();
  const plain = await laptop(`sessionId=${MAC_ID}`); await sleep(1000);
  plain.ws.send(JSON.stringify({ type: 'user', text: `sürüm notlarını hazırla https://example.com/${'uzun-yol-'.repeat(40)}` })); await sleep(1500);
  const gone = await laptop(`sessionId=${GONE_ID}`); await sleep(1000);
  gone.ws.send(JSON.stringify({ type: 'user', text: 'eski temizlik' })); await sleep(1500);
  const en = await api(port, 'POST', '/api/super/enable', { adopt: [MAC_ID, GONE_ID], titles: { [MAC_ID]: 'Sürüm notları', [GONE_ID]: 'Eski temizlik' } });
  const SUPER = en.json.session;
  report.check('hand-over with two children', en.status === 200 && !!SUPER, JSON.stringify(en.json).slice(0, 200));
  await laptop(`mode=super&sessionId=${SUPER}`);
  gone.ws.close(); await sleep(300);
  const rec = join(PROJ, '_dream_context', 'state', '.super-agent.json');
  const st = JSON.parse(readFileSync(rec, 'utf-8')); st.children[GONE_ID].endedAt = Date.now(); writeFileSync(rec, JSON.stringify(st));

  browser = await chromium.launch();
  let notesWritten = false;
  for (const width of [390, 360]) {
    console.log(`\n── Phone, ${width} touch`);
    const qr = (await api(port, 'POST', '/api/handsfree/mac/qr')).json.url;
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width, height: 844 }, colorScheme: 'light' });
    await markAnnouncementsSeen(ctx, `http://127.0.0.1:${port}`);
    const phone = await ctx.newPage();
    const errors = [];
    phone.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    phone.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
    const vis = (sel) => phone.locator(`${sel}:visible`);
    const shot = (n) => phone.screenshot({ path: join(SHOTS, `${width}-${n}.png`) });
    await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await until(() => phone.url().includes('vault=proj'), 25000);
    for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await sleep(300); }
    await until(() => drawerShown(phone), 20000);
    await until(async () => (await superRows(phone)) === 1, 20000);
    await openSuper(phone);
    report.check('the Super chat opens', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 15000));
    const box = vis('.chat-cmp-input').first();
    const sendText = async (t) => { await box.click(); await box.fill(t); await sleep(150); await submit(phone); await sleep(500); };
    if (!notesWritten) {
      notesWritten = true;
      await sendText('NOTLAR: ajandanı yaz.');
      for (let i = 0; i < 8; i++) await sendText(`Uzun bir mesaj ${i}: ${'çağrı şeması öğleden sonra güncellendi, '.repeat(8)}`);
      await sleep(6000); // every answer in: the chat has stopped growing
    }
    // The Mac-in-a-bag note is a one-time notice with its own OK; the bar's check is what is left.
    await phone.getByRole('button', { name: 'OK', exact: true }).first().click({ timeout: 3000 }).catch(() => {});
    await sleep(300);
    const agenda = vis('[data-testid="phone-agenda-chip"]');
    const agents = vis('[data-testid="phone-agents-chip"]');
    report.check('both chips are in the bar', await until(async () => (await agenda.count()) === 1 && (await agents.count()) === 1, 20000));
    report.check('the Agenda chip counts what waits, with the pink mark', await until(async () => /Agenda.*[12]/s.test(await agenda.innerText()) && (await agenda.locator('.phone-chip-dot').count()) === 1, 20000), await agenda.innerText().catch(() => ''));
    report.check('the agents chip counts the one running, not the ended one', await until(async () => /1\s*$/.test(await agents.innerText()), 20000), await agents.innerText().catch(() => ''));
    const shape = await phone.evaluate(() => {
      const head = [...document.querySelectorAll('.agent-overlay-head')].find((e) => e.getBoundingClientRect().height > 0);
      const b = head.getBoundingClientRect();
      const rects = [...head.children].map((c) => c.getBoundingClientRect());
      const pane = [...document.querySelectorAll('.chat-pane')].find((e) => e.getBoundingClientRect().height > 0);
      return {
        height: b.height, right: Math.max(...rects.map((r) => r.right)), sameLine: rects.every((r) => r.top >= b.top - 7 && r.bottom <= b.bottom + 7),
        title: head.querySelector('[data-testid="chat-head-title"]').scrollWidth <= head.querySelector('[data-testid="chat-head-title"]').clientWidth + 1,
        gap: pane ? Math.round(pane.getBoundingClientRect().top - b.bottom) : null,
        strips: document.querySelectorAll('.phone-agenda-strip, .phone-jobs').length,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    report.check('one line, the + on screen, the name not cut, no sideways overflow', shape.height <= 45 && shape.sameLine && shape.right <= width && shape.title && !shape.overflow, JSON.stringify(shape));
    report.check('nothing between the bar and the chat', shape.strips === 0 && shape.gap !== null && shape.gap <= 1, JSON.stringify(shape));
    const agentsWord = await agents.locator('.phone-chip-label').isVisible();
    report.check(width < 380 ? 'at 360 agents collapse to the count, Agenda keeps its word' : 'at 390 both chips keep their word', agentsWord === (width >= 380) && await agenda.locator('.phone-chip-label').isVisible());

    const scroller = () => phone.evaluate(() => { const e = [...document.querySelectorAll('.chat-scroll')].find((x) => x.getBoundingClientRect().height > 0); return e ? Math.round(e.scrollTop) : -1; });
    await phone.evaluate(() => { const e = [...document.querySelectorAll('.chat-scroll')].find((x) => x.getBoundingClientRect().height > 0); e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) / 2); });
    await sleep(500);
    const spot = await scroller();
    report.check('the chat is scrolled to a middle spot', spot > 100, String(spot));
    await shot('1-chat');
    const same = async (how) => { await sleep(500); const at = await scroller(); report.check(`${how}: same scroll spot`, Math.abs(at - spot) <= 1, `${spot} -> ${at}`); };
    const openDrawerFoot = async () => { await phone.getByTestId('ns-drawer-toggle').click(); return until(() => phone.getByTestId('drawer-foot-row').isVisible(), 5000); };
    const closed = (t) => until(async () => (await phone.locator(`[data-testid="${t}"]`).count()) === 0, 3000);

    // The drawer's foot: one row, the long words a tap away.
    if (await openDrawerFoot()) {
      const foot = await phone.getByTestId('drawer-foot-row').boundingBox();
      const all = await phone.getByTestId('drawer-foot').boundingBox();
      report.check('the drawer foot is one short row', !!foot && foot.height <= 48, JSON.stringify({ foot, all }));
      report.check('the foot stays inside the width', await phone.evaluate(() => { const r = document.querySelector('[data-testid="drawer-foot-row"]'); return r.scrollWidth <= r.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; }));
      report.check('the log action is short and there', /Send log/.test(await phone.getByTestId('phone-log-send').innerText()));
      await shot('8-drawer-foot');
      await phone.getByTestId('phone-log-send').tap();
      report.check('Send log still sends', await until(async () => /Log sent to the Mac/.test(await phone.getByTestId('phone-log-note').innerText()), 6000), await phone.getByTestId('phone-log-note').innerText().catch(() => ''));
      await sleep(300); await shot('8b-log-sent');
      await phone.getByTestId('drawer-foot-more').tap();
      const details = vis('[data-testid="drawer-foot-sheet"]');
      report.check('the long words are behind a tap', await until(async () => /no message content/.test(await details.innerText()), 3000), await details.innerText().catch(() => ''));
      await sleep(350); await shot('8c-foot-sheet');
      await phone.goBack().catch(() => {});
      report.check('back closes it and the drawer stays', await closed('drawer-foot-sheet') && await drawerShown(phone));
      await closeDrawer(phone);
    } else report.check('the drawer foot shows on this device', false);
    await sleep(500);

    // The agenda.
    await phone.evaluate(() => { const e = [...document.querySelectorAll('.chat-scroll')].find((x) => x.getBoundingClientRect().height > 0); if (e) e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) / 2); });
    await agenda.tap();
    const sheet = vis('[data-testid="phone-agenda-sheet"]');
    report.check('the agenda sheet opens with all the counts', await until(async () => /[12] waiting on you/.test(await sheet.innerText()) && /Now 2/.test(await sheet.innerText()) && /Done 1/.test(await sheet.innerText()), 5000), await sheet.innerText().catch(() => ''));
    report.check('the sheet covers the title bar and the tab bar', await phone.evaluate(() => [document.querySelector('[data-testid="ns-drawer-toggle"]'), document.querySelector('[data-testid="ns-rail-tasks"]')].every((e) => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.phone-agenda-layer'); })));
    report.check('every line keeps its ↩', (await sheet.locator('[data-testid="super-agenda-about"]').count()) >= 3);
    report.check('Turkish survives', /İki ödeme tasarımı/.test(await sheet.innerText()));
    await sleep(350); await shot('2-agenda-sheet');
    await phone.locator('[data-testid="phone-agenda-sheet-backdrop"]').tap({ position: { x: 20, y: 40 } });
    report.check('tapping outside closes it', await closed('phone-agenda-sheet'));
    await same('outside');
    await agenda.tap(); await until(async () => (await sheet.count()) === 1, 3000);
    await sleep(100);
    await phone.goBack().catch(() => {});
    report.check('back closes it', await closed('phone-agenda-sheet'));
    report.check('back did not open the drawer', !(await drawerShown(phone)));
    await same('back');
    await agenda.tap(); await until(async () => (await sheet.count()) === 1, 3000);
    await phone.evaluate(() => {
      const grip = document.querySelector('[data-testid="phone-agenda-sheet-grip"]');
      const r = grip.getBoundingClientRect();
      const touch = (y) => new Touch({ identifier: 1, target: grip, clientX: r.left + 40, clientY: y });
      grip.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(r.top + 10)] }));
      grip.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(r.top + 140)] }));
      grip.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
    });
    report.check('a swipe down closes it', await closed('phone-agenda-sheet'));
    await same('swipe');

    // The agents, one agent, its chat.
    await agents.tap();
    const jobs = vis('[data-testid="phone-agents-sheet"]');
    report.check('the agents sheet lists both, by name and state', await until(async () => /Sürüm notları/.test(await jobs.innerText()) && /Eski temizlik[\s\S]*Finished/.test(await jobs.innerText()), 5000), await jobs.innerText().catch(() => ''));
    await sleep(350); await shot('3-agents-sheet');
    await jobs.locator('[data-testid="phone-job-row"]', { hasText: 'Sürüm notları' }).tap();
    report.check('one agent: its state and last output', await until(async () => /Not aldım/.test(await vis('[data-testid="phone-job-last"]').innerText().catch(() => '')), 8000) && (await vis('[data-testid="phone-job-state"]').count()) === 1);
    await sleep(300); await shot('4-agent-open');
    await vis('[data-testid="phone-job-back"]').tap();
    report.check('‹ goes back to the list', await until(async () => (await vis('[data-testid="phone-job-row"]').count()) === 2, 3000));
    await jobs.locator('[data-testid="phone-job-row"]', { hasText: 'Sürüm notları' }).tap();
    await vis('[data-testid="phone-job-open-chat"]').tap();
    report.check('the way in: its chat, read only', await until(async () => /Not aldım/.test(await vis('[data-testid="phone-job-chat"]').innerText().catch(() => '')), 8000) && (await phone.locator('[data-testid="phone-job-chat"] .chat-cmp-input').count()) === 0);
    report.check('a long line wraps in the agent chat, nothing scrolls sideways', await phone.evaluate(() => { const e = document.querySelector('[data-testid="phone-job-chat"] .chat-scroll'); return !!e && getComputedStyle(e).overflowX === 'hidden' && [...e.querySelectorAll('*')].every((x) => x.getBoundingClientRect().right <= window.innerWidth + 1); }));
    await sleep(300); await shot('5-agent-chat');
    await phone.goBack().catch(() => {});
    report.check('back closes the whole sheet', await closed('phone-agents-sheet'));
    report.check('back did not open the drawer', !(await drawerShown(phone)));
    await same('agent back');
    await shot('6-back-at-the-spot');
    await agents.tap(); await until(async () => (await jobs.count()) === 1, 3000);
    await phone.keyboard.press('Escape');
    report.check('Escape closes it', await closed('phone-agents-sheet'));
    await same('Escape');
    report.check('the chip takes the focus back', await until(() => phone.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'phone-agents-chip'), 2000));

    // Writing about a line.
    await agenda.tap(); await until(async () => (await sheet.count()) === 1, 3000);
    await sheet.locator('[data-testid="super-agenda-about"]').first().tap();
    report.check('a line\'s ↩ closes the sheet and stages it in the composer', await closed('phone-agenda-sheet') && await until(() => phone.evaluate(() => /ödeme|Ödeme|fiyat|Giriş/.test(document.querySelector('.chat-cmp')?.textContent ?? '') || !!document.querySelector('.chat-cmp [data-kind="about"], .chat-cmp-attachment-about, .chat-cmp-inline-about')), 4000));
    await sleep(400); await shot('7-about-staged');
    // The chat's own back mark still works once no sheet is up.
    await phone.goBack().catch(() => {});
    report.check('with no sheet up, back goes to the drawer as before', await until(() => drawerShown(phone), 4000));
    report.check('no console error', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
} catch (e) {
  report.fails.push(`crash: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await browser?.close().catch(() => {});
  for (const s of sockets) { try { s.ws.close(); } catch { /* gone */ } }
  server?.kill();
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
for (const f of report.fails) console.log(`  ✗ ${f}`);
process.exit(report.fails.length ? 1 : 0);
