#!/usr/bin/env node
/**
 * `/mcp` in the Chat window — end-to-end verification.
 *
 *   npm run build && npm run verify:chat-mcp
 *
 * WHAT WAS BROKEN. `/mcp` typed into Chat was answered, not refused: the headless engine
 * treats it as a local command and returns "N MCP server(s): … Use `/mcp` in the terminal for
 * details." (verified against the REAL CLI 2.1.276 while building this). The user typed
 * exactly the right thing, spent a turn, and was sent to another app — while unauthenticated
 * servers, 11 of 24 on the machine this was built for, stayed broken with no way to see or
 * fix them from the window they were working in.
 *
 * WHAT THIS PROVES, in the real app against the real server:
 *   §1  `/mcp` opens the panel and is NEVER SENT — no user bubble, no turn, nothing spent
 *   §2  the panel lists what the CLI reports, with each state read from the CLI's own words
 *   §3  Sign in runs `claude mcp login <name>` with the name EXACTLY as configured (spaces,
 *       dots and colons intact) — asserted from the child's own recorded argv
 *   §4  the verdict is the RE-PROBE, not the exit code: a login abandoned in the browser
 *       exits 0 and the row still says "Needs sign-in" instead of lying about a live tool
 *   §5  the login child's output never surfaces — a callback URL bearing an authorization
 *       code is printed by the child on purpose here, and must appear in NO response and NO
 *       pixel of the DOM
 *   §6  interception stays narrow: "what does /mcp do?" and `/mcpanel` still travel as
 *       ordinary messages
 *   §7  A SANDBOXED ACCOUNT STILL SEES ITS LOCAL SERVERS (owner report 2026-09-18: "sadece
 *       claude ai ile ilgili olan mcp'ler geldi lokaller gelmedi"). A sandbox's `.claude.json`
 *       carries no MCP keys by design; its session reaches the machine's own servers through
 *       `--mcp-config <shared file>`. So the panel must merge two listings, and a sign-in for
 *       a shared row must run against the REAL HOME — where that server is configured and
 *       where its credential belongs — not against the sandbox
 *
 * WHAT MAKES §3 AND §4 HONEST: the scripted `claude` records its own argv and env to a file,
 * and it decides each server's fate itself. A UI that flipped a row optimistically would pass
 * a DOM-only check and fail §4; a UI that sent a mangled name would pass §2 and fail §3.
 *
 * SCRATCH HOME, ALWAYS. Every fixture lives under an isolated HOME the server is spawned
 * with, and the only `claude` on its PATH is the stand-in. This script never reads or writes
 * the developer's real `~/.claude.json`, and it never performs a real OAuth against a real
 * MCP server.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST: every check prints ✓/✗ with evidence and the run
 * continues. Exit 0 iff everything passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-mcp');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
/** Where the stand-in records every `mcp` invocation, and where it keeps server states. */
const CALLS = join(SCRATCH, 'mcp-calls.jsonl');
const STATES = join(SCRATCH, 'mcp-states.json');

/**
 * The secret the login child prints on stdout.
 *
 * This is the whole of §5: an interactive OAuth's stdout can carry a callback URL bearing an
 * authorization code, so the spawn discards the child's output entirely. If that ever
 * regresses to buffering, this string reaches the route, and the assertion catches it.
 */
const LEAK_CANARY = 'https://127.0.0.1:59999/callback?code=VERIFY-CANARY-DO-NOT-SURFACE';

/** The fixture listing — real shapes, including the two names that break a naive parser. */
const SERVERS = [
  { name: 'claude.ai Pixabay', target: 'https://pixabay-mcp.example.test/mcp', state: 'connected' },
  { name: 'claude.ai Figma', target: 'https://mcp.figma.test/mcp', state: 'needs-auth' },
  { name: 'claude.ai Google Calendar', target: 'https://calendarmcp.example.test/mcp/v1', state: 'needs-auth' },
  { name: 'plugin:stripe:stripe', target: 'https://mcp.stripe.test (HTTP)', state: 'needs-auth' },
];

/** Which servers a sign-in actually completes for. `Google Calendar` is the abandoned one. */
const LOGIN_SUCCEEDS = new Set(['claude.ai Figma', 'plugin:stripe:stripe', 'playwright']);

/**
 * The MACHINE's own servers — user scope in the real `~/.claude.json`, and the contents of the
 * shared `--mcp-config` file a sandboxed spawn is pointed at.
 *
 * A sandbox listing must NOT contain these (that is the architecture: no MCP keys are ever
 * copied into a sandbox), and the panel must show them anyway, because the session has them.
 */
const LOCAL_SERVERS = [
  { name: 'playwright', target: 'npx @playwright/mcp@latest', state: 'needs-auth' },
  { name: 'analytics-mcp', target: 'npx analytics-mcp --stdio', state: 'connected' },
];

/** The sandboxed account the §7 assertions run against. */
const SANDBOX_ID = 'someone-example-com';

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// Two personalities in one binary, because the route and the chat both resolve `claude` from
// PATH: `mcp …` subcommands, and the `-p --input-format stream-json` chat engine.
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude\` — see scripts/verify/chat-mcp-panel.mjs. */
const fs = require('fs');
const argv = process.argv.slice(2);
const CALLS = ${JSON.stringify(CALLS)};
const STATES = ${JSON.stringify(STATES)};
const LEAK = ${JSON.stringify(LEAK_CANARY)};
const LOGIN_SUCCEEDS = new Set(${JSON.stringify([...LOGIN_SUCCEEDS])});
const LOCAL = ${JSON.stringify(LOCAL_SERVERS.map((s) => s.name))};

const LABEL = {
  'connected': '✔ Connected',
  'needs-auth': '! Needs authentication',
  'pending-approval': '⏸ Pending approval',
};

/**
 * THE ARCHITECTURE, REPRODUCED. A sandbox's config directory knows nothing about the
 * machine's own servers — no MCP key is ever copied into one — so a listing run under
 * CLAUDE_CONFIG_DIR reports the account's connectors ONLY. The real home reports both.
 * A panel that ran one listing under the sandbox therefore loses every local server, which
 * is exactly the bug §7 exists to catch.
 */
function visible(all) {
  return process.env.CLAUDE_CONFIG_DIR
    ? all.filter((s) => !LOCAL.includes(s.name))
    : all;
}
function states() { return JSON.parse(fs.readFileSync(STATES, 'utf-8')); }
function write(next) { fs.writeFileSync(STATES, JSON.stringify(next, null, 2)); }
function record(entry) {
  fs.appendFileSync(CALLS, JSON.stringify({ ...entry, argv, configDir: process.env.CLAUDE_CONFIG_DIR || null }) + '\\n');
}

if (argv[0] === 'mcp') {
  const sub = argv[1];
  const list = states();
  record({ sub, name: argv[2] || null });

  if (sub === 'list') {
    // The real command's shape, header line and all.
    process.stdout.write('Checking MCP server health…\\n\\n');
    for (const s of visible(list)) process.stdout.write(s.name + ': ' + s.target + ' - ' + LABEL[s.state] + '\\n');
    process.exit(0);
  }
  if (sub === 'get') {
    const found = visible(list).find((s) => s.name === argv[2]);
    if (!found) { process.stdout.write('No MCP server found with name: ' + argv[2] + '\\n'); process.exit(1); }
    process.stdout.write(found.name + ':\\n  Scope: claude.ai config\\n  Status: ' + LABEL[found.state] + '\\n');
    process.exit(0);
  }
  if (sub === 'login') {
    // An interactive OAuth prints progress — INCLUDING the callback URL with its code. The
    // production spawn discards this stream; that is what §5 checks.
    process.stdout.write('Opening your browser…\\n' + LEAK + '\\n');
    const next = list.map((s) => (s.name === argv[2] && LOGIN_SUCCEEDS.has(s.name)
      ? { ...s, state: 'connected' } : s));
    write(next);
    // Exit 0 EVEN WHEN NOTHING WAS AUTHENTICATED — the abandoned-in-the-browser case, and the
    // reason the route re-probes instead of trusting this number.
    process.exit(0);
  }
  if (sub === 'logout') {
    write(list.map((s) => (s.name === argv[2] ? { ...s, state: 'needs-auth' } : s)));
    process.exit(0);
  }
  process.exit(1);
}

// ── the chat engine ──────────────────────────────────────────────────────────────────
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false;

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-mcp', model: 'claude-opus-5',
        cwd: process.cwd(), permissionMode: 'acceptEdits', slash_commands: ['mcp', 'compact'] });
  await sleep(100);
  // Echo the prompt back so §6 can prove a message TRAVELLED rather than being swallowed.
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'GOT: ' + prompt }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1,
        total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 5 }, session_id: 'verify-mcp' });
  busy = false;
  pump();
}

async function pump() {
  if (busy) return;
  const next = inbox.shift();
  if (next === undefined) return;
  busy = true;
  try { await runTurn(next); } finally { busy = false; }
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
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type === 'user') {
      const content = o.message && o.message.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        : String(content || '');
      inbox.push(text);
      pump();
    }
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
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', '1.soul.md'),
    '---\nname: acme-payments\ntype: soul\n---\n\n## Project Identity\n\nA payments backend: invoicing, ledgers and reconciliation.\n');
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: 'opus', chatDefaultEffort: 'high',
  }, null, 2)}\n`);
  writeFileSync(STATES, `${JSON.stringify([...SERVERS, ...LOCAL_SERVERS], null, 2)}\n`);
  writeFileSync(CALLS, '');

  // ── the multi-account world §7 needs ────────────────────────────────────────────────
  // A registered sandbox account, its directory, and the shared `--mcp-config` file a
  // sandboxed spawn is pointed at. Written the way the real ones are: the register at
  // ~/.dreamcontext/claude-accounts.json, the sandbox under ~/.dreamcontext/claude-accounts/<id>,
  // and the shared file beside it carrying the machine's own servers.
  const sandboxDir = join(HOME, '.dreamcontext', 'claude-accounts', SANDBOX_ID);
  mkdirSync(sandboxDir, { recursive: true });
  writeFileSync(join(sandboxDir, '.claude.json'), `${JSON.stringify({
    // Deliberately NO mcpServers at any depth — that is what makes the sandbox a sandbox.
    hasTrustDialogAccepted: true,
    oauthAccount: { emailAddress: 'someone@example.com' },
  }, null, 2)}\n`);
  writeFileSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), `${JSON.stringify({
    accounts: [{
      id: SANDBOX_ID, accountUuid: '', email: 'someone@example.com',
      organizationUuid: '', organizationName: '', tier: '',
      configDir: sandboxDir, preferred: false,
    }],
  }, null, 2)}\n`);
  // The real home's user-scope servers. `ensureSharedMcpConfig` derives the shared file from
  // exactly this map, so writing it here is what makes the server build the real thing.
  writeFileSync(join(HOME, '.claude.json'), `${JSON.stringify({
    mcpServers: Object.fromEntries(LOCAL_SERVERS.map((s) => [s.name, { command: 'npx', args: [s.name] }])),
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'acme-payments', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath,
    [join(REPO, 'dist', 'index.js'), 'dashboard', '--launcher', '--no-open', '-p', String(port)], {
      cwd: SCRATCH,
      env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; }
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

/** Every `mcp` invocation the stand-in recorded, in order. */
function calls() {
  if (!existsSync(CALLS)) return [];
  return readFileSync(CALLS, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function run(chromium, base, report) {
  const ok = (label, cond, detail) => report.check(label, cond, detail);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  context.setDefaultTimeout(8000);
  await context.addInitScript(() => {
    try { window.localStorage.setItem('dreamcontext.launcher.view', 'space'); } catch { /* private mode */ }
  });

  const until = async (page, fn, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };

  // ── the route, before any UI ──────────────────────────────────────────────────────
  console.log('\n── the endpoint');
  const listRes = await fetch(`${base}/api/agent/mcp`);
  const listed = await listRes.json();
  ok('GET /api/agent/mcp answers', listRes.ok, `status ${listRes.status}`);
  const EXPECTED = SERVERS.length + LOCAL_SERVERS.length;
  ok('…with every configured server, parsed out of the CLI\'s own listing',
    listed?.servers?.length === EXPECTED,
    `${listed?.servers?.length} of ${EXPECTED}`);
  ok('…names survive spaces, dots and colons intact',
    listed?.servers?.some((s) => s.name === 'plugin:stripe:stripe')
    && listed?.servers?.some((s) => s.name === 'claude.ai Google Calendar'),
    (listed?.servers ?? []).map((s) => s.name).join(' | '));
  ok('…and the counts name the problem the panel exists to fix',
    listed?.counts?.needsAuth === 4 && listed?.counts?.connected === 2,
    JSON.stringify(listed?.counts));
  ok('account #0 reads one listing and marks every row as its own',
    (listed?.servers ?? []).every((s) => s.origin === 'account'),
    (listed?.servers ?? []).map((s) => `${s.name}:${s.origin}`).join(' | '));

  // ── the chat ──────────────────────────────────────────────────────────────────────
  console.log('\n── the project window');
  const chat = await context.newPage();
  await chat.goto(`${base}/?vault=acme-payments`, { waitUntil: 'domcontentloaded' });
  await chat.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) { await chat.keyboard.press('Escape'); await chat.waitForTimeout(200); }
  if (!(await chat.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = chat.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await chat.waitForTimeout(1200); }
      if (await chat.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await chat.locator('.chat-cmp-input:visible').count())) {
    await chat.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  ok('a project chat opens with the composer mounted',
    await until(chat, async () => (await chat.locator('.chat-cmp-input:visible').count()) > 0, 25000));
  const input = chat.locator('.chat-cmp-input:visible').first();

  // ── §1 the command opens the panel and is never sent ──────────────────────────────
  console.log('\n── §1 `/mcp` opens the panel instead of spending a turn');
  await input.click();
  await input.fill('/mcp');
  // The slash menu may be open over the draft; Enter with it open COMPLETES rather than sends,
  // so it is dismissed first — the same gesture a user makes.
  await chat.keyboard.press('Escape');
  await chat.keyboard.press('Enter');
  // Waiting on ROWS, not on the list container: the container is rendered from the first
  // paint (the panel says "health-checking…" inside it), so waiting on it would only prove
  // the component mounted, and every row assertion below would race the real `claude mcp
  // list` child. The rows are the signal that the listing actually came back.
  ok('the panel opens and fills with what the CLI reported',
    await until(chat, async () => (await chat.locator('.mcp-row').count()) > 0, 40000));
  /** Everything the CLI was asked from here on is the UI's doing. Marked AFTER the listing
   *  has landed, so the panel's own opening `list` is not counted as a stray call — and so
   *  the two probe fetches this script made itself stay behind the mark too. */
  const uiFrom = calls().length;
  const uiCalls = () => calls().slice(uiFrom);

  const transcript = await chat.locator('.chat-transcript').first().innerText().catch(() => '');
  ok('…and the command was NOT sent — no `/mcp` bubble in the transcript',
    !transcript.includes('/mcp'), transcript.slice(0, 160).replace(/\s+/g, ' '));
  ok('…no turn ran for it — the engine was never handed the command',
    !transcript.includes('GOT: /mcp'), transcript.slice(0, 160).replace(/\s+/g, ' '));
  ok('…and the composer is empty, not left holding the obeyed command',
    (await input.inputValue()) === '', JSON.stringify(await input.inputValue()));

  // ── §2 what the panel draws ───────────────────────────────────────────────────────
  console.log('\n── §2 the panel reports what the CLI reports');
  const rowText = async () => (await chat.locator('.mcp-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const rows = await rowText();
  ok(`every server has a row (${rows.length})`,
    rows.length === SERVERS.length + LOCAL_SERVERS.length, rows.join(' || '));
  ok('the connected one reads Connected', rows.some((t) => t.includes('claude.ai Pixabay') && t.includes('Connected')),
    rows.find((t) => t.includes('Pixabay')));
  ok('the unauthenticated ones say so, and offer the sign-in',
    (await chat.locator('.mcp-row[data-tone="warn"] .mcp-act').count()) === 4,
    `${await chat.locator('.mcp-act').count()} action buttons in total`);
  await chat.screenshot({ path: join(SHOTS, '01-mcp-panel.png') });
  report.note('📸 01-mcp-panel.png');

  // ── §3 + §4 the sign-in, and whose word the verdict is ────────────────────────────
  console.log('\n── §3 the sign-in runs the real command for the right server');
  const figmaRow = chat.locator('.mcp-row', { hasText: 'claude.ai Figma' }).first();
  await figmaRow.locator('.mcp-act').click();
  ok('the row flips to Connected once the CLI says it is',
    await until(chat, async () => (await figmaRow.innerText()).includes('Connected'), 25000),
    (await figmaRow.innerText()).replace(/\s+/g, ' '));

  const loginCalls = calls().filter((c) => c.sub === 'login');
  ok('`claude mcp login` ran exactly once', loginCalls.length === 1, JSON.stringify(loginCalls.map((c) => c.argv)));
  ok('…for the server the user clicked, name byte-for-byte',
    loginCalls[0]?.argv?.join(' ') === 'mcp login claude.ai Figma',
    JSON.stringify(loginCalls[0]?.argv));
  ok('…and the verdict came from a re-probe, not from the exit code',
    calls().some((c) => c.sub === 'get' && c.name === 'claude.ai Figma'),
    calls().map((c) => `${c.sub}:${c.name ?? ''}`).join(' → '));
  ok('the panel did not re-list all servers to answer about one',
    uiCalls().filter((c) => c.sub === 'list').length === 0,
    uiCalls().map((c) => c.sub).join(','));

  console.log('\n── §4 a login abandoned in the browser is not reported as success');
  const calRow = chat.locator('.mcp-row', { hasText: 'claude.ai Google Calendar' }).first();
  await calRow.locator('.mcp-act').click();
  // The stand-in exits 0 for this one WITHOUT authenticating it — exactly what an abandoned
  // browser tab produces. The row must stay honest.
  ok('the abandoned sign-in leaves the row unchanged',
    await until(chat, async () => {
      const t = (await calRow.innerText());
      return t.includes('Needs sign-in') && !t.includes('Signing in…');
    }, 25000),
    (await calRow.innerText()).replace(/\s+/g, ' '));
  ok('…and the panel says so rather than claiming a connection',
    !(await calRow.innerText()).includes('Connected'),
    (await calRow.innerText()).replace(/\s+/g, ' '));
  await chat.screenshot({ path: join(SHOTS, '02-after-signin.png') });
  report.note('📸 02-after-signin.png');

  /** The UI's whole CLI conversation, snapshotted BEFORE §5 makes its own probe fetch — a
   *  script-made call landing in the same log would otherwise be read as the panel's. */
  const uiConversation = uiCalls().map((c) => `${c.sub}:${c.name}`).join(' → ');

  // ── §5 nothing from the login child surfaces ──────────────────────────────────────
  console.log('\n── §5 the login child\'s output never reaches the surface');
  const dom = await chat.content();
  ok('the callback URL with its authorization code is nowhere in the DOM',
    !dom.includes('VERIFY-CANARY-DO-NOT-SURFACE'), 'canary found in page HTML');
  const reRes = await fetch(`${base}/api/agent/mcp`);
  const reBody = await reRes.text();
  ok('…nor in any API response', !reBody.includes('VERIFY-CANARY-DO-NOT-SURFACE'));
  ok('…and Figma is now genuinely connected upstream, so §3 was not a UI-only flip',
    JSON.parse(reBody).servers.find((s) => s.name === 'claude.ai Figma')?.state === 'connected');

  // ── §6 the interception stays narrow ──────────────────────────────────────────────
  console.log('\n── §6 only the command itself is intercepted');
  await chat.locator('.chat-slideover-close').first().click();
  await chat.waitForTimeout(400);
  await input.click();
  await input.fill('what does /mcp do?');
  await chat.keyboard.press('Enter');
  ok('a question ABOUT the command still reaches the model',
    await until(chat, async () =>
      (await chat.locator('.chat-transcript').first().innerText()).includes('GOT: what does /mcp do?'), 20000));
  ok('…and it did not open the panel', (await chat.locator('.mcp-list').count()) === 0);

  await input.click();
  await input.fill('/mcpanel');
  await chat.keyboard.press('Escape');
  await chat.keyboard.press('Enter');
  ok('a longer command sharing the prefix is not intercepted',
    await until(chat, async () =>
      (await chat.locator('.chat-transcript').first().innerText()).includes('GOT: /mcpanel'), 20000));

  // The whole CLI conversation the UI had, in order: two sign-ins, each judged by its own
  // re-probe, and nothing else. No polling, no speculative re-listing, no third login from a
  // double-fired click.
  ok('the panel asked the CLI for exactly what the user clicked, and nothing more',
    uiConversation
      === 'login:claude.ai Figma → get:claude.ai Figma → login:claude.ai Google Calendar → get:claude.ai Google Calendar',
    uiConversation);

  // ── §7 a sandboxed account still sees the machine's own servers ───────────────────
  console.log('\n── §7 a sandboxed account does not lose its local servers');
  const sbRes = await fetch(`${base}/api/agent/mcp?account=${encodeURIComponent(SANDBOX_ID)}`);
  const sb = await sbRes.json();
  const sbNames = (sb?.servers ?? []).map((x) => x.name);
  ok('the sandbox listing answers', sbRes.ok, `status ${sbRes.status}`);
  // The bug, stated as an assertion: the sandbox's own config directory reports the
  // connectors ONLY, so a single listing would stop here and the user would see no
  // `playwright` at all.
  ok('…the account\'s own connectors are there',
    SERVERS.every((x) => sbNames.includes(x.name)), sbNames.join(' | '));
  ok('…AND the machine\'s own servers are there too, which one listing would have lost',
    LOCAL_SERVERS.every((x) => sbNames.includes(x.name)), sbNames.join(' | '));
  ok('…each row says where the session gets it from',
    (sb?.servers ?? []).filter((x) => x.origin === 'shared').map((x) => x.name).sort().join(',')
      === LOCAL_SERVERS.map((x) => x.name).sort().join(','),
    (sb?.servers ?? []).map((x) => `${x.name}:${x.origin}`).join(' | '));
  ok('…and nothing is listed twice',
    sbNames.length === new Set(sbNames).size, sbNames.join(' | '));

  // Where a shared server's sign-in LANDS. Its credential belongs in the real home, where the
  // server is configured; run under the sandbox it would be written where no session looks.
  const beforeLogin = calls().length;
  const shLogin = await fetch(`${base}/api/agent/mcp/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'playwright', account: SANDBOX_ID, origin: 'shared' }),
  });
  const shBody = await shLogin.json();
  const shCalls = calls().slice(beforeLogin);
  ok('signing into a local server runs against the REAL HOME, not the sandbox',
    shCalls.filter((c) => c.sub === 'login').every((c) => c.configDir === null),
    shCalls.map((c) => `${c.sub}@${c.configDir ? 'sandbox' : 'real-home'}`).join(' → '));
  ok('…and its verdict is re-probed in that same place',
    shCalls.some((c) => c.sub === 'get' && c.name === 'playwright' && c.configDir === null),
    shCalls.map((c) => `${c.sub}:${c.name}`).join(' → '));
  ok('…the row comes back connected', shBody?.state === 'connected', JSON.stringify(shBody));

  // A client that CLAIMS shared for a name the shared file does not carry must not redirect
  // the sign-in out of the sandbox.
  const beforeLie = calls().length;
  await fetch(`${base}/api/agent/mcp/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'claude.ai Figma', account: SANDBOX_ID, origin: 'shared' }),
  });
  ok('an unfounded `shared` claim is refused — the leg stays in the account\'s own directory',
    calls().slice(beforeLie).filter((c) => c.sub === 'login').every((c) => c.configDir !== null),
    calls().slice(beforeLie).map((c) => `${c.sub}@${c.configDir ? 'sandbox' : 'real-home'}`).join(' → '));

  await browser.close();
}

function makeReport() {
  const failures = [];
  let passed = 0;
  return {
    check(label, cond, detail) {
      if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
      else { failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
    },
    note(msg) { console.log(`    ${msg}`); },
    finish() {
      console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed`);
      console.log(`  screenshots: ${SHOTS}`);
      if (failures.length) { for (const f of failures) console.log(`   - ${f}`); }
      return failures.length === 0 ? 0 : 1;
    },
  };
}

async function main() {
  const { chromium } = await import('playwright');
  console.log('── setup');
  setupScratch();
  const port = await freePort();
  const srv = await startServer(port);
  console.log(`  server on ${port}, scratch ${SCRATCH}`);
  const report = makeReport();
  try {
    await run(chromium, `http://127.0.0.1:${port}`, report);
  } catch (err) {
    console.log(`\n✗ threw: ${err && err.stack ? err.stack : String(err)}`);
    report.check('the run completed without throwing', false, String(err).slice(0, 200));
  } finally {
    srv.kill();
  }
  process.exit(report.finish());
}

main();
