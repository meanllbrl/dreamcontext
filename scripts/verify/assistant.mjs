#!/usr/bin/env node
/**
 * The dreamcontext Assistant — SERVER + CLI legs, end to end.
 *
 *   npm run build && node scripts/verify/assistant.mjs   (the W2 legs drive the built notch UI in Chromium)
 *
 * WHAT IT DRIVES — the real dashboard server (`dist/index.js dashboard`) on an isolated HOME,
 * the real `/api/assistant/*` routes, the real `/api/agent/chat` upgrade, and the real
 * `dreamcontext assistant …` CLI as a child process. Nothing is imported and called directly.
 *
 * HOW IT SEES THE TOKEN — the token is injected ONLY into the `__assistant__` chat's spawn env,
 * so the only honest way to get it is to BE that spawn. A scripted stand-in for `claude` on
 * the scratch HOME's `~/.local/bin` reports its own env, argv, cwd and briefing on every
 * turn; this script reads the token out of the assistant session's report and runs the CLI
 * with it, exactly as the assistant would. A second session in a normal vault reports its env
 * too — the proof that nobody else gets the token.
 *
 * The same stand-in answers `claude -p "<prompt>" --output-format json` (the headless run
 * broadcast uses) by writing the prompt into THAT vault's own folder, so "each vault's own
 * agent does the writing" is observed on disk. No real `claude` ever runs; no tokens are spent.
 *
 * FAILURE POLICY — collect, don't fail fast: every check prints ✓/✗, exit 0 iff all passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-assistant');
const HOME = join(SCRATCH, 'home');
const PROJ = (n) => join(SCRATCH, 'projects', n);
const ECHO = '<<<DC-SPAWN-ECHO>>>';

const STANDIN = `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] ?? null); };

// Headless one-shot (runPeerHeadless): claude -p "<prompt>" --output-format json …
if (argv[0] === '-p' && flag('--output-format') === 'json') {
  const prompt = argv[1] ?? '';
  appendFileSync(join(process.cwd(), '_dream_context', 'broadcast-received.txt'), prompt + '\\n---\\n');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Wrote it to knowledge in ' + process.cwd().split('/').pop() + '.', session_id: 'headless-' + Date.now() });
  process.exit(0);
}

const briefPath = flag('--append-system-prompt-file');
let briefing = null;
if (briefPath) { try { briefing = readFileSync(briefPath, 'utf-8'); } catch (e) { briefing = 'READ-FAILED'; } }
const report = {
  cwd: process.cwd(),
  permissionMode: flag('--permission-mode'),
  token: process.env.DREAMCONTEXT_ASSISTANT_TOKEN ?? null,
  url: process.env.DREAMCONTEXT_ASSISTANT_URL ?? null,
  // What the latency legs read: the recall mode forced on this process's hooks, the effort and
  // the pre-approved tools it was spawned with, and which conversation it pinned or resumed.
  recallMode: process.env.DREAMCONTEXT_RECALL_MODE ?? null,
  effort: flag('--effort'),
  allowedTools: flag('--allowedTools'),
  sessionIdArg: flag('--session-id'),
  resumeArg: flag('--resume'),
  briefing,
};
let initDone = false;
function turn(text) {
  // Like the real CLI, init names the conversation it pinned (--session-id) or resumed
  // (--resume): the chat registry keys a chat's conversation off this frame.
  const convId = flag('--session-id') ?? flag('--resume');
  if (!initDone) { initDone = true; out({ type: 'system', subtype: 'init', session_id: convId ?? 'conv-' + process.pid, model: 'x', cwd: process.cwd(), slash_commands: [] }); }
  // KEEP:<text> leaves a transcript behind, as a real claude does after a first turn, so the
  // server will --resume this conversation instead of pinning a fresh one.
  if (text.startsWith('KEEP:') && convId) {
    const dir = join(homedir(), '.claude', 'projects', 'verify-standin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, convId + '.jsonl'), JSON.stringify({ type: 'user', sessionId: convId, message: { role: 'user', content: text } }) + '\\n');
  }
  if (text === 'ASK') {
    out({ type: 'control_request', request_id: 'q-' + process.pid, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } } });
    return;
  }
  // SAY:<text> answers with exactly <text> — how the W4 leg gets a real dream-actions answer.
  const reply = text.startsWith('SAY:') ? text.slice(4) : ${JSON.stringify(ECHO)} + JSON.stringify({ ...report, said: text });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_response') { out({ type: 'result', subtype: 'success', is_error: false, result: 'ANSWERED' }); continue; }
    if (o.type !== 'user') continue;
    turn(((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ─── setup ───────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

let ALPHA_TASK = '';

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const n of ['alpha-app', 'beta-app', 'gamma-app']) {
    mkdirSync(join(PROJ(n), '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(PROJ(n), '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1' }));
    const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', n, PROJ(n)], { env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (add.status !== 0) throw new Error(`vaults add ${n} failed: ${add.stderr || add.stdout}`);
  }
  // alpha keeps the default recall mode (haiku); beta is switched to raw — a delegation must
  // leave a non-haiku vault's recall alone.
  const raw = spawnSync(process.execPath, [CLI, 'recall', 'raw'], { cwd: PROJ('beta-app'), env: { ...process.env, HOME, DREAMCONTEXT_RECALL_MODE: '' }, encoding: 'utf-8' });
  if (raw.status !== 0) throw new Error(`recall raw failed: ${raw.stderr || raw.stdout}`);
  // A real task in alpha, for the W4 detail button to land on.
  const task = spawnSync(process.execPath, [CLI, 'tasks', 'create', 'Fix the login flow', '--why', 'Owners cannot sign in.'], { cwd: PROJ('alpha-app'), env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (task.status !== 0) throw new Error(`tasks create failed: ${task.stderr || task.stdout}`);
  ALPHA_TASK = readdirSync(join(PROJ('alpha-app'), '_dream_context', 'state')).find((f) => f.endsWith('.md'))?.replace(/\.md$/, '') ?? '';
  if (!ALPHA_TASK) throw new Error('tasks create wrote no task file');
  // gamma's folder disappears after registration → broadcast must report it `missing`.
  rmSync(PROJ('gamma-app'), { recursive: true, force: true });
}

const LINGER_MS = 2000;
const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');

async function startServer(port) {
  // A recall mode in THIS shell's env would override every vault's own (sleep.ts
  // resolveRecallMode) and blind the latency legs; the server runs without one.
  const { DREAMCONTEXT_RECALL_MODE: _shellRecall, ...shellEnv } = process.env;
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ('alpha-app'),
    // The linger is shortened so the W2 notch check can outwait it (agent-chat.ts closeLingerMs).
    env: { ...shellEnv, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_CHAT_CLOSE_LINGER_MS: String(LINGER_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`dashboard server did not come up\n${log}`);
}

/** A chat session: open the WS, and read the stand-in's report off each turn. */
function openChat(WebSocket, port, params) {
  const qs = new URLSearchParams({ bypass: '0', ...params }).toString();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/chat?${qs}`);
  const reports = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let f; try { f = JSON.parse(raw.toString('utf-8')); } catch { return; }
    const blocks = f?.message?.content;
    if (f?.type === 'assistant' && Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith(ECHO)) {
          const rep = JSON.parse(b.text.slice(ECHO.length));
          reports.push(rep);
          waiters.splice(0).forEach((w) => w(rep));
        }
      }
    }
  });
  const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return {
    ws,
    async say(text) {
      await opened;
      const next = new Promise((resolve, reject) => { waiters.push(resolve); setTimeout(() => reject(new Error(`no echo for "${text}"`)), 20_000); });
      ws.send(JSON.stringify({ type: 'user', text }));
      return next;
    },
    async send(frame) { await opened; ws.send(JSON.stringify(frame)); },
    close() { try { ws.close(); } catch { /* closing */ } },
  };
}

/** Run the real CLI as the assistant would (or as a stranger would, with `env` overridden). */
function cli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME, PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout || stderr.split('\n}\n')[0] + (stderr.includes('\n}\n') ? '\n}' : '')); } catch { /* not json */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

const report = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
const sockets = [];
try {
  const { WebSocket } = await import('ws');
  console.log('· scratch HOME + three vaults (gamma\'s folder deleted) + scripted claude…');
  setupScratch();
  const port = await freePort();
  console.log(`· real dashboard server on ${port}…`);
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // ── W1 hidden vault ───────────────────────────────────────────────────────────────
  console.log('\n── hidden vault');
  {
    const before = await (await fetch(`${base}/api/assistant/status`)).json();
    ok('status before create: exists=false', before.exists === false, JSON.stringify(before));
    const r = await post('/api/assistant/create', { name: 'Nova', character: 'Terse, dry, Turkish-first.' });
    const body = await r.json();
    ok('POST /api/assistant/create scaffolds it (real init + setup)', r.status === 200 && existsSync(join(HOME, '.dreamcontext', 'assistant', '_dream_context')), JSON.stringify(body));
    const vaultsJson = readFileSync(join(HOME, '.dreamcontext', 'vaults.json'), 'utf-8');
    ok('it is NOT in vaults.json', !vaultsJson.includes('__assistant__') && !vaultsJson.includes('.dreamcontext/assistant'), vaultsJson);
    const list = await (await fetch(`${base}/api/vaults`)).text();
    ok('it is NOT in GET /api/vaults (Launcher list / ⌘P)', !list.includes('__assistant__') && !list.includes('.dreamcontext/assistant'), list);
    const soul = readFileSync(join(HOME, '.dreamcontext', 'assistant', '_dream_context', 'core', '0.soul.md'), 'utf-8');
    ok('the character is written into the hidden vault\'s soul', soul.includes('## Character') && soul.includes('Terse, dry, Turkish-first.'));
    const cfg = JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'assistant', 'config.json'), 'utf-8'));
    const mode = (spawnSync('stat', ['-f', '%Lp', join(HOME, '.dreamcontext', 'assistant', 'config.json')], { encoding: 'utf-8' }).stdout || '').trim();
    ok('config.json holds name + autonomy ask, mode 0600', cfg.name === 'Nova' && cfg.autonomy === 'ask' && (mode === '600' || process.platform !== 'darwin'), `${JSON.stringify(cfg)} mode=${mode}`);
    const term = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/terminal?vault=__assistant__`);
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
      ws.on('open', () => { ws.close(); resolve('opened'); });
      ws.on('error', () => resolve('error'));
    });
    ok('the terminal refuses the hidden vault (403)', term === 403, String(term));
  }

  // ── sessions + token injection ─────────────────────────────────────────────────────
  console.log('\n── token reaches ONLY the assistant spawn; the registry sees every other chat');
  const alphaSid = randomUUID();
  const alpha = openChat(WebSocket, port, { vault: 'alpha-app', sessionId: alphaSid, mode: 'basic' });
  sockets.push(alpha);
  const alphaReport = await alpha.say('fix the login bug');
  ok('a normal vault\'s chat gets NO assistant token or URL', alphaReport.token === null && alphaReport.url === null, JSON.stringify({ token: alphaReport.token, url: alphaReport.url }));

  const asstSid = randomUUID();
  const asst = openChat(WebSocket, port, { vault: '__assistant__', sessionId: asstSid, mode: 'basic' });
  sockets.push(asst);
  const a = await asst.say('hello');
  ok('the __assistant__ chat runs in the hidden vault', a.cwd.endsWith('/.dreamcontext/assistant'), a.cwd);
  ok('the __assistant__ chat gets the token and a loopback URL', /^dca_[0-9a-f]{12}_[0-9a-f]{48}$/.test(a.token ?? '') && a.url === `http://127.0.0.1:${port}`, JSON.stringify({ token: a.token?.slice(0, 10), url: a.url }));
  ok('mode=basic in the URL is FORCED to the assistant briefing', (a.briefing ?? '').includes('# Mode: dreamcontext Assistant') && a.briefing.includes('**Nova**'));
  ok('autonomy ask → claude permission mode "default"', a.permissionMode === 'default', a.permissionMode);
  ok('the __assistant__ spawn runs --effort medium (its config default)', a.effort === 'medium', String(a.effort));
  ok('under ask the __assistant__ argv carries NO --allowedTools', a.allowedTools === null, String(a.allowedTools));
  ok('its hooks recall raw (no embedding model on disk) — never haiku', a.recallMode === 'raw', String(a.recallMode));
  ok('an ordinary project chat carries no --allowedTools and no forced recall mode', alphaReport.allowedTools === null && alphaReport.recallMode === null, JSON.stringify({ allowedTools: alphaReport.allowedTools, recallMode: alphaReport.recallMode }));
  ok('the briefing carries the roster and the untrusted rule', a.briefing.includes('## Projects (3)') && a.briefing.includes('alpha-app') && a.briefing.includes('UNTRUSTED CONTENT'));
  const env = { DREAMCONTEXT_ASSISTANT_URL: a.url, DREAMCONTEXT_ASSISTANT_TOKEN: a.token };

  // ── CLI read verbs ───────────────────────────────────────────────────────────────
  console.log('\n── dreamcontext assistant projects | sessions | watch');
  {
    const r = await cli(['assistant', 'projects'], env);
    const names = (r.json?.projects ?? []).map((p) => p.name);
    ok('projects lists every registered vault, never the hidden one', r.code === 0 && names.join(',') === 'alpha-app,beta-app,gamma-app', r.stdout || r.stderr);
    ok('projects marks the deleted folder missing', r.json?.projects?.find((p) => p.name === 'gamma-app')?.missing === true);
  }
  {
    const r = await cli(['assistant', 'sessions'], env);
    const s = (r.json?.sessions ?? []).find((x) => x.sessionId === alphaSid);
    ok('sessions lists alpha\'s chat as idle, title wrapped as untrusted', r.code === 0 && s?.status === 'idle' && s?.title === '<untrusted-project-output vault="alpha-app">fix the login bug</untrusted-project-output>', r.stdout || r.stderr);
    ok('sessions never lists the assistant\'s own chat', !(r.json?.sessions ?? []).some((x) => x.sessionId === asstSid));
    const f = await cli(['assistant', 'sessions', '--vault', 'beta-app'], env);
    ok('sessions --vault filters', f.code === 0 && (f.json?.sessions ?? []).length === 0, f.stdout);
  }
  {
    const watching = cli(['assistant', 'watch', alphaSid, '--until', 'asking', '--timeout', '30'], env);
    await sleep(800);
    await alpha.send({ type: 'user', text: 'ASK' });
    const r = await watching;
    ok('watch --until asking resolves when the chat raises a question', r.code === 0 && r.json?.session?.status === 'asking' && r.json?.session?.pendingQuestion?.kind === 'question', r.stdout || r.stderr);
    const t0 = Date.now();
    const idle = await cli(['assistant', 'watch', alphaSid, '--until', 'idle', '--timeout', '3'], env);
    ok('watch times out honestly', idle.json?.timedOut === true && Date.now() - t0 < 10_000, idle.stdout);
    alpha.close();
    await sleep(1500);
    const t1 = Date.now();
    const gone = await cli(['assistant', 'watch', alphaSid, '--until', 'idle', '--timeout', '60'], env);
    ok('watch resolves IMMEDIATELY with ended:true once the chat is gone', gone.json?.ended === true && gone.json?.session?.status === 'gone' && Date.now() - t1 < 5000, gone.stdout);
  }

  // ── broadcast (under ask → a proposal the owner approves) ─────────────────────────────
  console.log('\n── dreamcontext assistant broadcast');
  {
    const running = cli(['assistant', 'broadcast', 'Always use pnpm, never npm.'], env);
    let proposal = null;
    for (let i = 0; i < 40 && !proposal; i++) {
      await sleep(250);
      proposal = (await (await fetch(`${base}/api/assistant/proposals`)).json()).proposals?.[0] ?? null;
    }
    ok('under ask, broadcast becomes a proposal and WAITS', proposal?.verb === 'broadcast' && proposal?.text === 'Always use pnpm, never npm.', JSON.stringify(proposal));
    const alphaFile = join(PROJ('alpha-app'), '_dream_context', 'broadcast-received.txt');
    ok('nothing was written before approval', !existsSync(alphaFile));
    if (proposal) await post(`/api/assistant/proposals/${proposal.id}`, { action: 'approve' });
    const r = await running;
    const rows = r.json?.rows ?? [];
    ok('broadcast answers "written in 2 of 3"', r.code === 0 && r.json?.summary === 'written in 2 of 3', r.stdout || r.stderr);
    ok('one row per vault: replied, replied, missing', rows.map((x) => `${x.vault}:${x.status}`).join(',') === 'alpha-app:replied,beta-app:replied,gamma-app:missing', JSON.stringify(rows));
    ok('each reply is wrapped as untrusted', rows.filter((x) => x.status === 'replied').every((x) => x.text.startsWith(`<untrusted-project-output vault="${x.vault}">`)));
    for (const n of ['alpha-app', 'beta-app']) {
      const f = join(PROJ(n), '_dream_context', 'broadcast-received.txt');
      ok(`${n}'s OWN agent ran in its own root and got the owner's words`, existsSync(f) && readFileSync(f, 'utf-8').includes('Always use pnpm, never npm.'));
    }
  }

  // ── UI verbs → no_surface until W2 ──────────────────────────────────────────────────
  console.log('\n── UI verbs return no_surface (no notch yet)');
  {
    await post('/api/assistant/profile', { autonomy: 'bypass' }); // so send/answer reach the relay without a proposal
    const bSid = randomUUID();
    const beta = openChat(WebSocket, port, { vault: 'beta-app', sessionId: bSid, mode: 'basic' });
    sockets.push(beta);
    await beta.say('hi');
    const verbs = [
      ['open', 'alpha-app'], ['chat', 'alpha-app', '--prompt', 'hi'], ['send', bSid, 'follow up'],
      ['answer', bSid, '--question', 'q1', '--choice', 'Postgres'], ['focus', 'alpha-app'],
      ['tile', 'alpha-app', 'beta-app'], ['notify', 'done'],
    ];
    for (const v of verbs) {
      const r = await cli(['assistant', ...v], env);
      ok(`assistant ${v[0]} → no_surface`, r.code === 1 && r.stderr.includes('no_surface'), r.stdout + r.stderr);
    }
    await post('/api/assistant/profile', { autonomy: 'ask' });
  }

  // ── W2 relay, protocol level: a scripted notch + a scripted project window ─────────
  console.log('\n── W2 relay: CLI → server → notch socket → bind → window claim → result');
  {
    await post('/api/assistant/profile', { autonomy: 'bypass' }); // send/answer straight to the relay
    const commands = [];
    const cmdWaiters = [];
    asst.ws.on('message', (raw) => {
      let f; try { f = JSON.parse(raw.toString('utf-8')); } catch { return; }
      if (f?.type === '_meta' && f.subtype === 'assistant_command') { commands.push(f); cmdWaiters.splice(0).forEach((w) => w(f)); }
    });
    const nextCommand = () => new Promise((resolve, reject) => { cmdWaiters.push(resolve); setTimeout(() => reject(new Error('no command reached the notch')), 10_000); });
    await asst.send({ type: 'assistant_surface' });
    await sleep(300);

    const reg = async (vault, label) => (await (await post('/api/assistant/windows', { vault, label })).json()).nonce;
    const alphaNonce = await reg('alpha-app', 'scripted-alpha');
    const betaNonce = await reg('beta-app', 'scripted-beta');
    ok('a project window registers and gets a nonce', /^[0-9a-f]{32}$/.test(alphaNonce ?? '') && alphaNonce !== betaNonce);
    const badReg = await post('/api/assistant/windows', { vault: '__assistant__', label: 'x' });
    ok('the hidden vault can never register a window', badReg.status === 400);

    // chat: the notch binds the id to alpha's window; the window claims and answers.
    const running = cli(['assistant', 'chat', 'alpha-app', '--prompt', 'ship the release notes', '--mode', 'plan'], env);
    const cmd = await nextCommand();
    ok('the chat verb reaches the notch socket as an assistant_command', cmd.verb === 'chat' && cmd.args?.vault === 'alpha-app' && cmd.args?.prompt === 'ship the release notes' && cmd.args?.mode === 'plan', JSON.stringify(cmd));
    const claim = (id, body) => post(`/api/assistant/commands/${id}/claim`, body);
    ok('FORGED: an id the server never minted cannot be claimed', (await claim('f'.repeat(32), { vault: 'alpha-app', nonce: alphaNonce })).status === 404);
    ok('FORGED: an unbound id cannot be claimed yet', (await claim(cmd.id, { vault: 'alpha-app', nonce: alphaNonce })).status === 404);
    const bindWrong = await post(`/api/assistant/commands/${cmd.id}/bind`, { vault: 'alpha-app', label: 'vault-nobody' });
    ok('binding to a label with no registered window is refused', bindWrong.status === 404);
    const bind = await post(`/api/assistant/commands/${cmd.id}/bind`, { vault: 'alpha-app', label: 'scripted-alpha' });
    ok('the notch binds the id to the window by label (it never sees a nonce)', bind.status === 200);
    ok('FORGED: a second bind of the same id is refused', (await post(`/api/assistant/commands/${cmd.id}/bind`, { vault: 'beta-app', label: 'scripted-beta' })).status === 404);
    ok('FORGED: another project\'s window cannot claim it', (await claim(cmd.id, { vault: 'beta-app', nonce: betaNonce })).status === 404);
    ok('FORGED: the right vault with a wrong window nonce cannot claim it', (await claim(cmd.id, { vault: 'alpha-app', nonce: betaNonce })).status === 404);
    const claimed = await claim(cmd.id, { vault: 'alpha-app', nonce: alphaNonce });
    const got = await claimed.json();
    ok('the bound window claims the authoritative command', claimed.status === 200 && got.verb === 'chat' && got.args?.prompt === 'ship the release notes', JSON.stringify(got));
    ok('FORGED: a reused id cannot be claimed twice', (await claim(cmd.id, { vault: 'alpha-app', nonce: alphaNonce })).status === 404);
    const wrongResult = await post(`/api/assistant/commands/${cmd.id}/result`, { vault: 'beta-app', nonce: betaNonce, ok: true, result: { sessionId: 'forged' } });
    ok('FORGED: another window cannot post the result', wrongResult.status === 404);
    await post(`/api/assistant/commands/${cmd.id}/result`, { vault: 'alpha-app', nonce: alphaNonce, ok: true, result: { vault: 'alpha-app', sessionId: 'new-chat-1' } });
    const r = await running;
    ok('the CLI gets the window\'s answer (the new chat\'s id)', r.code === 0 && r.json?.ok === true && r.json?.result?.sessionId === 'new-chat-1', r.stdout + r.stderr);

    // send / answer / focus / open: same path, one call each.
    const bSid2 = randomUUID();
    const beta2 = openChat(WebSocket, port, { vault: 'beta-app', sessionId: bSid2, mode: 'basic' });
    sockets.push(beta2);
    await beta2.say('hello');
    const through = async (args, vault, nonce, label) => {
      const running = cli(['assistant', ...args], env);
      const c = await nextCommand();
      await post(`/api/assistant/commands/${c.id}/bind`, { vault, label });
      const cl = await (await claim(c.id, { vault, nonce })).json();
      await post(`/api/assistant/commands/${c.id}/result`, { vault, nonce, ok: true, result: { did: cl.verb } });
      return { c, cl, r: await running };
    };
    const send = await through(['send', bSid2, 'and the changelog'], 'beta-app', betaNonce, 'scripted-beta');
    ok('send is relayed to the chat\'s own project window with the text', send.cl.verb === 'send' && send.cl.args?.sessionId === bSid2 && send.cl.args?.text === 'and the changelog' && send.c.args?.vault === 'beta-app' && send.r.code === 0, JSON.stringify(send.cl) + send.r.stderr);
    const ans = await through(['answer', bSid2, '--question', 'q1', '--choice', 'Postgres'], 'beta-app', betaNonce, 'scripted-beta');
    ok('answer is relayed with the question id and the choice', ans.cl.verb === 'answer' && ans.cl.args?.question === 'q1' && ans.cl.args?.choice === 'Postgres' && ans.r.code === 0, JSON.stringify(ans.cl) + ans.r.stderr);
    const foc = await through(['focus', 'alpha-app'], 'alpha-app', alphaNonce, 'scripted-alpha');
    ok('focus is relayed', foc.cl.verb === 'focus' && foc.r.code === 0, foc.r.stderr);
    const opn = await through(['open', 'alpha-app'], 'alpha-app', alphaNonce, 'scripted-alpha');
    ok('open is relayed', opn.cl.verb === 'open' && opn.r.code === 0, opn.r.stderr);

    // notify: the notch answers it itself, up its own socket.
    const nrun = cli(['assistant', 'notify', 'build is green'], env);
    const nc = await nextCommand();
    await asst.send({ type: 'assistant_command_result', id: nc.id, ok: true, result: { shown: true } });
    const nr = await nrun;
    ok('notify is answered by the notch up its own socket', nc.verb === 'notify' && nr.code === 0 && nr.json?.result?.shown === true, nr.stdout + nr.stderr);
    await post('/api/assistant/profile', { autonomy: 'ask' });
    asst.close();
    await sleep(500);
  }

  // ── latency: the delegation marker, the recall it buys, effort, pre-approved verbs ──────
  // Protocol level, against the contract the notch's doorbell uses (origin=assistant on the
  // chat URL). The stand-in reports its own env/argv; alpha is a haiku vault, beta a raw one.
  console.log('\n── latency: origin=assistant → cheap recall + medium effort; it survives a resume');
  {
    const turnIn = async (params, text = 'probe') => {
      const s = openChat(WebSocket, port, params);
      sockets.push(s);
      try { return { s, r: await s.say(text) }; } catch (err) { s.close(); return { s, r: null, err: String(err) }; }
    };
    const pick = (r) => JSON.stringify(r && { recallMode: r.recallMode, effort: r.effort, allowedTools: r.allowedTools, sessionIdArg: r.sessionIdArg, resumeArg: r.resumeArg });

    const ord = await turnIn({ vault: 'alpha-app', sessionId: randomUUID(), mode: 'basic' });
    ok('an ordinary chat in a haiku vault is unchanged: no forced recall mode, no --effort', ord.r?.recallMode === null && ord.r?.effort === null, pick(ord.r));
    ord.s.close();

    const delSid = randomUUID();
    const del = await turnIn({ vault: 'alpha-app', sessionId: delSid, mode: 'basic', origin: 'assistant' }, 'KEEP: delegated turn');
    ok('a delegated chat in a haiku vault recalls raw (model absent), never haiku', del.r?.recallMode === 'raw', pick(del.r));
    ok('a delegated basic chat with no URL effort runs --effort medium', del.r?.effort === 'medium', pick(del.r));
    ok('a delegated chat carries no --allowedTools', del.r !== null && del.r.allowedTools === null, pick(del.r));

    const plan = await turnIn({ vault: 'alpha-app', sessionId: randomUUID(), mode: 'plan', origin: 'assistant' });
    ok('a delegated plan chat keeps the default effort (no --effort)', plan.r !== null && plan.r.effort === null, pick(plan.r));
    plan.s.close();

    const beta = await turnIn({ vault: 'beta-app', sessionId: randomUUID(), mode: 'basic', origin: 'assistant' });
    ok('a delegated chat in a raw vault gets no forced recall mode (its own raw stands)', beta.r !== null && beta.r.recallMode === null, pick(beta.r));
    beta.s.close();

    // Close + resume the SAME conversation, WITHOUT origin on the URL: the server re-derives it.
    del.s.close();
    await sleep(LINGER_MS + 1000);
    const back = await turnIn({ vault: 'alpha-app', resume: delSid, mode: 'basic' });
    ok('delegate → close → resume the same id: it is a --resume of that conversation', back.r?.resumeArg === delSid, pick(back.r) + (back.err ?? ''));
    ok('…and it still carries the delegation marker (recall raw, effort medium)', back.r?.recallMode === 'raw' && back.r?.effort === 'medium', pick(back.r));
    back.s.close();

    // Control: an ordinary conversation resumed the same way stays ordinary.
    const plainSid = randomUUID();
    const plain = await turnIn({ vault: 'alpha-app', sessionId: plainSid, mode: 'basic' }, 'KEEP: plain turn');
    plain.s.close();
    await sleep(LINGER_MS + 1000);
    const plainBack = await turnIn({ vault: 'alpha-app', resume: plainSid, mode: 'basic' });
    ok('control: an ordinary chat closed + resumed stays ordinary (no forced recall)', plainBack.r?.resumeArg === plainSid && plainBack.r?.recallMode === null, pick(plainBack.r) + (plainBack.err ?? ''));
    plainBack.s.close();

    // The embedding model "on disk" (the three files isEmbedModelDownloaded checks) → hybrid.
    const modelDir = join(HOME, '.dreamcontext', 'models', 'Xenova', 'multilingual-e5-small');
    mkdirSync(join(modelDir, 'onnx'), { recursive: true });
    for (const f of ['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json']) writeFileSync(join(modelDir, f), '');
    try {
      const hyb = await turnIn({ vault: 'alpha-app', sessionId: randomUUID(), mode: 'basic', origin: 'assistant' });
      ok('with the model on disk, a delegated chat in a haiku vault recalls hybrid', hyb.r?.recallMode === 'hybrid', pick(hyb.r));
      hyb.s.close();
      const ordH = await turnIn({ vault: 'alpha-app', sessionId: randomUUID(), mode: 'basic' });
      ok('with the model on disk, an ordinary chat is still unchanged', ordH.r !== null && ordH.r.recallMode === null, pick(ordH.r));
      ordH.s.close();
      const asH = await turnIn({ vault: '__assistant__', sessionId: randomUUID(), mode: 'basic' });
      ok('with the model on disk, the __assistant__ spawn recalls hybrid', asH.r?.recallMode === 'hybrid', pick(asH.r));
      asH.s.close();
    } finally {
      rmSync(join(HOME, '.dreamcontext', 'models'), { recursive: true, force: true });
    }

    // --allowedTools on the __assistant__ argv follows autonomy: auto only.
    const allowed = {};
    for (const level of ['auto', 'bypass', 'ask']) {
      await post('/api/assistant/profile', { autonomy: level });
      await sleep(300);
      const as = await turnIn({ vault: '__assistant__', sessionId: randomUUID(), mode: 'basic' });
      allowed[level] = as.r ? as.r.allowedTools : 'no-report';
      as.s.close();
      await sleep(300);
    }
    ok('__assistant__ argv: --allowedTools "Bash(dreamcontext assistant:*)" under auto', allowed.auto === 'Bash(dreamcontext assistant:*)', JSON.stringify(allowed));
    ok('__assistant__ argv: no --allowedTools under bypass or ask', allowed.bypass === null && allowed.ask === null, JSON.stringify(allowed));
    await post('/api/assistant/profile', { autonomy: 'ask' });
  }

  // ── W2 notch UI in a real browser: collapse is never an unmount ───────────────────────
  console.log('\n── W2 notch UI (Chromium): collapsed past the linger, session + relay still answer');
  let browser = null;
  try {
    if (!existsSync(join(REPO, 'dist', 'dashboard', 'index.html'))) throw new Error('dist/dashboard missing — run npm run build first');
    const { chromium } = await import('playwright');
    // A fake microphone for the W3 hold-to-talk leg (Chromium's beep source; no prompt).
    browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    // The notch as the desktop app loads it: window `assistant` on a mocked Tauri bus (event
    // listen/unlisten are real, window calls are no-ops), a counted microphone. Without the
    // desktop runtime the composer hides its voice controls, and the FIT check below would
    // measure a footer the owner never sees.
    const notchTauri = () => {
      const handlers = new Map();
      let seq = 0;
      window.__mics = 0;
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => { window.__mics += 1; return gum(c); };
      // Unlisten is REAL here: the notch re-registers its hotkey listener when its status
      // loads, and a mock that kept the stale one would fire every edge twice — enough to
      // start a take on its own and make the W3 leg pass with the notch's forwarding removed.
      const drop = (event, id) => { const list = handlers.get(event); if (list) list.delete(id); };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: drop };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'assistant' }, currentWebview: { windowLabel: 'assistant', label: 'assistant' } },
        transformCallback: (cb) => { const id = ++seq; window[`_${id}`] = cb; return id; },
        invoke: async (cmd, args) => {
          if (cmd === 'plugin:event|listen') {
            const list = handlers.get(args.event) ?? new Set();
            list.add(args.handler);
            handlers.set(args.event, list);
            return args.handler;
          }
          if (cmd === 'plugin:event|unlisten') { drop(args.event, args.eventId); return null; }
          window.__calls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) });
          // A frame without monitor geometry keeps the window where it is (Notch.tsx frameItem),
          // which reads the window's own position: answer it as the native side would.
          if (cmd === 'plugin:window|outer_position') return { x: 0, y: 0 };
          if (cmd === 'plugin:window|scale_factor') return 1;
          return null;
        },
      };
      window.__calls = [];
      window.__fireTauri = (event, payload) => {
        const ids = [...(handlers.get(event) ?? [])];
        for (const id of ids) window[`_${id}`]?.({ event, id: 0, payload });
        return ids.length;
      };
    };
    // The open notch's own size (Notch.tsx PANEL_W x PANEL_H): the checks below measure THAT.
    const page = await browser.newPage({ viewport: { width: 580, height: 560 } });
    await page.addInitScript(notchTauri);
    // Speech is the W3 leg's business; here it must never reach the real /focus (it would
    // pause THIS machine's music) or a paid TTS call.
    await page.route('**/api/agent/voice/tts', (route) => route.fulfill({ status: 204, body: '' }));
    await page.route('**/api/agent/voice/focus', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, holder: null, ducked: false, gain: 1, paused: [] }) }));
    await page.goto(`${base}/?assistant=1`);
    await page.waitForSelector('.dc-notch__pill', { timeout: 20_000 });
    ok('the notch renders its pill with the assistant\'s name', (await page.textContent('.dc-notch__pill'))?.includes('Nova'));
    ok('it starts collapsed (panel hidden)', await page.locator('.dc-notch__panel').isHidden());
    await page.click('.dc-notch__pill');
    await page.waitForSelector('.dc-notch__panel:not([hidden]) textarea', { timeout: 20_000 });
    ok('expanding shows the reused chat pane and composer', await page.locator('.dc-notch__chat .agent-pane-chat textarea').count() > 0);
    // The open notch is ONE black island: the pill row stays on top (the reused ChatPane is
    // `position: absolute; inset: 0` and once painted over it), and every layer is the housing black.
    const earHit = await page.evaluate(() => {
      const ear = document.querySelector('.dc-notch__ear--left')?.getBoundingClientRect();
      if (!ear) return 'no left ear';
      const hit = document.elementFromPoint(ear.x + Math.min(12, ear.width / 2), ear.y + ear.height / 2);
      return hit?.closest('.dc-notch__pill') ? 'pill' : (hit ? `${hit.tagName}.${hit.className}` : 'nothing');
    });
    ok('open, the pill\'s left ear is on top (elementFromPoint lands in .dc-notch__pill)', earHit === 'pill', earHit);
    const black = await page.evaluate(() => {
      const bg = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).backgroundColor : 'missing'; };
      const pane = document.querySelector('.dc-notch__chat .agent-pane-chat');
      const notch = document.querySelector('.dc-notch');
      return {
        pill: bg('.dc-notch__pill'), panel: bg('.dc-notch__panel'), chatPane: bg('.dc-notch__chat .chat-pane'),
        paneVar: pane ? getComputedStyle(pane).getPropertyValue('--color-bg').trim() : 'missing',
        surface: notch ? getComputedStyle(notch).getPropertyValue('--notch-surface').trim() : 'missing',
      };
    });
    ok('open, the pill, the panel and the chat pane draw on the notch black, not the app\'s palette',
      black.pill === 'rgb(0, 0, 0)' && black.panel === 'rgb(0, 0, 0)' && black.chatPane === 'rgb(0, 0, 0)'
        && black.surface !== '' && black.paneVar === black.surface, JSON.stringify(black));
    await page.fill('.dc-notch__chat textarea', 'ping from verify');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.innerText.includes('"said":"ping from verify"'), null, { timeout: 30_000 });
    // W7 FIT: at the open notch's own size, every visible control in the composer footer sits
    // wholly inside the composer box and no two of them overlap (the owner's screenshot had the
    // + on top of the context ring and the hint squeezed under the pickers). Measured after a
    // turn, so the context ring is drawn too.
    await page.waitForTimeout(300);
    const fit = await page.evaluate(() => {
      const card = document.querySelector('.dc-notch__chat .chat-cmp-card');
      const bar = card?.querySelector('.chat-cmp-toolbar');
      if (!card || !bar) return { error: 'no composer card / toolbar' };
      const box = card.getBoundingClientRect();
      const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
      const seen = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const els = [...bar.querySelectorAll('button, .chat-cmp-voice-note')].filter(seen)
        .filter((el) => !el.parentElement?.closest('button'));
      const rects = els.map((el) => { const r = el.getBoundingClientRect(); return { n: name(el), l: r.left, t: r.top, r: r.right, b: r.bottom }; });
      const E = 0.5;
      const outside = rects.filter((r) => r.l < box.left - E || r.t < box.top - E || r.r > box.right + E || r.b > box.bottom + E).map((r) => r.n);
      const overlaps = [];
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (a.l < b.r - E && b.l < a.r - E && a.t < b.b - E && b.t < a.b - E) overlaps.push(`${a.n} × ${b.n}`);
      }
      const has = (sel) => els.some((el) => el.matches(sel));
      return {
        count: rects.length, outside, overlaps,
        present: { ring: has('.chat-cmp-usagebtn'), model: has('.chat-cmp-model-wrap .chat-cmp-modeltrigger'), mic: has('.chat-cmp-mic'), send: has('.chat-cmp-send:not(.chat-cmp-mic)'), readAloud: has('.chat-cmp-readaloud') },
      };
    });
    ok('FIT: the footer\'s controls are all there (context ring, model picker, mic, read-aloud, send)',
      !fit.error && Object.values(fit.present ?? {}).every(Boolean), JSON.stringify(fit));
    ok(`FIT: at ${580}x${560} every visible footer control is inside the composer box and none overlap`,
      !fit.error && fit.count > 0 && fit.outside.length === 0 && fit.overlaps.length === 0, JSON.stringify(fit));
    if (process.env.VERIFY_SHOT_DIR) {
      mkdirSync(process.env.VERIFY_SHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.VERIFY_SHOT_DIR, 'notch-open.png') });
    }
    const firstPid = await page.evaluate(() => /"cwd":"([^"]+)"/.exec(document.body.innerText)?.[1] ?? '');
    ok('the notch chat runs in the hidden vault', firstPid.endsWith('/.dreamcontext/assistant'), firstPid);
    // A turn pops the notch out to the side by itself (owner, 2026-09-27) and it goes home once
    // the turn is over; wait for that, then open it by hand for the Escape check.
    await page.waitForFunction(() => !document.querySelector('.dc-notch--window'), null, { timeout: 15_000 }).catch(() => {});
    if (await page.locator('.dc-notch__panel').isHidden()) {
      await page.click('.dc-notch__pill');
      await page.waitForSelector('.dc-notch__panel:not([hidden]) textarea', { timeout: 10_000 });
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('Escape collapses it', await page.locator('.dc-notch__panel').isHidden());
    ok('collapsed, the chat pane is still MOUNTED', await page.locator('.dc-notch__chat .agent-pane-chat').count() === 1);
    await page.waitForTimeout(LINGER_MS + 1500);
    const n = await cli(['assistant', 'notify', 'still here'], env);
    ok(`past the ${LINGER_MS} ms linger, the collapsed notch still answers the relay`, n.code === 0 && n.json?.ok === true, n.stdout + n.stderr);
    await page.click('.dc-notch__pill');
    await page.evaluate(() => { window.__calls.length = 0; });
    await page.fill('.dc-notch__chat textarea', 'second turn');
    await page.keyboard.press('Enter');
    // ── WHILE IT WORKS, IT STEPS OUT (owner, 2026-09-27) ──
    console.log('\n── a turn pops the notch out to the side, glowing, and it goes home afterwards');
    const glowing = await page.waitForSelector('.dc-notch--window .dc-notch__glow', { timeout: 5000 }).then(() => true, () => false);
    ok('a turn starting pops it out to the side seat, wearing the working glow', glowing);
    if (process.env.VERIFY_SHOT_DIR && glowing) {
      mkdirSync(process.env.VERIFY_SHOT_DIR, { recursive: true });
      await page.setViewportSize({ width: 480, height: 620 });
      // The stand-in agent answers in milliseconds, so the real glow is gone by now; the shot
      // puts the same element back to show what it looks like.
      await page.evaluate(() => {
        const root = document.querySelector('.dc-notch');
        if (root && !root.querySelector('.dc-notch__glow')) root.insertAdjacentHTML('afterbegin', '<span class="dc-notch__glow" aria-hidden="true"></span>');
      });
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(process.env.VERIFY_SHOT_DIR, 'notch-working-glow.png') });
      await page.setViewportSize({ width: 580, height: 560 });
    }
    const same = await page.waitForFunction(() => document.body.innerText.includes('"said":"second turn"'), null, { timeout: 30_000 }).then(() => true, () => false);
    ok('and the SAME session still answers a new turn', same);
    // The stand-in answers in milliseconds; the pop-out's frame lands a few IPCs later
    // (show, outer_position, scale_factor, then set_frames), so wait for it before reading.
    await page.waitForFunction(() => window.__calls.some((c) => c.cmd === 'set_frames'), null, { timeout: 5000 }).catch(() => {});
    const popCalls = await page.evaluate(() => window.__calls.map((c) => {
      if (c.cmd === 'plugin:event|emit') return `emit ${c.args.event} ${JSON.stringify(c.args.payload)}`;
      if (c.cmd === 'plugin:window|set_size') { const v = c.args.value; const z = v?.Logical ?? v?.data ?? v; return `set_size ${z?.width}x${z?.height}`; }
      // Windows move through ONE set_frames call (lib/windowFrames.ts → frames.rs): label + size per item.
      if (c.cmd === 'set_frames') return `set_frames ${(c.args.items ?? []).map((i) => `${i.label} ${i.width}x${i.height}`).join(',')}`;
      if (c.cmd === 'plugin:window|set_focus') return 'set_focus';
      return null;
    }).filter(Boolean));
    ok('it asked for the window seat at the side size (480x620)', popCalls.includes('emit assistant://seat {"seat":"window"}') && popCalls.includes('set_frames assistant 480x620'), popCalls.join(' | ') + ' || all: ' + (await page.evaluate(() => window.__calls.map((c) => c.cmd).join(','))));
    ok('stepping out never takes focus from the app the owner is in', !popCalls.slice(0, popCalls.indexOf('set_frames assistant 480x620') + 1).includes('set_focus'), popCalls.join(' | '));
    const home = await page.waitForFunction(() => !document.querySelector('.dc-notch--window') && !!document.querySelector('.dc-notch__panel[hidden]'), null, { timeout: 15_000 }).then(() => true, () => false);
    ok('once the turn is over (nothing read aloud: after the reading pause) it goes home to the collapsed notch', home);
    const homeCalls = await page.evaluate(() => window.__calls.filter((c) => c.cmd === 'plugin:event|emit').map((c) => JSON.stringify(c.args.payload)));
    ok('going home asks the native side for the notch seat', homeCalls.includes('{"seat":"notch"}'), homeCalls.join(' | '));
    await page.click('.dc-notch__pill');
    await page.waitForSelector('.dc-notch__panel:not([hidden]) textarea', { timeout: 10_000 });
    const cfg = JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'assistant', 'config.json'), 'utf-8'));
    ok('the notch saved its conversation id for the next summon', /^[0-9a-f-]{36}$/.test(cfg.conversationId ?? ''), JSON.stringify(cfg));

    // W7 pop-out: the SAME webview leaves the notch seat and floats as a window. In the browser
    // there is no native seat, so the viewport is resized the way assistant.rs resizes the
    // window; what is proven here is that nothing inside is rebuilt: the same pane NODE, no new
    // chat socket, the same session answering, and Dock bringing it back.
    console.log('\n── W7 pop out as a window, then dock (same pane, same socket, same session)');
    const newSockets = [];
    page.on('websocket', (w) => { if (w.url().includes('/api/agent/chat')) newSockets.push(w.url()); });
    await page.evaluate(() => { window.__paneBefore = document.querySelector('.dc-notch__chat .agent-pane-chat'); window.__calls.length = 0; });
    const seatCalls = () => page.evaluate(() => window.__calls.map((c) => {
      if (c.cmd === 'plugin:event|emit') return `emit ${c.args.event} ${JSON.stringify(c.args.payload)}`;
      if (c.cmd === 'plugin:window|set_size') { const v = c.args.value; const z = v?.Logical ?? v?.data ?? v; return `set_size ${z?.width}x${z?.height}`; }
      // Windows move through ONE set_frames call (lib/windowFrames.ts → frames.rs): label + size per item.
      if (c.cmd === 'set_frames') return `set_frames ${(c.args.items ?? []).map((i) => `${i.label} ${i.width}x${i.height}`).join(',')}`;
      return null;
    }).filter(Boolean));
    const popBtn = await page.locator('.dc-notch__popout').count();
    ok('the open notch offers "Pop out"', popBtn === 1);
    if (popBtn) await page.click('.dc-notch__popout');
    await page.setViewportSize({ width: 720, height: 640 });
    await page.waitForTimeout(300);
    const popped = await page.evaluate(() => {
      const root = document.querySelector('.dc-notch');
      const cs = root ? getComputedStyle(root) : null;
      return {
        window: !!root?.classList.contains('dc-notch--window'),
        samePane: document.querySelector('.dc-notch__chat .agent-pane-chat') === window.__paneBefore && !!window.__paneBefore,
        corners: cs ? [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius] : [],
        dock: !!document.querySelector('.dc-notch__dock'),
      };
    });
    ok('popped out: the window seat, all four corners rounded, a Dock control', popped.window && popped.dock && popped.corners.length === 4 && popped.corners.every((c) => parseFloat(c) > 0), JSON.stringify(popped));
    ok('popped out: the SAME .agent-pane-chat node (never an unmount)', popped.samePane, JSON.stringify(popped));
    const outCalls = await seatCalls();
    ok('popped out: it asks the native side for the window seat, then sizes itself 720x640',
      outCalls.join(' | ') === 'emit assistant://seat {"seat":"window"} | set_frames assistant 720x640', outCalls.join(' | '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('popped out, Escape does not close the window', await page.locator('.dc-notch__panel').isVisible());
    await page.fill('.dc-notch__chat textarea', 'turn from the window');
    await page.keyboard.press('Enter');
    const winTurn = await page.waitForFunction(() => document.body.innerText.includes('"said":"turn from the window"'), null, { timeout: 30_000 }).then(() => true, () => false);
    ok('popped out, the same session answers a new turn over the same socket (no new chat socket)', winTurn && newSockets.length === 0, `answered=${winTurn} newSockets=${JSON.stringify(newSockets)}`);
    if (process.env.VERIFY_SHOT_DIR) await page.screenshot({ path: join(process.env.VERIFY_SHOT_DIR, 'notch-popout.png') });
    await page.evaluate(() => { window.__calls.length = 0; });
    if (popped.dock) await page.click('.dc-notch__dock');
    await page.setViewportSize({ width: 580, height: 560 });
    await page.waitForTimeout(300);
    const dockCalls = await seatCalls();
    ok('Dock asks the native side for the notch seat and sizes back to the open notch (580x560)',
      dockCalls.join(' | ') === 'emit assistant://seat {"seat":"notch"} | set_frames assistant 580x560', dockCalls.join(' | '));
    await page.waitForTimeout(300);
    const docked = await page.evaluate(() => ({
      window: !!document.querySelector('.dc-notch--window'),
      popout: !!document.querySelector('.dc-notch__popout'),
      open: !document.querySelector('.dc-notch__panel')?.hidden,
      samePane: document.querySelector('.dc-notch__chat .agent-pane-chat') === window.__paneBefore,
    }));
    ok('Dock returns it to the notch seat, still open, still the same pane', !docked.window && docked.popout && docked.open && docked.samePane, JSON.stringify(docked));
    await page.close();

    // ── the notch shows it is working the moment you send, before any server frame ──────
    // Every inbound frame on the chat socket is HELD in the page while the send happens, so
    // whatever lights up can only have come from the client's own optimistic state.
    console.log('\n── the notch lights up within 300 ms of send, with every server frame held back');
    const wpage = await browser.newPage({ viewport: { width: 580, height: 560 } });
    await wpage.addInitScript(notchTauri);
    await wpage.addInitScript(() => {
      window.__holdFrames = false;
      window.__held = [];
      const chat = (ws) => typeof ws.url === 'string' && ws.url.includes('/api/agent/chat');
      const gate = (ws, fn) => function (ev) {
        if (window.__holdFrames && chat(ws)) { window.__held.push(() => fn.call(this, ev)); return undefined; }
        return fn.call(this, ev);
      };
      const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(fn) { desc.set.call(this, typeof fn === 'function' ? gate(this, fn) : fn); },
      });
      const add = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (type, fn, o) {
        return add.call(this, type, type === 'message' && typeof fn === 'function' ? gate(this, fn) : fn, o);
      };
      window.__releaseFrames = () => { window.__holdFrames = false; const h = window.__held.splice(0); h.forEach((f) => f()); return h.length; };
      document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && window.__holdFrames && window.__sendAt == null) window.__sendAt = performance.now(); }, true);
      new MutationObserver(() => {
        if (window.__holdFrames && window.__glowAt == null && document.querySelector('.dc-notch__glow')) window.__glowAt = performance.now();
      }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    await wpage.goto(`${base}/?assistant=1`);
    await wpage.waitForSelector('.dc-notch__pill', { timeout: 20_000 });
    await wpage.click('.dc-notch__pill');
    await wpage.waitForSelector('.dc-notch__panel:not([hidden]) textarea', { timeout: 20_000 });
    await wpage.waitForTimeout(1500);   // the chat socket is open and the session idle
    ok('before the send, the notch is not wearing the working glow', await wpage.locator('.dc-notch__glow').count() === 0);
    await wpage.fill('.dc-notch__chat textarea', 'working state probe');
    await wpage.evaluate(() => { window.__sendAt = null; window.__glowAt = null; window.__holdFrames = true; });
    await wpage.keyboard.press('Enter');
    await wpage.waitForFunction(() => window.__glowAt != null, null, { timeout: 2000 }).catch(() => null);
    const lit = await wpage.evaluate(() => ({ sendAt: window.__sendAt, glowAt: window.__glowAt, held: window.__held.length, holding: window.__holdFrames }));
    const dt = lit.sendAt != null && lit.glowAt != null ? Math.round(lit.glowAt - lit.sendAt) : null;
    ok('send → the working glow within 300 ms, while no server frame had reached the page', dt !== null && dt >= 0 && dt < 300 && lit.holding === true, JSON.stringify({ ...lit, dt }));
    const releasedFrames = await wpage.evaluate(() => window.__releaseFrames());
    const answered = await wpage.waitForFunction(() => document.body.innerText.includes('"said":"working state probe"'), null, { timeout: 30_000 }).then(() => true, () => false);
    ok('releasing the held frames, the same turn is answered', answered, `released ${releasedFrames} frames`);
    await wpage.close();

    // W7 the pill's right ear speaks the tab strip's language: ring bubbles, not a sentence.
    // The counts are routed (lane B owns what the server counts); first a server that does
    // not send `stale` yet, then one that does, so the forward-compatible read is proven too.
    console.log('\n── W7 the pill\'s right ear: the tab strip\'s bubbles, stale never green');
    const rpage = await browser.newPage({ viewport: { width: 580, height: 560 } });
    let rollupBody = { starting: 0, working: 1, asking: 0, idle: 4, proposals: 0 };
    await rpage.route('**/api/assistant/rollup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rollupBody) }));
    await rpage.goto(`${base}/?assistant=1`);
    await rpage.waitForSelector('.dc-notch__ear--right .project-tab-bubble', { timeout: 20_000 }).catch(() => null);
    const ear = () => rpage.evaluate(() => {
      const e = document.querySelector('.dc-notch__ear--right');
      const pill = document.querySelector('.dc-notch__pill')?.getBoundingClientRect();
      const bs = e?.querySelector('.project-tab-bubbles')?.getBoundingClientRect();
      return {
        label: e?.getAttribute('aria-label') ?? null,
        text: e?.textContent ?? '',
        // How far the bubbles sit from the pill's right edge (its padding is 16px).
        gapRight: pill && bs ? Math.round(pill.right - bs.right) : null,
        bubbles: [...(e?.querySelectorAll('.project-tab-bubble') ?? [])].map((b) => ({
          state: b.getAttribute('data-state'), n: b.querySelector('.project-tab-bubble-n')?.textContent ?? '',
          ring: !!b.querySelector('.project-tab-bubble-ring'), h: getComputedStyle(b).height, radius: getComputedStyle(b).borderTopLeftRadius,
        })),
      };
    });
    const pre = await ear();
    ok('before the server sends stale: a green ring bubble 1 and a grey bubble 4, said "1 working, 4 idle"',
      JSON.stringify(pre.bubbles.map((b) => [b.state, b.n, b.ring])) === JSON.stringify([['working', '1', true], ['idle', '4', false]]) && pre.label === '1 working, 4 idle', JSON.stringify(pre));
    rollupBody = { starting: 0, working: 1, stale: 5, asking: 0, idle: 4, proposals: 0 };
    await rpage.waitForFunction(() => document.querySelector('.dc-notch__ear--right')?.getAttribute('aria-label') === '1 working, 4 idle, 5 stale', null, { timeout: 10_000 }).catch(() => null);
    const post5 = await ear();
    ok('working=1 idle=4 stale=5: ONE green ring bubble (1) and ONE grey bubble (9), no "0", no sentence',
      JSON.stringify(post5.bubbles.map((b) => [b.state, b.n, b.ring])) === JSON.stringify([['working', '1', true], ['idle', '9', false]])
        && !/working|idle|stale/.test(post5.text), JSON.stringify(post5));
    ok('the bubbles wear the tab strip\'s own CSS (16px pills), not unstyled text', post5.bubbles.length > 0 && post5.bubbles.every((b) => b.h === '16px' && parseFloat(b.radius) >= 8), JSON.stringify(post5.bubbles));
    ok('its aria-label says the counts in words: "1 working, 4 idle, 5 stale"', post5.label === '1 working, 4 idle, 5 stale', String(post5.label));
    ok('without a camera housing the bubbles still sit at the pill\'s right end (not in the middle)', post5.gapRight !== null && post5.gapRight <= 24, `gapRight=${post5.gapRight}`);
    await rpage.close();

    // ── W2 anti-forgery in the UI: forged doorbells land nothing; a real one does ──────────
    console.log('\n── W2 forged doorbells in a project window (mocked Tauri event bus)');
    const vpage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await vpage.addInitScript(() => {
      const handlers = new Map();
      let seq = 0;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'vault-alpha-app' }, currentWebview: { windowLabel: 'vault-alpha-app', label: 'vault-alpha-app' } },
        transformCallback: (cb) => { const id = ++seq; window[`_${id}`] = cb; return id; },
        invoke: async (cmd, args) => {
          if (cmd === 'plugin:event|listen') {
            const list = handlers.get(args.event) ?? [];
            list.push(window[`_${args.handler}`]);
            handlers.set(args.event, list);
            return args.handler;
          }
          if (cmd === 'plugin:webview|get_all_windows' || cmd === 'plugin:window|get_all_windows') return ['vault-alpha-app'];
          return null;
        },
      };
      window.__fireTauri = (event, payload) => { for (const h of handlers.get(event) ?? []) h({ event, id: 0, payload }); return (handlers.get(event) ?? []).length; };
    });
    await vpage.goto(`${base}/?vault=alpha-app`);
    await vpage.waitForTimeout(4000);
    const chatTabs = () => vpage.evaluate(() => document.querySelectorAll('.agent-pane-chat').length);
    const before = await chatTabs();
    const listeners = await vpage.evaluate(() => window.__fireTauri('noop', null));
    void listeners;
    const forged = [
      { commandId: 'f'.repeat(32), vault: 'alpha-app' },
      { commandId: 'not-hex', vault: 'alpha-app' },
      { commandId: '0'.repeat(32), vault: 'beta-app' },
    ];
    for (const p of forged) await vpage.evaluate((pl) => window.__fireTauri('dream://assistant-command', pl), p);
    await vpage.waitForTimeout(1500);
    ok('forged doorbells (unknown id, malformed id, other vault) land NOTHING in the project', await chatTabs() === before, `${before} → ${await chatTabs()}`);

    // Positive control: a REAL command, minted by the assistant and bound to this window.
    // The scripted window above registered under OTHER labels, so a bind to `vault-alpha-app`
    // succeeds only if the page itself registered at mount.
    const chatUrls = [];
    vpage.on('websocket', (w) => { if (w.url().includes('/api/agent/chat')) chatUrls.push(w.url()); });
    const notch = openChat(WebSocket, port, { vault: '__assistant__', sessionId: randomUUID(), mode: 'assistant' });
    sockets.push(notch);
    const realCmds = [];
    notch.ws.on('message', (raw) => { try { const f = JSON.parse(raw.toString('utf-8')); if (f?.subtype === 'assistant_command') realCmds.push(f); } catch { /* */ } });
    await notch.send({ type: 'assistant_surface' });
    await sleep(300);
    const token2 = (await notch.say('who am i')).token;
    const realRun = cli(['assistant', 'chat', 'alpha-app', '--prompt', 'real doorbell prompt'], { ...env, DREAMCONTEXT_ASSISTANT_TOKEN: token2 });
    let rc = null;
    for (let i = 0; i < 40 && !rc; i++) { await sleep(250); rc = realCmds[0] ?? null; }
    const bound = rc ? (await post(`/api/assistant/commands/${rc.id}/bind`, { vault: 'alpha-app', label: 'vault-alpha-app' })).status : 0;
    ok('the project window registered itself with the server at mount', bound === 200, `bind status ${bound}`);
    if (rc) await vpage.evaluate((pl) => window.__fireTauri('dream://assistant-command', pl), { commandId: rc.id, vault: 'alpha-app' });
    const realOut = await realRun;
    ok('a REAL doorbell is claimed and the project opens the chat (positive control)', realOut.code === 0 && typeof realOut.json?.result?.sessionId === 'string', realOut.stdout + realOut.stderr);
    const delegatedUrl = chatUrls.find((u) => typeof realOut.json?.result?.sessionId === 'string' && u.includes(encodeURIComponent(realOut.json.result.sessionId))) ?? '';
    ok('the chat the doorbell opened connects with origin=assistant on its WS URL', new URL(delegatedUrl || 'ws://x/').searchParams.get('origin') === 'assistant', JSON.stringify(chatUrls));
    ok('no other chat socket this project opened carries an origin', chatUrls.filter((u) => u !== delegatedUrl).every((u) => !new URL(u).searchParams.has('origin')), JSON.stringify(chatUrls));
    if (rc) {
      await vpage.evaluate((pl) => window.__fireTauri('dream://assistant-command', pl), { commandId: rc.id, vault: 'alpha-app' });
      await vpage.waitForTimeout(1000);
    }
    ok('replaying the same real id lands nothing more', await chatTabs() <= before + 1, `${before} → ${await chatTabs()}`);
    await vpage.close();

    // ── W3 voice: the Rust hotkey's edges drive the notch composer's microphone ─────────────
    // Tauri is mocked (the notch is window `assistant`); the microphone is Chromium's fake
    // device; only /stt is stubbed, and it is asserted to be addressed to the hidden vault (the
    // lexicon with the project names lives there). No second model rewrites the take
    // (owner, 2026-09-27): what was heard is what is sent.
    console.log('\n── W3 hold-to-talk in the notch (Rust hotkey edges → composer mic)');
    const npage = await browser.newPage({ viewport: { width: 600, height: 720 } });
    await npage.addInitScript(notchTauri);
    const voiceCalls = [];
    await npage.route('**/api/agent/voice/stt', (route) => {
      voiceCalls.push({ kind: 'stt', vault: route.request().headers()['x-dreamcontext-vault'] ?? '' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'send the rule to tilki' }) });
    });
    await npage.route('**/api/agent/voice/correct', (route) => {
      voiceCalls.push({ kind: 'correct', vault: route.request().headers()['x-dreamcontext-vault'] ?? '' });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await npage.goto(`${base}/?assistant=1`);
    await npage.waitForSelector('.dc-notch__pill', { timeout: 20_000 });
    await npage.waitForFunction(() => document.querySelector('.dc-notch__chat .agent-pane-chat textarea'), null, { timeout: 20_000 });
    ok('the notch is collapsed before the hotkey', await npage.locator('.dc-notch__panel').isHidden());
    await npage.waitForTimeout(1000);   // past the status fetch, so the listener is the final one
    // Fired the moment the notch's listener exists (it registers after the status fetch).
    const fired = await npage.waitForFunction(() => window.__fireTauri('assistant://hotkey', { state: 'pressed' }) || 0, null, { timeout: 10_000 }).then((h) => h.jsonValue(), () => 0);
    await npage.waitForTimeout(300);
    ok('exactly one notch listener takes the hotkey edge', fired === 1, `listeners fired: ${fired}`);
    ok('the hotkey PRESS summons the panel', await npage.locator('.dc-notch__panel').isVisible());
    const opened = await npage.waitForFunction(() => window.__mics > 0, null, { timeout: 5000 }).then(() => true, () => false);
    ok('…and the same press opens the microphone in the notch composer', opened, `getUserMedia calls: ${await npage.evaluate(() => window.__mics)}`);
    await npage.waitForTimeout(1800);
    await npage.evaluate(() => window.__fireTauri('assistant://hotkey', { state: 'released' }));
    const heard = await npage.waitForFunction(() => document.body.innerText.includes('"said":"send the rule to tilki"'), null, { timeout: 15_000 }).then(() => true, () => false);
    ok('the RELEASE ends the take: transcribed, and the transcript is SENT as heard', heard, JSON.stringify(voiceCalls) + ' draft=' + await npage.evaluate(() => document.querySelector('.dc-notch__chat textarea')?.value));
    ok('transcription is addressed to the hidden vault', voiceCalls.some((c) => c.kind === 'stt') && voiceCalls.every((c) => c.vault === '__assistant__'), JSON.stringify(voiceCalls));
    ok('no correction call is made — nothing but the transcriber sees the take', !voiceCalls.some((c) => c.kind === 'correct'), JSON.stringify(voiceCalls));

    // Speech in the notch: the reply is read aloud (TTS), the machine's music is held for it
    // (/focus hold → release), and Hush silences it mid-answer. Both routes are stubbed — the
    // real /focus would pause THIS machine's player — and the TTS audio is 3 s of silence so
    // there is an answer still playing when Hush is pressed.
    const focusCalls = [];
    let ttsCalls = 0;
    const silentWav = (() => {
      const rate = 16000, n = rate * 3, b = Buffer.alloc(44 + n * 2);
      b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
      b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
      b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
      return b;
    })();
    await npage.route('**/api/agent/voice/tts', (route) => { ttsCalls += 1; return route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav }); });
    await npage.route('**/api/agent/voice/focus', (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      focusCalls.push(body.hold === true ? 'hold' : 'release');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, holder: body.session ?? null, ducked: false, gain: 1, paused: body.hold ? ['Music'] : [] }) });
    });
    // Read-aloud is the owner's switch in the composer and starts OFF (owner 2026-09-26: it
    // must speak only when switched on): a reply with the switch off is not spoken; then the
    // switch is turned on for the speech checks below.
    await npage.fill('.dc-notch__chat textarea', 'A quiet reply please.');
    await npage.keyboard.press('Enter');
    await npage.waitForFunction(() => document.body.innerText.includes('"said":"A quiet reply please."'), null, { timeout: 30_000 }).catch(() => null);
    await npage.waitForTimeout(1500);
    const switchState = () => npage.evaluate(() => document.querySelector('.dc-notch__chat .chat-cmp-readaloud')?.getAttribute('aria-pressed') ?? 'missing');
    const offState = await switchState();
    ok('read-aloud starts OFF and a reply is NOT spoken', offState === 'false' && ttsCalls === 0, `switch=${offState} tts=${ttsCalls}`);
    if (offState === 'false') await npage.click('.dc-notch__chat .chat-cmp-readaloud');
    ok('the composer\'s read-aloud switch turns it on', await switchState() === 'true', await switchState());
    await npage.fill('.dc-notch__chat textarea', 'Read this answer aloud please.');
    await npage.keyboard.press('Enter');
    const spoke = await npage.waitForSelector('.dc-notch__chat .chat-cmp-hush', { timeout: 30_000 }).then(() => true, () => false);
    ok('the notch reads the reply aloud (TTS from the notch, speaking indicator shown)', spoke && ttsCalls > 0, `tts=${ttsCalls} focus=${focusCalls.join(',')}`);
    ok('the machine\'s music is held while it speaks (/focus hold)', focusCalls.includes('hold'), focusCalls.join(','));
    if (spoke) await npage.click('.dc-notch__chat .chat-cmp-hush');
    const hushed = await npage.waitForSelector('.dc-notch__chat .chat-cmp-hush', { state: 'detached', timeout: 5000 }).then(() => true, () => false);
    ok('Hush silences it mid-answer', spoke && hushed);
    let released = false;
    for (let i = 0; i < 40 && !released; i++) { released = focusCalls.includes('release'); if (!released) await sleep(250); }
    ok('…and the music is handed back (/focus release)', released, focusCalls.join(','));
    await npage.close();

    // ── W4: tile + a detail click, notch → project window ─────────────────────────────────
    // ONE browser context, so the notch and the project page share the window registry the
    // way two Tauri windows share it. Each page gets a Tauri mock under its own label; the
    // notch's emitTo is carried to the addressed page by a binding, the way Tauri would.
    console.log('\n── W4 tile + detail click (notch → project window)');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const byLabel = {};
    const emits = [];
    await ctx.exposeBinding('__relayEmit', async (_src, target, event, payload) => {
      emits.push({ target, event });
      const pg = byLabel[target];
      if (pg) await pg.evaluate(([e, p]) => window.__fireTauri(e, p), [event, payload]);
    });
    const mockTauri = (label) => {
      const handlers = new Map();
      let seq = 0;
      window.__winCalls = [];
      const drop = (event, id) => { const list = handlers.get(event); if (list) list.delete(id); };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: drop };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
        transformCallback: (cb) => { const id = ++seq; window[`_${id}`] = cb; return id; },
        invoke: async (cmd, args) => {
          if (cmd === 'plugin:event|listen') {
            const list = handlers.get(args.event) ?? new Set();
            list.add(args.handler);
            handlers.set(args.event, list);
            return args.handler;
          }
          if (cmd === 'plugin:event|unlisten') { drop(args.event, args.eventId); return null; }
          if (cmd === 'plugin:event|emit_to') {
            const t = typeof args.target === 'string' ? args.target : args.target?.label;
            await window.__relayEmit(t, args.event, args.payload);
            return null;
          }
          if (cmd === 'plugin:window|get_all_windows') return ['assistant', 'vault-alpha-app', 'vault-beta-app'];
          if (cmd === 'plugin:window|current_monitor') {
            return { name: 'Verify', scaleFactor: 2, position: { x: 0, y: 0 }, size: { width: 3600, height: 2336 }, workArea: { position: { x: 0, y: 50 }, size: { width: 3600, height: 2240 } } };
          }
          if (cmd === 'set_frames') { window.__winCalls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) }); return null; }
          if (cmd.startsWith('plugin:window|')) window.__winCalls.push({ cmd: cmd.slice(14), args: JSON.parse(JSON.stringify(args ?? {})) });
          return null;
        },
      };
      window.__fireTauri = (event, payload) => {
        const ids = [...(handlers.get(event) ?? [])];
        for (const id of ids) window[`_${id}`]?.({ event, id: 0, payload });
        return ids.length;
      };
    };
    const proj = await ctx.newPage();
    await proj.addInitScript(mockTauri, 'vault-alpha-app');
    byLabel['vault-alpha-app'] = proj;
    await proj.goto(`${base}/?vault=alpha-app`);
    await proj.waitForTimeout(4000);
    const notch4 = await ctx.newPage();
    await notch4.addInitScript(mockTauri, 'assistant');
    byLabel.assistant = notch4;
    await notch4.goto(`${base}/?assistant=1`);
    await notch4.waitForSelector('.dc-notch__pill', { timeout: 20_000 });
    await notch4.click('.dc-notch__pill');
    await notch4.waitForSelector('.dc-notch__panel:not([hidden]) textarea', { timeout: 20_000 });
    await notch4.waitForTimeout(1500);

    // Tile: the rects each window is handed, on the notch's monitor (work area 1800×1120 at
    // y=25, logical). Columns → two side by side with the 8 px gap; rows → stacked.
    const tileCase = async (layout, expect) => {
      await notch4.evaluate(() => { window.__winCalls.length = 0; });
      const r = await cli(['assistant', 'tile', 'alpha-app', 'beta-app', '--layout', layout], env);
      const calls = await notch4.evaluate(() => window.__winCalls);
      // Each window's whole frame, from the set_frames call that moved it (tile.ts → windowFrames.ts).
      const rect = (label) => {
        const it = calls.filter((c) => c.cmd === 'set_frames').flatMap((c) => c.args.items ?? []).find((i) => i.label === label);
        return it ? { x: it.x, y: it.y, width: it.width, height: it.height } : null;
      };
      const got = { alpha: rect('vault-alpha-app'), beta: rect('vault-beta-app') };
      ok(`tile --layout ${layout}: each project's OWN window gets its measured slot`, r.code === 0 && r.json?.ok === true && JSON.stringify(got) === JSON.stringify(expect), JSON.stringify({ got, expect, out: r.stdout + r.stderr, calls: calls.slice(0, 6) }));
    };
    await tileCase('columns', { alpha: { x: 0, y: 25, width: 896, height: 1120 }, beta: { x: 904, y: 25, width: 896, height: 1120 } });
    await tileCase('rows', { alpha: { x: 0, y: 25, width: 1800, height: 556 }, beta: { x: 0, y: 589, width: 1800, height: 556 } });

    // Detail click: the assistant answers with a dream-actions button naming the project.
    const answer = `SAY:Found it.\n\n\`\`\`dream-actions\n[{"label":"Open the login task","action":"task","id":"${ALPHA_TASK}","vault":"alpha-app"}]\n\`\`\``;
    const detailTitle = () => proj.evaluate(() => document.querySelector('.detail-panel .detail-title')?.textContent ?? '');
    ok('before the click the project shows no task detail', await detailTitle() === '', await detailTitle());
    await notch4.fill('.dc-notch__chat textarea', answer);
    await notch4.keyboard.press('Enter');
    const btn = notch4.locator('.dc-notch__chat button', { hasText: 'Open the login task' });
    const shown = await btn.first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    ok('the notch answer renders the detail button', shown);
    const emitsBefore = emits.length;
    if (shown) await btn.first().click();
    const landed = await proj.waitForFunction(() => document.querySelector('.detail-panel .detail-title')?.textContent === 'Fix the login flow', null, { timeout: 15_000 }).then(() => true, () => false);
    const rang = emits.slice(emitsBefore).some((e) => e.target === 'vault-alpha-app' && e.event === 'dream://assistant-command');
    ok('the click rings THAT project\'s window through the relay (doorbell to vault-alpha-app)', rang, JSON.stringify(emits.slice(emitsBefore)));
    ok('…and the project window opens THAT task\'s detail', landed, `detail="${await detailTitle()}" slug=${ALPHA_TASK}`);
    await ctx.close();
  } catch (err) {
    ok('the notch UI legs completed', false, err?.stack ?? String(err));
  } finally {
    if (browser) await browser.close();
  }

  // ── refusals ─────────────────────────────────────────────────────────────────────
  console.log('\n── refusals');
  {
    const r = await cli(['assistant', 'projects'], { DREAMCONTEXT_ASSISTANT_URL: '', DREAMCONTEXT_ASSISTANT_TOKEN: '' });
    ok('without the env: "only the dreamcontext Assistant can drive the app", exit 1', r.code === 1 && r.stderr.includes('only the dreamcontext Assistant can drive the app'), r.stderr);
    const stale = await cli(['assistant', 'projects'], { ...env, DREAMCONTEXT_ASSISTANT_TOKEN: `dca_${'0'.repeat(12)}_${'a'.repeat(48)}` });
    ok('a stale token: "the app restarted — this turn cannot drive it"', stale.code === 1 && stale.stderr.includes('the app restarted — this turn cannot drive it'), stale.stderr);
    const wrong = await cli(['assistant', 'projects'], { ...env, DREAMCONTEXT_ASSISTANT_TOKEN: a.token.slice(0, -1) + (a.token.endsWith('0') ? '1' : '0') });
    ok('a wrong token is refused', wrong.code === 1 && wrong.stderr.includes('bad_token'), wrong.stderr);
    const app = spawnSync(process.execPath, [CLI, 'app', '--help'], { env: { ...process.env, HOME }, encoding: 'utf-8' });
    ok('dreamcontext app install|update|status is untouched', ['install', 'update', 'status'].every((c) => app.stdout.includes(c)), app.stdout);
  }
} catch (err) {
  ok('the run completed', false, err?.stack ?? String(err));
} finally {
  for (const s of sockets) s.close();
  if (server) server.kill();
}

console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
process.exit(report.fails.length ? 1 : 0);
