#!/usr/bin/env node
/**
 * Hands-free: the phone's Açık list holds only what the Mac runs, and opening the phone starts
 * nothing on the Mac.
 *
 *   npm run build && node scripts/verify/handsfree-phone-restore.mjs [--local]
 *
 * THE BUG (owner, 2026-10-17, from the phone: "mac'te açık olmayan sessionları da açık gibi
 * gösteriyor"): the phone's stored roster held every chat it had ever opened, and the restore
 * `--resume`d each one, so opening the phone started six `claude` processes on the Mac in four
 * seconds and listed them all under Açık.
 *
 * WHAT IT DRIVES: the real dashboard server (scratch HOME, a `claude` stand-in that logs every
 * spawn), a project whose phone roster stores three chats: two that run nowhere and one a laptop
 * socket started and dropped (detached, still running). Then a Chromium phone (390x844, touch)
 * signed in through Mac mode's real quick tunnel with the one-time QR link. `--local`: the main
 * listener dressed as the phone surface (no tunnel); the client code under test is the same.
 *
 * CHECKS: no spawn while the phone opens; the Mac still runs exactly the one chat; Açık reads 1
 * and lists only it; both stopped chats are under Kapalı; a Kapalı tap still resumes one (one
 * spawn, then); the stored roster no longer holds the stopped chats. Then the Mac does not answer
 * live-chats: nothing starts, and a save keeps the stored tabs it could not judge.
 *
 * `DC_CLI=<dist/index.js>` runs another build (the pre-fix one must fail the spawn checks).
 * FAILURE POLICY: collect, don't fail fast; exit 0 iff every check passed.
 * Screenshots: tmp/verify-handsfree-phone-restore/*.png
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
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-phone-restore');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const POWER_LOG = join(SCRATCH, 'power.log');
const SPAWNS = join(HOME, 'spawns.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-phone-restore');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');
const LOCAL = process.argv.includes('--local');

const STANDIN = `#!${process.execPath}
/** Inert stand-in for \`claude -p --input-format stream-json\` that logs every spawn. */
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
fs.appendFileSync(path.join(process.env.HOME, 'spawns.log'), JSON.stringify({ pid: process.pid, sid, resume: !!at('--resume') }) + '\\n');
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
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
const spawns = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The three stored chats: two that run nowhere, one the laptop starts and drops. */
const OLD1 = crypto.randomUUID();
const OLD2 = crypto.randomUUID();
const LIVE = crypto.randomUUID();
const TITLES = { [OLD1]: 'Yesterday webhooks cleanup', [OLD2]: 'Yesterday invoice export', [LIVE]: 'Running release notes' };

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const tdir = join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the phone restore check']);
  const r = cli(['vaults', 'add', 'proj', PROJ]);
  if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
  // Each stored chat has a transcript (the old ones from yesterday), so Kapalı can list it.
  const yesterday = Date.now() - 22 * 3600_000;
  for (const [i, id] of [OLD1, OLD2, LIVE].entries()) {
    const ts = new Date(yesterday + i * 60_000).toISOString();
    const rows = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: TITLES[id] }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done: ${TITLES[id]}` }] } },
    ].map((o) => JSON.stringify({ ...o, cwd: PROJ, uuid: crypto.randomUUID(), timestamp: ts, sessionId: id }));
    writeFileSync(join(tdir, `${id}.jsonl`), `${rows.join('\n')}\n`);
  }
  // The roster both screens would read: the phone's own (tunnel run) and the desktop's (--local).
  const roster = {
    sessions: [OLD1, OLD2, LIVE].map((id) => ({ title: TITLES[id], bypass: false, minimized: false, size: 1, sessionId: id, kind: 'chat', pane: 0, ...(id === LIVE ? { active: true } : {}) })),
    activePane: 0,
  };
  for (const f of ['.agent-sessions.json', '.agent-sessions.phone.json']) writeFileSync(join(PROJ, '_dream_context', 'state', f), JSON.stringify(roster, null, 2));
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

const liveIds = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/agent/live-chats`, { headers: { 'x-dreamcontext-vault': 'proj' } });
  const j = await r.json();
  return (j.chats ?? []).map((c) => c.conversationId);
};

let server = null;
let browser = null;
let phoneBrowser = null;
let proxy = null;
let port = 0;
const errors = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  console.log(`· build: ${CLI}`);
  console.log(`· scratch vault, server${LOCAL ? ' (--local: main listener, no tunnel)' : ', Mac mode over a real quick tunnel'}…`);
  setupScratch();
  port = await freePort();
  server = await startServer(port);
  const setup = await mac(port, 'POST', 'setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));

  // The one chat the Mac runs: a laptop socket opens it, then drops (no close frame), so the
  // child keeps running detached, the way a chat outlives a phone that left.
  const { WebSocket: NodeWs } = await import('ws');
  const laptop = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&resume=${LIVE}`);
  laptop.on('error', () => {});
  await new Promise((r) => laptop.on('open', r));
  laptop.send(JSON.stringify({ type: 'user', text: 'draft the notes' }));
  report.check('the laptop started the one running chat', await until(() => spawns().length === 1, 15000), JSON.stringify(spawns()));
  await sleep(800);
  laptop.terminate();
  report.check('it keeps running detached on the Mac (live-chats lists it alone)', await until(async () => JSON.stringify(await liveIds(port)) === JSON.stringify([LIVE]), 10000), JSON.stringify(await liveIds(port).catch(() => [])));
  const before = spawns().length;

  let entry;
  if (!LOCAL) {
    proxy = await startProxy();
    phoneBrowser = await chromium.launch({ proxy: { server: proxy.url } });
    const started = await mac(port, 'POST', 'start', { vaults: ['proj'] });
    report.check('Mac mode starts for the project', started.status === 200 && !!started.json.url, JSON.stringify(started.json).slice(0, 200));
    entry = (await mac(port, 'POST', 'qr')).json.url;
  } else {
    browser = await chromium.launch();
    phoneBrowser = browser;
    entry = `http://127.0.0.1:${port}/?vault=proj`;
  }
  const ctx = await phoneBrowser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  if (LOCAL) await ctx.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive' || document.querySelector('meta[name="dreamcontext-surface"]')) return;
      const m = document.createElement('meta'); m.name = 'dreamcontext-surface'; m.content = 'mac'; document.head.appendChild(m);
    });
  });
  const phone = await ctx.newPage();
  phone.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  phone.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  await phone.goto(entry, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('signed in, landed in the project', await until(async () => phone.url().includes('vault=proj'), 25000), phone.url());
  report.check('the phone opens on the Sohbetler list', await until(async () => (await phone.locator('[data-testid="phone-list"]:visible').count()) === 1, 25000));
  // The restore runs once the roster arrives; give it ample time to spawn, if it were going to.
  await phone.waitForTimeout(6000);
  for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }

  const after = spawns().slice(before);
  report.check('opening the phone started NO claude on the Mac', after.length === 0, JSON.stringify(after.map((s) => TITLES[s.sid] ?? s.sid)));
  report.check('the Mac still runs exactly the one chat', JSON.stringify(await liveIds(port)) === JSON.stringify([LIVE]), JSON.stringify(await liveIds(port)));

  const view = () => phone.evaluate(() => {
    const el = document.querySelector('[data-testid="phone-list"]');
    // A tab row's data-id is its tab, not its conversation: rows are told apart by their title.
    const rows = (sel) => [...(el?.querySelectorAll(sel) ?? [])].map((r) => ({ id: r.getAttribute('data-id'), kind: r.getAttribute('data-kind'), text: (r.textContent ?? '').replace(/\s+/g, ' ').trim() }));
    return {
      open: rows('[data-testid="list-tab-row"], [data-testid="mac-live-row"]'),
      past: rows('[data-testid="past-row"]'),
      chip: (el?.querySelector('[data-testid="list-filter-open"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
  let v = await view();
  report.check(`Açık holds only the running chat (${v.chip})`, await until(async () => {
    v = await view();
    return v.open.length === 1 && v.open[0].text.includes(TITLES[LIVE]) && /\b1\b/.test(v.chip);
  }, 10000), JSON.stringify(v));
  report.check('both stopped chats are under Kapalı, the running one is not', await until(async () => {
    v = await view();
    const past = v.past.map((p) => p.id);
    return past.includes(OLD1) && past.includes(OLD2) && !past.includes(LIVE);
  }, 15000), JSON.stringify(v));
  await phone.screenshot({ path: join(SHOTS, '390x844-list.png') });

  // The stored roster forgets the stopped chats once the phone saves its tabs (it does on any change).
  const rosterFile = join(PROJ, '_dream_context', 'state', LOCAL ? '.agent-sessions.json' : '.agent-sessions.phone.json');
  // A Kapalı tap still resumes a stopped chat: one spawn, for that chat only.
  await phone.locator(`[data-testid="past-row"][data-id="${OLD1}"]`).click();
  report.check('a Kapalı tap resumes that chat: exactly one spawn, for it', await until(() => {
    const s = spawns().slice(before);
    return s.length === 1 && s[0].sid === OLD1 && s[0].resume;
  }, 15000), JSON.stringify(spawns().slice(before)));
  await phone.waitForTimeout(2500);
  await phone.screenshot({ path: join(SHOTS, '390x844-resumed.png') });
  const stored = (() => { try { return JSON.parse(readFileSync(rosterFile, 'utf-8')).sessions.map((m) => m.sessionId); } catch { return null; } })();
  report.check('the stored roster holds the running chat and the resumed one, not the other stopped one', !!stored && stored.includes(LIVE) && stored.includes(OLD1) && !stored.includes(OLD2), JSON.stringify(stored));

  // --local: the main listener serves no phone service worker, so its registration 404s.
  const errs = errors.filter((e) => !/__TAURI|status of 401/.test(e) && !(LOCAL && /404/.test(e)));
  report.check('no console errors on the phone', errs.length === 0, errs.slice(0, 8).join('\n      '));

  // Review r1 (edge-cases): the Mac does not answer live-chats (a tunnel 502). The phone restores
  // nothing and starts nothing, and its next save still keeps the stored tabs it could not judge.
  // The fetch is failed inside the page: the app's service worker hides requests from routes.
  const home = phone.url();
  await phone.close();
  await ctx.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      return url.includes('/api/agent/live-chats') ? Promise.resolve(new Response('bad gateway', { status: 502 })) : real(input, init);
    };
  });
  const before2 = spawns().length;
  const phone2 = await ctx.newPage();
  await phone2.goto(home, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('Mac unreachable: the phone opens on the list', await until(async () => (await phone2.locator('[data-testid="phone-list"]:visible').count()) === 1, 25000));
  await phone2.waitForTimeout(5000);
  for (let i = 0; i < 3; i++) { const x = phone2.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone2.waitForTimeout(300); }
  report.check('Mac unreachable: opening the phone started NO claude', spawns().length === before2, JSON.stringify(spawns().slice(before2)));
  await phone2.locator('[data-testid="list-new"]').click();
  report.check('Mac unreachable: "New chat" still opens one chat', await until(() => spawns().length === before2 + 1, 15000), JSON.stringify(spawns().slice(before2)));
  const fresh = spawns()[before2]?.sid;
  let stored2 = null;
  report.check('Mac unreachable: the save keeps the stored tabs it could not judge, beside the new chat', await until(() => {
    try { stored2 = JSON.parse(readFileSync(rosterFile, 'utf-8')).sessions.map((m) => m.sessionId); } catch { stored2 = null; }
    return !!stored2 && !!fresh && stored2.includes(fresh) && stored2.includes(LIVE) && stored2.includes(OLD1);
  }, 10000), JSON.stringify({ stored2, fresh }));
  await phone2.screenshot({ path: join(SHOTS, '390x844-mac-unreachable.png') });
  console.log(`\n  screenshots: ${SHOTS}`);
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  try { if (phoneBrowser !== browser) await phoneBrowser?.close(); } catch { /* gone */ }
  try { proxy?.close(); } catch { /* gone */ }
  if (port) { try { await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/stop`, { method: 'POST' }); } catch { /* gone */ } }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
if (report.fails.length) { for (const f of report.fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
