#!/usr/bin/env node
/**
 * The Super stage on a REMOTE computer is as alive as on the Mac (owner 2026-10-29, hands-free on
 * another computer): every child card read "CHAT · Child chat 53 · saved" and the Super's chat
 * carried a stale "On the Mac's stage now" strip of pictures long gone from the stage.
 *
 *   npm run build && node scripts/verify/handsfree-super-stage-live.mjs
 *   (OUT=<dir> LABEL=before|after to name the screenshots; DC_CLI=<dist/index.js> for another build)
 *
 * WHAT IT DRIVES: the real dashboard server on a scratch HOME, the Mac WINDOW as a real Chromium
 * page on the loopback listener (it hands over and holds every child, as on the Mac), a scripted
 * stand-in `claude` (no tokens; everything fictional, "Pocket Ledger"), and a REAL Cloudflare quick
 * tunnel the remote computer reaches through a CONNECT proxy, as the owner's other computer does.
 *
 * The Super opens two pictures on hand-over and delegates three jobs: one keeps working (HOLD),
 * one asks a question (ASK), one finishes at once (QUICK). Then the remote computer signs in
 * through the tunnel.
 *
 * CHECKS: on the remote stage each child card carries its job's NAME (never "Child chat N") and its
 * live state (working / asking / done), as the Mac draws them; a job that starts again turns
 * "working" on the remote within seconds (no reload); the Super's chat on the remote shows no
 * "On the Mac's stage" strip (the stage itself shows the pictures); the full brief beyond the
 * name never reaches the remote page; no console error.
 * Screenshots: $OUT/<label>-mac-1440.png, <label>-remote-1440.png, <label>-remote-1440-live.png.
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-super-stage-live-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');
const OUT = process.env.OUT || join(REPO, 'tmp', 'verify-super-stage-live');
const LABEL = process.env.LABEL || 'after';
const TOKEN_FILE = join(SCRATCH, 'super-env.json');
const POWER_LOG = join(SCRATCH, 'power.log');
const PICS = ['mockups/checkout.png', 'mockups/receipts.png'];
// The tail a name never carries: a brief longer than the 80-character name.
const TAIL = 'TAIL-NEVER-REMOTE';
const JOBS = [
  { key: 'hold', prompt: 'HOLD Fix the coupon field on checkout.', brief: 'Checkout coupon field fix' },
  { key: 'ask', prompt: 'ASK Which currency should receipts use?', brief: 'Receipt currency question' },
  { key: 'quick', prompt: 'QUICK Export receipts as CSV.', brief: `Receipts CSV export, then check every column and its header against the old export ${TAIL}` },
];

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || ('verify-' + role + '-' + process.pid);
const cli = (...args) => spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
let busy = false;
let buf = '';
const finish = (said) => {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  busy = false;
};
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user' || busy) continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    const text = blocks.join('\\n');
    busy = true;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    if (role === 'super') {
      if (blocks.some((b) => b.startsWith('[super handover]'))) {
        writeFileSync(${JSON.stringify(TOKEN_FILE)}, JSON.stringify({ url: process.env.DREAMCONTEXT_WINDOW_URL, token: process.env.DREAMCONTEXT_WINDOW_TOKEN }));
        for (const pic of ${JSON.stringify(PICS)}) cli('super', 'open', 'image', pic, '--no-group');
      }
      finish('Two jobs run, one is done.');
      continue;
    }
    if (text.includes('ASK')) {
      out({ type: 'control_request', request_id: 'ask-' + Date.now(), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which currency?', header: 'Currency', multiSelect: false, options: [{ label: 'EUR', description: 'euro' }, { label: 'USD', description: 'dollar' }] }] } } });
      continue;
    }
    if (text.includes('HOLD')) {
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-' + Date.now(), name: 'Bash', input: { command: 'npm test' } }] } });
      continue;
    }
    finish('Exported 12 receipts to receipts.csv.');
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(250); }
  return false;
};
let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 700)}` : ''}`); }
  return !!cond;
};

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext', 'bin'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, 'mockups'), OUT]) mkdirSync(d, { recursive: true });
  chmodSync(join(HOME, '.dreamcontext', 'bin'), 0o700);
  // The Mac's own pinned cloudflared (its sha256 is checked again by the server).
  const real = join(homedir(), '.dreamcontext', 'bin');
  const bin = existsSync(real) ? readdirSync(real).find((f) => /^cloudflared-\d/.test(f)) : null;
  if (!bin) throw new Error('no pinned cloudflared in ~/.dreamcontext/bin: set up Mac mode once on this machine');
  copyFileSync(join(real, bin), join(HOME, '.dreamcontext', 'bin', bin));
  chmodSync(join(HOME, '.dreamcontext', 'bin', bin), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, titleMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  spawnSync(process.execPath, [CLI, 'init', '-y', '--name', 'pocket-ledger', '--description', 'A fictional ledger app for the remote-stage check'], { cwd: PROJ, env: env(), encoding: 'utf-8' });
  const claude = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(claude, STANDIN);
  chmodSync(claude, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  copyFileSync(join(REPO, 'public', 'image', 'diagram-loop.png'), join(PROJ, PICS[0]));
  copyFileSync(join(REPO, 'public', 'image', 'diagram-memory.png'), join(PROJ, PICS[1]));
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...env(), PATH, DREAMCONTEXT_MAC_VERIFY_POWER_LOG: POWER_LOG }, stdio: ['ignore', 'pipe', 'pipe'],
  });
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
async function go(page, target) {
  try { return await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 }); }
  catch (err) {
    if (!/ERR_EMPTY_RESPONSE|ERR_CONNECTION|ERR_TIMED_OUT|ERR_TUNNEL|ERR_NAME/.test(String(err))) throw err;
    await sleep(3000);
    return page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
}

const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [], children: {} }; } };
const superCli = (...args) => {
  const e = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  const r = spawnSync(process.execPath, [CLI, 'super', ...args], { cwd: PROJ, env: { ...env(), DREAMCONTEXT_WINDOW_URL: e.url, DREAMCONTEXT_WINDOW_TOKEN: e.token }, encoding: 'utf-8', timeout: 90_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, json };
};

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

/** The What's New popup over a fresh profile: closed, so the screenshot shows the stage. */
const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
};
/** Each child card as the stage draws it: its name and its state. */
const cards = (page, ids) => page.evaluate((list) => list.map((id) => {
  const el = document.querySelector(`.super-card-frame[data-container-id="${id}"]`);
  if (!el) return { id, missing: true };
  return {
    id,
    title: el.querySelector('.super-tile-title, .super-card-brief')?.textContent ?? '',
    kind: el.querySelector('[data-testid="super-tile-status"], .super-card-dot')?.getAttribute('data-kind') ?? '',
    text: (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 160),
  };
}), ids);
const strips = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="stage-media-strip"]')]
  .filter((e) => e.getBoundingClientRect().height > 0).map((e) => (e.textContent ?? '').slice(0, 60)));

let server = null;
let browser = null;
let remoteBrowser = null;
let proxy = null;
let port = 0;
const errors = [];
try {
  const { chromium } = await import('@playwright/test');
  console.log(`· build: ${CLI}  label: ${LABEL}`);
  setupScratch();
  port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  const macCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const macPage = await macCtx.newPage();
  macPage.on('console', (m) => { if (m.type() === 'error') errors.push(`mac: ${m.text().slice(0, 200)}`); });
  macPage.on('pageerror', (e) => errors.push(`mac pageerror: ${String(e).slice(0, 200)}`));

  console.log('\n── the Mac window hands over; the Super opens two pictures and delegates three jobs');
  await openChat(macPage, base);
  if (!(await macPage.locator('.chat-cmp-input:visible').count())) await macPage.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens on the Mac', await until(async () => (await macPage.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await macPage.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the Mac draws the Super stage', await until(async () => (await macPage.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the Super opened two pictures', await until(async () => existsSync(TOKEN_FILE) && record().containers.filter((c) => c.kind === 'image').length === 2, 60000));
  const kids = {};
  for (const j of JOBS) {
    const d = superCli('delegate', '--prompt', j.prompt, '--brief', j.brief);
    kids[j.key] = { sid: d.json?.sessionId, card: d.json?.container };
    ok(`delegate ${j.key}`, d.status === 0 && !!d.json?.sessionId, d.out);
  }
  const rowOf = (k) => record().children?.[kids[k].sid]?.row;
  ok('the rows reach working / asking / done', await until(async () => rowOf('hold') === 'working' && rowOf('ask') === 'asking' && rowOf('quick') === 'done', 45000),
    JSON.stringify(Object.fromEntries(Object.keys(kids).map((k) => [k, rowOf(k)]))));
  const ids = JOBS.map((j) => kids[j.key].card);
  await macPage.waitForTimeout(2500);
  await dismiss(macPage);
  const onMac = await cards(macPage, ids);
  console.log(`  · Mac cards: ${JSON.stringify(onMac.map((c) => [c.title, c.kind]))}`);
  ok('the Mac draws the three jobs working / asking / done', onMac[0].kind === 'working' && onMac[1].kind === 'asking' && onMac[2].kind === 'ready', JSON.stringify(onMac));
  await macPage.screenshot({ path: join(OUT, `${LABEL}-mac-1440.png`) });

  console.log('\n── Mac mode over a REAL quick tunnel; the other computer signs in');
  const setup = await mac(port, 'POST', 'setup', {});
  ok('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));
  proxy = await startProxy();
  const started = await mac(port, 'POST', 'start', { vaults: ['pocket-ledger'] });
  const url = started.json.url;
  ok('Mac mode starts over a real quick tunnel', started.status === 200 && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com/.test(url ?? ''), JSON.stringify(started.json).slice(0, 220));
  remoteBrowser = await chromium.launch({ proxy: { server: proxy.url } });
  const qr = (await mac(port, 'POST', 'qr')).json.url;
  const rCtx = await remoteBrowser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const remote = await rCtx.newPage();
  remote.on('console', (m) => { if (m.type() === 'error') errors.push(`remote: ${m.text().slice(0, 200)}`); });
  remote.on('pageerror', (e) => errors.push(`remote pageerror: ${String(e).slice(0, 200)}`));
  await go(remote, qr);
  const stageUp = async () => (await remote.locator('[data-testid="super-surface"]:visible').count()) > 0;
  if (!(await until(stageUp, 25000))) {
    await remote.locator('.project-tabs-add').click().catch(() => {});
    await remote.locator('.psw-row', { hasText: 'pocket-ledger' }).first().click().catch(() => {});
  }
  ok('the remote computer draws the Super stage', await until(stageUp, 40000));
  // Every card drawn, the Super's chat replayed.
  await until(async () => (await cards(remote, ids)).every((c) => !c.missing), 20000);
  await remote.waitForTimeout(4000);
  await dismiss(remote);
  const onRemote = await cards(remote, ids);
  console.log(`  · remote cards: ${JSON.stringify(onRemote.map((c) => [c.title, c.kind]))}`);
  await remote.screenshot({ path: join(OUT, `${LABEL}-remote-1440.png`) });
  ok('remote: no card is named "Child chat N"', onRemote.every((c) => !/Child chat \d|Alt sohbet \d/.test(c.title)), JSON.stringify(onRemote));
  ok('remote: each card carries its job\'s name, as on the Mac', onRemote.every((c, i) => c.title && onMac[i].title.startsWith(c.title.replace(/…$/, '').slice(0, 20))), JSON.stringify({ onMac: onMac.map((c) => c.title), onRemote: onRemote.map((c) => c.title) }));
  ok('remote: the states match the Mac (working / asking / done), not "saved"', onRemote.map((c) => c.kind).join() === onMac.map((c) => c.kind).join(), JSON.stringify({ mac: onMac.map((c) => c.kind), remote: onRemote.map((c) => c.kind) }));
  const strip = await strips(remote);
  ok('remote: the Super\'s chat carries no "On the Mac\'s stage" strip (the stage shows the pictures)', strip.length === 0, JSON.stringify(strip));
  const body = await remote.evaluate(() => document.body.innerText);
  ok('remote: the brief beyond the name never reaches the page', !body.includes(TAIL));

  console.log('\n── alive: the finished job starts again; the remote card turns working without a reload');
  const s = superCli('send', kids.quick.sid, 'HOLD one more column');
  ok('super send woke the finished job', s.status === 0, s.out);
  const t0 = Date.now();
  const turned = await until(async () => (await cards(remote, [kids.quick.card]))[0].kind === 'working', 20000);
  ok(`remote: the card turned working (${((Date.now() - t0) / 1000).toFixed(1)} s)`, turned, JSON.stringify(await cards(remote, [kids.quick.card])));
  await remote.screenshot({ path: join(OUT, `${LABEL}-remote-1440-live.png`) });
  await macPage.screenshot({ path: join(OUT, `${LABEL}-mac-1440-live.png`) });

  ok('no console error on either screen', errors.length === 0, errors.join('\n'));
} catch (err) {
  fails.push(`crashed: ${err?.stack || err}`);
  console.log(`  ✗ crashed: ${err?.stack || err}`);
} finally {
  if (port) await mac(port, 'POST', 'stop').catch(() => {});
  await remoteBrowser?.close().catch(() => {});
  await browser?.close().catch(() => {});
  proxy?.close();
  server?.kill();
}
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(0);
