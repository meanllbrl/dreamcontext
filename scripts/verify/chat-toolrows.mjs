#!/usr/bin/env node
/**
 * Chat tool-row identity, density and run-grouping end-to-end verification.
 *
 *   npm run build && npm run verify:chat-toolrows
 *
 * Proves the four things the 08-01 owner report asked for, in the real app:
 *
 *   1. a file row names its FILE (basename + one parent), never a right-truncated abs path
 *   2. every row names its OBJECT, not its type — Skill says which skill, and one of OUR
 *      skills wears the dreamcontext mark
 *   3. a collapsed row is 32px and adjacent rows sit 8px apart (58px → 40px per call)
 *   4. a contiguous run of ≥3 calls is ONE card: open while live, collapsed once the agent
 *      speaks again, re-openable and then sticky
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/ws/agent-chat` route, and the real
 * React surface in Chromium. Nothing is imported and called directly; every number below is
 * measured off `getBoundingClientRect` in the browser, not computed from the CSS by hand.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is replaced, for this run only, by a scripted
 * stand-in in an isolated fake HOME (see scripts/verify/chat-steer.mjs for why the fake HOME
 * makes the substitution airtight). It emits a realistic tool run and then talks — which is
 * exactly the transition the group card exists to survive.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST: every check prints ✓/✗ with evidence and the run
 * continues, so one invocation reports everything that is broken. Exit 0 iff all checks pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-toolrows');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// One turn shaped like a real one: a RUN of six tool calls, an answer, a SHORT stretch of two
// calls, another answer. The short stretch is the control — it must stay two plain cards,
// because a disclosure over two rows saves nothing and costs a click (MIN_TOOL_RUN).
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-toolrows.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let seq = 0, busy = false;

const ROOT = '/Users/verify/projects/dc/dashboard/src/components/sleepy';
const RUN = [
  { name: 'Read',  input: { file_path: ROOT + '/chat/chatEntities.ts' }, result: 'x\\ny\\nz' },
  { name: 'Read',  input: { file_path: ROOT + '/chat/ToolCard.tsx' },    result: 'a\\nb' },
  { name: 'Read',  input: { file_path: ROOT + '/ChatPane.tsx' },         result: 'q' },
  { name: 'Bash',  input: { command: 'echo hello', description: 'Say hello' }, result: 'hello' },
  // No \`description\` — the CLI does not always send one, and this row used to render as
  // the bare word "Bash" with nothing beside it (owner report 08-01, second pass).
  { name: 'Bash',  input: { command: 'git rev-parse HEAD && git status --porcelain' }, result: 'abc123' },
  { name: 'Skill', input: { skill: 'dreamcontext', args: 'snapshot' },   result: 'ok' },
  { name: 'Skill', input: { skill: 'brand-voice', args: '' },            result: 'ok' },
];
const SHORT = [
  { name: 'Grep',  input: { pattern: 'useGroupCollapse', path: ROOT },   result: 'hit' },
  { name: 'WebFetch', input: { url: 'https://docs.anthropic.com/en/api/x' }, result: 'fetched' },
];

async function call(step, pauseMs) {
  const id = 'toolu_' + (++seq);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: step.name, input: step.input }] } });
  await sleep(pauseMs);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: step.result }] }] } });
  await sleep(120);
}

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: ['compact'] });
  // Slow on purpose: the run has to stay live long enough to be OBSERVED live.
  for (const step of RUN) await call(step, 600);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ANSWER-ONE' }] } });
  await sleep(400);
  for (const step of SHORT) await call(step, 300);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ANSWER-TWO ' + prompt }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
  busy = false;
  pump();
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request' && o.request && o.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) { inbox.push(text); pump(); }
  }
});

let pumping = false;
async function pump() {
  if (pumping || busy) return;
  const next = inbox.shift();
  if (next === undefined) return;
  pumping = true;
  try { await runTurn(next); } finally { pumping = false; }
}
process.stdin.on('end', () => process.exit(0));
`;

// ─── setup (mirrors scripts/verify/chat-steer.mjs) ────────────────────────────────────

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
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
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
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function runTheme(chromium, base, theme, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  const vis = (sel) => page.locator(`${sel}:visible`);
  const pane = () => vis('.chat-pane').first();
  const paneText = async () => (await pane().innerText()).replace(/\s+/g, ' ');
  const busy = async () => (await vis('.chat-cmp-stop').count()) > 0;
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };
  const waitIdle = () => until(async () => !(await busy()), 40000);
  const waitText = (s, ms = 40000) => until(async () => (await paneText()).includes(s), ms);
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);

  console.log(`\n═══ ${theme} ═══`);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  ok('a chat session opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  await page.waitForTimeout(800);

  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('GO');
  await page.keyboard.press('Enter');

  // ── 4a — the run groups, and is OPEN while it is live ─────────────────────────────
  console.log('── group: open while live');
  ok('a run of ≥3 adjacent tool calls became ONE group card',
    await until(async () => (await vis('.chat-toolrun').count()) === 1, 20000));
  ok('while it is live the group is OPEN — the reader can watch it work',
    await until(async () => (await vis('.chat-toolrun[data-open]').count()) === 1, 10000));
  ok('the live header reads "Working", not a summary that rewrites itself every second',
    await until(async () => (await vis('.chat-toolrun').innerText()).includes('Working'), 10000));

  // ── 1 + 2 — identity, measured while the rows are on screen ───────────────────────
  console.log('── identity: every row names its object');
  // Wait for the WHOLE run to be on screen — three path chips only means the three Reads have
  // landed, and asserting there measured a run that had not reached its Skill calls yet.
  ok('all six calls of the run are on screen',
    await until(async () => (await vis('.chat-toolrun .chat-toolcard').count()) === 7, 25000),
    `saw ${await vis('.chat-toolrun .chat-toolcard').count()} rows`);
  const chipNames = await vis('.chat-toolrun .chat-a-pathchip-name').allInnerTexts();
  ok('a file row names its FILE — the basename is its own element, so it cannot be truncated away',
    chipNames.includes('chatEntities.ts') && chipNames.includes('ToolCard.tsx') && chipNames.includes('ChatPane.tsx'),
    JSON.stringify(chipNames));
  const chipDirs = await vis('.chat-toolrun .chat-a-pathchip-dir').allInnerTexts();
  ok('exactly ONE parent folder rides along for context', chipDirs.includes('chat/') && chipDirs.includes('sleepy/'),
    JSON.stringify(chipDirs));
  const chipText = (await vis('.chat-toolrun .chat-a-pathchip').first().innerText()).replace(/\s+/g, '');
  ok('the shared /Users/… prefix is GONE from what you read', !chipText.includes('/Users/'), chipText);
  const chipTitle = await vis('.chat-toolrun .chat-a-pathchip').first().getAttribute('title');
  ok('…but the exact absolute path is still there, in the title', (chipTitle ?? '').startsWith('/Users/verify/'), chipTitle);

  // A clean assertion set is necessary, not sufficient — these are for LOOKING at.
  const shot = process.env.VERIFY_SHOTS;
  if (shot) await vis('.chat-toolrun').first().screenshot({ path: `${shot}/run-open-${theme}.png` });
  const runText = (await vis('.chat-toolrun').innerText()).replace(/\s+/g, ' ');
  ok('a Skill row says WHICH skill', runText.includes('dreamcontext') && runText.includes('brand-voice'), runText.slice(0, 200));
  ok('and never falls back to "· 1 lines" — a skill result\'s line count means nothing',
    !/Skill\s*·\s*\d+ lines/.test(runText), runText.slice(0, 200));
  ok('a file row also says HOW MUCH it read — a tool_result arrives as text blocks, not only a string',
    /3 lines/.test(runText), runText.slice(0, 300));
  ok('a Bash row WITH a description still shows it', runText.includes('Say hello'), runText.slice(0, 300));
  ok('a Bash row with NO description falls back to its command — never the bare word "Bash"',
    runText.includes('git rev-parse HEAD'), runText.slice(0, 300));
  const bashRows = await vis('.chat-toolrun .chat-toolcard').evaluateAll((els) => els
    .filter((e) => /(^|\s)Bash(\s|$)/.test(e.querySelector('.chat-a-toolname')?.textContent ?? ''))
    .map((e) => ({
      sub: (e.querySelector('.chat-m-toolhead-sub')?.textContent ?? '').trim(),
      // On failure the HEAD is the evidence: it says whether the subtitle span is absent
      // (the data never reached the card) or merely empty (it reached it and rendered blank).
      head: (e.querySelector('.chat-m-toolhead')?.outerHTML ?? '').slice(0, 400),
    })));
  ok('NO Bash row is left nameless',
    bashRows.length === 2 && bashRows.every((r) => r.sub.length > 0),
    JSON.stringify(bashRows, null, 2));
  const cmdTitle = await vis('.chat-toolrun .chat-m-toolhead-sub').filter({ hasText: 'git rev-parse' }).first().getAttribute('title');
  ok('…and the full, uncondensed command is in its title', (cmdTitle ?? '').includes('git status --porcelain'), cmdTitle);

  ok('one of OUR skills wears the dreamcontext mark',
    (await vis('.chat-toolrun .chat-a-glyph-brand').count()) === 1);
  ok('…and it is the dreamcontext one, not the third-party skill',
    runText.includes('dreamcontext skill'), runText.slice(0, 200));

  // ── 3 — density, measured off the real boxes ──────────────────────────────────────
  console.log('── density: 58px → 40px per call');
  const heads = await vis('.chat-toolrun .chat-m-toolhead').evaluateAll(
    (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)),
  );
  ok('a collapsed row is 32px tall, not 40', heads.length >= 3 && heads.every((h) => h === 32), JSON.stringify(heads));

  // ── 4b — it collapses when the agent speaks again ─────────────────────────────────
  console.log('── group: collapses when the agent speaks again');
  ok('the agent answers', await waitText('ANSWER-ONE'));
  ok('the run stops being the tail and COLLAPSES to its header',
    await until(async () => (await vis('.chat-toolrun[data-open]').count()) === 0, 20000));
  const collapsed = (await vis('.chat-toolrun').innerText()).replace(/\s+/g, ' ');
  ok('the collapsed header still reports the whole outcome',
    /7 steps · 3 files read · 2 commands/.test(collapsed), collapsed);
  ok('its rows are really gone from the DOM, not just hidden',
    (await page.locator('.chat-toolrun .chat-toolcard').count()) === 0);

  // ── control — a stretch of two must NOT be grouped ────────────────────────────────
  console.log('── control: two calls stay two cards');
  ok('the turn finishes', await waitText('ANSWER-TWO'));
  await waitIdle();
  ok('still exactly ONE group card — the 2-call stretch did not earn one',
    (await vis('.chat-toolrun').count()) === 1);
  const loose = await vis('.chat-scroll-inner > .chat-toolcard').count();
  ok('the 2-call stretch rendered as two plain top-level cards', loose === 2, `found ${loose}`);
  if (shot) await vis('.chat-scroll-inner').first().screenshot({ path: `${shot}/transcript-${theme}.png` });
  const looseText = (await vis('.chat-scroll-inner > .chat-toolcard').first().innerText()).replace(/\s+/g, ' ');
  ok('and those rows name their objects too — Grep says its pattern',
    looseText.includes('useGroupCollapse'), looseText);
  const fetchText = (await vis('.chat-scroll-inner > .chat-toolcard').last().innerText()).replace(/\s+/g, ' ');
  ok('WebFetch says its host, not the whole url', fetchText.includes('docs.anthropic.com') && !fetchText.includes('/en/api'), fetchText);

  // adjacent-card spacing: the second card sits 8px below the first, not 16
  const gap = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.chat-scroll-inner > .chat-toolcard')]
      .filter((e) => e.getBoundingClientRect().height > 0);
    if (cards.length < 2) return null;
    const a = cards[cards.length - 2].getBoundingClientRect();
    const b = cards[cards.length - 1].getBoundingClientRect();
    return Math.round(b.top - a.bottom);
  });
  ok('two ADJACENT tool cards sit 8px apart, not the transcript\'s 16', gap === 8, `gap=${gap}`);

  // ── 4c — a click re-opens it, and it STAYS open ───────────────────────────────────
  console.log('── group: the user outranks the automatic state');
  await vis('.chat-toolrun .chat-m-cardhead-hit').first().click();
  await page.waitForTimeout(400);
  ok('clicking the collapsed header brings the rows back',
    (await vis('.chat-toolrun[data-open]').count()) === 1
    && (await vis('.chat-toolrun .chat-toolcard').count()) === 7);
  await page.waitForTimeout(1500);
  ok('…and it stays open — the auto-collapse does not fire a second time',
    (await vis('.chat-toolrun[data-open]').count()) === 1);

  // ── rows keep everything a tool card could do ─────────────────────────────────────
  console.log('── rows are still real tool cards');
  const bashRow = vis('.chat-toolrun .chat-toolcard').filter({ hasText: 'Say hello' }).first();
  ok('the Bash row shows its description, as it always did', (await bashRow.count()) === 1);
  await bashRow.locator('.chat-m-toolhead-hit').click();
  await page.waitForTimeout(400);
  ok('a row inside the group still expands to its terminal output',
    (await bashRow.locator('.chat-m-terminal').count()) === 1);

  await browser.close();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0,
  fails: [],
  notes: [],
  check(theme, label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(`[${theme}] ${label}`); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

let server = null;
try {
  const { chromium } = await import('@playwright/test');
  console.log('· setting up scratch vault + scripted claude…');
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of (process.env.VERIFY_THEMES || 'light,dark').split(',')) {
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    await runTheme(chromium, `http://127.0.0.1:${port}`, theme, report);
  }
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
