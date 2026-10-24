#!/usr/bin/env node
/**
 * Several references in one message, observed (task super-e-tek-mesajda-birden-cok-referans-…,
 * plan W2 'Observed', criteria 1-4, 6-9, 12, 14): the real dashboard server from this checkout's
 * dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), a scripted stand-in `claude` (no tokens), fictional
 * project "orbit". The rig of super-reply.mjs.
 *
 *   npm run build && node scripts/verify/super-multi-ref.mjs
 *
 * The owner hands one chat over; the stand-in super writes six agenda lines and answers once.
 * In the composer: words, agenda ↩, words, agenda ↩, words, message ↩, words: three chips INLINE
 * at the caret, slots 1/2/3, his words untouched; ←/→ never stop inside a chip; the same line
 * again flashes the chip it has; a chip opens its popover (whole line, Remove), Esc closes it;
 * five chips and a sixth ↩ shows the notice and adds nothing; Remove and Backspace take a chip
 * whole; cut + paste moves a chip with its reference. Sent: the frame carries the headers in
 * draft order and `<owner-msg … parts="…">`; the bubble shows the chips inline with his words in
 * the same slots, no header text anywhere in the DOM. The stand-in answers each part in its own
 * section (a stacked pair one per line): the heads show those parts' chips in the same colours,
 * a head click lands on the bubble and flashes that chip. A queued multi-part row shows its
 * chips. Rewind gives the chips back (never header text), and a file dropped afterwards keeps
 * them. A reload draws the same bubble. 1440x900 dark and light, 390x844: the widest chip at
 * most 60% of the field, no chip broken across lines, no horizontal overflow; the token's id
 * digits draw nothing in Chromium and WebKit. Zero page errors.
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
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
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-multi-ref-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-multi-ref');
const LOGS = join(OUT, 'logs');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 900;
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
import { appendFileSync, readFileSync, mkdirSync as mk } from 'node:fs';
import { randomUUID } from 'node:crypto';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'cap-' + process.pid;
const convo = at('--resume') || at('--session-id') || '';
const dir = process.env.HOME + '/.claude/projects/verify-super-multi-ref';
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
  if (/^MESGUL/.test(text)) {
    say('Uzun bir iş yapıyorum.');
    toolCall('Bash', { command: 'sleep 9', description: 'Long job' }, '');
    report({ kind: 'busy' });
    await sleep(9000);
    return 'Bitti.';
  }
  if (parts.length >= 3) {
    // A section per part, in his order; the stacked pair (2 and 3) one mark per line.
    report({ kind: 'parts', parts });
    return '<!-- re:' + parts[0] + ' -->\\nİlk parçana: Windows testlerini yalnız CLI için ekliyorum.\\n\\n<!-- re:' + parts[1] + ' -->\\n<!-- re:' + parts[2] + ' -->\\nİkisine: anlaştık, devam ediyorum.';
  }
  report({ kind: 'owner', text: text.slice(0, 600) });
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
async function shot(page, name) { await clean(page); await page.screenshot({ path: join(OUT, name) }); log(`  saved ${name}`); }
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
const tokensIn = (v) => [...v.matchAll(/\u2068([●↩])\u00A0([^\u2068\u2069\n\u2061-\u2064]*)[\u2061-\u2064]+\u2069/g)].map((m) => ({ glyph: m[1], label: m[2].replace(/\u00A0/g, ' '), start: m.index, end: m.index + m[0].length }));
const stripped = (v) => v.replace(/\u2068[^\u2069]*\u2069/g, '').replace(/\s+/g, ' ').trim();
const marks = (page) => centre(page).locator('.chat-cmp-hl mark.chat-cmp-hl-ref');
const markInfo = (page) => marks(page).evaluateAll((ms) => ms.map((m) => ({ slot: m.getAttribute('data-slot'), flash: m.classList.contains('is-flash'), rects: m.getClientRects().length, w: Math.round(m.getBoundingClientRect().width), bg: getComputedStyle(m).backgroundColor })));
const caret = (page) => centreInput(page).evaluate((el) => [el.selectionStart, el.selectionEnd]);
const setCaret = (page, a, b = a) => centreInput(page).evaluate((el, [x, y]) => { el.focus(); el.setSelectionRange(x, y); el.dispatchEvent(new Event('select')); }, [a, b]);
const typeIn = async (page, text) => { await page.keyboard.type(text, { delay: 6 }); await page.waitForTimeout(80); };
const aboutHeadCount = (t) => [...t.matchAll(/(^|\n\n)\[About agenda line note=/g)].length;
const headerText = (page) => page.evaluate(() => /\[About agenda line|\[Reply to message/.test(document.querySelector('[data-super-slot="centre"]')?.innerText ?? ''));

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base}, scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
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
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    await motionIdle(page);
    ok('the super took over and wrote six agenda lines', await until(page, async () => turnEnds() >= 1 && (record().pad ?? []).length === 6 && (await centreInput(page).count()) === 1, 90000), JSON.stringify(record().pad ?? null));
    await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
    ok('the agenda shows the lines, each with its ↩', await until(page, async () => (await page.locator('[data-testid="super-agenda-about"]').count()) >= 6, 20000));
    await motionIdle(page);
    ok('the super answered once (a message to reply to)', await sendAndWait(page, 'HAZIR mısın?'));
    await page.waitForTimeout(600);

    // 1. Words, agenda ↩, words, agenda ↩, words, message ↩, words: three chips INLINE.
    await centreInput(page).click();
    await typeIn(page, 'Üç şey:');
    await aboutRow(page, NOTES[0][1]);
    let v = await value(page);
    ok('agenda ↩ puts a chip AT THE CARET, after his words (they stay)', v.startsWith('Üç şey: \u2068●\u00A0') && tokensIn(v).length === 1, JSON.stringify(v));
    ok('…no chip above the box (the old About row)', (await centre(page).locator('.chat-cmp-attachment-about').count()) === 0);
    await typeIn(page, 'Windows: evet, yalnız CLI.');
    await aboutRow(page, NOTES[1][1]);
    await typeIn(page, 'Doküman tamam.');
    const answer = centre(page).locator('.chat-msg-assistant-row').filter({ hasText: 'Planı yazdım' }).last();
    await answer.hover();
    await answer.locator('[aria-label="Quote-reply"]').click();
    await page.waitForTimeout(300);
    await typeIn(page, 'Devam et.');
    v = await value(page);
    const toks = tokensIn(v);
    ok('three chips in order: ●, ●, ↩ (a second ↩ ADDS, never replaces)', toks.map((t) => t.glyph).join('') === '●●↩' && /^Windows için/.test(toks[0].label) && /^Doküman/.test(toks[1].label) && /^Super: Planı/.test(toks[2].label), JSON.stringify(toks));
    log(`  three chips: ${JSON.stringify(v)}`);
    ok('a space stands after every chip (never glued to his words)', toks.every((t) => v[t.end] === ' '), JSON.stringify(toks.map((t) => v.slice(t.end, t.end + 3))));
    ok('his words untouched, in order', stripped(v) === 'Üç şey: Windows: evet, yalnız CLI. Doküman tamam. Devam et.', stripped(v));
    let mi = await markInfo(page);
    ok('the mirror tints them slot 1, 2, 3', JSON.stringify(mi.map((m) => m.slot)) === '["1","2","3"]', JSON.stringify(mi));
    ok('…three different colours', new Set(mi.map((m) => m.bg)).size === 3, JSON.stringify(mi.map((m) => m.bg)));
    ok('every chip label at most 24 graphemes', toks.every((t) => Array.from(t.label).length <= 24), JSON.stringify(toks.map((t) => t.label)));
    await shot(page, '01-three-chips-1440-dark.png');

    // 2. ←/→ never stop inside a chip.
    await setCaret(page, toks[0].end);
    await page.keyboard.press('ArrowLeft');
    let c = await caret(page);
    ok('← from a chip\'s end lands on its start (never inside)', c[0] === toks[0].start && c[1] === toks[0].start, JSON.stringify({ c, t: toks[0] }));
    await page.keyboard.press('ArrowRight');
    c = await caret(page);
    ok('→ from its start lands on its end', c[0] === toks[0].end, JSON.stringify({ c, t: toks[0] }));

    // 3. The same line again: the chip it has flashes, nothing added.
    await setCaret(page, (await value(page)).length);
    await aboutRow(page, NOTES[0][1]);
    const flashed = await until(page, async () => (await markInfo(page))[0]?.flash === true, 1500);
    ok('the same line again flashes chip 1 and adds nothing', flashed && tokensIn(await value(page)).length === 3);
    await shot(page, '02-same-line-flash-1440-dark.png');
    await page.waitForTimeout(800);

    // 4. A chip opens its popover: the whole line, Remove; Esc closes it.
    const m2 = await marks(page).nth(1).boundingBox();
    await page.mouse.click(m2.x + m2.width / 2, m2.y + m2.height / 2);
    const pop = page.locator('[data-testid="chat-cmp-ref-pop"]');
    ok('a click on chip 2 opens its popover with the whole line and Remove', await until(page, async () => (await pop.count()) === 1 && (await pop.innerText()).includes(NOTES[1][1]) && (await pop.innerText()).includes('Remove'), 3000), await pop.innerText().catch(() => ''));
    await shot(page, '03-popover-1440-dark.png');
    await page.keyboard.press('Escape');
    ok('Esc closes it', await until(page, async () => (await pop.count()) === 0, 2000));
    ok('every chip has a screen-reader Remove', (await centre(page).locator('.chat-cmp-refs-sr button').count()) === 3
      && (await centreInput(page).getAttribute('aria-describedby'))?.endsWith('-refs'));
    await centreInput(page).focus();
    await page.keyboard.press('Tab');
    const srFocus = await page.evaluate(() => {
      const el = document.activeElement;
      const list = el?.closest('.chat-cmp-refs-sr');
      const r = el?.getBoundingClientRect();
      return { inList: !!list, w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0), outline: el ? getComputedStyle(el).outlineStyle : '' };
    });
    ok('Tab out of the box lands on a VISIBLE Remove with a focus ring (never an invisible stop)', srFocus.inList && srFocus.w > 40 && srFocus.h > 8 && srFocus.outline !== 'none', JSON.stringify(srFocus));
    await shot(page, '03b-sr-list-focused-1440-dark.png');
    await page.keyboard.press('Shift+Tab');
    ok('…Shift+Tab is back in the box, nothing removed', tokensIn(await value(page)).length === 3);

    // 5. Five chips; a sixth ↩ shows the notice and adds nothing.
    await setCaret(page, (await value(page)).length);
    await aboutRow(page, NOTES[2][1]);
    await aboutRow(page, NOTES[5][1]);
    ok('five chips staged', tokensIn(await value(page)).length === 5);
    await aboutRow(page, NOTES[4][1]);
    const notice = centre(page).locator('[data-testid="chat-cmp-ref-notice"]');
    ok('a sixth ↩: "At most 5 references in one message", nothing added', await until(page, async () => (await notice.count()) === 1, 3000) && tokensIn(await value(page)).length === 5, await notice.innerText().catch(() => ''));
    await shot(page, '04-five-chips-notice-1440-dark.png');
    ok('…the notice goes again within 4 s', await until(page, async () => (await notice.count()) === 0, 4500));
    // The widest possible chip (a 24-grapheme label of W) at 1440, measured again at 390 below.
    // 6. Remove (popover) and Backspace take a chip whole.
    const m5 = await marks(page).nth(4).boundingBox();
    await page.mouse.click(m5.x + m5.width / 2, m5.y + m5.height / 2);
    await pop.locator('[data-testid="chat-cmp-ref-remove"]').click();
    ok('Remove takes chip 5 out whole', await until(page, async () => tokensIn(await value(page)).length === 4, 2000));
    v = await value(page);
    const t4 = tokensIn(v)[3];
    await setCaret(page, t4.end);
    await page.keyboard.press('Backspace');
    v = await value(page);
    ok('Backspace at chip 4\'s end takes it out whole, the words stay', tokensIn(v).length === 3 && stripped(v) === 'Üç şey: Windows: evet, yalnız CLI. Doküman tamam. Devam et.', JSON.stringify(v));
    ok('no damaged token left (no stray isolate or digit)', !/[\u2061-\u2064]/.test(v.replace(/\u2068[^\u2069]*\u2069/g, '')));

    // 7. Cut + paste moves chip 1 with its reference.
    const t1 = tokensIn(v)[0];
    await setCaret(page, t1.start, t1.end);
    await page.keyboard.press('ControlOrMeta+x');
    await page.waitForTimeout(200);
    ok('cut takes chip 1 out, and the gap it leaves is one space', tokensIn(await value(page)).length === 2 && (await value(page)).startsWith('Üç şey: Windows'), JSON.stringify((await value(page)).slice(0, 20)));
    await setCaret(page, (await value(page)).length);
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(300);
    v = await value(page);
    const moved = tokensIn(v);
    ok('paste puts it back as a chip, now last: Doküman, Super, Windows', moved.map((t) => t.label.slice(0, 6)).join('|') === 'Doküma|Super:|Window', JSON.stringify(moved.map((t) => t.label)));
    mi = await markInfo(page);
    ok('…slots follow the new order (1, 2, 3)', JSON.stringify(mi.map((m) => m.slot)) === '["1","2","3"]');
    await typeIn(page, ' bunu en sona aldım');
    await shot(page, '05-moved-1440-dark.png');

    // 8. Send: the frame in draft order with parts=, the bubble with inline chips.
    const n = superFrames().length;
    const ends = turnEnds();
    await page.keyboard.press('Enter');
    ok('the frame carries the headers in draft order, his words after each, and parts=', await until(page, async () => {
      const f = superFrames()[n];
      if (!f) return false;
      const t = f.blocks[0];
      const order = ['note=n2', 'Reply to message', 'note=n1'].map((k) => t.indexOf(k));
      return order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])) && t.startsWith('Üç şey: Windows: evet')
        && f.blocks.some((b) => /^<owner-msg ref="[0-9a-z]{6}" parts="[0-9a-z]{6} [0-9a-z]{6} [0-9a-z]{6}"\/>$/.test(b));
    }, 15000), JSON.stringify(superFrames()[n]?.blocks));
    log(`  sent: ${JSON.stringify(superFrames()[n]?.blocks?.[0])}`);
    ok('the box is empty after the send', (await value(page)) === '');
    const bubble = centre(page).locator('.chat-msg-user-row').last();
    ok('the bubble shows three chips inline with his words, slots 1-3', await until(page, async () => (await bubble.locator('[data-testid="chat-msg-parts"] .chat-ref-chip').count()) === 3, 8000)
      && JSON.stringify(await bubble.locator('.chat-ref-chip').evaluateAll((cs) => cs.map((x) => x.getAttribute('data-slot')))) === '["1","2","3"]');
    ok('no header text anywhere in the centre (bubble or box)', !(await headerText(page)));
    ok('the stand-in answered each part', await until(page, async () => turnEnds() > ends && reports().some((r) => r.kind === 'parts'), 20000));
    await page.waitForTimeout(800);

    // 9. The heads: each part's chip in the same colour; a stacked pair side by side.
    const ansRow = centre(page).locator('.chat-msg-assistant-row').filter({ hasText: 'İlk parçana' }).last();
    const heads = ansRow.locator('[data-testid="chat-reply-head"]');
    ok('two heads: part 1, then parts 2+3 stacked', await until(page, async () => (await heads.count()) === 2, 8000)
      && JSON.stringify(await heads.evaluateAll((hs) => hs.map((h) => h.getAttribute('data-parts')))) === '["1","2,3"]', JSON.stringify(await heads.evaluateAll((hs) => hs.map((h) => h.getAttribute('data-parts')))));
    const colour = (loc) => loc.evaluateAll((cs) => cs.map((x) => [x.getAttribute('data-slot'), getComputedStyle(x).backgroundColor]));
    const bubbleCols = Object.fromEntries(await colour(bubble.locator('.chat-ref-chip')));
    const headCols = await colour(ansRow.locator('[data-testid="chat-reply-head"] .chat-ref-chip'));
    ok('each head chip wears its bubble chip\'s colour', headCols.length === 3 && headCols.every(([s, bg]) => bubbleCols[s] === bg), JSON.stringify({ bubbleCols, headCols }));
    ok('no `<!-- re:` in the DOM', await noMarkInDom(page));
    await ansRow.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await page.waitForTimeout(300);
    await shot(page, '06-bubble-and-heads-1440-dark.png');
    await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await heads.nth(1).click();
    const bubbleId = await bubble.getAttribute('data-item-id');
    ok('a head click lands on the bubble and flashes that part\'s chip', await until(page, async () => (await inView(page, `[data-super-slot="centre"] [data-item-id="${bubbleId}"]`))
      && (await bubble.locator('[data-ref-part="2"][data-reply-flash]').count()) === 1, 4000));
    await shot(page, '07-head-jump-flash-1440-dark.png');

    // 10. A queued multi-part row shows its chips.
    await send(page, 'MESGUL uzun iş');
    await until(page, async () => reports().some((r) => r.kind === 'busy'), 15000);
    await centreInput(page).click();
    await typeIn(page, 'Sıradaki:');
    await aboutRow(page, NOTES[2][1]);
    await typeIn(page, 'ikinci adım.');
    await aboutRow(page, NOTES[3][1]);
    await typeIn(page, 'kart.');
    await centre(page).locator('[aria-label="Queue for the next turn"]').click();
    const qrow = centre(page).locator('.chat-queue-row').last();
    ok('the queued row shows the same chips inline (slots 1, 2), no header text', await until(page, async () => (await qrow.locator('.chat-ref-chip').count()) === 2, 5000)
      && !/\[About agenda line/.test(await qrow.innerText()), await qrow.innerText().catch(() => ''));
    await shot(page, '08-queued-row-1440-dark.png');
    // Its editor edits the RAW text (plan R2-3): a word added, saved; every header survives.
    const qn = superFrames().length;
    await qrow.locator('.chat-queue-text').click();
    const qedit = centre(page).locator('.chat-queue-edit');
    await qedit.press('End');
    await qedit.type(' ek', { delay: 10 });
    await qedit.press('Enter');
    ok('an edited, saved multi-part queued row goes out with both headers and the edit', await until(page, async () => {
      const f = superFrames().slice(qn).find((x) => x.blocks[0].startsWith('Sıradaki:'));
      return !!f && aboutHeadCount(f.blocks[0]) === 2 && f.blocks[0].endsWith('kart. ek');
    }, 40000), JSON.stringify(superFrames().slice(qn).map((x) => x.blocks[0])));
    await until(page, async () => (await centre(page).locator('.chat-queue-row').count()) === 0, 40000);
    await until(page, async () => !(await centre(page).locator('.chat-cmp-stop:visible').count()), 20000);
    await page.waitForTimeout(1500);

    // 11. Rewind gives the chips back; a file dropped afterwards keeps them.
    const multi = centre(page).locator('.chat-msg-user-row').filter({ has: page.locator('[data-testid="chat-msg-parts"]') }).first();
    await multi.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await multi.hover();
    await multi.locator('[aria-label="Edit — rewind to before this message"]').click();
    await centre(page).getByRole('button', { name: 'Rewind', exact: true }).click();
    ok('rewind puts the message back with its three chips, never header text', await until(page, async () => {
      const r = await value(page);
      return tokensIn(r).length === 3 && !/\[About agenda line|\[Reply to message/.test(r);
    }, 15000), JSON.stringify(await value(page)));
    v = await value(page);
    log(`  rewound draft: ${JSON.stringify(stripped(v))}`);
    await page.evaluate(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File(['orbit notes'], 'notlar.txt', { type: 'text/plain' }));
      const target = document.querySelector('[data-super-slot="centre"] .chat-cmp-input');
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 5 }));
    });
    ok('a dropped file lands at the end and every chip stays', await until(page, async () => {
      const r = await value(page);
      return /notlar\.txt/.test(r) && tokensIn(r).length === 3;
    }, 15000), JSON.stringify(await value(page)));
    await shot(page, '09-rewind-then-drop-1440-dark.png');
    await setCaret(page, 0, (await value(page)).length);
    await page.keyboard.press('Backspace');

    // 12. A reload draws the same bubble.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    await page.waitForTimeout(1500);
    for (let i = 0; i < 6; i++) { const more = centre(page).locator('.chat-window-more'); if (!(await more.count())) break; await more.click(); await page.waitForTimeout(400); }
    ok('after a reload the bubble draws its three chips again, no header text', await until(page, async () => (await centre(page).locator('[data-testid="chat-msg-parts"] .chat-ref-chip').count()) >= 3 && !(await headerText(page)), 20000));

    // 12b. ↑ recall gives a sent message back with its chips; ↑, ↩, ↑ keeps the chip.
    await centreInput(page).click();
    await typeIn(page, 'Geri çağır:');
    await aboutRow(page, NOTES[0][1]);
    await typeIn(page, 'bir');
    await aboutRow(page, NOTES[1][1]);
    await typeIn(page, 'iki');
    ok('a two-chip message for recall was answered', await sendAndWait(page, ''));
    await centreInput(page).click();
    await page.keyboard.press('ArrowUp');
    v = await value(page);
    ok('↑ in an empty box brings the last message back with its two chips, never header text', tokensIn(v).length === 2 && stripped(v) === 'Geri çağır: bir iki' && !/\[About agenda line/.test(v), JSON.stringify(v));
    await aboutRow(page, NOTES[2][1]);
    await centreInput(page).click();
    await setCaret(page, 0);
    await page.keyboard.press('ArrowUp');
    v = await value(page);
    ok('↑, ↩, ↑: the new chip and the recalled ones stay (a draft with chips is never recalled over)', tokensIn(v).length === 3, JSON.stringify(v));
    await setCaret(page, 0, v.length);
    await page.keyboard.press('Backspace');

    // 13. Light theme, then 390x844.
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'light'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    await page.waitForTimeout(1200);
    await centreInput(page).click();
    await typeIn(page, 'Açık temada:');
    await aboutRow(page, NOTES[0][1]);
    await typeIn(page, 'bir');
    await aboutRow(page, NOTES[1][1]);
    await typeIn(page, 'iki');
    const bub = centre(page).locator('[data-testid="chat-msg-parts"]').last();
    await bub.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, '10-1440-light.png');
    ok('light: the composer chips are slots 1, 2', JSON.stringify((await markInfo(page)).map((m) => m.slot)) === '["1","2"]');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await motionIdle(page);
    await setCaret(page, (await value(page)).length);
    await typeIn(page, ' en dar ekranda');
    await page.waitForTimeout(400);
    const geo = await page.evaluate(() => {
      const field = document.querySelector('[data-super-slot="centre"] .chat-cmp-field');
      const fw = field?.getBoundingClientRect().width ?? 0;
      const ms = [...document.querySelectorAll('[data-super-slot="centre"] .chat-cmp-hl mark.chat-cmp-hl-ref')];
      return { fw: Math.round(fw), marks: ms.map((m) => ({ w: Math.round(m.getBoundingClientRect().width), rects: m.getClientRects().length, text: m.textContent })) };
    });
    log(`  390 composer: ${JSON.stringify(geo)}`);
    // The 60% rule is the phone's (criterion 8, super-reply-phone.mjs): these chips were drawn at
    // 1440, for that field. At 390 they still never break and never overflow.
    ok('390: no chip broken across lines', geo.marks.every((m) => m.rects === 1), JSON.stringify(geo.marks));
    const bub390 = await page.evaluate(() => [...document.querySelectorAll('[data-super-slot="centre"] [data-testid="chat-msg-parts"] .chat-ref-chip')].map((c) => c.getClientRects().length));
    ok('390: bubble chips never break across lines', bub390.length >= 3 && bub390.every((n2) => n2 === 1), JSON.stringify(bub390));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok('390: no horizontal overflow', overflow <= 1, `over by ${overflow}`);
    await shot(page, '11-390-composer-light.png');
    const bub2 = centre(page).locator('[data-testid="chat-msg-parts"]').last();
    await bub2.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, '12-390-bubble-light.png');
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    await page.waitForTimeout(1200);
    await centre(page).locator('[data-testid="chat-msg-parts"]').last().evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, '13-390-dark.png');

    const errs = errors.filter((e) => !/favicon|WebSocket|ERR_CONNECTION_REFUSED/i.test(e));
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the run completed', false, String(e?.stack || e).slice(0, 1200));
    await page.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  } finally {
    try { writeFileSync(join(LOGS, 'reports.ndjson'), readFileSync(REPORTS, 'utf-8')); } catch {}
    try { writeFileSync(join(LOGS, 'frames.ndjson'), readFileSync(FRAMES, 'utf-8')); } catch {}
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
    await new Promise((r) => setTimeout(r, 800));
    if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  }

  // 14. The token's id digits draw nothing, in Chromium and WebKit (plan R2-1).
  for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
    const b = await engine.launch().catch(() => null);
    if (!b) { ok(`${name}: launched for the id-digit measurement`, false); continue; }
    const p = await b.newPage({ viewport: { width: 390, height: 844 } });
    const res = await p.evaluate(() => {
      const box = document.createElement('div');
      box.style.cssText = 'font: 15px -apple-system, system-ui, sans-serif; white-space: pre-wrap; width: 160px';
      document.body.appendChild(box);
      const span = (t) => { const s = document.createElement('span'); s.textContent = t; box.appendChild(s); box.appendChild(document.createElement('br')); return s; };
      const name = '\u2068●\u00A0Windows\u00A0için\u00A0otomatik\u00A0test';
      const a = span(`${name}\u2061\u2063\u2062\u2064\u2061\u2062\u2069`);
      const b2 = span(`${name}\u2069`);
      return { with: a.getBoundingClientRect().width, without: b2.getBoundingClientRect().width, lines: a.getClientRects().length };
    });
    ok(`${name}: id digits add no width (${res.with.toFixed(2)} vs ${res.without.toFixed(2)}) and the token never wraps`, Math.abs(res.with - res.without) < 0.01 && res.lines === 1, JSON.stringify(res));
    await b.close();
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots in ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
