#!/usr/bin/env node
/**
 * Headless builders as live teammates in Chat, end to end in the real app.
 *
 *   npm run build && npm run verify:chat-teammates
 *
 * A `claude -p` builder the orchestrator REGISTERED (`goal-live actor … --session <uuid>`) or
 * LAUNCHED (`claude -p --session-id <uuid>` in its own call) joins a party card with its role,
 * its brief, its live steps and its status, all read off the builder's own transcript, and its
 * drill-in is that transcript, not shell output. Four cases, both themes:
 *
 *   DETACHED  registered, started detached (nothing tracks it): running, live step, then done
 *             with its report; the drill-in shows its transcript.
 *   LAUNCHED  not registered, started by the chat's own `--session-id` call: the server confirms
 *             the launch against the pane's own transcript and the card appears.
 *   CRASH     registered, dies without an exit record: reads "Stopped", never running forever.
 *   ENDED     registered, and the chat's own session ends while it works: the card still turns
 *             done, because nothing about it depends on the orchestrator being alive.
 *
 * WHAT IT DOES NOT SPEND: tokens. The chat's `claude` is a scripted stand-in in a fake HOME, and
 * each builder is a second stand-in named `claude` that writes a transcript in the shapes claude
 * 2.1.281 writes for a `-p` run (queue-operation enqueue, tool_use/tool_result, end_turn answer,
 * cost-state on exit) into the fake HOME's projects dir, under a worktree-style slug of its own.
 *
 * FAILURE POLICY: collect, don't fail fast. Exit 0 iff every check passes.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeText, distIndex, scratchDir, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = distIndex(REPO);
const SCRATCH = scratchDir('dreamcontext-verify-chat-teammates');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const BUILDER_DIR = join(SCRATCH, 'builder');
const SHOTS = shotsDir(REPO, 'chat-teammates');

// ─── the builder stand-in: a `claude -p` that writes its own transcript ─────────────────
function builderMain() {
  const fs = require('fs');
  const path = require('path');
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  // `--resume <uuid>` appends a new turn to the same transcript, the way claude resumes a session.
  const sid = flag('--session-id') || flag('--resume');
  const plan = JSON.parse(fs.readFileSync(flag('--verify-plan'), 'utf-8'));
  const dir = path.join(process.env.HOME, '.claude', 'projects', '-verify-claude-worktrees-lane');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  const ts = () => new Date().toISOString();
  const row = (o) => fs.appendFileSync(file, JSON.stringify(Object.assign({ sessionId: sid, timestamp: ts() }, o)) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    row({ type: 'queue-operation', operation: 'enqueue', content: plan.brief });
    row({ type: 'queue-operation', operation: 'dequeue' });
    row({ type: 'user', message: { role: 'user', content: plan.brief } });
    let n = 0;
    for (const step of plan.steps) {
      const id = `toolu_b${plan.resume ? 'r' : ''}${++n}`;
      row({ type: 'assistant', message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: step.name, input: step.input }] } });
      await sleep(plan.stepMs);
      row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
    }
    if (plan.crash) {
      // Dies mid-step: a tool call with no result and no exit record, like a SIGKILL.
      row({ type: 'assistant', message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_last', name: 'Bash', input: { command: 'npm test' } }] } });
      process.exit(1);
    }
    row({ type: 'assistant', message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: plan.answer }] } });
    row({ type: 'cost-state', totalDuration: plan.steps.length * plan.stepMs });
    process.exit(0);
  })();
}

// ─── the chat stand-in: plays the orchestrator ─────────────────────────────────────────
function chatMain(cfg) {
  const fs = require('fs');
  const path = require('path');
  const { spawn: spawnChild } = require('child_process');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };
  const SID = flag('--session-id') || flag('--resume') || cfg.fallbackSid;
  let seq = 0;
  // The pane's OWN transcript: what the server checks a launch against. Real claude writes it;
  // the stand-in writes the one line that matters, the launching tool call.
  const paneDir = path.join(process.env.HOME, '.claude', 'projects', '-verify-proj');
  fs.mkdirSync(paneDir, { recursive: true });
  const paneLog = (o) => fs.appendFileSync(path.join(paneDir, `${SID}.jsonl`), JSON.stringify(o) + '\n');

  const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  async function bash(command) {
    const tid = `toolu_c${++seq}`;
    const use = { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command } }] } };
    out(use);
    paneLog(use);
    await sleep(200);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: [{ type: 'text', text: '' }], is_error: false }] } });
    await sleep(150);
  }
  const liveFile = () => path.join(process.cwd(), '_dream_context', 'tmp', `.goal-skill-live.${SID}.json`);
  const lineage = [];
  // `extra` is what `goal-live actor` writes for its flags: `{ w: <--wave>, r: <--round> }`.
  function register(a, role, k, sid, extra = {}) {
    lineage.push({ a, role, k, sid, at: new Date().toISOString(), ...extra });
    const now = new Date().toISOString();
    fs.mkdirSync(path.dirname(liveFile()), { recursive: true });
    fs.writeFileSync(liveFile(), JSON.stringify({ goal: 'teammates-demo', session: SID, started: now, updated: now, phase: 'plan', lineage }));
  }
  function startBuilder(sid, plan) {
    const planFile = path.join(cfg.builderDir, `${sid}${plan.resume ? '-resume' : ''}.json`);
    fs.writeFileSync(planFile, JSON.stringify(plan));
    // Detached: the chat's process does not own it, and it outlives the chat.
    spawnChild(cfg.builder, ['-p', plan.resume ? '--resume' : '--session-id', sid, '--verify-plan', planFile], { detached: true, stdio: 'ignore', env: process.env }).unref();
  }
  const steps = (n) => Array.from({ length: n }, (_, i) => ({ name: 'Read', input: { file_path: `src/payments/lane-${i + 1}.ts` } }));

  // ── the Develop recipe's shapes: a wait on the builders, then a reviewer Agent ──
  /** How many turns a builder has finished: one `cost-state` row per run of it. */
  const turnsDone = (sid) => {
    try {
      const raw = fs.readFileSync(path.join(process.env.HOME, '.claude', 'projects', '-verify-claude-worktrees-lane', `${sid}.jsonl`), 'utf-8');
      return raw.split('\n').filter((l) => l.includes('"cost-state"')).length;
    } catch { return 0; }
  };
  /** The lead's wait loop: one Bash call that returns once every builder finished its nth turn. */
  async function waitBuilt(sids, nth, command) {
    const tid = `toolu_c${++seq}`;
    const use = { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Bash', input: { command } }] } };
    out(use);
    paneLog(use);
    const until = Date.now() + 60000;
    while (Date.now() < until && !sids.every((s) => turnsDone(s) >= nth)) await sleep(250);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: [{ type: 'text', text: 'done' }], is_error: false }] } });
    await sleep(200);
  }
  /** A synchronous reviewer Agent: its tool_result is its report. */
  async function review(taskId, description, ms, summary) {
    const tid = `toolu_c${++seq}`;
    const use = { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Agent', input: { description, subagent_type: 'reviewer', prompt: description } }] } };
    out(use);
    paneLog(use);
    await sleep(120);
    out({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: tid, task_type: 'local_agent', subagent_type: 'reviewer', description, prompt: description });
    await sleep(ms);
    out({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: tid, status: 'completed', summary, total_tokens: 900, total_tool_use_count: 3, total_duration_ms: ms });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: [{ type: 'text', text: summary }] }] }, tool_use_result: { agentId: taskId, totalTokens: 900, totalToolUseCount: 3, totalDurationMs: ms } });
    await sleep(250);
  }

  async function runTurn(prompt) {
    out({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    await sleep(150);
    let end = false;
    if (prompt.includes('DETACHED')) {
      const sid = cfg.ids.detached;
      register('planner', 'planner', 'spawn', sid);
      await bash(`dreamcontext goal-live actor planner --kind spawn --session ${sid} && nohup /tmp/run-planner.sh &`);
      startBuilder(sid, { brief: 'Plan the parent panel payment line\nRead the task first.', steps: steps(4), stepMs: 3000, answer: 'PLAN READY: three files, one new line.' });
      say('DETACHED-STARTED');
    } else if (prompt.includes('LAUNCHED')) {
      const sid = cfg.ids.launched;
      await bash(`nohup claude -p --session-id ${sid} "Build the tokens lane" > /dev/null 2>&1 &`);
      startBuilder(sid, { brief: 'Build the tokens lane', steps: steps(2), stepMs: 2500, answer: 'BUILT: tokens lane.' });
      say('LAUNCHED-STARTED');
    } else if (prompt.includes('CRASH')) {
      const sid = cfg.ids.crash;
      register('T2', 'implementer', 'fork', sid);
      await bash(`dreamcontext goal-live actor T2 --role implementer --kind fork --from planner --session ${sid} && nohup /tmp/run-t2.sh &`);
      startBuilder(sid, { brief: 'Build the receipts lane', steps: steps(1), stepMs: 1500, crash: true });
      say('CRASH-STARTED');
    } else if (prompt.includes('ENDED')) {
      const sid = cfg.ids.ended;
      register('validator', 'validator', 'fresh', sid);
      await bash(`dreamcontext goal-live actor validator --kind fresh --session ${sid} && nohup /tmp/run-validator.sh &`);
      startBuilder(sid, { brief: 'Run the final checks', steps: steps(3), stepMs: 3000, answer: 'PASS: every criterion holds.' });
      say('ENDED-STARTED');
      end = true;
    } else if (prompt.includes('DEVELOP')) {
      // A Develop run the way the recipe drives it: every builder is spawned with a SHELL
      // VARIABLE for its id, so no spawn call names the uuid. Wave 6 is registered through the
      // variable too (its first literal id is the resume, far later); wave 7's three are
      // registered with literal ids in ONE call. A reviewer follows each wave.
      const d = cfg.ids.develop;
      const lane = (n) => ({ steps: steps(n), stepMs: 1500 });
      say('Wave 6: one builder on the ledger lane.');
      await bash('SID=$(uuidgen | tr A-Z a-z); echo "$SID" > .w6-A.sid; nohup claude -p --session-id "$SID" "$(cat brief-w6-A.md)" > /dev/null 2>&1 &');
      startBuilder(d.w6a, { brief: 'Build the ledger lane', ...lane(3), answer: 'BUILT: ledger lane.' });
      register('w6-A', 'implementer', 'spawn', d.w6a, { w: 6 });
      await bash('dreamcontext goal-live actor w6-A --kind spawn --role implementer --wave 6 --session "$(cat .w6-A.sid)"');
      await waitBuilt([d.w6a], 1, 'while pgrep -f "$(cat .w6-A.sid)" > /dev/null; do sleep 5; done');
      await review('rev-w6-1', 'Review wave 6', 2500, 'NEEDS_WORK: the ledger total rounds twice.');
      say('The reviewer sent wave 6 back. Its builder picks up the note.');
      await bash('nohup claude -p --resume "$(cat .w6-A.sid)" "Fix the rounding note" > /dev/null 2>&1 &');
      startBuilder(d.w6a, { resume: true, brief: 'Fix the rounding note', ...lane(2), answer: 'FIXED: the ledger rounds once.' });
      register('w6-A', 'implementer', 'resume', d.w6a, { w: 6, r: 2 });
      await bash(`dreamcontext goal-live actor w6-A --kind resume --role implementer --wave 6 --round 2 --session ${d.w6a}`);
      await waitBuilt([d.w6a], 2, 'while pgrep -f "$(cat .w6-A.sid)" > /dev/null; do sleep 5; done');
      await review('rev-w6-2', 'Review wave 6 again', 2500, 'PASS: wave 6 holds.');
      say('Wave 7: three builders.');
      const w7 = [['B', d.w7b, 3], ['C', d.w7c, 4], ['D', d.w7d, 3]];
      await bash('for L in B C D; do SID=$(uuidgen | tr A-Z a-z); echo "$SID" > .w7-$L.sid; nohup claude -p --session-id "$SID" "$(cat brief-w7-$L.md)" > /dev/null 2>&1 & done');
      for (const [L, sid, n] of w7) startBuilder(sid, { brief: `Build the ${L === 'B' ? 'invoice' : L === 'C' ? 'refund' : 'export'} lane`, ...lane(n), answer: `BUILT: lane ${L}.` });
      for (const [L, sid] of w7) register(`w7-${L}`, 'implementer', 'spawn', sid, { w: 7 });
      await bash(w7.map(([L, sid]) => `dreamcontext goal-live actor w7-${L} --kind spawn --role implementer --wave 7 --session ${sid}`).join(' && '));
      await waitBuilt(w7.map(([, sid]) => sid), 1, 'for L in B C D; do while pgrep -f "$(cat .w7-$L.sid)" > /dev/null; do sleep 5; done; done');
      await review('rev-w7-1', 'Review wave 7', 9000, 'PASS: wave 7 holds.');
      say('DEVELOP-DONE: waves 6 and 7 are in.');
    } else say('ANSWER ' + prompt);
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: SID });
    // The orchestrator's session ends while its validator is still working.
    if (end) setTimeout(() => process.exit(0), 600);
  }

  let buf = '';
  const inbox = [];
  let busy = false;
  async function pump() {
    if (busy) return;
    const next = inbox.shift();
    if (next === undefined) return;
    busy = true;
    try { await runTurn(next); } finally { busy = false; pump(); }
  }
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
  process.stdin.on('end', () => process.exit(0));
}

const uuid = (n) => `${String(n).repeat(8)}-4444-4555-8666-${String(n).repeat(12)}`;

function setupScratch(theme) {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'tmp'), { recursive: true });
  mkdirSync(BUILDER_DIR, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  // Fresh ids per theme: a transcript from the other theme's run must not answer for this one.
  const base = theme === 'light' ? 1 : 5;
  const wid = (i) => `9${base}${i}00000-4444-4555-8666-9${base}${i}000000000`;
  const ids = {
    detached: uuid(base), launched: uuid(base + 1), crash: uuid(base + 2), ended: uuid(base + 3),
    develop: { w6a: wid(1), w7b: wid(2), w7c: wid(3), w7d: wid(4) },
  };
  const builder = join(BUILDER_DIR, 'claude');
  writeFileSync(builder, `#!${process.execPath}\n(${builderMain.toString()})();\n`);
  chmodSync(builder, 0o755);
  const chat = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(chat, `#!${process.execPath}\n(${chatMain.toString()})(${JSON.stringify({ fallbackSid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', builder, builderDir: BUILDER_DIR, ids })});\n`);
  chmodSync(chat, 0o755);
  const add = spawnSync(process.execPath, [DIST, 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
  return ids;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST, 'dashboard', '--no-open', '-p', String(port)], {
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

const JARGON = /fork|session|resume|--/i;

/** A fresh scratch vault, its server, and a browser page with a chat open in it. */
async function openChat(chromium, port, theme, report, title) {
  const ids = setupScratch(theme);
  const server = await startServer(port);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  mkdirSync(SHOTS, { recursive: true });
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000, step = 150) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(step); }
    return false;
  };
  const paneText = async () => (await vis('.chat-pane').first().innerText()).replace(/\s+/g, ' ');
  const say = async (text) => {
    await until(async () => (await vis('.chat-cmp-input').count()) > 0, 30000);
    await vis('.chat-cmp-input').first().click();
    await vis('.chat-cmp-input').first().fill(text);
    await page.keyboard.press('Enter');
  };
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) }).catch(() => {});
  /** The card holding the run with this session: rows first, then the landed report. */
  const row = (sid) => page.locator(`[data-subagent-row="teammate:${sid}"]:visible`);
  const openRows = async () => {
    for (const head of await vis('.chat-subagents:not([data-open]) .chat-m-cardhead').all()) await head.click().catch(() => {});
    await page.waitForTimeout(200);
  };
  const close = async () => { await browser.close().catch(() => {}); server.kill(); };

  console.log(`\n═══ ${theme}${title ? ` · ${title}` : ''} ═══`);
  try {
    await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
    for (const sel of ['.agent-dock-chip', '.agent-fab', '.agent-surface']) {
      if (await page.locator('.agent-surface.expanded').count()) break;
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    ok('a chat session opens', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  } catch (err) { await close(); throw err; }
  return { ids, page, ok, vis, until, paneText, say, shot, row, openRows, close };
}

async function runTheme(chromium, port, theme, report) {
  const { ids, page, ok, vis, until, paneText, say, shot, row, openRows, close } = await openChat(chromium, port, theme, report);
  try {
    const report$ = (text) => vis('.chat-subreport').filter({ hasText: text });

    // ── DETACHED ──────────────────────────────────────────────────────────────────────
    console.log('── a registered builder, started detached');
    await say('DETACHED');
    ok('its row appears in a party card', await until(async () => (await row(ids.detached).count()) > 0, 15000),
      `pane: ${(await paneText()).slice(-400)} | cards: ${await vis('.chat-subagents').count()}`);
    await shot('detached-first');
    const r1 = row(ids.detached);
    ok('it wears its registered role', (await r1.getAttribute('data-role').catch(() => null)) === 'planner', await r1.getAttribute('data-role').catch(() => '?'));
    ok('the brief reads on the row',
      await until(async () => ((await r1.innerText()) || '').includes('Plan the parent panel payment line'), 8000),
      await r1.innerText().catch(() => ''));
    ok('it reads as running', await until(async () => (await r1.getAttribute('data-status')) === 'running', 8000));
    ok('its doing line is a live step, in the team log\'s words',
      await until(async () => /^Reading/.test(((await r1.locator('.chat-subagents-row-doing').innerText()) || '').trim()), 12000),
      await r1.locator('.chat-subagents-row-doing').innerText().catch(() => ''));
    await shot('detached-running');
    // DOCKED over the composer while it works: the lead's long answer scrolls its card away,
    // and the owner could only see the lead's own "Wait for planner…" shell down here.
    const mate = vis('.chat-bgshells-row--mate');
    ok('while it works, the tray over the composer names it: "Planner is working" (was only a background shell row)',
      await until(async () => /Planner is working/.test(await vis('.chat-bgshells-title').first().innerText().catch(() => '')), 10000)
        && (await mate.count()) === 1
        && /Planner/.test(await mate.first().innerText().catch(() => '')),
      `tray: ${await vis('.chat-bgshells').first().innerText().catch(() => '(none)')}`);
    ok('…with what it is doing now', /Reading/.test(await mate.first().locator('.chat-bgshells-mate-doing').innerText().catch(() => '')));
    await mate.first().locator('.chat-bgshells-btn').click();
    ok('…and Open there opens its own transcript',
      await until(async () => (await vis('.chat-slideover-transcript').count()) > 0, 10000));
    await vis('.chat-slideover-close').first().click().catch(() => {});
    await until(async () => (await vis('.chat-slideover-scrim').count()) === 0, 5000);
    // Drill-in while it works: its transcript, not shell output.
    await r1.click();
    ok('the drill-in opens its transcript', await until(async () => (await vis('.chat-slideover-transcript').count()) > 0, 10000));
    ok('…with its brief in it', ((await vis('.chat-slideover-transcript').first().innerText().catch(() => '')) || '').includes('Plan the parent panel payment line'));
    ok('…and no shell output panel', (await vis('.chat-slideover-shellout').count()) === 0);
    await shot('detached-drillin');
    await vis('.chat-slideover-close').first().click().catch(() => {});
    ok('the drill-in closes', await until(async () => (await vis('.chat-slideover-scrim').count()) === 0, 5000));
    ok('it lands done, with its report', await until(async () => (await report$('PLAN READY').count()) > 0, 30000),
      (await paneText()).slice(-300));
    ok('…and leaves the tray once it is done (its card keeps the record)',
      await until(async () => (await vis('.chat-bgshells-row--mate').count()) === 0, 10000));

    // ── LAUNCHED ──────────────────────────────────────────────────────────────────────
    console.log('── a builder launched by the chat\'s own call, not registered');
    await say('LAUNCHED');
    ok('the launched builder joins a party card', await until(async () => (await row(ids.launched).count()) > 0, 20000),
      `rows: ${await page.locator('[data-subagent-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-subagent-row')).join(','))} | pane: ${(await paneText()).slice(-300)}`);
    ok('…as a Builder, named by its brief',
      await until(async () => (await row(ids.launched).getAttribute('data-role')) === 'implementer'
        && ((await row(ids.launched).innerText()) || '').includes('Build the tokens lane'), 8000),
      await row(ids.launched).innerText().catch(() => ''));
    ok('…and lands done', await until(async () => (await report$('BUILT').count()) > 0, 30000));

    // ── CRASH ─────────────────────────────────────────────────────────────────────────
    console.log('── a builder that dies without an exit record');
    await say('CRASH');
    ok('the crashing builder appears', await until(async () => (await row(ids.crash).count()) > 0, 15000));
    const stoppedNow = async () => {
      await openRows();
      return (await row(ids.crash).getAttribute('data-status')) === 'stopped';
    };
    ok('it reads Stopped, not running forever', await until(stoppedNow, 25000),
      await row(ids.crash).getAttribute('data-status').catch(() => '?'));
    ok('…and its line says so', ((await row(ids.crash).locator('.chat-subagents-row-doing').innerText().catch(() => '')) || '').trim() === 'Stopped');

    // ── ENDED ─────────────────────────────────────────────────────────────────────────
    console.log('── the orchestrator\'s session ends while its builder works');
    await say('ENDED');
    ok('the builder appears', await until(async () => (await row(ids.ended).count()) > 0, 15000));
    ok('the chat\'s own session ended', await until(async () => /Session ended|Resume/.test(await paneText()), 20000));
    ok('the builder still lands done after the session ended', await until(async () => (await report$('PASS').count()) > 0, 40000),
      (await paneText()).slice(-300));
    await openRows();
    await shot('all-landed');

    // ── plain language on the cards ──────────────────────────────────────────────────
    const cardText = await chromeText(page, '.chat-subagents');
    const leaks = cardText.split('\n').filter((l) => JARGON.test(l) || /Sleepy/.test(l) || l.includes('—'));
    ok('plain language on the party cards: no fork/session/resume/--, Sleepy or em dash', leaks.length === 0, leaks.slice(0, 5).join(' | '));
  } finally {
    await close();
  }
}

/** "4:07" / "1:02:03" → seconds; null for anything else. */
function clockSeconds(text) {
  if (!/^\d+(?::\d{2})+$/.test((text ?? '').trim())) return null;
  return text.trim().split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/**
 * MULTI-WAVE DEVELOP (owner 09-27, two screenshots): a run that starts at wave 6, one builder,
 * sent back and resumed as round 2; then wave 7, three builders registered in one call; a
 * reviewer after each. Read in the rendered DOM: each build card names its REGISTERED wave,
 * holds exactly that wave's builders, sits above the review that followed it, and once
 * finished never docks under the newest message or below the live card; its clock is its own
 * span and stands still.
 */
async function runDevelop(chromium, port, theme, report) {
  const { ids, page, ok, vis, until, paneText, say, shot, row, openRows, close } = await openChat(chromium, port, theme, report, 'multi-wave develop');
  const d = ids.develop;
  const w7 = [d.w7b, d.w7c, d.w7d];
  try {
    /** Every party card in the pane, in DOM order, with what a reader sees on it. */
    const cards = async () => {
      await openRows();
      return vis('.chat-pane').first().evaluate((pane) => {
        const all = [...pane.querySelectorAll('.chat-subagents')];
        const assistants = [...pane.querySelectorAll('.chat-msg-assistant-row')];
        const newest = assistants[assistants.length - 1] ?? null;
        return {
          newestText: newest ? newest.innerText.replace(/\s+/g, ' ').slice(0, 80) : null,
          cards: all.map((el, i) => {
            const box = el.getBoundingClientRect();
            return {
              i,
              stage: el.getAttribute('data-party-stage'),
              kicker: el.querySelector('.chat-subagents-stage')?.textContent?.trim() ?? '',
              rows: [...el.querySelectorAll('[data-subagent-row]')].map((r) => r.getAttribute('data-subagent-row')),
              running: !!el.querySelector('.chat-subagents-spinner'),
              clock: el.querySelector('.chat-subagents-elapsed')?.textContent?.trim() ?? null,
              top: Math.round(box.top),
              bottom: Math.round(box.bottom),
              // Does the newest assistant message come AFTER this card in the transcript?
              aboveNewest: newest ? !!(el.compareDocumentPosition(newest) & Node.DOCUMENT_POSITION_FOLLOWING) : true,
            };
          }),
        };
      });
    };
    const holding = (list, id) => list.find((c) => c.rows.includes(id));
    const describe = (list) => list.map((c) => `#${c.i} ${c.stage} "${c.kicker}" [${c.rows.map((r) => r.replace(/^teammate:(\w{3}).*/, 't:$1')).join(',')}]${c.running ? ' running' : ''} ${c.clock ?? ''}`).join(' | ');
    const buildAboveReview = (list, sid, reviewId) => {
      const build = holding(list, `teammate:${sid}`);
      const rev = holding(list, reviewId);
      return !!build && !!rev && build.i < rev.i && build.bottom <= rev.top;
    };

    const t0 = Date.now();
    await say('DEVELOP');
    ok('the wave-6 builder joins a card', await until(async () => { await openRows(); return (await row(d.w6a).count()) > 0; }, 20000),
      (await paneText()).slice(-300));

    // ── LIVE: the wave-7 reviewer is at work; everything before it is done ─────────────
    ok('the wave-7 review starts', await until(async () => {
      const { cards: list } = await cards();
      return !!holding(list, 'rev-w7-1')?.running;
    }, 90000, 400), describe((await cards()).cards));
    await page.waitForTimeout(600);
    const live = await cards();
    await shot('develop-live');
    const L = live.cards;
    const w6card = holding(L, `teammate:${d.w6a}`);
    const w7card = holding(L, `teammate:${d.w7b}`);
    const liveRev = holding(L, 'rev-w7-1');
    console.log(`      cards: ${describe(L)}`);
    ok('the wave-6 build card\'s kicker names its registered wave: "wave 6"', /\bwave 6\b/i.test(w6card?.kicker ?? ''), w6card?.kicker ?? '(no card)');
    ok('the wave-7 build card\'s kicker names its registered wave: "wave 7"', /\bwave 7\b/i.test(w7card?.kicker ?? ''), w7card?.kicker ?? '(no card)');
    ok('the wave-7 card holds all three wave-7 builders',
      !!w7card && w7.every((sid) => w7card.rows.includes(`teammate:${sid}`)),
      `wave-7 builders in: ${w7.map((sid) => holding(L, `teammate:${sid}`)?.i ?? 'none').join(',')}`);
    ok('…and not the wave-6 builder', !!w7card && !w7card.rows.includes(`teammate:${d.w6a}`) && w6card !== w7card, describe(L));
    ok('the wave-6 build card sits above the review that followed it', buildAboveReview(L, d.w6a, 'rev-w6-1'), describe(L));
    ok('the wave-7 build card sits above the review that followed it', buildAboveReview(L, d.w7b, 'rev-w7-1'), describe(L));
    ok('no finished card sits below the live review card',
      !!liveRev && L.filter((c) => !c.running && c.i > liveRev.i).length === 0, describe(L));
    const sinceFirst = (Date.now() - t0) / 1000;
    const c7a = clockSeconds(w7card?.clock);
    ok('the finished wave-7 card\'s clock is its own span, not the time since the first spawn',
      c7a != null && c7a >= 1 && c7a <= 15 && c7a < sinceFirst - 5, `clock ${w7card?.clock} vs ${Math.round(sinceFirst)}s since the first spawn`);
    await page.waitForTimeout(2100);
    const again = await cards();
    const w7b2 = holding(again.cards, `teammate:${d.w7b}`);
    const w6b2 = holding(again.cards, `teammate:${d.w6a}`);
    ok('…and stands still (read twice, 2s apart)', !!w7card?.clock && w7card.clock === w7b2?.clock && !w7card.running, `${w7card?.clock} → ${w7b2?.clock}`);
    ok('the finished wave-6 card\'s clock stands still too', !!w6card?.clock && !w6card.running && w6card.clock === w6b2?.clock, `${w6card?.clock} → ${w6b2?.clock}`);

    // ── DONE: the lead's last message is the bottom of the transcript ─────────────────
    ok('the run lands', await until(async () => (await paneText()).includes('DEVELOP-DONE') && !holding((await cards()).cards, 'rev-w7-1')?.running, 30000));
    await page.waitForTimeout(800);
    const done = await cards();
    await shot('develop-done');
    const D = done.cards;
    console.log(`      cards: ${describe(D)} | newest: ${done.newestText}`);
    ok('no finished card is rendered below the newest message', /DEVELOP-DONE/.test(done.newestText ?? '') && D.every((c) => c.aboveNewest),
      `newest "${done.newestText}" · below it: ${describe(D.filter((c) => !c.aboveNewest))}`);
    ok('still in order once done: wave 6 above its review, wave 7 above its review',
      buildAboveReview(D, d.w6a, 'rev-w6-1') && buildAboveReview(D, d.w7b, 'rev-w7-1'), describe(D));
    ok('still named by their registered waves once done',
      /\bwave 6\b/i.test(holding(D, `teammate:${d.w6a}`)?.kicker ?? '') && /\bwave 7\b/i.test(holding(D, `teammate:${d.w7b}`)?.kicker ?? ''), describe(D));
    // The build cards, framed, for the eye.
    const b7 = vis('.chat-subagents[data-party-stage="build"]').last();
    await b7.scrollIntoViewIfNeeded().catch(() => {});
    await shot('develop-wave7-card');

    // ── ONE ENTRY PER AGENT (owner 09-27 11:28): a landed builder's report lives in its own
    //    row, never as a second avatar-and-title entry under the rows. Read open and collapsed.
    const w7answers = { [d.w7b]: 'BUILT: lane B.', [d.w7c]: 'BUILT: lane C.', [d.w7d]: 'BUILT: lane D.' };
    const card7 = page.locator(`.chat-subagents:has([data-agent-entry="teammate:${d.w7b}"]), .chat-subagents:has([data-subagent-row="teammate:${d.w7b}"])`).first();
    /** The wave-7 card's agent entries: which run each is, whether it is a row, and its text. */
    const entries7 = () => card7.evaluate((el) => [...el.querySelectorAll('[data-agent-entry]')].map((e) => ({
      id: e.getAttribute('data-agent-entry'),
      row: !!e.querySelector('.chat-subagents-row'),
      text: e.innerText.replace(/\s+/g, ' '),
    })));
    const entriesOk = (list) => list.length === w7.length
      && w7.every((sid) => { const e = list.find((x) => x.id === `teammate:${sid}`); return !!e && e.text.includes(w7answers[sid]); })
      && Object.values(w7answers).every((a) => list.filter((e) => e.text.includes(a)).length === 1);
    const showEntries = (list) => list.map((e) => `${e.id?.replace(/^teammate:(\w{3}).*/, 't:$1')}${e.row ? '(row)' : ''}: ${e.text.slice(0, 50)}`).join(' | ');
    await openRows();
    const open7 = await entries7();
    ok('open, the wave-7 card shows exactly one entry per builder (3), each a row',
      open7.length === 3 && open7.every((e) => e.row), showEntries(open7));
    ok('…and each builder\'s report text sits inside its own row',
      entriesOk(open7) && (await card7.locator('.chat-subagents-reports').count()) === 0, showEntries(open7));
    await card7.scrollIntoViewIfNeeded().catch(() => {});
    await shot('develop-wave7-one-entry-open');
    await card7.locator('.chat-m-cardhead').first().click();
    await page.waitForTimeout(250);
    const shut7 = await entries7();
    ok('collapsed, the wave-7 card still shows one entry per builder (3), each with its report',
      (await card7.getAttribute('data-open')) === null && entriesOk(shut7) && shut7.every((e) => !e.row), showEntries(shut7));
    await card7.scrollIntoViewIfNeeded().catch(() => {});
    await shot('develop-wave7-one-entry-collapsed');
  } finally {
    await close();
  }
}

const report = {
  pass: 0, fails: [], notes: [],
  check(theme, label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(`[${theme}] ${label}`); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

try {
  const { chromium } = await import('@playwright/test');
  for (const theme of (process.env.VERIFY_THEMES || 'light,dark').split(',')) {
    for (const run of [runTheme, runDevelop]) {
      try {
        await run(chromium, await freePort(), theme, report);
      } catch (err) {
        report.fails.push(`[${theme}] harness (${run.name}): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        console.error(err);
      }
    }
  }
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
}

console.log(`\nscreenshots: ${SHOTS}`);
console.log(`${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
