#!/usr/bin/env node
/**
 * THREE STAGE FIXES (owner 2026-10-22 12:19, on the installed 0.34.0) — derived from
 * super-card-size.mjs. Original header follows.
 *
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
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-stage-fixes-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-stage-fixes', process.env.SHOTS_TAG || 'now');
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
      cli('super', 'open', 'image', 'pics/release-diagram.png'),
    ];
    report({ kind: 'handover', steps });
    return 'arranged';
  }
  const m = text.match(/GO-CLI\\s+(.+)$/);
  if (m) {
    const steps = [cli(...m[1].trim().split(/\\s+/))];
    report({ kind: 'verb', steps });
    return 'did ' + m[1];
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
    try { said = role === 'super' ? superTurn(blocks.find((b) => /GO-CLI|\\[super handover\\]/.test(b)) ?? blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
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


/** A small project page: a heading, a picture inline, a long table (it scrolls). */
function smallPage() {
  const png = readFileSync(join(REPO, 'public', 'image', 'diagram-recall.png')).toString('base64');
  const rows = Array.from({ length: 40 }, (_, i) => `<tr><td>Row ${i + 1}</td><td>Pocket Ledger entry ${i + 1}</td></tr>`).join('');
  return `<!doctype html><html><body style="font-family:system-ui;margin:24px"><h1 id="top">Share sheet</h1>
<img alt="Share sheet" style="width:100%" src="data:image/png;base64,${png}"><table>${rows}</table><p id="bottom">End.</p></body></html>`;
}

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
  writeFileSync(join(PROJ, 'mockups', 'share-sheet.html'), smallPage());
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

const card = (page, id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
const rectOf = async (page, id) => card(page, id).evaluate((e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), size: e.dataset.size, side: e.dataset.side, where: e.dataset.where }; });
const shot = async (page, name) => { await page.waitForTimeout(900); await page.screenshot({ path: join(OUT, `${name}.png`) }); return join(OUT, `${name}.png`); };
/** The centre's midpoint against the stage's, in px (0 = the chat is in the middle). */
const centreOffset = (page) => page.evaluate(() => {
  const s = document.querySelector('[data-testid="super-surface"]').getBoundingClientRect();
  const c = document.querySelector('.super-centre').getBoundingClientRect();
  return { off: Math.round((c.x + c.width / 2) - (s.x + s.width / 2)), centreW: Math.round(c.width), stageW: Math.round(s.width) };
});
async function hoverCard(page, id) {
  const b = await card(page, id).boundingBox();
  if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(250);
}
async function clickIn(page, id, testId) {
  await hoverCard(page, id);
  const b = await card(page, id).locator(`[data-testid="${testId}"]`).first().boundingBox();
  if (!b) throw new Error(`no ${testId} in ${id}`);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(250);
}
async function pickSize(page, id, size) {
  const c = card(page, id);
  await clickIn(page, id, (await c.locator('[data-testid="super-card-more"]').count()) ? 'super-card-more' : 'super-card-size-btn');
  await page.locator(`[data-testid="super-size-${size}"]`).first().click();
  await settle(page);
}
async function agent(page, args) {
  const before = readNd(REPORTS).filter((r) => r.kind === 'verb').length;
  await sayToSuper(page, `GO-CLI ${args}`);
  await until(page, async () => readNd(REPORTS).filter((r) => r.kind === 'verb').length > before, 40000);
  const step = readNd(REPORTS).filter((r) => r.kind === 'verb').pop()?.steps?.[0];
  await settle(page);
  return step;
}
/** A zoomable view's scale inside a card (the in-place zoom), or null when there is none. */
const zoomScale = (page, id) => card(page, id).locator('[data-testid="super-zoom"]').first()
  .evaluate((e) => Number(e.dataset.scale)).catch(() => null);
const boxW = (page, id, sel) => card(page, id).locator(sel).first().evaluate((e) => Math.round(e.getBoundingClientRect().width)).catch(() => null);

/** A dev server on this computer (a fictional site), on a port the app does not own. */
async function startSite(port) {
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body style="font-family:system-ui;margin:32px"><h1>Pocket Ledger</h1><p>Shared ledgers, one tap.</p><button id="cta">Share</button></body></html>');
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return srv;
}

let server = null;
let site = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const sitePort = await freePort();
  server = await startServer(port);
  site = await startSite(sitePort);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── hand over');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super agent opened its cards', await until(page, async () => record().containers.length >= 2, 60000));
  await settle(page);
  await page.waitForTimeout(2000);
  const ids = { task: idOf('ship-the-share-sheet'), image: idOf('pics/release-diagram.png') };

  console.log('\n── 2) a card grows: the chat stays in the middle while there is room');
  for (const [w, h] of [[1440, 900], [1800, 1100]]) {
    await page.setViewportSize({ width: w, height: h });
    await settle(page);
    const c0 = await centreOffset(page);
    if ((await rectOf(page, ids.image)).size !== 'large') await pickSize(page, ids.image, 'large');
    await page.waitForTimeout(1200);
    const c1 = await centreOffset(page);
    const img = await rectOf(page, ids.image);
    console.log(`  · ${w}: before ${JSON.stringify(c0)} after ${JSON.stringify(c1)} image ${JSON.stringify(img)}`);
    ok(`${w}: the large card is drawn large (344×344)`, img.w === 344 && img.h === 344, JSON.stringify(img));
    ok(`${w}: the chat stays centred (midpoint off by ≤ 1 px)`, Math.abs(c1.off) <= 1, JSON.stringify(c1));
    ok(`${w}: …and keeps at least 560 px`, c1.centreW >= 560, JSON.stringify(c1));
    await shot(page, `2-centre-${w}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);

  console.log('\n── 1) a web page the agent opens shows side by side, never a small tile');
  const siteUrl = `http://127.0.0.1:${sitePort}/`;
  const s1 = await agent(page, `super open web ${siteUrl}`);
  ok('`super open web <dev server>` succeeded', s1 && s1.status === 0, JSON.stringify(s1));
  ids.site = record().containers.find((c) => c.kind === 'web' && c.ref.startsWith('http://127.0.0.1'))?.id;
  await page.waitForTimeout(1200);
  const site1 = await rectOf(page, ids.site);
  console.log(`  · site card ${JSON.stringify(site1)} view ${JSON.stringify(record().view)} record size ${record().containers.find((c) => c.id === ids.site)?.size}`);
  ok('the site opens side by side with the chat (half)', site1.where === 'half' && record().view?.mode === 'half' && record().view?.card === ids.site, JSON.stringify({ site1, view: record().view }));
  ok('…and its record is at least large (what the stage draws when it floats)', ['large', 'wide'].includes(record().containers.find((c) => c.id === ids.site)?.size), JSON.stringify(record().containers.find((c) => c.id === ids.site)));
  await shot(page, '1-site-opened');
  // Allow the page once: it is a page on this computer (the trust gate is unchanged).
  const once = card(page, ids.site).getByRole('button', { name: /Open once/ }).first();
  if (await once.count()) { await page.waitForTimeout(700); await once.click(); }
  ok('the site draws in its frame', await until(page, async () => (await card(page, ids.site).locator('iframe').count()) > 0, 10000));
  await shot(page, '1-site-shown');

  const s2 = await agent(page, 'super open web mockups/share-sheet.html');
  ok('`super open web <project page>` succeeded', s2 && s2.status === 0, JSON.stringify(s2));
  ids.html = idOf('mockups/share-sheet.html');
  console.log(`  · view after the second page: ${JSON.stringify(record().view)}`);
  // A card the owner typed just before waits out the typing hold (2 s) before it appears.
  await until(page, async () => (await rectOf(page, ids.html)).where === 'half', 6000);
  const html1 = await rectOf(page, ids.html);
  ok('the newest page the agent opened takes the side-by-side place', html1.where === 'half', JSON.stringify(html1));
  // Side by side shows one card; the rest wait in Others for the view (the record keeps them floating, large).
  const siteRec = record().containers.find((c) => c.id === ids.site);
  ok('…the site card keeps its place and its large size on the record', siteRec?.place === 'float' && siteRec?.size === 'large', JSON.stringify(siteRec));
  if (html1.where === 'half') { await clickIn(page, ids.html, 'super-card-minimize'); await settle(page); }
  const html2 = await rectOf(page, ids.html);
  ok('back on the stage the page card is large, not a tile', html2.where === 'float' && html2.size !== 'small', JSON.stringify(html2));
  await shot(page, '1-pages-on-stage');

  console.log('\n── the owner\'s size is his: small stays small when the agent opens it again');
  await pickSize(page, ids.html, html2.size === 'small' ? 'medium' : 'small');
  const s3 = await agent(page, 'super open web mockups/share-sheet.html');
  ok('re-opened by the agent', s3 && s3.status === 0, JSON.stringify(s3));
  const rec3 = record().containers.find((c) => c.id === ids.html);
  ok('…his size is kept', rec3?.sizeBy === 'owner' && (html2.size === 'small' ? rec3?.size === 'medium' : !rec3?.size), JSON.stringify(rec3));
  // Reset to the agent's hands for the zoom part.

  console.log('\n── 3) zoom in place: side by side');
  await agent(page, `super half ${ids.image}`);
  await page.waitForTimeout(1500);
  const imgSel = 'img';
  ok('the picture is side by side', (await rectOf(page, ids.image)).where === 'half');
  const zb = await card(page, ids.image).locator('.super-card-large-body').boundingBox();
  await page.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2);
  const w0 = await boxW(page, ids.image, imgSel);
  const z0 = await zoomScale(page, ids.image);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -60);
  await page.keyboard.up('Control');
  await page.waitForTimeout(400);
  const w1 = await boxW(page, ids.image, imgSel);
  const z1 = await zoomScale(page, ids.image);
  console.log(`  · picture ${w0}px → ${w1}px, zoom ${z0} → ${z1}`);
  ok('ctrl + wheel over the picture zooms it in place', z1 !== null && z1 > 1 && w1 > w0, `${w0}→${w1} scale ${z0}→${z1}`);
  await shot(page, '3-half-image-zoomed');
  const tf = () => card(page, ids.image).locator('[data-testid="super-zoom-content"]').first().evaluate((e) => e.style.transform).catch(() => null);
  const t0 = await tf();
  await page.mouse.down();
  await page.mouse.move(zb.x + zb.width / 2 + 120, zb.y + zb.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  ok('a drag pans the zoomed picture', t0 !== null && (await tf()) !== t0, `${t0} → ${await tf()}`);
  await page.mouse.dblclick(zb.x + zb.width / 2, zb.y + zb.height / 2);
  await page.waitForTimeout(300);
  ok('a double click fits it again', (await zoomScale(page, ids.image)) === 1, String(await zoomScale(page, ids.image)));
  await page.evaluate(() => { window.__boardGestures = 0; for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, () => { window.__boardGestures += 1; }, false); });
  await card(page, ids.image).locator('[data-testid="super-zoom"]').first().evaluate((el) => {
    const fire = (type, scale) => { const e = new Event(type, { bubbles: true, cancelable: true }); const r = el.getBoundingClientRect(); Object.assign(e, { scale, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }); el.dispatchEvent(e); };
    fire('gesturestart', 1); fire('gesturechange', 1.5); fire('gesturechange', 2); fire('gestureend', 2);
  }).catch(() => {});
  await page.waitForTimeout(300);
  const zg = await zoomScale(page, ids.image);
  ok('a trackpad pinch (WebKit gesture) over the picture zooms it ×2', zg !== null && Math.abs(zg - 2) < 0.05, String(zg));
  ok('…and no board behind hears it', (await page.evaluate(() => window.__boardGestures)) === 0);

  console.log('\n── 3) zoom in place: a presentation');
  await agent(page, `super present ${ids.image} ${ids.html}`);
  await page.waitForTimeout(2000);
  ok('two cards are presented', (await rectOf(page, ids.image)).where === 'present' && (await rectOf(page, ids.html)).where === 'present');
  await page.mouse.dblclick(zb.x + 5, zb.y + 5).catch(() => {});
  const pb = await card(page, ids.image).locator('.super-card-large-body').boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  const pz0 = await zoomScale(page, ids.image);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await page.waitForTimeout(400);
  const pz1 = await zoomScale(page, ids.image);
  ok('ctrl + wheel over the presented picture zooms it', pz1 !== null && pz1 > 1, `${pz0} → ${pz1}`);
  ok('the page frame is drawn in the presented card', await until(page, async () => (await card(page, ids.html).locator('iframe').count()) > 0, 15000));
  await page.waitForTimeout(1500);
  const hb = await card(page, ids.html).locator('iframe').first().boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + Math.min(hb.height / 2, 200));
  const hz0 = await zoomScale(page, ids.html);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
  const hz1 = await zoomScale(page, ids.html);
  ok('ctrl + wheel with the pointer INSIDE the project page zooms it', hz1 !== null && hz1 > 1, `${hz0} → ${hz1}`);
  await shot(page, '3-present-zoomed');
  await page.mouse.dblclick(hb.x + hb.width / 2, hb.y + 40);
  await page.waitForTimeout(400);
  ok('a double click inside the page fits it again', (await zoomScale(page, ids.html)) === 1, String(await zoomScale(page, ids.html)));

  console.log('\n── 3) a live page: the zoom bar, and Inspect for a pinch over it');
  await agent(page, `super half ${ids.site}`);
  await page.waitForTimeout(1500);
  const zin = card(page, ids.site).locator('[data-testid="super-zoom-in"]').first();
  ok('a live page offers a zoom bar', (await zin.count()) > 0);
  if (await zin.count()) {
    await hoverCard(page, ids.site);
    await zin.click();
    ok('＋ zooms the live page', ((await zoomScale(page, ids.site)) ?? 0) > 1, String(await zoomScale(page, ids.site)));
    await card(page, ids.site).locator('[data-testid="super-zoom-fit"]').first().click();
    ok('Fit returns to 100 %', (await zoomScale(page, ids.site)) === 1);
    await card(page, ids.site).locator('[data-testid="super-zoom-inspect"]').first().click();
    const sb = await card(page, ids.site).locator('[data-testid="super-zoom"]').first().boundingBox();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -250);
    await page.keyboard.up('Control');
    await page.waitForTimeout(400);
    ok('in Inspect, ctrl + wheel over the live page zooms it', ((await zoomScale(page, ids.site)) ?? 0) > 1, String(await zoomScale(page, ids.site)));
    await shot(page, '3-site-inspect-zoomed');
  }

  ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await context.close();
} catch (e) {
  fails.push(`crashed: ${e?.stack || e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
  if (site) site.close();
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${OUT}`);
process.exit(fails.length === 0 ? 0 : 1);
