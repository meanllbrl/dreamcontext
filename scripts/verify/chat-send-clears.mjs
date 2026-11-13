#!/usr/bin/env node
/**
 * A sent message leaves the composer, and an answer's `ask` chip responds, in every state a
 * typed message can be sent in (owner bug 2026-11-12: "the message goes and STAYS in the box;
 * the quick-answer button cannot be pressed").
 *
 *   npm run build && node scripts/verify/chat-send-clears.mjs
 *
 *   1. send while the session is STARTING (no `system:init` yet): the box empties
 *   2. send MID-TURN (a steer): the box empties
 *   3. the answer's `ask` chip, clicked while idle: the box shows its text
 *   4. the `ask` chip clicked while a turn runs / the session starts: the box shows its text
 *   6. a PARKED chat (stopped under load, drawn as it was): its ask chip fills the box, and its
 *      first message (which wakes it) leaves the box empty, during and after the wake
 *   5. after a reload (a reopened tab, "Starting Claude…" on its first send): send empties the
 *      box and the old text never comes back
 *
 * Isolated scratch HOME, scripted `claude` (the chat-drafts.mjs harness). Screenshots go to
 * VERIFY_SHOTS (default tmp/verify-shots).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-send-clears');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 4000);

// The stand-in: every turn waits START_DELAY_MS before its `system:init` (the "Starting
// Claude…" window), runs one slow tool step (a steer lands at its boundary), and answers with a
// question and an `ask` chip.
const STANDIN = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// The conversation on disk, as the real CLI keeps it: a parked tab and a resume read it back.
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
const SID = flag('--resume') || flag('--session-id') || 'verify-session';
const TDIR = path.join(process.env.HOME, '.claude', 'projects', 'verify-proj');
fs.mkdirSync(TDIR, { recursive: true });
let rec = 0;
const keep = (o) => fs.appendFileSync(path.join(TDIR, SID + '.jsonl'), JSON.stringify({ ...o, uuid: SID.slice(0, 8) + '-' + process.pid + '-' + (++rec), sessionId: SID, timestamp: new Date().toISOString() }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false;
let n = 0;
const ACTIONS = ['\`\`\`dream-actions', JSON.stringify([{ label: 'Fix it, send the note', action: 'ask', text: 'ASKCHIP fix it and send the note' }]), '\`\`\`'].join('\\n');
async function runTurn(prompt) {
  busy = true;
  n++;
  await sleep(${START_DELAY_MS});
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'default', slash_commands: [] });
  const id = 'tu' + n;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo step', description: 'step' } }] } });
  await sleep(2500);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'step' }] }] } });
  const steered = inbox.splice(0);
  const answer = { role: 'assistant', content: [{ type: 'text', text: 'ANSWER ' + n + ' to: ' + prompt + (steered.length ? ' + steered: ' + steered.join(' | ') : '') + '\\n\\nShall I do it?\\n\\n' + ACTIONS }] };
  keep({ type: 'user', message: { role: 'user', content: prompt } });
  keep({ type: 'assistant', message: answer });
  out({ type: 'assistant', message: answer });
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
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
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
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'bypass', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
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
    env: {
      ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1',
      // §6: park an idle, unfocused chat quickly (the chat-park.mjs overrides).
      DREAMCONTEXT_PARK_PRESSURE: 'hard', DREAMCONTEXT_PARK_IDLE_MS: '4000',
      DREAMCONTEXT_PARK_SWEEP_MS: '1500', DREAMCONTEXT_PARK_FOCUS_MS: '3000',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const SHOTS = process.env.VERIFY_SHOTS || join(REPO, 'tmp', 'verify-shots');

async function run(chromium, base, report) {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
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
  const box = () => input().inputValue().catch(() => '?');
  const paneText = () => vis('.chat-pane').first().innerText().catch(() => '');
  const starting = async () => (await paneText()).includes('Starting Claude');
  const shot = async (name) => { await page.screenshot({ path: join(SHOTS, name) }); report.note(`📸 ${join(SHOTS, name)}`); };
  const clear = async () => { await input().fill(''); await page.waitForTimeout(300); };
  const type = async (text) => { await input().click(); await input().pressSequentially(text, { delay: 3 }); };
  const chip = () => vis('.chat-action-btn[data-action="ask"]').last();
  const settle = () => until(async () => !(await paneText()).includes('Working') && !(await starting()) && (await chip().count()) > 0, 30000);

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await openSurface();
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat session opens', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));

  // §1 first send: the session is starting
  await type('FIRST message');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  ok('§1 the first send empties the box', (await box()) === '', await box());
  ok('§1 …while the pane says Starting Claude', await until(starting, 3000));
  // §2 a steer while it still starts
  await type('STEER while starting');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await shot('s2-steer-while-starting.png');
  ok('§2 a send while starting empties the box', (await box()) === '', await box());
  // §4a the ask chip is not drawn yet; wait for the answer
  ok('§3 the turn ends with an ask chip', await settle());
  await page.waitForTimeout(400);
  ok('§2 nothing came back into the box after the turn', (await box()) === '', await box());

  // §3 idle chip
  await chip().click();
  await page.waitForTimeout(400);
  ok('§3 the idle ask chip puts its text in the box', (await box()).includes('ASKCHIP'), await box());
  await shot('s3-chip-idle.png');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  ok('§3 sending the chip text empties the box', (await box()) === '', await box());
  // §4 chip while the turn runs (starting window)
  ok('§4 the chip turn is running', await until(async () => (await starting()) || (await paneText()).includes('Working'), 3000));
  await chip().click();
  await page.waitForTimeout(400);
  await shot('s4-chip-while-starting.png');
  ok('§4 the ask chip responds while the session starts', (await box()).includes('ASKCHIP'), await box());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  ok('§4 …and that send empties the box', (await box()) === '', await box());
  await settle();
  await page.waitForTimeout(600);
  ok('§4 nothing came back after the turn', (await box()) === '', await box());

  // §6 a PARKED tab (the machine was under load and the idle, unfocused chat's process was
  // stopped): it is drawn like the chat it was, and its first message wakes it.
  const tabs = () => page.locator('[role="tab"]');
  await page.locator('button[aria-label="New chat"]:visible').first().click();
  await page.waitForTimeout(1500);
  await type('BRAVO keeps the focus');
  await page.keyboard.press('Enter');
  await settle();
  // The parked view is drawn only for the tab on screen: wait out idle + grace + sweeps, then look.
  await page.waitForTimeout(14000);
  await tabs().first().click();
  const parked = await until(async () => (await page.locator('[data-testid="parked-chat"]').count()) > 0, 15000);
  ok('§6 the idle first chat gets parked', parked);
  await page.waitForTimeout(1500);
  ok('§6 the parked chat shows its ask chip', await until(async () => (await chip().count()) > 0, 10000));
  await chip().click();
  await page.waitForTimeout(500);
  await shot('s6-chip-on-parked.png');
  ok('§6 the ask chip responds on a parked chat', (await box()).includes('ASKCHIP'), await box());
  await clear();
  await type('PARKED wake message');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await shot('s6-after-send-on-parked.png');
  ok('§6 a send on a parked chat empties the box', (await box()) === '', await box());
  await type('PARKED steer while starting');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  ok('§6 a second send while it wakes empties the box', (await box()) === '', await box());
  await settle();
  await page.waitForTimeout(800);
  ok('§6 nothing came back into the box after the woken turn', (await box()) === '', await box());
  await shot('s6-end.png');
  await chip().click();
  await page.waitForTimeout(400);
  ok('§6 the chip responds on the woken chat', (await box()).includes('ASKCHIP'), await box());
  await clear();

  ok('§6 the box is empty before the reload', (await box()) === '', await box());
  // The roster (where a kept draft outlives a reload) is written 400 ms after a change.
  await page.waitForTimeout(1500);
  // §5 reload: a reopened tab, a fresh session that starts on its first send
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await openSurface();
  await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000);
  await page.waitForTimeout(1500);
  ok('§5 after reload the box is empty', (await box()) === '', await box());
  await shot('s5-after-reload.png');
  await until(async () => (await chip().count()) > 0, 8000);
  if (await chip().count()) {
    await chip().click();
    await page.waitForTimeout(400);
    ok('§5 the ask chip responds on a reopened tab', (await box()).includes('ASKCHIP'), await box());
  }
  await clear();
  await type('AFTER RELOAD send');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  ok('§5 a send on the reopened tab empties the box', (await box()) === '', await box());
  await type('AFTER RELOAD steer');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await shot('s5-steer-after-reload.png');
  ok('§5 a steer on the reopened tab empties the box', (await box()) === '', await box());
  await settle();
  await page.waitForTimeout(800);
  ok('§5 nothing came back after the turn', (await box()) === '', await box());
  await shot('s5-end.png');
  await browser.close();
}

const report = {
  pass: 0, fails: [], notes: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

let server = null;
try {
  const { chromium } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
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
