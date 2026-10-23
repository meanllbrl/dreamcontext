#!/usr/bin/env node
/**
 * Which Super answer is to which message, on the hands-free PHONE (task super-sohbetinde-her-
 * cevabin-ustunde-…, plan r2 'Observed 2'). The phone opens the Super Agent's conversation as a
 * MIRROR in an ordinary chat mode (`superMirror`), so everything here proves the client-only flag.
 *
 *   npm run build && node scripts/verify/super-reply-phone.mjs
 *
 * The rig of handsfree-super-phone.mjs (scratch HOME, Mac mode over the loopback stand-in, an
 * iPhone 13 at 390x844 with touch). The stand-in super answers two phone messages out of order,
 * each block opening with `<!-- re:<ref> -->` from the `<owner-msg ref>` it received. Checks: the
 * strip over the out-of-order answer, none over the one right under its message, the group
 * line; strips one line, no horizontal overflow; a tap on a Super answer shows its ↩ (touch has
 * no hover), the chip stages, the reply goes through the mirror with its reference header and
 * his bubble draws the ↩ strip; no `<!-- re:` in the DOM; no console error, no 403.
 *
 * Collect, don't fail fast; exit 0 iff every check passed. Screenshots: tmp/verify-super-reply-phone
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-super-reply-phone');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-super-reply-phone');
const CLI = join(REPO, 'dist', 'index.js');

/** Stand-in `claude -p --input-format stream-json`: answers two messages out of order, each
 *  block opening with the reply mark built from the `<owner-msg ref>` it received. */
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
const say = (text) => { const message = { role: 'assistant', content: [{ type: 'text', text }] }; row({ type: 'assistant', message }); out({ type: 'assistant', message }); };
const received = ${JSON.stringify(join(SCRATCH, 'received.ndjson'))};
const owners = [];
const refOf = (w) => { for (let i = owners.length - 1; i >= 0; i--) if (owners[i].text.startsWith(w)) return owners[i].ref; return 'zzzzzz'; };
let inited = false; let buf = ''; let running = false;
const end = (said) => out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const blocks = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text);
    const text = blocks[0] || '';
    for (const b of blocks) { const m = /^<owner-msg ref="([0-9a-z]{6})"\\/>$/.exec(b); if (m) owners.push({ text, ref: m[1] }); }
    fs.appendFileSync(received, JSON.stringify({ blocks, folded: running }) + '\\n');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    if (running) continue;
    if (text.startsWith('Bir:')) {
      running = true;
      const id = 'toolu_1';
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '12 passing' }] }] } });
      setTimeout(() => {
        say('<!-- re:' + refOf('İki:') + ' -->\\nİkinci mesajına: kart adı Takım oldu.');
        say('<!-- re:' + refOf('Bir:') + ' -->\\nBirinci mesajına: giriş sayfası düzeldi.');
        end('ok'); running = false;
      }, 4000);
      continue;
    }
    const said = text.startsWith('[super') ? 'Nothing needs you.' : 'Not aldım.';
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
  report.check('super on: ONE row, the Super Agent; no search, no chips, no New chat, no other chat', await until(async () => {
    shape = await listShape();
    return shape.super && shape.rows.length === 1 && shape.rows[0].kind === 'super' && shape.rows[0].id === SUPER
      && /Super Agent/.test(shape.rows[0].text) && !shape.search && !shape.chips && !shape.newChat && !shape.overflowX;
  }, 20000), JSON.stringify(shape));
  const w1 = await wire();
  report.check('super on: the wire lists no chat of the project and one live super row', Array.isArray(w1.chats) && w1.chats.length === 0
    && w1.supers?.length === 1 && w1.supers[0].conversationId === SUPER && w1.supers[0].live === true, JSON.stringify(w1).slice(0, 240));
  const rowH = await phone.evaluate(() => Math.round(document.querySelector('[data-testid="super-row"]')?.getBoundingClientRect().height ?? 0));
  report.check(`the row is a touch target (${rowH}px >= 44)`, rowH >= 44);
  await phone.screenshot({ path: join(SHOTS, '390x844-super-on.png') });

  console.log('\n── 3. The mirror: two messages answered out of order');
  await vis('[data-testid="super-row"]').click();
  report.check('the Super Agent\'s chat opens over the list', await until(async () => !(await onList()) && (await vis('.chat-cmp-input').count()) > 0, 15000));
  await phone.waitForTimeout(1500);
  report.check('the phone has no hover (touch)', await phone.evaluate(() => matchMedia('(hover: none)').matches));
  const box = vis('.chat-cmp-input').first();
  const sendText = async (t) => { await box.click(); await box.fill(t); await phone.waitForTimeout(150); await phone.keyboard.press('Enter'); };
  await sendText('Bir: giriş sayfası açılmıyor, düzelt.');
  await phone.waitForTimeout(1200);
  await sendText('İki: kartın adını Takım yap.');
  const received = () => { try { return readFileSync(join(SCRATCH, 'received.ndjson'), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  report.check('both reached the super through the mirror, each with its <owner-msg ref>', await until(async () => {
    const r = received().filter((x) => /^(Bir|İki):/.test(x.blocks[0]));
    return r.length === 2 && r.every((x) => x.blocks.some((b) => /^<owner-msg ref="[0-9a-z]{6}"\/>$/.test(b)));
  }, 15000), JSON.stringify(received().slice(-2)));
  const pane = () => vis('.chat-pane').first();
  report.check('the answers arrived', await until(async () => (await pane().innerText()).includes('Birinci mesajına'), 20000));
  await phone.waitForTimeout(800);
  const rows = await phone.evaluate(() => {
    const inner = [...document.querySelectorAll('.chat-scroll-inner')].find((e) => e.getBoundingClientRect().height > 0);
    return [...(inner?.children ?? [])].map((el) => ({ strip: el.getAttribute('data-reply-strip'), grp: el.getAttribute('data-reply-grp'), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90), h: Math.round(el.getBoundingClientRect().height), r: Math.round(el.getBoundingClientRect().right) }));
  });
  const t2 = rows.find((x) => x.text.startsWith('İkinci mesajına'));
  const t1 = rows.find((x) => x.text.startsWith('Birinci mesajına'));
  report.check('the answer right under its message draws no strip; the other names the first message', !!t2?.grp && !rows.some((x) => x.strip === t2.grp)
    && /To your message.*Bir: giriş sayfası/.test(rows.find((x) => x.strip === t1?.grp)?.text ?? ''), JSON.stringify(rows.slice(-6)));
  const stripRow = rows.find((x) => x.strip === t1?.grp);
  report.check(`the strip is one line (${stripRow?.h}px) inside the screen`, !!stripRow && stripRow.h <= 26 && stripRow.r <= 390);
  report.check('the group line is drawn', await phone.evaluate(() => [...document.querySelectorAll('.chat-reply-line')].some((l) => l.getBoundingClientRect().height > 20)));
  report.check('no horizontal overflow', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  report.check('no `<!-- re:` in the DOM', await phone.evaluate(() => !document.body.innerHTML.includes('&lt;!-- re:') && !document.body.innerText.includes('<!-- re:')));
  await phone.screenshot({ path: join(SHOTS, '390x844-strips.png') });

  console.log('\n── 4. A tap shows ↩; the reply goes through the mirror');
  const answer = vis('.chat-msg-assistant-row').filter({ hasText: 'Birinci mesajına' }).first();
  await answer.tap();
  const quote = answer.locator('[aria-label="Quote-reply"]');
  report.check('a tap on the answer shows its ↩ (the bar is visible)', await until(async () => Number(await quote.evaluate((el) => getComputedStyle(el.closest('.chat-m-hoverbar')).opacity)) === 1, 4000));
  await phone.screenshot({ path: join(SHOTS, '390x844-tap-bar.png') });
  await quote.tap();
  const chip = vis('.chat-cmp-attachment-about');
  report.check('↩ stages ONE chip "Reply to Super: …"', await until(async () => (await chip.count()) === 1 && /Reply to Super: Birinci mesajına/.test(await chip.innerText()), 5000));
  await box.click();
  await box.fill('teşekkürler');
  await phone.waitForTimeout(150);
  await phone.keyboard.press('Enter');
  report.check('the reply reaches the super with its reference header and the quote, through the mirror', await until(async () => received().some((x) =>
    /^\[Reply to message ref=[0-9a-z]{6} from=super\]\nquote: "Birinci mesajına: giriş sayfası düzeldi\."\n\nteşekkürler$/.test(x.blocks[0])), 15000), JSON.stringify(received().slice(-1)));
  const bubble = vis('.chat-msg-user-row').last();
  report.check('his bubble: the ↩ strip and only his words', await until(async () => (await bubble.locator('.chat-msg-user-bubble').innerText()) === 'teşekkürler'
    && /To Super/.test(await bubble.locator('[data-testid="chat-msg-reply"]').innerText()), 8000));
  report.check('still no horizontal overflow', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await phone.screenshot({ path: join(SHOTS, '390x844-reply-sent.png') });

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
