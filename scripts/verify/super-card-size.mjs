#!/usr/bin/env node
/**
 * Card sizes and full screen on the Super stage (task super-sahnesindeki-kartlar-apple-widget-lari-
 * gibi-4-hazir-boya-ayarlanir…, owner 2026-10-22: "size the cards like Apple widgets; let me open
 * HTML and pictures full screen and zoom").
 *
 *   npm run build && node scripts/verify/super-card-size.mjs
 *
 * WHAT IT DRIVES — the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium, and a scripted stand-in `claude` that, as the Super Agent, opens a task,
 * a picture (large), a ~596 KB web page with its picture inline as base64, and a whiteboard, and
 * runs `super shape` when told to (no tokens spent). Everything is fictional ("Pocket Ledger").
 *
 * WHAT IT PROVES — the four sizes are drawn at their sizes (a large card is 344×344 at a 1440
 * window), the size menu and the corner handle set them and the owner's choice survives a reload
 * and beats the agent (409); a card the owner placed keeps its inner corner when it grows; the big
 * local page shows; the picture and the page open full screen fitted, zoom by + and ctrl+wheel,
 * scroll by the wheel, pan by dragging; a pinch over a viewer with a whiteboard mounted zooms the
 * viewer and never reaches the board. Screenshots: tmp/super-card-size/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-card-size-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-card-size');
const REPORTS = join(SCRATCH, 'reports.ndjson');

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-super-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [
      cli('super', 'open', 'task', 'ship-the-share-sheet'),
      cli('super', 'open', 'image', 'pics/release-diagram.png', '--size', 'large'),
      cli('super', 'open', 'web', 'mockups/share-sheet-before-after.html'),
      cli('super', 'open', 'whiteboard', 'share-flow'),
    ];
    report({ kind: 'handover', steps });
    return 'arranged';
  }
  const m = text.match(/GO-SHAPE\\s+(\\S+)\\s+(\\S+)/);
  if (m) {
    const steps = [cli('super', 'shape', m[1], m[2])];
    report({ kind: 'verb-shape', steps });
    return 'did shape';
  }
  return 'ok';
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
    if (role === 'super') report({ kind: 'turn', text: blocks.join(' | ').slice(0, 400) });
    try { said = role === 'super' ? superTurn(blocks.find((b) => /GO-SHAPE|\\[super handover\\]/.test(b)) ?? blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    running = false;
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});


/** A ~596 KB web page: a before/after mockup with its picture inline as base64 (the owner's case). */
function bigPage() {
  const png = readFileSync(join(REPO, 'public', 'image', 'diagram-recall.png')).toString('base64');
  const img = `<img alt="Share sheet" style="width:100%;border-radius:12px" src="data:image/png;base64,${png}">`;
  const rows = Array.from({ length: 60 }, (_, i) => `<tr><td>Row ${i + 1}</td><td>Pocket Ledger entry ${i + 1}</td><td>${(i * 13.7).toFixed(2)}</td></tr>`).join('');
  let html = `<!doctype html><html><body style="font-family:system-ui;margin:24px">
<h1 id="top">Share sheet — before and after</h1>
<div role="tablist"><button id="tab-before" onclick="document.getElementById('which').textContent='Before'">Before</button>
<button id="tab-after" onclick="document.getElementById('which').textContent='After'">After</button> <b id="which">Before</b></div>
${img}<table>${rows}</table>${img}<p id="bottom">The end of the mockup.</p>`;
  // Pad with the picture again until the file is the owner's size (~596 KB), past the old 512 KB cap.
  while (html.length < 596 * 1024) html += `<!-- ${'x'.repeat(4096)} -->`;
  return `${html}</body></html>`;
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'pics'), join(PROJ, 'mockups'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const must = (what, r) => { if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`); };
  must('vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' }));
  must('task', dc('tasks', 'create', 'Ship the share sheet', '-w', 'Sharing a ledger takes four taps today.'));
  must('criteria', dc('tasks', 'insert', 'ship-the-share-sheet', 'acceptance_criteria', '--', '- [x] One tap opens the sheet\n- [ ] The sheet lists recent contacts\n- [ ] A shared ledger opens read-only'));
  copyFileSync(join(REPO, 'public', 'image', 'diagram-recall.png'), join(PROJ, 'pics', 'release-diagram.png'));
  writeFileSync(join(PROJ, 'mockups', 'share-sheet-before-after.html'), bigPage());
  must('whiteboard', dc('whiteboard', 'create', 'share-flow'));
  must('whiteboard note', dc('whiteboard', 'add', 'share-flow', 'note', '--text', 'Tap Share, pick a contact, done.'));
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [] }; } };
const idOf = (ref) => record().containers.find((c) => c.ref === ref)?.id;

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(900));

async function openChat(page, base) {
  await page.goto(`${base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}

const superComposer = (page) => page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
async function sayToSuper(page, text) {
  const input = superComposer(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

async function shoot1440(page) {
  await shot(page, '1-sizes-1440');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, '2-sizes-1440-light');
  await page.emulateMedia({ colorScheme: 'dark' });
}

const card = (page, id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
const rectOf = async (page, id) => card(page, id).evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: Math.round(b.width), h: Math.round(b.height), size: e.dataset.size, side: e.dataset.side }; });
const stageWidth = (page) => page.locator('[data-testid="super-surface"]').first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
const shot = async (page, name) => { await page.waitForTimeout(900); await page.screenshot({ path: join(OUT, `${name}.png`) }); return join(OUT, `${name}.png`); };

/** Point at a card (its middle), the way a hand reveals its buttons. */
async function hoverCard(page, id) {
  const b = await card(page, id).boundingBox();
  if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(250);
}

/** Click a control inside a card by its box (the card's buttons fade in on hover). */
async function clickIn(page, id, testId) {
  await hoverCard(page, id);
  const b = await card(page, id).locator(`[data-testid="${testId}"]`).first().boundingBox();
  if (!b) throw new Error(`no ${testId} in ${id}`);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(250);
}

/** Pick a size from a card's menu (the "more" menu on a small tile, the size button otherwise). */
async function pickSize(page, id, size) {
  const c = card(page, id);
  await clickIn(page, id, (await c.locator('[data-testid="super-card-more"]').count()) ? 'super-card-more' : 'super-card-size-btn');
  await page.locator(`[data-testid="super-size-${size}"]`).first().click();
  await settle(page);
}

let server = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── hand over: the cards arrive');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super agent opened the four cards', await until(page, async () => record().containers.length >= 5, 60000),
    JSON.stringify(readNd(REPORTS).find((r) => r.kind === 'handover')?.steps));
  await settle(page);
  await page.waitForTimeout(2500);
  const ids = { task: idOf('ship-the-share-sheet'), image: idOf('pics/release-diagram.png'), page: idOf('mockups/share-sheet-before-after.html'), board: idOf('share-flow') };
  console.log(`  · stage ${await stageWidth(page)} px wide at a 1440 window; ids ${JSON.stringify(ids)}`);
  ok('`super open --size large` recorded the picture\'s size', record().containers.find((c) => c.id === ids.image)?.size === 'large');
  const img0 = await rectOf(page, ids.image);
  ok('at a 1440 window the large picture card is drawn 344×344', img0.w === 344 && img0.h === 344 && img0.size === 'large', JSON.stringify(img0));

  console.log('\n── full screen from a small card\'s ⋯ menu gives focus back to ⋯');
  await clickIn(page, ids.board, 'super-card-more');
  await page.locator('[data-testid="super-card-size"] [data-testid="super-card-fullscreen"]').first().click();
  ok('the board opens full screen from the ⋯ menu', await until(page, async () => (await page.locator('.fullscreen-overlay').count()) > 0, 8000));
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await until(page, async () => (await page.locator('.fullscreen-overlay').count()) === 0, 4000);
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
  ok('…and on close focus is back on the card\'s ⋯ button', focused === 'super-card-more', focused);
  ok('…and the stage is still open', (await page.locator('[data-testid="super-surface"]:visible').count()) > 0);

  console.log('\n── the size menu: the task to medium');
  await pickSize(page, ids.task, 'medium');
  const task1 = await rectOf(page, ids.task);
  ok('the task card is drawn medium, 344×160', task1.w === 344 && task1.h === 160, JSON.stringify(task1));
  const rec1 = record().containers.find((c) => c.id === ids.task);
  ok('the record keeps the owner\'s size and his mark', rec1?.size === 'medium' && rec1?.sizeBy === 'owner', JSON.stringify(rec1));
  ok('a medium task tile lists its next two criteria', (await card(page, ids.task).locator('[data-testid="super-tile-next"]').count()) === 2);

  console.log('\n── the corner handle: Esc mid-drag cancels, the stage stays');
  const pgA = await rectOf(page, ids.page);
  await hoverCard(page, ids.page);
  const hA = await card(page, ids.page).locator('[data-testid="super-card-resize"]').boundingBox();
  if (hA) {
    const sx = hA.x + hA.width / 2;
    const sy = hA.y + hA.height / 2;
    const dir = pgA.side === 'left' ? -1 : 1;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(sx + dir * 15 * i, sy + 15 * i); await page.waitForTimeout(16); }
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  await page.waitForTimeout(600);
  ok('Esc during a resize leaves the stage open', (await page.locator('[data-testid="super-surface"]:visible').count()) > 0);
  ok('…writes no size and leaves no outline', !record().containers.find((c) => c.id === ids.page)?.size && (await page.locator('[data-testid="super-resize-outline"]').count()) === 0);

  console.log('\n── the corner handle: the page to large');
  const pg0 = await rectOf(page, ids.page);
  const handle = card(page, ids.page).locator('[data-testid="super-card-resize"]');
  await hoverCard(page, ids.page);
  const hb = await handle.boundingBox();
  if (hb) {
    const sx = hb.x + hb.width / 2;
    const sy = hb.y + hb.height / 2;
    const dir = pg0.side === 'left' ? -1 : 1;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(sx + dir * 15 * i, sy + 15 * i); await page.waitForTimeout(16); }
    ok('a dashed outline shows the size the drag would land on', (await page.locator('[data-testid="super-resize-outline"]').count()) === 1);
    await page.mouse.up();
  } else ok('the corner handle is there', false);
  await settle(page);
  const pg1 = await rectOf(page, ids.page);
  ok('the handle grew the page card to large (344×344)', pg1.w === 344 && pg1.h === 344 && record().containers.find((c) => c.id === ids.page)?.size === 'large', JSON.stringify(pg1));

  console.log('\n── the big local page (596 KB, base64 picture) shows');
  const loaded = await until(page, async () => (await card(page, ids.page).locator('iframe').count()) > 0, 20000);
  ok('the page card draws the page in a frame', loaded);
  ok('…and never says it could not be read', !/could not be read/i.test(await card(page, ids.page).innerText()), await card(page, ids.page).innerText());
  await shoot1440(page);

  console.log('\n── the owner\'s size beats the agent');
  const before = readNd(REPORTS).filter((r) => r.kind === 'verb-shape').length;
  await sayToSuper(page, `GO-SHAPE ${ids.task} wide`);
  await until(page, async () => readNd(REPORTS).filter((r) => r.kind === 'verb-shape').length > before, 40000);
  const shape = readNd(REPORTS).filter((r) => r.kind === 'verb-shape').pop()?.steps?.[0];
  ok('`super shape` on a card he sized is refused owner_sized', shape && shape.status !== 0 && /owner_sized|owner chose/i.test(shape.out), JSON.stringify(shape ?? readNd(REPORTS).filter((r) => r.kind === 'turn').slice(-3)));
  ok('…and his size stands', record().containers.find((c) => c.id === ids.task)?.size === 'medium');

  console.log('\n── a card he placed keeps its inner corner when it grows');
  // Room on the left column first: the picture to medium (a card he drops wins over auto ones).
  await pickSize(page, ids.image, 'medium');
  const b0 = await rectOf(page, ids.board);
  const bc = card(page, ids.board);
  const bb = await bc.boundingBox();
  // Grab the tile's middle (its top carries the action buttons on hover) and move it up a little.
  const gx = bb.x + bb.width / 2;
  const gy = bb.y + bb.height / 2 + 20;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) { await page.mouse.move(gx, gy - (60 * i) / 14); await page.waitForTimeout(16); }
  await page.mouse.up();
  await settle(page);
  const samples = [];
  for (let i = 0; i < 6; i++) { samples.push(await rectOf(page, ids.board)); await page.waitForTimeout(400); }
  console.log(`  · board after the drop: ${samples.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${r.w}x${r.h}`).join(' | ')}`);
  console.log(`  · motion: ${await page.locator('[data-super-motion]').evaluateAll((els) => els.map((e) => e.getAttribute('data-super-motion')).join(','))}`);
  await shot(page, 'debug-after-drop');
  const placed = await rectOf(page, ids.board);
  ok('the whiteboard was dropped by the owner (it has a pos)', !!record().containers.find((c) => c.id === ids.board)?.pos, JSON.stringify(placed));
  // The left column is full (a chat, the large picture, the board): Large cannot be drawn there
  // now, and the menu says so instead of drawing it smaller.
  await clickIn(page, ids.board, 'super-card-more');
  // Wide here would leave the chat under its floor: offered disabled, saying why.
  const wideOpt = page.locator('[data-testid="super-size-wide"]').first();
  ok('a size the stage has no room for is offered disabled, saying why', (await wideOpt.isDisabled()) && /wider window/i.test((await wideOpt.getAttribute('title')) ?? ''), await wideOpt.getAttribute('title'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('Esc closed only the menu: the stage is still there', (await page.locator('[data-testid="super-surface"]:visible').count()) > 0 && (await page.locator('[data-testid="super-card-size"]').count()) === 0);
  // The picture went medium before the drop: the board grows to large.
  const placedNow = await rectOf(page, ids.board);
  await pickSize(page, ids.board, 'large');
  await page.waitForTimeout(1500);
  const grown = await rectOf(page, ids.board);
  const inner = (r) => (r.side === 'left' ? r.x + r.w : r.x);
  ok('grown to large, its inner top corner did not move', grown.w === 344 && Math.abs(inner(grown) - inner(placedNow)) <= 1 && Math.abs(grown.y - placedNow.y) <= 4, `${JSON.stringify(placedNow)} → ${JSON.stringify(grown)} (dropped ${JSON.stringify(placed)}, start ${JSON.stringify(b0)})`);

  console.log('\n── a reload keeps every size');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openChat(page, base);
  await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000);
  await settle(page);
  await page.waitForTimeout(2500);
  const after = { task: await rectOf(page, ids.task), image: await rectOf(page, ids.image), page: await rectOf(page, ids.page), board: await rectOf(page, ids.board) };
  ok('after a reload: medium, medium, large, large', after.task.size === 'medium' && after.image.size === 'medium' && after.page.size === 'large' && after.board.size === 'large', JSON.stringify(after));

  console.log('\n── the picture full screen');
  await clickIn(page, ids.image, 'super-card-fullscreen');
  ok('the picture viewer opens', await until(page, async () => (await page.locator('.image-viewer:not(.frame-viewer)').count()) === 1, 5000));
  await page.waitForTimeout(800);
  const level = () => page.locator('.image-viewer:not(.frame-viewer) .image-viewer-level').innerText();
  const fitted = await level();
  await shot(page, '3-image-fit');
  await page.keyboard.press('+');
  await page.waitForTimeout(300);
  ok('+ zooms the picture', (await level()) !== fitted, `${fitted} → ${await level()}`);
  const st = await page.locator('.image-viewer-stage').boundingBox();
  await page.mouse.move(st.x + st.width / 2, st.y + st.height / 2);
  const l1 = await level();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  ok('ctrl + wheel zooms the picture', parseInt(await level(), 10) > parseInt(l1, 10), `${l1} → ${await level()}`);
  const tf = () => page.locator('.image-viewer-img').evaluate((e) => e.style.transform);
  const t0 = await tf();
  await page.mouse.down();
  await page.mouse.move(st.x + st.width / 2 + 120, st.y + st.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  ok('a drag pans the zoomed picture', (await tf()) !== t0, `${t0} → ${await tf()}`);
  await shot(page, '4-image-zoomed');

  console.log('\n── a pinch over the viewer with a whiteboard mounted');
  ok('the whiteboard card draws its board (an editor is mounted)', await until(page, async () => (await card(page, ids.board).locator('.excalidraw-canvas-wrap, canvas').count()) > 0, 15000));
  await page.evaluate(() => {
    window.__boardGestures = 0;
    // Where every Excalidraw editor's own Safari handler sits: the document, bubble phase.
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, () => { window.__boardGestures += 1; }, false);
  });
  const l2 = await level();
  await page.evaluate(() => {
    const stage = document.querySelector('.image-viewer-stage');
    const fire = (type, scale) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { scale, clientX: 400, clientY: 300 }); stage.dispatchEvent(e); };
    fire('gesturestart', 1); fire('gesturechange', 0.6); fire('gestureend', 0.6);
  });
  await page.waitForTimeout(300);
  ok('the pinch zooms the viewer', (await level()) !== l2, `${l2} → ${await level()}`);
  ok('…and never reaches the editors\' document handlers (the board behind does not zoom)', (await page.evaluate(() => window.__boardGestures)) === 0);
  // A real pinch is many frames, from wherever the view already is (the app re-renders between).
  const pct = async () => parseInt(await level(), 10);
  const L0 = await pct();
  const fireAt = (sel, type, scale) => page.evaluate(([sel, type, scale]) => {
    const el = document.querySelector(sel);
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { scale, clientX: 500, clientY: 300 });
    el.dispatchEvent(e);
  }, [sel, type, scale]);
  await fireAt('.image-viewer-stage', 'gesturestart', 1);
  for (const k of [0.95, 0.9, 0.85, 0.8]) { await fireAt('.image-viewer-stage', 'gesturechange', k); await page.waitForTimeout(80); }
  await fireAt('.image-viewer-stage', 'gestureend', 0.8);
  await page.waitForTimeout(200);
  const L1 = await pct();
  ok('a many-frame pinch from a zoomed view lands at start × scale (it never snaps back toward fit)', Math.abs(L1 - L0 * 0.8) <= Math.max(3, L0 * 0.05), `${L0}% → ${L1}% (want ≈ ${Math.round(L0 * 0.8)}%)`);
  const spyBefore = await page.evaluate(() => window.__boardGestures);
  await fireAt('.image-viewer-bar', 'gesturestart', 1);
  await fireAt('.image-viewer-bar', 'gesturechange', 2);
  await fireAt('.image-viewer-bar', 'gestureend', 2);
  await page.waitForTimeout(200);
  ok('a pinch over the viewer\'s bar reaches no board either', (await page.evaluate(() => window.__boardGestures)) === spyBefore);
  await page.keyboard.press('Escape');
  ok('Esc closes the viewer', await until(page, async () => (await page.locator('.image-viewer').count()) === 0, 3000));

  console.log('\n── the page full screen');
  await clickIn(page, ids.page, 'super-card-fullscreen');
  ok('the page viewer opens', await until(page, async () => (await page.locator('[data-testid="frame-viewer"]').count()) === 1, 5000));
  ok('…and draws the page', await until(page, async () => (await page.locator('[data-testid="frame-viewer"] iframe').count()) === 1, 10000));
  await page.waitForTimeout(1500);
  const scale = () => page.locator('.frame-viewer-stage').evaluate((e) => Number(e.dataset.scale));
  const ptf = () => page.locator('.frame-viewer-page').evaluate((e) => e.style.transform);
  ok('it opens fitted (100 %)', (await scale()) === 1, String(await scale()));
  await shot(page, '5-page-fit');
  const fs = await page.locator('.frame-viewer-stage').boundingBox();
  await page.mouse.move(fs.x + fs.width / 2, fs.y + fs.height / 2);
  const y0 = await ptf();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  ok('a plain wheel scrolls the page down', (await ptf()) !== y0 && (await scale()) === 1, `${y0} → ${await ptf()}`);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -40);
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  ok('ctrl + wheel zooms the page', (await scale()) > 1 && (await scale()) < 4, String(await scale()));
  const s1 = await scale();
  await page.locator('[data-testid="frame-viewer-zoom-in"]').click();
  ok('＋ zooms further', (await scale()) > s1, `${s1} → ${await scale()}`);
  const p1 = await ptf();
  await page.mouse.move(fs.x + fs.width / 2, fs.y + fs.height / 2);
  await page.mouse.down();
  await page.mouse.move(fs.x + fs.width / 2 - 150, fs.y + fs.height / 2 - 80, { steps: 6 });
  await page.mouse.up();
  ok('a drag pans the page', (await ptf()) !== p1, `${p1} → ${await ptf()}`);
  await shot(page, '6-page-zoomed');
  const l3 = await scale();
  await page.evaluate(() => {
    const stage = document.querySelector('.frame-viewer-shield');
    const fire = (type, s) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { scale: s, clientX: 500, clientY: 300 }); stage.dispatchEvent(e); };
    fire('gesturestart', 1); fire('gesturechange', 0.7); fire('gestureend', 0.7);
  });
  await page.waitForTimeout(300);
  ok('a pinch over the page viewer zooms it, and no board hears it', (await scale()) < l3 && (await page.evaluate(() => window.__boardGestures)) === 0, `${l3} → ${await scale()}`);
  await page.locator('[data-testid="frame-viewer-fit"]').click();
  ok('Fit returns to 100 %', (await scale()) === 1);
  await page.locator('[data-testid="frame-viewer-mode"]').click();
  ok('Click lifts the shield so the page takes clicks', (await page.locator('[data-testid="frame-viewer-shield"]').count()) === 0);
  await page.frameLocator('[data-testid="frame-viewer"] iframe').locator('#tab-after').click();
  ok('…a tab inside the page works', /After/.test(await page.frameLocator('[data-testid="frame-viewer"] iframe').locator('#which').innerText()));
  await page.keyboard.press('Escape');
  ok('Esc closes the page viewer', await until(page, async () => (await page.locator('[data-testid="frame-viewer"]').count()) === 0, 3000));

  console.log('\n── wider: every size, and a phone width');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await settle(page);
  await pickSize(page, ids.page, 'wide');
  await page.waitForTimeout(1500);
  const wide = await rectOf(page, ids.page);
  console.log(`  · stage ${await stageWidth(page)} px wide at a 1920 window; page card ${JSON.stringify(wide)}`);
  ok('at 1920 the page card is drawn wide (528×344)', wide.w === 528 && wide.h === 344, JSON.stringify(wide));
  await shot(page, '7-sizes-1920');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok('at a phone width nothing overflows sideways', !overflow);
  await shot(page, '8-phone-390');

  ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await context.close();
} catch (e) {
  fails.push(`crashed: ${e?.stack || e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${OUT}`);
process.exit(fails.length === 0 ? 0 : 1);
