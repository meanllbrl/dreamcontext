#!/usr/bin/env node
/**
 * The unseen dot (owner 2026-11-01), on the real dashboard with a scratch HOME and a scripted
 * `claude`: a chat on screen with the window in front loses it by itself, a chat off screen or a
 * window behind keeps it.
 *   npm run build && node scripts/verify/unseen-dot.mjs --out <dir> --tag after
 *   node scripts/verify/unseen-dot.mjs --cli <a build without the fix> --out <dir> --tag before
 * Prints one JSON report; exit 1 on a failed check.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = resolve(arg('cli', join(REPO, 'dist', 'index.js')));
const OUT = resolve(arg('out', join(REPO, 'tmp', 'verify-unseen-dot')));
const TAG = arg('tag', 'after');
const PORT = Number(arg('port', TAG === 'before' ? 45851 : 45852));
const SCRATCH = join(tmpdir(), `dc-unseen-${TAG}-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const ACME = join(SCRATCH, 'acme');
const report = { tag: TAG, checks: {}, console: [] };
const check = (name, ok, detail) => { report.checks[name] = ok ? 'ok' : `FAIL ${detail ?? ''}`; };
mkdirSync(OUT, { recursive: true });

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
let buf = '';
const finish = () => {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'v-' + process.pid });
};
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    setTimeout(finish, 2500);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(ACME, '_dream_context', 'state'), { recursive: true });
spawnSync('git', ['-C', ACME, 'init', '-q']);
mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off' }));
writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme'], projectOrder: ['acme'], lastVault: 'acme' }));
spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme', ACME], { cwd: ACME, env: env() });
writeFileSync(join(ACME, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({
  sessions: [
    { title: 'First', kind: 'chat', sessionId: randomUUID(), pane: 0, active: true, window: 'main', size: 1 },
    { title: 'Second', kind: 'chat', sessionId: randomUUID(), pane: 0, active: true, window: 'two', size: 1 },
  ],
  activePane: 0, chatPermissionMode: 'auto',
  windows: [{ id: 'main', name: 'First', activePane: 0 }, { id: 'two', name: 'Second', activePane: 0 }], generation: 1,
}));

const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(PORT)], { cwd: ACME, env: { ...env(), PATH }, stdio: 'ignore' });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* up soon */ }
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('dreamcontext-announcements-seen-all', '1');
    // The test's own window focus: a headless page is always "focused".
    window.__front = true;
    document.hasFocus = () => window.__front;
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) report.console.push(m.text().slice(0, 200)); });
  p.on('pageerror', (e) => report.console.push(String(e).slice(0, 200)));
  await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
  await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
  await p.waitForTimeout(2500);
  const gotIt = p.getByRole('button', { name: 'Got it' });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await p.keyboard.press('Escape');
  const shot = (name) => p.screenshot({ path: join(OUT, `${TAG}-${name}.png`) });
  const row = (id) => p.locator(`[data-testid="drawer-window-row"][data-window-id="${id}"]`);
  const open = async (id) => { await row(id).click(); await p.waitForTimeout(1200); };
  const dot = (id) => row(id).locator('.project-tab-flag').count().then((n) => n > 0);
  const send = async (text) => {
    const input = p.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill(text);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(500);
  };
  const front = (on) => p.evaluate((v) => { window.__front = v; window.dispatchEvent(new Event(v ? 'focus' : 'blur')); }, on);

  // 1. The turn ends with the chat on screen: no dot at all.
  await open('main');
  await send('one');
  await p.waitForTimeout(3500);
  check('on screen: a finished turn raises nothing', !(await dot('main')));

  // 2. Off screen it lights; the drawer alone takes it off (the recording's Chat 4).
  await send('two');
  await open('two');
  await p.waitForTimeout(3500);
  check('off screen: the dot lights', await dot('main'));
  await shot('1-off-screen-lit');
  await open('main');
  check('drawer: opening the chat takes the dot off, no tab click', !(await dot('main')));
  await shot('2-drawer-opened');

  // 3. The window behind: on screen, the dot still lights; coming back takes it off, no click.
  await send('three');
  await front(false);
  await p.waitForTimeout(3500);
  check('window behind: the dot lights on the chat on screen', await dot('main'));
  await shot('3-window-behind');
  await front(true);
  await p.waitForTimeout(600);
  check('window back in front: the dot goes by itself', !(await dot('main')));
  await shot('4-window-front');

  // 4. Another page: the chat is not on screen, the dot lights and stays until it is.
  await send('four');
  await p.locator('.ns-rail-btn').nth(1).click();
  await p.waitForTimeout(3500);
  report.page = { url: p.url(), chatPage: await p.locator('.chat-cmp-input:visible').count(), rows: await row('main').count(), drawer: await p.getByTestId('chat-drawer').count() };
  if (!(await row('main').count())) await p.getByTestId('ns-drawer-toggle').click().catch(() => {});
  await p.waitForTimeout(500);
  await shot('5-another-page');
  check('another page: the dot lights', await dot('main'));
  await p.locator('[data-testid="ns-rail-chat"]').click();
  await p.waitForTimeout(1000);
  check('back on the chat: the dot goes', !(await dot('main')));
  await ctx.close();
} catch (err) {
  check('run finished', false, String(err).slice(0, 300));
} finally {
  await browser.close();
  srv.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 1));
writeFileSync(join(OUT, `${TAG}-report.json`), JSON.stringify(report, null, 1));
process.exit(Object.values(report.checks).every((v) => v === 'ok') && !report.console.length ? 0 : 1);
