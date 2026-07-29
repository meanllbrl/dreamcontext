#!/usr/bin/env node
/**
 * Chat message-steering end-to-end verification.
 *
 * Proves the thing the queue was rebuilt for: a message submitted while a turn is in flight
 * reaches THAT turn at its next opening, instead of waiting the turn out.
 *
 *   npm run build && npm run verify:chat-steer
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/ws/agent-chat` route, and the real
 * React surface in Chromium. Nothing is imported and called directly.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is replaced, for this run only, by a scripted
 * stand-in written into an isolated fake HOME (`$SCRATCH/home/.local/bin/claude`). It speaks
 * the same stream-json protocol and reproduces the ONE CLI behaviour under test, measured
 * against real CLI 2.1.220: a `user` frame written to stdin mid-turn is held and delivered at
 * the next TOOL BOUNDARY of the running turn — everything pending at that boundary arrives
 * together, and the turn still ends in a single `result` (`num_turns` 2, not two turns).
 *
 * The fake HOME is what makes the substitution airtight: `claudeAwarePath()` resolves
 * `~/.local/bin/claude` from `homedir()`, and a HOME with no rc file cannot prepend the real
 * install back onto PATH.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST, matching verify/people-first.mjs: every check
 * prints ✓/✗ with evidence and the run continues, so one invocation reports everything that is
 * broken. Exit code is 0 iff every check in every theme passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-steer');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// Kept as a string rather than a checked-in file so the stand-in and the assertions that read
// its output can never drift apart, and so it can pick up the running node's absolute path
// (the login shell the server spawns has no guaranteed nvm on PATH).
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-steer.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0, pending = [], busy = false, awaitingAnswer = null, aborted = false, asked = false;
const inbox = [];

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request' && o.request && o.request.subtype === 'interrupt') {
      // Mirrors 2.1.220: ack, then abort with a \`result\` — the busy→idle edge that made
      // "Stop didn't stop" possible, so the pause is tested against a REAL interrupt.
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      aborted = true;
      if (awaitingAnswer) { const r = awaitingAnswer; awaitingAnswer = null; r('interrupted'); }
      continue;
    }
    if (o.type === 'control_response') {
      const behavior = (o.response && o.response.response && o.response.response.behavior) || 'unknown';
      if (awaitingAnswer) { const r = awaitingAnswer; awaitingAnswer = null; r(behavior); }
      continue;
    }
    if (o.type === 'user') {
      const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text) continue;
      if (busy) pending.push(text);            // ← THE behaviour under test
      else { inbox.push(text); pump(); }
    }
  }
});

/** Announce and clear whatever steered in since the last boundary. */
function drainAtBoundary() {
  if (!pending.length) return [];
  const got = pending; pending = [];
  got.forEach((t, i) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'STEERED[' + (i + 1) + ']: ' + t }] } }));
  return got;
}

async function step(label, prompt) {
  const id = 'toolu_' + (++seq);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo ' + label, description: label } }] } });
  await sleep(1200);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: label }] }] } });
  // THE boundary. A card, when the prompt asks for one, opens here — so a ⏎ typed during the
  // card is parked by the client and must wait for the answer before it can steer.
  if (prompt.includes('ASK') && !asked) {
    asked = true;
    out({ type: 'control_request', request_id: 'req-' + seq, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/nothing' }, description: 'Delete a scratch path' } });
    const behavior = await new Promise((r) => { awaitingAnswer = r; });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CARD ANSWERED: ' + behavior }] } });
  }
  return drainAtBoundary();
}

async function runTurn(prompt) {
  busy = true; aborted = false;
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: ['compact', 'effort'] });
  const got = [];
  got.push(...await step('STEP-A', prompt));
  if (!aborted) got.push(...await step('STEP-B', prompt));
  if (aborted) {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'ABORTED', num_turns: 1, terminal_reason: 'aborted_tools', total_cost_usd: 0, usage: {}, session_id: 'verify-session' });
  } else {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE: ' + prompt + ' | picked up ' + got.length }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE: ' + prompt, num_turns: 1 + got.length, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
  }
  busy = false;
  // Anything that arrived after the last boundary belongs to the NEXT turn — as the real CLI does.
  if (pending.length) { inbox.push(...pending); pending = []; }
  pump();
}

let pumping = false;
async function pump() {
  if (pumping || busy) return;
  const next = inbox.shift();
  if (next === undefined) return;
  pumping = true;
  try { await runTurn(next); } finally { pumping = false; }
}
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

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  // Presence-based fake sign-in; the token never reaches the network in this run.
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/some-code-repo.git'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  // A PATH without the REAL claude's directory, so the only `claude` the spawned login shell
  // can resolve is the stand-in `claudeAwarePath()` appends from the fake HOME.
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

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function runTheme(chromium, base, theme, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  // Every locator is VISIBILITY-filtered: a restored session leaves hidden panes in the DOM,
  // and `.first()` alone will happily grab a minimized composer.
  const vis = (sel) => page.locator(`${sel}:visible`);
  const pane = () => vis('.chat-pane').first();
  const composer = () => vis('.chat-cmp-input').first();
  const paneText = async () => (await pane().innerText()).replace(/\s+/g, ' ');
  const busy = async () => (await vis('.chat-cmp-stop').count()) > 0;
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const waitBusy = () => until(busy, 10000);
  const waitIdle = () => until(async () => !(await busy()), 25000);
  const waitText = (s, ms = 25000) => until(async () => (await paneText()).includes(s), ms);
  const type = async (t) => { await composer().click(); await composer().fill(t); await page.waitForTimeout(120); };
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const sendNow = (n = 1) => vis('.chat-queue-row').getByRole('button', { name: new RegExp(`Send queued message ${n} now`) });

  console.log(`\n═══ ${theme} ═══`);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  ok('a chat session opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  await page.waitForTimeout(1000);

  // S1 — ⏎ while busy steers into the running turn.
  console.log('── S1: ⏎ while busy steers into the running turn');
  await type('P1');
  await page.keyboard.press('Enter');
  ok('a turn starts (Stop appears)', await waitBusy());
  await page.waitForTimeout(250);
  await type('S1-CORRECTION');
  ok('while busy the toolbar offers Stop, Queue(⇡) AND Send(↑) — three live actions',
    (await vis('.chat-cmp-stop').count()) === 1 && (await vis('.chat-cmp-queue').count()) === 1
    && (await vis('.chat-cmp-send').count()) === 1);
  const sendTitle = await vis('.chat-cmp-send').first().getAttribute('title');
  ok('↑ says it goes into the RUNNING turn, not "queue for the next"', /running turn/i.test(sendTitle ?? ''), sendTitle);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  ok('⏎ did NOT queue it — no queue strip appeared', (await vis('.chat-queue').count()) === 0);
  ok('it is in the transcript immediately', (await paneText()).includes('S1-CORRECTION'));
  ok('and is marked "sent mid-turn", because the tool calls below it predate it',
    (await vis('.chat-msg-steered').count()) >= 1);
  ok('the composer is empty again (committed, not left behind)', (await composer().inputValue()) === '');
  ok('the CLI picked it up AT THE NEXT BOUNDARY, mid-turn', await waitText('STEERED[1]: S1-CORRECTION'));
  ok('…and it arrived BEFORE the turn ended', !(await paneText()).includes('DONE: P1'));
  ok('the turn ends ONCE, having consumed it (same turn, not a second one)', await waitText('DONE: P1 | picked up 1'));
  await waitIdle();

  // S2 — ⇡ still holds for the next turn.
  console.log('── S2: ⇡ holds for the next turn');
  await type('P2');
  await page.keyboard.press('Enter');
  ok('turn 2 starts', await waitBusy());
  await page.waitForTimeout(250);
  await type('Q2-LATER');
  await vis('.chat-cmp-queue').first().click();
  await page.waitForTimeout(400);
  ok('⇡ produced a queue strip', (await vis('.chat-queue').count()) === 1);
  const strip = (await vis('.chat-queue').innerText()).replace(/\s+/g, ' ');
  ok('the row holds the text', strip.includes('Q2-LATER'), strip);
  ok('the strip says it waits for the turn to end', /sends when this turn ends/.test(strip), strip);
  ok('the row offers Send now', (await sendNow().count()) === 1);
  ok('the running turn ends having picked up NOTHING — ⇡ really held it', await waitText('DONE: P2 | picked up 0'));
  ok('then the held message goes out on its own turn', await waitText('DONE: Q2-LATER'));
  ok('and the strip is empty again', (await vis('.chat-queue').count()) === 0);
  await waitIdle();

  // S3 — a queued row's Send now cuts into the running turn.
  console.log('── S3: a queued row\'s Send now cuts in');
  await type('P3');
  await page.keyboard.press('Enter');
  ok('turn 3 starts', await waitBusy());
  await page.waitForTimeout(250);
  await type('Q3-JUMP');
  await vis('.chat-cmp-queue').first().click();
  await page.waitForTimeout(400);
  ok('the row is queued first', (await vis('.chat-queue-row').count()) === 1);
  await sendNow().click();
  await page.waitForTimeout(400);
  ok('Send now empties the strip', (await vis('.chat-queue').count()) === 0);
  ok('and the message is in the transcript, marked mid-turn',
    (await paneText()).includes('Q3-JUMP') && (await vis('.chat-msg-steered').count()) >= 2);
  ok('the RUNNING turn picks it up — it jumped the line, it did not wait', await waitText('STEERED[1]: Q3-JUMP'));
  ok('same turn, one result', await waitText('DONE: P3 | picked up 1'));
  await waitIdle();

  // S4 — ⏎ during an open card parks, then auto-steers at the first opening.
  console.log('── S4: ⏎ during a permission card parks, then takes the first opening');
  await type('P4 ASK');
  await page.keyboard.press('Enter');
  ok('turn 4 starts', await waitBusy());
  ok('a permission card opens', await until(async () => (await vis('.chat-permcard').count()) > 0, 15000));
  await type('S4-AFTERCARD');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  ok('⏎ neither vanished nor talked over the card — it parked as a row',
    (await vis('.chat-queue-row').count()) === 1);
  const parked = (await vis('.chat-queue').innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('the strip says it is owed the FIRST OPENING, not the end of the turn',
    /sends at the first opening/.test(parked), parked);
  ok('its Send now is disabled while the card is open', await sendNow().isDisabled().catch(() => false));
  const allow = vis('.chat-permcard').getByRole('button', { name: 'Allow' }).first();
  ok('the card has an approve action', (await allow.count()) > 0);
  await allow.click();
  await page.waitForTimeout(400);
  ok('answering the card auto-steers the parked row (no second click needed)',
    await until(async () => (await vis('.chat-queue').count()) === 0, 10000));
  ok('and the SAME running turn receives it', await waitText('STEERED[1]: S4-AFTERCARD'));
  ok('one turn, one result', await waitText('DONE: P4 ASK | picked up 1'));
  await waitIdle();

  // S5 — Stop still pauses the queue (the regression the first cut existed to prevent).
  console.log('── S5: Stop still pauses the queue');
  await type('P5');
  await page.keyboard.press('Enter');
  ok('turn 5 starts', await waitBusy());
  await page.waitForTimeout(250);
  await type('Q5-MUST-NOT-FIRE');
  await vis('.chat-cmp-queue').first().click();
  await page.waitForTimeout(300);
  ok('a row is queued', (await vis('.chat-queue-row').count()) === 1);
  await vis('.chat-cmp-stop').first().click();
  await page.waitForTimeout(3000);
  const paused = (await vis('.chat-queue').innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('the strip says paused', /paused/.test(paused), paused);
  ok('and offers Resume, not a second "Send now" meaning something else', /Resume/.test(paused), paused);
  ok('the interrupt\'s own busy→idle edge did NOT fire the queued message',
    !(await paneText()).includes('DONE: Q5-MUST-NOT-FIRE'));
  ok('the row is still there — nothing was destroyed', (await vis('.chat-queue-row').count()) === 1);
  await vis('.chat-queue').getByRole('button', { name: 'Resume' }).click();
  ok('Resume sends it', await waitText('DONE: Q5-MUST-NOT-FIRE'));

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
  for (const theme of ['light', 'dark']) {
    // Each theme starts from a clean roster, so a restored pane can never shadow the live one.
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    await runTheme(chromium, `http://127.0.0.1:${port}`, theme, report);
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
