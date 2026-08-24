#!/usr/bin/env node
/**
 * "I switched Claude accounts and my open sessions followed" — end-to-end verification.
 *
 *   npm run build && npm run verify:claude-auth-switch
 *
 * THE BUG THIS PROVES FIXED. A spawned `claude` reads its credentials once, at startup. So
 * `claude auth login` into another account changed nothing for a chat that was already open:
 * it kept talking to the API as the account the user had just left, billed to it and
 * rate-limited by it, with nothing on screen saying so. The only cure is a process restart.
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/api/agent/chat` WebSocket, the real
 * `/api/agent/capabilities` route, and (theme 2) the real React surface in Chromium. Nothing
 * is imported and called directly; every assertion is made against bytes on the wire or
 * pixels in the app.
 *
 * WHAT IT DOES NOT SPEND — tokens, or the developer's real credentials. `claude` is replaced,
 * for this run only, by a scripted stand-in in an isolated fake HOME
 * (`$SCRATCH/home/.local/bin/claude`), which is what `claudeAwarePath()` resolves from
 * `homedir()`. That stand-in is BOTH halves of the substitution: it answers
 * `auth status --json` from a control file this script rewrites, and it plays a minimal
 * stream-json engine so a session can be open to be restarted. It logs every argv it is
 * called with, which is how the restart is proven to have carried the SAME conversation id
 * rather than silently starting a new conversation.
 *
 * The switch itself is performed exactly the way a real one appears to the app: the account
 * identity in `~/.claude.json` changes (`oauthAccount.accountUuid` / `emailAddress` — the
 * cheap trigger, verified 2026-08-24 to mirror what the CLI reports) and `claude auth status`
 * starts answering with the new account (the authoritative judge).
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST, matching verify/chat-steer.mjs: every check
 * prints ✓/✗ with evidence and the run continues, so one invocation reports everything that
 * is broken. Exit code is 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-claude-auth-switch');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
/** What the stand-in answers `auth status --json` with. Rewritten to perform a switch. */
const AUTH_CONTROL = join(HOME, '.auth-status.json');
/** One line per stand-in invocation: `<kind>\t<argv…>`. The restart evidence. */
const SPAWN_LOG = join(HOME, 'spawns.log');

const ACCOUNT_A = {
  accountUuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  emailAddress: 'first@example.com',
  organizationUuid: 'org-aaaa-1111',
  subscriptionType: 'max',
};
const ACCOUNT_B = {
  accountUuid: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  emailAddress: 'second@example.com',
  organizationUuid: 'org-bbbb-2222',
  subscriptionType: 'team',
};
const ACCOUNT_C = {
  accountUuid: 'cccccccc-3333-4333-8333-cccccccccccc',
  emailAddress: 'third@example.com',
  organizationUuid: 'org-cccc-3333',
  subscriptionType: 'pro',
};

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// Kept as a string rather than a checked-in file so the stand-in and the assertions that read
// its log can never drift apart, and so it can pick up the running node's absolute path (the
// login shell the server spawns has no guaranteed nvm on PATH).
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude\` — see scripts/verify/claude-auth-switch.mjs. */
const fs = require('node:fs');
const path = require('node:path');
const HOME = process.env.HOME;
const argv = process.argv.slice(2);
const log = (kind) => {
  try { fs.appendFileSync(path.join(HOME, 'spawns.log'), kind + '\\t' + argv.join(' ') + '\\n'); }
  catch { /* best-effort */ }
};

// (1) The auth probe. Answers whatever the control file currently holds — this is the
//     authoritative half of a switch, and rewriting that file IS performing one.
if (argv[0] === 'auth' && argv[1] === 'status') {
  log('auth');
  try { process.stdout.write(fs.readFileSync(path.join(HOME, '.auth-status.json'), 'utf-8')); }
  catch { process.stdout.write('{}'); }
  process.exit(0);
}

// (2) The engine. Only \`-p --input-format stream-json\` matters here; anything else (a
//     --help probe for the model picker) exits quietly rather than confusing the surface.
if (!argv.includes('--input-format')) { log('other'); process.exit(0); }
log('engine');

// Give the conversation a transcript on disk, so a respawn takes the REAL \`--resume\` path
// (\`claudeConversationExists\`) instead of the fresh-pin fallback — otherwise this script
// would be proving the restart against an easier code path than production's.
const idFlag = argv.indexOf('--session-id') !== -1 ? argv.indexOf('--session-id') : argv.indexOf('--resume');
const convId = idFlag !== -1 ? argv[idFlag + 1] : null;
if (convId) {
  const dir = path.join(HOME, '.claude', 'projects', 'verify');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, convId + '.jsonl');
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ sessionId: convId, type: 'summary' }) + '\\n');
  } catch { /* best-effort */ }
}

const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    // The CLI withholds system:init until the first stdin frame — mirrored here so the
    // client's handshake is the real one.
    out({ type: 'system', subtype: 'init', session_id: convId || 'verify', model: 'claude-opus-5',
          permissionMode: 'auto', slash_commands: ['/login'], claude_code_version: '2.1.220' });
    out({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5',
          content: [{ type: 'text', text: 'ack' }] } });
    // "HOLD" starts a turn that never ends, so the surface stays BUSY — that is how the
    // script gets a session in the one state where a restart has to be DEFERRED.
    if (JSON.stringify(o.message || {}).includes('HOLD')) continue;
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 });
  }
});
// Idle forever otherwise: the point of this stand-in is to BE an open session that the
// account switch has to reach.
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

// ─── setup ────────────────────────────────────────────────────────────────────────────

function authStatusFor(account) {
  return JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: account.emailAddress,
    orgId: account.organizationUuid,
    orgName: 'Verify Org',
    subscriptionType: account.subscriptionType,
  }, null, 2);
}

/** A realistic `~/.claude.json`: the identity block plus the counters the CLI churns. */
function claudeJsonFor(account, noise = 1) {
  return JSON.stringify({
    numStartups: noise,
    tipsHistory: { 'shift-enter': noise },
    hasCompletedOnboarding: true,
    oauthAccount: {
      accountUuid: account.accountUuid,
      emailAddress: account.emailAddress,
      organizationUuid: account.organizationUuid,
      // Moves on its own schedule and must NOT read as a switch.
      profileFetchedAt: new Date(1_760_000_000_000 + noise * 60_000).toISOString(),
      organizationName: 'Verify Org',
      seatTier: 'team_tier_1',
    },
  });
}

function setAccount(account, noise) {
  writeFileSync(AUTH_CONTROL, authStatusFor(account));
  writeFileSync(join(HOME, '.claude.json'), claudeJsonFor(account, noise));
}

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
  mkdirSync(join(HOME, '.claude', 'projects', 'verify'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  writeFileSync(SPAWN_LOG, '');
  setAccount(ACCOUNT_A, 1);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  // A PATH without the REAL claude's directory, so the only `claude` anything can resolve is
  // the stand-in `claudeAwarePath()` appends from the fake HOME.
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawnLines = () => (existsSync(SPAWN_LOG) ? readFileSync(SPAWN_LOG, 'utf-8').split('\n').filter(Boolean) : []);
const engineSpawns = () => spawnLines().filter((l) => l.startsWith('engine\t'));
const authSpawns = () => spawnLines().filter((l) => l.startsWith('auth\t'));
/** The conversation uuid an engine spawn was launched against. */
const convIdOf = (line) => (line.match(/--(?:session-id|resume) ([0-9a-f-]{36})/) ?? [])[1] ?? null;

/** Open a chat WS and collect every `_meta` frame it is sent. */
async function openChat(WebSocket, port, sessionId) {
  const url = `ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&sessionId=${sessionId}`;
  const ws = new WebSocket(url);
  const metas = [];
  ws.on('message', (raw) => {
    let o; try { o = JSON.parse(raw.toString('utf-8')); } catch { return; }
    if (o && o.type === '_meta') metas.push(o);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('chat ws did not open')), 15_000);
  });
  return { ws, metas, authFrames: () => metas.filter((m) => m.subtype === 'auth_changed') };
}

// ─── the wire assertions ──────────────────────────────────────────────────────────────

async function runWire(port, report) {
  const ok = (label, cond, detail) => report.check('wire', label, cond, detail);
  const { WebSocket } = await import('ws');
  const caps = () => fetch(`http://127.0.0.1:${port}/api/agent/capabilities`).then((r) => r.json());

  console.log('\n═══ wire: the server detects the switch and pushes it ═══');

  const first = await caps();
  ok('capabilities reports the CLI signed in as account A',
    first?.claudeAuth?.loggedIn === true && first.claudeAuth.email === ACCOUNT_A.emailAddress,
    JSON.stringify(first?.claudeAuth));
  ok('…and carries the account-watcher epoch, so a poller can spot a change without diffing strings',
    typeof first?.claudeAuth?.epoch === 'number', `epoch=${first?.claudeAuth?.epoch}`);
  const epochA = first?.claudeAuth?.epoch ?? -1;

  const convA = randomUUID();
  const a = await openChat(WebSocket, port, convA);
  await sleep(1500);
  ok('a chat session opens against the real WS route and stays up', a.ws.readyState === 1);
  const spawnedFirst = engineSpawns();
  ok('…and really spawned the CLI, pinned to its conversation id',
    spawnedFirst.length === 1 && convIdOf(spawnedFirst[0]) === convA, spawnedFirst[0]);

  // ── The false positive that would make this feature unusable ────────────────────────
  // `~/.claude.json` is rewritten constantly by the CLI itself (counters, tips, usage
  // caches). If any of that read as a switch, every live session would be killed for
  // nothing — so this is checked BEFORE the real switch, on the same open socket.
  console.log('── a same-account rewrite must be silent');
  const authBefore = authSpawns().length;
  setAccount(ACCOUNT_A, 2);          // new mtime, new counters, SAME account
  await sleep(4000);
  ok('rewriting ~/.claude.json with the same account pushes NOTHING',
    a.authFrames().length === 0, JSON.stringify(a.authFrames()));
  ok('…and does not even pay for a probe (the identity fingerprint is an allowlist)',
    authSpawns().length === authBefore, `${authBefore} → ${authSpawns().length}`);

  // ── The switch ──────────────────────────────────────────────────────────────────────
  console.log('── switching to account B');
  setAccount(ACCOUNT_B, 3);
  const gotFrame = await (async () => {
    const end = Date.now() + 20_000;
    while (Date.now() < end) { if (a.authFrames().length) return true; await sleep(250); }
    return false;
  })();
  ok('the OPEN session is told, unprompted, within seconds', gotFrame);
  const frame = a.authFrames()[0] ?? {};
  ok('the frame names the new account authoritatively',
    typeof frame.identity === 'string' && frame.identity.includes(ACCOUNT_B.emailAddress),
    JSON.stringify(frame));
  ok('…and says a restart is warranted (a confirmed sign-in, so it would actually help)',
    frame.restart === true && frame.loggedIn === true, JSON.stringify(frame));
  ok('exactly ONE frame — a switch is announced once, not once per poll tick',
    a.authFrames().length === 1, `${a.authFrames().length} frames`);

  const after = await caps();
  ok('capabilities now reports account B',
    after?.claudeAuth?.email === ACCOUNT_B.emailAddress, JSON.stringify(after?.claudeAuth));
  ok('…and its epoch advanced, so a surface with no chat open can see it too',
    (after?.claudeAuth?.epoch ?? -1) > epochA, `${epochA} → ${after?.claudeAuth?.epoch}`);

  // ── The epoch guard ─────────────────────────────────────────────────────────────────
  // A session spawned AFTER the switch already holds the new credentials. Telling it to
  // restart would be a pointless reconnect — and the kind of bug that only shows up as
  // "why did my brand-new tab reload itself?".
  console.log('── a session opened AFTER the switch must not be told about it');
  const b = await openChat(WebSocket, port, randomUUID());
  await sleep(5000);
  ok('a chat opened after the switch receives no auth_changed at all',
    b.authFrames().length === 0, JSON.stringify(b.authFrames()));
  ok('…while the pre-existing session still holds its single frame',
    a.authFrames().length === 1);

  a.ws.close();
  b.ws.close();
  await sleep(500);
}

// ─── the UI assertions ────────────────────────────────────────────────────────────────

async function runUi(chromium, base, report) {
  const ok = (label, cond, detail) => report.check('ui', label, cond, detail);
  console.log('\n═══ ui: the open chat restarts itself onto the new account ═══');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(200); }
    return false;
  };

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  ok('a chat pane is open in the real app', await until(async () => (await vis('.chat-cmp-input').count()) > 0));
  await page.waitForTimeout(2500);

  const before = engineSpawns();
  const convId = before.length ? convIdOf(before[before.length - 1]) : null;
  ok('the pane is backed by a real CLI process with a conversation id', !!convId, String(convId));

  console.log('── switching to account B while the pane is open and idle');
  setAccount(ACCOUNT_B, 11);

  ok('the surface says so, naming the new account',
    await until(async () => {
      const n = await vis('.agent-auth-strip').count();
      if (!n) return false;
      return (await vis('.agent-auth-strip').first().innerText()).includes(ACCOUNT_B.emailAddress);
    }, 25_000),
    (await vis('.agent-auth-strip').first().innerText().catch(() => '(no strip)')).replace(/\s+/g, ' '));

  const restarted = await until(() => Promise.resolve(engineSpawns().length > before.length), 25_000);
  ok('the open chat restarted itself — a NEW CLI process was spawned, with nobody clicking anything',
    restarted, `${before.length} → ${engineSpawns().length} engine spawns`);

  const last = engineSpawns()[engineSpawns().length - 1] ?? '';
  ok('…on the SAME conversation, so the transcript is not abandoned',
    convIdOf(last) === convId, last);
  ok('…and it took the real --resume path, exactly as production does',
    / --resume /.test(last), last);
  ok('the restarted pane is usable again (a live composer, not a dead session)',
    await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20_000));

  const strip = (await vis('.agent-auth-strip').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('the strip states the restart rather than leaving a reconnect unexplained',
    /restarted/i.test(strip), strip);
  await vis('.agent-auth-strip').getByRole('button', { name: 'Dismiss' }).click().catch(() => {});
  ok('and it can be dismissed', await until(async () => (await vis('.agent-auth-strip').count()) === 0, 5000));

  // ── A switch DURING a turn waits for it, and a tab closed meanwhile is not resurrected ──
  //
  // Both halves of one scenario, because they are the same edge. A turn already in flight was
  // authorized by the old credentials and will finish on them, so the restart is deferred to
  // the turn boundary — and the boundary the client sees is `busy` going false. Closing the
  // tab ALSO makes it go false (the socket teardown does). Without the registry guard in
  // `armAuthRestart`, that indistinguishable edge would spawn a live `claude` behind a tab
  // that no longer exists in the roster or in any pane: invisible, and unclosable.
  console.log('── a switch during a BUSY turn defers; closing that tab must strand nothing');
  const composer = () => vis('.chat-cmp-input').first();
  await composer().click();
  await composer().fill('HOLD');           // the stand-in never ends this turn
  await page.waitForTimeout(250);          // let React adopt the draft before ⏎ reads it
  await page.keyboard.press('Enter');
  // The 0.25 composer renders Stop as the SEND button in its stop state (`chat-cmp-send
  // is-stop`), not as a separate control — so "is a turn in flight?" is that one modifier.
  const inFlight = async () => (await vis('.chat-cmp-send.is-stop').count()) > 0;
  ok('a turn is in flight', await until(inFlight, 15_000));
  const midTurn = engineSpawns().length;

  setAccount(ACCOUNT_C, 12);
  ok('the switch is announced even though the session is busy',
    await until(async () => {
      if (!(await vis('.agent-auth-strip').count())) return false;
      return (await vis('.agent-auth-strip').first().innerText()).includes(ACCOUNT_C.emailAddress);
    }, 25_000));
  const busyStrip = (await vis('.agent-auth-strip').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('…and says the restart is waiting for the turn, not that it already happened',
    /as soon as they finish/i.test(busyStrip), busyStrip);
  ok('the in-flight turn was NOT thrown away — no respawn yet',
    engineSpawns().length === midTurn, `${midTurn} → ${engineSpawns().length} engine spawns`);
  ok('…and the turn is still running', await inFlight());

  const closer = vis('.agent-tab-btn.close').first();
  if (await closer.count()) await closer.click({ force: true });
  else await page.keyboard.press('Meta+w').catch(() => {});
  await page.waitForTimeout(1500);
  ok('the chat tab is closed mid-turn', (await vis('.chat-cmp-input').count()) === 0);
  await page.waitForTimeout(10_000);
  ok('closing it cancelled the pending restart instead of stranding a process behind a dead tab',
    engineSpawns().length === midTurn, `${midTurn} → ${engineSpawns().length} engine spawns`);

  await browser.close();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0,
  fails: [],
  notes: [],
  check(theme, label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(`[${theme}] ${label}`); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

let server = null;
try {
  const { chromium } = await import('@playwright/test');
  console.log('· setting up scratch vault + scripted claude…');
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  await runWire(port, report);

  // A FRESH server for the UI half. The account watcher is a process-wide singleton holding
  // "which account we last saw", and the wire half deliberately left it on account B — so
  // reusing it would make the UI half's first tick discover the reset-to-A as a switch of its
  // own, and its spawn counts would be measuring two overlapping restarts. Restarting is the
  // honest way to get a clean baseline; suppressing the announcement would be testing a
  // different program than the one that ships.
  server.kill();
  await sleep(1500);
  rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
  setAccount(ACCOUNT_A, 10);
  writeFileSync(SPAWN_LOG, '');
  const uiPort = await freePort();
  console.log(`· restarting the server on ${uiPort} for the UI half…`);
  server = await startServer(uiPort);
  await runUi(chromium, `http://127.0.0.1:${uiPort}`, report);
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
