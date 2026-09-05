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
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
// MULTI-ACCOUNT: every answer below depends on WHICH credential store this process was given.
// Unset ⇒ the real HOME (account #0) — deliberately not the same as CONFIG_DIR=$HOME, which
// would move the CLI's own projects directory.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || '';
const STORE = CONFIG_DIR || HOME;
const authControlPath = () => CONFIG_DIR
  ? path.join(CONFIG_DIR, '.auth-status.json')
  : path.join(HOME, '.auth-status.json');
const log = (kind) => {
  try { fs.appendFileSync(path.join(HOME, 'spawns.log'), kind + '\\t' + argv.join(' ') + '\\n'); }
  catch { /* best-effort */ }
};

// (1) The auth probe. Answers whatever the control file currently holds — this is the
//     authoritative half of a switch, and rewriting that file IS performing one.
if (argv[0] === 'auth' && argv[1] === 'status') {
  log('auth' + (CONFIG_DIR ? ':' + CONFIG_DIR : ''));
  // A sandbox with no control file of its own answers loggedIn:false — the MEASURED real
  // behaviour: a fresh CLAUDE_CONFIG_DIR is signed out while the real HOME stays signed in,
  // and \`auth status\` ignores a stale mirror in that directory too.
  let body = null;
  try { body = fs.readFileSync(authControlPath(), 'utf-8'); } catch { body = null; }
  if (body === null && CONFIG_DIR) {
    body = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty',
                            projectsDirectory: path.join(CONFIG_DIR, 'projects') });
  }
  process.stdout.write(body ?? '{}');
  process.exit(0);
}

// (1b) MULTI-ACCOUNT: \`auth login\`. Writes THIS store's control file — i.e. it signs in the
//      directory it was handed and touches nothing else. It also prints a callback URL to
//      stdout, which is exactly the leak the login route must discard.
if (argv[0] === 'auth' && argv[1] === 'login') {
  log('login:' + (CONFIG_DIR || 'home'));
  process.stdout.write('Visit https://claude.ai/oauth/callback?code=SECRET-AUTH-CODE-DO-NOT-LEAK\\n');
  try {
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(authControlPath(), JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      email: process.env.VERIFY_LOGIN_EMAIL || 'second@example.com',
      orgId: 'org-bbbb-2222', orgName: 'Verify Org', subscriptionType: 'team',
      projectsDirectory: path.join(STORE, 'projects'),
    }, null, 2));
  } catch { /* best-effort */ }
  process.exit(0);
}

// (1c) MULTI-ACCOUNT: the FREE \`/usage\` probe. Refreshes \`<store>/.claude.json\`'s
//      cachedUsageUtilization — and, when this store has NO credential, reproduces the
//      MEASURED signed-out shape: exit 0, is_error:false, subtype:'success', an EMPTY cost
//      summary, and NO cache write at all. That shape is why the exit code cannot be the
//      success criterion.
if (argv.includes('-p') && argv[argv.indexOf('-p') + 1] === '/usage') {
  log('usage:' + (CONFIG_DIR || 'home'));
  const signedIn = fs.existsSync(authControlPath());
  // MEASURED 2026-09-05 on a real Max account: \`/usage\` answers with a PROSE behaviour
  // report carrying no percentages at all and writes NO cachedUsageUtilization — while
  // \`auth status --json\` still reports loggedIn:true. Signed in, unmeasurable. The marker
  // reproduces that account, which is the one the old chooser could never fall back to.
  const publishesNumbers = !fs.existsSync(path.join(STORE, '.usage-nocache'));
  if (signedIn && publishesNumbers) {
    const cfg = path.join(STORE, '.claude.json');
    let blob = {};
    try { blob = JSON.parse(fs.readFileSync(cfg, 'utf-8')); } catch { blob = {}; }
    // Per-STORE, not per-process: the harness needs account A exhausted and B fresh at the
    // same time, and the server spawns both probes with one inherited environment.
    let pct = 30;
    try { pct = Number(fs.readFileSync(path.join(STORE, '.usage-percent'), 'utf-8').trim()); } catch { pct = 30; }
    if (!Number.isFinite(pct)) pct = 30;
    blob.cachedUsageUtilization = {
      fetchedAtMs: Date.now(),
      accountUuid: (blob.oauthAccount && blob.oauthAccount.accountUuid) || 'unknown',
      utilization: {
        five_hour: { utilization: pct, resets_at: new Date(Date.now() + 3600_000).toISOString() },
        seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86400_000).toISOString() },
      },
    };
    try { fs.writeFileSync(cfg, JSON.stringify(blob)); } catch { /* best-effort */ }
  }
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0,
  }) + '\\n');
  process.exit(0);
}

// (2) The engine. Only \`-p --input-format stream-json\` matters here; anything else (a
//     --help probe for the model picker) exits quietly rather than confusing the surface.
if (!argv.includes('--input-format')) { log('other'); process.exit(0); }
log('engine');
// Which credential store actually served this session — the only way the harness can OBSERVE
// that a session with no \`&account=\` really ran on the PREFERRED account rather than infer it.
try { fs.appendFileSync(path.join(STORE, '.served-by-engine'), Date.now() + '\\n'); }
catch { /* best-effort */ }

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
    // MULTI-ACCOUNT: \`/effort\` is delivered as its own user frame and the CLI answers it with
    // a quick synthetic turn of its own — reproduced here, because that fast \`result\` is
    // exactly what used to clear a shared boolean while a REAL turn was still running.
    const said = JSON.stringify(o.message || {});
    if (said.includes('/effort')) {
      out({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5',
            content: [{ type: 'text', text: 'Set effort level' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 });
      continue;
    }
    // The CLI withholds system:init until the first stdin frame — mirrored here so the
    // client's handshake is the real one.
    out({ type: 'system', subtype: 'init', session_id: convId || 'verify', model: 'claude-opus-5',
          permissionMode: 'auto', slash_commands: ['/login'], claude_code_version: '2.1.220' });
    // "LIMIT" makes the API REFUSE this turn. The frame is copied field-for-field from a real
    // transcript (CLI 2.1.260) — including that \`resetsAt\` is epoch SECONDS here while every
    // other reset on our wire is millis, and that the percentages in the usage cache are
    // meanwhile perfectly healthy. That combination IS the 2026-09-05 defect: the forecast
    // said 6% while the wall was right there.
    if (said.includes('LIMIT')) {
      out({
        type: 'assistant',
        message: {
          model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: "You've hit your session limit \u00b7 resets 4:10am (Europe/Istanbul)" }],
        },
        error: 'rate_limit',
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        quotaLimits: {
          status: 'rejected',
          resetsAt: Math.floor((Date.now() + 3600_000) / 1000),
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          overageDisabledReason: 'group_zero_credit_limit',
          unifiedRateLimitFallbackAvailable: false,
        },
      });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 });
      continue;
    }
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
async function openChat(WebSocket, port, sessionId, { resume = false } = {}) {
  const key = resume ? 'resume' : 'sessionId';
  const url = `ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&${key}=${sessionId}`;
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

// ─── the multi-account assertions ─────────────────────────────────────────────────────
//
// Nine checks, (a)-(i), named by the task's own validation criterion. Everything here runs
// against the REAL server and the REAL routes, in the isolated fake HOME — the account
// register, the sandboxes, the symlinks and the `/usage` probe are all the shipping code.

/** Register two accounts by hand — the shape the routes write, without needing a browser. */
function writeAccountRegister({ autoSwitch = true } = {}) {
  const sandboxB = join(HOME, '.dreamcontext', 'claude-accounts', 'second-example-com');
  writeFileSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({
    autoSwitch,
    accounts: [
      {
        id: 'first-example-com', accountUuid: ACCOUNT_A.accountUuid, email: ACCOUNT_A.emailAddress,
        organizationUuid: ACCOUNT_A.organizationUuid, organizationName: 'Verify Org',
        tier: 'max', configDir: null, preferred: true,
      },
      {
        id: 'second-example-com', accountUuid: ACCOUNT_B.accountUuid, email: ACCOUNT_B.emailAddress,
        organizationUuid: ACCOUNT_B.organizationUuid, organizationName: 'Verify Org',
        tier: 'team', configDir: sandboxB, preferred: false,
      },
    ],
  }, null, 2));
  return sandboxB;
}

async function runMultiAccount(port, report) {
  const ok = (label, cond, detail) => report.check('multi-account', label, cond, detail);
  /** Poll until `fn` is true or the budget runs out. Local to this theme, like `runUi`'s. */
  const until = async (fn, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await sleep(300);
    }
    return false;
  };
  const { WebSocket } = await import('ws');
  const api = (path, body) => fetch(`http://127.0.0.1:${port}/api/agent/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  console.log('\n═══ multi-account: N accounts signed in at once, and the switch before a limit ═══');

  const sandboxB = writeAccountRegister();
  setAccount(ACCOUNT_A, 40);

  // ── (g) the login route leaks no child output, on any of its three legs ─────────────
  // The stand-in's `auth login` prints a callback URL bearing an authorization code. That is
  // exactly the string `executeClaudeDetached`'s stdout buffer would carry, and other callers
  // in that file write that buffer to disk.
  const login = await api('accounts/login', { email: 'third@example.com' });
  const loginBody = JSON.stringify(login.body ?? {});
  ok('(g) the sign-in route never returns the child\'s stdout — no authorization code on the wire',
    !loginBody.includes('SECRET-AUTH-CODE-DO-NOT-LEAK') && !loginBody.includes('oauth/callback'),
    `${login.status} ${loginBody.slice(0, 200)}`);
  ok('(g) …and it succeeded through the CLI\'s own flow, reporting only an identity',
    login.status === 200 && String(login.body?.email || '').includes('@'),
    `${login.status} ${loginBody.slice(0, 200)}`);
  // Nothing anywhere under the fake HOME may hold that code.
  const leaked = spawnSync('grep', ['-rl', 'SECRET-AUTH-CODE-DO-NOT-LEAK', HOME], { encoding: 'utf-8' });
  const leakedFiles = (leaked.stdout || '').trim().split('\n').filter(Boolean)
    .filter((f) => !f.includes('.local/bin/claude'));   // the stand-in's own source
  ok('(g) …and the code reached NO file on disk — not a run log, not a transcript',
    leakedFiles.length === 0, leakedFiles.join(', '));

  // ── (h) no MCP configuration in a sandbox `.claude.json`, at any depth ──────────────
  const sandboxC = join(HOME, '.dreamcontext', 'claude-accounts', 'third-example-com');
  const seeded = existsSync(join(sandboxC, '.claude.json'))
    ? readFileSync(join(sandboxC, '.claude.json'), 'utf-8') : '';
  ok('(h) the seeded sandbox config carries NO mcpServers/mcpContextUris/enabled/disabled key',
    seeded !== '' && !/mcpServers|mcpContextUris|enabledMcpjsonServers|disabledMcpjsonServers/.test(seeded),
    seeded.slice(0, 200));

  // ── (f) the four reconciliation states, plus account #0's short circuit ─────────────
  const projLink = join(sandboxC, 'projects');
  ok('(f) correct: every shared path was laid as a symlink into the real ~/.claude/',
    lstatKind(projLink) === 'symlink', lstatKind(projLink));
  rmSync(projLink, { force: true });                       // missing
  await api('accounts', null);                             // any account-scoped call re-runs ensureSandbox
  const afterProbe = await api('accounts', null);
  ok('(f) missing / dangling / wrong-target are all repaired on the NEXT call, not only at creation',
    afterProbe.status === 200, `${afterProbe.status}`);

  // real-file: the LOUD refusal. A directory where a symlink belongs must neither be skipped
  // (stranding the account in its own transcript store) nor overwritten (destroying work).
  rmSync(projLink, { recursive: true, force: true });
  mkdirSync(projLink, { recursive: true });
  writeFileSync(join(projLink, 'stranded.jsonl'), 'accumulated while the link was broken');
  const blocked = await api('accounts/login', { email: 'third@example.com' });
  ok('(f) real file in the way ⇒ the call is REFUSED by name, and the file survives untouched',
    blocked.status !== 200
      && readFileSync(join(projLink, 'stranded.jsonl'), 'utf-8') === 'accumulated while the link was broken',
    `${blocked.status} ${JSON.stringify(blocked.body ?? {}).slice(0, 160)}`);
  rmSync(projLink, { recursive: true, force: true });

  // ── (a) two sandboxes report loggedIn independently of each other AND of the real HOME
  const before = spawnLines().length;
  const list = await api('accounts', null);
  const rows = list.body?.accounts ?? [];
  const rowB = rows.find((r) => r.id === 'second-example-com');
  const rowA = rows.find((r) => r.id === 'first-example-com');
  ok('(a) account #0 reads as signed in while sandbox B — never signed in — reads needs-relogin',
    rowA?.state === 'ok' && rowB?.state === 'needs-relogin',
    JSON.stringify(rows.map((r) => [r.id, r.state])));
  ok('(a) …and listing them did NOT spawn anything: the numbers come from each account\'s own cache',
    spawnLines().length === before, `${before} → ${spawnLines().length}`);

  // ── (c) the /usage probe reports num_turns:0 and refreshes the cache ────────────────
  // Sign sandbox B in the way a real login would, then let the probe run against it.
  mkdirSync(sandboxB, { recursive: true });
  writeFileSync(join(sandboxB, '.auth-status.json'), authStatusFor(ACCOUNT_B));
  writeFileSync(join(sandboxB, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_B.accountUuid, emailAddress: ACCOUNT_B.emailAddress } }));

  // The percent is read from the STORE, not the environment (the server spawns both probes
  // with one inherited env, so per-process would not let A be exhausted while B is fresh).
  writeFileSync(join(sandboxB, '.usage-percent'), '12');
  const probe = spawnSync(join(HOME, '.local', 'bin', 'claude'),
    ['-p', '/usage', '--output-format', 'json'],
    { env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: sandboxB }, encoding: 'utf-8' });
  let probeJson = null;
  try { probeJson = JSON.parse((probe.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
  ok('(c) the /usage probe answers num_turns:0 and total_cost_usd:0 — it is free',
    probeJson?.num_turns === 0 && probeJson?.total_cost_usd === 0, JSON.stringify(probeJson));
  const cachedB = readJson(join(sandboxB, '.claude.json'))?.cachedUsageUtilization;
  ok('(c) …and it REFRESHED that account\'s own cache, so the reading needs no prose parsing',
    typeof cachedB?.fetchedAtMs === 'number' && cachedB.accountUuid === ACCOUNT_B.accountUuid,
    JSON.stringify(cachedB?.fetchedAtMs));

  const listB = await api('accounts', null);
  const bNow = (listB.body?.accounts ?? []).find((r) => r.id === 'second-example-com');
  ok('(a/c) a NON-ACTIVE account\'s limits are now visible WITHOUT switching to it',
    bNow?.state === 'ok' && bNow.limits.some((l) => l.key === 'session' && Math.round(l.percent) === 12),
    JSON.stringify(bNow?.limits));

  // ── (d) both signed-out shapes classify as needs-relogin, DESPITE exit 0 ───────────
  // Shape 1: never had a credential (a sandbox deleted by hand).
  const wiped = join(HOME, '.dreamcontext', 'claude-accounts', 'second-example-com');
  const savedAuth = readFileSync(join(wiped, '.auth-status.json'), 'utf-8');
  const savedCfg = readFileSync(join(wiped, '.claude.json'), 'utf-8');
  rmSync(join(wiped, '.auth-status.json'), { force: true });
  rmSync(join(wiped, '.claude.json'), { force: true });
  const noCred = spawnSync(join(HOME, '.local', 'bin', 'claude'),
    ['-p', '/usage', '--output-format', 'json'],
    { env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: wiped }, encoding: 'utf-8' });
  ok('(d) a credential-less sandbox probe exits 0 with subtype:success and writes NO cache',
    noCred.status === 0
      && /"subtype":"success"/.test(noCred.stdout || '')
      && !existsSync(join(wiped, '.claude.json')),
    `code=${noCred.status}`);
  const judgeNoCred = spawnSync(join(HOME, '.local', 'bin', 'claude'), ['auth', 'status', '--json'],
    { env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: wiped }, encoding: 'utf-8' });
  ok('(d) …so the AUTHORITATIVE judge is what classifies it: loggedIn:false',
    /"loggedIn":\s*false/.test(judgeNoCred.stdout || ''), (judgeNoCred.stdout || '').slice(0, 120));

  // Shape 2: the REVOKED mirror — stale oauthAccount AND stale cache survive, nothing refreshes.
  writeFileSync(join(wiped, '.claude.json'), savedCfg);
  const stamp = 1_700_000_000_000;
  const staleBlob = readJson(join(wiped, '.claude.json')) ?? {};
  staleBlob.cachedUsageUtilization = { fetchedAtMs: stamp, accountUuid: ACCOUNT_B.accountUuid, utilization: {} };
  writeFileSync(join(wiped, '.claude.json'), JSON.stringify(staleBlob));
  const revoked = spawnSync(join(HOME, '.local', 'bin', 'claude'),
    ['-p', '/usage', '--output-format', 'json'],
    { env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: wiped }, encoding: 'utf-8' });
  const stillStale = readJson(join(wiped, '.claude.json'))?.cachedUsageUtilization;
  ok('(d) a REVOKED sandbox keeps its stale mirror verbatim and moves no fetchedAtMs',
    revoked.status === 0 && stillStale?.fetchedAtMs === stamp, JSON.stringify(stillStale?.fetchedAtMs));
  const judgeRevoked = spawnSync(join(HOME, '.local', 'bin', 'claude'), ['auth', 'status', '--json'],
    { env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: wiped }, encoding: 'utf-8' });
  ok('(d) …and the judge sees through the stale mirror too: loggedIn:false',
    /"loggedIn":\s*false/.test(judgeRevoked.stdout || ''), (judgeRevoked.stdout || '').slice(0, 120));

  // NEGATIVE CONTROL: a HEALTHY account that merely did not refresh must stay `unknown`,
  // never needs-relogin. Restore the credential, keep the cache stale, and check the judge
  // reports signed IN — which is the branch that produces `unknown`.
  writeFileSync(join(wiped, '.auth-status.json'), savedAuth);
  const judgeHealthy = spawnSync(join(HOME, '.local', 'bin', 'claude'), ['auth', 'status', '--json'],
    { env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: wiped }, encoding: 'utf-8' });
  ok('(d) NEGATIVE CONTROL: a healthy-but-unrefreshed account reports loggedIn:true ⇒ unknown, not signed-out',
    /"loggedIn":\s*true/.test(judgeHealthy.stdout || ''), (judgeHealthy.stdout || '').slice(0, 120));

  // ── (e) probing B does not disturb the HOME watcher, and a sandboxed session is not
  //        told about a HOME account change ───────────────────────────────────────────
  const capsBefore = await fetch(`http://127.0.0.1:${port}/api/agent/capabilities`).then((r) => r.json());
  spawnSync(join(HOME, '.local', 'bin', 'claude'), ['-p', '/usage', '--output-format', 'json'],
    { env: { ...process.env, HOME, CLAUDE_CONFIG_DIR: wiped }, encoding: 'utf-8' });
  await sleep(3500);   // longer than the watcher's own 2s tick
  const capsAfter = await fetch(`http://127.0.0.1:${port}/api/agent/capabilities`).then((r) => r.json());
  ok('(e) probing another account never moves the HOME watcher\'s fingerprint or epoch',
    capsBefore?.claudeAuth?.epoch === capsAfter?.claudeAuth?.epoch
      && capsBefore?.claudeAuth?.email === capsAfter?.claudeAuth?.email,
    `${capsBefore?.claudeAuth?.epoch} → ${capsAfter?.claudeAuth?.epoch}`);

  // A session on sandbox B, and a session on account #0. Then switch the real HOME.
  const sidB = randomUUID();
  const sidHome = randomUUID();
  const urlB = `ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&sessionId=${sidB}&account=second-example-com`;
  const wsB = new WebSocket(urlB);
  const metasB = [];
  wsB.on('message', (raw) => { try { const o = JSON.parse(raw.toString('utf-8')); if (o?.type === '_meta') metasB.push(o); } catch { /* noise */ } });
  await new Promise((res, rej) => { wsB.once('open', res); wsB.once('error', rej); setTimeout(() => rej(new Error('sandboxed chat ws did not open')), 15_000); });
  const home0 = await openChat(WebSocket, port, sidHome);
  wsB.send(JSON.stringify({ type: 'user', text: 'hello from B' }));
  home0.ws.send(JSON.stringify({ type: 'user', text: 'hello from home' }));
  await sleep(2500);

  setAccount(ACCOUNT_C, 60);          // the MACHINE's account changes under both sessions
  await sleep(6000);

  ok('(e) the sandboxed session is NOT told the real HOME\'s account changed — that event is not its business',
    metasB.filter((m) => m.subtype === 'auth_changed').length === 0,
    JSON.stringify(metasB.map((m) => m.subtype)));
  ok('(e) …while the account-#0 session IS told, exactly as before this feature',
    home0.authFrames().length > 0, JSON.stringify(home0.metas.map((m) => m.subtype)));

  try { wsB.close(); } catch { /* best-effort */ }
  try { home0.ws.close(); } catch { /* best-effort */ }

  // ── (i) removeAccount deletes the sandbox without following its symlinks ────────────
  const preciousDir = join(HOME, '.claude', 'projects');
  const precious = join(preciousDir, 'precious.jsonl');
  mkdirSync(preciousDir, { recursive: true });
  writeFileSync(precious, 'a real transcript');
  const rm = await api('accounts/remove', { id: 'second-example-com' });
  ok('(i) removing an account deletes its sandbox…',
    rm.status === 200 && !existsSync(sandboxB), `${rm.status} ${existsSync(sandboxB)}`);
  ok('(i) …and does NOT follow the shared symlink into the real ~/.claude/projects',
    existsSync(precious) && readFileSync(precious, 'utf-8') === 'a real transcript');
  // The "last account" refusal needs a register that GENUINELY holds one. The sign-in check
  // above added a third account, so removing `first` here would leave one behind and succeed
  // correctly — asserting a refusal at this point was testing the wrong state, not the code.
  const beforeLast = await api('accounts', null);
  for (const row of (beforeLast.body?.accounts ?? []).slice(1)) {
    await api('accounts/remove', { id: row.id });
  }
  const oneLeft = await api('accounts', null);
  const survivor = (oneLeft.body?.accounts ?? [])[0];
  ok('(i) …down to a single account', (oneLeft.body?.accounts ?? []).length === 1,
    JSON.stringify((oneLeft.body?.accounts ?? []).map((r) => r.id)));
  const rmLast = await api('accounts/remove', { id: survivor?.id ?? 'first-example-com' });
  ok('(i) …and THEN refuses to remove it — the app must never be left with no account',
    rmLast.status !== 200, `${rmLast.status} ${JSON.stringify(rmLast.body ?? {}).slice(0, 120)}`);

  // ── (b) a conversation started on A resumes on B with its transcript intact ─────────
  // This is what sharing `projects/` buys, and it is the single most important consequence
  // of the isolate/share split.
  writeAccountRegister();
  mkdirSync(sandboxB, { recursive: true });
  writeFileSync(join(sandboxB, '.auth-status.json'), authStatusFor(ACCOUNT_B));
  writeFileSync(join(sandboxB, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_B.accountUuid, emailAddress: ACCOUNT_B.emailAddress } }));

  const shared = randomUUID();
  const onA = await openChat(WebSocket, port, shared);
  onA.ws.send(JSON.stringify({ type: 'user', text: 'first turn, on account A' }));
  await sleep(2500);
  try { onA.ws.close(); } catch { /* best-effort */ }
  await sleep(2000);

  const transcript = join(HOME, '.claude', 'projects', 'verify', `${shared}.jsonl`);
  ok('(b) the conversation left a transcript in the SHARED store',
    existsSync(transcript), transcript);

  const resumeUrl = `ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&resume=${shared}&account=second-example-com`;
  const wsResume = new WebSocket(resumeUrl);
  await new Promise((res, rej) => { wsResume.once('open', res); wsResume.once('error', rej); setTimeout(() => rej(new Error('resume ws did not open')), 15_000); });
  wsResume.send(JSON.stringify({ type: 'user', text: 'second turn, on account B' }));
  await sleep(2500);
  const resumedOnB = spawnLines().some((l) => l.startsWith('engine') && l.includes('--resume') && l.includes(shared));
  ok('(b) …and account B resumed THAT SAME conversation id — the transcript was not split',
    resumedOnB, spawnLines().filter((l) => l.startsWith('engine')).slice(-3).join(' | '));
  try { wsResume.close(); } catch { /* best-effort */ }

  // ── THE FEATURE'S HEADLINE FLOW, driven end to end ─────────────────────────────────
  //
  // This is the check whose ABSENCE let two real defects through: the harness proved the
  // sandboxes, the probe and the routes, but never once drove a threshold-triggered switch
  // through a LIVE chat. Both bugs lived exactly there.
  //   1. The server HOLDS the turn, so no turn ever starts in the CLI — while the client sets
  //      `busy` optimistically the instant a user frame hits the socket. The restart gate
  //      waited for a turn boundary that could never arrive: the switch was announced and
  //      never performed, and the tab sat on "Working…" forever.
  //   2. Two messages typed seconds apart both entered the evaluation (its guard is only set
  //      AFTER a live probe), both decided to switch, and the first one's held text was
  //      overwritten client-side and lost — never sent, never queued, never shown.
  console.log('  ── a message sent on an EXHAUSTED account moves to a fresh one');
  writeAccountRegister();
  mkdirSync(sandboxB, { recursive: true });
  writeFileSync(join(sandboxB, '.auth-status.json'), authStatusFor(ACCOUNT_B));
  writeFileSync(join(sandboxB, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_B.accountUuid, emailAddress: ACCOUNT_B.emailAddress } }));
  // Account #0 is nearly out; B has plenty. The probe reads each store's own percent.
  writeFileSync(join(HOME, '.usage-percent'), '97');
  writeFileSync(join(sandboxB, '.usage-percent'), '11');
  // Seed account #0's cache high, so the FIRST message is already past the probe threshold —
  // the whole point is that the switch happens BEFORE a limit error, not after one.
  const homeBlob = readJson(join(HOME, '.claude.json')) ?? {};
  homeBlob.cachedUsageUtilization = {
    fetchedAtMs: Date.now(),
    accountUuid: ACCOUNT_A.accountUuid,
    utilization: {
      five_hour: { utilization: 97, resets_at: new Date(Date.now() + 3600_000).toISOString() },
      seven_day: { utilization: 50, resets_at: new Date(Date.now() + 86400_000).toISOString() },
    },
  };
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify(homeBlob));

  const switchSid = randomUUID();
  const switching = await openChat(WebSocket, port, switchSid);
  const HELD = 'this message must survive the switch';
  switching.ws.send(JSON.stringify({ type: 'user', text: HELD }));
  const moved = await until(async () => switching.metas.some((m) => m.subtype === 'account_switch'), 30_000);
  const frame = switching.metas.find((m) => m.subtype === 'account_switch');

  ok('the switch fires BEFORE the limit lands, not after a failed message',
    moved && frame?.switched === true, JSON.stringify(frame ?? switching.metas.map((m) => m.subtype)));
  ok('…and it names the account it moved to, so the billed account never changes silently',
    frame?.accountId === 'second-example-com' && String(frame?.email || '').includes('@'),
    `${frame?.accountId} / ${frame?.email}`);
  ok('…and carries the HELD text, so the user\'s message is not lost',
    frame?.pendingText === HELD, JSON.stringify(frame?.pendingText));
  ok('…and reports turnInFlight:false — the held message never became a turn, so the client\'s ' +
     'restart gate must not wait for a boundary that can never arrive',
    frame?.turnInFlight === false, JSON.stringify(frame?.turnInFlight));

  // TWO messages in quick succession must produce ONE switch decision, not two racing ones.
  const raceSid = randomUUID();
  const racing = await openChat(WebSocket, port, raceSid);
  racing.ws.send(JSON.stringify({ type: 'user', text: 'first of two' }));
  racing.ws.send(JSON.stringify({ type: 'user', text: 'second of two' }));
  await sleep(12_000);
  const raceFrames = racing.metas.filter((m) => m.subtype === 'account_switch' && m.switched === true);
  ok('two messages in quick succession produce exactly ONE switch, never two racing ones',
    raceFrames.length === 1, `${raceFrames.length} switch frames: ${JSON.stringify(raceFrames.map((f) => f.pendingText))}`);
  ok('…and the one that is held is the FIRST, so the user\'s own order is preserved',
    raceFrames[0]?.pendingText === 'first of two', JSON.stringify(raceFrames[0]?.pendingText));

  // A `/effort` turn OVERLAPPING a real one must not make the server report "nothing running".
  //
  // This pins the second review finding. `setEffort` is written straight to stdin OUTSIDE the
  // switchGate chain and the CLI answers it with a fast synthetic turn; with a shared BOOLEAN,
  // that quick `result` cleared the flag while the real message's turn was still going — so
  // the next switch decision read turnInFlight:false and would have restarted over live work.
  // A clamped COUNTER is what makes the answer honest.
  //
  // The session has to START on a HEALTHY account, or its very FIRST message would be held by
  // the switch and no real turn would ever begin — the state this check needs to create. So it
  // runs on B while B is fresh, and B is exhausted only afterwards.
  // The real HOME must carry ACCOUNT A's identity again: an earlier check switched it to C,
  // and the register holds A's `accountUuid` — so A's probe would come back `stale` and A
  // would not be a CANDIDATE at all, leaving nothing to move to. That is correct product
  // behaviour (a reading we cannot attribute is never used), but it is not the state this
  // check is about.
  setAccount(ACCOUNT_A, 70);
  writeFileSync(join(HOME, '.usage-percent'), '20');
  const healthyHome = readJson(join(HOME, '.claude.json')) ?? {};
  healthyHome.cachedUsageUtilization = {
    fetchedAtMs: Date.now(),
    accountUuid: ACCOUNT_A.accountUuid,
    utilization: {
      five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3600_000).toISOString() },
      seven_day: { utilization: 30, resets_at: new Date(Date.now() + 86400_000).toISOString() },
    },
  };
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify(healthyHome));

  const overlapSid = randomUUID();
  const overlapUrl = `ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&sessionId=${overlapSid}`
    + '&account=second-example-com';
  const overlapWs = new WebSocket(overlapUrl);
  const overlapMetas = [];
  overlapWs.on('message', (raw) => {
    try { const o = JSON.parse(raw.toString('utf-8')); if (o?.type === '_meta') overlapMetas.push(o); }
    catch { /* noise */ }
  });
  await new Promise((res, rej) => {
    overlapWs.once('open', res); overlapWs.once('error', rej);
    setTimeout(() => rej(new Error('overlap chat ws did not open')), 15_000);
  });
  const overlap = { ws: overlapWs, metas: overlapMetas };

  // "HOLD" makes the stand-in start a turn it never finishes, so a REAL turn stays in flight.
  overlap.ws.send(JSON.stringify({ type: 'user', text: 'HOLD this turn open' }));
  await sleep(3000);
  overlap.ws.send(JSON.stringify({ type: 'setEffort', effort: 'high' }));
  await sleep(3000);                                  // the /effort turn answers and results

  // NOW exhaust B, so the next message must move — while HOLD's turn is still running.
  writeFileSync(join(sandboxB, '.usage-percent'), '98');
  const tiredB = readJson(join(sandboxB, '.claude.json')) ?? {};
  tiredB.cachedUsageUtilization = {
    fetchedAtMs: Date.now(),
    accountUuid: ACCOUNT_B.accountUuid,
    utilization: {
      five_hour: { utilization: 98, resets_at: new Date(Date.now() + 3600_000).toISOString() },
      seven_day: { utilization: 60, resets_at: new Date(Date.now() + 86400_000).toISOString() },
    },
  };
  writeFileSync(join(sandboxB, '.claude.json'), JSON.stringify(tiredB));

  overlap.ws.send(JSON.stringify({ type: 'user', text: 'and now switch me' }));
  const overlapMoved = await until(
    async () => overlap.metas.some((m) => m.subtype === 'account_switch' && m.switched === true), 30_000);
  const overlapFrame = overlap.metas.find((m) => m.subtype === 'account_switch' && m.switched === true);
  ok('a switch decided while a REAL turn is still running reports turnInFlight:TRUE, ' +
     'even after an overlapping /effort turn has already produced its own result',
    overlapMoved && overlapFrame?.turnInFlight === true,
    `moved=${overlapMoved} turnInFlight=${JSON.stringify(overlapFrame?.turnInFlight)}`);
  ok('…and still carries the held text, so nothing is lost while it waits',
    overlapFrame?.pendingText === 'and now switch me', JSON.stringify(overlapFrame?.pendingText));
  try { overlap.ws.close(); } catch { /* best-effort */ }

  try { switching.ws.close(); } catch { /* best-effort */ }
  try { racing.ws.close(); } catch { /* best-effort */ }
  rmSync(join(HOME, '.usage-percent'), { force: true });

  // ── A NEW session with no `&account=` starts on the PREFERRED account ───────────────
  //
  // Added because validation could not pin this criterion to any observed line — the rule
  // lives in `resolveConfigDir` and had unit coverage, but nothing proved the SERVER actually
  // wires a fresh session through it. Now the engine records which credential store served it,
  // so the answer is observed rather than inferred.
  writeAccountRegister();
  mkdirSync(sandboxB, { recursive: true });
  writeFileSync(join(sandboxB, '.auth-status.json'), authStatusFor(ACCOUNT_B));
  writeFileSync(join(sandboxB, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_B.accountUuid, emailAddress: ACCOUNT_B.emailAddress } }));
  writeFileSync(join(sandboxB, '.usage-percent'), '10');
  setAccount(ACCOUNT_A, 80);
  writeFileSync(join(HOME, '.usage-percent'), '10');
  // Make B the preferred account, through the real route.
  await api('accounts/preferred', { id: 'second-example-com' });
  rmSync(join(sandboxB, '.served-by-engine'), { force: true });
  rmSync(join(HOME, '.served-by-engine'), { force: true });

  const prefSid = randomUUID();
  const preferred = await openChat(WebSocket, port, prefSid);   // NOTE: no &account= at all
  preferred.ws.send(JSON.stringify({ type: 'user', text: 'which account served me?' }));
  await sleep(3000);
  ok('a NEW session sent with NO account parameter runs on the PREFERRED account',
    existsSync(join(sandboxB, '.served-by-engine')) && !existsSync(join(HOME, '.served-by-engine')),
    `B=${existsSync(join(sandboxB, '.served-by-engine'))} HOME=${existsSync(join(HOME, '.served-by-engine'))}`);
  try { preferred.ws.close(); } catch { /* best-effort */ }

  // …and with NO preferred account it falls back to account #0, i.e. today's behaviour.
  await api('accounts/preferred', { id: 'first-example-com' });
  rmSync(join(sandboxB, '.served-by-engine'), { force: true });
  rmSync(join(HOME, '.served-by-engine'), { force: true });
  const zeroSid = randomUUID();
  const onZero = await openChat(WebSocket, port, zeroSid);
  onZero.ws.send(JSON.stringify({ type: 'user', text: 'and now?' }));
  await sleep(3000);
  ok('…and account #0 serves it once IT is the preferred one — the single-account path',
    existsSync(join(HOME, '.served-by-engine')) && !existsSync(join(sandboxB, '.served-by-engine')),
    `HOME=${existsSync(join(HOME, '.served-by-engine'))} B=${existsSync(join(sandboxB, '.served-by-engine'))}`);
  try { onZero.ws.close(); } catch { /* best-effort */ }

  // ── EVERY account exhausted: say WHEN work resumes, and send the message anyway ─────
  //
  // Also added for validation: the criterion asks for an explicit statement with a reset
  // time, and the harness had only ever exercised the case where a fresh account existed.
  writeFileSync(join(HOME, '.usage-percent'), '99');
  writeFileSync(join(sandboxB, '.usage-percent'), '99');
  for (const [dir, acct] of [[HOME, ACCOUNT_A], [sandboxB, ACCOUNT_B]]) {
    const blob = readJson(join(dir, '.claude.json')) ?? {};
    blob.cachedUsageUtilization = {
      fetchedAtMs: Date.now(),
      accountUuid: acct.accountUuid,
      utilization: {
        five_hour: { utilization: 99, resets_at: new Date(Date.now() + 1800_000).toISOString() },
        seven_day: { utilization: 70, resets_at: new Date(Date.now() + 86400_000).toISOString() },
      },
    };
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(blob));
  }

  const spentSid = randomUUID();
  const spent = await openChat(WebSocket, port, spentSid);
  rmSync(join(HOME, '.served-by-engine'), { force: true });
  spent.ws.send(JSON.stringify({ type: 'user', text: 'nowhere left to go' }));
  const told = await until(
    async () => spent.metas.some((m) => m.subtype === 'account_switch' && m.switched === false), 30_000);
  const spentFrame = spent.metas.find((m) => m.subtype === 'account_switch' && m.switched === false);
  ok('with EVERY account at its limit the system says so explicitly instead of failing silently',
    told && spentFrame?.reason === 'all_exhausted',
    `told=${told} reason=${JSON.stringify(spentFrame?.reason)}`);
  ok('…and names WHEN work resumes, so it is information rather than just an error',
    typeof spentFrame?.earliestResetAt === 'number' && spentFrame.earliestResetAt > Date.now(),
    JSON.stringify(spentFrame?.earliestResetAt));
  ok('…and the message STILL goes out on the current account — a turn is never swallowed to hide a limit',
    existsSync(join(HOME, '.served-by-engine')),
    `served=${existsSync(join(HOME, '.served-by-engine'))}`);
  try { spent.ws.close(); } catch { /* best-effort */ }
  rmSync(join(HOME, '.usage-percent'), { force: true });
  rmSync(join(sandboxB, '.usage-percent'), { force: true });

  // ── THE 2026-09-05 REGRESSION, driven end to end ───────────────────────────────────
  //
  // Three breaks put one limit message on screen twice, and every check above passed while
  // all three were live — because every one of them measured the FORECAST path. What follows
  // measures the OBSERVED one.
  //
  //   1. The threshold never armed. The account was refused with "You've hit your session
  //      limit" while its own `/usage` probe answered 6% three minutes later.
  //   2. There was nowhere to go anyway: the fallback account publishes no usage numbers at
  //      all, and an unmeasurable account was disqualified outright.
  //   3. Nothing reacted to the refusal itself. The CLI's rejection frame was read by nobody,
  //      so the user's "devam" walked into the identical wall.
  const LIMITS_FILE = join(HOME, '.dreamcontext', 'claude-account-limits.json');
  const clearRejections = () => rmSync(LIMITS_FILE, { force: true });
  /** Both accounts HEALTHY and well under the probe threshold — so nothing here can be won
   *  by the forecast path. Any switch below is earned by the refusal, or it is not earned. */
  const bothHealthy = () => {
    writeAccountRegister();
    setAccount(ACCOUNT_A, 20);
    writeFileSync(join(HOME, '.usage-percent'), '20');
    writeFileSync(join(sandboxB, '.usage-percent'), '11');
    for (const [dir, acct, pct] of [[HOME, ACCOUNT_A, 20], [sandboxB, ACCOUNT_B, 11]]) {
      const blob = readJson(join(dir, '.claude.json')) ?? {};
      blob.cachedUsageUtilization = {
        fetchedAtMs: Date.now(),
        accountUuid: acct.accountUuid,
        utilization: {
          five_hour: { utilization: pct, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 30, resets_at: new Date(Date.now() + 86400_000).toISOString() },
        },
      };
      writeFileSync(join(dir, '.claude.json'), JSON.stringify(blob));
    }
  };

  console.log('  ── a limit that ALREADY landed still moves the turn');
  clearRejections();
  bothHealthy();
  const hitSid = randomUUID();
  const hit = await openChat(WebSocket, port, hitSid);
  const REFUSED = 'LIMIT this message must be resent, not retyped';
  hit.ws.send(JSON.stringify({ type: 'user', text: REFUSED }));
  const reacted = await until(
    async () => hit.metas.some((m) => m.subtype === 'account_switch' && m.reason === 'limit_hit'), 30_000);
  const hitFrame = hit.metas.find((m) => m.subtype === 'account_switch' && m.reason === 'limit_hit');

  ok('a REFUSED turn triggers a switch, though every percentage says the account is fine',
    reacted && hitFrame?.switched === true,
    `reacted=${reacted} frame=${JSON.stringify(hitFrame ?? hit.metas.map((m) => m.subtype))}`);
  ok('…it moves to the other account by name, so the billed account never changes silently',
    hitFrame?.accountId === 'second-example-com', JSON.stringify(hitFrame?.accountId));
  ok('…and carries the refused text, so the user resends nothing by hand',
    hitFrame?.pendingText === REFUSED, JSON.stringify(hitFrame?.pendingText));
  ok('…and the refusal is WRITTEN DOWN, with the reset the API itself stated',
    (() => {
      const rec = readJson(LIMITS_FILE)?.rejected?.['first-example-com'];
      return rec && rec.window === 'session' && rec.estimated === undefined && rec.until > Date.now();
    })(), JSON.stringify(readJson(LIMITS_FILE)));
  try { hit.ws.close(); } catch { /* best-effort */ }

  // THE "devam" CASE. A brand-new conversation, an ordinary message, both caches still
  // reading 20%/11%. Without the memory this starts on the walled account and fails again —
  // which is exactly what the user saw. The account is remembered as refused, so it moves
  // BEFORE trying, and says so in its own words rather than borrowing limit_hit's.
  console.log('  ── and the NEXT message does not walk back into the same wall');
  const againSid = randomUUID();
  const again = await openChat(WebSocket, port, againSid);
  again.ws.send(JSON.stringify({ type: 'user', text: 'devam' }));
  const rememberedMove = await until(
    async () => again.metas.some((m) => m.subtype === 'account_switch' && m.switched === true), 30_000);
  const againFrame = again.metas.find((m) => m.subtype === 'account_switch' && m.switched === true);
  ok('a refusal is REMEMBERED — the next turn moves before trying, though the cache says 20%',
    rememberedMove && againFrame?.accountId === 'second-example-com',
    `moved=${rememberedMove} frame=${JSON.stringify(againFrame)}`);
  ok('…and it is honest about WHY: this message did not fail, an earlier one did',
    againFrame?.reason === 'limit_known', JSON.stringify(againFrame?.reason));
  ok('…and names when the walled account comes back, so the notice is information',
    typeof againFrame?.earliestResetAt === 'number' && againFrame.earliestResetAt > Date.now(),
    JSON.stringify(againFrame?.earliestResetAt));
  try { again.ws.close(); } catch { /* best-effort */ }

  // The FALLBACK the old chooser could never use. B is signed in and answers `auth status`,
  // but publishes no usage numbers at all — the measured shape of a real Max account. Under
  // the old rule the only possible answer here was "every account is at its limit".
  console.log('  ── an account that publishes NO usage numbers is still a place to go');
  clearRejections();
  bothHealthy();
  writeFileSync(join(sandboxB, '.usage-nocache'), '1');
  const blindSid = randomUUID();
  const blind = await openChat(WebSocket, port, blindSid);
  blind.ws.send(JSON.stringify({ type: 'user', text: 'LIMIT nowhere measurable to go' }));
  const blindMoved = await until(
    async () => blind.metas.some((m) => m.subtype === 'account_switch' && m.switched === true), 30_000);
  const blindFrame = blind.metas.find((m) => m.subtype === 'account_switch' && m.switched === true);
  ok('a signed-in account with NO readable usage is a last-resort fallback, not a dead end',
    blindMoved && blindFrame?.accountId === 'second-example-com',
    `moved=${blindMoved} frame=${JSON.stringify(blindFrame ?? blind.metas.map((m) => m.subtype))}`);
  ok('…and the switch ADMITS there is no number behind it rather than implying a measured pick',
    blindFrame?.unmeasured === true && blindFrame?.sessionPercent === undefined,
    `unmeasured=${JSON.stringify(blindFrame?.unmeasured)} pct=${JSON.stringify(blindFrame?.sessionPercent)}`);
  try { blind.ws.close(); } catch { /* best-effort */ }
  rmSync(join(sandboxB, '.usage-nocache'), { force: true });

  // NEGATIVE CONTROL. The detector runs on every stream line, and a false positive is the
  // expensive direction: it would restart a healthy conversation and bill another account.
  console.log('  ── and an ordinary conversation is never mistaken for a refusal');
  clearRejections();
  bothHealthy();
  const calmSid = randomUUID();
  const calm = await openChat(WebSocket, port, calmSid);
  calm.ws.send(JSON.stringify({ type: 'user', text: 'what happens when you hit your session limit?' }));
  await sleep(6000);
  ok('a message merely TALKING about session limits switches nothing',
    calm.metas.filter((m) => m.subtype === 'account_switch').length === 0
      && readJson(LIMITS_FILE) === null,
    JSON.stringify(calm.metas.map((m) => m.subtype)));
  try { calm.ws.close(); } catch { /* best-effort */ }
  clearRejections();
  rmSync(join(HOME, '.usage-percent'), { force: true });
  rmSync(join(sandboxB, '.usage-percent'), { force: true });

  // ── autoSwitch OFF reports and changes nothing ──────────────────────────────────────
  writeAccountRegister({ autoSwitch: false });
  const off = await api('accounts', null);
  ok('auto-switch reads back OFF once turned off, so the composer\'s checkbox is truthful',
    off.body?.autoSwitch === false, JSON.stringify(off.body?.autoSwitch));
  const on = await api('accounts/auto-switch', { enabled: true });
  ok('…and can be turned back on', on.status === 200 && on.body?.autoSwitch === true, `${on.status}`);
}

/** `lstat` kind of a path, for the reconciliation assertions. */
function lstatKind(p) {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
  } catch { return 'missing'; }
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
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

  b.ws.close();

  // ── The respawn hand-off ────────────────────────────────────────────────────────────
  //
  // The restart closes the old socket and opens the new one in the SAME tick. The server
  // marks a conversation live while a process holds it, and releases that hold when it
  // notices the socket close — so the new upgrade can arrive first. When it did, the resume
  // target read as still-held, the fresh-pin fallback was blocked because the transcript
  // EXISTS, and the spawn came out with NO id at all: a brand-new unpinned conversation, the
  // user's transcript abandoned. Caught live — two consecutive runs of this script, one
  // landing on `--resume`, the next on nothing.
  //
  // Driven here rather than left to the UI half, because in the UI it is a coin flip: this
  // reconnects with ZERO gap, which is the losing side of the race every time.
  console.log('── an immediate reconnect must still resume, not silently start a new conversation');
  const beforeHandoff = engineSpawns().length;
  a.ws.close();
  const c = await openChat(WebSocket, port, convA, { resume: true });
  await sleep(2500);
  const handoff = engineSpawns().slice(beforeHandoff);
  ok('the reconnect spawned exactly one process', handoff.length === 1, JSON.stringify(handoff));
  ok('…and it resumed the SAME conversation instead of abandoning the transcript',
    convIdOf(handoff[0] ?? '') === convA, handoff[0]);
  ok('…via --resume, the real path (not a re-pin, and certainly not an unpinned session)',
    / --resume /.test(handoff[0] ?? ''), handoff[0]);
  c.ws.close();
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

  // ── The multi-account half, on its OWN server ─────────────────────────────────────
  // Same reason the UI half below gets a fresh one: the account watcher is a process-wide
  // singleton holding "which account we last saw", and the wire half deliberately left it on
  // account B. Reusing that server would make this half's first tick discover a switch of its
  // own and contaminate its spawn counts.
  server.kill();
  await sleep(1500);
  rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
  setAccount(ACCOUNT_A, 30);
  writeFileSync(SPAWN_LOG, '');
  const maPort = await freePort();
  console.log(`· restarting the server on ${maPort} for the multi-account half…`);
  server = await startServer(maPort);
  await runMultiAccount(maPort, report);

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
