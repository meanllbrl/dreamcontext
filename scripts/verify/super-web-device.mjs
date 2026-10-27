#!/usr/bin/env node
/**
 * PHONE / TABLET / DESKTOP WIDTH and an HONEST INSPECT on the Super stage's web card (owner
 * 2026-10-27: "on the web board I must be able to switch to phone, tablet and computer size";
 * "Inspect does not work, why? Is it because it isn't localhost?"). Harness derived from
 * super-stage-fixes.mjs.
 *
 *   npm run build && node scripts/verify/super-web-device.mjs
 *   REMOTE_URL=https://example.com node scripts/verify/super-web-device.mjs
 *
 * WHAT IT DRIVES — the real dashboard on a scratch HOME, Chromium, a stand-in `claude` that opens
 * cards when told to, a fictional dev server on this computer (its page prints its own viewport
 * width), and a real site on the web (REMOTE_URL, default the owner's https://app.trypushme.com,
 * only loaded and looked at).
 *
 * WHAT IT PROVES — on both pages the three widths lay the page out at 390 / 820 / 1440 and fit
 * it into the card without reloading it; the choice survives a reload and the full-screen view
 * opens at it; the local page's button picks elements ("Pick element"), the site's is the
 * shield ("Pan & zoom") and says why it cannot pick. Screenshots: tmp/super-web-device/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-web-device-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-web-device', process.env.SHOTS_TAG || 'now');
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

const REMOTE = process.env.REMOTE_URL || 'https://app.trypushme.com/';
const WIDTH = { phone: 390, tablet: 820, desktop: 1440 };
const frameOf = (page, id) => card(page, id).locator('iframe').first();
const frameBox = (page, id) => frameOf(page, id).evaluate((f) => {
  const r = f.getBoundingClientRect();
  const v = f.closest('.wb-web-device').getBoundingClientRect();
  return { layout: f.offsetWidth, drawn: Math.round(r.width), drawnH: Math.round(r.height), boxW: Math.round(v.width), boxH: Math.round(v.height) };
});

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

  for (const which of ['local', 'remote']) {
    const url = which === 'local' ? `http://127.0.0.1:${sitePort}/` : REMOTE;
    console.log(`\n── ${which}: ${url}`);
    const s = await agent(page, `super open web ${url}`);
    ok(`${which}: \`super open web\` succeeded`, s && s.status === 0, JSON.stringify(s));
    const id = record().containers.find((c) => c.kind === 'web' && c.ref === url)?.id;
    await agent(page, `super half ${id}`);
    await page.waitForTimeout(800);
    const gate = card(page, id).getByRole('button', { name: which === 'local' ? /Open once/ : /^Load$/ }).first();
    if (await until(page, async () => (await gate.count()) > 0, 6000)) { await page.waitForTimeout(700); await gate.click(); }
    ok(`${which}: the page draws in its frame`, await until(page, async () => (await frameOf(page, id).count()) > 0, 15000));
    await page.waitForTimeout(which === 'remote' ? 4000 : 1500);
    await hoverCard(page, id);

    // The mode button: picks where the bridge is, is the shield (and says so) where it is not.
    const btn = card(page, id).locator('[data-testid="super-zoom-inspect"]').first();
    if (which === 'local') {
      ok('local: the button is "Pick element" (the proxy carries the bridge)', await until(page, async () => (await btn.textContent()) === 'Pick element', 8000), await btn.textContent());
      await btn.click();
      const f = page.frameLocator(`[data-testid="super-container"][data-container-id="${id}"] iframe`).first();
      await f.locator('#cta').hover();
      ok('local: hovering in Pick outlines the element (the bridge draws its overlay)', await until(page, async () => (await f.locator('dreamcontext-inspect').count()) > 0, 4000));
      await shot(page, `${which}-pick`);
      await page.keyboard.press('Escape');
    } else {
      ok('remote: the button is "Pan & zoom", never "Pick element"', (await btn.textContent()) === 'Pan & zoom', await btn.textContent());
      await btn.click();
      const note = card(page, id).locator('[data-testid="super-zoom-nopick"]');
      ok('remote: turning it on says why there is no picking', await until(page, async () => (await note.count()) === 1 && /only on pages on this computer/.test(await note.textContent()), 3000));
      ok('remote: the shield is up (pinch and drag are the card\'s)', (await card(page, id).locator('[data-testid="super-zoom-shield"]').count()) === 1);
      const sb = await card(page, id).locator('[data-testid="super-zoom"]').first().boundingBox();
      await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control');
      await page.waitForTimeout(400);
      ok('remote: ctrl + wheel (a trackpad pinch) over the site zooms the card', ((await zoomScale(page, id)) ?? 0) > 1, String(await zoomScale(page, id)));
      await shot(page, `${which}-pan-zoom-note`);
      await hoverCard(page, id);
      await card(page, id).locator('[data-testid="super-zoom-fit"]').first().click();
      await btn.click();
      ok('remote: off again, the note goes', (await card(page, id).locator('[data-testid="super-zoom-nopick"]').count()) === 0);
    }

    // The three widths: laid out at the device's width, drawn inside the card, never reloaded.
    const f = page.frames().find((fr) => fr.url().startsWith(which === 'local' ? 'http://127.0.0.1' : REMOTE.replace(/\/$/, '')) && fr !== page.mainFrame() && !fr.url().startsWith(base));
    if (f) await f.evaluate(() => { window.__verifyMark = 1; }).catch(() => {});
    const fill = await frameBox(page, id);
    for (const d of ['phone', 'tablet', 'desktop']) {
      await hoverCard(page, id);
      await card(page, id).locator(`[data-testid="web-device-${d}"]`).first().click();
      await page.waitForTimeout(900);
      const b = await frameBox(page, id);
      console.log(`  · ${d}: ${JSON.stringify(b)}`);
      ok(`${which} ${d}: laid out at ${WIDTH[d]} px`, b.layout === WIDTH[d], JSON.stringify(b));
      ok(`${which} ${d}: drawn inside the card (≤ its width, its full height)`, b.drawn <= b.boxW + 1 && Math.abs(b.drawnH - b.boxH) <= 2, JSON.stringify(b));
      if (which === 'local') {
        const vw = await page.frameLocator(`[data-testid="super-container"][data-container-id="${id}"] iframe`).first().locator('#vw').textContent();
        ok(`local ${d}: the page itself says ${WIDTH[d]}`, vw === String(WIDTH[d]), vw);
      }
      ok(`${which} ${d}: the button shows pressed`, (await card(page, id).locator(`[data-testid="web-device-${d}"]`).first().getAttribute('aria-pressed')) === 'true');
      await shot(page, `${which}-${d}`);
    }
    if (f) ok(`${which}: switching never reloaded the page`, (await f.evaluate(() => window.__verifyMark).catch(() => null)) === 1);

    console.log(`\n── ${which}: remembered, and full screen at the same width`);
    await page.goto(`${base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
    if (!(await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 15000))) await openChat(page, base);
    ok(`${which}: the stage is back after a reload`, await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000));
    await settle(page);
    await agent(page, `super half ${id}`);
    await page.waitForTimeout(800);
    const gate2 = card(page, id).getByRole('button', { name: which === 'local' ? /Open once/ : /^Load$/ }).first();
    if (await until(page, async () => (await gate2.count()) > 0, 6000)) { await page.waitForTimeout(700); await gate2.click(); }
    ok(`${which}: after a reload the card is still at desktop width`, await until(page, async () => (await frameBox(page, id).catch(() => ({}))).layout === 1440, 15000), JSON.stringify(await frameBox(page, id).catch(() => null)));
    await hoverCard(page, id);
    await clickIn(page, id, 'super-card-fullscreen');
    const fv = page.locator('[data-testid="frame-viewer"]');
    ok(`${which}: full screen opens`, await until(page, async () => (await fv.count()) === 1, 6000));
    await page.waitForTimeout(2500);
    const fb = await fv.locator('iframe').first().evaluate((e) => ({ layout: e.offsetWidth, drawn: Math.round(e.getBoundingClientRect().width) }));
    ok(`${which}: full screen lays it out at desktop width too, fitted to the screen`, fb.layout === 1440 && fb.drawn <= 1440, JSON.stringify(fb));
    ok(`${which}: …and its desktop button is pressed`, (await fv.locator('[data-testid="web-device-desktop"]').getAttribute('aria-pressed')) === 'true');
    await shot(page, `${which}-fullscreen-desktop`);
    await fv.locator('[data-testid="web-device-phone"]').click();
    await page.waitForTimeout(800);
    const fp = await fv.locator('iframe').first().evaluate((e) => ({ layout: e.offsetWidth, drawn: Math.round(e.getBoundingClientRect().width) }));
    ok(`${which}: full screen at phone width: 390, real size`, fp.layout === 390 && fp.drawn === 390, JSON.stringify(fp));
    await shot(page, `${which}-fullscreen-phone`);
    await fv.locator('[data-testid="frame-viewer-mode"]').click();
    ok(`${which}: the full-screen toggle reads "Use the page"`, (await fv.locator('[data-testid="frame-viewer-mode"]').textContent()) === 'Use the page');
    console.log(`  · hint: ${await fv.locator('[data-testid="frame-viewer-hint"]').textContent()}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    ok(`${which}: back on the card it is at phone width (the choice is shared)`, await until(page, async () => (await frameBox(page, id).catch(() => ({}))).layout === 390, 15000));
    await shot(page, `${which}-back-phone`);
  }

  console.log('\n── a phone-sized window: the bar stays inside the card');
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.waitForTimeout(1500);
  const narrow = await page.evaluate(() => [...document.querySelectorAll('.super-zoom-bar')].filter((b) => b.getClientRects().length).map((b) => {
    const r = b.getBoundingClientRect(); const z = b.closest('.super-zoom').getBoundingClientRect();
    return { inside: r.left >= z.left - 1 && r.right <= z.right + 1, devices: b.querySelectorAll('.web-device-btn').length };
  }));
  console.log(`  · ${JSON.stringify(narrow)}`);
  ok('390 px window: every shown bar stays inside its card, with its three device buttons', narrow.length > 0 && narrow.every((n) => n.inside && n.devices === 3), JSON.stringify(narrow));
  await shot(page, 'window-390');
  const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|posthog|Content Security Policy|Refused to/i.test(e));
  ok('no console errors from the app', real.length === 0, real.slice(0, 5).join('\n'));
} catch (e) {
  fails.push(`crashed: ${e && e.stack ? e.stack : e}`);
  console.log(`  ✗ crashed: ${e && e.stack ? e.stack : e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
  if (site) site.close();
}
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? `:\n  - ${fails.join('\n  - ')}` : ''}\nScreenshots: ${OUT}`);
process.exit(fails.length ? 1 : 0);
