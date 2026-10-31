#!/usr/bin/env node
/**
 * /verify for the owner's drawer notes of 2026-10-31. Real dashboard, scratch HOME, fictional
 * projects, a scripted `claude` stand-in (no tokens spent).
 *   node scripts/verify/drawer-landing.mjs --repo <checkout with dist> --out <dir> --tag before|after
 * Prints a JSON report; exit 1 on a failed check (after).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const REPO = resolve(arg('repo', '.'));
const OUT = resolve(arg('out', 'tmp/develop/shots'));
const TAG = arg('tag', 'after');
const PORT = Number(arg('port', TAG === 'before' ? 45851 : 45852));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-landing-${TAG}-${process.pid}`);
const report = { tag: TAG, checks: {}, failures: [], console: [] };
const check = (name, ok, detail) => { report.checks[name] = ok ? 'ok' : `FAIL ${detail ?? ''}`; if (!ok) report.failures.push(name); };
mkdirSync(OUT, { recursive: true });

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
`;

function world(name) {
  const root = join(SCRATCH, name);
  const HOME = join(root, 'home');
  const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
  const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  return { root, HOME, env, dc };
}

function project(w, name) {
  const p = join(w.root, name);
  mkdirSync(join(p, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', p, 'init', '-q']);
  w.dc(p, 'vaults', 'add', name, p);
  return p;
}

const record = (session, extra = {}) => ({ v: 1, session, enabled: true, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [], ...extra });
const roster = (p, sessions, windows = [{ id: 'main', name: 'Chat', activePane: 0 }]) => writeFileSync(join(p, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows, generation: 1 }));

function thread(p, slug, runId, entries) {
  const dir = threadDirOf(p, slug);
  mkdirSync(dir, { recursive: true });
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const base = Date.now() - 60000;
  const body = entries.map((e, i) => `<!-- dc-thread-entry -->\n\`\`\`json\n${JSON.stringify({ id: `${String(base + i).padStart(14, '0')}-000-${slug}`, runId, at: new Date(base + i).toISOString(), ...e })}\n\`\`\`\n`).join('\n');
  writeFileSync(join(dir, `${day}.md`), body);
}
const threadDirOf = (p, slug) => join(p, '_dream_context', 'automations', 'threads', slug);

function seedMain() {
  const w = world('main');
  const acme = project(w, 'acme'); const globex = project(w, 'globex'); const initech = project(w, 'initech');
  writeFileSync(join(w.HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme', 'globex', 'initech'], projectOrder: ['acme', 'globex', 'initech'], lastVault: 'acme' }));
  for (const [slug, title] of [['scout', 'Scout'], ['owl', 'Owl']]) w.dc(acme, 'agents', 'create', slug, '--title', title, '--prompt', 'Reads the funnel.');
  const run = new Date(Date.now() - 60000).toISOString();
  thread(acme, 'scout', run, [{ kind: 'user', via: 'super', text: 'Check the funnel' }, { kind: 'system', event: 'started', via: 'runner', text: 'started' }]);
  thread(acme, 'owl', run, [{ kind: 'user', via: 'dashboard', text: 'Look at pricing' }, { kind: 'system', event: 'started', via: 'runner', text: 'started' }]);
  writeFileSync(join(acme, '_dream_context', 'state', '.super-agent.json'), JSON.stringify(record(randomUUID(), { team: [{ id: 't1', member: 'scout', runId: run }] })));
  roster(acme, [{ title: 'My own chat', kind: 'chat', sessionId: randomUUID(), pane: 0, active: true, window: 'main', size: 1 }]);
  // Globex: its Super is on, its chat window is empty. Initech: a saved chat, no Super yet.
  writeFileSync(join(globex, '_dream_context', 'state', '.super-agent.json'), JSON.stringify(record(randomUUID())));
  roster(globex, []);
  roster(initech, [{ title: 'Saved chat', kind: 'chat', sessionId: randomUUID(), pane: 0, active: true, window: 'main', size: 1 }]);
  return w;
}

function seedZero() {
  const w = world('zero');
  writeFileSync(join(w.HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true }));
  return w;
}

async function server(w, port) {
  const PATH = [join(w.HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  mkdirSync(join(w.root, 'cwd'), { recursive: true });
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--launcher', '--no-open', '-p', String(port)], { cwd: join(w.root, 'cwd'), env: { ...w.env(), PATH }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* up soon */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not come up');
}

const wait = (p, ms = 800) => p.waitForTimeout(ms);
const seen = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);
const shot = (p, name) => p.screenshot({ path: join(OUT, `${TAG}-${name}.png`) });
async function dismiss(p) { const g = p.getByRole('button', { name: 'Got it' }); if (await g.isVisible().catch(() => false)) { await g.click(); await wait(p, 300); } }
async function open(browser, port, url, { w = 1440, h = 900, dark = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light', recordVideo: { dir: join(OUT, `video-${TAG}`), size: { width: w, height: h } } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) report.console.push(m.text().slice(0, 200)); });
  p.on('pageerror', (e) => report.console.push(String(e).slice(0, 200)));
  await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
  await p.goto(`http://127.0.0.1:${port}${url}`);
  await wait(p, 2500);
  await dismiss(p);
  return { ctx, p };
}
/** Every animation frame until stopped: what the owner could see. */
const startFrames = (p) => p.evaluate(() => {
  const inst = () => document.querySelector('.project-instance:not([hidden])');
  const log = [];
  const t0 = performance.now();
  window.__frames = log;
  window.__stop = false;
  const tick = () => {
    const i = inst();
    const s = i?.querySelector('.agent-surface');
    log.push({
      t: Math.round(performance.now() - t0),
      drawer: !!document.querySelector('[data-testid="chat-drawer"]'),
      surface: !!s?.classList.contains('expanded'),
      zoom: !!s?.getAnimations?.().some((a) => a.animationName === 'agent-surface-zoom-in' && a.playState === 'running'),
      vault: i?.dataset.instance ?? null,
      tasks: !!i?.querySelector('[class*="kanban"]') && !s?.classList.contains('expanded'),
      stage: !!i?.querySelector('.super-centre'),
      tabs: !!i?.querySelector('.agent-overlay-head:not([hidden]) [role="tab"], .agent-overlay-head:not([hidden]) .agent-tab'),
      selected: document.querySelector('.ns-dr-child.is-sel')?.textContent ?? null,
    });
    if (!window.__stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopFrames = (p) => p.evaluate(() => { window.__stop = true; return window.__frames; });
async function burst(p, name, n = 7, gap = 160) { for (let i = 0; i < n; i++) { await shot(p, `${name}-${i}`); await wait(p, gap); } }
function judge(label, frames, { stage = false } = {}) {
  const after = frames.slice(1);
  const moved = after.findIndex((f) => f.surface || !f.drawer || f.tasks);
  const f = moved < 0 ? after : after.slice(moved);
  const end = f[f.length - 1];
  check(`${label}: the drawer never left`, f.every((x) => x.drawer), JSON.stringify(f.find((x) => !x.drawer)));
  check(`${label}: no page in between`, !f.some((x) => x.tasks));
  check(`${label}: no zoom`, !f.some((x) => x.zoom));
  if (stage) {
    check(`${label}: no chat tabs before the stage`, !f.some((x) => x.tabs));
    check(`${label}: lands on the stage`, !!end?.stage, JSON.stringify(end));
  }
  report[`frames:${label}`] = { count: frames.length, tabsSeen: f.filter((x) => x.tabs).length, tasksSeen: f.filter((x) => x.tasks).length, noDrawer: f.filter((x) => !x.drawer).length, zoom: f.filter((x) => x.zoom).length };
}
const clickProjectRow = async (p, vault, testid) => { await p.locator(`[data-drawer-project="${vault}"] [data-testid="${testid}"]`).first().click(); };

async function main(browser) {
  const w = seedMain();
  const srv = await server(w, PORT);
  const { ctx, p } = await open(browser, PORT, '/?vault=acme');
  try {
    if (await seen(p, '[data-testid="ns-rail-chat"]')) { await p.locator('[data-testid="ns-rail-chat"]').first().click(); await wait(p, 900); }
    await shot(p, '1-drawer');
    const acmeText = await p.locator('[data-drawer-project="acme"]').textContent();
    report.acmeRows = acmeText;
    check('1: a Super job leaves no row', !acmeText.includes('Scout'), acmeText);
    check('1: the owner\'s member stays', acmeText.includes('Owl'), acmeText);
    check('2: no closed Chat row on an empty project', (await p.locator('[data-drawer-project="globex"] [data-testid="drawer-window-row"]').count()) === 0);
    check('2: New Chat there instead', await seen(p, '[data-drawer-project="globex"] [data-testid="drawer-new-chat"]'));
    check('2: a saved chat keeps its row', await seen(p, '[data-drawer-project="initech"] [data-testid="drawer-window-row"]'));
    // 3: the member's page.
    const owl = p.locator('[data-drawer-project="acme"] [data-testid="drawer-member-row"]', { hasText: 'Owl' });
    if (await owl.isVisible().catch(() => false)) {
      await owl.click(); await wait(p, 2500);
      await shot(p, '3-member');
      const box = await p.locator('[data-testid="agent-conversation"]').first().boundingBox().catch(() => null);
      report.memberBox = box;
      check('3: the conversation has a height', (box?.height ?? 0) > 300, JSON.stringify(box));
      check('3: a composer is there', await seen(p, '[data-testid="agent-peek"] textarea, [data-testid="agent-peek"] [contenteditable="true"]'));
      await p.getByTestId('agent-peek-close').click().catch(() => {});
      await wait(p, 400);
    } else check('3: a member row to press', false);
    // 4: another project's Super, not mounted, from a chat.
    await startFrames(p);
    await clickProjectRow(p, 'globex', 'drawer-super-row');
    await burst(p, '4-super-far');
    await wait(p, 1500);
    judge('4 far Super from chat', await stopFrames(p), { stage: true });
    await shot(p, '4-super-far-end');
    // Back to a mounted project's chat, then a mounted Super from a page.
    await startFrames(p);
    await clickProjectRow(p, 'acme', 'drawer-window-row');
    await wait(p, 1200);
    judge('4 mounted chat', await stopFrames(p));
    await p.locator('[data-testid="ns-rail-tasks"]').first().click(); await wait(p, 900);
    await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 500);
    await startFrames(p);
    await clickProjectRow(p, 'globex', 'drawer-super-row');
    await wait(p, 1500);
    judge('4 mounted Super from a page', await stopFrames(p), { stage: true });
    // A far project's chat, from inside another project's page.
    await startFrames(p);
    await clickProjectRow(p, 'initech', 'drawer-window-row');
    await burst(p, '4-chat-far', 5);
    await wait(p, 1200);
    judge('4 far chat', await stopFrames(p));
    await shot(p, '4-chat-far-end');
    // A far project with no chat and no Super on: its Super hands over.
    // 2: New Chat is real: a tab, and the composer has the keys.
    await clickProjectRow(p, 'globex', 'drawer-new-chat').catch(() => {});
    await wait(p, 2500);
    await shot(p, '2-new-chat');
    check('2: New Chat opened a chat', await seen(p, '.project-instance:not([hidden]) .chat-pane textarea, .project-instance:not([hidden]) .chat-pane [contenteditable="true"]'));
    report.focus = await p.evaluate(() => document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''));
    check('2: the composer is focused', /TEXTAREA|contenteditable|ProseMirror/i.test(report.focus) || await p.evaluate(() => document.activeElement?.isContentEditable === true), report.focus);
    await p.keyboard.type('hello'); await wait(p, 200);
    await shot(p, '2-typed');
    // 5: New project.
    const row = p.getByTestId('drawer-new-project-row');
    check('5: the row is there', await seen(p, '[data-testid="drawer-new-project-row"]'));
    await shot(p, '5-drawer-top');
    if (await row.isVisible().catch(() => false)) {
      await row.click(); await wait(p, 1500);
      await shot(p, '6-new-project');
      const txt = await p.locator('.ob').first().textContent().catch(() => '');
      report.flowText = txt.slice(0, 120);
      check('6: titled New project', txt.includes('New project'), txt.slice(0, 80));
      check('6: no setup steps, no Skip', !/Skip for now|This Mac/.test(txt), txt.slice(0, 80));
      check('6: Cancel is there', txt.includes('Cancel'));
      await p.keyboard.press('Escape'); await wait(p, 600);
      check('5: Esc goes back, in place', !(await seen(p, '.ob')) && await seen(p, '[data-testid="chat-drawer"]'));
      await row.click(); await wait(p, 1200);
      await p.locator('.ob-skip').click(); await wait(p, 600);
      check('5: Cancel goes back, in place', !(await seen(p, '.ob')) && await seen(p, '[data-testid="chat-drawer"]'));
      await row.click(); await wait(p, 1200);
      await p.locator('.ob-choice').first().click(); await wait(p, 500);
      await p.locator('input.ob-input').first().fill('delta');
      await p.locator('input.ob-input').nth(1).fill(w.root);
      await p.locator('.ob-btn--primary, .ob-btn:not(.ob-btn--secondary):not(.ob-btn--ghost)').last().click(); await wait(p, 3500);
      await shot(p, '5-made');
      const go = p.locator('.ob-handoff .ob-btn').last();
      if (await go.isVisible().catch(() => false)) { await go.click(); await wait(p, 3000); }
      await shot(p, '5-landed');
      check('5: delta is in the drawer', await seen(p, '[data-drawer-project="delta"]'));
      const sel = await p.locator('[data-drawer-project="delta"] .is-sel').count();
      report.deltaText = await p.locator('[data-drawer-project="delta"]').textContent().catch(() => null);
      check('5: selected in the drawer', sel > 0, report.deltaText);
    }
  } finally { await ctx.close(); srv.kill(); }
}

async function zero(browser) {
  const w = seedZero();
  const port = PORT + 1;
  const srv = await server(w, port);
  const { ctx, p } = await open(browser, port, '/');
  try {
    await shot(p, '6-zero-welcome');
    const body0 = await p.locator('body').textContent();
    check('6 zero: no Skip on Welcome', !body0.includes('Skip for now'));
    const go = p.getByRole('button', { name: 'Get started' });
    if (await go.isVisible().catch(() => false)) { await go.click(); await wait(p, 1200); }
    await shot(p, '6-zero-first-project');
    const txt = await p.locator('.ob').first().textContent().catch(() => '');
    report.zeroText = txt.slice(0, 160);
    check('6 zero: says first project', txt.includes('Create your first project'), txt.slice(0, 100));
    check('6 zero: no Skip', !txt.includes('Skip for now'));
    check('6 zero: the three ways', /Create new/.test(txt) && /Open a folder/.test(txt) && /Clone from GitHub/.test(txt), txt.slice(0, 200));
    await p.keyboard.press('Escape'); await wait(p, 400);
    check('6 zero: Esc does not leave', await seen(p, '.ob'));
    await p.locator('.ob-choice').first().click(); await wait(p, 500);
    await p.locator('input.ob-input').first().fill('first-one');
    await p.locator('input.ob-input').nth(1).fill(w.root);
    await p.locator('.ob-btn--primary, .ob-btn:not(.ob-btn--secondary):not(.ob-btn--ghost)').last().click(); await wait(p, 3500);
    await shot(p, '6-zero-made');
    const h = p.locator('.ob-handoff .ob-btn').last();
    if (await h.isVisible().catch(() => false)) { await h.click(); await wait(p, 3500); }
    await shot(p, '6-zero-landed');
    report.zeroUrl = p.url();
    report.zeroBody = (await p.locator('body').textContent()).slice(0, 200);
    check('6 zero: the project opens in this window', await p.evaluate(() => !!document.querySelector('.project-instance:not([hidden])')), report.zeroUrl);
    check('6 zero: the drawer stands beside it', await seen(p, '[data-drawer-project="first-one"]'));
    check('6 zero: selected and ready', (await p.locator('[data-drawer-project="first-one"] .is-sel').count()) > 0 && await seen(p, '.project-instance:not([hidden]) .chat-pane textarea, .project-instance:not([hidden]) .chat-pane [contenteditable="true"]'), (await p.locator('body').textContent()).slice(0, 160));
  } finally { await ctx.close(); srv.kill(); }
}

const browser = await chromium.launch();
try {
  const only = arg('only', 'all');
  if (only !== 'zero') await main(browser).catch((e) => { report.failures.push(`main threw: ${String(e).slice(0, 300)}`); });
  if (only !== 'main') await zero(browser).catch((e) => { report.failures.push(`zero threw: ${String(e).slice(0, 300)}`); });
} finally { await browser.close(); rmSync(SCRATCH, { recursive: true, force: true }); }
console.log(JSON.stringify(report, null, 1));
process.exit(report.failures.length ? 1 : 0);
