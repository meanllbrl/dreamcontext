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
 *   §2  the panel reports the SESSION's own view, so a server that reaches the chat only by
 *       reference is listed, and each row says which scope it came from
 *   §3  Sign in runs `claude mcp login <name>` IN THE PROJECT (which is what makes a
 *       repo-defined server a valid target) — asserted from the child's own recorded argv+cwd
 *   §4  the verdict is a RE-READ of the session, not the exit code: a login abandoned in the
 *       browser exits 0 and the row still says "Needs sign-in"
 *   §5  the login child's output never surfaces — a callback URL bearing an authorization
 *       code is printed by the child on purpose here, and must appear in NO response and NO
 *       pixel of the DOM
 *   §6  interception stays narrow: "what does /mcp do?" and `/mcpanel` still travel as
 *       ordinary messages
 *   §7  a by-reference server is never reported connected by a forced sign-in — the command
 *       cannot name it there, so the panel offers an explanation instead of a button
 *   §8  Settings shares a machine server with the repo, and REFUSES to publish its secret:
 *       the literal becomes a ${VAR} reference and the key reaches neither the file nor the
 *       API response
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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The fixture, in the shape the ENGINE reports it: `{ name, status, source }`.
 *
 * Every source here is one measured on the real CLI (2.1.276). The mix is the point: a
 * `project` server is the team-shared kind, a `dynamic` one is handed in by `--mcp-config`
 * and cannot be signed into at all, and a `claudeai` one belongs to the account.
 */
const SERVERS = [
  { name: 'probe-project-scope', status: 'connected', source: 'project' },
  { name: 'claude.ai Figma', status: 'needs-auth', source: 'claudeai' },
  { name: 'claude.ai Google Calendar', status: 'needs-auth', source: 'claudeai' },
  { name: 'plugin:stripe:stripe', status: 'needs-auth', source: 'plugin' },
  { name: 'playwright', status: 'connected', source: 'dynamic' },
  { name: 'designer-pack', status: 'needs-auth', source: 'dynamic' },
];

/** Which servers a sign-in actually completes for. `Google Calendar` is the abandoned one. */
const LOGIN_SUCCEEDS = new Set(['claude.ai Figma', 'plugin:stripe:stripe']);

/** The machine-local servers — `dynamic` above, and the pool Settings offers to share. */
const LOCAL_SERVERS = [
  { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  { name: 'designer-pack', type: 'http', url: 'https://designer.example.test/mcp', headers: { Authorization: 'literal-secret-must-not-be-published' } },
];

/** The sandboxed account the account assertions run against. */
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

function states() { return JSON.parse(fs.readFileSync(STATES, 'utf-8')); }
function write(next) { fs.writeFileSync(STATES, JSON.stringify(next, null, 2)); }
function record(entry) {
  fs.appendFileSync(CALLS, JSON.stringify({
    ...entry, argv, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR || null,
  }) + '\\n');
}

/**
 * THE ARCHITECTURE, REPRODUCED.
 *
 * \`claude mcp <sub>\` sees a CONFIG DIRECTORY: under CLAUDE_CONFIG_DIR it knows nothing about
 * the machine's own servers (no MCP key is ever copied into a sandbox) and nothing about the
 * ones handed in by --mcp-config. The SESSION sees all of them. That gap is the whole bug the
 * panel was rebuilt around, so the stand-in must have it too.
 */
function configVisible(all) {
  return all.filter((s) => s.source !== 'dynamic' && s.source !== 'project');
}

if (argv[0] === 'mcp') {
  const sub = argv[1];
  const list = states();
  record({ sub, name: argv[2] || null });
  const found = configVisible(list).find((s) => s.name === argv[2]);

  if (sub === 'login' || sub === 'logout') {
    if (!found) {
      // What the real CLI answers for a server it cannot name here — the reason the panel
      // must not offer a button for a \`dynamic\` row.
      process.stdout.write('No MCP server named "' + argv[2] + '".\\n');
      process.exit(1);
    }
    if (sub === 'login') {
      // An interactive OAuth prints progress — INCLUDING the callback URL with its code.
      process.stdout.write('Opening your browser…\\n' + LEAK + '\\n');
      write(list.map((s) => (s.name === argv[2] && LOGIN_SUCCEEDS.has(s.name)
        ? { ...s, status: 'connected' } : s)));
      // Exit 0 EVEN WHEN NOTHING WAS AUTHENTICATED — the abandoned-in-the-browser case.
      process.exit(0);
    }
    write(list.map((s) => (s.name === argv[2] ? { ...s, status: 'needs-auth' } : s)));
    process.exit(0);
  }
  process.exit(1);
}

// ── the engine ───────────────────────────────────────────────────────────────────────
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false;

/** The session's OWN view: everything, whatever config directory it runs under. */
function initFrame() {
  return {
    type: 'system', subtype: 'init', session_id: 'verify-mcp', model: 'claude-opus-5',
    cwd: process.cwd(), permissionMode: 'acceptEdits', slash_commands: ['mcp', 'compact'],
    mcp_servers: states().map((s) => ({ name: s.name, status: s.status, source: s.source })),
  };
}

// The panel's probe: \`-p /mcp\`, which the real engine answers as a local command with
// num_turns 0 and zero cost. It emits the init frame and exits without a turn.
const prompt = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : '';
if (prompt === '/mcp') {
  record({ sub: 'probe', name: null });
  out(initFrame());
  out({ type: 'result', subtype: 'success', is_error: false, result: 'n MCP server(s)',
        num_turns: 0, total_cost_usd: 0, session_id: 'verify-mcp', local_command: 'mcp' });
  process.exit(0);
}

async function runTurn(text) {
  busy = true;
  out(initFrame());
  await sleep(100);
  // Echo the prompt back so §6 can prove a message TRAVELLED rather than being swallowed.
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'GOT: ' + text }] } });
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
  writeFileSync(STATES, `${JSON.stringify(SERVERS, null, 2)}\n`);
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
    mcpServers: Object.fromEntries(LOCAL_SERVERS.map(({ name, ...def }) => [name, def])),
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
  const listRes = await fetch(`${base}/api/agent/mcp?vault=acme-payments`);
  const listed = await listRes.json();
  ok('GET /api/agent/mcp answers', listRes.ok, `status ${listRes.status}`);
  ok('…with the session\'s OWN view — every server, whatever scope it came from',
    listed?.servers?.length === SERVERS.length, `${listed?.servers?.length} of ${SERVERS.length}`);
  ok('…including the ones handed in by reference, which a config listing would have lost',
    (listed?.servers ?? []).some((s) => s.name === 'playwright' && s.source === 'dynamic'),
    (listed?.servers ?? []).map((s) => `${s.name}:${s.source}`).join(' | '));
  ok('…and the counts name the problem the panel exists to fix',
    listed?.counts?.needsAuth === 4 && listed?.counts?.connected === 2,
    JSON.stringify(listed?.counts));
  // realpath both sides: macOS resolves /var to /private/var, which is not a difference.
  const samePath = (a) => { try { return realpathSync(a) === realpathSync(PROJ); } catch { return false; } };
  ok('the probe ran IN THE PROJECT, so project-scoped servers are visible at all',
    calls().filter((c) => c.sub === 'probe').every((c) => samePath(c.cwd)),
    calls().filter((c) => c.sub === 'probe').map((c) => c.cwd).join(' | '));
  ok('a `dynamic` row is marked as un-signable, because the command cannot name it there',
    (listed?.servers ?? []).find((s) => s.name === 'designer-pack')?.signInAvailable === false
    && (listed?.servers ?? []).find((s) => s.name === 'claude.ai Figma')?.signInAvailable === true,
    (listed?.servers ?? []).map((s) => `${s.name}:${s.signInAvailable}`).join(' | '));

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
  await chat.keyboard.press('Escape');
  await chat.keyboard.press('Enter');
  // Waiting on ROWS, not on the list container: the container is rendered from the first
  // paint, so waiting on it would only prove the component mounted.
  ok('the panel opens and fills with what the session reported',
    await until(chat, async () => (await chat.locator('.mcp-row').count()) > 0, 40000));
  /** Everything the CLI was asked from here on is the UI's doing. */
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
  console.log('\n── §2 the panel reports the SESSION, not a config directory');
  const rows = (await chat.locator('.mcp-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  ok(`every server has a row (${rows.length})`, rows.length === SERVERS.length, rows.join(' || '));
  ok('the team-shared one says so', rows.some((t) => t.includes('probe-project-scope') && t.includes('shared with the repo')),
    rows.find((t) => t.includes('probe-project-scope')));
  ok('a machine-only one says THAT', rows.some((t) => t.includes('playwright') && t.includes('this machine')),
    rows.find((t) => t.includes('playwright')));
  ok('only the rows a button can help get one',
    (await chat.locator('.mcp-act').count()) === 4,
    `${await chat.locator('.mcp-act').count()} buttons`);
  ok('the stranded server is EXPLAINED rather than given a button that cannot work',
    (await chat.locator('.mcp-foot--warn').count()) === 1
    && (await chat.locator('.mcp-foot--warn').first().innerText()).includes('designer-pack'),
    await chat.locator('.mcp-foot--warn').first().innerText().catch(() => '(absent)'));
  await chat.screenshot({ path: join(SHOTS, '01-mcp-panel.png') });
  report.note('📸 01-mcp-panel.png');

  // ── §3 the sign-in ────────────────────────────────────────────────────────────────
  console.log('\n── §3 the sign-in runs the real command, in the project, for the right server');
  const figmaRow = chat.locator('.mcp-row', { hasText: 'claude.ai Figma' }).first();
  await figmaRow.locator('.mcp-act').click();
  ok('the row flips to Connected once the session says it is',
    await until(chat, async () => (await figmaRow.innerText()).includes('Connected'), 25000),
    (await figmaRow.innerText()).replace(/\s+/g, ' '));

  const loginCalls = uiCalls().filter((c) => c.sub === 'login');
  ok('`claude mcp login` ran exactly once', loginCalls.length === 1, JSON.stringify(loginCalls.map((c) => c.argv)));
  ok('…for the server the user clicked, name byte-for-byte',
    loginCalls[0]?.argv?.join(' ') === 'mcp login claude.ai Figma', JSON.stringify(loginCalls[0]?.argv));
  ok('…in the PROJECT, which is what makes a repo-defined server a valid target',
    samePath(loginCalls[0]?.cwd), loginCalls[0]?.cwd);
  ok('…and the verdict came from re-reading the SESSION, not from the exit code',
    uiCalls().some((c) => c.sub === 'probe'),
    uiCalls().map((c) => c.sub).join(' → '));

  // ── §4 an abandoned login ─────────────────────────────────────────────────────────
  console.log('\n── §4 a login abandoned in the browser is not reported as success');
  const calRow = chat.locator('.mcp-row', { hasText: 'claude.ai Google Calendar' }).first();
  await calRow.locator('.mcp-act').click();
  ok('the abandoned sign-in leaves the row unchanged',
    await until(chat, async () => {
      const t = await calRow.innerText();
      return t.includes('Needs sign-in') && !t.includes('Signing in…');
    }, 25000),
    (await calRow.innerText()).replace(/\s+/g, ' '));
  ok('…and the panel says so rather than claiming a connection',
    !(await calRow.innerText()).includes('Connected'),
    (await calRow.innerText()).replace(/\s+/g, ' '));
  await chat.screenshot({ path: join(SHOTS, '02-after-signin.png') });
  report.note('📸 02-after-signin.png');

  const uiConversation = uiCalls().map((c) => c.sub).join(' → ');

  // ── §5 nothing from the login child surfaces ──────────────────────────────────────
  console.log('\n── §5 the login child\'s output never reaches the surface');
  const dom = await chat.content();
  ok('the callback URL with its authorization code is nowhere in the DOM',
    !dom.includes('VERIFY-CANARY-DO-NOT-SURFACE'), 'canary found in page HTML');
  const reBody = await (await fetch(`${base}/api/agent/mcp?vault=acme-payments`)).text();
  ok('…nor in any API response', !reBody.includes('VERIFY-CANARY-DO-NOT-SURFACE'));
  ok('…and Figma is genuinely connected upstream, so §3 was not a UI-only flip',
    JSON.parse(reBody).servers.find((s) => s.name === 'claude.ai Figma')?.status === 'connected');

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

  ok('the panel asked for exactly what the user clicked, each verdict re-read',
    uiConversation === 'login → probe → login → probe', uiConversation);

  // ── §7 a `dynamic` server cannot be signed into, and the panel does not pretend ────
  console.log('\n── §7 the panel never offers a button that cannot work');
  const strandedLogin = await fetch(`${base}/api/agent/mcp/login?vault=acme-payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'acme-payments' },
    body: JSON.stringify({ name: 'designer-pack', account: '' }),
  });
  const strandedBody = await strandedLogin.json();
  ok('a forced sign-in for a by-reference server ANSWERS, and not with a connection',
    strandedLogin.ok && strandedBody?.status !== 'connected'
      && typeof strandedBody?.status === 'string',
    `${strandedLogin.status} ${JSON.stringify(strandedBody)}`);

  // ── §8 Settings: sharing with the repo, and what it refuses ───────────────────────
  console.log('\n── §8 Settings shares a server with the repo — and refuses to publish a secret');
  const projRes = await fetch(`${base}/api/agent/mcp/project?vault=acme-payments`);
  const proj = await projRes.json();
  ok('the project starts with nothing shared', proj?.servers?.length === 0, JSON.stringify(proj?.servers));
  ok('…and offers this machine\'s servers as candidates',
    (proj?.candidates ?? []).map((c) => c.name).sort().join(',') === 'designer-pack,playwright',
    (proj?.candidates ?? []).map((c) => c.name).join(','));
  ok('a candidate whose header is a literal secret says what it would need',
    (proj?.candidates ?? []).find((c) => c.name === 'designer-pack')?.wouldRequire?.includes('DESIGNER_PACK_AUTHORIZATION'),
    JSON.stringify((proj?.candidates ?? []).find((c) => c.name === 'designer-pack')));

  const adopt = await (await fetch(`${base}/api/agent/mcp/project/adopt?vault=acme-payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'acme-payments' },
    body: JSON.stringify({ name: 'designer-pack' }),
  })).json();
  ok('sharing it writes the repo file', adopt?.servers?.some((s) => s.name === 'designer-pack'),
    JSON.stringify(adopt).slice(0, 300));
  ok('…and reports the variable the team must now set',
    (adopt?.requires ?? []).includes('DESIGNER_PACK_AUTHORIZATION'), JSON.stringify(adopt?.requires));

  let written = '';
  try { written = readFileSync(join(PROJ, '.mcp.json'), 'utf-8'); } catch { written = '(file absent)'; }
  ok('THE SECRET IS NOT IN THE REPO FILE — the whole point of the refusal',
    !written.includes('literal-secret-must-not-be-published'), written.slice(0, 200));
  ok('…it became a ${VAR} reference instead',
    written.includes('${DESIGNER_PACK_AUTHORIZATION}'), written.slice(0, 200));
  ok('…and the API response never carried the secret either',
    !JSON.stringify(adopt).includes('literal-secret-must-not-be-published'));

  const removed = await (await fetch(`${base}/api/agent/mcp/project/remove?vault=acme-payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'acme-payments' },
    body: JSON.stringify({ name: 'designer-pack' }),
  })).json();
  ok('stop-sharing takes it back out',
    Array.isArray(removed?.servers) && removed.servers.length === 0,
    JSON.stringify(removed).slice(0, 200));

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
