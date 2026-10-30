#!/usr/bin/env node
/**
 * The composer keeps its unsent content per conversation (Slack's draft behaviour) — end-to-end
 * in the real app.
 *
 *   npm run build && node scripts/verify/chat-drafts.mjs
 *
 *   1. text typed in chat 1 is still there after switching to chat 2 and back
 *   2. it reaches the roster file, keyed by conversation
 *   3. after a reload it is back in the box
 *   4. sending clears the box AND the kept record
 *   5. no draft shelf, no "Save as draft" menu row (the earlier shape is gone)
 *
 * Same harness as chat-composer-ui.mjs: isolated scratch HOME, scripted `claude`.
 * Screenshots go to VERIFY_SHOTS (default tmp/verify-shots).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-drafts');
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
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false,
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

const SHOTS = process.env.VERIFY_SHOTS || join(REPO, 'tmp', 'verify-shots');

async function run(chromium, base, report) {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  const vis = (sel) => page.locator(`${sel}:visible`);
  const ok = (label, cond, detail) => report.check(label, cond, detail);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
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
    if (!(await vis('.chat-cmp-input').count())) {
      for (const loc of [page.locator('nav, aside').getByText('Chat', { exact: true }).first(), page.getByText('Chat 1', { exact: true }).first()]) {
        if (await vis('.chat-cmp-input').count()) break;
        await loc.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
  };
  const input = () => vis('.chat-cmp-input').first();
  const shot = async (name) => { await page.screenshot({ path: join(SHOTS, name) }); report.note(`📸 ${join(SHOTS, name)}`); };
  const roster = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), 'utf-8')); } catch { return {}; } };
  const tab = (name) => page.locator('.agent-tab').filter({ hasText: name }).first();
  const NOTE = 'Ajan bitince: testleri yeniden çalıştır ve sonucu özetle';

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await openSurface();
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat session opens', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  // One real turn, so the conversation exists on disk.
  await input().click();
  await input().fill('hello');
  await page.keyboard.press('Enter');
  await until(async () => (await vis('.chat-pane').first().innerText()).includes('FACTS'), 20000);
  await page.waitForTimeout(400);

  // §1 type, switch away, come back
  await input().click();
  await input().pressSequentially(NOTE, { delay: 5 });
  await shot('1-alana-yazildi.png');
  await vis('.chat-cmp-iconbtn').first().click();
  await page.waitForTimeout(250);
  ok('no "Save as draft" row in the + menu', (await page.getByRole('menuitem', { name: /Save as draft/ }).count()) === 0);
  await page.keyboard.press('Escape');
  ok('no draft shelf', (await page.locator('.chat-cmp-drafts').count()) === 0);
  await page.locator('.agent-add-btn').first().click().catch(() => {});
  ok('a second chat opens', await until(async () => (await tab('Chat 2').count()) > 0, 20000));
  await page.waitForTimeout(800);
  ok('…with an empty box of its own', (await input().inputValue()) === '', await input().inputValue().catch(() => '?'));
  await shot('2-baska-sohbete-gecildi.png');
  await tab('Chat 1').click();
  await page.waitForTimeout(800);
  ok('back on chat 1, the text is where it was', (await input().inputValue()) === NOTE, await input().inputValue());
  await shot('3-geri-donuldu-metin-yerinde.png');

  // §2 on disk
  await until(async () => Object.values(roster().drafts ?? {}).some((d) => d.text === NOTE), 5000);
  const kept = Object.values(roster().drafts ?? {}).map((d) => d.text);
  ok('the roster file keeps it, by conversation', kept.includes(NOTE), JSON.stringify(kept));

  // §3 reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await openSurface();
  if ((await tab('Chat 1').count())) { await tab('Chat 1').click().catch(() => {}); await page.waitForTimeout(800); }
  ok('after a reload the text is back in the box',
    await until(async () => (await input().inputValue()) === NOTE, 20000), await input().inputValue().catch(() => '?'));
  await shot('4-yeniden-yuklemeden-sonra-yerinde.png');

  // §4 send clears both
  await input().click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  ok('sending empties the box', (await input().inputValue()) === '');
  ok('…and the kept record goes with it',
    await until(async () => !Object.values(roster().drafts ?? {}).some((d) => d.text === NOTE), 5000),
    JSON.stringify(roster().drafts ?? {}));

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
