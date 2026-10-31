#!/usr/bin/env node
/**
 * A card dropped on the Super chat is a chip (task super-kart-cipi), observed: the built app, a
 * stand-in `claude`, a picture card and a page card on the stage. Drop each on the centre (a real
 * drag, and "Ask about this"), see the chips in the composer, send, read the exact words the
 * Super Agent got, see the chips in the sent bubble, click one (the card comes side by side),
 * close a card and see its chip keep its title.
 *
 *   npm run build && SONUC=<dir> node scripts/verify/card-chip.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { chromium, webkit } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-card-chip-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-card-chip');
const LOGS = join(OUT, 'logs');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 1300;


// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync as mk } from 'node:fs';
import { randomUUID } from 'node:crypto';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'cap-' + process.pid;
const convo = at('--resume') || at('--session-id') || '';
const dir = process.env.HOME + '/.claude/projects/verify-card-chip';
/** Rows this process wrote, by uuid: a rewind gives his message back from here. */
const rows = new Map();
function row(o) {
  if (role !== 'super' || !/^[0-9a-f-]{36}$/.test(convo)) return;
  mk(dir, { recursive: true });
  const uuid = randomUUID();
  rows.set(uuid, o);
  appendFileSync(dir + '/' + convo + '.jsonl', JSON.stringify({ ...o, sessionId: convo, uuid, timestamp: new Date().toISOString() }) + '\\n');
}
const cli = (...args) => spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
};
let seq = 0;
const toolCall = (name, input, result) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  const use = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
  out(use); row(use);
  const res = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result }], is_error: false }] } };
  out(res); row(res);
};
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    mk(process.cwd() + '/_dream_context/tmp/super', { recursive: true });
    writeFileSync(process.cwd() + '/_dream_context/tmp/super/plan.html', '<!doctype html><body style="font:16px system-ui;padding:16px"><h1>Tek ekip önerisi</h1><p>Karttaki rapor.</p></body>');
    const a = cli('super', 'open', 'web', '_dream_context/tmp/super/plan.html', '--title', 'Tek ekip önerisi');
    const b = cli('super', 'open', 'image', '_dream_context/tmp/super/odeme.png', '--title', 'Ödeme ekranı taslağı');
    let ids = [];
    for (const r of [a, b]) { try { ids.push(JSON.parse(r.stdout).container.id); } catch {} }
    const f = ids.map((id) => cli('super', 'float', id));
    report({ kind: 'cards', ids, out: [a.stderr, b.stderr, ...f.map((x) => (x.stderr || '').slice(0, 200))].join(' ') });
    return 'Devraldım.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 200) }); return null; }
  report({ kind: 'owner', text: text.slice(0, 3000) });
  return 'Not aldım.';
}
async function childTurn() { return 'Fatura toplamları yeni ledger API üstünde.'; }
let inited = false;
let running = false;
let chain = Promise.resolve();
async function turn(blocks, parts) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '', parts) : await childTurn(); } catch (e) { said = 'error ' + e; }
  if (said) say(said);
  out({ type: 'result', subtype: 'success', is_error: false, result: said ?? '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'turn-end', said: (said ?? '').slice(0, 80) });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      const req = o.request || {};
      let response = {};
      if (req.subtype === 'rewind_conversation') {
        const r = rows.get(req.target_message_uuid);
        const t = r && r.message && r.message.content && r.message.content[0] && r.message.content[0].text;
        response = { rewound: !!t, prefillText: t || '' };
        report({ kind: 'rewind', ok: !!t });
      }
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response } });
      continue;
    }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    let parts = [];
    for (const b of blocks) { const m = /^<owner-msg ref="([0-9a-z]{6})"(?: parts="([0-9a-z ]+)")?\\/>$/.exec(b); if (m && m[2]) parts = m[2].split(' '); }
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    if (running) row({ type: 'attachment', attachment: { type: 'queued_command', prompt: blocks.map((text) => ({ type: 'text', text })) } });
    else row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: blocks[0] }] } });
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks, parts)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT, LOGS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  mkdirSync(join(PROJ, '_dream_context', 'tmp', 'super'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'tmp', 'super', 'odeme.png'), png(320, 200));
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'orbit', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(LOGS, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const frames = () => readNd(FRAMES);
const superFrames = () => frames().filter((f) => f.role === 'super');
const log = (...a) => console.log(...a);
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };

async function clean(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove());
    if (!document.getElementById('cap-kill')) {
      const s = document.createElement('style'); s.id = 'cap-kill';
      s.textContent = '.announcements-modal-scrim,.sleep-tracker-wrap{display:none!important}';
      document.head.appendChild(s);
    }
  });
}
async function shot(page, name) { await clean(page); await page.screenshot({ path: join(process.env.SONUC || OUT, name) }); log(`  saved ${name}`); }
const motionIdle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };

const centre = (page) => page.locator('[data-super-slot="centre"]');
const centreInput = (page) => centre(page).locator('.chat-cmp-input').first();
const turnEnds = () => reports().filter((r) => r.role === 'super' && r.kind === 'turn-end').length;
async function send(page, text) {
  await centreInput(page).click();
  await page.keyboard.type(text, { delay: 8 });
  await page.keyboard.press('Enter');
}
async function sendAndWait(page, text) {
  const before = turnEnds();
  await send(page, text);
  return until(page, async () => turnEnds() > before, 40000);
}
/** The centre's transcript as a list: each strip and row, in order. */
const transcriptShape = (page) => page.evaluate(() => {
  const inner = document.querySelector('[data-super-slot="centre"] .chat-scroll-inner');
  if (!inner) return [];
  return [...inner.children].map((el) => ({
    strip: el.getAttribute('data-reply-strip'),
    grp: el.getAttribute('data-reply-grp'),
    id: el.getAttribute('data-item-id'),
    kind: el.classList.contains('chat-msg-user-row') ? 'user' : el.classList.contains('chat-msg-assistant-row') ? 'text' : el.classList.contains('chat-reply-strip') ? 'strip' : 'other',
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
});
const scroller = (page) => centre(page).locator('.chat-scroll').first();
const inView = (page, sel) => page.evaluate((s) => {
  const row = document.querySelector(s);
  const sc = document.querySelector('[data-super-slot="centre"] .chat-scroll');
  if (!row || !sc) return false;
  const r = row.getBoundingClientRect(); const v = sc.getBoundingClientRect();
  return r.bottom > v.top + 8 && r.top < v.bottom - 8;
}, sel);
const userRowSel = async (page, word) => {
  const id = await centre(page).locator('.chat-msg-user-row').filter({ hasText: word }).first().getAttribute('data-item-id').catch(() => null);
  return id ? `[data-super-slot="centre"] [data-item-id="${id}"]` : null;
};
const noMarkInDom = (page) => page.evaluate(() => !document.body.innerHTML.includes('&lt;!-- re:') && !document.body.innerHTML.includes('<!-- re:') && !document.body.innerText.includes('<!-- re:'));

async function backToStage(page) {
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await clean(page);
  if (!(await page.getByTestId('super-surface').isVisible().catch(() => false))) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) await nav.click().catch(() => {});
  }
  await until(page, async () => page.getByTestId('super-surface').isVisible(), 30000);
  await motionIdle(page);
}

const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return {}; } };
const agendaRow = (page, text) => page.locator('[data-testid="super-agenda-row"]').filter({ hasText: text }).first();
async function aboutRow(page, text) {
  const row = agendaRow(page, text);
  await row.hover().catch(() => {});
  await row.locator('[data-testid="super-agenda-about"]').click();
  await page.waitForTimeout(250);
}
const value = (page) => centreInput(page).inputValue();
const tokensIn = (v) => [...v.matchAll(/\u2068\u00A0?([●↩])\u00A0/g)].map((m) => ({ glyph: m[1] }));
const stripped = (v) => v.replace(/\u2068[^\u2069]*\u2069/g, '').replace(/\s+/g, ' ').trim();
const marks = (page) => centre(page).locator('.chat-cmp-hl mark.chat-cmp-hl-ref');
const markInfo = (page) => marks(page).evaluateAll((ms) => ms.map((m) => ({ slot: m.getAttribute('data-slot'), flash: m.classList.contains('is-flash'), rects: m.getClientRects().length, w: Math.round(m.getBoundingClientRect().width), bg: getComputedStyle(m).backgroundColor })));
const caret = (page) => centreInput(page).evaluate((el) => [el.selectionStart, el.selectionEnd]);
const setCaret = (page, a, b = a) => centreInput(page).evaluate((el, [x, y]) => { el.focus(); el.setSelectionRange(x, y); el.dispatchEvent(new Event('select')); }, [a, b]);
const typeIn = async (page, text) => { await page.keyboard.type(text, { delay: 6 }); await page.waitForTimeout(80); };
const aboutHeadCount = (t) => [...t.matchAll(/(^|\n\n)\[About agenda line note=/g)].length;
const headerText = (page) => page.evaluate(() => /\[About agenda line|\[Reply to message/.test(document.querySelector('[data-super-slot="centre"]')?.innerText ?? ''));



/** A small synthetic picture (a two-tone mock screen), so the picture card has something to show. */
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    const bar = y < 34; const btn = y > 150 && y < 180 && x > 40 && x < 280;
    raw[o] = bar ? 60 : btn ? 255 : 235; raw[o + 1] = bar ? 90 : btn ? 140 : 238; raw[o + 2] = bar ? 200 : btn ? 50 : 245;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const cardEl = (page, kind) => page.locator(`[data-testid="super-container"][data-kind="${kind}"]`).first();
const cardChipsIn = (v) => [...v.matchAll(/\u2068\u00A0?\u2003\u2060?\u2003\u2060?\u00A0([^\u2069]*?)\u00A0?[\u2061-\u2064]+\u2069/g)].map((m) => m[1].replace(/\u00A0/g, ' '));
const SONUC = process.env.SONUC || OUT;

async function main() {
  setupScratch();
  mkdirSync(SONUC, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base}, scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'tr-TR' });
  await context.addInitScript(() => { try { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'dark'); } catch {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${base}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await clean(page);
    if (!(await page.locator('.agent-surface.expanded').count())) {
      const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*(Chat|Sohbet)\s*\d*\s*$/ }).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat|Sohbet başlat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 90000);
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill('Fatura toplamlarını yeni ledger API üstüne taşı.');
    await page.keyboard.press('Enter');
    await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'turn-end'), 60000);
    await page.waitForTimeout(1000);

    await page.locator('aside, nav').getByText(/^(Super Agent|Süper Ajan)$/).first().click();
    await page.waitForTimeout(1500);
    if (!(await centreInput(page).count())) { const b = page.getByRole('button', { name: /Start|Wake|Turn on|Hand over|devret/i }).first(); if (await b.count()) await b.click().catch(() => {}); }
    ok('the super took over', await until(page, async () => (await centreInput(page).count()) > 0, 60000));
    await until(page, async () => reports().some((r) => r.kind === 'cards'), 45000);
    await motionIdle(page);
    await page.waitForTimeout(1200);
    // The page card opened side by side: back to the floating stage (its panel's minimize).
    const mini = page.getByTestId('super-card-minimize').first();
    if (await mini.count()) { await mini.click().catch(() => {}); await motionIdle(page); await page.waitForTimeout(800); }
    ok('two cards on the stage', await until(page, async () => (await cardEl(page, 'image').getAttribute('data-where').catch(() => null)) === 'float' && (await cardEl(page, 'web').getAttribute('data-where').catch(() => null)) === 'float', 30000), JSON.stringify(reports().filter((r) => r.kind === 'cards')));
    await motionIdle(page);
    await page.waitForTimeout(1500);
    const imgId = await cardEl(page, 'image').getAttribute('data-container-id');
    const webId = await cardEl(page, 'web').getAttribute('data-container-id');

    // 1. Words, the page card by its "Ask about this", more words, the picture card by a real drag
    //    onto the centre. (The composer puts a space after a chip, as the raw drop did.)
    await centreInput(page).click();
    await page.keyboard.type('Şuna bak ', { delay: 6 });
    await cardEl(page, 'web').hover();
    await cardEl(page, 'web').getByTestId('super-card-ask').click();
    await page.waitForTimeout(500);
    ok('page card asked about: a chip at the caret', cardChipsIn(await value(page)).length === 1, JSON.stringify(await value(page)));
    await setCaret(page, (await value(page)).length);
    await page.keyboard.type('ve şu taslak ', { delay: 6 });
    const ib = await cardEl(page, 'image').boundingBox();
    const cb = await centre(page).boundingBox();
    const from = { x: ib.x + ib.width / 2, y: ib.y + ib.height * 0.62 };
    const to = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 14; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / 14, from.y + (to.y - from.y) * i / 14); await page.waitForTimeout(16); }
    await page.mouse.up();
    await page.waitForTimeout(900);
    ok('picture card dropped on the centre by a real drag: a second chip', cardChipsIn(await value(page)).length === 2, JSON.stringify(await value(page)));
    await setCaret(page, (await value(page)).length);
    await page.keyboard.type('aynı mı?', { delay: 6 });
    const v = await value(page);
    ok('the composer holds two chips and no raw @card words', cardChipsIn(v).length === 2 && !v.includes('@card:'), JSON.stringify(v));
    const hl = await centre(page).locator('.chat-cmp-hl mark.chat-cmp-hl-img').evaluateAll((ms) => ms.map((m) => {
      const th = m.querySelector('.chat-cmp-hl-thumb');
      return { icon: th?.getAttribute('data-icon') ?? null, img: (th && getComputedStyle(th).backgroundImage) || '', text: m.textContent.replace(/[\u2000-\u206f\u00a0]/g, ' ').trim() };
    }));
    ok('page chip: its icon and title', hl[0] && hl[0].icon === '◎' && hl[0].text.includes('Tek ekip'), JSON.stringify(hl));
    ok('picture chip: its picture and title', hl[1] && /agent\/file/.test(hl[1].img) && hl[1].text.includes('Ödeme'), JSON.stringify(hl));
    await centre(page).locator('.chat-cmp-wrap, .chat-cmp').first().screenshot({ path: join(SONUC, '01-composer-cipler.png') }).catch(async () => { await shot(page, '01-composer-cipler.png'); });
    await shot(page, '01-sahne-composer.png');

    // 2. Send: the Super gets today's words.
    const before = turnEnds();
    await page.keyboard.press('Enter');
    await until(page, async () => turnEnds() > before, 40000);
    const owner = reports().filter((r) => r.kind === 'owner').pop()?.text ?? '';
    const want = `Şuna bak @card:${webId} “Tek ekip önerisi” ve şu taslak @card:${imgId} “Ödeme ekranı taslağı” aynı mı?`;
    ok('the Super got exactly the @card words', owner === want, JSON.stringify({ owner, want }));
    await page.waitForTimeout(800);
    const row = centre(page).locator('.chat-msg-user-row').last();
    const chips = row.locator('[data-testid="chat-msg-card"]');
    ok('the sent bubble: two card chips', (await chips.count()) === 2);
    ok('…and no raw @card words', !(await row.innerText()).includes('@card:'), await row.innerText());
    await row.screenshot({ path: join(SONUC, '02-gonderilen-mesaj.png') });

    // 3. The picture card closed for good: its chip keeps its title, quietly, and does nothing.
    await cardEl(page, 'image').hover();
    await cardEl(page, 'image').getByTestId('super-card-close').click();
    ok('the picture card left the stage (closed from its card)', await until(page, async () => (await cardEl(page, 'image').count()) === 0 && !JSON.stringify(record().containers ?? []).includes(imgId), 15000));
    await page.waitForTimeout(600);
    const gone = row.locator('[data-testid="chat-msg-card"]').nth(1);
    ok('its chip stays, with its title, marked gone', (await gone.getAttribute('data-state')) === 'gone' && (await gone.innerText()).includes('Ödeme'), `${await gone.getAttribute('data-state')} ${await gone.innerText()}`);
    ok('…and is not a button', (await gone.getAttribute('role')) === null);
    await row.screenshot({ path: join(SONUC, '03-kart-kapandi.png') });

    // 4. Click the page card's chip: it comes side by side.
    await chips.first().click();
    const sideBy = await until(page, async () => JSON.stringify(record()).includes(`"card":"${webId}"`) && (await cardEl(page, 'web').getAttribute('data-where')) !== 'float', 8000);
    ok('clicking a chip brings its card into view (side by side)', sideBy, `${await cardEl(page, 'web').getAttribute('data-where')} ${JSON.stringify(record().view ?? null)}`);
    await page.waitForTimeout(900);
    await shot(page, '04-cipe-tiklandi.png');

    // 5. ↑ recalls the message with its chips, never the raw words.
    await centreInput(page).click();
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(400);
    const back = await value(page);
    ok('↑ brings the message back with its chips', cardChipsIn(back).length === 2 && !back.includes('@card:'), JSON.stringify(back));
    await centreInput(page).fill('');

    ok('zero page errors', errors.filter((e) => !/WebSocket|favicon|401|403 \(/.test(e)).length === 0, errors.slice(0, 4).join(' | '));
  } catch (e) {
    ok('the run finished', false, String(e?.stack ?? e));
    await page.screenshot({ path: join(SONUC, 'crash.png') }).catch(() => {});
  }
  await browser.close();
  srv.kill();
  log(failures ? `FAILED ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
}
main();
