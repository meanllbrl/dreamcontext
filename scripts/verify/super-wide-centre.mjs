#!/usr/bin/env node
/**
 * THE SUPER CHAT USES A WIDE STAGE (owner 2026-11-03, a ~1800 px window: "bu ekranda super agent
 * daha geniş olmalı ama değil daha sıkışmış duruyor"). Harness derived from super-stage-fit.mjs.
 *
 *   npm run build && node scripts/verify/super-wide-centre.mjs
 *   DC_BUILD=<a checkout built before the change> TAG=before node scripts/verify/super-wide-centre.mjs
 *
 * WHAT IT DRIVES: the real dashboard on a scratch HOME, a stand-in `claude` that opens nothing on
 * hand-over, so the stage holds the Super chat and its agenda (large, its default) only: the
 * owner's screen. Then one picture is presented (spotlight).
 *
 * WHAT IT PROVES, at 1440x900, 1800x1170, 1920x1080 and 2560x1440: (1) the agenda keeps its size
 * (its 1x1 counts on a stage under 1400 px, as before);
 * (2) the centre is as wide as the side free of cards allows (its preferred width, or the room
 * beside the agenda), not narrowed to mirror the agenda on the empty side; (3) nothing overlaps
 * and nothing is off the stage; (4) the message column keeps a readable measure inside a wide
 * centre; (5) a presentation still draws the chat small beside the picture.
 * Screenshots and metrics: $OUT/<tag>-<engine>-*. Exit 0 iff all pass (TAG=before only records).
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
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-wide-centre-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(BUILD, 'dist', 'index.js');
const OUT = process.env.OUT || join(REPO, 'tmp', 'super-wide-centre');
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
    const steps = [];
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


const WINDOWS = [[1440, 900], [1800, 1170], [1920, 1080], [2560, 1440]];

const measure = (page) => page.evaluate(() => {
  const st = document.querySelector('[data-testid="super-surface"]');
  const s = st.getBoundingClientRect();
  const rel = (r) => ({ x: Math.round(r.left - s.left), y: Math.round(r.top - s.top), w: Math.round(r.width), h: Math.round(r.height) });
  const centreEl = st.querySelector('[data-testid="super-centre"]');
  const centre = rel(centreEl.getBoundingClientRect());
  const cards = [...st.querySelectorAll('[data-testid="super-container"]')].map((e) => ({
    id: e.dataset.containerId, where: e.dataset.where, size: e.dataset.size, ...rel(e.getBoundingClientRect()),
  }));
  // The widest line box a message can take: the transcript's own content column.
  const msgs = [...centreEl.querySelectorAll('.chat-scroll-inner > *:not(.chat-reply-lines):not(.super-event-line)')];
  const widest = msgs.reduce((m, e) => (Math.round(e.getBoundingClientRect().width) > m.w ? { w: Math.round(e.getBoundingClientRect().width), cls: e.className } : m), { w: 0, cls: '' });
  const msgW = widest.w;
  return { widestCls: widest.cls, stage: { w: Math.round(s.width), h: Math.round(s.height) }, centre, cards, msgW };
});
const hit = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

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
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw[ENGINE].launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`\n── hand over (${ENGINE}, ${TAG})`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  const handover = page.locator('[data-testid="super-handover-btn"]:visible').first();
  if (await handover.count()) await handover.click();
  else await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  await until(page, async () => (await superComposer(page).count()) > 0);
  // A few turns, so the transcript has text to measure.
  for (const t of ['Where are we on the share sheet? Give me the long version, every open question and what you would do next about each of them.', 'And the bank CSV import?']) {
    await sayToSuper(page, t);
    await page.waitForTimeout(2500);
  }
  if (!record().containers.some((c) => c.kind === 'agenda')) {
    await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Dreamcontext-Vault': 'pocket-ledger' }, body: JSON.stringify({ agenda: 'open' }) }));
  }
  const ag = record().containers.find((c) => c.kind === 'agenda')?.id;
  ok('the agenda is on the stage', !!ag);
  // The owner's screen: he dropped the agenda in the top-left corner (a card he placed).
  const moved = await page.evaluate(async (id) => (await fetch('/api/super/layout', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Dreamcontext-Vault': 'pocket-ledger' }, body: JSON.stringify({ cards: [{ id, pos: { x: 0.02, y: 0.05 } }] }) })).status, ag);
  ok('owner: the agenda dropped top-left', moved === 200, String(moved));
  await settle(page);

  const metrics = [];
  for (const [w, h] of WINDOWS) {
    const name = `${w}x${h}`;
    console.log(`\n── ${name}`);
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1500);
    const m = await measure(page);
    const a = m.cards.find((c) => c.id === ag);
    metrics.push({ window: name, ...m });
    console.log(`  · stage ${m.stage.w}x${m.stage.h}; centre ${JSON.stringify(m.centre)}; agenda ${JSON.stringify(a)}; widest message ${m.msgW} (${m.widestCls})`);
    const preferred = Math.min(1120, Math.max(560, 0.56 * m.stage.w));
    const beside = a ? m.stage.w - 24 - (a.x + a.w + 24) : m.stage.w - 48;
    // Under ~1400 px of stage the agenda is its 1x1 counts, as before (its own rule, owner 2026-10-29).
    check(`${name}: the agenda is on the stage${m.stage.w >= 1400 ? ' at its size (large, 344 px)' : ''}`, a && a.where === 'float' && (m.stage.w < 1400 || a.w >= 340), JSON.stringify(a));
    check(`${name}: the centre takes min(its preferred ${Math.round(preferred)}, the room beside the agenda ${beside}) px`, m.centre.w >= Math.min(preferred, beside) - 2, JSON.stringify(m.centre));
    check(`${name}: nothing overlaps the centre, nothing off the stage`, !(a && hit(a, m.centre)) && m.centre.x >= 23 && m.centre.x + m.centre.w <= m.stage.w - 23, JSON.stringify({ a, c: m.centre }));
    check(`${name}: a message line stays readable (<= 962 px, the chat's own measure)`, m.msgW > 0 && m.msgW <= 962, `${m.msgW}`);
    await page.screenshot({ path: join(OUT, `${TAG}-${w}.png`) });
  }
  writeFileSync(join(OUT, `${TAG}-${ENGINE}-metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`);

  console.log('\n── a presentation (spotlight)');
  await page.setViewportSize({ width: 1920, height: 1080 });
  const s = await agent(page, 'super open image pics/release-diagram.png');
  ok('`super open image` succeeded', s && s.status === 0, JSON.stringify(s));
  const img = record().containers.find((c) => c.kind === 'image')?.id;
  const p = await agent(page, `super present ${img} --layout spotlight`);
  ok('`super present --layout spotlight` succeeded', p && p.status === 0, JSON.stringify(p));
  ok('the stage presents', await until(page, async () => (await page.locator('[data-testid="super-surface"][data-mode="present"]').count()) === 1, 8000));
  await settle(page);
  await page.waitForTimeout(1200);
  const pm = await measure(page);
  const pic = pm.cards.find((c) => c.id === img);
  console.log(`  · centre ${JSON.stringify(pm.centre)}; picture ${JSON.stringify(pic)}`);
  check('spotlight: the picture is the big card, the chat smaller beside it', pic && pic.w > pm.centre.w, JSON.stringify({ pic, c: pm.centre }));
  check('spotlight: the chat does not overlap the picture', pic && !hit(pic, pm.centre), JSON.stringify({ pic, c: pm.centre }));
  await page.screenshot({ path: join(OUT, `${TAG}-present-spotlight-1920.png`) });

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fails.push(String(e?.stack || e));
  console.log(e);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, `${TAG}-crash.png`) }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  site?.close?.();
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? `\n  - ${fails.join('\n  - ')}` : ''}`);
process.exit(fails.length && STRICT ? 1 : 0);
