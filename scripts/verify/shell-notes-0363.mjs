#!/usr/bin/env node
/**
 * /verify for the owner's notes on the 0.36.3 new shell. Real dashboard, scratch HOME, fictional
 * projects (acme, globex), a scripted `claude` stand-in (no tokens spent).
 *   node scripts/verify/shell-notes-0363.mjs --repo <checkout with dist> --out <dir> --tag before|after
 * Prints a JSON report; exit 1 on a failed check (after) or a console error.
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
const PORT = Number(arg('port', TAG === 'before' ? 45841 : 45842));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-notes-0363-${TAG}-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const ACME = join(SCRATCH, 'acme');
const GLOBEX = join(SCRATCH, 'globex');
const after = TAG === 'after';
const report = { tag: TAG, checks: {}, failures: [], console: [], pages: [] };
const check = (name, ok, detail) => { report.checks[name] = ok ? 'ok' : `FAIL ${detail ?? ''}`; if (!ok && after) report.failures.push(name); };
mkdirSync(OUT, { recursive: true });

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
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
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'v-' + process.pid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });
const id = () => randomUUID();

function recordFor(session, children, extra = {}) {
  return {
    v: 1, session, enabled: true, containers: Object.keys(children).filter((k) => children[k].endedAt === undefined).map((k, i) => ({ id: `c${i}`, kind: 'chat', ref: k, shape: 'portrait', place: 'float', by: 'super', title: children[k].brief })),
    groups: [], view: { mode: 'float' }, children, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [], ...extra,
  };
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const p of [ACME, GLOBEX]) { mkdirSync(join(p, '_dream_context', 'state'), { recursive: true }); spawnSync('git', ['-C', p, 'init', '-q']); }
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme', 'globex'], projectOrder: ['acme', 'globex'], lastVault: 'acme' }));
  for (const [n, p] of [['acme', ACME], ['globex', GLOBEX]]) dc(p, 'vaults', 'add', n, p);
  dc(ACME, 'agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'Reads the funnel.');
  writeFileSync(join(ACME, '_dream_context', 'agents', 'scout.md'), `${readFileSync(join(ACME, '_dream_context', 'agents', 'scout.md'), 'utf-8')}\nAlso checks pricing.\n`);
  dc(ACME, 'whiteboard', 'create', 'Launch plan');
  const kids = { [id()]: 'Fix the checkout', [id()]: 'Write the pricing page', [id()]: 'Review the release' };
  const endedId = id();
  const children = Object.fromEntries(Object.entries(kids).map(([k, brief], i) => [k, { sessionId: k, brief, adopted: i === 2, startedAt: Date.now() - 60000, row: 'working', rowAt: Date.now() }]));
  children[endedId] = { sessionId: endedId, brief: 'Old migration', adopted: false, startedAt: 1, endedAt: 2, row: 'done' };
  const sup = id();
  const owner1 = id(); const owner2 = id();
  const sessions = [
    ...Object.entries(kids).map(([k, title], i) => ({ title, kind: 'chat', sessionId: k, pane: i, active: true, window: 'main', size: 1 })),
    { title: 'Old migration', kind: 'chat', sessionId: endedId, pane: 3, active: true, window: 'main', size: 1 },
    { title: 'My own chat', kind: 'chat', sessionId: owner1, pane: 4, active: true, window: 'main', size: 1 },
    { title: 'Second chat', kind: 'chat', sessionId: owner2, pane: 5, active: true, window: 'main', size: 1 },
  ];
  writeFileSync(join(ACME, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 5, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 5 }], generation: 1 }));
  writeFileSync(join(ACME, '_dream_context', 'state', '.super-agent.json'), JSON.stringify(recordFor(sup, children, { pad: [{ id: 'p1', section: 'now', text: 'Ship the pricing page', at: 1 }] })));
  // Globex: its Super asks the owner, read by fan-out while this window holds only acme.
  const gsup = id();
  writeFileSync(join(GLOBEX, '_dream_context', 'state', '.super-agent.json'), JSON.stringify(recordFor(gsup, {}, { queue: [{ id: 'q1', sessionId: gsup, kind: 'ask', state: 'escalated', createdAt: Date.now(), text: 'Which plan?' }] })));
  // A transcript for History.
  const dir = join(HOME, '.claude', 'projects', ACME.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  for (const [sid, text] of [[endedId, 'Migrate the old table'], [owner1, 'Plan the launch']]) {
    writeFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: sid, cwd: ACME, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })}\n${JSON.stringify({ type: 'assistant', sessionId: sid, cwd: ACME, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })}\n`);
  }
  return { endedId, kids: Object.keys(kids), owner1 };
}

async function server() {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(PORT)], { cwd: ACME, env: { ...env(), PATH }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return srv; } catch { /* up soon */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not come up');
}

const wait = (p, ms = 800) => p.waitForTimeout(ms);
const seen = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);
async function shot(p, name) { await p.screenshot({ path: join(OUT, `${TAG}-${name}.png`) }); }
async function dismiss(p) { const g = p.getByRole('button', { name: 'Got it' }); if (await g.isVisible().catch(() => false)) { await g.click(); await wait(p, 300); } }

async function run(browser, { w, h, dark, full }, seeded) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript((d) => { try { localStorage.setItem('theme', d ? 'dark' : 'light'); localStorage.setItem('dreamcontext-theme', d ? 'dark' : 'light'); } catch { /* */ } }, dark);
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) report.console.push(`${w}: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => report.console.push(`${w}: ${String(e).slice(0, 200)}`));
  const tag = `${w}-${dark ? 'dark' : 'light'}`;
  // A Mac that is ready: this scratch HOME has no Claude sign-in.
  await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
  await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
  await wait(p, 2200);
  await dismiss(p);
  await p.keyboard.press('Escape');
  if (!(await seen(p, '[data-testid="chat-drawer"]')) && w > 900) { await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 500); }
  await wait(p, 300);
  await shot(p, `1-super-stage-${tag}`);
  if (full) {
    if (!dark) check('note9: 3 working children, ring shown', await seen(p, '[data-testid="super-working-ring"]'));
    check('note9: another project asks (red)', (await p.locator('[data-testid="drawer-super-row"][data-asking="true"]').count()) >= 1);
    await shot(p, `9-super-row-${tag}`);
  }
  if (full) {
    const head = await p.locator('.agent-overlay-head').first().isVisible().catch(() => false);
    check('note2: the stage has no bar', !head);
    check('note2: no Take back', !(await seen(p, '[data-testid="super-handover-btn"]')));
    const centre = await p.locator('.super-centre').first().boundingBox().catch(() => null);
    report.centreDrawerOpen = centre;
    const row = p.getByTestId('drawer-super-row').first();
    report.superRowText = await row.textContent().catch(() => null);
    await p.getByTestId('ns-drawer-toggle').click(); await wait(p);
    report.centreDrawerClosed = await p.locator('.super-centre').first().boundingBox().catch(() => null);
    await shot(p, `7-stage-drawer-closed-${tag}`);
    await p.getByTestId('ns-drawer-toggle').click(); await wait(p);
    // A chat window: the owner's two tabs only.
    await p.getByTestId('drawer-window-row').first().click(); await wait(p, 1200);
    await shot(p, `2-chat-window-${tag}`);
    const tabs = await p.locator('.agent-overlay-tabs [role="tab"], .agent-overlay-tabs .agent-tab').allTextContents().catch(() => []);
    report.chatTabs = tabs;
    check('note1: no Super tab in a chat window', !tabs.join(' ').match(/checkout|pricing|Review|migration/i), tabs.join('|'));
    check('note1: the owner\'s chats stay', tabs.join(' ').includes('My own chat'), tabs.join('|'));
    check('note6: no Super button in a chat window', !(await seen(p, '[data-testid="super-handover-btn"]')));
    report.windowRowText = await p.getByTestId('drawer-window-row').first().textContent().catch(() => null);
    // History: a Super child goes to the Super window.
    await p.getByTestId('drawer-history').click(); await wait(p, 1200);
    await shot(p, `6-history-${tag}`);
    // One Super Agent entry, then its sessions.
    const entry = p.getByTestId('chp-super-group').first();
    if (await entry.isVisible().catch(() => false)) {
      check('note11: one entry, with its count', (await p.getByTestId('chp-super-group').count()) >= 1 && (await p.getByTestId('chp-super-count').first().textContent())?.includes('1'));
      check('note11: the owner\'s chat is a row', (await p.locator('.chp-modal').getByText('Plan the launch').count()) >= 1);
      await shot(p, `11-history-entry-${tag}`);
      await p.locator('.chp-input').fill('Migrate'); await wait(p, 1200);
      await shot(p, `11-history-search-${tag}`);
      check('note11: a search finds the Super session, marked', await seen(p, '[data-testid="chp-super-tag"]'));
      await p.locator('.chp-input').fill(''); await wait(p, 900);
      await p.getByTestId('chp-super-group').first().click(); await wait(p, 900);
      await shot(p, `11-history-opened-${tag}`);
      check('note11: the entry lists its sessions', await seen(p, '[data-testid="chp-super-back"]'));
    } else if (after) check('note11: the entry is there', false);
    const hist = p.locator('.chp-modal').getByText('Migrate the old table').first();
    if (await hist.isVisible().catch(() => false)) {
      await hist.click(); await wait(p, 1500);
      await shot(p, `6-history-pick-super-child-${tag}`);
      check('note6: a Super pick opens its transcript in the Super window', await seen(p, '[data-testid="agent-peek"][data-kind="transcript"]'));
      check('note6: the Super stage is what stands behind it', await seen(p, '.super-centre'));
      if (after) await p.getByTestId('agent-peek-close').click().catch(() => {});
    } else check('note6: History lists the child', false, 'no row');
    // Pages: the drawer button.
    const pages = ['tasks', 'agents', 'lab', 'roadmap', 'hypotheses', 'whiteboards', 'knowledge', 'brain', 'settings'];
    for (const pg of pages) {
      const rail = p.locator(`[data-testid="ns-rail-${pg}"]`).first();
      if (!(await rail.isVisible().catch(() => false))) { report.pages.push({ page: pg, note: 'no rail item' }); continue; }
      await rail.click(); await wait(p, 900);
      await shot(p, `4-${pg}-before-toggle-${tag}`);
      const panelBefore = await seen(p, '.wbp-explorer, .board-explorer, .wbx, .brain-settings');
      await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 700);
      const onChat = await seen(p, '.project-instance:not([hidden]) .agent-surface.expanded');
      const panelAfter = await seen(p, '.wbp-explorer, .board-explorer, .wbx, .brain-settings');
      const drawer = await seen(p, '[data-testid="chat-drawer"]');
      report.pages.push({ page: pg, leftForChat: onChat, panelBefore, panelAfter, chatDrawer: drawer });
      await shot(p, `4-${pg}-after-toggle-${tag}`);
      check(`note4: ${pg} stays on the page`, !onChat);
      if (onChat) { await rail.click(); await wait(p, 500); }
      else await p.getByTestId('ns-drawer-toggle').click().then(() => wait(p, 400)).catch(() => {});
    }
    // The corner of a page.
    await p.locator('[data-testid="ns-rail-tasks"]').first().click(); await wait(p, 900);
    await shot(p, `5-page-corner-${tag}`);
    check('note5: no floating list', (await p.locator('.agent-dock:not(.agent-dock--floating)').count()) === 0 || !(await seen(p, '.agent-dock')));
    check('note5: the Super pill stays', await seen(p, '[data-testid="super-dock"], [data-testid="super-dock-pill"]'));
    const pill = p.locator('[data-testid="super-dock-pill"]').first();
    if (await pill.isVisible().catch(() => false)) { await pill.click(); await wait(p, 1200); await shot(p, `5-super-on-page-${tag}`); await p.keyboard.press('Escape'); await wait(p, 400); }
    // A team member, from the floating drawer over Tasks.
    await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 700);
    await shot(p, `4-tasks-floating-drawer-${tag}`);
    const m = p.getByTestId('drawer-member-row').first();
    if (await m.isVisible().catch(() => false)) {
      await m.click(); await wait(p, 1800);
      await shot(p, `3-member-in-chat-${tag}`);
      check('note3: the conversation opens in the chat area', await seen(p, '[data-testid="agent-peek"][data-kind="member"]'));
      check('note3: not the AI Team page', !(await seen(p, '.project-instance:not([hidden]) .aiteam-roster')));
      await p.getByTestId('agent-peek-close').click().catch(() => {});
    } else if (after) check('note3: a member row is listed', false);
    // New project.
    await p.locator('[data-testid="ns-rail-chat"]').first().click(); await wait(p, 900);
    const plus = p.getByTestId('drawer-new-project');
    if (await plus.isVisible().catch(() => false)) {
      await plus.click(); await wait(p, 1500);
      await shot(p, `8-new-project-${tag}`);
      check('note8: the flow opens', await seen(p, '.ob-shell, .onboarding, [class*="ob-"]'));
      await p.locator('.ob-skip').click(); await wait(p, 500);
      check('note8: leaving returns here', await seen(p, '[data-testid="chat-drawer"]'));
    }
    if (after) {
      await p.locator('[aria-expanded]', { hasText: 'acme' }).first().click(); await wait(p, 500);
      await shot(p, `8-picker-${tag}`);
      check('note8: the picker has New project', await seen(p, '[data-testid="ns-picker-new-project"]'));
      // The whole flow, on a Mac that is ready (this scratch HOME has no Claude sign-in).
      await p.getByTestId('ns-picker-new-project').click(); await wait(p, 1500);
      await shot(p, `8-project-step-${tag}`);
      const made = `delta-${dark ? 'd' : 'l'}`;
      await p.locator('.ob-choice').first().click(); await wait(p, 500);
      await p.locator('input.ob-input').first().fill(made);
      await p.locator('input.ob-input').nth(1).fill(SCRATCH);
      await shot(p, `8-project-name-${tag}`);
      await p.locator('.ob-btn--primary, .ob-btn:not(.ob-btn--secondary):not(.ob-btn--ghost)').last().click(); await wait(p, 3500);
      await shot(p, `8-project-made-${tag}`);
      const go = p.locator('.ob-handoff .ob-btn').last();
      if (await go.isVisible().catch(() => false)) { await go.click(); await wait(p, 2500); }
      await shot(p, `8-project-landed-${tag}`);
      check('note8: the new project is in the drawer, no reload', await seen(p, `[data-drawer-project="${made}"]`));
      report.pickerName = await p.locator('[aria-expanded]').first().textContent().catch(() => null);
      check('note8: it is the project on screen', report.pickerName?.includes(made), report.pickerName);
    }
  } else {
    await shot(p, `0-${tag}`);
  }
  await ctx.close();
}

let saved = '';
async function presentation(browser, w, h, layout, drawer, dark) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light' });
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  // The record on disk, read fresh: three jobs at work (one asking) and two pictures presented.
  const file = join(ACME, '_dream_context', 'state', '.super-agent.json');
  const rec = JSON.parse(saved);
  for (const [i, c] of Object.values(rec.children).filter((x) => x.endedAt === undefined).entries()) { c.row = i === 1 ? 'asking' : 'working'; c.rowAt = Date.now(); }
  rec.containers = [...rec.containers, ...['pa', 'pb'].map((k) => ({ id: k, kind: 'image', ref: `tmp/${k}.png`, shape: 'landscape', place: 'float', by: 'super', title: `Picture ${k}` }))];
  rec.view = { mode: 'present', cards: ['pa', 'pb'], layout, layoutBy: 'owner' };
  writeFileSync(file, JSON.stringify(rec));
  await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
  await wait(p, 1800);
  await dismiss(p);
  if (drawer !== await seen(p, '[data-testid="chat-drawer"]')) { await p.getByTestId('ns-drawer-toggle').click(); await wait(p, 900); }
  await wait(p, 300);
  const name = `10-present-${layout}-${w}-${drawer ? 'drawer' : 'nodrawer'}-${dark ? 'dark' : 'light'}`;
  await shot(p, name);
  report.present = report.present ?? {};
  report.present[name] = { chat: await p.locator('.super-centre').first().boundingBox().catch(() => null), mini: await p.locator('[data-mini="true"]').count(), tiles: await p.locator('[data-testid="super-container"][data-where="float"]').count() };
  await ctx.close();
}

const seeded = seed();
const srv = await server();
const browser = await chromium.launch();
try {
  if (!process.argv.includes('--present-only')) await run(browser, { w: 1440, h: 900, dark: false, full: true }, seeded);
  if (!process.argv.includes('--present-only')) await run(browser, { w: 1440, h: 900, dark: true, full: true }, seeded);
  if (!process.argv.includes('--present-only')) await run(browser, { w: 1024, h: 768, dark: false, full: false }, seeded);
  if (!process.argv.includes('--present-only')) await run(browser, { w: 390, h: 844, dark: false, full: false }, seeded);
  const recordFile = join(ACME, '_dream_context', 'state', '.super-agent.json');
  saved = readFileSync(recordFile, 'utf-8');
  mkdirSync(join(ACME, 'tmp'), { recursive: true });
  for (const k of ['pa', 'pb']) writeFileSync(join(ACME, 'tmp', `${k}.png`), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  for (const [w, h] of [[1440, 900], [1024, 768]]) for (const drawer of [true, false]) for (const l of ['filmstrip', 'grid', 'spotlight']) await presentation(browser, w, h, l, drawer, false);
  await presentation(browser, 1440, 900, 'filmstrip', true, true);
  writeFileSync(recordFile, saved);
  if (process.argv.includes('--present-only')) { await browser.close(); srv.kill(); console.log(JSON.stringify(report.present, null, 0)); process.exit(0); }
} finally {
  await browser.close();
  srv.kill();
}
writeFileSync(join(OUT, `${TAG}-report.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
process.exit(report.failures.length || (after && report.console.length) ? 1 : 0);
