#!/usr/bin/env node
/**
 * Which Super answer is to which message, observed (task super-sohbetinde-her-cevabin-ustunde-…,
 * plan r2 'Observed 1'): the real dashboard server from this checkout's dist (scratch HOME,
 * DREAMCONTEXT_DESKTOP=1), a scripted stand-in `claude` (no tokens), fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-reply.mjs
 *
 * The owner hands one chat over and writes the super three messages, the 2nd and 3rd while its
 * first turn still runs. The stand-in reads each `<owner-msg ref>` block it received and answers
 * out of order, every block opening with `<!-- re:<ref> -->` (one streamed in three deltas, one
 * naming two messages). Checks: one strip per answer group over the right message, none over the
 * answer right under its message, the group's rows carry its line; a strip click brings the
 * message into view and flashes it, also while a turn streams and when the message sits above
 * the 20-card window; ↩ on a Super answer stages ONE chip, Enter sends a reference and at most
 * 100 characters of the message (a 2,000-character answer too), his bubble keeps his words under
 * a ↩ strip; an unmarked answer to one message gets no strip; a reload draws every strip again;
 * no `<!-- re:` anywhere in the DOM. Screenshots at 1440x900 dark and light and 390x844; zero
 * page errors.
 *
 * Check 5b (owner 2026-10-24, pick A): three new messages, the 2nd and 3rd steered into a busy
 * turn written about an agenda line (its ↩ chip: a typed header is plain text since the
 * multi-reference task), answered in ONE streamed block with a section per
 * message after an unmarked "Bakıyorum.". Polled every 100 ms while it streams: no strip ever
 * mounts, no head shows before its words, a head once shown never goes. At the end: three heads
 * inside one answer body (About + agenda line on 2-3, "To your message" on 1), no "To 3
 * messages"; a head click lands on its message, also while another turn streams; Copy holds no
 * head; a reload draws the same heads; every head one line at 1440 and 390.
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
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
/** The server's message reference (src/lib/super/types.ts `msgRef`, pinned by its unit tests):
 *  dist is one bundle, so the rig carries its own copy to know what the super should receive. */
function msgRef(text) {
  let h = 0x811c9dc5;
  const s = (text ?? '').trim();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 2_176_782_336).toString(36).padStart(6, '0');
}
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-reply-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-reply');
const LOGS = join(OUT, 'logs');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const W = 1440; const H = 900;
const LONG = `Uzun cevap: ${Array.from({ length: 40 }, (_, i) => `Bölüm ${i + 1}: ödeme formunun bu adımı yeniden yazıldı ve test edildi.`).join(' ')}`;

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { appendFileSync, readFileSync, mkdirSync as mk } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const cli = (...args) => spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'cap-' + process.pid;
const convo = at('--resume') || at('--session-id') || '';
const dir = process.env.HOME + '/.claude/projects/verify-super-reply';
function row(o) {
  if (role !== 'super' || !/^[0-9a-f-]{36}$/.test(convo)) return;
  mk(dir, { recursive: true });
  appendFileSync(dir + '/' + convo + '.jsonl', JSON.stringify({ ...o, sessionId: convo, uuid: randomUUID(), timestamp: new Date().toISOString() }) + '\\n');
}
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const say = (text) => {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
};
/** One block streamed in pieces (the head split across deltas), then its echo. */
const stream = async (pieces) => {
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const p of pieces) { out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } } }); await sleep(450); }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  say(pieces.join(''));
};
const toolCall = (name, input, result) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  const use = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
  out(use); row(use);
  const res = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result }], is_error: false }] } };
  out(res); row(res);
};
/** Every owner message this process received, with the reference the server sent beside it. */
const owners = [];
/** His words without a leading agenda About header (\`[About agenda line …]\\nline: "…"\\n\\n\`). */
const wordsOf = (t) => t.replace(/^\\[About agenda line [^\\]\\n]*\\]\\nline: "[^\\n]*"\\n\\n/, '');
const refOf = (word) => { for (let i = owners.length - 1; i >= 0; i--) if (wordsOf(owners[i].text).startsWith(word)) return owners[i].ref; return 'zzzzzz'; };
const LONG = ${JSON.stringify(LONG)};

async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    // Two agenda lines, so check 5b can write about them with their ↩ (a chip, never typed).
    cli('super', 'note', 'add', 'waiting', 'Fiyat kartının adı');
    cli('super', 'note', 'add', 'waiting', 'Orbit dağıtımı');
    return 'Devraldım.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 200) }); return null; }
  if (/^Birinci/.test(text)) {
    toolCall('Bash', { command: 'npm test -- login', description: 'Run the login tests' }, '31 passing');
    report({ kind: 'busy' });
    await sleep(7000);
    // Out of order: the third first (right under it: no strip), then the first, then the first
    // and second together, then the second.
    await stream(['<!-- r', 'e:' + refOf('Üçüncü').slice(0, 3), refOf('Üçüncü').slice(3) + ' -->\\nÜçüncü mesajına: dağıtım yeşil, 212 testin hepsi geçti.']);
    toolCall('Bash', { command: 'dreamcontext super brief c1 "Giriş sayfası"', description: 'Update the row' }, 'ok');
    say('<!-- re:' + refOf('Birinci') + ' -->\\nBirinci mesajına: giriş sayfası düzeldi, Safari\\'de de açılıyor.');
    toolCall('Read', { file_path: 'site/pricing.md' }, '# Pricing');
    say('<!-- re:' + refOf('Birinci') + ' ' + refOf('İkinci') + ' -->\\nİkisine birden: fiyat kartının adı giriş sayfasında da değişti.');
    return '<!-- re:' + refOf('İkinci') + ' -->\\nİkinci mesajına: fiyat kartını "Takım" diye yeniden adlandırdım.';
  }
  if (/^Dördüncü/.test(text)) return 'Tamam, not aldım.';
  // One block answering three messages, a section per message (what the real model writes).
  // (i) a busy phase the 2nd and 3rd message steer into, (v) an unmarked text first, then the
  // answer streamed in deltas naming (ii) the refs of the three NEW messages.
  if (/^BOLUMLER/.test(text)) {
    say('Bakıyorum.');
    toolCall('Bash', { command: 'dreamcontext super state', description: 'Read the state' }, 'ok');
    report({ kind: 'busy3' });
    await sleep(7000);
    toolCall('Read', { file_path: 'site/pricing.md' }, '# Pricing');
    const r1 = refOf('BOLUMLER'); const r2 = refOf('Fiyat kartı bitti mi'); const r3 = refOf('Dağıtım ne durumda');
    await stream(['<!-- re:' + r1, ' -->\\nBOLUMLER mesajına: üçü de elimde, ', 'sırayla yazıyorum.\\n\\n<!-', '- re:' + r2 + ' -->\\n', 'Fiyat kartı: ', 'Takım oldu, yayında.\\n\\n<!-- re:' + r3 + ' -->\\n', 'Dağıtım: ', 'yeşil, 212 test geçti.']);
    return null;
  }
  if (/^UZUN/.test(text)) return LONG;
  if (/^MESGUL/.test(text)) {
    say('Uzun bir iş yapıyorum.');
    toolCall('Bash', { command: 'sleep 12', description: 'Long job' }, '');
    report({ kind: 'busy2' });
    await sleep(12000);
    return 'Bitti.';
  }
  if (/^DOLDUR/.test(text)) {
    for (let i = 1; i <= 24; i++) {
      say('Ara not ' + i + ': kontrol ediyorum.');
      toolCall('Read', { file_path: 'src/step' + i + '.ts' }, 'export {}');
    }
    return '<!-- re:' + refOf('Birinci') + ' -->\\nEn baştaki birinci mesajına dönüyorum: giriş sayfası yayında.';
  }
  report({ kind: 'owner', text: text.slice(0, 600) });
  return 'Not aldım.';
}
async function childTurn() {
  toolCall('Grep', { pattern: 'invoiceTotal', path: 'src/billing', output_mode: 'files_with_matches' }, 'src/billing/invoice.ts');
  return 'Fatura toplamları yeni ledger API üstünde. 212 testin hepsi geçti.';
}
let inited = false;
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(); } catch (e) { said = 'error ' + e; }
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
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    for (const b of blocks) { const m = /^<owner-msg ref="([0-9a-z]{6})"\\/>$/.exec(b); if (m) owners.push({ text: blocks[0], ref: m[1] }); }
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    if (running) row({ type: 'attachment', attachment: { type: 'queued_command', prompt: blocks.map((text) => ({ type: 'text', text })) } });
    else row({ type: 'user', message: { role: 'user', content: blocks.map((text) => ({ type: 'text', text })) } });
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
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
/** A reference chip in the box: the token's tint in the mirror. */
const chip = (page) => centre(page).locator('.chat-cmp-hl mark.chat-cmp-hl-ref');
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

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base}, scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
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
    ok('the super took over', await until(page, async () => turnEnds() >= 1 && (await centreInput(page).count()) === 1, 90000));
    // The agenda on the stage (its lines are written at the hand-over).
    await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
    await until(page, async () => (await page.locator('[data-testid="super-agenda-about"]').count()) >= 2, 20000);
    await motionIdle(page);
    await page.waitForTimeout(1000);

    // 1. Three messages, the 2nd and 3rd while the first turn runs.
    const MSG = {
      A: 'Birinci: giriş sayfası Safari\'de açılmıyor, düzelt.',
      B: 'İkinci: fiyat kartının adını Takım yap.',
      C: 'Üçüncü: dağıtım durumu ne?',
    };
    const endsBefore = turnEnds();
    await send(page, MSG.A);
    await until(page, async () => reports().some((r) => r.kind === 'busy'), 15000);
    await send(page, MSG.B);
    await page.waitForTimeout(600);
    await send(page, MSG.C);
    ok('every owner message reached the super with its `<owner-msg ref>`', await until(page, async () => {
      const f = superFrames().filter((x) => Object.values(MSG).includes(x.blocks[0]));
      return f.length === 3 && f.every((x) => x.blocks.includes(`<owner-msg ref="${msgRef(x.blocks[0])}"/>`)) && f[1].folded && f[2].folded;
    }, 15000), JSON.stringify(superFrames().slice(-3).map((f) => [f.blocks.slice(0, 2), f.folded])));
    // While the streamed head is still arriving, nothing of it shows.
    ok('a streamed mark never shows while its head arrives', await until(page, async () => {
      const t = await centre(page).innerText();
      return t.includes('Üçüncü mesajına') || t.includes('<!--');
    }, 20000) && !(await centre(page).innerText()).includes('<!--'));
    ok('the out-of-order answers arrived', await until(page, async () => turnEnds() > endsBefore, 30000));
    await page.waitForTimeout(800);
    let shape = await transcriptShape(page);
    const strips = shape.filter((x) => x.kind === 'strip');
    const textRow = (word) => shape.find((x) => x.kind === 'text' && x.text.includes(word));
    const before = (row) => shape[shape.indexOf(row) - 1];
    const firstOfGroup = (grp) => shape.find((x) => x.grp === grp);
    const stripOf = (grp) => strips.find((s) => s.strip === grp);
    const tC = textRow('Üçüncü mesajına'); const tA = textRow('Birinci mesajına'); const tAB = textRow('İkisine birden'); const tB = textRow('İkinci mesajına');
    ok('each answer is in a group (its row carries the group line)', !!(tC?.grp && tA?.grp && tAB?.grp && tB?.grp), JSON.stringify(shape.filter((x) => x.kind !== 'user').slice(-12)));
    ok('the answer right under its message (the third) draws no strip', tC && !stripOf(tC.grp), JSON.stringify(strips));
    ok('the first message\'s answer: a strip over its group naming the first message', tA && /To your message.*Birinci: giriş sayfası/.test(stripOf(tA.grp)?.text ?? '')
      && before(firstOfGroup(tA.grp))?.strip === tA.grp, JSON.stringify({ strip: stripOf(tA?.grp), first: firstOfGroup(tA?.grp) }));
    ok('…its action row (the tool call before it) is in the same group, under the strip', shape[shape.indexOf(firstOfGroup(tA.grp))].kind === 'other');
    ok('the answer to two messages: one strip, "To 2 messages", both quoted', /To 2 messages.*Birinci.*·.*İkinci/.test(stripOf(tAB?.grp)?.text ?? ''), stripOf(tAB?.grp)?.text);
    ok('the second message\'s answer: its strip names the second message', /To your message.*İkinci: fiyat kartının/.test(stripOf(tB?.grp)?.text ?? ''), stripOf(tB?.grp)?.text);
    ok('no `<!-- re:` anywhere in the DOM', await noMarkInDom(page));
    ok('…and no section head anywhere: every block there has one section (0.34.5 unchanged)', (await centre(page).locator('[data-testid="chat-reply-head"]').count()) === 0);
    await shot(page, '01-out-of-order-1440-dark.png');

    // 2. A strip click scrolls to its message and flashes it.
    await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(400);
    const aSel = await userRowSel(page, 'Birinci: giriş sayfası');
    await centre(page).locator(`[data-reply-strip="${tA.grp}"] button`).click();
    ok('a strip click brings the message into view and flashes it', await until(page, async () => aSel && await inView(page, aSel)
      && await page.locator(`${aSel}[data-reply-flash]`).count() === 1, 4000), aSel);
    await page.waitForTimeout(300);
    await shot(page, '02-strip-jump-1440-dark.png');

    // 3. ↩ on a Super answer: ONE chip in the text; Enter sends a reference and at most 100
    // characters. (Owner 2026-10-24: the chip is IN the text, a second ↩ ADDS one.)
    const aRow = centre(page).locator('.chat-msg-assistant-row').filter({ hasText: 'Birinci mesajına' }).first();
    const aBody = 'Birinci mesajına: giriş sayfası düzeldi, Safari\'de de açılıyor.';
    await aRow.hover();
    await aRow.locator('[aria-label="Quote-reply"]').click();
    ok('↩ drops ONE chip into the text: "↩ Super: …"', await until(page, async () => (await chip(page).count()) === 1 && /\u21a9\u00a0Super:\u00a0Birinci/.test(await centreInput(page).inputValue()), 5000), JSON.stringify(await centreInput(page).inputValue()));
    ok('…the chip alone, the box focused: "Write your reply…" after it', await until(page, async () => (await centre(page).locator('.chat-cmp-hl-hint').innerText().catch(() => '')).includes('Write your reply…'), 3000));
    const tAnswer = centre(page).locator('.chat-msg-assistant-row').filter({ hasText: 'İkinci mesajına' }).first();
    await tAnswer.hover();
    await tAnswer.locator('[aria-label="Quote-reply"]').click();
    ok('…a second ↩ ADDS a chip (two in the text)', await until(page, async () => (await chip(page).count()) === 2, 5000));
    // Back to one chip for the one-chip wire check: clear the box, ↩ the first answer again.
    // (The hover that shows ↩ is proven by the two presses above; this one is a DOM click, so a
    // hover bar still fading in after the fill cannot make the step flaky.)
    await centreInput(page).fill('');
    await aRow.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await aRow.locator('[aria-label="Quote-reply"]').evaluate((el) => el.click());
    await until(page, async () => (await chip(page).count()) === 1, 5000);
    await shot(page, '03-reply-chip-1440-dark.png');
    let n = superFrames().length;
    await send(page, 'teşekkürler, yayına al');
    ok('Enter sends the reference, the quote and his words, never the whole message', await until(page, async () => {
      const f = superFrames()[n];
      return !!f && f.blocks[0] === `[Reply to message ref=${msgRef(aBody)} from=super]\nquote: ${JSON.stringify(aBody)}\n\nteşekkürler, yayına al`;
    }, 15000), JSON.stringify(superFrames()[n]?.blocks?.[0]));
    const bubble = centre(page).locator('.chat-msg-user-row').last();
    ok('his bubble keeps only his words, under a ↩ strip', await until(page, async () => (await bubble.locator('.chat-msg-user-bubble').innerText()) === 'teşekkürler, yayına al'
      && /To Super.*Birinci mesajına/.test((await bubble.locator('[data-testid="chat-msg-reply"]').innerText()).replace(/\s+/g, ' ')), 8000));
    await until(page, async () => turnEnds() >= endsBefore + 2, 15000);
    // His reply's strip scrolls to the Super answer it names.
    await scroller(page).evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
    await bubble.locator('[data-testid="chat-msg-reply"]').click().catch(() => {});
    const aRowId = await aRow.getAttribute('data-item-id');
    ok('…his reply strip scrolls to the answer it replies to', await until(page, async () => inView(page, `[data-super-slot="centre"] [data-item-id="${aRowId}"]`), 4000));

    // 4. A 2,000-character answer: a reply carries at most 100 characters of it.
    ok('a 2,000-character answer arrived', await sendAndWait(page, 'UZUN bir özet ver') && LONG.length > 2000);
    const longRow = centre(page).locator('.chat-msg-assistant-row').filter({ hasText: 'Uzun cevap:' }).last();
    await longRow.hover();
    await longRow.locator('[aria-label="Quote-reply"]').click();
    n = superFrames().length;
    await send(page, 'tamam');
    ok('…the reply to it carries at most 100 characters of it', await until(page, async () => {
      const f = superFrames()[n]?.blocks?.[0] ?? '';
      const quote = JSON.parse(f.split('\nquote: ')[1]?.split('\n')[0] ?? '""');
      return f.startsWith(`[Reply to message ref=${msgRef(LONG)} from=super]`) && Array.from(quote).length <= 100 && f.length < 200 && !f.includes(LONG.slice(0, 101));
    }, 15000), `${(superFrames()[n]?.blocks?.[0] ?? '').length} chars`);
    await until(page, async () => turnEnds() >= endsBefore + 4, 15000);

    // 5. An unmarked answer to the one message waiting: linked, right under it, no strip.
    ok('an unmarked answer arrived', await sendAndWait(page, 'Dördüncü: not al'));
    await page.waitForTimeout(500);
    shape = await transcriptShape(page);
    const tD = shape.find((x) => x.kind === 'text' && x.text.includes('Tamam, not aldım'));
    ok('…it is linked (a group) but draws no strip: its message is right above', !!tD?.grp && !shape.some((x) => x.strip === tD.grp), JSON.stringify(tD));

    // 5b. One block, a section per message (owner 2026-10-24, pick A): one container, a head per
    // section, no strip. The 2nd and 3rd message are steered in, each written about an agenda
    // line with its ↩ (iv).
    const SEC = {
      A: 'BOLUMLER: üç işi tek cevapta topla.',
      B: '[About agenda line note=n1 section=waiting]\nline: "Fiyat kartının adı"\n\nFiyat kartı bitti mi?',
      C: '[About agenda line note=n2 section=waiting]\nline: "Orbit dağıtımı"\n\nDağıtım ne durumda?',
    };
    const secEnds = turnEnds();
    await page.evaluate(() => {
      const w = window; w.__secSamples = [];
      w.__secTimer = setInterval(() => {
        const c = document.querySelector('[data-super-slot="centre"]');
        const row = [...(c?.querySelectorAll('.chat-msg-assistant-row') ?? [])].find((r) => (r.textContent || '').includes('BOLUMLER mesajına'));
        if (!row) return;
        const grp = row.getAttribute('data-reply-grp');
        const text = row.textContent || '';
        w.__secSamples.push({
          strip: !!grp && !!c.querySelector(`[data-reply-strip="${grp}"]`),
          heads: row.querySelectorAll('[data-testid="chat-reply-head"]').length,
          words: ['BOLUMLER mesajına', 'Fiyat kartı:', 'Dağıtım:'].filter((x) => text.includes(x)).length,
          mark: text.includes('<!--'),
        });
      }, 100);
    });
    await send(page, SEC.A);
    await until(page, async () => reports().some((r) => r.kind === 'busy3'), 15000);
    const sendAbout = async (line, words) => {
      await centreInput(page).fill('');
      const row = page.locator('[data-testid="super-agenda-row"]').filter({ hasText: line }).first();
      await row.hover().catch(() => {});
      await row.locator('[data-testid="super-agenda-about"]').click();
      await page.waitForTimeout(300);
      await page.keyboard.type(words, { delay: 8 });
      await page.keyboard.press('Enter');
    };
    await sendAbout('Fiyat kartının adı', 'Fiyat kartı bitti mi?');
    await page.waitForTimeout(600);
    await sendAbout('Orbit dağıtımı', 'Dağıtım ne durumda?');
    ok('the three new messages reached the super, the 2nd and 3rd steered with their About header', await until(page, async () => {
      const f = superFrames().filter((x) => Object.values(SEC).includes(x.blocks[0]));
      return f.length === 3 && f[1].folded && f[2].folded && f.every((x) => x.blocks.includes(`<owner-msg ref="${msgRef(x.blocks[0])}"/>`));
    }, 15000), JSON.stringify(superFrames().slice(-3).map((f) => [f.blocks[0].slice(0, 40), f.folded])));
    ok('a block with a section per message arrived', await until(page, async () => turnEnds() > secEnds, 40000));
    await page.waitForTimeout(800);
    const samples = await page.evaluate(() => { clearInterval(window.__secTimer); return window.__secSamples; });
    ok(`while it streamed (${samples.length} polls): no strip ever mounted`, samples.length > 10 && samples.every((x) => !x.strip), JSON.stringify(samples.filter((x) => x.strip).slice(0, 2)));
    ok('…no head before the 2nd section\'s words, never more heads than sections with words', samples.every((x) => (x.words < 2 ? x.heads === 0 : x.heads <= x.words)), JSON.stringify(samples.filter((x) => x.heads > 0 && x.heads > x.words).slice(0, 3)));
    ok('…a head once shown never went', samples.every((x, i) => i === 0 || x.heads >= samples[i - 1].heads) && samples.some((x) => x.heads >= 2 && x.words < 3), JSON.stringify(samples.map((x) => `${x.words}/${x.heads}`).join(' ')));
    ok('…no half mark ever showed', samples.every((x) => !x.mark));
    const secRow = centre(page).locator('.chat-msg-assistant-row').filter({ hasText: 'BOLUMLER mesajına' }).last();
    const heads = secRow.locator('[data-testid="chat-reply-head"]');
    const headTexts = (await heads.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const oneBody = await secRow.evaluate((row) => {
      const hs = [...row.querySelectorAll('[data-testid="chat-reply-head"]')];
      const bodies = new Set(hs.map((h) => h.closest('.chat-msg-assistant-body')));
      return hs.length === 3 && bodies.size === 1 && !bodies.has(null);
    });
    ok('three heads inside ONE answer body', oneBody, JSON.stringify(headTexts));
    ok('…head 1: "To your message" + his words', /To your message.*BOLUMLER: üç işi/.test(headTexts[0] ?? ''), headTexts[0]);
    ok('…heads 2-3: the pink About dot + the agenda line + his words', (await heads.nth(1).locator('.chat-msg-about-dot').count()) === 1 && (await heads.nth(2).locator('.chat-msg-about-dot').count()) === 1
      && /About.*Fiyat kartının adı.*Fiyat kartı bitti mi/.test(headTexts[1] ?? '') && /About.*Orbit dağıtımı.*Dağıtım ne durumda/.test(headTexts[2] ?? ''), JSON.stringify(headTexts));
    shape = await transcriptShape(page);
    const tS = shape.find((x) => x.kind === 'text' && x.text.includes('BOLUMLER mesajına'));
    ok('…no strip over it and no "To 3 messages" anywhere', !!tS && !shape.some((x) => x.strip === tS.grp) && !(await centre(page).innerText()).includes('To 3 messages'), JSON.stringify(tS));
    ok('…no `<!--` anywhere in the DOM', await noMarkInDom(page) && !(await page.evaluate(() => document.body.innerHTML.includes('&lt;!--'))));
    await heads.first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await shot(page, '03b-sections-1440-dark.png');
    // A head click lands on the message it names and flashes it.
    const bSel = await userRowSel(page, 'Fiyat kartı bitti mi');
    await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    await heads.nth(1).click();
    ok('clicking head 2 lands on message 2 and flashes it', await until(page, async () => !!bSel && await inView(page, bSel)
      && await page.locator(`${bSel}[data-reply-flash]`).count() === 1, 4000), bSel);
    // Copy: the words, never a head or a mark.
    await secRow.hover();
    await secRow.locator('[aria-label="Copy"]').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `unreadable: ${e}`);
    ok('Copy holds the answer without any head text or mark', copied.includes('BOLUMLER mesajına') && copied.includes('Dağıtım: yeşil') && !copied.includes('To your message') && !copied.includes('Fiyat kartının adı') && !copied.includes('<!--'), copied.slice(0, 200));

        // 6. A strip click while a turn streams: the view stays on the message.
    await send(page, 'MESGUL kal');
    await until(page, async () => reports().some((r) => r.kind === 'busy2'), 15000);
    await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    await centre(page).locator(`[data-reply-strip="${tA.grp}"] button`).click();
    await page.waitForTimeout(2500);
    ok('a strip clicked while a turn runs: the view stays on the message', await inView(page, aSel));
    await until(page, async () => reports().filter((r) => r.kind === 'turn-end' && r.said === 'Bitti.').length > 0, 20000);
    await page.waitForTimeout(800);
    ok('…and after the turn ends it is still there', await inView(page, aSel));
    // The same while ANOTHER turn streams, from a section head (its own busy turn).
    const busyBefore = reports().filter((r) => r.kind === 'busy2').length;
    await send(page, 'MESGUL kal yine');
    await until(page, async () => reports().filter((r) => r.kind === 'busy2').length > busyBefore, 15000);
    const s1Sel = await userRowSel(page, 'BOLUMLER: üç işi');
    await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    await secRow.locator('[data-testid="chat-reply-head"]').first().click();
    await page.waitForTimeout(2500);
    ok('a head clicked while a turn runs: the view stays on its message', !!s1Sel && await inView(page, s1Sel), s1Sel);
    await until(page, async () => reports().filter((r) => r.kind === 'turn-end' && r.said === 'Bitti.').length > 1, 20000);
    await page.waitForTimeout(800);
    ok('…and after that turn ends it is still there', !!s1Sel && await inView(page, s1Sel));

    // 7. The message above the 20-card window: the click reveals it, then scrolls to it.
    ok('a long stretch of rows arrived', await sendAndWait(page, 'DOLDUR'));
    await page.waitForTimeout(800);
    await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(600);
    const mountedBefore = await centre(page).locator('.chat-msg-user-row').filter({ hasText: 'Birinci: giriş sayfası' }).count();
    shape = await transcriptShape(page);
    const tBack = shape.find((x) => x.kind === 'text' && x.text.includes('En baştaki birinci'));
    ok('…its last answer names the first message (strip)', !!tBack && /Birinci: giriş sayfası/.test(shape.find((x) => x.strip === tBack.grp)?.text ?? ''), JSON.stringify(tBack));
    await centre(page).locator(`[data-reply-strip="${tBack.grp}"] button`).click();
    ok(`the target was above the window (mounted before: ${mountedBefore}); the click brings it into view`, mountedBefore === 0 && await until(page, async () => {
      const sel = await userRowSel(page, 'Birinci: giriş sayfası');
      return !!sel && await inView(page, sel);
    }, 6000));
    await shot(page, '04-window-jump-1440-dark.png');

    // 8. A reload draws every strip again from the replayed transcript.
    const stripsBefore = (await transcriptShape(page)).filter((x) => x.kind === 'strip').map((x) => x.text);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    await page.waitForTimeout(1500);
    await scroller(page).evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(800);
    // Reveal everything so the whole replay is compared.
    for (let i = 0; i < 6; i++) { const more = centre(page).locator('.chat-window-more'); if (!(await more.count())) break; await more.click(); await page.waitForTimeout(400); }
    const after = await transcriptShape(page);
    const stripsAfter = after.filter((x) => x.kind === 'strip').map((x) => x.text);
    ok('after a reload the out-of-order strips draw again', ['Birinci: giriş sayfası', 'To 2 messages', 'İkinci: fiyat kartının'].every((w) => stripsAfter.some((t) => t.includes(w))),
      JSON.stringify({ stripsBefore, stripsAfter }));
    ok('…his reply bubbles draw their ↩ strip again, only his words in the bubble', (await centre(page).locator('[data-testid="chat-msg-reply"]').count()) >= 2
      && !(await centre(page).locator('.chat-msg-user-bubble').allInnerTexts()).some((t) => t.includes('[Reply to message')));
    ok('…and no `<!-- re:` anywhere in the DOM', await noMarkInDom(page));
    const headsAfter = (await centre(page).locator('.chat-msg-assistant-row').filter({ hasText: 'BOLUMLER mesajına' }).last()
      .locator('[data-testid="chat-reply-head"]').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    ok('…the sectioned answer draws the same three heads again', JSON.stringify(headsAfter) === JSON.stringify(headTexts), JSON.stringify({ headTexts, headsAfter }));
    const headsAt = async (block = 'center') => centre(page).locator('[data-testid="chat-reply-head"]').first().evaluate((el, b) => el.scrollIntoView({ block: b }), block).catch(() => {});
    await headsAt();
    await page.waitForTimeout(400);
    await shot(page, '03e-sections-after-reload-1440.png');

    // 9. Screenshots: 1440 light, then 390x844.
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'light'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    await page.waitForTimeout(1200);
    const sel1440 = await userRowSel(page, 'Üçüncü: dağıtım');
    if (sel1440) await page.locator(sel1440).evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
    else {
      for (let i = 0; i < 6; i++) { const more = centre(page).locator('.chat-window-more'); if (!(await more.count())) break; await more.click(); await page.waitForTimeout(400); }
      const s2 = await userRowSel(page, 'Üçüncü: dağıtım');
      if (s2) await page.locator(s2).evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
    }
    await page.waitForTimeout(500);
    await shot(page, '05-out-of-order-1440-light.png');
    for (let i = 0; i < 6; i++) { const more = centre(page).locator('.chat-window-more'); if (!(await more.count())) break; await more.click(); await page.waitForTimeout(400); }
    await headsAt();
    await page.waitForTimeout(400);
    await shot(page, '03c-sections-1440-light.png');
    const oneLine = async (w) => page.evaluate((vw) => [...document.querySelectorAll('[data-super-slot="centre"] .chat-reply-strip, [data-super-slot="centre"] [data-testid="chat-msg-reply"], [data-super-slot="centre"] [data-testid="chat-reply-head"]')]
      .map((el) => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), right: Math.round(r.right), w: Math.round(r.width) }; })
      .filter((r) => r.w > 0)
      .map((r) => ({ ...r, ok: r.h <= 26 && r.right <= vw + 0.5 })), w);
    const s1440 = await oneLine(W);
    ok('1440: every strip and head one line, inside the window', s1440.length > 0 && s1440.every((r) => r.ok), JSON.stringify(s1440));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await motionIdle(page);
    const sel390 = await userRowSel(page, 'Üçüncü: dağıtım');
    if (sel390) await page.locator(sel390).evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, '06-390-strips.png');
    for (let i = 0; i < 6; i++) { const more = centre(page).locator('.chat-window-more'); if (!(await more.count())) break; await more.click(); await page.waitForTimeout(400); }
    await headsAt('start');
    await page.waitForTimeout(500);
    await shot(page, '03d-sections-390.png');
    const s390 = await oneLine(390);
    ok('390: every strip and head one line, inside the screen', s390.length > 0 && s390.every((r) => r.ok) && (await centre(page).locator('[data-testid="chat-reply-head"]').count()) >= 3, JSON.stringify(s390));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok('390: no horizontal overflow', overflow <= 1, `over by ${overflow}`);
    for (const theme of ['dark']) {
      await page.evaluate((t) => localStorage.setItem('dreamcontext-theme', t), theme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await backToStage(page);
      await page.waitForTimeout(1200);
      const s = await userRowSel(page, 'Üçüncü: dağıtım');
      if (s) await page.locator(s).evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
      await page.waitForTimeout(500);
      await shot(page, `07-390-${theme}.png`);
    }

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
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots in ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
