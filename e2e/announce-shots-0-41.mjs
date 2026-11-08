/**
 * Capture the v0.41.0 announcement's screenshots: the drawer's Team row with its members, a
 * member's own stage, and the board explorer's group menu.
 * Forked from announce-shots-0-40.mjs (same fake HOME, stand-ins and seed; new scenes).
 *
 * Runs against the release candidate's own build over the fictional "orbit" demo vault in a fake
 * HOME under the OS temp dir (nothing real on screen). No turn is spent anywhere:
 *   - `claude` is a stand-in that answers from a fixed script;
 *   - `codex` is scripts/verify/fake-codex.mjs (T3's RECORDED Codex app-server frames), copied
 *     into the temp dir with the fixture words swapped for orbit's (FAKE AGENT, never a real turn);
 *   - `agy_acp_server.par` is T3's own mock ACP agent with the Antigravity profile.
 * The bridge and the mock ACP agent need Node 22, so run the script AND the server on Node 22.
 *
 *   T=$(node -e "console.log(require('fs').realpathSync(require('os').tmpdir()))")
 *   ROOT=$T/dc-ann-041 DC=$PWD/dist/index.js <main checkout>/marketing/build-demo-vault-v2.sh
 *   unlink $T/dc-ann-041/home/Library/Keychains     # no live Claude login in the fake HOME
 *   DEMO_ROOT=$T/dc-ann-041 <node 22> e2e/announce-shots-0-40.mjs
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that cannot be reached is reported and skipped.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const DEMO = process.env.DEMO_ROOT;
if (!DEMO) throw new Error('DEMO_ROOT is required (the demo vault root)');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('run on Node 22 (the Codex bridge and the mock ACP agent need it)');
const HOME = join(DEMO, 'home');
if (!realpathSync(HOME).startsWith(realpathSync(tmpdir()) + '/')) throw new Error('the demo HOME must sit under os.tmpdir()');
const PROJ = realpathSync(join(DEMO, 'proj'));
const REPO = resolve('.');
const CLI = resolve('dist/index.js');
const OUT = resolve(process.env.OUT_DIR ?? 'dashboard/public/announcements/shots/v0-41-0');
const RAW = join(DEMO, 'raw');
const BIN = join(HOME, '.local', 'bin');
const VAULT = 'orbit';
const ONLY = (process.env.ONLY ?? 'all').split(',');
const on = (g) => ONLY.includes('all') ? g !== 'probe' : ONLY.includes(g);
const FIXTURES = join(REPO, 'src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures');
const ACP_MOCK = join(REPO, 'src/vendor/t3/apps/server/scripts/acp-mock-agent.ts');
const REGISTER = join(REPO, 'scripts/t3-node-register.mjs');
for (const d of [OUT, RAW, BIN, join(HOME, '.codex'), join(HOME, '.dreamcontext')]) mkdirSync(d, { recursive: true });

// This Mac's name must not reach a shot: the fake HOME's machine record gets a fictional one.
{
  const f = join(HOME, '.dreamcontext', 'machine.json');
  const m = existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : { id: crypto.randomBytes(6).toString('hex') };
  writeFileSync(f, `${JSON.stringify({ ...m, name: 'orbit-studio' }, null, 2)}\n`);
}

// ── The stand-in `claude` ──────────────────────────────────────────────────────────────
const REPLIES = [
  ['trial-to-paid', 'Trial-to-paid fell from 18% to 13% the week the v2 onboarding emails shipped. Single-source trials carry the whole drop.'],
  ['at risk', 'Northwind and Kite Studio. Both connected Stripe only, and single-source trials convert at 11%. A second source on day 1 is the fix the investigation points to.'],
  ['churn', 'Monthly churn is 4.4%, down from 6.8% in March. Annual plans would lock in the teams that stay past month three.'],
];
const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const REPLIES = ${JSON.stringify(REPLIES)};
const reply = (t) => (REPLIES.find(([k]) => t.toLowerCase().includes(k)) ?? [null, 'On it.'])[1];
if (argv[0] === 'auth' || argv[0] === '--version' || argv[0] === 'mcp') { out({}); process.exit(0); }
if (argv.includes('-p') && !argv.includes('--input-format')) { out({ type: 'result', subtype: 'success', is_error: false, result: reply(argv.join(' ')), session_id: 'stand-in' }); process.exit(0); }
if (!argv.includes('stream-json')) { out({}); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || ('stand-in-' + process.pid);
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    const said = reply(text);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ── The stand-in `codex`: fake-codex.mjs with orbit's words instead of the fixture's ──────
// Every frame still comes from a recorded Codex app-server transcript; only the words change.
const CODEX_WORDS = [
  // the question card (plan_questions)
  ['Should this fixture prefer strict schemas or UI flexibility?', 'Which trials should the day-1 prompt reach first?'],
  ['"header":"Fixture"', '"header":"Day-1 prompt"'],
  ['Strict schemas (Recommended)', 'Single-source trials (Recommended)'],
  ['Keep fixture data tightly validated, even if UI variations are harder to represent.', 'They carry the whole drop: 11% trial-to-paid against 31% with two sources.'],
  ['UI flexibility', 'Every new trial'],
  ['Allow fixture shapes that better support varied UI states, with looser validation.', 'Simpler to ship, but two-source trials see a prompt they do not need.'],
  // the plan card (todo_list)
  ['Inspect package.json', 'Split last month\'s trials by data sources connected'],
  ['Inspect tsconfig.json', 'Compare trial-to-paid for one and two sources'],
  ['Report completion', 'Write the finding on the investigation task'],
  ["/bin/bash -lc 'cat package.json && cat tsconfig.json'", "/bin/bash -lc 'node scripts/trial-cohorts.mjs --by sources'"],
  ['cat package.json', 'node scripts/trial-cohorts.mjs --by sources'],
  ['cat tsconfig.json', 'node scripts/trial-cohorts.mjs --compare'],
  ['/home/replay-user/t3code/packages/effect-codex-app-server', '~/orbit'],
  ['Codex verify chat', 'Trials by data sources'],
];
const AGENT_TEXT = [
  ['plan questions fixture complete', 'Single-source trials first, then. I will put the day-1 prompt on the investigation task.'],
  ['todo list fixture complete', 'Two-source trials convert at 31%, single-source trials at 11%. The drop is the single-source trials.'],
  ['fixture simple ok', 'Trial-to-paid fell from 18% to 13% in one week. I will split it by data sources first.'],
];
{
  let src = readFileSync(join(REPO, 'scripts/verify/fake-codex.mjs'), 'utf-8');
  const swap = (a, b) => { if (!src.includes(a)) throw new Error(`fake-codex patch: anchor not found: ${a.slice(0, 60)}`); src = src.replace(a, b); };
  // Words: swapped on every frame on its way out.
  swap('const out = (frame) => { process.stdout.write(JSON.stringify(frame) + \'\\n\');',
    `const WORDS = ${JSON.stringify(CODEX_WORDS)};
const out = (frame) => { let s = JSON.stringify(frame); for (const [a, b] of WORDS) s = s.split(a).join(b.includes('"') ? b : JSON.stringify(b).slice(1, -1)); process.stdout.write(s + '\\n');`);
  // An agent message: its whole orbit text on the first delta, the rest of the deltas dropped.
  swap('    let frame = rehome(e.frame, from);',
    `    let frame = rehome(e.frame, from);
    {
      const AGENT_TEXT = ${JSON.stringify(AGENT_TEXT)};
      const p = frame.params ?? {};
      if (frame.method === 'item/agentMessage/delta') {
        const done = entries.find((x) => x.frame?.method === 'item/completed' && x.frame.params?.item?.id === e.frame.params?.itemId);
        const hit = AGENT_TEXT.find(([k]) => done?.frame.params.item.text?.includes(k));
        if (hit) { globalThis.__said ??= new Set(); if (globalThis.__said.has(p.itemId)) continue; globalThis.__said.add(p.itemId); frame = { ...frame, params: { ...p, delta: hit[1] } }; }
      }
      if (frame.method === 'item/completed' && p.item?.type === 'agentMessage') {
        const hit = AGENT_TEXT.find(([k]) => String(p.item.text ?? '').includes(k));
        if (hit) frame = { ...frame, params: { ...p, item: { ...p.item, text: hit[1] } } };
      }
    }`);
  // Which recorded turn plays is chosen by orbit's own words, not the fixture's capitals.
  swap("[/QUESTION/, 'plan_questions'],", "[/day-1 prompt/i, 'plan_questions'],");
  swap("[/PLAN/, 'todo_list'],", "[/split last month/i, 'todo_list'],");
  writeFileSync(join(DEMO, 'fake-codex.mjs'), src);
}

const exe = (name, body) => { writeFileSync(join(BIN, name), body); chmodSync(join(BIN, name), 0o755); };
exe('claude', STANDIN);
exe('codex', `#!/bin/sh\nexport FAKE_CODEX_FIXTURES="${FIXTURES}" FAKE_CODEX_LOG="${join(DEMO, 'fake-codex.log')}"\nexec "${process.execPath}" "${join(DEMO, 'fake-codex.mjs')}" "$@"\n`);
exe('agy_acp_server.par', `#!/bin/sh\nexport T3_ACP_ANTIGRAVITY=1 T3_ACP_PROMPT_RESPONSE_TEXT="On it."\nexec "${process.execPath}" --import "${REGISTER}" "${ACP_MOCK}" "$@"\n`);
exe('localharness_external', '#!/bin/sh\nexit 0\n');
exe('dreamcontext', `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"demo placeholder, not a credential"}');
writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n');
writeFileSync(join(HOME, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5-codex', display_name: 'GPT-5-Codex', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] }] }));
{
  // A signed-in Antigravity, as T3 lays it down.
  const key = crypto.createHash('sha256').update('antigravity').digest('hex');
  const tok = join(HOME, '.dreamcontext', 't3', 'state', 'providers', 'antigravity', key, 'antigravity-acp');
  mkdirSync(tok, { recursive: true });
  writeFileSync(join(tok, 'acp_token.json'), '{}');
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_|CODEX_|T3_)/.test(k)));
const PATH = [BIN, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const ENV = { ...cleanEnv(), HOME, PATH, DREAMCONTEXT_CLI: CLI, FAKE_CODEX_FIXTURES: FIXTURES, FAKE_CODEX_LOG: join(DEMO, 'fake-codex.log'), T3_ACP_ANTIGRAVITY: '1' };
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: ENV, encoding: 'utf-8', timeout: 180_000 });

// A clean start: no roster, no super state. Chat view on, Super on (the default since 0.36.1).
rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
rmSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), { force: true });
rmSync(join(PROJ, '_dream_context', 'state', '.super'), { recursive: true, force: true });
writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({ enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false, chatView: true, screenMigrated: true, chatPermissionMode: 'auto', lightMode: 'off', superAgent: true }, null, 2)}\n`);

// The AI Team member's history, written through the app's own library (run with tsx).
const TEAM_SEED = `/** AI Team fixtures for the 0.40.0 announcement: a fictional orbit member with three runs. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '${REPO}/src/lib/agents/store.js';
import { createQuestion } from '${REPO}/src/lib/automations/hitl.js';
import { recordAutomationSession } from '${REPO}/src/lib/automations/session-registry.js';
import { recordRun } from '${REPO}/src/lib/automations/store.js';
import { appendThreadEntry } from '${REPO}/src/lib/automations/threads.js';
import { claudeProjectDirName } from '${REPO}/src/lib/transcript-sessions.js';

const proj = process.argv[2];
const ctx = join(proj, '_dream_context');
const home = homedir();
const SLUG = 'churn-watch';
const ids = { bound: '11111111-1111-4111-8111-111111111111', asked: '33333333-3333-4333-8333-333333333333' };
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const tfile = (id: string): string => { const d = join(home, '.claude', 'projects', claudeProjectDirName(proj)); mkdirSync(d, { recursive: true }); return join(d, id + '.jsonl'); };
const row = (id: string, o: Record<string, unknown>): void => { appendFileSync(tfile(id), JSON.stringify({ ...o, cwd: proj, sessionId: id, uuid: id + '-' + Math.random(), timestamp: new Date().toISOString() }) + '\\n'); };
const said = (id: string, w: string): void => row(id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: w }] } });
const bash = (id: string, n: number, cmd: string, res: string): void => {
  row(id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + n, name: 'Bash', input: { command: cmd } }] } });
  row(id, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + n, content: res }] } });
};
function run(firedAt: string, over: Record<string, unknown>, result: string | null, text = 'Finished in 1m 16s.'): void {
  appendThreadEntry(ctx, SLUG, { runId: firedAt, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
  appendThreadEntry(ctx, SLUG, { runId: firedAt, kind: 'system', event: 'ok', text, via: 'runner', ...(result ? { result } : {}) } as never);
  recordRun(ctx, SLUG, { firedAt, startedAt: firedAt, status: 'ok', durationMs: 76_000, sessionId: null, outputPath: null, error: null, costUsd: 0, numTurns: 1, permissionDenials: 0, ...over } as never);
}
function doc(name: string, body: string): string { const d = join(ctx, 'automations', 'output', SLUG); mkdirSync(d, { recursive: true }); const p = join(d, name); writeFileSync(p, body); return p; }

createAgent(ctx, { slug: SLUG, title: 'Churn Watch', prompt: 'Every night, read the cancellations and say which ones we could have kept.', learning: false } as never, { approve: { now: new Date(), home } } as never);
const light = ago(26 * 60);
run(light, { outputPath: doc('oct-31.md', '# Churn, 31 October\\n\\nTwo cancellations, both on the monthly plan after month three.\\n') }, 'Two cancellations yesterday, both monthly teams past month three.');
const bound = ago(180);
row(ids.bound, { type: 'user', message: { role: 'user', content: 'Nightly churn check for orbit.' } });
said(ids.bound, 'Reading last night\\'s cancellations.');
bash(ids.bound, 1, 'node scripts/cancellations.mjs --since yesterday', '3 cancellations: Northwind (monthly, month 4), Lumen Labs (monthly, month 3), Kite Studio (annual)');
said(ids.bound, 'Two of the three were monthly teams past month three. An annual plan would have kept them.');
run(bound, { sessionId: ids.bound, outputPath: doc('nov-01.md', '# Churn, 1 November\\n\\nThree cancellations. Two were monthly teams past month three.\\n') }, 'Three cancellations last night. Two were monthly teams past month three: the annual plan would have kept them.');
recordAutomationSession(SLUG, ids.bound, home, Date.now(), undefined, bound);
const asked = ago(20);
row(ids.asked, { type: 'user', message: { role: 'user', content: 'Nightly churn check for orbit.' } });
said(ids.asked, 'Kite Studio left on an annual plan. Should I count it?');
appendThreadEntry(ctx, SLUG, { runId: asked, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
recordRun(ctx, SLUG, { firedAt: asked, startedAt: asked, status: 'awaiting-review', durationMs: 1000, sessionId: ids.asked, outputPath: null, error: null, costUsd: 0, numTurns: 1, permissionDenials: 0 } as never);
recordAutomationSession(SLUG, ids.asked, home, Date.now(), undefined, asked);
createQuestion(ctx, { slug: SLUG, runFiredAt: asked, sessionId: ids.asked, kind: 'flow-hitl', channel: 'chat', question: 'Kite Studio cancelled an annual plan at renewal. Count it in this month\\'s churn?', choices: ['Count it', 'Leave it out'] } as never);
process.stdout.write(JSON.stringify({ bound, light, asked }) + '\\n');
`;
writeFileSync(join(DEMO, 'team-seed.ts'), TEAM_SEED);

if (!process.env.SKIP_SEED) {
  // Codex's one approval for this Mac, in the fake HOME.
  const inst = cli('install', '--tool', 'codex', '--global', '--yes');
  if (inst.status !== 0) console.log('  ! install --tool codex:', (inst.stdout + inst.stderr).slice(-300));
  for (const args of [
    ['agents', 'create', 'analyst', '--title', 'Analyst', '--soul-template', 'careful-researcher', '--prompt', 'You answer product questions from orbit\'s own numbers and research.'],
    ['agents', 'create', 'release-scout', '--title', 'Release Scout', '--prompt', 'Before each orbit release, list what changed for customers and what still needs a check.'],
    ['whiteboard', 'create', 'Pricing experiments', '--group', 'Growth'],
    ['whiteboard', 'create', 'Trial funnel', '--group', 'Growth'],
    ['whiteboard', 'create', 'Beta launch plan', '--group', 'Launch'],
    ['whiteboard', 'create', 'Onboarding emails', '--group', 'Launch'],
    ['whiteboard', 'create', 'Weekly metrics', '--group', 'Ops'],
  ]) { const r = cli(...args); if (r.status !== 0) console.log(`  ! ${args.join(' ')}:`, (r.stdout + r.stderr).slice(-300)); }
  // RICE: both objectives and four tasks scored, so the priority view has lanes to fill.
  for (const args of [
    ['roadmap', 'objective', 'edit', 'reach-100-paying', '--reach', '8', '--impact', '5', '--confidence', '75', '--effort', '4', '--owner'],
    ['roadmap', 'objective', 'edit', 'ship-public-beta', '--reach', '6', '--impact', '3', '--confidence', '50', '--effort', '6', '--owner'],
    ['tasks', 'rice', 'investigate-trial-to-paid-drop', '--reach', '9', '--impact', '5', '--confidence', '100', '--effort', '1'],
    ['tasks', 'rice', 'annual-plan-on-pricing-page', '--reach', '7', '--impact', '4', '--confidence', '75', '--effort', '2'],
    ['tasks', 'rice', 'churn-exit-survey', '--reach', '5', '--impact', '3', '--confidence', '75', '--effort', '1'],
    ['tasks', 'rice', 'usage-dashboard', '--reach', '4', '--impact', '2', '--confidence', '50', '--effort', '4'],
  ]) { const r = cli(...args); if (r.status !== 0) console.log(`  ! ${args.join(' ')}:`, (r.stdout + r.stderr).slice(-300)); }
  // The AI Team member with a history: written through the app's own library (team-seed.ts).
  if (!existsSync(join(PROJ, '_dream_context', 'agents', 'churn-watch.md'))) {
    const r = spawnSync('npx', ['--yes', 'tsx', join(DEMO, 'team-seed.ts'), PROJ], { cwd: REPO, encoding: 'utf-8', env: { ...cleanEnv(), HOME, npm_config_cache: join(process.env.HOME, '.npm') } });
    if (r.status !== 0) console.log('  ! team seed:', (r.stdout + r.stderr).slice(-400));
  }
  // An app with its own assistant: a trial board on the left, the assistant's chat on the right.
  const APP = join(`${PROJ}-apps`, 'trial-board');
  if (!existsSync(APP)) cli('apps', 'new', 'trial-board', '--name', 'Trial Board');
  writeFileSync(join(APP, 'ASSISTANT.md'), '# Trial Board\n\nYou are the assistant of Trial Board.\n\nSubject: orbit\'s trials and how they convert.\nReads: the trial list and the Lab insights.\nDoes: answers questions about trials.\nAsks first: anything that writes.\n');
  writeFileSync(join(APP, 'public', 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trial Board</title><link rel="stylesheet" href="/style.css"></head>
<body><main><h1>Trial Board</h1><p class="s">Trials started in the last 14 days</p>
<table><tr><th>Team</th><th>Sources</th><th>Day</th><th>Status</th></tr>
<tr><td>Northwind</td><td>Stripe</td><td>12</td><td><b class="r">At risk</b></td></tr>
<tr><td>Lumen Labs</td><td>Stripe, Segment</td><td>9</td><td><b class="g">Likely to pay</b></td></tr>
<tr><td>Kite Studio</td><td>Stripe</td><td>6</td><td><b class="r">At risk</b></td></tr>
<tr><td>Harbor Analytics</td><td>Stripe, Postgres</td><td>4</td><td><b class="g">Likely to pay</b></td></tr>
<tr><td>Pine &amp; Co</td><td>Segment</td><td>2</td><td><b class="y">Too early</b></td></tr></table></main>
<aside id="host"></aside><script type="module" src="/chat.js"></script></body></html>`);
  writeFileSync(join(APP, 'public', 'style.css'), `body{margin:0;display:grid;grid-template-columns:1fr 560px;height:100vh;background:#111318;color:#e6e6ea;font-family:-apple-system,'Helvetica Neue',sans-serif}
main{padding:40px 44px}h1{margin:0 0 4px;font-size:28px}.s{color:#8b8b98;margin:0 0 28px}table{width:100%;border-collapse:collapse;font-size:16px}
th{text-align:left;color:#8b8b98;font-weight:500;padding:10px 8px;border-bottom:1px solid #2a2c35}td{padding:14px 8px;border-bottom:1px solid #1f2129}
b{font-weight:600;font-size:13px;padding:4px 10px;border-radius:99px}.r{background:#3a1d22;color:#ff8a8a}.g{background:#16301f;color:#7ee2a0}.y{background:#33301a;color:#f0d77a}
#host{border-left:1px solid #2a2c35;height:100vh}`);
  writeFileSync(join(APP, 'public', 'chat.js'), `import { dc } from '/__dc/sdk.js'; dc.mountEmbed(document.getElementById('host'), 'chat');`);
}

// ── Server ──────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
  cwd: PROJ, detached: true,
  env: { ...ENV, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: String(process.pid), DREAMCONTEXT_AUTO_DASHBOARD: '0', DREAMCONTEXT_T3_DEBUG: join(DEMO, 'bridge.log') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', stopServer);
const log = join(DEMO, 'server-0-41.log');
server.stdout.on('data', (d) => appendFileSync(log, d));
server.stderr.on('data', (d) => appendFileSync(log, d));
{
  const end = Date.now() + 40000;
  let up = false;
  while (!up && Date.now() < end) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* not up */ } if (!up) await sleep(300); }
  if (!up) { stopServer(); throw new Error('dashboard server did not come up'); }
}

const { chromium } = await import('@playwright/test');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await setTheme(ctx, 'dark');
await markAnnouncementsSeen(ctx, BASE);
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

const CLEAN = `.ns-setup-wrap{display:none!important}.agent-dock{display:none!important}[class*="sleep-debt"],[class*="debt-badge"]{display:none!important}`;
const captured = [];
const failed = [];
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(200); }
  return false;
};
async function shot(name, clip, p = page) {
  await p.addStyleTag({ content: CLEAN });
  await sleep(500);
  const raw = join(RAW, `${name}-2x.png`);
  await p.screenshot({ path: raw, ...(clip ? { clip } : {}) });
  spawnSync('sips', ['-Z', '1600', raw, '--out', join(OUT, `${name}.png`)]);
  captured.push(name);
  console.log('  ✓', name);
}
async function probe(name) {
  await page.addStyleTag({ content: CLEAN });
  await sleep(400);
  await page.screenshot({ path: join(RAW, `probe-${name}.png`) });
  console.log('  · probe', name);
}
async function scene(name, fn) {
  if (!on(name)) return;
  try { await fn(); } catch (e) { failed.push(name); console.log('  ✗', name, String(e?.stack ?? e).slice(0, 600)); }
}
const vis = (sel) => page.locator(`${sel}:visible`);
const dismiss = async () => {
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await sleep(200); }
  const g = page.getByRole('button', { name: 'Got it' });
  if (await g.isVisible().catch(() => false)) { await g.click(); await sleep(300); }
};
const rail = async (id) => {
  const r = page.getByTestId(`ns-rail-${id}`);
  if (await r.isVisible().catch(() => false)) await r.click();
  else { await page.getByTestId('ns-rail-more').click(); await page.getByTestId(`ns-more-${id}`).click(); }
  await sleep(1500);
};

await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
await until(() => page.locator('[data-testid="ns-rail"]').count(), 30000);
await sleep(2500);
await dismiss();

// ── Probe: the landing page on this build (not shipped) ──────────────────────────────
await scene('probe', async () => {
  await probe('landing');
  await rail('whiteboards').catch(() => {});
  await probe('whiteboards');
});

const drawer = () => page.getByTestId('chat-drawer');
const openDrawer = async () => {
  if (await drawer().isVisible().catch(() => false)) return;
  const t = page.locator('[data-testid="ns-drawer-toggle"], [aria-label*="rawer"], [aria-label*="Projects"]').first();
  await t.click().catch(() => {});
  await drawer().waitFor({ state: 'visible', timeout: 10000 });
};
const box = async (loc, pad = 0, until = null) => {
  const b = await loc.boundingBox();
  const end = until ? await until.boundingBox() : null;
  const h = end ? end.y + end.height - b.y : b.height;
  return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: h + pad * 2 };
};

// ── The drawer: the Team row open under the project, its members one level below ───────
await scene('drawer-team', async () => {
  await rail('chat');
  await openDrawer();
  await sleep(800);
  const row = page.locator(`[data-testid="drawer-team-row"][data-vault="${VAULT}"], [data-drawer-project="${VAULT}"] .ns-team-sec-row`).first();
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  await page.locator('[data-testid="team-list-member"]:visible').first().waitFor({ timeout: 10000 });
  await sleep(800);
  await page.mouse.move(1500, 990);
  { const end = await page.locator('[data-testid="team-manage"]:visible').first().boundingBox();
    await shot('drawer-team', { x: 0, y: 0, width: 1040, height: Math.round(end.y + end.height + 40) }, page); }
});

// ── A member's own stage ─────────────────────────────────────────────────────────────
await scene('member-stage', async () => {
  await openDrawer();
  await page.locator('[data-testid="team-list-member"][data-slug="churn-watch"]:visible').first().click();
  await sleep(3000);
  await dismiss();
  await page.mouse.move(1500, 990);
  await shot('member-stage');
});

// ── Whiteboards: a group's ⋯ menu with Move up / Move down ───────────────────────────
await scene('board-groups', async () => {
  await rail('whiteboards');
  await sleep(1500);
  const more = page.locator('.wbx-row--group .wbx-more[aria-haspopup="menu"]:visible');
  await more.first().waitFor({ timeout: 10000 });
  await more.nth(1).click();
  await sleep(800);
  const exp = page.locator('.wbx, [class*="wbx-explorer"], [class*="board-explorer"]').first();
  await page.mouse.move(1500, 990);
  if (process.env.PROBE) await probe('board-groups');
  { const top = await page.locator('.wbx-row--group:visible').first().boundingBox(); const m = await page.locator('[role="menu"]:visible').last().boundingBox();
    const y = Math.max(0, Math.round(top.y - 120)); await shot('board-groups', { x: 0, y, width: 1040, height: Math.round(m.y + m.height + 40 - y) }, page); }
  await page.keyboard.press('Escape');
});

// ── Verify (not shipped): the 0.41.0 story in the app's own reader ───────────────────
await scene('verify-story', async () => {
  await page.setViewportSize({ width: 1600, height: 3200 });
  await rail('announcements');
  await sleep(1500);
  { const h = page.locator('.ann-version-head').first(); if ((await h.getAttribute('aria-expanded')) !== 'true') await h.click(); await page.locator('.ann-version-panel img').first().waitFor({ timeout: 15000 }); }
  await sleep(2500);
  await page.screenshot({ path: join(RAW, 'verify-story.png'), fullPage: true });
  console.log('  · verify', join(RAW, 'verify-story.png'));
});

await b.close();
stopServer();
console.log(`\ncaptured ${captured.length}: ${captured.join(', ')}`);
if (failed.length) console.log(`FAILED ${failed.length}: ${failed.join(', ')}`);
process.exit(0);
