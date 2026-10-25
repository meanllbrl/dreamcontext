#!/usr/bin/env node
/**
 * Hands-free on a COMPUTER or a LANDSCAPE TABLET (task hands-free-bilgisayar-ve-tablette…, W2):
 * the desktop Chat with project chips, chat tabs and panes, seeded from the Mac window's live
 * tabs, and the full Super stage, read and arranged only; a portrait tablet and a phone keep the
 * phone layout.
 *
 *   npm run build && node scripts/verify/handsfree-remote-desktop.mjs
 *
 * WHAT IT DRIVES: the real dashboard server (scratch HOME, a `claude` stand-in that logs every
 * spawn, every message it gets and its window token; the power runner only logging) and a REAL
 * Cloudflare quick tunnel (the Mac's pinned cloudflared, copied into the scratch HOME; a CONNECT
 * proxy resolves the fresh name through public resolvers). Three projects are chosen at start:
 *
 *   proj  — the Mac window holds two live chats (A in pane 0, B in pane 1; node sockets that stay
 *           open and answer pings, so a passive open must not evict them);
 *   other — handed over: the Super's chat and one child are live on the Mac (node sockets), its
 *           record holds a child card, a picture, a task, an https page and a localhost page;
 *   third — the Mac WINDOW itself (a real page on the main listener) holds two chats; the remote
 *           takes one by sending in it, then the Mac hands over: that one is skipped and named.
 *
 * CHECKS: the login page's shared-computer line (AC20); at 1440x900 and 1280x560 (mouse) and
 * 1024x768 and 1180x820 (touch) the desktop layout (AC1); the rail folded on first load and 44 px
 * chips and tabs on touch (AC19); no Settings, no hands-free button, no detach, the "Uzaktan" chip
 * (AC8); `+` lists exactly the chosen projects (AC5); three chips, switching keeps every instance
 * (AC4); the Mac's live tabs seeded into the same panes, passively (AC6); a send in a seeded tab
 * takes the chat and is delivered once (AC7); the remote stage of `other` (AC9, AC13), an agent
 * `super open` on it within 2 s, a child card large is watch-only (AC11); the Mac's skipped-chat
 * notice (AC12); rotation keeps every socket (AC2); 768x1024 touch and 390x844 are the phone (AC1);
 * over the whole run no 4xx/5xx from the desktop sessions, no request to a laptop-only route (AC3)
 * and no console error (AC19).
 *
 * FAILURE POLICY: collect, don't fail fast; exit 0 iff every check passed.
 * Screenshots: tmp/verify-handsfree-remote-desktop/*.png
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-remote-desktop');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const OTHER = join(SCRATCH, 'other');
const THIRD = join(SCRATCH, 'third');
const POWER_LOG = join(SCRATCH, 'power.log');
const SPAWNS = join(HOME, 'spawns.log');
const SAID = join(HOME, 'said.log');
const TOKENS = join(HOME, 'tokens');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-remote-desktop');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');

const STANDIN = `#!${process.execPath}
/** Inert stand-in for \`claude -p --input-format stream-json\`: logs spawns, messages, its window token. */
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
fs.appendFileSync(path.join(process.env.HOME, 'spawns.log'), JSON.stringify({ pid: process.pid, sid, resume: !!at('--resume') }) + '\\n');
if (process.env.DREAMCONTEXT_WINDOW_TOKEN) {
  fs.mkdirSync(path.join(process.env.HOME, 'tokens'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, 'tokens', sid), process.env.DREAMCONTEXT_WINDOW_TOKEN);
}
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    fs.appendFileSync(path.join(process.env.HOME, 'said.log'), JSON.stringify({ sid, text }) + '\\n');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    if (text.includes('please ask')) {
      // A question to the owner: the chat waits on him (the phone's "Seni bekliyor").
      out({ type: 'control_request', request_id: 'ask-' + Date.now(), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which port?', header: 'Port', multiSelect: false, options: [{ label: '3000', description: 'dev' }, { label: '5173', description: 'vite' }] }] } } });
      continue;
    }
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ECHO ' + text }] };
    row({ type: 'assistant', message }); out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ECHO', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const report = {
  pass: 0, fails: [], notes: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(s) { this.notes.push(s); console.log(`  · ${s}`); },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const spawns = () => lines(SPAWNS);
const said = () => lines(SAID);

// Conversation ids: the Mac window's two chats in proj, the Super and its child in other, two in third.
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const SUPER = crypto.randomUUID();
const CHILD = crypto.randomUUID();
const T1 = crypto.randomUUID();
const T2 = crypto.randomUUID();
const P1 = crypto.randomUUID();
const TITLES = { [A]: 'Checkout adımı', [B]: 'Fiyat kartı', [CHILD]: 'Push izinleri', [T1]: 'Arama sırası', [T2]: 'Kargo ücreti', [P1]: 'İade akışı' };

function transcript(dir, sid, title) {
  const tdir = join(HOME, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const ts = new Date(Date.now() - 3600_000).toISOString();
  const rows = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: title }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Working on: ${title}` }] } },
  ].map((o) => JSON.stringify({ ...o, cwd: dir, uuid: crypto.randomUUID(), timestamp: ts, sessionId: sid }));
  writeFileSync(join(tdir, `${sid}.jsonl`), `${rows.join('\n')}\n`);
}

const roster = (tabs) => JSON.stringify({ generation: 1, chatPermissionMode: 'auto', activePane: 0, sessions: tabs });
const tab = (sid, pane, active) => ({ title: TITLES[sid], bypass: false, minimized: false, size: 1, sessionId: sid, kind: 'chat', mode: 'basic', pane, ...(active ? { active: true } : {}) });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext', 'bin'), join(HOME, '.local', 'bin'), PROJ, OTHER, THIRD, SHOTS]) mkdirSync(d, { recursive: true });
  chmodSync(join(HOME, '.dreamcontext', 'bin'), 0o700);
  // The Mac's own pinned cloudflared (its sha256 is checked again by the server).
  const real = join(homedir(), '.dreamcontext', 'bin');
  const bin = existsSync(real) ? readdirSync(real).find((f) => /^cloudflared-\d/.test(f)) : null;
  if (bin) { copyFileSync(join(real, bin), join(HOME, '.dreamcontext', 'bin', bin)); chmodSync(join(HOME, '.dreamcontext', 'bin', bin), 0o755); }
  const claude = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(claude, STANDIN);
  chmodSync(claude, 0o755);
  // The Mac's settings: the Super Agent is on (third hands over from the Mac window).
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ superAgent: true, chatView: true, screenMigrated: true, titleMigrated: true, enabled: true, restoreTabs: true }));
  for (const [name, dir] of [['proj', PROJ], ['other', OTHER], ['third', THIRD]]) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    cli(['init', '-y', '--name', name, '--description', `A scratch project for the remote-desktop check (${name})`], dir);
    const r = cli(['vaults', 'add', name, dir], dir);
    if (r.status !== 0) throw new Error(`vaults add ${name}: ${r.stderr || r.stdout}`);
  }
  cli(['tasks', 'create', 'Ship the remote stage', '--why', 'a task card on the stage'], OTHER);
  cli(['tasks', 'create', 'Second card', '--why', 'the agent opens it during the check'], OTHER);
  mkdirSync(join(OTHER, 'docs'), { recursive: true });
  // A real 2x2 PNG for the picture card.
  writeFileSync(join(OTHER, 'docs', 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4AWP4z8Dwn4GBgYGJgYEBAA0QAgEsl2u9AAAAAElFTkSuQmCC', 'base64'));
  transcript(PROJ, A, TITLES[A]); transcript(PROJ, B, TITLES[B]); transcript(PROJ, P1, TITLES[P1]);
  transcript(OTHER, CHILD, TITLES[CHILD]); transcript(OTHER, SUPER, 'Super Agent');
  transcript(THIRD, T1, TITLES[T1]); transcript(THIRD, T2, TITLES[T2]);
  // proj: the Mac window's roster (two panes) and a terminal that must never be seeded.
  writeFileSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), roster([
    tab(A, 0, true), tab(B, 1, true), { title: 'zsh', bypass: false, minimized: false, size: 1, kind: 'shell', pane: 1 },
  ]));
  // third: the Mac window page restores these two.
  writeFileSync(join(THIRD, '_dream_context', 'state', '.agent-sessions.json'), roster([tab(T1, 0, true), tab(T2, 0)]));
  // other: handed over. The record the remote stage reads.
  const slug = readdirSync(join(OTHER, '_dream_context', 'state')).find((f) => f.startsWith('ship-the-remote-stage'))?.replace(/\.md$/, '') ?? 'ship-the-remote-stage';
  writeFileSync(join(OTHER, '_dream_context', 'state', '.super-agent.json'), JSON.stringify({
    v: 1, session: SUPER, enabled: true,
    containers: [
      { id: 'chat-kid', kind: 'chat', ref: CHILD, shape: 'tall', place: 'float', title: TITLES[CHILD] },
      { id: 'img-1', kind: 'image', ref: 'docs/shot.png', shape: 'square', place: 'float', title: 'Shot' },
      { id: 'task-1', kind: 'task', ref: slug, shape: 'square', place: 'float', title: 'Ship the remote stage' },
      { id: 'web-ok', kind: 'web', ref: 'https://example.com/', shape: 'square', place: 'float', title: 'Example' },
      { id: 'web-lo', kind: 'web', ref: 'http://localhost:5173/checkout', shape: 'square', place: 'float', title: 'Checkout preview' },
    ],
    groups: [], view: { mode: 'float' },
    children: { [CHILD]: { sessionId: CHILD, brief: 'BRIEF-NEVER-REMOTE', adopted: true, startedAt: Date.now() - 60_000, row: 'working' } },
    queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [],
  }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: POWER_LOG },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`[server] ${s}`); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function mac(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** A fresh quick-tunnel name resolves through public resolvers (macOS caches the first NXDOMAIN). */
function freshLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const r = new dns.Resolver({ timeout: 2000, tries: 1 });
  r.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);
  r.resolve4(hostname, (err, addrs) => {
    if (!err && addrs.length) { if (opts && opts.all) cb(null, [{ address: addrs[0], family: 4 }]); else cb(null, addrs[0], 4); return; }
    dns.lookup(hostname, opts || {}, cb);
  });
}
function startProxy() {
  const socks = new Set();
  const srv = http.createServer((_q, r) => { r.writeHead(405); r.end(); });
  srv.on('connect', (req, client, head) => {
    const [host, portStr] = String(req.url).split(':');
    const up = net.connect({ port: Number(portStr) || 443, host, lookup: freshLookup }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      client.pipe(up); up.pipe(client);
    });
    socks.add(up); socks.add(client);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close() { for (const s of socks) s.destroy(); srv.close(); } })));
}

/** A navigation over the quick tunnel: one retry on a transport error (a Cloudflare edge drops a
 *  request now and then); the second failure is the run's. */
async function go(page, target) {
  try { return await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 }); }
  catch (err) {
    if (!/ERR_EMPTY_RESPONSE|ERR_CONNECTION|ERR_TIMED_OUT|ERR_TUNNEL/.test(String(err))) throw err;
    report.note(`tunnel hiccup on ${target.replace(/^https:\/\/[^/]+/, '')}: retried once`);
    await sleep(2000);
    return page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
}

const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
};

/** What is on screen. */
const layout = (page) => page.evaluate(() => {
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const any = (sel) => [...document.querySelectorAll(sel)].some(vis);
  const heights = (sel) => [...document.querySelectorAll(sel)].filter(vis).map((el) => Math.round(el.getBoundingClientRect().height));
  const rail = document.querySelector('.project-instance:not([hidden]) .sidebar') ?? document.querySelector('.sidebar');
  return {
    phoneList: any('[data-testid="phone-list"]'),
    chrome: any('.window-chrome-bar'),
    chips: [...document.querySelectorAll('.project-tab .project-tab-name')].map((e) => e.textContent),
    chipHeights: heights('.project-tab'),
    tabHeights: heights('.agent-tab'),
    tabTitles: [...document.querySelectorAll('.agent-tab .agent-tab-title')].filter(vis).map((e) => e.textContent),
    panes: [...document.querySelectorAll('.agent-pane-tabbar')].filter(vis).length,
    railCollapsed: !!rail?.classList.contains('sidebar--collapsed'),
    settings: [...document.querySelectorAll('.sidebar-item .sidebar-label')].filter(vis).some((e) => /^(Settings|Ayarlar)$/.test((e.textContent ?? '').trim())),
    hfButton: any('[data-testid="hf-button"]'),
    chip: [...document.querySelectorAll('[data-testid="phone-live-badge"]')].filter(vis).map((e) => e.textContent ?? '').join(' | '),
    stage: any('[data-testid="super-surface"]'),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    sockets: window.__dcSockets ? window.__dcSockets.filter((w) => w.readyState === 1).length : -1,
  };
});

/** Count every WebSocket the page opens (rotation keeps them, AC2). */
const SOCKET_HOOK = () => {
  const Real = window.WebSocket;
  window.__dcSockets = [];
  window.WebSocket = class extends Real { constructor(...a) { super(...a); window.__dcSockets.push(this); } };
};

let server = null;
let browser = null;
let remoteBrowser = null;
let proxy = null;
let port = 0;
const errors = [];
const refused = [];
const bad = [];
const holders = {};
try {
  const { chromium } = await import('@playwright/test');
  const { WebSocket: NodeWs } = await import('ws');
  // The laptop-only routes, read from the dashboard's own mirror (phoneSurface.ts).
  const surfaceSrc = readFileSync(join(REPO, 'dashboard', 'src', 'lib', 'phoneSurface.ts'), 'utf-8');
  const deniedBlock = surfaceSrc.slice(surfaceSrc.indexOf('export const MAC_DENIED_API_ROUTES'), surfaceSrc.indexOf('];', surfaceSrc.indexOf('export const MAC_DENIED_API_ROUTES')));
  const MAC_DENIED_API_ROUTES = [...deniedBlock.matchAll(/'([A-Z]+ \/api\/[^']+)'/g)].map((m) => m[1]);
  report.check('the laptop-only route list was read', MAC_DENIED_API_ROUTES.length > 50, String(MAC_DENIED_API_ROUTES.length));
  console.log(`· build: ${CLI}`);
  setupScratch();
  port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;

  // ── The Mac window's sockets: two chats in proj, the Super and its child in other ─────────
  const hold = (name, query, first) => new Promise((resolve) => {
    const ws = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?${query}`);
    const h = { ws, closes: [], frames: [] };
    ws.on('error', () => {});
    ws.on('close', (code) => h.closes.push(code));
    ws.on('message', (d) => h.frames.push(String(d)));
    ws.on('open', () => { if (first) ws.send(JSON.stringify({ type: 'user', text: first })); holders[name] = h; resolve(h); });
  });
  await hold('A', `vault=proj&bypass=0&resume=${A}`, 'keep going on checkout');
  await hold('B', `vault=proj&bypass=0&resume=${B}`, 'keep going on pricing');
  await hold('super', `vault=other&bypass=0&mode=super&resume=${SUPER}`, 'hello super');
  await hold('child', `vault=other&bypass=0&resume=${CHILD}`, 'push permissions');
  report.check('the Mac window holds four live chats', await until(() => spawns().length >= 4, 20000), JSON.stringify(spawns()));

  // ── Mac mode on over a REAL quick tunnel, three projects chosen ─────────────────────────
  const setup = await mac(port, 'POST', 'setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));
  proxy = await startProxy();
  const started = await mac(port, 'POST', 'start', { vaults: ['proj', 'other', 'third'] });
  const url = started.json.url;
  report.check('Mac mode starts over a real quick tunnel for three projects', started.status === 200 && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com/.test(url ?? ''), JSON.stringify(started.json).slice(0, 220));
  remoteBrowser = await chromium.launch({ proxy: { server: proxy.url } });
  browser = await chromium.launch();

  const watch = (page, tag, desktopSession) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${String(e).slice(0, 200)}`));
    page.on('response', (r) => {
      const path = new URL(r.url()).pathname;
      if (r.status() === 403) refused.push(`${tag}: ${r.request().method()} ${path}`);
      if (desktopSession && r.status() >= 400 && path.startsWith('/api/')) bad.push(`${tag}: ${r.status()} ${r.request().method()} ${path}`);
    });
    page.on('request', (q) => {
      const path = new URL(q.url()).pathname;
      if (!path.startsWith('/api/')) return;
      const key = `${q.method()} ${path}`;
      for (const d of MAC_DENIED_API_ROUTES) {
        const [m, p] = d.split(' ');
        const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-zA-Z_]+/g, '[^/]+').replace(/\*[a-zA-Z_]+/g, '.+')}$`);
        if (m === q.method() && re.test(path)) bad.push(`${tag}: laptop-only request ${key}`);
      }
    });
  };

  const remote = async (name, ctxOpts) => {
    const qr = (await mac(port, 'POST', 'qr')).json.url;
    const ctx = await remoteBrowser.newContext({ locale: 'tr-TR', ...ctxOpts });
    await ctx.addInitScript(SOCKET_HOOK);
    const page = await ctx.newPage();
    watch(page, name, true);
    await go(page, qr);
    return { ctx, page };
  };

  // ── AC20: the login page's line for a shared computer ──────────────────────────────────
  {
    const ctx = await remoteBrowser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'tr-TR' });
    const page = await ctx.newPage();
    await go(page, `${url}/login`);
    const line = (await page.locator('#shared').textContent().catch(() => '')) ?? '';
    report.check('AC20: the login page says what a shared computer should do', /Dönüş|Return/.test(line), line);
    await page.screenshot({ path: join(SHOTS, 'login-1440.png') });
    await ctx.close();
  }

  // ── A computer, 1440x900, mouse ─────────────────────────────────────────────────────────
  console.log('\n· computer 1440x900 (mouse)');
  const comp = await remote('computer-1440', { viewport: { width: 1440, height: 900 } });
  const page = comp.page;
  await go(page, `${url}/?vault=proj`);
  report.check('AC1 1440 mouse: the desktop layout (window chrome, no phone list)', await until(async () => { const l = await layout(page); return l.chrome && !l.phoneList; }, 30000), JSON.stringify(await layout(page)));
  await page.waitForTimeout(2500);
  await dismiss(page);
  let l = await layout(page);
  report.check('AC8: no Settings, no hands-free button; the chip says "Uzaktan · Mac"', !l.settings && !l.hfButton && /Uzaktan|Remote/.test(l.chip), JSON.stringify({ settings: l.settings, hf: l.hfButton, chip: l.chip }));
  // AC6: the Mac window's live tabs, in the same panes, passively.
  report.check('AC6: the Mac window\'s two chats are seeded into two panes', await until(async () => { const x = await layout(page); return x.tabTitles.includes(TITLES[A]) && x.tabTitles.includes(TITLES[B]) && x.panes >= 2; }, 25000), JSON.stringify(await layout(page)));
  report.check('AC6: no terminal tab was seeded', !(await layout(page)).tabTitles.includes('zsh'));
  await page.waitForTimeout(4000);
  report.check('AC6: the Mac window kept every socket (no 4409, nothing respawned)', holders.A.closes.length === 0 && holders.B.closes.length === 0 && spawns().length === 4, JSON.stringify({ A: holders.A.closes, B: holders.B.closes, spawns: spawns().length }));
  report.check('AC6: a seeded tab says writing takes it', (await page.locator('.chat-banner-taken--write').count()) >= 1);
  await page.screenshot({ path: join(SHOTS, 'computer-1440-seeded.png') });

  // AC7: a send in a seeded tab takes the chat and is delivered once.
  const before = said().filter((x) => x.sid === A).length;
  await page.locator('.agent-tab', { hasText: TITLES[A] }).first().click();
  await page.waitForTimeout(500);
  // A's pane is the first (left) one: its composer.
  const ta = page.locator('textarea.chat-cmp-input:visible').first();
  await ta.click();
  await ta.fill('remote takes this');
  await page.keyboard.press('Enter');
  report.check('AC7: the Mac window is told 4409 (another screen took the chat)', await until(() => holders.A.closes.includes(4409), 15000), JSON.stringify(holders.A.closes));
  report.check('AC7: the message reached the chat exactly once', await until(() => said().filter((x) => x.sid === A && x.text === 'remote takes this').length === 1, 15000) && said().filter((x) => x.sid === A).length === before + 1, JSON.stringify(said().filter((x) => x.sid === A)));
  await page.waitForTimeout(1500);
  report.check('AC7: still exactly once after the take settles', said().filter((x) => x.sid === A && x.text === 'remote takes this').length === 1);
  await page.screenshot({ path: join(SHOTS, 'computer-1440-taken.png') });

  // AC5: `+` lists exactly the chosen projects.
  await page.locator('.project-tabs-add').click();
  await until(async () => (await page.locator('.psw-row').count()) > 0, 10000);
  const rows = (await page.locator('.psw-row .psw-row-name').allTextContents()).map((s) => s.trim());
  report.check('AC5: the + menu lists exactly the chosen projects (no Launcher row)', JSON.stringify([...rows].sort()) === JSON.stringify(['other', 'proj', 'third']), JSON.stringify(rows));
  await page.screenshot({ path: join(SHOTS, 'computer-1440-plus.png') });
  // AC4: three chips; switching never unmounts an instance.
  await page.locator('.psw-row', { hasText: 'other' }).first().click();
  await until(async () => (await layout(page)).chips.length === 2, 10000);
  await page.locator('.project-tabs-add').click();
  await page.locator('.psw-row', { hasText: 'third' }).first().click();
  report.check('AC4: three chosen projects open as chips', await until(async () => (await layout(page)).chips.length === 3, 15000), JSON.stringify((await layout(page)).chips));
  const instances = () => page.evaluate(() => [...document.querySelectorAll('.project-instance')].map((e) => e.getAttribute('data-instance-id') ?? e.id ?? ''));
  const idsBefore = await instances();
  for (const name of ['proj', 'other', 'third', 'proj']) {
    await page.locator('.project-tab', { hasText: name }).first().locator('.project-tab-main').click();
    await page.waitForTimeout(700);
  }
  report.check('AC4: switching keeps every project instance mounted', JSON.stringify(await instances()) === JSON.stringify(idsBefore), JSON.stringify({ before: idsBefore, after: await instances() }));

  // AC9/AC13: the remote stage of `other`.
  await page.locator('.project-tab', { hasText: 'other' }).first().locator('.project-tab-main').click();
  report.check('AC9: the handed-over project draws the Super stage on the computer', await until(async () => (await layout(page)).stage, 25000), JSON.stringify(await layout(page)));
  await page.waitForTimeout(2500);
  const stage = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.super-card-frame[data-container-id]')].map((e) => [e.getAttribute('data-container-id'), e.getAttribute('data-where')]),
    managed: document.querySelector('[data-testid="super-handover-remote"]')?.textContent ?? '',
    handover: !!document.querySelector('[data-testid="super-handover-btn"]'),
    newSession: !!document.querySelector('[data-testid="super-new-session"], .super-new-session'),
    macOnly: [...document.querySelectorAll('[data-testid="super-card-mac-only"]')].map((e) => e.textContent ?? ''),
    close: document.querySelectorAll('[data-testid="super-card-close"]').length,
    iframes: [...document.querySelectorAll('.super-card-frame iframe')].map((f) => f.getAttribute('src') ?? ''),
    body: document.body.innerText,
  }));
  report.check('AC13: "Super Agent devrede · Mac\'te yönetilir" is shown, no hand-over or take-back button', /devrede|managed on the Mac/.test(stage.managed) && !stage.handover, JSON.stringify({ managed: stage.managed, handover: stage.handover }));
  report.check('AC13: no New session, no close on a card', !stage.newSession && stage.close === 0, JSON.stringify({ newSession: stage.newSession, close: stage.close }));
  report.check('AC13: the localhost page draws "Bu önizleme Mac\'te açık" and loads nothing from localhost', stage.macOnly.some((t) => /Mac'te açık|open on the Mac/.test(t)) && !stage.iframes.some((s) => /localhost|127\.0\.0\.1/.test(s)), JSON.stringify(stage.macOnly));
  report.check('AC9: the child card, the picture, the task are on the stage (floating)', ['chat-kid', 'img-1', 'task-1'].every((id) => stage.cards.some(([c, w]) => c === id && w === 'float')), JSON.stringify(stage.cards));
  report.check('AC14: the brief never reaches the remote page', !stage.body.includes('BRIEF-NEVER-REMOTE'));
  await page.screenshot({ path: join(SHOTS, 'computer-1440-stage.png') });

  // AC9: an agent `super open` appears within 2 s, without reload.
  const tokenOf = (sid) => (existsSync(join(TOKENS, sid)) ? readFileSync(join(TOKENS, sid), 'utf-8').trim() : '');
  const token = tokenOf(SUPER);
  const slug2 = readdirSync(join(OTHER, '_dream_context', 'state')).find((f) => f.startsWith('second-card'))?.replace(/\.md$/, '') ?? 'second-card';
  const t0 = Date.now();
  const opened = await fetch(`${base}/api/super/v/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dreamcontext-window-token': token }, body: JSON.stringify({ kind: 'task', ref: slug2, title: 'Second card' }) });
  const openedBody = await opened.json().catch(() => ({}));
  const shown = await until(async () => page.evaluate((s) => [...document.querySelectorAll('.super-card-frame[data-kind="task"]')].length >= 2 || document.body.innerText.includes(s), 'Second card'), 2000, 100);
  report.check(`AC9: an agent \`super open\` is on the remote stage within 2 s (${Date.now() - t0} ms)`, opened.status === 200 && shown, JSON.stringify({ status: opened.status, body: openedBody }).slice(0, 200));

  // AC11: a child card large is watch-only: the child streams, no composer, no Allow/Deny.
  const kid = page.locator('.super-card-frame[data-container-id="chat-kid"]');
  await kid.click({ position: { x: 20, y: 20 } }).catch(() => {});
  report.check('AC11: the child card opens large', await until(async () => (await page.locator('[data-testid="super-shown"]').count()) === 1, 10000));
  report.check('AC11: its chat is watch-only ("Super Agent\'a devredildi", no composer)', await until(async () => (await page.locator('[data-testid="super-shown"] .chat-banner-handed-over').count()) >= 1 && (await page.locator('[data-testid="super-shown"] textarea.chat-cmp-input').count()) === 0, 15000));
  holders.child.ws.send(JSON.stringify({ type: 'user', text: 'live line from the Mac' }));
  report.check('AC11: the child streams live into the watch', await until(async () => (await page.locator('[data-testid="super-shown"]').innerText().catch(() => '')).includes('ECHO live line from the Mac'), 15000));
  report.check('AC11: no Allow/Deny on the remote', (await page.locator('[data-testid="super-queue-allow"], [data-testid="super-queue-deny"]').count()) === 0);
  report.check('AC12: the Mac child holder was never evicted', holders.child.closes.length === 0 && holders.super.closes.length === 0, JSON.stringify({ child: holders.child.closes, super: holders.super.closes }));
  await page.screenshot({ path: join(SHOTS, 'computer-1440-child.png') });
  // AC10: the remote's minimise lands on the Mac's record (the stage floats again).
  await page.locator('[data-testid="super-shown"]').hover().catch(() => {});
  await page.locator('[data-testid="super-card-minimize"]').first().click();
  const recView = () => JSON.parse(readFileSync(join(OTHER, '_dream_context', 'state', '.super-agent.json'), 'utf-8')).view;
  report.check('AC10: the remote\'s minimise is applied on the Mac\'s stage (view float)', await until(() => recView()?.mode === 'float', 10000), JSON.stringify(recView()));
  const desktopOverflow = (await layout(page)).overflow;
  report.check('no horizontal overflow at 1440', desktopOverflow <= 1, String(desktopOverflow));
  await comp.ctx.close();

  // ── 1280x560 mouse: still the desktop layout ────────────────────────────────────────────
  console.log('\n· computer 1280x560 (mouse)');
  {
    const r = await remote('computer-1280x560', { viewport: { width: 1280, height: 560 } });
    await go(r.page, `${url}/?vault=proj`);
    report.check('AC1 1280x560 mouse: the desktop layout', await until(async () => { const x = await layout(r.page); return x.chrome && !x.phoneList; }, 30000), JSON.stringify(await layout(r.page)));
    await r.page.waitForTimeout(2000);
    await r.page.screenshot({ path: join(SHOTS, 'computer-1280x560.png') });
    await r.ctx.close();
  }

  // ── Touch tablets: 1024x768 and 1180x820 landscape, 768x1024 portrait ───────────────────
  for (const [w, h] of [[1024, 768], [1180, 820]]) {
    console.log(`\n· tablet ${w}x${h} (touch, landscape)`);
    const r = await remote(`tablet-${w}`, { viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await go(r.page, `${url}/?vault=proj`);
    report.check(`AC1 ${w}x${h} touch: the desktop layout`, await until(async () => { const x = await layout(r.page); return x.chrome && !x.phoneList; }, 30000), JSON.stringify(await layout(r.page)));
    await r.page.waitForTimeout(3000);
    await dismiss(r.page);
    const x = await layout(r.page);
    report.check(`AC19 ${w}x${h}: the rail is folded on first load`, x.railCollapsed, JSON.stringify(x));
    if (w === 1024) {
      await until(async () => (await layout(r.page)).tabHeights.length >= 1, 15000);
      const y = await layout(r.page);
      report.check('AC19 1024x768: every project chip and chat tab is at least 44 px tall', y.chipHeights.length > 0 && y.chipHeights.every((v) => v >= 44) && y.tabHeights.length > 0 && y.tabHeights.every((v) => v >= 44), JSON.stringify({ chips: y.chipHeights, tabs: y.tabHeights }));
      await r.page.screenshot({ path: join(SHOTS, 'tablet-1024-landscape.png') });
      // AC2: rotation keeps every socket and the focused chat.
      const focusedTitle = async () => r.page.evaluate(() => document.querySelector('.agent-tab.active .agent-tab-title')?.textContent ?? document.querySelector('.mchat-title, [data-testid="chat-title"]')?.textContent ?? '');
      const socks0 = (await layout(r.page)).sockets;
      const title0 = await focusedTitle();
      await r.page.setViewportSize({ width: 768, height: 1024 });
      report.check('AC2: rotated to portrait, the tablet is the phone layout', await until(async () => !(await layout(r.page)).chrome, 10000), JSON.stringify(await layout(r.page)));
      await r.page.waitForTimeout(1500);
      const socks1 = (await layout(r.page)).sockets;
      await r.page.screenshot({ path: join(SHOTS, 'tablet-1024-rotated-portrait.png') });
      await r.page.setViewportSize({ width: 1024, height: 768 });
      report.check('AC2: back to landscape, the desktop layout again', await until(async () => (await layout(r.page)).chrome, 10000));
      await r.page.waitForTimeout(1500);
      const socks2 = (await layout(r.page)).sockets;
      report.check('AC2: every chat socket stayed open through both turns', socks0 > 0 && socks1 === socks0 && socks2 === socks0, JSON.stringify({ socks0, socks1, socks2 }));
      report.check('AC2: the focused chat is the one on screen after the turns', (await focusedTitle()) === title0, JSON.stringify({ before: title0, after: await focusedTitle() }));
      // AC19: the remote stage at 1024x768 touch floats its cards.
      await r.page.locator('.project-tabs-add').click();
      await r.page.locator('.psw-row', { hasText: 'other' }).first().click();
      report.check('AC19 1024x768: the Super stage is drawn', await until(async () => (await layout(r.page)).stage, 25000));
      await r.page.waitForTimeout(2500);
      const where = await r.page.evaluate(() => [...document.querySelectorAll('.super-card-frame[data-container-id]')].map((e) => e.getAttribute('data-where')));
      report.check('AC19 1024x768: cards float on the stage, not all in Others', where.filter((v) => v === 'float').length >= 2, JSON.stringify(where));
      await r.page.screenshot({ path: join(SHOTS, 'tablet-1024-stage.png') });
    } else {
      await r.page.screenshot({ path: join(SHOTS, `tablet-${w}-landscape.png`) });
    }
    await r.ctx.close();
  }
  console.log('\n· tablet 768x1024 (touch, portrait)');
  {
    const r = await remote('tablet-portrait', { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await go(r.page, `${url}/?vault=proj`);
    report.check('AC1 768x1024 touch portrait: the phone layout', await until(async () => { const x = await layout(r.page); return x.phoneList && !x.chrome; }, 30000), JSON.stringify(await layout(r.page)));
    await r.page.waitForTimeout(1500);
    await dismiss(r.page);
    await r.page.screenshot({ path: join(SHOTS, 'tablet-768-portrait.png') });
    await r.ctx.close();
  }
  console.log('\n· phone 390x844');
  {
    const r = await remote('phone-390', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    await go(r.page, `${url}/?vault=proj`);
    report.check('AC1 390x844 phone: the phone layout', await until(async () => { const x = await layout(r.page); return x.phoneList && !x.chrome; }, 30000), JSON.stringify(await layout(r.page)));
    await r.page.waitForTimeout(1500);
    await dismiss(r.page);
    await r.page.screenshot({ path: join(SHOTS, 'phone-390.png') });
    await r.ctx.close();
  }

  // ── AC12 on the Mac: a chat a remote screen holds is skipped at hand-over, by name ───────
  console.log('\n· the Mac window hands third over while a remote screen holds one of its chats');
  {
    const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await deskCtx.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    const desk = await deskCtx.newPage();
    desk.on('pageerror', (e) => errors.push(`mac pageerror: ${String(e).slice(0, 200)}`));
    await desk.goto(`${base}/?vault=third`, { waitUntil: 'domcontentloaded' });
    await desk.waitForTimeout(3000);
    await dismiss(desk);
    await desk.locator('.sidebar-item', { hasText: /^Chat$/ }).first().click().catch(() => {});
    report.check('the Mac window restored third\'s two chats', await until(() => spawns().filter((s) => s.sid === T1 || s.sid === T2).length >= 2, 25000), JSON.stringify(spawns().slice(-4)));
    const r = await remote('computer-third', { viewport: { width: 1440, height: 900 } });
    await go(r.page, `${url}/?vault=third`);
    await until(async () => (await layout(r.page)).tabTitles.includes(TITLES[T1]), 25000);
    await r.page.waitForTimeout(1500);
    await dismiss(r.page);
    await r.page.locator('.agent-tab', { hasText: TITLES[T1] }).first().click({ force: true });
    await r.page.locator('textarea.chat-cmp-input:visible').first().fill('remote holds T1');
    await r.page.keyboard.press('Enter');
    report.check('the remote screen took T1 by sending', await until(() => said().some((x) => x.sid === T1 && x.text === 'remote holds T1'), 15000));
    await desk.waitForTimeout(1500);
    await dismiss(desk);
    // The Mac's chat surface, open (the rail's Chat row; its label carries a count badge).
    await desk.locator('.sidebar-item').filter({ has: desk.locator('.sidebar-label', { hasText: /^Chat$/ }) }).first().click();
    await until(async () => desk.locator('[data-testid="super-handover-btn"]').first().isVisible(), 10000);
    await desk.waitForTimeout(2000);
    await desk.screenshot({ path: join(SHOTS, 'mac-1440-before-handover.png') });
    await desk.locator('[data-testid="super-handover-btn"]').first().click();
    report.check('AC12: the Mac names the chat a remote screen holds, not handed over', await until(async () => ((await desk.locator('[data-testid="super-skipped-remote"]').textContent().catch(() => '')) ?? '').includes(TITLES[T1]), 20000), (await desk.locator('[data-testid="super-skipped-remote"]').textContent().catch(() => '')) ?? '');
    const recPath = join(THIRD, '_dream_context', 'state', '.super-agent.json');
    await until(() => existsSync(recPath), 10000);
    const rec = existsSync(recPath) ? JSON.parse(readFileSync(recPath, 'utf-8')) : {};
    report.check('AC12: T1 is no child of the record; T2 is', !rec.children?.[T1] && !!rec.children?.[T2], JSON.stringify(Object.keys(rec.children ?? {})));
    await desk.screenshot({ path: join(SHOTS, 'mac-1440-skipped-notice.png') });
    await r.ctx.close();
    await deskCtx.close();
  }

  // ── W3: the phone's ONE list over every chosen project, and its chat screen ────────────
  console.log('\n· phone 390x844: one list over every chosen project (W3)');
  {
    const r = await remote('phone-w3', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    const ph = r.page;
    // From the handed-over project: its one Super row, every other project's chats beside it.
    await go(ph, `${url}/?vault=other`);
    report.check('W3: the phone layout', await until(async () => (await layout(ph)).phoneList, 30000));
    await ph.waitForTimeout(2000);
    await dismiss(ph);
    // A chat that waits on the owner: B asks (the Mac holds it).
    holders.B.ws.send(JSON.stringify({ type: 'user', text: 'please ask about the port' }));
    const listInfo = () => ph.evaluate(() => ({
      sections: [...document.querySelectorAll('[data-testid^="list-section-"]')].map((e) => e.getAttribute('data-testid').replace('list-section-', '')),
      rows: [...document.querySelectorAll('[data-testid="phone-list"] .mlist-row')].map((e) => ({ id: e.getAttribute('data-id'), vault: e.getAttribute('data-vault'), kind: e.getAttribute('data-kind'), text: e.textContent })),
      tags: document.querySelectorAll('[data-testid="list-project-tag"]').length,
    }));
    const macLive = async () => { const x = await fetch(`${base}/api/agent/live-chats`, { headers: { 'x-dreamcontext-vault': 'proj' } }); return (await x.json()).chats?.map((c) => [TITLES[c.conversationId] ?? c.conversationId.slice(0, 8), c.state]); };
    report.check('AC15: B waits on you and leads the list', await until(async () => (await listInfo()).sections[0] === 'waiting', 30000), JSON.stringify({ sections: (await listInfo()).sections, mac: await macLive(), said: said().filter((x) => x.sid === B) }));
    const li = await listInfo();
    const order = ['waiting', 'working', 'idle', 'closed'];
    report.check('AC15: sections run waiting → working → idle → closed', li.sections.every((x, k) => k === 0 || order.indexOf(x) > order.indexOf(li.sections[k - 1])), JSON.stringify(li.sections));
    const vaultsListed = [...new Set(li.rows.map((x) => x.vault))].sort();
    report.check('AC15: chats of every chosen project are in the one list, each row tagged', JSON.stringify(vaultsListed) === JSON.stringify(['other', 'proj', 'third']) && li.tags === li.rows.length, JSON.stringify({ vaultsListed, tags: li.tags, rows: li.rows.length }));
    report.check('AC15: a project handed over at the Mac (third) is one Super row too', li.rows.filter((x) => x.vault === 'third').every((x) => x.kind === 'super'), JSON.stringify(li.rows.filter((x) => x.vault === 'third')));
    report.check('AC15: the handed-over project is its one Super row', li.rows.filter((x) => x.vault === 'other').every((x) => x.kind === 'super') && li.rows.some((x) => x.vault === 'other'), JSON.stringify(li.rows.filter((x) => x.vault === 'other')));
    await ph.screenshot({ path: join(SHOTS, 'phone-390-one-list.png') });
    // Search finds a chat in a project the phone is not in.
    await ph.locator('[data-testid="list-search"]').fill('iade');
    report.check('AC15: search finds a chat of another project (Turkish-folded)', await until(async () => (await listInfo()).rows.some((x) => x.vault === 'proj' && /İade/.test(x.text ?? '')), 15000), JSON.stringify((await listInfo()).rows));
    await ph.screenshot({ path: join(SHOTS, 'phone-390-search.png') });
    await ph.locator('.mlist-row[data-vault="proj"]', { hasText: 'İade' }).first().click();
    report.check('AC15: tapping it opens that chat in its project', await until(async () => {
      const t0 = await ph.evaluate(() => ({ url: location.href, title: [...document.querySelectorAll('.mchat-head-title')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent).join('|') }));
      return /İade/.test(t0.title);
    }, 25000), await ph.evaluate(() => [...document.querySelectorAll('.mchat-head-title')].map((e) => e.textContent).join('|')));
    await ph.screenshot({ path: join(SHOTS, 'phone-390-opened-elsewhere.png') });
    // The chat screen: the back badge counts B waiting elsewhere.
    report.check('AC16: the back badge counts the chat waiting elsewhere', await until(async () => ((await ph.locator('[data-testid="chat-back-badge"]:visible').textContent().catch(() => '')) ?? '').trim() === '1', 15000), (await ph.locator('[data-testid="chat-back-badge"]').textContent().catch(() => '')) ?? '');
    // A swipe left moves to the next open chat in the list's order (across projects).
    const swipe = (dx) => ph.evaluate((d) => {
      const el = [...document.querySelectorAll('.chat-scroll, .chat-transcript')].find((e) => e.getBoundingClientRect().width > 0) ?? document.querySelector('.agent-surface');
      const r0 = el.getBoundingClientRect();
      const x = r0.left + r0.width / 2; const y = r0.top + r0.height / 2;
      const mk = (cx) => new Touch({ identifier: 1, target: el, clientX: cx, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [mk(x)], changedTouches: [mk(x)] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [mk(x + d)] }));
    }, dx);
    const headTitle = () => ph.evaluate(() => [...document.querySelectorAll('.mchat-head-title')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent).join('|'));
    const before = await headTitle();
    await swipe(160);
    report.check('AC16: a swipe right moves to the previous open chat', await until(async () => (await headTitle()) !== before, 20000), JSON.stringify({ before, after: await headTitle() }));
    const mid = await headTitle();
    await ph.waitForTimeout(1500);
    await swipe(-160);
    report.check('AC16: a swipe left comes back', await until(async () => (await headTitle()) !== mid, 20000), JSON.stringify({ mid, after: await headTitle() }));
    await ph.screenshot({ path: join(SHOTS, 'phone-390-chat.png') });
    // The toast: another chat starts waiting while this one is on screen.
    // (The Super Agent's chat, which the Mac still holds, starts asking.)
    holders.super.ws.send(JSON.stringify({ type: 'user', text: 'please ask again' }));
    report.check('AC16: the waiting toast appears above the composer', await until(async () => (await ph.locator('[data-testid="chat-waiting-toast"]:visible').count()) === 1, 20000));
    const box = await ph.evaluate(() => {
      const t0 = document.querySelector('[data-testid="chat-waiting-toast"]')?.getBoundingClientRect();
      const c0 = [...document.querySelectorAll('textarea.chat-cmp-input')].find((e) => e.getBoundingClientRect().width > 0)?.getBoundingClientRect();
      return t0 && c0 ? { toastBottom: t0.bottom, composerTop: c0.top } : null;
    });
    report.check('AC16: the toast never covers the composer', !!box && box.toastBottom <= box.composerTop + 1, JSON.stringify(box));
    await ph.screenshot({ path: join(SHOTS, 'phone-390-toast.png') });
    await ph.locator('[data-testid="chat-waiting-toast"]').click();
    report.check('AC16: a tap on the toast opens that chat (in its own project)', await until(async () => /Super/.test(await headTitle()), 25000), await headTitle());
    await r.ctx.close();
    const small = await remote('phone-375', { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await go(small.page, `${url}/?vault=proj`);
    await until(async () => (await layout(small.page)).phoneList, 30000);
    await small.page.waitForTimeout(2000);
    await dismiss(small.page);
    report.check('W3 375x667: the one list, no horizontal overflow', (await layout(small.page)).overflow <= 1, String((await layout(small.page)).overflow));
    await small.page.screenshot({ path: join(SHOTS, 'phone-375-one-list.png') });
    await small.ctx.close();
  }

  const errs = errors.filter((e) => !/__TAURI|status of 401/.test(e));
  report.check('AC19: no console errors on any remote screen', errs.length === 0, errs.slice(0, 10).join('\n      '));
  report.check('AC3: no 4xx/5xx and no laptop-only request from the desktop sessions', bad.length === 0, bad.slice(0, 12).join('\n      '));
  report.check('no 403 at all from the remote pages\' own calls', refused.length === 0, refused.slice(0, 8).join('\n      '));
  console.log(`\n  screenshots: ${SHOTS}`);
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  try { await remoteBrowser?.close(); } catch { /* gone */ }
  for (const h of Object.values(holders)) { try { h.ws.terminate(); } catch { /* gone */ } }
  if (port) { try { await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/stop`, { method: 'POST' }); } catch { /* gone */ } }
  try { proxy?.close(); } catch { /* gone */ }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
if (report.fails.length) { for (const f of report.fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
