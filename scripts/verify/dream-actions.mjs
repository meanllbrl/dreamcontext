#!/usr/bin/env node
/**
 * dreamcontext-CLI rows in the chat transcript — end-to-end verification.
 *
 *   npm run build && npm run verify:dream-actions
 *
 * Proves, in the real app, what the 08-01 owner report asked for:
 *
 *   1. a `dreamcontext …` shell call is rendered as the ACTION it performed — the entity, the
 *      verb, and the object — instead of the agent's hand-written Bash description
 *   2. it wears the dreamcontext mark and a tinted surface, so it is unmistakable in a column
 *      of ordinary tool rows
 *   3. it BREAKS the run grouping: ordinary calls still collapse into one card, our calls each
 *      keep their own row
 *   4. a read is toned differently from a write, and a delete differently again
 *   5. a `✗` the CLI printed makes the row an error row even though the process exited 0
 *   6. a command that chained several actions says so, and lists them when opened
 *   7. none of it costs the density the transcript was tuned to (a collapsed row is 32px)
 *
 * Same harness contract as scripts/verify/chat-toolrows.mjs: the real server, the real
 * `/ws/agent-chat`, a real browser, a scripted stand-in for `claude` in an isolated fake HOME
 * so no tokens are spent, and COLLECT-DON'T-FAIL-FAST reporting.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-dream-actions');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// One turn shaped like the screenshot that started this: a stretch of ordinary calls that
// SHOULD group, then the dreamcontext work — a create, a lookup, a status change, a chain of
// inserts, and a delete that fails without the process failing.
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/dream-actions.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let seq = 0, busy = false;

const ROOT = '/Users/verify/projects/dc';
const ORDINARY = [
  { name: 'Read', input: { file_path: ROOT + '/src/cli/program.ts' }, result: 'a\\nb\\nc' },
  { name: 'Read', input: { file_path: ROOT + '/src/lib/cli-manifest.ts' }, result: 'a\\nb' },
  { name: 'Grep', input: { pattern: 'registerTasksCommand', path: ROOT }, result: 'hit' },
];
const DREAM = [
  // The agent's own description says "Create the task" — the row must say WHICH task instead.
  { name: 'Bash',
    input: { command: 'dreamcontext tasks create "Chat rows name their object" -p high --why "rows were nameless"',
             description: 'Create the task' },
    result: '✓ Task created: chat-rows-name-their-object.md' },
  { name: 'Bash',
    input: { command: 'dreamcontext memory recall "context root resolution" --types task', description: 'Check for an existing task' },
    result: 'hit one\\nhit two\\nhit three' },
  { name: 'Bash',
    input: { command: 'dreamcontext tasks status chat-rows-name-their-object in_progress', description: 'Start it' },
    result: '✓ chat-rows-name-their-object → status: in_progress' },
  { name: 'Bash',
    // No leading dash on the content: commander itself rejects a positional that starts with
    // one ("error: unknown option"), so a fixture using it would be testing a call the CLI
    // never accepts — and the parser deliberately reads the command line the way the CLI does.
    input: { command: 'dreamcontext tasks insert chat-rows-name-their-object "Acceptance Criteria" "rows name their object" && dreamcontext tasks insert chat-rows-name-their-object "Acceptance Criteria" "the mark is visible" && dreamcontext tasks insert chat-rows-name-their-object "Acceptance Criteria" "grouping is broken"',
             description: 'Insert remaining acceptance criteria' },
    result: '✓ Inserted into Acceptance Criteria in chat-rows-name-their-object.md' },
  // Exits 0, prints ✗. The row has to believe the output, not the exit code.
  { name: 'Bash',
    input: { command: 'dreamcontext tasks delete stale-task', description: 'Clean up' },
    result: '✗ Task not found: stale-task' },
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
  for (const step of ORDINARY) await call(step, 400);
  for (const step of DREAM) await call(step, 400);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ANSWER-ONE ' + prompt }] } });
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

// ─── setup (mirrors scripts/verify/chat-toolrows.mjs) ────────────────────────────────

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
  const rowText = async (i) => (await vis('.chat-dreamcard').nth(i).innerText()).replace(/\s+/g, ' ');

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

  ok('the turn finishes', await waitText('ANSWER-ONE'));
  await waitIdle();
  await page.waitForTimeout(600);

  // ── 1 — the row is the action, not the description ────────────────────────────────
  console.log('── identity: the row names the action and its object');
  ok('every dreamcontext call got its own branded row',
    (await vis('.chat-dreamcard').count()) === 5, `found ${await vis('.chat-dreamcard').count()}`);
  const first = await rowText(0);
  ok('a create says "Task created", not the agent\'s "Create the task"',
    first.includes('Task created') && !first.includes('Create the task'), first);
  ok('…and names the task the agent actually typed',
    first.includes('Chat rows name their object'), first);
  ok('a status change reads as the change it made',
    (await rowText(2)).includes('Task status') && (await rowText(2)).includes('in_progress'), await rowText(2));
  const recall = await rowText(1);
  ok('a recall says the QUERY, not the flags', recall.includes('Memory recall') && recall.includes('context root resolution'), recall);
  ok('…and how much came back', /3 lines/.test(recall), recall);

  // The chip reads as the task the agent named and opens the slug the CLI reported — the two
  // are different strings, and only the second one locates a file.
  const createChip = vis('.chat-dreamcard').nth(0).locator('.chat-a-pathchip:not([data-static])');
  ok('the created task is openable, at the path the CLI itself printed',
    (await createChip.getAttribute('title')) === '_dream_context/state/chat-rows-name-their-object.md',
    await createChip.getAttribute('title'));
  ok('…while a recall\'s query chip stays inert — there is nothing behind it to open',
    (await vis('.chat-dreamcard').nth(1).locator('.chat-a-pathchip[data-static]').count()) === 1);

  // ── 2 — the mark ──────────────────────────────────────────────────────────────────
  console.log('── the mark: this is us, working');
  ok('every dreamcontext row wears the dreamcontext mark',
    (await vis('.chat-dreamcard .chat-a-glyph-brand').count()) === 5);
  const tinted = await page.evaluate(() => {
    const el = document.querySelector('.chat-dreamcard');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const edge = getComputedStyle(el, '::before');
    return { bg: cs.backgroundColor, edge: edge.backgroundColor, w: edge.width };
  });
  ok('it sits on a tinted surface with an accent edge — not a filled swatch',
    !!tinted && tinted.w === '3px' && tinted.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(tinted));

  // ── 3 — grouping ──────────────────────────────────────────────────────────────────
  console.log('── grouping: ours break out, the rest still collapse');
  ok('the three ordinary calls still collapsed into ONE run card',
    (await vis('.chat-toolrun').count()) === 1, `found ${await vis('.chat-toolrun').count()}`);
  ok('no dreamcontext row was swallowed into it',
    (await page.locator('.chat-toolrun .chat-dreamcard').count()) === 0);
  ok('every one of them is a top-level row in the transcript',
    (await vis('.chat-scroll-inner > .chat-dreamcard').count()) === 5);

  // ── 4 — tone ──────────────────────────────────────────────────────────────────────
  console.log('── tone: did it change the brain, or only look at it?');
  const tones = await vis('.chat-dreamcard').evaluateAll((els) => els.map((e) => e.getAttribute('data-tone')));
  ok('a create is a write, a recall is a read, a delete is destructive',
    tones[0] === 'write' && tones[1] === 'read' && tones[2] === 'write' && tones[4] === 'destructive',
    JSON.stringify(tones));

  // ── 5 — a printed failure is a failure ────────────────────────────────────────────
  console.log('── honesty: the CLI said ✗');
  const del = await rowText(4);
  ok('the failed delete reports the CLI\'s own error line', del.includes('Task not found: stale-task'), del);
  ok('…and the row is an error row, though the process exited 0',
    (await vis('.chat-dreamcard[data-status="error"]').count()) === 1);

  // ── 6 — a chain says how many, and lists them ─────────────────────────────────────
  console.log('── chains: one Bash call, three actions');
  const chain = await rowText(3);
  ok('the row admits it ran the action three times', /×3/.test(chain), chain);
  await vis('.chat-dreamcard').nth(3).locator('.chat-m-toolhead-hit').click();
  await page.waitForTimeout(400);
  const rows = await vis('.chat-dreamcard .chat-dreamcard-listrow').allInnerTexts();
  ok('opened, it lists every action in order', rows.length === 3 && rows.join(' ').includes('the mark is visible'),
    JSON.stringify(rows));
  ok('…and still shows the real command underneath',
    (await vis('.chat-dreamcard .chat-m-terminal').count()) === 1);
  await vis('.chat-dreamcard').nth(3).locator('.chat-m-toolhead-hit').click();
  await page.waitForTimeout(300);

  // ── 7 — density is untouched ──────────────────────────────────────────────────────
  console.log('── density: the row costs no more than any other');
  const heads = await vis('.chat-dreamcard .chat-m-toolhead').evaluateAll(
    (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)),
  );
  ok('a collapsed dreamcontext row is 32px, exactly like every other tool row',
    heads.length === 5 && heads.every((h) => h === 32), JSON.stringify(heads));

  const shot = process.env.VERIFY_SHOTS;
  if (shot) await vis('.chat-scroll-inner').first().screenshot({ path: `${shot}/dream-actions-${theme}.png` });

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
