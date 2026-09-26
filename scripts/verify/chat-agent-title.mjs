#!/usr/bin/env node
/**
 * The chat's own agent names its tab — end-to-end verification.
 *
 *   npm run build && npm run verify:chat-agent-title
 *
 * WHAT IT PROVES — the whole path the Haiku namer used to own, now owned by the agent:
 *   T1  a fresh chat tab starts as "Chat N" and, when the agent's answer carries a
 *       `{"type":"title"}` dream-view block, the TAB takes that name
 *   T2  the block is drawn nowhere — no raw JSON, no notice in the transcript
 *   T3  the roster on disk records the name AND that the agent set it (`titleByAgent`)
 *   T4  when the subject moves, a second block renames the tab again (it is the agent's name)
 *   T5  a name the USER types wins for good: a later block is ignored and the flag is dropped
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/ws/agent-chat` route and the real
 * React surface in Chromium. WHAT IT DOES NOT SPEND — tokens: `claude` is a scripted stand-in
 * in an isolated fake HOME, the same substitution `chat-steer.mjs` documents. The stand-in
 * writes a title block whenever the prompt says `TITLE:<name>`, so the test decides what the
 * agent "understood" and asserts only what the app does with it.
 *
 * FAILURE POLICY — collect, don't fail fast; exit 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-agent-title');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const ROSTER = join(PROJ, '_dream_context', 'state', '.agent-sessions.json');

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-agent-title.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const FENCE = String.fromCharCode(96).repeat(3);
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) continue;
    out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
    const m = /TITLE:(.+)$/.exec(text);
    const body = 'DONE: ' + text.replace(/\\s*TITLE:.*$/, '') + (m
      ? '\\n\\n' + FENCE + 'dream-view\\n' + JSON.stringify({ type: 'title', text: m[1].trim() }) + '\\n' + FENCE + '\\n'
      : '');
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: body }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: body, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
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

const readRoster = () => {
  try { return existsSync(ROSTER) ? JSON.parse(readFileSync(ROSTER, 'utf-8')).sessions ?? [] : []; }
  catch { return []; }
};

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function run(chromium, base, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  const vis = (sel) => page.locator(`${sel}:visible`);
  const composer = () => vis('.chat-cmp-input').first();
  const paneText = async () => (await vis('.chat-pane').first().innerText()).replace(/\s+/g, ' ');
  const tabTitle = async () => ((await vis('.agent-tab-title').first().textContent()) ?? '').trim();
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const send = async (t) => {
    await composer().click(); await composer().fill(t); await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
  };
  const ok = (label, cond, detail) => report.check(label, cond, detail);

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
  const initial = await tabTitle();
  ok('the fresh tab carries its default name', /^Chat \d+$/.test(initial), initial);

  // T1 + T2 + T3
  await send('look at the checkout flow TITLE:Checkout button redesign');
  ok('T1 the agent\'s title block names the tab',
    await until(async () => (await tabTitle()) === 'Checkout button redesign'), await tabTitle());
  const text = await paneText();
  ok('T2 the answer text is shown', text.includes('DONE: look at the checkout flow'), text.slice(0, 200));
  ok('T2 the block itself is drawn nowhere — no raw JSON, no notice',
    !text.includes('"type"') && !text.includes('dream-view') && !/skipped/i.test(text), text.slice(0, 300));
  ok('T3 the roster records the name and that the agent set it',
    await until(() => readRoster().some((m) => m.title === 'Checkout button redesign' && m.titleByAgent === true), 8000),
    JSON.stringify(readRoster()));

  // T4
  await send('now the invoices TITLE:Invoice PDF export');
  ok('T4 a new subject renames the agent-named tab again',
    await until(async () => (await tabTitle()) === 'Invoice PDF export'), await tabTitle());

  // T5 — the user renames through the tab's own menu, then the agent tries again.
  await vis('.agent-tab').first().click({ button: 'right' });
  await page.locator('.agent-tab-menu [role="menuitem"]', { hasText: 'Rename' }).click();
  const editor = page.locator('.agent-tab-rename');
  await editor.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await editor.fill('My own name');
  await editor.press('Enter');
  ok('T5 the user rename lands', await until(async () => (await tabTitle()) === 'My own name'), await tabTitle());
  await send('one more TITLE:Should not apply');
  await until(async () => (await paneText()).includes('DONE: one more'), 15000);
  await page.waitForTimeout(800);
  ok('T5 a later agent title is ignored — the user\'s name wins', (await tabTitle()) === 'My own name', await tabTitle());
  ok('T5 the roster drops the agent flag for the user-named tab',
    await until(() => readRoster().some((m) => m.title === 'My own name' && !m.titleByAgent), 8000),
    JSON.stringify(readRoster()));

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
