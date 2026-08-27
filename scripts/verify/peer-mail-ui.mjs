#!/usr/bin/env node
/**
 * PEER MAIL — the `@peer` picker and the live Peer Session card, end to end.
 *
 *   npm run build && npm run verify:peer-mail
 *
 * Proves, in the real app against the real server, the claim the whole feature rests on:
 * addressing a connected project opens a session THERE, not here.
 *
 *   §1  two connected scratch vaults produce a real `@` picker — the peer's name AND the
 *       one-liner read out of its own soul, from `/api/peer/peers`
 *   §2  ⏎ completes the mention into the draft without swallowing what was already typed
 *   §3  `@peerproj …` does NOT reach the local session: the local transcript never shows
 *       the message, a compact ROW appears instead, and NO panel opens by itself
 *   §4  that session's socket carries `vault=peerproj` and `bypass=0` — the peer runs under
 *       AUTO, never bypass
 *   §5  clicking the row opens the side panel, carrying an answer from a process whose cwd
 *       IS the peer's project root
 *   §6  the panel's own composer talks to THAT session — and closing the panel does NOT
 *       kill it (§6b: reopen, the answers are intact)
 *   §7  a permission request from the peer renders Allow/Deny in the panel, the ROW flags
 *       that it needs you, and answering unblocks the peer's turn
 *   §8  "Open in new tab" hands the peer PROJECT to the window chrome as its own tab
 *   §9  the RUNNING AGENT is told it can ask (snapshot + generated envoy sub-agent), and
 *       disconnecting RETRACTS that envoy
 *
 * WHAT MAKES §4/§5 HONEST: the scripted stand-in echoes its OWN `--permission-mode` argv and
 * its OWN `process.cwd()`. A card that rendered "auto" over a process spawned in the wrong
 * directory — or under bypass — would pass a DOM-only check and fail this one. The WS URL is
 * captured independently by an init script wrapping `window.WebSocket`, so the client's
 * request and the server's spawn are pinned separately.
 *
 * SCRATCH HOME, ALWAYS. Vault registry, agent-ui.json, both vaults and the fake `claude` all
 * live under an isolated HOME. Nothing here reads or writes the developer's real
 * `~/.claude.json`, `~/.claude/` or `~/.dreamcontext/`.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST: every check prints ✓/✗ with evidence and the run
 * continues. Exit 0 iff everything passed. Screenshots land in SHOTS either way, because a
 * failed run is exactly when you want to see the screen.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-peer-mail');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const PEER = join(SCRATCH, 'peerproj');
const SHOTS = process.env.PEER_SHOTS_DIR || join(SCRATCH, 'shots');

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// Answers every turn with the two facts this script exists to check, both read from its own
// process rather than from anything the UI claims: the permission mode it was SPAWNED under,
// and the directory it is RUNNING in. `ASKME` in the prompt makes it raise a real permission
// card and block until the card is answered — which is how §7 proves the embedded card is a
// live control channel and not a decoration.
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/peer-mail-ui.mjs. */
const path = require('path');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
const PERM = flag('--permission-mode') || 'none';
const WHERE = path.basename(process.cwd());

const inbox = [];
let busy = false;
let awaitingAnswer = null;
let seq = 0;

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-' + WHERE, model: 'claude-opus-5',
        cwd: process.cwd(), permissionMode: PERM, slash_commands: ['compact', 'effort'] });
  await sleep(150);

  if (prompt.includes('ASKME')) {
    seq += 1;
    out({ type: 'control_request', request_id: 'req-' + seq,
          request: { subtype: 'can_use_tool', tool_name: 'Write',
                     input: { file_path: 'notes/peer.md' }, description: 'Write notes/peer.md' } });
    const behavior = await new Promise((r) => { awaitingAnswer = r; });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text',
          text: 'CARD ANSWERED: ' + behavior }] } });
    await sleep(120);
  }

  // The load-bearing line: WHERE is this process actually running, and under what mode.
  const answer = 'ANSWER from=' + WHERE + ' perm=' + PERM + ' asked=' + prompt.slice(0, 60);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer,
        num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 },
        session_id: 'verify-' + WHERE });
  busy = false;
  pump();
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'control_response' && awaitingAnswer) {
      const r = msg.response || {};
      const behavior = (r.response && r.response.behavior) || r.behavior || 'unknown';
      const resolve = awaitingAnswer; awaitingAnswer = null; resolve(behavior);
      continue;
    }
    if (msg.type === 'user') {
      const c = msg.message && msg.message.content;
      const text = Array.isArray(c) ? c.map((b) => b.text || '').join(' ') : String(c || '');
      inbox.push(text); pump();
    }
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

function dc(args, cwd = PROJ) {
  return spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args],
    { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  for (const root of [PROJ, PEER]) {
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    mkdirSync(join(root, '_dream_context', 'core'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: root });
  }

  // The peer's LOGO — `assets/logo.png` in ITS vault is the whole setup for the identity
  // mark (vault-logo.ts), so the picker row, the docked peer row and the envoy avatar all
  // get asserted against a real image. A 1×1 PNG: what matters is that it loads.
  mkdirSync(join(PEER, '_dream_context', 'assets'), { recursive: true });
  writeFileSync(join(PEER, '_dream_context', 'assets', 'logo.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));

  // The peer's soul — this is what the `@` picker's second line reads, so the picker in the
  // screenshot shows a real identity rather than a bare name.
  writeFileSync(join(PEER, '_dream_context', 'core', '0.soul.md'),
    '---\nname: "peerproj"\ntype: soul\n---\n\n## Project Identity\n\n'
    + 'A teaching-platform backend: lesson scheduling, payouts and parent messaging for private tutors.\n');
  writeFileSync(join(PROJ, '_dream_context', 'core', '0.soul.md'),
    '---\nname: "proj"\ntype: soul\n---\n\n## Project Identity\n\nThe local project doing the asking.\n');
  // An active task in the peer, so the envoy agent and the peers API have something to carry.
  writeFileSync(join(PEER, '_dream_context', 'state', 'payout-stamp.md'),
    '---\nid: task_peer\nname: Stamp the teacher payout on lesson write\nstatus: in_progress\n---\n\n'
    + '## Acceptance Criteria\n\n- [ ] the stamp is written by the trigger\n');

  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  for (const [name, path] of [['proj', PROJ], ['peerproj', PEER]]) {
    const add = dc(['vaults', 'add', name, path]);
    if (add.status !== 0) throw new Error(`vaults add ${name} failed: ${add.stderr || add.stdout}`);
  }
  // The connection is what creates BOTH the `@` entry and the envoy subagent.
  const conn = dc(['connect', 'peerproj']);
  if (conn.status !== 0) throw new Error(`connect failed: ${conn.stderr || conn.stdout}`);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; }
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

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
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'dark' });
  await page.addInitScript(WS_SPY);
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  const vis = (sel) => page.locator(`${sel}:visible`);
  const ok = (label, cond, detail) => report.check(label, cond, detail);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };
  /**
   * The LOCAL agent's transcript — `.chat-transcript`, the scroller, NOT `.chat-pane`.
   *
   * The peer cards are docked inside the pane (above the composer, outside the scroller) so
   * that a card blocked on a permission cannot scroll away. That means `.chat-pane` text
   * legitimately contains the peer's answer, and asserting over it would "find" the message
   * in the local session and call the feature broken when it is working exactly as designed.
   * The claim under test is what the LOCAL agent received, and that is the transcript.
   */
  const paneText = async () => (await vis('.chat-transcript').first().innerText()).replace(/\s+/g, ' ');
  const sockets = () => page.evaluate(() => window.__dcChatSockets ?? []);
  const shot = async (name) => {
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    report.note(`  📸 ${name}.png`);
  };

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

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  // The announcements popup eats the first clicks on a fresh scratch profile.
  await page.keyboard.press('Escape');
  await openSurface();
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  ok('a local chat session opens', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  await page.waitForTimeout(800);

  // ── §1 the `@` picker ────────────────────────────────────────────────────────────
  console.log('\n── §1 the @ picker');
  const input = () => vis('.chat-cmp-input').first();
  await input().click();
  await input().fill('');
  await page.keyboard.type('@');
  await page.waitForTimeout(600);

  const menu = () => vis('.chat-cmp-mention');
  ok('typing @ opens the peer picker', (await menu().count()) === 1,
    `menus=${await menu().count()}`);
  const rowText = (await menu().first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('…listing the connected peer by name', rowText.includes('@peerproj'), rowText.slice(0, 120));
  ok('…with the one-liner read from ITS OWN soul',
    /teaching-platform backend/i.test(rowText), rowText.slice(0, 160));
  // The logo must have actually LOADED (naturalWidth > 0), not merely rendered an <img>
  // whose src 404s — the route, the consent gate and the file convention are all under
  // this one bit.
  const menuLogo = () => vis('.chat-cmp-mention .chat-cmp-mention-logo');
  ok("…wearing the peer vault's own logo, loaded from its assets/",
    await until(async () => (await menuLogo().count()) === 1
      && await menuLogo().first().evaluate((el) => el.naturalWidth > 0), 8000),
    `imgs=${await menuLogo().count()}`);
  await shot('01-mention-picker');

  // ── §2 completion ────────────────────────────────────────────────────────────────
  console.log('\n── §2 completion');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const draftAfter = await input().inputValue();
  ok('⏎ completes the mention into the draft', draftAfter.startsWith('@peerproj '), `draft=${JSON.stringify(draftAfter)}`);
  ok('…and the picker closes', (await menu().count()) === 0);
  // The completed mention gets its emphasis from the highlight mirror behind the field —
  // a pill under exactly the `@peerproj` token, nothing else.
  const hlText = await vis('.chat-cmp-hl-mention').first().innerText().catch(() => '');
  ok('…and the mention is highlighted in the field', hlText === '@peerproj', `hl=${JSON.stringify(hlText)}`);

  // An email address must NOT open it — the `@` there is glued to the previous character.
  await input().fill('');
  await page.keyboard.type('mail me at a@b');
  await page.waitForTimeout(400);
  ok('an email address does not open the picker', (await menu().count()) === 0);
  await input().fill('');

  // ── §3 the message does not reach the local session ──────────────────────────────
  console.log('\n── §3 addressing the peer');
  const socketsBefore = (await sockets()).length;
  await input().click();
  await page.keyboard.type('@peerproj where is the payout stamp written?');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  ok('a peer ROW appears (the message you click)',
    await until(async () => (await vis('.peer-row').count()) === 1, 15000),
    `rows=${await vis('.peer-row').count()}`);
  ok("…wearing the vault's logo as its mark",
    await until(async () => (await vis('.peer-row .peer-mark-logo').count()) === 1, 8000),
    `marks=${await vis('.peer-row .peer-mark-logo').count()}`);
  ok('…and no panel opened by itself',
    (await vis('.peer-panel').count()) === 0,
    `panels=${await vis('.peer-panel').count()}`);
  const localAfter = await paneText();
  ok('the local transcript never received the message',
    !localAfter.includes('where is the payout stamp written'),
    localAfter.slice(-160));
  ok('…and the composer cleared', (await input().inputValue()) === '');

  // ── §4 the socket: right vault, auto not bypass ──────────────────────────────────
  console.log('\n── §4 the peer socket');
  const opened = (await sockets()).slice(socketsBefore);
  const peerSocket = opened.find((u) => u.includes('vault=peerproj')) ?? '';
  ok('a chat socket opened against the PEER vault', !!peerSocket, peerSocket.slice(0, 120) || `opened=${opened.length}`);
  ok('…with bypass=0 (auto, never bypassPermissions)', peerSocket.includes('bypass=0'),
    peerSocket.slice(0, 160));

  // ── §5 the row summarises, and the click opens the side panel ────────────────────
  console.log('\n── §5 the row, then the panel');
  const rowText2 = async () => (await vis('.peer-row').first().innerText()).replace(/\s+/g, ' ');
  ok('the row reports the peer answered',
    await until(async () => (await rowText2()).includes('ANSWER from='), 25000),
    (await rowText2()).slice(0, 200));
  const rowSummary = await rowText2();
  ok('…from a process whose cwd IS the peer project root',
    rowSummary.includes('from=peerproj'), rowSummary.slice(0, 220));
  ok('…and the row names the peer', rowSummary.includes('peerproj'));
  await shot('02-peer-row');

  await vis('.peer-row-main').first().click();
  ok('clicking the message opens the side panel',
    await until(async () => (await vis('.peer-panel').count()) === 1, 8000),
    `panels=${await vis('.peer-panel').count()}`);
  // GEOMETRY, not just presence. The first version of this panel rendered inside the docked
  // strip, so `position:absolute; inset:0` resolved against a ~40px box: it was in the DOM,
  // it was ":visible", its text was queryable — and the user saw nothing. A presence check
  // passed that build. Asserting it actually occupies the pane is what catches it.
  const box = await vis('.peer-panel').first().boundingBox();
  ok('…and it actually fills the pane (not collapsed into the docked strip)',
    !!box && box.width > 300 && box.height > 400,
    box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'no box');
  const panelText = async () => (await vis('.peer-panel').first().innerText()).replace(/\s+/g, ' ');
  const panel = await panelText();
  ok('…carrying the full answer', panel.includes('ANSWER from=peerproj'), panel.slice(0, 220));
  ok('…which reports running under auto', panel.includes('perm=auto'), panel.slice(0, 220));
  ok('…and an "Open in new tab" button', (await vis('.peer-panel-tab').count()) === 1);
  await shot('03-peer-panel');

  // ── §6 the panel's own composer ──────────────────────────────────────────────────
  console.log('\n── §6 talking INTO the peer session, from the panel');
  // The REAL `Composer`, scoped to the panel — not a bespoke text box. Asserting on
  // `.chat-cmp-*` is the point: if this ever regressed to a hand-rolled input these checks
  // would fail, which is exactly what should happen.
  const cardInput = () => vis('.peer-panel .chat-cmp-input').first();
  ok('the panel mounts the REAL composer', (await cardInput().count()) === 1);
  ok('…with its model/effort trigger', (await vis('.peer-panel .chat-cmp-modeltrigger').count()) === 2,
    `triggers=${await vis('.peer-panel .chat-cmp-modeltrigger').count()}`);
  ok('…its attach button and send disc',
    (await vis('.peer-panel .chat-cmp-iconbtn').count()) === 1
    && (await vis('.peer-panel .chat-cmp-send').count()) === 1);
  await cardInput().click();
  await page.keyboard.type('and who writes it on a price change?');
  await page.keyboard.press('Enter');
  ok('a follow-up reaches the PEER session',
    await until(async () => (await panelText()).includes('price change'), 25000),
    (await panelText()).slice(-200));
  ok('…and the local pane still knows nothing about it',
    !(await paneText()).includes('price change'));

  // THE reason the session lives in the holder and not the panel: closing the panel must
  // not dispose the socket or kill the peer's turn.
  console.log('\n── §6b the session survives closing the panel');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  ok('Escape closes the panel', (await vis('.peer-panel').count()) === 0);
  ok('…the row is still there', (await vis('.peer-row').count()) === 1);
  await vis('.peer-row-main').first().click();
  await page.waitForTimeout(500);
  ok('…and reopening shows the SAME session, answers intact',
    (await panelText()).includes('price change'), (await panelText()).slice(-160));

  // ── §7 the peer's permission prompt, answered in the panel ───────────────────────
  console.log('\n── §7 the peer asks permission');
  await cardInput().click();
  await page.keyboard.type('ASKME write the note');
  await page.keyboard.press('Enter');
  ok('a permission request from the peer renders as the REAL PermissionCard',
    await until(async () => (await vis('.peer-panel .chat-permcard').count()) === 1, 20000),
    `cards=${await vis('.peer-panel .chat-permcard').count()}`);
  const askText = await vis('.peer-panel .chat-permcard').first().innerText().catch(() => '');
  ok('…naming the tool the peer wants to run', /Write/i.test(askText), askText.replace(/\s+/g, ' ').slice(0, 140));
  ok('…and the ROW flags that it needs you',
    (await vis('.peer-row.needs-you').count()) === 1,
    await rowText2());
  await shot('04-peer-permission');

  await vis('.peer-panel .chat-permcard').first().getByRole('button', { name: /Allow/ }).first().click();
  ok('answering it there unblocks the peer turn',
    await until(async () => (await panelText()).includes('CARD ANSWERED: allow'), 20000),
    (await panelText()).slice(-200));
  ok('…and the prompt clears', (await vis('.peer-panel .chat-permcard').count()) === 0);
  await shot('05-peer-permission-answered');

  // ── §8 "Open in new tab" hands the PROJECT to the window chrome ──────────────────
  console.log('\n── §8 open in new tab');
  const tabsBefore = await page.locator('.project-tab').count();
  await vis('.peer-panel-tab').first().click();
  ok('the peer project opens as its own project tab',
    await until(async () => (await page.locator('.project-tab').count()) > tabsBefore, 15000),
    `tabs ${tabsBefore} → ${await page.locator('.project-tab').count()}`);
  await page.waitForTimeout(1200);
  await shot('06-opened-in-new-tab');

  // ── §9 the RUNNING AGENT knows the peer is callable, and when ────────────────────
  //
  // Not a UI question. A Claude Code session in this project learns what it can do from two
  // places: the SessionStart snapshot and the sub-agent registry. If neither mentions that a
  // connected project can be ASKED, the capability exists and is never reached — the agent
  // recalls, finds nothing, and concludes the information does not exist.
  console.log('\n── §9 what the running agent is told');
  const snap = dc(['snapshot']).stdout ?? '';
  ok('the snapshot names the connected peer', snap.includes('peerproj'));
  ok('…and tells the agent it can ASK, not only read', /dreamcontext peer ask/.test(snap),
    (snap.match(/.{0,80}peer ask.{0,80}/) ?? ['(absent)'])[0]);
  ok('…and says WHEN to prefer asking over recall',
    /reasoned rather than looked up|recall came back empty/i.test(snap));

  const envoy = join(PROJ, '.claude', 'agents', 'peer-peerproj.md');
  let envoyText = '';
  try { envoyText = readFileSync(envoy, 'utf-8'); } catch { /* absent */ }
  ok('an envoy sub-agent was generated for the peer', envoyText.length > 0, envoy);
  ok('…carrying the peer\'s identity, not just its name',
    /teaching-platform backend/i.test(envoyText));
  ok('…and the routing rule for when to dispatch it',
    /Recall returns documents|reasoned/i.test(envoyText));
  ok('…and the peer\'s real path', envoyText.includes(PEER), PEER);

  // Disconnecting must RETRACT the capability — a dead envoy is worse than none, because the
  // agent will dispatch it and get a failure it cannot interpret.
  dc(['disconnect', 'peerproj']);
  let afterDisconnect = 'still-there';
  try { readFileSync(envoy, 'utf-8'); } catch { afterDisconnect = 'gone'; }
  ok('disconnecting removes the envoy', afterDisconnect === 'gone');
  dc(['connect', 'peerproj']);

  // Light theme, for the screenshot set.
  const light = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'light' });
  await light.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await light.waitForTimeout(2500);
  await light.screenshot({ path: join(SHOTS, '06-light-launcher.png') }).catch(() => {});
  await light.close().catch(() => {});

  await browser.close();
}

// ─── report ───────────────────────────────────────────────────────────────────────────

function makeReport() {
  const failures = [];
  let passed = 0;
  return {
    check(label, cond, detail) {
      if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
      else { failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
    },
    note(msg) { console.log(`    ${msg}`); },
    finish() {
      console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed`);
      console.log(`  screenshots: ${SHOTS}`);
      if (failures.length) { for (const f of failures) console.log(`   - ${f}`); }
      return failures.length === 0 ? 0 : 1;
    },
  };
}

async function main() {
  const { chromium } = await import('playwright');
  console.log('── setup');
  setupScratch();
  const port = await freePort();
  const srv = await startServer(port);
  console.log(`  server on ${port}, scratch ${SCRATCH}`);
  const report = makeReport();
  try {
    await run(chromium, `http://127.0.0.1:${port}`, report);
  } catch (err) {
    console.log(`\n✗ threw: ${err && err.stack ? err.stack : String(err)}`);
    report.check('the run completed without throwing', false, String(err).slice(0, 200));
  } finally {
    srv.kill();
  }
  process.exit(report.finish());
}

main();
