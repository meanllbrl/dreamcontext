#!/usr/bin/env node
/**
 * Past-chats PICKER — browser-level verification of the surface.
 *
 *   npm run build && npm run verify:past-chats-ui
 *
 * `verify:past-chats` proves the INDEX over HTTP. This proves what a person actually touches:
 * the entry point lives in the ＋New menu (not a header button of its own), the popup lists,
 * groups and searches, agent runs are held back with one click to see them, Esc belongs to
 * the picker rather than the overlay under it, and picking a row reopens that conversation as
 * a titled tab with its own transcript replayed.
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/api/agent/chat-sessions` and
 * `/api/agent/chat-history` routes, the real chat WS bridge, and the real React surface in
 * Chromium, in BOTH themes.
 *
 * WHAT IT DOES NOT TOUCH — your machine. Isolated fake HOME with synthesized transcripts, so
 * it can neither read your real conversations nor fight your running app over its session
 * roster, and `claude` is replaced by a stand-in on that HOME's PATH: a resume spawns a
 * process, sends nothing, and spends no tokens.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST (matching verify/chat-steer.mjs). Exit 0 iff
 * every check in every theme passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dc-ui-past-chats');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-past-chats-ui');
const DIR = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'standin', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'STANDIN ACK' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ACK', num_turns: 1, total_cost_usd: 0, usage: {}, session_id: 'standin' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const SLEEP_BRIEF = 'Think hard. Run a full dreamcontext memory consolidation ("sleep") for THIS project now, fully autonomously.';
const IDS = {
  quiz: '11111111-1111-4111-8111-111111111111',
  sidebar: '22222222-2222-4222-8222-222222222222',
  webhook: '33333333-3333-4333-8333-333333333333',
  sleepRun: '44444444-4444-4444-8444-444444444444',
};

const jsonl = (e) => e.map((x) => JSON.stringify(x)).join('\n') + '\n';

function transcript(id, prompts, branch) {
  const entries = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-01T11:41:29.085Z' },
    { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: `preload ${'x'.repeat(20000)}` } },
  ];
  prompts.forEach((text, i) => {
    entries.push({
      type: 'user', isSidechain: false, uuid: `${id}-u${i}`, timestamp: `2026-08-01T12:0${i}:00.000Z`,
      cwd: PROJ, sessionId: id, gitBranch: branch, version: '2.1.220',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    entries.push({
      type: 'assistant', isSidechain: false, uuid: `${id}-a${i}`,
      message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
    });
  });
  return jsonl(entries);
}

function write(id, raw, ageMs) {
  const path = join(DIR, `${id}.jsonl`);
  writeFileSync(path, raw);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(DIR, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  write(IDS.quiz, transcript(IDS.quiz, ['Quiz funnelin son adımını yeniden yazalım', 'devam et'], 'feat/quiz-funnel'), 5 * 60_000);
  write(IDS.sidebar, transcript(IDS.sidebar, [`${PROJ}/tmp/shot.png Sidebar ikonları hizasız duruyor`], 'main'), 90 * 60_000);
  write(IDS.webhook, transcript(IDS.webhook, [
    'Ödeme webhookları neden iki kez düşüyor',
    'the idempotency key is derived per attempt, not per event',
  ], 'fix/webhook-retry'), 3 * 24 * 3600_000);
  // Newest of all — without the filter it would sit on top of the list.
  write(IDS.sleepRun, transcript(IDS.sleepRun, [SLEEP_BRIEF], 'main'), 60_000);

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

const report = { pass: 0, fail: 0 };
const check = (label, ok, ev = '') => {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
};

async function runTheme(base, theme) {
  console.log(`\n═══ ${theme} ═══`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => check(`no page error (${String(e).slice(0, 80)})`, false));

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const rows = () => page.locator('.chp-row:visible');
  const titles = () => page.locator('.chp-row-title:visible').allInnerTexts();
  const modal = page.locator('.cmd-modal.chp-modal');
  const tabText = async () => (await page.locator('.agent-tab:visible').allInnerTexts()).join(' | ');

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }

  // Open the surface (scratch vault → no roster → the lone FAB).
  const fab = page.locator('.agent-fab').first();
  if (await fab.count()) { await fab.click(); await page.waitForTimeout(1200); }
  check('the agent surface opens', (await page.locator('.agent-surface.expanded').count()) === 1);

  // ENTRY POINT — no standalone header button; the way in is the ＋New dropdown.
  check('the header has no separate History button', (await page.locator('.agent-history-btn').count()) === 0);
  const emptyEntry = page.getByRole('button', { name: /Past chats/i });
  check('the empty state offers "Past chats" (there is no ＋New menu with zero tabs)',
    (await emptyEntry.count()) > 0);
  await emptyEntry.first().click();
  check('the picker opens', await until(async () => (await modal.count()) > 0, 20000));
  check('conversations are listed', await until(async () => (await rows().count()) > 0, 20000));

  const listed = await titles();
  check('agent runs are not in the list', listed.length === 3, `${listed.length}: ${JSON.stringify(listed)}`);
  check('newest real conversation is on top', /Quiz funnel/.test(listed[0] ?? ''), JSON.stringify(listed[0]));
  check('a dropped file\'s path is stripped from the title',
    listed.includes('Sidebar ikonları hizasız duruyor'), JSON.stringify(listed));
  check('the newest prompt rides along as the second line',
    (await page.locator('.chp-row-preview:visible').allInnerTexts()).includes('devam et'));
  // `innerText` is the RENDERED text, and the headers are CSS-uppercased.
  const groups = (await page.locator('.chp-group-label:visible').allInnerTexts()).map((t) => t.toLowerCase());
  check('rows are grouped by day',
    groups.includes('today') && groups.includes('previous 7 days'), JSON.stringify(groups));
  await page.screenshot({ path: join(SHOTS, `list-${theme}.png`) });

  // WITHHELD AGENT RUNS — stated, and one click away.
  const toggle = page.locator('.chp-foot-toggle');
  check('the footer says what is being held back',
    /1 agent run hidden/.test(await toggle.innerText().catch(() => '')), await toggle.innerText().catch(() => '(none)'));
  await toggle.click();
  check('showing them adds the run, newest first',
    await until(async () => (await rows().count()) === 4, 8000), `${await rows().count()} rows`);
  check('…and it really is the sleep run on top',
    /memory consolidation/.test((await titles())[0] ?? ''), JSON.stringify((await titles())[0]));
  await page.screenshot({ path: join(SHOTS, `agent-runs-${theme}.png`) });
  await toggle.click();
  check('hiding them again restores the clean list', await until(async () => (await rows().count()) === 3, 8000));

  // SEARCH reaches the middle of a conversation.
  await page.locator('.chp-input').fill('idempotency');
  check('a mid-conversation word finds its session',
    await until(async () => (await rows().count()) === 1, 8000), JSON.stringify(await titles()));
  check('…and it is the right one', /Ödeme webhookları/.test((await titles())[0] ?? ''));
  await page.screenshot({ path: join(SHOTS, `search-${theme}.png`) });

  await page.locator('.chp-input').fill('idempotency quiz');
  check('a second token narrows rather than widens', await until(async () => (await rows().count()) === 0, 8000));
  check('a no-match query is explained',
    /No past chat matches/i.test(await page.locator('.chp-empty').innerText().catch(() => '')));

  // PICK — keyboard only.
  await page.locator('.chp-input').fill('webhook');
  await until(async () => (await rows().count()) === 1, 8000);
  const picked = (await titles())[0];
  await page.locator('.chp-input').press('Enter');
  check('picking closes the picker', await until(async () => (await modal.count()) === 0, 8000));
  check('the conversation opens as a tab', await until(async () => (await page.locator('.agent-tab:visible').count()) === 1, 15000));
  check('the tab is titled from the conversation, not "Chat 1"',
    (await tabText()).includes(picked.slice(0, 14)), JSON.stringify(await tabText()));

  const paneText = async () => (await page.locator('.chat-pane:visible').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('the resumed conversation replays its own transcript',
    await until(async () => (await paneText()).includes('Ödeme webhookları neden iki kez düşüyor'), 25000),
    (await paneText()).slice(0, 140));
  check('…including turns after the first',
    (await paneText()).includes('idempotency key is derived per attempt'));
  await page.screenshot({ path: join(SHOTS, `resumed-${theme}.png`) });

  // ENTRY POINT, part two — with a tab open, the way in is the ＋New caret menu.
  await page.locator('.agent-add-caret').click();
  await page.waitForTimeout(400);
  const menuItem = page.locator('.agent-new-menu-item', { hasText: 'Past chats' });
  check('＋New ▾ carries a "Past chats" item', (await menuItem.count()) === 1,
    await page.locator('.agent-new-menu').innerText().catch(() => '(no menu)'));
  await page.screenshot({ path: join(SHOTS, `new-menu-${theme}.png`) });
  await menuItem.click();
  check('the menu item opens the picker', await until(async () => (await rows().count()) > 0, 20000));
  check('the already-open conversation is marked "open"',
    await until(async () => (await page.locator('.chp-row--open:visible').count()) === 1, 5000));
  await page.screenshot({ path: join(SHOTS, `open-marked-${theme}.png`) });

  // ESC belongs to the picker, not to the overlay underneath it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  check('Esc closes the picker', (await modal.count()) === 0);
  check('…and does NOT also collapse the agent overlay',
    (await page.locator('.agent-surface.expanded').count()) === 1);

  // Picking an already-open conversation focuses it instead of resuming a second CLI.
  await page.locator('.agent-add-caret').click();
  await page.waitForTimeout(300);
  await page.locator('.agent-new-menu-item', { hasText: 'Past chats' }).click();
  await until(async () => (await rows().count()) > 0, 20000);
  await page.locator('.chp-row--open:visible').first().click();
  await page.waitForTimeout(2500);
  check('picking an open conversation does not open a duplicate tab',
    (await page.locator('.agent-tab:visible').count()) === 1, await tabText());

  await browser.close();
}

let server = null;
try {
  console.log('· fixture (isolated HOME, synthesized transcripts, stand-in claude)…');
  setup();
  const port = await freePort();
  console.log(`· real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of ['dark', 'light']) {
    // The surface mirrors its tab roster to `state/.agent-sessions.json`, so the tab the dark
    // run resumed would restore as a dormant tab in the light one — and the zero-session
    // entry point being tested only exists with no tabs at all.
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    await runTheme(`http://127.0.0.1:${port}`, theme);
  }
} catch (err) {
  report.fail++;
  console.log(`\n  ✗ RUN FAILED: ${err && err.stack ? err.stack : err}`);
} finally {
  if (server) server.kill();
}
console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
console.log(`Screenshots: ${SHOTS}`);
process.exit(report.fail ? 1 : 0);
