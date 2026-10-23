#!/usr/bin/env node
/**
 * verify:super-layouts — the Super stage's named presentation layouts (task
 * super-sahnesinde-adli-sunum-duzenleri…, plan-r2). Against the REAL dashboard server (this
 * worktree's `dist/`) in Chromium, a stand-in `claude` and a scratch HOME; a fictional
 * "Pocket Ledger" dev site prints its own `innerWidth` and counts clicks on a button.
 *
 *  L1  first look: `super present <site>` at 1440x900 is a spotlight, the card ~930-1010 px, the
 *      page laid out at 1280 css px and scaled; the card's head and the trust prompt at 1:1; a
 *      click inside the page registers; Inspect outlines inside the page and picks into the
 *      Super Agent's composer;
 *  L2  the mini chat: composer usable; folded to a bar the card takes the full width, the bar
 *      survives a reload, a question from the Super draws the mini (no write); unfold restores;
 *  L3  exit: Esc and "Back to the stage" float the stage, the Agents view stays; Esc while typing,
 *      with Others open or a card full screen does not leave;
 *  L4  the switcher offers only the layouts the cards take, keyboard + aria-pressed, survives reload;
 *  L5  filmstrip: 6 cards, the first big, static thumbs in one row, never dragged; a press and
 *      the arrows swap; the site as a thumb keeps 1280 and never reloads; spotlight again: 1280;
 *  L6  review: a child's dev site with its chat, the site on top, the chat under it; its close-ask
 *      keeps the presentation on Esc;
 *  L7  narrow 1000x800: the sheet with tabs and a usable composer bar; widening writes nothing;
 *  L8  screenshots of every layout at 1440x900 and 1920x1080, light and dark, plus narrow;
 *      zero console and page errors.
 *
 * Run: npm run build && npm run verify:super-layouts. Output: tmp/super-layouts/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-layouts-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-layouts');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');

// ─── the stand-in `claude`: the super runs `GO-SUPER <verb> <args…>`; `GO-DELEGATE <port>` starts
// a child that pins its dev server on that port (so the server opens its site by itself) ──
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-layouts-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const pin = (port) => say('The dev server runs.\\n\\n\\\`\\\`\\\`dream-view\\n' + JSON.stringify({ type: 'pin', id: 'dev-' + port, weight: 'tag', facts: [{ label: ':' + port, url: 'http://localhost:' + port }] }) + '\\n\\\`\\\`\\\`\\n');
let inited = false;
async function turn(blocks) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  const text = blocks.join('\\n');
  let said = 'ok';
  if (role === 'super') {
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); said = 'arranged'; }
    else if (!text.startsWith('[super')) {
      const d = text.match(/GO-DELEGATE\\s+(\\d+)/);
      const m = text.match(/GO-SUPER\\s+(.+)$/m);
      if (d) { const step = cli('super', 'delegate', '--prompt', 'PIN ' + d[1], '--brief', 'Pocket Ledger site'); report({ kind: 'super', step }); said = 'delegated'; }
      else if (m) { const step = cli('super', ...m[1].trim().split(/\\s+/)); report({ kind: 'super', step }); said = 'did ' + m[1]; }
    }
  } else {
    const p = text.match(/PIN (\\d+)/);
    if (p) { await sleep(1500); pin(p[1]); report({ kind: 'pinned', port: p[1] }); said = 'pinned ' + p[1]; }
  }
  say((role === 'super' ? 'SUPER ' : 'CHILD ') + said);
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
}
let buf = '';
let chain = Promise.resolve();
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
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks }) + '\\n');
    chain = chain.then(() => turn(blocks));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

// ─── harness ────────────────────────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], groups: [], view: { mode: 'float' }, queue: [] }; } };

/** A solid-colour PNG (the filmstrip's pictures), written without any image library. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const PICTURES = [['mock-a.png', [238, 130, 51]], ['mock-b.png', [64, 148, 220]], ['mock-c.png', [90, 180, 120]], ['mock-d.png', [180, 90, 200]]];

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'mockups'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  for (const [name, rgb] of PICTURES) writeFileSync(join(PROJ, 'mockups', name), png(320, 200, rgb));
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  if (dc('tasks', 'create', 'Ship the ledger export', '-w', 'CSV export of the month.').status !== 0) throw new Error('task create failed');
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
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

/** The fictional "Pocket Ledger" site: it prints the width it is laid out at and counts clicks. */
const dev = { hits: 0 };
function startDevServer(port, name) {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<style>
body{margin:0;font:15px -apple-system,system-ui,sans-serif;background:#f6f8f4;color:#1d2a1f}
header{display:flex;gap:16px;align-items:center;padding:14px 24px;background:#fff;border-bottom:1px solid #dfe6dc}
.logo{font:800 22px system-ui}#iw{margin-left:auto;font:600 13px ui-monospace,monospace;background:#eef3ea;padding:4px 8px;border-radius:8px}
main{padding:24px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
@media (max-width: 1024px){main{grid-template-columns:1fr}}
.card{background:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 4px 16px rgba(0,0,0,.06)}
.cta{background:#2f7d4f;color:#fff;font-weight:700;padding:10px 16px;border-radius:10px;border:0;font-size:14px;cursor:pointer}
.big{font:800 30px system-ui;margin:4px 0 10px}
</style></head>
<body><header><span class="logo">${name}</span><span id="iw"></span></header>
<main>
<section class="card"><h2>Balance</h2><p class="big">€ 2,418.40</p><button id="add" class="cta">Add entry</button><p id="clicks">clicks: 0</p></section>
<section class="card"><h2>This month</h2><p class="big">−€ 612.15</p><p>Groceries, rent share, transport.</p></section>
<section class="card"><h2>Export</h2><p>CSV of every entry this month.</p><button class="cta">Export CSV</button></section>
</main>
<script>
const iw = document.getElementById('iw');
const show = () => { iw.textContent = 'innerWidth ' + innerWidth; };
show(); addEventListener('resize', show);
let n = 0; document.getElementById('add').onclick = () => { n++; document.getElementById('clicks').textContent = 'clicks: ' + n; };
</script></body></html>`;
  const srv = createServer((req, res) => {
    if (req.url === '/' || req.url?.startsWith('/?')) {
      dev.hits++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    res.writeHead(204); res.end();
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

const results = { pass: 0, fails: [], notes: [], shots: [] };
const ok = (label, cond, detail) => {
  if (cond) { results.pass++; console.log(`  ✓ ${label}`); }
  else { results.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 700)}` : ''}`); }
  return !!cond;
};
const note = (m) => { results.notes.push(m); console.log(`  · ${m}`); };
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};
const shot = async (page, name) => { const p = join(OUT, name); await page.screenshot({ path: p }); results.shots.push(p); return p; };

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
const surface = (page) => page.locator('[data-testid="super-surface"]:visible').first();
const surfaceShown = (page) => page.locator('[data-testid="super-surface"]:visible').count().then((n) => n > 0);
const superComposer = (page) => page.locator('[data-testid="super-surface"] .chat-cmp-input:visible').first();
async function sayToSuper(page, text) {
  const input = superComposer(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
async function superSay(page, text) {
  const before = reports().filter((r) => r.kind === 'super').length;
  await sayToSuper(page, text);
  const done = await until(page, async () => reports().filter((r) => r.kind === 'super').length > before, 30000);
  const last = reports().filter((r) => r.kind === 'super').at(-1);
  if (!done || last?.step?.status !== 0) note(`${text} → ${JSON.stringify(last?.step ?? null).slice(0, 300)}`);
  await page.waitForTimeout(900);
  return last?.step;
}
const superVerb = (page, args) => superSay(page, `GO-SUPER ${args}`);
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(700));
const layoutOf = (page) => surface(page).getAttribute('data-layout');
const presenting = async (page) => (await page.locator('[data-testid="super-surface"][data-presenting]:visible').count()) > 0;
const card = (page, id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`).first();
const centre = (page) => page.locator('[data-testid="super-centre"]:visible').first();
/** Every page frame with the site in it, newest first (one per dev server). */
const siteFrames = (page) => page.frames().filter((f) => f !== page.mainFrame() && /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(f.url()));
const innerWidthOf = (frame) => frame.evaluate(() => innerWidth);
const box = async (loc) => loc.boundingBox();

async function allowLoopback(page, scope) {
  const prompt = scope.locator('[data-testid="web-loopback-prompt"]');
  if (!(await until(page, async () => (await prompt.count()) > 0, 10000))) return false;
  await page.waitForTimeout(800);
  await prompt.locator('button').nth(1).click();
  return until(page, async () => (await scope.locator('iframe').count()) > 0, 10000);
}

// ─── the flow ───────────────────────────────────────────────────────────────────────────
async function flow(pw, base, ports) {
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  const errors = [];
  const consoleLog = createWriteStream(join(OUT, 'console.log'));
  page.on('console', (m) => { consoleLog.write(`[${m.type()}] ${m.text()}\n`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── hand over, open the cards');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  const first = page.locator('.chat-cmp-input:visible').first();
  await first.click();
  await first.fill('hello');
  await page.keyboard.press('Enter');
  await until(page, async () => readNd(FRAMES).some((f) => f.role === 'child'), 30000);
  await page.waitForTimeout(1500);
  ok('the hand-over button shows', await until(page, async () => (await page.locator('[data-testid="super-handover-btn"]:visible').count()) > 0, 20000));
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the Super Agent surface shows', await until(page, () => surfaceShown(page)));
  await settle(page);
  await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000);
  const siteRef = `http://localhost:${ports.site}/`;
  await superVerb(page, `open web ${siteRef} --title Pocket-Ledger`);
  await superVerb(page, 'open task ship-the-ledger-export');
  for (const [name] of PICTURES) await superVerb(page, `open image mockups/${name} --no-group`);
  const site = () => record().containers.find((c) => c.kind === 'web' && c.ref === siteRef);
  const task = () => record().containers.find((c) => c.kind === 'task');
  const pics = () => PICTURES.map(([name]) => record().containers.find((c) => c.kind === 'image' && c.ref.endsWith(name))).filter(Boolean);
  ok('the site, the task and four pictures are cards', !!site() && !!task() && pics().length === 4, JSON.stringify(record().containers.map((c) => [c.kind, c.ref])));

  console.log('\n── L1: first look, spotlight');
  await superVerb(page, `present ${site().id}`);
  await settle(page);
  ok('super present <site> is a spotlight', (await layoutOf(page)) === 'spotlight' && record().view.layout === 'spotlight', JSON.stringify(record().view));
  const siteCard = card(page, site().id);
  const prompt = siteCard.locator('[data-testid="web-loopback-prompt"]');
  await until(page, async () => (await prompt.count()) > 0, 10000);
  const promptBtn = prompt.locator('button').first();
  const pb = await box(promptBtn);
  const pbLayout = await promptBtn.evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
  ok('the trust prompt\'s buttons render at 1:1', !!pb && Math.abs(pb.width - pbLayout.w) < 1.5 && Math.abs(pb.height - pbLayout.h) < 1.5, JSON.stringify({ pb, pbLayout }));
  await shot(page, 'l1-00-trust-prompt.png');
  ok('Always allow loads it', await allowLoopback(page, siteCard));
  const cb = await box(siteCard);
  ok(`the card is about 930-1010 px wide (${Math.round(cb?.width ?? 0)})`, !!cb && cb.width >= 930 && cb.width <= 1010, JSON.stringify(cb));
  let frame = null;
  await until(page, async () => { frame = siteFrames(page)[0]; return !!frame && (await frame.locator('#iw').count()) > 0; }, 10000);
  await page.waitForTimeout(800);
  ok('the page lays out at 1280 css px', (await innerWidthOf(frame)) === 1280, await innerWidthOf(frame).catch((e) => String(e)));
  const scale = Number(await siteCard.locator('iframe').getAttribute('data-desktop-scale'));
  ok(`…scaled to fit (${scale})`, scale >= 0.6 && scale < 1);
  const head = siteCard.locator('.super-card-head').first();
  const hb = await box(head);
  const hl = await head.evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
  ok('the card\'s title bar renders at 1:1', !!hb && Math.abs(hb.height - hl.h) < 1.5, JSON.stringify({ hb, hl }));
  const hits0 = dev.hits;
  const addBox = await frame.locator('#add').boundingBox();
  await page.mouse.click(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2);
  ok('a click on a button inside the scaled page registers', await until(page, async () => (await frame.locator('#clicks').textContent()) === 'clicks: 1', 4000));
  await shot(page, 'l1-01-spotlight-1440-dark.png');
  // Inspect, at that scale.
  await siteCard.getByTestId('super-zoom-inspect').click();
  ok('Inspect stays enabled at that scale and picks', await until(page, async () => (await page.locator('[data-testid="super-zoom"][data-picker="true"]').count()) > 0, 5000));
  await page.mouse.move(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2);
  await page.waitForTimeout(400);
  ok('…the outline is drawn INSIDE the page (its bridge host)', await until(page, () => frame.evaluate(() => { const h = document.querySelector('dreamcontext-inspect'); return !!h && h.style.display !== 'none'; }), 4000));
  await shot(page, 'l1-02-inspect-hover.png');
  await page.mouse.click(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2);
  const chips = page.locator('[data-testid="super-surface"] .chat-cmp-attachment-element');
  ok('…a click puts the pick in the Super\'s composer', await until(page, async () => (await chips.count()) === 1, 8000));
  ok('…and the page never saw that click', (await frame.locator('#clicks').textContent()) === 'clicks: 1');
  await page.keyboard.press('Escape');
  await until(page, async () => (await siteCard.getByTestId('super-zoom-inspect').getAttribute('aria-pressed')) === 'false', 4000);
  ok('Esc left Inspect, and only Inspect: still presenting', await presenting(page));
  await chips.first().locator('.chat-cmp-chip-x').click().catch(() => {});

  console.log('\n── L2: the mini chat and its bar');
  const cbox = await box(centre(page));
  ok(`the Super is a mini square bottom-left (${Math.round(cbox?.width ?? 0)}x${Math.round(cbox?.height ?? 0)})`, (await centre(page).getAttribute('data-chat')) === 'mini'
    && cbox.width >= 299 && cbox.width <= 381 && cbox.height >= 319 && cbox.height <= 461 && cbox.x < cb.x, JSON.stringify(cbox));
  ok('…its messages scroll', await centre(page).locator('.chat-scroll').evaluate((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)).catch(() => false));
  const sent = await superVerb(page, 'state');
  ok('…its composer types and sends', sent?.status === 0);
  await page.getByTestId('super-chat-fold').click();
  await until(page, async () => (await centre(page).getAttribute('data-chat')) === 'bar', 4000);
  await settle(page);
  const stageBox = await box(surface(page));
  const cbBar = await box(siteCard);
  ok('folded to a bar: the card spans the full content width', record().view.chat === 'bar' && cbBar.width >= stageBox.width - 2 * 24 - 2, JSON.stringify({ stage: stageBox.width, card: cbBar.width, view: record().view }));
  await shot(page, 'l2-01-bar-1440-dark.png');
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await until(page, () => surfaceShown(page), 15000))) await openChat(page, base);
  await until(page, () => surfaceShown(page), 15000);
  await settle(page);
  ok('the bar survives a reload', (await centre(page).getAttribute('data-chat')) === 'bar' && (await layoutOf(page)) === 'spotlight');
  await page.getByTestId('super-chat-fold').click();
  ok('unfolding brings the mini back', await until(page, async () => (await centre(page).getAttribute('data-chat')) === 'mini' && !record().view.chat, 4000), JSON.stringify(record().view));
  await page.getByTestId('super-chat-fold').click();
  await until(page, async () => record().view.chat === 'bar', 4000);
  await superVerb(page, 'ask Keep-the-wide-site? --options Yes|No');
  ok('a Super question for the owner draws the mini (the record keeps the bar)', await until(page, async () => (await centre(page).getAttribute('data-chat')) === 'mini', 8000) && record().view.chat === 'bar', JSON.stringify(record().view));
  await shot(page, 'l2-02-question-draws-mini.png');
  const ask = (record().queue ?? []).find((q) => q.kind === 'ask' && q.state !== 'done');
  if (ask) await superVerb(page, `queue done ${ask.id}`);
  await page.waitForTimeout(800);
  if ((await centre(page).getAttribute('data-chat')) === 'bar') await page.getByTestId('super-chat-fold').click();
  await until(page, async () => !record().view.chat, 4000);

  console.log('\n── L3: the way out');
  await superComposer(page).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  ok('Esc while typing in the composer stays in the presentation', await presenting(page));
  await page.locator('[data-testid="super-surface"] .super-others-stack').first().click();
  await until(page, async () => (await page.locator('.super-group-panel').count()) > 0, 4000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  ok('Esc with Others open closes Others only', (await page.locator('.super-group-panel').count()) === 0 && await presenting(page));
  const fullBtn = siteCard.getByTestId('super-card-fullscreen');
  if (await fullBtn.count()) {
    await fullBtn.click();
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    ok('Esc with a card full screen closes the full screen only', await presenting(page));
  } else note('the site card offers no full screen here (skipped)');
  // Nothing focused (a click on the stage could land on the band's own exit button).
  await page.evaluate(() => (document.activeElement)?.blur?.());
  ok('still presenting before the Esc', await presenting(page));
  await page.keyboard.press('Escape');
  ok('Esc goes back to the floating stage', await until(page, async () => record().view.mode === 'float' && !(await presenting(page)), 6000), JSON.stringify(record().view));
  ok('…and never folds the Agents view', (await page.locator('.agent-surface.expanded').count()) > 0 && await surfaceShown(page));
  await superVerb(page, `present ${site().id}`);
  await settle(page);
  await page.getByTestId('super-stage-exit').click();
  ok('"Back to the stage" floats it too', await until(page, async () => record().view.mode === 'float', 6000));
  await superVerb(page, `present ${site().id} ${task().id}`);
  await settle(page);
  ok('card minimize still floats the stage', await (async () => { await card(page, task().id).getByTestId('super-card-minimize').click({ force: true }); return until(page, async () => record().view.mode === 'float', 6000); })());
  await superVerb(page, `present ${site().id}`);
  await superVerb(page, 'present --off');
  ok('super present --off still works', record().view.mode === 'float');

  console.log('\n── L4: the switcher');
  await superVerb(page, `present ${task().id} ${pics()[0].id}`);
  await settle(page);
  const segs = await page.locator('[data-testid="super-layout-switch"] [data-layout]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-layout'), e.getAttribute('aria-pressed')]));
  ok('two cards: compare, grid and filmstrip are offered (no spotlight, no review), compare pressed',
    JSON.stringify(segs.map((s) => s[0])) === JSON.stringify(['compare', 'grid', 'filmstrip']) && segs.find((s) => s[0] === 'compare')?.[1] === 'true', JSON.stringify(segs));
  await page.getByTestId('super-layout-grid').focus();
  await page.keyboard.press('Enter');
  ok('a keyboard pick redraws at once', await until(page, async () => (await layoutOf(page)) === 'grid', 3000));
  ok('…and is the owner\'s on the record', await until(page, async () => record().view.layout === 'grid' && record().view.layoutBy === 'owner', 4000), JSON.stringify(record().view));
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await until(page, () => surfaceShown(page), 15000))) await openChat(page, base);
  await until(page, () => surfaceShown(page), 15000);
  await settle(page);
  ok('the pick survives a reload', (await layoutOf(page)) === 'grid' && (await page.getByTestId('super-layout-grid').getAttribute('aria-pressed')) === 'true');
  const kept = await superVerb(page, `present ${pics()[0].id} ${task().id}`);
  ok('the agent re-presenting the same cards keeps it (kept: owner_layout)', /owner_layout/.test(kept?.out ?? '') && record().view.layout === 'grid', kept?.out);

  console.log('\n── L5: the filmstrip');
  const strip = [site().id, ...pics().map((p) => p.id), task().id];
  await superVerb(page, `present ${strip.join(' ')}`);
  await settle(page);
  ok('6 cards without --layout are a filmstrip', (await layoutOf(page)) === 'filmstrip' && record().view.cards.length === 6, JSON.stringify(record().view));
  const thumbs = page.locator('[data-testid="super-surface"] .super-card-frame[data-where="thumb"]');
  const tboxes = await thumbs.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height) }; }));
  ok('the first card big, the other 5 thumbs in one row', (await card(page, site().id).getAttribute('data-where')) === 'present' && tboxes.length === 5 && new Set(tboxes.map((b) => b.y)).size === 1, JSON.stringify(tboxes));
  ok('no thumb shows a live page', (await thumbs.locator('iframe').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden').length)) === 0);
  await shot(page, 'l5-01-filmstrip-1440-dark.png');
  const t0 = await box(thumbs.nth(1));
  await page.mouse.move(t0.x + 30, t0.y + 30);
  await page.mouse.down();
  await page.mouse.move(t0.x + 200, t0.y - 200, { steps: 8 });
  ok('a thumb is never dragged', (await page.locator('.super-surface[data-dragging]').count()) === 0);
  await page.mouse.up();
  const hitsBefore = dev.hits;
  await card(page, pics()[1].id).click();
  ok('a press on a thumb makes it the big card', await until(page, async () => (await card(page, pics()[1].id).getAttribute('data-where')) === 'present', 3000));
  ok('…the site is a thumb now, its page kept at 1280 (parked, no reload)', (await innerWidthOf(siteFrames(page)[0]).catch(() => 0)) === 1280 && dev.hits === hitsBefore, JSON.stringify({ hits: dev.hits, hitsBefore }));
  await card(page, pics()[1].id).focus().catch(() => {});
  await thumbs.first().focus();
  await page.keyboard.press('ArrowRight');
  ok('the right arrow moves the big card on', await until(page, async () => (await card(page, pics()[2].id).getAttribute('data-where')) === 'present', 3000));
  await superVerb(page, `close ${pics()[2].id}`);
  ok('when the big card leaves, the first is big again', await until(page, async () => (await card(page, site().id).getAttribute('data-where')) === 'present', 6000));
  await superVerb(page, `present ${site().id}`);
  await settle(page);
  ok('spotlight again: the page still at 1280, never reloaded', (await innerWidthOf(siteFrames(page)[0]).catch(() => 0)) === 1280 && dev.hits === hitsBefore, JSON.stringify({ hits: dev.hits }));
  await superVerb(page, `open image mockups/${PICTURES[2][0]} --no-group`);

  console.log('\n── L6: review');
  await superSay(page, `GO-DELEGATE ${ports.child}`);
  const childRef = `http://localhost:${ports.child}/`;
  ok('the child pinned its site and the server opened it (of the child)', await until(page, async () => record().containers.some((c) => c.kind === 'web' && c.ref === childRef && c.of), 45000), JSON.stringify(record().containers.map((c) => [c.kind, c.ref, c.of])));
  const childSite = record().containers.find((c) => c.kind === 'web' && c.ref === childRef);
  const childChat = record().containers.find((c) => c.kind === 'chat' && c.ref === childSite.of);
  await superVerb(page, `present ${childSite.id} ${childChat.id}`);
  await settle(page);
  ok('its site with its chat is review', (await layoutOf(page)) === 'review' && record().view.layout === 'review', JSON.stringify(record().view));
  await allowLoopback(page, card(page, childSite.id));
  await settle(page);
  const rs = await box(card(page, childSite.id));
  const rc = await box(card(page, childChat.id));
  const rm = await box(centre(page));
  ok('the site big on top, the child\'s chat under it, the Super mini bottom-left', rs.y + rs.height <= rc.y && rs.height > rc.height && rm.x + rm.width <= rs.x && (await centre(page).getAttribute('data-chat')) === 'mini', JSON.stringify({ rs, rc, rm }));
  await shot(page, 'l6-01-review-1440-dark.png');
  await card(page, childChat.id).hover();
  await card(page, childChat.id).getByTestId('super-card-close').click({ force: true });
  await until(page, async () => (await page.getByTestId('super-close-choice').count()) > 0, 3000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  ok('Esc on a child\'s close-ask closes the ask, not the presentation', (await page.getByTestId('super-close-choice').count()) === 0 && await presenting(page));

  console.log('\n── L7: a narrow window');
  await superVerb(page, `present ${task().id} ${pics()[0].id} ${pics()[1].id}`);
  await settle(page);
  const before = JSON.stringify(record().view);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(1500);
  ok('narrow: the sheet with a tab row for the 3 cards', (await page.getByTestId('super-sheet-tab').count()) === 3 && (await surface(page).getAttribute('data-narrow')) === 'true');
  ok('…the Super\'s composer bar is visible under it', (await centre(page).getAttribute('data-chat')) === 'bar' && await superComposer(page).isVisible());
  const narrowSent = await superVerb(page, 'state');
  ok('…and usable', narrowSent?.status === 0);
  await page.getByTestId('super-sheet-tab').nth(2).click();
  ok('a tab shows its card', await until(page, async () => (await card(page, pics()[1].id).getAttribute('data-where')) === 'sheet', 3000));
  await settle(page);
  await page.waitForTimeout(800);
  await shot(page, 'l7-01-narrow-1000-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(600);
  await shot(page, 'l7-02-narrow-1000-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok('narrow: no horizontal overflow', !overflow);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1500);
  ok('widening restores the stored layout and writes nothing', (await layoutOf(page)) === 'grid' && JSON.stringify(record().view) === before, `${before} → ${JSON.stringify(record().view)}`);

  console.log('\n── L8: every layout, two sizes, light and dark');
  const sets = {
    spotlight: [site().id],
    compare: [pics()[0].id, pics()[1].id],
    grid: [task().id, pics()[0].id, pics()[1].id, site().id],
    filmstrip: [pics()[0].id, pics()[1].id, task().id, site().id, ...record().containers.filter((c) => c.kind === 'image').slice(2).map((c) => c.id)],
    review: [childSite.id, childChat.id],
  };
  for (const [size, w, h] of [['1440', 1440, 900], ['1920', 1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const [layout, ids] of Object.entries(sets)) {
      await superVerb(page, `present ${ids.join(' ')} --layout ${layout}`);
      await settle(page);
      ok(`${layout} at ${size}`, (await layoutOf(page)) === layout, `${await layoutOf(page)} ${JSON.stringify(record().view)}`);
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(500);
        await shot(page, `l8-${layout}-${size}-${scheme}.png`);
      }
      await page.emulateMedia({ colorScheme: 'dark' });
    }
  }
  if (await page.getByTestId('super-stage-exit').count()) await page.getByTestId('super-stage-exit').click();

  await context.close();
  await browser.close();
  return { errors };
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
let server = null;
const devServers = [];
try {
  if (!existsSync(CLI)) throw new Error('dist/index.js is missing: npm run build first');
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const ports = { site: await freePort(), child: await freePort() };
  devServers.push(await startDevServer(ports.site, 'Pocket Ledger'));
  devServers.push(await startDevServer(ports.child, 'Pocket Ledger (child build)'));
  server = await startServer(port);
  const r = await flow(pw, base(port), ports);
  ok('zero console and page errors', r.errors.length === 0, r.errors.slice(0, 8).join('\n'));
} catch (err) {
  results.fails.push(`crashed: ${err?.stack || err}`);
  console.error(err);
} finally {
  server?.kill();
  for (const s of devServers) s.close();
}
function base(port) { return `http://127.0.0.1:${port}`; }
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.fails.length ? 'FAIL' : 'PASS'}: ${results.pass} passed, ${results.fails.length} failed${results.fails.length ? `\n  - ${results.fails.join('\n  - ')}` : ''}`);
process.exit(results.fails.length ? 1 : 0);
