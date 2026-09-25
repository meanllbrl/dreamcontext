#!/usr/bin/env node
/**
 * The quest-party Chat, end to end in the real app.
 *
 *   npm run build && npm run verify:chat-quest
 *
 * Proves the acceptance criteria of `knowledge/plans/quest-party-chat-ux-plan.md` §5 that only
 * a rendered app can show (3-14): the transcript as a team log, quiet quest-map bookkeeping,
 * party cards, the Plan and Develop quest maps, the goal-skill live file on the Develop chat's
 * rail (map, branch, win beat, receipt), the plain-language rule, contrast, layout and motion.
 *
 * WHAT IT DRIVES: the real dashboard server, the real `/ws/agent-chat` route, the real
 * `GET /api/agent/goal-live` route and the real React surface in Chromium, plus the real
 * `dreamcontext goal-live` CLI for the writer's session rule. Every number is measured off the
 * live DOM (lib/measure.mjs), never computed from the CSS by hand.
 *
 * WHAT IT DOES NOT SPEND: tokens. `claude` is replaced by a scripted stand-in in an isolated
 * fake HOME (see scripts/verify/chat-steer.mjs for why that makes the substitution airtight).
 * It plays one Plan chat and the Develop chat its hand-off opens, and on cue writes the
 * goal-skill live file for its own conversation, stamped with the id the app pinned it to.
 *
 * FIXTURE ORDER: the Plan chat plays PLAN-ANSWER (scout, draft, two review rounds, the task,
 * the hand-off) BEFORE PLAN-GO (the team-log turn). PLAN-GO creates a task, and a created task
 * advances the plan quest to its Task stage, so run first it would make "review is active in
 * round 2" impossible to observe. After the seal the quest is won and PLAN-GO cannot move it.
 *
 * FAILURE POLICY: COLLECT, DON'T FAIL FAST: every check prints ✓/✗ with evidence and the run
 * continues, so one invocation reports everything that is broken. Exit 0 iff all checks pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromeText, contrast, dashLines, distIndex, movingUnder, resolveColor, scratchDir, shotsDir,
} from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = distIndex(REPO);
const SCRATCH = scratchDir('dreamcontext-verify-chat-quest');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const WRITER = join(SCRATCH, 'writer');
const SHOTS = shotsDir(REPO, 'chat-quest');
const SLUG = 'quest-demo';

/** The win beat's hold, read from the component so the check moves with the constant. */
const WIN_HOLD_MS = Number(
  /export const WIN_HOLD_MS = (\d+)/.exec(readFileSync(join(REPO, 'dashboard/src/components/sleepy/quest/QuestMap.tsx'), 'utf-8'))?.[1] ?? NaN,
);

/**
 * A task file with 4 criteria, 2 ticked: the Develop build meter reads "2 of 4". It also has
 * to pass the hand-off's readiness gate (src/lib/handoff-readiness.ts: a checkbox criterion,
 * a "Validation method:" criterion and a technical plan that names a file), or the develop
 * button refuses with an alert and the Plan chat stays where it is.
 */
const TASK_MD = `---
id: task_questdemo
name: Quest demo
status: in_progress
---

## Acceptance Criteria

- [x] the team log reads as sentences
- [x] party cards replace the job monitor
- [ ] the quest map rides the rail
- [ ] Validation method: tests. The receipt says how it was built

## Technical Details

- dashboard/src/components/sleepy/chat/ChatQuestBar.tsx: the quest map on the rail.
`;

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// Written as a real function and serialised into the stand-in, so `node --check` covers it and
// nothing inside it needs template-literal escaping. It is self-contained: CommonJS, no closure.
function standinMain(cfg) {
  const fs = require('fs');
  const path = require('path');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; };
  // The app pins a fresh conversation with `--session-id <uuid>` and a respawn with `--resume`;
  // that id is the pane's `claudeId`, which is what the goal-live route matches the stamp to.
  const SID = flag('--session-id') || flag('--resume') || cfg.fallbackSid;
  const ROOT = cfg.root;
  const inbox = [];
  let busy = false;
  let seq = 0;

  const id = (p) => `toolu_${p}_${++seq}`;
  const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const think = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text, signature: `sig${++seq}` }] } });
  const use = (tid, name, input) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input }] } });
  const result = (tid, text, isError, extra) => out(Object.assign(
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: [{ type: 'text', text }], is_error: !!isError }] } },
    extra || {},
  ));
  async function tool(name, input, res, opts) {
    const o = opts || {};
    const tid = id(name.replace(/[^a-z]/gi, '').slice(0, 8).toLowerCase());
    use(tid, name, input);
    await sleep(o.ms == null ? 250 : o.ms);
    result(tid, res, o.error);
    await sleep(120);
    return tid;
  }

  // A dispatched sub-agent: its Agent call, then the CLI's task_started around it.
  function dispatch(taskId, input) {
    const tid = id('agent');
    use(tid, 'Agent', input);
    out({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: tid, task_type: 'local_agent', subagent_type: input.subagent_type, description: input.description, prompt: input.prompt });
    return tid;
  }
  function land(taskId, tid, summary, report) {
    out({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: tid, status: 'completed', summary, total_tokens: 4200, total_tool_use_count: 5, total_duration_ms: 20000 });
    result(tid, report || summary, false, { tool_use_result: { agentId: taskId, resolvedModel: 'claude-opus-5', totalTokens: 4200, totalToolUseCount: 5, totalDurationMs: 20000 } });
  }
  const lens = (name) => ({ description: `${name} lens`, subagent_type: 'goal-plan-reviewer', prompt: `Review the plan as the ${name} lens.` });

  const fence = (lang, obj) => '\n\n```' + lang + '\n' + JSON.stringify(obj) + '\n```\n';

  // ── the goal-skill live file, the whole state per step, stamped with THIS conversation ──
  const liveFile = () => path.join(process.cwd(), '_dream_context', 'tmp', `.goal-skill-live.${SID}.json`);
  function goalState(step) {
    const t0 = Date.now() - 12 * 60000;
    const at = (min) => new Date(t0 + min * 60000).toISOString();
    const lenses = ['critic', 'pragmatist', 'edge-cases'];
    const lineage = [{ a: 'planner', role: 'planner', k: 'spawn', r: 1, at: at(0) }]
      .concat(lenses.map((a) => ({ a, role: a, k: 'fresh', r: 1, at: at(2) })))
      .concat([{ a: 'planner', role: 'planner', k: 'resume', r: 2, at: at(4) }])
      .concat(lenses.map((a) => ({ a, role: a, k: 'fresh', r: 2, at: at(6) })));
    const history = [{ p: 'plan', at: at(0) }, { p: 'review', at: at(2) }, { p: 'plan', at: at(4) }, { p: 'review', at: at(6) }];
    const s = {
      goal: 'quest-demo', session: SID, started: at(0), updated: new Date().toISOString(),
      phase: 'review', iters: { plan: 2, review: 2 },
      judges: lenses.map((a) => ({ s: 'run', id: a, role: a })), history, lineage,
    };
    if (step === 'live') return s;
    const names = [['T1', 'Role registry'], ['T2', 'Tokens'], ['T3', 'Verify']];
    const withCtx = step !== 'noctx';
    s.phase = 'impl';
    s.iters.impl = 1;
    s.judges = [];
    s.history = history.concat([{ p: 'impl', at: at(8) }]);
    s.impl = { wave: 1, waves: 1, forks: names.map(([fid, name]) => ({ s: 'run', id: fid, name, role: 'implementer' })) };
    s.lineage = lineage.concat(names.map(([fid, name]) => Object.assign(
      { a: fid, role: 'implementer', k: 'fork', from: 'planner', name, at: at(8) },
      withCtx ? { ctx: 182000 } : {},
    )));
    if (step === 'build') return s;
    s.phase = 'done';
    s.iters.codereview = 1;
    s.iters.validate = 1;
    s.impl.forks = s.impl.forks.map((f) => Object.assign({}, f, { s: 'done' }));
    s.judges = [{ s: 'done', id: 'validator', role: 'validator', v: 'PASS' }];
    s.history = s.history.concat([{ p: 'codereview', at: at(10) }, { p: 'validate', at: at(11) }, { p: 'done', at: at(12) }]);
    s.lineage = s.lineage.concat([
      { a: 'reviewer', role: 'reviewer', k: 'fresh', r: 1, at: at(10) },
      { a: 'validator', role: 'validator', k: 'fresh', r: 1, at: at(11) },
    ]);
    return s;
  }
  function writeGoal(step) {
    fs.mkdirSync(path.dirname(liveFile()), { recursive: true });
    fs.writeFileSync(liveFile(), JSON.stringify(goalState(step)));
  }

  // ── PLAN-ANSWER: scout, the draft, two review rounds, the task and the hand-off ──
  async function planAnswer() {
    const scout = dispatch('scout-1', { description: 'Map the chat code', subagent_type: 'Explore', prompt: 'Map the chat components.' });
    await sleep(3000);
    land('scout-1', scout, 'Mapped 12 files in the chat folder');
    await sleep(300);
    say('Here is the draft plan: a quest map on the rail, party cards, and a team log.');
    await sleep(300);

    const round = async (r, holdEdgeMs, verdicts) => {
      await tool('Bash', { command: `dreamcontext goal-live phase review && dreamcontext goal-live actor critic,pragmatist,edge-cases --kind fresh --round ${r}` }, '', { ms: 80 });
      const ids = ['critic', 'pragmatist', 'edge-cases'].map((n) => [n, dispatch(`lens-${n}-r${r}`, lens(n))]);
      await sleep(1200);
      for (const [n, tid] of ids) {
        if (n === 'edge-cases') continue;
        land(`lens-${n}-r${r}`, tid, verdicts[n], `${verdicts[n]}\n\nRead the plan end to end.`);
        await sleep(150);
      }
      await sleep(holdEdgeMs);
      land(`lens-edge-cases-r${r}`, ids[2][1], verdicts['edge-cases'], `${verdicts['edge-cases']}\n\nNo empty-state gaps.`);
      await sleep(300);
    };
    await round(1, 400, { critic: 'NEEDS_WORK: the plan skips the empty state', pragmatist: 'SOLID: scope is right', 'edge-cases': 'SOLID: no gaps found' });
    say('Revising the plan after the critic.');
    await sleep(400);
    await round(2, 6000, { critic: 'SOLID: the empty state is covered', pragmatist: 'SOLID: scope is right', 'edge-cases': 'SOLID: no gaps found' });

    await tool('Bash', { command: 'dreamcontext tasks create "Quest demo" --why "demo"' }, '✓ Task created: quest-demo.md');
    say('The plan is filed as a task.'
      + fence('dream-view', { type: 'progress', task: 'quest-demo' })
      + fence('dream-actions', [{ label: 'Go to development', action: 'develop', id: 'quest-demo' }]));
  }

  // ── PLAN-GO: the team log, one of every kind of step ──
  async function planGo() {
    await tool('Bash', { command: 'cat _dream_context/core/*.md', description: 'Read the full project snapshot' }, 'ok');
    say('Filing the task first.');
    await sleep(200);
    // A dreamcard stretch: the dreamcard leads it, and a long step runs inside it.
    await tool('Bash', { command: 'dreamcontext tasks create "Quest demo" --why "demo"' }, '✓ Task created: quest-demo.md', { ms: 2600 });
    await tool('Bash', { command: 'cat vite.config.ts', description: 'Check the build config' }, 'ok');
    await tool('Bash', { command: 'npm run deploy:preview', description: 'Deploy the preview build' }, 'deployed', { ms: 3200 });
    say('Now the old task.');
    await sleep(200);
    await tool('Bash', { command: 'dreamcontext tasks status nope completed' }, '✗ Task not found: nope');
    await tool('Bash', { command: 'dreamcontext goal-live state critic=SOLID && dreamcontext tasks log quest-demo "wired the rail"' }, '✓ Logged to quest-demo');
    think('Let me weigh the two options for the rail before I look around the chat folder.');
    await sleep(200);
    await tool('Read', { file_path: ROOT + '/chat/ChatPane.tsx' }, 'a\nb\nc', { ms: 500 });
    await tool('Read', { file_path: ROOT + '/chat/ToolCard.tsx' }, 'a\nb', { ms: 500 });
    await tool('Grep', { pattern: 'stepStretches', path: ROOT }, 'hit', { ms: 500 });
    await tool('Bash', { command: 'ls dashboard/src/components/sleepy/chat', description: 'List the chat components' }, 'ChatPane.tsx', { ms: 500 });
    await tool('Bash', { command: 'dreamcontext goal-live phase impl' }, '', { ms: 1500 });
    say('Two questions for you.');
    await sleep(200);
    await tool('AskUserQuestion', { questions: [
      { question: 'Rail or strip?', header: 'Layout', options: [{ label: 'Rail' }, { label: 'Strip' }], multiSelect: false },
      { question: 'Show the receipt?', header: 'Receipt', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
    ] }, 'User answered: Rail, Yes', { ms: 150 });
    say('Checking two tools.');
    await sleep(200);
    await tool('mcp__claude_ai_Claude_Docs__batch', { container: { kind: 'project' } }, 'ok');
    await tool('FrobnicateThing', { level: 3 }, 'ok');
    say('An edit.');
    await sleep(200);
    await tool('Edit', { file_path: ROOT + '/chat/ChatPane.tsx', old_string: 'x', new_string: 'y' }, 'String to replace not found in file.', { error: true });
    say('Sending a scout.');
    await sleep(200);
    // A ghost: an Agent call the CLI never reported a run for (no task_started).
    await tool('Agent', { description: 'Map the chat components', subagent_type: 'Explore', prompt: 'Map it.' }, 'Mapped the chat folder.');
    say('One last look.');
    await sleep(200);
    await tool('Read', { file_path: ROOT + '/quest/QuestMap.tsx' }, 'a');
    await tool('Read', { file_path: ROOT + '/quest/quest.css' }, 'a');
    await tool('Bash', { command: 'dreamcontext goal-live phase review' }, '');
    say('PLAN-GO-DONE');
  }

  // ── Develop kickoff: the build party, the boss gate twice, the final trial, the win ──
  async function developKickoff() {
    say('Tracking the run.' + fence('dream-view', { type: 'progress', task: 'quest-demo' }));
    await sleep(300);
    const i1 = dispatch('impl-1', { description: 'T1 Role registry', subagent_type: 'goal-implementer', prompt: 'Build T1.' });
    const i2 = dispatch('impl-2', { description: 'T2 Tokens', subagent_type: 'goal-implementer', prompt: 'Build T2.' });
    const hcmd = 'dreamcontext goal-live actor "T3=Verify lane" --role implementer --kind fork --from planner && claude -p --resume planner-x --fork-session "T3 verify lane"';
    const hid = id('bash');
    use(hid, 'Bash', { command: hcmd, run_in_background: true });
    await sleep(100);
    result(hid, 'Command running in background with ID: sub-t3');
    out({ type: 'system', subtype: 'task_started', task_id: 'sub-t3', tool_use_id: hid, task_type: 'local_bash', description: 'T3 verify lane' });
    await sleep(2500);
    land('impl-1', i1, 'Built T1: the role registry');
    land('impl-2', i2, 'Built T2: the tokens');
    out({ type: 'system', subtype: 'task_notification', task_id: 'sub-t3', tool_use_id: hid, status: 'completed', summary: 'Built T3' });
    await sleep(300);
    await tool('Edit', { file_path: ROOT + '/chat/ChatPane.tsx', old_string: 'a', new_string: 'b' }, 'ok');
    const r1 = dispatch('rev-1', { description: 'Code review', subagent_type: 'reviewer', prompt: 'Review the diff.' });
    await sleep(800);
    land('rev-1', r1, 'FAIL: two defects in the rail', 'FAIL\n\nTwo defects in the rail.');
    await sleep(200);
    await tool('Edit', { file_path: ROOT + '/chat/ChatQuestBar.tsx', old_string: 'a', new_string: 'b' }, 'ok');
    const r2 = dispatch('rev-2', { description: 'Code review', subagent_type: 'reviewer', prompt: 'Review the diff again.' });
    await sleep(800);
    land('rev-2', r2, 'PASS: both defects fixed', 'PASS\n\nBoth defects fixed.');
    await sleep(200);
    say('Review passed; running the final checks.');
    await sleep(200);
    const v = dispatch('val-1', { description: 'Final checks', subagent_type: 'goal-validator', prompt: 'Validate.' });
    await sleep(4000);
    land('val-1', v, 'PASS: every criterion holds', 'PASS\n\nEvery criterion holds.');
    await sleep(200);
    await tool('Bash', { command: 'dreamcontext tasks status quest-demo completed "all criteria met"' }, '✓ quest-demo → status: completed');
    say('DEVELOP-DONE');
  }

  async function runTurn(prompt) {
    busy = true;
    out({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: ['compact'] });
    await sleep(150);
    const step = /GOAL-(LIVE|BUILD|DONE|NOCTX|CLEAR)/.exec(prompt);
    if (step) {
      if (step[1] === 'CLEAR') { try { fs.unlinkSync(liveFile()); } catch (e) { /* already gone */ } }
      else writeGoal(step[1].toLowerCase());
      say(`GOAL-${step[1]}-WRITTEN`);
    } else if (prompt.includes('PLAN-ANSWER')) await planAnswer();
    else if (prompt.includes('PLAN-GO')) await planGo();
    else if (prompt.includes('quest-demo')) await developKickoff();
    else say('ANSWER ' + prompt);
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: SID });
    busy = false;
    pump();
  }

  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c.toString('utf-8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'control_request') {
        out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
        continue;
      }
      if (o.type !== 'user') continue;
      const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) { inbox.push(text); pump(); }
    }
  });
  let pumping = false;
  async function pump() {
    if (pumping || busy) return;
    const next = inbox.shift();
    if (next === undefined) return;
    pumping = true;
    try { await runTurn(next); } finally { pumping = false; }
  }
  process.stdin.on('end', () => process.exit(0));
}

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\`: see scripts/verify/chat-quest.mjs. */
(${standinMain.toString()})(${JSON.stringify({
    fallbackSid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    root: '/Users/verify/projects/dc/dashboard/src/components/sleepy',
  })});
`;

// ─── setup (mirrors scripts/verify/chat-subagent-report.mjs) ─────────────────────────

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
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'tmp'), { recursive: true });
  mkdirSync(join(WRITER, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  writeFileSync(join(PROJ, '_dream_context', 'state', `${SLUG}.md`), TASK_MD);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [DIST, 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

/** Every live file this run wrote, so a theme never starts on the last theme's goal. */
function clearGoalFiles() {
  const dir = join(PROJ, '_dream_context', 'tmp');
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (f.startsWith('.goal-skill-live')) rmSync(join(dir, f), { force: true });
  }
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST, 'dashboard', '--no-open', '-p', String(port)], {
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

// ─── in-page measurements this suite needs beyond lib/measure.mjs ─────────────────────

/** Where the quest surfaces put copy the plain-language rule governs (§5.11). */
const PLAIN_SELECTORS = [
  '.quest-map', '.quest-victory', '.quest-receipt', '.goal-live-popup',
  '.chat-subagents .chat-m-cardhead', '.chat-subagents-stage', '.chat-subagents-why',
  '.chat-subagents-row-role', '.chat-subagents-row-head', '.chat-subagents-rail',
  '.chat-m-toolhead-action', '.chat-m-thinking-label', '.chat-toolrun > .chat-m-cardhead',
];
const JARGON = /fork|session|resume|--/i;
const EMOJI = /\p{Extended_Pictographic}/u;

/** Visible UI text the contrast rule covers (§5.12), by what it is. */
const TEXT_SELECTORS = {
  'action line': '.chat-m-toolhead-action',
  'thinking label': '.chat-m-thinking-label',
  'card title': '.chat-m-cardhead-title',
  'stage label': '.quest-node-label',
  'round counter': '.quest-node-round',
  'stage meta': '.quest-node-meta',
  beat: '.quest-beat',
  caption: '.quest-branch-caption',
  victory: '.quest-victory-text',
  'victory stats': '.quest-victory-stats',
  badge: '.quest-badge',
  'lineage name': '.quest-lineage-name',
  'lineage note': '.quest-lineage-note',
  kicker: '.chat-subagents-stage',
  role: '.chat-subagents-row-role',
  doing: '.chat-subagents-row-doing',
  why: '.chat-subagents-why',
  verdict: '.chat-a-verdict',
  roster: '.goal-live-member-name',
  tick: '.goal-live-tick-label',
};

/**
 * The transcript's stretches as painted: consecutive `.chat-step` children of the scroller,
 * split at a lead or at anything that is not a step, each with its step count and how many
 * of its avatars are visible. Nothing is wrapped, so this reads the siblings the app renders.
 */
function stretchesInPage() {
  const out = [];
  for (const inner of document.querySelectorAll('.chat-scroll-inner')) {
    if (!inner.getClientRects().length) continue;
    let cur = null;
    for (const el of inner.children) {
      if (!el.getClientRects().length) continue;
      const step = el.classList.contains('chat-step');
      if (!step || el.getAttribute('data-stretch') !== 'follow') {
        cur = step ? { steps: 0, avatars: 0, lead: el.getAttribute('data-tool') || el.className, text: (el.textContent || '').trim().slice(0, 60) } : null;
        if (cur) out.push(cur);
      }
      if (!cur) continue;
      cur.steps += 1;
      // This step's own avatar: a work beat's rows are steps of their own, nested inside it.
      const av = [...el.querySelectorAll('.chat-step-avatar')].find((a) => a.closest('.chat-step') === el);
      if (av && getComputedStyle(av).visibility !== 'hidden' && av.getClientRects().length) cur.avatars += 1;
    }
  }
  return out;
}

/** Does anything under a matching element run a keyframe animation right now? */
async function animatingCount(page, sel) {
  return page.evaluate((s) => {
    const secs = (d) => (d.trim().endsWith('ms') ? parseFloat(d) / 1000 : parseFloat(d));
    let n = 0;
    for (const root of document.querySelectorAll(s)) {
      if (!root.getClientRects().length) continue;
      const moving = [root, ...root.querySelectorAll('*')].some((el) => {
        const cs = getComputedStyle(el);
        return cs.animationName !== 'none' && cs.animationDuration.split(',').some((d) => secs(d) > 0.00001);
      });
      if (moving) n += 1;
    }
    return n;
  }, sel);
}

/** Horizontal overflow of every visible match: scrollWidth past clientWidth, in px. */
async function overflowOf(page, sel) {
  return page.evaluate((s) => [...document.querySelectorAll(s)]
    .filter((el) => el.getClientRects().length)
    .map((el) => el.scrollWidth - el.clientWidth), sel);
}

/** Rendered widths of the outer avatars under `sel` (the emblem badge's own glyph excluded). */
async function avatarWidths(page, sel) {
  return page.evaluate((s) => [...new Set([...document.querySelectorAll(s)]
    .filter((el) => el.getClientRects().length && !el.parentElement.closest('.chat-a-avatar'))
    .map((el) => Math.round(el.getBoundingClientRect().width)))], sel);
}

// ─── the run ──────────────────────────────────────────────────────────────────────────

async function runTheme(chromium, base, theme, report) {
  const browser = await chromium.launch();
  try {
    await runThemeIn(browser, base, theme, report);
  } finally {
    await browser.close();
  }
}

async function runThemeIn(browser, base, theme, report) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  // A render crash lands in the app's error boundary, which swallows the exception (no
  // pageerror). React still logs which component threw; keep that line as evidence.
  const crashes = [];
  page.on('console', (m) => {
    const line = m.type() === 'error' && m.text().split('\n').find((l) => /The above error occurred in the/.test(l));
    if (line) crashes.push(line.trim().slice(0, 200));
  });
  // Playwright dismisses a dialog silently, so an alert (the hand-off's readiness refusal is
  // one) would otherwise leave no trace but a check that times out later.
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    report.note(`[dialog] ${d.message().replace(/\s+/g, ' ').slice(0, 200)}`);
    d.dismiss().catch(() => {});
  });
  mkdirSync(SHOTS, { recursive: true });

  const vis = (sel) => page.locator(`${sel}:visible`);
  const pane = () => vis('.chat-pane').first();
  const paneText = async () => (await pane().innerText()).replace(/\s+/g, ' ');
  const rail = () => vis('.chat-live-rail').first();
  const railText = async () => ((await rail().count()) ? (await rail().innerText()).replace(/\s+/g, ' ') : '');
  // The composer's send button turns into Stop while a turn runs (Composer.tsx, `is-stop`).
  const busy = async () => (await vis('.chat-cmp-send.is-stop').count()) > 0;
  const until = async (fn, ms = 20000, step = 120) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(step); }
    return false;
  };
  const waitText = (s, ms = 60000) => until(async () => (await paneText()).includes(s), ms);
  const waitIdle = () => until(async () => !(await busy()), 60000);
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const shot = async (loc, name) => { try { if (await loc.count()) await loc.first().screenshot({ path: join(SHOTS, `${name}-${theme}.png`) }); } catch { /* a moving target */ } };
  const say = async (text) => {
    if (!(await until(async () => (await vis('.chat-cmp-input').count()) > 0, 30000))) {
      await page.screenshot({ path: join(SHOTS, `no-composer-${text}-${theme}.png`) });
    }
    await vis('.chat-cmp-input').first().click();
    await vis('.chat-cmp-input').first().fill(text);
    await page.keyboard.press('Enter');
  };
  // Resolved after navigation (below): on about:blank the tokens are undefined and read as black.
  const inks = {};
  const colorOf = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
  /**
   * A row's line as painted: verb, subject chip, tail and the running "…" (molecules.tsx
   * ActionHead glues the "…" to whichever piece is last, so with a chip it sits OUTSIDE the
   * verb span). The avatar, the muted subtitle and the meta are not part of the line.
   */
  const lineOf = (row) => row.locator('.chat-m-toolhead').first().evaluate((head) => [...head.children]
    .filter((c) => !c.matches('.chat-m-toolhead-hit, .chat-step-avatar, .chat-m-toolhead-sub, .chat-m-toolhead-meta'))
    .map((c) => (c.textContent || '').trim()).filter(Boolean).join(' ').replace(/\s+…$/, '…'));
  const minContrast = {};
  /** Record the worst contrast of every visible match, keyed by what it is. */
  const sampleContrast = async () => {
    // Contrast is a property of the settled paint: a surface still fading in (the receipt's
    // rise-in runs opacity 0 → 1) reads low for reasons no user sees. Finite animations only;
    // a spinner never finishes. Capped so a stuck animation cannot hang the run.
    await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
        .map((a) => a.finished.catch(() => {}))),
      new Promise((r) => { setTimeout(r, 2000); }),
    ]));
    for (const [what, sel] of Object.entries(TEXT_SELECTORS)) {
      const loc = vis(sel);
      const n = Math.min(await loc.count(), 12);
      for (let i = 0; i < n; i++) {
        const r = await contrast(loc.nth(i)).catch(() => null);
        if (r != null && (minContrast[what] == null || r < minContrast[what].ratio)) {
          minContrast[what] = { ratio: r, text: ((await loc.nth(i).innerText().catch(() => '')) || '').trim().slice(0, 40) };
        }
      }
    }
  };
  const plainLeaks = [];
  /** The plain-language rule over every quest surface on screen now. */
  const samplePlain = async (moment) => {
    for (const sel of PLAIN_SELECTORS) {
      const text = await chromeText(page, sel);
      for (const line of text.split('\n')) {
        if (JARGON.test(line) || /Sleepy/.test(line) || line.includes('—') || EMOJI.test(line)) plainLeaks.push(`${moment} ${sel}: ${line.trim().slice(0, 80)}`);
      }
    }
  };
  /** A motion moment: it moves with no preference, and it is still under reduced motion. */
  const motion = async (label, sel) => {
    const moving = await animatingCount(page, sel);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(150);
    const still = await movingUnder(page, sel);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    ok(`motion: ${label} animates`, moving > 0, `${sel}: ${moving} animating`);
    ok(`motion: …and is still under reduced motion`, still.length === 0, still.join(' | '));
  };
  /** Bring the agent surface back up, the way the run opened it. */
  const expandSurface = async () => {
    if (await page.locator('.agent-surface.expanded').count()) return;
    // With no session, the FAB; with one, its chip in the bottom-right dock (AgentDock.tsx).
    for (const sel of ['.agent-dock-chip', '.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  };
  /**
   * Esc on an overlay closes that overlay and nothing else: the chat under it stays open. If
   * the surface collapsed, that is recorded and the surface is reopened so the rest still runs.
   */
  const escClose = async (overlaySel, label) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const closed = (await vis(overlaySel).count()) === 0;
    const surfaceOpen = (await page.locator('.agent-surface.expanded').count()) > 0;
    ok(`Esc closes ${label} and the chat stays open`, closed && surfaceOpen, `closed=${closed} surfaceOpen=${surfaceOpen}`);
    if (!surfaceOpen) await expandSurface();
  };

  console.log(`\n═══ ${theme} ═══`);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  inks.success = await resolveColor(page, 'var(--color-success-ink)');
  inks.error = await resolveColor(page, 'var(--color-error-ink)');
  ok('instrument check: the two inks resolve to real, different colours after navigation',
    inks.success !== inks.error && ![inks.success, inks.error].includes('rgb(0, 0, 0)'), JSON.stringify(inks));
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  await expandSurface();
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  ok('a chat session opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  await page.waitForTimeout(800);

  // ── Plan mode, picked the way a person picks it ─────────────────────────────────────
  const modeWord = async () => (await vis('.chat-cmp-modeltrigger').first().locator('.chat-cmp-modeltrigger-model').innerText()).trim();
  // Open the menu and wait for it (a click before it mounts picks nothing), then pick the row
  // by its name, not its position. A mode change restarts the process, so the composer is
  // gone for a moment: wait for it to come back before the first message.
  await vis('.chat-cmp-modeltrigger').first().click();
  const planRow = vis('.chat-cmp-modemenu .chat-cmp-modelrow').filter({ has: page.locator('.chat-cmp-modelrow-name', { hasText: /^Plan$/ }) });
  await planRow.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await planRow.first().click({ timeout: 10000 }).catch((e) => report.note(`[mode] ${String(e).split('\n')[0]}`));
  // PRE-EXISTING SERVER RACE, not this suite's subject: a mode switch disposes the chat and
  // respawns it with `resume=<id>` on the same tick. On a chat with no transcript yet,
  // agent-chat.ts's awaitResumeHandoff skips its wait ("an id with no transcript never costs a
  // wait") while the refusal guard below it still refuses a conversation the old socket holds,
  // so whenever the new upgrade beats the old close the pane lands on "Session ended". The
  // refusal names its own recovery ("press Resume in a moment"), which is what a person does.
  const resumeBtn = vis('button').filter({ hasText: /^Resume session$/ });
  await until(async () => (await modeWord()) === 'Plan' || (await resumeBtn.count()) > 0, 10000);
  if (await resumeBtn.count()) {
    report.note('[pre-existing] the mode switch was refused by the server hand-off race (agent-chat.ts awaitResumeHandoff vs its refusal guard); pressing Resume, as the refusal says');
    await resumeBtn.first().click();
  }
  ok('the chat is in Plan mode', await until(async () => (await modeWord()) === 'Plan', 25000), await modeWord().catch(() => '?'));
  ok('the composer is back after the mode restart', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 30000));
  if (!(await vis('.chat-cmp-input').count())) await page.screenshot({ path: join(SHOTS, `mode-restart-${theme}.png`) });
  await page.waitForTimeout(800);

  // ════ PLAN-ANSWER ═══════════════════════════════════════════════════════════════════
  console.log('── party cards: the scout, two review rounds');
  await say('PLAN-ANSWER');
  const planMap = () => vis('.chat-live-rail .quest-map[data-kind="plan"]');
  ok('a Plan chat draws its quest map on the rail', await until(async () => (await planMap().count()) === 1, 15000));
  const scoutCard = () => vis('.chat-subagents[data-party-stage="scout"]');
  ok('"Scout is mapping the code" while the scout works',
    await until(async () => (await scoutCard().innerText()).includes('Scout is mapping the code'), 6000),
    await scoutCard().innerText().catch(() => '<no card>'));
  ok('…then "Scout mapped the code" once it lands',
    await until(async () => (await scoutCard().innerText()).includes('Scout mapped the code'), 10000),
    await scoutCard().innerText().catch(() => '<no card>'));

  const reviewCards = () => vis('.chat-subagents[data-party-stage="review"]');
  ok('"3 reviewers are reading the plan" while a round runs',
    await until(async () => (await reviewCards().last().locator('.chat-m-cardhead-title').innerText()).includes('3 reviewers are reading the plan'), 15000),
    await reviewCards().last().innerText().catch(() => '<no card>'));

  // Round 2: the edge hunter is held ~6s. Everything "live" is measured inside that window.
  ok('round 2 is under way (a second review card, still running)',
    await until(async () => (await reviewCards().count()) === 2 && (await vis('.chat-subagents[data-party-stage="review"][data-outcome="running"]').count()) === 1, 30000),
    `cards=${await reviewCards().count()}`);
  const reviewNode = vis('.chat-live-rail .quest-node[data-stage="review"]');
  ok('plan quest stages are ask, draft, review, task',
    JSON.stringify(await planMap().locator('.quest-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-stage')))) === '["ask","draft","review","task"]');
  ok('in round 2, review is the active stage with rounds = 2',
    (await reviewNode.getAttribute('data-state')) === 'active' && (await reviewNode.getAttribute('data-rounds')) === '2',
    `${await reviewNode.getAttribute('data-state')} / ${await reviewNode.getAttribute('data-rounds')}`);
  ok('…with the 3 reviewers standing on it',
    (await reviewNode.locator('.quest-node-cast .chat-a-avatar').count()) === 3,
    `${await reviewNode.locator('.quest-node-cast .chat-a-avatar').count()} avatars`);
  ok('…and the beat reads "Claude called 3 reviewers with fresh eyes"',
    ((await vis('.chat-live-rail .quest-beat').innerText().catch(() => '')) || '').includes('Claude called 3 reviewers with fresh eyes'),
    await vis('.chat-live-rail .quest-beat').innerText().catch(() => '<no beat>'));
  ok('the cast never animates', (await animatingCount(page, '.quest-node-cast .chat-a-avatar')) === 0);
  if (await vis('.chat-subagents-rail').count()) {
    ok('the rail chips never animate', (await animatingCount(page, '.chat-subagents-rail-chip .chat-a-avatar')) === 0);
  }
  const railH = await vis('.chat-live-rail .quest-map[data-variant="rail"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  ok('the chat quest map on the rail is ≤ 64px tall', railH.length > 0 && railH.every((h) => h <= 64), JSON.stringify(railH));
  await motion('a running party-row avatar', '.chat-subagents-row[data-status="running"] > .chat-a-avatar');
  await samplePlain('round 2 live');
  await sampleContrast();
  await shot(vis('.chat-live-rail'), 'plan-rail-round2');
  await shot(reviewCards().last(), 'party-round2-live');

  // ── the win: "Plan sealed", and its one-shot moment ─────────────────────────────────
  // The win swaps the map for its victory (ChatQuestBar), which carries the one-shot moment.
  ok('the plan seals: "Plan sealed" on the rail',
    await until(async () => (await railText()).includes('Plan sealed'), 30000, 60), await railText());
  ok('[data-just-won] is present right after the win',
    (await page.locator('.chat-live-rail [data-just-won]').count()) > 0);
  if ((await page.locator('.chat-live-rail .quest-victory[data-just-won] .quest-seal').count()) > 0) {
    await motion('the [data-just-won] seal', '.chat-live-rail .quest-victory[data-just-won]');
  } else {
    await motion('the [data-just-won] map', '.chat-live-rail [data-just-won]');
  }
  await page.waitForTimeout(WIN_HOLD_MS + 1000);
  ok(`…and gone ${WIN_HOLD_MS}+1000ms later (WIN_HOLD_MS parsed from QuestMap.tsx)`,
    Number.isFinite(WIN_HOLD_MS) && (await page.locator('.chat-live-rail [data-just-won]').count()) === 0, `WIN_HOLD_MS=${WIN_HOLD_MS}`);
  await waitIdle();
  await shot(vis('.chat-live-rail'), 'plan-sealed');
  // §5: the seal stamps once. PLAN-ANSWER sent 7 agents (a scout, then 3 lenses twice).
  const sealStats = async () => ((await vis('.chat-live-rail .quest-victory-stats').first().innerText().catch(() => '')) || '').trim();
  const sealAtWin = await sealStats();
  ok('the seal counts the plan\'s own party: "2 review rounds" and "7 agents"',
    sealAtWin.includes('2 review rounds') && sealAtWin.includes('7 agents'), sealAtWin);

  // ── the party cards, landed ─────────────────────────────────────────────────────────
  ok('exactly 2 review cards', (await reviewCards().count()) === 2, `saw ${await reviewCards().count()}`);
  for (let i = 0; i < 2; i++) {
    const card = reviewCards().nth(i);
    if ((await card.getAttribute('data-open')) == null) await card.locator('.chat-m-cardhead-hit').first().click();
    await page.waitForTimeout(250);
  }
  const rowCounts = [await reviewCards().nth(0).locator('.chat-subagents-row').count(), await reviewCards().nth(1).locator('.chat-subagents-row').count()];
  ok('…of 3 rows each', rowCounts[0] === 3 && rowCounts[1] === 3, JSON.stringify(rowCounts));
  const tops = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.chat-subagents[data-party-stage="review"]')].filter((e) => e.getClientRects().length);
    const revising = [...document.querySelectorAll('.chat-scroll-inner *')].find((e) => e.children.length === 0 && (e.textContent || '').includes('Revising the plan'));
    return { r1: cards[0]?.getBoundingClientRect().top, rev: revising?.getBoundingClientRect().top, r2: cards[1]?.getBoundingClientRect().top };
  });
  ok('their tops run round 1 < "Revising" < round 2', tops.r1 < tops.rev && tops.rev < tops.r2, JSON.stringify(tops));
  const r1 = vis('.chat-subagents[data-party-stage="review"][data-superseded="true"]');
  const r2 = vis('.chat-subagents[data-party-stage="review"][data-superseded="false"]');
  ok('round 1: the critic says Needs work, and the card was sent back',
    (await r1.locator('.chat-subagents-row[data-role="critic"] .chat-a-verdict[data-verdict="needs-work"]').count()) === 1
    && (await r1.getAttribute('data-outcome')) === 'sent-back',
    `outcome=${await r1.getAttribute('data-outcome')}`);
  ok('round 2: cleared, with a seal',
    (await r2.getAttribute('data-outcome')) === 'cleared' && (await r2.locator('.chat-subagents-seal').count()) === 1,
    `outcome=${await r2.getAttribute('data-outcome')}`);
  ok('judges carry "fresh eyes"',
    (await vis('.chat-subagents[data-party-stage="review"] .chat-subagents-row .quest-badge[data-badge="fresh"]').count()) === 6);
  ok('round 1 shows no reports until asked', (await r1.locator('.chat-subreport').count()) === 0);
  await r1.locator('.chat-subagents-reports-toggle').click().catch(() => {});
  ok('…and all 3 after the toggle', await until(async () => (await r1.locator('.chat-subreport').count()) === 3, 5000),
    `${await r1.locator('.chat-subreport').count()} reports`);
  // A hovered row names its drill-in ("open →") in the status mark's place, never on the meta.
  const lastRow = r1.locator('.chat-subagents-row').last();
  await lastRow.hover();
  await page.waitForTimeout(400);
  const hoverBoxes = await lastRow.evaluate((row) => {
    const box = (sel) => { const r = row.querySelector(sel)?.getBoundingClientRect(); return r ? { l: r.left, r: r.right, t: r.top, b: r.bottom } : null; };
    return { open: box('.chat-subagents-row-open'), meta: box('.chat-subagents-row-meta'),
      openOpacity: getComputedStyle(row.querySelector('.chat-subagents-row-open')).opacity };
  });
  const overlapX = hoverBoxes.open && hoverBoxes.meta ? Math.max(0, Math.min(hoverBoxes.open.r, hoverBoxes.meta.r) - Math.max(hoverBoxes.open.l, hoverBoxes.meta.l)) : -1;
  const overlapY = hoverBoxes.open && hoverBoxes.meta ? Math.max(0, Math.min(hoverBoxes.open.b, hoverBoxes.meta.b) - Math.max(hoverBoxes.open.t, hoverBoxes.meta.t)) : -1;
  ok('a hovered row shows "open →" clear of its meta (no overlap)',
    hoverBoxes.openOpacity === '1' && overlapX * overlapY === 0 && overlapX >= 0, JSON.stringify({ ...hoverBoxes, overlapX, overlapY }));
  await shot(lastRow, 'party-row-hover');
  await page.mouse.move(0, 0);
  const rowInfo = await vis('.chat-subagents-row').evaluateAll((els) => els.map((e) => ({ title: e.getAttribute('title') || '', text: e.innerText })));
  ok('no raw agent type in a row\'s text; it lives in the row\'s title',
    rowInfo.every((r) => !/goal-plan-reviewer|Explore/.test(r.text)) && rowInfo.some((r) => r.title.includes('goal-plan-reviewer')),
    JSON.stringify(rowInfo.slice(0, 2)));
  ok('no type badge in the rows', (await page.locator('.chat-subagents-row .chat-a-typebadge').count()) === 0);
  const text1 = await paneText();
  ok('no "agents running" text and no ⚡', !/agents running/i.test(text1) && !text1.includes('⚡'));
  ok('the fresh-eyes explainer appears exactly once', (await vis('.chat-subagents-why').count()) === 1,
    `${await vis('.chat-subagents-why').count()}`);
  ok('each dispatch round is one card and no quest row shows',
    (await vis('.chat-subagents').count()) === 3 && !(await paneText()).includes('Updated the quest map'),
    `${await vis('.chat-subagents').count()} cards`);
  await sampleContrast();
  await samplePlain('plan landed');
  await shot(r1, 'party-round1');

  // ════ PLAN-GO: the team log ═════════════════════════════════════════════════════════
  console.log('── the team log');
  await say('PLAN-GO');
  ok('"Read the full project snapshot" reads as its own sentence',
    await until(async () => (await vis('.chat-m-toolhead-action').allInnerTexts()).some((t) => t.trim() === 'Read the full project snapshot'), 15000));
  // §5.3: "A running dreamcard row reads in the present tense and ends in '…'". The line is the
  // whole row (verb + chip + "…"), since the chip, not the verb, is last on a row that has one.
  // The two running rows are live on the fixture's clock ("Creating task" ~0.7-3.3s, "Deploy"
  // ~3.8-7s after PLAN-GO), so they are watched CONCURRENTLY: a failing first check must not
  // spend the second one's window and report a working product as broken.
  const creating = vis('.chat-dreamcard[data-status="running"]').filter({ hasText: 'Creating task' });
  const deploy = vis('.chat-toolcard').filter({ hasText: 'Deploy the preview build' });
  const deployAction = deploy.last().locator('.chat-m-toolhead-action');
  let creatingLine = '<never running>';
  const [creatingOk, live] = await Promise.all([
    until(async () => {
      if (!(await creating.count())) return false;
      creatingLine = await lineOf(creating.last());
      return /^Creating task\b.*…$/.test(creatingLine);
    }, 8000, 80),
    (async () => {
      const running = await until(async () => (await deploy.last().getAttribute('data-status', { timeout: 500 })) === 'running', 12000, 80);
      if (!running) return { running };
      const line = await lineOf(deploy.last()).catch(() => '');
      const color = await colorOf(deployAction).catch(() => '');
      // PLAN-ANSWER filed the task too; the stretch under test is PLAN-GO's, the last one.
      const stretch = (await page.evaluate(stretchesInPage)).filter((x) => /Task created|Creating task/.test(x.text)).at(-1);
      const sel = '.chat-scroll-inner > .chat-dreamcard[data-stretch="lead"] .chat-step-avatar .chat-a-avatar[data-running]';
      const moving = await animatingCount(page, sel);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(150);
      const still = await movingUnder(page, sel);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await shot(vis('.chat-scroll'), 'team-log-live');
      return { running, line, color, stretch, moving, sel, still };
    })(),
  ]);
  // §5.3: "A running dreamcard row reads in the present tense and ends in '…'". The line is the
  // whole row (verb + chip + "…"), since the chip, not the verb, is last on a row that has one.
  ok('a running dreamcard reads in the present tense: "Creating task…"', creatingOk, creatingLine);
  ok('"Deploy the preview build" is running', live.running);
  ok('the running row ends in "…" in success ink',
    live.line === 'Deploy the preview build…' && live.color === inks.success, `${live.line} ${live.color} vs ${inks.success}`);
  ok('the stretch led by `tasks create` shows exactly one avatar',
    !!live.stretch && live.stretch.steps >= 2 && live.stretch.avatars === 1, JSON.stringify(live.stretch));
  ok('motion: the dreamcard-led stretch lead while "Deploy the preview build" runs animates', live.moving > 0, `${live.sel}: ${live.moving} animating`);
  ok('motion: …and is still under reduced motion', !!live.still && live.still.length === 0, (live.still || ['<not measured>']).join(' | '));

  ok('the team-log turn finishes', await waitText('PLAN-GO-DONE'));
  await waitIdle();
  await page.waitForTimeout(600);

  const actions = (await vis('.chat-m-toolhead-action').allInnerTexts()).map((t) => t.trim());
  const has = (re) => actions.some((t) => re.test(t));
  ok('"Task created" with its brand mark and no dot',
    await vis('.chat-dreamcard').filter({ hasText: 'Task created' }).first().evaluate((e) => !!e.querySelector('.chat-a-glyph-brand') && !e.querySelector('.chat-a-dot') && !e.querySelector('.chat-a-toolname')).catch(() => false));
  ok('"Asked you 2 questions"', has(/^Asked you 2 questions$/), JSON.stringify(actions));
  ok('"Used Claude Docs: batch"', has(/^Used Claude Docs: batch$/));
  ok('"Used FrobnicateThing"', has(/^Used FrobnicateThing$/));
  ok('"Sent the scout: …"', has(/^Sent the scout:/));
  const editFail = vis('.chat-toolcard[data-tool="Edit"][data-status="error"]').last();
  ok('"Couldn\'t edit …" in error ink',
    /^Couldn't edit/.test((await editFail.locator('.chat-m-toolhead-action').innerText()).trim())
    && (await colorOf(editFail.locator('.chat-m-toolhead-action'))) === inks.error,
    `${await editFail.locator('.chat-m-toolhead-action').innerText().catch(() => '')} ${await colorOf(editFail.locator('.chat-m-toolhead-action')).catch(() => '')}`);
  const thinking = vis('.chat-m-thinking').last();
  ok('"Thought it through" with its token count',
    (await thinking.locator('.chat-m-thinking-label').innerText()).trim() === 'Thought it through'
    && /\d/.test(await thinking.locator('.chat-m-thinking-meta').innerText()),
    await thinking.innerText().catch(() => '<none>'));
  const failCard = vis('.chat-dreamcard[data-status="error"]').first();
  const failText = (await failCard.locator('.chat-m-toolhead').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const failAria = (await failCard.locator('.chat-m-toolhead-hit').getAttribute('aria-label').catch(() => '')) || '';
  ok('a failed dreamcard says so in words, in error ink, and its aria-label says the same',
    /Couldn't|failed/.test(failText) && /Couldn't|failed/.test(failAria)
    && (await colorOf(failCard.locator('.chat-m-toolhead-action'))) === inks.error,
    `${failText} :: ${failAria}`);
  ok('a chained `goal-live && tasks log` keeps its own dreamcard row',
    (await vis('.chat-scroll-inner > .chat-dreamcard').filter({ hasText: /Log/i }).count()) >= 1);
  const RAW = /^(Bash|Read|Edit|Write|Grep|Glob|LS|Agent|Task|AskUserQuestion|WebFetch|WebSearch|Skill|TodoWrite|mcp__\S+|FrobnicateThing)$/;
  // §5.3 lists '"Read" plus a file chip' as a line that must render: the chip is the step's
  // subject, so a header is bare only when its WHOLE line (verb + chip + tail) is a tool name.
  const lines = [];
  const headRows = vis('.chat-toolcard, .chat-dreamcard');
  for (let i = 0, n = await headRows.count(); i < n; i++) lines.push(await lineOf(headRows.nth(i)).catch(() => ''));
  ok('no visible header shows a bare tool name',
    lines.length > 0 && lines.every((t) => !RAW.test(t)), JSON.stringify(lines.filter((t) => RAW.test(t))));

  // The work beat, collapsed, then opened.
  const beat = vis('.chat-toolrun').filter({ hasText: 'Looked around' }).first();
  ok('"Looked around: 4 steps · 2 files read · 1 command"',
    ((await beat.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').includes('Looked around: 4 steps · 2 files read · 1 command'),
    await vis('.chat-toolrun').allInnerTexts().then((a) => a.join(' | ')).catch(() => ''));
  await beat.locator('.chat-m-cardhead-hit').first().click().catch(() => {});
  await page.waitForTimeout(400);
  ok('inside it, "Searched for" and "Read" with a file chip',
    (await beat.locator('.chat-m-toolhead-action').allInnerTexts()).some((t) => t.startsWith('Searched for'))
    && (await beat.locator('.chat-toolcard[data-tool="Read"] .chat-a-pathchip').count()) >= 1);
  const quietRow = beat.locator('.chat-toolcard[data-quiet]').filter({ hasText: 'Updated the quest map' });
  ok('…and one quiet "Updated the quest map" line that is not counted',
    (await quietRow.count()) === 1 && (await beat.locator('.chat-toolcard').count()) === 5,
    `quiet=${await quietRow.count()} rows=${await beat.locator('.chat-toolcard').count()}`);

  // The lone [Read, Read, goal-live]: two rows, no beat, no quest row.
  const tail = await page.evaluate(() => {
    const inner = [...document.querySelectorAll('.chat-scroll-inner')].find((e) => e.getClientRects().length);
    const kids = [...(inner?.children ?? [])].filter((e) => e.getClientRects().length);
    const at = kids.findIndex((e) => (e.textContent || '').includes('One last look'));
    return kids.slice(at + 1).map((e) => ({ cls: e.className, tool: e.getAttribute('data-tool'), text: (e.textContent || '').trim().slice(0, 40) }));
  });
  const tailRows = tail.filter((e) => /chat-toolcard|chat-toolrun/.test(e.cls));
  ok('the lone [Read, Read, goal-live] shows 2 rows, no work beat and no quest row',
    tailRows.length === 2 && tailRows.every((e) => e.tool === 'Read') && !tail.some((e) => /chat-toolrun/.test(e.cls)),
    JSON.stringify(tail));
  ok('no quest row outside a work beat',
    (await page.locator('.chat-scroll-inner > .chat-toolcard[data-quiet]:visible').count()) === 0);

  // Every stretch of 3 or more steps shows exactly one avatar.
  const all = await page.evaluate(stretchesInPage);
  const bad = all.filter((s) => s.steps >= 3 && s.avatars !== 1);
  ok('in every stretch of 3+ steps exactly one avatar is visible', all.some((s) => s.steps >= 3) && bad.length === 0, JSON.stringify(bad));

  // Raw details stay one click away.
  const snap = vis('.chat-toolcard').filter({ hasText: 'Read the full project snapshot' }).first();
  await snap.locator('.chat-m-toolhead-hit').click().catch(() => {});
  await page.waitForTimeout(400);
  ok('an opened row shows the raw tool name and the full command',
    (await snap.locator('.chat-toolcard-raw').count()) === 1
    && ((await snap.locator('.chat-m-terminal').innerText().catch(() => '')) || '').includes('cat _dream_context/core'),
    await snap.innerText().catch(() => ''));

  await sampleContrast();
  await samplePlain('team log');
  await shot(vis('.chat-scroll'), 'team-log');
  const sealAfter = await sealStats();
  ok('the seal does not move when the same chat keeps working after the win', sealAfter === sealAtWin,
    `at win: ${sealAtWin} :: after PLAN-GO: ${sealAfter}`);

  // Layout, plan chat.
  for (const width of [1500, 720]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(500);
    for (const sel of ['.quest-map', '.chat-subagents', '.chat-toolrun']) {
      const over = await overflowOf(page, sel);
      ok(`layout @${width}px: no horizontal overflow on ${sel}`, over.every((d) => d <= 1), JSON.stringify(over));
    }
  }
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.waitForTimeout(400);
  ok('the app is still up after the 720px round trip (no error boundary)',
    (await page.getByText('Something went wrong').count()) === 0, crashes.join(' | ') || 'no component named');
  const heads = await vis('.chat-m-toolhead').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  ok('tool and dreamcard rows are still 32px', heads.length > 0 && heads.every((h) => Math.abs(h - 32) <= 1), JSON.stringify([...new Set(heads)]));
  const sizes = {
    step: await avatarWidths(page, '.chat-step-avatar .chat-a-avatar'),
    party: await avatarWidths(page, '.chat-subagents-row .chat-a-avatar'),
    cast: await avatarWidths(page, '.quest-node-cast .chat-a-avatar'),
    report: await avatarWidths(page, '.chat-subreport .chat-a-avatar'),
  };
  ok('avatar sizes: step 16, party row 32, report 28 (cast 20 when seated)',
    sizes.step.every((w) => w === 16) && sizes.party.every((w) => w === 32) && sizes.report.every((w) => w === 28)
    && sizes.cast.every((w) => w === 20) && sizes.step.length > 0 && sizes.party.length > 0,
    JSON.stringify(sizes));
  const badges = await page.evaluate(() => [...document.querySelectorAll('.chat-a-avatar-badge')]
    .filter((b) => b.getClientRects().length)
    .map((b) => Math.round(b.closest('.chat-a-avatar').getBoundingClientRect().width)));
  ok('the emblem badge appears only at ≥ 30px', badges.every((w) => w >= 30), JSON.stringify([...new Set(badges)]));
  const discs = vis('.chat-a-avatar[data-role] > svg');
  const discN = Math.min(await discs.count(), 16);
  let worstDisc = Infinity;
  for (let i = 0; i < discN; i++) worstDisc = Math.min(worstDisc, await contrast(discs.nth(i)).catch(() => Infinity));
  ok('faces and emblems reach 3:1 against their disc', discN > 0 && worstDisc >= 3, `worst ${worstDisc} over ${discN}`);

  // ════ Develop: the hand-off opens it ════════════════════════════════════════════════
  console.log('── the Develop quest');
  const ready = await fetch(`${base}/api/tasks/${SLUG}/readiness`, { headers: { 'X-Dreamcontext-Vault': 'proj' } })
    .then((r) => r.json()).catch((e) => ({ error: String(e) }));
  ok('the fixture task passes the hand-off readiness gate (GET /api/tasks/:slug/readiness)', ready.ready === true, JSON.stringify(ready));
  const dialogsBefore = dialogs.length;
  await vis('.chat-action-btn[data-action="develop"]').first().click();
  ok('a Develop session opens', await until(async () => (await modeWord()) === 'Develop', 25000),
    `${await modeWord().catch(() => '?')} ${dialogs.slice(dialogsBefore).join(' | ').replace(/\s+/g, ' ').slice(0, 300)}`);
  const devMap = () => vis('.chat-live-rail .quest-map[data-kind="develop"]');
  ok('the Develop quest map is on the rail', await until(async () => (await devMap().count()) === 1, 20000));
  ok('develop stages are build, boss, trial',
    JSON.stringify(await devMap().locator('.quest-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-stage')))) === '["build","boss","trial"]');
  ok('build shows "2 of 4"',
    await until(async () => ((await devMap().locator('.quest-node[data-stage="build"]').innerText()) || '').includes('2 of 4'), 15000),
    await devMap().locator('.quest-node[data-stage="build"]').innerText().catch(() => ''));
  const buildCard = vis('.chat-subagents[data-party-stage="build"]');
  ok('the build party is live', await until(async () => (await buildCard.count()) === 1, 15000));
  await sampleContrast();

  ok('the Develop run finishes', await waitText('DEVELOP-DONE', 60000));
  await waitIdle();
  await page.waitForTimeout(600);
  const kickers = await vis('.chat-subagents-stage').allInnerTexts();
  ok('card titles: "Build · wave 1", "Boss gate · round 2", "Final trial · round 1"',
    ['Build · wave 1', 'Boss gate · round 2', 'Final trial · round 1'].every((k) => kickers.map((t) => t.trim()).includes(k)),
    JSON.stringify(kickers));
  if ((await buildCard.count()) && (await buildCard.getAttribute('data-open')) == null) await buildCard.locator('.chat-m-cardhead-hit').first().click();
  await page.waitForTimeout(300);
  const buildRows = await buildCard.locator('.chat-subagents-row').evaluateAll((els) => els.map((e) => ({
    role: e.getAttribute('data-role'), label: e.querySelector('.chat-subagents-row-role')?.textContent ?? '',
    badge: e.querySelector('.quest-badge')?.getAttribute('data-badge') ?? null,
  })));
  ok('the build card holds both implementers and the headless builder',
    buildRows.length === 3 && buildRows.every((r) => r.role === 'implementer'), JSON.stringify(buildRows));
  ok('…the headless builder is a "Builder" carrying memory, the Agent-tool builders carry nothing',
    buildRows.filter((r) => r.badge === 'memory').length === 1 && buildRows.filter((r) => r.badge == null).length === 2
    && buildRows.every((r) => r.label === 'Builder'), JSON.stringify(buildRows));
  const order = await page.evaluate(() => {
    const inner = [...document.querySelectorAll('.chat-scroll-inner')].find((e) => e.getClientRects().length);
    const kids = [...(inner?.children ?? [])].filter((e) => e.getClientRects().length);
    const card = kids.findIndex((e) => e.matches('.chat-subagents[data-party-stage="build"]'));
    const line = kids.findIndex((e) => e.matches('.chat-toolcard') && (e.textContent || '').includes("Started a builder with the Planner's memory"));
    const between = card >= 0 && line > card ? kids.slice(card + 1, line).filter((e) => e.matches('.chat-subagents')).length : -1;
    return { card, line, between };
  });
  ok('the build card sits before "Started a builder with the Planner\'s memory", no card between, the line outside any work beat',
    order.card >= 0 && order.line > order.card && order.between === 0, JSON.stringify(order));
  const headless = vis('.chat-scroll-inner > .chat-toolcard').filter({ hasText: "Started a builder with the Planner's memory" }).first();
  await headless.locator('.chat-m-toolhead-hit').click().catch(() => {});
  await page.waitForTimeout(400);
  ok('instrument control: the headless row\'s terminal does contain --fork-session',
    ((await headless.locator('.chat-m-terminal').innerText().catch(() => '')) || '').includes('--fork-session'));
  await headless.locator('.chat-m-toolhead-hit').click().catch(() => {});

  ok('"Quest cleared" appears', await until(async () => (await railText()).includes('Quest cleared'), 10000), await railText());
  await vis('.chat-live-rail .quest-receipt-toggle').first().click().catch(() => {});
  ok('…with the receipt', await until(async () => (await vis('.quest-receipt').count()) === 1, 5000));
  await sampleContrast();
  await samplePlain('develop receipt');
  await shot(vis('.quest-receipt'), 'develop-receipt');
  await escClose('.quest-receipt', 'the Develop receipt');

  // ════ goal-live in the Develop chat ═════════════════════════════════════════════════
  console.log('── goal-live on the rail');
  const goalMap = () => vis('.chat-live-rail .quest-map[data-kind="goal"]');
  await say('GOAL-LIVE');
  ok('the rail shows a goal-kind quest map', await until(async () => (await goalMap().count()) === 1, 15000));
  const nodes = await goalMap().locator('.quest-node-label').evaluateAll((els) => els.map((e) => ({
    text: (e.textContent || '').trim(), font: getComputedStyle(e).fontFamily, tt: getComputedStyle(e).textTransform,
  })));
  ok('…with 6 sentence-case, non-monospace nodes',
    nodes.length === 6 && nodes.every((n) => /^[A-Z][a-z]/.test(n.text) && n.text !== n.text.toUpperCase() && !/mono/i.test(n.font) && n.tt !== 'uppercase'),
    JSON.stringify(nodes));
  const goalReview = goalMap().locator('.quest-node[data-stage="review"]');
  ok('GOAL-LIVE: 3 cast avatars on review, and "round 2"',
    (await goalReview.locator('.quest-node-cast .chat-a-avatar').count()) === 3
    && ((await goalReview.locator('.quest-node-round').innerText().catch(() => '')) || '').includes('round 2'),
    await goalReview.innerText().catch(() => ''));
  const questBar = () => vis('.chat-live-rail .chat-quest-bar');
  ok('the develop map is hidden while the goal file exists', (await questBar().count()) === 0 && (await devMap().count()) === 0);
  const goalBarH = await vis('.chat-live-rail .goal-live-bar').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  ok('the goal bar on the rail is ≤ 64px tall', goalBarH.length === 1 && goalBarH[0] <= 64, JSON.stringify(goalBarH));
  await vis('.chat-live-rail button.goal-live-bar').first().click().catch(() => {});
  ok('the popup opens with the roster and the timeline',
    await until(async () => (await vis('.goal-live-popup .goal-live-roster .goal-live-member[data-role][data-s]').count()) === 3, 5000)
    && (await vis('.goal-live-popup .goal-live-timeline .goal-live-tick .goal-live-tick-label').count()) >= 4);
  await sampleContrast();
  await samplePlain('goal popup');
  await shot(vis('.goal-live-popup'), 'goal-popup');
  await escClose('.goal-live-popup', 'the goal popup');

  await say('GOAL-BUILD');
  const branch = () => vis('.chat-live-rail .quest-branch');
  ok('GOAL-BUILD: the branch shows on the rail', await until(async () => (await branch().count()) === 1, 15000));
  ok('…as 1 planner and 3 builders',
    (await branch().locator('.quest-branch-fan > .chat-a-avatar[data-role="planner"]').count()) === 1
    && (await branch().locator('.quest-branch-to .chat-a-avatar[data-role="implementer"]').count()) === 3);
  const caption = (await branch().locator('.quest-branch-caption').innerText().catch(() => '')) || '';
  ok('…captioned "memory was copied into 3 builders" with "182k"',
    caption.includes('memory was copied into 3 builders') && caption.includes('182k'), caption);
  const justBranched = await page.locator('.chat-live-rail .quest-branch[data-just-branched]').count();
  if (justBranched) await motion('[data-just-branched]', '.chat-live-rail .quest-branch[data-just-branched]');
  ok('[data-just-branched] fires', justBranched === 1);
  await page.waitForTimeout(WIN_HOLD_MS + 1000);
  ok('…once: it settles and does not fire again on the next poll',
    (await page.locator('.chat-live-rail .quest-branch[data-just-branched]').count()) === 0);
  for (const width of [1500, 720]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(500);
    for (const sel of ['.goal-live-bar', '.quest-map', '.chat-subagents']) {
      const over = await overflowOf(page, sel);
      ok(`layout @${width}px: no horizontal overflow on ${sel} (goal build)`, over.every((d) => d <= 1), JSON.stringify(over));
    }
  }
  await page.setViewportSize({ width: 1500, height: 1000 });
  await sampleContrast();
  await samplePlain('goal build');
  await shot(vis('.chat-live-rail'), 'goal-build-rail');

  await say('GOAL-DONE');
  ok('GOAL-DONE: the rail shows the finished goal, "Quest cleared"',
    await until(async () => (await vis('.chat-live-rail div.goal-live-bar[data-won]').count()) === 1, 15000), await railText());
  ok('the develop map stays hidden after GOAL-DONE', (await questBar().count()) === 0);
  await vis('.chat-live-rail .goal-live-bar .quest-receipt-toggle').first().click().catch(() => {});
  ok('the receipt opens', await until(async () => (await vis('.quest-receipt').count()) === 1, 5000));
  const receipt = vis('.quest-receipt');
  const lin = await receipt.locator('li.quest-lineage-node').evaluateAll((els) => els.map((e) => ({
    role: e.getAttribute('data-role'),
    name: e.querySelector(':scope > .quest-lineage-row .quest-lineage-name')?.textContent ?? '',
    note: e.querySelector(':scope > .quest-lineage-note')?.textContent ?? '',
    rounds: e.querySelector(':scope > .quest-lineage-row .quest-lineage-rounds')?.textContent ?? '',
    badge: e.querySelector(':scope > .quest-lineage-row .quest-badge')?.getAttribute('data-badge') ?? null,
  })));
  const planners = lin.filter((n) => n.role === 'planner');
  const builders = lin.filter((n) => n.role === 'implementer');
  const judges = lin.filter((n) => ['critic', 'pragmatist', 'edge-cases', 'reviewer', 'validator'].includes(n.role));
  ok('receipt root is "Claude"', lin[0]?.name === 'Claude', JSON.stringify(lin[0]));
  ok('ONE Planner node, rounds 1-2, "picked up where it left off · round 2"',
    planners.length === 1 && planners[0].rounds.includes('1-2') && planners[0].note.includes('picked up where it left off · round 2'),
    JSON.stringify(planners));
  ok('3 builders marked memory with "182k tokens not rebuilt"',
    builders.length === 3 && builders.every((b) => b.badge === 'memory' && b.note.includes('182k tokens not rebuilt')),
    JSON.stringify(builders));
  ok('the judges are fresh', judges.length >= 5 && judges.every((j) => j.badge === 'fresh'), JSON.stringify(judges.map((j) => j.role + ':' + j.badge)));
  ok('the receipt totals exactly "546k tokens"',
    ((await receipt.locator('.quest-receipt-stats').innerText().catch(() => '')) || '').includes('546k tokens'),
    await receipt.locator('.quest-receipt-stats').innerText().catch(() => ''));
  await sampleContrast();
  await samplePlain('goal receipt');
  await shot(receipt, 'goal-receipt');
  await escClose('.quest-receipt', 'the goal receipt');

  await say('GOAL-NOCTX');
  await waitText('GOAL-NOCTX-WRITTEN');
  await page.waitForTimeout(3000);
  await vis('.chat-live-rail .goal-live-bar .quest-receipt-toggle').first().click().catch(() => {});
  await until(async () => (await vis('.quest-receipt').count()) === 1, 5000);
  const noCtx = `${await railText()} ${await vis('.quest-receipt').innerText().catch(() => '')}`;
  ok('GOAL-NOCTX: no "Nk tokens" anywhere', !/\d+(\.\d+)?k tokens/.test(noCtx), noCtx.slice(0, 300));
  await escClose('.quest-receipt', 'the no-context receipt');

  await say('GOAL-CLEAR');
  ok('GOAL-CLEAR: the develop quest comes back to the rail',
    // The Develop quest is already won, so the bar comes back as its victory, not the map.
    await until(async () => (await vis('.chat-live-rail .goal-live-bar').count()) === 0
      && (await vis('.chat-live-rail .chat-quest-bar[data-kind="develop"]').count()) === 1, 15000),
    await railText());

  // ── contrast: the inks on every surface they sit on, after an instrument check ─────
  console.log('── contrast');
  const probe = async (fg, layers) => {
    await page.evaluate(([f, ls]) => {
      document.getElementById('dcq-probe')?.remove();
      let host = document.body;
      const root = document.createElement('div');
      root.id = 'dcq-probe';
      root.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;';
      host.appendChild(root);
      host = root;
      for (const bg of ls) { const d = document.createElement('div'); d.style.background = bg; d.style.padding = '2px'; host.appendChild(d); host = d; }
      const t = document.createElement('span');
      t.id = 'dcq-probe-fg';
      t.textContent = 'Couldn\'t edit';
      t.style.color = f;
      host.appendChild(t);
    }, [fg, layers]);
    const r = await contrast(page.locator('#dcq-probe-fg'));
    await page.evaluate(() => document.getElementById('dcq-probe')?.remove());
    return r;
  };
  const inst = [await probe('rgb(0, 0, 0)', ['rgb(255, 255, 255)']), await probe('rgb(118, 118, 118)', ['rgb(255, 255, 255)'])];
  ok('instrument check: black on white reads 21, #767676 on white reads 4.54',
    Math.abs(inst[0] - 21) < 0.05 && Math.abs(inst[1] - 4.54) < 0.03, JSON.stringify(inst));
  const surfaces = {
    bg: ['var(--color-bg)'], 'bg-secondary': ['var(--color-bg-secondary)'], 'bg-tertiary': ['var(--color-bg-tertiary)'],
    'error-subtle on bg-secondary': ['var(--color-bg-secondary)', 'var(--color-error-subtle)'],
  };
  for (const ink of ['success', 'error']) {
    for (const [name, layers] of Object.entries(surfaces)) {
      if (ink === 'success' && name.startsWith('error-subtle')) continue;
      const r = await probe(`var(--color-${ink}-ink)`, layers);
      report.note(`${theme} --color-${ink}-ink on ${name}: ${r}`);
      ok(`--color-${ink}-ink on ${name} ≥ 4.5:1`, r >= 4.5, String(r));
    }
  }
  // T8's ask: error ink on "the pink background of a failed row inside a run". Measured on a
  // failed row built from the app's own classes, so the cascade decides its backdrop in each
  // state: cards.css gives it --color-error-subtle over the run's --color-bg-secondary, and its
  // error rule outranks the open/hover --color-bg-tertiary rules. A plain tertiary layering is
  // recorded as a note only: nothing in the product paints error-subtle over bg-tertiary.
  report.note(`${theme} (not painted) --color-error-ink on error-subtle over bg-tertiary: ${await probe('var(--color-error-ink)', ['var(--color-bg-tertiary)', 'var(--color-error-subtle)'])}`);
  for (const state of ['closed', 'open', 'hovered']) {
    await page.evaluate((st) => {
      document.getElementById('dcq-failrow')?.remove();
      const host = document.createElement('div');
      host.id = 'dcq-failrow';
      host.style.cssText = 'position:fixed;left:40px;top:40px;width:600px;z-index:99999;';
      host.innerHTML = `<div class="chat-toolrun"><div class="chat-toolrun-rows"><div class="chat-toolcard chat-step" data-status="error"${st === 'open' ? ' data-open="true"' : ''}>`
        + '<div class="chat-m-toolhead"><span class="chat-m-toolhead-action">Couldn\'t edit</span></div></div></div></div>';
      document.body.appendChild(host);
    }, state);
    const row = page.locator('#dcq-failrow .chat-toolcard');
    if (state === 'hovered') await row.hover();
    const bg = await row.evaluate((e) => getComputedStyle(e).backgroundColor);
    const r = await contrast(page.locator('#dcq-failrow .chat-m-toolhead-action'));
    report.note(`${theme} failed row in a run (${state}): bg ${bg}, ${r}`);
    ok(`--color-error-ink on a failed row inside a run (${state}) ≥ 4.5:1`, r >= 4.5, `${r} on ${bg}`);
  }
  await page.evaluate(() => document.getElementById('dcq-failrow')?.remove());
  await page.mouse.move(0, 0);
  for (const [what, v] of Object.entries(minContrast)) {
    report.note(`${theme} worst ${what}: ${v.ratio} "${v.text}"`);
    ok(`visible text ≥ 4.5:1: ${what}`, v.ratio >= 4.5, `${v.ratio} "${v.text}"`);
  }
  const unseen = Object.keys(TEXT_SELECTORS).filter((k) => !minContrast[k]);
  if (unseen.length) report.note(`${theme} contrast: never on screen during a sample: ${unseen.join(', ')}`);

  ok('plain language: no fork/session/resume/--, "Sleepy", em dash or emoji on any quest surface',
    plainLeaks.length === 0, plainLeaks.slice(0, 8).join('\n      '));
  const dashes = dashLines(await chromeText(page, '.chat-live-rail'));
  ok('no em dash on the rail', dashes.length === 0, dashes.join(' | '));
}

/** The writer's session rule, against the real CLI in a vault of its own (an unstamped
 *  `.solo` file would otherwise be visible to every pane of the chat vault). */
function writerChecks(report) {
  console.log('\n── the goal-live writer');
  const tmp = join(WRITER, '_dream_context', 'tmp');
  const sid = '0b7e2c1a-5d4f-4e8b-9a3c-1f2e3d4c5b6a';
  const run = (env) => spawnSync(process.execPath, [DIST, 'goal-live', 'start', '--goal', 'writer-demo'], {
    cwd: WRITER, env: { ...process.env, HOME, ...env }, encoding: 'utf-8',
  });
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  const stamped = run({ CLAUDE_CODE_SESSION_ID: sid });
  const stampedFile = join(tmp, `.goal-skill-live.${sid}.json`);
  const s1 = existsSync(stampedFile) ? JSON.parse(readFileSync(stampedFile, 'utf-8')) : null;
  report.check('cli', 'env set: a file named for the session, stamped with it', stamped.status === 0 && s1?.session === sid,
    `exit ${stamped.status} ${stamped.stderr} ${JSON.stringify(s1)}`);
  const solo = spawnSync(process.execPath, [DIST, 'goal-live', 'start', '--goal', 'writer-demo'], {
    cwd: WRITER, env: { ...env, HOME, CLAUDE_CODE_SESSION_ID: '' }, encoding: 'utf-8',
  });
  const soloFile = join(tmp, '.goal-skill-live.solo.json');
  const s2 = existsSync(soloFile) ? JSON.parse(readFileSync(soloFile, 'utf-8')) : null;
  report.check('cli', 'env unset: `.solo`, unstamped', solo.status === 0 && !!s2 && s2.session === undefined,
    `exit ${solo.status} ${solo.stderr} ${JSON.stringify(s2)}`);
}

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
  for (const theme of (process.env.VERIFY_THEMES || 'light,dark').split(',')) {
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    clearGoalFiles();
    // One theme's crash must not cost the other its run: record it and go on.
    try {
      await runTheme(chromium, `http://127.0.0.1:${port}`, theme, report);
    } catch (err) {
      report.fails.push(`[${theme}] harness: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      console.error(err);
    }
  }
  writerChecks(report);
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\nscreenshots: ${SHOTS}`);
console.log(`${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
