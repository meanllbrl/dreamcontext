#!/usr/bin/env node
/**
 * The Super Agent chat head with less text (owner 2026-11-05): no "you talk only to me" line,
 * no worded button (owner 2026-11-07), Add a card, New session and Turn off inside a ⋯ menu; and the left
 * drawer's "+ New Chat" reads "+ New window".
 *
 *   npm run build && TAG=after OUT=<dir> node scripts/verify/super-head-menu.mjs
 *
 * Real dashboard server, scratch HOME, a fictional project, a scripted `claude` (no tokens).
 * Screenshots (TAG-*.png into OUT): the head at 1440 wide and at a narrow card, dark and light;
 * with TAG=after also the ⋯ menu open, and the drawer's row. Checks (after only): the head has
 * no subtitle and no New session / Turn off button, the ⋯ menu opens by keyboard with both rows,
 * Esc and an outside click close it, and Turn off from the menu asks first.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.REPO ? resolve(process.env.REPO) : join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-head-menu-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = process.env.OUT ? resolve(process.env.OUT) : join(REPO, 'tmp', 'super-head-menu');
const TAG = process.env.TAG || 'after';
const REPORTS = join(SCRATCH, 'reports.ndjson');

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let convo = at('--resume') || at('--session-id') || '';
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, convo, pid: process.pid, t: Date.now(), ...o }) + '\\n');
report({ kind: 'spawn', tab: process.env.DREAMCONTEXT_TAB_SESSION || '' });
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
let session = 'v-' + process.pid;
let inited = false;
let rotations = 0;
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [];
    for (const n of ['one', 'two']) steps.push(cli('super', 'delegate', '--prompt', 'CHILD ' + n, '--brief', 'Child ' + n + ' rebuilds the invoice export with a very long title that cannot fit'));
    report({ kind: 'handover', steps });
    return 'arranged';
  }
  return 'ok';
}
function clear() {
  // What the CLI does with /clear: a new conversation, SessionStart(source=clear) in the pane's env.
  rotations += 1;
  const from = session;
  session = 'v-' + process.pid + '-r' + rotations;
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  const hook = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, 'hook', 'session-start'], {
    env: process.env, encoding: 'utf-8', timeout: 60000, cwd: process.cwd(),
    input: JSON.stringify({ source: 'clear', session_id: session, hook_event_name: 'SessionStart', cwd: process.cwd() }),
  });
  report({ kind: 'clear', from, to: session, hookStatus: hook.status, banner: (hook.stdout || '').split('\\n').filter((l) => l.startsWith('>> HANDOFF') || l.includes('.super/handoff.md')).slice(0, 4) });
}
async function turn(blocks) {
  const text = blocks[0] ?? '';
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  if (text === '/clear') {
    clear();
    out({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: session });
    return;
  }
  let said = 'ok';
  try { said = role === 'super' ? superTurn(text) : 'ok'; } catch (e) { said = 'error ' + e; }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }], usage: { input_tokens: 10, cache_read_input_tokens: 40000, output_tokens: 5 } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: session });
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
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    chain = chain.then(() => turn(blocks));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
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
const reports = () => readNd(REPORTS);

const result = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
  else { result.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
}

/** What the eye checks on one head: its height, the name's line count, every item inside the
 *  head's box and clear of its neighbours, no sideways scroll. Painted boxes, not styles. */

const AFTER = TAG !== 'before';
const shotPath = (name) => join(OUT, `${TAG}-${name}.png`);

async function newPage(browser, theme, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript((t) => { try { localStorage.setItem('dreamcontext-theme', t); } catch { /* none */ } }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { context, page, errors };
}

/** Scene A: the Super Agent's centre head, after a scripted handover. */
async function sceneHead(browser, base) {
  const { context, page, errors } = await newPage(browser, 'dark');
  console.log('\n── the Super centre head');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  await page.waitForTimeout(1500);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 60000));
  const centre = page.getByTestId('super-centre');
  const head = centre.locator('.super-centre-head');
  ok('the centre head is drawn', await until(page, async () => (await head.count()) === 1 && (await centre.locator('.super-centre-name').isVisible()), 20000));
  await page.waitForTimeout(1500);

  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { localStorage.setItem('dreamcontext-theme', t); document.documentElement.setAttribute('data-theme', t); }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(400);
    await head.screenshot({ path: shotPath(`head-wide-${theme}`) });
    await page.screenshot({ path: shotPath(`stage-1440-${theme}`) });
    const was = await centre.evaluate((el) => el.style.width);
    await centre.evaluate((el) => { el.style.setProperty('width', '380px', 'important'); });
    await page.waitForTimeout(300);
    await head.screenshot({ path: shotPath(`head-narrow-${theme}`) });
    // Back to the plan's own width (the stage sets it inline; removing it would leave none).
    await centre.evaluate((el, w) => { el.style.removeProperty('width'); el.style.width = w; }, was);
    await page.waitForTimeout(300);
  }

  if (AFTER) {
    console.log('── the ⋯ menu');
    const more = head.getByTestId('super-head-more');
    ok('the head has no subtitle, no New session and no Turn off button', (await head.locator('.super-centre-sub, [data-testid="super-fresh-btn"], [data-testid="super-turn-off-btn"]').count()) === 0);
    ok('no + Add in the head and ⋯ is there', (await head.getByTestId('super-add-btn').count()) === 0 && (await more.isVisible()));
    await more.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('super-head-menu');
    ok('Enter opens the menu', await until(page, async () => menu.isVisible(), 3000));
    const items = await menu.locator('[role="menuitem"]').allTextContents();
    ok('the menu has Add a card, New session, then Turn off', items.length === 3 && /Add a card/.test(items[0]) && /New session/.test(items[1]) && /Turn off/.test(items[2]), JSON.stringify(items));
    ok('focus is on the first row', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'super-head-add'));
    await page.keyboard.press('ArrowDown');
    ok('ArrowDown moves to New session', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'super-head-fresh'));
    await page.keyboard.press('ArrowDown');
    ok('ArrowDown moves to Turn off', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'super-head-off'));
    await page.evaluate(() => document.activeElement && (document.activeElement.blur(), 0));
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { localStorage.setItem('dreamcontext-theme', t); document.documentElement.setAttribute('data-theme', t); }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(300);
      const box = await head.boundingBox();
      await page.screenshot({ path: shotPath(`menu-open-${theme}`), clip: { x: Math.max(0, box.x + box.width - 420), y: Math.max(0, box.y - 8), width: Math.min(420, box.width), height: 170 } });
    }
    await page.keyboard.press('Escape');
    ok('Esc closes the menu and focus goes back to ⋯', await until(page, async () => !(await menu.count()), 2000) && await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'super-head-more'));
    await more.click();
    ok('a click opens it again', await until(page, async () => menu.isVisible(), 2000));
    // Outside the menu but inside the head (the name): a press anywhere else on the stage may move cards.
    await centre.locator('.super-centre-name').click();
    ok('a click outside closes it', await until(page, async () => !(await menu.count()), 2000));
    await more.click();
    await page.getByTestId('super-head-off').click();
    ok('Turn off from the menu asks first', await until(page, async () => (await page.getByText('Turn off the Super Agent?').count()) > 0, 3000));
    await page.screenshot({ path: shotPath('turn-off-asks') });
    await page.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
    await page.waitForTimeout(400);
    ok('Cancel keeps the Super Agent on', (await centre.count()) === 1);
  }
  ok('no console errors (head)', errors.length === 0, errors.slice(0, 5).join('\n'));
  await context.close();
}

/** Scene B: the left drawer's new-window row, in the new shell. */
async function sceneDrawer(browser) {
  console.log('\n── the drawer row');
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme-app'], projectOrder: ['acme-app'], lastVault: 'acme-app' }));
  spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  // A member of its own: the drawer then keeps its new-window row under the Chat row (r8-07).
  spawnSync(process.execPath, [CLI, 'agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'Reads the funnel.'], { cwd: PROJ, env: env(), encoding: 'utf-8' });
  writeFileSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions: [{ title: 'Invoice export', kind: 'chat', sessionId: '0b7c2a4e-1111-4c1d-9a3e-5d2f0c9b7a11', pane: 0, active: true, window: 'main', size: 1 }], activePane: 0, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 0 }], generation: 1 }));
  const port = await freePort();
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  mkdirSync(join(SCRATCH, 'cwd'), { recursive: true });
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--launcher', '--no-open', '-p', String(port)], { cwd: join(SCRATCH, 'cwd'), env: { ...env(), PATH }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { await new Promise((r) => setTimeout(r, 300)); } }
    for (const theme of ['dark', 'light']) {
      const { context, page, errors } = await newPage(browser, theme);
      await page.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
      await page.goto(`http://127.0.0.1:${port}/?vault=acme-app`);
      await page.waitForTimeout(2500);
      const gotIt = page.getByRole('button', { name: 'Got it' });
      if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
      const row = page.locator('[data-drawer-project="acme-app"]');
      ok(`[${theme}] the drawer project is drawn`, await until(page, async () => row.isVisible(), 10000));
      const label = (await row.getByTestId('drawer-new-chat').textContent().catch(() => '')) ?? '';
      if (AFTER) ok(`[${theme}] the row reads New window`, /New window/.test(label), label);
      await row.screenshot({ path: shotPath(`drawer-${theme}`) });
      ok(`[${theme}] no console errors (drawer)`, errors.length === 0, errors.slice(0, 5).join('\n'));
      await context.close();
    }
  } finally { srv.kill(); }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    setupScratch();
    const port = await freePort();
    const srv = await startServer(port);
    try { await sceneHead(browser, `http://127.0.0.1:${port}`); }
    catch (e) { ok('scene head ran to the end', false, e?.stack ?? e); }
    finally { srv.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
    try { await sceneDrawer(browser); }
    catch (e) { ok('scene drawer ran to the end', false, e?.stack ?? e); }
    finally { spawnSync('pkill', ['-f', SCRATCH]); }
  } finally { await browser.close(); }
  console.log(`\n${result.pass} passed, ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  console.log(`screenshots: ${OUT}`);
  if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
