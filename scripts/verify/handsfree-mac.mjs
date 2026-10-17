#!/usr/bin/env node
/**
 * Hands-free MAC MODE end-to-end verification against a REAL Cloudflare quick tunnel (AC20).
 *
 *   npm run build && node scripts/verify/handsfree-mac.mjs
 *
 * WHAT IT DRIVES — the real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real
 * pinned cloudflared (downloaded and sha256-checked into the scratch HOME), a real
 * `https://<name>.trycloudflare.com` address, and two real Chromium pages: the desktop window
 * (1440 px) and a phone (Playwright's iPhone 13 profile) that reaches the laptop ONLY through the
 * tunnel. The phone's traffic runs through a local CONNECT proxy so the check can drop its
 * network WITHOUT a close handshake: upstream (to Cloudflare) is frozen and kept open, only the
 * browser side is reset — the server's socket goes half-open exactly as a phone that lost its
 * signal does.
 *
 * WHAT IT DOES NOT TOUCH — the machine's power settings: `DREAMCONTEXT_MAC_VERIFY_POWER_LOG`
 * makes the server LOG the pmset/sudo argv instead of running them (honoured only with a
 * scratch HOME under the temp dir). Tokens: `claude` is a scripted stand-in.
 *
 * FAILURE POLICY — collect, don't fail fast: every check prints ✓/✗; exit 0 iff all passed.
 * Screenshots land in tmp/verify-handsfree-mac/.
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The REAL temp path: macOS's /var is a symlink to /private/var, and the stand-in claude records its
// realpath cwd, so a /var project root would never find its own transcripts (no past chats).
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-mac');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
/** A second registered project the owner does NOT choose: the phone must never see it (AC16). */
const OTHER_PROJ = join(SCRATCH, 'other');
const SPAWN_LOG = join(SCRATCH, 'spawns.log');
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-mac');
const HOLDER_PROBE_MS = 3000;
const FIRST_BACKOFF_MS = 1000;

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-reconnect.mjs. */
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const LOG = ${JSON.stringify(SPAWN_LOG)};
const log = (s) => fs.appendFileSync(LOG, s + '\\n');
const argv = process.argv.slice(2);
// The server runs \`claude\` for more than chat (auth/usage probes, titles): only a stream-json
// chat process is logged and scripted; anything else answers empty and leaves.
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
log('spawn ' + process.pid + ' ' + sid);
process.on('exit', () => log('exit ' + process.pid));
const enc = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const dir = path.join(process.env.HOME, '.claude', 'projects', enc);
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
// Like the real CLI, every row records the launch dir (hands-free reads it to tell whose chat it is).
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => {
  const message = { role: 'assistant', content: [{ type: 'text', text }] };
  row({ type: 'assistant', message });
  out({ type: 'assistant', message });
};
const done = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
let inited = false;
async function turn(text) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const slow = /^SLOW (\\d+)/.exec(text);
  if (slow) {
    say('START pid=' + process.pid);
    for (let i = 1; i <= Number(slow[1]); i++) { await sleep(1000); say('[TICK-' + String(i).padStart(2, '0') + ']'); }
    say('FINISH pid=' + process.pid);
    done('FINISH');
    return;
  }
  if (text === 'HANG') { say('HANGING pid=' + process.pid); await new Promise(() => {}); }
  if (text === 'EXIT') { say('BYE pid=' + process.pid); done('BYE'); setTimeout(() => process.exit(0), 200); return; }
  say('ECHO ' + text + ' pid=' + process.pid);
  done('ECHO');
}
let chain = Promise.resolve(); let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) chain = chain.then(() => turn(text));
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ─── page instrumentation: every chat socket and how it closed ───────────────────────
const INIT_SCRIPT = `(() => {
  const Real = window.WebSocket;
  window.__chatSockets = [];
  window.__closeCodes = [];
  class Tracked extends Real {
    constructor(url, protocols) {
      super(url, protocols);
      if (String(url).includes('/api/agent/chat')) {
        const rec = { url: String(url), ws: this, sent: [], got: 0 };
        window.__chatSockets.push(rec);
        const send = this.send.bind(this);
        this.send = (d) => { rec.sent.push(String(d).slice(0, 80)); return send(d); };
        rec.msgs = [];
        this.addEventListener('message', (e) => { rec.got++; if (rec.msgs.length < 4) rec.msgs.push(String(e.data).slice(0, 120)); });
        this.addEventListener('close', (e) => { window.__closeCodes.push(e.code); try { window.__reportClose && window.__reportClose(e.code); } catch {} });
      }
    }
  }
  window.WebSocket = Tracked;
})();`;

// ─── setup ────────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(OTHER_PROJ, '_dream_context', 'state'), { recursive: true });
  // The project's transcript folder exists before the server first lists past chats (it remembers a
  // project with no folder as having none until it restarts).
  mkdirSync(join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
  const add2 = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'other', OTHER_PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add2.status !== 0) throw new Error(`vaults add failed: ${add2.stderr || add2.stdout}`);
}

// ─── a fake push service (AC6-AC8 live): records every push; the phone's keys decrypt it ──

function startFakePush() {
  const got = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${srv.address().port}`, got, close: () => srv.close() })));
}

/** A browser-side subscription's keys (P-256 + a 16-byte auth secret). */
function phoneKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, auth: crypto.randomBytes(16) };
}

/** RFC 8291 decryption, as the phone's browser does it: the payload object, or null. */
function decryptPush(keys, body) {
  try {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const shared = keys.ecdh.computeSecret(asPublic);
    const uaPublic = keys.ecdh.getPublicKey();
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, keys.auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    let plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (plain[end] !== 2) return null;
    plain = plain.subarray(0, end);
    return JSON.parse(plain.toString('utf8'));
  } catch { return null; }
}

async function startServer(port, pushOrigin) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: POWER_LOG, ...(pushOrigin ? { DREAMCONTEXT_MAC_VERIFY_PUSH_ORIGIN: pushOrigin } : {}), ...(process.env.DREAMCONTEXT_MAC_DEBUG ? { DREAMCONTEXT_MAC_DEBUG: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`[server] ${s}`); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

function spawnLog() {
  const lines = existsSync(SPAWN_LOG) ? readFileSync(SPAWN_LOG, 'utf-8').trim().split('\n').filter(Boolean) : [];
  return {
    spawns: lines.filter((l) => l.startsWith('spawn ')).map((l) => l.split(' ')[1]),
    exits: lines.filter((l) => l.startsWith('exit ')).map((l) => l.split(' ')[1]),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The desktop app's own calls to its Mac routes (loopback, no Origin). */
async function mac(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ─── fresh tunnel names: resolve through public resolvers ────────────────────────────
// A quick tunnel's name is printed before its DNS record exists; macOS caches that first
// NXDOMAIN, so this Mac's own resolver can fail on it for minutes (the server's probe does the
// same, src/lib/handsfree/mac/tunnel.ts freshNameLookup). The phone (another network) would not.
function freshLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const r = new dns.Resolver({ timeout: 2000, tries: 1 });
  r.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);
  r.resolve4(hostname, (err, addrs) => {
    if (!err && addrs.length) { if (opts && opts.all) cb(null, [{ address: addrs[0], family: 4 }]); else cb(null, addrs[0], 4); return; }
    dns.lookup(hostname, opts || {}, cb);
  });
}

/** GET through the tunnel: { status, headers, body } (never throws; status 0 on failure). */
function tget(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ host: u.hostname, servername: u.hostname, path: u.pathname + u.search, lookup: freshLookup, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    req.end();
  });
}

/** Any request through the tunnel, as the phone's browser would send it (cookie, Origin). */
function treq(method, url, headers = {}, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ method, host: u.hostname, servername: u.hostname, path: u.pathname + u.search, lookup: freshLookup, timeout: 10_000,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (body) req.write(body);
    req.end();
  });
}

// ─── the phone's network: a CONNECT proxy that can drop without a close handshake ─────

function startPhoneProxy() {
  const pairs = new Set();
  const held = [];
  const srv = http.createServer((_q, r) => { r.writeHead(405); r.end(); });
  srv.on('connect', (req, client, head) => {
    const [host, portStr] = String(req.url).split(':');
    const up = net.connect({ port: Number(portStr) || 443, host, lookup: freshLookup }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      client.pipe(up);
      up.pipe(client);
    });
    const pair = { client, up };
    pairs.add(pair);
    up.on('error', () => {});
    client.on('error', () => {});
    up.on('close', () => pairs.delete(pair));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    /** The phone lost its signal: every upstream connection is frozen and KEPT OPEN (Cloudflare
     *  sees no FIN, so the server's socket stays half-open); the browser side is reset. */
    dropWithoutFin() {
      for (const p of pairs) {
        p.client.unpipe(p.up);
        p.up.unpipe(p.client);
        p.up.pause();
        held.push(p.up);
        if (typeof p.client.resetAndDestroy === 'function') p.client.resetAndDestroy(); else p.client.destroy();
      }
      pairs.clear();
    },
    close() { for (const s of held) s.destroy(); for (const p of pairs) { p.up.destroy(); p.client.destroy(); } srv.close(); },
  })));
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0, fails: [], notes: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

/** Console errors and 403s a page's OWN calls produced (AC17). */
function watch(page, origin, tag) {
  const errors = [];
  const forbidden = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${String(e).slice(0, 200)}`));
  const failed = [];
  page.on('response', (r) => {
    if (r.status() === 403 && r.url().startsWith(origin)) forbidden.push(`${tag}: ${r.request().method()} ${r.url().replace(origin, '')}`);
    if (r.status() >= 400) failed.push(`${tag}: ${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
  });
  return { errors, forbidden, failed };
}

async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}

/** No element overflows the viewport horizontally. */
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

let server = null;
let fakePush = null;
let browser = null;
let phoneBrowser = null;
let proxy = null;
const watchers = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  console.log('· scratch vault + scripted claude…');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`· the real dashboard server on ${port} (power runner LOGS only: ${POWER_LOG})…`);
  fakePush = await startFakePush();
  server = await startServer(port, fakePush.origin);
  proxy = await startPhoneProxy();
  browser = await chromium.launch();
  // The phone's own browser: every connection goes through the proxy that can drop it.
  phoneBrowser = await chromium.launch({ proxy: { server: proxy.url } });

  // ── M0: the desktop window runs a chat ──────────────────────────────────────────
  console.log('\n── M0: a chat runs in the desktop window');
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const desk = await deskCtx.newPage();
  watchers.push(watch(desk, base, 'desktop'));
  await desk.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
  await desk.addInitScript(INIT_SCRIPT);
  await desk.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await desk.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await desk.keyboard.press('Escape'); await desk.waitForTimeout(250); }
  const dvis = (sel) => desk.locator(`${sel}:visible`);
  /** The desktop's chat overlay starts collapsed after a (re)load: open it. */
  const expandDesk = async () => {
    if (await desk.locator('.agent-surface.expanded').count()) return;
    // A restored chat may sit in the dock (bottom right): its chip opens it.
    const chip = desk.locator('.agent-dock-chip').filter({ hasText: /Chat/ }).first();
    if (await chip.count()) { await chip.click().catch(() => {}); await desk.waitForTimeout(1500); }
    if (await desk.locator('.agent-surface.expanded').count()) return;
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = desk.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await desk.waitForTimeout(1500); }
      if (await desk.locator('.agent-surface.expanded').count()) break;
    }
  };
  await expandDesk();
  if (!(await dvis('.chat-cmp-input').count())) await desk.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  report.check('the desktop chat opens', await until(async () => (await dvis('.chat-cmp-input').count()) > 0, 20000));
  const deskText = async () => (await dvis('.chat-pane').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  const deskSend = async (t) => { const c = dvis('.chat-cmp-input').first(); await c.click(); await c.fill(t); await desk.waitForTimeout(120); await desk.keyboard.press('Enter'); };
  await deskSend('SLOW 40');
  report.check('a long turn is running on the desktop', await until(async () => (await deskText()).includes('[TICK-02]'), 20000));
  const pid = /START pid=(\d+)/.exec(await deskText())?.[1] ?? '?';
  // A SECOND live chat in the same project (AC9: "a project whose desktop has 2 live chats"),
  // opened the way any desktop client opens one: a loopback chat socket.
  const { WebSocket: NodeWs } = await import('ws');
  const SECOND_ID = crypto.randomUUID();
  let second = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&sessionId=${SECOND_ID}`);
  const secondGot = [];
  second.on('message', (d) => secondGot.push(String(d)));
  await new Promise((r) => second.on('open', r));
  await sleep(1200);
  second.send(JSON.stringify({ type: 'user', text: 'SECOND' }));
  report.check('a second desktop chat is live in the same project', await until(async () => secondGot.some((x) => x.includes('ECHO SECOND')), 15000));

  // ── M1: setup + start against the real tunnel ───────────────────────────────────
  console.log('\n── M1: setup, start (pinned cloudflared, real quick tunnel, probe, power)');
  const setup = await mac(port, 'POST', 'setup', {});
  const passphrase = setup.json.passphrase;
  report.check('setup shows a 6-word passphrase once', setup.status === 200 && /^\S+( \S+){5}$/.test(passphrase ?? ''), JSON.stringify(setup.json).slice(0, 200));
  const authFile = join(HOME, '.dreamcontext', 'handsfree-mac', 'auth.json');
  report.check('only the scrypt verifier is stored (0600), never the passphrase', existsSync(authFile) && !readFileSync(authFile, 'utf8').includes(passphrase)
    && (spawnSync('stat', ['-f', '%Lp', authFile], { encoding: 'utf8' }).stdout.trim() === '600'));
  // AC1: the sheet's first step offers both modes, "From this Mac" selected.
  await dvis('[data-testid="hf-button"]').first().click();
  report.check('the sheet opens on Mac mode only (no cloud option)', await until(async () => (await desk.locator('[data-testid="hf-mac-start"]').count()) === 1
    && (await desk.locator('[data-testid="hf-mode-cloud"]').count()) === 0, 10000));
  await desk.screenshot({ path: join(SHOTS, 'desktop-1440-sheet-modes.png') });
  await desk.locator('.hf-sheet-head .hf-icon-btn').first().click();
  const t0 = Date.now();
  const started = await mac(port, 'POST', 'start', { vaults: ['proj'] });
  const url = started.json.url;
  report.check('start: URL known within 30 s (+ download)', started.status === 200 && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url ?? ''), `${started.status} ${JSON.stringify(started.json).slice(0, 300)} after ${Date.now() - t0} ms`);
  report.note(`(start took ${Date.now() - t0} ms incl. first download; ${url})`);
  const binOk = existsSync(join(HOME, '.dreamcontext', 'bin', 'cloudflared-2026.10.1'));
  report.check('the pinned cloudflared was installed into ~/.dreamcontext/bin', binOk);
  const power = existsSync(POWER_LOG) ? readFileSync(POWER_LOG, 'utf8') : '';
  report.check('power: prior LPM read, then disablesleep 1 + LPM on both sources (sudo -n only)',
    /pmset -g custom[\s\S]*sudo -n \/usr\/bin\/pmset -a disablesleep 1[\s\S]*-b lowpowermode 1[\s\S]*-c lowpowermode 1/.test(power), power);
  const h = await tget(`${url}/api/health`);
  let hb = {};
  try { hb = JSON.parse(h.body); } catch { /* not json */ }
  report.check('/api/health through the tunnel answers only {version}', h.status === 200 && Object.keys(hb).join() === 'version', `${h.status} ${h.body}`);
  const leaked = (await tget(`${url}/api/tasks`)).status;
  report.check('a desktop-only route through the tunnel is refused', leaked === 401 || leaked === 403, String(leaked));
  const viaMain = await fetch(`${base}/api/health`, { headers: { 'cf-ray': 'x' } }).then((r) => r.status);
  report.check('the main listener refuses a request carrying cf-ray', viaMain === 403, String(viaMain));

  // ── M2: QR login (one-time) ─────────────────────────────────────────────────────
  console.log('\n── M2: QR login: scan → signed in, lands in chat; reuse → login page');
  const qr = (await mac(port, 'POST', 'qr')).json.url;
  report.check('the QR carries a one-time token', /\/login\?t=[A-Za-z0-9_-]{43}$/.test(qr ?? ''), qr);
  const phoneCtx = await phoneBrowser.newContext({ ...devices['iPhone 13'] });
  // Close codes outlive a navigation (a 4401 sends the page to /login, wiping page state).
  const phoneCloses = [];
  await phoneCtx.exposeBinding('__reportClose', (_src, code) => { phoneCloses.push(code); });
  const phone = await phoneCtx.newPage();
  watchers.push(watch(phone, url, 'phone'));
  await phone.addInitScript(INIT_SCRIPT);
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('scan → signed in and landed in the chat (/?vault=proj)', await until(async () => phone.url().includes('vault=proj'), 20000), phone.url());
  report.check('the phone SPA carries the mac surface marker', await phone.evaluate(() => document.querySelector('meta[name="dreamcontext-surface"]')?.getAttribute('content')) === 'mac');
  const pvis = (sel) => phone.locator(`${sel}:visible`);
  await phone.waitForTimeout(3000);
  // The first visit's "What's New" popup (same as the desktop's) is dismissed first.
  const dismiss = async (page) => { for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); } };
  await dismiss(phone);
  report.check('the phone opens on its Sohbetler list (AC21)', await until(async () => (await pvis('[data-testid="phone-list"]').count()) > 0, 20000));
  await phone.screenshot({ path: join(SHOTS, 'phone-390-chat.png') });
  const reuseCtx = await phoneBrowser.newContext({ ...devices['iPhone 13'] });
  const reuse = await reuseCtx.newPage();
  await reuse.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('the same QR used again → the login page, not a session', (await reuse.content()).includes('Sign in to your Mac') && !reuse.url().includes('vault='));

  // ── M3: passphrase login ────────────────────────────────────────────────────────
  console.log('\n── M3: passphrase login over the tunnel');
  await reuse.goto(`${url}/login`, { waitUntil: 'domcontentloaded' });
  await reuse.screenshot({ path: join(SHOTS, 'phone-390-login.png') });
  report.check('the login page fits a phone (no horizontal overflow)', await noOverflow(reuse));
  await reuse.fill('#p', passphrase);
  await reuse.click('#go');
  report.check('the passphrase signs the second phone in', await until(async () => reuse.url().includes('vault=proj'), 25000), reuse.url());
  await reuseCtx.close();

  // ── M4: the phone adopts the desktop's running chat (the list's Mac row) ───────
  console.log('\n── M4: takeover — phone adopts the running desktop chat, zero spawns');
  const desktopRoster = join(PROJ, '_dream_context', 'state', '.agent-sessions.json');
  const rosterBefore = existsSync(desktopRoster) ? readFileSync(desktopRoster, 'utf8') : '';
  const spawnsBefore = spawnLog().spawns.length;
  report.check('the list shows BOTH live desktop chats as open "Mac" rows', await until(async () => (await phone.locator('[data-testid="mac-live-row"]').count()) >= 2, 15000));
  report.check('AC16: one chosen project: no project switch on the list', (await phone.locator('[data-testid="list-projects"]').count()) === 0);
  const states = await phone.locator('[data-testid="mac-live-state"]').allInnerTexts();
  report.check('AC18: each live row reads its state (Working / Waiting for you / Idle)', states.length >= 2 && states.every((t) => /^(Working|Waiting for you|Idle)$/.test(t.trim())), JSON.stringify(states));
  await phone.waitForTimeout(1500); // the past list has loaded (its transcripts hold the live chats too)
  const liveIds = await phone.locator('[data-testid="mac-live-row"]').evaluateAll((els) => els.map((e) => e.dataset.id));
  const pastIds = await phone.locator('[data-testid="past-row"]').evaluateAll((els) => els.map((e) => e.dataset.id));
  // Not vacuous: the server's past-chats list DOES hold the running chats (their transcripts exist);
  // the list is what keeps them out of Kapalı.
  const rawPast = await phone.evaluate(async () => {
    const r = await fetch('/api/agent/chat-sessions?limit=50', { headers: { accept: 'application/json', 'x-dreamcontext-vault': 'proj' } });
    return r.ok ? (await r.json()).sessions.map((x) => x.id) : [`HTTP ${r.status}`];
  });
  report.check('AC18: a chat running on the Mac is listed once (open, as a Mac row; not under Kapalı, though the past list holds it)',
    liveIds.length >= 2 && liveIds.some((id) => rawPast.includes(id)) && !pastIds.some((id) => liveIds.includes(id)), JSON.stringify({ liveIds, pastIds, rawPast }));
  report.check('zero refusal banners and zero spawns on opening the project', (await pvis('.chat-banner-ended').count()) === 0 && spawnLog().spawns.length === spawnsBefore);
  await phone.screenshot({ path: join(SHOTS, 'phone-390-list.png') });
  report.check('the list fits a phone', await noOverflow(phone));
  await phone.locator('[data-testid="mac-live-row"]').filter({ hasText: 'Chat 1' }).first().click();
  const phoneText = async () => (await pvis('.chat-pane').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  report.check('the phone shows the running turn (ticks keep coming)', await until(async () => /\[TICK-\d+\]/.test(await phoneText()), 20000));
  report.check('the desktop pane is told: "open on your phone · Take it here"', await until(async () => (await dvis('.chat-banner-taken').count()) > 0, 10000));
  const deskCloses = await desk.evaluate(() => window.__closeCodes.slice());
  report.check('the desktop socket was closed 4409', deskCloses.includes(4409), JSON.stringify(deskCloses));
  report.check('zero spawns, the same pid keeps the turn', spawnLog().spawns.length === spawnsBefore && (await phoneText()).length > 0, JSON.stringify(spawnLog()));
  const rosterAfter = existsSync(desktopRoster) ? readFileSync(desktopRoster, 'utf8') : '';
  report.check('the desktop roster file is byte-identical', rosterAfter === rosterBefore);
  await phone.screenshot({ path: join(SHOTS, 'phone-390-chip.png') });
  report.check('the phone chip shows the Mac', (await phone.locator('.dc-hf-chip').count()) > 0);

  // ── M5: "Buraya al" back, then the phone reloads (passive restore) ──────────────
  console.log('\n── M5: desktop takes it back; the phone reloads → passive, no eviction');
  await desk.locator('.chat-banner-taken').getByRole('button').first().click();
  report.check('the phone is told: "open on your Mac"', await until(async () => (await pvis('.chat-banner-taken').count()) > 0, 10000));
  await phone.screenshot({ path: join(SHOTS, 'phone-390-takeover-banner.png') });
  report.check('the phone socket was closed 4409', (await phone.evaluate(() => window.__closeCodes.slice())).includes(4409));
  const deskSocketsBefore = await desk.evaluate(() => window.__chatSockets.length);
  await phone.reload({ waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(2500);
  await dismiss(phone);
  // A reload starts on the list (AC21): the restored chat is a row; opening it shows its banner.
  report.check('after the reload the phone opens on its list, the restored chat a row there', await until(async () => (await pvis('[data-testid="phone-list"]').count()) > 0
    && (await phone.locator('[data-testid="list-tab-row"]').filter({ hasText: 'Chat 1' }).count()) > 0, 25000));
  await phone.locator('[data-testid="list-tab-row"]').filter({ hasText: 'Chat 1' }).first().click();
  report.check('after the reload the phone shows "Buraya al" again (passive restore)', await until(async () => (await pvis('[data-testid="phone-list"]').count()) === 0 && (await pvis('.chat-banner-taken').count()) > 0, 25000));
  await desk.waitForTimeout(2000);
  report.check('the desktop socket stayed open (no eviction, no reconnect)', (await dvis('.chat-banner-taken').count()) === 0
    && (await desk.evaluate(() => window.__chatSockets.length)) === deskSocketsBefore
    && (await desk.evaluate(() => window.__chatSockets[window.__chatSockets.length - 1].ws.readyState)) === 1);

  // ── M6: both connected for 60 s → no ping-pong ──────────────────────────────────
  console.log('\n── M6: both clients connected for 60 s — the adoption count stays put');
  const sockCount = async () => [await desk.evaluate(() => window.__chatSockets.length), await phone.evaluate(() => window.__chatSockets.length)];
  const before60 = await sockCount();
  // AC13 rides the same minute: the (seamed) battery drains to 12% and discharges; the watch
  // polls every 2 s here, the phone chip every 30 s.
  const armedAt = readFileSync(POWER_LOG, 'utf8').split('\n').length;
  writeFileSync(`${POWER_LOG}.batt`, "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t12%; discharging; 0:40 remaining present: true");
  await sleep(60_000);
  const after60 = await sockCount();
  report.check('no new chat sockets on either side in 60 s', JSON.stringify(before60) === JSON.stringify(after60), `${before60} → ${after60}`);
  const drained = readFileSync(POWER_LOG, 'utf8').split('\n').slice(armedAt);
  report.check('battery at 12% discharging: sleep allowed again (disablesleep 0), no re-arm', drained.some((l) => l.endsWith('-a disablesleep 0'))
    && !drained.some((l) => l.endsWith('-a disablesleep 1')), drained.filter((l) => l.includes('disablesleep')).join(' | '));
  report.check('the phone chip warns the Mac may sleep', await until(async () => (await phone.locator('.dc-hf-chip[data-mac="low"]').count()) > 0, 35000),
    await phone.locator('.dc-hf-chip').first().innerText().catch(() => '(no chip)'));
  await phone.screenshot({ path: join(SHOTS, 'phone-390-chip-low.png') });
  const st = await mac(port, 'GET', 'status');
  report.check('status reports the battery and sleepAllowed', JSON.stringify(st.json).includes('"sleepAllowed":true'), JSON.stringify(st.json).slice(0, 300));
  rmSync(`${POWER_LOG}.batt`, { force: true });

  // ── M7: a desktop network drop while the phone holds → the desktop gets 4409 ─────
  console.log('\n── M7: the phone takes it; a desktop reconnect gets 4409, the phone keeps it');
  await pvis('.chat-banner-taken').getByRole('button').first().click();
  report.check('the phone holds the chat again', await until(async () => (await pvis('.chat-banner-taken').count()) === 0 && (await dvis('.chat-banner-taken').count()) > 0, 15000));
  // The desktop window was taken over (stopped); a network drop there means its NEXT automatic
  // open: simulate it by reloading (an automatic, passive restore of its roster).
  await desk.reload({ waitUntil: 'domcontentloaded' });
  await desk.waitForTimeout(4000);
  await dismiss(desk);
  await expandDesk();
  const m7ok = await until(async () => (await dvis('.chat-banner-taken').count()) > 0, 25000);
  if (!m7ok) await desk.screenshot({ path: join(SHOTS, 'debug-desktop-m7.png') });
  else await desk.screenshot({ path: join(SHOTS, 'desktop-1440-taken-over.png') });
  report.check('the desktop\'s automatic reopen is answered 4409 (shows "Take it here")', m7ok,
    `sockets: ${JSON.stringify(await desk.evaluate(() => window.__chatSockets.map((x) => x.url.replace(/^.*\?/, '').slice(0, 160))))} closes: ${JSON.stringify(await desk.evaluate(() => window.__closeCodes))} text: ${(await deskText()).slice(-200)}`);
  report.check('the phone still holds the chat', (await pvis('.chat-banner-taken').count()) === 0 && (await phone.evaluate(() => window.__chatSockets[window.__chatSockets.length - 1].ws.readyState)) === 1);
  {
    const pc0 = phone.locator('.chat-cmp-input:visible').first();
    await pc0.click(); await pc0.fill('EARLY PHONE'); await phone.keyboard.press('Enter');
    report.check('a chat turn from the phone (before any drop) runs on the Mac', await until(async () => (await phoneText()).includes(`ECHO EARLY PHONE pid=${pid}`), 20000));
  }

  // ── M8: the phone's network drops WITHOUT a FIN behind the real tunnel ──────────
  console.log('\n── M8: phone network drop with no close handshake → passive reconnect adopts');
  const phoneSocketsBefore = await phone.evaluate(() => window.__chatSockets.length);
  const closesBeforeDrop = phoneCloses.length;
  const dropAt = Date.now();
  proxy.dropWithoutFin();
  const adopted = await until(async () => {
    const n = await phone.evaluate(() => window.__chatSockets.length);
    if (n <= phoneSocketsBefore) return false;
    // Adopted = the SERVER said so on the new socket (an open socket alone is still being probed).
    return (await phone.evaluate(() => { const x = window.__chatSockets[window.__chatSockets.length - 1]; return x.ws.readyState === 1 && x.msgs.some((m) => m.includes('"reattached"') && m.includes('"adopted":true')); }))
      && (await pvis('.chat-banner-taken').count()) === 0;
  }, 30_000, 100);
  const took = Date.now() - dropAt;
  report.check(`the passive reconnect adopted within ~HOLDER_PROBE_MS + first backoff (${HOLDER_PROBE_MS + FIRST_BACKOFF_MS} ms + tunnel latency)`, adopted && took < HOLDER_PROBE_MS + FIRST_BACKOFF_MS + 6000, `${took} ms`);
  report.note(`(drop → adopted in ${took} ms)`);
  const lastUrl = await phone.evaluate(() => window.__chatSockets[window.__chatSockets.length - 1].url);
  report.check('the reconnect was passive (reattach=passive)', /[?&]reattach=passive(&|$)/.test(lastUrl), lastUrl);
  report.check('no 4409 and no "Buraya al" on the phone', !phoneCloses.slice(closesBeforeDrop).includes(4409) && (await pvis('.chat-banner-taken').count()) === 0, JSON.stringify(phoneCloses.slice(closesBeforeDrop)));
  await phone.locator('.chat-cmp-input:visible').first().click().catch(() => {});
  report.check('the turn finishes on the phone, same process', await until(async () => (await phoneText()).includes(`FINISH pid=${pid}`), 60_000), (await phoneText()).slice(-200));
  const pc = phone.locator('.chat-cmp-input:visible').first();
  await pc.click(); await pc.fill('FROM PHONE'); await phone.keyboard.press('Enter');
  report.check('a chat turn from the phone runs on the Mac (same pid)', await until(async () => (await phoneText()).includes(`ECHO FROM PHONE pid=${pid}`), 20000), `${(await phoneText()).slice(-160)} || transcript has FROM PHONE: ${spawnSync('/bin/sh', ['-c', `grep -l 'FROM PHONE' ${HOME}/.claude/projects/*/*.jsonl 2>/dev/null | head -1`], { encoding: 'utf8' }).stdout.trim() || 'no'} || sockets: ${JSON.stringify(await phone.evaluate(() => window.__chatSockets.map((x) => ({ u: x.url.replace(/^.*reattach=/, 'r=').slice(0, 12), st: x.ws.readyState, sent: x.sent.filter((f) => f.includes('user')), got: x.got, msgs: x.msgs }))))} queued-rows: ${await phone.evaluate(() => document.querySelectorAll('[class*="queue"]').length)}`);
  report.check('still exactly one chat process', spawnLog().spawns.length === spawnsBefore);

  // ── M8b: the gate, the chosen projects, and a real push round trip (W2) ─────────
  console.log('\n── M8b: route policy + chosen projects through the tunnel; push to a fake push service');
  const ck = (await phoneCtx.cookies()).filter((c) => url.includes(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');
  const ph = (extra = {}) => ({ cookie: ck, origin: url, accept: 'application/json', 'x-dreamcontext-vault': 'proj', ...extra });
  const vaultsSeen = await treq('GET', `${url}/api/vaults`, ph());
  report.check('the phone lists only the chosen project', vaultsSeen.status === 200 && JSON.stringify(JSON.parse(vaultsSeen.body).vaults) === JSON.stringify([{ name: 'proj', exists: true }]), vaultsSeen.body);
  report.check('dashboard reads pass (tasks, lab, whiteboards, knowledge)', (await Promise.all(['/api/tasks', '/api/lab', '/api/whiteboards', '/api/knowledge'].map((p) => treq('GET', `${url}${p}`, ph())))).every((r) => r.status === 200));
  report.check('the unchosen project is refused (header, ?vault=)', (await treq('GET', `${url}/api/tasks`, ph({ 'x-dreamcontext-vault': 'other' }))).status === 403
    && (await treq('GET', `${url}/api/tasks?vault=other`, ph())).status === 403);
  const denied = await treq('POST', `${url}/api/window/focus`, ph(), '{}');
  report.check('a laptop-only route is refused phone_unavailable, with nosniff', denied.status === 403 && /phone_unavailable/.test(denied.body) && denied.headers['x-content-type-options'] === 'nosniff', `${denied.status} ${denied.body}`);
  report.check('a cross-site API request is refused', (await treq('GET', `${url}/api/tasks`, ph({ 'sec-fetch-site': 'cross-site' }))).status === 403);
  const keys = phoneKeys();
  const sub = { endpoint: `${fakePush.origin}/push/phone-1`, keys: { p256dh: keys.ecdh.getPublicKey().toString('base64url'), auth: keys.auth.toString('base64url') } };
  report.check('the VAPID key is served to a signed-in phone', /"publicKey":"[A-Za-z0-9_-]{80,}"/.test((await treq('GET', `${url}/api/handsfree/push/key`, ph())).body));
  report.check('a non-push-service endpoint is refused', (await treq('PUT', `${url}/api/handsfree/push/subscription`, ph(), JSON.stringify({ ...sub, endpoint: 'https://evilnotify.windows.com/x' }))).status === 400);
  const put = await treq('PUT', `${url}/api/handsfree/push/subscription`, ph(), JSON.stringify(sub));
  report.check('the phone subscribes (PUT 200)', put.status === 200, `${put.status} ${put.body}`);
  const pushFile = join(HOME, '.dreamcontext', 'handsfree-mac', 'push.json');
  report.check('push.json is 0600 and holds one subscription', existsSync(pushFile) && spawnSync('stat', ['-f', '%Lp', pushFile], { encoding: 'utf8' }).stdout.trim() === '600'
    && Object.keys(JSON.parse(readFileSync(pushFile, 'utf8'))).length === 1);
  const pushesBefore = fakePush.got.length;
  second.send(JSON.stringify({ type: 'user', text: 'PUSHME' }));
  const turnPush = async () => fakePush.got.slice(pushesBefore).map((g) => ({ g, p: decryptPush(keys, g.body) })).find((x) => x.p?.kind === 'turn' && x.p?.conversationId === SECOND_ID);
  report.check('a finished turn on the Mac pushes "turn finished" to the phone', await until(async () => !!(await turnPush()), 20000), JSON.stringify(fakePush.got.slice(pushesBefore).map((g) => decryptPush(keys, g.body))));
  const tp = await turnPush();
  if (tp) {
    report.check('the push is RFC 8291 aes128gcm with a VAPID header, high urgency, a TTL', tp.g.headers['content-encoding'] === 'aes128gcm' && /^vapid t=[^,]+, k=/.test(tp.g.headers.authorization ?? '') && tp.g.headers.urgency === 'high' && Number(tp.g.headers.ttl) > 0, JSON.stringify(tp.g.headers));
    report.check('its tap target opens that chat (D10 deep link)', tp.p.url === `/?vault=proj&open=${encodeURIComponent(`dreamcontext://project/proj/session/${SECOND_ID}`)}`, tp.p.url);
  }
  // AC9: the push's link, loaded on the phone, opens THAT conversation there — adopted from the
  // Mac (the same process), never resumed beside it.
  if (tp) {
    const spawnsAtLink = spawnLog().spawns.length;
    await phone.goto(`${url}${tp.p.url}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await phone.waitForTimeout(2500);
    await dismiss(phone);
    report.check('the push link opens that chat on the phone (its turn is on screen)', await until(async () => (await phoneText()).includes('ECHO PUSHME'), 30000), (await phoneText()).slice(-200));
    report.check('…adopted: no new chat process', spawnLog().spawns.length === spawnsAtLink, JSON.stringify(spawnLog()));
    await phone.screenshot({ path: join(SHOTS, 'phone-390-push-link.png') });
    // The desktop takes the second chat back (an explicit reattach), for the sections below.
    second = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&resume=${SECOND_ID}&reattach=1`);
    second.on('message', (d) => secondGot.push(String(d)));
    await new Promise((r) => second.on('open', r));
    await sleep(1500);
    // Back to the chat the phone held before (chat 1), so the suppression check below is on it.
    await pvis('[data-testid="chat-back"]').first().click().catch(() => {});
    await until(async () => (await pvis('[data-testid="phone-list"]').count()) > 0, 8000);
    await phone.locator('[data-testid="list-tab-row"]').filter({ hasText: 'Chat 1' }).first().click().catch(() => {});
    await phone.waitForTimeout(1500);
  }
  // Suppression (D2): the chat the phone shows on screen does not buzz the phone.
  const quietFrom = fakePush.got.length;
  await pc.click(); await pc.fill('QUIET'); await phone.keyboard.press('Enter');
  report.check('the phone runs a turn in the chat it shows (chat 1)', await until(async () => (await phoneText()).includes(`ECHO QUIET pid=${pid}`), 20000), (await phoneText()).slice(-160));
  await sleep(3000);
  report.check('a turn in the chat open on the phone\'s screen sends no push', fakePush.got.slice(quietFrom).map((g) => decryptPush(keys, g.body)).filter((x) => x?.kind === 'turn').length === 0,
    JSON.stringify(fakePush.got.slice(quietFrom).map((g) => decryptPush(keys, g.body))));

  // ── M9: revoke-all ──────────────────────────────────────────────────────────────
  console.log('\n── M9: "Hepsini çıkar" — the phone is signed out at once');
  const closesBeforeRevoke = phoneCloses.length;
  const rv = await mac(port, 'POST', 'devices/revoke-all');
  report.check('revoke-all signed the phones out', rv.status === 200 && rv.json.revoked >= 1, JSON.stringify(rv.json));
  report.check('revoke-all removed the phone\'s push subscription', Object.keys(JSON.parse(readFileSync(pushFile, 'utf8') || '{}')).length === 0, readFileSync(pushFile, 'utf8'));
  const afterRevoke = fakePush.got.length;
  second.send(JSON.stringify({ type: 'user', text: 'AFTER' }));
  await until(async () => secondGot.some((x) => x.includes('ECHO AFTER')), 15000);
  await sleep(2000);
  report.check('no push after the phone was signed out', fakePush.got.length === afterRevoke);
  report.check('the phone socket got 4401 and the phone went to the login page', await until(async () => phoneCloses.slice(closesBeforeRevoke).includes(4401) && phone.url().includes('/login?revoked=1'), 10000), `${phone.url()} ${JSON.stringify(phoneCloses.slice(closesBeforeRevoke))}`);

  // ── M10: the desktop sheet (1440) and Return ────────────────────────────────────
  console.log('\n── M10: the desktop sheet, then Return');
  const qr2 = (await mac(port, 'POST', 'qr')).json.url;
  await phone.goto(qr2, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('a new QR signs the phone in again', await until(async () => phone.url().includes('vault=proj'), 20000));
  await phone.waitForTimeout(2500);
  await dismiss(phone);
  // Signed in again = a NEW device id, and revoke-all dropped the old subscription: the app's start
  // hands the browser's subscription to the Mac again (PushOptIn resyncPush), and pushes come back.
  const ck2 = (await phoneCtx.cookies()).filter((c) => url.includes(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');
  const reput = await treq('PUT', `${url}/api/handsfree/push/subscription`, { ...ph(), cookie: ck2 }, JSON.stringify(sub));
  report.check('after signing in again the phone hands its subscription back (PUT 200)', reput.status === 200, `${reput.status} ${reput.body}`);
  const againFrom = fakePush.got.length;
  second.send(JSON.stringify({ type: 'user', text: 'AGAIN' }));
  report.check('…and a finished turn pushes to the phone again', await until(async () => fakePush.got.slice(againFrom).map((g) => decryptPush(keys, g.body)).some((x) => x?.kind === 'turn' && x?.conversationId === SECOND_ID), 20000),
    JSON.stringify(fakePush.got.slice(againFrom).map((g) => decryptPush(keys, g.body))));
  await dvis('[data-testid="hf-button"]').first().click();
  report.check('the desktop chip reads "On phone"', (await desk.locator('[data-testid="hf-button"]').first().innerText()).includes('On phone'));
  report.check('the sheet shows the Mac panel (address, devices, risk, Return)', await until(async () => (await desk.locator('[data-testid="hf-mac-panel"][data-phase="on"]').count()) > 0
    && (await desk.locator('[data-testid="hf-mac-risk"]').count()) > 0, 10000));
  await desk.locator('[data-testid="hf-mac-show-qr"]').click();
  report.check('"Show QR" draws the one-time QR', await until(async () => (await desk.locator('[data-testid="hf-mac-qr"] svg').count()) > 0, 10000));
  await desk.screenshot({ path: join(SHOTS, 'desktop-1440-sheet.png') });
  report.check('the desktop page has no horizontal overflow', await noOverflow(desk));
  const closesBeforeReturn = phoneCloses.length;
  await desk.locator('[data-testid="hf-mac-return"]').click();
  report.check('Return: the sheet goes back to off', await until(async () => (await desk.locator('[data-testid="hf-mac-panel"][data-phase="off"]').count()) > 0, 20000));
  report.check('every phone socket closed 4401', await until(async () => phoneCloses.slice(closesBeforeReturn).includes(4401), 10000), JSON.stringify(phoneCloses.slice(closesBeforeReturn)));
  const ps = spawnSync('/bin/sh', ['-c', `ps -axo command | grep -c '${HOME}/.dreamcontext/bin/cloudflared' | tr -d ' '`], { encoding: 'utf8' }).stdout.trim();
  report.check('cloudflared and its watchdog exited', await until(async () => spawnSync('/bin/sh', ['-c', `ps -axo command | grep '${HOME}/.dreamcontext/bin/cloudflared' | grep -v grep | wc -l`], { encoding: 'utf8' }).stdout.trim() === '0', 8000), ps);
  const powerAfter = readFileSync(POWER_LOG, 'utf8').split('\n');
  const tail = powerAfter.slice(powerAfter.lastIndexOf('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0')).join('\n');
  report.check('Return restored sleep (disablesleep 0) and LPM per source (0 / 1 as recorded)', /disablesleep 0[\s\S]*-b lowpowermode 0[\s\S]*-c lowpowermode 1/.test(tail), tail);
  report.check('state cleared', !existsSync(join(HOME, '.dreamcontext', 'handsfree-mac', 'state.json')));
  const gone = (await tget(`${url}/api/health`)).headers['x-dreamcontext-mac-probe'] === undefined;
  report.check('the tunnel address no longer reaches the laptop', gone);
  await desk.locator('.hf-sheet-head .hf-icon-btn').first().click().catch(() => {});
  await expandDesk();
  report.check('the desktop pane reattached by itself (no banner) and takes a turn on the same process', await until(async () => (await dvis('.chat-banner-taken').count()) === 0, 15000)
    && (await (async () => { await deskSend('BACK'); return until(async () => (await deskText()).includes(`ECHO BACK pid=${pid}`), 20000); })()));
  report.check('still exactly one chat process after Return', spawnLog().spawns.length === spawnsBefore, JSON.stringify(spawnLog()));

  // ── M11: a graceful shutdown is a Return (AC12) ─────────────────────────────────
  console.log('\n── M11: graceful shutdown while Mac mode is on runs stop');
  second.close();
  const again = await mac(port, 'POST', 'start', { vaults: ['proj'] });
  report.check('Mac mode starts again', again.status === 200 && !!again.json.url, JSON.stringify(again.json).slice(0, 200));
  const armsBefore = readFileSync(POWER_LOG, 'utf8').split('\n').filter((l) => l.endsWith('disablesleep 1') && !l.includes(' -l ')).length;
  server.kill('SIGTERM');
  await new Promise((r) => { server.once('exit', r); setTimeout(r, 8000); });
  const lines = readFileSync(POWER_LOG, 'utf8').split('\n');
  const lastArm = lines.map((l, i) => (l.endsWith('disablesleep 1') && !l.includes(' -l ') ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  report.check('SIGTERM restored sleep after the last arm', armsBefore >= 1 && lines.slice(lastArm + 1).some((l) => l.endsWith('disablesleep 0')), lines.slice(lastArm).join(' | '));
  report.check('SIGTERM: cloudflared gone and state cleared', !existsSync(join(HOME, '.dreamcontext', 'handsfree-mac', 'state.json'))
    && spawnSync('/bin/sh', ['-c', `ps -axo command | grep '${HOME}/.dreamcontext/bin/cloudflared' | grep -v grep | wc -l`], { encoding: 'utf8' }).stdout.trim() === '0');
  server = null;

  // ── AC17: zero console errors, zero 403s from the SPA's own calls ───────────────
  // Expected noise, each named: a socket the check itself killed (M8 drop, Return), and the
  // browser's own line for the expected 401/403s the CHECKS provoke (a refused route probe, the
  // revoked phone). Everything else counts. The ignored lines are printed, never hidden.
  const all = watchers.flatMap((w) => w.errors);
  const ignored = all.filter((e) => /WebSocket connection to .* failed|ERR_CONNECTION|ERR_TUNNEL|net::ERR_|Failed to load resource: the server responded with a status of (401|403|404|530)|__TAURI/.test(e));
  const errs = all.filter((e) => !ignored.includes(e));
  for (const e of ignored) report.note(`(ignored, provoked by the check: ${e.slice(0, 160)})`);
  for (const f of watchers.flatMap((w) => w.failed)) report.note(`(http ${f})`);
  const f403 = watchers.flatMap((w) => w.forbidden);
  report.check('zero console errors on the phone and desktop pages', errs.length === 0, errs.join('\n      '));
  report.check('zero 403s from the SPA\'s own calls', f403.length === 0, f403.join('\n      '));
  report.note(`screenshots: ${SHOTS}`);
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  try { await phoneBrowser?.close(); } catch { /* gone */ }
  try { proxy?.close(); } catch { /* gone */ }
  try { fakePush?.close(); } catch { /* gone */ }
  try { await fetch(`http://127.0.0.1:${server?.spawnargs?.[server.spawnargs.indexOf('-p') + 1]}/api/handsfree/mac/stop`, { method: 'POST' }); } catch { /* gone */ }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
if (report.fails.length) { for (const f of report.fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
