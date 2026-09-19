#!/usr/bin/env node
/**
 * The secret card and the run card — end-to-end verification in the real app.
 *
 *   npm run build && npm run verify:chat-secret-run
 *
 * Proves the two promises the feature is made of, against the real server, the real
 * `/ws/agent-chat`, the real `/api/agent/terminal` PTY bridge and a real browser:
 *
 *   SECRET  1. a `dream-view` secret block draws a masked field in the transcript
 *           2. Submit writes the value into the project's `.env` — 0600, gitignored first
 *           3. the agent receives a RECEIPT (key · file · chars · sha256) and the value
 *              appears NOWHERE: not in what the CLI received, not in a pixel of the DOM
 *           4. a `.env` that git TRACKS is refused, and the card says why
 *
 *   RUN     5. ▶ opens a real PTY in the card and the command's output appears
 *           6. it is INTERACTIVE — typing into the card reaches the process
 *           7. on exit the card posts `exit 0` + the output tail back into the conversation,
 *              so the agent continues without the user typing anything
 *           8. with the output switch off, the exit code goes back and the output does not
 *
 *   PERM    9. a Bash permission card offers ▶ Run here BESIDE Deny and Allow
 *          10. the command runs in a PTY inside that card and takes input — the thing the
 *              headless shell it was asking permission for could not do
 *          11. the blocked turn resumes: the permission is answered DENY (an allow would
 *              re-run it headless) carrying "the user ran this" + the exit code + the output
 *
 * Every phase writes a screenshot, because "did you validate it" is answered by looking.
 *
 * Same harness contract as scripts/verify/dream-actions.mjs: isolated scratch vault, fake
 * HOME, a scripted stand-in for `claude` (no tokens spent), COLLECT-DON'T-FAIL-FAST.
 *
 * The stand-in ECHOES every message it receives back into its next answer, wrapped in
 * `RECEIVED<<< >>>` — that echo is how an assertion can read what the agent was actually
 * told, which is the whole subject of checks 3, 7 and 8.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-secret-run');
// Screenshots are EVIDENCE, not an extra: "did you validate it — show me" is the standing
// question, and an assertion count cannot answer it. Written by default (into the repo's
// gitignored tmp/), overridable with VERIFY_SHOTS.
const SHOTS = process.env.VERIFY_SHOTS || join(REPO, 'tmp', 'verify-shots');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

/** The canary. If this string is ever readable outside `.env`, the feature is broken. */
const SECRET_VALUE = 'SEKRET-CANARY-1a2b3c4d5e6f';

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// Turn 1 draws a secret card and a run card. Every later turn simply reports what it was
// handed, which is what the assertions read.
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-secret-run.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false, turn = 0, pendingPermission = '';

const SECRET_BLOCK = [
  'Paste the token below and I will never see it.',
  '',
  '\\u0060\\u0060\\u0060dream-view',
  JSON.stringify({ type: 'secret', id: 'fb', title: 'Firebase CI token', file: '.env',
    fields: [{ key: 'FIREBASE_TOKEN', label: 'Token', hint: 'printed by firebase login:ci' }] }),
  '\\u0060\\u0060\\u0060',
].join('\\n');

const RUN_BLOCK = [
  'Run this one yourself.',
  '',
  '\\u0060\\u0060\\u0060dream-view',
  JSON.stringify({ type: 'run', id: 'ask', command: 'echo READY; read line; echo GOT:$line',
    why: 'it waits for you to type' }),
  '\\u0060\\u0060\\u0060',
].join('\\n');

const TRACKED_BLOCK = [
  'This one aims at a tracked file.',
  '',
  '\\u0060\\u0060\\u0060dream-view',
  JSON.stringify({ type: 'secret', id: 'tracked', title: 'Into a tracked file', file: '.env.tracked',
    fields: [{ key: 'TRACKED_KEY' }] }),
  '\\u0060\\u0060\\u0060',
].join('\\n');

// A Bash permission request, raised on demand so the third card (the ▶ on a permission
// card) can be driven end to end. The turn does NOT finish until the answer comes back —
// which is the real thing being tested: the agent is blocked while the user runs it.
function askPermission() {
  pendingPermission = 'perm-1';
  out({ type: 'control_request', request_id: 'perm-1', request: {
    subtype: 'can_use_tool', tool_name: 'Bash',
    input: { command: 'echo ASKING; read answer; echo ANSWERED:$answer' },
    description: 'Claude wants to run a command that waits for input.',
  } });
}

async function runTurn(prompt) {
  busy = true;
  turn++;
  if (prompt.includes('PERM')) {
    out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'default', slash_commands: ['compact'] });
    askPermission();
    return; // busy stays true: the turn ends when the permission is answered
  }
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: ['compact'] });
  let text;
  if (turn === 1) text = 'TURN-ONE\\n\\n' + SECRET_BLOCK + '\\n\\n' + RUN_BLOCK + '\\n\\n' + TRACKED_BLOCK;
  else text = 'TURN-' + turn + ' RECEIVED<<<' + prompt + '>>>';
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
  busy = false;
  pump();
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request' && o.request && o.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    // The permission answer. Echoed back as prose so an assertion can read exactly what the
    // agent was told — behaviour AND message, which is the whole contract of "Run here".
    if (o.type === 'control_response' && o.response && o.response.request_id === pendingPermission) {
      pendingPermission = '';
      const r = o.response.response || {};
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text',
        text: 'PERM-ANSWER<<<' + (r.behavior || '?') + '::' + (r.message || '') + '>>>' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
      busy = false;
      pump();
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
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  spawnSync('git', ['config', 'user.email', 'verify@example.com'], { cwd: PROJ });
  spawnSync('git', ['config', 'user.name', 'Verify'], { cwd: PROJ });
  // A TRACKED .env-family file, for the refusal check. Committed, so `git ls-files` sees it.
  writeFileSync(join(PROJ, '.env.tracked'), 'ALREADY=here\n');
  spawnSync('git', ['add', '.env.tracked'], { cwd: PROJ });
  spawnSync('git', ['commit', '-q', '-m', 'tracked env'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
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
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, colorScheme: theme });
  // The RUN card's ▶ is gated on `isDesktop()` — the PTY bridge is desktop-only — and
  // `isDesktop()` is a one-line check for Tauri's injected bridge. A plain Chromium has
  // none, so the button would be permanently disabled here and the whole run half would
  // go unverified. We inject the same MINIMAL bridge `task-delete-confirm.mjs` uses: the
  // object exists (so the gate reads true, exactly as it does in the real .app) while every
  // `invoke` rejects, which is the degradation path the app already handles everywhere.
  // The PTY itself is NOT faked — the server runs with DREAMCONTEXT_DESKTOP=1 and the
  // process on the other end of that socket is real.
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd) => Promise.reject(new Error(`Command ${cmd} not found`)),
      transformCallback: (cb) => cb,
      metadata: {},
    };
  });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  // The RUN card's ▶ is gated on `isDesktop()` — the PTY bridge is desktop-only — and
  // `isDesktop()` is a one-line check for Tauri's injected bridge. A plain Chromium has
  // none, so the button would be permanently disabled here and the whole run half would
  // go unverified. We inject the same MINIMAL bridge `task-delete-confirm.mjs` uses: the
  // object exists (so the gate reads true, exactly as it does in the real .app) while every
  // `invoke` rejects, which is the degradation path the app already handles everywhere.
  // The PTY itself is NOT faked — the server runs with DREAMCONTEXT_DESKTOP=1 and the
  // process on the other end of that socket is real.
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd) => Promise.reject(new Error(`Command ${cmd} not found`)),
      transformCallback: (cb) => cb,
      metadata: {},
    };
  });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  // VERIFY_DEBUG=1 traces the exec socket frame by frame. Kept because it is what separated
  // two failures that looked identical from the outside: output ARRIVING on the socket but
  // never painting (xterm pauses off-screen) versus input never being SENT (the pane's
  // click-to-focus had taken the caret). Both are fixed; the trace is how you would tell
  // them apart again.
  if (process.env.VERIFY_DEBUG) {
    const t0 = Date.now();
    page.on('websocket', (ws) => {
      if (!ws.url().includes('kind=exec')) return;
      console.log(`    [ws ${Date.now() - t0}] open ${ws.url().slice(0, 90)}`);
      ws.on('framesent', (f) => console.log(`    [ws ${Date.now() - t0}] → ${JSON.stringify(String(f.payload)).slice(0, 90)}`));
      ws.on('framereceived', (f) => console.log(`    [ws ${Date.now() - t0}] ← ${JSON.stringify(String(f.payload)).slice(0, 90)}`));
      ws.on('close', () => console.log(`    [ws ${Date.now() - t0}] close`));
      ws.on('socketerror', (e) => console.log(`    [ws ${Date.now() - t0}] error ${e}`));
    });
  }

  const vis = (sel) => page.locator(`${sel}:visible`);
  const pane = () => vis('.chat-pane').first();
  const paneText = async () => (await pane().innerText()).replace(/\s+/g, ' ');
  const busy = async () => (await vis('.chat-cmp-stop').count()) > 0;
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const waitIdle = () => until(async () => !(await busy()), 40000);
  const waitText = (s, ms = 40000) => until(async () => (await paneText()).includes(s), ms);
  // What the AGENT was handed, as it echoed it back — scoped to its last answer rather than
  // read off the whole pane. The pane also contains the live terminal, which is showing the
  // command's output on screen either way; asserting "the output was withheld" against that
  // would be a check that can never fail.
  const lastAnswer = async () => {
    const rows = vis('.chat-msg-assistant-row');
    const n = await rows.count();
    return n === 0 ? '' : (await rows.nth(n - 1).innerText()).replace(/\s+/g, ' ');
  };
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  let shotNo = 0;
  // `focus` is the card the shot is ABOUT: scrolled into view first, because a pane
  // screenshot captures wherever the transcript happens to be sitting, and a picture of the
  // composer proves nothing.
  const shot = async (name, focus) => {
    shotNo++;
    const file = join(SHOTS, `${theme}-${String(shotNo).padStart(2, '0')}-${name}.png`);
    try {
      if (focus) { await focus.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(250); }
      await pane().screenshot({ path: file });
    } catch { report.note(`· could not capture ${name}`); }
  };

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
  await page.waitForTimeout(800);

  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('GO');
  await page.keyboard.press('Enter');
  ok('the turn finishes', await waitText('TURN-ONE'));
  await waitIdle();
  await page.waitForTimeout(800);

  // ── 1 — the card is drawn ─────────────────────────────────────────────────────────
  console.log('── secret: the field is in the conversation');
  ok('two secret cards and one run card were drawn',
    (await vis('.chat-secretcard').count()) === 2 && (await vis('.chat-runcard').count()) === 1,
    `secret=${await vis('.chat-secretcard').count()} run=${await vis('.chat-runcard').count()}`);
  const field = vis('.chat-secretcard').first().locator('.masked-secret-input');
  ok('the field is masked in CSS and is NOT a password input — no OS keychain prompt',
    (await field.getAttribute('type')) === 'text'
    && (await field.evaluate((el) => getComputedStyle(el).webkitTextSecurity)) === 'disc',
    await field.getAttribute('type'));
  ok('the card states, before anything is typed, that the value does not reach the agent',
    (await vis('.chat-secretcard').first().innerText()).replace(/\s+/g, ' ').includes('Not sent to the agent'));

  // ── 2/3 — the write, and the canary ───────────────────────────────────────────────
  console.log('── secret: where the value goes, and where it does not');
  await field.fill(SECRET_VALUE);
  await shot('secret-card-filled', vis('.chat-secretcard').first());
  await vis('.chat-secretcard').first().getByRole('button', { name: /Save to/ }).click();
  ok('the card turns into a receipt', await until(async () => (await vis('.chat-secretcard-receipt').count()) > 0, 15000));

  const envPath = join(PROJ, '.env');
  ok('the value landed in the project .env', existsSync(envPath)
    && readFileSync(envPath, 'utf-8').includes(`FIREBASE_TOKEN=${SECRET_VALUE}`),
    existsSync(envPath) ? readFileSync(envPath, 'utf-8') : 'no .env');
  ok('.env is 0600', existsSync(envPath) && (statSync(envPath).mode & 0o777) === 0o600);
  ok('.gitignore covers it — written BEFORE the value',
    existsSync(join(PROJ, '.gitignore')) && readFileSync(join(PROJ, '.gitignore'), 'utf-8').includes('.env'));

  ok('the receipt on screen names the key, the size and a fingerprint',
    /FIREBASE_TOKEN/.test(await vis('.chat-secretcard-receipt').first().innerText())
    && /sha256:/.test(await vis('.chat-secretcard-receipt').first().innerText()),
    await vis('.chat-secretcard-receipt').first().innerText());

  ok('the agent was told — a receipt reached the CLI as a real turn', await waitText('TURN-2'));
  await waitIdle();
  const echoed = await paneText();
  ok('…and what it was told names the key and the file',
    echoed.includes('secret submitted') && echoed.includes('FIREBASE_TOKEN') && echoed.includes('.env'), '');
  ok('…and tells it not to read the file back', /never read the file back/.test(echoed));

  // THE CANARY. Two places, because they fail for different reasons: the CLI's stdin (the
  // value would be in the transcript on disk forever) and the rendered DOM (the value would
  // be re-readable by anyone who scrolls back).
  await shot('secret-receipt', vis('.chat-secretcard').first());
  ok('THE VALUE NEVER REACHED THE AGENT', !echoed.includes(SECRET_VALUE));
  const domHasSecret = await page.evaluate((v) => document.body.innerHTML.includes(v), SECRET_VALUE);
  ok('THE VALUE IS NOWHERE IN THE DOM once submitted', !domHasSecret);

  // ── 4 — the refusal ───────────────────────────────────────────────────────────────
  console.log('── secret: a tracked file is refused');
  const tracked = vis('.chat-secretcard').nth(1);
  await tracked.locator('.masked-secret-input').fill('does-not-matter');
  await tracked.getByRole('button', { name: /Save to/ }).click();
  ok('the card refuses and says the file is tracked by git',
    await until(async () => /tracked by git/i.test(await tracked.innerText()), 15000),
    (await tracked.innerText()).replace(/\s+/g, ' ').slice(0, 200));
  ok('…and nothing was written into the tracked file',
    readFileSync(join(PROJ, '.env.tracked'), 'utf-8') === 'ALREADY=here\n');
  await shot('secret-tracked-refused', tracked);

  // ── 5/6/7 — the run card ──────────────────────────────────────────────────────────
  console.log('── run: a real process, typed into, reporting back');
  const runCard = vis('.chat-runcard').first();
  ok('the command is shown in full before anything runs',
    (await runCard.locator('.chat-runcard-cmd').innerText()).includes('read line'));
  await runCard.scrollIntoViewIfNeeded();
  await runCard.getByRole('button', { name: /Run/ }).click();
  ok('a terminal opens inside the card', await until(async () => (await vis('.chat-runterm .xterm').count()) > 0, 15000));
  // Read the terminal through its OWN row container rather than the card's `innerText`:
  // xterm renders into absolutely-positioned rows, and a card sitting below the fold in a
  // long transcript reported an empty string for as long as it stayed there.
  const screen = () => page.evaluate(() => {
    const rows = document.querySelector('.chat-runterm .xterm-rows');
    return rows ? rows.textContent.replace(/\s+/g, ' ') : '';
  });
  ok('the process really ran — its output is on the card', await until(async () => (await screen()).includes('READY'), 20000),
    (await screen()).slice(0, 200));

  // Click the TERMINAL's own screen, not the card's padded wrapper: xterm takes focus from a
  // mousedown inside `.xterm-screen`, and a click on the 8px inset around it does nothing —
  // which is exactly how this check first "failed", with every keystroke landing in the
  // composer (whose own focus policy re-claims the caret whenever a turn settles).
  await vis('.chat-runterm .xterm-screen').first().scrollIntoViewIfNeeded();
  await vis('.chat-runterm .xterm-screen').first().click();
  await page.keyboard.type('pong');
  await page.keyboard.press('Enter');
  await shot('run-terminal-live', runCard);
  ok('the card reports the exit code', await until(async () => /exit 0/.test(await runCard.innerText()), 20000),
    (await runCard.innerText()).replace(/\s+/g, ' ').slice(0, 200));
  ok('THE TURN CONTINUES BY ITSELF — the agent was handed the outcome', await waitText('TURN-3'));
  await waitIdle();
  const afterRun = await lastAnswer();
  ok('…including the command and its exit code', afterRun.includes('ran in chat') && afterRun.includes('exit 0'), afterRun.slice(0, 200));
  ok('…and the output it printed', afterRun.includes('GOT:pong'), afterRun.slice(0, 200));
  await shot('run-reported-back', vis('.chat-msg-assistant-row').last());

  // ── 8 — the output switch ─────────────────────────────────────────────────────────
  console.log('── run: the output switch is real');
  // The switch is offered on a FINISHED card too, because there it configures the next run —
  // so it is flipped BEFORE pressing Run again, which is the only order that means anything.
  const share = runCard.locator('.chat-runcard-share input');
  ok('the output switch is reachable again on a finished card', (await share.count()) === 1);
  await share.uncheck();
  await runCard.getByRole('button', { name: /Run again/ }).click();
  await until(async () => (await vis('.chat-runterm .xterm').count()) > 0, 15000);
  await until(async () => (await screen()).includes('READY'), 20000);
  await vis('.chat-runterm .xterm-screen').first().scrollIntoViewIfNeeded();
  await vis('.chat-runterm .xterm-screen').first().click();
  await page.keyboard.type('SECOND-RUN-OUTPUT');
  await page.keyboard.press('Enter');
  ok('the second run also finishes', await until(async () => /exit 0/.test(await runCard.innerText()), 20000));
  ok('the agent hears about it', await waitText('TURN-4'));
  await waitIdle();
  const afterSecond = await lastAnswer();
  ok('with the switch off, the OUTPUT is withheld', !afterSecond.includes('GOT:SECOND-RUN-OUTPUT'), afterSecond.slice(0, 200));
  ok('…but the exit code still goes back',
    /chose not to share/.test(afterSecond) && /exit 0/.test(afterSecond), afterSecond.slice(0, 200));

  // ── 9/10/11 — the same ▶ on a PERMISSION card ─────────────────────────────────────
  console.log('── permission: Deny / ▶ Run here / Allow');
  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('PERM');
  await page.keyboard.press('Enter');
  ok('a Bash permission card arrives', await until(async () => (await vis('.chat-permcard').count()) > 0, 20000));
  const perm = vis('.chat-permcard').first();
  ok('…offering Run here BESIDE Deny and Allow, not instead of them',
    (await perm.getByRole('button', { name: /Run here/ }).count()) === 1
    && (await perm.getByRole('button', { name: /^Deny$/ }).count()) === 1
    && (await perm.getByRole('button', { name: /^Allow$/ }).count()) === 1);
  await shot('permission-card', perm);

  await perm.getByRole('button', { name: /Run here/ }).click();
  ok('the command opens in a terminal inside the permission card',
    await until(async () => (await vis('.chat-permcard .chat-runterm .xterm').count()) > 0, 15000));
  const permScreen = () => page.evaluate(() => {
    const rows = document.querySelector('.chat-permcard .xterm-rows');
    return rows ? rows.textContent.replace(/\s+/g, ' ') : '';
  });
  ok('the process is live in the card', await until(async () => (await permScreen()).includes('ASKING'), 20000),
    (await permScreen()).slice(0, 120));
  await shot('permission-running', perm);
  // Typed, but NOT asserted on screen: answering the permission unmounts the card the
  // instant the process exits, so a poll for the echo here is a race against the card's own
  // disappearance. The stronger proof is below — the text the AGENT received carries
  // `ANSWERED:by-hand`, which only exists if the keystrokes reached a live `read`.
  await vis('.chat-permcard .xterm-screen').first().scrollIntoViewIfNeeded();
  await vis('.chat-permcard .xterm-screen').first().click();
  await page.keyboard.type('by-hand');
  await page.keyboard.press('Enter');

  ok('THE BLOCKED TURN RESUMES — the agent got its answer', await waitText('PERM-ANSWER'));
  await waitIdle();
  const permAnswer = await lastAnswer();
  // DENY, and that is the load-bearing half: an allow would re-run the command headless,
  // straight back into the prompt it just hung on.
  ok('the permission is answered DENY, so the agent does not run it a second time',
    /PERM-ANSWER<<<deny::/.test(permAnswer), permAnswer.slice(0, 160));
  ok('…carrying, as the tool result, that the USER ran it', /ran this command themselves/.test(permAnswer));
  ok('…with the real exit code', /exit 0/.test(permAnswer), permAnswer.slice(0, 260));
  // This line is also what proves the card is INTERACTIVE: `ANSWERED:by-hand` can only
  // exist if the keystrokes reached a `read` that was waiting inside the permission card.
  ok('…and the output my typing produced, which is what the headless shell could not get',
    /ANSWERED:by-hand/.test(permAnswer), permAnswer.slice(0, 260));
  await shot('permission-answered', vis('.chat-msg-assistant-row').last());

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
  mkdirSync(SHOTS, { recursive: true });
  console.log(`· screenshots → ${SHOTS}`);
  console.log('· setting up scratch vault + scripted claude…');
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of (process.env.VERIFY_THEMES || 'light,dark').split(',')) {
    // Each theme is a FRESH project: the first pass writes .env and .gitignore, and the
    // second must exercise the same first-write path rather than an update.
    setupScratch();
    await runTheme(chromium, `http://127.0.0.1:${port}`, theme, report);
  }
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
for (const f of report.fails) console.log(`   ✗ ${f}`);
process.exit(report.fails.length === 0 ? 0 : 1);
