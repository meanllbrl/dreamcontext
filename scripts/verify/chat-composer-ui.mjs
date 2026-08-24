#!/usr/bin/env node
/**
 * The redesigned Chat composer and its MODE wiring — end-to-end verification.
 *
 *   npm run build && npm run verify:chat-composer
 *
 * Proves, in the real app against the real server, the four things wave 3 (D1-E1) is
 * responsible for and the composer chrome wave 2 landed underneath it:
 *
 *   §§A  the three menus behave as one set — one open at a time, Esc closes only the top
 *        overlay, the effort slider walks every level, and the mode menu has NO
 *        "Set as default" (owner call: a mode is a per-session choice)
 *   §9   Plan → Develop hands off WITHOUT ESCALATING: a new tab lands at the plan tab's
 *        index, the plan tab closes, the new session's WS upgrade carries `bypass=0`, and
 *        its trigger reads `auto` — inside a project whose REMEMBERED default is `bypass`
 *   §10  neither a mode switch nor a Session-ended Resume re-inherits that remembered
 *        default: the scripted `claude` echoes its own `--permission-mode` argv and it is
 *        still `auto` after both
 *   §11  the shared dismiss/overlay effect extracted out of `SkillPickerPopover` did not
 *        break `Popover` — for the chat composer's Attach menu OR the legacy Terminal
 *        composer's Skills picker
 *   §12  a mode switch does not eat what the user STAGED — the half-typed message, the reply
 *        quote, or the attachment chips. The switch respawns the process and unmounts the pane
 *        holding all three, so they survive only because the draft is carried onto the incoming
 *        session (`carryDraftInto`) and the quote + chips are keyed by conversation id
 *        (`composerScratch`). Asserted against the real textarea, the real quote row and a real
 *        pasted-and-uploaded image — including that its preview still RENDERS, which is what
 *        proves the object URL was not revoked when the old pane went away
 *
 * WHAT MAKES THE PERMISSION ASSERTIONS HONEST: the stand-in echoes its OWN argv. A UI that
 * renders "auto" over a process spawned `--permission-mode bypassPermissions` would pass a
 * DOM-only check and fail this one. The WS URL is captured independently (an init script
 * wraps `window.WebSocket`), so the client's request and the server's spawn are both pinned.
 *
 * SCRATCH HOME, ALWAYS. Every fixture — vault registry, agent-ui.json, the fake `claude` —
 * is written under an isolated HOME that the server is spawned with. No verify script may
 * read or write the developer's real `~/.claude.json` or `~/.claude/`: that file holds
 * oauthAccount / machineID / accountUuid and spend history.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST (matching verify/dream-actions.mjs): every check
 * prints ✓/✗ with evidence and the run continues. Exit 0 iff everything passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-composer');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

const SLUG = 'ship-the-pinned-shelf';

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// It answers every turn with the two facts this script exists to check — the permission mode
// it was actually spawned under, and which mode brief (if any) rode in on
// `--append-system-prompt-file`. Both are read from its OWN argv, so no assertion here can be
// satisfied by the UI merely claiming something.
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-composer-ui.mjs. */
const fs = require('fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false;

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };

const PERM = flag('--permission-mode') || 'none';
// The mode brief is APPENDED to CHAT_SURFACE_BRIEFING in one file (see chat-modes.ts), so the
// heading is what identifies it. No heading = Basic, i.e. the surface briefing alone.
let MODE = 'none';
const briefPath = flag('--append-system-prompt-file');
if (briefPath) {
  try {
    const m = /^# Mode: (.+)$/m.exec(fs.readFileSync(briefPath, 'utf-8'));
    if (m) MODE = m[1].trim();
  } catch { /* no brief readable — MODE stays 'none' */ }
}
const FACTS = 'FACTS perm=' + PERM + ' mode=' + MODE;

/** The hand-off button a Plan agent writes at the end of its planning turn. */
const DEVELOP_BUTTON = [
  '\`\`\`dream-actions',
  JSON.stringify([{ label: 'Go to development', action: 'develop', id: ${JSON.stringify(SLUG)} }]),
  '\`\`\`',
].join('\\n');

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5',
        cwd: process.cwd(), permissionMode: PERM, slash_commands: ['compact'] });
  await sleep(120);
  const wantsButton = prompt.includes('PLANDONE');
  out({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: FACTS + (wantsButton ? '\\n\\n' + DEVELOP_BUTTON : '') },
  ] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1,
        total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
  busy = false;
  // "DIE" makes the child exit for real, so the pane shows the Session-ended banner whose
  // Resume path §10 checks. stdin EOF is the graceful exit everywhere else.
  if (prompt.includes('DIE')) { await sleep(150); process.exit(0); }
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
    if (o.type === 'control_request') {
      const req = o.request || {};
      // Mirror the REAL CLI's asymmetry (2.1.220, measured through this very route — see the
      // \`setPermissionMode\` arm in src/server/routes/agent-chat.ts): a live switch INTO
      // \`bypassPermissions\` is REFUSED by a process that did not boot with
      // \`--dangerously-skip-permissions\`, while a switch back to \`auto\` lands. Acking
      // everything success — which this stand-in used to do — tested a path production never
      // takes and let a regression through in which Bypass was simply unreachable: the client
      // took its respawn fallback and the fallback re-adopted the mode being left. The
      // refusal is the interesting case, so it has to be the scripted one.
      if (req.subtype === 'set_permission_mode' && req.mode === 'bypassPermissions'
          && PERM !== 'bypassPermissions') {
        out({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id,
              error: 'Cannot set permission mode to bypassPermissions because the session was not '
                   + 'launched with --dangerously-skip-permissions' } });
        continue;
      }
      // Everything else acks success. \`set_permission_mode\` → \`auto\` MUST, because the
      // client only keeps \`session.bypass\` in lockstep on a successful ack, and B3's whole
      // argument is that \`cs.bypass\` is therefore the session's real current mode.
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
`;

// ─── setup (mirrors scripts/verify/dream-actions.mjs) ────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Read the Agents-surface preference file back OUT of the scratch HOME — the real
 *  `~/.dreamcontext/agent-ui.json` the server persists to, never the developer's own. */
function readAgentUi() {
  try { return JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), 'utf-8')); }
  catch { return null; }
}

/** Write the Agents-surface preference file INSIDE the scratch HOME. */
function writeAgentUi(chatView) {
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  // A task document for the hand-off to land on, so the Develop session's seeded prompt
  // names something that exists.
  writeFileSync(join(PROJ, '_dream_context', 'state', `${SLUG}.md`),
    '---\nid: task_verify\nname: Ship the pinned shelf\nstatus: todo\n---\n\n## Acceptance Criteria\n\n- [ ] it ships\n');
  writeAgentUi(true);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

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

/** Record every chat WebSocket URL the app opens, before the app boots. This is the client
 *  half of the permission assertion — the stand-in's argv echo is the server half. */
const WS_SPY = `
  window.__dcChatSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    try { if (String(url).includes('/api/agent/chat')) window.__dcChatSockets.push(String(url)); } catch {}
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);
`;

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function run(chromium, base, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: 'dark' });
  await page.addInitScript(WS_SPY);
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  const vis = (sel) => page.locator(`${sel}:visible`);
  const ok = (label, cond, detail) => report.check(label, cond, detail);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };
  const paneText = async () => (await vis('.chat-pane').first().innerText()).replace(/\s+/g, ' ');
  const waitText = (s, ms = 30000) => until(async () => (await paneText()).includes(s), ms);
  /** The permission word on the composer's LEFT trigger — the security indicator itself. */
  const permWord = async () => (await vis('.chat-cmp-modeltrigger').first()
    .locator('.chat-cmp-modeltrigger-effort').innerText()).trim();
  const modeWord = async () => (await vis('.chat-cmp-modeltrigger').first()
    .locator('.chat-cmp-modeltrigger-model').innerText()).trim();
  const sockets = () => page.evaluate(() => window.__dcChatSockets ?? []);
  const openSurface = async () => {
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
    if (!(await page.locator('.agent-surface.expanded').count())) {
      for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
        if (await page.locator('.agent-surface.expanded').count()) break;
      }
    }
  };
  /** Send a prompt into the focused chat composer and wait for the stand-in's answer. */
  const say = async (text) => {
    await vis('.chat-cmp-input').first().click();
    await vis('.chat-cmp-input').first().fill(text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  };

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await openSurface();
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  ok('a chat session opens against the real WS route',
    await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  await page.waitForTimeout(700);

  // ── §A — the chrome the menus live in ────────────────────────────────────────────
  console.log('\n── §A the composer chrome');
  ok('the toolbar has both triggers, the attach icon and the send disc',
    (await vis('.chat-cmp-modeltrigger').count()) === 2
    && (await vis('.chat-cmp-iconbtn').count()) === 1
    && (await vis('.chat-cmp-send').count()) === 1,
    `triggers=${await vis('.chat-cmp-modeltrigger').count()} icon=${await vis('.chat-cmp-iconbtn').count()}`);
  ok('the old pill/readout chrome is gone',
    (await page.locator('.chat-cmp-pill').count()) === 0
    && (await page.locator('.chat-cmp-readout').count()) === 0
    && (await page.locator('.chat-permmode-chip').count()) === 0);

  const modeTrigger = () => vis('.chat-cmp-modeltrigger').first();
  const modelTrigger = () => vis('.chat-cmp-modeltrigger').nth(1);

  await modeTrigger().click();
  await page.waitForTimeout(250);
  ok('the mode menu opens', (await vis('.chat-cmp-modemenu').count()) === 1);
  // Three checks, not one `&&`: a compound assertion that fails tells you nothing about
  // which half broke, which is exactly the debugging cost a verify script exists to remove.
  ok('…with one row per mode',
    (await vis('.chat-cmp-modemenu .chat-cmp-modelrow').count()) === 4,
    `rows=${await vis('.chat-cmp-modemenu .chat-cmp-modelrow').count()}`);
  ok('…J.A.R.V.I.S is rendered but unpickable',
    (await page.locator('.chat-cmp-modemenu .chat-cmp-modelrow[disabled]').count()) === 1,
    `disabled=${await page.locator('.chat-cmp-modemenu .chat-cmp-modelrow[disabled]').count()}`);
  // Case-INSENSITIVE on purpose: `.chat-cmp-badge` is `text-transform: uppercase`, so
  // `innerText` returns "SOON" while the source says "Soon". Asserting the rendered casing
  // would pin a style rule from a test that is about the CONTENT of the badge.
  ok('…and badged "Soon"',
    (await page.locator('.chat-cmp-modemenu .chat-cmp-badge').first().innerText()).trim().toLowerCase() === 'soon',
    await page.locator('.chat-cmp-modemenu .chat-cmp-badge').first().innerText().catch(() => '<none>'));
  ok('…and NO "Set as default" — a mode is a per-session choice (owner call)',
    (await page.locator('.chat-cmp-modemenu .chat-cmp-setdefault').count()) === 0);

  await modelTrigger().click();
  await page.waitForTimeout(250);
  ok('opening the model menu CLOSES the mode menu — one panel at a time',
    (await vis('.chat-cmp-modelmenu[aria-label="Model and reasoning effort"]').count()) === 1
    && (await page.locator('.chat-cmp-modemenu').count()) === 0);

  const slider = vis('.chat-cmp-effort-slider').first();
  ok('the effort slider is present and spans every level', (await slider.count()) === 1);
  if (await slider.count()) {
    const max = Number(await slider.getAttribute('max'));
    await slider.fill('0');
    await page.waitForTimeout(200);
    const low = (await vis('.chat-cmp-effort-value').innerText()).trim();
    await slider.fill(String(max));
    await page.waitForTimeout(200);
    const high = (await vis('.chat-cmp-effort-value').innerText()).trim();
    ok('…and dragging it moves the reported effort', low !== high && !!low && !!high, `${low} → ${high}`);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc closes the open panel', (await page.locator('.chat-cmp-modelmenu').count()) === 0);

  // ── §A2 — "Set as default" writes through to ~/.dreamcontext/agent-ui.json (AC 13) ──
  //
  // Not a DOM-only check. The label flip is a RECEIPT, and a receipt is only honest if the
  // write behind it happened — so this reads the file the server actually persisted, under
  // the scratch HOME, and compares it to what the composer was showing when the button was
  // pressed. A button that flips to "Saved as default" over a write that never landed would
  // pass a label assertion and fail this one.
  console.log('\n── §A2 "Set as default" (AC 13)');
  await modelTrigger().click();
  await page.waitForTimeout(250);
  const footer = vis('.chat-cmp-setdefault').first();
  ok('the model menu HAS a "Set as default" footer', (await footer.count()) === 1);
  if (await footer.count()) {
    // Pin a known effort first, so the assertion below has an exact expected value rather
    // than whatever the CLI happened to default to.
    const s2 = vis('.chat-cmp-effort-slider').first();
    await s2.fill('0');
    await page.waitForTimeout(250);
    const wantEffort = (await vis('.chat-cmp-effort-value').innerText()).trim().toLowerCase();
    const wantModelLabel = (await modelTrigger().locator('.chat-cmp-modeltrigger-model').innerText()).trim();
    ok('…reading "Set as default" before the click',
      (await footer.innerText()).trim() === 'Set as default', await footer.innerText());

    await footer.click();
    await page.waitForTimeout(300);
    ok('…the label flips to "Saved as default"',
      (await vis('.chat-cmp-setdefault').first().innerText()).trim() === 'Saved as default',
      await vis('.chat-cmp-setdefault').first().innerText());

    // The POST is fire-and-forget from the client, so poll rather than assuming one tick.
    const landed = await until(async () => {
      const ui = readAgentUi();
      return !!ui && !!ui.chatDefaultModel && ui.chatDefaultEffort === wantEffort;
    }, 8000);
    const ui = readAgentUi();
    ok('…and agent-ui.json under the scratch HOME carries the effort', landed,
      JSON.stringify({ want: wantEffort, got: ui && ui.chatDefaultEffort }));
    ok('…and the model the composer was showing',
      !!ui && typeof ui.chatDefaultModel === 'string'
        && ui.chatDefaultModel.toLowerCase().includes(wantModelLabel.toLowerCase()),
      JSON.stringify({ label: wantModelLabel, got: ui && ui.chatDefaultModel }));

    // A receipt beside a value you have since changed is a false one.
    await vis('.chat-cmp-effort-slider').first().fill('1');
    await page.waitForTimeout(300);
    ok('…and changing the effort afterwards clears the receipt',
      (await vis('.chat-cmp-setdefault').first().innerText()).trim() === 'Set as default',
      await vis('.chat-cmp-setdefault').first().innerText());
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // ── §11a — the shared Popover primitive still works (the extraction guard) ────────
  console.log('\n── §11a the extracted dismiss effect (chat Attach popover)');
  await vis('.chat-cmp-iconbtn').first().click();
  await page.waitForTimeout(250);
  ok('the Attach popover opens', (await vis('.agent-composer-menu').count()) === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('…Esc closes it', (await page.locator('.agent-composer-menu').count()) === 0);
  await vis('.chat-cmp-iconbtn').first().click();
  await page.waitForTimeout(250);
  await vis('.chat-cmp-input').first().click();
  await page.waitForTimeout(250);
  ok('…an outside click closes it', (await page.locator('.agent-composer-menu').count()) === 0);

  // ── the baseline turn: what did this session actually spawn under? ────────────────
  console.log('\n── baseline: the stand-in echoes its own argv');
  await say('HELLO');
  ok('the turn finishes', await waitText('FACTS'));
  ok('a fresh chat runs under `auto` and carries NO mode brief',
    (await paneText()).includes('FACTS perm=auto mode=none'), await paneText());
  ok('…and the trigger says the same', (await permWord()) === 'auto' && (await modeWord()) === 'Basic',
    `${await modeWord()} / ${await permWord()}`);

  // ── the project now REMEMBERS bypass — every check below runs against that ────────
  console.log('\n── the project default is switched to bypass (the escalation trap)');
  const preBypassSockets = (await sockets()).length;
  await modeTrigger().click();
  await page.waitForTimeout(250);
  await vis('.chat-cmp-segment-opt.is-bypass').first().click();
  await page.waitForTimeout(600);
  // The CLI REFUSED the live switch (the stand-in mirrors 2.1.220), so the only route to
  // Bypass is the respawn fallback. All three of these have to hold, and the last one is the
  // one that actually matters: a chip reading "bypass" over a process still running `auto` is
  // exactly the lie this whole section exists to catch.
  ok('picking Bypass reaches THIS session — via the respawn fallback the CLI forces',
    await until(async () => (await permWord()) === 'bypass', 20000), await permWord());
  const bypassSockets = (await sockets()).slice(preBypassSockets);
  ok('…the fallback\'s WS upgrade carries bypass=1',
    bypassSockets.length > 0 && bypassSockets.some((u) => u.includes('bypass=1')),
    JSON.stringify(bypassSockets.map((u) => u.slice(-120))));
  await say('WHOAMI');
  ok('…and the PROCESS is genuinely on bypassPermissions, not just the chip',
    await until(async () => (await paneText()).includes('perm=bypassPermissions'), 20000), await paneText());

  // ── §9 — Plan → Develop, inside a bypass-remembered project ──────────────────────
  console.log('\n── §9 the Plan → Develop hand-off');
  const tabsBefore = await vis('.agent-tab').count();
  const socketsBefore = (await sockets()).length;
  await say('PLANDONE');
  ok('the plan turn produced the hand-off button',
    await until(async () => (await vis('.chat-action-btn[data-action="develop"]').count()) > 0, 20000));
  await vis('.chat-action-btn[data-action="develop"]').first().click();
  ok('a Develop session opens',
    await until(async () => (await modeWord()) === 'Develop', 25000), await modeWord());
  await page.waitForTimeout(900);
  ok('the plan tab is gone and the tab count is unchanged — replaced in place, not stacked',
    (await vis('.agent-tab').count()) === tabsBefore,
    `before=${tabsBefore} after=${await vis('.agent-tab').count()}`);

  const fresh = (await sockets()).slice(socketsBefore);
  ok('the hand-off\'s WS upgrade carries bypass=0 …',
    fresh.length > 0 && fresh.every((u) => u.includes('bypass=0')), JSON.stringify(fresh.map((u) => u.slice(-120))));
  ok('…and mode=develop', fresh.some((u) => u.includes('mode=develop')), JSON.stringify(fresh.map((u) => u.slice(-120))));

  await say('WHOAMI');
  ok('the Develop process was SPAWNED under auto, though the project remembers bypass',
    await until(async () => (await paneText()).includes('perm=auto'), 20000), await paneText());
  ok('…and it carries the Develop brief', (await paneText()).includes('mode=Develop'), await paneText());
  ok('…and the trigger tells the truth rather than the project default (B2a)',
    (await permWord()) === 'auto', await permWord());

  // ── §9b — the segment reads per-session but WRITES per-project, and says so ───────
  //
  // Driven in the one state where the two scopes genuinely disagree: a hand-off session
  // running `auto` inside a project that remembers `bypass`. The display must show the
  // session (or the chip lies about the process) and the note must show the project (or a
  // click silently rewrites every other chat in the project). Both, at once, or neither is
  // trustworthy.
  console.log('\n── §9b the permission segment names BOTH scopes');
  await modeTrigger().click();
  await page.waitForTimeout(300);
  const notes = (await vis('.chat-cmp-modemenu .chat-cmp-permnote').allInnerTexts()).join(' | ');
  ok('the menu states that a permission change reaches the whole project',
    /every chat in this project/i.test(notes), notes);
  ok('…and names the PROJECT default (bypass) …', /project default:\s*bypass/i.test(notes), notes);
  ok('…while the segment still shows THIS session (auto) — the scopes are named, not merged',
    (await vis('.chat-cmp-segment-opt.is-auto.is-active').count()) === 1
    && (await page.locator('.chat-cmp-segment-opt.is-bypass.is-active').count()) === 0,
    `auto-active=${await vis('.chat-cmp-segment-opt.is-auto.is-active').count()} bypass-active=${await page.locator('.chat-cmp-segment-opt.is-bypass.is-active').count()}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // ── §10 — a mode switch must not re-inherit the remembered default ───────────────
  console.log('\n── §10 the mode switch keeps the session\'s own permission');
  await modeTrigger().click();
  await page.waitForTimeout(250);
  await vis('.chat-cmp-modemenu .chat-cmp-modelrow').nth(1).click(); // Plan
  ok('the session comes back in Plan mode',
    await until(async () => (await modeWord()) === 'Plan', 25000), await modeWord());
  await page.waitForTimeout(700);
  await say('WHOAMI');
  ok('the respawn is STILL auto — a mode switch cannot escalate (B3)',
    await until(async () => (await paneText()).includes('perm=auto'), 20000), await paneText());
  ok('…and it is now briefed as Plan', (await paneText()).includes('mode=Plan'), await paneText());
  ok('…and the trigger agrees', (await permWord()) === 'auto', await permWord());

  // ── §10b — the Session-ended Resume path keeps it too ────────────────────────────
  console.log('\n── §10b the Session-ended Resume path');
  await say('DIE');
  const banner = await until(async () => (await vis('.chat-banner-ended').count()) > 0, 25000);
  ok('the process exit raises the Session-ended banner', banner);
  if (banner) {
    await vis('.chat-banner-ended button').first().click();
    ok('the conversation comes back',
      await until(async () => (await vis('.chat-cmp-input').count()) > 0, 25000));
    await page.waitForTimeout(700);
    await say('WHOAMI');
    ok('the resumed session is STILL auto — Resume cannot escalate either (B3)',
      await until(async () => (await paneText()).includes('perm=auto'), 20000), await paneText());
    ok('…and it kept its Plan brief across the restart',
      (await paneText()).includes('mode=Plan'), await paneText());
  }

  // ── §12 — the mode switch keeps everything the user STAGED but did not send ───────
  // The point of doing this LIVE rather than in a unit test: survival depends on a React
  // remount happening in the right order (the fresh Composer reading state written before it
  // ever mounted). No source scan can see that, and an assertion on the store would pass even
  // if the box came back empty. So this reads the actual input, the actual quote row, and the
  // actual chip — after an actual process respawn.
  //
  // The chip's `<img>` is checked with `naturalWidth`, not just for presence: that is the ONE
  // assertion that proves the preview's object URL was not revoked when the old pane unmounted,
  // which was the reason the chips could not simply be copied across like the draft.
  console.log('\n── §12 a mode switch keeps the draft, the quote and the chips');
  if (await vis('.chat-cmp-input').count()) {
    const DRAFT = 'half-typed: do not eat this';
    const sockets0 = (await sockets()).length;

    // (a) a half-typed message
    await vis('.chat-cmp-input').first().click();
    await vis('.chat-cmp-input').first().fill(DRAFT);

    // (b) a reply quote — state 11's ↩ on the last thing Claude said. HOVER first, then click:
    // the action bar is `pointer-events: none` until its row is hovered, so a forced click at
    // those coordinates lands on whatever is underneath and silently does nothing.
    const msgRow = page.locator('.chat-msg-assistant-row').last();
    const quoteBtn = msgRow.locator('button[aria-label="Quote-reply"]');
    ok('the transcript offers Quote-reply', (await quoteBtn.count()) > 0);
    await msgRow.hover().catch(() => {});
    await quoteBtn.click().catch(() => {});
    ok('…and a quote row opens on the composer',
      await until(async () => (await vis('.chat-cmp-quote').count()) > 0, 10000));
    const quoteText = await vis('.chat-cmp-quote-text').first().innerText().catch(() => '');
    // Non-vacuity: if the click missed, `quoteText` would be '' and the post-respawn comparison
    // below would pass by comparing two empty strings. This is what stops that.
    ok('…carrying the message it is replying to', quoteText.trim().length > 0, JSON.stringify(quoteText));

    // (c) a pasted image, uploaded for real through POST /api/agent/drop
    await page.evaluate(() => {
      const ta = document.querySelector('.chat-cmp-input');
      if (!ta) return;
      // A real 1×1 PNG: the upload writes real bytes into the vault temp dir, so the chip ends
      // up holding a path a Claude session could actually read.
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'pasted-shot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const chipReady = await until(async () => (await vis('.chat-cmp-attachment[data-state="ready"]').count()) > 0, 20000);
    ok('a pasted image becomes a chip and its upload settles',
      chipReady, await vis('.chat-cmp-attachments').first().innerText().catch(() => '<no row>'));

    // …now respawn the process under a new brief.
    await modeTrigger().click();
    await page.waitForTimeout(250);
    await vis('.chat-cmp-modemenu .chat-cmp-modelrow').nth(2).click();   // Plan → Develop
    ok('the session comes back in Develop mode',
      await until(async () => (await modeWord()) === 'Develop', 25000), await modeWord());
    // Proof the pane really was replaced rather than re-rendered: a second WS upgrade. Without
    // this, a switch that silently no-op'd would make every assertion below vacuous.
    ok('…having genuinely respawned the process (a new WS upgrade)',
      await until(async () => (await sockets()).length > sockets0, 25000),
      `${sockets0} → ${(await sockets()).length}`);

    ok('…and the half-typed message is STILL in the box',
      await until(async () => (await vis('.chat-cmp-input').first().inputValue()) === DRAFT, 25000),
      JSON.stringify(await vis('.chat-cmp-input').first().inputValue().catch(() => '<gone>')));
    ok('…and the reply quote is still queued',
      await until(async () => (await vis('.chat-cmp-quote-text').first().innerText().catch(() => '')) === quoteText, 15000),
      `${JSON.stringify(quoteText)} → ${JSON.stringify(await vis('.chat-cmp-quote-text').first().innerText().catch(() => '<gone>'))}`);
    ok('…and the attachment chip is still staged, still ready to send',
      await until(async () => (await vis('.chat-cmp-attachment[data-state="ready"]').count()) > 0, 15000),
      await vis('.chat-cmp-attachments').first().innerText().catch(() => '<no row>'));
    // The object URL survived the unmount — a revoked blob renders at naturalWidth 0.
    ok('…and its preview still resolves (the object URL was not revoked on unmount)',
      await until(async () => page.evaluate(() => {
        const img = document.querySelector('.chat-cmp-attachment-image .chat-cmp-thumb, .chat-cmp-thumb');
        return !!img && img.complete && img.naturalWidth > 0;
      }), 15000));
    // It has to be STAGED, not sent: a "carry" that submitted the message would also leave the
    // box looking right, and would be far worse than the bug.
    ok('…and nothing was sent on the user\'s behalf',
      !(await paneText()).includes(DRAFT), await paneText());

    // Leave the composer clean for anything after this section.
    await vis('.chat-cmp-quote button[aria-label="Cancel reply"]').first().click().catch(() => {});
    await vis('.chat-cmp-attachments .chat-cmp-chip-x').first().click().catch(() => {});
    await vis('.chat-cmp-input').first().fill('');
  } else {
    report.note('⚠ SKIPPED §12 — no live chat composer at this point (see §10b).');
  }

  // ── §11b — the legacy Terminal composer's Skills picker ──────────────────────────
  console.log('\n── §11b the legacy Terminal composer\'s Skills picker');
  writeAgentUi(false);              // flip the Agent screen preference to Terminal…
  await page.reload({ waitUntil: 'domcontentloaded' });   // …and re-read it on mount
  await page.waitForTimeout(3500);
  await openSurface();
  const startBtn = page.getByRole('button', { name: /Start agent in app/ }).first();
  if (await startBtn.count()) { await startBtn.click().catch(() => {}); }
  else { await page.getByRole('button', { name: /^New agent$/ }).first().click().catch(() => {}); }
  await until(async () => (await vis('.agent-composer').count()) > 0, 20000);
  // Enabled only for a real Claude AGENT pane — a shell composer renders the same button
  // `disabled` (skills are slash triggers), so a hit here is proof of the right surface.
  const skills = vis('.agent-composer button:has-text("Dreamcontext Skills"):not([disabled])').first();
  if ((await skills.count()) === 0) {
    report.note('⚠ SKIPPED §11b — no live terminal AGENT composer here (node-pty / claude CLI gate). '
      + '§11a covers the same `Popover` primitive through the chat composer\'s Attach menu.');
  } else {
    await skills.click();
    await page.waitForTimeout(300);
    ok('the terminal Skills picker opens', (await vis('.agent-skill-browser').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('…Esc closes it', (await page.locator('.agent-skill-browser').count()) === 0);
    await skills.click();
    await page.waitForTimeout(300);
    await page.locator('.agent-overlay-head').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    ok('…an outside click closes it', (await page.locator('.agent-skill-browser').count()) === 0);
  }

  const shot = process.env.VERIFY_SHOTS;
  if (shot) await page.screenshot({ path: `${shot}/chat-composer-ui.png` });
  await browser.close();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0,
  fails: [],
  notes: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

let server = null;
try {
  const { chromium } = await import('@playwright/test');
  console.log('· setting up scratch vault + scripted claude (isolated HOME)…');
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  await run(chromium, `http://127.0.0.1:${port}`, report);
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
