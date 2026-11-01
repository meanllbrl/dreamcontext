#!/usr/bin/env node
/**
 * Hands-free on a PHONE, in the NEW SHELL (task hands-free-nin-ayri-telefon-arayuzu-kalkar…, W2:
 * F1-F8, criteria 9, 10, 11, 12, 17; the Bag mode and push rows as before).
 *
 *   npm run build && node scripts/verify/handsfree-mobile.mjs
 *
 * WHAT IT DRIVES — the real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1, power runner
 * that only LOGS), Mac mode started over a real Cloudflare quick tunnel, and Chromium phones
 * (390x844 iPhone 13, 375x667 iPhone SE: touch, coarse pointer) signed in through the tunnel
 * with the one-time QR link, so every request goes through the phone listener's route policy.
 * Then a computer on the tunnel at 1440 (fine pointer), and the laptop window on the main listener.
 *
 * FIXTURE: three chosen projects, `proj` (a chat waiting for you, an idle chat, a past chat),
 * `quiet` (no chat at all) and `other` (handed over to its Super Agent, a past chat), and one
 * UNCHOSEN project, `zanzibar`, with a live chat on the Mac. The unchosen name must appear in no
 * DOM, response body or storage of the phone.
 *
 * PHONE (390x844 touch): F1 the drawer is open at full height over the chosen projects only, the
 * waiting chat marked; F2 a tap closes it and the chat fills the frame, one chat, no tab strip;
 * F3 the keyboard (visualViewport emulated) hides the bottom bar, the composer never zooms; F4 the
 * back gesture returns to the drawer and stays in the app; F5 the bottom bar, More without
 * Settings, no New project, no Hands-free button, the Mac chip, the Tasks/Chat round trips with the
 * drawer closed; F6 every target 44 px; F7 the quiet project's New chat row and one-line empty
 * state, the handed-over project's Super hint and Super row; 10 `__dcPhoneRefused` 0, no 4xx/5xx,
 * no console error; 11 no New chat and no hand-over for the handed-over project; 12 its past chat is
 * absent from History and History reads nothing of it; 17 screenshots light and dark, More's
 * pages, the close confirm. 375x667: the same first screen and a chat, no overflow.
 *
 * HONEST LIMIT — Chromium's phone emulation, not an iPhone: safe-area insets and the real keyboard
 * are the owner's iPhone walk (criterion 18).
 *
 * `--local`: the same checks on the MAIN listener dressed as the phone surface (no tunnel), and
 * the Bag mode Start / running / remembered path with DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL=1.
 *
 * FAILURE POLICY — collect, don't fail fast; exit 0 iff every check passed.
 * Screenshots: tmp/verify-handsfree-mobile/*.png
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The real path: macOS tmpdir is a /var -> /private/var symlink and the chat child files its
// transcripts under its realpath cwd, so a /var project root would never find its past chats.
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-mobile');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const OTHER = join(SCRATCH, 'other');
const QUIET = join(SCRATCH, 'quiet');
const SECRET = join(SCRATCH, 'zanzibar');
const SECRET_NAME = 'zanzibar';
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-mobile');
const CLI = join(REPO, 'dist', 'index.js');
const LOCAL = process.argv.includes('--local');
const CHOSEN = ['proj', 'quiet', 'other'];

const STANDIN = `#!${process.execPath}
/** Inert stand-in for \`claude -p --input-format stream-json\`: one line per turn, transcript rows with cwd. */
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
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
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    // The two-screen check needs a chat waiting for you and one working: ASK raises a question card and
    // waits; WORK <s> says one line and finishes after <s> seconds.
    if (text === 'ASK') {
      const said = { role: 'assistant', content: [{ type: 'text', text: '14 webhooks found, none fired in 90 days.' }] };
      row({ type: 'assistant', message: said }); out({ type: 'assistant', message: said });
      out({ type: 'control_request', request_id: 'ask-' + sid.slice(0, 8), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', requires_user_interaction: true,
        input: { questions: [{ question: 'Delete the old webhooks?', header: 'Webhooks', multiSelect: false, options: [{ label: 'Delete', description: 'remove all 14' }, { label: 'Archive', description: 'keep a copy' }] }] } } });
      continue;
    }
    const work = /^WORK (\\d+)$/.exec(text);
    if (work) {
      const said = { role: 'assistant', content: [{ type: 'text', text: 'Running npm test 412/895' }] };
      row({ type: 'assistant', message: said }); out({ type: 'assistant', message: said });
      setTimeout(() => {
        const done = { role: 'assistant', content: [{ type: 'text', text: 'All 895 green.' }] };
        row({ type: 'assistant', message: done }); out({ type: 'assistant', message: done });
        out({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
      }, Number(work[1]) * 1000);
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
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { console.log(`  ${msg}`); },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}

function cli(args, cwd = PROJ) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, OTHER, QUIET, SECRET, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  // The transcript dir exists before the server first looks (it remembers a miss for its life).
  for (const d of [PROJ, OTHER, QUIET, SECRET]) mkdirSync(join(HOME, '.claude', 'projects', d.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  // The Super Agent is on for this machine (the hand-over of `other` needs it).
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, chatView: true, screenMigrated: true, chatPermissionMode: 'auto', superAgent: true }));
  for (const [name, path] of [['proj', PROJ], ['other', OTHER], ['quiet', QUIET], [SECRET_NAME, SECRET]]) {
    cli(['init', '-y', '--name', name, '--description', 'A scratch project for the phone check'], path);
    const r = cli(['vaults', 'add', name, path]);
    if (r.status !== 0) throw new Error(`vaults add ${name}: ${r.stderr || r.stdout}`);
  }
  // One past chat in proj and in other (handed over: History must never show or read it).
  for (const [d, title] of [[PROJ, 'Proj past fixture'], [OTHER, 'Other past fixture'], [SECRET, 'Zanzibar past fixture']]) {
    const sid = crypto.randomUUID();
    const ts = new Date(Date.now() - 3600_000).toISOString();
    const rows = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: title }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done: ${title}` }] } },
    ].map((o) => JSON.stringify({ ...o, cwd: d, uuid: crypto.randomUUID(), timestamp: ts, sessionId: sid }));
    writeFileSync(join(HOME, '.claude', 'projects', d.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`), `${rows.join('\n')}\n`);
  }
  // Something on every page that lists things.
  for (const t of ['Ship the phone layout', 'Write the release note', 'Fix the drawer label', 'Measure every page on a phone']) cli(['tasks', 'create', t, '--why', 'so the phone pages have something to show']);
  for (const k of ['Phone layout rules', 'Route policy']) cli(['knowledge', 'create', k]);
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
    env: {
      ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: POWER_LOG,
      // --local: Mac mode's Start runs over a loopback stand-in, never a Cloudflare tunnel.
      ...(LOCAL ? { DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' } : {}),
    },
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

/** The phone browser's CONNECT proxy, resolving with {@link freshLookup}. */
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


/**
 * One page, measured: its header (the block holding the first heading, a direct child of the
 * page root) and where the first thing AFTER it starts, from the top of the viewport.
 */
const pageMetrics = (page) => page.evaluate(() => {
  const main = document.querySelector('.shell-main');
  if (!main) return { ok: false };
  const visible = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.height > 0 && b.width > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
  const name = (el) => (el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` : '');
  // The page header: the band around the page title (the first heading near the top), grown
  // to its ancestors only while they stay a band (<= 120px tall).
  // A CENTERED heading is a first-run explainer's hero, which is the page's content, not a
  // header band (an empty Automations or Council page is all hero).
  const title = [...main.querySelectorAll('h1, h2')].find((h) => visible(h) && h.getBoundingClientRect().top < 260 && getComputedStyle(h).textAlign !== 'center');
  let header = title || null;
  while (header && header.parentElement && header.parentElement !== main && header.parentElement.getBoundingClientRect().height <= 120) header = header.parentElement;
  const hb = header ? header.getBoundingClientRect() : null;
  // First content: the TOPMOST visible leaf (no visible element children, or a control) below
  // it — by position, not source order (a hero can paint its media above its copy).
  const leafy = (el) => /^(BUTTON|INPUT|TEXTAREA|SELECT|IMG|SVG|CANVAS|VIDEO|A)$/i.test(el.tagName) || ![...el.children].some(visible);
  let first = null;
  for (const el of main.querySelectorAll('*')) {
    if (header && (header.contains(el) || el.contains(header))) continue;
    if (!visible(el) || !leafy(el) || el.closest('svg') !== null && el.tagName.toLowerCase() !== 'svg') continue;
    const b = el.getBoundingClientRect();
    if (hb && b.top < hb.bottom - 1) continue;
    if ((el.textContent || '').trim() === '' && !/^(BUTTON|INPUT|TEXTAREA|SELECT|IMG|SVG|CANVAS|VIDEO)$/i.test(el.tagName) && b.height < 8) continue;
    if (!first || b.top < first.getBoundingClientRect().top) first = el;
  }
  const wide = [...main.querySelectorAll('*')].filter((el) => {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.right <= window.innerWidth + 1) return false;
    // Inside a horizontal scroller is fine (a swipeable row): only what pushes the PAGE wide counts.
    for (let n = el.parentElement; n && n !== main; n = n.parentElement) { const ox = getComputedStyle(n).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return false; }
    return true;
  }).slice(0, 3).map((el) => `${name(el)} r=${Math.round(el.getBoundingClientRect().right)}`);
  return {
    ok: true,
    headerH: hb ? Math.round(hb.height) : 0,
    headerClass: name(header),
    firstTop: first ? Math.round(first.getBoundingClientRect().top) : -1,
    firstClass: name(first),
    docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    mainOverflow: main.scrollWidth > main.clientWidth + 1,
    wide,
  };
});

/** Console errors, 4xx/5xx, logo/avatar reads, and every response body or socket frame naming
 *  the unchosen project (criteria 9 and 10: the network log alone cannot see a local refusal). */
function watch(page, tag) {
  const errors = []; const bad = []; const leaks = []; const logos = [];
  const path = (u) => u.replace(/^(?:https?|wss?):\/\/[^/]+/, '');
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${String(e).slice(0, 200)}`));
  // A PROJECT's logo or a member's avatar (the app's own /logo.png is the brand, not a project's).
  page.on('request', (r) => { if (/^\/api\/(?:launcher\/logo|peer\/logo|.*avatar)/i.test(path(r.url()))) logos.push(`${tag}: ${path(r.url())}`); });
  page.on('response', async (r) => {
    if (r.status() >= 400) bad.push(`${tag}: ${r.status()} ${r.request().method()} ${path(r.url())}`);
    try {
      const ct = r.headers()['content-type'] ?? '';
      if (/json|text|javascript/.test(ct) && (await r.text()).includes(SECRET_NAME)) leaks.push(`${tag}: body ${path(r.url())}`);
    } catch { /* a redirect or a gone page has no body */ }
  });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => { if (String(f.payload).includes(SECRET_NAME)) leaks.push(`${tag}: frame ${path(ws.url())}`); }));
  return { errors, bad, leaks, logos };
}

const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) {
    const g = page.getByRole('button', { name: 'Got it' });
    if (await g.isVisible().catch(() => false)) { await g.click(); await page.waitForTimeout(300); continue; }
    const x = page.locator('.announcements-modal-close');
    if (!(await x.count())) break;
    await x.first().click().catch(() => {});
    await page.waitForTimeout(300);
  }
};

/** The visualViewport, made shrinkable: `__kb(h)` is a keyboard taking the screen below h. */
const KEYBOARD_SHIM = () => {
  const real = window.visualViewport;
  if (!real) return;
  const ev = new EventTarget();
  let fake = null;
  const vv = {
    get height() { return fake ?? real.height; }, get width() { return real.width; },
    get offsetTop() { return 0; }, get offsetLeft() { return 0; }, get pageTop() { return real.pageTop; }, get pageLeft() { return real.pageLeft; }, get scale() { return 1; },
    addEventListener: (t, f, o) => { ev.addEventListener(t, f, o); real.addEventListener(t, f, o); },
    removeEventListener: (t, f, o) => { ev.removeEventListener(t, f, o); real.removeEventListener(t, f, o); },
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  window.__kb = (h) => { fake = h; ev.dispatchEvent(new Event('resize')); };
};

/** Where each local refusal happened: the rail entry lit, the URL, the call site. */
const REFUSAL_PROBE = () => {
  let n = 0;
  window.__dcRefusals = [];
  Object.defineProperty(window, '__dcPhoneRefused', {
    configurable: true,
    get() { return n; },
    set(v) {
      n = v;
      window.__dcRefusals.push({ on: [...document.querySelectorAll('[data-on="true"]')].map((e) => e.dataset.testid).join(','), url: location.search, stack: String(new Error().stack).split('\n').slice(2, 7).join(' | ') });
    },
  });
};

/** The new shell's frame, read from what Chromium painted. */
const frame = (p) => p.evaluate(() => {
  const shown = (s) => [...document.querySelectorAll(s)].find((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; });
  const r = (s) => { const el = shown(s); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height), w: Math.round(b.width) }; };
  const chrome = document.querySelector('.window-chrome');
  return {
    tb: r('[data-testid="ns-titlebar"]'), rail: r('[data-testid="ns-rail"]'), drawer: r('[data-testid="chat-drawer"]'),
    surface: r('.agent-surface[data-mobile]'), cmp: r('.agent-surface[data-mobile] .chat-cmp'),
    tabs: [...document.querySelectorAll('.agent-surface[data-mobile] [role="tab"], .agent-surface[data-mobile] .agent-tab')].filter((e) => e.getBoundingClientRect().height > 0).length,
    w: innerWidth, h: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth,
    home: document.querySelector('[data-testid="chat-drawer"]')?.getAttribute('data-home') ?? null,
    touch: chrome?.getAttribute('data-touch') ?? null, keyboard: chrome?.getAttribute('data-keyboard') ?? null,
    shell: chrome?.getAttribute('data-shell') ?? null, phone: document.body.dataset.phone ?? null,
  };
});

/** Every visible control in the title bar, the bottom bar and the drawer under 44 px (F6). */
const smallTargets = (p) => p.evaluate(() => [...document.querySelectorAll('[data-testid="ns-titlebar"] button, [data-testid="ns-rail"] button, [data-testid="chat-drawer"] button, [data-testid="chat-drawer"] select')]
  .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })
  .filter((e) => { const b = e.getBoundingClientRect(); return b.height < 43.5 || b.width < 43.5; })
  .map((e) => { const b = e.getBoundingClientRect(); return `${e.dataset.testid ?? e.className}:${Math.round(b.width)}x${Math.round(b.height)}`; }));

let server = null;
let browser = null;
/** The Android check's subscription refusal (see there): its console 400 is expected. */
let expectAndroid400 = false;
let phoneBrowser = null;
let proxy = null;
const watchers = [];
const sockets = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  const { WebSocket: NodeWs } = await import('ws');
  console.log('· scratch vaults, server, Mac mode over a real quick tunnel…');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = await startServer(port);
  browser = await chromium.launch();
  const api = async (vault, method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'X-Dreamcontext-Vault': vault, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  /** A laptop chat socket, the way any desktop client opens one. */
  const laptop = (vault, q) => {
    const ws = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=${vault}&bypass=0&${q}`);
    const s = { ws, closed: null };
    ws.on('close', (code) => { s.closed = code; });
    ws.on('error', () => {});
    sockets.push(s);
    return new Promise((resolve) => { ws.on('open', () => resolve(s)); ws.on('close', () => resolve(s)); });
  };
  const say = async (s, text) => { await sleep(1000); s.ws.send(JSON.stringify({ type: 'user', text })); };

  const setup = await mac(port, 'POST', 'setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));

  // The Mac's chats: proj waits for you (a question) and has an idle chat; the unchosen project
  // runs one; `other` is handed over to its Super Agent (the window's super socket live).
  const ASK_ID = crypto.randomUUID(); const IDLE_ID = crypto.randomUUID(); const SECRET_ID = crypto.randomUUID();
  const ask = await laptop('proj', `sessionId=${ASK_ID}`); await say(ask, 'ASK');
  const idle = await laptop('proj', `sessionId=${IDLE_ID}`); await say(idle, 'hello');
  const secret = await laptop(SECRET_NAME, `sessionId=${SECRET_ID}`); await say(secret, 'WORK 900');
  await sleep(2500);
  idle.ws.close();
  const en = await api('other', 'POST', '/api/super/enable', {});
  const SUPER = en.json.session;
  report.check('other is handed over (a super session recorded)', en.status === 200 && typeof SUPER === 'string', JSON.stringify(en.json).slice(0, 200));
  const win = await laptop('other', `mode=super&sessionId=${SUPER}`);
  report.check('…and its window\'s Super Agent socket is open', win.closed === null);
  await sleep(1500);

  if (!LOCAL) {
    proxy = await startProxy();
    phoneBrowser = await chromium.launch({ proxy: { server: proxy.url } });
    const started = await mac(port, 'POST', 'start', { vaults: CHOSEN });
    report.check('Mac mode starts for the three chosen projects (zanzibar not chosen)', started.status === 200 && !!started.json.url && JSON.stringify([...started.json.exposedVaults].sort()) === JSON.stringify([...CHOSEN].sort()), JSON.stringify(started.json).slice(0, 200));
  } else {
    phoneBrowser = browser;
    report.note('(--local: main listener, no tunnel; not the evidence run)');
  }

  // --local runs on the main listener: dress it as the Mac phone surface (its meta flag).
  const phoneContext = async (opts, { keyboard = false } = {}) => {
    const c = await phoneBrowser.newContext(opts);
    await c.addInitScript(REFUSAL_PROBE);
    if (keyboard) await c.addInitScript(KEYBOARD_SHIM);
    if (LOCAL) await c.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState !== 'interactive' || document.querySelector('meta[name="dreamcontext-surface"]')) return;
        const m = document.createElement('meta'); m.name = 'dreamcontext-surface'; m.content = 'mac'; document.head.appendChild(m);
      });
    });
    return c;
  };
  const signIn = async (opts, tag, extra) => {
    const link = LOCAL ? `${base}/?vault=proj` : (await mac(port, 'POST', 'qr')).json.url;
    const c = await phoneContext(opts, extra);
    const p = await c.newPage();
    const w = watch(p, tag);
    watchers.push(w);
    const ws = [];
    p.on('websocket', (s) => ws.push(s.url()));
    await p.goto(link, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    report.check(`${tag}: signed in, landed in a project`, await until(async () => p.url().includes('vault='), 25000), p.url());
    await p.waitForTimeout(3000);
    await dismiss(p);
    return { c, p, w, ws };
  };
  const drawerShown = (p) => p.locator('[data-testid="chat-drawer"]').isVisible().catch(() => false);
  const projRow = (p, v) => p.locator(`[data-drawer-project="${v}"]`);
  const drawerNames = (p) => p.locator('[data-drawer-project]').evaluateAll((els) => els.map((e) => e.getAttribute('data-drawer-project')));
  const expand = async (p, v) => {
    const t = projRow(p, v).locator('[data-testid="drawer-project-row"]');
    if ((await t.getAttribute('aria-expanded')) !== 'true') { await t.click(); await p.waitForTimeout(500); }
  };
  const openDrawer = async (p) => { if (!(await drawerShown(p))) { await p.getByTestId('ns-drawer-toggle').click(); await until(() => drawerShown(p), 4000); } };
  const railOn = (p, id) => p.locator(`[data-testid="${id}"][data-on="true"]`).count().then((n) => n > 0);
  const chatShown = async (p) => { const f = await frame(p); return !!f.surface && !(await drawerShown(p)); };
  const pick = async (p, vault) => {
    await p.getByTestId('ns-picker-btn').click();
    await p.getByTestId(`ns-picker-${vault}`).click();
    await p.waitForTimeout(1500);
  };
  const leaksIn = (p) => p.evaluate((name) => {
    const store = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return JSON.stringify(o); };
    return { dom: document.documentElement.outerHTML.includes(name), storage: store(localStorage).includes(name) || store(sessionStorage).includes(name), title: document.title.includes(name) };
  }, SECRET_NAME);

  // ── PHONE 390x844, touch, over the tunnel ───────────────────────────────────────
  console.log('\n── phone 390x844 (touch) over the tunnel');
  const { c: ctx, p: ph, w: phw, ws: phSockets } = await signIn({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } }, 'phone 390', { keyboard: true });
  report.check('the page is a phone (narrow AND coarse pointer)', await ph.evaluate(() => matchMedia('(max-width: 768px)').matches && matchMedia('(pointer: coarse)').matches));

  // F1: the drawer open at full height over the chosen projects only, the waiting chat marked.
  report.check('F1 the phone opens with the drawer open', await until(() => drawerShown(ph), 15000));
  await until(async () => (await projRow(ph, 'proj').locator('[data-testid="drawer-chat-row"][data-state="asking"]').count()) > 0, 25000);
  let f = await frame(ph);
  report.check(`F1 the new shell, the title bar on top, the drawer at full height between it and the bottom bar (drawer ${f.drawer?.top}-${f.drawer?.bottom}, title bar to ${f.tb?.bottom}, bar from ${f.rail?.top})`,
    f.shell === 'new' && f.home === 'true' && !!f.tb && !!f.drawer && !!f.rail && f.tb.top <= 1 && Math.abs(f.drawer.top - f.tb.bottom) <= 2 && Math.abs(f.drawer.bottom - f.rail.top) <= 2 && f.drawer.w >= f.w - 1 && f.rail.bottom >= f.h - 1, JSON.stringify(f));
  const names = await drawerNames(ph);
  report.check('F1 the drawer lists the chosen projects only', JSON.stringify([...names].sort()) === JSON.stringify([...CHOSEN].sort()), JSON.stringify(names));
  const askRow = projRow(ph, 'proj').locator('[data-testid="drawer-chat-row"][data-state="asking"]');
  report.check('F1 the waiting chat is visibly marked (its row reads asking, its dot painted)', (await askRow.count()) === 1 && await askRow.locator('.ns-dr-cdot').isVisible(), String(await askRow.count()));
  report.check('F1 the idle chat the Mac keeps is a row too', await until(async () => (await projRow(ph, 'proj').locator(`[data-testid="drawer-chat-row"][data-chat-id="${IDLE_ID}"]`).count()) === 1, 10000));
  if (!LOCAL) report.check('the drawer\'s foot holds the notifications row ("needs the fixed address" on a quick tunnel)', (await ph.locator('[data-testid="drawer-foot"] [data-testid="push-optin"]').getAttribute('data-state').catch(() => null)) === 'quick');
  await ph.screenshot({ path: join(SHOTS, '390-light-first-screen.png') });
  await ph.emulateMedia({ colorScheme: 'dark' });
  await ph.waitForTimeout(500);
  await ph.screenshot({ path: join(SHOTS, '390-dark-first-screen.png') });
  await ph.emulateMedia({ colorScheme: 'light' });

  // F5: the bottom bar and the chrome.
  const barIds = await ph.locator('[data-testid="ns-rail"] [data-testid^="ns-rail-"]').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.dataset.testid));
  report.check('F5 the bottom bar is Chat, Tasks, AI Team, Insights, More', JSON.stringify(barIds) === JSON.stringify(['ns-rail-chat', 'ns-rail-tasks', 'ns-rail-automations', 'ns-rail-lab', 'ns-rail-more']), JSON.stringify(barIds));
  report.check('F5 no Hands-free button; the Mac chip sits in the title bar', (await ph.locator('[data-testid="hf-button"]:visible').count()) === 0 && await ph.locator('[data-testid="ns-titlebar"] [data-testid="ns-phone-chip"]').isVisible());
  report.check('F5 no New project, no Relations in the drawer', (await ph.locator('[data-testid="drawer-new-project"], [data-testid="drawer-new-project-row"], [data-testid="drawer-relations"]').count()) === 0);
  await ph.getByTestId('ns-picker-btn').click();
  await ph.waitForTimeout(400);
  const pickerNames = await ph.locator('[data-testid^="ns-picker-"]').evaluateAll((els) => els.map((e) => e.dataset.testid).filter((t) => t !== 'ns-picker-btn' && t !== 'ns-picker'));
  report.check('F5 the project picker offers the chosen projects and no New project', JSON.stringify([...pickerNames].sort()) === JSON.stringify(CHOSEN.map((v) => `ns-picker-${v}`).sort()), JSON.stringify(pickerNames));
  await ph.screenshot({ path: join(SHOTS, '390-picker.png') });
  await ph.keyboard.press('Escape');
  await ph.waitForTimeout(300);
  if (await ph.getByTestId('ns-picker').isVisible().catch(() => false)) await ph.getByTestId('ns-picker-btn').click();
  report.check('F6 every target in the title bar, the bottom bar and the drawer is 44 px', await until(async () => (await smallTargets(ph)).length === 0, 1500), JSON.stringify(await smallTargets(ph)));

  // F5: from the first screen, Tasks shows the page with the drawer closed; Chat shows the chat.
  await ph.getByTestId('ns-rail-tasks').click();
  report.check('F5 first screen → Tasks: the page, the drawer closed', await until(async () => (await railOn(ph, 'ns-rail-tasks')) && !(await drawerShown(ph)), 5000));
  await ph.waitForTimeout(800);
  await ph.screenshot({ path: join(SHOTS, '390-tasks.png') });
  await ph.getByTestId('ns-rail-chat').click();
  report.check('F5 …then Chat: the chat, the drawer closed', await until(async () => (await railOn(ph, 'ns-rail-chat')) && (await chatShown(ph)), 5000), JSON.stringify(await frame(ph)));
  // …and the same from a page with the drawer opened by the toggle.
  await ph.getByTestId('ns-rail-tasks').click();
  await until(() => railOn(ph, 'ns-rail-tasks'), 4000);
  await openDrawer(ph);
  report.check('the toggle opens the drawer over a page', await drawerShown(ph));
  await ph.getByTestId('ns-rail-chat').click();
  report.check('F5 toggled drawer on a page → Chat: the chat, the drawer closed', await until(async () => (await railOn(ph, 'ns-rail-chat')) && (await chatShown(ph)), 5000));
  await openDrawer(ph);
  await ph.getByTestId('ns-rail-tasks').click();
  report.check('F5 toggled drawer over the chat → Tasks: the page, the drawer closed', await until(async () => (await railOn(ph, 'ns-rail-tasks')) && !(await drawerShown(ph)), 5000));

  // F5 + 17: More, without Settings; every More page fits.
  await ph.getByTestId('ns-rail-more').click();
  await until(() => ph.getByTestId('ns-more-menu').isVisible(), 4000);
  const more = await ph.locator('[data-testid="ns-more-menu"] [data-testid^="ns-more-"]').evaluateAll((els) => els.map((e) => e.dataset.testid.replace('ns-more-', '')));
  report.check('F5 More holds no Settings and no Relations', more.length > 0 && !more.includes('settings') && !more.includes('relations'), JSON.stringify(more));
  await ph.screenshot({ path: join(SHOTS, '390-more.png') });
  await ph.keyboard.press('Escape');
  for (const pg of more) {
    if (!(await ph.getByTestId('ns-more-menu').isVisible().catch(() => false))) await ph.getByTestId('ns-rail-more').click();
    await ph.getByTestId(`ns-more-${pg}`).click();
    await ph.waitForTimeout(1600);
    await dismiss(ph);
    const m = await pageMetrics(ph);
    const fr = await frame(ph);
    await ph.screenshot({ path: join(SHOTS, `390-more-${pg}.png`) });
    report.check(`17 More → ${pg}: fits (no sideways overflow), the drawer closed`, m.ok && !m.docOverflow && !m.mainOverflow && m.wide.length === 0 && fr.overflow <= 1 && !(await drawerShown(ph)), JSON.stringify({ m, overflow: fr.overflow }));
  }

  // F2: tap the waiting chat: the drawer closes, the chat fills the frame, one chat, no tab strip.
  await ph.getByTestId('ns-rail-chat').click();
  await openDrawer(ph);
  await expand(ph, 'proj');
  await projRow(ph, 'proj').locator('[data-testid="drawer-chat-row"][data-state="asking"]').click();
  report.check('F2 a tap closes the drawer and shows that chat (its question on screen)', await until(async () => (await chatShown(ph)) && (await ph.locator('.agent-surface[data-mobile] .chat-pane:visible').first().innerText().catch(() => '')).includes('Delete the old webhooks?'), 20000));
  await ph.waitForTimeout(800);
  f = await frame(ph);
  report.check(`F2 the chat fills edge to edge between the title bar and the bottom bar (${f.surface?.left}..${f.surface?.right} x ${f.surface?.top}..${f.surface?.bottom}), no tab strip (${f.tabs})`,
    !!f.surface && f.surface.left <= 0 && f.surface.right >= f.w && Math.abs(f.surface.top - f.tb.bottom) <= 2 && Math.abs(f.surface.bottom - f.rail.top) <= 2 && f.tabs === 0 && f.overflow <= 1, JSON.stringify(f));
  await ph.screenshot({ path: join(SHOTS, '390-light-chat.png') });
  await ph.emulateMedia({ colorScheme: 'dark' });
  await ph.waitForTimeout(500);
  await ph.screenshot({ path: join(SHOTS, '390-dark-chat.png') });
  await ph.emulateMedia({ colorScheme: 'light' });

  // F3: the keyboard up (visualViewport shrunk): the bottom bar goes, the composer never zooms.
  const input = ph.locator('.agent-surface[data-mobile] .chat-cmp-input:visible').first();
  await input.click();
  await ph.evaluate(() => window.__kb?.(500));
  await ph.waitForTimeout(500);
  f = await frame(ph);
  const fontPx = await input.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  report.check(`F3 keyboard up: the bottom bar is gone, the composer stays on screen, its text is ${fontPx}px (>= 16: no zoom)`, f.keyboard === 'true' && !f.rail && !!f.cmp && fontPx >= 16, JSON.stringify({ keyboard: f.keyboard, rail: f.rail, cmp: f.cmp, fontPx }));
  await ph.screenshot({ path: join(SHOTS, '390-keyboard.png') });
  await ph.evaluate(() => { window.__kb?.(null); document.activeElement?.blur?.(); });
  await ph.waitForTimeout(400);
  report.check('F3 keyboard down: the bottom bar is back', !!(await frame(ph)).rail);

  // F4: the back gesture returns to the drawer and never leaves the app.
  const url = ph.url();
  await ph.goBack();
  report.check('F4 the back gesture returns to the drawer, in the app', await until(() => drawerShown(ph), 6000) && ph.url().includes('vault='), `${url} -> ${ph.url()}`);

  // 17: the close confirm. Only this phone's own chat closes from the phone (a Mac chat it never
  // adopted has no close); the adopted chat is waiting for an answer, so it asks first.
  await expand(ph, 'proj');
  const askChat = projRow(ph, 'proj').locator('.ns-dr-chat.is-closable', { has: ph.locator('[data-testid="drawer-chat-row"][data-state="asking"]') });
  const closeBtn = askChat.locator('[data-testid="drawer-chat-close"]');
  report.check('the adopted chat\'s close is a visible target on touch', await closeBtn.isVisible().catch(() => false));
  await closeBtn.click().catch(() => {});
  const dialog = ph.getByRole('alertdialog');
  report.check('17 a chat waiting for an answer asks before it closes, in the app\'s own dialog', await dialog.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false));
  await ph.screenshot({ path: join(SHOTS, '390-close-confirm.png') });
  await dialog.getByRole('button', { name: 'Keep it open' }).click().catch(() => {});
  await ph.waitForTimeout(500);
  report.check('…Keep keeps it', (await askChat.count()) === 1);
  const macRowClose = await projRow(ph, 'proj').locator(`.ns-dr-chat:has([data-chat-id="${IDLE_ID}"]) [data-testid="drawer-chat-close"]`).count();
  report.check('a Mac chat this phone never opened has no close on the phone', macRowClose === 0, String(macRowClose));

  // F7: the quiet project: a New chat row, and a one-line empty state, not the setup screen.
  await expand(ph, 'quiet');
  report.check('F7 the quiet project offers a New chat row', await until(async () => (await projRow(ph, 'quiet').locator('[data-testid="drawer-new-chat"]').count()) === 1, 6000));
  await pick(ph, 'quiet');
  if (await drawerShown(ph)) await ph.getByTestId('ns-drawer-toggle').click();
  const empty = ph.locator('.project-instance:not([hidden]) [data-testid="chat-empty"]');
  report.check('F7 its Chat page is the one-line empty state with New chat', await until(async () => (await empty.isVisible()) && (await empty.locator('[data-testid="chat-empty-new"]').isVisible()), 10000));
  const lineH = await empty.locator('.mchat-empty-line').evaluate((e) => Math.round(e.getBoundingClientRect().height)).catch(() => -1);
  report.check(`F7 …one line (${lineH}px), no desktop setup screen`, lineH > 0 && lineH <= 48 && (await ph.locator('.project-instance:not([hidden]) .agent-setup:visible, .project-instance:not([hidden]) .chat-setup:visible').count()) === 0);
  await ph.screenshot({ path: join(SHOTS, '390-quiet-empty.png') });

  // F7 + 11 + 12: the handed-over project.
  await pick(ph, 'other');
  if (await drawerShown(ph)) await ph.getByTestId('ns-drawer-toggle').click();
  const oEmpty = ph.locator('.project-instance:not([hidden]) [data-testid="chat-empty"]');
  report.check('F7 the handed-over project shows the Super hint and the Super row button, no New chat', await until(async () => (await oEmpty.isVisible()) && (await oEmpty.locator('[data-testid="chat-empty-super"]').isVisible()) && (await oEmpty.locator('[data-testid="chat-empty-new"]').count()) === 0, 10000));
  await ph.screenshot({ path: join(SHOTS, '390-handed-over-empty.png') });
  await openDrawer(ph);
  await expand(ph, 'other');
  const otherRows = await projRow(ph, 'other').locator('[data-testid="drawer-chat-row"] .ns-dr-t').allTextContents();
  report.check('11 the handed-over project offers no New chat in the drawer, only its Super Agent row', (await projRow(ph, 'other').locator('[data-testid="drawer-new-chat"]').count()) === 0
    && JSON.stringify(otherRows) === '["Super Agent"]', JSON.stringify(otherRows));
  report.check('11 no New chat in the chat head, no hand-over anywhere on the phone', (await ph.locator('[data-testid="chat-head-new"]:visible, [data-testid="super-handover-btn"]:visible').count()) === 0);
  // 12: History with the handed-over project ACTIVE: no read for it, its past chat absent.
  const histReads = [];
  const onReq = (r) => { const u = r.url(); if (/history|past|sessions|transcript/i.test(u) && (r.headers()['x-dreamcontext-vault'] === 'other' || /[?&]vault=other\b/.test(u))) histReads.push(u.replace(/^https?:\/\/[^/]+/, '')); };
  ph.on('request', onReq);
  await ph.getByTestId('drawer-history').click();
  const histOpen = await until(async () => (await ph.locator('.chp-row', { hasText: 'Proj past fixture' }).count()) > 0, 20000);
  report.check('12 History opens (proj\'s past chat listed)', histOpen);
  const histProjects = await ph.getByTestId('chp-projects').innerText().catch(() => '');
  report.check('12 …the handed-over project\'s past chat is absent, the project not offered, no surface picker of its own', (await ph.locator('.chp-row', { hasText: 'Other past fixture' }).count()) === 0 && !/\bother\b/.test(histProjects), histProjects);
  await ph.screenshot({ path: join(SHOTS, '390-history.png') });
  await ph.waitForTimeout(1500);
  ph.off('request', onReq);
  report.check('12 History issued no read for the handed-over project', histReads.length === 0, JSON.stringify(histReads));
  // A pick in a project that is NOT handed over opens that chat (review W2 C1: with 2+ chosen
  // projects the guard's read must name the project, or every pick is refused with a 400).
  const pickBad = phw.bad.length;
  await ph.locator('.chp-row', { hasText: 'Proj past fixture' }).first().click();
  report.check('12 a History pick in proj opens that past chat, the drawer closed', await until(async () => (await chatShown(ph)) && (await ph.locator('.project-instance:not([hidden]) .chat-pane:visible').first().innerText().catch(() => '')).includes('Proj past fixture'), 20000));
  report.check('12 …with no 4xx/5xx on the way', phw.bad.length === pickBad, JSON.stringify(phw.bad.slice(pickBad)));
  await ph.screenshot({ path: join(SHOTS, '390-history-pick.png') });
  await pick(ph, 'other');
  // F7: the Super row opens the Super Agent (a mirror of the window's session).
  await openDrawer(ph);
  await projRow(ph, 'other').locator('[data-testid="drawer-chat-row"]', { hasText: 'Super Agent' }).click();
  report.check('F7 the Super row opens the Super Agent\'s chat (the phone\'s socket names its session)', await until(async () => phSockets.some((u) => u.includes(SUPER)) && (await chatShown(ph)), 15000), JSON.stringify(phSockets.slice(-3)));
  report.check('11 the window keeps its Super socket (a mirror, never a takeover)', win.closed === null, String(win.closed));
  await ph.screenshot({ path: join(SHOTS, '390-super.png') });

  // 9 + 10, for this phone.
  const leak = await leaksIn(ph);
  report.check('9 the unchosen project\'s name is in no DOM, storage or title', !leak.dom && !leak.storage && !leak.title, JSON.stringify(leak));
  const refused = await ph.evaluate(() => window.__dcPhoneRefused ?? 0);
  report.check(`10 ApiClient refused nothing locally (__dcPhoneRefused ${refused})`, refused === 0, JSON.stringify(await ph.evaluate(() => window.__dcRefusals ?? [])));
  await ctx.close();

  // ── PHONE 375x667 ────────────────────────────────────────────────────────────────
  console.log('\n── phone 375x667 (touch)');
  const se = await signIn({ ...devices['iPhone SE'], viewport: { width: 375, height: 667 } }, 'phone 375');
  report.check('375: the drawer is open at full height', await until(() => drawerShown(se.p), 15000) && (await frame(se.p)).home === 'true');
  await until(async () => (await projRow(se.p, 'proj').locator('[data-testid="drawer-chat-row"]').count()) > 0, 20000);
  await se.p.screenshot({ path: join(SHOTS, '375-first-screen.png') });
  await expand(se.p, 'proj');
  await projRow(se.p, 'proj').locator('[data-testid="drawer-chat-row"]').first().click();
  report.check('375: a tap shows the chat, the drawer closed', await until(() => chatShown(se.p), 15000));
  await se.p.waitForTimeout(600);
  f = await frame(se.p);
  report.check(`375: the chat fills the frame, no sideways overflow (${f.overflow})`, !!f.surface && f.surface.right >= f.w && f.overflow <= 1 && f.tabs === 0, JSON.stringify(f));
  await se.p.screenshot({ path: join(SHOTS, '375-chat.png') });
  report.check('9/10 375: no unchosen name in the DOM or storage, nothing refused', !(await leaksIn(se.p)).dom && (await se.p.evaluate(() => window.__dcPhoneRefused ?? 0)) === 0, JSON.stringify({ leak: await leaksIn(se.p), refusals: await se.p.evaluate(() => window.__dcRefusals ?? []) }));
  await se.c.close();

  // ── A COMPUTER on the tunnel at 1440 (fine pointer) ─────────────────────────────
  console.log('\n── computer 1440x900 over the tunnel');
  const pc = await signIn({ viewport: { width: 1440, height: 900 } }, 'computer 1440');
  await until(async () => (await pc.p.locator('[data-testid="ns-titlebar"]').count()) > 0, 15000);
  f = await frame(pc.p);
  report.check('15 the computer opens the new shell, no phone layout, no touch title bar', f.shell === 'new' && f.phone === null && f.touch === null && f.home === null, JSON.stringify(f));
  report.check('15 no Settings on the rail, no Hands-free button, the Mac chip', (await pc.p.locator('[data-testid="ns-rail-settings"]').count()) === 0 && (await pc.p.locator('[data-testid="hf-button"]:visible').count()) === 0 && await pc.p.getByTestId('ns-phone-chip').isVisible());
  await openDrawer(pc.p);
  report.check('15 the drawer lists the chosen projects only', JSON.stringify([...(await drawerNames(pc.p))].sort()) === JSON.stringify([...CHOSEN].sort()));
  report.check('17 1440: no sideways overflow', f.overflow <= 1);
  await pc.p.screenshot({ path: join(SHOTS, '1440-tunnel-light.png') });
  await pc.p.emulateMedia({ colorScheme: 'dark' });
  await pc.p.waitForTimeout(500);
  await pc.p.screenshot({ path: join(SHOTS, '1440-tunnel-dark.png') });
  report.check('9/10 1440: no unchosen name in the DOM or storage, nothing refused', !(await leaksIn(pc.p)).dom && (await pc.p.evaluate(() => window.__dcPhoneRefused ?? 0)) === 0, JSON.stringify({ leak: await leaksIn(pc.p), refusals: await pc.p.evaluate(() => window.__dcRefusals ?? []) }));
  await pc.c.close();

  if (!LOCAL) {
    // Notifications on an ANDROID phone over the quick tunnel (owner, 2026-10-17: none ever came):
    // a plain Chrome tab subscribes, so the button shows there, with the note that the address
    // changes per start; the iPhone runs above still read "needs the fixed address".
    console.log('\n── android phone 412x915: notifications on a quick address');
    const aqr = (await mac(port, 'POST', 'qr')).json.url;
    // Chromium's NEW headless mode (the old headless shell answers every Notification.permission
    // with "denied") and a PERSISTENT profile (a fresh context is incognito, where Chrome has no
    // Push API at all): the closest a script gets to the owner's Android Chrome.
    const androidProfile = join(SCRATCH, 'android-profile');
    rmSync(androidProfile, { recursive: true, force: true });
    const actx = await chromium.launchPersistentContext(androidProfile, { ...devices['Pixel 7'], channel: 'chromium', proxy: { server: proxy.url } });
    await actx.grantPermissions(['notifications'], { origin: new URL(aqr).origin });
    const ap = await actx.newPage();
    watchers.push(watch(ap, 'android'));
    await ap.goto(aqr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await until(async () => ap.url().includes('vault='), 25000);
    await ap.waitForTimeout(3000);
    await dismiss(ap);
    report.check('android: the list offers "Turn on notifications" on the quick address, with the per-start note', await until(async () => (await ap.locator('[data-testid="push-optin"]').getAttribute('data-state')) === 'off'
      && (await ap.locator('[data-testid="push-enable"]:visible').count()) === 1 && (await ap.locator('[data-testid="push-quick-note"]:visible').count()) === 1, 20000),
      String(await ap.locator('[data-testid="push-optin"]').getAttribute('data-state').catch(() => null)));
    await ap.screenshot({ path: join(SHOTS, 'android-412-list-push.png') });
    // The tap asks for the permission, subscribes through the browser's real push service and
    // hands the subscription to the Mac over the tunnel. Unbranded Chromium subscribes at
    // jmt17.google.com, which the Mac's push-host allow-list does not hold (Android Chrome uses
    // fcm.googleapis.com, which it does), so here the Mac's answer is 200 or exactly that refusal.
    // Recorded from inside the page (a wrapped fetch): neither the page's nor the context's
    // response events report a request its service worker answers.
    await ap.evaluate(() => {
      const f = window.fetch.bind(window);
      window.__puts = [];
      window.fetch = async (input, init) => {
        const r = await f(input, init);
        try {
          const u = String(input?.url ?? input);
          if (u.endsWith('/api/handsfree/push/subscription') && (init?.method ?? 'GET') === 'PUT') {
            window.__puts.push({ status: r.status, host: new URL(JSON.parse(init.body).endpoint).hostname, body: await r.clone().text() });
          }
        } catch { /* not ours */ }
        return r;
      };
    });
    const putNow = () => ap.evaluate(() => window.__puts?.[0] ?? null);
    let put = null;
    await ap.locator('[data-testid="push-enable"]').click();
    await until(async () => (put = await putNow()) !== null || (await ap.locator('[data-testid="push-optin"]').getAttribute('data-state')) === 'on', 45000);
    // When nothing reached the Mac, say which step stopped (permission, worker, key, subscribe).
    const why = put ? null : await ap.evaluate(async () => {
      const out = { permission: Notification.permission };
      try {
        const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('no active worker in 10 s')), 10000))]);
        out.worker = reg.active?.scriptURL ?? null;
        const k = await fetch('/api/handsfree/push/key', { credentials: 'same-origin' });
        out.key = k.status;
        const { publicKey } = await k.json();
        const b = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4));
        const sub = await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(b, (x) => x.charCodeAt(0)) }), new Promise((_, no) => setTimeout(() => no(new Error('subscribe hung 20 s')), 20000))]);
        out.endpointHost = new URL(sub.endpoint).hostname;
      } catch (e) { out.error = `${e.name}: ${e.message}`; }
      return out;
    }).catch((e) => ({ evalError: String(e) }));
    const KNOWN = ['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com'];
    report.check(`android: the tap asks, subscribes and hands the subscription to the Mac (PUT ${put?.status}, push host ${put?.host})`,
      !!put && !!put.host && (put.status === 200 || (put.status === 400 && !KNOWN.includes(put.host) && /invalid_subscription/.test(put.body))), JSON.stringify(put ?? why));
    // That refusal is the console's "status of 400" here (once per PUT, and the opt-in row puts
    // again on its next check): expected for this test browser only, so the console check below
    // lets exactly that line through for this page.
    expectAndroid400 = put?.status === 400 && !KNOWN.includes(put.host);
    await ap.screenshot({ path: join(SHOTS, 'android-412-list-push-after.png') });
    await actx.close();
  }

  // ── AC10: the notifications row in a Safari tab and in the installed app. A quick tunnel
  // (checked above) cannot show these, and a fixed address needs a Cloudflare domain, so the
  // main listener is dressed as the phone surface (its meta flag) at an iPhone size.
  // Without a grant, notification permission reads "denied": the "blocked" row (the owner said no);
  // granted and not yet subscribed is "off" with the button. The headless SHELL answers "denied"
  // even when granted, so these run in full Chromium's headless mode (channel 'chromium').
  const permBrowser = await chromium.launch({ channel: 'chromium' });
  for (const [label, standalone, granted, want] of [['Safari tab', false, false, 'install'], ['installed app, notifications allowed', true, true, 'off'], ['installed app, notifications refused', true, false, 'blocked']]) {
    const ectx = await permBrowser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, permissions: granted ? ['notifications'] : [] });
    await ectx.addInitScript(({ standalone: sa }) => {
      if (sa) Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
      document.addEventListener('readystatechange', () => {
        if (document.readyState !== 'interactive' || document.querySelector('meta[name="dreamcontext-surface"]')) return;
        const m = document.createElement('meta'); m.name = 'dreamcontext-surface'; m.content = 'mac'; document.head.appendChild(m);
      });
    }, { standalone });
    const ep = await ectx.newPage();
    await ep.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await ep.waitForTimeout(3000);
    await dismiss(ep);
    // The notifications row is in the drawer's foot (the drawer is open on the first screen).
    await until(async () => (await ep.locator('[data-testid="chat-drawer"]:visible').count()) > 0, 20000);
    await until(async () => (await ep.locator('[data-testid="push-optin"]').count()) > 0, 8000);
    await ep.waitForTimeout(600);
    const st = await ep.locator('[data-testid="push-optin"]').getAttribute('data-state');
    const btn = await ep.locator('[data-testid="push-enable"]').count();
    await ep.screenshot({ path: join(SHOTS, `390x844-push-${want}.png`) });
    report.check(`AC10 ${label}: the notifications row is "${want}"${want === 'off' ? ' with the Turn on button' : ', no button'} (${st})`, st === want && btn === (want === 'off' ? 1 : 0));
    await ectx.close();
  }
  await permBrowser.close();

  // ── AC14 (+ AC16's checklist): the laptop is unchanged ─────────────────────────────
  console.log('\n── desktop 1440x900 (classic shell: F8, classic users see no change)');
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'classic' }));
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desk = await deskCtx.newPage();
  watchers.push(watch(desk, 'desktop'));
  await desk.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
  await desk.goto(`${base}/?vault=proj&page=tasks`, { waitUntil: 'domcontentloaded' });
  await desk.waitForTimeout(4000);
  await dismiss(desk);
  for (let i = 0; i < 3; i++) { await desk.keyboard.press('Escape'); await desk.waitForTimeout(200); }
  const dm = await desk.evaluate(() => {
    const r = (s) => { const el = document.querySelector(s); return el ? el.getBoundingClientRect() : null; };
    const tokens = getComputedStyle(document.documentElement);
    return {
      phone: document.body.dataset.phone ?? null,
      sidebarW: Math.round(r('.sidebar')?.width ?? -1),
      sidebarToken: tokens.getPropertyValue('--sidebar-width').trim(),
      chromeH: Math.round(r('.window-chrome-bar')?.height ?? -1),
      phoneBar: !!document.querySelector('.phone-bar'),
      labels: [...document.querySelectorAll('.sidebar .sidebar-label')].map((x) => x.textContent.trim()),
    };
  });
  await desk.screenshot({ path: join(SHOTS, '1440-tasks.png') });
  report.check(`AC14 desktop: no phone mode, sidebar ${dm.sidebarW}px = ${dm.sidebarToken}, Settings present, window bar shown (${dm.chromeH}px), no phone bar`,
    dm.phone === null && dm.sidebarToken === `${dm.sidebarW}px` && dm.sidebarW === 220 && dm.labels.includes('Settings') && dm.chromeH > 0 && !dm.phoneBar, JSON.stringify(dm));
  // The Mac panel's project checklist (AC16): Return first, so the panel shows the start screen.
  await mac(port, 'POST', 'stop');
  await desk.locator('[data-testid="hf-button"]:visible').first().click();
  report.check('AC16 the panel lists the registered projects, the current one checked', await until(async () => (await desk.locator('[data-testid="hf-mac-projects"] label').count()) === 4, 10000)
    && await desk.locator('[data-testid="hf-mac-projects"] label', { hasText: 'proj' }).first().locator('input').isChecked()
    && !(await desk.locator('[data-testid="hf-mac-projects"] label', { hasText: 'other' }).locator('input').isChecked()));
  await desk.screenshot({ path: join(SHOTS, '1440-mac-panel-projects.png') });
  await desk.locator('[data-testid="hf-mac-projects"] label', { hasText: 'proj' }).first().locator('input').uncheck();
  report.check('AC16 Start is disabled with no project checked', await desk.locator('[data-testid="hf-mac-start"]').isDisabled());
  await desk.locator('[data-testid="hf-mac-projects"] label', { hasText: 'proj' }).first().locator('input').check();
  report.check('AC16 …and enabled again with one', !(await desk.locator('[data-testid="hf-mac-start"]').isDisabled()));

  // ── Bag mode: the switch, Start sends it, remembered after a reload ──────────────
  console.log('\n── desktop 1440x900: Bag mode');
  const bagRow = desk.locator('[data-testid="hf-mac-bag-row"]');
  const bagSwitch = bagRow.locator('input[role="switch"]');
  /** Where the row sits and whether anything spills sideways (the sheet, the page). */
  const bagGeom = (page) => page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="hf-sheet"]');
    const row = document.querySelector('[data-testid="hf-mac-bag-row"]');
    const sw = row?.querySelector('input[role="switch"]');
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const rs = r(sheet); const rr = r(row); const rw = r(sw);
    return {
      // The checklist sits in its own card: the row follows that card (or the bare checklist).
      afterChecklist: !!row?.previousElementSibling && (row.previousElementSibling.getAttribute('data-testid') === 'hf-mac-projects' || !!row.previousElementSibling.querySelector(':scope > [data-testid="hf-mac-projects"]')),
      sheetOverflow: sheet ? sheet.scrollWidth > sheet.clientWidth + 1 : true,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      inSheet: !!(rs && rr && rr.left >= rs.left - 1 && rr.right <= rs.right + 1),
      rowW: Math.round(rr?.width ?? 0), rowH: Math.round(rr?.height ?? 0),
      switchW: Math.round(rw?.width ?? 0), switchH: Math.round(rw?.height ?? 0),
    };
  });
  report.check('Bag mode: the row shows before Start', await until(async () => await bagRow.isVisible(), 10000));
  const bagText = (await bagRow.textContent().catch(() => '')) ?? '';
  report.check('Bag mode: the row reads "Bag mode" with its one-line hint',
    bagText.includes('Bag mode') && bagText.includes('Turn on if the lid goes shut in a bag.'), bagText);
  report.check('Bag mode: the switch is on by default (never chosen, or a start that sent no choice)', await bagSwitch.isChecked().catch(() => false));
  const g1440 = await bagGeom(desk);
  report.check('Bag mode: the row sits directly under the project checklist', g1440.afterChecklist, JSON.stringify(g1440));

  // The whole row is the target: its title, the switch itself, then its hint.
  await bagRow.locator('.hf-mac-bag-title').click();
  const offByTitle = await until(async () => !(await bagSwitch.isChecked()), 3000);
  await bagSwitch.click();
  const onBySwitch = await until(async () => await bagSwitch.isChecked(), 3000);
  await bagRow.locator('.hf-quiet').click();
  const offByHint = await until(async () => !(await bagSwitch.isChecked()), 3000);
  report.check('Bag mode: the switch toggles from the title, the switch and the hint (off → on → off)', offByTitle && onBySwitch && offByHint, JSON.stringify({ offByTitle, onBySwitch, offByHint }));
  const gOff = await bagGeom(desk);
  report.check(`Bag mode: no horizontal overflow; the row is a ${gOff.rowW}x${gOff.rowH} target inside the sheet (switch ${gOff.switchW}x${gOff.switchH})`,
    !gOff.sheetOverflow && !gOff.pageOverflow && gOff.inSheet && gOff.rowH >= 24 && gOff.switchW >= 24 && gOff.switchH > 0, JSON.stringify(gOff));
  await desk.screenshot({ path: join(SHOTS, '1440-mac-panel-bag-off.png') });

  if (LOCAL) {
    // Start sends the choice; the run reports it; Return + reload shows it remembered.
    const startReq = desk.waitForRequest((r) => r.url().endsWith('/api/handsfree/mac/start') && r.method() === 'POST', { timeout: 15000 });
    await desk.locator('[data-testid="hf-mac-start"]').click();
    const sent = await startReq.then((r) => r.postDataJSON()).catch(() => null);
    report.check('Bag mode: Start sends bagMode: false (with the checked project)', sent?.bagMode === false && JSON.stringify(sent?.vaults) === '["proj"]', JSON.stringify(sent));
    report.check('Bag mode: Mac mode starts (loopback stand-in for the tunnel)',
      await until(async () => (await desk.locator('[data-testid="hf-mac-panel"][data-phase="on"]').count()) > 0, 30000),
      JSON.stringify((await mac(port, 'GET', 'status')).json).slice(0, 240));
    const bagLine = desk.locator('[data-testid="hf-mac-bag"]');
    report.check('Bag mode: the running panel says Normal mode (data-bag=off)',
      await until(async () => (await bagLine.getAttribute('data-bag')) === 'off' && ((await bagLine.textContent()) ?? '').includes('Normal mode'), 10000),
      await bagLine.textContent().catch(() => '(no line)'));
    const st = await mac(port, 'GET', 'status');
    report.check('Bag mode: status reports bagMode false while on', st.json.phase === 'on' && st.json.bagMode === false, JSON.stringify({ phase: st.json.phase, bagMode: st.json.bagMode }));
    await desk.screenshot({ path: join(SHOTS, '1440-mac-panel-running-normal.png') });

    await desk.locator('[data-testid="hf-mac-return"]').click();
    report.check('Bag mode: Return goes back to the start screen',
      await until(async () => (await desk.locator('[data-testid="hf-mac-panel"][data-phase="off"]').count()) > 0, 20000));
    await desk.reload({ waitUntil: 'domcontentloaded' });
    await desk.waitForTimeout(3000);
    await dismiss(desk);
    for (let i = 0; i < 3; i++) { await desk.keyboard.press('Escape'); await desk.waitForTimeout(200); }
    await desk.locator('[data-testid="hf-button"]:visible').first().click();
    // A fresh page holds no local choice: an unchecked switch can only come from the server.
    report.check('Bag mode: after a reload the switch shows the remembered choice (off)',
      await until(async () => (await bagSwitch.count()) === 1 && !(await bagSwitch.isChecked()), 10000));
    let prefs = null;
    try { prefs = JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'handsfree-mac', 'prefs.json'), 'utf8')); } catch (e) { prefs = String(e); }
    report.check('Bag mode: prefs.json holds { bagMode: false }', JSON.stringify(prefs) === '{"bagMode":false}', JSON.stringify(prefs));
    await desk.screenshot({ path: join(SHOTS, '1440-mac-panel-remembered.png') });

    // ── Heat (the heat task): the Bag note, the phone chip + note, the very-hot line. ONE server
    // run; the governor reads `<POWER_LOG>.thermal` (the seam), so `serious` is a file write and
    // the seam's filter keeps every real process unslowed (no clamp line in thermal.log).
    console.log('\n── Heat: Bag note, phone chip, very hot');
    const THERMAL = `${POWER_LOG}.thermal`;
    writeFileSync(THERMAL, 'nominal');
    const bagNote = desk.locator('[data-testid="hf-mac-bag-note"]');
    report.check('Heat: Bag switch off → no Bag note', await until(async () => (await bagNote.count()) === 0, 3000));
    await bagSwitch.click();
    report.check('Heat: Bag switch on → the Bag note shows under it',
      await until(async () => (await bagNote.isVisible().catch(() => false)) && ((await bagNote.textContent()) ?? '').includes('In a bag the Mac cools slowly'), 3000)
      && await desk.evaluate(() => document.querySelector('[data-testid="hf-mac-bag-row"]')?.nextElementSibling?.getAttribute('data-testid') === 'hf-mac-bag-note'));
    await desk.waitForTimeout(400); // the switch's slide, so the shot shows it on
    await desk.screenshot({ path: join(SHOTS, '1440-mac-panel-bag-note.png') });
    await bagSwitch.click();
    report.check('Heat: Bag switch off again → the note is gone', await until(async () => (await bagNote.count()) === 0, 3000));
    await bagSwitch.click();
    await desk.locator('[data-testid="hf-mac-start"]').click();
    report.check('Heat: Mac mode starts in Bag mode',
      await until(async () => (await desk.locator('[data-testid="hf-mac-panel"][data-phase="on"]').count()) > 0 && (await mac(port, 'GET', 'status')).json.bagMode === true, 30000));

    /** A phone signed in through the run's own QR link, on the phone listener (a real phone socket). */
    const signInPhone = async (tag) => {
      const link = (await mac(port, 'POST', 'qr')).json.url;
      const c = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
      const p = await c.newPage();
      watchers.push(watch(p, tag));
      await p.goto(link, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await p.waitForTimeout(3000);
      await dismiss(p);
      return { c, p };
    };
    const chipText = (p) => p.locator('[data-testid="phone-live-badge"]:visible').first().textContent().catch(() => '');
    let ph = await signInPhone('phone-heat');
    const phoneNote = ph.p.locator('[data-testid="phone-bag-note"]:visible');
    report.check('Heat: phone 390: the chip reads "Mac · in the bag"', await until(async () => ((await chipText(ph.p)) ?? '').includes('Mac · in the bag'), 20000), await chipText(ph.p));
    report.check('Heat: phone 390: the Bag note shows under the header', await until(async () => (await phoneNote.count()) === 1, 10000));
    const pm = await ph.p.evaluate(() => ({ overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 }));
    report.check('Heat: phone 390: no horizontal overflow', !pm.overflowX, JSON.stringify(pm));
    await ph.p.screenshot({ path: join(SHOTS, '390-phone-bag.png') });
    await ph.p.locator('[data-testid="phone-bag-note-ok"]:visible').click();
    report.check('Heat: phone: OK hides the note', await until(async () => (await phoneNote.count()) === 0, 3000));
    await ph.p.reload({ waitUntil: 'domcontentloaded' });
    await ph.p.waitForTimeout(3000);
    report.check('Heat: phone: after a reload the note stays dismissed for this run',
      await until(async () => ((await chipText(ph.p)) ?? '').includes('in the bag'), 20000) && (await phoneNote.count()) === 0);

    writeFileSync(THERMAL, 'serious');
    const hotLine = desk.locator('[data-testid="hf-mac-heat"]');
    report.check('Heat: Mac panel 1440: the very-hot line shows after macOS says serious',
      await until(async () => ((await hotLine.textContent().catch(() => '')) ?? '').includes('Mac got very hot · heavy steps run one at a time'), 20000));
    await desk.screenshot({ path: join(SHOTS, '1440-mac-panel-hot.png') });
    await ph.p.reload({ waitUntil: 'domcontentloaded' });
    report.check('Heat: phone 390: the chip reads "Mac very hot"', await until(async () => ((await chipText(ph.p)) ?? '').includes('Mac very hot'), 20000), await chipText(ph.p));
    await ph.p.screenshot({ path: join(SHOTS, '390-phone-hot.png') });
    const hotNarrowCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const hotNarrow = await hotNarrowCtx.newPage();
    watchers.push(watch(hotNarrow, 'desktop-390-hot'));
    await hotNarrow.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    await hotNarrow.goto(`${base}/?vault=proj&page=tasks`, { waitUntil: 'domcontentloaded' });
    await hotNarrow.waitForTimeout(4000);
    await dismiss(hotNarrow);
    for (let i = 0; i < 3; i++) { await hotNarrow.keyboard.press('Escape'); await hotNarrow.waitForTimeout(200); }
    const hotBtn = hotNarrow.locator('[data-testid="hf-button"]:visible').first();
    if (await hotBtn.count()) {
      await hotBtn.click();
      const shown = await until(async () => await hotNarrow.locator('[data-testid="hf-mac-heat"]').isVisible().catch(() => false), 15000);
      const ov = await hotNarrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      report.check('Heat: Mac panel 390: the very-hot line shows, no horizontal overflow', shown && !ov, JSON.stringify({ shown, ov }));
      await hotNarrow.screenshot({ path: join(SHOTS, '390-mac-panel-hot.png') });
    } else {
      report.note('Heat: the Hands-free button is not shown at 390 px: no 390 hot panel');
    }
    await hotNarrowCtx.close();
    let tlog = '';
    try { tlog = readFileSync(join(HOME, '.dreamcontext', 'handsfree-mac', 'thermal.log'), 'utf8'); } catch { /* none: nothing clamped */ }
    report.check('Heat: the scratch thermal.log has no clamp line (the seam slows nothing)', !/ clamp /.test(tlog), tlog.split('\n').filter((l) => / clamp /.test(l)).slice(0, 3).join(' | '));

    // Return + start: a new run shows the note again (the phone signs in again: Return signs it out).
    writeFileSync(THERMAL, 'nominal');
    await desk.locator('[data-testid="hf-mac-return"]').click();
    await until(async () => (await desk.locator('[data-testid="hf-mac-panel"][data-phase="off"]').count()) > 0, 20000);
    await ph.c.close();
    await desk.locator('[data-testid="hf-mac-start"]').click();
    await until(async () => (await desk.locator('[data-testid="hf-mac-panel"][data-phase="on"]').count()) > 0, 30000);
    ph = await signInPhone('phone-heat-2');
    report.check('Heat: phone: after Return + start the Bag note shows again',
      await until(async () => (await ph.p.locator('[data-testid="phone-bag-note"]:visible').count()) === 1, 20000));
    await ph.c.close();
    await desk.locator('[data-testid="hf-mac-return"]').click();
    await until(async () => (await desk.locator('[data-testid="hf-mac-panel"][data-phase="off"]').count()) > 0, 20000);
  } else {
    report.note('(Bag mode: Start / running / remembered run only under --local: a full run starts no second quick tunnel)');
  }

  // 390 px: the laptop window made narrow (fine pointer, no touch): the panel, if the button shows.
  console.log('\n── desktop 390x844: Bag mode');
  const narrowCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const narrow = await narrowCtx.newPage();
  watchers.push(watch(narrow, 'desktop-390'));
  await narrow.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
  await narrow.goto(`${base}/?vault=proj&page=tasks`, { waitUntil: 'domcontentloaded' });
  await narrow.waitForTimeout(4000);
  await dismiss(narrow);
  for (let i = 0; i < 3; i++) { await narrow.keyboard.press('Escape'); await narrow.waitForTimeout(200); }
  const narrowBtn = narrow.locator('[data-testid="hf-button"]:visible').first();
  if (await narrowBtn.count()) {
    await narrowBtn.click();
    const shown = await until(async () => await narrow.locator('[data-testid="hf-mac-bag-row"]').isVisible(), 10000);
    const g390 = await bagGeom(narrow);
    report.check('Bag mode: 390 px: the row shows inside the panel, no horizontal overflow',
      shown && g390.inSheet && !g390.sheetOverflow && !g390.pageOverflow, JSON.stringify(g390));
    await narrow.screenshot({ path: join(SHOTS, '390-mac-panel-bag.png') });
    if (LOCAL) {
      const nSwitch = narrow.locator('[data-testid="hf-mac-bag-row"] input[role="switch"]');
      const nNote = narrow.locator('[data-testid="hf-mac-bag-note"]');
      if (!(await nSwitch.isChecked())) await nSwitch.click();
      const on = await until(async () => await nNote.isVisible().catch(() => false), 3000);
      const ov = await narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      await narrow.screenshot({ path: join(SHOTS, '390-mac-panel-bag-note.png') });
      await nSwitch.click();
      const off = await until(async () => (await nNote.count()) === 0, 3000);
      report.check('Heat: Mac panel 390: the Bag note shows with the switch on, hides off, no overflow', on && off && !ov, JSON.stringify({ on, off, ov }));
    }
  } else {
    report.note('Bag mode: the Hands-free button is not shown at 390 px (the window chrome hides it): no 390 panel');
  }
  await narrowCtx.close();

  const errs = watchers.flatMap((w) => w.errors).filter((e) => !/__TAURI/.test(e))
    .filter((e) => !(expectAndroid400 && /^android: Failed to load resource: the server responded with a status of 400/.test(e)));
  const bad = watchers.flatMap((w) => w.bad ?? w.forbidden ?? []).filter((e) => !(expectAndroid400 && /^android: 400 PUT \/api\/handsfree\/push\/subscription/.test(e)));
  // The Mac's own window (desktop*) lists every registered project by design: only the tunnel's
  // pages (phones, the computer, the dressed phone surfaces) must never name the unchosen one.
  const leaks = watchers.flatMap((w) => w.leaks ?? []).filter((l) => !/^desktop/.test(l));
  const logos = watchers.flatMap((w) => w.logos ?? []).filter((l) => !/^desktop/.test(l));
  report.check('10 no console errors on any page', errs.length === 0, errs.slice(0, 12).join('\n      '));
  report.check('10 no 4xx/5xx in the network log', bad.length === 0, [...new Set(bad)].slice(0, 20).join('\n      '));
  report.check('9 no response body or socket frame names the unchosen project', leaks.length === 0, [...new Set(leaks)].slice(0, 12).join('\n      '));
  report.check('9 no project logo or avatar read on the tunnel', logos.length === 0, [...new Set(logos)].slice(0, 12).join('\n      '));
  console.log(`\n  screenshots: ${SHOTS}`);
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err));
} finally {
  for (const s of sockets) { try { s.ws.close(); } catch { /* gone */ } }
  try { await browser?.close(); } catch { /* gone */ }
  try { await phoneBrowser?.close(); } catch { /* gone */ }
  try { proxy?.close(); } catch { /* gone */ }
  try { await fetch(`http://127.0.0.1:${server?.spawnargs?.[server.spawnargs.indexOf('-p') + 1]}/api/handsfree/mac/stop`, { method: 'POST' }); } catch { /* gone */ }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
if (report.fails.length) { for (const f of report.fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
