#!/usr/bin/env node
/**
 * A stand-in for the dreamcontext desktop server, speaking ONLY the runner half of the
 * dreamcontext Apps contract (plan r19, "Kontrat"), so the app runner (desktop/app-runner)
 * can be proved on a real Mac before the real gateway exists (W1 gate).
 *
 *   ~/.dreamcontext/desktop-server.json   {schema:1,pid,port,launchToken,appBundleId}, 0600
 *   POST /api/apps/launch-window           Bearer launchToken → {url,runnerToken,title,state,theme}
 *   GET  /api/apps/running                 {count}: windows that heartbeat in the last 6 s
 *   gateway GET /__dc/enter?code=          one-time code → HttpOnly cookie, 302 to /
 *   gateway POST /__dc/runner/heartbeat    Bearer runnerToken → {rev,lastError,theme,state,command?}
 *   gateway POST /__dc/runner/{stop,start} Bearer runnerToken
 *   gateway POST /__dc/runner/snapshot/:id Bearer runnerToken, PNG or {error}
 *
 * Test controls (dashboard port, no auth, loopback only — a FIXTURE, never shipped):
 *   POST /__fake/rev            bump rev (the runner reloads a visible window)
 *   POST /__fake/theme?t=dark   change theme
 *   POST /__fake/state?s=stopped|running
 *   POST /__fake/snapshot       queue a snapshot command, wait ≤12 s, answer {file|error}
 *   POST /__fake/exit           close both ports, remove the file, exit (server "gone")
 *   GET  /__fake/log            what happened so far
 *
 * Usage: node fake-desktop-server.mjs --home <dir> [--port N] [--gw-port N] [--theme dark]
 *        [--app-bundle-id com.dreamcontext.fakeshell] [--state running] [--shots <dir>]
 *        [--title "Meta Ads"] [--launch-delay-ms N] [--no-file]
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, writeSync, closeSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const HOME = opt('home', process.env.HOME);
const STATE_FILE = join(HOME, '.dreamcontext', 'desktop-server.json');
const SHOTS = opt('shots', join(HOME, 'shots'));
const APP_BUNDLE_ID = opt('app-bundle-id', 'com.dreamcontext.fakeshell');
const LAUNCH_DELAY = Number(opt('launch-delay-ms', '0'));
const launchToken = randomBytes(32).toString('base64url');
const log = [];
const note = (ev, extra = {}) => {
  log.push({ at: Date.now(), ev, ...extra });
  if (log.length > 2000) log.shift();
};

const state = {
  rev: 1,
  theme: opt('theme', 'system'),
  state: opt('state', 'running'),
  title: opt('title', 'Fixture App'),
  codes: new Map(), // code -> expiry
  runnerTokens: new Set(),
  lastBeat: new Map(), // runnerToken -> ms
  pendingSnapshot: null, // {id, resolve}
  beats: 0,
  stops: 0,
  starts: 0,
  pages: 0,
  action: null, // one page action for the page to pick up: download | copy | confirm
};

function readBody(req, limit = 9 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] ?? null;

// ─── The app page the runner shows: every W1 check has a control on it ────────
const PAGE = (rev) => `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>
<style>
:root{--bg:#fff;--fg:#111}
html[data-theme=dark]{--bg:#1b1a22;--fg:#eee}
@media (prefers-color-scheme:dark){html:not([data-theme=light]){--bg:#1b1a22;--fg:#eee}}
body{background:var(--bg);color:var(--fg);font:15px -apple-system,sans-serif;padding:24px}
section{margin:12px 0} textarea,input{font:inherit}
</style></head><body>
<h1 id="h">Fixture app · rev ${rev}</h1>
<p>theme attr: <b id="theme"></b> · prefers dark: <b id="pd"></b></p>
<section><button id="c" onclick="document.getElementById('cr').textContent=String(confirm('Silinsin mi? Ş ğ ü ı ö ç'))">confirm()</button> <span id="cr">—</span></section>
<section><button onclick="document.getElementById('pr').textContent=String(prompt('Adın?','Şule'))">prompt()</button> <span id="pr">—</span></section>
<section><textarea id="tr" rows="2" cols="40">Türkçe: ŞşĞğÜüİıÖöÇç — kopyala bunu</textarea>
<button onclick="dcRunner.copy(document.getElementById('tr').value)">dcRunner.copy</button></section>
<section>Paste here: <input id="paste" size="40" placeholder="⌘V"></section>
<section><input type="file" id="f" onchange="document.getElementById('fn').textContent=this.files[0]&&this.files[0].name"> <span id="fn">—</span></section>
<section><a href="/download">download rapor.csv</a> · <a href="https://example.com/" target="_blank">external link</a></section>
<section>Form survives backend writes: <input id="form" placeholder="type here"></section>
<script>
function t(){document.getElementById('theme').textContent=document.documentElement.getAttribute('data-theme');document.getElementById('pd').textContent=matchMedia('(prefers-color-scheme: dark)').matches}
t();addEventListener('dc-theme',t);matchMedia('(prefers-color-scheme: dark)').addEventListener('change',t);
// Test driver hook: the fixture hands the page one action at a time (no GUI access needed).
setInterval(async function(){try{const r=await fetch('/action');const a=(await r.json()).action;
if(a==='download')location.href='/download';
if(a==='copy')dcRunner.copy(document.getElementById('tr').value);
if(a==='confirm')document.getElementById('cr').textContent=String(confirm('Uzun bir onay: Ş ğ ü'));
}catch(e){}},700);
</script></body></html>`;

// ─── Gateway ──────────────────────────────────────────────────────────────────
const gw = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/__dc/enter') {
    const code = url.searchParams.get('code');
    const exp = code && state.codes.get(code);
    state.codes.delete(code);
    if (!exp || exp < Date.now()) { note('enter-refused'); res.writeHead(403); return res.end('code used or expired'); }
    note('enter');
    res.writeHead(302, { location: '/', 'set-cookie': `dc_gw_${gwPort()}=ok; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    return res.end();
  }
  if (p.startsWith('/__dc/runner/')) {
    const tok = bearer(req);
    if (!tok || !state.runnerTokens.has(tok)) { note('runner-401', { p }); return json(res, 401, { error: 'unauthorized' }); }
    if (req.headers.origin) { note('runner-origin-refused'); return json(res, 403, { error: 'origin' }); }
    if (p === '/__dc/runner/heartbeat') {
      state.beats++;
      state.lastBeat.set(tok, Date.now());
      const out = { rev: state.rev, lastError: null, theme: state.theme, state: state.state };
      if (state.pendingSnapshot && !state.pendingSnapshot.sent) {
        state.pendingSnapshot.sent = true;
        out.command = { id: state.pendingSnapshot.id, type: 'snapshot' };
      }
      return json(res, 200, out);
    }
    if (p === '/__dc/runner/stop') { state.stops++; state.lastBeat.delete(tok); note('stop'); return json(res, 200, { ok: true }); }
    if (p === '/__dc/runner/start') { state.starts++; state.state = 'running'; note('start'); return json(res, 200, { ok: true }); }
    const m = /^\/__dc\/runner\/snapshot\/([A-Za-z0-9_-]+)$/.exec(p);
    if (m) {
      const body = await readBody(req, 8 * 1024 * 1024).catch(() => null);
      const pending = state.pendingSnapshot;
      if (!pending || pending.id !== m[1]) { note('snapshot-unknown-id'); return json(res, 404, { error: 'unknown id' }); }
      state.pendingSnapshot = null;
      if ((req.headers['content-type'] || '').startsWith('image/png') && body) {
        mkdirSync(SHOTS, { recursive: true });
        const file = join(SHOTS, `${m[1]}.png`);
        writeFileSync(file, body, { mode: 0o600 });
        note('snapshot', { file, bytes: body.length });
        pending.resolve({ file, bytes: body.length });
      } else {
        let err = 'snapshot_failed';
        try { err = JSON.parse(String(body)).error; } catch {}
        note('snapshot-error', { err });
        pending.resolve({ error: err });
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'no route' });
  }
  const cookie = req.headers.cookie || '';
  if (!cookie.includes(`dc_gw_${gwPort()}=ok`)) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('no gateway cookie'); }
  if (p === '/action') {
    const a = state.action;
    state.action = null;
    if (a) note('action-taken', { a });
    return json(res, 200, { action: a });
  }
  if (p === '/download') {
    note('download');
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="rapor.csv"' });
    return res.end('kampanya,durum\nŞubat,aktif\n');
  }
  if (p === '/' || p === '/index.html') {
    state.pages++;
    note('page', { rev: state.rev });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PAGE(state.rev));
  }
  res.writeHead(404);
  res.end();
});

// ─── Dashboard side ───────────────────────────────────────────────────────────
const dash = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/api/apps/launch-window' && req.method === 'POST') {
    if (bearer(req) !== launchToken) { note('launch-401'); return json(res, 401, { error: 'unauthorized' }); }
    const body = JSON.parse(String(await readBody(req)) || '{}');
    note('launch-window', { slug: body.slug });
    if (LAUNCH_DELAY) await new Promise((r) => setTimeout(r, LAUNCH_DELAY));
    const code = randomBytes(32).toString('base64url');
    state.codes.set(code, Date.now() + 60_000);
    const runnerToken = randomBytes(32).toString('base64url');
    state.runnerTokens.add(runnerToken);
    return json(res, 200, { url: `http://127.0.0.1:${gwPort()}/__dc/enter?code=${code}`, runnerToken, title: state.title, state: state.state, theme: state.theme });
  }
  if (p === '/api/apps/running') {
    const now = Date.now();
    const count = [...state.lastBeat.values()].filter((t) => now - t < 6000).length;
    return json(res, 200, { count });
  }
  if (p === '/__fake/rev') { state.rev++; note('rev', { rev: state.rev }); return json(res, 200, { rev: state.rev }); }
  if (p === '/__fake/theme') { state.theme = url.searchParams.get('t') || 'system'; note('theme', { theme: state.theme }); return json(res, 200, { theme: state.theme }); }
  if (p === '/__fake/state') { state.state = url.searchParams.get('s') || 'running'; note('state', { state: state.state }); return json(res, 200, { state: state.state }); }
  if (p === '/__fake/snapshot') {
    const id = randomBytes(16).toString('base64url');
    const result = await new Promise((resolve) => {
      state.pendingSnapshot = { id, sent: false, resolve };
      setTimeout(() => resolve({ error: 'snapshot_timeout' }), 12_000);
    });
    state.pendingSnapshot = null;
    return json(res, 200, result);
  }
  if (p === '/__fake/action') { state.action = url.searchParams.get('a'); note('action', { a: state.action }); return json(res, 200, { action: state.action }); }
  if (p === '/__fake/log') return json(res, 200, { beats: state.beats, stops: state.stops, starts: state.starts, pages: state.pages, rev: state.rev, theme: state.theme, state: state.state, log });
  if (p === '/__fake/exit') {
    json(res, 200, { ok: true });
    setTimeout(() => shutdown(), 50);
    return;
  }
  if (p === '/api/health') return json(res, 200, { ok: true });
  json(res, 404, { error: 'No route' });
});

const gwPort = () => gw.address()?.port;

function writeStateFile(port) {
  if (flag('no-file')) return;
  const dir = join(HOME, '.dreamcontext');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.desktop-server.json.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  writeSync(fd, JSON.stringify({ schema: 1, pid: process.pid, port, launchToken, appBundleId: APP_BUNDLE_ID }) + '\n');
  closeSync(fd);
  renameSync(tmp, STATE_FILE);
}

function shutdown() {
  try {
    const cur = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf-8')) : null;
    if (cur && cur.pid === process.pid) rmSync(STATE_FILE, { force: true });
  } catch {}
  gw.closeAllConnections?.();
  dash.closeAllConnections?.();
  gw.close();
  dash.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

gw.listen(Number(opt('gw-port', '0')), '127.0.0.1', () => {
  dash.listen(Number(opt('port', '0')), '127.0.0.1', () => {
    const port = dash.address().port;
    writeStateFile(port);
    console.log(JSON.stringify({ ready: true, port, gwPort: gwPort(), stateFile: STATE_FILE, pid: process.pid }));
  });
});
