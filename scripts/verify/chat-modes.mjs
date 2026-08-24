#!/usr/bin/env node
/**
 * Chat MODES — the SERVER leg, end to end.
 *
 *   npm run build:cli && node scripts/verify/chat-modes.mjs
 *
 * WHAT IT DRIVES — the real dashboard server (`dist/index.js dashboard`), the real
 * `/api/agent/chat` WebSocket upgrade, and a real spawned process. Nothing is imported and
 * called directly: every assertion is made against what the SERVER actually put on the
 * command line of the child it spawned.
 *
 * HOW IT SEES THAT — a scripted stand-in for `claude` on the scratch HOME's `~/.local/bin`.
 * It reads its OWN argv, finds `--append-system-prompt-file` and `--permission-mode`, reads
 * the briefing file back off disk, and echoes both to the client inside an assistant frame.
 * So these checks observe the spawn itself, not a re-derivation of what the spawn should
 * have been. No tokens are spent — no real `claude` ever runs.
 *
 * NO BROWSER. This is the server leg only: the URL param → sanitizer → briefing file → argv
 * chain. The CLIENT leg (does the composer's mode trigger send `&mode=`, does a mode switch
 * or a resume preserve the session's permission mode) is `scripts/verify/chat-composer-ui.mjs`
 * in wave 3, which drives Chromium — a hand-rolled WS replay here could not tell a correct
 * client from a broken one, because it would BE the client.
 *
 * ISOLATION — an isolated fake HOME, always. The `~/.claude.json` fixture below is written
 * to `join(HOME, '.claude.json')` under the scratch HOME, never to the developer's real one:
 * that file holds `oauthAccount`, `machineID`, `accountUuid` and spend history. No verify
 * script may read or write it.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST (matching verify/past-chats.mjs): every check
 * prints ✓/✗ with evidence and the run continues. Exit 0 iff everything passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-modes');
const HOME = join(SCRATCH, 'home');
/** Brain in-tree (the default layout) — a worktree here would fork the brain. */
const PROJ_INTREE = join(SCRATCH, 'proj');
/** Brain in its own repo (`brainRepo.mode: 'full-repo'`) — a worktree is safe. */
const PROJ_ISOLATED = join(SCRATCH, 'isolated');

/** The marker the stand-in wraps its argv/briefing report in, so the client can pick it out
 *  of the verbatim NDJSON relay. */
const ECHO = '<<<DC-SPAWN-ECHO>>>';

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// It answers ONE turn. On the first user frame it reports what the server spawned it with.
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-modes.mjs. */
import { readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };

const briefPath = flag('--append-system-prompt-file');
let briefing = null;
if (briefPath) { try { briefing = readFileSync(briefPath, 'utf-8'); } catch (e) { briefing = 'READ-FAILED: ' + e.message; } }

const report = {
  permissionMode: flag('--permission-mode'),
  model: flag('--model'),
  effort: flag('--effort'),
  briefPath,
  briefing,
  argv,
};

let answered = false;
function answer(firstPrompt) {
  if (answered) return;
  answered = true;
  report.firstPrompt = firstPrompt;
  out({ type: 'system', subtype: 'init', session_id: 'verify-chat-modes', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: report.permissionMode, slash_commands: [] });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(ECHO)} + JSON.stringify(report) }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-chat-modes' });
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    answer(text);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ─── setup ────────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** A project with the given brain mode. `in-tree` is the default layout (brain inside the
 *  code checkout); `full-repo` is the isolated one. */
function makeProject(root, brainMode) {
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(root, '_dream_context', 'state', '.config.json'), JSON.stringify({
    platforms: [], packs: [], setupVersion: '1',
    brainRepo: { mode: brainMode, enabled: brainMode === 'full-repo' },
  }));
  spawnSync('git', ['init', '-q'], { cwd: root });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  makeProject(PROJ_INTREE, 'in-tree');
  makeProject(PROJ_ISOLATED, 'full-repo');

  // The account-usage fixture the usage-limits route reads. Under the SCRATCH HOME — the
  // real ~/.claude.json is never touched by any verify script.
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      utilization: {
        five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3 * 3600_000).toISOString() },
        seven_day: { utilization: 47, resets_at: new Date(Date.now() + 40 * 3600_000).toISOString() },
        limits: [
          { kind: 'session', group: 'session', percent: 20, severity: 'normal', resets_at: new Date(Date.now() + 3 * 3600_000).toISOString(), is_active: false },
          { kind: 'weekly_all', group: 'weekly', percent: 47, severity: 'normal', resets_at: new Date(Date.now() + 40 * 3600_000).toISOString(), is_active: true },
          { kind: 'weekly_scoped', group: 'weekly', percent: 44, severity: 'normal', resets_at: new Date(Date.now() + 40 * 3600_000).toISOString(), scope: { model: { display_name: 'Fable' } }, is_active: false },
        ],
      },
    },
  }));

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  for (const [name, path] of [['proj', PROJ_INTREE], ['isolated', PROJ_ISOLATED]]) {
    const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', name, path],
      { env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (add.status !== 0) throw new Error(`vaults add ${name} failed: ${add.stderr || add.stdout}`);
  }
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ_INTREE,
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

// ─── one spawn, observed ──────────────────────────────────────────────────────────────

/**
 * Open a chat WS with `params`, send one message (unless the server is submitting an initial
 * prompt itself), and resolve with the stand-in's report of how it was spawned.
 */
async function observeSpawn(WebSocket, port, params, { send = 'GO' } = {}) {
  const qs = new URLSearchParams({ vault: 'proj', bypass: '0', ...params }).toString();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/chat?${qs}`);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch { /* closing */ } reject(new Error('timed out waiting for the spawn echo')); }, 25_000);
    const done = (fn, arg) => { clearTimeout(timer); try { ws.close(); } catch { /* closing */ } fn(arg); };
    ws.on('open', () => { if (send) ws.send(JSON.stringify({ type: 'user', text: send })); });
    ws.on('error', (err) => done(reject, err));
    ws.on('close', () => done(reject, new Error('socket closed before the echo arrived')));
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString('utf-8')); } catch { return; }
      const blocks = frame?.message?.content;
      if (frame?.type !== 'assistant' || !Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (b?.type !== 'text' || typeof b.text !== 'string' || !b.text.startsWith(ECHO)) continue;
        try { done(resolve, JSON.parse(b.text.slice(ECHO.length))); } catch (err) { done(reject, err); }
        return;
      }
    });
  });
}

// ─── the assertions ───────────────────────────────────────────────────────────────────

const report = {
  pass: 0,
  fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  fail(label, detail) { this.check(label, false, detail); },
};
const ok = (label, cond, detail) => report.check(label, cond, detail);

/** The surface briefing's own last sentence — the anchor that proves nothing was appended
 *  after it. (`dist/` is a single tsup bundle with no importable `chat-surface.js`, so the
 *  identity check is made structurally; `tests/unit/chat-modes.test.ts` pins the other half,
 *  `modeBriefing('basic') === ''`.) */
const SURFACE_TAIL = 'Nothing else about how you work changes.';
const SURFACE_HEAD = '# Surface: dreamcontext Chat';

let server = null;
try {
  let WebSocket;
  try { ({ WebSocket } = await import('ws')); }
  catch { throw new Error('the `ws` package is required (it is a root dependency — run npm install)'); }

  console.log('· setting up scratch HOME + two vaults + scripted claude…');
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;

  // ── 1 — basic adds nothing ────────────────────────────────────────────────────────
  console.log('\n── 1-5: the mode reaches the briefing file, and only the right one');
  {
    const s = await observeSpawn(WebSocket, port, { mode: 'basic' });
    ok('basic: the surface briefing is written and passed as --append-system-prompt-file',
      !!s.briefPath && typeof s.briefing === 'string' && s.briefing.includes(SURFACE_HEAD),
      `briefPath=${s.briefPath}`);
    ok('basic: NOTHING is appended after it — no mode heading, ends on the surface briefing',
      !s.briefing.includes('# Mode:') && s.briefing.trimEnd().endsWith(SURFACE_TAIL),
      `tail=${JSON.stringify(s.briefing.trimEnd().slice(-80))}`);
    ok('basic: exactly ONE --append-system-prompt-file on the command line',
      s.argv.filter((a) => a === '--append-system-prompt-file').length === 1,
      JSON.stringify(s.argv));
  }

  // ── 2 — plan ──────────────────────────────────────────────────────────────────────
  {
    const s = await observeSpawn(WebSocket, port, { mode: 'plan' });
    ok('plan: the surface briefing is still there, with the mode brief appended to it',
      s.briefing.includes(SURFACE_HEAD) && s.briefing.includes('# Mode: Plan'),
      `has surface=${s.briefing.includes(SURFACE_HEAD)} has mode=${s.briefing.includes('# Mode: Plan')}`);
    ok('plan: it is the planning half — asks first, ends by creating a task',
      /ask/i.test(s.briefing) && s.briefing.includes('dreamcontext tasks create'));
    ok('plan: it ends by offering the develop handoff button',
      s.briefing.includes('dream-actions') && s.briefing.includes('"action": "develop"'));
    ok('plan: it tells the agent to shelve the task it just created',
      s.briefing.includes('"type":"progress"') && s.briefing.includes('"task":"<the-slug>"'));
    ok('plan: still exactly ONE briefing file (both parts share it)',
      s.argv.filter((a) => a === '--append-system-prompt-file').length === 1);
  }

  // ── 3/4 — develop, both project layouts ───────────────────────────────────────────
  {
    const inTree = await observeSpawn(WebSocket, port, { mode: 'develop' });
    ok('develop + brain IN-TREE: a worktree is explicitly FORBIDDEN',
      /Do\s+NOT\s+create\s+a\s+git\s+worktree/.test(inTree.briefing)
      && !/MAY\s+use\s+a\s+git\s+worktree/.test(inTree.briefing));
    ok('develop + brain IN-TREE: the prohibition says why (the brain lives in the tree)',
      inTree.briefing.includes('_dream_context/'));
    ok('develop: the run goes on the shelf BEFORE the first edit',
      inTree.briefing.includes('"type":"progress"')
      && inTree.briefing.indexOf('"type":"progress"') < inTree.briefing.indexOf('Work in waves'));
    ok('develop: a dev-server URL is pinned as a tag (only the agent knows the port)',
      inTree.briefing.includes('"type":"pin"') && inTree.briefing.includes('http://localhost:PORT'));

    const isolated = await observeSpawn(WebSocket, port, { mode: 'develop', vault: 'isolated' });
    ok('develop + brain FULL-REPO: a worktree is permitted',
      /MAY\s+use\s+a\s+git\s+worktree/.test(isolated.briefing)
      && !/Do\s+NOT\s+create\s+a\s+git\s+worktree/.test(isolated.briefing));
    ok('…and it is the SAME develop brief either way — only the worktree paragraph differs',
      isolated.briefing.includes('# Mode: Develop') && inTree.briefing.includes('# Mode: Develop'));
  }

  // ── 5 — unknown / disabled modes coerce to basic ──────────────────────────────────
  for (const [label, mode] of [['jarvis (disabled in the UI)', 'jarvis'], ['a hostile value', ';rm -rf /'], ['an unknown value', 'turbo']]) {
    const s = await observeSpawn(WebSocket, port, { mode });
    ok(`${label} → the basic briefing, no mode brief`,
      !s.briefing.includes('# Mode:') && s.briefing.trimEnd().endsWith(SURFACE_TAIL),
      `mode=${JSON.stringify(mode)}`);
  }

  // ── 6 — the prompt hand-off a Plan→Develop handoff uses ───────────────────────────
  console.log('\n── 6: the promptToken hand-off reaches the child as its first user frame');
  {
    const slug = 'verify-handoff-task-slug';
    const prompt = `Read the dreamcontext task ${slug} and implement it in waves.`;
    const res = await fetch(`${base}/api/agent/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vault: 'proj', prompt }),
    });
    const body = await res.json();
    ok('POST /api/agent/prompt mints a token', res.ok && !!body.token, JSON.stringify(body).slice(0, 160));
    if (body.token) {
      const s = await observeSpawn(WebSocket, port, { mode: 'develop', promptToken: body.token }, { send: null });
      ok('the develop session receives the kickoff prompt, naming the task slug',
        typeof s.firstPrompt === 'string' && s.firstPrompt.includes(slug), JSON.stringify(s.firstPrompt));
      ok('…and it really is a develop session (the mode brief rode along with the token)',
        s.briefing.includes('# Mode: Develop'));
    } else {
      report.fail('the develop session receives the kickoff prompt, naming the task slug', 'no token minted');
    }
  }

  // ── 7 — account usage limits, from the SCRATCH ~/.claude.json ─────────────────────
  console.log('\n── 7: /api/agent/usage-limits reads the scratch HOME, never the real one');
  {
    const res = await fetch(`${base}/api/agent/usage-limits`);
    if (res.status === 404) {
      report.fail('GET /api/agent/usage-limits returns the fixtured session + weekly limits',
        'route not registered — D1-B (src/lib/claude-usage.ts + routes/agent-usage.ts) has not landed in this tree yet');
    } else {
      const body = await res.json().catch(() => null);
      const limits = body?.limits ?? [];
      ok('GET /api/agent/usage-limits returns the fixtured session + weekly limits',
        res.ok && limits.some((l) => l.key === 'session' && l.percent === 20)
        && limits.some((l) => l.key === 'weekly' && l.percent === 47),
        JSON.stringify(body).slice(0, 240));
      ok('…and leaks nothing else out of ~/.claude.json',
        !JSON.stringify(body).includes('accountUuid') && !JSON.stringify(body).includes('oauthAccount'));
    }
  }

  // ── 9 — the permission mode the server actually put on the command line ───────────
  //
  // The SERVER leg of the handoff's non-escalation guarantee: whatever the client remembers,
  // an upgrade carrying `bypass=0` must spawn `--permission-mode auto`. (Whether the composer
  // SENDS bypass=0 for a handoff is the client leg — chat-composer-ui.mjs, wave 3.)
  console.log('\n── 9: bypass= on the wire → --permission-mode on the command line');
  {
    const auto = await observeSpawn(WebSocket, port, { mode: 'develop', bypass: '0' });
    ok('bypass=0 → --permission-mode auto', auto.permissionMode === 'auto', `got ${auto.permissionMode}`);
    ok('…never acceptEdits (it prompts on every non-edit command)', auto.permissionMode !== 'acceptEdits');

    const bypass = await observeSpawn(WebSocket, port, { mode: 'develop', bypass: '1' });
    ok('bypass=1 → --permission-mode bypassPermissions', bypass.permissionMode === 'bypassPermissions',
      `got ${bypass.permissionMode}`);
    ok('the mode brief is independent of the permission mode', bypass.briefing.includes('# Mode: Develop'));
  }
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
