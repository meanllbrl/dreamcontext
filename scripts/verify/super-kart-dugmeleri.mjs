#!/usr/bin/env node
/**
 * Super stage card buttons (owner 2026-11-07): the minimise glyph shows its word on hover, a chat
 * card's close menu ("This chat?") offers Minimise and closes when the card is minimised, the
 * Super head has no "+ Add" (Add a card is the ⋯ menu's first row), and a presentation rail's
 * mini tile has no hover toolbar: the whole tile is the button.
 *
 *   node scripts/verify/super-kart-dugmeleri.mjs --repo <checkout or install with dist> --out <dir> --tag before|after
 *
 * Real dashboard server, scratch HOME, a fictional project (acme), a scripted `claude` stand-in
 * (no tokens). Screenshots TAG-*.png into OUT; checks are enforced with --tag after. Exit 1 on a
 * failed check or a console error (after).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const REPO = resolve(arg('repo', '.'));
const OUT = resolve(arg('out', 'tmp/develop/kart-dugmeleri'));
const TAG = arg('tag', 'after');
const PORT = Number(arg('port', TAG === 'before' ? 45861 : 45862));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-kart-dugmeleri-${TAG}-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const ACME = join(SCRATCH, 'acme');
const after = TAG === 'after';
const report = { tag: TAG, checks: {}, failures: [], console: [] };
const check = (name, ok, detail) => {
  report.checks[name] = ok ? 'ok' : `FAIL ${detail ?? ''}`;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail ?? ''}`}`);
  if (!ok && after) report.failures.push(name);
};
mkdirSync(OUT, { recursive: true });
process.on('unhandledRejection', (e) => { console.log('  (ignored after close) ' + String(e).slice(0, 120)); });

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
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
const RECORD = join(ACME, '_dream_context', 'state', '.super-agent.json');
let baseRecord = null;

function seed() {
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
  const kids = { [randomUUID()]: 'Fix the checkout', [randomUUID()]: 'Write the pricing page', [randomUUID()]: 'Review the release' };
  const children = Object.fromEntries(Object.entries(kids).map(([k, brief]) => [k, { sessionId: k, brief, adopted: false, startedAt: Date.now() - 60000, row: 'working', rowAt: Date.now() }]));
  const sessions = Object.entries(kids).map(([k, title], i) => ({ title, kind: 'chat', sessionId: k, pane: i, active: true, window: 'main', size: 1 }));
  writeFileSync(join(ACME, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 0 }], generation: 1 }));
  baseRecord = {
    v: 1, session: randomUUID(), enabled: true,
    containers: Object.entries(kids).map(([k, title], i) => ({ id: `c${i}`, kind: 'chat', ref: k, shape: 'portrait', place: 'float', by: 'super', title })),
    groups: [], view: { mode: 'float' }, children, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [],
  };
  writeFileSync(RECORD, JSON.stringify(baseRecord));
  mkdirSync(join(ACME, 'tmp'), { recursive: true });
  for (const k of ['pa', 'pb']) writeFileSync(join(ACME, 'tmp', `${k}.png`), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
}

async function server() {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(PORT)], { cwd: ACME, env: { ...env(), PATH }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return srv; } catch { /* up soon */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('server did not come up');
}

const wait = (p, ms = 800) => p.waitForTimeout(ms);
const until = async (p, fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(p, 150); } return false; };
const shotPath = (name) => join(OUT, `${TAG}-${name}.png`);
async function dismiss(p) { const g = p.getByRole('button', { name: 'Got it' }); if (await g.isVisible().catch(() => false)) { await g.click(); await wait(p, 300); } }
/** A region around a box, kept inside the viewport. */
function around(box, vp, padX = 140, padY = 80, minW = 420, minH = 240) {
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  return { x, y, width: Math.min(vp.width - x, Math.max(minW, box.width + 2 * padX)), height: Math.min(vp.height - y, Math.max(minH, box.height + 2 * padY)) };
}

async function openStage(browser, { w, h, dark = false }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript((d) => { try { localStorage.setItem('theme', d ? 'dark' : 'light'); localStorage.setItem('dreamcontext-theme', d ? 'dark' : 'light'); } catch { /* */ } }, dark);
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) report.console.push(`${w}: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => report.console.push(`${w}: ${String(e).slice(0, 200)}`));
  // A Mac that is ready (no Claude sign-in in this HOME); a request still out when the page closes is dropped.
  await p.route('**/api/onboarding/readiness**', async (r) => { try { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); } catch { /* page closed */ } });
  await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
  await wait(p, 2200);
  await dismiss(p);
  await p.keyboard.press('Escape');
  await until(p, async () => (await p.locator('[data-testid="super-centre"]:visible').count()) > 0, 20000);
  await wait(p, 1200);
  return { ctx, p };
}

const card = (p, id) => p.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
const whereOf = (p, id) => card(p, id).getAttribute('data-where').catch(() => null);
const choices = (p) => p.locator('[data-testid="super-close-choice"]').count();

/** Scene 1: the head, the ⋯ menu with Add a card, and the add menu it opens. */
async function sceneHead(browser, w, h, dark) {
  const tag = `${w}-${dark ? 'dark' : 'light'}`;
  console.log(`\n── the head at ${tag}`);
  const { ctx, p } = await openStage(browser, { w, h, dark });
  const centre = p.locator('[data-testid="super-centre"]').first();
  const head = centre.locator('.super-centre-head');
  await head.screenshot({ path: shotPath(`1-head-${tag}`) });
  check(`[${tag}] the head has no + Add`, (await p.locator('[data-testid="super-add-btn"]').count()) === 0);
  const more = centre.getByTestId('super-head-more');
  check(`[${tag}] the head has its ⋯`, (await more.count()) === 1, String(await more.count()));
  if (await more.count()) {
    await more.click();
    await wait(p, 300);
    const rows = await p.locator('[data-testid="super-head-menu"] [role="menuitem"]').allTextContents();
    check(`[${tag}] the ⋯ menu opens on Add a card`, /Add a card/.test(rows[0] ?? ''), JSON.stringify(rows));
    const hb = await head.boundingBox();
    const vp = p.viewportSize();
    await p.screenshot({ path: shotPath(`2-more-menu-${tag}`), clip: { x: Math.max(0, hb.x + hb.width - 420), y: Math.max(0, hb.y - 8), width: Math.min(420, vp.width), height: 200 } });
    check(`[${tag}] the ⋯ menu has its Add a card row`, (await p.getByTestId('super-head-add').count()) === 1);
    if (await p.getByTestId('super-head-add').count()) {
      await p.getByTestId('super-head-add').click();
      const menu = p.locator('[data-testid="super-add-menu"]');
      check(`[${tag}] Add a card opens the add menu with its six kinds`, await until(p, async () => (await menu.locator('.wb-palette-item').count()) === 6, 3000));
      const mb = await menu.boundingBox();
      if (mb) check(`[${tag}] the add menu sits inside the window`, mb.x >= 0 && mb.x + mb.width <= vp.width + 0.5 && mb.y + mb.height <= vp.height + 0.5, JSON.stringify(mb));
      await p.screenshot({ path: shotPath(`3-add-menu-${tag}`), clip: { x: Math.max(0, hb.x + hb.width - 420), y: Math.max(0, hb.y - 8), width: Math.min(420, vp.width), height: Math.min(460, vp.height - Math.max(0, hb.y - 8)) } });
      await p.keyboard.press('Escape');
      check(`[${tag}] Escape closes it, focus back on ⋯`, await until(p, async () => (await menu.count()) === 0 && (await p.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'super-head-more', 3000));
    }
  }
  await ctx.close();
}

/** Scene 2: a chat card side by side: the minimise caption, the X menu, minimise with it open. */
async function sceneCard(browser) {
  console.log('\n── the card head at 1440');
  const { ctx, p } = await openStage(browser, { w: 1440, h: 900 });
  const vp = p.viewportSize();
  const toHalf = async () => {
    const b = await card(p, 'c0').boundingBox();
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    return until(p, async () => (await whereOf(p, 'c0')) === 'half', 6000);
  };
  check('the card opens side by side', await toHalf());
  await wait(p, 900);
  const min = card(p, 'c0').getByTestId('super-card-minimize');
  const rest = await min.boundingBox();
  await min.hover();
  await wait(p, 400);
  const hover = await min.boundingBox();
  // Since 2026-11-08 minimise is the yellow light: hovered, it shows its glyph and no word slides out.
  const caption = await min.evaluate((el) => !!el.querySelector('.super-icon-btn-caption'));
  report.caption = { rest, hover, caption };
  check('hovered, the yellow light keeps its size and no word slides out', !caption && Math.abs(hover.width - rest.width) < 1, JSON.stringify(report.caption));
  const actions = await card(p, 'c0').locator('.super-card-actions').boundingBox();
  await p.screenshot({ path: shotPath('4-minimise-hover-1440'), clip: around(actions, vp) });
  await p.mouse.move(5, vp.height - 5);
  await wait(p, 300);
  await p.screenshot({ path: shotPath('4b-minimise-rest-1440'), clip: around(actions, vp) });

  await card(p, 'c0').getByTestId('super-card-close').click();
  check('X opens This chat?', await until(p, async () => (await choices(p)) === 1, 3000));
  const rows = await p.locator('[data-testid="super-close-choice"] button').allTextContents();
  report.closeRows = rows;
  check('the X menu offers Minimize', rows.some((r) => /Minimi/.test(r)), JSON.stringify(rows));
  const cb = await p.locator('[data-testid="super-close-choice"]').boundingBox();
  await p.screenshot({ path: shotPath('5-x-menu-1440'), clip: around({ x: cb.x, y: cb.y - 40, width: cb.width, height: cb.height + 40 }, vp) });

  // The owner's path: the menu open, the head's minimise pressed.
  await card(p, 'c0').getByTestId('super-card-minimize').click({ force: true });
  const floated = await until(p, async () => (await whereOf(p, 'c0')) === 'float', 6000);
  await wait(p, 900);
  const left = await choices(p);
  check('minimised with the menu open, the card floats and the menu is gone', floated && left === 0, `floated=${floated} menus=${left}`);
  await p.screenshot({ path: shotPath('6-after-minimise-1440') });

  if (after) {
    check('side by side again', await toHalf());
    await wait(p, 700);
    await card(p, 'c0').getByTestId('super-card-close').click();
    await until(p, async () => (await choices(p)) === 1, 3000);
    await p.getByTestId('super-close-minimize').click();
    check('Minimize from the X menu floats the card and closes the menu', await until(p, async () => (await whereOf(p, 'c0')) === 'float' && (await choices(p)) === 0, 6000));
  }
  await ctx.close();
}

/** Scene 3: a tight presentation's rail of mini tiles: no toolbar on hover, a click opens it. */
async function sceneMini(browser, w, h) {
  console.log(`\n── the presentation rail at ${w}`);
  const rec = JSON.parse(JSON.stringify(baseRecord));
  for (const c of Object.values(rec.children)) { c.row = 'working'; c.rowAt = Date.now(); }
  // An open question per job keeps it live (a row alone is settled by the server: no process runs).
  rec.queue = Object.keys(rec.children).map((sid, i) => ({ id: `q${i}`, sessionId: sid, kind: 'question', state: 'pending', createdAt: Date.now(), text: 'Which plan?' }));
  rec.containers = [...rec.containers, ...['pa', 'pb'].map((k) => ({ id: k, kind: 'image', ref: `tmp/${k}.png`, shape: 'landscape', place: 'float', by: 'super', title: `Picture ${k}` }))];
  rec.view = { mode: 'present', cards: ['pa', 'pb'], layout: 'filmstrip', layoutBy: 'owner' };
  writeFileSync(RECORD, JSON.stringify(rec));
  const { ctx, p } = await openStage(browser, { w, h });
  const vp = p.viewportSize();
  const minis = p.locator('[data-testid="super-container"][data-mini="true"]');
  const n = await minis.count();
  const st = await p.evaluate(async () => { try { return await (await fetch('/api/super/state?vault=acme')).json(); } catch (e) { return String(e); } });
  const s = st && (st.state ?? st);
  const diag = {
    view: s?.view, rows: s?.children ? Object.values(s.children).map((c) => c.row) : null, queue: s?.queue?.length,
    cards: await p.locator('[data-testid="super-container"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-container-id')}:${e.getAttribute('data-where')}:${e.getAttribute('data-mini')}`)),
    stage: await p.locator('[data-testid="super-centre"]').first().evaluate((e) => e.closest('[class*="super-stage"]')?.getBoundingClientRect().width ?? null).catch(() => null),
  };
  console.log(`  diag ${JSON.stringify(diag).slice(0, 900)}`);
  report.mini = { w, count: n, diag };
  check(`[${w}] the rail draws mini tiles`, n > 0, String(n));
  if (n > 0) {
    const tile = minis.first();
    const id = await tile.getAttribute('data-container-id');
    await tile.hover();
    await wait(p, 400);
    const bar = tile.locator('.super-card-actions');
    const shown = (await bar.count()) > 0 && await bar.evaluate((el) => getComputedStyle(el).opacity !== '0' && el.getBoundingClientRect().width > 0).catch(() => false);
    check(`[${w}] hovered, a mini tile shows no toolbar and no X`, !shown && (await tile.getByTestId('super-card-close').count()) === 0);
    const tb = await tile.boundingBox();
    await p.screenshot({ path: shotPath(`7-mini-hover-${w}`), clip: around(tb, vp, 60, 160, 360, 420) });
    await tile.click();
    const opened = await until(p, async () => (await card(p, id).getAttribute('data-mini').catch(() => null)) !== 'true', 6000);
    report.mini.after = await whereOf(p, id);
    check(`[${w}] a click on the tile opens the card`, opened, String(report.mini.after));
    await wait(p, 900);
    await p.screenshot({ path: shotPath(`8-mini-opened-${w}`) });
  }
  await ctx.close();
  writeFileSync(RECORD, JSON.stringify(baseRecord));
}

seed();
const srv = await server();
const browser = await chromium.launch();
try {
  const miniOnly = process.argv.includes('--mini-only');
  if (!miniOnly) for (const [w, h, dark] of [[1440, 900, false], [1440, 900, true], [390, 844, false]]) {
    try { await sceneHead(browser, w, h, dark); } catch (e) { check(`scene head ${w} ran to the end`, false, String(e).slice(0, 300)); }
  }
  if (!miniOnly) try { await sceneCard(browser); } catch (e) { check('scene card ran to the end', false, String(e).slice(0, 300)); }
  for (const [w, h] of [[1440, 900], [1024, 768]]) {
    try { await sceneMini(browser, w, h); } catch (e) { check(`scene mini ${w} ran to the end`, false, String(e).slice(0, 300)); }
  }
} finally {
  await browser.close();
  srv.kill();
  spawnSync('pkill', ['-f', SCRATCH]);
}
writeFileSync(join(OUT, `${TAG}-report.json`), JSON.stringify(report, null, 2));
console.log(`\nconsole errors: ${report.console.length ? report.console.join('\n') : 'none'}`);
console.log(`failures: ${report.failures.length ? report.failures.join(', ') : 'none'}`);
console.log(`screenshots: ${OUT}`);
if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
process.exitCode = 0;
process.exit(report.failures.length || (after && report.console.length) ? 1 : 0);
