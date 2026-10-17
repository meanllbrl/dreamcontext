#!/usr/bin/env node
/**
 * Hands-free on a PHONE: the whole dashboard, measured (W3: AC11-AC14, AC16's panel, AC17).
 *
 *   npm run build && node scripts/verify/handsfree-mobile.mjs
 *
 * WHAT IT DRIVES — the real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1, power runner
 * that only LOGS), Mac mode started over a real Cloudflare quick tunnel, and Chromium phones
 * (390x844 iPhone 13, 375x667 iPhone SE: touch, coarse pointer) signed in through the tunnel
 * with the one-time QR link, so every request goes through the phone listener's route policy.
 * Then the laptop window at 1440x900 (fine pointer) on the main listener.
 *
 * PER PHONE SIZE: the chat (header, resting composer, pin shelf, transcript share), the round
 * trip chat → "Show full dashboard" → a page → the drawer's Chat → chat, then EVERY phone page
 * through the drawer: no horizontal overflow, page header <= 56px, first content within 120px
 * of the top, a screenshot each. Across the run: no console error, no 403 in the network log.
 *
 * THE SOHBETLER LIST (AC21-AC22): the phone opens on it; New chat, ‹ and the back gesture move
 * between list and chat; a word only a closed chat's message holds is found under Kapalı with the
 * hit marked, the chips filter, an open chat's loaded text is searched too, a closed hit resumes.
 *
 * THE CHAT STACK (AC19-AC20): three open chats (one asking, one working on the Mac through a laptop
 * chat socket, one idle): rows above the focused chat, waiting first, a tap swaps (animated, none
 * under reduced motion), a Mac row updates live and is adopted on tap, three rows keep the
 * focused chat's economy; at 390x844 and 375x667.
 *
 * HONEST LIMIT — Chromium's phone emulation, not an iPhone: safe-area insets and the keyboard
 * are not exercised (AC15 is the owner's iPhone check).
 *
 * `--local`: the same checks on the MAIN listener (no tunnel, no Mac mode start): the layout
 * keys off the viewport, so this is the fast loop while styling. The evidence run is without it.
 *
 * FAILURE POLICY — collect, don't fail fast; exit 0 iff every check passed.
 * Screenshots: tmp/verify-handsfree-mobile/<size>-<page>.png
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-mobile');
const CLI = join(REPO, 'dist', 'index.js');
const LOCAL = process.argv.includes('--local');

/** Every page the phone reaches, by its drawer label (English UI). */
const PAGES = [
  ['agents', 'Agents'], ['tasks', 'Tasks'], ['knowledge', 'Knowledge'], ['lab', 'Insights'], ['whiteboards', 'Whiteboard'],
  ['roadmap', 'Roadmap'], ['automations', 'Automations'], ['sleep', 'Sleep Cycle'], ['core', 'Core'], ['brain', 'Map'],
  ['council', 'Council'], ['hypotheses', 'Hypotheses'], ['packs', 'Packs'], ['taxonomy', 'Taxonomy'],
  ['announcements', 'Announcements'], ['about', 'What is this?'],
];
const SIZES = [
  { name: '390x844', device: 'iPhone 13', viewport: { width: 390, height: 844 } },
  { name: '375x667', device: 'iPhone SE', viewport: { width: 375, height: 667 } },
];

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
    // AC19's stack needs a chat waiting for you and one working: ASK raises a question card and
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
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, OTHER, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  // The transcript dir exists before the server first looks (it remembers a miss for its life).
  for (const d of [PROJ, OTHER]) mkdirSync(join(HOME, '.claude', 'projects', d.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [name, path] of [['proj', PROJ], ['other', OTHER]]) {
    cli(['init', '-y', '--name', name, '--description', 'A scratch project for the phone check'], path);
    const r = cli(['vaults', 'add', name, path]);
    if (r.status !== 0) throw new Error(`vaults add ${name}: ${r.stderr || r.stdout}`);
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

/** Console errors, failed requests and every 403 a page saw. */
function watch(page, tag) {
  const errors = []; const forbidden = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() === 403) forbidden.push(`${tag}: ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  return { errors, forbidden };
}

/** A drawer row by its EXACT label ("Map" must not pick "Roadmap"). */
const drawerItem = (page, label) => page.locator('.sidebar--phone .sidebar-item')
  .filter({ has: page.locator('.sidebar-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();

const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) {
    const x = page.locator('.announcements-modal-close');
    if (!(await x.count())) break;
    await x.first().click().catch(() => {});
    await page.waitForTimeout(300);
  }
};

/** The phone's shell, read from what Chromium painted. */
const shellMetrics = (page) => page.evaluate(() => {
  const r = (el) => (el ? el.getBoundingClientRect() : null);
  const chrome = document.querySelector('.window-chrome-bar');
  const bar = document.querySelector('.phone-bar');
  const main = document.querySelector('.shell-main');
  return {
    chromeVisible: !!chrome && getComputedStyle(chrome).display !== 'none' && r(chrome).height > 0,
    barH: bar ? Math.round(r(bar).height) : -1,
    mainLeft: main ? Math.round(r(main).left) : -1,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  };
});

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

/** The phone chat, read from what Chromium painted (AC12). */
const chatMetrics = (page) => page.evaluate(() => {
  const vis = (sel) => [...document.querySelectorAll(sel)].find((el) => { const b = el.getBoundingClientRect(); return b.height > 0 && b.width > 0; });
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
  const head = vis('.agent-surface[data-mobile] .agent-overlay-head');
  const cmp = vis('.agent-surface[data-mobile] .chat-cmp');
  const shelf = vis('.agent-surface[data-mobile] .pin-shelf');
  const scroll = vis('.agent-surface[data-mobile] .chat-scroll');
  // The chat stack (AC19) sits between the header and the focused chat: the gap is measured below it.
  const stack = vis('.agent-surface[data-mobile] [data-testid="phone-stack"]');
  const above = stack ?? head;
  const gap = above && scroll ? Math.round(scroll.getBoundingClientRect().top - above.getBoundingClientRect().bottom) : -1;
  const rows = [...document.querySelectorAll('.agent-surface[data-mobile] [data-testid="phone-stack-row"]')].filter((el) => el.getBoundingClientRect().height > 0);
  return {
    headH: h(head), cmpH: h(cmp), shelfH: h(shelf), scrollH: h(scroll), gap, innerH: window.innerHeight, stackH: h(stack),
    rowHs: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 || (stack ? stack.scrollWidth > stack.clientWidth + 1 : false),
  };
});

let server = null;
let browser = null;
let phoneBrowser = null;
let proxy = null;
const watchers = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  console.log('· scratch vault, server, Mac mode over a real quick tunnel…');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = await startServer(port);
  browser = await chromium.launch();
  const setup = await mac(port, 'POST', 'setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));
  if (!LOCAL) {
    proxy = await startProxy();
    phoneBrowser = await chromium.launch({ proxy: { server: proxy.url } });
    const started = await mac(port, 'POST', 'start', { vaults: ['proj'] });
    report.check('Mac mode starts for the chosen project', started.status === 200 && !!started.json.url && JSON.stringify(started.json.exposedVaults) === '["proj"]', JSON.stringify(started.json).slice(0, 200));
  } else {
    phoneBrowser = browser;
    report.note('(--local: main listener, no tunnel; not the evidence run)');
  }

  // --local runs on the main listener: dress it as the Mac phone surface (its meta flag), so the
  // same list-first screens are measured. The tunnel run needs no dressing.
  const phoneContext = async (opts) => {
    const c = await phoneBrowser.newContext(opts);
    if (LOCAL) await c.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState !== 'interactive' || document.querySelector('meta[name="dreamcontext-surface"]')) return;
        const m = document.createElement('meta'); m.name = 'dreamcontext-surface'; m.content = 'mac'; document.head.appendChild(m);
      });
    });
    return c;
  };
  /** The Sohbetler list on screen (AC21): the phone's home. */
  const onList = (page) => page.locator('[data-testid="phone-list"]:visible').count().then((n) => n === 1);
  const listMetrics = (page) => page.evaluate(() => {
    const el = document.querySelector('[data-testid="phone-list"]');
    const head = el?.querySelector('.mlist-head');
    const rows = [...(el?.querySelectorAll('.mlist-row') ?? [])].map((r) => Math.round(r.getBoundingClientRect().height));
    return { headH: head ? Math.round(head.getBoundingClientRect().height) : -1, rows, overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 || (el ? el.scrollWidth > el.clientWidth + 1 : true) };
  });

  for (const size of SIZES) {
    console.log(`\n── phone ${size.name}`);
    const qr = LOCAL ? `${base}/?vault=proj` : (await mac(port, 'POST', 'qr')).json.url;
    const ctx = await phoneContext({ ...devices[size.device], viewport: size.viewport });
    const phone = await ctx.newPage();
    watchers.push(watch(phone, `phone ${size.name}`));
    await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    report.check('signed in, landed in the project', await until(async () => phone.url().includes('vault=proj'), 25000), phone.url());
    report.check('the page is a phone (narrow AND coarse pointer)', await phone.evaluate(() => matchMedia('(max-width: 768px)').matches && matchMedia('(pointer: coarse)').matches));
    await phone.waitForTimeout(3000);
    await dismiss(phone);
    report.check('AC21 the phone opens on the Sohbetler list', await until(() => onList(phone), 20000));
    await phone.waitForTimeout(600);
    const lm = await listMetrics(phone);
    if (!LOCAL) {
      report.check('AC10 the list\'s notifications row reads "needs the fixed address" on a quick tunnel', (await phone.locator('[data-testid="push-optin"]').getAttribute('data-state')) === 'quick');
      report.check('AC16 one chosen project: no project switch on the list; no project tabs', (await phone.locator('[data-testid="list-projects"]').count()) === 0 && (await phone.locator('.project-tabs:visible').count()) === 0);
    }
    report.check(`AC21 the list's header is 44px (${lm.headH}), no horizontal overflow`, lm.headH >= 43 && lm.headH <= 45 && !lm.overflowX, JSON.stringify(lm));
    await phone.screenshot({ path: join(SHOTS, `${size.name}-list.png`) });
    // The chat: the list's "New chat" opens one (or the open one, when the runs above left it).
    await phone.locator('[data-testid="list-new"]').click();
    report.check('AC21 "New chat" opens a chat over the list', await until(async () => !(await onList(phone)) && (await phone.locator('.chat-cmp:visible').count()) > 0, 15000));
    await phone.waitForTimeout(800);
    const cm = await chatMetrics(phone);
    await phone.screenshot({ path: join(SHOTS, `${size.name}-chat.png`) });
    report.check(`AC12 chat header is 44px (${cm.headH})`, cm.headH >= 43 && cm.headH <= 45);
    report.check(`AC12 resting composer <= 64px (${cm.cmpH})`, cm.cmpH > 0 && cm.cmpH <= 64);
    report.check(`AC12 pin shelf <= 32px collapsed (${cm.shelfH})`, cm.shelfH <= 32);
    report.check(`AC12 nothing taller than 32px between header and transcript (${cm.gap})`, cm.gap >= 0 && cm.gap <= 32);
    if (size.name === '390x844') report.check(`AC12 the transcript gets >= 75% of 844 (${cm.scrollH})`, cm.scrollH >= 0.75 * 844);
    else report.check(`the transcript gets >= 70% of ${cm.innerH} (${cm.scrollH})`, cm.scrollH >= 0.7 * cm.innerH);
    // ‹ comes back to the list; the phone's back gesture does too.
    await phone.locator('[data-testid="chat-back"]:visible').click();
    report.check('AC21 the chat\'s ‹ returns to the list', await until(() => onList(phone), 8000));
    await phone.locator('[data-testid="list-tab-row"]').first().click();
    await until(async () => !(await onList(phone)), 8000);
    await phone.goBack();
    report.check('AC21 the back gesture leaves the chat for the list, not the app', await until(() => onList(phone), 8000) && phone.url().includes('vault=proj'), phone.url());
    if (size.name === '390x844') {
      // Review r1 M1: a reload inside a chat keeps that history entry's state; ‹ from the next chat
      // must step back ONCE (to the list), never twice (out of the app).
      await phone.locator('[data-testid="list-tab-row"]').first().click();
      await until(async () => !(await onList(phone)), 8000);
      await phone.reload();
      await until(() => onList(phone), 20000);
      await phone.locator('[data-testid="list-tab-row"]').first().click();
      await until(async () => !(await onList(phone)), 8000);
      const before = phone.url();
      await phone.locator('[data-testid="chat-back"]:visible').click();
      await phone.waitForTimeout(1500);
      report.check('AC21 after a reload in a chat, ‹ from the next chat lands on the list and stays in the app', (await onList(phone)) && phone.url() === before, `${before} -> ${phone.url()}`);
    }
    // AC11 round trip: list → "Boards, tasks…" → a page → the menu's Chat → the list.
    await phone.locator('[data-testid="list-dashboard"]').click();
    report.check('"Boards, tasks…" shows the shell with the one phone bar', await until(async () => (await phone.locator('[data-testid="phone-bar"]:visible').count()) === 1, 10000));
    const sm = await shellMetrics(phone);
    report.check(`AC11 window chrome hidden; bar <= 44px + safe area (${sm.barH}); the rail takes no width (main at x=${sm.mainLeft})`, !sm.chromeVisible && sm.barH > 0 && sm.barH <= 44 && sm.mainLeft === 0, JSON.stringify(sm));
    await phone.locator('[data-testid="phone-menu"]').click();
    await until(async () => (await phone.locator('.sidebar--phone[data-open]').count()) === 1, 5000);
    await phone.waitForTimeout(300);
    const labels = (await phone.locator('.sidebar--phone .sidebar-label').allInnerTexts()).map((x) => x.trim());
    await phone.screenshot({ path: join(SHOTS, `${size.name}-drawer.png`) });
    const missing = PAGES.map(([, l]) => l).filter((l) => !labels.includes(l));
    report.check('AC11 the drawer lists every phone page plus Chat, and not Settings', missing.length === 0 && labels.includes('Chat') && !labels.includes('Settings'), `missing ${JSON.stringify(missing)}; got ${JSON.stringify(labels)}`);
    await drawerItem(phone, 'Tasks').click();
    report.check('picking a page closes the drawer and shows it', await until(async () => (await phone.locator('.sidebar--phone[data-open]').count()) === 0 && (await phone.locator('.phone-bar-title').innerText()) === 'Tasks', 5000));
    await phone.locator('[data-testid="phone-menu"]').click();
    await phone.locator('.sidebar--phone .sidebar-item--launcher').click();
    report.check('AC11 the drawer\'s Chat brings the chats back (round trip, on the list)', await until(() => onList(phone), 8000));

    // AC13: every page, through the drawer.
    await phone.locator('[data-testid="list-dashboard"]').click();
    await until(async () => (await phone.locator('[data-testid="phone-bar"]:visible').count()) === 1, 8000);
    for (const [key, label] of PAGES) {
      await phone.locator('[data-testid="phone-menu"]').click();
      await until(async () => (await phone.locator('.sidebar--phone[data-open]').count()) === 1, 5000);
      await drawerItem(phone, label).click();
      await until(async () => (await phone.locator('.sidebar--phone[data-open]').count()) === 0, 5000);
      report.check(`the drawer opened ${key} (bar says "${label === 'What is this?' ? label : label}")`, (await phone.locator('.phone-bar-title').innerText()).trim() === label);
      await phone.waitForTimeout(1800);
      await dismiss(phone);
      const m = await pageMetrics(phone);
      await phone.screenshot({ path: join(SHOTS, `${size.name}-${key}.png`) });
      const fits = m.ok && !m.docOverflow && !m.mainOverflow && m.wide.length === 0;
      report.check(`AC13 ${key}: fits (no horizontal overflow)`, fits, JSON.stringify(m));
      report.check(`AC13 ${key}: header <= 56px (${m.headerH} ${m.headerClass})`, m.ok && m.headerH <= 56, JSON.stringify(m));
      report.check(`AC13 ${key}: first content within 120px of the top (${m.firstTop} ${m.firstClass})`, m.ok && m.firstTop >= 0 && m.firstTop <= 120, JSON.stringify(m));
    }
    await ctx.close();
  }

  if (!LOCAL) {
    // ── AC16: several chosen projects: the list switches between exactly those, no tabs ──
    console.log('\n── phone 390x844, two chosen projects');
    await mac(port, 'POST', 'stop');
    const two = await mac(port, 'POST', 'start', { vaults: ['proj', 'other'] });
    report.check('Mac mode starts for two chosen projects', two.status === 200 && JSON.stringify(two.json.exposedVaults) === '["proj","other"]', JSON.stringify(two.json).slice(0, 200));
    const qr = (await mac(port, 'POST', 'qr')).json.url;
    const mctx = await phoneBrowser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    const mp = await mctx.newPage();
    watchers.push(watch(mp, 'phone two-projects'));
    await mp.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await until(async () => mp.url().includes('vault='), 25000);
    await mp.waitForTimeout(3000);
    await dismiss(mp);
    report.check('the two-project phone opens on the list', await until(() => onList(mp), 20000));
    await until(async () => (await mp.locator('[data-testid="list-projects"]:visible .mlist-project').count()) > 0, 10000);
    const rows = (await mp.locator('[data-testid="list-projects"]:visible .mlist-project').allInnerTexts()).map((x) => x.trim()).sort();
    await mp.screenshot({ path: join(SHOTS, '390x844-list-two-projects.png') });
    report.check('AC16 several chosen: the list switches between exactly the chosen projects; no project tabs', JSON.stringify(rows) === '["other","proj"]' && (await mp.locator('.project-tabs:visible').count()) === 0, JSON.stringify(rows));
    // Every project's view stays mounted (hidden): read the list on screen, not the first in the DOM.
    const shownProject = async () => (await mp.locator('[data-testid="list-projects"]:visible .mlist-project[data-on]').first().innerText().catch(() => '')).trim();
    const from = await shownProject();
    const to = from === 'proj' ? 'other' : 'proj';
    await mp.locator('[data-testid="list-projects"]:visible .mlist-project', { hasText: to }).first().click();
    report.check(`AC16 …and switches to the other one (${from} -> ${to})`, await until(async () => (await shownProject()) === to, 30000, 500));
    await mp.waitForTimeout(900);
    await mp.screenshot({ path: join(SHOTS, '390x844-list-switched.png') });
    await mctx.close();
  }

  // ── AC19-AC20: the project's open chats, STACKED ────────────────────────────────────
  // Three open chats: one waiting for you (a question card), one working ON THE MAC (a laptop
  // chat socket), one idle and focused. Then a tap swaps, a Mac row is adopted, the labels move
  // on their own, three rows keep the focused chat's economy, and the same at 375x667.
  console.log('\n── phone stack 390x844: asking, working on the Mac, idle');
  if (!LOCAL) {
    await mac(port, 'POST', 'stop');
    const one = await mac(port, 'POST', 'start', { vaults: ['proj'] });
    report.check('Mac mode restarts for proj', one.status === 200, JSON.stringify(one.json).slice(0, 160));
  }
  const sqr = LOCAL ? `${base}/?vault=proj` : (await mac(port, 'POST', 'qr')).json.url;
  const sctx = await phoneContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  const sp = await sctx.newPage();
  watchers.push(watch(sp, 'phone stack'));
  await sp.goto(sqr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await until(async () => sp.url().includes('vault=proj'), 25000);
  await sp.waitForTimeout(3000);
  await dismiss(sp);
  await until(async () => (await onList(sp)) || (await sp.locator('[data-testid="phone-bar"]:visible').count()) > 0, 20000);
  // The page the runs above left this phone on may be a dashboard page: the menu's Chat brings the list.
  const toList = async () => {
    if (await onList(sp)) return true;
    if (await sp.locator('[data-testid="chat-back"]:visible').count()) { await sp.locator('[data-testid="chat-back"]:visible').click(); return until(() => onList(sp), 8000); }
    await sp.locator('[data-testid="phone-menu"]').click();
    await until(async () => (await sp.locator('.sidebar--phone[data-open]').count()) === 1, 5000);
    await sp.locator('.sidebar--phone .sidebar-item--launcher').click();
    return until(() => onList(sp), 10000);
  };
  report.check('the phone is on the list', await toList());
  const svis = (sel) => sp.locator(`${sel}:visible`);
  // Start from no open chat: close what the runs above left on this phone (the list's ✕).
  for (let i = 0; i < 12; i++) {
    const c = sp.locator('[data-testid="phone-list"] [data-testid="list-close"]:visible');
    if (!(await c.count())) break;
    await c.first().click();
    await sp.waitForTimeout(500);
  }
  report.check('AC21 the list\'s ✕ closes this phone\'s chats', (await sp.locator('[data-testid="phone-list"] [data-testid="list-tab-row"]:visible').count()) === 0);
  // Chats the runs above left running on the Mac (a closed phone context keeps its child for a
  // reconnect) are real Mac chats, listed as such; the checks below look past them.
  const orphanIds = new Set(((await (await fetch(`${base}/api/agent/live-chats`)).json().catch(() => ({ chats: [] }))).chats ?? []).map((c) => c.conversationId));
  report.note(`(${orphanIds.size} chat(s) already running on the Mac from the runs above)`);
  const rowsNow = () => sp.evaluate((orphans) => [...document.querySelectorAll('[data-testid="phone-stack-row"]')]
    .filter((e) => e.getBoundingClientRect().height > 0 && !orphans.includes(e.dataset.id))
    .map((e) => ({ id: e.dataset.id, kind: e.dataset.kind, waiting: e.dataset.waiting === 'true',
      state: (e.querySelector('[data-testid="phone-stack-state"]')?.textContent ?? '').trim(),
      line: (e.querySelector('.mchat-stack-line')?.textContent ?? '').trim() })), [...orphanIds]);
  const swapAnim = () => sp.evaluate(() => {
    const el = [...document.querySelectorAll('.agent-surface[data-mobile] .agent-panes')].find((e) => e.getBoundingClientRect().height > 0);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { swap: el.dataset.swap ?? null, name: cs.animationName, dur: cs.animationDuration };
  });
  const ssend = async (t) => { const c = svis('.chat-cmp-input').first(); await c.click(); await c.fill(t); await sp.waitForTimeout(120); await sp.keyboard.press('Enter'); };
  const focusedText = async () => (await svis('.chat-pane').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  const newChat = async () => {
    const fromList = await onList(sp);
    const before = (await rowsNow()).length;
    if (fromList) await sp.locator('[data-testid="list-new"]').click();
    // In a chat: the header's ＋.
    else await svis('.agent-overlay-head .mchat-head-btn[aria-label="New chat"]').first().click();
    await until(async () => !(await onList(sp)) && (await svis('.chat-cmp-input').count()) > 0 && (fromList || (await rowsNow()).length > before), 15000);
    await sp.waitForTimeout(600);
  };

  // Chat A asks a question; chat B (focused) answers plainly.
  await newChat();
  await ssend('ASK');
  report.check('chat A is waiting for you (its question card is on screen)', await until(async () => (await focusedText()).includes('Delete the old webhooks?'), 20000));
  await newChat();
  await ssend('hello');
  report.check('chat B (focused) answered and is idle', await until(async () => (await focusedText()).includes('ECHO hello'), 20000));
  let rows = await rowsNow();
  const idA = rows[0]?.id;
  report.check('AC19 chat A is a row above B, marked waiting, reading "Waiting for you" and its question', rows.length === 1 && rows[0].kind === 'tab' && rows[0].waiting
    && /Waiting for you|Seni bekliyor/.test(rows[0].state) && rows[0].line === 'Delete the old webhooks?', JSON.stringify(rows));

  // A chat working ON THE MAC: a laptop chat socket, the way any desktop client opens one.
  const { WebSocket: NodeWs } = await import('ws');
  const MAC_ID = crypto.randomUUID();
  const laptop = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&sessionId=${MAC_ID}`);
  let laptopClosed = false;
  laptop.on('close', () => { laptopClosed = true; });
  laptop.on('error', () => {});
  await new Promise((r) => laptop.on('open', r));
  await sleep(1200);
  laptop.send(JSON.stringify({ type: 'user', text: 'WORK 30' }));
  if (!LOCAL) {
    report.check('AC19 the Mac\'s working chat appears as a row ("Working", its last line), waiting row still first', await until(async () => {
      rows = await rowsNow();
      const m = rows.find((r) => r.id === MAC_ID);
      return rows.length === 2 && rows[0].id === idA && !!m && m.kind === 'mac' && /Working|Çalışıyor/.test(m.state) && m.line === 'Running npm test 412/895';
    }, 20000), JSON.stringify(rows));
    // Review r1 M4: the list's age for a Mac chat comes from the wire, over the tunnel.
    const wire = await sp.evaluate(async () => (await fetch('/api/agent/live-chats', { credentials: 'same-origin' })).json());
    const macWire = (wire.chats ?? []).find((c) => c.conversationId === MAC_ID);
    report.check('AC21 the Mac chat carries its age on the wire (updatedAt, recent)', !!macWire && typeof macWire.updatedAt === 'number' && Date.now() - macWire.updatedAt < 120_000, JSON.stringify(macWire));
  }
  // Resting: the composer measured with nothing focused (the keyboard down), as AC12 does.
  const rest = () => sp.evaluate(() => { document.activeElement?.blur?.(); });
  await rest();
  await sp.waitForTimeout(300);
  const cm3 = await chatMetrics(sp);
  await sp.screenshot({ path: join(SHOTS, '390x844-stack.png') });
  report.check(`AC20 rows are >= 44px (${cm3.rowHs}), no horizontal overflow, header 44 (${cm3.headH}), resting composer <= 64 (${cm3.cmpH})`,
    cm3.rowHs.length > 0 && cm3.rowHs.every((h) => h >= 44) && !cm3.overflowX && cm3.headH >= 43 && cm3.headH <= 45 && cm3.cmpH > 0 && cm3.cmpH <= 64, JSON.stringify(cm3));

  // Tap A: it becomes the focused chat and B becomes a row; the swap plays (<= 250 ms).
  await sp.locator(`[data-testid="phone-stack-row"][data-id="${idA}"]:visible`).click();
  const anim = await swapAnim();
  report.check(`AC20 the swap animates (${anim?.name} ${anim?.dur})`, !!anim && /^mchatSwap[AB]$/.test(anim.name) && parseFloat(anim.dur) > 0 && parseFloat(anim.dur) <= 0.25, JSON.stringify(anim));
  report.check('AC19 tapping A focuses it (its question on screen); A leaves the stack and B is a row now', await until(async () => {
    rows = await rowsNow();
    return (await focusedText()).includes('Delete the old webhooks?') && !rows.some((r) => r.id === idA) && rows.filter((r) => r.kind === 'tab').length === 1;
  }, 10000), JSON.stringify(rows));
  await sp.waitForTimeout(400);
  await sp.screenshot({ path: join(SHOTS, '390x844-stack-swapped.png') });

  if (!LOCAL) {
    report.check('AC19 the Mac row updates live: Working -> Idle with its new last line, no tap', await until(async () => {
      const m = (await rowsNow()).find((r) => r.id === MAC_ID);
      return !!m && /Idle|Boşta/.test(m.state) && m.line === 'All 895 green.';
    }, 45000), JSON.stringify(await rowsNow()));
    // Tap the Mac row: the running chat is ADOPTED (the laptop's socket is taken over), never resumed beside it.
    await sp.locator(`[data-testid="phone-stack-row"][data-id="${MAC_ID}"]:visible`).click();
    report.check('AC19 tapping the Mac row adopts that chat: the laptop socket is taken over, it is focused here, A (waiting) and B are rows', await until(async () => {
      rows = await rowsNow();
      return laptopClosed && (await focusedText()).includes('All 895 green.') && rows.length === 2 && rows.every((r) => r.kind === 'tab') && rows[0].id === idA && rows[0].waiting;
    }, 20000), JSON.stringify({ laptopClosed, rows }));
  }
  try { laptop.close(); } catch { /* gone */ }

  // Three rows: the focused chat keeps AC12's economy (transcript >= 60% of 844).
  for (let i = 0; i < 3 && (await rowsNow()).length < 3; i++) await newChat();
  await rest();
  await sp.waitForTimeout(600);
  const cm4 = await chatMetrics(sp);
  await sp.screenshot({ path: join(SHOTS, '390x844-stack-3rows.png') });
  report.check(`AC20 with 3 rows (${cm4.rowHs}): header 44 (${cm4.headH}), resting composer <= 64 (${cm4.cmpH}), transcript >= 60% of 844 (${cm4.scrollH}), waiting row first, no overflow`,
    cm4.rowHs.length >= 3 && cm4.stackH <= 3 * 44 + 4 * 4 + 1 && cm4.rowHs.every((h) => h >= 44) && cm4.headH >= 43 && cm4.headH <= 45 && cm4.cmpH > 0 && cm4.cmpH <= 64 && cm4.scrollH >= 0.6 * 844 && !cm4.overflowX
      && (await rowsNow())[0].id === idA, JSON.stringify({ cm4, rows: await rowsNow() }));

  // Reduced motion: no swap animation, no row entrance.
  await sp.emulateMedia({ reducedMotion: 'reduce' });
  rows = await rowsNow();
  await sp.locator(`[data-testid="phone-stack-row"][data-id="${rows[rows.length - 1].id}"]:visible`).click();
  const still = await swapAnim();
  const rowAnim = await sp.evaluate(() => { const r = [...document.querySelectorAll('[data-testid="phone-stack-row"]')].find((e) => e.getBoundingClientRect().height > 0); return r ? getComputedStyle(r).animationName : null; });
  report.check(`AC20 under prefers-reduced-motion the swap and rows do not animate (${still?.name}, ${rowAnim})`, !!still && still.name === 'none' && rowAnim === 'none', JSON.stringify({ still, rowAnim }));
  await sp.emulateMedia({ reducedMotion: 'no-preference' });

  // ── AC22: search the list. A word only a CLOSED chat's message holds; then one only an OPEN
  // chat's conversation holds; the chips filter; a closed hit resumes; ‹ comes back.
  console.log('\n── phone list search 390x844');
  await newChat();
  await ssend('remember the zebra migration plan');
  await until(async () => (await focusedText()).includes('ECHO remember the zebra'), 20000);
  await svis('[data-testid="chat-back"]').click();
  await until(() => onList(sp), 8000);
  const zebraTab = sp.locator('[data-testid="phone-list"] li').filter({ has: sp.locator('[data-testid="list-tab-row"]', { hasText: 'zebra' }) });
  await zebraTab.locator('[data-testid="list-close"]').first().click();
  await sp.waitForTimeout(800);
  const search = sp.locator('[data-testid="list-search"]:visible');
  const listState = () => sp.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="phone-list"]')].find((e) => e.getBoundingClientRect().height > 0);
    const rows = (sel) => [...(el?.querySelectorAll(sel) ?? [])].map((r) => ({ id: r.dataset.id, text: r.textContent.replace(/\s+/g, ' ').trim(), hits: [...r.querySelectorAll('mark.mlist-hit')].map((m) => m.textContent) }));
    const count = (f) => Number((el?.querySelector(`[data-testid="list-filter-${f}"] b`)?.textContent ?? '-1').trim());
    return { open: rows('[data-testid="list-tab-row"], [data-testid="mac-live-row"]'), closed: rows('[data-testid="past-row"]'), counts: { all: count('all'), open: count('open'), closed: count('closed') }, empty: !!el?.querySelector('[data-testid="list-empty"]') };
  });
  await search.fill('zebra');
  let ls = null;
  report.check('AC22 a word only a closed chat\'s message holds: found under Kapalı, highlighted, nothing under Açık; chips 1 / 0 / 1', await until(async () => {
    ls = await listState();
    return ls.closed.length === 1 && ls.closed[0].hits.some((h) => h.toLowerCase() === 'zebra') && ls.open.length === 0 && ls.counts.all === 1 && ls.counts.open === 0 && ls.counts.closed === 1;
  }, 15000), JSON.stringify(ls));
  await sp.screenshot({ path: join(SHOTS, '390x844-list-search.png') });
  await sp.locator('[data-testid="list-filter-open"]').click();
  report.check('AC22 Açık filter: no match, and the list says so', await until(async () => { ls = await listState(); return ls.open.length === 0 && ls.closed.length === 0 && ls.empty; }, 5000), JSON.stringify(ls));
  await sp.locator('[data-testid="list-filter-closed"]').click();
  report.check('AC22 Kapalı filter: the closed hit', await until(async () => { ls = await listState(); return ls.closed.length === 1 && ls.open.length === 0; }, 5000), JSON.stringify(ls));
  await sp.locator('[data-testid="list-filter-all"]').click();
  await search.fill('webhooks');
  report.check('AC22 a word only an OPEN chat\'s conversation holds: chat A under Açık, highlighted where shown', await until(async () => {
    ls = await listState();
    return ls.open.some((r) => r.id === idA) && ls.counts.open >= 1;
  }, 15000), JSON.stringify(ls));
  await search.fill('zebra');
  await until(async () => (await listState()).closed.length === 1, 15000);
  // A double tap (review r1 C1): the closed row asks the Mac first, and the second tap must not
  // resume the same conversation again.
  await sp.locator('[data-testid="past-row"]:visible').first().dblclick();
  report.check('AC21 a closed row resumes that chat (its words on screen)', await until(async () => !(await onList(sp)) && (await focusedText()).includes('zebra'), 20000));
  await sp.waitForTimeout(1500);
  await svis('[data-testid="chat-back"]').click();
  report.check('AC21 ‹ returns to the list after a resume', await until(() => onList(sp), 8000));
  // The list remounts on ‹ (the search is empty again): count the zebra chat's rows wherever they are.
  ls = await listState();
  const zebra = (rs) => rs.filter((r) => /zebra/i.test(r.text)).length;
  report.check('AC21 a double tap on a closed row opened it once (one open row for it, none closed)', zebra(ls.open) === 1 && zebra(ls.closed) === 0, JSON.stringify(ls));
  await search.fill('');
  // Back into a chat for the 375x667 stack.
  await sp.locator('[data-testid="list-tab-row"]:visible').first().click();
  await until(async () => !(await onList(sp)) && (await svis('.chat-cmp-input').count()) > 0, 10000);

  // The same stack at 375x667.
  console.log('\n── phone stack 375x667');
  await sp.setViewportSize({ width: 375, height: 667 });
  await rest();
  await sp.waitForTimeout(800);
  const cm5 = await chatMetrics(sp);
  rows = await rowsNow();
  await sp.locator(`[data-testid="phone-stack-row"][data-id="${rows[rows.length - 1].id}"]:visible`).click();
  const anim5 = await swapAnim();
  await sp.waitForTimeout(500);
  await sp.screenshot({ path: join(SHOTS, '375x667-stack.png') });
  report.check(`AC20 375x667: rows >= 44px (${cm5.rowHs}), the stack holds at most 3 rows of height (${cm5.stackH}), no overflow, composer <= 64 (${cm5.cmpH}), a tap swaps with the animation (${anim5?.name})`,
    cm5.rowHs.length >= 3 && cm5.stackH <= 3 * 44 + 4 * 4 + 1 && cm5.rowHs.every((h) => h >= 44) && !cm5.overflowX && cm5.cmpH > 0 && cm5.cmpH <= 64 && /^mchatSwap[AB]$/.test(anim5?.name ?? ''), JSON.stringify({ cm5, anim5 }));
  // The list and its search at 375x667.
  await toList();
  await sp.locator('[data-testid="list-search"]:visible').fill('zebra');
  // The zebra chat was resumed above, so it is OPEN now: the search finds it there.
  await until(async () => { const x = await listState(); return x.open.length + x.closed.length >= 1; }, 15000);
  await sp.waitForTimeout(400);
  const lm5 = await listMetrics(sp);
  const ls5 = await listState();
  await sp.screenshot({ path: join(SHOTS, '375x667-list-search.png') });
  report.check(`AC22 375x667: the search finds the resumed zebra chat under Açık, marked, header 44 (${lm5.headH}), no horizontal overflow`, ls5.open.some((r) => r.hits.some((h) => h.toLowerCase() === 'zebra')) && lm5.headH >= 43 && lm5.headH <= 45 && !lm5.overflowX, JSON.stringify(lm5));
  await sctx.close();

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
    // The notifications row is on the list, the phone's home (AC21).
    await until(async () => (await ep.locator('[data-testid="phone-list"]:visible').count()) > 0, 20000);
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
  console.log('\n── desktop 1440x900');
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
  report.check('AC16 the panel lists the registered projects, the current one checked', await until(async () => (await desk.locator('[data-testid="hf-mac-projects"] label').count()) === 2, 10000)
    && await desk.locator('[data-testid="hf-mac-projects"] label', { hasText: 'proj' }).first().locator('input').isChecked()
    && !(await desk.locator('[data-testid="hf-mac-projects"] label', { hasText: 'other' }).locator('input').isChecked()));
  await desk.screenshot({ path: join(SHOTS, '1440-mac-panel-projects.png') });
  await desk.locator('[data-testid="hf-mac-projects"] label', { hasText: 'proj' }).first().locator('input').uncheck();
  report.check('AC16 Start is disabled with no project checked', await desk.locator('[data-testid="hf-mac-start"]').isDisabled());
  await desk.locator('[data-testid="hf-mac-projects"] label', { hasText: 'proj' }).first().locator('input').check();
  report.check('AC16 …and enabled again with one', !(await desk.locator('[data-testid="hf-mac-start"]').isDisabled()));

  const errs = watchers.flatMap((w) => w.errors).filter((e) => !/__TAURI|Failed to load resource: the server responded with a status of 401/.test(e));
  const f403 = watchers.flatMap((w) => w.forbidden);
  report.check('no console errors on any page', errs.length === 0, errs.slice(0, 12).join('\n      '));
  report.check('no 403 in the network log', f403.length === 0, [...new Set(f403)].slice(0, 20).join('\n      '));
  console.log(`\n  screenshots: ${SHOTS}`);
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  try { await phoneBrowser?.close(); } catch { /* gone */ }
  try { proxy?.close(); } catch { /* gone */ }
  try { await fetch(`http://127.0.0.1:${server?.spawnargs?.[server.spawnargs.indexOf('-p') + 1]}/api/handsfree/mac/stop`, { method: 'POST' }); } catch { /* gone */ }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
if (report.fails.length) { for (const f of report.fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
