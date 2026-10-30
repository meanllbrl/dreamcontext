#!/usr/bin/env node
/**
 * verify:composer-inline-etiket — nothing sits above the composer's text (owner 2026-10-30):
 * every attachment is a chip IN the text at the caret, each followed by his words about it.
 * Against the REAL dashboard server (`dist/` of VERIFY_REPO, default this checkout), a stand-in
 * `claude`, a scratch HOME and a tiny dev server, in Chromium or WebKit (argv[2]).
 *
 *  N1  normal chat: a pasted PDF and a ↩ on Claude's message are chips in the text, no row above;
 *  S1  Super: two elements picked on a web card land as chips at the caret, a picture pasted
 *      between them too, his words after each; no row above;
 *  S2  the send carries them strictly in that order;
 *  screenshots at 1440 and 390 px into OUT (default tmp/verify-composer-inline-etiket/<engine>).
 *
 * Run: npm run build && node scripts/verify/composer-inline-etiket.mjs chromium|webkit
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


const ENGINE = process.argv[2] === 'webkit' ? 'webkit' : 'chromium';
const REPO = process.env.VERIFY_REPO || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-inline-etiket-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = process.env.VERIFY_OUT || join(REPO, 'tmp', 'verify-composer-inline-etiket', ENGINE);
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
// ─── helpers for this check ──────────────────────────────────────────────────────────────
/** Paste a generated PNG (or any file) into the visible field marked `data-verify-input`. */
const pasteFile = (page, kind, name) => page.evaluate(async ([k, n]) => {
  const el = document.querySelector('[data-verify-input="1"]');
  let file;
  if (k === 'png') {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 100;
    const g = cv.getContext('2d'); g.fillStyle = '#2471a3'; g.fillRect(0, 0, 160, 100); g.fillStyle = '#fff'; g.fillRect(20, 20, 50, 30);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    file = new File([blob], n, { type: 'image/png' });
  } else file = new File(['%PDF-1.4 fictional brief'], n, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [kind, name]);
/** Mark the visible composer field (scoped) and put the caret at its end. */
async function focusEnd(page, scope) {
  const input = page.locator(`${scope} .chat-cmp-input:visible`).first();
  await page.evaluate(() => document.querySelectorAll('[data-verify-input]').forEach((e) => e.removeAttribute('data-verify-input')));
  await input.evaluate((el) => { el.setAttribute('data-verify-input', '1'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  return input;
}
/** What the composer shows: chips in the text (the mirror), and anything in a row above it. */
const composerState = (page, scope) => page.evaluate((s) => {
  const root = [...document.querySelectorAll(`${s} .chat-cmp`)].find((e) => e.offsetParent !== null) ?? document.querySelector(`${s} .chat-cmp`);
  if (!root) return null;
  const field = root.querySelector('.chat-cmp-field')?.getBoundingClientRect();
  return {
    rowAbove: root.querySelectorAll('.chat-cmp-attachments .chat-cmp-attachment, .chat-cmp-quote').length,
    inlineMedia: root.querySelectorAll('.chat-cmp-hl-img').length,
    inlineIcons: [...root.querySelectorAll('.chat-cmp-hl-thumb[data-icon]')].map((e) => e.getAttribute('data-icon')),
    inlineThumbs: [...root.querySelectorAll('.chat-cmp-hl-thumb')].filter((e) => /url\(/.test(e.style.backgroundImage)).length,
    inlineRefs: root.querySelectorAll('.chat-cmp-hl-ref:not(.chat-cmp-hl-img)').length,
    // Every chip inside the text field's box: nothing drawn above it.
    allInField: [...root.querySelectorAll('.chat-cmp-hl-ref')].every((m) => { const r = m.getBoundingClientRect(); return field && r.top >= field.top - 2 && r.bottom <= field.bottom + 2; }),
    pageChipInToolbar: root.querySelectorAll('.chat-cmp-toolbar .chat-cmp-page-chip').length,
    value: root.querySelector('.chat-cmp-input')?.value ?? '',
  };
}, scope);
/**
 * The painted geometry of the chips in the mirror (owner 2026-10-30: chips sit between the lines,
 * never touching the line above or below; text and chips share one baseline). Measured on what is
 * drawn: each chip's painted box (getClientRects of its mark) against the letters of every OTHER
 * line (Range rects of the plain text), and each chip's own letters against plain text on its line.
 */
const chipGeometry = (page, scope) => page.evaluate((s) => {
  const root = [...document.querySelectorAll(`${s} .chat-cmp`)].find((e) => e.offsetParent !== null);
  const hl = root?.querySelector('.chat-cmp-hl');
  if (!hl) return null;
  const marks = [...hl.querySelectorAll('mark.chat-cmp-hl-ref')];
  // A chip paints its mark AND its thumbnail's padded room (which reaches past the mark).
  const chipBoxes = marks.flatMap((m) => [m, ...m.querySelectorAll('.chat-cmp-hl-thumb')].flatMap((e) => [...e.getClientRects()].filter((r) => r.width > 2)));
  const textBoxes = [];
  const walker = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('mark') || !n.textContent.trim()) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    textBoxes.push(...[...r.getClientRects()].filter((x) => x.width > 2));
  }
  const lineH = parseFloat(getComputedStyle(hl).lineHeight);
  const sameLine = (a, b) => Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < lineH / 2;
  let minGap = Infinity;
  for (const c of chipBoxes) for (const o of [...textBoxes, ...chipBoxes]) {
    if (o === c || sameLine(c, o)) continue;
    const gap = c.top > o.top ? c.top - o.bottom : o.top - c.bottom;
    minGap = Math.min(minGap, gap);
  }
  // Baseline: a chip's label letters end on the same bottom as plain letters on its line.
  let maxBaselineDiff = 0;
  for (const m of marks) {
    const tn = [...m.childNodes].reverse().find((x) => x.nodeType === 3 && x.textContent.trim());
    if (!tn) continue;
    const r = document.createRange(); r.setStart(tn, Math.max(0, tn.textContent.length - 2)); r.setEnd(tn, tn.textContent.length);
    const lr = [...r.getClientRects()].at(-1);
    const peer = lr && textBoxes.find((t) => sameLine(t, lr));
    if (peer) maxBaselineDiff = Math.max(maxBaselineDiff, Math.abs(peer.bottom - lr.bottom));
  }
  // Side room: from a chip's painted edge to the nearest visible letter beside it on its line.
  let minSideGap = Infinity;
  const letterRects = [];
  const w2 = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
  for (let n = w2.nextNode(); n; n = w2.nextNode()) {
    if (n.parentElement?.closest('mark')) continue;
    const t = n.textContent;
    for (let k = 0; k < t.length; k++) {
      if (/[\s\u2060-\u2069\u202F]/.test(t[k])) continue;
      const r = document.createRange(); r.setStart(n, k); r.setEnd(n, k + 1);
      const rr = r.getClientRects()[0]; if (rr) letterRects.push(rr);
    }
  }
  for (const m of marks) for (const c of [...m.getClientRects()].filter((r) => r.width > 2)) {
    for (const l of letterRects) {
      if (!sameLine(c, l)) continue;
      const gap = l.left >= c.right ? l.left - c.right : c.left >= l.right ? c.left - l.right : -1;
      if (gap >= 0) minSideGap = Math.min(minSideGap, gap);
    }
  }
  const lines = new Set([...chipBoxes, ...textBoxes].map((r) => Math.round((r.top + r.bottom) / 2 / 4))).size;
  const ta = root.querySelector('.chat-cmp-input');
  const pad = parseFloat(getComputedStyle(ta).paddingTop) + parseFloat(getComputedStyle(ta).paddingBottom);
  const taLines = Math.round((ta.scrollHeight - pad) / lineH);
  const hlRange = document.createRange(); hlRange.selectNodeContents(hl);
  const mirrorLines = new Set([...hlRange.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top / (lineH / 2)))).size;
  const split = marks.filter((m) => [...m.getClientRects()].filter((r) => r.width > 2).length > 1).length;
  const cw = (e) => { const c = getComputedStyle(e); return Math.round((e.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight)) * 10) / 10; };
  // Diagnostic: the same text in ONE run, in a plain div with the textarea's metrics.
  const probe = document.createElement('div');
  const tcs = getComputedStyle(ta);
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', width: `${cw(ta)}px`, font: tcs.font, fontFamily: tcs.fontFamily, fontSize: tcs.fontSize, lineHeight: tcs.lineHeight, fontKerning: tcs.fontKerning });
  probe.textContent = ta.value; document.body.appendChild(probe);
  const plainDivLines = Math.round(probe.getBoundingClientRect().height / lineH); probe.remove();
  const markDiff = marks.map((m) => { const sp = document.createElement('span'); Object.assign(sp.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', font: tcs.font, fontFamily: tcs.fontFamily, fontSize: tcs.fontSize }); sp.textContent = m.textContent; document.body.appendChild(sp); const d = Math.round((m.getBoundingClientRect().width - sp.getBoundingClientRect().width) * 10) / 10; sp.remove(); return d; });
  const hlFont = getComputedStyle(hl).fontFamily === tcs.fontFamily && getComputedStyle(hl).fontWeight === tcs.fontWeight && getComputedStyle(hl).letterSpacing === tcs.letterSpacing && getComputedStyle(hl).wordSpacing === tcs.wordSpacing;
  const thumbPad = [...hl.querySelectorAll('.chat-cmp-hl-thumb, mark')].map((e) => getComputedStyle(e).paddingLeft + '/' + getComputedStyle(e).paddingRight + '/' + getComputedStyle(e).marginLeft + '/' + getComputedStyle(e).borderLeftWidth);
  return { markDiff, hlFont, thumbPad: [...new Set(thumbPad)], plainDivLines, taContentW: cw(ta), hlContentW: cw(hl), taOverflowY: getComputedStyle(ta).overflowY, taScrollbar: ta.offsetWidth - ta.clientWidth, taLines, mirrorLines, splitChips: split, lineHeightPx: lineH, fontSizePx: parseFloat(getComputedStyle(hl).fontSize), lines, chips: chipBoxes.length, minGapPx: Number.isFinite(minGap) ? Math.round(minGap * 10) / 10 : null, minSideGapPx: Number.isFinite(minSideGap) ? Math.round(minSideGap * 10) / 10 : null, maxBaselineDiffPx: Math.round(maxBaselineDiff * 10) / 10 };
}, scope);
/** The composer's toolbar as drawn: which controls show, and its line icons. */
const toolbarState = (page, scope) => page.evaluate((s) => {
  const root = [...document.querySelectorAll(`${s} .chat-cmp`)].find((e) => e.offsetParent !== null);
  const bar = root?.querySelector('.chat-cmp-toolbar');
  if (!bar) return null;
  const vis = (sel) => [...bar.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);
  const card = root.querySelector('.chat-cmp-card');
  return {
    mic: vis('.chat-cmp-mic').length, micTitle: vis('.chat-cmp-mic')[0]?.getAttribute('title') ?? null,
    speaker: vis('.chat-cmp-readaloud').length, ring: vis('.chat-cmp-usagebtn').length,
    modeFace: bar.querySelectorAll('.chat-cmp-modetrigger-face, .smascot').length,
    chevrons: vis('svg.chat-cmp-caret').length,
    restText: /to talk/i.test(bar.textContent ?? ''),
    modeText: vis('.chat-cmp-modetrigger')[0]?.textContent?.trim() ?? null,
    modelText: vis('.chat-cmp-model-wrap .chat-cmp-modeltrigger')[0]?.textContent?.trim() ?? null,
    triggerH: vis('.chat-cmp-modeltrigger')[0]?.getBoundingClientRect().height ?? null,
    sendW: vis('.chat-cmp-send')[0]?.getBoundingClientRect().width ?? null,
    cardRadius: card ? getComputedStyle(card).borderTopLeftRadius : null,
  };
}, scope);
const composerShot = async (page, scope, name) => {
  const cmp = page.locator(`${scope} .chat-cmp`).filter({ has: page.locator('.chat-cmp-input:visible') }).first();
  const p = join(OUT, name); await cmp.screenshot({ path: p }).catch(() => {}); results.shots.push(p);
};
const r3Checks = async (page, scope, where, super_) => {
  const tb = await toolbarState(page, scope);
  note(`${where} toolbar: ${JSON.stringify(tb)}`);
  ok(`R3 ${where}: the mic shows, its tooltip names the chord ("Hold to talk · …")`, tb?.mic === 1 && /^Hold to talk · /.test(tb?.micTitle ?? ''), JSON.stringify(tb));
  if (super_) ok(`R3 ${where}: the speaker (read aloud) shows`, tb?.speaker === 1, JSON.stringify(tb));
  ok(`R3 ${where}: no "… to talk" text in the bar`, tb && !tb.restText, JSON.stringify(tb));
  // The Super chat has no mode button (only the model trigger carries a chevron there).
  ok(`R3 ${where}: the mode button has no Sleepy glyph; chevrons are line icons`, tb?.modeFace === 0 && (tb?.chevrons ?? 0) >= (super_ ? 1 : 2), JSON.stringify(tb));
  ok(`R3 ${where}: the usage ring shows`, tb?.ring === 1, JSON.stringify(tb));
  ok(`R3 ${where}: the prototype's sizes (30px triggers, 32px send, 24px card radius)`, tb?.triggerH === 30 && tb?.sendW === 32 && tb?.cardRadius === '24px', JSON.stringify(tb));
};
const R3 = process.env.VERIFY_DESKTOP === '1';
const shotEl = async (page, name) => { const p = join(OUT, name); await page.screenshot({ path: p }); results.shots.push(p); return p; };

// ─── the flow ───────────────────────────────────────────────────────────────────────────
async function flow(pw, base) {
  const browser = await pw[ENGINE].launch(ENGINE === 'chromium' ? { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', ...(ENGINE === 'chromium' ? { permissions: ['microphone'] } : {}) });
  // VERIFY_DESKTOP=1: the composer as the desktop app draws it (the mic and the read-aloud switch
  // need the Tauri shell and local dictation): a stand-in `__TAURI_INTERNALS__` and a server
  // answer that dictation is installed. Nothing else of the shell is faked.
  if (process.env.VERIFY_DESKTOP === '1') {
    await context.addInitScript(() => { window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; });
    await context.route('**/api/agent/voice/dictation', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ installed: true }) }));
  }
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`\n── [${ENGINE}] N1: a normal chat`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  const first = page.locator('.chat-cmp-input:visible').first();
  await first.click();
  await first.fill('hello');
  await page.keyboard.press('Enter');
  await until(page, async () => readNd(FRAMES).some((f) => f.role === 'child'), 30000);
  await until(page, async () => (await page.locator('.chat-msg-assistant-row').count()) > 0, 15000);
  await page.waitForTimeout(800);
  const msgRow = page.locator('.chat-msg-assistant-row').last();
  await msgRow.hover().catch(() => {});
  await msgRow.locator('button[aria-label="Quote-reply"]').click().catch(() => {});
  await page.waitForTimeout(400);
  await focusEnd(page, '.agent-surface');
  await page.keyboard.type('bunu düzelt ');
  await pasteFile(page, 'pdf', 'brief.pdf');
  await page.waitForTimeout(600);
  await focusEnd(page, '.agent-surface');
  await page.keyboard.type('bu dosyaya göre');
  await page.waitForTimeout(600);
  let st = await composerState(page, '.agent-surface');
  ok('normal chat: nothing in a row above the text', st?.rowAbove === 0, JSON.stringify(st));
  ok('…the ↩ is a chip in the text', st?.inlineRefs === 1, JSON.stringify(st));
  ok('…the PDF is a chip in the text with its icon', st?.inlineIcons.includes('📄'), JSON.stringify(st));
  await shotEl(page, 'n1-normal-chat-1440.png');
  if (R3) { await r3Checks(page, '.agent-surface', 'normal 1440', false); await composerShot(page, '.agent-surface', 'r3-normal-composer-1440.png'); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  st = await composerState(page, '.agent-surface');
  ok('390 px: still nothing above the text, both chips in the field', st?.rowAbove === 0 && st?.allInField, JSON.stringify(st));
  await shotEl(page, 'n1-normal-chat-390.png');
  if (R3) { await r3Checks(page, '.agent-surface', 'normal 390', false); await composerShot(page, '.agent-surface', 'r3-normal-composer-390.png'); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);
  const n0 = readNd(FRAMES).filter((f) => f.role === 'child').length;
  await focusEnd(page, '.agent-surface');
  await page.keyboard.press('Enter');
  await until(page, async () => readNd(FRAMES).filter((f) => f.role === 'child').length > n0, 20000);
  const normalSent = readNd(FRAMES).filter((f) => f.role === 'child').at(-1)?.blocks.join('\n') ?? '';
  writeFileSync(join(OUT, 'n1-sent-message.txt'), normalSent);
  ok('normal send: the quote, his words, the PDF path, his words about it, in that order',
    /^> CHILD ok\n\nbunu düzelt\n\n'?[^\n]*brief\.pdf'?\nbu dosyaya göre$/.test(normalSent), normalSent);

  console.log(`\n── [${ENGINE}] S1: the Super chat, element picks on a web card`);
  ok('the hand-over button shows', await until(page, async () => (await page.locator('[data-testid="super-handover-btn"]:visible').count()) > 0, 20000));
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the Super Agent surface shows', await until(page, () => surfaceShown(page)));
  await until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
  await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000);
  const siteRef = `http://localhost:${dev.port}/`;
  await superVerb(page, `open web ${siteRef}`);
  ok('the web card is on the stage', await until(page, async () => (await webCard(page).count()) > 0, 15000), JSON.stringify(record().containers));
  await webCard(page).click({ position: { x: 40, y: 40 } });
  await until(page, async () => (await page.getByTestId('web-loopback-prompt').count()) > 0, 10000);
  await page.waitForTimeout(700);
  await page.locator('[data-testid="web-loopback-prompt"] button').nth(1).click();
  ok('the page loads in the card', await until(page, async () => (await webCard(page).locator('iframe').count()) > 0, 10000));
  const proxy = new URL(await webCard(page).locator('iframe').getAttribute('src')).origin;
  let frame = null;
  await until(page, async () => { frame = cardFrame(page, proxy); return !!frame && (await frame.locator('#who').count()) > 0; }, 10000);
  await page.waitForTimeout(1000);
  const SCOPE = '[data-testid="super-surface"]';
  const pick = async (sel) => {
    await page.getByTestId('super-zoom-inspect').click();
    await until(page, async () => (await page.locator('[data-testid="super-zoom"][data-picker="true"]').count()) > 0, 5000);
    await until(page, () => bridgeInspecting(frame), 5000);
    const b = await frame.locator(sel).boundingBox();
    await page.mouse.move(b.x + Math.min(10, b.width / 2), b.y + b.height / 2);
    await page.waitForTimeout(250);
    await page.mouse.click(b.x + Math.min(10, b.width / 2), b.y + b.height / 2);
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  };
  // He starts in the box, then picks: the chip goes where his caret was.
  await focusEnd(page, SCOPE);
  await page.keyboard.type('şuna bak: ');
  await pick('#start');
  st = await composerState(page, SCOPE);
  ok('the first pick: a chip IN the text, with the element\'s picture, nothing above', st?.inlineMedia === 1 && st?.inlineThumbs === 1 && st?.rowAbove === 0, JSON.stringify(st));
  await shotEl(page, 's1-one-element-1440.png');
  await focusEnd(page, SCOPE);
  await page.keyboard.type('bu butonu daha görünür yap ');
  await pasteFile(page, 'png', 'ekran.png');
  await page.waitForTimeout(800);
  await focusEnd(page, SCOPE);
  await page.keyboard.type('burada boşluk fazla ');
  await pick('.price');
  await focusEnd(page, SCOPE);
  await page.keyboard.type('fiyat daha büyük olsun');
  await page.waitForTimeout(800);
  st = await composerState(page, SCOPE);
  ok('two elements and a picture: three chips in the text, nothing above', st?.inlineMedia === 3 && st?.rowAbove === 0 && st?.allInField, JSON.stringify(st));
  await shotEl(page, 's1-mixed-1440.png');
  let geo = await chipGeometry(page, SCOPE);
  writeFileSync(join(OUT, 'l1-geometry-1440.json'), JSON.stringify(geo, null, 2));
  note(`1440 geometry: ${JSON.stringify(geo)}`);
  ok('L1 1440: a message of two lines or more with chips', (geo?.lines ?? 0) >= 2 && (geo?.chips ?? 0) >= 3, JSON.stringify(geo));
  ok('L1 1440: no chip touches the line above or below (≥ 5 px clear)', (geo?.minGapPx ?? -1) >= 5, JSON.stringify(geo));
  ok('L1 1440: chips and words share one baseline (≤ 1 px)', (geo?.maxBaselineDiffPx ?? 9) <= 1, JSON.stringify(geo));
  ok('L1 1440: room on both sides of each chip (≥ 6 px to the nearest letter)', (geo?.minSideGapPx ?? -1) >= 6, JSON.stringify(geo));
  ok('L1 1440: no chip split across two lines', geo?.splitChips === 0, JSON.stringify(geo));
  ok('L1 1440: the mirror wraps exactly like the textarea (same line count)', geo && geo.taLines === geo.mirrorLines, JSON.stringify(geo));
  { const cmp = page.locator(`${SCOPE} .chat-cmp`).filter({ has: page.locator('.chat-cmp-input:visible') }).first(); const p = join(OUT, 'l1-two-lines-composer-1440.png'); await cmp.screenshot({ path: p }).catch(() => {}); results.shots.push(p); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  st = await composerState(page, SCOPE);
  note(`390 px Super composer: ${JSON.stringify(st)}`);
  ok('390 px: nothing above the text', !st || st.rowAbove === 0, JSON.stringify(st));
  // At 390 the web card covers the stage: minimise it (the owner's own button) to see the chat.
  await page.locator('[data-testid="super-card-minimize"]').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  await shotEl(page, 's1-mixed-390.png');
  const cmp = page.locator(`${SCOPE} .chat-cmp`).filter({ has: page.locator('.chat-cmp-input:visible') }).first();
  if (await cmp.count()) { const p = join(OUT, 's1-mixed-390-composer.png'); await cmp.screenshot({ path: p }).catch(() => {}); results.shots.push(p); }
  geo = await chipGeometry(page, SCOPE);
  writeFileSync(join(OUT, 'l1-geometry-390.json'), JSON.stringify(geo, null, 2));
  note(`390 geometry: ${JSON.stringify(geo)}`);
  ok('L1 390: no chip touches the line above or below (≥ 5 px clear)', (geo?.minGapPx ?? -1) >= 5, JSON.stringify(geo));
  ok('L1 390: chips and words share one baseline (≤ 1 px)', (geo?.maxBaselineDiffPx ?? 9) <= 1, JSON.stringify(geo));
  ok('L1 390: room on both sides of each chip (≥ 6 px to the nearest letter)', (geo?.minSideGapPx ?? -1) >= 6, JSON.stringify(geo));
  ok('L1 390: no chip split across two lines', geo?.splitChips === 0, JSON.stringify(geo));
  ok('L1 390: the mirror wraps exactly like the textarea (same line count)', geo && geo.taLines === geo.mirrorLines, JSON.stringify(geo));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1200);

  console.log(`\n── [${ENGINE}] S2: the send keeps each chip's words after it`);
  const s0 = readNd(FRAMES).filter((f) => f.role === 'super').length;
  await focusEnd(page, SCOPE);
  await page.keyboard.press('Enter');
  ok('the send reaches the Super Agent', await until(page, async () => readNd(FRAMES).filter((f) => f.role === 'super').length > s0, 20000));
  const sent = readNd(FRAMES).filter((f) => f.role === 'super').at(-1)?.blocks.join('\n') ?? '';
  writeFileSync(join(OUT, 's2-sent-message.txt'), sent);
  const at = (s) => sent.indexOf(s);
  const order = [at('şuna bak:'), at('react: StartButton'), at('bu butonu daha görünür yap'), at('[Picture 1: '), at('burada boşluk fazla'), at('₺249'), at('fiyat daha büyük olsun')];
  ok('…in order: words, element 1, its words, the picture, its words, element 2, its words', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `${JSON.stringify(order)}\n${sent}`);
  ok('…each element with its picture path', (sent.match(/\npicture: /g) ?? []).length === 2, sent);
  await page.waitForTimeout(800);
  await shotEl(page, 's2-sent-1440.png');
  if (R3) {
    await r3Checks(page, SCOPE, 'super 1440', true);
    await composerShot(page, SCOPE, 'r3-super-composer-1440.png');
    // The recording look, as CSS draws it: the desktop records through the Tauri shell, which a
    // browser cannot, so the class is set by hand for this one picture and taken off again.
    const mic = page.locator(`${SCOPE} .chat-cmp-mic:visible`).first();
    if (await mic.count()) {
      await mic.evaluate((e) => e.classList.add('is-recording'));
      await page.waitForTimeout(400);
      const recColour = await mic.evaluate((e) => getComputedStyle(e).color);
      note(`recording-style mic colour: ${recColour}`);
      ok('R3 super: the recording mic is drawn red (its CSS state)', /^rgb\((\d+), (\d+), (\d+)\)$/.test(recColour) && (([, r, g, b]) => +r > 150 && +g < 140 && +b < 140)(recColour.match(/^rgb\((\d+), (\d+), (\d+)\)$/)), recColour);
      await composerShot(page, SCOPE, 'r3-super-composer-recording-style-1440.png');
      await mic.evaluate((e) => e.classList.remove('is-recording'));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1200);
    await page.locator('[data-testid="super-card-minimize"]').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    await r3Checks(page, SCOPE, 'super 390', true);
    await composerShot(page, SCOPE, 'r3-super-composer-390.png');
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await context.close();
  await browser.close();
  return { errors };
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
let server = null;
let devServer = null;
try {
  if (!existsSync(CLI)) throw new Error('dist/index.js is missing: npm run build first');
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  devServer = await startDevServer(await freePort(), port);
  server = await startServer(port);
  const r = await flow(pw, `http://127.0.0.1:${port}`);
  const errs = r.errors.filter((e) => !/Failed to load resource|WebSocket connection to|blocked by CORS policy|access control checks|not allowed by Access-Control-Allow-Origin/.test(e)
    // The stand-in Tauri shell has no event plugin: its listener teardown throws (VERIFY_DESKTOP only).
    && !(R3 && /unregisterListener/.test(e)));
  ok('no console errors in the dashboard (the dev page\'s refused calls aside)', errs.length === 0, errs.slice(0, 6).join('\n'));
} catch (err) {
  results.fails.push(`crashed: ${err?.stack || err}`);
  console.error(err);
} finally {
  server?.kill();
  devServer?.close();
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.fails.length ? 'FAIL' : 'PASS'} [${ENGINE}]: ${results.pass} passed, ${results.fails.length} failed${results.fails.length ? `\n  - ${results.fails.join('\n  - ')}` : ''}`);
process.exit(results.fails.length ? 1 : 0);
