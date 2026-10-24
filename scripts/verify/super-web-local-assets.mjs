#!/usr/bin/env node
/**
 * A PROJECT web page on a Super web card shows its own pictures and stylesheets (owner
 * 2026-10-22 18:57: a mockup `akis.html` opened with `super open web` drew every
 * `<img src="sonra/1-pano.png">` as an empty box, "external stylesheets, images and scripts are
 * not loaded"). Stage harness derived from super-stage-fixes.mjs.
 *
 *   npm run build && node scripts/verify/super-web-local-assets.mjs
 *   VERIFY_PAGE_DIR=<a folder with akis.html> node scripts/verify/super-web-local-assets.mjs
 *
 * WHAT IT DRIVES — the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium, and a scripted stand-in `claude` that, as the Super Agent, opens
 * `_dream_context/tmp/share-sheet-v6/akis.html` as a web card (no tokens spent). The page is a
 * fictional ("Pocket Ledger") before/after mockup: sibling pictures in `once/` and `sonra/`, each
 * wrapped in `<a href>` to itself, a sibling stylesheet, a picture on another local server (the
 * "web"), a picture outside the project, one in the project but outside the page's folder, one over
 * the 8 MB cap, and a script that builds an <img> from a JS string. With VERIFY_PAGE_DIR the given folder is copied in
 * as `_dream_context/tmp/gorev-arayuzu-taslak/v6/` and opened too (the owner's own draft).
 *
 * WHAT IT PROVES — every project picture decodes in the sandboxed frame (naturalWidth > 0); the
 * sibling stylesheet applies; the frame's CSP is still `default-src 'none'` (the fix inlines, it
 * does not relax); the picture on the web is NOT requested (its server counts zero hits) and the
 * pictures outside the project, outside the page's folder and over the cap stay unloaded; the
 * script still parses and runs; clicking a picture's wrapping link does not
 * navigate the card away. Screenshots: tmp/super-web-local-assets/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-web-local-assets-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-web-local-assets');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const PAGE_DIR = process.env.VERIFY_PAGE_DIR || '';
const SYNTH = '_dream_context/tmp/share-sheet-v6';
const OWNER = '_dream_context/tmp/gorev-arayuzu-taslak/v6';

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
      cli('super', 'open', 'web', '_dream_context/tmp/share-sheet-v6/akis.html'),
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

/** The fictional mockup: pictures beside it, a stylesheet beside it, one on the web, one outside. */
function mockup(sitePort) {
  const fig = (href, alt) => `<figure><a href="${href}"><img src="${href}" alt="${alt}"></a><figcaption>${alt}</figcaption></figure>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Share sheet v6</title>
<link rel="stylesheet" href="stil.css"></head><body>
<h1 id="title">Share sheet: before and after</h1>
<h2>Before</h2>${fig('once/0-sheet.png', '0. Four taps to share')}
<h2>After</h2>${fig('sonra/1-sheet.png', '1. One tap opens the sheet')}${fig('sonra/2-contacts.png', '2. Recent contacts')}
<p><img id="web" src="http://127.0.0.1:${sitePort}/leak.png" alt="on the web"><img id="outside" src="../../../../outside.png" alt="outside the project">
<img id="sibling" src="../brain-shot.png" alt="in the project, outside the page folder"><img id="huge" src="sonra/huge.png" alt="over the size cap"></p>
<div id="gallery"></div>
<script>var tile = "<img id='built' src='sonra/1-sheet.png' alt='built'>"; document.getElementById('gallery').innerHTML = tile; document.body.dataset.scriptRan = 'yes';</script>
</body></html>`;
}

function setupScratch(sitePort) {
  rmSync(SCRATCH, { recursive: true, force: true });
  const synth = join(PROJ, SYNTH);
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(synth, 'once'), join(synth, 'sonra'), OUT]) mkdirSync(d, { recursive: true });
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
  const png = join(REPO, 'public', 'image', 'diagram-recall.png');
  for (const p of ['once/0-sheet.png', 'sonra/1-sheet.png', 'sonra/2-contacts.png']) copyFileSync(png, join(synth, p));
  copyFileSync(png, join(SCRATCH, 'outside.png'));
  copyFileSync(png, join(PROJ, '_dream_context', 'tmp', 'brain-shot.png'));
  // A real picture padded past the 8 MB cap (bytes after IEND are ignored by decoders).
  writeFileSync(join(synth, 'sonra', 'huge.png'), Buffer.concat([readFileSync(png), Buffer.alloc(9 * 1024 * 1024)]));
  writeFileSync(join(synth, 'stil.css'), 'h1#title { color: rgb(201, 42, 42); letter-spacing: 3px; }\nimg { max-width: 100%; border-radius: 8px; }\n');
  writeFileSync(join(synth, 'akis.html'), mockup(sitePort));
  if (PAGE_DIR) cpSync(PAGE_DIR, join(PROJ, OWNER), { recursive: true });
}

/** The "web": a local server standing in for any remote host; it counts what it is asked for. */
async function startSite(port) {
  const http = await import('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'image/png' }); res.end(readFileSync(join(REPO, 'public', 'image', 'diagram-recall.png'))); });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { srv, hits };
}

/** The sandboxed frame inside a web card. */
async function frameOf(page, id) {
  const el = await card(page, id).locator('iframe.doc-reader-html-frame').first().elementHandle({ timeout: 20000 });
  return el.contentFrame();
}
/** Every picture in the frame: id/alt, src kind, natural width, once each has settled. */
async function pictures(frame) {
  await frame.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
  return frame.evaluate(() => [...document.images].map((i) => ({ id: i.id || i.alt, w: i.naturalWidth, src: i.getAttribute('src').slice(0, 22) })));
}

let server = null;
let site = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  const port = await freePort();
  const sitePort = await freePort();
  setupScratch(sitePort);
  server = await startServer(port);
  site = await startSite(sitePort);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Content Security Policy|leak\.png|ERR_BLOCKED/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── the agent opens the project mockup as a web card');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super agent opened the page', await until(page, async () => !!idOf(`${SYNTH}/akis.html`), 60000));
  await settle(page);
  const id = idOf(`${SYNTH}/akis.html`);
  ok('the page is drawn in its frame', await until(page, async () => (await card(page, id).locator('iframe.doc-reader-html-frame').count()) > 0, 20000));
  const frame = await frameOf(page, id);

  console.log('\n── its pictures and stylesheet show; nothing else is let in');
  const pics = await pictures(frame);
  console.log(`  · ${JSON.stringify(pics)}`);
  const local = pics.filter((p) => !['web', 'outside', 'sibling', 'huge', 'built'].includes(p.id));
  ok('three project pictures are in the page', local.length === 3, JSON.stringify(pics));
  ok('…every one decodes (naturalWidth > 0), carried in as data: URLs', local.every((p) => p.w > 0 && p.src.startsWith('data:image/png')), JSON.stringify(local));
  const h1 = await frame.evaluate(() => { const s = getComputedStyle(document.getElementById('title')); return { color: s.color, ls: s.letterSpacing }; });
  ok('the sibling stylesheet applies (heading colour and spacing)', h1.color === 'rgb(201, 42, 42)' && h1.ls === '3px', JSON.stringify(h1));
  const csp = await frame.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
  ok("the frame's CSP is unchanged: default-src 'none', img-src data: only", csp.includes("default-src 'none'") && /img-src data:$|img-src data:;/.test(csp) && !/https?:|'self'|blob:/.test(csp), csp);
  ok('the picture on the web stays blocked (naturalWidth 0)', pics.find((p) => p.id === 'web')?.w === 0, JSON.stringify(pics));
  ok('…and its server was never asked for it', site.hits.length === 0, JSON.stringify(site.hits));
  ok('the picture outside the project stays unloaded', pics.find((p) => p.id === 'outside')?.w === 0, JSON.stringify(pics));
  ok('a project picture outside the page\'s own folder stays unloaded', pics.find((p) => p.id === 'sibling')?.w === 0, JSON.stringify(pics));
  ok('a picture over the 8 MB cap stays unloaded', pics.find((p) => p.id === 'huge')?.w === 0, JSON.stringify(pics));
  const ran = await frame.evaluate(() => ({ ran: document.body.dataset.scriptRan, built: document.getElementById('built')?.getAttribute('src') }));
  ok('a script building <img> from a JS string still parses and runs (its markup untouched)', ran.ran === 'yes' && ran.built === 'sonra/1-sheet.png', JSON.stringify(ran));
  await card(page, id).screenshot({ path: join(OUT, '1-card.png') });
  await shot(page, '1-stage');

  console.log('\n── a picture\'s link does not take the card away');
  await frame.locator('a[href="sonra/1-sheet.png"] img').click();
  await page.waitForTimeout(1500);
  ok('the frame is still there (not torn down)', (await card(page, id).locator('iframe.doc-reader-html-frame').count()) === 1);
  ok('…with no "tried to open another page" notice', (await card(page, id).locator('[role="alert"]').count()) === 0);
  const after = await pictures(await frameOf(page, id));
  ok('…and still the same page, its pictures shown', after.filter((p) => p.w > 0).length === 3, JSON.stringify(after));

  if (PAGE_DIR) {
    console.log(`\n── the owner's draft (${PAGE_DIR})`);
    const s = await agent(page, `super open web ${OWNER}/akis.html`);
    ok('`super open web` on the draft succeeded', s && s.status === 0, JSON.stringify(s));
    const oid = idOf(`${OWNER}/akis.html`);
    ok('the draft is drawn in its frame', await until(page, async () => (await card(page, oid).locator('iframe.doc-reader-html-frame').count()) > 0, 20000));
    const of = await frameOf(page, oid);
    const op = await pictures(of);
    console.log(`  · ${JSON.stringify(op)}`);
    ok('every picture in the draft decodes (naturalWidth > 0)', op.length > 0 && op.every((p) => p.w > 0), JSON.stringify(op));
    await card(page, oid).screenshot({ path: join(OUT, '2-owner-card.png') });
    await of.evaluate(() => document.querySelectorAll('img')[1]?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(600);
    await card(page, oid).screenshot({ path: join(OUT, '2-owner-card-scrolled.png') });
    await shot(page, '2-owner-stage');
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
  if (site) site.srv.close();
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${OUT}`);
process.exit(fails.length === 0 ? 0 : 1);
