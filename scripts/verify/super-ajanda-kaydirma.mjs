#!/usr/bin/env node
/**
 * The agenda card scrolls as ONE area and says "unchanged 2h+" once per group (owner 15 Nov:
 * "kaydırdığımda üst kısım da kaysın komple", "unchanged'ler çok kalabalık oluyor", pick A).
 *
 *   npm run build && node scripts/verify/super-ajanda-kaydirma.mjs [--out <dir>]
 *
 * Real dashboard server on dist/, scratch HOME, a fictional project (acme), a scripted `claude`
 * stand-in (no tokens). The stage record holds ten lines from earlier days (unchanged 2h+) and a
 * full day. For every float size (small, medium, large, wide) in dark and light:
 *   S1  the scrolling area is the whole card body (its height = the body's), not a strip; the
 *       1x1 tile shows its top lines and its foot with nothing to scroll; medium keeps its filters
 *       at hand and its right column (head and lines) scrolls as one;
 *   S2  scrolled to the end, the day head is off screen (it moved up with the list);
 *   S3  no "unchanged" pill on any row; the earlier group's head says it once ("10 unchanged");
 *   S4  after scrolling a row still answers the pointer (Done / Ask show on hover);
 *   S5  wide with a line's detail open: the left column (head and list) scrolls as one.
 * Screenshots of the card before and after scrolling. Exit 1 on a failure or a console error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(REPO, 'package.json'));
const { chromium } = require('playwright');
const OUT = resolve(arg('out', join(REPO, 'tmp/develop/ajanda-kaydirma')));
const PORT = Number(arg('port', 45893));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-ajanda-kaydirma-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const ACME = join(SCRATCH, 'acme');
const RECORD = join(ACME, '_dream_context', 'state', '.super-agent.json');
const failures = [];
// The Mac app's owner key (the shell stub below hands it to the page): his add box and marks.
const KEY = 'verifyOwnerKey_0123456789abcdefghijklmnopqrstuv';
const SHELL = `window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'owner_key' ? ${JSON.stringify(KEY)} : cmd === 'confirm_dialog' ? true : null), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;
const consoleErrors = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail ?? ''}`}`);
  if (!ok) failures.push(name);
};
mkdirSync(OUT, { recursive: true });

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (!process.argv.slice(2).includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
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
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'v-' + process.pid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });

const DAY = 24 * 3600 * 1000;
function pad() {
  const now = Date.now();
  const earlier = [
    'Private line announcement: not sent to Mod Plus yet',
    'Claude 24 hour close check: starts after 9 Nov 16:17',
    'Robin (Northside) three lessons to make up',
    'Invoice export date format',
    'Calendar sync for the partner school',
    'Homework screen copy review',
    'Payout report for October',
    'Parent message templates in English',
    'Trial reminder email wording',
    'Pricing page screenshot refresh',
  ].map((text, i) => ({ id: `n${i + 1}`, section: 'now', text, at: now - (6 - (i % 2)) * DAY - i * 60000 }));
  const today = [
    ['waiting', 'Live funnel: walk the local site, then approve going live'],
    ['waiting', 'Institution calendar: look at the demo, then approve live'],
    ['waiting', 'Founder tests: live funnel, calendar, payouts, student count'],
    ['now', 'Payouts go live: merging, then release'],
    ['now', 'Weekly brief to the team channel'],
    ['done', 'Payout plan answered on its card'],
    ['done', 'Absent and cancelled lessons counted right'],
    ['done', 'Demo video trimmed'],
  ].map(([section, text], i) => ({ id: `n${i + 11}`, section, text, at: now - (20 - i) * 60000 }));
  return [...earlier, ...today];
}

function seed(size) {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(ACME, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', ACME, 'init', '-q']);
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme'], projectOrder: ['acme'], lastVault: 'acme' }));
  dc(ACME, 'vaults', 'add', 'acme', ACME);
  const id = `agenda-${createHash('sha1').update('agenda').digest('hex').slice(0, 12)}`;
  writeFileSync(RECORD, JSON.stringify({
    v: 1, session: randomUUID(), enabled: true,
    containers: [{ id, kind: 'agenda', ref: 'agenda', shape: 'square', size, sizeBy: 'owner', place: 'float', by: 'super' }],
    pad: pad(), groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [],
  }));
}

async function server() {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(PORT)], { cwd: ACME, env: { ...env(), PATH, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
  srv.stdin.write(`${KEY}\n`);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return srv; } catch { /* up soon */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('server did not come up');
}

const wait = (p, ms = 800) => p.waitForTimeout(ms);
const until = async (p, fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(p, 150); } return false; };
const card = (p) => p.locator('[data-testid="super-container"][data-kind="agenda"]').first();

async function openStage(browser, dark) {
  const ctx = await browser.newContext({ viewport: { width: 1888, height: 1000 }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2 });
  await ctx.addInitScript(SHELL);
  await ctx.addInitScript((d) => { try { localStorage.setItem('theme', d ? 'dark' : 'light'); localStorage.setItem('dreamcontext-theme', d ? 'dark' : 'light'); } catch { /* */ } }, dark);
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
  p.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
  await p.route('**/api/onboarding/readiness**', async (r) => { try { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); } catch { /* page closed */ } });
  await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
  await wait(p, 2200);
  const g = p.getByRole('button', { name: 'Got it' });
  if (await g.isVisible().catch(() => false)) { await g.click(); await wait(p, 300); }
  await p.keyboard.press('Escape');
  await until(p, async () => (await card(p).isVisible()), 20000);
  await wait(p, 1500);
  return { ctx, p };
}

/** The scrolling area, the body it sits in and where the day head is. */
const measure = (p, scrollerSel, headSel) => p.evaluate(([sel, hsel]) => {
  const root = document.querySelector('[data-testid="super-container"][data-kind="agenda"] [data-testid="super-agenda"]');
  const sc = sel ? root.querySelector(sel) : root;
  const body = root.parentElement;
  const head = root.querySelector(hsel || '.agenda-head, .agenda-title-row');
  const foot = root.querySelector('.agenda-foot');
  const r = (el) => el.getBoundingClientRect();
  return {
    size: root.getAttribute('data-size'),
    bodyH: Math.round(body.clientHeight), scH: Math.round(sc.clientHeight), scroll: Math.round(sc.scrollHeight),
    scrollTop: Math.round(sc.scrollTop), scTop: Math.round(r(sc).top), headBottom: Math.round(r(head).bottom),
    rootScroll: Math.round(root.scrollHeight), rootH: Math.round(root.clientHeight),
    footInside: foot ? r(foot).bottom <= r(root).bottom + 0.5 : null,
    listOwnScroll: [...root.querySelectorAll('.agenda-groups')].some((g) => g.scrollHeight > g.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(g).overflowY)),
  };
}, [scrollerSel, headSel]);
const scrollEnd = (p, scrollerSel) => p.evaluate((sel) => {
  const root = document.querySelector('[data-testid="super-container"][data-kind="agenda"] [data-testid="super-agenda"]');
  const sc = sel ? root.querySelector(sel) : root;
  sc.scrollTop = sc.scrollHeight;
}, scrollerSel);

const agendaState = (p) => p.evaluate(() => {
  const f = document.querySelector('[data-testid="super-container"][data-kind="agenda"]');
  const a = f?.querySelector('[data-testid="super-agenda"]');
  const b = f?.getBoundingClientRect();
  return { where: f?.getAttribute('data-where'), size: a?.getAttribute('data-size'), w: Math.round(b?.width ?? 0), h: Math.round(b?.height ?? 0) };
});
/** S6: the agenda opens side by side (half page) from its own controls, and full screen from there;
 *  the larger view draws the fuller agenda (the week strip, the line's detail beside it). `how`:
 *  'head' = a click on its title bar, 'button' = its side-by-side button. */
async function sideAndFull(p, name, how) {
  await p.evaluate(() => { const r = document.querySelector('[data-testid="super-container"][data-kind="agenda"] [data-testid="super-agenda"]'); if (r) r.scrollTop = 0; });
  await card(p).hover();
  if (how === 'head') {
    // The window lights sit over the title's start: he clicks the end of the word he sees.
    const pt = await card(p).locator('.super-card-head .super-card-title').evaluate((el) => {
      const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect();
      return { x: b.right - 4, y: b.top + b.height / 2 };
    });
    await p.mouse.click(pt.x, pt.y);
  }
  else await card(p).getByTestId('super-agenda-side').click();
  await wait(p, 1200);
  const half = await agendaState(p);
  console.log('    half   ' + JSON.stringify(half));
  check(`[${name}] S6 its ${how === 'head' ? 'title bar' : 'side-by-side button'} opens it side by side (half page), the full agenda drawn`, half.where === 'half' && half.size === 'full' && half.w >= 500, JSON.stringify(half));
  check(`[${name}] S6 side by side it shows more: the week strip`, (await card(p).locator('.agenda-week').count()) === 1);
  await p.screenshot({ path: join(OUT, `${name}-5-half.png`) });
  const btn = card(p).getByTestId('super-card-fullscreen-btn');
  const has = (await btn.count()) === 1;
  if (has) await btn.click();
  await wait(p, 800);
  const fs = p.getByTestId('super-agenda-fullscreen');
  const fsOk = has && await fs.isVisible().catch(() => false) && (await fs.locator('[data-testid="super-agenda"][data-size="full"]').count()) === 1;
  check(`[${name}] S6 from side by side its full-screen button opens the agenda over the window`, fsOk, JSON.stringify({ has }));
  if (fsOk) {
    const box = await fs.boundingBox();
    check(`[${name}] S6 full screen covers the window`, box && box.width >= 1880 && box.height >= 990, JSON.stringify(box));
    await fs.locator('[data-testid="super-agenda-section-earlier"] .super-agenda-row-btn').first().click();
    await wait(p, 500);
    check(`[${name}] S6 full screen: a line's detail opens beside the list`, (await fs.getByTestId('super-agenda-detail-inline').count()) === 1);
    // Its status menu opens in front of the full screen and takes the click (review r2).
    await fs.getByTestId('super-agenda-status').first().click();
    await wait(p, 400);
    const menu = await p.evaluate(() => {
      const m = document.querySelector('.agenda-menu');
      if (!m) return { open: false };
      const b = m.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { open: true, inMenu: !!hit && m.contains(hit) };
    });
    check(`[${name}] S6 full screen: a line's status menu opens in front and takes the click`, menu.open && menu.inMenu, JSON.stringify(menu));
    await p.screenshot({ path: join(OUT, `${name}-6b-full-menu.png`) });
    await p.keyboard.press('Escape');
    await wait(p, 300);
    await p.screenshot({ path: join(OUT, `${name}-6-full.png`) });
    await p.keyboard.press('Escape');
    await wait(p, 300);
    if (await fs.isVisible().catch(() => false)) await p.keyboard.press('Escape');
    await wait(p, 400);
    check(`[${name}] S6 Esc closes full screen`, !(await fs.isVisible().catch(() => false)));
  }
  // Back to the floating card for the next scene.
  await card(p).hover();
  await card(p).getByTestId('super-card-minimize').click().catch(() => {});
  await until(p, async () => (await agendaState(p)).where === 'float', 4000);
}

/** S7: the + floats at the card's bottom-right corner, keeps out of the last line, opens a small box
 *  in place (Escape cancels, Enter adds). */
async function fab(p, name, size) {
  const plus = card(p).getByTestId('super-agenda-plus');
  check(`[${name}] S7 no "Add a line" row in the head any more`, (await card(p).locator('.agenda-head + .agenda-bar + .agenda-add, .agenda-add.agenda-add').count()) === 0);
  check(`[${name}] S7 the + is there`, (await plus.count()) === 1);
  if (!(await plus.count())) return;
  const geo = await p.evaluate(() => {
    const f = document.querySelector('[data-testid="super-container"][data-kind="agenda"]');
    const root = f.querySelector('[data-testid="super-agenda"]');
    // Every area that scrolls (the body; medium's right column; wide's left column with a detail open) to its end.
    for (const el of [root, ...root.querySelectorAll('.agenda-main, .agenda-col')]) el.scrollTop = el.scrollHeight;
    const b = f.querySelector('[data-testid="super-agenda-plus"]').getBoundingClientRect();
    const c = f.getBoundingClientRect();
    const rows = [...root.querySelectorAll('[data-testid="super-agenda-row"]')];
    const last = rows[rows.length - 1]?.getBoundingClientRect();
    return { right: Math.round(c.right - b.right), bottom: Math.round(c.bottom - b.bottom), lastBottom: last ? Math.round(last.bottom) : null, plusTop: Math.round(b.top) };
  });
  await wait(p, 300);
  console.log('    fab    ' + JSON.stringify(geo));
  check(`[${name}] S7 the + sits in the bottom-right corner (${geo.right}px, ${geo.bottom}px from the edges)`, geo.right >= 0 && geo.right <= 24 && geo.bottom >= 0 && geo.bottom <= 24, JSON.stringify(geo));
  if (size !== 'small') check(`[${name}] S7 scrolled to the end, the + does not cover the last line`, geo.lastBottom !== null && geo.lastBottom <= geo.plusTop, JSON.stringify(geo));
  await card(p).screenshot({ path: join(OUT, `${name}-7-fab.png`) });
  await plus.focus();
  await p.keyboard.press('Enter');
  const input = card(p).getByTestId('super-agenda-add-input');
  check(`[${name}] S7 the + opens by keyboard into a small box, focused`, await until(p, async () => (await input.isVisible()) && (await input.evaluate((el) => el === document.activeElement)), 3000));
  await card(p).screenshot({ path: join(OUT, `${name}-8-fab-open.png`) });
  await p.keyboard.press('Escape');
  check(`[${name}] S7 Escape cancels: the + is back`, await until(p, async () => (await input.count()) === 0 && (await plus.count()) === 1, 3000));
  if (size === 'large') {
    await plus.click();
    await input.fill('Call the partner school back');
    await p.keyboard.press('Enter');
    check(`[${name}] S7 Enter adds the line (it lands under his own lines)`, await until(p, async () => (await card(p).locator('[data-testid="super-agenda-row"]').filter({ hasText: 'Call the partner school back' }).count()) === 1, 8000));
    check(`[${name}] S7 the box closes after adding`, await until(p, async () => (await input.count()) === 0, 3000));
  }
}

/** S8: list or board, his pick; the board is three columns, waiting, on it, done. */
async function boardView(p, name) {
  check(`[${name}] S8 the list is the default`, (await card(p).getByTestId('super-agenda-view-list').getAttribute('aria-pressed')) === 'true' && (await card(p).getByTestId('super-agenda-board').count()) === 0);
  await card(p).getByTestId('super-agenda-view-board').click();
  await wait(p, 400);
  const cols = await card(p).locator('[data-testid="super-agenda-board"] > .agenda-board-col').count();
  const counts = await card(p).locator('[data-testid="super-agenda-board"] .agenda-board-col').evaluateAll((els) => els.map((e) => e.querySelectorAll('[data-testid="super-agenda-row"]').length));
  check(`[${name}] S8 the board shows three columns with every line (${counts.join('/')})`, cols === 3 && counts[0] === 3 && counts[1] >= 12 && counts[2] === 3, JSON.stringify(counts));
  await card(p).screenshot({ path: join(OUT, `${name}-9-board.png`) });
  await p.reload();
  await until(p, async () => (await card(p).isVisible()), 15000);
  await wait(p, 1500);
  check(`[${name}] S8 his pick holds after a reload`, (await card(p).getByTestId('super-agenda-board').count()) === 1);
  await card(p).getByTestId('super-agenda-view-list').click();
  await wait(p, 300);
}

async function scene(browser, size, dark) {
  const name = `${size}-${dark ? 'dark' : 'light'}`;
  console.log(`\n── ${name}`);
  const { ctx, p } = await openStage(browser, dark);
  try {
    await p.mouse.move(5, 995);
    if (size === 'small') {
      // The 1x1 tile: its top three lines and the waiting count, at a glance; nothing scrolls.
      const m = await measure(p);
      console.log('    tile   ' + JSON.stringify(m));
      await card(p).screenshot({ path: join(OUT, `${name}-1-top.png`) });
      check(`[${name}] S1 the tile does not scroll and its foot ("N waiting on you") stays inside`, m.rootScroll <= m.rootH + 1 && m.footInside === true && !m.listOwnScroll, JSON.stringify(m));
    } else {
      // Medium: the filters stay at hand on the left; its right column (head and lines) is the one area.
      const sc = size === 'medium' ? '.agenda-main' : undefined;
      const hd = size === 'medium' ? '.agenda-main-head' : undefined;
      if (size === 'medium') { await card(p).getByTestId('super-agenda-filter-onit').click(); await wait(p, 400); }
      const before = await measure(p, sc, hd);
      console.log('    before ' + JSON.stringify(before));
      await card(p).screenshot({ path: join(OUT, `${name}-1-top.png`) });
      check(`[${name}] S1 the scrolling area is the card body's full height (${before.scH} of ${before.bodyH} px), the list has no strip of its own`, before.scH >= before.bodyH - 16 && !before.listOwnScroll, JSON.stringify(before));
      check(`[${name}] S1 there is more than fits (the check is real)`, before.scroll > before.scH + 4, JSON.stringify(before));
      await scrollEnd(p, sc);
      await wait(p, 300);
      const after = await measure(p, sc, hd);
      console.log('    after  ' + JSON.stringify(after));
      check(`[${name}] S2 scrolled to the end, the head is off screen`, after.scrollTop > 0 && after.headBottom <= after.scTop, JSON.stringify(after));
      await card(p).screenshot({ path: join(OUT, `${name}-2-scrolled.png`) });
    }
    const pills = await card(p).locator('.super-agenda-chip[data-kind="stale"]').count();
    check(`[${name}] S3 no "unchanged" pill on any row`, pills === 0, `${pills} pills`);
    if (size === 'large' || size === 'wide') {
      const note = card(p).getByTestId('super-agenda-stale-earlier');
      const text = (await note.textContent().catch(() => '')) ?? '';
      check(`[${name}] S3 the earlier group's head says it once: "${text.trim()}"`, (await note.count()) === 1 && /10/.test(text), text);
      await p.evaluate(() => { const r = document.querySelector('[data-testid="super-container"][data-kind="agenda"] [data-testid="super-agenda"]'); r.scrollTop = r.scrollHeight; });
      const last = card(p).locator('[data-testid="super-agenda-section-super"] [data-testid="super-agenda-row"]').last();
      await last.scrollIntoViewIfNeeded();
      await last.hover();
      await wait(p, 300);
      check(`[${name}] S4 after scrolling a row still answers the pointer (hover actions show)`, await last.locator('.agenda-hover').isVisible());
      await card(p).screenshot({ path: join(OUT, `${name}-3-hover.png`) });
    }
    if (size === 'wide') {
      await p.evaluate(() => { document.querySelector('[data-testid="super-container"][data-kind="agenda"] [data-testid="super-agenda"]').scrollTop = 0; });
      await card(p).locator('[data-testid="super-agenda-section-earlier"] .super-agenda-row-btn').first().click();
      await until(p, async () => (await card(p).getByTestId('super-agenda-detail-inline').count()) === 1, 4000);
      const d0 = await measure(p, '.agenda-col', '.agenda-head');
      await scrollEnd(p, '.agenda-col');
      await wait(p, 300);
      const d1 = await measure(p, '.agenda-col', '.agenda-head');
      console.log('    detail ' + JSON.stringify(d1));
      check(`[${name}] S5 with the detail open the left column scrolls head and list as one`, d0.scroll > d0.scH && d1.scrollTop > 0 && d1.headBottom <= d1.scTop, JSON.stringify({ d0, d1 }));
      await card(p).screenshot({ path: join(OUT, `${name}-4-detail.png`) });
    }
    if (size === 'large' || size === 'wide') await boardView(p, name);
    await fab(p, name, size);
    if (size === 'large' || size === 'small') await sideAndFull(p, name, size === 'small' ? 'button' : 'head');
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch();
try {
  for (const size of (arg('only', '') ? arg('only').split(',') : ['small', 'medium', 'large', 'wide'])) {
    seed(size);
    const srv = await server();
    try {
      for (const dark of [true, false]) {
        try { await scene(browser, size, dark); } catch (e) { check(`[${size}-${dark ? 'dark' : 'light'}] ran to the end`, false, String(e).slice(0, 300)); }
      }
    } finally { srv.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
  }
} finally {
  await browser.close();
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\nconsole errors: ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}`);
if (consoleErrors.length) failures.push('console errors');
console.log(`screenshots: ${OUT}`);
console.log(failures.length ? `FAIL: ${failures.join(', ')}` : 'PASS');
process.exit(failures.length ? 1 : 0);
