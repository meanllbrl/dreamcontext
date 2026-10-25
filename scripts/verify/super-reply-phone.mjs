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
 * Sections (owner 2026-10-24, pick A): three phone sends, the 2nd and 3rd steered into a busy
 * turn (plain words: a typed header is plain text since the multi-reference task), answered by ONE streamed block with a section per
 * message: three heads inside one answer body, each one line, no overflow, a head tap lands on
 * its message; the same heads after a reload.
 *
 * Several references (owner 2026-10-24, task super-e-tek-mesajda-birden-cok-referans-…): ↩ on a
 * Super answer drops a chip INTO the text at the caret (one chip: the same message as 0.34.5);
 * two ↩ give two chips inline, they fit the phone's field (the widest possible chip, a label of
 * W, at most 60% of the field: the label limit is measured here) and never break; then a voice
 * take (a real `say` WAV as the fake microphone; the Mac's whisper stood in at the HTTP edge:
 * dictation reported on, POST /api/agent/voice/stt answered) goes in after the chip the caret is
 * at and is sent: two parts, the spoken words in the second; the bubble draws both chips inline.
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
const TAKE = join(SCRATCH, 'take.wav');
const SPOKEN = 'sesli yorumum ikinci cevaba';

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
/** His words without a leading agenda About header. */
const wordsOf = (t) => t.replace(/^\\[About agenda line [^\\]\\n]*\\]\\nline: "[^\\n]*"\\n\\n/, '');
const refOf = (w) => { for (let i = owners.length - 1; i >= 0; i--) if (wordsOf(owners[i].text).startsWith(w)) return owners[i].ref; return 'zzzzzz'; };
/** One block streamed in deltas, then its echo and the turn's end. */
const streamThenEnd = (pieces) => {
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  let i = 0;
  const next = () => {
    if (i < pieces.length) { out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: pieces[i++] } } }); setTimeout(next, 450); return; }
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    say(pieces.join('')); end('ok'); running = false;
  };
  next();
};
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
    if (text.startsWith('GENIS')) { const w = 'W'.repeat(40); say(w); end(w); continue; }
    if (text.startsWith('BOLUMLER')) {
      running = true;
      say('Bakıyorum.');
      const id = 'toolu_2';
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'dreamcontext super state', description: 'Read the state' } }] } });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }] } });
      setTimeout(() => streamThenEnd(['<!-- re:' + refOf('BOLUMLER'), ' -->\\nBOLUMLER mesajına: üçü de elimde.\\n\\n<!-', '- re:' + refOf('Fiyat kartı bitti mi') + ' -->\\n', 'Fiyat kartı: Takım oldu.\\n\\n<!-- re:' + refOf('Dağıtım ne durumda') + ' -->\\n', 'Dağıtım: yeşil.']), 6000);
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

  // The microphone is a fake device playing a sentence macOS \`say\` spoke (the voice section).
  spawnSync('say', ['-o', TAKE, '--data-format=LEI16@16000', 'Bu benim sesli yorumum, ikinci cevaba.']);
  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${TAKE}`] });
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
  // Owner 2026-10-24: the chip is IN the text (a token the mirror tints), never a row above.
  const chip = vis('.chat-cmp-hl mark.chat-cmp-hl-ref');
  report.check('↩ drops ONE chip into the text: "↩ Super: …"', await until(async () => (await chip.count()) === 1 && /\u21a9\u00a0Super:\u00a0Birinci/.test(await box.inputValue()), 5000), JSON.stringify(await box.inputValue()));
  report.check('…no chip row above the box', (await vis('.chat-cmp-attachment-about').count()) === 0);
  await box.click();
  await phone.keyboard.type('teşekkürler');
  await phone.waitForTimeout(150);
  await phone.keyboard.press('Enter');
  report.check('the reply reaches the super with its reference header and the quote, through the mirror', await until(async () => received().some((x) =>
    /^\[Reply to message ref=[0-9a-z]{6} from=super\]\nquote: "Birinci mesajına: giriş sayfası düzeldi\."\n\nteşekkürler$/.test(x.blocks[0])), 15000), JSON.stringify(received().slice(-1)));
  const bubble = vis('.chat-msg-user-row').last();
  report.check('his bubble: the ↩ strip and only his words', await until(async () => (await bubble.locator('.chat-msg-user-bubble').innerText()) === 'teşekkürler'
    && /To Super/.test(await bubble.locator('[data-testid="chat-msg-reply"]').innerText()), 8000));
  report.check('still no horizontal overflow', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await phone.screenshot({ path: join(SHOTS, '390x844-reply-sent.png') });

  console.log('\n── 4b. One answer, a section per message: heads inside one body');
  // Plain words: a typed `[About agenda line …]` is neutralised in the Super view (only a chip
  // makes a header, owner 2026-10-24), and the phone has no agenda to press.
  const SEC_B = 'Fiyat kartı bitti mi?';
  const SEC_C = 'Dağıtım ne durumda?';
  await sendText('BOLUMLER: üç işi tek cevapta topla.');
  await phone.waitForTimeout(1500);
  await sendText(SEC_B);
  await phone.waitForTimeout(600);
  await sendText(SEC_C);
  report.check('the three reached the super, the 2nd and 3rd folded into its turn', await until(async () => {
    const r = received().filter((x) => /^(BOLUMLER|Fiyat kartı bitti|Dağıtım ne durumda)/.test(x.blocks[0]));
    return r.length === 3 && r[1].folded && r[2].folded && r[1].blocks[0] === SEC_B;
  }, 15000), JSON.stringify(received().slice(-3).map((x) => [x.blocks[0].slice(0, 40), x.folded])));
  const secRow = () => vis('.chat-msg-assistant-row').filter({ hasText: 'BOLUMLER mesajına' }).last();
  report.check('the sectioned answer arrived with three heads', await until(async () => (await secRow().locator('[data-testid="chat-reply-head"]').count()) === 3 && (await pane().innerText()).includes('Dağıtım: yeşil'), 30000));
  await phone.waitForTimeout(800);
  const headInfo = () => secRow().evaluate((row) => {
    const hs = [...row.querySelectorAll('[data-testid="chat-reply-head"]')];
    return {
      oneBody: new Set(hs.map((h) => h.closest('.chat-msg-assistant-body'))).size === 1,
      heads: hs.map((h) => { const r = h.getBoundingClientRect(); return { h: Math.round(r.height), right: Math.round(r.right), dot: !!h.querySelector('.chat-msg-about-dot'), text: (h.textContent || '').replace(/\s+/g, ' ').trim() }; }),
    };
  });
  const hi = await headInfo();
  report.check('three heads inside ONE answer body, each "To your message" with its words', hi.oneBody && hi.heads.length === 3
    && /To your message.*BOLUMLER/.test(hi.heads[0].text) && /To your message.*Fiyat kartı bitti mi/.test(hi.heads[1].text) && /To your message.*Dağıtım ne durumda/.test(hi.heads[2].text), JSON.stringify(hi));
  report.check('each head one line inside the screen', hi.heads.every((h) => h.h <= 26 && h.right <= 390), JSON.stringify(hi.heads));
  report.check('no strip over it, no "To 3 messages"', !(await pane().innerText()).includes('To 3 messages')
    && await secRow().evaluate((row) => !document.querySelector(`[data-reply-strip="${row.getAttribute('data-reply-grp')}"]`)));
  report.check('no horizontal overflow with the heads', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await secRow().locator('[data-testid="chat-reply-head"]').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: join(SHOTS, '390x844-sections.png') });
  const bRow = vis('.chat-msg-user-row').filter({ hasText: 'Fiyat kartı bitti mi' }).first();
  const bId = await bRow.getAttribute('data-item-id');
  await vis('.chat-scroll').first().evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await phone.waitForTimeout(300);
  await secRow().locator('[data-testid="chat-reply-head"]').nth(1).tap();
  report.check('a tap on head 2 lands on message 2', await until(() => phone.evaluate((id) => {
    const row = [...document.querySelectorAll(`[data-item-id="${id}"]`)].find((e) => e.getBoundingClientRect().height > 0);
    const sc = row?.closest('.chat-scroll');
    if (!row || !sc) return false;
    const r = row.getBoundingClientRect(); const v = sc.getBoundingClientRect();
    return r.bottom > v.top + 8 && r.top < v.bottom - 8;
  }, bId), 4000), bId);
  await phone.screenshot({ path: join(SHOTS, '390x844-head-tap.png') });

  console.log('\n── 4c. Two references, the label measured, a voice take into the second');
  // The Mac's whisper, stood in at the HTTP edge: dictation on, and the take's transcript.
  const stt = [];
  await phone.route('**/api/agent/capabilities*', async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => ({}));
    await route.fulfill({ response: res, json: { ...body, dictation: true } });
  });
  await phone.route('**/api/agent/voice/stt*', async (route) => {
    stt.push({ bytes: (route.request().postDataBuffer() ?? Buffer.alloc(0)).length });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: SPOKEN }) });
  });
  await phone.reload({ waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(2500);
  if (await onList()) await vis('[data-testid="super-row"]').click().catch(() => {});
  await until(async () => (await vis('.chat-cmp-input').count()) > 0, 15000);
  await phone.waitForTimeout(1200);
  const box2 = vis('.chat-cmp-input').first();
  // An answer of forty W's to reply to, asked for before any chip is staged.
  await box2.click();
  await box2.fill('GENIS bir cevap ver');
  await phone.waitForTimeout(150);
  await phone.keyboard.press('Enter');
  await until(async () => (await vis('.chat-msg-assistant-row').filter({ hasText: 'WWWWWWWWWW' }).count()) > 0, 15000);
  for (const word of ['Birinci mesajına', 'İkinci mesajına']) {
    // The tap that shows the bar is proven in section 4; here the ↩ is pressed directly.
    const ans = vis('.chat-msg-assistant-row').filter({ hasText: word }).first();
    await ans.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await ans.locator('[aria-label="Quote-reply"]').evaluate((el) => el.click());
    await phone.waitForTimeout(400);
  }
  const marks2 = vis('.chat-cmp-hl mark.chat-cmp-hl-ref');
  report.check('two ↩: two chips in the text, slots 1 and 2', await until(async () => (await marks2.count()) === 2
    && JSON.stringify(await marks2.evaluateAll((ms) => ms.map((m) => m.getAttribute('data-slot')))) === '["1","2"]', 5000));
  // The widest possible chip: a reply to an answer of forty W's, clipped to fit this field.
  const wAns = vis('.chat-msg-assistant-row').filter({ hasText: 'WWWWWWWWWW' }).last();
  await wAns.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await wAns.locator('[aria-label="Quote-reply"]').evaluate((el) => el.click());
  await phone.waitForTimeout(500);
  const fit = await phone.evaluate(() => {
    const ta = [...document.querySelectorAll('.chat-cmp-input')].find((e) => e.getBoundingClientRect().height > 0);
    const field = ta.closest('.chat-cmp-field').getBoundingClientRect().width;
    const real = [...document.querySelectorAll('.chat-cmp-hl mark.chat-cmp-hl-ref')].filter((m) => m.getBoundingClientRect().height > 0)
      .map((m) => ({ w: Math.round(m.getBoundingClientRect().width), rects: m.getClientRects().length, label: (m.textContent || '').replace(/[\u2061-\u2069]/g, '') }));
    return { field: Math.round(field), real };
  });
  console.log(`      measured: ${JSON.stringify(fit)}`);
  const widest = Math.max(...fit.real.map((m) => m.w));
  report.check(`three chips, the widest (forty W's, clipped) at most 60% of the ${fit.field}px field: ${widest}px`, fit.real.length === 3 && widest <= 0.6 * fit.field, JSON.stringify(fit));
  report.check('…a chip of ordinary words keeps its 24 letters', fit.real.some((m) => Array.from(m.label).length >= 24), JSON.stringify(fit.real.map((m) => m.label)));
  report.check('the chips in the box never break across lines', fit.real.every((m) => m.rects === 1), JSON.stringify(fit.real));
  // The mirror draws the tint under the textarea's own text: the two must share one size.
  const sizes = await phone.evaluate(() => {
    const ta = [...document.querySelectorAll('.chat-cmp-input')].find((e) => e.getBoundingClientRect().height > 0);
    const hl = ta.parentElement.querySelector('.chat-cmp-hl');
    return [getComputedStyle(ta).fontSize, hl ? getComputedStyle(hl).fontSize : null];
  });
  report.check(`the chip tints sit under their words (mirror and box both ${sizes[0]})`, sizes[0] === sizes[1], JSON.stringify(sizes));
  report.check('no horizontal overflow with two chips', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await phone.screenshot({ path: join(SHOTS, '390x844-two-chips.png') });
  // The voice take: the caret is after chip 2 (the last ↩); hold, speak, let go.
  const mic = vis('.chat-cmp-mic').first();
  report.check('the hold-to-talk mic is drawn (dictation on)', await until(async () => (await mic.count()) === 1, 10000));
  const cdp2 = await ctx.newCDPSession(phone);
  await phone.mouse.move(1, 1);
  await phone.waitForTimeout(600);
  const mb = await mic.boundingBox();
  const pt = [{ x: mb.x + mb.width / 2, y: mb.y + mb.height / 2, id: 1 }];
  const before = received().length;
  await cdp2.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  report.check('holding it records', await until(async () => (await vis('.chat-cmp-mic.is-recording').count()) === 1, 5000));
  await phone.waitForTimeout(2600);
  await cdp2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  report.check('the take went to the stood-in whisper', await until(async () => stt.length >= 1, 20000), JSON.stringify(stt));
  report.check('the spoken message goes with all three blocks, the spoken words after the last chip', await until(async () => {
    const f = received().slice(before).find((x) => /^\[Reply to message/.test(x.blocks[0]));
    if (!f) return false;
    const t = f.blocks[0];
    const heads = [...t.matchAll(/(^|\n\n)\[Reply to message ref=/g)].length;
    return heads === 3 && t.endsWith(SPOKEN) && t.indexOf(SPOKEN) > t.lastIndexOf('[Reply to message') && f.blocks.some((b) => / parts="[0-9a-z]{6} [0-9a-z]{6} [0-9a-z]{6}"\/>$/.test(b));
  }, 20000), JSON.stringify(received().slice(before).map((x) => x.blocks)));
  report.check('no chip was lost: the box is empty after the send', await until(async () => (await box2.inputValue()) === '', 8000), JSON.stringify(await box2.inputValue()));
  const vb = vis('.chat-msg-user-row').last();
  report.check('the bubble draws the three chips inline with the spoken words', await until(async () => (await vb.locator('[data-testid="chat-msg-parts"] .chat-ref-chip').count()) === 3
    && (await vb.innerText()).includes(SPOKEN) && !(await vb.innerText()).includes('[Reply to message'), 8000));
  report.check('still no horizontal overflow', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await vb.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: join(SHOTS, '390x844-voice-two-parts.png') });

  console.log('\n── 5. A reload: the phone still knows the Super conversation');
  await phone.reload({ waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(3000);
  report.check('the Super conversation id is kept across the reload', await phone.evaluate((id) => (localStorage.getItem('dreamcontext-super-mirror-ids') ?? '').includes(id), SUPER));
  if (await onList()) await vis('[data-testid="super-row"]').click().catch(() => {});
  report.check('after the reload the strip and the reply strip draw again from the replay', await until(async () => {
    const t = (await pane().innerText().catch(() => '')).replace(/\s+/g, ' ');
    return /To your message Bir: giriş sayfası/.test(t) && (await vis('[data-testid="chat-msg-reply"]').count()) >= 1 && !t.includes('<!--');
  }, 20000), (await pane().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(-300));
  report.check('…and the sectioned answer draws its three heads again', await until(async () => (await secRow().locator('[data-testid="chat-reply-head"]').count()) === 3, 15000));
  await phone.screenshot({ path: join(SHOTS, '390x844-after-reload.png') });

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
