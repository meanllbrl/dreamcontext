#!/usr/bin/env node
/**
 * The Super Agent, end to end (task chat-gets-a-super-agent-mode-sub-agents-as-containers-
 * one-question-queue, plan-r7 "W2 lead").
 *
 *   npm run build && node scripts/verify/super-agent.mjs        (ENGINES=chromium,webkit REPS=3)
 *
 * WHAT IT DRIVES — the real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium and WebKit, the real chat WebSockets and the real CLI run from INSIDE
 * each chat's spawned process with only the env the server gave it. The `claude` on PATH is a
 * scripted stand-in (no tokens spent) that reads its own briefing to know whether it is the
 * Super Agent or a child, records every user frame it receives (so the hand-over note can be
 * counted), and on cue runs `dreamcontext super …` / `dreamcontext window …`, asks an
 * AskUserQuestion, asks a tool permission, or commits in its own worktree.
 *
 * WHAT IT PROVES — the owner's flow: three live chats in two panes → hand over (all three
 * adopted, the note on each child's next message exactly once) → the super agent delegates two
 * children with worktrees and opens task / knowledge / web / image containers → a child's
 * question reaches the super agent only after the owner's 15 s lease → a permission jumps to the
 * queue pill and is answered there → refusals (the super cannot re-mode itself, a child cannot
 * reach a sibling) → reload while handed over → take back (the earlier panes, the delegated
 * children as tabs, still alive; the take-back note) → hand over again (same session, same
 * layout) → merge the two children (one clean, one conflicting) → a stage under 1040 px puts
 * every card in Others and side by side opens as a sheet.
 *
 * THE STAGE (plan-r8, owner decisions O1-O11): the centre centred in both axes with >= 24 px to
 * every card; every card one 160 px 1:1 tile on the ORBIT (each side's column on the midline, its
 * ends next to the centre, its middle standing out; the centre 56%: owner decision 2026-10-20); a
 * card dropped on another makes a group, the agent groups with `super group`, a group opens into
 * its panel, Escape closes the panel and not the screen, a card dragged out leaves its group,
 * Ungroup dissolves it, groups survive a reload; a task side by side shows its criteria; a card
 * dragged with the mouse lands where it
 * was dropped and stays there after a reload (and, at the very end, a server restart); dropped in
 * the bottom-right corner it joins Others; clicked there it is side by side; minimize floats it;
 * the agent's half / present / present --off; a card dropped on the centre (or "Ask about this")
 * puts one @card reference in the super composer and writes nothing; a working child's card and
 * the centre glow (opacity 1 within 0.8 s, a pixel crop outside the edge differs) and fade (0
 * within 1.6 s), the doing-line and the background chip; a push during a drag keeps the card
 * under the pointer.
 *
 * Then the MOTION in each engine: hand-over and take-back (worst rAF gap, median over REPS),
 * final rects vs the static layout, no running animation 100 ms after, no frame with an empty
 * stage, mid-flight reverse; a float → half → float switch by the owner, and agent verbs 150 ms
 * apart (half → present, present --off) with the centre and its composer at opacity 1 in every
 * frame and the draft, focus and caret kept; nothing moves for 500 ms after; a resize snaps;
 * reduced motion = crossfade; a filmstrip, a recording and screenshots at 1280, 1440 and 1920 in
 * light and dark (and 1800 x 1130, the owner's window) with the queue pill and the Others stack,
 * each checked for the orbit.
 *
 * Collect, don't fail fast: every check prints ✓/✗ and the run continues. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// One scratch vault per run: two sessions verifying at once must never wipe each other's.
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-agent-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CODE = join(SCRATCH, 'acme-code');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-agent');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const REPS = Number(process.env.REPS || 3);
const SKIP_FLOW = process.env.SKIP_FLOW === '1';
const SEED_TASKS = Number(process.env.SEED_TASKS ?? 300);

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const SLOW_EVENTS = ${JSON.stringify(join(SCRATCH, 'slow-events'))};
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const convo = at('--resume') || at('--session-id') || '';
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-super-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const verbRoute = (verb, body) => fetch(process.env.DREAMCONTEXT_WINDOW_URL + '/api/super/v/' + verb, {
  method: 'POST',
  headers: { 'x-dreamcontext-window-token': process.env.DREAMCONTEXT_WINDOW_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ args: 'super ' + verb, status: r.status, json: await r.json().catch(() => null), out: '' }), (e) => ({ args: 'super ' + verb, status: 0, json: null, out: String(e) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, convo, pid: process.pid, t: Date.now(), ...o }) + '\\n');
report({ kind: 'argv', argv });
function persist(text) {
  if (!/^[0-9a-f-]{36}$/.test(convo)) return;
  const dir = join(process.env.HOME, '.claude', 'projects', 'verify-super');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, convo + '.jsonl'), JSON.stringify({ type: 'user', sessionId: convo, message: { role: 'user', content: text } }) + '\\n');
}
// A frame folded into the running turn is stored the way claude 2.1.304 stores it (measured):
// a queued_command attachment, so the history replay is the real one.
function persistQueued(text) {
  if (!/^[0-9a-f-]{36}$/.test(convo)) return;
  const dir = join(process.env.HOME, '.claude', 'projects', 'verify-super');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, convo + '.jsonl'), JSON.stringify({ type: 'attachment', sessionId: convo, attachment: { type: 'queued_command', prompt: [{ type: 'text', text }] } }) + '\\n');
}
let inited = false;
let awaiting = null;
let seq = 0;
const ask = (request) => new Promise((resolve) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: request.tool_name, input: request.input }] } });
  out({ type: 'control_request', request_id: 'req-' + process.pid + '-' + seq, request: { subtype: 'can_use_tool', ...request, tool_use_id: id, requires_user_interaction: true } });
  awaiting = (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } }); resolve(r); };
});
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [cli('super', 'state')];
    const children = Object.keys(steps[0].json?.children ?? {});
    for (const c of children) steps.push(cli('super', 'send', c, 'NOTE-CHECK'));
    steps.push(cli('super', 'delegate', '--prompt', 'CHILD-D2 COMMIT a.txt=two', '--brief', 'Worktree two', '--worktree', 'acme-code', '--slug', 'd2'));
    steps.push(cli('super', 'delegate', '--prompt', 'CHILD-D3 COMMIT a.txt=three', '--brief', 'Worktree three', '--worktree', 'acme-code', '--slug', 'd3'));
    steps.push(cli('super', 'open', 'task', 'fix-the-login-form'));
    steps.push(cli('super', 'open', 'knowledge', 'login-notes'));
    steps.push(cli('super', 'open', 'web', 'https://example.com/'));
    steps.push(cli('super', 'open', 'image', 'docs/hero.png'));
    steps.push(cli('super', 'open', 'whiteboard', 'login-flow'));
    steps.push(cli('super', 'state'));
    report({ kind: 'handover', text: text.slice(0, 2000), children, steps });
    return 'arranged ' + children.length;
  }
  if (text.startsWith('[super event')) {
    // One slow event turn on cue, so the owner can write into it (plan r4 D4: steer, never held).
    if (existsSync(SLOW_EVENTS)) { rmSync(SLOW_EVENTS, { force: true }); report({ kind: 'slow-event-start', text: text.slice(0, 2000) }); await sleep(7000); }
    const q = cli('super', 'queue', 'list');
    const items = Array.isArray(q.json) ? q.json : (q.json?.items ?? q.json?.queue ?? []);
    const question = items.find((i) => i.kind === 'question' && i.state !== 'done' && i.state !== 'escalated' && text.includes(i.sessionId));
    const esc = question ? cli('super', 'queue', 'ask', question.id, 'The login button: which colour?') : null;
    report({ kind: 'event', text: text.slice(0, 2000), queue: q, escalated: esc });
    return 'handled';
  }
  if (text.startsWith('[super recap]')) { report({ kind: 'recap', text: text.slice(0, 1000) }); return 'recap'; }
  const m = text.match(/GO-(ASKOWNER|ASK|PERM|SIBLING|MERGE|REFUSE|HALF|PRESENTOFF|PRESENT|TWO|BUSYALL|BUSY|SLOW|LATEROPEN|CLOSE|GROUP|TURNS3)\\s*(\\S*)\\s*(\\S*)/);
  if (m) {
    const [, verb, a, b] = m;
    const steps = [];
    // The arranging verbs (plan-r8 F2). TWO: half, then present 150 ms later, both in flight at
    // once, so their pushes land 150 ms apart. LATER: wait first, so the owner can be mid-gesture.
    if (verb === 'HALF') steps.push(cli('super', 'half', a));
    if (verb === 'PRESENT') steps.push(cli('super', 'present', a, b));
    if (verb === 'PRESENTOFF') { if (a === 'later') await sleep(1200); steps.push(cli('super', 'present', '--off')); }
    if (verb === 'TWO') {
      await sleep(1200);
      // Straight to the route the CLI calls: two CLI processes 150 ms apart can start out of
      // order under load and write half AFTER present; two loopback requests cannot.
      const first = verbRoute('half', { container: a });
      await sleep(150);
      const second = verbRoute('present', { containers: [a, b] });
      steps.push(await first, await second);
    }
    if (verb === 'BUSY') steps.push(cli('super', 'send', a, 'BUSY'));
    // The live children, each ending three quick turns (rows, not turns: plan r4 AC1).
    const live = () => Object.entries(cli('super', 'state').json?.children ?? {}).filter(([, c]) => c && c.status !== 'gone' && c.status !== 'ended').map(([id]) => id);
    if (verb === 'TURNS3') { const ids = live().slice(0, 5); for (let r = 0; r < 3; r += 1) { for (const id of ids) steps.push(cli('super', 'send', id, 'QUICK')); await sleep(900); } report({ kind: 'turns3', ids }); }
    if (verb === 'BUSYALL') { const ids = live().slice(0, 6); for (const id of ids) steps.push(cli('super', 'send', id, 'LONGBUSY')); report({ kind: 'busyall', ids }); }
    if (verb === 'ASKOWNER') steps.push(cli('super', 'ask', 'Ship the login fix now?', '--options', 'Ship it|Wait'));
    if (verb === 'SLOW') await sleep(3000);
    if (verb === 'LATEROPEN') { await sleep(1500); steps.push(cli('super', 'open', 'web', 'https://example.org/later', '--title', 'Later')); }
    if (verb === 'CLOSE') steps.push(cli('super', 'close', a));
    if (verb === 'GROUP') steps.push(cli('super', 'group', a, b, '--name', 'Formlar'));
    if (verb === 'ASK') steps.push(cli('super', 'send', a, 'ASK-Q'));
    if (verb === 'PERM') steps.push(cli('super', 'send', a, 'ASK-PERM'));
    if (verb === 'SIBLING') steps.push(cli('super', 'send', a, 'TRY-SIBLING ' + b));
    if (verb === 'MERGE') steps.push(cli('super', 'merge', a, b, '--into', 'integ'), cli('super', 'worktree', 'list'));
    if (verb === 'REFUSE') steps.push(cli('window', 'mode', 'develop'), cli('window', 'new', '--prompt', 'sneak'), cli('super', 'answer', a, 'no-such-request', 'Blue'));
    report({ kind: 'owner-' + verb.toLowerCase(), steps });
    return 'did ' + verb;
  }
  return 'ok';
}
async function childTurn(text) {
  if (text.includes('GO-OPEN')) {
    const steps = [cli('window', 'new', '--prompt', 'hello B'), cli('window', 'new', '--split', '--prompt', 'hello C'), cli('window', 'new', '--terminal')];
    report({ kind: 'opened', steps });
    return 'opened';
  }
  if (text.includes('ASK-Q')) {
    const r = await ask({ tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour for the login button?', header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: 'brand' }, { label: 'Green', description: 'go' }] }] } });
    report({ kind: 'answered', response: r });
    return 'got answer';
  }
  if (text.includes('QUICK')) return 'quick';
  if (text.includes('LONGBUSY')) {
    // Twenty-five seconds of work with a tool in flight: the working ring's measurement window.
    const id = 'toolu_long_' + process.pid;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } });
    await new Promise((r) => setTimeout(r, 25000));
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'passed' }] }] } });
    report({ kind: 'longbusy-done' });
    return 'tested';
  }
  if (text.includes('BUSY')) {
    // Six seconds of work: a Bash call in flight (the card's doing-line) and a background shell
    // (its chip), then both end.
    const id = 'toolu_busy_' + process.pid;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm run build', description: 'Wait for the build' } }] } });
    out({ type: 'system', subtype: 'task_started', task_id: 'bg-' + process.pid, tool_use_id: id, description: 'npm run watch', task_type: 'local_bash' });
    await new Promise((r) => setTimeout(r, 6000));
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'built' }] }] } });
    out({ type: 'system', subtype: 'task_updated', task_id: 'bg-' + process.pid, patch: { status: 'completed', end_time: Date.now() } });
    report({ kind: 'busy-done' });
    return 'built';
  }
  if (text.includes('OPEN-TERM')) {
    report({ kind: 'opened-term', steps: [cli('window', 'new', '--terminal')] });
    return 'opened a terminal';
  }
  if (text.includes('PRE-PERM')) {
    const r = await ask({ tool_name: 'Bash', display_name: 'Bash', input: { command: 'echo pre-handover', description: 'print a line' } });
    report({ kind: 'pre-permission', response: r });
    return 'got permission';
  }
  if (text.includes('ASK-PERM')) {
    const r = await ask({ tool_name: 'Bash', display_name: 'Bash', input: { command: 'echo super-verify', description: 'print a line' } });
    report({ kind: 'permission', response: r });
    return 'got permission';
  }
  const sib = text.match(/TRY-SIBLING (\\S+)/);
  if (sib) { report({ kind: 'sibling', steps: [cli('window', 'send', sib[1], 'hi sibling'), cli('window', 'new', '--prompt', 'x')] }); return 'tried'; }
  const commit = text.match(/COMMIT (\\S+)=(\\S+)/);
  const wt = text.match(/worktree:?\\s+(\\/\\S+)/i);
  if (commit && wt) {
    const dir = wt[1].replace(/[.,;:)]+$/, '');
    writeFileSync(join(dir, commit[1]), commit[2] + '\\n');
    const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf-8' });
    g('add', commit[1]);
    const c = g('-c', 'user.email=v@example.com', '-c', 'user.name=verify', 'commit', '-qm', 'child ' + commit[2]);
    report({ kind: 'committed', dir, status: c.status, err: c.stderr });
    return 'committed';
  }
  return 'ok';
}
// The CLI folds a user frame that arrives while a turn runs INTO that turn (one result for all,
// agent-chat.ts's steer note) and opens every turn with a system:init: the stand-in does both.
let running = false;
let folded = [];
async function turn(blocks) {
  const text = blocks.join('');
  persist(blocks[0] ?? '');
  inited = true;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(text); } catch (e) { said = 'error ' + e; }
  const extra = folded.splice(0);
  if (extra.length) said += ' (+' + extra.length + ' folded: ' + extra.map((b) => (b[0] ?? '').slice(0, 40)).join(' | ') + ')';
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'result', first: (blocks[0] ?? '').slice(0, 80), folded: extra.length });
}
let buf = '';
let chain = Promise.resolve();
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_response') { if (awaiting) { const r = awaiting; awaiting = null; r(o.response && o.response.response); } continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    if (running) {
      folded.push(blocks);
      persistQueued(blocks[0] ?? '');
      appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, convo, pid: process.pid, t: Date.now(), blocks, folded: true }) + '\\n');
      continue;
    }
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, convo, pid: process.pid, t: Date.now(), blocks }) + '\\n');
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

// A 1×1 PNG, so the image container has a real picture to show.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'docs'), CODE, OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  writeFileSync(join(PROJ, 'docs', 'hero.png'), PNG);
  const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf-8' });
  git(PROJ, 'init', '-q');
  git(CODE, 'init', '-q', '-b', 'main');
  writeFileSync(join(CODE, 'a.txt'), 'one\n');
  git(CODE, 'add', 'a.txt');
  git(CODE, '-c', 'user.email=v@example.com', '-c', 'user.name=verify', 'commit', '-qm', 'base');
  git(CODE, 'remote', 'add', 'origin', 'https://github.com/acme/acme-code.git');
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [what, r] of [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' })],
    ['link add', dc('link', 'add', 'acme-code', CODE)],
    ['task', dc('tasks', 'create', 'Fix the login form', '-w', 'The login form loses its input on a slow network.')],
    ['whiteboard', dc('whiteboard', 'create', 'Login flow')],
    ['criteria', dc('tasks', 'insert', 'fix-the-login-form', 'acceptance_criteria', '--',
      '- [x] The form keeps its input on a slow network\n- [ ] The draft survives a reload\n- [ ] Unit tests for the draft store')],
  ]) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  // A board the size of a real project's behind the chat (the owner's has ~470 tasks): the
  // motion is measured with that page mounted, not an empty one. Synthetic, cloned from the
  // task above (written straight to disk: 300 CLI runs would take minutes).
  const stateDir = join(PROJ, '_dream_context', 'state');
  const taskSrc = readFileSync(join(stateDir, 'fix-the-login-form.md'), 'utf-8');
  const statuses = ['todo', 'in_progress', 'in_review', 'completed', 'todo'];
  for (let i = 0; i < SEED_TASKS; i += 1) {
    writeFileSync(join(stateDir, `synthetic-task-${i}.md`), taskSrc
      .replace(/^id: .*$/m, `id: task_synth${i}`)
      .replace(/^name: .*$/m, `name: Synthetic task ${i} with a title as long as a real one`)
      .replace(/^status: .*$/m, `status: ${statuses[i % statuses.length]}`));
  }
  mkdirSync(join(PROJ, '_dream_context', 'knowledge'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'knowledge', 'login-notes.md'),
    '---\nname: login-notes\ndescription: Notes on the login flow\ntags: []\n---\n\nThe login form posts to /session.\n');
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const frames = () => readNd(FRAMES);
const reports = () => readNd(REPORTS);
const NOTE_HANDOVER = '<super-agent-note> From now on the owner talks to you through the Super Agent; it relays your questions and answers. </super-agent-note>';
const NOTE_TAKEBACK = '<super-agent-note> The Super Agent mode is over; you talk directly with the owner again. </super-agent-note>';

const report = {
  pass: 0, fails: [], notes: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 700)}` : ''}`); }
    return !!cond;
  },
  note(msg) { this.notes.push(msg); console.log(`  · ${msg}`); },
};
/** The last check run: a console error names it, so a red 'no console errors' says WHERE. */
let LAST_CHECK = 'start';
const ok = (l, c, d) => { LAST_CHECK = l; return report.check(l, c, d); };

/** Open the project's Chat surface in a page. */
async function openChat(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    // The way the owner gets there: the sidebar's Chat entry.
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}

const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

/** The panes as the owner sees them: each pane's tab titles, left to right. */
const paneLayout = (page) => page.evaluate(() => [...document.querySelectorAll('[role="tablist"]')]
  .filter((p) => p.getBoundingClientRect().width > 0 && p.querySelector('.agent-tab-title'))
  .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
  .map((p) => [...p.querySelectorAll('.agent-tab-title')].map((t) => (t.textContent || '').trim())));

async function sayInVisibleComposer(page, text, which = 0, { typed = false } = {}) {
  const input = page.locator('.chat-cmp-input:visible').nth(which);
  await input.click();
  // Real keystrokes when the owner-activity lease is under test (fill() fires no key events).
  if (typed) await page.keyboard.type(text, { delay: 40 }); else await input.fill(text);
  await page.keyboard.press('Enter');
}
const surfaceShown = (page) => page.locator('[data-testid="super-surface"]:visible').count().then((n) => n > 0);

// ─── the stage (plan-r8) ────────────────────────────────────────────────────────────────

const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {}, view: { mode: 'float' } }; } };
/** The card the owner dragged in the flow: checked again after a server restart at the end. */
let DRAGGED = null;

/** The stage as drawn: the surface, the centre, every card frame, the Others count. */
const geo = (page) => page.evaluate(() => {
  const box = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  const s = document.querySelector('[data-testid="super-surface"]');
  const c = document.querySelector('.super-centre');
  return {
    s: s ? box(s) : null,
    c: c ? box(c) : null,
    cards: [...document.querySelectorAll('.super-card-frame')].map((e) => ({
      id: e.dataset.containerId || e.dataset.groupId, kind: e.dataset.kind || 'group', where: e.dataset.where, shape: e.dataset.shape,
      owner: e.dataset.owner === 'true', status: e.dataset.status, r: box(e),
    })),
    others: Number(document.querySelector('.super-others-count')?.textContent || 0),
  };
});
const cardIn = (g, id) => g.cards.find((c) => c.id === id);
/** The 2026-10-20 stage, read off the drawn one: every auto-placed card one 160 px 1:1 tile; each
 *  side's inner column one gap apart and centred on the midline, its ends one gap from the centre
 *  and its middle standing out (the orbit); the centre 56% of the stage, within its floor and
 *  ceiling. An owner-placed card and the columns it crosses are the owner's arrangement. */
function orbitOf(g) {
  const T = 160, GAP = 24, DEPTH = 112;
  const owned = g.cards.filter((c) => c.where === 'float' && c.owner).map((c) => c.r);
  const crosses = (r) => owned.some((o) => o.x < r.x + r.w && r.x < o.x + o.w && o.y < r.y + r.h && r.y < o.y + o.h);
  const autos = g.cards.filter((c) => c.where === 'float' && !c.owner).map((c) => c.r);
  const free = autos.filter((r) => !crosses(r));
  const oneSize = autos.every((r) => Math.abs(r.w - T) <= 1 && Math.abs(r.h - T) <= 1);
  const mid = g.c.y + g.c.h / 2;
  const sides = [['L', g.c.x - GAP - T], ['R', g.c.x + g.c.w + GAP]].map(([side, inner]) => {
    const col = free.filter((r) => (side === 'L' ? r.x < g.c.x : r.x > g.c.x) && Math.abs(r.x - inner) <= DEPTH + 1).sort((a, b) => a.y - b.y);
    if (col.length < 2 || owned.length) return { side, n: col.length, ok: true };
    const out = (r) => (side === 'L' ? inner - r.x : r.x - inner);
    const oneGap = col.every((r, i) => i === 0 || Math.abs(r.y - (col[i - 1].y + col[i - 1].h) - GAP) <= 1);
    const centred = Math.abs((col[0].y + col[col.length - 1].y + col[col.length - 1].h) / 2 - mid) <= 1;
    const ends = [col[0], col[col.length - 1]].every((r) => Math.abs(out(r)) <= 1);
    const middle = col.length < 3 || out(col[Math.floor(col.length / 2)]) > 1;
    return { side, n: col.length, ok: oneGap && centred && ends && middle, oneGap, centred, ends, middle };
  });
  const want = Math.min(1120, Math.max(560, 0.56 * g.s.w));
  const centreOk = Math.abs(g.c.w - want) <= 1;
  return { ok: autos.length > 0 && oneSize && sides.every((x) => x.ok) && centreOk, detail: { oneSize, sides, centre: Math.round(g.c.w), want: Math.round(want), owned: owned.length } };
}
/** Two rects at least `gap` apart on some axis. */
const apart = (a, b, gap = 23.5) => a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;
const near1 = (a, b, tol = 1) => !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
/** Where the owner grabs a card: its middle, below the hover buttons. */
const grabPoint = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h * 0.62 });

/** A real mouse drag: press, move in steps, (optionally look while held), release. */
async function drag(page, from, to, { steps = 14, hold } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(16);
  }
  if (hold) await hold();
  await page.mouse.up();
}

const superComposer = (page) => page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
const valueOf = (loc) => loc.inputValue().catch(() => loc.innerText());
/** The owner talks to the Super Agent: its own composer in the centre. */
async function sayToSuper(page, text) {
  const input = superComposer(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

/**
 * Time a glow layer: wait for the element's `data-status` to become `status`, then count the ms
 * until the pseudo-element's computed opacity reaches the target (1: >= 0.99, 0: <= 0.01),
 * sampled every frame. Started BEFORE the action that flips the status.
 */
const glowTiming = (page, sel, pseudo, status, target) => page.evaluate(([sel, pseudo, status, target]) => new Promise((resolve) => {
  const el = document.querySelector(sel);
  if (!el) { resolve({ ms: null, error: 'no element' }); return; }
  const start = (late) => {
    const t0 = performance.now();
    const tick = () => {
      const o = Number(getComputedStyle(el, pseudo).opacity);
      if (target === 1 ? o >= 0.99 : o <= 0.01) { resolve({ ms: Math.round(performance.now() - t0), o, late }); return; }
      if (performance.now() - t0 > 5000) { resolve({ ms: null, o, late }); return; }
      requestAnimationFrame(tick);
    };
    tick();
  };
  if (el.dataset.status === status) { start(true); return; }
  const mo = new MutationObserver(() => { if (el.dataset.status === status) { mo.disconnect(); start(false); } });
  mo.observe(el, { attributes: true, attributeFilter: ['data-status'] });
  setTimeout(() => { mo.disconnect(); resolve({ ms: null, timeout: true }); }, 40000);
}), [sel, pseudo, status, target]);

async function stage(page, base, adopted = []) {
  console.log('\n── the stage: centred, shapes, gaps (O1, O2)');
  await page.waitForTimeout(1200);
  let g = await geo(page);
  const rec0 = record();
  const floats = g.cards.filter((c) => c.where === 'float');
  ok('the centre is centred in both axes (<= 1 px)', !!g.s && !!g.c
    && Math.abs((g.c.x - g.s.x) - (g.s.x + g.s.w - g.c.x - g.c.w)) <= 1 && Math.abs((g.c.y - g.s.y) - (g.s.y + g.s.h - g.c.y - g.c.h)) <= 1, JSON.stringify({ s: g.s, c: g.c }));
  ok('>= 24 px between the centre and every floating card', floats.every((c) => apart(c.r, g.c)), JSON.stringify(floats.map((c) => c.r)));
  const autos = floats.filter((c) => !c.owner);
  ok('>= 24 px between auto-placed cards', autos.every((a, i) => autos.every((b, j) => j <= i || apart(a.r, b.r))), JSON.stringify(autos.map((c) => c.r)));
  ok('each floating card is one 160 px 1:1 tile (2026-10-20)', floats.every((c) => Math.abs(c.r.w - 160) <= 1 && Math.abs(c.r.h - 160) <= 1), JSON.stringify(floats.map((c) => [c.kind, c.r.w, c.r.h])));
  const rh = orbitOf(g);
  ok('the orbit: each side\'s column on the midline, its ends next to the centre, its middle out; the centre 56%', rh.ok, JSON.stringify(rh.detail));
  ok('the orbit is drawn: a faint arc through each side\'s column', (await page.locator('.super-orbit polyline').count()) >= 1);
  const prog = await page.locator('[data-testid="super-tile-progress"]').first().innerText().catch(() => '');
  ok('the task tile says how far its criteria are (owner 2026-10-20: a small card still shows what is in it)', /1\s*\/\s*3/.test(prog), prog);
  ok('the record: chat and web cards tall, the rest square', rec0.containers.length > 0 && rec0.containers.every((c) => c.shape === (c.kind === 'chat' || c.kind === 'web' ? 'tall' : 'square')), JSON.stringify(rec0.containers.map((c) => [c.kind, c.shape])));
  ok('>= 4 cards float around the centre', floats.length >= 4, `${floats.length} floating, ${g.others} in Others`);
  ok('a card the stage cannot fit is drawn in Others, its record still float', g.others === rec0.containers.length - g.cards.length && rec0.containers.every((c) => c.place === 'float'), JSON.stringify({ drawn: g.cards.length, others: g.others, record: rec0.containers.map((c) => c.place) }));
  report.note(`stage ${Math.round(g.s?.w)}x${Math.round(g.s?.h)}: centre ${Math.round(g.c?.w)} px, ${floats.length} floating, ${g.others} in Others`);
  await page.screenshot({ path: join(OUT, 'stage-01-floating.png') });

  console.log('\n── the owner drags a card and drops it (O3)');
  const A = floats.find((c) => c.kind === 'chat');
  const top = g.s.y + 24 + 40;
  const dy = A.r.y - top > 90 ? -60 : 60;
  const fromA = grabPoint(A.r);
  await drag(page, fromA, { x: fromA.x, y: fromA.y + dy });
  await page.waitForTimeout(900);
  g = await geo(page);
  const dropped = { ...A.r, y: A.r.y + dy };
  ok('the card lands where it was dropped (<= 1 px)', near1(cardIn(g, A.id)?.r, dropped), JSON.stringify({ got: cardIn(g, A.id)?.r, want: dropped }));
  ok('…as an owner-placed card, its position written to the record', cardIn(g, A.id)?.owner && !!record().containers.find((c) => c.id === A.id)?.pos, JSON.stringify(record().containers.find((c) => c.id === A.id)));
  DRAGGED = A.id;
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await until(page, () => surfaceShown(page), 12000))) await openChat(page, base);
  await until(page, async () => (await geo(page)).cards.length > 0, 15000);
  await page.waitForTimeout(1500);
  g = await geo(page);
  ok('…and it stays there after a reload (<= 1 px)', near1(cardIn(g, A.id)?.r, dropped), JSON.stringify({ got: cardIn(g, A.id)?.r, want: dropped }));

  console.log('\n── dropped in the bottom-right corner it joins Others (O4)');
  const B = g.cards.find((c) => c.where === 'float' && c.kind === 'chat' && c.id !== A.id);
  let lit = 0;
  await drag(page, grabPoint(B.r), { x: g.s.x + g.s.w - 30, y: g.s.y + g.s.h - 30 }, { hold: async () => { lit = await page.locator('[data-testid="super-others-zone"][data-lit]').count(); } });
  ok('the corner lights while the card is over it', lit === 1, `lit=${lit}`);
  await page.waitForTimeout(900);
  g = await geo(page);
  ok('the card left the stage for the Others stack', !cardIn(g, B.id) && g.others >= 1, JSON.stringify({ onStage: !!cardIn(g, B.id), others: g.others }));
  ok('…written as place: others', record().containers.find((c) => c.id === B.id)?.place === 'others');
  await page.getByTestId('super-others-stack').click();
  ok('the Others stack opens its panel with it', await until(page, async () => (await page.locator(`[data-testid="super-others-item"][data-container-id="${B.id}"]`).count()) === 1, 3000));
  await page.screenshot({ path: join(OUT, 'stage-02-others-fan.png') });
  await page.locator(`[data-testid="super-others-item"][data-container-id="${B.id}"]`).click();
  await page.waitForTimeout(900);
  g = await geo(page);
  ok('clicking it in Others shows it side by side (half page)', cardIn(g, B.id)?.where === 'half' && g.c.x + g.c.w <= cardIn(g, B.id).r.x, JSON.stringify({ card: cardIn(g, B.id), centre: g.c }));
  ok('…every other card is in Others', g.cards.every((c) => c.id === B.id), JSON.stringify(g.cards.map((c) => [c.id, c.where])));
  ok('…its chat is mounted, read-only, in the shown slot', await until(page, async () => (await page.locator(`.super-card-frame[data-container-id="${B.id}"] [data-super-slot="shown"] .chat-scroll`).count()) === 1, 5000));
  ok('at most one child chat is shown besides the centre', (await page.locator('[data-testid="super-surface"] .chat-scroll:visible').count()) <= 2);
  await page.screenshot({ path: join(OUT, 'stage-03-half.png') });
  await page.locator(`.super-card-frame[data-container-id="${B.id}"]`).getByTestId('super-card-minimize').click();
  await page.waitForTimeout(900);
  g = await geo(page);
  ok('minimize returns it to floating', cardIn(g, B.id)?.where === 'float' && record().view.mode === 'float', JSON.stringify({ card: cardIn(g, B.id), view: record().view }));

  console.log('\n── the agent arranges: half, present, present --off (O5, O7, O8)');
  const taskId = record().containers.find((c) => c.kind === 'task')?.id;
  const knowId = record().containers.find((c) => c.kind === 'knowledge')?.id;
  await sayToSuper(page, `GO-HALF ${taskId}`);
  ok('super half: the task card is the right half', await until(page, async () => cardIn(await geo(page), taskId)?.where === 'half', 30000));
  ok('…side by side the task shows its page: its criteria under its status head (owner 2026-10-20)', await until(page, async () =>
    /Acceptance Criteria/.test(await page.locator(`.super-card-frame[data-container-id="${taskId}"] .super-card-view--page`).innerText().catch(() => ''))
    && (await page.locator(`.super-card-frame[data-container-id="${taskId}"] [data-testid="super-task-head"]`).count()) === 1, 15000));
  await page.screenshot({ path: join(OUT, 'stage-03b-task-half.png') });
  await sayToSuper(page, `GO-PRESENT ${taskId} ${knowId}`);
  ok('super present: the agent left, the two cards right', await until(page, async () => {
    const x = await geo(page);
    const a = cardIn(x, taskId);
    const b = cardIn(x, knowId);
    return a?.where === 'present' && b?.where === 'present' && x.c.x + x.c.w <= Math.min(a.r.x, b.r.x);
  }, 30000), JSON.stringify((await geo(page)).cards.map((c) => [c.kind, c.where])));
  await page.waitForTimeout(900);
  g = await geo(page);
  ok('…the centre is a left column of at most 560 px', g.c.w <= 561 && g.c.x - g.s.x <= 25, JSON.stringify(g.c));
  await page.screenshot({ path: join(OUT, 'stage-04-present.png') });
  await sayToSuper(page, 'GO-PRESENTOFF');
  ok('super present --off: the cards float again', await until(page, async () => (await geo(page)).cards.every((c) => c.where === 'float') && record().view.mode === 'float', 30000));
  await page.waitForTimeout(1000);

  console.log('\n── a card dropped on the centre asks about it (O11)');
  g = await geo(page);
  const D = g.cards.find((c) => c.where === 'float' && c.kind === 'chat');
  const recBefore = JSON.stringify(record().containers);
  const composer = superComposer(page);
  await composer.fill('');
  let target = 0;
  await drag(page, grabPoint(D.r), { x: g.c.x + g.c.w / 2, y: g.c.y + g.c.h / 2 }, { hold: async () => { target = await page.getByTestId('super-ask-target').count(); } });
  ok('"Ask about this" shows on the centre while the card is over it', target === 1, `target=${target}`);
  await page.waitForTimeout(900);
  const draft1 = await valueOf(composer);
  const refs = (text, id) => (text.match(new RegExp(`@card:${id} “`, 'g')) ?? []).length;
  ok('one @card reference lands in the super composer', refs(draft1, D.id) === 1, draft1);
  ok('…the super composer has focus', await page.evaluate(() => !!document.activeElement?.closest('[data-super-slot="centre"]')));
  let g2 = await geo(page);
  ok('…the card is back where it was (<= 1 px)', near1(cardIn(g2, D.id)?.r, D.r), JSON.stringify({ got: cardIn(g2, D.id)?.r, want: D.r }));
  ok('…and nothing was written to the record', JSON.stringify(record().containers) === recBefore);
  const E = g2.cards.find((c) => c.where === 'float' && c.id !== D.id);
  const eFrame = page.locator(`.super-card-frame[data-container-id="${E.id}"]`);
  await eFrame.hover();
  await eFrame.getByTestId('super-card-ask').click();
  await page.waitForTimeout(300);
  const draft2 = await valueOf(composer);
  ok('the card\'s "Ask about this" button adds one reference of its own', refs(draft2, E.id) === 1 && refs(draft2, D.id) === 1, draft2);
  await composer.fill('');

  console.log('\n── a working child glows; its card says what it is doing (O1, O10)');
  g = await geo(page);
  // A child the later sections leave alone (the lease test asks the first adopted one).
  const refOf = (id) => record().containers.find((c) => c.id === id)?.ref;
  const chatCards = g.cards.filter((c) => c.where === 'float' && c.kind === 'chat');
  const W = chatCards.find((c) => !adopted.includes(refOf(c.id))) ?? chatCards[chatCards.length - 1];
  const wRef = record().containers.find((c) => c.id === W.id)?.ref;
  const wSel = `.super-card-frame[data-container-id="${W.id}"]`;
  const riseP = glowTiming(page, wSel, '::before', 'working', 1);
  await sayToSuper(page, `GO-BUSY ${wRef}`);
  const rise = await riseP;
  ok('the working card\'s glow rises to opacity 1 within 0.8 s', rise.ms !== null && rise.ms <= 800 && !rise.late, JSON.stringify(rise));
  // The crop while it surely works: the child's work lasts 6 s and the checks below take a while.
  const wr = cardIn(await geo(page), W.id).r;
  const clip = { x: Math.round(wr.x - 14), y: Math.round(wr.y + wr.h / 3), width: 10, height: 40 };
  const workingShot = await page.screenshot({ clip });
  ok('its doing-line names the tool in flight', /Wait for the build/.test(await page.locator(`${wSel} [data-testid="super-card-doing"]`).innerText().catch(() => '')),
    await page.locator(`${wSel} [data-testid="super-card-doing"]`).innerText().catch(() => 'none'));
  ok('a background chip shows the shell it runs', await until(page, async () => /1 shell/.test(await page.locator(`${wSel} [data-testid="super-card-bg"]`).getAttribute('aria-label').catch(() => '') ?? ''), 3000),
    await page.locator(`${wSel} .super-card-meta`).innerText().catch(() => 'none'));
  await page.screenshot({ path: join(OUT, 'stage-05-working-glow.png') });
  const fall = await glowTiming(page, wSel, '::before', 'idle', 0);
  ok('when it goes idle the glow fades to 0 within 1.6 s', fall.ms !== null && fall.ms <= 1600, JSON.stringify(fall));
  await page.waitForTimeout(300);
  const idleShot = await page.screenshot({ clip });
  ok('a crop just outside the card\'s edge differs working vs idle (the glow is painted)', !workingShot.equals(idleShot));
  const cRiseP = glowTiming(page, '.super-centre', '::before', 'working', 1);
  await sayToSuper(page, 'GO-SLOW');
  const cRise = await cRiseP;
  ok('the centre glows while Claude works (opacity 1 within 0.8 s)', cRise.ms !== null && cRise.ms <= 800, JSON.stringify(cRise));
  const cFall = await glowTiming(page, '.super-centre', '::before', 'idle', 0);
  ok('…and fades when it is idle (0 within 1.6 s)', cFall.ms !== null && cFall.ms <= 1600, JSON.stringify(cFall));

  console.log('\n── a push during a drag keeps the card under the pointer (D1)');
  await page.waitForTimeout(1000);
  g = await geo(page);
  const P = g.cards.find((c) => c.where === 'float' && c.kind === 'chat' && c.id !== A.id) ?? g.cards.find((c) => c.where === 'float');
  const countBefore = record().containers.length;
  await sayToSuper(page, 'GO-LATEROPEN');
  const fromP = grabPoint(P.r);
  await page.mouse.move(fromP.x, fromP.y);
  await page.mouse.down();
  const offs = [];
  let landedAt = -1;
  for (let i = 0; i < 80; i += 1) {
    const x = fromP.x + 12 + (i % 8);
    const y = fromP.y + 12;
    await page.mouse.move(x, y);
    await page.waitForTimeout(50);
    const r = await page.locator(`.super-card-frame[data-container-id="${P.id}"]`).evaluate((e) => { const b = e.getBoundingClientRect(); return [b.left, b.top]; }).catch(() => null);
    if (r) offs.push([r[0] - x, r[1] - y]);
    if (landedAt < 0 && record().containers.length > countBefore) landedAt = i;
  }
  await page.mouse.up();
  const spread = (k) => (offs.length ? Math.max(...offs.map((o) => o[k])) - Math.min(...offs.map((o) => o[k])) : Infinity);
  ok('the agent\'s card landed while the owner was dragging', landedAt >= 0 && landedAt < 70, `landed at sample ${landedAt}`);
  ok('…and the dragged card stayed under the pointer (<= 1 px)', offs.length >= 70 && spread(0) <= 1 && spread(1) <= 1, `spread x=${spread(0)} y=${spread(1)} over ${offs.length}`);
  await page.waitForTimeout(900);
  ok('the agent\'s card survived the owner\'s drop, and the drop was saved', record().containers.length === countBefore + 1 && !!record().containers.find((c) => c.id === P.id)?.pos,
    JSON.stringify(record().containers.map((c) => [c.id, c.kind, !!c.pos])));
  const later = record().containers.find((c) => c.ref === 'https://example.org/later');
  if (later) {
    await sayToSuper(page, `GO-CLOSE ${later.id}`);
    await until(page, async () => !record().containers.some((c) => c.id === later.id), 20000);
  }
  await page.waitForTimeout(1000);

  console.log('\n── groups (owner decision 2026-10-20): the agent groups, the owner drops a card on another');
  // A clean stage: the owner's drops from the sections above would otherwise sit where a new
  // group stands and push it to Others (the stage's rule for a covered card with no free spot).
  // They are put back at the end of this section (the server-restart check reads one of them).
  const dropsBefore = record().containers.filter((c) => c.pos).map((c) => ({ id: c.id, pos: c.pos }));
  await page.evaluate(async (ids) => fetch('/api/super/layout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'acme-app' }, body: JSON.stringify({ cards: ids.map((id) => ({ id, pos: null })) }),
  }), dropsBefore.map((d) => d.id));
  await page.waitForTimeout(1000);
  const chatsNow = record().containers.filter((c) => c.kind === 'chat' && c.place === 'float' && !c.pos).slice(0, 2);
  const [ga, gb] = chatsNow;
  await sayToSuper(page, `GO-GROUP ${ga.id} ${gb.id}`);
  ok('super group: two chats become ONE tile on the stage', await until(page, async () => {
    const x = await geo(page);
    return x.cards.filter((c) => c.kind === 'group').length === 1 && !x.cards.some((c) => c.id === ga.id || c.id === gb.id);
  }, 30000), JSON.stringify((await geo(page)).cards.map((c) => [c.id, c.kind, c.where])));
  const agentGroup = (record().groups ?? [])[0];
  ok('…recorded as a group named Formlar holding both', agentGroup?.name === 'Formlar' && JSON.stringify(agentGroup?.cards) === JSON.stringify([ga.id, gb.id]), JSON.stringify(record().groups));
  await page.locator(`[data-group-id="${agentGroup?.id}"]`).click();
  ok('clicking the group opens its panel with both cards', await until(page, async () => (await page.locator('[data-testid="super-group-panel"] [data-testid="super-group-item"]').count()) === 2, 4000));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'stage-06-group-open.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  ok('Escape closes the panel and never the hand-over screen', (await page.getByTestId('super-group-panel').count()) === 0 && await surfaceShown(page)
    && (await page.locator('.agent-surface.expanded').count()) > 0);
  g = await geo(page);
  const singles = g.cards.filter((c) => c.where === 'float' && c.kind !== 'group' && !c.owner && c.id);
  const [X, Y] = singles;
  let label = 0;
  let ring = 0;
  await drag(page, grabPoint(X.r), { x: Y.r.x + Y.r.w / 2, y: Y.r.y + Y.r.h / 2 }, { hold: async () => {
    label = await page.getByTestId('super-drop-label').count();
    ring = await page.locator(`.super-card-frame[data-container-id="${Y.id}"][data-drop-target]`).count();
  } });
  ok('a card held over another lights it and says "Release to group"', label === 1 && ring === 1, JSON.stringify({ label, ring }));
  ok('…released, the two are one group standing where the target stood', await until(page, async () => (record().groups ?? []).some((x) => JSON.stringify(x.cards) === JSON.stringify([Y.id, X.id])), 6000), JSON.stringify(record().groups));
  const ownGroup = (record().groups ?? []).find((x) => x.cards[0] === Y.id);
  await page.waitForTimeout(900);
  g = await geo(page);
  ok('…drawn as one tile; its cards are not on the stage', !!cardIn(g, ownGroup?.id) && !cardIn(g, X.id) && !cardIn(g, Y.id), JSON.stringify(g.cards.map((c) => [c.id, c.kind])));
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await until(page, () => surfaceShown(page), 12000))) await openChat(page, base);
  ok('after a reload both groups are still on the stage', await until(page, async () => (await geo(page)).cards.filter((c) => c.kind === 'group').length === 2, 15000));
  await page.waitForTimeout(1200);
  await page.locator(`[data-group-id="${ownGroup?.id}"]`).click();
  await until(page, async () => (await page.locator('[data-testid="super-group-item"]').count()) === 2, 4000);
  const item = await page.locator(`[data-testid="super-group-item"][data-container-id="${X.id}"]`).boundingBox();
  g = await geo(page);
  const outTo = { x: g.s.x + 110, y: g.s.y + 150 };
  if (item) await drag(page, { x: item.x + item.width / 2, y: item.y + item.height / 2 }, outTo);
  ok('dragged out of its group, a card floats where it was dropped and leaves the group (a group of one dissolves)', await until(page, async () =>
    !(record().groups ?? []).some((x) => x.id === ownGroup?.id) && !!record().containers.find((c) => c.id === X.id)?.pos, 6000), JSON.stringify({ groups: record().groups, x: record().containers.find((c) => c.id === X.id) }));
  await page.waitForTimeout(900);
  g = await geo(page);
  ok('…both cards are tiles on the stage again', cardIn(g, X.id)?.where === 'float' && cardIn(g, Y.id)?.where === 'float', JSON.stringify(g.cards.map((c) => [c.id, c.where])));
  await page.locator(`[data-group-id="${agentGroup?.id}"]`).click();
  await until(page, async () => (await page.getByTestId('super-group-panel-ungroup').count()) === 1, 4000);
  await page.getByTestId('super-group-panel-ungroup').click();
  ok('Ungroup dissolves the group: its cards float again', await until(page, async () => (record().groups ?? []).length === 0 && !!cardIn(await geo(page), ga.id) && !!cardIn(await geo(page), gb.id), 6000), JSON.stringify(record().groups));
  // Back to the stage as the sections above left it: this section's drop cleared, theirs put back.
  await page.evaluate(async (cards) => fetch('/api/super/layout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'acme-app' }, body: JSON.stringify({ cards }),
  }), [{ id: X.id, pos: null }, ...dropsBefore.map((d) => ({ id: d.id, pos: d.pos }))]);
  await page.waitForTimeout(1000);
}

// ─── the owner's flow (Chromium) ────────────────────────────────────────────────────────

async function flow(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video-flow'), size: { width: 1600, height: 1000 } } });
  const page = await context.newPage();
  const consoleLog = createWriteStream(join(OUT, 'console-flow.log'));
  const errors = [];
  page.on('console', (m) => { consoleLog.write(`[${m.type()}] ${m.text()}\n`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── three live chats in two panes');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sayInVisibleComposer(page, 'GO-OPEN');
  ok('its agent opened two more chats (window new, one --split)', await until(page, async () => reports().some((r) => r.kind === 'opened'), 40000));
  ok('two panes on screen', await until(page, async () => (await page.locator('.agent-pane:visible').count()) === 2, 20000));
  await until(page, async () => frames().filter((f) => f.role === 'child').length >= 3, 30000);
  await page.waitForTimeout(1500);
  const before = await paneLayout(page);
  report.note(`panes before: ${JSON.stringify(before)}`);
  ok('the button reads "Hand over to the Super Agent" (or the Turkish label)', await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0));
  await page.screenshot({ path: join(OUT, 'flow-01-before.png') });
  const mountedBefore = await page.locator('.chat-scroll').count();

  console.log('\n── hand over');
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, () => surfaceShown(page)));
  await until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 5000);
  ok('three chat containers', await until(page, async () => (await page.locator('[data-testid="super-container"][data-kind="chat"]').count()) >= 3, 15000),
    `chat containers=${await page.locator('[data-testid="super-container"][data-kind="chat"]').count()}`);
  ok('the terminal tab sits in the Terminals row, not adopted', await until(page, async () => (await page.locator('[data-testid="super-terminals-row"]:visible').count()) > 0, 8000)
    && (await page.locator('[data-testid="super-container"][data-kind="chat"]').count()) === 3,
    `terminals row=${await page.locator('[data-testid="super-terminals-row"]:visible').count()} chat containers=${await page.locator('[data-testid="super-container"][data-kind="chat"]').count()}`);
  ok('the empty-stage hint is hidden while cards exist', (await page.locator('[data-testid="super-empty-hint"]:visible').count()) === 0);
  ok('the super agent got one [super handover] turn', await until(page, async () => frames().filter((f) => f.role === 'super' && f.blocks[0]?.startsWith('[super handover]')).length === 1, 60000));
  ok('…and arranged the screen', await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));
  const ho = reports().find((r) => r.kind === 'handover');
  const adopted = ho?.children ?? [];
  ok('all three chats adopted', adopted.length === 3, JSON.stringify(ho?.steps?.[0]?.json ?? ho));
  const step = (args) => ho?.steps?.find((s) => s.args.startsWith(args));
  for (const s of ho?.steps ?? []) if (s.status !== 0) report.note(`step "${s.args}" exit ${s.status}: ${s.out.slice(0, 300)}`);
  ok('super delegate (worktree d2) answered a session id', typeof step('super delegate --prompt CHILD-D2')?.json?.sessionId === 'string', step('super delegate --prompt CHILD-D2')?.out);
  ok('super delegate (worktree d3) answered a session id', typeof step('super delegate --prompt CHILD-D3')?.json?.sessionId === 'string', step('super delegate --prompt CHILD-D3')?.out);
  ok('the worktree and super/d2 branch exist', existsSync(join(HOME, '.claude-worktrees')) && spawnSync('git', ['-C', CODE, 'branch', '--list', 'super/d2'], { encoding: 'utf-8' }).stdout.includes('super/d2'));
  for (const [k, args] of [['task', 'super open task'], ['knowledge', 'super open knowledge'], ['web', 'super open web'], ['image', 'super open image'], ['whiteboard', 'super open whiteboard']]) {
    ok(`super open ${k} succeeded`, step(args)?.status === 0, step(args)?.out);
  }

  console.log('\n── the hand-over note rides each child\'s next message, exactly once');
  await until(page, async () => adopted.every((c) => frames().some((f) => f.role === 'child' && f.blocks[0] === 'NOTE-CHECK' && f.convo)), 30000);
  const noteCheck = frames().filter((f) => f.role === 'child' && f.blocks[0] === 'NOTE-CHECK');
  ok('three NOTE-CHECK messages arrived', noteCheck.length === 3, JSON.stringify(noteCheck));
  ok('each carries the note as a second <-block, the first block untouched', noteCheck.every((f) => f.blocks.length === 2 && f.blocks[1] === NOTE_HANDOVER), JSON.stringify(noteCheck.map((f) => f.blocks)));
  const noteFrames = frames().filter((f) => f.role === 'child' && f.blocks.includes(NOTE_HANDOVER));
  ok('no chat received it twice', noteFrames.length === 3);

  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'flow-02-handed-over.png') });
  const kinds = record().containers.map((c) => c.kind);
  report.note(`cards: ${JSON.stringify(kinds)} (drawn: ${JSON.stringify(await page.locator('[data-testid="super-container"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind'))))})`);
  for (const k of ['task', 'knowledge', 'web', 'image', 'whiteboard']) ok(`a ${k} card is on the stage or in Others`, kinds.includes(k), JSON.stringify(kinds));

  const delegated = ['super delegate --prompt CHILD-D2', 'super delegate --prompt CHILD-D3'].map((a) => step(a)?.json?.sessionId).filter(Boolean);
  // AC12 (as the end review read it): the hand-over mounts no extra chat pane — only the centre
  // (the Super Agent) and one per delegated child are new; at most one child chat is shown.
  const mountedAfter = await page.locator('.chat-scroll').count();
  const shownChildren = await page.locator('.chat-scroll:visible').count() - 1;
  ok('the hand-over mounts no extra chat pane (centre + delegated only)', mountedAfter <= mountedBefore + 1 + delegated.length,
    `before=${mountedBefore} after=${mountedAfter} delegated=${delegated.length}`);
  ok('at most one child chat is shown besides the centre', shownChildren <= 1, `shown children=${shownChildren}`);
  await stage(page, base, adopted);
  const containerIds = () => page.locator('[data-testid="super-container"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-container-id')));
  const idsHanded = await containerIds();
  const superConvo = frames().find((f) => f.role === 'super')?.convo;
  const [childA, childB, childC] = adopted;

  console.log('\n── a child\'s question waits for the owner\'s 15 s lease, then reaches the super agent');
  await sayInVisibleComposer(page, `GO-ASK ${childA}`, 0, { typed: true });
  const typedAt = Date.now();
  ok('the child asked', await until(page, async () => frames().some((f) => f.role === 'child' && f.blocks[0] === 'ASK-Q'), 30000));
  const askCard = record().containers.find((c) => c.kind === 'chat' && c.ref === childA);
  const askSel = askCard ? `.super-card-frame[data-container-id="${askCard.id}"]` : '';
  if (askCard && (await page.locator(askSel).count())) {
    ok('an asking child\'s card glows in the waiting colour', await until(page, async () => (await page.locator(askSel).getAttribute('data-status')) === 'asking'
      && Number(await page.locator(askSel).evaluate((e) => getComputedStyle(e, '::after').opacity)) >= 0.99, 5000));
  } else {
    ok('an asking child in Others is marked asking on the stack', await until(page, async () => (await page.locator('[data-testid="super-others-stack"][data-asking]').count()) === 1, 5000));
  }
  const isQuestionEvent = (f) => f.role === 'super' && !f.folded && /^\[super events?\]/.test(f.blocks[0] ?? '') && /which colour/i.test(f.blocks[0]);
  ok('the question reached the super agent as one [super events] turn', await until(page, async () => frames().filter(isQuestionEvent).length === 1, 60000));
  const ev = frames().find(isQuestionEvent);
  ok('…no sooner than the 15 s lease after the owner typed', ev && ev.t - typedAt >= 15000, ev ? `${ev.t - typedAt} ms` : 'none');
  ok('…with the child\'s text fenced', /untrusted-project-output/.test(ev?.blocks[0] ?? ''), ev?.blocks[0]?.slice(0, 400));
  ok('the super agent escalated it (queue ask)', await until(page, async () => reports().some((r) => r.kind === 'event' && r.escalated?.status === 0), 30000), JSON.stringify(reports().filter((r) => r.kind === 'event')).slice(0, 600));
  ok('the queue strip shows it at its head', await until(page, async () => /which colour/i.test(await page.getByTestId('super-queue-head').innerText()), 15000));
  await page.screenshot({ path: join(OUT, 'flow-03-escalated.png') });
  const blue = page.getByTestId('super-queue-head').getByRole('button', { name: /^Blue/ });
  if (await blue.count()) await blue.first().click();
  ok('the owner\'s pick in the strip answered the child', await until(page, async () => reports().some((r) => r.kind === 'answered' && JSON.stringify(r.response).includes('Blue')), 20000), JSON.stringify(reports().filter((r) => r.kind === 'answered')));

  console.log('\n── a permission jumps to the queue head and is never shown to the agent');
  const superTurnsBefore = frames().filter((f) => f.role === 'super').length;
  await sayInVisibleComposer(page, `GO-PERM ${childB}`);
  ok('the child asked for a tool permission', await until(page, async () => frames().some((f) => f.role === 'child' && f.blocks[0] === 'ASK-PERM'), 30000));
  ok('Allow/Deny show at the queue head at once', await until(page, async () => (await page.getByTestId('super-queue-allow').count()) > 0, 8000));
  ok('the strip names the child\'s own tool', /Bash|echo super-verify/.test(await page.getByTestId('super-queue-head').innerText().catch(() => '')));
  await page.screenshot({ path: join(OUT, 'flow-04-permission.png') });
  await page.getByTestId('super-queue-allow').first().click();
  ok('Allow answered the child', await until(page, async () => reports().some((r) => r.kind === 'permission' && /allow/i.test(JSON.stringify(r.response))), 20000), JSON.stringify(reports().filter((r) => r.kind === 'permission')));
  await page.waitForTimeout(3000);
  const permToSuper = frames().filter((f) => f.role === 'super').slice(superTurnsBefore).filter((f) => /permission|Bash|echo super-verify/i.test(f.blocks[0] ?? '') && f.blocks[0]?.startsWith('[super'));
  ok('no super turn was ever about the permission', permToSuper.length === 0, JSON.stringify(permToSuper).slice(0, 500));

  console.log('\n── refusals');
  await sayInVisibleComposer(page, `GO-REFUSE ${childA}`);
  ok('the refusal turn ran', await until(page, async () => reports().some((r) => r.kind === 'owner-refuse'), 30000));
  const ref = reports().find((r) => r.kind === 'owner-refuse')?.steps ?? [];
  ok('the super cannot switch its own mode (window mode)', ref[0] && ref[0].status !== 0, ref[0]?.out);
  ok('the super cannot open a tab outside super delegate (window new)', ref[1] && ref[1].status !== 0, ref[1]?.out);
  ok('super answer on a stale request is refused', ref[2] && ref[2].status !== 0, ref[2]?.out);
  await sayInVisibleComposer(page, `GO-SIBLING ${childC} ${childB}`);
  ok('a child tried to reach its sibling', await until(page, async () => reports().some((r) => r.kind === 'sibling'), 40000));
  const sib = reports().find((r) => r.kind === 'sibling')?.steps ?? [];
  ok('a child cannot send to a sibling', sib[0] && sib[0].status !== 0, sib[0]?.out);
  ok('a child cannot open a tab', sib[1] && sib[1].status !== 0, sib[1]?.out);

  console.log('\n── reload while handed over');
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await until(page, () => surfaceShown(page), 12000))) await openChat(page, base);
  ok('still handed over after a reload', await until(page, () => surfaceShown(page), 20000));
  await page.screenshot({ path: join(OUT, 'flow-04b-after-reload.png') });
  ok('the same containers', await until(page, async () => JSON.stringify((await containerIds()).sort()) === JSON.stringify([...idsHanded].sort()), 15000), `${JSON.stringify(await containerIds())} vs ${JSON.stringify(idsHanded)}`);

  console.log('\n── take back');
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface is gone', await until(page, async () => !(await surfaceShown(page)), 10000));
  await page.waitForTimeout(1500);
  const after = await paneLayout(page);
  report.note(`panes after take-back: ${JSON.stringify(after)}`);
  // A plain terminal (a shell) never outlives a page reload, handed over or not (main's rule:
  // the roster save and the restore both drop shells), so after THIS take-back — which follows
  // a reload — the earlier panes are expected without their shell tabs. The no-reload take-back
  // at the end of the flow checks a terminal returns to its exact place.
  const beforeNoShells = before.map((tabs) => tabs.filter((t) => !/^Terminal \d+$/.test(t)));
  ok('the earlier panes return, each tab where it was (shells excepted: they die on the reload)', beforeNoShells.every((tabs, i) => tabs.every((t, j) => after[i]?.[j] === t)) && after.length === before.length, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  ok('the delegated children are tabs now', ['Worktree two', 'Worktree three'].every((t) => after.flat().some((x) => x.includes(t))), JSON.stringify(after));
  ok('no super tab', !after.flat().some((t) => /super agent|^Claude$/i.test(t)), JSON.stringify(after));
  await page.screenshot({ path: join(OUT, 'flow-05-taken-back.png') });
  // Chat 3 (an idle adopted chat that heard the hand-over note) sits alone in the right pane.
  await page.locator('.agent-tab-title', { hasText: 'Chat 3' }).first().click();
  await page.waitForTimeout(600);
  const target = (await page.locator('.chat-cmp-input:visible').count()) - 1;
  await sayInVisibleComposer(page, 'AFTER-TAKEBACK', Math.max(0, target));
  ok('the take-back note rides that chat\'s next owner message, once', await until(page, async () => frames().some((f) => f.role === 'child' && f.blocks[0] === 'AFTER-TAKEBACK' && f.blocks[1] === NOTE_TAKEBACK), 30000),
    JSON.stringify(frames().filter((f) => f.blocks[0] === 'AFTER-TAKEBACK')));

  console.log('\n── relaunch after take-back: no super tab');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openChat(page, base);
  await until(page, async () => (await paneLayout(page)).flat().length > 0, 20000);
  const relaunched = await paneLayout(page);
  ok('after a relaunch the panes are the taken-back panes, with no super tab', !(await surfaceShown(page)) && !relaunched.flat().some((t) => /super agent|^Claude$/i.test(t)) && relaunched.flat().length === after.flat().length, `${JSON.stringify(relaunched)} vs ${JSON.stringify(after)}`);

  console.log('\n── a terminal opened before the second hand-over (for the no-reload take-back)');
  await page.locator('.agent-tab-title', { hasText: 'Chat 3' }).first().click();
  await page.waitForTimeout(600);
  await sayInVisibleComposer(page, 'OPEN-TERM', Math.max(0, (await page.locator('.chat-cmp-input:visible').count()) - 1));
  ok('a terminal tab opened', await until(page, async () => (await paneLayout(page)).flat().some((t) => /^Terminal \d+$/.test(t)), 30000), JSON.stringify(await paneLayout(page)));

  console.log('\n── a permission already open at hand-over reaches the queue head (review r1 M3)');
  await page.locator('.agent-tab-title', { hasText: 'Chat 3' }).first().click();
  await page.waitForTimeout(600);
  await sayInVisibleComposer(page, 'PRE-PERM', Math.max(0, (await page.locator('.chat-cmp-input:visible').count()) - 1));
  ok('Chat 3 is asking a tool permission before the hand-over', await until(page, async () => frames().some((f) => f.role === 'child' && f.blocks[0] === 'PRE-PERM'), 30000));
  await page.waitForTimeout(1500);
  const superTurnsBeforeAgain = frames().filter((f) => f.role === 'super').length;
  const before2 = await paneLayout(page);
  report.note(`panes before the second hand-over: ${JSON.stringify(before2)}`);

  console.log('\n── hand over again: the same session and layout');
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('handed over again', await until(page, () => surfaceShown(page), 15000));
  ok('the open permission is at the queue head at once, with Allow/Deny', await until(page, async () => (await page.getByTestId('super-queue-allow').count()) > 0
    && /echo pre-handover|Bash/.test(await page.getByTestId('super-queue-head').innerText().catch(() => '')), 8000),
    await page.getByTestId('super-queue-head').innerText().catch(() => 'no head'));
  await page.screenshot({ path: join(OUT, 'flow-05b-open-permission-at-handover.png') });
  await page.getByTestId('super-queue-allow').first().click().catch(() => {});
  ok('Allow answered the child that was already asking', await until(page, async () => reports().some((r) => r.kind === 'pre-permission' && /allow/i.test(JSON.stringify(r.response))), 20000),
    JSON.stringify(reports().filter((r) => r.kind === 'pre-permission')));
  ok('no super turn was about that permission', frames().filter((f) => f.role === 'super').slice(superTurnsBeforeAgain).every((f) => !/echo pre-handover/.test(f.blocks[0] ?? '')));
  await page.waitForTimeout(2500);
  ok('the same super conversation', frames().filter((f) => f.role === 'super').every((f) => f.convo === superConvo), JSON.stringify([...new Set(frames().filter((f) => f.role === 'super').map((f) => f.convo))]));
  const idsAgain = await containerIds();
  ok('the same containers are back', idsHanded.every((id) => idsAgain.includes(id)), `${JSON.stringify(idsAgain)} vs ${JSON.stringify(idsHanded)}`);

  console.log('\n── merge two worktree children (one clean, one conflicting)');
  await sayInVisibleComposer(page, `GO-MERGE ${delegated[0]} ${delegated[1]}`);
  ok('the merge ran', await until(page, async () => reports().some((r) => r.kind === 'owner-merge'), 60000));
  const merge = reports().find((r) => r.kind === 'owner-merge')?.steps?.[0];
  report.note(`merge: ${merge?.out?.slice(0, 600)}`);
  const integ = spawnSync('git', ['-C', CODE, 'show', 'super/integ:a.txt'], { encoding: 'utf-8' });
  ok('super/integ holds the clean child\'s change', integ.stdout.trim() === 'two', integ.stdout + integ.stderr);
  ok('the conflicting child was aborted with its file named', /a\.txt/.test(merge?.out ?? '') && /conflict/i.test(merge?.out ?? ''), merge?.out);
  ok('nothing landed on main', spawnSync('git', ['-C', CODE, 'show', 'main:a.txt'], { encoding: 'utf-8' }).stdout.trim() === 'one');

  console.log('\n── a stage under 1040 px: every card in Others, side by side as a sheet');
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(900);
  let narrow = await geo(page);
  ok('the stage is narrower than 1040 px', !!narrow.s && narrow.s.w < 1040, `${narrow.s?.w}`);
  ok('no card floats: every card is in Others', narrow.cards.length === 0 && narrow.others === record().containers.length, JSON.stringify({ drawn: narrow.cards.length, others: narrow.others, record: record().containers.length }));
  await page.getByTestId('super-others-stack').click();
  await page.getByTestId('super-others-item').first().click();
  await page.waitForTimeout(900);
  narrow = await geo(page);
  ok('side by side opens as a sheet over the centre', narrow.cards.length === 1 && narrow.cards[0].where === 'sheet', JSON.stringify(narrow.cards));
  await page.screenshot({ path: join(OUT, 'flow-06-narrow-1000.png') });
  await page.getByTestId('super-card-minimize').first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(900);

  console.log('\n── take back with no reload: the terminal returns to its exact place');
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface is gone (second take-back)', await until(page, async () => !(await surfaceShown(page)), 10000));
  await page.waitForTimeout(1500);
  const after2 = await paneLayout(page);
  report.note(`panes after the second take-back: ${JSON.stringify(after2)}`);
  ok('every earlier tab, the terminal included, is back where it was', before2.length > 0 && before2.flat().some((t) => /^Terminal \d+$/.test(t))
    && before2.every((tabs, i) => tabs.every((t, j) => after2[i]?.[j] === t)) && after2.length === before2.length, `${JSON.stringify(before2)} → ${JSON.stringify(after2)}`);
  await page.screenshot({ path: join(OUT, 'flow-07-second-take-back.png') });

  console.log('\n── Settings → Chat → Super Agent (off by default; the owner turns it on)');
  // The owner's path: the rail's Settings, the Chat section, the last row's switch, back to Chat.
  const setSuper = async (on, shot) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.locator('.settings-nav-item').filter({ hasText: /^\s*Chat/ }).first().click();
    const sw = page.getByRole('switch', { name: 'Show the Super Agent' });
    await sw.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    if ((await sw.isChecked()) !== on) await sw.click();
    await until(page, async () => (await sw.isChecked()) === on, 5000);
    await page.waitForTimeout(400); // the switch's own transition, so the shot shows where it landed
    if (shot) await page.screenshot({ path: join(OUT, shot) });
    await page.locator('aside button, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first().click();
    await until(page, async () => (await page.locator('.agent-surface.expanded').count()) > 0, 5000);
    await page.waitForTimeout(600);
  };
  await setSuper(false, 'settings-super-off.png');
  const lastGroup = await page.evaluate(() => [...document.querySelectorAll('.settings-section .setting-group')].pop()?.textContent ?? '');
  ok('the Super Agent group is the last one in Settings → Chat', /Super Agent/.test(lastGroup), lastGroup.slice(0, 80));
  ok('Super Agent off in Settings: the Chat header shows no hand-over button', (await page.getByTestId('super-handover-btn').count()) === 0);
  const savedSuper = () => JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), 'utf-8')).superAgent;
  ok('…and it is saved off (agent-ui.json)', await until(page, async () => savedSuper() === false, 5000), String(savedSuper()));
  await setSuper(true, 'settings-super-on.png');
  ok('Super Agent on in Settings: the hand-over button is back', await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0, 5000));
  // Switched off DURING a hand-over: Take back stays, and once the chats are back the button goes.
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000);
  await page.waitForTimeout(1200);
  await setSuper(false);
  const stays = await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0 && (await page.getByTestId('super-handover-btn').count()) > 0, 5000);
  ok('switched off while handed over: Take back is still there', stays);
  await page.screenshot({ path: join(OUT, 'settings-super-off-handed-over.png') });
  if (stays) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('…taken back, the button is gone (the switch is off)', await until(page, async () => (await page.locator('.agent-pane:visible').count()) > 0 && (await page.getByTestId('super-handover-btn').count()) === 0, 20000));
  await setSuper(true);
  ok('…switched on again, the hand-over button is back', await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0, 5000));

  const result = { page, context, before, adopted, ho, errors };
  return result;
}

// ─── motion (each engine) ───────────────────────────────────────────────────────────────

/** Arm a per-rAF probe: frame times, the worst "ring with nothing painted" frame, and every
 *  animation's animated properties. */
const armProbe = (page) => page.evaluate(() => {
  const s = { frames: [], empty: 0, props: new Set(), transitions: new Set(), who: new Set(), maxRunning: 0, done: false, flights: 0, standins: 0, centreMin: 1, viewsInFlight: 0 };
  window.__superProbe = s;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const tick = (t) => {
    if (s.done) return;
    s.frames.push(t);
    const surface = [...document.querySelectorAll('[data-testid="super-surface"]')].find(visible);
    if (surface && Number(getComputedStyle(surface).opacity) > 0.05) {
      const painted = [...document.querySelectorAll('[data-testid="super-container"], .super-flight-layer > *')]
        .filter((el) => visible(el) && Number(getComputedStyle(el).opacity) > 0.01).length;
      if (painted === 0) s.empty += 1;
    }
    s.flights = Math.max(s.flights, document.querySelectorAll('.super-flight-layer > *').length);
    s.standins = Math.max(s.standins, document.querySelectorAll('.super-stage-layer > *, .super-stage-under > *').length);
    // A card's view (whiteboard, web page, task, note, image) mounted while the hand-over flies.
    if (document.querySelector('[data-super-motion="running"]')) {
      s.viewsInFlight = Math.max(s.viewsInFlight, document.querySelectorAll('[data-testid="super-container"] .super-card-view').length);
    }
    // The centre's composer as painted: its own opacity times every ancestor's (FE3).
    const comp = document.querySelector('[data-super-slot="centre"] .chat-cmp-input');
    if (comp && visible(comp)) {
      let o = 1;
      for (let e = comp; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      s.centreMin = Math.min(s.centreMin, o);
    }
    // The transition's own animations: WAAPI and keyframe animations with an end. CSS
    // transitions (hover, focus rings) and endless status/ambient loops are not the choreography.
    const anims = document.getAnimations().filter((a) => !(typeof CSSTransition !== 'undefined' && a instanceof CSSTransition)
      && a.effect?.getComputedTiming?.().iterations !== Infinity);
    s.maxRunning = Math.max(s.maxRunning, anims.filter((a) => a.playState === 'running').length);
    for (const a of anims) {
      try {
        for (const k of a.effect?.getKeyframes?.() ?? []) for (const p of Object.keys(k)) {
          s.props.add(p);
          if (p === 'transform') s.who.add(`${a.animationName || a.constructor.name}@${String(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '').slice(0, 60)}`);
        }
      } catch { /* not a keyframe effect */ }
    }
    for (const a of document.getAnimations()) if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) s.transitions.add(a.transitionProperty);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const readProbe = (page) => page.evaluate(() => {
  const s = window.__superProbe;
  s.done = true;
  const gaps = [];
  const long = [];
  for (let i = 1; i < s.frames.length; i += 1) {
    const g = s.frames[i] - s.frames[i - 1];
    gaps.push(g);
    if (g > 25) long.push(`${Math.round(g)}ms@+${Math.round(s.frames[i - 1] - s.frames[0])}`);
  }
  return { long, worst: gaps.length ? Math.max(...gaps) : 0, frames: s.frames.length, empty: s.empty, props: [...s.props], transitions: [...s.transitions], who: [...s.who], flights: s.flights, standins: s.standins, centreMin: s.centreMin, viewsInFlight: s.viewsInFlight };
});
const NON_STYLE = new Set(['offset', 'easing', 'composite', 'computedOffset']);
/** The crossfade check reads the CHOREOGRAPHY: list content mounting inside a container brings
 *  the app's own entrance (`slide-up-fade` on `.animate-stagger`), which is not a flight. */
const choreographyOnly = (r) => ({ ...r, who: r.who.filter((w) => !w.startsWith('slide-up-fade@')), crossfadeOk: r.flights === 0 && r.who.every((w) => w.startsWith('slide-up-fade@')) });
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
const rectsOf = (page, sel) => page.locator(sel).evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0)
  .map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }));
const within1 = (a, b) => a.length === b.length && a.every((r, i) => r.every((v, j) => Math.abs(v - b[i][j]) <= 1));
const runningAfter = (page) => page.evaluate(() => new Promise((r) => setTimeout(() => r(document.getAnimations()
  .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations !== Infinity)
  .map((a) => `${a.animationName || a.transitionProperty || a.id || a.constructor.name}@${a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? ''}`.slice(0, 120))), 100)));
/** The choreography has finished: no surface says "running" and its flight layer is empty. */
const motionIdle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0
  && (await page.locator('.super-flight-layer > *').count()) === 0, 4000);

/** One transition with the probe on; returns its numbers. */
async function measured(page, label) {
  await armProbe(page);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  await page.waitForTimeout(60);
  await motionIdle(page);
  const running = await runningAfter(page);
  const probe = await readProbe(page);
  // The rects the moment the motion ends, for the "lands on the static layout" check.
  const rectsAtEnd = await rectsOf(page, (await surfaceShown(page)) ? '[data-testid="super-container"]' : '.agent-pane');
  return { label, ...probe, running, rectsAtEnd };
}

async function motion(engineName, browserType, base) {
  console.log(`\n── motion: ${engineName}`);
  const browser = await browserType.launch();
  const vids = join(OUT, `video-${engineName}`);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', recordVideo: { dir: vids, size: { width: 1600, height: 1000 } } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} (after: ${LAST_CHECK})`); });
  page.on('pageerror', (e) => errors.push(`${String(e)} (after: ${LAST_CHECK})`));
  await openChat(page, base);
  await page.bringToFront();
  // Start taken back, with the five chats as tabs.
  if (await until(page, () => surfaceShown(page), 6000)) {
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    await motionIdle(page);
    await page.waitForTimeout(800);
  }
  ok(`${engineName}: five chat tabs before the hand-over`, (await paneLayout(page)).flat().length >= 5, JSON.stringify(await paneLayout(page)));
  // A draft in the active composer that must survive both transitions.
  const draftBox = page.locator('.chat-cmp-input:visible').first();
  await draftBox.click();
  await draftBox.fill('a draft the owner was writing');
  const paneRects0 = await rectsOf(page, '.agent-pane');
  // The page behind the chat (the seeded board), scrolled: covered while handed over, it must
  // come back at this position when the chat is collapsed (checked at the end).
  //
  // On the task board the scrollers are its COLUMNS (the page itself does not scroll), and a
  // column reflows with its width: the rail folds while the Super Agent has the screen, so the
  // page comes back wider, card titles wrap onto fewer lines, and Chromium's scroll anchoring
  // keeps the same cards in view by moving scrollTop (900 → 882 on the seeded board; WebKit has
  // no anchoring and keeps 900). "Where it was" is then the same card at the top, not the same
  // pixel: the check takes the card at the column's top edge and its offset, and accepts either
  // the same scrollTop or, after a width change, that same card still at the top.
  const pageScroll0 = await page.evaluate(() => {
    const main = document.querySelector('.shell-main');
    const sc = main && [main, ...main.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
    if (!sc) return null;
    sc.setAttribute('data-verify-scroller', '');
    sc.scrollTop = Math.min(900, sc.scrollHeight - sc.clientHeight);
    return sc.scrollTop;
  });
  /** The card at the scroller's top edge (the first whose bottom is below it), its offset, and the width. */
  const topOf = () => page.evaluate(() => {
    const sc = document.querySelector('[data-verify-scroller]');
    if (!sc) return null;
    const top = sc.getBoundingClientRect().top;
    const card = [...sc.querySelectorAll('[data-task-card]')].find((c) => c.getBoundingClientRect().bottom > top + 1) ?? null;
    return { card: card?.getAttribute('data-task-card') ?? null, offset: card ? Math.round(card.getBoundingClientRect().top - top) : null, width: sc.clientWidth };
  });
  const pageTop0 = await topOf();
  const coverOf = () => page.evaluate(() => {
    const m = document.querySelector('.shell-main');
    return { attr: !!document.querySelector('.project-instance[data-super-cover]'), cv: m ? getComputedStyle(m).contentVisibility : null, scroll: document.querySelector('[data-verify-scroller]')?.scrollTop ?? null };
  });

  // The engine's own floor: the same page, no interaction, 1 s per sample.
  const idle = [];
  for (let i = 0; i < REPS; i += 1) {
    await armProbe(page);
    await page.waitForTimeout(1000);
    idle.push((await readProbe(page)).worst);
  }
  report.note(`${engineName}: idle baseline worst rAF gap (no interaction, 1 s): ${idle.map((x) => Math.round(x)).join(', ')} ms`);

  const handovers = [];
  const takebacks = [];
  for (let i = 0; i < REPS; i += 1) {
    const h = await measured(page, 'hand-over');
    handovers.push(h);
    await page.waitForTimeout(1200);
    h.rectsOk = within1(h.rectsAtEnd, await rectsOf(page, '[data-testid="super-container"]'));
    // Every card that is not a chat shows what it holds once the cards landed: a floating tile
    // its data (2026-10-20 tiles), a large card its view.
    h.views = await page.evaluate(() => ({
      mounted: document.querySelectorAll('[data-testid="super-container"] :is(.super-tile[data-view="ready"], .super-card-view)').length,
      want: [...document.querySelectorAll('[data-testid="super-container"]')].filter((c) => ['task', 'knowledge', 'image', 'insight', 'whiteboard', 'board', 'web'].includes(c.dataset.kind)).length,
    }));
    if (i === 0) {
      const cover = await coverOf();
      ok(`${engineName}: handed over, the page behind skips style and layout (content-visibility: hidden)`, cover.attr && cover.cv === 'hidden', JSON.stringify(cover));
      const focus = await page.evaluate(() => { const a = document.activeElement; return a ? (a.closest('[data-super-slot="centre"]') ? 'centre' : a.className) : 'none'; });
      ok(`${engineName}: focus lands in the centre composer after the hand-over`, focus === 'centre', focus);
      await page.screenshot({ path: join(OUT, `${engineName}-handed-over-1600-dark.png`) });
    }
    const t = await measured(page, 'take-back');
    takebacks.push(t);
    await page.waitForTimeout(1200);
    t.rectsOk = within1(t.rectsAtEnd, await rectsOf(page, '.agent-pane'));
    if (i === 0) {
      ok(`${engineName}: taken back, the panes still cover the page, which stays skipped`, (await coverOf()).attr, JSON.stringify(await coverOf()));
      ok(`${engineName}: the panes return to their exact rects`, within1(await rectsOf(page, '.agent-pane'), paneRects0), `${JSON.stringify(await rectsOf(page, '.agent-pane'))} vs ${JSON.stringify(paneRects0)}`);
      ok(`${engineName}: the composer kept its draft`, (await page.locator('.chat-cmp-input:visible').first().inputValue().catch(async () => page.locator('.chat-cmp-input:visible').first().innerText())) === 'a draft the owner was writing');
    }
  }
  ok(`${engineName} hand-over: no card view (whiteboard, web page, task, note, image) mounts while the cards fly`, handovers.every((r) => r.viewsInFlight === 0), JSON.stringify(handovers.map((r) => r.viewsInFlight)));
  ok(`${engineName} hand-over: every card view is mounted once the cards landed`, handovers.every((r) => r.views.want > 0 && r.views.mounted >= r.views.want), JSON.stringify(handovers.map((r) => r.views)));
  for (const [name, runs] of [['hand-over', handovers], ['take-back', takebacks]]) {
    const worst = median(runs.map((r) => r.worst));
    ok(`${engineName} ${name}: median of each run's worst rAF gap <= 34 ms`, worst <= 34, `${runs.map((r) => Math.round(r.worst)).join(', ')} ms`);
    report.note(`${engineName} ${name}: frames over 25 ms (gap@offset from the click): ${JSON.stringify(runs.map((r) => r.long))}`);
    // Headless WebKit's own idle floor sits at ~33-39 ms here, so the strict bar above cannot
    // separate jank from pacing there: also report the transition against the engine's floor.
    report.note(`${engineName} ${name}: median worst ${Math.round(worst)} ms vs idle floor ${Math.round(median(idle))} ms (${worst <= median(idle) + 8 ? 'within' : 'OVER'} floor + 8 ms)`);
    ok(`${engineName} ${name}: only transform/opacity animate`, runs.every((r) => r.props.every((p) => NON_STYLE.has(p) || p === 'transform' || p === 'opacity')), JSON.stringify(runs.map((r) => r.props)));
    ok(`${engineName} ${name}: no running animation 100 ms after it finished`, runs.every((r) => r.running.length === 0), JSON.stringify(runs.map((r) => r.running)));
    report.note(`${engineName} ${name}: CSS transitions during it (not the choreography): ${JSON.stringify([...new Set(runs.flatMap((r) => r.transitions))])}`);
    ok(`${engineName} ${name}: no frame shows the ring with nothing painted`, runs.every((r) => r.empty === 0), JSON.stringify(runs.map((r) => r.empty)));
    ok(`${engineName} ${name}: flights use stand-ins`, runs.some((r) => r.flights > 0), JSON.stringify(runs.map((r) => r.flights)));
    ok(`${engineName} ${name}: final rects within 1 px of the static layout`, runs.every((r) => r.rectsOk), JSON.stringify(runs.map((r) => r.rectsOk)));
  }

  // Mid-flight reverse: press again 150 ms in; it must come back to where it started.
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  await page.waitForTimeout(150);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  await motionIdle(page);
  await page.waitForTimeout(1500);
  ok(`${engineName}: a press mid-flight reverses back to the start`, !(await surfaceShown(page)) && within1(await rectsOf(page, '.agent-pane'), paneRects0), `surface=${await surfaceShown(page)} ${JSON.stringify(await rectsOf(page, '.agent-pane'))}`);

  // Filmstrip of one hand-over (screenshots slow the frames, so this run is not measured).
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  const t0 = Date.now();
  for (const pct of [0, 25, 50, 75, 100]) {
    const wait = t0 + (450 * pct) / 100 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await page.screenshot({ path: join(OUT, `${engineName}-filmstrip-${String(pct).padStart(3, '0')}.png`) });
  }
  await motionIdle(page);
  await page.waitForTimeout(800);

  // ── Layout motion (plan-r8 F8, FE2-FE4): the owner's float → half → float, then the agent's
  // verbs 150 ms apart (half → present) and present --off, with a draft and a caret in the centre.
  const stageRects = () => rectsOf(page, '[data-testid="super-container"], .super-centre');
  let gm = await geo(page);
  const sideCard = gm.cards.find((c) => c.where === 'float' && c.kind === 'chat') ?? gm.cards.find((c) => c.where === 'float');
  const ownerRuns = [];
  for (let i = 0; i < REPS && sideCard; i += 1) {
    await armProbe(page);
    const at = cardIn(await geo(page), sideCard.id)?.r ?? sideCard.r;
    await page.mouse.click(grabPoint(at).x, grabPoint(at).y);
    await page.waitForTimeout(700);
    const half = cardIn(await geo(page), sideCard.id)?.where;
    await page.getByTestId('super-card-minimize').first().click().catch(() => {});
    await page.waitForTimeout(700);
    ownerRuns.push({ ...(await readProbe(page)), half });
  }
  const recM = record();
  const taskM = recM.containers.find((c) => c.kind === 'task')?.id;
  const knowM = recM.containers.find((c) => c.kind === 'knowledge')?.id;
  const agentRuns = [];
  const composerM = superComposer(page);
  for (let i = 0; i < REPS; i += 1) {
    for (const [cmd, mode] of [[`GO-TWO ${taskM} ${knowM}`, 'present'], ['GO-PRESENTOFF later', 'float']]) {
      await sayToSuper(page, cmd);
      await composerM.click();
      await composerM.fill('keep this draft');
      await composerM.evaluate((el) => { if (typeof el.setSelectionRange === 'function') el.setSelectionRange(4, 4); });
      await armProbe(page);
      await until(page, async () => record().view.mode === mode, 20000);
      await page.waitForTimeout(1000);
      const pr = await readProbe(page);
      const kept = await page.evaluate(() => {
        const a = document.activeElement;
        return { inCentre: !!a?.closest('[data-super-slot="centre"]'), value: a && 'value' in a ? a.value : a?.textContent ?? '', caret: a && 'selectionStart' in a ? a.selectionStart : null };
      });
      const r1 = await stageRects();
      await page.waitForTimeout(500);
      const still = within1(r1, await stageRects());
      agentRuns.push({ ...pr, cmd, kept, still, mode: record().view.mode });
      await composerM.fill('');
    }
  }
  if (ownerRuns.length) {
    ok(`${engineName} float → half → float (owner): it went half and back`, ownerRuns.every((r) => r.half === 'half'), JSON.stringify(ownerRuns.map((r) => r.half)));
    ok(`${engineName} float → half → float: median worst rAF gap <= 34 ms`, median(ownerRuns.map((r) => r.worst)) <= 34, `${ownerRuns.map((r) => Math.round(r.worst)).join(', ')} ms`);
    ok(`${engineName} float → half → float: the size change flies a stand-in`, ownerRuns.some((r) => r.standins > 0), JSON.stringify(ownerRuns.map((r) => r.standins)));
  }
  ok(`${engineName} agent verbs 150 ms apart (half → present, present --off): median worst rAF gap <= 34 ms`, median(agentRuns.map((r) => r.worst)) <= 34, `${agentRuns.map((r) => Math.round(r.worst)).join(', ')} ms`);
  ok(`${engineName} agent verbs: each landed (present, then float)`, agentRuns.every((r) => r.mode === (r.cmd.startsWith('GO-TWO') ? 'present' : 'float')), JSON.stringify(agentRuns.map((r) => [r.cmd, r.mode])));
  ok(`${engineName} layout motion: the centre and its composer stay at opacity 1 in every frame`, [...ownerRuns, ...agentRuns].every((r) => r.centreMin >= 0.999), JSON.stringify([...ownerRuns, ...agentRuns].map((r) => r.centreMin)));
  ok(`${engineName} agent verbs keep the draft, the focus and the caret`, agentRuns.every((r) => r.kept.inCentre && r.kept.value === 'keep this draft' && r.kept.caret === 4), JSON.stringify(agentRuns.map((r) => r.kept)));
  ok(`${engineName} layout motion: only transform/opacity animate`, [...ownerRuns, ...agentRuns].every((r) => r.props.every((p) => NON_STYLE.has(p) || p === 'transform' || p === 'opacity')), JSON.stringify([...ownerRuns, ...agentRuns].map((r) => r.props)));
  ok(`${engineName} layout motion: nothing moves for 500 ms after it ends`, agentRuns.every((r) => r.still), JSON.stringify(agentRuns.map((r) => r.still)));
  report.note(`${engineName} layout motion frames over 25 ms: ${JSON.stringify([...ownerRuns, ...agentRuns].map((r) => r.long))}`);
  // A resize SNAPS (FE4): no stand-in, no layout animation.
  await armProbe(page);
  await page.setViewportSize({ width: 1480, height: 1000 });
  await page.waitForTimeout(400);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(400);
  const rs = await readProbe(page);
  // Only the stage's own elements count: list content mounting inside a card plays the app's
  // entrance, and the rail's glide is the sidebar's.
  const stageWho = rs.who.filter((w) => /super-(card-frame|centre|standin)/.test(w));
  ok(`${engineName}: a resize snaps (no stand-in, no layout animation on the stage)`, rs.standins === 0 && stageWho.length === 0, JSON.stringify({ standins: rs.standins, stageWho }));

  if (engineName === 'chromium') {
    // The owner's view as the screenshots show it (AC16): a card in Others, a question in the pill.
    gm = await geo(page);
    const toStack = gm.cards.find((c) => c.where === 'float' && c.kind !== 'chat' && c.id !== DRAGGED) ?? gm.cards.find((c) => c.where === 'float' && c.id !== DRAGGED);
    if (toStack) await drag(page, grabPoint(toStack.r), { x: gm.s.x + gm.s.w - 30, y: gm.s.y + gm.s.h - 30 });
    const askChild = Object.keys(record().children ?? {})[0];
    if (askChild) await sayToSuper(page, `GO-ASK ${askChild}`);
    ok('chromium: a question waits in the queue pill for the screenshots', await until(page, async () => (await page.getByTestId('super-queue-head').count()) > 0, 60000));
    ok('chromium: the Others stack holds a card for the screenshots', (await page.getByTestId('super-others-stack').count()) === 1);
    // The owner judges the STAGE's composition: his drops are cleared for the shots (the owner's
    // own route, as a drop writes it) and the dragged card's put back after, for the restart check.
    const layout = (patch) => page.evaluate(async (p) => (await fetch('/api/super/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'acme-app' }, body: JSON.stringify(p),
    })).status, patch);
    const placed = record().containers.filter((c) => c.pos).map((c) => ({ id: c.id, pos: c.pos }));
    if (placed.length) {
      const st = await layout({ cards: placed.map((c) => ({ id: c.id, pos: null })) });
      ok('chromium: the owner\'s drops cleared for the screenshots', st === 200 && !record().containers.some((c) => c.pos), `status ${st}`);
    }
    await page.waitForTimeout(800);
    for (const [w, h] of [[1280, 800], [1440, 900], [1800, 1130], [1920, 1080]]) {
      for (const scheme of ['light', 'dark']) {
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(OUT, `handed-over-${w}-${scheme}.png`) });
        if (scheme === 'light') {
          const gw = await geo(page);
          ok(`chromium ${w}x${h}: >= 4 cards float, the centre centred (<= 1 px)`, gw.cards.filter((c) => c.where === 'float').length >= 4
            && Math.abs((gw.c.x - gw.s.x) - (gw.s.x + gw.s.w - gw.c.x - gw.c.w)) <= 1, JSON.stringify({ floating: gw.cards.filter((c) => c.where === 'float').length, s: gw.s, c: gw.c }));
          const rw = orbitOf(gw);
          ok(`chromium ${w}x${h}: the orbit, the centre 56% (2026-10-20)`, rw.ok, JSON.stringify(rw.detail));
          ok(`chromium ${w}x${h}: every floating card one 160 px 1:1 tile`, gw.cards.filter((c) => c.where === 'float').every((c) => Math.abs(c.r.w - 160) <= 1 && Math.abs(c.r.h - 160) <= 1),
            JSON.stringify(gw.cards.filter((c) => c.where === 'float').map((c) => [c.r.w, c.r.h])));
          // At rest the pill keeps one row in its band: it never half-covers the centre's header.
          const pill = await page.getByTestId('super-queue-head').boundingBox();
          ok(`chromium ${w}x${h}: the queue pill at rest stays in its band, clear of the centre`, !!pill && pill.y + pill.height <= gw.c.y + 0.5, JSON.stringify({ pill, centreTop: gw.c.y }));
        }
        if (scheme === 'light' && w === 1280) {
          // The pill as JobBar draws it, laid out by the real stylesheet at the narrowest band
          // and the widest, with the real Reply / "n more" labels in English and Turkish: with its
          // options when they ALL fit at full width (no cut label: an answer cannot be undone),
          // else Reply only (optionsFit). Either way one row inside the band, every button inside
          // the pill, some of the question showing.
          const pills = await page.evaluate((widths) => {
            const surface = document.querySelector('[data-testid="super-surface"]');
            const el = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; };
            const fixtures = [
              { name: 'en-typical', who: 'Chat 1', text: 'The login button: which colour?', options: ['Blue', 'Green'], reply: 'Reply to Claude', more: '1 more waiting', list: 'Job list' },
              { name: 'en-worst', who: 'Fix the login button colour on every page', text: 'Which colour should the login button use across the whole app, given the brand palette?', options: ['Blue (Recommended)', 'Green', 'Keep the current one', 'Match the brand palette'], reply: 'Reply to Claude', more: '2 more waiting', list: 'Job list' },
              { name: 'tr-worst', who: 'Giriş düğmesinin rengini düzelt', text: 'Giriş düğmesi tüm uygulamada hangi renkte olmalı, marka paletine göre?', options: ['Mavi (Önerilen)', 'Yeşil', 'Mevcut olanı koru', 'Marka paletine uy'], reply: 'Claude’a yanıt ver', more: '2 tane daha bekliyor', list: 'İş listesi' },
            ];
            const lay = (fx, bw, withOptions) => {
              const strip = el('div', 'super-queue-strip');
              strip.style.cssText = `left:0;top:0;width:${bw}px;min-height:40px;visibility:hidden`;
              const head = el('div', 'super-queue-head');
              head.dataset.kind = 'question';
              const actions = el('span', 'super-queue-actions');
              if (withOptions) for (const o of fx.options) actions.append(el('button', 'super-queue-btn super-queue-btn--option', o));
              actions.append(el('button', 'super-queue-btn super-queue-btn--reply', fx.reply));
              head.append(el('span', 'super-queue-who', fx.who), el('span', 'super-queue-text', fx.text), actions, el('span', 'super-queue-more', fx.more));
              // The band holds only the head now (the counts moved into the agenda).
              strip.classList.add('super-job-bar');
              strip.append(head);
              surface.append(strip);
              const hr = head.getBoundingClientRect();
              const right = Math.max(...[...head.querySelectorAll('button, .super-queue-more')].map((b) => b.getBoundingClientRect().right));
              const cutLabel = [...head.querySelectorAll('.super-queue-btn--option')].some((b) => b.scrollWidth > b.clientWidth + 1 && b.textContent.length <= 24);
              const r = { overflow: head.scrollWidth - head.clientWidth, height: Math.round(hr.height), over: Math.round(right - hr.right), text: Math.round(head.querySelector('.super-queue-text').getBoundingClientRect().width), cutLabel };
              strip.remove();
              return r;
            };
            const out = [];
            for (const fx of fixtures) for (const bw of widths) {
              const full = lay(fx, bw, true);
              const drawn = full.overflow > 1 ? { ...lay(fx, bw, false), options: false } : { ...full, options: true };
              out.push({ fx: fx.name, bw, ...drawn });
            }
            return out;
          }, [600, 720]);
          ok('chromium: the queue pill (en + tr, typical + worst, 600 + 720 px) is one row inside its band, every button inside it, no cut option label, the question showing', pills.every((r) => r.height <= 40 && r.over <= 0 && r.text >= 60 && !r.cutLabel), JSON.stringify(pills));
          ok('chromium: a typical question keeps its option buttons at both widths', pills.filter((r) => r.fx === 'en-typical').every((r) => r.options), JSON.stringify(pills.filter((r) => r.fx === 'en-typical')));
        }
      }
    }
    // The amended Layout clause, OBSERVED (stage v2 end review r1): five chats and two other cards
    // at the four windows: six float and the seventh is drawn in Others at 1280 and 1440, all seven
    // float at 1600 and 1920, on one rhythm, every chat on the stage.
    const rec = record().containers;
    const chats = rec.filter((c) => c.kind === 'chat');
    const rest = rec.filter((c) => c.kind !== 'chat');
    const keep = rest.slice(0, 2);
    const was = new Map(rec.map((c) => [c.id, c.place]));
    const st5 = await layout({ cards: [...[...chats, ...keep].map((c) => ({ id: c.id, place: 'float' })), ...rest.slice(2).map((c) => ({ id: c.id, place: 'others' }))] });
    ok('chromium: the stage holds five chats and two other cards for the shape check', st5 === 200 && chats.length === 5 && keep.length === 2, JSON.stringify({ st5, chats: chats.length, keep: keep.length }));
    const seven = new Set([...chats, ...keep].map((c) => c.id));
    await page.emulateMedia({ colorScheme: 'light' });
    for (const [w, h, want] of [[1280, 800, 6], [1440, 900, 6], [1600, 1000, 7], [1920, 1080, 7]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(700);
      const g5 = await geo(page);
      const floats = g5.cards.filter((c) => c.where === 'float');
      const drawnOthers = [...seven].filter((id) => !floats.some((c) => c.id === id)).length;
      await page.screenshot({ path: join(OUT, `stage-v2-5t2s-${w}.png`) });
      const r5 = orbitOf(g5);
      ok(`chromium ${w}x${h}: 5 chats + 2 others: ${want} float, ${7 - want} drawn in Others, on the orbit`, floats.length === want && drawnOthers === 7 - want && floats.every((c) => seven.has(c.id)) && r5.ok,
        JSON.stringify({ floating: floats.length, drawnOthers, rhythm: r5.detail }));
      ok(`chromium ${w}x${h}: 5 tall + 2 square: every chat floats (the other cards go to Others first)`, chats.every((c) => floats.some((f) => f.id === c.id)), JSON.stringify(floats.map((c) => c.kind)));
    }
    await layout({ cards: rec.map((c) => ({ id: c.id, place: was.get(c.id) })) });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const back = placed.find((c) => c.id === DRAGGED);
    if (back) {
      const st = await layout({ cards: [back] });
      ok('chromium: the dragged card\'s drop is put back after the screenshots', st === 200 && JSON.stringify(record().containers.find((c) => c.id === DRAGGED)?.pos) === JSON.stringify(back.pos), `status ${st}`);
      await page.waitForTimeout(800);
    }
  }
  // Collapsed while handed over: the page shows again, at the scroll position it had.
  await page.locator('.agent-overlay-collapse').first().click();
  await page.waitForTimeout(800);
  const shown = await coverOf();
  const pageTop1 = await topOf();
  // Same pixel, or (the column reflowed to a new width) the same card at the top edge.
  const sameSpot = shown.scroll === pageScroll0
    || (!!pageTop0?.card && pageTop1?.width !== pageTop0.width && pageTop1?.card === pageTop0.card && shown.scroll > 0);
  ok(`${engineName}: collapsed, the page behind shows again where it was scrolled (${pageScroll0} px)`, pageScroll0 > 0 && !shown.attr && shown.cv !== 'hidden' && sameSpot, JSON.stringify({ ...shown, before: pageScroll0, top0: pageTop0, top1: pageTop1 }));
  // Re-opened while still handed over: the page shows around the surface's zoom-in and is
  // covered only once the zoom has landed (never a blank page behind a small fading overlay).
  await page.evaluate(() => {
    const inst = document.querySelector('.project-instance');
    const surf = document.querySelector('.agent-surface');
    const t = (window.__reopen = { expandAt: null, coverAt: null, coverDuringZoom: false });
    new MutationObserver(() => {
      const now = performance.now();
      if (t.expandAt === null && surf?.classList.contains('expanded')) t.expandAt = now;
      if (t.coverAt === null && inst?.hasAttribute('data-super-cover')) t.coverAt = now;
      if (inst?.hasAttribute('data-super-cover') && surf?.getAnimations().some((a) => a.animationName === 'agent-surface-zoom-in' && a.playState === 'running')) t.coverDuringZoom = true;
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'data-super-cover'] });
  });
  const chatNav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
  if (await chatNav.count()) await chatNav.click().catch(() => {});
  else await page.locator('.agent-fab').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  const reopen = await page.evaluate(() => window.__reopen);
  ok(`${engineName}: re-opened while handed over, the page is covered only after the zoom-in lands`, reopen.expandAt !== null && reopen.coverAt !== null && !reopen.coverDuringZoom && reopen.coverAt - reopen.expandAt >= 250, JSON.stringify(reopen));
  // The What's New popup renders inside the page, above the surface: the cover lets it show.
  const popupCv = await page.evaluate(() => {
    const m = document.querySelector('.shell-main');
    const probe = document.createElement('div');
    probe.className = 'announcements-modal';
    m.appendChild(probe);
    const withPopup = getComputedStyle(m).contentVisibility;
    probe.remove();
    return { withPopup, without: getComputedStyle(m).contentVisibility };
  });
  ok(`${engineName}: the What's New popup is never hidden under the cover`, popupCv.withPopup !== 'hidden' && popupCv.without === 'hidden', JSON.stringify(popupCv));
  ok(`${engineName}: no console errors`, errors.length === 0, errors.slice(0, 5).join('\n'));
  await context.close();

  // Reduced motion → a crossfade, no flights.
  const rm = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const rp = await rm.newPage();
  await openChat(rp, base);
  await rp.bringToFront();
  const r1 = await measured(rp, 'reduced hand-back');
  const r2 = await measured(rp, 'reduced hand-over');
  const rr = [r1, r2].map(choreographyOnly);
  ok(`${engineName}: reduced motion = crossfade only (no flights, no transform in the choreography)`, rr.every((r) => r.crossfadeOk), JSON.stringify(rr.map((r) => ({ flights: r.flights, who: r.who }))));
  if ([r1, r2].some((r) => r.who.some((w) => w.startsWith('slide-up-fade@')))) report.note(`${engineName}: under reduced motion, container content still plays the app's own slide-up-fade list entrance (pre-existing, outside this choreography)`);
  await rm.close();
  await browser.close();
}

// ─── the job board (plan r4: rows not turns, batches, steer, the bar, the event line) ─────────

/** Plan r4 + the owner's 2026-10-21 card asks, observed. `full` (Chromium) also drives the flow
 *  pieces (turn ends, a slow event turn steered into, the super's own ask, the ring's cost);
 *  every engine checks the bar, the list, the centre font and takes the screenshots. */
async function board(engineName, browserType, base, full) {
  console.log(`\n── ${engineName}: the job board (plan r4)`);
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${LAST_CHECK}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${LAST_CHECK}: ${e}`));
  const apiReqs = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) apiReqs.push({ t: Date.now(), path: u.pathname }); });
  try {
    await openChat(page, base);
    if (!(await until(page, () => surfaceShown(page), 8000))) {
      await page.locator('[data-testid="super-handover-btn"]:visible').first().click().catch(() => {});
      await until(page, () => surfaceShown(page), 20000);
    }
    ok(`${engineName}: handed over for the board checks`, await surfaceShown(page));
    // The board reads the floating stage: nothing side by side from an earlier section.
    if (record().view?.mode !== 'float') {
      await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'acme-app' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
      await until(page, async () => record().view?.mode === 'float', 8000);
    }
    await until(page, async () => (await superComposer(page).count()) > 0, 20000);
    await page.waitForTimeout(1500);

    if (full) {
      // AC9 server: the super session's own argv.
      const sup = reports().filter((r) => r.kind === 'argv' && r.role === 'super').pop();
      const av = sup?.argv ?? [];
      const at = (f) => { const i = av.indexOf(f); return i >= 0 ? av[i + 1] : null; };
      ok('the super agent spawns with --model sonnet --effort medium by default', at('--model') === 'sonnet' && at('--effort') === 'medium', JSON.stringify(av));

      // AC1: children ending turns spend no super turn; 30 s settled they are done, batched.
      const superTurns = (from, to) => frames().filter((f) => f.role === 'super' && !f.folded && f.t >= from && f.t <= to && /^\[super events?\]/.test(f.blocks[0] ?? ''));
      await sayToSuper(page, 'GO-TURNS3');
      ok('the super sent three quick turns to each live child', await until(page, async () => reports().some((r) => r.kind === 'turns3'), 60000));
      const t3 = reports().filter((r) => r.kind === 'turns3').pop();
      const tEnd = t3?.t ?? Date.now();
      await page.waitForTimeout(20000);
      const early = superTurns(tEnd - 15000, tEnd + 20000).filter((f) => /event=done/.test(f.blocks[0]));
      ok(`children ending 3 turns each (${t3?.ids?.length ?? 0} children) open 0 super turns inside the 30 s settle window`, early.length === 0, JSON.stringify(early.map((f) => f.blocks[0].slice(0, 120))));
      // The rows say so meanwhile: working with the "bitiyor" chip, or still working.
      const settlingRows = await page.locator('[data-testid="super-agenda-row"][data-chip="settling"]').count().catch(() => 0);
      ok('…the agenda shows them settling ("finishing") meanwhile', settlingRows >= 1, `${settlingRows}`);
      // A slow next event turn: the owner writes into it three times, fast.
      writeFileSync(join(SCRATCH, 'slow-events'), '1');
      ok('30 s settled, the done rows reach the super agent batched', await until(page, async () => superTurns(tEnd, Date.now()).some((f) => /event=done/.test(f.blocks[0])), 60000));
      const doneTurns = superTurns(tEnd, Date.now() + 1).filter((f) => /event=done/.test(f.blocks[0]));
      const doneItems = doneTurns.reduce((n, f) => n + (f.blocks[0].match(/event=done/g) ?? []).length, 0);
      ok(`…in fewer turns than children (${doneTurns.length} turns for ${doneItems} done items)`, doneTurns.length >= 1 && doneTurns.length < Math.max(2, doneItems), JSON.stringify(doneTurns.map((f) => f.blocks[0].split('\n')[0])));
      ok('the slow event turn started', await until(page, async () => reports().some((r) => r.kind === 'slow-event-start'), 30000));
      const slowAt = reports().filter((r) => r.kind === 'slow-event-start').pop().t;
      for (const m of ['STEER-ONE', 'STEER-TWO', 'STEER-THREE']) { await sayToSuper(page, m); await page.waitForTimeout(250); }
      const steeredOf = () => frames().filter((f) => f.role === 'super' && f.t >= slowAt && /^STEER-/.test(f.blocks[0] ?? ''));
      ok('AC4: 3 owner messages during an event turn are 3 stdin writes at once (folded into it, never held)', await until(page, async () => steeredOf().length === 3 && steeredOf().every((f) => f.folded), 6000), JSON.stringify(steeredOf().map((f) => ({ b: f.blocks[0], folded: !!f.folded }))));
      ok('…all three before that turn\'s result, and no extra turn after it', await until(page, async () => reports().some((r) => r.kind === 'result' && r.role === 'super' && r.t >= slowAt && r.folded === 3), 20000)
        && (await page.waitForTimeout(3000), frames().filter((f) => f.role === 'super' && !f.folded && f.t > slowAt && /^STEER-/.test(f.blocks[0] ?? '')).length === 0),
        JSON.stringify(reports().filter((r) => r.kind === 'result' && r.role === 'super' && r.t >= slowAt)));

      // AC8: the event line, compact; the steered owner bubbles render as his.
      const lines = page.locator('[data-super-slot="centre"] [data-testid="super-event-line"]');
      ok('AC8: event turns are one line each in the centre', await until(page, async () => (await lines.count()) >= 1, 15000), `${await lines.count()}`);
      const steerBubbles = await page.locator('[data-super-slot="centre"]').getByText(/^STEER-(ONE|TWO|THREE)$/).count();
      ok('…a steered owner message renders as his bubble', steerBubbles >= 3, `${steerBubbles}`);
      const name = page.locator('[data-super-slot="centre"] .super-event-line-name').first();
      if (await name.count()) {
        await name.click();
        ok('…a name in the line lights its agenda row', await until(page, async () => (await page.locator('[data-testid="super-agenda"] [data-focus="true"]').count()) === 1, 5000));
      } else ok('…a name in the line lights its agenda row', false, 'no name in any event line');
      const toggle = page.locator('[data-super-slot="centre"] [data-testid="super-event-line-toggle"]').first();
      if (await toggle.count()) {
        await toggle.click();
        ok('…a click expands the super agent\'s reply', await until(page, async () => (await page.locator('[data-super-slot="centre"] [data-testid="super-event-line"][data-expanded="true"]').count()) >= 1, 5000));
        await toggle.click().catch(() => {});
      }
      const fullLines = await page.locator('[data-super-slot="centre"] [data-testid="super-event-line"][data-full="true"]').count();
      ok('…the batch the super agent escalated in renders full', fullLines >= 1 || (record().ownerBatches ?? []).length === 0, JSON.stringify({ fullLines, ownerBatches: record().ownerBatches }));

      // AC7 + D7: the super agent's own question, its options whole, the click framed.
      await sayToSuper(page, 'GO-ASKOWNER');
      const opt = page.getByTestId('super-ask-option').filter({ hasText: /^Ship it$/ });
      ok('the super agent\'s own ask heads the bar with its options drawn whole', await until(page, async () => (await opt.count()) === 1, 40000), await page.getByTestId('super-queue-head').innerText().catch(() => 'no head'));
      ok('…the band holds only the question (no counts beside it)', (await page.locator('[data-testid^="super-job-count-"]').count()) === 0);
      const tAsk = Date.now();
      await opt.click();
      ok('…a click sends exactly the drawn label, framed, into the super chat', await until(page, async () => frames().some((f) => f.role === 'super' && f.t >= tAsk && f.blocks[0] === 'Answer to your question: Ship it'), 15000));
      ok('…and closes the ask', await until(page, async () => !(record().queue ?? []).some((q) => q.kind === 'ask' && q.state !== 'done'), 15000), JSON.stringify((record().queue ?? []).filter((q) => q.kind === 'ask')));
      await until(page, async () => (await page.getByTestId('super-queue-head').count()) === 0, 15000);
    }

    // The agenda (task super-agent-ajandasi-…): always drawn left of the stage, four sections,
    // the band above the centre has no counts; it reads the pushed record (no request of its own).
    ok(`${engineName}: the agenda is drawn with its four sections`, (await page.locator('[data-testid="super-agenda"] [data-testid^="super-agenda-section-"]').count()) === 4);
    ok(`${engineName}: the band holds no counts and there is no list overlay`, (await page.locator('[data-testid^="super-job-count-"], [data-testid="super-job-list"]').count()) === 0);
    await until(page, async () => { const n = apiReqs.length; await page.waitForTimeout(2500); return apiReqs.length === n; }, 30000);
    const r0 = apiReqs.length;
    await page.waitForTimeout(1500);
    const kids = Object.keys(record().children ?? {});
    const during = apiReqs.slice(r0).filter((x) => (x.path.startsWith('/api/super/') && !x.path.startsWith('/api/super/activity')) || kids.some((k) => x.path.includes(k)));
    ok(`${engineName}: 0 requests from the agenda while it shows`, during.length === 0, JSON.stringify(during.slice(0, 5)));
    if (engineName === 'chromium') {
      for (const [w, h] of [[1280, 800], [1920, 1080]]) for (const scheme of ['light', 'dark']) {
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(OUT, `board-agenda-${w}-${scheme}.png`) });
      }
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.emulateMedia({ colorScheme: 'dark' });
    } else await page.screenshot({ path: join(OUT, `board-agenda-${engineName}.png`) });

    // D14: the centre reads 17 px, its composer 15 px; any other chat 15 px.
    const fonts = await page.evaluate(() => {
      const centre = document.querySelector('[data-super-slot="centre"] .chat-pane');
      const input = document.querySelector('[data-super-slot="centre"] .chat-cmp-input');
      const prose = centre?.querySelector('.chat-msg, .chat-md, .chat-text, p');
      const others = [...document.querySelectorAll('.chat-pane')].filter((p) => !p.closest('[data-super-slot="centre"]'));
      return {
        centreVar: centre ? getComputedStyle(centre).getPropertyValue('--chat-text').trim() : null,
        prose: prose ? getComputedStyle(prose).fontSize : null,
        input: input ? getComputedStyle(input).fontSize : null,
        othersVar: others.map((p) => getComputedStyle(p).getPropertyValue('--chat-text').trim()),
      };
    });
    ok(`${engineName}: the centre transcript reads 17 px and its composer 15 px`, /^calc\(17px|^17px/.test(fonts.centreVar ?? '') && (fonts.prose === null || fonts.prose === '17px') && fonts.input === '15px', JSON.stringify(fonts));
    ok(`${engineName}: every other chat keeps 15 px`, fonts.othersVar.every((v) => /15px/.test(v)), JSON.stringify(fonts.othersVar));

    // The cards: tone, model chip, a title of up to three lines.
    const tiles = await page.evaluate(() => [...document.querySelectorAll('.super-tile[data-tile="chat"]')].map((el) => {
      const cs = getComputedStyle(el);
      const title = el.querySelector('.super-tile-title');
      const lh = title ? parseFloat(getComputedStyle(title).lineHeight) : 0;
      return {
        kind: el.dataset.kind, tone: el.dataset.superTone, toneColor: cs.getPropertyValue('--tone').trim(),
        success: cs.getPropertyValue('--color-success').trim(), accent: cs.getPropertyValue('--color-accent').trim(),
        model: el.querySelector('[data-testid="super-card-model"]')?.textContent ?? null,
        titleLines: title && lh ? Math.round(title.getBoundingClientRect().height / lh) : 0,
        state: el.querySelector('.super-tile-state, .super-tile-asks')?.textContent ?? '',
        w: Math.round(el.closest('.super-card-frame')?.getBoundingClientRect().width ?? 0),
      };
    }));
    ok(`${engineName}: every chat tile carries a tone and keeps its state word`, tiles.length > 0 && tiles.every((x) => x.tone && x.state.trim().length > 0), JSON.stringify(tiles));
    ok(`${engineName}: an idle tile is purple (accent), a working one green (success)`, tiles.filter((x) => x.tone === 'idle').every((x) => x.toneColor === x.accent) && tiles.filter((x) => x.tone === 'working').every((x) => x.toneColor === x.success), JSON.stringify(tiles.map((x) => [x.tone, x.toneColor])));
    // A chip only from what the session reported (its system:init): the flow's children ran turns
    // in this page; a freshly opened page's children have not, and show no guess.
    if (full) ok(`${engineName}: a tile shows its model chip from the session (Opus here)`, tiles.some((x) => /^Opus/.test(x.model ?? '')), JSON.stringify(tiles.map((x) => x.model)));
    else ok(`${engineName}: no tile guesses a model it was not told`, tiles.every((x) => x.model === null || /^(Opus|Sonnet|Haiku|Fable)/.test(x.model)), JSON.stringify(tiles.map((x) => x.model)));
    ok(`${engineName}: titles take up to three lines in the 160 px tile`, tiles.every((x) => x.titleLines <= 3) && tiles.filter((x) => x.w).every((x) => Math.abs(x.w - 160) <= 1), JSON.stringify(tiles.map((x) => [x.titleLines, x.w])));

    if (full) {
      // The working ring: at most 4 turn, held by the motion clock, rest when unfocused; its cost A/B.
      await sayToSuper(page, 'GO-BUSYALL');
      ok('children are busy for the ring checks', await until(page, async () => (await page.locator('.super-tile[data-kind="working"]').count()) >= 2, 40000), `${await page.locator('.super-tile[data-kind="working"]').count()}`);
      await page.waitForTimeout(1500);
      const ring = await page.evaluate(() => {
        const spins = [...document.querySelectorAll('[data-testid="super-tile-spin"]')];
        const anims = document.getAnimations().filter((a) => a.animationName === 'superTileSpin');
        return { working: document.querySelectorAll('.super-tile[data-kind="working"]').length, on: spins.filter((s) => s.dataset.spin === 'on').length, closed: spins.filter((s) => s.dataset.spin === 'closed').length, anims: anims.length, running: anims.filter((a) => a.playState === 'running').length };
      });
      ok('the working ring turns on at most 4 tiles at once, the rest closed', ring.on >= 1 && ring.on <= 4 && ring.on + ring.closed === ring.working, JSON.stringify(ring));
      ok('…its animations are held by the motion clock (none left on the display link)', ring.anims >= 1 && ring.running === 0, JSON.stringify(ring));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const sample = async (ms) => {
        const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const frames0 = await page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n += 1; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }), ms);
        const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const per = (k) => Math.round(((m1[k] ?? 0) - (m0[k] ?? 0)) / (ms / 1000) * 10) / 10;
        return { recalcPerS: per('RecalcStyleCount'), layoutPerS: per('LayoutCount'), rafPerS: Math.round(frames0 / (ms / 1000)) };
      };
      const withRing = await sample(5000);
      await page.evaluate(() => document.documentElement.style.setProperty('--dc-motion-ambient-name', 'none'));
      await page.waitForTimeout(300);
      const restRing = await page.evaluate(() => document.getAnimations().filter((a) => a.animationName === 'superTileSpin').length);
      const without = await sample(5000);
      await page.evaluate(() => document.documentElement.style.removeProperty('--dc-motion-ambient-name'));
      report.note(`ring cost A/B (chromium, ${ring.on} turning): with ${JSON.stringify(withRing)} | rested ${JSON.stringify(without)}`);
      ok('…unfocused (the ambient name none) the ring rests: no ring animation at all', restRing === 0, `${restRing}`);
      ok('…turning costs <= 20 style recalcs a second over resting (15 fps clock)', withRing.recalcPerS - without.recalcPerS <= 20, JSON.stringify({ withRing, without }));
      await page.screenshot({ path: join(OUT, 'board-working-ring.png') });
      // The compact and the full event lines, the larger centre font, in light and dark.
      for (const [w, h] of [[1280, 800], [1800, 1130], [1920, 1080]]) for (const scheme of ['light', 'dark']) {
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(OUT, `board-closed-${w}-${scheme}.png`) });
        if (scheme === 'dark') {
          // The centre takes the height while the bottom band is empty (owner 2026-10-21).
          const g = await geo(page);
          const banded = (record().containers ?? []).some((c) => c.place === 'others') || g.others > 0 || (await page.locator('[data-testid="super-terminals-row"] button').count()) > 0;
          const below = g.s.y + g.s.h - (g.c.y + g.c.h);
          report.note(`${w}x${h}: centre ${Math.round(g.c.w)}x${Math.round(g.c.h)}, ${Math.round(below)} px below it (${banded ? 'band reserved: Others or terminals' : 'band empty'})`);
          ok(`chromium ${w}x${h}: the centre runs to the bottom margin unless the band holds something`, banded ? below >= 24 + 40 - 1 : Math.abs(below - 24) <= 1, JSON.stringify({ below, banded }));
        }
      }
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.emulateMedia({ colorScheme: 'dark' });
      // A child row asks for side by side.
      const link = page.locator('[data-testid="super-agenda-section-now"] button.super-agenda-row-btn').first();
      if (await link.count()) {
        await link.click();
        ok('a child row in the agenda opens it side by side', await until(page, async () => record().view?.mode === 'half', 8000), JSON.stringify(record().view));
      } else ok('a child row in the agenda opens it side by side', false, 'no child row in Now');
      // Leave the stage as the next sections expect it: floating, nothing side by side.
      await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'acme-app' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
      await until(page, async () => record().view?.mode === 'float', 8000);
    }
    ok(`${engineName}: no console errors on the board`, errors.length === 0, errors.slice(0, 5).join('\n'));
  } finally {
    await context.close();
    await browser.close();
  }
}

// ─── main ───────────────────────────────────────────────────────────────────────────────

let server = null;
try {
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  if (!SKIP_FLOW) {
    const browser = await pw.chromium.launch();
    try {
      const r = await flow(browser, base);
      ok('no console errors during the flow', r.errors.length === 0, r.errors.slice(0, 5).join('\n'));
      await r.context.close();
    } finally { await browser.close(); }
  }
  for (const e of ENGINES) await board(e, pw[e], base, e === 'chromium' && !SKIP_FLOW);
  for (const e of ENGINES) await motion(e, pw[e], base);
  // Light mode: the same crossfade, no flights.
  const settingsPath = join(HOME, '.dreamcontext', 'agent-ui.json');
  const saved = readFileSync(settingsPath, 'utf-8');
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(saved), lightMode: 'on' }, null, 2));
  try {
    const b = await pw.chromium.launch();
    const c = await b.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });
    const lp = await c.newPage();
    await openChat(lp, base);
    await lp.bringToFront();
    const l1 = await measured(lp, 'light take-back');
    const l2 = await measured(lp, 'light hand-over');
    const ll = [l1, l2].map(choreographyOnly);
    ok('Light mode = crossfade only (no flights, no transform in the choreography)', ll.every((r) => r.crossfadeOk), JSON.stringify(ll.map((r) => ({ flights: r.flights, who: r.who }))));
    await b.close();
  } finally { writeFileSync(settingsPath, saved); }

  // The owner's drop survives a SERVER restart (AC Layout): the same rect, the same saved pos.
  if (DRAGGED) {
    console.log('\n── the owner-placed card after a server restart');
    const b = await pw.chromium.launch();
    try {
      const c = await b.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });
      const p = await c.newPage();
      await openChat(p, base);
      if (!(await until(p, () => surfaceShown(p), 8000))) {
        await p.locator('[data-testid="super-handover-btn"]:visible').first().click();
        await until(p, () => surfaceShown(p), 15000);
      }
      await p.waitForTimeout(2000);
      const before = cardIn(await geo(p), DRAGGED)?.r;
      const posBefore = JSON.stringify(record().containers.find((x) => x.id === DRAGGED)?.pos ?? null);
      await new Promise((r) => { server.once('exit', r); server.kill(); });
      server = await startServer(port);
      await p.reload({ waitUntil: 'domcontentloaded' });
      if (!(await until(p, () => surfaceShown(p), 15000))) await openChat(p, base);
      await until(p, async () => !!cardIn(await geo(p), DRAGGED), 20000);
      await p.waitForTimeout(1500);
      const after = cardIn(await geo(p), DRAGGED)?.r;
      ok('after a server restart the owner-placed card is where he dropped it (<= 1 px)', near1(before, after), JSON.stringify({ before, after }));
      ok('…its saved position unchanged', posBefore !== 'null' && JSON.stringify(record().containers.find((x) => x.id === DRAGGED)?.pos ?? null) === posBefore, posBefore);
      await c.close();
    } finally { await b.close(); }
  }
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}
console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
console.log(`artifacts: ${OUT}`);
// A failed run keeps its scratch vault to look into; a clean one leaves nothing behind.
if (report.fails.length) console.log(`scratch: ${SCRATCH}`);
else { try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a dying server still writing: left for the OS */ } }
process.exit(report.fails.length ? 1 : 0);
