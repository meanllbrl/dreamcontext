#!/usr/bin/env node
/**
 * verify:super-web-session — the Super stage's web card keeps its page's session, clears it on
 * the owner's word, and hands a picked element to the Super Agent's composer (owner 2026-10-22).
 * Against the REAL dashboard server (this worktree's `dist/`) in Chromium, a stand-in `claude`
 * and a scratch HOME; a tiny dev server stands in for the owner's app.
 *
 *  P1  an allowed dev-server page loads through the session proxy (127.0.0.1:<proxy>, never
 *      localhost and never the dashboard); its own JS still cannot reach the chat socket or the API;
 *  P2  a login (an HttpOnly cookie), a counter in the page's memory and a note in localStorage
 *      survive: side by side → minimised tile → wide card → Others → back → a group → out, with
 *      ZERO page loads on the dev server (the frame is never rebuilt);
 *  P3  Reload: the page loads again; the login and the note stay, the counter resets;
 *  P4  an app restart (server restart + a fresh browser context carrying only the cookies, as
 *      WKWebView keeps them): still signed in, the note back from the disk snapshot;
 *  P5  Clear cache asks first in the bar, then: signed out, the note and IndexedDB gone, the
 *      snapshot forgotten;
 *  P6  Inspect: hover outlines, a click picks (the page never sees it), two picks = two chips in
 *      the Super Agent's composer (component, selector, text, a picture), Esc leaves; a send carries
 *      the blocks with the picture's path; a chip can be removed;
 *  P7  screenshots at 1440 and 390 px, read by the run's author; console errors recorded.
 *
 * Run: npm run build && npm run verify:super-web-session. Output: tmp/verify-super-web-session/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-web-session-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-web-session');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');

// ─── the stand-in `claude`: the super runs `GO-SUPER <verb> <args…>` as `dreamcontext super …` ──
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-websess-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
let inited = false;
async function turn(blocks) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  const text = blocks.join('\\n');
  let said = 'ok';
  if (role === 'super') {
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); said = 'arranged'; }
    else {
      const m = text.match(/GO-SUPER\\s+(.+)$/m);
      if (m) { const step = cli('super', ...m[1].trim().split(/\\s+/)); report({ kind: 'super', step }); said = 'did ' + m[1]; }
    }
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
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], groups: [] }; } };

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  if (dc('tasks', 'create', 'Ship the pricing page', '-w', 'The pricing card.').status !== 0) throw new Error('task create failed');
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

/** The owner's app, in miniature: a login cookie, a counter in memory, a note in localStorage,
 *  an IndexedDB record, a "React" tree (fiber expandos) for the picker, and a page script that
 *  tries what an approved page must never do. */
const dev = { hits: 0, port: 0, otherPort: 0 };
function startDevServer(port, dashPort) {
  dev.port = port;
  const page = (signedIn) => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Bekleyen işler (yerel deneme)</title>
<style>
body{margin:0;font:15px -apple-system,system-ui,sans-serif;background:#fff7f0;color:#222}
header{display:flex;gap:18px;align-items:center;padding:14px 22px;background:#fff;border-bottom:1px solid #f0e2d6}
.logo{font:800 24px system-ui}.logo b{color:#ee8233}#who{margin-left:auto;font-weight:600}
main{padding:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
.card{background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 4px 18px rgba(0,0,0,.07)}
.cta{display:inline-block;background:#ee8233;color:#fff;font-weight:700;padding:11px 18px;border-radius:12px;border:0;font-size:14px;cursor:pointer}
.price{font:800 28px system-ui;margin:6px 0 12px}input{font:inherit;padding:8px;border:1px solid #ddd;border-radius:8px;width:90%}
small{color:#888}
</style></head>
<body><header><span class="logo">Tilki<b>.</b></span><span id="who">${signedIn ? 'Signed in as Defne' : 'Signed out'}</span>${signedIn ? '' : '<a id="login" class="cta" href="/login">Giriş yap</a>'}</header>
<main>
<section class="card" id="counter-card"><h2>Bekleyen işler</h2><p>Bugün tamamlanan: <b id="count">0</b></p><button id="inc" class="cta">+1 ders</button></section>
<section class="card pricing" data-testid="pricing"><h2>Fiyat</h2><p class="price">₺249 / ay</p><button class="cta" id="start">30 GÜN ÜCRETSİZ BAŞLA</button><p><small id="clicked">start clicks: 0</small></p></section>
<section class="card"><label>Not <input id="note" placeholder="bir not"></label><p id="noteShown"></p><p id="idb">idb: ?</p><p id="jsCookie"></p><p id="ws">ws: pending</p><p id="post">post: pending</p></section>
</main>
<script>
document.cookie = 'theme=dark; path=/; max-age=86400';
document.getElementById('jsCookie').textContent = 'js cookies: ' + document.cookie;
let n = 0; const count = document.getElementById('count');
document.getElementById('inc').onclick = () => { n++; count.textContent = n; };
let starts = 0; document.getElementById('start').onclick = () => { starts++; document.getElementById('clicked').textContent = 'start clicks: ' + starts; };
const note = document.getElementById('note'); const shown = document.getElementById('noteShown');
note.value = localStorage.getItem('note') || ''; shown.textContent = 'saved: ' + (localStorage.getItem('note') || '');
note.oninput = () => { localStorage.setItem('note', note.value); shown.textContent = 'saved: ' + note.value; };
const fiber = (name, parent) => ({ type: { name }, return: parent });
const app = fiber('TilkiApp', null);
document.querySelector('.pricing')['__reactFiber$v3rify'] = fiber('PricingCard', fiber('LandingPage', app));
document.getElementById('start')['__reactFiber$v3rify'] = { type: 'button', return: fiber('StartButton', fiber('PricingCard', fiber('LandingPage', app))) };
const r = indexedDB.open('tilki-db', 1);
r.onupgradeneeded = () => r.result.createObjectStore('s');
r.onsuccess = () => { const st = r.result.transaction('s', 'readwrite').objectStore('s'); const g = st.get('k'); g.onsuccess = () => { document.getElementById('idb').textContent = 'idb: ' + (g.result || 'none'); st.put('v', 'k'); }; };
const ws = new WebSocket('ws://127.0.0.1:${dashPort}/api/agent/chat?vault=acme-app&bypass=1');
ws.onopen = () => { document.getElementById('ws').textContent = 'ws: OPENED'; };
ws.onerror = () => { document.getElementById('ws').textContent = 'ws: refused'; };
fetch('http://127.0.0.1:${dashPort}/api/automations', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'pwn', prompt: 'x' }) })
  .then((x) => { document.getElementById('post').textContent = 'post: ' + x.status; }, () => { document.getElementById('post').textContent = 'post: refused'; });
</script></body></html>`;
  const srv = createServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(302, { Location: `http://localhost:${port}/`, 'Set-Cookie': 'sid=defne; Domain=localhost; Path=/; HttpOnly; SameSite=Lax' });
      res.end();
      return;
    }
    if (req.url === '/' || req.url?.startsWith('/?')) {
      dev.hits++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(/(^|;\s*)sid=defne/.test(req.headers.cookie ?? '')));
      return;
    }
    res.writeHead(404); res.end();
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
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
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
const surfaceShown = (page) => page.locator('[data-testid="super-surface"]:visible').count().then((n) => n > 0);
const superComposer = (page) => page.locator('[data-testid="super-surface"] .chat-cmp-input:visible').first();
async function sayToSuper(page, text) {
  const input = superComposer(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
let superCalls = 0;
async function superVerb(page, args) {
  const before = reports().filter((r) => r.kind === 'super').length;
  await sayToSuper(page, `GO-SUPER ${args}`);
  const done = await until(page, async () => reports().filter((r) => r.kind === 'super').length > before, 30000);
  const last = reports().filter((r) => r.kind === 'super').at(-1);
  superCalls++;
  if (!done || last?.step?.status !== 0) note(`super ${args} → ${JSON.stringify(last?.step ?? null).slice(0, 300)}`);
  await page.waitForTimeout(900);
  return last?.step;
}
const webCard = (page) => page.locator('.super-card-frame[data-kind="web"]').first();
/** The page's bridge is picking (its own overlay is up): the card's toggle reaches it by postMessage. */
const bridgeInspecting = (frame) => frame.evaluate(() => { const h = document.querySelector('dreamcontext-inspect'); return !!h && h.style.display !== 'none'; }).catch(() => false);
const cardFrame = (page, origin) => page.frames().find((f) => f.url().startsWith(origin));
async function frameState(frame) {
  return frame.evaluate(() => ({
    alive: window.__alive ?? null,
    who: document.getElementById('who')?.textContent ?? '',
    count: document.getElementById('count')?.textContent ?? '',
    note: localStorage.getItem('note'),
    idb: document.getElementById('idb')?.textContent ?? '',
    jsCookie: document.cookie,
    ws: document.getElementById('ws')?.textContent ?? '',
    post: document.getElementById('post')?.textContent ?? '',
    href: location.href,
  }));
}

// ─── the flow ───────────────────────────────────────────────────────────────────────────
async function flow(pw, base, dashPort, restart) {
  const browser = await pw.chromium.launch();
  let context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 900 } } });
  let page = await context.newPage();
  const errors = [];
  const consoleLog = createWriteStream(join(OUT, 'console.log'));
  const watch = (p) => {
    p.on('console', (m) => { consoleLog.write(`[${m.type()}] ${m.text()}\n`); if (m.type() === 'error') errors.push(m.text()); });
    p.on('pageerror', (e) => errors.push(String(e)));
  };
  watch(page);

  console.log('\n── hand over, open the dev server as a card');
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
  await until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
  await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000);
  const siteRef = `http://localhost:${dev.port}/`;
  await superVerb(page, `open web ${siteRef}`);
  const taskSlug = 'ship-the-pricing-page';
  await superVerb(page, `open task ${taskSlug}`);
  const web = () => record().containers.find((c) => c.kind === 'web' && c.ref === siteRef);
  ok('the web card is on the stage', await until(page, async () => (await webCard(page).count()) > 0, 15000), JSON.stringify(record().containers));
  await webCard(page).click({ position: { x: 40, y: 40 } });
  ok('side by side it asks first (Open once / Always allow)', await until(page, async () => (await page.getByTestId('web-loopback-prompt').count()) > 0, 10000));
  await page.waitForTimeout(700);
  await page.locator('[data-testid="web-loopback-prompt"] button').nth(1).click();

  console.log('\n── P1: through the session proxy');
  ok('the page loads in the card', await until(page, async () => (await webCard(page).locator('iframe').count()) > 0, 10000));
  const src = await webCard(page).locator('iframe').getAttribute('src');
  const proxy = new URL(src).origin;
  ok('…from 127.0.0.1:<proxy>, neither localhost nor the dashboard\'s port', /^http:\/\/127\.0\.0\.1:\d+$/.test(proxy) && !proxy.endsWith(`:${dashPort}`) && !proxy.endsWith(`:${dev.port}`), src);
  let frame = null;
  await until(page, async () => { frame = cardFrame(page, proxy); return !!frame && (await frame.locator('#who').count()) > 0; }, 10000);
  ok('the dev page drew, with the bridge in it', !!frame && await frame.evaluate(() => window.__dreamWebCardBridge === true));
  await page.waitForTimeout(1200);
  let st = await frameState(frame);
  ok('T0: the page\'s own JS still cannot open the chat socket', /refused/.test(st.ws), st.ws);
  ok('T3: …nor POST to the API', !/post: 2\d\d/.test(st.post) && !existsSync(join(PROJ, '_dream_context', 'automations', 'pwn.md')), st.post);

  console.log('\n── P2: sign in, work, then move the card everywhere');
  await frame.locator('#login').click();
  await until(page, async () => { frame = cardFrame(page, proxy); return /Signed in/.test((await frameState(frame)).who); }, 10000);
  for (let i = 0; i < 3; i++) await frame.locator('#inc').click();
  await frame.locator('#note').fill('kept note');
  await frame.evaluate(() => { window.__alive = 'token-' + Math.random(); });
  st = await frameState(frame);
  ok('signed in (an HttpOnly cookie through the proxy), counter 3, a note in localStorage', /Signed in as Defne/.test(st.who) && st.count === '3' && st.note === 'kept note', JSON.stringify(st));
  const token = st.alive;
  const hits0 = dev.hits;
  await page.waitForTimeout(800);
  await shot(page, 'web-01-signed-in-side-by-side.png');
  const sameDoc = async (label) => {
    const f = cardFrame(page, proxy);
    const s = f ? await frameState(f).catch((e) => ({ err: String(e) })) : { err: 'no frame' };
    return ok(`${label}: the same page (no reload), signed in, counter 3, the note`, s.alive === token && s.count === '3' && /Signed in/.test(s.who) && s.note === 'kept note' && dev.hits === hits0, JSON.stringify({ ...s, hits: dev.hits, hits0 }));
  };
  await page.locator('[data-testid="super-card-minimize"]').first().click({ force: true });
  await until(page, async () => (await page.locator('[data-mode="float"]').count()) > 0, 8000);
  await page.waitForTimeout(1200);
  ok('minimised: a floating card', (await page.locator('[data-testid="super-web-card"][data-web-state="float"]').count()) > 0, await page.locator('[data-testid="super-web-card"]').first().getAttribute('data-web-state').catch(() => 'none'));
  await sameDoc('floating');
  // The owner's size menu: down to a 1×1 tile, then up to wide.
  const sizeTo = async (size) => {
    const card = webCard(page);
    await card.hover();
    const more = card.locator('[data-testid="super-card-more"]');
    if (await more.count()) await more.click({ force: true }); else await card.locator('[data-testid="super-card-size-btn"]').click({ force: true });
    await page.getByTestId(`super-size-${size}`).click();
    await page.waitForTimeout(1200);
  };
  await sizeTo('small');
  ok('sized small: a 1×1 tile, its page hidden under it', (await page.locator('[data-testid="super-web-card"][data-web-state="tile"]').count()) > 0, await page.locator('[data-testid="super-web-card"]').first().getAttribute('data-web-state').catch(() => 'none'));
  await sameDoc('tile');
  await shot(page, 'web-02-tile.png');
  await sizeTo('wide');
  ok('sized wide: the page drawn in the floating card', (await page.locator('[data-testid="super-web-card"][data-web-state="float"]').count()) > 0);
  await sameDoc('wide');
  await superVerb(page, `stack ${web().id}`);
  ok('in Others: kept alive, parked off the stage', await until(page, async () => (await page.locator('[data-testid="super-container-parked"][data-kind="web"]').count()) > 0, 8000));
  await sameDoc('Others');
  await shot(page, 'web-03-in-others.png');
  await superVerb(page, `half ${web().id}`);
  await until(page, async () => (await page.locator('[data-testid="super-web-card"][data-web-state="large"]').count()) > 0, 8000);
  await sameDoc('back side by side');
  await superVerb(page, 'half --off');
  await page.waitForTimeout(800);
  const task = record().containers.find((c) => c.kind === 'task');
  await superVerb(page, `group ${web().id} ${task?.id ?? ''}`);
  ok('grouped: kept alive, parked', await until(page, async () => (record().groups ?? []).length > 0 && (await page.locator('[data-testid="super-container-parked"][data-kind="web"]').count()) > 0, 8000), JSON.stringify(record().groups));
  await sameDoc('in a group');
  await shot(page, 'web-04-grouped.png');
  const gid = (record().groups ?? [])[0]?.id;
  await superVerb(page, `ungroup ${gid}`);
  await superVerb(page, `half ${web().id}`);
  await until(page, async () => (await page.locator('[data-testid="super-web-card"][data-web-state="large"]').count()) > 0, 8000);
  await page.waitForTimeout(600);
  await sameDoc('out of the group, side by side again');
  await shot(page, 'web-05-back-alive.png');

  console.log('\n── P3: Reload');
  ok('the bar has Reload, Clear cache, Inspect', (await page.getByTestId('super-zoom-reload').count()) === 1 && (await page.getByTestId('super-zoom-clear').count()) === 1 && (await page.getByTestId('super-zoom-inspect').count()) === 1);
  await page.getByTestId('super-zoom-reload').click();
  ok('the page loaded again', await until(page, async () => dev.hits === hits0 + 1, 8000), `hits ${dev.hits}`);
  await page.waitForTimeout(1000);
  frame = cardFrame(page, proxy);
  st = await frameState(frame);
  ok('…still signed in, the note kept, the counter back to 0 (memory is the page\'s own)', /Signed in/.test(st.who) && st.note === 'kept note' && st.count === '0' && st.alive === null, JSON.stringify(st));
  ok('…its IndexedDB record survived the reload', /idb: v/.test(st.idb), st.idb);
  await shot(page, 'web-06-after-reload.png');
  await page.waitForTimeout(1500); // the bridge's debounced save

  console.log('\n── P4: an app restart (the cookies kept, the frame\'s storage gone, as in WKWebView)');
  const cookies = (await context.cookies()).filter((c) => c.domain === '127.0.0.1');
  ok('the login cookie is first-party on 127.0.0.1, HttpOnly, under this session\'s own prefix', cookies.some((c) => /^dc[a-f0-9]{8}\.sid$/.test(c.name) && c.httpOnly), JSON.stringify(cookies));
  const sessKey = cookies.find((c) => /^dc[a-f0-9]{8}\.sid$/.test(c.name))?.name.slice(2, 10) ?? '';
  const snapFile = join(HOME, '.dreamcontext', 'web-sessions', `${sessKey}.json`);
  const jar = cookies.map((c) => c.name);
  ok('the page\'s own JS cookie: plain to the page, prefixed in the jar', /theme=dark/.test(st.jsCookie) && !/dc[a-f0-9]{8}\./.test(st.jsCookie) && jar.includes(`dc${sessKey}.theme`), JSON.stringify({ js: st.jsCookie, jar }));
  const snap = (() => { try { return JSON.parse(readFileSync(snapFile, 'utf-8')); } catch { return null; } })();
  ok('the page\'s localStorage is kept on disk for this dev server (0600)', snap?.localStorage?.note === 'kept note' && (statSync(snapFile).mode & 0o777) === 0o600, JSON.stringify(snap));
  await context.close();
  await restart();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 900 } } });
  await context.addCookies(cookies);
  page = await context.newPage();
  watch(page);
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  if (!(await until(page, () => surfaceShown(page), 15000))) await openChat(page, base);
  ok('the stage is back', await until(page, () => surfaceShown(page), 20000));
  await until(page, async () => (await webCard(page).count()) > 0, 15000);
  if (!(await page.locator('[data-testid="super-web-card"][data-web-state="large"]').count())) await webCard(page).click({ position: { x: 40, y: 40 } }).catch(() => {});
  ok('the allowed page loads without asking', await until(page, async () => (await webCard(page).locator('iframe').count()) > 0, 15000));
  const proxy2 = new URL(await webCard(page).locator('iframe').getAttribute('src')).origin;
  await until(page, async () => { frame = cardFrame(page, proxy2); return !!frame && (await frame.locator('#who').count()) > 0; }, 10000);
  await page.waitForTimeout(800);
  st = await frameState(frame);
  ok('after the restart: still signed in, the note restored from disk', /Signed in/.test(st.who) && st.note === 'kept note', JSON.stringify(st));
  await shot(page, 'web-07-after-restart.png');

  console.log('\n── P5: Clear cache');
  await page.getByTestId('super-zoom-clear').click();
  ok('Clear asks first, in the bar', await until(page, async () => (await page.getByTestId('super-zoom-clear-ask').count()) > 0, 4000));
  await shot(page, 'web-08-clear-ask.png');
  await page.getByTestId('super-zoom-clear-no').click();
  ok('…Cancel keeps everything', (await page.getByTestId('super-zoom-clear-ask').count()) === 0 && /Signed in/.test((await frameState(cardFrame(page, proxy2))).who));
  await page.getByTestId('super-zoom-clear').click();
  await page.getByTestId('super-zoom-clear-yes').click();
  await until(page, async () => { const f = cardFrame(page, proxy2); return !!f && /Signed out/.test((await frameState(f)).who); }, 15000);
  await page.waitForTimeout(1200);
  frame = cardFrame(page, proxy2);
  st = await frameState(frame);
  ok('after Clear: signed out, the note gone, IndexedDB empty', /Signed out/.test(st.who) && !st.note && /idb: none/.test(st.idb), JSON.stringify(st));
  ok('…the HttpOnly cookie expired', !(await context.cookies()).some((c) => /\.sid$/.test(c.name)), JSON.stringify(await context.cookies()));
  const after = (() => { try { return JSON.parse(readFileSync(snapFile, 'utf-8')); } catch { return null; } })();
  ok('…the disk snapshot forgotten', !after || !after.localStorage?.note, JSON.stringify(after));
  ok('…and the page is back where it was', new URL(st.href).pathname === '/', st.href);
  await shot(page, 'web-09-after-clear.png');

  console.log('\n── P6: Inspect → the Super Agent\'s composer');
  await frame.locator('#login').click();
  await until(page, async () => { frame = cardFrame(page, proxy2); return /Signed in/.test((await frameState(frame)).who); }, 10000);
  await page.waitForTimeout(500);
  await page.getByTestId('super-zoom-inspect').click();
  ok('Inspect picks (the page carries the bridge): no shield', await until(page, async () => (await page.locator('[data-testid="super-zoom"][data-picker="true"]').count()) > 0, 5000) && (await page.getByTestId('super-zoom-shield').count()) === 0);
  ok('…and the page\'s bridge is picking', await until(page, () => bridgeInspecting(frame), 5000));
  // Playwright's boundingBox of an element inside a frame is in the main page's coordinates.
  const startBox = await frame.locator('#start').boundingBox();
  const sp = { x: startBox.x + startBox.width / 2, y: startBox.y + startBox.height / 2 };
  await page.mouse.move(sp.x, sp.y);
  await page.waitForTimeout(300);
  await shot(page, 'web-10-inspect-hover.png');
  await page.mouse.click(sp.x, sp.y);
  const chips = page.locator('[data-testid="super-surface"] .chat-cmp-attachment-element');
  ok('a click picks: a chip in the Super Agent\'s composer', await until(page, async () => (await chips.count()) === 1, 8000));
  const startClicks = await frame.locator('#clicked').textContent();
  ok('…and the page never saw that click', startClicks === 'start clicks: 0', startClicks);
  const priceBox = await frame.locator('.price').boundingBox();
  await page.mouse.move(priceBox.x + 10, priceBox.y + priceBox.height / 2);
  await page.waitForTimeout(200);
  await page.mouse.click(priceBox.x + 10, priceBox.y + priceBox.height / 2);
  ok('a second pick: a second chip', await until(page, async () => (await chips.count()) === 2, 8000));
  ok('…the chip names the React component and the text', /StartButton · “30 GÜN ÜCRETSİZ BAŞLA”/.test(await chips.first().innerText()), await chips.first().innerText());
  ok('…with its picture as the thumbnail', (await chips.first().locator('img.chat-cmp-thumb').count()) === 1);
  await until(page, async () => (await page.locator('[data-testid="super-surface"] .chat-cmp-attachment-element[data-state="uploading"]').count()) === 0, 8000);
  await shot(page, 'web-11-two-chips.png');
  // Each chip's picture as the bridge drew it, for the reader of this run.
  const thumbs = await chips.locator('img.chat-cmp-thumb').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
  thumbs.forEach((d, i) => { const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(d ?? ''); if (m) { const f = join(OUT, `web-11c-chip-${i + 1}.${m[1] === 'png' ? 'png' : 'jpg'}`); writeFileSync(f, Buffer.from(m[2], 'base64')); results.shots.push(f); } });
  ok('both chips carry a picture', thumbs.length === 2 && thumbs.every((d) => /^data:image\//.test(d ?? '')));
  // The owner's Esc after picking: the picks never focused the page, so it lands in the window.
  await page.keyboard.press('Escape');
  ok('Esc leaves Inspect', await until(page, async () => (await page.getByTestId('super-zoom-inspect').getAttribute('aria-pressed')) === 'false', 4000));
  await page.waitForTimeout(500);
  ok('…and only Inspect: the stage stays open', await surfaceShown(page));
  await shot(page, 'web-11b-after-esc.png');
  // Esc pressed INSIDE the page (its focus there) leaves Inspect too, through the bridge.
  await page.getByTestId('super-zoom-inspect').click();
  await until(page, async () => (await page.locator('[data-testid="super-zoom"][data-picker="true"]').count()) > 0, 4000);
  await until(page, () => bridgeInspecting(frame), 5000);
  await frame.evaluate(() => { const i = document.getElementById('note'); i.focus(); });
  await frame.locator('#note').press('Escape');
  ok('Esc inside the page leaves Inspect (the bridge tells the card)', await until(page, async () => (await page.getByTestId('super-zoom-inspect').getAttribute('aria-pressed')) === 'false', 4000) && await surfaceShown(page));
  // Remove the second chip, then send with a comment.
  await chips.nth(1).locator('.chat-cmp-chip-x').click();
  ok('a chip can be removed', await until(page, async () => (await chips.count()) === 1, 4000));
  const sentBefore = readNd(FRAMES).filter((f) => f.role === 'super').length;
  await sayToSuper(page, 'bu butonu daha görünür yap');
  ok('the send reaches the Super Agent', await until(page, async () => readNd(FRAMES).filter((f) => f.role === 'super').length > sentBefore, 20000));
  const sent = readNd(FRAMES).filter((f) => f.role === 'super').at(-1)?.blocks.join('\n') ?? '';
  writeFileSync(join(OUT, 'sent-message.txt'), sent);
  ok('…carrying the comment and the element block', sent.startsWith('bu butonu daha görünür yap') && sent.includes('[Selected element on card @card:')
    && sent.includes(`page: http://localhost:${dev.port}/`) && /selector: .*#start|selector: .*start/.test(sent) && sent.includes('text: "30 GÜN ÜCRETSİZ BAŞLA"')
    && sent.includes('react: StartButton ← PricingCard ← LandingPage') && /box: x \d+, y \d+, \d+×\d+ in a \d+×\d+ view/.test(sent), sent);
  const pic = /picture: '?([^'\n]+\.png)'?/.exec(sent)?.[1];
  ok('…and the picture\'s path, a real PNG', !!pic && existsSync(pic) && readFileSync(pic).subarray(1, 4).toString() === 'PNG', pic);
  if (pic && existsSync(pic)) { copyFileSync(pic, join(OUT, 'web-12-picked-element.png')); results.shots.push(join(OUT, 'web-12-picked-element.png')); }
  ok('…and only the chip that was left (the removed one did not go)', (sent.match(/\[Selected element/g) ?? []).length === 1, sent);
  ok('the chips left with the send', await until(page, async () => (await chips.count()) === 0, 4000));
  await page.waitForTimeout(800);
  await shot(page, 'web-13-sent.png');

  console.log('\n── P6b: a send right after a pick still carries its picture');
  await page.getByTestId('super-zoom-inspect').click();
  await until(page, async () => (await page.locator('[data-testid="super-zoom"][data-picker="true"]').count()) > 0, 5000);
  await until(page, () => bridgeInspecting(frame), 5000);
  const incBox = await frame.locator('#inc').boundingBox();
  const before2 = readNd(FRAMES).filter((f) => f.role === 'super').length;
  await page.mouse.click(incBox.x + incBox.width / 2, incBox.y + incBox.height / 2);
  ok('the pick is a chip', await until(page, async () => (await chips.count()) === 1, 8000));
  await page.keyboard.press('Escape');
  await sayToSuper(page, 'quick');
  await until(page, async () => readNd(FRAMES).filter((f) => f.role === 'super').length > before2, 20000);
  const quick = readNd(FRAMES).filter((f) => f.role === 'super').at(-1)?.blocks.join('\n') ?? '';
  ok('…the block went with its picture (the send waited for the upload)', /\[Selected element/.test(quick) && /picture: /.test(quick), quick);

  console.log('\n── P6c: a page the app navigated away from the proxy is not inspected');
  await frame.evaluate((port) => { location.href = `http://127.0.0.1:${port}/`; }, dev.otherPort);
  await until(page, async () => page.frames().some((f) => f.url().startsWith(`http://127.0.0.1:${dev.otherPort}/`)), 8000);
  await page.waitForTimeout(800);
  await page.getByTestId('super-zoom-inspect').click();
  await page.waitForTimeout(400);
  ok('Inspect falls back to the zoom shield there (no picker)', (await page.getByTestId('super-zoom-shield').count()) === 1
    && (await page.locator('[data-testid="super-zoom"][data-picker="true"]').count()) === 0);
  await page.getByTestId('super-zoom-inspect').click();
  await page.getByTestId('super-zoom-reload').click();
  ok('Reload brings the card back to its own page', await until(page, async () => { const f = cardFrame(page, proxy2); return !!f && /Signed in/.test((await frameState(f)).who); }, 8000));

  console.log('\n── P7: a narrow window (390 px)');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  if (!(await page.locator('[data-testid="super-web-card"][data-web-state="large"]').count())) await superVerb(page, `half ${web().id}`);
  await page.waitForTimeout(1200);
  const f390 = cardFrame(page, proxy2);
  const st390 = f390 ? await frameState(f390) : null;
  ok('390 px: the card still shows the same signed-in page', !!st390 && /Signed in/.test(st390.who), JSON.stringify(st390));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok('390 px: no horizontal overflow', !overflow);
  await shot(page, 'web-14-mobile-390.png');
  const barFits = () => page.evaluate(() => {
    const bar = document.querySelector('[data-testid="super-web-card"] .super-zoom-bar');
    const card = document.querySelector('[data-testid="super-web-card"] .super-zoom');
    if (!bar || !card) return false;
    const b = bar.getBoundingClientRect(); const c = card.getBoundingClientRect();
    return b.left >= c.left - 0.5 && b.right <= c.right + 0.5;
  });
  ok('390 px: the toolbar sits inside the card', await barFits());
  await page.getByTestId('super-zoom-clear').click();
  await until(page, async () => (await page.getByTestId('super-zoom-clear-ask').count()) > 0, 4000);
  const askShown = await page.evaluate(() => { const a = document.querySelector('[data-testid="super-zoom-clear-ask"]'); const bar = a?.closest('.super-zoom-bar'); if (!a || !bar) return false; const r = a.getBoundingClientRect(); const br = bar.getBoundingClientRect(); return r.left >= br.left - 0.5 && r.right <= br.right + 0.5; });
  ok('390 px: the Clear question is whole on screen (wraps, never scrolled away)', askShown && await barFits());
  await shot(page, 'web-15-mobile-390-clear-ask.png');
  await page.getByTestId('super-zoom-clear-no').click();
  // Zoomed on a narrow card: the steps give way, Fit (the way back) stays.
  await page.getByTestId('super-zoom').first().evaluate((el) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, ctrlKey: true, bubbles: true, cancelable: true, clientX: el.getBoundingClientRect().left + 60, clientY: el.getBoundingClientRect().top + 60 })));
  await page.waitForTimeout(400);
  const zoomed390 = await page.locator('[data-testid="super-zoom"][data-zoomed]').count();
  ok('390 px zoomed: Fit is there, the steps are not', zoomed390 > 0 && await page.getByTestId('super-zoom-fit').isVisible() && !(await page.getByTestId('super-zoom-in').isVisible()), JSON.stringify({ zoomed390 }));
  await shot(page, 'web-16-mobile-390-zoomed.png');
  await page.getByTestId('super-zoom-fit').click();
  await page.setViewportSize({ width: 1440, height: 900 });

  await context.close();
  await browser.close();
  return { errors };
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
let server = null;
let devServer = null;
let otherServer = null;
try {
  if (!existsSync(CLI)) throw new Error('dist/index.js is missing: npm run build first');
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  devServer = await startDevServer(await freePort(), port);
  // A page on another port the app could navigate its frame to (an auth server, say).
  dev.otherPort = await freePort();
  otherServer = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>Elsewhere</title><h1>Another server</h1>'); });
  await new Promise((r) => otherServer.listen(dev.otherPort, '127.0.0.1', r));
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const restart = async () => {
    await new Promise((r) => { server.once('exit', r); server.kill(); });
    server = await startServer(port);
  };
  const r = await flow(pw, base, port, restart);
  // The dev page is the attacker for T0/T3: its refused socket and blocked POST are evidence.
  const errs = r.errors.filter((e) => !/Failed to load resource|WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/api\/agent\/chat\?vault=acme-app&bypass=1'|from origin 'http:\/\/127\.0\.0\.1:\d+' has been blocked by CORS policy/.test(e));
  ok('no console errors in the dashboard (the dev page\'s refused calls aside)', errs.length === 0, errs.slice(0, 6).join('\n'));
  const videos = existsSync(join(OUT, 'video')) ? readdirSync(join(OUT, 'video')) : [];
  note(`video: ${videos.map((v) => join(OUT, 'video', v)).join(', ')}`);
} catch (err) {
  results.fails.push(`crashed: ${err?.stack || err}`);
  console.error(err);
} finally {
  server?.kill();
  devServer?.close();
  otherServer?.close();
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.fails.length ? 'FAIL' : 'PASS'}: ${results.pass} passed, ${results.fails.length} failed${results.fails.length ? `\n  - ${results.fails.join('\n  - ')}` : ''}`);
process.exit(results.fails.length ? 1 : 0);
