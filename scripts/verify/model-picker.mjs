#!/usr/bin/env node
/**
 * The r29 model picker, end to end (Track T W4).
 *
 *   npm run build && node scripts/verify/model-picker.mjs
 *
 * Real dashboard server and React surface in Chromium on a scratch HOME and a fictional vault, with
 * scripts/verify/fake-codex.mjs as `codex`. Checks every r29 state, a cross-tool switch (asks once,
 * says the text goes to the other vendor, Cancel leaves everything, OK opens a chat beside the old
 * one whose first turn carries the text), and a signed-out tool's Sign in. Then 1440/1024/390 in
 * dark and light with no console errors. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-model-picker');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = process.env.SHOTS_DIR || join(SCRATCH, 'shots');
const FIXTURES = join(REPO, 'src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures');

const CLAUDE_STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// A real transcript, so the model picker's cross-tool switch has a conversation to carry.
const fs = require('node:fs'); const path = require('node:path');
const at = process.argv.indexOf('--session-id');
const sid = at > 0 ? process.argv[at + 1] : '';
const dir = path.join(process.env.HOME, '.claude', 'projects', '-verify');
fs.mkdirSync(dir, { recursive: true });
const keep = (o) => { if (sid) fs.appendFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ ...o, sessionId: sid, cwd: process.cwd(), uuid: sid + '-' + Math.random(), timestamp: new Date().toISOString() }) + '\\n'); };
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    keep({ type: 'user', message: { role: 'user', content: text } });
    keep({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE SAYS: ' + text }] } });
    out({ type: 'system', subtype: 'init', session_id: 'claude-verify', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE SAYS: ' + text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'claude-verify' });
  }
});
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
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.codex'), join(PROJ, '_dream_context', 'state'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), CLAUDE_STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.local', 'bin', 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(REPO, 'scripts/verify/fake-codex.mjs')}" "$@"\n`);
  chmodSync(join(HOME, '.local', 'bin', 'codex'), 0o755);
  // A signed-in Codex, as the registry reads it: presence of auth.json, a default model, its model cache.
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"verify placeholder, not a credential"}');
  writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "gpt-6-luna"\n');
  writeFileSync(join(HOME, '.codex', 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
    { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
  ] }));
  // A second Codex login, so the picker has an account chip and panel to show.
  mkdirSync(join(HOME, '.dreamcontext', 'codex-accounts', 'acct1'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'codex-accounts', 'acct1', 'auth.json'), '{"note":"verify placeholder, not a credential"}');
  writeFileSync(join(HOME, '.dreamcontext', 'codex-accounts.json'), JSON.stringify({ accounts: [{ id: 'acct1', email: 'ada@example.test', planType: 'plus', addedAt: 1 }] }));
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', FAKE_CODEX_FIXTURES: FIXTURES, FAKE_CODEX_LOG: join(SCRATCH, 'fake-codex.log'), DREAMCONTEXT_T3_DEBUG: join(SCRATCH, 'bridge.log'), DREAMCONTEXT_CLI: join(REPO, 'dist', 'index.js') },
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

const report = {
  results: [],
  notes: [],
  check(ctx, label, cond, detail) {
    this.results.push({ ctx, label, ok: !!cond, detail });
    console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `  — ${String(detail).slice(0, 200)}` : ''}`);
  },
  note(s) { this.notes.push(s); },
};

/** Bring the Codex chat on screen: a reload or restart may land on another page with the
 *  restored chats docked bottom-right. */
async function showCodexChat(page) {
  const nav = page.locator('nav, aside').getByText('Chat', { exact: true }).first();
  if (await nav.count() && await nav.isVisible().catch(() => false)) {
    await nav.click({ force: true }).catch(() => {});
  } else {
    // A narrow window: the sidebar is icons only, the restored chats sit in the dock.
    const dock = page.getByText('Codex verify chat', { exact: true }).last();
    if (await dock.count()) await dock.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(2000);
  const tab = page.locator('.agent-tab-title:visible', { hasText: 'Codex verify chat' }).first();
  if (await tab.count()) await tab.click().catch(() => {});
  await page.waitForTimeout(1500);
}

async function expandSurface(page) {
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}

async function openPage(browser, base, { width = 1440, height = 960, theme = 'dark' } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 200)}`); });
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`); });
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await expandSurface(page);
  return { page, errors };
}

function helpers(page) {
  const vis = (sel) => page.locator(`${sel}:visible`);
  const pane = () => vis('.chat-pane').first();
  const paneText = async () => ((await pane().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); } return false; };
  const busy = async () => (await vis('.chat-cmp-send.is-stop').count()) > 0;
  const send = async (t) => { const c = vis('.chat-cmp-input').first(); await c.click(); await c.fill(t); await page.waitForTimeout(100); await page.keyboard.press('Enter'); };
  const waitText = (s, ms = 25000) => until(async () => (await paneText()).includes(s), ms);
  /** The turn has ENDED (its result arrived): no Stop button, settled for a moment. */
  const settled = async () => { await until(async () => !(await busy()), 20000); await page.waitForTimeout(1500); return until(async () => !(await busy()), 5000); };
  return { vis, pane, paneText, until, busy, send, waitText, settled };
}


const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

async function openPicker(page, h) {
  await page.keyboard.press('Escape');
  await h.vis('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]').first().click({ timeout: 8000 });
  await h.until(async () => (await h.vis('[data-testid="model-picker"]').count()) > 0, 5000);
}

async function main() {
  const { chromium } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  const ok = (label, cond, detail) => report.check('flow', label, cond, detail);
  try {
    const { page, errors } = await openPage(browser, base);
    const h = helpers(page);
    if (!(await h.vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
    ok('a chat opens', await h.until(async () => (await h.vis('.chat-cmp-input').count()) > 0));
    await h.send('REMEMBER the word marigold');
    await h.waitText('CLAUDE SAYS');
    await h.settled();

    await openPicker(page, h);
    const picker = () => h.vis('[data-testid="model-picker"]').first();
    ok('default: the picker opens on Claude with its models', (await picker().innerText()).includes('Opus'), await picker().innerText());
    await shot(page, 'r29-default-1440-dark');
    await picker().getByRole('button', { name: 'Codex', exact: true }).click();
    const codexText = await picker().innerText();
    ok('Codex list: its models, and the note about a new chat', codexText.includes('GPT-6 Luna') && codexText.includes('Opens a new Codex chat'), codexText);
    await shot(page, 'r29-codex-1440-dark');
    await picker().getByRole('button', { name: 'Claude', exact: true }).click();
    await picker().getByRole('button', { name: /^Effort/ }).click();
    ok('effort: the levels sit under the list', (await h.vis('.mp-efforts').count()) === 1);
    await shot(page, 'r29-effort-1440-dark');
    await picker().getByLabel('Search models').fill('luna');
    const found = await picker().innerText();
    ok('search crosses tools', found.includes('GPT-6 Luna') && !found.includes('Opus'), found);
    await shot(page, 'r29-search-1440-dark');
    await picker().getByLabel('Search models').fill('');
    await picker().getByRole('button', { name: 'Add GPT-6 Luna to favourites' }).count();

    // Cancel keeps everything.
    await picker().getByLabel('Search models').fill('luna');
    await picker().getByRole('menuitemradio', { name: /GPT-6 Luna/ }).click();
    const sheet = () => page.getByRole('alertdialog').first();
    await h.until(async () => (await sheet().count()) > 0, 5000);
    const said = (await sheet().innerText().catch(() => '')) ?? '';
    ok('a cross-tool pick asks, and says the text goes to OpenAI', said.includes('OpenAI'), said);
    await shot(page, 'r29-confirm-1440-dark');
    await sheet().getByRole('button', { name: /Stay here/ }).click();
    await page.waitForTimeout(500);
    ok('Stay here opens nothing', (await h.vis('.agent-tab-title').count()) <= 1 || !(await h.paneText()).includes('Starting Codex'));

    // Confirm opens a chat beside the old one, and its first turn carries the text.
    await openPicker(page, h);
    await picker().getByLabel('Search models').fill('luna');
    await picker().getByRole('menuitemradio', { name: /GPT-6 Luna/ }).click();
    await h.until(async () => (await sheet().count()) > 0, 5000);
    await sheet().getByRole('button', { name: /Open new chat/ }).click();
    // The seed is rendered by a short child first: on a busy Mac that takes seconds.
    ok('the new chat opens on Codex', await h.until(async () => /Message Codex/.test((await h.vis('.chat-cmp-input').first().getAttribute('placeholder').catch(() => '')) ?? ''), 45000));
    await h.send('HISTORY what did we say?');
    await h.waitText('Handed over: ', 30000);
    // Only the fake's own line counts: the old Claude tab holds the word too.
    ok('the new Codex chat saw the old conversation', /Handed over: .*marigold/.test(await h.paneText()), await h.paneText());
    await shot(page, 'r29-carried-1440-dark');
    ok('the seed was really written and left no trace in git', readFileSync(join(PROJ, '.gitignore'), 'utf-8').includes('.tool-handoff'));
    const seedLeft = spawnSync('ls', [join(PROJ, '_dream_context', 'state', '.tool-handoff')], { encoding: 'utf-8' }).stdout.trim();
    ok('the seed is consumed once', seedLeft === '', seedLeft);

    // The account chip and its panel, on this Codex chat.
    await openPicker(page, h);
    const chip = picker().getByTestId('model-picker-account-chip');
    ok('account: the chip names the active login', (await chip.innerText().catch(() => '')).includes('~/.codex'), await picker().innerText());
    await chip.click();
    const acct = await h.vis('[data-testid="model-picker-accounts"]').first().innerText().catch(() => '');
    ok('account: the panel lists every login, the switch and Add', acct.includes('ada@example.test') && acct.includes('Auto-switch') && acct.includes('Add'), acct);
    await shot(page, 'r29-account-1440-dark');
    await page.keyboard.press('Escape');

    // A signed-out tool.
    rmSync(join(HOME, '.codex', 'auth.json'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await expandSurface(page);
    await openPicker(page, h);
    await picker().getByRole('button', { name: /Codex/ }).first().click();
    const out = await h.vis('[data-testid="model-picker-signin"]').first().innerText().catch(() => '');
    ok('a signed-out tool says so and offers Sign in', out.includes('not signed in') && out.includes('Sign in'), out);
    await shot(page, 'r29-signin-1440-dark');
    writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"verify placeholder, not a credential"}');
    ok('the flow logged no console error', errors.length === 0, errors.join(' | '));
    await page.close();

    for (const [width, height] of [[1440, 960], [1024, 768], [390, 844]]) {
      for (const theme of ['dark', 'light']) {
        const v = await openPage(browser, base, { width, height, theme });
        const vh = helpers(v.page);
        if (!(await vh.vis('.chat-cmp-input').count())) await v.page.getByRole('button', { name: /Start chat/ }).first().click().catch(() => {});
        await vh.until(async () => (await vh.vis('.chat-cmp-input').count()) > 0, 8000);
        await openPicker(v.page, vh).catch(() => {});
        const box = await vh.vis('[data-testid="model-picker"]').first().boundingBox().catch(() => null);
        report.check(`${width} ${theme}`, 'the picker fits the window', !!box && box.x >= 0 && box.x + box.width <= width && box.y >= 0, JSON.stringify(box));
        await shot(v.page, `r29-${width}-${theme}`);
        report.check(`${width} ${theme}`, 'no console error', v.errors.length === 0, v.errors.join(' | '));
        await v.page.close();
      }
    }
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
  }
  const failed = report.results.filter((r) => !r.ok);
  console.log(`\n${report.results.length - failed.length}/${report.results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
