#!/usr/bin/env node
/**
 * THE SUPER STAGE IN A WINDOW (owner 2026-10-28, a ~1140x710 window, task super-sahnesi-pencere-
 * boyutunda-dogru-yerlesir…). Harness derived from super-web-device.mjs.
 *
 *   npm run build && node scripts/verify/super-stage-fit.mjs
 *   ENGINE=webkit TAG=after OUT=<dir> node scripts/verify/super-stage-fit.mjs
 *   DC_BUILD=<a checkout built before the change> TAG=before node scripts/verify/super-stage-fit.mjs
 *
 * WHAT IT DRIVES: the real dashboard on a scratch HOME, Chromium or WebKit, a stand-in `claude`
 * that opens two tasks, two pictures and a whiteboard on hand-over and a fictional dev server's
 * page when told to. The owner's moves go through the window's own route (POST /api/super/layout):
 * the agenda sized medium, two cards dropped on nearly one spot, one card put in Others.
 *
 * WHAT IT PROVES, at 1140x710, 1440x900 and 1920x1080: (1) the centre chat runs the stage's
 * height, margin to margin; (2) the agenda is drawn no wider than leaves the centre its share
 * (the 1x1 counts on a small window); (3) no floating card overlaps another or the centre, none
 * is off the stage, and every card is on the stage or in Others; (4) side by side, the web card's
 * phone / tablet / desktop switch reshapes the CARD (narrow tall → wide) and the centre takes
 * what it leaves, nothing overlapping. Screenshots: $OUT/<tag>-<engine>-*.png. Exit 0 iff all pass
 * (TAG=before only records: the old build is expected to fail).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The build to drive (a checkout of the code BEFORE the change, for the before shots). */
const BUILD = process.env.DC_BUILD || REPO;
const ENGINE = process.env.ENGINE || 'chromium';
const TAG = process.env.TAG || 'after';
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-stage-fit-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(BUILD, 'dist', 'index.js');
const OUT = process.env.OUT || join(REPO, 'tmp', 'super-stage-fit');
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
      cli('super', 'open', 'image', 'pics/onboarding-flow.png'),
      cli('super', 'open', 'whiteboard', 'share-flow'),
      cli('super', 'open', 'task', 'import-bank-csv'),
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
  copyFileSync(join(REPO, 'public', 'image', 'diagram-recall.png'), join(PROJ, 'pics', 'onboarding-flow.png'));
  must('task 2', dc('tasks', 'create', 'Import bank CSV', '-w', 'Owners keep typing statements in by hand.'));
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
const shot = async (page, name) => { await page.waitForTimeout(900); const p = join(OUT, `${TAG}-${ENGINE}-${name}.png`); await page.screenshot({ path: p }); return p; };
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
/** A dev server on this computer (fictional): the page prints the width it is laid out at. */
async function startSite(port) {
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="font-family:system-ui;margin:24px"><h1>Pocket Ledger</h1>
<p>Laid out at <b id="vw"></b> px</p><button id="cta">Share</button>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-top:16px">
${Array.from({ length: 12 }, (_, i) => `<div style="height:90px;border-radius:12px;background:hsl(${i * 30} 60% 70%)">Ledger ${i + 1}</div>`).join('')}</div>
<script>function w(){document.getElementById('vw').textContent=String(innerWidth)}w();addEventListener('resize',w)</script></body></html>`);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return srv;
}

// The owner's window (~1140x710 asked; his screenshot measures as a ~1280x800 CSS window), 1440, 1920.
const WINDOWS = [[1140, 710], [1280, 800], [1440, 900], [1920, 1080]];
const ASPECT = { phone: 390 / 844, tablet: 820 / 1180, desktop: 1440 / 900 };

/** The stage as drawn: its box, the centre's, every card's (float or not), Others. */
const measure = (page) => page.evaluate(() => {
  const st = document.querySelector('[data-testid="super-surface"]');
  const s = st.getBoundingClientRect();
  const rel = (r) => ({ x: Math.round(r.left - s.left), y: Math.round(r.top - s.top), w: Math.round(r.width), h: Math.round(r.height) });
  const centre = rel(st.querySelector('[data-testid="super-centre"]').getBoundingClientRect());
  const cards = [...st.querySelectorAll('[data-testid="super-container"]')].map((e) => ({
    id: e.dataset.containerId, where: e.dataset.where, size: e.dataset.size, owner: e.dataset.owner === 'true', ...rel(e.getBoundingClientRect()),
  }));
  // A group is one floating tile on the stage, like a card.
  for (const g of st.querySelectorAll('[data-testid="super-group"]')) cards.push({ id: g.dataset.groupId, where: g.dataset.where, group: true, ...rel(g.getBoundingClientRect()) });
  const others = st.querySelector('[data-testid="super-others"]');
  const othersCount = Number(others?.querySelector('.super-others-count')?.textContent || 0);
  return { stage: { w: Math.round(s.width), h: Math.round(s.height) }, centre, cards, others: others ? rel(others.getBoundingClientRect()) : null, othersCount };
});
const hit = (a, b, gap = 0) => a.x < b.x + b.w + gap - 1 && b.x < a.x + a.w + gap - 1 && a.y < b.y + b.h + gap - 1 && b.y < a.y + a.h + gap - 1;

async function owner(page, patch) {
  const r = await page.evaluate(async (p) => {
    const res = await fetch('/api/super/layout', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Dreamcontext-Vault': 'pocket-ledger' }, body: JSON.stringify(p) });
    return res.status;
  }, patch);
  await settle(page);
  return r;
}

const STRICT = TAG !== 'before';
const check = (label, cond, detail) => (STRICT ? ok(label, cond, detail) : (console.log(`  ${cond ? '·' : '!'} ${label}${cond ? '' : ` — ${String(detail ?? '').slice(0, 300)}`}`), cond));

let server = null;
let site = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  setupScratch();
  mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  const sitePort = await freePort();
  server = await startServer(port);
  site = await startSite(sitePort);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw[ENGINE].launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`\n── hand over (${ENGINE}, ${TAG})`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super agent opened its five cards', await until(page, async () => record().containers.filter((c) => c.kind !== 'agenda').length >= 5, 60000));
  await settle(page);
  const url = `http://127.0.0.1:${sitePort}/`;
  const s = await agent(page, `super open web ${url}`);
  ok('`super open web` (the dev server) succeeded', s && s.status === 0, JSON.stringify(s));
  if (!record().containers.some((c) => c.kind === 'agenda')) await owner(page, { agenda: 'open' });
  const rec = record().containers;
  const ag = rec.find((c) => c.kind === 'agenda')?.id;
  const web = rec.find((c) => c.kind === 'web' && c.ref === url)?.id;
  const [t1, t2] = rec.filter((c) => c.kind === 'task').map((c) => c.id);
  const board = rec.find((c) => c.kind === 'whiteboard')?.id;
  ok('the agenda is on the stage', !!ag);
  // The owner's moves: the agenda at medium (his old choice), two cards dropped on nearly one spot
  // on the left, the whiteboard put in Others.
  ok('owner: agenda sized medium', (await owner(page, { cards: [{ id: ag, size: 'medium' }] })) === 200);
  ok('owner: two cards dropped near one spot', (await owner(page, { cards: [{ id: t1, pos: { x: 0.02, y: 0.28 } }, { id: t2, pos: { x: 0.03, y: 0.33 } }] })) === 200);
  ok('owner: the whiteboard put in Others', (await owner(page, { cards: [{ id: board, place: 'others' }] })) === 200);
  // `super open web` shows the page side by side: the owner takes the stage back to floating.
  ok('owner: back to the floating stage', (await owner(page, { view: { mode: 'float' } })) === 200);
  ok('the stage floats', await until(page, async () => (await page.locator('[data-testid="super-surface"][data-mode="float"]').count()) === 1, 8000));
  await page.waitForTimeout(1500);

  for (const [w, h] of WINDOWS) {
    const name = `${w}x${h}`;
    console.log(`\n── float at ${name}`);
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1200);
    await settle(page);
    const m = await measure(page);
    await shot(page, `${name}-float`);
    const fl = m.cards.filter((c) => c.where === 'float');
    console.log(`  · stage ${m.stage.w}x${m.stage.h}; centre ${JSON.stringify(m.centre)}; agenda ${JSON.stringify(m.cards.find((c) => c.id === ag))}; others ${JSON.stringify(m.others)}`);
    check(`${name}: the centre runs the stage's height (24 px margins)`, Math.abs(m.centre.y - 24) <= 2 && Math.abs(m.stage.h - (m.centre.y + m.centre.h) - 24) <= 2, JSON.stringify({ centre: m.centre, stage: m.stage }));
    const share = Math.min(1120, Math.max(560, 0.56 * m.stage.w));
    const a = m.cards.find((c) => c.id === ag);
    // Another card the owner or the agent sized keeps the old rule (it may narrow the centre);
    // the agenda never does: it is the 1x1 counts, or the centre keeps its share.
    check(`${name}: the agenda is on the stage and never what narrows the centre (share ${Math.round(share)} px)`, a?.where === 'float' && (a.w <= 160 || m.centre.w >= share - 2), JSON.stringify({ centre: m.centre.w, agenda: a }));
    if (m.stage.w < 1300) check(`${name}: on a small window the agenda is the 1x1 counts`, a?.size === 'small', JSON.stringify(a));
    const bad = [];
    for (const c of fl) {
      if (hit(c, m.centre)) bad.push(`${c.id} over the centre`);
      if (c.x < 0 || c.y < 0 || c.x + c.w > m.stage.w + 1 || c.y + c.h > m.stage.h + 1) bad.push(`${c.id} off the stage`);
      for (const d of fl) if (c.id < d.id && hit(c, d)) bad.push(`${c.id} overlaps ${d.id}`);
    }
    check(`${name}: no floating card overlaps another or the centre, none off the stage`, bad.length === 0, bad.join('; '));
    // Every item (an ungrouped card, a group) is a floating tile or counted in Others.
    const r = record();
    const grouped = new Set((r.groups ?? []).flatMap((g) => g.cards));
    const items = r.containers.filter((c) => !grouped.has(c.id) && !c.min).length + (r.groups ?? []).length;
    check(`${name}: every card is on the stage or in Others (${fl.length} + ${m.othersCount} of ${items})`, fl.length + m.othersCount === items, JSON.stringify({ fl: fl.map((c) => c.id), others: m.othersCount }));
    if (m.others) check(`${name}: the Others stack sits beside the centre, not under it`, !hit(m.others, m.centre), JSON.stringify(m.others));
  }

  console.log('\n── side by side: the web card\'s device width reshapes the card');
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
  await agent(page, `super half ${web}`);
  await page.waitForTimeout(800);
  const gate = card(page, web).getByRole('button', { name: /Open once/ }).first();
  if (await until(page, async () => (await gate.count()) > 0, 6000)) { await page.waitForTimeout(700); await gate.click(); }
  ok('the page draws in its frame', await until(page, async () => (await card(page, web).locator('iframe').count()) > 0, 15000));
  await page.waitForTimeout(1200);
  for (const [w, h] of WINDOWS) {
    const name = `${w}x${h}`;
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1000);
    await settle(page);
    const widths = {};
    for (const d of ['phone', 'tablet', 'desktop']) {
      await hoverCard(page, web);
      const btn = card(page, web).locator(`[data-testid="web-device-${d}"]`).first();
      if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
      await page.waitForTimeout(500);
      await settle(page);
      await page.mouse.move(5, 5);
      const m = await measure(page);
      const c = m.cards.find((x) => x.id === web);
      widths[d] = { card: c.w, centre: m.centre.w };
      await shot(page, `${name}-half-${d}`);
      const shape = (c.w - 2) / (c.h - 38);
      check(`${name} ${d}: the card has the device's shape (${shape.toFixed(2)} vs ${ASPECT[d].toFixed(2)})`, Math.abs(shape - ASPECT[d]) < 0.05 || c.w <= 202, JSON.stringify(c));
      check(`${name} ${d}: the card and the centre do not overlap, both on the stage`, !hit(c, m.centre) && c.x >= 0 && c.x + c.w <= m.stage.w + 1 && c.y >= 0 && c.y + c.h <= m.stage.h + 1, JSON.stringify({ c, centre: m.centre }));
    }
    console.log(`  · ${name}: ${JSON.stringify(widths)}`);
    check(`${name}: phone < tablet < desktop card, the centre takes what each leaves`, widths.phone.card < widths.tablet.card && widths.tablet.card < widths.desktop.card && widths.phone.centre > widths.desktop.centre, JSON.stringify(widths));
  }
  // Leave the device off for the next run's float shots.
  await hoverCard(page, web);
  const on = card(page, web).locator('[data-testid="web-device-desktop"]').first();
  if ((await on.getAttribute('aria-pressed')) === 'true') await on.click();

  const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|posthog|Content Security Policy|Refused to/i.test(e));
  ok('no console errors from the app', real.length === 0, real.slice(0, 5).join('\n'));
} catch (e) {
  fails.push(`crashed: ${e && e.stack ? e.stack : e}`);
  console.log(`  ✗ crashed: ${e && e.stack ? e.stack : e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, `${TAG}-${ENGINE}-crash.png`) }).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
  if (site) site.close();
}
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? `:\n  - ${fails.join('\n  - ')}` : ''}\nScreenshots: ${OUT}`);
process.exit(fails.length ? 1 : 0);
