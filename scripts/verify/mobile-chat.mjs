#!/usr/bin/env node
/**
 * A TOUCH PHONE ON THE LAPTOP LISTENER (the tailnet phone) opens the new shell (task hands-free-
 * nin-ayri-telefon-arayuzu-kalkar…, W2, criterion 16). Before W2 it got the classic phone layout
 * (the session drawer this script used to drive, deleted with the Sohbetler list).
 *
 *   npm run build && node scripts/verify/mobile-chat.mjs
 *
 * WHAT IT DRIVES: the real dashboard server bound to 0.0.0.0 with remote access on
 * (DREAMCONTEXT_REMOTE=1), scratch HOME, two projects, past chats in one, a `claude` stand-in.
 * A Chromium iPhone 13 (390x844, touch) signs in with the tokenized URL the server prints, on a
 * NON-LOOPBACK address of this machine: a tailnet address (100.64.0.0/10) when one exists or
 * TAILNET_IP names one (the chat socket answers only a tailnet peer), else a LAN address (then
 * the chat checks cannot pass and say so).
 *
 * CHECKS: the page is a phone (narrow AND coarse); the new shell in the phone layout with the
 * drawer open on the first screen; no Hands-free button and no Mac chip; New chat starts a chat of
 * its own, which is a drawer row; Past chats opens History with this project's past chats; the
 * whole session makes no POST to /api/launcher/ui-settings and no /api/agent/live-chats read; no
 * sideways overflow; no console error. Screenshots: tmp/mobile-chat/*.png
 *
 * FAILURE POLICY: collect, don't fail fast. Exit 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { drawerShown, newChat, projRow } from './lib/phone-shell.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-mobile-chat');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const PROJ2 = join(SCRATCH, 'proj2');
const SHOT_DIR = process.env.SHOT_DIR || join(REPO, 'tmp', 'mobile-chat');

const PAST = ['Fix the login redirect loop', 'Rename the payout column'];
const PAST_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
};

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { out({}); process.exit(0); }
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'verify-session-' + process.pid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ECHO from the tailnet phone' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-session-' + process.pid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '0.0.0.0', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const isTailnet = (a) => { const m = /^100\.(\d+)\./.exec(a); return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127; };
function phoneAddress() {
  if (process.env.TAILNET_IP) return process.env.TAILNET_IP;
  const v4 = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.address.startsWith('127.'));
  return (v4.find((i) => isTailnet(i.address)) ?? v4.find((i) => !i.internal))?.address ?? null;
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false, renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto',
  }, null, 2)}\n`);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [name, path] of [['proj', PROJ], ['proj2', PROJ2]]) {
    mkdirSync(join(path, '_dream_context', 'state'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: path });
    const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', name, path], { env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (add.status !== 0) throw new Error(`vaults add ${name} failed: ${add.stderr || add.stdout}`);
  }
  const projectsDir = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectsDir, { recursive: true });
  PAST.forEach((title, i) => {
    const when = new Date(Date.now() - (i + 1) * 3_600_000).toISOString();
    const line = JSON.stringify({ type: 'user', cwd: PROJ, gitBranch: 'main', sessionId: PAST_IDS[i], timestamp: when, message: { role: 'user', content: title } });
    writeFileSync(join(projectsDir, `${PAST_IDS[i]}.jsonl`), `${line}\n`);
  });
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '--host', '0.0.0.0', '-p', String(port)], {
    cwd: PROJ,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_REMOTE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += String(d); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const token = /\?token=([A-Za-z0-9_-]+)/.exec(out)?.[1];
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok && token) return { srv, token }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`dashboard server did not come up with a token URL: ${out.slice(0, 300)}`);
}

let server;
let browser;
try {
  setupScratch();
  const port = await freePort();
  const up = await startServer(port);
  server = up.srv;
  const addr = phoneAddress();
  check('a non-loopback address of this machine to sign in on', !!addr, String(addr));
  const tailnet = !!addr && isTailnet(addr);
  console.log(`· phone address ${addr} (${tailnet ? 'tailnet' : 'LAN: the chat socket will refuse it'})`);
  const base = `http://${addr}:${port}`;

  browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = []; const uiPosts = []; const liveReads = []; const sockets = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/launcher/ui-settings' && r.method() !== 'GET') uiPosts.push(`${r.method()} ${u.pathname}`);
    if (u.pathname === '/api/agent/live-chats') liveReads.push(u.pathname);
  });
  page.on('websocket', (w) => sockets.push(w.url()));
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const shot = async (name) => { const p = join(SHOT_DIR, `${name}.png`); await page.screenshot({ path: p }); console.log(`      shot: ${p}`); };

  await page.goto(`${base}/?token=${up.token}`, { waitUntil: 'domcontentloaded' });
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const gotIt = page.getByRole('button', { name: /^Got it$/ });
  if (await gotIt.count()) { await gotIt.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }

  const mq = await page.evaluate(() => ({ narrow: matchMedia('(max-width: 768px)').matches, coarse: matchMedia('(pointer: coarse)').matches, host: location.hostname }));
  check('the page is a phone (narrow AND coarse) on a non-loopback address', mq.narrow && mq.coarse && mq.host === addr, JSON.stringify(mq));
  const shell = () => page.evaluate(() => ({
    shell: document.querySelector('.window-chrome')?.getAttribute('data-shell') ?? null,
    phone: document.body.dataset.phone ?? null,
    hf: [...document.querySelectorAll('[data-testid="hf-button"]')].some((e) => e.getBoundingClientRect().width > 0),
    chip: !!document.querySelector('[data-testid="ns-phone-chip"]'),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  check('the new shell in the phone layout', await until(async () => { const s = await shell(); return s.shell === 'new' && s.phone === 'true'; }, 20000), JSON.stringify(await shell()));
  check('the drawer is open on the first screen', await until(() => drawerShown(page), 10000));
  const s0 = await shell();
  check('no Hands-free button, no Mac chip (this is the laptop listener, not the tunnel)', !s0.hf && !s0.chip, JSON.stringify(s0));
  check('no sideways overflow', s0.overflow <= 1, String(s0.overflow));
  await shot('01-first-screen');

  // Its own chat: New chat starts one, and it is a drawer row.
  await newChat(page, 'proj');
  const live = await until(async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 20000);
  check(`New chat starts a chat of its own${tailnet ? '' : ' (needs a tailnet address)'}`, live && sockets.some((u) => u.includes('/api/agent/chat')), JSON.stringify(sockets));
  if (live) {
    const box = page.locator('.chat-cmp-input:visible').first();
    await box.click(); await box.fill('hello from the tailnet'); await page.keyboard.press('Enter');
  }
  const answered = await until(async () => (await page.locator('.chat-pane:visible').first().innerText().catch(() => '')).includes('ECHO from the tailnet phone'), 20000);
  check('…and it answers', answered);
  await shot('02-own-chat');
  await page.getByTestId('ns-drawer-toggle').click();
  check('its chat is a drawer row', await until(async () => (await projRow(page, 'proj').locator('[data-testid="drawer-chat-row"]').count()) >= 1, 10000));

  // Past chats opens History with this project's past chats.
  await page.getByTestId('drawer-history').click();
  check('Past chats opens History with the project\'s past chats', await until(async () => (await page.locator('.chp-row', { hasText: PAST[0] }).count()) > 0 && (await page.locator('.chp-row', { hasText: PAST[1] }).count()) > 0, 15000));
  await shot('03-history');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(3000);

  check('no POST to /api/launcher/ui-settings over the whole session', uiPosts.length === 0, JSON.stringify(uiPosts));
  check('no /api/agent/live-chats read over the whole session', liveReads.length === 0, String(liveReads.length));
  check('no console errors', errors.length === 0, errors.slice(0, 6).join(' | '));
} catch (err) {
  check('the run completed', false, String(err?.stack ?? err));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
