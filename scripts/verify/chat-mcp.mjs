#!/usr/bin/env node
/**
 * MCP management in the real app (task mcp-management) — `/mcp` popover, the `mcp` chat card,
 * the claude.ai fallback, and Settings → MCP's matrix, at a desktop (1440) and a phone (390) width.
 *
 *   npm run build && npm run verify:chat-mcp
 *
 * WHAT THIS PROVES, against the real server and a real Chromium:
 *   §1  typing `/mcp` opens the popover within 300 ms from the chat's own live status, needs-you
 *       first; a failed server offers Restart, never Sign in / Connect
 *   §2  the agent's `mcp` card draws live rows; Connect runs `mcp_authenticate` through the CHAT'S
 *       OWN process and opens the CLI's https auth URL; the row turns green with no refresh
 *   §3  the card reports exactly once (`MCP connected: …`) and the agent continues on its own
 *   §4  a claude.ai connector that never completes falls back to claude.ai/settings/connectors
 *   §5  Settings → MCP draws the matrix, "Check all accounts" fills each cell from a probe
 *   §6  no MCP secret reaches the DOM, and the page logs no console error
 * Screenshots: tmp/mcp-shots/ in the worktree (desktop-* and phone-*).
 *
 * The `claude` on the server's PATH is a scripted stand-in (no tokens): it speaks stream-json,
 * answers `mcp_status` / `mcp_authenticate` / `mcp_reconnect` from a state it owns (PostHog
 * becomes connected a few seconds after its sign-in starts, Gmail never does), and its first
 * turn sends the `mcp` card. Scratch HOME only; the real ~/.claude.json is never read.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST. Exit 0 iff everything passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-mcp');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'mcp-shots');
const CANARY = 'MCP-CANARY-SECRET-9f8e7d';

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-mcp.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const CANARY = ${JSON.stringify(CANARY)};
const state = { posthog: 'needs-auth', stitch: 'connected', 'apple-mail': 'failed', 'claude.ai Gmail': 'needs-auth' };
const started = Date.now();
function servers() {
  // Everything still connecting for the first second, as the real CLI does right after spawn.
  const early = Date.now() - started < 1000;
  return [
    { name: 'posthog', status: early ? 'pending' : state.posthog, scope: 'dynamic', source: 'dynamic', transport: 'http',
      config: { type: 'http', url: 'https://mcp.posthog.com/mcp?key=' + CANARY, headers: { Authorization: 'Bearer ' + CANARY } } },
    { name: 'stitch', status: state.stitch, scope: 'dynamic', source: 'dynamic', transport: 'stdio',
      config: { type: 'stdio', command: 'stitch-mcp', env: { STITCH_TOKEN: CANARY } }, tools: Array.from({ length: 14 }, (_, i) => ({ name: 't' + i })) },
    { name: 'apple-mail', status: state['apple-mail'], scope: 'dynamic', source: 'dynamic', transport: 'stdio',
      config: { type: 'stdio', command: '/nonexistent/apple-mail-mcp', args: ['--token=' + CANARY] }, error: 'spawn ENOENT --token=' + CANARY },
    { name: 'claude.ai Gmail', status: state['claude.ai Gmail'], scope: 'claudeai', source: 'claudeai', transport: 'http' },
  ];
}
const CARD = ['I need PostHog and Gmail for this report, and both have expired on this account. Connect them, then I will pick up from here.', '',
  '\\u0060\\u0060\\u0060dream-view',
  JSON.stringify({ type: 'mcp', id: 'report-sources', why: 'PostHog numbers for the weekly report', servers: ['posthog'] }),
  '\\u0060\\u0060\\u0060', '', 'Gmail too:', '',
  '\\u0060\\u0060\\u0060dream-view',
  JSON.stringify({ type: 'mcp', id: 'mail-source', why: 'the weekly mail digest', servers: ['claude.ai Gmail'] }),
  '\\u0060\\u0060\\u0060'].join('\\n');
let turn = 0;
function runTurn(text) {
  turn++;
  out({ type: 'system', subtype: 'init', session_id: 'verify-mcp-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: ['compact'] });
  const reply = turn === 1 ? CARD : 'CONTINUED [' + text + ']';
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-mcp-session' });
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
      if (sub === 'mcp_status') ok({ mcpServers: servers() });
      else if (sub === 'mcp_authenticate') {
        const name = o.request.serverName;
        ok({ authUrl: 'https://auth.example.test/authorize?server=' + encodeURIComponent(name) });
        if (name === 'posthog') setTimeout(() => { state.posthog = 'connected'; }, 4000);
      } else if (sub === 'mcp_reconnect') ok({});
      else ok({});
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
  // The machine's own servers, as Claude Code keeps them: dreamcontext copies them in.
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: {
      posthog: { type: 'http', url: `https://mcp.posthog.com/mcp?key=${CANARY}`, headers: { Authorization: `Bearer ${CANARY}` } },
      stitch: { type: 'stdio', command: 'stitch-mcp', env: { STITCH_TOKEN: CANARY } },
      'apple-mail': { type: 'stdio', command: '/nonexistent/apple-mail-mcp', args: [`--token=${CANARY}`] },
    },
  }));
  // Two registered accounts: the Mac's own (#0) and a sandboxed second one, so the matrix has a
  // column per account and the card can name the account the CLI expects.
  writeFileSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({
    autoSwitch: false,
    accounts: [
      { id: 'me', email: 'me@personal.test', configDir: null, preferred: true },
      { id: 'work', email: 'work@acme.test', configDir: join(HOME, '.dreamcontext', 'claude-accounts', 'work') },
    ],
  }));
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MCP_CONNECT_WINDOW_MS: '6000' },
    stdio: ['ignore', 'pipe', 'pipe'],
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
  // A phone-width window docks the chat as a card on first load: open the chat wide, then
  // narrow the window — the surfaces below are what a 390 px window draws.
  const context = await browser.newContext({ viewport: { width: 1440, height: viewport.height }, colorScheme: 'dark' });
  const page = await context.newPage();
  const consoleErrors = [];
  const opened = [];
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { invoke: (cmd) => Promise.reject(new Error(`Command ${cmd} not found`)), transformCallback: (cb) => cb, metadata: {} };
    // `openExternalUrl` falls back to window.open outside the real app: record the URL the
    // CLI handed out instead of loading it (the host does not exist).
    window.__dcOpened = [];
    window.open = (url) => { window.__dcOpened.push(String(url)); return null; };
  });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e).slice(0, 200)}`));
  const openedNow = async () => { opened.splice(0, opened.length, ...(await page.evaluate(() => window.__dcOpened ?? []))); return opened; };

  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const shot = async (name, locator) => {
    const file = join(SHOTS, `${where}-${name}.png`);
    try {
      if (locator) { await locator.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(250); }
      await page.screenshot({ path: file });
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
  // A narrow window docks the chat as a card ("Chat 1 · READY"): open it.
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
  // Let the spawn-time status settle (the stand-in reports `pending` for its first second).
  await page.waitForTimeout(4000);

  // §1 — /mcp
  const input = vis('.chat-cmp-input').first();
  await input.click();
  const t0 = Date.now();
  await input.fill('/mcp');
  const popped = await until(async () => (await vis('.mcp-picker').count()) > 0, 3000);
  const openMs = Date.now() - t0;
  check(where, `/mcp opens the popover (${openMs} ms, from the chat's last live status)`, popped && openMs < 300 + 150, `${openMs} ms`);
  await until(async () => (await vis('.mcp-picker-row').count()) >= 4, 8000);
  const names = await vis('.mcp-picker-name').allInnerTexts();
  check(where, 'needs-you first: the two sign-ins, then the failed one, then connected', JSON.stringify(names) === JSON.stringify(['claude.ai Gmail', 'posthog', 'apple-mail', 'stitch']), JSON.stringify(names));
  const failedRow = vis('.mcp-picker-row[data-status="failed"]').first();
  const failedButtons = (await failedRow.locator('button').allInnerTexts()).join('|');
  check(where, 'the failed server offers Restart, never Sign in / Connect', /Restart/.test(failedButtons) && !/Sign in|Connect/.test(failedButtons), failedButtons);
  await page.waitForTimeout(300);
  await shot('01-mcp-popover', vis('.mcp-picker').first());
  await page.keyboard.press('ArrowDown');
  check(where, '↓ moves the active row', (await vis('.mcp-picker-row[data-active="true"] .mcp-picker-name').first().innerText()) === 'posthog');
  await page.keyboard.press('Escape');
  check(where, 'esc closes it and clears the command', await until(async () => (await vis('.mcp-picker').count()) === 0 && (await input.inputValue()) === '', 2000));

  // §2-§4 — the card
  await input.fill('GO');
  await page.keyboard.press('Enter');
  check(where, 'the agent sends the mcp cards', await until(async () => (await vis('.chat-mcpcard').count()) === 2, 20000));
  const phCard = vis('.chat-mcpcard[data-view-id="report-sources"]').first();
  check(where, 'PostHog shows its live state: needs sign-in', await until(async () => (await phCard.locator('.chat-mcpcard-row').getAttribute('data-status')) === 'needs-auth', 8000));
  await shot('02-card-needs-auth', phCard);
  await phCard.getByRole('button', { name: 'Connect' }).click();
  check(where, 'Connect opens the CLI\'s https auth URL', await until(async () => (await openedNow()).some((u) => u.startsWith('https://auth.example.test/authorize?server=posthog')), 8000), JSON.stringify(opened));
  check(where, 'the row turns green without a refresh', await until(async () => (await phCard.locator('.chat-mcpcard-row').getAttribute('data-status')) === 'connected', 20000));
  check(where, 'the agent continues on its own with one `MCP connected: posthog`', await until(async () => (await page.locator('.chat-pane').first().innerText()).includes('CONTINUED [MCP connected: posthog]'), 15000));
  await page.waitForTimeout(1500);
  const paneText = await page.locator('.chat-pane').first().innerText();
  const continued = paneText.split('CONTINUED [MCP connected: posthog]').length - 1;
  const mentions = paneText.split('MCP connected: posthog').length - 1;
  check(where, 'reported exactly once (one owner message, one agent continuation)', continued === 1 && mentions === 2, `continued ${continued}, mentions ${mentions}`);
  await shot('03-card-connected', phCard);
  const gmCard = vis('.chat-mcpcard[data-view-id="mail-source"]').first();
  await gmCard.getByRole('button', { name: 'Reconnect' }).click();
  check(where, 'Reconnect on a claude.ai connector opens its auth URL too', await until(async () => (await openedNow()).some((u) => u.includes('server=claude.ai%20Gmail')), 8000));
  check(where, 'not connected in the window → the claude.ai fallback with the connectors link', await until(async () => (await gmCard.locator('.chat-mcpcard-fallback').count()) === 1, 30000));
  const fbText = (await gmCard.locator('.chat-mcpcard-fallback').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(where, 'the fallback names the account the CLI expects', fbText.includes('me@personal.test'), fbText.slice(0, 160));
  await shot('04-card-claudeai-fallback', gmCard.locator('.chat-mcpcard-fallback'));

  // §5 — Settings, through the popover's own "Manage in Settings" link. Every probe reading is
  // forgotten first, so what the matrix shows next can only come from probes it starts.
  rmSync(join(HOME, '.dreamcontext', 'mcp-status.json'), { force: true });
  await input.click();
  await input.fill('/mcp');
  await until(async () => (await vis('.mcp-picker').count()) > 0, 3000);
  await vis('.mcp-picker-link').first().dispatchEvent('mousedown');
  await page.waitForTimeout(1500);
  check(where, 'Settings → MCP draws the matrix', await until(async () => (await vis('.mcpm-table').count()) > 0, 15000));
  // Opened with no probe reading at all (removed before navigating): Settings checks every
  // account in the background on its own, then the owner's click checks again.
  check(where, 'opened with no reading, it starts checking every account by itself', await until(async () => (await page.getByRole('button', { name: /Checking every account/ }).count()) > 0, 5000));
  const columns = await vis('.mcpm-table thead .mcpm-acc').allInnerTexts();
  check(where, 'a column per registered account', JSON.stringify(columns) === JSON.stringify(['me@personal.test', 'work@acme.test']), JSON.stringify(columns));
  await until(async () => (await page.getByRole('button', { name: 'Check all accounts' }).count()) > 0, 60000);
  await page.getByRole('button', { name: 'Check all accounts' }).click();
  await until(async () => (await page.getByRole('button', { name: 'Check all accounts' }).count()) > 0, 90000);
  const filled = await vis('.mcpm-table .mcpm-dot[data-status="failed"]').count();
  const green = await vis('.mcpm-table .mcpm-dot[data-status="connected"]').count();
  const unchecked = await vis('.mcpm-table .mcpm-dot[data-status="unchecked"]').count();
  check(where, '"Check all accounts" fills every account\'s cells from its probe, with the check time', filled >= 2 && green >= 2 && unchecked === 0
    && /checked just now/.test(await vis('.mcpm-toolbar-when').first().innerText()), `failed ${filled}, connected ${green}, unchecked ${unchecked}`);
  const groups = await vis('.mcpm-group th').allInnerTexts();
  check(where, 'grouped by where servers live', groups.some((g) => /This computer/i.test(g)) && groups.some((g) => /claude\.ai/i.test(g)), JSON.stringify(groups));
  const scroll = vis('.mcpm-scroll').first();
  const overflow = await scroll.evaluate((el) => el.scrollWidth > el.clientWidth).catch(() => false);
  if (viewport.width < 600) check(where, 'the matrix scrolls sideways on a narrow window', overflow);
  const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(where, 'the page itself does not overflow', !bodyOverflow);
  await shot('05-settings-matrix', vis('#settings-mcp').first());

  // §6
  const html = await page.content();
  check(where, 'no MCP secret in the DOM', !html.includes(CANARY));
  check(where, 'no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  await browser.close();
  return consoleErrors;
}

(async () => {
  rmSync(SHOTS, { recursive: true, force: true });
  const base0 = { errors: [] };
  const { chromium } = await import('playwright');
  // Each width gets its own scratch vault and server: a fresh chat, the stand-in's first state.
  for (const [where, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    setupScratch();
    const port = await freePort();
    const srv = await startServer(port);
    const base = `http://127.0.0.1:${port}`;
    try {
      base0.errors = base0.errors.concat(await run(chromium, base, where, viewport));
      const overview = await (await fetch(`${base}/api/agent/mcp/overview`, { headers: { 'X-Dreamcontext-Vault': 'proj' } })).text();
      check(where, 'the overview response carries no secret', !overview.includes(CANARY));
    } finally {
      srv.kill();
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed · console errors: ${base0.errors.length} · shots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
})();
