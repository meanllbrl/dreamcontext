#!/usr/bin/env node
/**
 * The `mcp` card a Super child sends for a claude.ai connector by its short name (owner
 * 2026-11-14: a child's card `servers: ["notion", "playwright"]` said "reading this chat's
 * servers…" on both rows forever, with no button but "Continue without").
 *
 *   npm run build && node scripts/verify/chat-mcp-connector.mjs
 *
 * WHAT THIS PROVES, against the real server and a real Chromium, at 1440 and 390 px:
 *   §1  the chat's own server list never answers: within ~10 s every row stops "reading…" and
 *       says what Settings → MCP knows (Notion: a claude.ai connector, sign-in on claude.ai, with
 *       its claude.ai button; playwright: not set up), and the card offers Retry
 *   §2  Retry once the list answers: `notion` is matched to the live `claude.ai Notion` row, its
 *       state and Reconnect are drawn; nothing is left "reading…"
 *   §3  no console error
 * Screenshots: tmp/mcp-connector-shots/ in the worktree.
 *
 * The `claude` on the server's PATH is a scripted stand-in (no tokens, scratch HOME only): its
 * first turn sends the card; it answers `mcp_status` only once the flag file exists.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-mcp-connector');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const FLAG = join(SCRATCH, 'answer-status');
const SHOTS = join(REPO, 'tmp', 'mcp-connector-shots');

const STANDIN = `#!${process.execPath}
const fs = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const CARD = ['I need Notion and the browser for this.', '',
  '\\u0060\\u0060\\u0060dream-view',
  JSON.stringify({ type: 'mcp', id: 'debt-notion', why: 'the debt page lives in Notion', servers: ['notion', 'playwright'] }),
  '\\u0060\\u0060\\u0060'].join('\\n');
let turn = 0;
function runTurn(text) {
  turn++;
  out({ type: 'system', subtype: 'init', session_id: 'verify-conn-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [], apiKeySource: 'none' });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: turn === 1 ? CARD : 'CONTINUED [' + text + ']' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-conn-session' });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      const sub = o.request && o.request.subtype;
      const ok = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response } });
      if (sub === 'mcp_status') {
        // Hangs (never answers) until the flag exists, as a stuck list read does.
        if (fs.existsSync(${JSON.stringify(FLAG)})) ok({ mcpServers: [{ name: 'claude.ai Notion', status: 'needs-auth', scope: 'claudeai', source: 'claudeai', transport: 'http', config: { type: 'claudeai-proxy', url: 'https://mcp.notion.example/mcp' } }] });
      } else ok({});
      continue;
    }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) runTurn(text);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({
    autoSwitch: false, accounts: [{ id: 'me', email: 'me@personal.test', configDir: null, preferred: true }],
  }));
  // The account's last reading (another chat's): Notion is a connector that needs a sign-in.
  writeFileSync(join(HOME, '.dreamcontext', 'mcp-status.json'), JSON.stringify({
    me: { at: Date.now(), cells: { 'claude.ai Notion|claudeai': { status: 'needs-auth', at: Date.now() } } },
  }), { mode: 0o600 });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const results = [];
const check = (where, label, cond, detail = '') => {
  results.push({ where, label, ok: !!cond });
  console.log(`  ${cond ? '✓' : '✗'} [${where}] ${label}${!cond && detail ? ` — ${detail}` : ''}`);
};

async function run(chromium, base, where, viewport) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: viewport.height }, colorScheme: 'dark' });
  const page = await context.newPage();
  const consoleErrors = [];
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { invoke: (cmd) => Promise.reject(new Error(`Command ${cmd} not found`)), transformCallback: (cb) => cb, metadata: {} };
    window.open = () => null;
  });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e).slice(0, 200)}`));
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const shot = async (name, locator) => {
    try {
      if (locator) { await locator.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(250); }
      await page.screenshot({ path: join(SHOTS, `${where}-${name}.png`) });
    } catch { console.log(`  · could not capture ${name}`); }
  };

  console.log(`\n═══ ${where} ${viewport.width}px ═══`);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).first().click().catch(() => {});
  for (const target of [page.getByText('Chat 1', { exact: true }).last(), page.getByText('Chat', { exact: true }).first()]) {
    if (await vis('.chat-cmp-input').count()) break;
    await target.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  const chatOpen = await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000);
  check(where, 'a chat opens against the real WS route', chatOpen);
  if (!chatOpen) { await shot('00-no-chat'); await browser.close(); return consoleErrors; }
  await page.setViewportSize(viewport);
  await page.waitForTimeout(800);

  const input = vis('.chat-cmp-input').first();
  await input.fill('GO');
  await page.keyboard.press('Enter');
  check(where, 'the agent sends the mcp card', await until(async () => (await vis('.chat-mcpcard').count()) === 1, 20000));
  const card = vis('.chat-mcpcard[data-view-id="debt-notion"]').first();

  // §1 — the list never answers.
  const t0 = Date.now();
  const settled = await until(async () => !(await card.innerText()).includes('reading this chat'), 15000);
  check(where, `no row stays "reading…" (${Math.round((Date.now() - t0) / 1000)} s)`, settled);
  const text1 = (await card.innerText()).replace(/\s+/g, ' ');
  check(where, 'Notion says it is a claude.ai connector that needs the sign-in on claude.ai', /claude\.ai connector · needs your sign-in on claude\.ai/.test(text1), text1.slice(0, 300));
  check(where, 'playwright says it is not set up', /not set up yet/.test(text1), text1.slice(0, 300));
  check(where, 'Notion offers its claude.ai button', (await card.getByRole('button', { name: /Settings on claude\.ai/ }).count()) === 1);
  check(where, 'the card offers Retry', (await card.getByRole('button', { name: 'Retry' }).count()) === 1);
  await shot('01-list-never-answered', card);

  // §2 — the list answers; Retry.
  writeFileSync(FLAG, '1');
  await card.getByRole('button', { name: 'Retry' }).click();
  const matched = await until(async () => (await card.locator('.chat-mcpcard-name').allInnerTexts()).includes('claude.ai Notion'), 15000);
  check(where, '`notion` is matched to the live `claude.ai Notion` row', matched, JSON.stringify(await card.locator('.chat-mcpcard-name').allInnerTexts()));
  const text2 = (await card.innerText()).replace(/\s+/g, ' ');
  check(where, 'its live state and Reconnect are drawn', /claude\.ai connector · expired/.test(text2) && (await card.getByRole('button', { name: 'Reconnect' }).count()) === 1, text2.slice(0, 300));
  check(where, 'Retry is gone once the list answered, nothing reads "reading…"', (await card.getByRole('button', { name: 'Retry' }).count()) === 0 && !text2.includes('reading this chat'));
  await shot('02-list-answered', card);

  check(where, 'no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  await browser.close();
  return consoleErrors;
}

(async () => {
  rmSync(SHOTS, { recursive: true, force: true });
  const { chromium } = await import('playwright');
  for (const [where, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    setupScratch();
    const port = await freePort();
    const srv = await startServer(port);
    try { await run(chromium, `http://127.0.0.1:${port}`, where, viewport); } finally { srv.kill(); }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed · shots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
})();
