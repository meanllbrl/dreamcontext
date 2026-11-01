#!/usr/bin/env node
/**
 * The new shell's drawer lists chats by name (hands-free phone in the new shell, W1).
 *
 *   npm run build && node scripts/verify/drawer-chats.mjs
 *
 * WHAT IT DRIVES: the real built dashboard (scratch HOME, fictional projects, a `claude` stand-in
 * that logs every spawn and answers every message except one holding "HOLD", which keeps its
 * turn running). Three "windows" are three Chromium contexts with the Tauri marker (so each is
 * the Mac's own app window and reads `live-chats`):
 *   - the window under test, on acme (two chat windows, three chats);
 *   - a second window holding initech, whose restored chat runs (so initech is NOT mounted in the
 *     first window but has a running chat there);
 *   - a third window holding globex, handed over to its Super Agent, whose owner chat runs.
 *
 * CHECKS (W1 criteria): rows by name with state, waiting first, each once; 2+ windows nest; a
 * handed-over project not mounted shows its window row and no live rows; mounted, it shows the
 * owner's chat and never the Super's child, and a tap on it from the stage shows that chat; a
 * running chat of a project not mounted opens ADOPTED (`reattach=1`, the stand-in spawned once);
 * close closes the tab and it does not come back, a working chat asks first in the app's own
 * dialog; Past chats opens History and a pick opens in its own project; the live read stops while
 * the drawer is hidden; 1440, 1024 and 390 (mouse) screenshots with no sideways overflow; the
 * classic shell draws no drawer and no chat row.
 *
 * FAILURE POLICY: collect, don't fail fast; exit 0 iff every check passed and no console error.
 * Screenshots: tmp/verify-drawer-chats/*.png
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-drawer-chats-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const SPAWNS = join(HOME, 'spawns.log');
const SHOTS = join(REPO, 'tmp', 'verify-drawer-chats');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');

const STANDIN = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
fs.appendFileSync(path.join(process.env.HOME, 'spawns.log'), JSON.stringify({ pid: process.pid, sid, resume: !!at('--resume') }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    if (text.includes('HOLD')) continue;
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ECHO ' + text }] };
    out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ECHO', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const SOCKETS = `(() => {
  const Real = window.WebSocket;
  window.__chatUrls = [];
  window.WebSocket = class extends Real {
    constructor(url, protocols) { super(url, protocols); if (String(url).includes('/api/agent/chat')) window.__chatUrls.push(String(url)); }
  };
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
})();`;

const report = { pass: 0, fails: [], console: [], shots: [] };
const check = (label, cond, detail) => {
  if (cond) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 300)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME });
const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: 'utf-8' });
const spawns = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const ID = {
  pricing: crypto.randomUUID(), funnel: crypto.randomUUID(), research: crypto.randomUUID(),
  initRun: crypto.randomUUID(), initPast: crypto.randomUUID(),
  globexOwn: crypto.randomUUID(), globexChild: crypto.randomUUID(), globexSuper: crypto.randomUUID(),
};

function project(name) {
  const p = join(SCRATCH, name);
  mkdirSync(join(p, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', p, 'init', '-q']);
  const r = cli(p, 'vaults', 'add', name, p);
  if (r.status !== 0) throw new Error(`vaults add ${name}: ${r.stderr || r.stdout}`);
  return p;
}
const roster = (p, sessions, windows = [{ id: 'main', name: 'Chat', activePane: 0 }]) => writeFileSync(join(p, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows, generation: 1 }));
const tab = (title, sessionId, window = 'main', o = {}) => ({ title, kind: 'chat', sessionId, pane: 0, active: false, window, size: 1, bypass: false, minimized: false, ...o });
const transcript = (p, sid, text) => {
  const dir = join(HOME, '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const row = (o) => JSON.stringify({ ...o, cwd: p, uuid: crypto.randomUUID(), timestamp: new Date(Date.now() - 3600_000).toISOString(), sessionId: sid });
  writeFileSync(join(dir, `${sid}.jsonl`), [row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }), row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answered.' }] } })].join('\n') + '\n');
};

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  const acme = project('acme'); const globex = project('globex'); const initech = project('initech');
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme', 'globex', 'initech'], projectOrder: ['acme', 'globex', 'initech'], lastVault: 'acme' }));
  // acme: two chat windows, three chats.
  roster(acme, [
    tab('Pricing notes', ID.pricing, 'main', { active: true }),
    tab('Funnel check', ID.funnel, 'main'),
    tab('Market research', ID.research, 'w2'),
  ], [{ id: 'main', name: 'Chat', activePane: 0 }, { id: 'w2', name: 'Research', activePane: 0 }]);
  // initech: one chat (it runs in the second window), one past chat only on disk.
  roster(initech, [tab('Initech running chat', ID.initRun, 'main', { active: true })]);
  transcript(initech, ID.initPast, 'Initech old question about churn');
  // globex: handed over; the owner's chat and one child of the Super in the roster.
  writeFileSync(join(globex, '_dream_context', 'state', '.super-agent.json'), JSON.stringify({
    v: 1, session: ID.globexSuper, enabled: true, containers: [], groups: [], view: { mode: 'float' },
    children: { [ID.globexChild]: { sessionId: ID.globexChild, startedAt: Date.now() - 60_000 } },
    queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [],
  }));
  roster(globex, [tab('Globex owner chat', ID.globexOwn, 'main', { active: true }), tab('Globex child job', ID.globexChild, 'main')]);
  return { acme, globex, initech };
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  mkdirSync(join(SCRATCH, 'cwd'), { recursive: true });
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--launcher', '--no-open', '-p', String(port)], { cwd: join(SCRATCH, 'cwd'), env: { ...env(), PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore' });
  if (!(await until(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok, 40_000, 300))) { srv.kill(); throw new Error('server did not come up'); }
  return srv;
}

let shotN = 0;
const shot = async (p, name) => { const f = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`); await p.screenshot({ path: f }); report.shots.push(f); };
const dismiss = async (p) => {
  for (let i = 0; i < 3; i++) {
    const g = p.getByRole('button', { name: 'Got it' });
    if (await g.isVisible().catch(() => false)) { await g.click(); await sleep(300); continue; }
    const x = p.locator('.announcements-modal-close');
    if (await x.count()) { await x.first().click().catch(() => {}); await sleep(300); continue; }
    break;
  }
};
async function windowCtx(browser, base, vault, { w = 1440, h = 900, watch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
  await ctx.addInitScript(SOCKETS);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  if (watch) {
    p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource|__TAURI|tauri/i.test(m.text())) report.console.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => { if (!/__TAURI|tauri|invoke/i.test(String(e))) report.console.push(String(e).slice(0, 200)); });
  }
  await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
  await p.goto(`${base}/?vault=${vault}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await dismiss(p);
  return { ctx, p };
}
const proj = (p, vault) => p.locator(`[data-drawer-project="${vault}"]`);
const chatRow = (p, vault, title) => proj(p, vault).locator('[data-testid="drawer-chat-row"]', { hasText: title });
const chatTitles = (p, vault) => proj(p, vault).locator('[data-testid="drawer-chat-row"] .ns-dr-t').allTextContents();
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const onScreen = (p) => p.evaluate(() => document.querySelector('.project-instance:not([hidden])')?.getAttribute('data-instance') ?? document.querySelector('.project-instance:not([hidden])')?.dataset?.vault ?? null);
const shownTabTitle = (p) => p.evaluate(() => {
  const i = document.querySelector('.project-instance:not([hidden])');
  const sel = i?.querySelector('.agent-overlay-head [role="tab"][aria-selected="true"], .agent-tab.active, .agent-tab[aria-selected="true"]');
  return sel?.textContent?.trim() ?? null;
});
async function sendIn(p, text) {
  const box = p.locator('.project-instance:not([hidden]) .chat-pane textarea, .project-instance:not([hidden]) .chat-pane [contenteditable="true"]').first();
  await box.click();
  await p.keyboard.type(text);
  await p.keyboard.press('Enter');
}

let srv = null;
let browser = null;
/** The route answers the app's own window only: read it from a page, never from Node. */
let livePage = null;
const liveNow = async () => (livePage ? livePage.evaluate(() => fetch('/api/agent/live-chats', { headers: { 'X-Dreamcontext-Vault': 'acme' } }).then((r) => r.json())) : { chats: [] });
try {
  const { chromium } = await import('@playwright/test');
  console.log(`· build: ${CLI}`);
  const dirs = seed();
  const port = await freePort();
  srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();

  // ── The other windows: initech's chat and globex's owner chat run there ──
  const initW = await windowCtx(browser, base, 'initech');
  livePage = initW.p;
  const initLive = await until(async () => (await liveNow()).chats.some((c) => c.conversationId === ID.initRun), 25_000);
  check('initech\'s chat runs in another window', initLive);
  const globexW = await windowCtx(browser, base, 'globex');
  const globexLive = await until(async () => (await liveNow()).chats.some((c) => c.vault === 'globex'), 25_000);
  check('globex has a running chat in another window', globexLive);

  // ── The window under test, on acme at 1440 ──
  const { p } = await windowCtx(browser, base, 'acme', { watch: true });
  livePage = p;
  const liveReads = [];
  p.on('request', (r) => { if (r.url().includes('/api/agent/live-chats')) liveReads.push(Date.now()); });
  if (await p.locator('[data-testid="ns-rail-chat"]').first().isVisible().catch(() => false)) { await p.locator('[data-testid="ns-rail-chat"]').first().click(); await sleep(900); }
  await until(async () => (await chatTitles(p, 'acme')).length === 3, 15_000);
  await until(async () => (await chatRow(p, 'initech', 'Initech running chat').count()) > 0, 20_000);
  await shot(p, 'w1-1440-drawer');

  // 1. Rows by name with their state, each chat once; 2+ windows nest.
  const acmeTitles = await chatTitles(p, 'acme');
  check('1: acme\'s chats by name, each once', ['Pricing notes', 'Funnel check', 'Market research'].every((t) => acmeTitles.filter((x) => x === t).length === 1), JSON.stringify(acmeTitles));
  const states = await proj(p, 'acme').locator('[data-testid="drawer-chat-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
  check('1: every row carries its state', states.length === 3 && states.every((s) => ['asking', 'working', 'idle'].includes(s)), JSON.stringify(states));
  const shape = await proj(p, 'acme').locator('[data-testid="drawer-window-row"], [data-testid="drawer-chat-row"]').evaluateAll((els) => els.map((e) => (e.dataset.testid === 'drawer-window-row' ? `win:${e.dataset.windowId}` : `chat:${e.closest('.ns-dr-chat')?.classList.contains('is-nested') ? 'nested' : 'flat'}:${e.textContent}`)));
  report.acmeShape = shape;
  check('5: two windows keep their rows and their chats nest under them', shape[0] === 'win:main' && shape.filter((s) => s.startsWith('win:')).length === 2 && shape.filter((s) => s.startsWith('chat:nested')).length === 3, JSON.stringify(shape));

  // 2. Handed over, not mounted: its window row and no live rows (globex's chat runs).
  const globexRows = await proj(p, 'globex').locator('[data-testid="drawer-chat-row"]').count();
  check('2: a handed-over project not mounted lists no live rows', globexRows === 0, String(globexRows));
  check('2: …and keeps its window row', (await proj(p, 'globex').locator('[data-testid="drawer-window-row"]').count()) > 0);
  // Each chat once across the drawer: the running initech chat is one row.
  check('1: initech\'s running chat is one row by name', (await chatRow(p, 'initech', 'Initech running chat').count()) === 1);

  // 3. A running chat of a project not mounted opens ADOPTED: same process, no respawn.
  const before = spawns().filter((s) => s.sid === ID.initRun).length;
  await chatRow(p, 'initech', 'Initech running chat').click();
  const adopted = await until(async () => (await p.evaluate(() => window.__chatUrls)).some((u) => u.includes(encodeURIComponent('initech')) || u.includes('initech')), 15_000);
  await sleep(2500);
  const urls = await p.evaluate(() => window.__chatUrls);
  // A restore of the tab may open its passive socket first; the tap's adoption is the evicting one.
  const initUrl = urls.find((u) => u.includes('vault=initech') && u.includes(ID.initRun) && /[?&]reattach=1\b/.test(u))
    ?? urls.find((u) => u.includes('vault=initech'));
  report.initUrls = urls.filter((u) => u.includes('vault=initech'));
  report.initUrl = initUrl;
  check('3: the tap opened initech here', adopted && (await onScreen(p)) !== 'acme', String(await onScreen(p)));
  check('3: it attached with reattach=1 (an adoption, not a resume beside it)', !!initUrl && /[?&]reattach=1\b/.test(initUrl), initUrl);
  const after = spawns().filter((s) => s.sid === ID.initRun).length;
  check('3: no respawn: the stand-in for that chat was started once', before === 1 && after === 1, `before ${before} after ${after}`);
  check('3: the chat is still the one live process', (await liveNow()).chats.filter((c) => c.conversationId === ID.initRun).length === 1);
  await shot(p, 'w1-1440-adopted');

  // 4. Close: the tab closes and does not come back as a live row.
  await until(async () => (await chatRow(p, 'initech', 'Initech running chat').count()) === 1, 10_000);
  await chatRow(p, 'initech', 'Initech running chat').hover();
  await proj(p, 'initech').locator('.ns-dr-chat', { hasText: 'Initech running chat' }).locator('[data-testid="drawer-chat-close"]').click();
  const gone = await until(async () => (await chatRow(p, 'initech', 'Initech running chat').count()) === 0, 8000);
  await sleep(4000);
  check('4: close closed the tab', gone);
  check('4: and it does not come back as a live row', (await chatRow(p, 'initech', 'Initech running chat').count()) === 0);
  check('4: its process ended', await until(async () => !(await liveNow()).chats.some((c) => c.conversationId === ID.initRun), 10_000));

  // 4. A working chat asks first, in the app's own dialog.
  await chatRow(p, 'acme', 'Funnel check').click();
  await sleep(2500);
  await sendIn(p, 'HOLD this turn please');
  const working = await until(async () => (await chatRow(p, 'acme', 'Funnel check').getAttribute('data-state')) === 'working', 10_000);
  check('4: the held turn reads as working', working, await chatRow(p, 'acme', 'Funnel check').getAttribute('data-state').catch(() => null));
  await chatRow(p, 'acme', 'Funnel check').hover();
  await proj(p, 'acme').locator('.ns-dr-chat', { hasText: 'Funnel check' }).locator('[data-testid="drawer-chat-close"]').click();
  const dialog = p.getByRole('alertdialog');
  check('4: a working chat asks first', await dialog.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false));
  await shot(p, 'w1-1440-confirm');
  await dialog.getByRole('button', { name: 'Keep it open' }).click().catch(() => {});
  await sleep(600);
  check('4: Keep keeps it', (await chatRow(p, 'acme', 'Funnel check').count()) === 1);
  await chatRow(p, 'acme', 'Funnel check').hover();
  await proj(p, 'acme').locator('.ns-dr-chat', { hasText: 'Funnel check' }).locator('[data-testid="drawer-chat-close"]').click();
  await p.getByRole('alertdialog').getByRole('button', { name: 'Close chat' }).click().catch(() => {});
  check('4: Close chat closes it', await until(async () => (await chatRow(p, 'acme', 'Funnel check').count()) === 0, 6000));

  // 2. Handed over and mounted: the owner's chat, never the child; a tap from the stage shows it.
  // No other screen holds globex's chat from here on: the tap must show the chat itself.
  await globexW.ctx.close();
  await sleep(1500);
  await proj(p, 'globex').locator('[data-testid="drawer-super-row"]').click();
  const stage = await until(async () => p.evaluate(() => !!document.querySelector('.project-instance:not([hidden]) .super-centre')), 15_000);
  check('2: globex\'s Super row lands on its stage', stage);
  await until(async () => (await chatTitles(p, 'globex')).length > 0, 15_000);
  const gTitles = await chatTitles(p, 'globex');
  report.globexTitles = gTitles;
  check('2: mounted, it lists the owner\'s chat', gTitles.includes('Globex owner chat'), JSON.stringify(gTitles));
  check('2: …and never the Super\'s child', !gTitles.includes('Globex child job'), JSON.stringify(gTitles));
  await shot(p, 'w1-1440-globex-stage');
  await chatRow(p, 'globex', 'Globex owner chat').click();
  await sleep(2500);
  const shownChat = await p.evaluate(() => {
    const i = document.querySelector('.project-instance:not([hidden])');
    const panes = i?.querySelector('.agent-panes');
    return { panes: !!panes && getComputedStyle(panes).display !== 'none' && panes.getBoundingClientRect().height > 100, head: i?.querySelector('.agent-overlay-head')?.textContent ?? '' };
  });
  report.globexShown = shownChat;
  const banner = await p.locator('.project-instance:not([hidden])').getByText('This chat is open on your phone').count();
  check('2: a tap on it from the stage shows that chat', shownChat.panes && shownChat.head.includes('Globex owner chat') && banner === 0, JSON.stringify({ ...shownChat, banner }));
  await shot(p, 'w1-1440-globex-chat');

  // 5. Past chats opens History; a pick opens in its own project.
  await p.getByTestId('drawer-history').click();
  await sleep(800);
  // History opens on the project on screen; the past chat is initech's.
  await p.getByTestId('chp-projects').getByText('initech', { exact: true }).click().catch(() => {});
  const hist = await until(async () => (await p.locator('.chp-row', { hasText: 'Initech old question' }).count()) > 0, 15_000);
  check('5: Past chats opens History, across projects', hist);
  await shot(p, 'w1-1440-history');
  await p.locator('.chp-row', { hasText: 'Initech old question' }).first().click();
  await sleep(3500);
  const pickedVault = await p.evaluate(() => [...document.querySelectorAll('.project-instance')].find((e) => !e.hidden)?.outerHTML.slice(0, 200));
  report.pickedVault = pickedVault;
  const pickUrl = (await p.evaluate(() => window.__chatUrls)).filter((u) => u.includes('vault=initech')).pop();
  check('5: the pick opened in initech, its own project', !!pickUrl && pickUrl.includes(ID.initPast), pickUrl);
  await shot(p, 'w1-1440-history-pick');

  // 6. The live read stops while the drawer is hidden (the unfocused half is the unit test's).
  if (!(await p.getByTestId('chat-drawer').isVisible().catch(() => false))) await p.getByTestId('ns-drawer-toggle').click();
  await sleep(500);
  const seenWhileOpen = liveReads.length;
  await p.getByTestId('ns-drawer-toggle').click();
  await sleep(800);
  check('6: the drawer is hidden', !(await p.getByTestId('chat-drawer').isVisible().catch(() => false)));
  const mark = liveReads.length;
  await sleep(20_000);
  check('6: no live read while the drawer is hidden (20 s, the poll is 15 s)', liveReads.length === mark, `${liveReads.length - mark} reads`);
  check('6: it did read while the drawer was open', seenWhileOpen > 0, String(seenWhileOpen));
  await p.getByTestId('ns-drawer-toggle').click();
  await sleep(1500);

  // Widths: 1440, 1024, 390 with a mouse.
  for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]]) {
    await p.setViewportSize({ width: w, height: h });
    await sleep(900);
    if (!(await p.getByTestId('chat-drawer').isVisible().catch(() => false))) { await p.getByTestId('ns-drawer-toggle').click(); await sleep(700); }
    const rows = await p.locator('[data-testid="drawer-chat-row"]').count();
    const over = await overflow(p);
    check(`${w}: chat rows on screen, no sideways overflow`, rows > 0 && over <= 1, `rows ${rows} overflow ${over}`);
    await shot(p, `w1-${w}-drawer`);
  }

  // The classic shell: no drawer, no chat row.
  await initW.ctx.close();
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'classic' }));
  const classic = await windowCtx(browser, base, 'acme');
  await sleep(1500);
  check('7: the classic shell draws no drawer and no chat row', (await classic.p.locator('[data-testid="chat-drawer"], [data-testid="drawer-chat-row"]').count()) === 0);
  check('7: the classic shell keeps its chip strip', await classic.p.locator('.window-chrome-bar').first().isVisible().catch(() => false));
  await shot(classic.p, 'w1-classic');
} catch (e) {
  report.fails.push(`threw: ${String(e?.stack ?? e).slice(0, 400)}`);
  console.log(`  ✗ threw: ${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  await browser?.close().catch(() => {});
  srv?.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
for (const c of report.console) console.log(`  console: ${c}`);
if (report.console.length) report.fails.push(`${report.console.length} console error(s)`);
for (const f of report.shots) console.log(`screenshot: ${f}`);
console.log(`${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `: ${report.fails.join(' | ')}` : ''}`);
process.exit(report.fails.length ? 1 : 0);
