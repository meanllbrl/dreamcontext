#!/usr/bin/env node
/**
 * ROOM TO GROW (owner 2026-10-29 on the installed 0.36.1, "alan var mı?"): on the floating stage he
 * drags the corner of a card in the empty column right of the centre chat to make it 2x2, and the
 * outline turns yellow, "No room: the centre chat needs its width", though the column is free.
 * Harness from super-agenda-group.mjs.
 *
 *   npm run build && node scripts/verify/super-resize-room.mjs
 *   ENGINE=webkit TAG=after OUT=<dir> node scripts/verify/super-resize-room.mjs
 *   TAG=before records only (the old build is expected to fail).
 *
 * WHAT IT PROVES, at the owner's window (1800x1169 CSS, his screenshot), 2000x1300 and 1440x900,
 * with his stage (agenda 2x2 dropped top-left, two cards under it, a board and the card he grows
 * dropped right of the centre, cards in Others): the corner drag to 2x2 shows NO "no room", and
 * releasing it draws the card 2x2 where he grows it, the centre chat unmoved and unnarrowed beyond
 * its floor; a size that truly cannot be drawn (3x2 at 1440x900) still says no room. Screenshots:
 * $OUT/<tag>-<engine>-*.png.
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
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-resize-room-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(BUILD, 'dist', 'index.js');
const OUT = process.env.OUT || join(REPO, 'tmp', 'super-resize-room');
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
      cli('super', 'open', 'image', 'pics/release-diagram.png', '--no-group'),
      cli('super', 'open', 'image', 'pics/onboarding-flow.png', '--no-group'),
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


const CENTRE_MIN = 560;
/** The stage as drawn: its box, the centre's, every card's, the agenda's variant. */
const measure = (page) => page.evaluate(() => {
  const st = document.querySelector('[data-testid="super-surface"]');
  const s = st.getBoundingClientRect();
  const rel = (r) => ({ x: Math.round(r.left - s.left), y: Math.round(r.top - s.top), w: Math.round(r.width), h: Math.round(r.height) });
  const centre = rel(st.querySelector('[data-testid="super-centre"]').getBoundingClientRect());
  const cards = [...st.querySelectorAll('[data-testid="super-container"]')].map((e) => ({
    id: e.dataset.containerId, where: e.dataset.where, size: e.dataset.size, ...rel(e.getBoundingClientRect()),
  }));
  return { stage: { w: Math.round(s.width), h: Math.round(s.height) }, centre, cards };
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

/** Press a card's resize corner and move it by (grow, grow) away from the centre; read the outline, then release. */
async function dragCorner(page, id, grow) {
  const m = await measure(page);
  const a = m.cards.find((c) => c.id === id);
  const left = a.x + a.w / 2 < m.centre.x + m.centre.w / 2;
  await card(page, id).hover();
  await page.waitForTimeout(300);
  const box = await card(page, id).locator('[data-testid="super-card-resize"]').first().boundingBox();
  const x0 = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const dx = left ? -grow : grow;
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 + (dx * i) / 8, y0 + (grow * i) / 8); await page.waitForTimeout(40); }
  await page.waitForTimeout(300);
  const outline = await page.locator('[data-testid="super-resize-outline"]').evaluate((e) => ({ size: e.dataset.size, fits: e.dataset.fits ?? null, text: e.textContent })).catch(() => null);
  return outline;
}
const release = async (page) => { await page.mouse.up(); await settle(page); };


let server = null;
let site = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  setupScratch();
  mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw[ENGINE].launch();
  const context = await browser.newContext({ viewport: { width: 1800, height: 1169 }, colorScheme: 'dark' });
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
  if (!record().containers.some((c) => c.kind === 'agenda')) await owner(page, { agenda: 'open' });
  const rec = record().containers;
  const ag = rec.find((c) => c.kind === 'agenda')?.id;
  const [pic1, pic2] = rec.filter((c) => c.kind === 'image').map((c) => c.id);
  const board = rec.find((c) => c.kind === 'whiteboard')?.id;
  const [taskA, taskB] = rec.filter((c) => c.kind === 'task').map((c) => c.id);
  const handoverChat = rec.find((c) => c.kind === 'chat')?.id;
  ok('owner: the floating stage', (await owner(page, { view: { mode: 'float' } })) === 200);
  // His stage (the pos fractions of his record): the agenda 2x2 top-left, two cards under it, the
  // board top-right and the card he grows right of the centre; one card in Others.
  const HIS = [
    { id: ag, size: 'large', pos: { x: 0, y: 0 } },
    { id: pic1, size: null, pos: { x: 0.0755, y: 0.4526 } },
    { id: pic2, size: null, pos: { x: 0.0779, y: 0.5873 } },
    { id: board, place: 'float', pos: { x: 0.9365, y: 0.0844 } },
    { id: taskB, size: 'small', pos: { x: 0.882, y: 0.607 } },
    { id: taskA, place: 'others' },
    ...(handoverChat ? [{ id: handoverChat, place: 'float' }] : []),
  ];
  // A stage the 0.36.1 check refused at his window (the unit test's): his 2x2 agenda bottom-right,
  // a 3x2 picture he sized there, the card he grows above them with a free 2x2 beside the centre.
  const RIGHT_FULL = [
    { id: ag, size: 'large', pos: { x: 0.911, y: 0.932 } },
    ...(handoverChat ? [{ id: handoverChat, place: 'others' }] : []),
    { id: taskA, place: 'float', size: 'small', pos: { x: 0.003, y: 0.558 } },
    { id: pic1, place: 'float', size: 'wide', pos: { x: 0.916, y: 0.886 } },
    { id: pic2, place: 'float', size: 'large', pos: null },
    { id: board, place: 'float', size: 'small', pos: null },
    { id: taskB, size: 'small', pos: { x: 0.868, y: 0.633 } },
  ];
  ok('owner: his stage', (await owner(page, { cards: HIS })) === 200);
  await page.waitForTimeout(1200);
  const WINDOWS = [[1800, 1169, 'his', HIS], [2000, 1300, 'his', HIS], [1440, 900, 'his', HIS], [1800, 1169, 'right-full', RIGHT_FULL]];

  // His screenshot is a 3600 px retina capture: an 1800x1169 CSS window. Then 2000x1300, 1440x900.
  for (const [w, h, stageName, cards] of WINDOWS) {
    const name = `${w}x${h}-${stageName}`;
    console.log(`\n── he grows the card right of the centre to 2x2, ${name}`);
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1200);
    ok(`${name}: the stage set`, (await owner(page, { cards })) === 200);
    await page.waitForTimeout(800);
    const m0 = await measure(page);
    const t0 = m0.cards.find((c) => c.id === taskB);
    const rightRoom = m0.stage.w - 24 - (m0.centre.x + m0.centre.w + 24);
    console.log(`  · stage ${m0.stage.w}x${m0.stage.h}; centre ${JSON.stringify(m0.centre)}; card ${JSON.stringify(t0)}; free column right of the centre ${rightRoom}px`);
    console.log(`  · cards ${JSON.stringify(m0.cards.filter((c) => c.where === "float").map((c) => [c.id.slice(0, 10), c.size, c.x, c.y, c.w, c.h]))}`);
    await shot(page, `${name}-start`);
    const outline = await dragCorner(page, taskB, 190);
    await shot(page, `${name}-drag`);
    await release(page);
    const m1 = await measure(page);
    const t1 = m1.cards.find((c) => c.id === taskB);
    const r1 = record().containers.find((c) => c.id === taskB);
    await shot(page, `${name}-done`);
    console.log(`  · outline ${JSON.stringify(outline)}; record ${JSON.stringify({ size: r1?.size, sizeBy: r1?.sizeBy, pos: r1?.pos })}; drawn ${JSON.stringify(t1)}; centre ${JSON.stringify(m1.centre)}`);
    // Room = the 2x2 grown from its inner top corner is on the stage, clear of the centre and of every other card.
    const g = { x: t0.x, y: t0.y, w: 344, h: 344 };
    const room = g.x + g.w <= m0.stage.w - 24 + 1 && g.y + g.h <= m0.stage.h - 24 + 1 && !hit(g, m0.centre, 24)
      && !m0.cards.some((c) => c.id !== taskB && c.where === 'float' && hit(g, c, 24));
    if (room) {
      check(`${name}: the 2x2 rect is free (column ${rightRoom}px), the outline says nothing about room`, outline?.size === 'large' && outline?.fits !== 'false', JSON.stringify(outline));
      check(`${name}: released, the card is 2x2 on the stage`, r1?.size === 'large' && t1?.where === 'float' && t1?.size === 'large', JSON.stringify({ r1, t1 }));
      check(`${name}: the centre chat did not move`, Math.abs(m1.centre.x - m0.centre.x) <= 1 && Math.abs(m1.centre.w - m0.centre.w) <= 1, JSON.stringify({ before: m0.centre, after: m1.centre }));
    } else {
      check(`${name}: the 2x2 rect is not free: refused and nothing written, or drawn sound`, (outline?.fits === 'false') === !(r1?.size === 'large'), JSON.stringify({ outline, r1 }));
    }
    check(`${name}: the centre keeps its ${CENTRE_MIN}px floor`, m1.centre.w >= CENTRE_MIN - 1, JSON.stringify(m1.centre));
    const fl = m1.cards.filter((c) => c.where === 'float');
    const bad = [];
    for (const c of fl) {
      if (hit(c, m1.centre)) bad.push(`${c.id} over the centre`);
      if (c.x < 0 || c.y < 0 || c.x + c.w > m1.stage.w + 1 || c.y + c.h > m1.stage.h + 1) bad.push(`${c.id} off the stage`);
      for (const d of fl) if (c.id < d.id && hit(c, d)) bad.push(`${c.id} overlaps ${d.id}`);
    }
    check(`${name}: no card overlaps another or the centre, none off the stage`, bad.length === 0, bad.join('; '));
  }

  console.log('\n── a size that truly cannot be drawn still says no room (1440x900, 3x2 beside a 2x2 on the left)');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1000);
  // A 2x2 card he sized on the left: 2x2 + 3x2 + the centre's 560 px floor are wider than the stage.
  const NOFIT = [
    { id: ag, size: 'small', pos: { x: 0, y: 0 } },
    { id: taskA, place: 'float', size: 'large', pos: { x: 0, y: 0.35 } },
    { id: pic1, place: 'others' },
    { id: pic2, place: 'others' },
    { id: board, place: 'others' },
    { id: taskB, size: 'small', pos: { x: 0.9, y: 0.5 } },
  ];
  ok('owner: a 2x2 card on the left, the card small on the right', (await owner(page, { cards: NOFIT })) === 200);
  await page.waitForTimeout(800);
  const wide = await dragCorner(page, taskB, 420);
  await shot(page, '1440x900-wide-nofit');
  await release(page);
  const rw = record().containers.find((c) => c.id === taskB);
  console.log(`  · outline ${JSON.stringify(wide)}; record ${JSON.stringify({ size: rw?.size })}`);
  check('3x2 at 1440x900: the outline says no room and nothing is written', wide?.size === 'wide' && wide?.fits === 'false' && (rw?.size ?? 'small') !== 'wide', JSON.stringify({ wide, rw }));

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
