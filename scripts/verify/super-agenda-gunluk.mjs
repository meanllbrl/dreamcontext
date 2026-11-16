#!/usr/bin/env node
/**
 * The agenda in Günlük style, observed (task ajanda-gunluk-tarzinda-…): the real dashboard
 * server from this checkout's dist (scratch HOME, DREAMCONTEXT_DESKTOP=1, an owner key fed on
 * stdin the way the Mac shell does), a scripted stand-in `claude` (no tokens), fictional
 * project "orbit".
 *
 *   npm run build && node scripts/verify/super-agenda-gunluk.mjs
 *
 * At the hand-over the stand-in Super writes its notepad in every status (in progress, almost
 * done, not started, waiting, done) and asks one question. Across a server restart one Waiting
 * line is moved to yesterday (From earlier days) and one Done line to yesterday (it rolls off
 * into yesterday's saved day). Checks, at the large size: the groups in order, every status
 * glyph, the owner adds a line (Added by you, author owner), the status circle opens a 5-item
 * menu inside the window and its pick is recorded as his, hover shows Done and Ask, Done moves a
 * line, a row opens its detail beside the card, ‹ goes to yesterday (its Done line) and › back.
 * Then every size (small, medium, large, wide, full): rows drawn, hover Done/Ask at that size,
 * no row wider than the card, medium's counts filter the list, wide shows the detail inside the
 * card, full has the 7-day strip. Screenshots light and dark into OUT; zero page errors.
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
const SCRATCH = join(tmpdir(), `dc-verify-agenda-gunluk-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = process.env.OUT || join(REPO, 'tmp', 'verify-super-agenda-gunluk');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const KEY = 'verifyOwnerKey_0123456789abcdefghijklmnopqrstuv';

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { a: args.slice(0, 4).join(' '), st: r.status, o: ((r.stdout || '') + (r.stderr || '')).slice(0, 160) };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
function superTurn(text) {
  if (!text.startsWith('[super handover]')) return 'ok';
  const s = [
    cli('super', 'note', 'add', 'now', 'Ajanda Günlük tarzında yenileniyor'),
    cli('super', 'note', 'add', 'now', 'Telegram botları B2 zengin biçime geçiyor'),
    cli('super', 'note', 'add', 'now', 'Ekip üyesi sohbeti normal sohbet gibi'),
    cli('super', 'note', 'add', 'waiting', "Main'e gönderim: komut kartında Çalıştır'a bas"),
    cli('super', 'note', 'add', 'waiting', 'Pano Gönder ve al: iki kopyayla dene'),
    cli('super', 'note', 'add', 'done', 'Dal yapısı: dev, beta, main kuruldu'),
    cli('super', 'note', 'add', 'done', 'Dünden kalan biten satır'),
    cli('super', 'note', 'status', 'n2', 'almost-done'),
    cli('super', 'note', 'status', 'n3', 'not-started'),
    cli('super', 'ask', 'Telegram biçimi: A ya da B taslağını seç', '--options', 'A|B'),
  ];
  report({ kind: 'handover', steps: s });
  return 'Devraldım.';
}
let running = false;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user' || running) continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    running = true;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    let said = 'ok';
    try { said = role === 'super' ? superTurn(blocks.find((b) => b.startsWith('[super handover]')) ?? blocks[0] ?? '') : 'Fiyat sayfasının taslağı hazır.'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    running = false;
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const SHELL = `if (localStorage.getItem('verify-shell') === '1') { window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'owner_key' ? ${JSON.stringify(KEY)} : cmd === 'confirm_dialog' ? true : null), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }; }`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
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
async function startServer(port, logName) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  srv.stdin.write(`${KEY}\n`);
  const log = createWriteStream(join(SCRATCH, logName));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}
const stopServer = (srv) => new Promise((r) => { srv.once('exit', r); srv.kill('SIGTERM'); setTimeout(r, 5000); });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {} }; } };
const pad = () => record().pad ?? [];
const log = (...a) => console.log(...a);
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };

let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };

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
async function shot(page, name) { await clean(page); await page.waitForTimeout(350); /* popovers fade in over 160 ms */ await page.screenshot({ path: join(OUT, name) }); log(`  saved ${name}`); }
async function cardShot(page, name, pad = 24) {
  await clean(page);
  await page.waitForTimeout(350);
  const b = await agendaCard(page).boundingBox().catch(() => null);
  if (!b) { log(`  ! no card for ${name}`); return; }
  const vp = page.viewportSize();
  const x = Math.max(0, b.x - pad); const y = Math.max(0, b.y - pad);
  const extraRight = (await page.getByTestId('super-agenda-detail').count()) ? 380 : 0;
  await page.screenshot({ path: join(OUT, name), clip: { x, y, width: Math.min(vp.width - x, b.width + 2 * pad + extraRight), height: Math.min(vp.height - y, b.height + 2 * pad + 240) } });
  log(`  saved ${name}`);
}
const agendaCard = (page) => page.locator('[data-testid="super-container"][data-kind="agenda"]');
const agenda = (page) => agendaCard(page).locator('[data-testid="super-agenda"]');
const rows = (page) => agendaCard(page).locator('[data-testid="super-agenda-row"]');
const section = (page, g) => agendaCard(page).locator(`[data-testid="super-agenda-section-${g}"]`);
const rowWith = (page, text) => rows(page).filter({ hasText: text }).first();

async function settle(page, ms = 10000) {
  let last = '';
  for (const end = Date.now() + ms; Date.now() < end;) {
    const now = await page.evaluate(() => {
      const layer = document.querySelector('.super-stage-layer');
      const rects = [...document.querySelectorAll('.super-centre, [data-testid="super-container"]')].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; });
      return `${layer ? layer.childElementCount : 0}|${rects.join(';')}`;
    });
    if (now === last && now.startsWith('0|')) return true;
    last = now;
    await page.waitForTimeout(400);
  }
  return false;
}
async function owner(page, body) {
  return page.evaluate(async (b) => (await fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify(b) })).status, body);
}
async function toStage(page) {
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await clean(page);
  if (!(await page.getByTestId('super-surface').isVisible().catch(() => false))) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*(Chat|Sohbet)\s*\d*\s*$/ }).first();
    if (await nav.count()) await nav.click().catch(() => {});
  }
  await until(page, async () => page.getByTestId('super-surface').isVisible(), 30000);
}
async function setSize(page, size) {
  await agendaCard(page).hover();
  await agendaCard(page).locator('[data-testid="super-card-size-btn"], [data-testid="super-card-more"]').first().click();
  await page.getByTestId(`super-size-${size}`).click();
  const done = await until(page, async () => (await agendaCard(page).getAttribute('data-size')) === size, 8000);
  await settle(page);
  await page.mouse.move(5, 5);
  return done;
}
/** No row is wider than its card, and nothing in the agenda scrolls sideways. */
async function noOverflow(page) {
  return agendaCard(page).evaluate((card) => {
    const c = card.getBoundingClientRect();
    const bad = [...card.querySelectorAll('[data-testid="super-agenda-row"]')].map((r) => r.getBoundingClientRect()).filter((r) => r.width > 0 && (r.right > c.right + 0.5 || r.left < c.left - 0.5));
    const side = [...card.querySelectorAll('[data-testid="super-agenda"], [data-testid="super-agenda"] *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'hidden' && getComputedStyle(e).overflowX !== 'clip' && getComputedStyle(e).overflowX !== 'visible');
    return { bad: bad.length, side: side.map((e) => e.className).slice(0, 3) };
  });
}
const inViewport = (page, loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
async function hoverShows(page, text) {
  const r = rowWith(page, text);
  await r.hover();
  return until(page, async () => (await r.getByTestId('super-agenda-done').isVisible()) && (await r.getByTestId('super-agenda-about').isVisible()), 3000);
}

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let srv = await startServer(port, 'server-1.log');
  log(`server on ${base}, scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'tr-TR' });
  await context.addInitScript(SHELL);
  await context.addInitScript(() => { try { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'light'); } catch {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  try {
    // ── the hand-over: the Super writes its notepad in every status
    await page.goto(`${base}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await clean(page);
    if (!(await page.locator('.chat-cmp-input:visible').count())) {
      const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*(Chat|Sohbet)\s*\d*\s*$/ }).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat|Sohbet başlat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 90000);
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill('Fiyat sayfasının metnini yaz.');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    // The new shell's one way in is the drawer's Super Agent row; the old header tab where it still shows.
    const tab = page.locator('[data-testid="super-handover-btn"]:visible').first();
    if (await tab.count()) await tab.click();
    else await page.locator('aside button, aside a, nav button, nav a, [role="button"]').filter({ hasText: /^\s*(Super Agent|Süper Ajan)/ }).first().click();
    await page.waitForTimeout(1500);
    await shot(page, '00-after-super-row.png');
    ok('the Super wrote its notepad and asked', await until(page, async () => pad().length === 7 && reports().some((r) => r.kind === 'handover'), 90000), JSON.stringify(reports()).slice(0, 400));

    // ── a day passes for two lines: across a restart, a Waiting line and a Done line move to yesterday
    await stopServer(srv);
    const rec = record();
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(10, 0, 0, 0);
    for (const p of rec.pad) {
      if (p.text.startsWith('Pano Gönder')) { p.at = y.getTime(); p.bornAt = y.getTime(); }
      if (p.text.startsWith('Dünden kalan')) { p.at = y.getTime() + 3600_000; p.bornAt = y.getTime() + 3600_000; }
    }
    writeFileSync(RECORD, JSON.stringify(rec, null, 2));
    // From here the page plays the Mac app's shell (its owner key): the add box and his own marks.
    await page.evaluate(() => localStorage.setItem('verify-shell', '1'));
    srv = await startServer(port, 'server-2.log');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await toStage(page);
    if (!(record().containers ?? []).some((c) => c.kind === 'agenda')) await owner(page, { agenda: 'open' });
    await owner(page, { view: { mode: 'float' } });
    ok('the agenda is a card on the stage', await until(page, async () => (await agendaCard(page).count()) === 1, 15000));
    ok('yesterday\'s Done line rolled off into its saved day', await until(page, async () => !pad().some((p) => p.text.startsWith('Dünden kalan')), 15000), JSON.stringify(pad().map((p) => p.text)));
    if ((await agendaCard(page).getAttribute('data-size')) !== 'large') await setSize(page, 'large');
    await settle(page);
    await page.mouse.move(5, 5);

    // ── large: groups, statuses, add, status menu, hover, Done, detail, day arrows
    const groups = await agendaCard(page).locator('[data-testid^="super-agenda-section-"]').evaluateAll((els) => els.map((e) => e.dataset.section));
    ok('large: groups in order From earlier days, Waiting on you, Super is on it, Done', groups.join(',') === 'earlier,waiting,super,done', groups.join(','));
    ok('…the yesterday Waiting line sits in From earlier days with its day chip', (await section(page, 'earlier').locator('[data-testid="super-agenda-row"]').filter({ hasText: 'Pano Gönder' }).count()) === 1);
    ok('…the open question is in Waiting on you', await until(page, async () => (await section(page, 'waiting').locator('[data-testid="super-agenda-row"]').filter({ hasText: 'Telegram biçimi' }).count()) === 1, 15000));
    const glyphs = await agendaCard(page).locator('.agenda-glyph[data-status]').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.status))]);
    ok('…every status draws its glyph (in progress, almost done, not started, waiting, done)', ['in-progress', 'almost-done', 'not-started', 'waiting', 'done'].every((s) => glyphs.includes(s)), glyphs.join(','));
    const superOrder = await section(page, 'super').locator('.super-agenda-name').allInnerTexts();
    ok('…inside a group the newest update is on top', superOrder[0]?.startsWith('Ekip üyesi') || superOrder[0]?.startsWith('Telegram botları'), superOrder.join(' | '));
    await shot(page, '01-large-light.png');
    await cardShot(page, '01b-large-light-card.png');

    await agendaCard(page).getByTestId('super-agenda-plus').click();
    await agendaCard(page).getByTestId('super-agenda-add-input').fill('Beta için fiyat fikrini yaz');
    await agendaCard(page).getByTestId('super-agenda-add-submit').click();
    ok('the owner adds a line: Added by you, Not started, author owner', await until(page, async () => (await section(page, 'mine').locator('[data-testid="super-agenda-row"]').filter({ hasText: 'Beta için fiyat' }).count()) === 1
      && pad().some((p) => p.text === 'Beta için fiyat fikrini yaz' && p.author === 'owner'), 10000), JSON.stringify(pad().slice(-1)));

    const mineRow = rowWith(page, 'Beta için fiyat');
    await mineRow.getByTestId('super-agenda-status').click();
    const menu = page.getByTestId('super-agenda-status-menu');
    ok('the status circle opens the five statuses', await until(page, async () => (await menu.locator('[role="menuitemradio"]').count()) === 5, 3000));
    ok('…the menu sits inside the window', await inViewport(page, menu).catch(() => false));
    const near = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="super-agenda-status-menu"]').getBoundingClientRect();
      const a = [...document.querySelectorAll('[data-testid="super-agenda-status"]')].find((b) => b.closest('[data-testid="super-agenda-row"]')?.textContent.includes('Beta için fiyat')).getBoundingClientRect();
      return { dx: Math.round(m.left - a.left), dy: Math.round(Math.min(Math.abs(m.top - a.bottom), Math.abs(m.bottom - a.top))) };
    });
    ok('…and opens at its circle (within 40 px)', Math.abs(near.dx) <= 40 && near.dy <= 40, JSON.stringify(near));
    await shot(page, '02-status-menu-light.png');
    await menu.locator('button[data-status="in-progress"]').click();
    ok('…picking In progress is recorded on his line', await until(page, async () => { const p = pad().find((x) => x.text.startsWith('Beta için fiyat')); return p && p.section === 'now' && !p.stage; }, 8000), JSON.stringify(pad().find((x) => x.text.startsWith('Beta için fiyat'))));

    ok('hover on a line shows Done and Ask (large)', await hoverShows(page, "Main'e gönderim"));
    await shot(page, '03-hover-large-light.png');
    await rowWith(page, 'Ekip üyesi').hover();
    await rowWith(page, 'Ekip üyesi').getByTestId('super-agenda-done').click();
    ok('Done on hover moves the line to Done', await until(page, async () => pad().find((x) => x.text.startsWith('Ekip üyesi'))?.section === 'done'
      && (await section(page, 'done').locator('[data-testid="super-agenda-row"]').filter({ hasText: 'Ekip üyesi' }).count()) === 1, 8000));

    await page.mouse.move(5, 5);
    await rowWith(page, 'Telegram botları').locator('.super-agenda-row-btn').click();
    const detail = page.getByTestId('super-agenda-detail');
    ok('a row opens its detail', await until(page, async () => detail.isVisible(), 4000));
    const geo = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="super-container"][data-kind="agenda"]').getBoundingClientRect();
      const d = document.querySelector('[data-testid="super-agenda-detail"]')?.getBoundingClientRect();
      return d && { overlap: d.left < c.right - 1 && d.right > c.left + 1 && d.top < c.bottom - 1 && d.bottom > c.top + 1, inside: d.left >= 0 && d.top >= 0 && d.right <= innerWidth && d.bottom <= innerHeight };
    });
    ok('…beside the card, inside the window', geo && !geo.overlap && geo.inside, JSON.stringify(geo));
    const gap = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="super-container"][data-kind="agenda"]').getBoundingClientRect();
      const d = document.querySelector('[data-testid="super-agenda-detail"]').getBoundingClientRect();
      return Math.round(Math.min(Math.abs(d.left - c.right), Math.abs(c.left - d.right)));
    });
    ok('…right next to it (gap at most 32 px; the bug was ~450)', gap <= 32, String(gap));
    ok('…with Ask and Done', (await detail.getByTestId('super-agenda-detail-ask').count()) === 1 && (await detail.getByTestId('super-agenda-detail-done').count()) === 1);
    await shot(page, '04-detail-large-light.png');
    await page.keyboard.press('Escape');
    ok('…Escape closes it', await until(page, async () => (await detail.count()) === 0, 3000));

    const dayBefore = await agendaCard(page).getByTestId('super-agenda-day').innerText();
    const progressToday = await agendaCard(page).getByTestId('super-agenda-progress').innerText();
    await agendaCard(page).getByTestId('super-agenda-day-prev').click();
    ok('‹ goes to yesterday and shows its saved Done line', await until(page, async () => (await agendaCard(page).getByTestId('super-agenda-day').innerText()) !== dayBefore
      && (await rows(page).filter({ hasText: 'Dünden kalan' }).count()) === 1, 8000));
    const progressPast = await agendaCard(page).getByTestId('super-agenda-progress').innerText();
    ok('…its count is that day\'s, not today\'s', progressPast !== progressToday && /\b1\b/.test(progressPast), `${progressToday} | ${progressPast}`);
    await shot(page, '05-yesterday-light.png');
    await agendaCard(page).getByTestId('super-agenda-day-next').click();
    ok('› comes back to today', await until(page, async () => (await agendaCard(page).getByTestId('super-agenda-day').innerText()) === dayBefore, 5000));
    await agendaCard(page).getByTestId('super-agenda-day-next').click();
    ok('› goes on to tomorrow (not greyed) and shows its empty state', await until(page, async () => (await agendaCard(page).getByTestId('super-agenda-day').innerText()) !== dayBefore
      && (await agendaCard(page).getByTestId('super-agenda-day-next').isEnabled()), 5000));
    await agendaCard(page).getByTestId('super-agenda-day-prev').click();
    ok('‹ comes back to today from tomorrow', await until(page, async () => (await agendaCard(page).getByTestId('super-agenda-day').innerText()) === dayBefore, 5000));

    // ── every size, both themes
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'dark'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await toStage(page);
        await owner(page, { view: { mode: 'float' } });
        await until(page, async () => (await agendaCard(page).count()) === 1, 10000);
      }
      for (const size of ['small', 'medium', 'large', 'wide']) {
        // Wide (3x2 tiles) needs more room than 1440 leaves beside the centre: sized at 1800.
        if (size === 'wide') { await page.setViewportSize({ width: 1800, height: 1130 }); await settle(page); }
        ok(`${theme} ${size}: the card takes the size`, await setSize(page, size));
        ok(`${theme} ${size}: lines drawn`, await until(page, async () => (await rows(page).count()) > 0, 5000));
        const ov = await noOverflow(page);
        ok(`${theme} ${size}: no row wider than the card, nothing scrolls sideways`, ov.bad === 0 && ov.side.length === 0, JSON.stringify(ov));
        // A line row (it has the status circle): a question row has Ask only, by design.
        const lineRow = rows(page).filter({ has: page.getByTestId('super-agenda-status') }).first();
        const first = (await lineRow.locator('.super-agenda-name').innerText()).trim();
        const hv = await hoverShows(page, first.replace(/…$/, '').slice(0, 6));
        ok(`${theme} ${size}: hover shows Done and Ask`, hv);
        await cardShot(page, `10-${size}-${theme}-hover.png`);
        await page.mouse.move(5, 5);
        if (size === 'medium') {
          const f = agendaCard(page).getByTestId('super-agenda-filter-done');
          if (await f.count()) {
            await f.click();
            ok(`${theme} medium: the Done count filters the list to Done lines`, await until(page, async () => (await rows(page).count()) > 0 && (await agendaCard(page).locator('[data-testid="super-agenda-row"] .agenda-glyph[data-status]:not([data-status="done"]):not([data-status="archived"])').count()) === 0, 3000));
            await cardShot(page, `11-medium-${theme}-done-filter.png`);
            await agendaCard(page).getByTestId('super-agenda-filter-waiting').click().catch(() => {});
          } else ok(`${theme} medium: the counts filter the list`, false, 'no filter buttons');
          await agendaCard(page).getByTestId('super-agenda-plus').click();
          ok(`${theme} medium: + opens one add box`, await until(page, async () => page.getByTestId('super-agenda-add-input').isVisible(), 3000));
          if (theme === 'light') {
            // A refused add says why where he is typing (review r1: a full agenda).
            await page.route('**/api/super/pad/add', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'pad_full', message: 'the agenda is full' }) }));
            await page.getByTestId('super-agenda-add-input').fill('Bir satır daha');
            await page.getByTestId('super-agenda-add-submit').click();
            ok('light medium: a refused add says why inside the add box, in words', await until(page, async () => (await page.getByTestId('super-agenda-add-error').isVisible()) && !/Request failed/.test(await page.getByTestId('super-agenda-add-error').innerText()), 4000));
            await shot(page, '11b-medium-light-add-refused.png');
            await page.unroute('**/api/super/pad/add');
          }
          await page.keyboard.press('Escape');
        }
        if (size === 'small' && theme === 'light') {
          // A refused Done shows on the small card itself (review r1).
          await page.route('**/api/super/pad', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unknown_note', message: 'no such note' }) }) : r.continue()));
          const lr = rows(page).filter({ has: page.getByTestId('super-agenda-status') }).first();
          await lr.hover();
          await lr.getByTestId('super-agenda-done').click();
          ok('light small: a refused Done says why on the card, in words', await until(page, async () => (await agendaCard(page).getByTestId('super-agenda-error').isVisible()) && !/Request failed/.test(await agendaCard(page).getByTestId('super-agenda-error').innerText()), 4000));
          await cardShot(page, '12b-small-light-done-refused.png');
          await page.unroute('**/api/super/pad');
          await page.mouse.move(5, 5);
        }
        if (size === 'small') {
          await rows(page).getByTestId('super-agenda-status').first().click().catch(() => {});
          const m = page.getByTestId('super-agenda-status-menu');
          ok(`${theme} small: the status circle opens its menu`, await until(page, async () => m.isVisible(), 3000));
          ok(`${theme} small: the status menu fits the window`, await inViewport(page, m).catch(() => false));
          await shot(page, `12-small-${theme}-menu.png`);
          await page.keyboard.press('Escape');
        }
        if (size === 'wide') {
          await shot(page, `13a-wide-${theme}-1800.png`);
          await rows(page).filter({ hasText: 'Telegram botları' }).first().locator('.super-agenda-row-btn').click();
          ok(`${theme} wide: the detail opens inside the card`, await until(page, async () => agendaCard(page).getByTestId('super-agenda-detail-inline').isVisible(), 4000));
          await cardShot(page, `13-wide-${theme}-detail.png`);
          await page.keyboard.press('Escape');
          await page.setViewportSize({ width: 1440, height: 900 });
          await settle(page);
        }
      }
      // full: side by side with the agenda as the card
      const id = (record().containers ?? []).find((c) => c.kind === 'agenda')?.id;
      await owner(page, { view: { mode: 'half', card: id } });
      ok(`${theme} full: the 7-day strip`, await until(page, async () => (await page.getByTestId('super-agenda-week-day').count()) === 7, 8000));
      ok(`${theme} full: every day of the strip is clickable and the week arrows are on`, (await page.locator('[data-testid="super-agenda-week-day"]:disabled').count()) === 0
        && await page.getByTestId('super-agenda-week-next').isEnabled() && await page.getByTestId('super-agenda-week-prev').isEnabled());
      await page.locator('[data-testid="super-agenda-week-day"]:not([data-on="true"])').last().click();
      ok(`${theme} full: a click on another day shows that day`, await until(page, async () => (await page.locator('[data-testid="super-agenda-week-day"][data-on="true"]').count()) === 1
        && (await page.locator('[data-testid="super-agenda-week-day"][data-today="true"][data-on="true"]').count()) === 0, 5000));
      await shot(page, `13b-full-${theme}-other-day.png`);
      await page.locator('[data-testid="super-agenda-week-day"][data-today="true"]').click();
      await settle(page);
      await page.mouse.move(5, 5);
      await shot(page, `14-full-${theme}.png`);
      const fr = page.locator('[data-testid="super-agenda"] [data-testid="super-agenda-row"]').filter({ hasText: "Main'e gönderim" }).first();
      await fr.hover();
      ok(`${theme} full: hover shows Done and Ask`, await until(page, async () => fr.getByTestId('super-agenda-done').isVisible(), 3000));
      await shot(page, `15-full-${theme}-hover.png`);
      await owner(page, { view: { mode: 'float' } });
      await until(page, async () => (await agendaCard(page).count()) === 1, 8000);
    }

    // ── 1280x800, large, light (sized large first: wide cannot fit at 1280 and waits in Others)
    await setSize(page, 'large');
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'light'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await toStage(page);
    await owner(page, { view: { mode: 'float' } });
    // A narrow stage keeps the agenda behind the centre's Agenda button (stage behaviour, not this
    // task's): the button brings it, as a card or side by side.
    const anyAgenda = page.locator('[data-testid="super-agenda"]').first();
    if (!(await until(page, async () => anyAgenda.isVisible(), 4000))) await page.getByTestId('super-agenda-open').click().catch(() => {});
    ok('1280: the agenda shows', await until(page, async () => anyAgenda.isVisible(), 10000));
    await settle(page);
    await page.mouse.move(5, 5);
    await shot(page, '20-agenda-1280-light.png');
    const ov = await anyAgenda.evaluate((a) => {
      const c = a.getBoundingClientRect();
      return [...a.querySelectorAll('[data-testid="super-agenda-row"]')].map((r) => r.getBoundingClientRect()).filter((r) => r.width > 0 && (r.right > c.right + 0.5 || r.left < c.left - 0.5)).length;
    });
    ok('1280: no row wider than the agenda', ov === 0, String(ov));
  } catch (e) {
    ok('the run finished', false, String(e?.stack ?? e).slice(0, 400));
    await page.screenshot({ path: join(OUT, 'zz-failure.png') }).catch(() => {});
  } finally {
    // The 404/409 are the refusals this script forces on purpose (page.route), once each.
    const real = errors.filter((e) => !/favicon|ResizeObserver loop|WebSocket|ERR_CONNECTION_REFUSED|status of (404|409)/.test(e));
    // ERR_CONNECTION_REFUSED: only while the script restarts the server on purpose.
    ok('zero page errors', real.length === 0, real.slice(0, 5).join(' | '));
    await browser.close();
    await stopServer(srv);
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} · screenshots ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
