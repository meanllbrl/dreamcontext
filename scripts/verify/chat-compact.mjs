#!/usr/bin/env node
/**
 * A compaction in the Chat view, end to end.
 *
 *   npm run build && npm run verify:chat-compact
 *
 * WHAT IT PROVES:
 *   C1  while the CLI compacts, the transcript says so (a running divider, not a frozen pane)
 *   C2  the boundary turns it into "Conversation compacted · <before> → <after>"
 *   C3  the summary is folded by default and opens on click, preamble and instructions cut
 *   C4  the summary never renders as a user bubble or as assistant text
 *
 * The replay of a reopened chat (transcript rows → the same divider) is covered by
 * tests/unit/chat-compaction.test.ts, which runs the real parser over a real transcript's rows.
 *
 * WHAT IT DRIVES: the real dashboard server, the real `/ws/agent-chat` route and the real React
 * surface in Chromium. WHAT IT DOES NOT SPEND: tokens. `claude` is a scripted stand-in in an
 * isolated fake HOME (see chat-steer.mjs); on `COMPACT` it plays the exact frame sequence CLI
 * 2.1.261 sends for `/compact`, captured live.
 *
 * FAILURE POLICY: collect, don't fail fast; exit 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-compact');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, '_dream_context', 'tmp', 'verify-shots', 'chat-compact');

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-compact.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\\n\\nSummary:\\n1. **Primary Request and Intent:**\\n   The user asked for the checkout redesign.\\n\\n2. **Pending Tasks:**\\n   - Ship the new button\\n\\nIf you need specific details from before compaction, read the full transcript at: /x.jsonl\\nContinue the conversation from where it left off without asking the user any further questions.';
let buf = '';
const sid = 'verify-session';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const content = o.message && o.message.content;
    const text = typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) continue;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
    if (!text.includes('COMPACT')) {
      const body = 'DONE: ' + text;
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: body }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: body, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: sid });
      continue;
    }
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sid });
    setTimeout(() => {
      out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sid });
      out({ type: 'system', subtype: 'compact_boundary', session_id: sid, compact_metadata: { trigger: 'manual', pre_tokens: 280806, post_tokens: 19067, duration_ms: 2500 } });
      out({ type: 'user', message: { role: 'user', content: SUMMARY }, session_id: sid, parent_tool_use_id: null, isReplay: false, isSynthetic: true });
      out({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, session_id: sid, isReplay: true });
      out({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, session_id: sid });
    }, 2500);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ─── setup (same shape as chat-steer.mjs) ─────────────────────────────────────────────

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
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}


// ─── the assertions ───────────────────────────────────────────────────────────────────

async function run(chromium, base, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  mkdirSync(SHOTS, { recursive: true });

  const vis = (sel) => page.locator(`${sel}:visible`);
  const composer = () => vis('.chat-cmp-input').first();
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(100); }
    return false;
  };
  const send = async (t) => {
    await composer().click(); await composer().fill(t); await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
  };
  const ok = (label, cond, detail) => report.check(label, cond, detail);
  const divider = () => vis('.chat-m-compact').first();
  const dividerText = async () => ((await divider().count()) ? (await divider().innerText()).replace(/\s+/g, ' ') : '');

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3 && await page.locator('.announcements-modal-scrim').count(); i++) {
    await page.locator('.announcements-modal-close').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  ok('a chat session opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));

  await send('hello there');
  await until(async () => (await vis('.chat-pane').first().innerText()).includes('DONE: hello there'));
  await send('please COMPACT');

  ok('C1 a running divider shows while compacting',
    await until(async () => (await dividerText()).includes('Compacting conversation')), await dividerText());
  await page.screenshot({ path: join(SHOTS, 'running.png') });
  ok('C2 the boundary fills in the token drop',
    await until(async () => (await dividerText()).includes('Conversation compacted · 281k → 19k tokens')), await dividerText());
  ok('C3 the summary is folded by default',
    !(await vis('.chat-m-compact-body').count()) && (await dividerText()).includes('Show summary'), await dividerText());
  await vis('.chat-m-compact-head').first().click();
  const body = (await vis('.chat-m-compact-body').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('C3 a click opens the summary', body.includes('Primary Request and Intent') && body.includes('Ship the new button'), body.slice(0, 200));
  ok('C3 preamble and model instructions are cut',
    !body.includes('This session is being continued') && !body.includes('Continue the conversation'), body.slice(0, 300));
  await page.screenshot({ path: join(SHOTS, 'open-light.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'open-dark.png') });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  const bubbles = await vis('.chat-pane').first().evaluate((el) => {
    const pane = el.cloneNode(true);
    pane.querySelectorAll('.chat-m-compact').forEach((n) => n.remove());
    return pane.textContent || '';
  });
  ok('C4 the summary appears nowhere but the divider',
    !bubbles.includes('This session is being continued') && !bubbles.includes('Ship the new button'), bubbles.slice(0, 300));
  ok('C4 exactly one divider', (await vis('.chat-m-compact').count()) === 1, String(await vis('.chat-m-compact').count()));

  await browser.close();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0,
  fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { console.log(`  ${msg}`); },
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
