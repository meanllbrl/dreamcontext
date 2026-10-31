#!/usr/bin/env node
/**
 * Copy and Comment under selected text, observed (task secili-metne-yorum-…): the built app, a stand-in
 * `claude`, real mouse drags in a normal chat, a Super answer, a dream-html block and a report card.
 *
 *   npm run build && node scripts/verify/selection-comment.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { chromium, webkit } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-selection-comment-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-selection-comment');
const LOGS = join(OUT, 'logs');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 1300;
const WIDE = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
const NOTES = [
  ['waiting', 'Windows için otomatik test eklensin mi'],
  ['waiting', 'Doküman sayfası yayına hazır mı'],
  ['now', 'Ödeme formunun ikinci adımı'],
  ['now', 'Fiyat kartı adı Takım oldu mu'],
  ['waiting', 'Bülten taslağına bir göz at'],
  ['waiting', WIDE],
];

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
const dir = process.env.HOME + '/.claude/projects/verify-selection-comment';
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
const NOTES = ${JSON.stringify(NOTES)};
async function superTurn(text, parts) {
  if (text.startsWith('[super handover]')) {
    for (const [sec, line] of NOTES) cli('super', 'note', 'add', sec, line);
    report({ kind: 'handover' });
    return 'Devraldım.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 200) }); return null; }
  if (/^HAZIR/.test(text)) return 'Planı yazdım: ödeme formu iki adımda bitiyor, testler yeşil.';
  if (/^BLOK/.test(text)) { const f = String.fromCharCode(96).repeat(3); return ['Blok geldi.', '', f + 'dream-html', '<div class="dc-doc dc-doc--hug"><p class="dc-p" id="blok">Bloktaki plan cümlesi burada duruyor ve seçilebilir.</p></div>', f, '', 'Blok bitti.'].join(String.fromCharCode(10)); }
  if (/^KART/.test(text)) {
    mk(process.cwd() + '/_dream_context/tmp/super', { recursive: true });
    writeFileSync(process.cwd() + '/_dream_context/tmp/super/plan.html', '<!doctype html><h1 id="b">Tek ekip önerisi</h1><p id="k">Karttaki rapor cümlesi burada duruyor ve yorum bekliyor.</p>');
    const r = cli('super', 'open', 'web', '_dream_context/tmp/super/plan.html', '--title', 'Tek ekip önerisi');
    report({ kind: 'card', out: (r.stdout || '') + (r.stderr || '') });
    return 'Kartı açtım.';
  }
  if (/^MESGUL/.test(text)) {
    say('Uzun bir iş yapıyorum.');
    toolCall('Bash', { command: 'sleep 9', description: 'Long job' }, '');
    report({ kind: 'busy' });
    await sleep(9000);
    return 'Bitti.';
  }
  if (parts.length >= 99) {
    // A section per part, in his order; the stacked pair (2 and 3) one mark per line.
    report({ kind: 'parts', parts });
    return '<!-- re:' + parts[0] + ' -->\\nİlk parçana: Windows testlerini yalnız CLI için ekliyorum.\\n\\n<!-- re:' + parts[1] + ' -->\\n<!-- re:' + parts[2] + ' -->\\nİkisine: anlaştık, devam ediyorum.';
  }
  report({ kind: 'owner', text: text.slice(0, 3000), parts });
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


const bar = (page) => page.getByTestId('selection-bar');
const SONUC = process.env.SONUC || OUT;
const keep = (name) => join(SONUC, name);
/** A real mouse drag over `phrase` inside the first text under `root` (a page or a frame). */
async function drag(page, scope, phrase, frameBox = null) {
  const find = `(p) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(p) && n.parentElement.getClientRects().length && !n.parentElement.closest('textarea,[aria-hidden="true"],[data-testid="selection-bar"]') && (!last || n.parentElement.closest('[data-super-slot="centre"]'))) last = n;
    return last;
  }`;
  const measure = () => scope.evaluate(([src, p]) => {
    const n = (0, eval)(src)(p);
    if (!n) return null;
    const at = n.data.indexOf(p); const g = document.createRange();
    g.setStart(n, at); g.setEnd(n, at + 1); const a = g.getBoundingClientRect();
    g.setStart(n, at + p.length - 1); g.setEnd(n, at + p.length); const b = g.getBoundingClientRect();
    return { x0: a.left + 0.5, y0: a.top + a.height / 2, x1: b.right - 0.5, y1: b.top + b.height / 2 };
  }, [find, phrase]);
  const r = await measure();
  if (!r) throw new Error(`no text ${phrase}`);
  const k = frameBox ?? { x: 0, y: 0 };
  await page.waitForTimeout(200);
  await page.mouse.move(k.x + r.x0, k.y + r.y0);
  await page.mouse.down();
  await page.mouse.move((k.x * 2 + r.x0 + r.x1) / 2, k.y + (r.y0 + r.y1) / 2, { steps: 4 });
  await page.mouse.move(k.x + r.x1, k.y + r.y1, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(450);
}
const barBox = (page) => bar(page).boundingBox();
const selected = (page) => page.evaluate(() => String(window.getSelection()));
const inside = (b, w, h) => !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= w && b.y + b.height <= h;

async function main() {
  setupScratch();
  mkdirSync(SONUC, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base}, scratch ${SCRATCH}`);
  const WK = process.env.ENGINE === 'webkit';
  const browser = await (WK ? webkit : chromium).launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'en-US', ...(WK ? {} : { permissions: ['clipboard-read', 'clipboard-write'] }) });
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
      const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 90000);
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill('Fatura toplamlarını yeni ledger API üstüne taşı.');
    await page.keyboard.press('Enter');
    await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'turn-end'), 60000);
    await page.waitForTimeout(1500);

    // 0. A normal chat.
    await drag(page, page, 'yeni ledger API üstünde');
    ok('normal chat: the bar shows under the selection', await bar(page).isVisible());
    ok('…the selection stays', (await selected(page)).includes('yeni ledger API üstünde'));
    await shot(page, '00-normal.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('normal chat: Esc closes it, the selection stays', !(await bar(page).isVisible()) && (await selected(page)).includes('yeni ledger'));
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.waitForTimeout(300);
    await drag(page, page, 'yeni ledger API üstünde');
    await page.getByTestId('selection-comment').click();
    await page.waitForTimeout(350);
    let nv = await input.inputValue();
    ok('normal chat: Comment drops a chip in the composer, caret there', tokensIn(nv).length === 1 && (await page.evaluate(() => document.activeElement?.className ?? '')).includes('chat-cmp-input'), `${tokensIn(nv).length} ${await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 160))}`);
    await input.fill(''); await page.waitForTimeout(200);

    await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    if (!(await centreInput(page).count())) { const b = page.getByRole('button', { name: /Start|Wake|Turn on|Hand over/ }).first(); if (await b.count()) await b.click().catch(() => {}); }
    await motionIdle(page);
    ok('the super took over', await until(page, async () => (await centreInput(page).count()) > 0, 60000));
    await motionIdle(page);
    ok('a dream-html block', await sendAndWait(page, 'BLOK göster'));
    ok('a report card', await until(page, async () => { await sendAndWait(page, 'KART aç'); return reports().some((r) => r.kind === 'card'); }, 45000), JSON.stringify(reports().filter((r) => r.kind === 'card')));
    ok('an answer to select in', await sendAndWait(page, 'HAZIR mısın?'));
    await page.waitForTimeout(1500);
    await clean(page);

    // 1. A Super message.
    await drag(page, page, 'ödeme formu iki adımda');
    ok('Super message: the bar shows', await bar(page).isVisible());
    const mb = await barBox(page);
    ok('…inside the window', inside(mb, W, H), JSON.stringify(mb));
    ok('…the selection stays', (await selected(page)) === 'ödeme formu iki adımda');
    await shot(page, '01-mesajda.png');
    await page.getByTestId('selection-copy').click();
    await page.waitForTimeout(250);
    if (!WK) ok('Copy copies the words', (await page.evaluate(() => navigator.clipboard.readText())) === 'ödeme formu iki adımda');
    ok('…and leaves the selection', (await selected(page)) === 'ödeme formu iki adımda');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('Esc closes the bar, the selection stays', !(await bar(page).isVisible()) && (await selected(page)) === 'ödeme formu iki adımda');
    await page.mouse.click(W / 3, 200);
    await page.waitForTimeout(300);
    await drag(page, page, 'ödeme formu iki adımda');
    ok('a new selection opens it again', await bar(page).isVisible());
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.waitForTimeout(350);
    ok('the selection gone: the bar gone', !(await bar(page).isVisible()));

    await drag(page, page, 'ödeme formu iki adımda');
    const cbx = await page.getByTestId('selection-copy').boundingBox();
    await page.mouse.move(cbx.x + 5, cbx.y + 5); await page.mouse.down(); await page.mouse.move(cbx.x - 200, cbx.y + 200); await page.mouse.up();
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.waitForTimeout(350);
    ok('a press slid off the bar leaves it working: deselecting closes it', !(await bar(page).isVisible()));
    await page.evaluate(() => window.postMessage({ __dreamHtmlSelection: { text: 'pencereden', x: 10, y: 10, width: 50, height: 10 } }, '*'));
    await page.waitForTimeout(250);
    ok('a report from any other window draws nothing', !(await bar(page).isVisible()));
    await centreInput(page).click();
    await typeIn(page, 'baş son ');
    await setCaret(page, 4);
    await drag(page, page, 'ödeme formu iki adımda');
    await page.getByTestId('selection-comment').click();
    await page.waitForTimeout(350);
    let v = await value(page);
    ok('the chip lands at the caret, in the middle of his words', /^baş \u2068/.test(v) && /\u2069 ?son/.test(v), JSON.stringify(v));
    await setCaret(page, (await value(page)).length);

    ok('Comment: a chip with the reply glyph', tokensIn(v).length === 1 && tokensIn(v)[0].glyph === '↩', JSON.stringify(v));
    await centreInput(page).evaluate((el) => el.focus());
    ok('…the bar is gone', !(await bar(page).isVisible()));
    await typeIn(page, 'birinci yorum ');

    // 2. Another passage of the same message: its own chip.
    await drag(page, page, 'testler yeşil');
    await page.getByTestId('selection-comment').click();
    await page.waitForTimeout(350);
    v = await value(page);
    ok('a second passage of one message is a second chip', tokensIn(v).length === 2, JSON.stringify(v));
    await typeIn(page, 'ikinci yorum ');

    // 3. A dream-html block.
    const blokBox = await centre(page).locator('iframe').first().boundingBox();
    const blokFrame = await centre(page).locator('iframe').first().elementHandle().then((h) => h.contentFrame());
    await drag(page, blokFrame, 'Bloktaki plan cümlesi', blokBox);
    ok('dream-html: the bar shows', await bar(page).isVisible());
    const fb = await barBox(page);
    ok('…under the words, inside the window', inside(fb, W, H) && fb.y > blokBox.y, JSON.stringify({ fb, blokBox }));
    await shot(page, '02-dream-html.png');
    await page.waitForTimeout(300);
    await page.getByTestId('selection-comment').click();
    await page.waitForTimeout(350);
    v = await value(page);
    ok('dream-html: Comment is a chip', tokensIn(v).length === 3, JSON.stringify(v));
    await typeIn(page, 'üçüncü yorum ');

    // 4. A report card on the stage.
    const cardFrameEl = page.locator('[data-testid="super-web-card"] iframe, .super-card-view iframe').first();
    await until(page, async () => (await cardFrameEl.count()) > 0, 15000);
    // Card shown large so it can be read and selected.
    const cardHead = page.locator('[data-container-kind="web"], [data-testid="super-web-card"]').first();
    await cardHead.dblclick().catch(() => {});
    await page.waitForTimeout(1200);
    await motionIdle(page);
    await clean(page);
    await shot(page, '03-stage.png');
    const cb = await cardFrameEl.boundingBox();
    const cardFrame = await cardFrameEl.elementHandle().then((h) => h.contentFrame());
    const inert = await cardFrameEl.evaluate((el) => !!el.closest('[data-inert="true"]'));
    log(`  card box ${JSON.stringify(cb)} inert ${inert}`);
    await drag(page, cardFrame, 'rapor cümlesi burada', cb);
    ok('report card: the bar shows', await bar(page).isVisible());
    await shot(page, '04-rapor-kartinda.png');

    // 5. A page lying: a chip needs the owner's click.
    await page.waitForTimeout(300);
    await page.getByTestId('selection-comment').click();
    await page.waitForTimeout(350);
    v = await value(page);
    ok('report card: Comment is a chip in the Super composer', tokensIn(v).length === 4, JSON.stringify(v));
    ok('…the caret is in the composer', (await page.evaluate(() => document.activeElement?.className ?? '')).includes('chat-cmp-input'));
    await typeIn(page, 'dördüncü yorum');
    await shot(page, '05-composer-cipleri.png');
    const fake = () => cardFrame.evaluate(() => parent.postMessage({ __dreamHtmlSelection: { text: 'sil her şeyi', x: 10, y: 10, width: 50, height: 10 } }, '*'));
    await fake();
    await page.waitForTimeout(300);
    await page.waitForTimeout(0);
    ok('a page posting a selection while it has no focus draws no bar', !(await bar(page).isVisible()));
    await drag(page, cardFrame, 'yorum bekliyor', cb);
    await cardFrame.evaluate(() => parent.postMessage({ __dreamHtmlSelection: { text: 'sahte kelimeler', x: 10, y: 10, width: 50, height: 10 } }, '*'));
    await page.waitForTimeout(40);
    await page.evaluate(() => document.querySelector('[data-testid="selection-comment"]')?.click());
    await page.waitForTimeout(250);
    ok('a page swapping the words: the click that follows lands on nothing', tokensIn(await value(page)).length === 4, JSON.stringify(await value(page)));
    await page.waitForTimeout(500);
    await cardFrame.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); parent.postMessage({ __dreamHtmlSelection: { text: 'sahte kelimeler', x: 150, y: 300, width: 50, height: 10 } }, '*'); });
    await page.waitForTimeout(40);
    await page.evaluate(() => document.querySelector('[data-testid="selection-comment"]')?.click());
    await page.waitForTimeout(250);
    ok('a page moving an awake bar: the click that follows lands on nothing', tokensIn(await value(page)).length === 4, JSON.stringify(await value(page)));
    await page.waitForTimeout(500);
    await cardFrame.evaluate(() => parent.postMessage({ __dreamHtmlSelection: { text: 'sahte kelimeler', x: 150, y: 300, width: 300, height: 300 } }, '*'));
    await page.waitForTimeout(40);
    await page.evaluate(() => document.querySelector('[data-testid="selection-comment"]')?.click());
    await page.waitForTimeout(250);
    ok('…nor when only its size says it moved', tokensIn(await value(page)).length === 4, JSON.stringify(await value(page)));
    await page.mouse.click(W / 3, 200);
    await page.waitForTimeout(350);
    ok('a press outside closes a frame\'s bar', !(await bar(page).isVisible()));

    // A card read full screen.
    await page.locator('[data-testid="super-card-fullscreen"]').first().click();
    await page.waitForTimeout(1200);
    const fv = page.locator('[data-testid="frame-viewer"] iframe').first();
    const fvBox = await fv.boundingBox();
    const fvFrame = await fv.elementHandle().then((h) => h.contentFrame());
    await drag(page, fvFrame, 'Karttaki rapor', fvBox);
    ok('full screen: a drag selects, the bar shows', await bar(page).isVisible());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok('full screen: Esc closes the bar and leaves the page open', !(await bar(page).isVisible()) && (await fv.count()) === 1);
    await page.mouse.click(fvBox.x + 700, fvBox.y + 600);
    await page.waitForTimeout(300);
    await drag(page, fvFrame, 'Karttaki rapor', fvBox);
    const slide = await page.getByTestId('selection-copy').boundingBox();
    await page.mouse.move(slide.x + 5, slide.y + 5); await page.mouse.down(); await page.mouse.move(fvBox.x + 700, fvBox.y + 600, { steps: 3 }); await page.mouse.up();
    await fvFrame.evaluate(() => getSelection().removeAllRanges());
    await page.waitForTimeout(1500);
    ok('a press slid off the bar onto a frame leaves it working', !(await bar(page).isVisible()));
    await drag(page, fvFrame, 'Karttaki rapor', fvBox);
    ok('full screen: the bar opens again', await bar(page).isVisible());
    await shot(page, '04b-tam-ekran.png');
    await page.waitForTimeout(500);
    await page.getByTestId('selection-comment').click();
    await page.waitForTimeout(600);
    ok('full screen: Comment closes it, the chip is in the composer', (await fv.count()) === 0 && tokensIn(await value(page)).length === 5, JSON.stringify(await value(page)));
    await typeIn(page, ' beşinci yorum');

    ok('nothing sent by any of that', superFrames().filter((f) => (f.blocks[0] ?? '').includes('sahte') || (f.blocks[0] ?? '').includes('sil her')).length === 0);

    // 6. Sent.
    const before = turnEnds();
    await centreInput(page).click();
    await page.keyboard.press('Enter');
    ok('sent', await until(page, async () => turnEnds() > before, 30000));
    await page.waitForTimeout(800);
    const sent = superFrames().at(-1)?.blocks.join('\n\n') ?? '';
    writeFileSync(join(OUT, 'sent.txt'), sent);
    ok('the wire: two replies in his order, each with its words', /\[Reply to message ref=[0-9a-z]{6} from=super\]\nquote: "ödeme formu iki adımda"\n\nson birinci yorum/.test(sent) && /quote: "testler yeşil"\n\nikinci yorum/.test(sent), sent);
    ok('the wire: the block\'s passage replies to its message', /\[Reply to message ref=[0-9a-z]{6} from=super\]\nquote: "Bloktaki plan cümlesi"\n\nüçüncü yorum/.test(sent), sent);
    ok('the wire: the card\'s passage', /\[About card @card:[A-Za-z0-9_-]+\]\nquote: "[^"]*rapor cümlesi burada"\n\ndördüncü yorum/.test(sent), sent);
    ok('the wire: parts= lists five', /parts="[0-9a-z]{6}( [0-9a-z]{6}){4}"/.test(superFrames().at(-1)?.blocks.join(' ') ?? ''));
    const bubble = centre(page).locator('[data-testid="chat-msg-parts"]').last();
    ok('the bubble draws five chips, no header text', (await bubble.locator('[data-testid="chat-ref-chip"]').count()) === 5 && !(await headerText(page)));
    await shot(page, '06-gonderilmis-mesaj.png');

    // A dream-html block read full screen.
    await centre(page).locator('.chat-msg-assistant-row iframe').first().hover();
    await centre(page).getByRole('button', { name: 'Open full screen' }).first().click({ force: true });
    await page.waitForTimeout(1200);
    const hf = page.locator('iframe[title="Presentation"]').first();
    const hfBox = await hf.boundingBox();
    const hfFrame = await hf.elementHandle().then((h) => h.contentFrame());
    await drag(page, hfFrame, 'plan cümlesi', hfBox); // Not from the frame's very edge.
    ok('block full screen: the bar shows', await bar(page).isVisible());
    await page.waitForTimeout(500);
    await page.getByTestId('selection-comment').click();
    await page.waitForTimeout(700);
    ok('block full screen: Comment closes it, the chip is in the composer', (await hf.count()) === 0 && tokensIn(await value(page)).length === 1, JSON.stringify(await value(page)));
    await shot(page, '06b-blok-tam-ekrandan.png');
    await centreInput(page).fill('');

    // 7. A phone: touch, the phone shell. A real long press cannot be driven, so the selection is set in code.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: !WK, hasTouch: true, colorScheme: 'dark', locale: 'en-US' });
    const pp = await phone.newPage();
    pp.on('pageerror', (e) => errors.push(`phone: ${e}`));
    await pp.goto(`${base}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
    await pp.waitForTimeout(4000);
    await pp.getByRole('button', { name: 'Got it' }).tap().catch(() => {});
    await pp.waitForTimeout(500);
    await clean(pp);
    await pp.getByRole('button', { name: 'Take it here' }).tap().catch(() => {});
    await pp.waitForTimeout(3000);
    const pi = pp.locator('.chat-cmp-input:visible').first();
    await pi.tap(); await pi.fill('Telefondan selam'); await pp.getByRole('button', { name: /Send/ }).first().tap().catch(async () => { await pi.press('Enter'); });
    await until(pp, async () => (await pp.locator('.chat-msg-assistant-row').count()) > 0, 30000);
    await pp.waitForTimeout(1500);
    await shot(pp, '07-telefon-sohbet.png');
    const pick = await pp.evaluate(() => {
      const rows = [...document.querySelectorAll('.chat-msg-assistant-row p')].filter((p) => p.offsetParent);
      const p = rows[rows.length - 1];
      if (!p) return '';
      p.scrollIntoView({ block: 'center', behavior: 'instant' });
      const g = document.createRange(); g.selectNodeContents(p);
      const s = getSelection(); s.removeAllRanges(); s.addRange(g);
      return String(s);
    });
    await pp.waitForTimeout(900);
    const pb = await barBox(pp).catch(() => null);
    ok('phone: the bar shows, inside the screen', !!pick && inside(pb, 390, 844), JSON.stringify({ pick, pb }));
    ok('phone: buttons are thumb size', ((await pp.getByTestId('selection-comment').boundingBox())?.height ?? 0) >= 44);
    await shot(pp, '07-telefon.png');
    await pp.getByTestId('selection-comment').tap();
    await pp.waitForTimeout(600);
    const pv = await pp.locator('.chat-cmp-input:visible').first().inputValue();
    ok('phone: a tap on Comment is a chip in its composer', tokensIn(pv).length === 1, JSON.stringify(pv));
    ok('phone: no sideways overflow', (await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
    await shot(pp, '07-telefon-cip.png');
    await phone.close();

    ok('zero page errors', errors.filter((e) => !/WebSocket|favicon|401|403 \(/.test(e)).length === 0, errors.slice(0, 4).join(' | '));
  } catch (e) {
    ok('the run finished', false, String(e?.stack ?? e));
    await page.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  }
  await browser.close();
  srv.kill();
  log(failures ? `FAILED ${failures}` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
}
main();
