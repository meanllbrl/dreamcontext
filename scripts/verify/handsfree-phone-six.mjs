#!/usr/bin/env node
/**
 * The six things the owner found on the phone (task telefonda-sahibin-buldugu-alti-dert-cozulur),
 * over the loopback stand-in for the tunnel, at 390 touch and at 1440 with a mouse:
 *
 *   1. A project whose Super Agent was taken back starts a chat and gets its answer; the mirror
 *      tab does not hang on "Connecting…".
 *   2. New chat opens in every chosen project, Super on or off, and in no other.
 *   3. The phone's More is Roadmap, Whiteboard, Knowledge; the Mac's stays whole.
 *   4. No search and no sleep face in the phone's title bar; the Mac keeps both.
 *   5. The Super's jobs are listed by name and state in its chat; a tap reads the transcript.
 *   6. The owner's chats list beside the Super row; a Super child does not.
 *
 *   npm run build && node scripts/verify/handsfree-phone-six.mjs
 *
 * Screenshots: tmp/verify-handsfree-phone-six/*.png. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { closeDrawer, drawerShape, drawerShown, expand, openDrawer, openSuper, projRow, submit } from './lib/phone-shell.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-phone-six');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-phone-six');
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
    const answer = () => {
      const message = { role: 'assistant', content: [{ type: 'text', text: said }] };
      row({ type: 'assistant', message }); out({ type: 'assistant', message });
      out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    };
    // A slow turn stays Working long enough to be seen.
    if (text.startsWith('slow')) setTimeout(answer, 12000); else answer();
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
  for (const [name, dir] of [['proj', PROJ], ['beta', join(SCRATCH, 'beta')], ['gamma', join(SCRATCH, 'gamma')]]) {
    mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir });
    cli(['init', '-y', '--name', name, '--description', 'A scratch project'], dir);
    const r = cli(['vaults', 'add', name, dir]);
    if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
  }
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


let server = null; let browser = null; const sockets = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  const { WebSocket: NodeWs } = await import('ws');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  await api(port, 'POST', '/api/handsfree/mac/setup', {});
  await api(port, 'POST', '/api/handsfree/mac/start', { vaults: ['proj', 'beta'] });
  const laptop = (q, vault = 'proj') => {
    const ws = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=${vault}&bypass=0&${q}`);
    const s = { ws, frames: [], closed: null };
    ws.on('message', (d) => { try { s.frames.push(JSON.parse(String(d))); } catch { /* partial */ } });
    ws.on('close', (code) => { s.closed = code; }); ws.on('error', () => {});
    sockets.push(s);
    return new Promise((resolve) => { ws.on('open', () => resolve(s)); ws.on('close', () => resolve(s)); });
  };
  const say = async (s, text) => { await sleep(800); s.ws.send(JSON.stringify({ type: 'user', text })); await sleep(600); };

  // A past chat of the handed-over project: the owner's, History lists it.
  const PAST = crypto.randomUUID();
  const ts = new Date(Date.now() - 3600_000).toISOString();
  writeFileSync(join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-'), `${PAST}.jsonl`), `${[
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Proj past fixture' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: Proj past fixture' }] } },
  ].map((o) => JSON.stringify({ ...o, cwd: PROJ, uuid: crypto.randomUUID(), timestamp: ts, sessionId: PAST })).join('\n')}\n`);
  const CHILD = crypto.randomUUID(); const FINISHED = crypto.randomUUID(); const MINE = crypto.randomUUID();
  const child = await laptop(`sessionId=${CHILD}`); await say(child, 'child work');
  const finished = await laptop(`sessionId=${FINISHED}`); await say(finished, 'finished work');
  const en = await api(port, 'POST', '/api/super/enable', { adopt: [CHILD, FINISHED], titles: { [CHILD]: 'Release notes', [FINISHED]: 'Old cleanup' } });
  const SUPER = en.json.session;
  report.check('hand-over with two children', en.status === 200 && !!SUPER, JSON.stringify(en.json).slice(0, 200));
  const win = await laptop(`mode=super&sessionId=${SUPER}`);
  const mine = await laptop(`sessionId=${MINE}`); await say(mine, 'my own chat');

  browser = await chromium.launch();
  const open = async (name, opts, url) => {
    const ctx = await browser.newContext(opts);
    await markAnnouncementsSeen(ctx, `http://127.0.0.1:${port}`);
    const p = await ctx.newPage();
    // Which call was refused locally (`api/client.ts`): the counter's write carries its stack.
    await p.addInitScript(() => {
      let n = 0; window.__dcRefusals = [];
      Object.defineProperty(window, '__dcPhoneRefused', { get: () => n, set: (v) => { n = v; window.__dcRefusals.push(String(new Error('refused').stack).split('\n').slice(2, 7).join(' < ')); } });
    });
    const errors = []; const bad = [];
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 180)}`));
    p.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 90)}`); });
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await until(() => p.locator('[data-testid="ns-titlebar"]').count(), 25000);
    await sleep(3500);
    for (let i = 0; i < 3; i++) { const x = p.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await sleep(300); }
    return { ctx, p, errors, bad, shot: (n) => p.screenshot({ path: join(SHOTS, `${name}-${n}.png`) }) };
  };
  const qr = async () => (await api(port, 'POST', '/api/handsfree/mac/qr')).json.url;
  const composer = (p) => p.locator('.chat-cmp-input:visible').first();
  const send = async (p, text) => {
    const box = composer(p);
    if (!(await until(async () => (await box.count()) > 0 && !(await box.isDisabled()), 15000))) return false;
    await sleep(500);
    await box.click({ timeout: 8000 }).catch(async (e) => {
      await p.screenshot({ path: join(SHOTS, 'failed-send.png') });
      console.log('      send: no click', JSON.stringify(await p.evaluate(() => ({ drawer: !!document.querySelector('[data-testid="chat-drawer"]'), active: document.querySelector('[data-testid="ns-picker-btn"]')?.textContent, boxes: [...document.querySelectorAll('.chat-cmp-input')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), b.value.slice(0, 20), b.closest('.project-instance')?.hidden]; }) }))));
      throw e;
    });
    await box.fill(text); await sleep(150); await submit(p);
    return until(async () => (await p.locator('body').innerText()).includes(`ECHO ${text}`), 20000);
  };

  console.log('\n── Phone, 390 touch');
  const ph = await open('390', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } }, await qr());
  const p = ph.p;
  // 6
  await expand(p, 'proj');
  let shape;
  report.check('6 the Super row and the owner\'s chat side by side', await until(async () => { shape = await drawerShape(p, 'proj'); return shape.super && shape.rows.some((r) => r.id === MINE); }, 15000), JSON.stringify(shape));
  report.check('6 no Super child among the owner\'s chats', !shape.rows.some((r) => r.id === CHILD || r.id === FINISHED), JSON.stringify(shape.rows));
  report.check('6 the Super row comes first', shape.rows[0]?.kind === 'super');
  report.check('2 the head New chat entry is there with Super on', await p.locator('[data-testid="drawer-new-window"]:visible').count() > 0);
  report.check('2 every chosen project has its +', await p.locator('[data-testid="drawer-project-add"]:visible').count() === 2);
  await ph.shot('1-drawer');
  await p.getByTestId('drawer-new-window').click(); await sleep(400);
  const menu = await p.getByTestId('drawer-new-menu').innerText();
  report.check('2 New chat offers the chosen projects and only them', /proj/.test(menu) && /beta/.test(menu) && !/gamma/.test(menu), menu);
  await ph.shot('2-new-menu');
  await p.mouse.click(5, 300); await sleep(300);
  if (!(await drawerShown(p))) await openDrawer(p);
  // 3, 4
  await closeDrawer(p);
  const bar = await p.evaluate(() => ({
    search: !!document.querySelector('[data-testid="ns-search"]'), face: !!document.querySelector('.ns-titlebar .sleep-tracker'),
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    bar: document.querySelector('[data-testid="ns-titlebar"]').scrollWidth <= document.querySelector('[data-testid="ns-titlebar"]').clientWidth + 1,
  }));
  report.check('4 no search and no face in the title bar', !bar.search && !bar.face, JSON.stringify(bar));
  report.check('4 the title bar fits at 390', bar.bar && !bar.overflow, JSON.stringify(bar));
  await p.getByTestId('ns-rail-more').click(); await sleep(400);
  const more = await p.locator('[data-testid="ns-more-menu"] [role="menuitem"]').allInnerTexts();
  report.check('3 More is Roadmap, Whiteboard, Knowledge', more.length === 3 && /Roadmap/.test(more[0]) && /Whiteboard/.test(more[1]) && /Knowledge/.test(more[2]), JSON.stringify(more));
  await ph.shot('3-more');
  await p.keyboard.press('Escape'); await sleep(300);
  // 2: a new chat in the handed-over project
  await expand(p, 'proj');
  await projRow(p, 'proj').getByTestId('drawer-project-add').click();
  report.check('2 New chat in the handed-over project starts and answers', await send(p, 'hello from the phone'));
  await ph.shot('4-new-chat-super-on');
  // 2: a new chat in the other chosen project
  await expand(p, 'beta');
  await projRow(p, 'beta').getByTestId('drawer-project-add').click();
  report.check('2 New chat in the other chosen project starts and answers', await send(p, 'hello beta'));
  // 6: the owner's Mac chat opens and answers
  await expand(p, 'proj');
  await projRow(p, 'proj').locator(`[data-chat-id="${MINE}"]`).click();
  report.check('6 the owner\'s chat in a handed-over project takes a message', await send(p, 'more from me'));
  await ph.shot('5-own-chat');
  // 6: History holds the owner's past chat of the handed-over project, and no child.
  await openDrawer(p);
  await p.getByTestId('drawer-history').click();
  report.check('6 History lists the handed-over project\'s past chat', await until(() => p.locator('.chp-row', { hasText: 'Proj past fixture' }).count(), 15000));
  const hist = await p.locator('.chp-row').allInnerTexts();
  report.check('6 History lists no Super child', !hist.some((h) => /child work|finished work/.test(h)), JSON.stringify(hist));
  await sleep(400); await ph.shot('5b-history');
  await p.locator('.chp-row', { hasText: 'Proj past fixture' }).first().click();
  report.check('6 a History pick there opens the chat', await until(async () => (await p.locator('.chat-pane:visible').first().innerText().catch(() => '')).includes('Done: Proj past fixture'), 20000));
  await ph.shot('5c-history-pick');
  // 5: one child working, one the record ended, one idle.
  const rec = join(PROJ, '_dream_context', 'state', '.super-agent.json');
  finished.ws.close();
  const state = JSON.parse(readFileSync(rec, 'utf-8'));
  state.children[FINISHED].endedAt = Date.now();
  writeFileSync(rec, JSON.stringify(state));
  child.ws.send(JSON.stringify({ type: 'user', text: 'slow job' }));
  await sleep(600);
  await openSuper(p);
  await p.getByTestId('phone-agents-chip').click();
  report.check('5 the jobs list opens from the chip in the Super chat', await until(() => p.locator('[data-testid="phone-job-row"]:visible').count(), 15000));
  report.check('5 a job at work says Working', await until(async () => (await p.locator('[data-testid="phone-job-row"][data-state="working"]').count()) === 1, 8000));
  const jobs = await p.locator('[data-testid="phone-job-row"]').allInnerTexts();
  report.check('5 each row has a name and a state; ended means Finished', jobs.some((j) => /Release notes[\s\S]*Working/.test(j)) && jobs.some((j) => /Old cleanup[\s\S]*Finished/.test(j)), JSON.stringify(jobs));
  await ph.shot('6-super-jobs-working');
  await p.locator('[data-testid="phone-job-row"]', { hasText: 'Release notes' }).click();
  await p.getByTestId('phone-job-open-chat').click();
  report.check('5 a tap reads that job\'s chat', await until(async () => (await p.getByTestId('phone-agents-sheet').innerText().catch(() => '')).includes('ECHO child work'), 10000));
  report.check('5 it is read only: no composer in the sheet', await p.locator('[data-testid="phone-agents-sheet"] .chat-cmp-input').count() === 0);
  await sleep(400);
  report.check('5 the sheet takes the focus', await p.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'phone-job-close'));
  await ph.shot('7-job-transcript');
  await p.getByTestId('phone-job-close').click(); await sleep(400);
  report.check('5 closing gives the focus back to the chip', await p.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'phone-agents-chip'));
  await p.locator('.chat-cmp-input:visible').first().fill('half a thought').catch(() => {});
  await sleep(300);
  // A phone held sideways is still a phone.
  await p.setViewportSize({ width: 844, height: 390 }); await sleep(800);
  await p.getByTestId('ns-rail-more').click(); await sleep(400);
  const sideways = await p.locator('[data-testid="ns-more-menu"] [role="menuitem"]').allInnerTexts();
  report.check('3 sideways More is the same three', sideways.length === 3, JSON.stringify(sideways));
  await p.keyboard.press('Escape'); await p.setViewportSize({ width: 390, height: 844 }); await sleep(600);

  console.log('\n── Computer on the tunnel, 1440');
  const pc = await open('1440', { viewport: { width: 1440, height: 900 } }, await qr());
  report.check('1440 the Super row and the owner\'s chats side by side', await until(async () => { const s = await drawerShape(pc.p, 'proj'); return s.super && s.rows.filter((r) => r.kind === 'chat').length > 0; }, 15000));
  await projRow(pc.p, 'proj').getByTestId('drawer-project-add').click();
  report.check('1440 New chat in the handed-over project starts and answers', await send(pc.p, 'hello from the computer'));
  await pc.shot('1-new-chat-super-on');

  console.log('\n── 1: Super taken back while the phone is on its chat');
  report.check('no console error on the phone with Super on', ph.errors.length === 0, ph.errors.slice(0, 4).join(' | '));
  report.check('no console error on the computer with Super on', pc.errors.length === 0, pc.errors.slice(0, 4).join(' | '));
  ph.errors.length = 0; pc.errors.length = 0;
  const dis = await api(port, 'POST', '/api/super/disable', {});
  report.check('take-back', dis.status === 200, JSON.stringify(dis.json).slice(0, 160));
  report.check('1 no chat is left saying "Connecting…"', await until(async () => !(await p.locator('.chat-cmp-input:visible[placeholder="Connecting…"]').count()), 20000));
  await ph.shot('8-after-take-back');
  report.check('1 the unsent words survive in a fresh chat', await until(async () => (await composer(p).inputValue().catch(() => '')).includes('half a thought'), 6000));
  const wire = await p.evaluate(async () => (await fetch('/api/agent/live-chats', { credentials: 'same-origin', headers: { 'X-Dreamcontext-Vault': 'proj' } })).json());
  report.check('1 the parked Super session is no chat on the wire', !wire.chats.some((c) => c.conversationId === SUPER) && !wire.supers, JSON.stringify(wire).slice(0, 240));
  await expand(p, 'proj');
  await projRow(p, 'proj').getByTestId('drawer-project-add').click();
  report.check('1 phone: a project with Super off starts a chat and gets its answer', await send(p, 'super is off now'));
  await ph.shot('9-super-off-chat');
  await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(6000);
  report.check('1 phone: after a reload no tab hangs on "Connecting…"', !(await p.locator('.chat-cmp-input:visible[placeholder="Connecting…"]').count()));
  await projRow(pc.p, 'proj').getByTestId('drawer-project-add').click();
  report.check('1 computer: a project with Super off starts a chat and gets its answer', await send(pc.p, 'computer with super off'));
  await pc.shot('2-super-off-chat');

  console.log('\n── The Mac, 1440');
  const mac = await open('mac', { viewport: { width: 1440, height: 900 } }, `http://127.0.0.1:${port}/?vault=proj`);
  report.check('4 the Mac keeps search and the face', await mac.p.locator('[data-testid="ns-search"]').count() === 1 && await mac.p.locator('.ns-titlebar .sleep-tracker').count() === 1);
  await mac.p.getByTestId('ns-rail-more').click(); await sleep(400);
  const macMore = await mac.p.locator('[data-testid="ns-more-menu"] [role="menuitem"]').allInnerTexts();
  report.check('3 the Mac\'s More is whole', macMore.length === 7 && macMore.some((x) => /Stats/.test(x)), JSON.stringify(macMore));
  await mac.shot('1-more');

  // The take-back's last gasp: a reconnect the Mac refuses until the next read drops the tab.
  // Bounded, never a loop. (The computer's stage also reads 409 once as it goes.)
  const gasp = (e) => e.includes(SUPER) || /status of 409/.test(e);
  report.check('after the take-back only its bounded last refusals', ph.errors.every(gasp) && ph.errors.length <= 3, ph.errors.join(' | '));
  report.check('after the take-back the computer logs only those too', pc.errors.every(gasp) && pc.errors.length <= 6, pc.errors.join(' | '));
  report.check('no failed request on the phone', ph.bad.length === 0, ph.bad.slice(0, 6).join(' | '));
  report.check('ApiClient refused nothing locally', (await p.evaluate(() => window.__dcPhoneRefused ?? 0)) === 0, JSON.stringify(await p.evaluate(() => window.__dcRefusals ?? [])).slice(0, 900));
  const leak = await p.evaluate(() => document.documentElement.innerHTML.includes('gamma') || JSON.stringify({ ...localStorage }).includes('gamma'));
  report.check('the unchosen project is nowhere in the DOM or storage', !leak);
  win.ws.close();
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err).slice(0, 700));
} finally {
  for (const s of sockets) { try { s.ws.close(); } catch { /* gone */ } }
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `:\n  - ${report.fails.join('\n  - ')}` : ''}`);
process.exit(report.fails.length ? 1 : 0);
