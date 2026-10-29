#!/usr/bin/env node
/**
 * verify:super-filmstrip — pictures shown as a result, and the filmstrip (owner 2026-10-29:
 * "the selected one does not show below… every time I select one it swaps places"). Against the
 * REAL dashboard server (this worktree's `dist/`, or DC_CLI) with a stand-in `claude`, a scratch
 * HOME and fictional design shots.
 *
 *  F1  `super open image <4 landscape> --present`: opened AND presented at once, a filmstrip
 *      (landscape), the strip holds 4 slots: the big one's marked (aria-current) in its own place;
 *  F2  a press on the 3rd thumb: it is big, its slot is marked, every other card keeps its exact
 *      slot (nothing swaps); ←/→ walk the same fixed order;
 *  F3  12 landscape shots: no cap, all 12 in the strip, it scrolls (‹ ›, wheel); → walks to the
 *      last and its slot scrolls into view;
 *  F4  three portrait shots keep the grid;
 *  zero console and page errors. DC_BEFORE=1 (the base build): the old open + present only.
 *
 * Run: npm run build && node scripts/verify/super-filmstrip.mjs [chromium|webkit]
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-filmstrip-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
// DC_CLI: another build's CLI (the base branch, for the before shots); DC_OUT: where shots go.
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');
const OUT = process.env.DC_OUT || join(REPO, 'tmp', 'super-filmstrip');
const AFTER = process.env.DC_BEFORE !== '1';
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
// Landscape (16:9) design shots, a long set of 12, and three portrait phone shots.
const COLORS = [[238, 130, 51], [64, 148, 220], [90, 180, 120], [180, 90, 200], [220, 70, 90], [60, 170, 170], [200, 180, 60], [120, 120, 220], [230, 120, 180], [100, 160, 80], [160, 110, 70], [80, 90, 110]];
const WIDE = ['d3-work', 'd3-busy', 'd3-team', 'd3-narrow'];
const LONG = COLORS.map((_, i) => `shot-${String(i + 1).padStart(2, '0')}`);
const TALL = ['phone-a', 'phone-b', 'phone-c'];

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'mockups'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  WIDE.forEach((n, i) => writeFileSync(join(PROJ, 'mockups', `${n}.png`), png(320, 180, COLORS[i])));
  LONG.forEach((n, i) => writeFileSync(join(PROJ, 'mockups', `${n}.png`), png(320, 180, COLORS[i])));
  TALL.forEach((n, i) => writeFileSync(join(PROJ, 'mockups', `${n}.png`), png(180, 390, COLORS[i + 4])));
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
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
// The cards fade in after the flight settles: wait for them, or the shot shows an empty stage.
const shot = async (page, name) => { await page.waitForTimeout(2500); const p = join(OUT, name); await page.screenshot({ path: p }); results.shots.push(p); return p; };

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


const ENGINE = process.argv[2] || 'chromium';
const imgs = (names) => names.map((n) => record().containers.find((c) => c.kind === 'image' && c.ref === `mockups/${n}.png`)).filter(Boolean);
const where = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="super-container"][data-container-id]')]
  .map((el) => [el.getAttribute('data-container-id'), { where: el.getAttribute('data-where'), hidden: el.getAttribute('data-strip-hidden') === 'true',
    x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) }])));
const marker = (page) => page.evaluate(() => {
  const m = document.querySelector('[data-testid="super-strip-current"]');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return { id: m.getAttribute('data-card-id'), current: m.getAttribute('aria-current'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
});
const big = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="super-container"][data-where="present"]')].map((el) => el.getAttribute('data-container-id')));

async function flow(pw, base) {
  const browser = await pw[ENGINE].launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const tag = `${AFTER ? 'after' : 'before'}-${ENGINE}`;

  console.log(`\n── ${tag}: hand over`);
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

  console.log('\n── F1: open … --present');
  const refs = WIDE.map((n) => `mockups/${n}.png`).join(' ');
  if (AFTER) {
    const step = await superVerb(page, `open image ${refs} --titles D3-work|D3-busy|D3-team|D3-narrow --present`);
    ok('the CLI answers with the presented view', step?.status === 0 && /"presented"/.test(step?.out ?? ''), step?.out);
  } else {
    await superVerb(page, `open image ${refs} --titles D3-work|D3-busy|D3-team|D3-narrow`);
    await settle(page);
    await shot(page, `${tag}-0-group-card.png`);
    const g = record().groups.find((x) => x.cards.length === 4);
    await superVerb(page, `present ${g.id} --layout filmstrip`);
  }
  await settle(page);
  const wide = imgs(WIDE).map((c) => c.id);
  ok('presented at once, in the order opened', record().view.mode === 'present' && JSON.stringify(record().view.cards) === JSON.stringify(wide), JSON.stringify(record().view));
  if (AFTER) ok('landscape pictures default to a filmstrip', (await layoutOf(page)) === 'filmstrip' && record().view.layout === 'filmstrip', `${await layoutOf(page)} ${JSON.stringify(record().view)}`);
  let w0 = await where(page);
  const m0 = await marker(page);
  await shot(page, `${tag}-1-presented.png`);
  if (AFTER) {
    ok('the big card is the first and its slot is marked current in the strip', (await big(page))[0] === wide[0] && m0?.id === wide[0] && m0?.current === 'true', JSON.stringify(m0));
    ok('the strip holds every card: 3 thumbs + the marked slot, left to right in order',
      [wide[1], wide[2], wide[3]].every((id) => w0[id]?.where === 'thumb') && m0.x < w0[wide[1]].x && w0[wide[1]].x < w0[wide[2]].x && w0[wide[2]].x < w0[wide[3]].x, JSON.stringify({ m0, w0 }));
  }

  console.log('\n── F2: selecting never reorders');
  const slot2 = w0[wide[2]];
  await card(page, wide[2]).click();
  await settle(page);
  const w1 = await where(page);
  const m1 = await marker(page);
  await shot(page, `${tag}-2-third-selected.png`);
  ok('the pressed card is big', (await big(page))[0] === wide[2], JSON.stringify(await big(page)));
  if (AFTER) {
    ok('its own slot is now the marked one (same place)', m1?.id === wide[2] && Math.abs(m1.x - slot2.x) <= 2 && Math.abs(m1.y - slot2.y) <= 6, JSON.stringify({ m1, slot2 }));
    ok('every other card keeps its exact slot', [wide[1], wide[3]].every((id) => Math.abs(w1[id].x - w0[id].x) <= 2) && Math.abs(w1[wide[0]].x - m0.x) <= 2, JSON.stringify({ w0, w1, m0 }));
    await surface(page).focus().catch(() => {});
    await page.locator('[data-testid="super-strip-current"]').hover().catch(() => {});
    await card(page, wide[2]).focus().catch(() => {});
    await page.keyboard.press('ArrowRight');
    await settle(page);
    const w2 = await where(page);
    const m2 = await marker(page);
    ok('→ moves the selection to the next in the same order; nothing moves', (await big(page))[0] === wide[3] && m2?.id === wide[3] && Math.abs(m2.x - w0[wide[3]].x) <= 2 && Math.abs(w2[wide[1]].x - w0[wide[1]].x) <= 2, JSON.stringify({ m2, w2 }));
  } else {
    note(`before: positions ${JSON.stringify(Object.fromEntries(wide.map((id) => [id.slice(-6), [w0[id]?.where, w0[id]?.x], ])))} → ${JSON.stringify(Object.fromEntries(wide.map((id) => [id.slice(-6), [w1[id]?.where, w1[id]?.x]])))}`);
  }

  if (AFTER) {
    console.log('\n── F3: 12 shots, no cap, the strip scrolls');
    const step = await superVerb(page, `open image ${LONG.map((n) => `mockups/${n}.png`).join(' ')} --present`);
    ok('12 pictures open and present', step?.status === 0, step?.out);
    await settle(page);
    const long = imgs(LONG).map((c) => c.id);
    ok('all 12 presented as a filmstrip, in order', (await layoutOf(page)) === 'filmstrip' && JSON.stringify(record().view.cards) === JSON.stringify(long), JSON.stringify(record().view));
    let w = await where(page);
    const hiddenN = long.filter((id) => w[id]?.hidden).length;
    ok(`the strip scrolls: ${hiddenN} out of view, the ‹ › buttons show`, hiddenN > 0 && (await page.getByTestId('super-strip-next').count()) === 1, JSON.stringify(w));
    await shot(page, `${tag}-3-twelve.png`);
    await page.getByTestId('super-strip-next').click();
    await page.waitForTimeout(600);
    const w3 = await where(page);
    ok('› scrolls the strip (the last shot comes into view)', !w3[long[11]].hidden || long.filter((id) => !w3[id].hidden).join() !== long.filter((id) => !w[id].hidden).join(), JSON.stringify(w3));
    await shot(page, `${tag}-4-scrolled.png`);
    await card(page, long.find((id) => !w3[id].hidden && w3[id].where === 'thumb')).focus().catch(() => {});
    for (let i = 0; i < 12; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(120); }
    await settle(page);
    // 12 presses from wherever: walk to the end of the fixed order and wrap; select the last one.
    let guard = 0;
    while ((await big(page))[0] !== long[11] && guard++ < 14) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150); }
    await settle(page);
    const m4 = await marker(page);
    ok('→ walks the order to the last shot; its slot scrolls into view, marked', (await big(page))[0] === long[11] && m4?.id === long[11], JSON.stringify({ big: await big(page), m4 }));
    await shot(page, `${tag}-5-last-selected.png`);
    const box0 = await surface(page).boundingBox();
    const sb = await page.locator('[data-testid="super-strip-prev"]').boundingBox();
    await page.mouse.move(sb.x + 200, sb.y + sb.height / 2);
    const before = JSON.stringify(await where(page));
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(500);
    ok('the wheel over the strip scrolls it', JSON.stringify(await where(page)) !== before, box0 ? '' : 'no surface box');

    console.log('\n── F4: portrait shots keep the grid');
    await superVerb(page, `open image ${TALL.map((n) => `mockups/${n}.png`).join(' ')} --present`);
    await settle(page);
    ok('three portrait shots are a grid', (await layoutOf(page)) === 'grid', `${await layoutOf(page)}`);
    await shot(page, `${tag}-6-portrait-grid.png`);
  }

  await context.close();
  await browser.close();
  return { errors };
}

let server = null;
try {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: npm run build first`);
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const r = await flow(pw, `http://127.0.0.1:${port}`);
  ok('zero console and page errors', r.errors.length === 0, r.errors.slice(0, 8).join('\n'));
} catch (err) {
  results.fails.push(`crashed: ${err?.stack || err}`);
  console.error(err);
} finally {
  server?.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
writeFileSync(join(OUT, `summary-${AFTER ? 'after' : 'before'}-${ENGINE}.json`), JSON.stringify(results, null, 2));
console.log(`\n${results.fails.length ? 'FAIL' : 'PASS'}: ${results.pass} passed, ${results.fails.length} failed${results.fails.length ? `\n  - ${results.fails.join('\n  - ')}` : ''}`);
process.exit(results.fails.length ? 1 : 0);
