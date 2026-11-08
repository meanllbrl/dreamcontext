#!/usr/bin/env node
/**
 * /verify for the owner's note of 2026-11-03: a chat picked in History opens in its OWN chat
 * window and the chat area comes forward, from a chat window and from the Super stage alike; a
 * chat already open brings its window forward instead of a second copy. Real dashboard (dist/),
 * scratch HOME, a fictional project, a scripted `claude` stand-in (no tokens spent).
 *   node scripts/verify/history-pick.mjs --repo <checkout with dist> --out <dir> --tag before|after
 * Prints a JSON report; exit 1 on a failed check.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const PORT = Number(arg('port', TAG === 'before' ? 45861 : 45862));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-history-pick-${TAG}-${process.pid}`);
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

const root = join(SCRATCH, 'w');
const HOME = join(root, 'home');
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });

const OPEN_ID = randomUUID();
const PAST_A = randomUUID();
const PAST_B = randomUUID();

function seed() {
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  const p = join(root, 'acme');
  mkdirSync(join(p, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', p, 'init', '-q']);
  dc(p, 'vaults', 'add', 'acme', p);
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme'], projectOrder: ['acme'], lastVault: 'acme' }));
  const record = { v: 1, session: randomUUID(), enabled: true, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [] };
  writeFileSync(join(p, '_dream_context', 'state', '.super-agent.json'), JSON.stringify(record));
  writeFileSync(join(p, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({
    sessions: [{ title: 'My own chat', kind: 'chat', sessionId: OPEN_ID, pane: 0, active: true, window: 'main', size: 1 }],
    activePane: 0, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 0 }], generation: 1,
  }));
  // Past conversations in Claude's own transcript store for this project.
  const dir = join(HOME, '.claude', 'projects', p.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 3600_000;
  for (const [id, text, i] of [[OPEN_ID, 'My own chat question', 0], [PAST_A, 'Pricing page question', 1], [PAST_B, 'Funnel drop question', 2]]) {
    const at = new Date(t0 + i * 60_000).toISOString();
    const lines = [
      { type: 'user', message: { role: 'user', content: text }, sessionId: id, cwd: p, gitBranch: 'main', timestamp: at, uuid: randomUUID() },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'An answer.' }] }, sessionId: id, cwd: p, timestamp: at, uuid: randomUUID() },
    ];
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return p;
}

async function server(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  mkdirSync(join(root, 'cwd'), { recursive: true });
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--launcher', '--no-open', '-p', String(port)], { cwd: join(root, 'cwd'), env: { ...env(), PATH }, stdio: 'ignore' });
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

/** What the owner sees: the stage or the chat area, the shown tabs, the window rows. */
const state = (p) => p.evaluate(() => {
  const inst = document.querySelector('.project-instance:not([hidden])');
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rowsEl = [...document.querySelectorAll('[data-drawer-project="acme"] [data-testid="drawer-window-row"]')];
  return {
    stage: vis(inst?.querySelector('.super-centre')),
    panes: [...(inst?.querySelectorAll('.chat-pane') ?? [])].filter(vis).length,
    windows: rowsEl.length,
    selected: rowsEl.findIndex((e) => e.classList.contains('is-sel') || !!e.closest('.is-sel')),
    rows: rowsEl.map((e) => e.textContent.trim().slice(0, 40)),
  };
});

async function pickFromHistory(p, text) {
  await p.locator('[data-testid="drawer-history"]').first().click();
  await wait(p, 1500);
  await p.locator('.chp-row', { hasText: text }).first().click();
  await wait(p, 2500);
}

async function run(browser, w, h, label) {
  const { ctx, p } = await (async () => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark', recordVideo: { dir: join(OUT, `video-${TAG}-${label}`), size: { width: w, height: h } } });
    const p = await ctx.newPage();
    p.setDefaultTimeout(6000);
    p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) report.console.push(`${label}: ${m.text().slice(0, 200)}`); });
    p.on('pageerror', (e) => report.console.push(`${label}: ${String(e).slice(0, 200)}`));
    await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
    await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
    await wait(p, 3000);
    await dismiss(p);
    return { ctx, p };
  })();
  try {
    if (await seen(p, '[data-testid="ns-rail-chat"]')) { await p.locator('[data-testid="ns-rail-chat"]').first().click(); await wait(p, 900); }
    // A phone-width window keeps the drawer behind its toggle.
    if (!(await seen(p, '[data-testid="drawer-history"]')) && await seen(p, '[data-testid="ns-drawer-toggle"]')) { await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 500); }
    // Start in the chat window, the owner's ordinary place.
    await p.locator('[data-drawer-project="acme"] [data-testid="drawer-window-row"]').first().click();
    await wait(p, 1500);
    if (!(await seen(p, '[data-testid="drawer-history"]')) && await seen(p, '[data-testid="ns-drawer-toggle"]')) { await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 500); }
    const s0 = await state(p);
    report[`${label}:start`] = s0;
    await shot(p, `${label}-0-start`);

    // 1. From a chat window: a past chat with no tab (on the phone run, the desktop run already
    // opened it: its window comes forward, no new one).
    await pickFromHistory(p, 'Pricing page question');
    await shot(p, `${label}-1-landed`);
    if (!(await seen(p, '[data-testid="drawer-history"]')) && await seen(p, '[data-testid="ns-drawer-toggle"]')) { await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 500); }
    const s1 = await state(p);
    if (label !== 'desktop') {
      report[`${label}:1`] = s1;
      await shot(p, `${label}-1-from-chat`);
      check(`${label} 1: an open chat brings its window forward, no new one`, s1.windows === s0.windows && s1.selected === 1, JSON.stringify(s1));
      return;
    }
    report[`${label}:1`] = s1;
    await shot(p, `${label}-1-from-chat`);
    check(`${label} 1: opens in a new window`, s1.windows === s0.windows + 1, JSON.stringify(s1));
    check(`${label} 1: the new window is the one shown, holding one chat`, s1.selected === s1.windows - 1 && s1.panes === 1 && !s1.stage, JSON.stringify(s1));

    // 2. From the Super stage.
    await p.locator('[data-drawer-project="acme"] [data-testid="drawer-super-row"]').first().click();
    await wait(p, 1800);
    const s2a = await state(p);
    report[`${label}:2-stage`] = s2a;
    await shot(p, `${label}-2a-stage`);
    check(`${label} 2: the stage is on screen first`, s2a.stage, JSON.stringify(s2a));
    if (!(await seen(p, '[data-testid="drawer-history"]')) && await seen(p, '[data-testid="ns-drawer-toggle"]')) { await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 500); }
    await pickFromHistory(p, 'Funnel drop question');
    const s2 = await state(p);
    report[`${label}:2`] = s2;
    await shot(p, `${label}-2b-from-stage`);
    check(`${label} 2: the stage gives way to the chat`, !s2.stage, JSON.stringify(s2));
    check(`${label} 2: in its own new window`, s2.windows === s1.windows + 1, JSON.stringify(s2));
    check(`${label} 2: that window is shown, holding one chat`, s2.panes === 1 && s2.selected === s2.windows - 1, JSON.stringify(s2));

    // 3. Already open: its window comes forward, no second copy.
    await p.locator('[data-drawer-project="acme"] [data-testid="drawer-super-row"]').first().click();
    await wait(p, 1500);
    await pickFromHistory(p, 'My own chat question');
    const s3 = await state(p);
    report[`${label}:3`] = s3;
    await shot(p, `${label}-3-already-open`);
    check(`${label} 3: no new window`, s3.windows === s2.windows, JSON.stringify(s3));
    check(`${label} 3: its window (the first) is shown`, !s3.stage && s3.selected === 0, JSON.stringify(s3));
  } finally { await ctx.close(); }
}

const browser = await chromium.launch();
let srv;
try {
  seed();
  srv = await server(PORT);
  await run(browser, 1440, 900, 'desktop').catch((e) => { report.failures.push(`desktop threw: ${String(e).slice(0, 300)}`); });
  await run(browser, 390, 844, 'phone').catch((e) => { report.failures.push(`phone threw: ${String(e).slice(0, 300)}`); });
} finally { await browser.close(); srv?.kill(); rmSync(SCRATCH, { recursive: true, force: true }); }
console.log(JSON.stringify(report, null, 1));
process.exit(report.failures.length ? 1 : 0);
