#!/usr/bin/env node
/**
 * A landed sub-agent's REPORT, end-to-end in the real app.
 *
 *   npm run build && npm run verify:chat-subagent-report
 *
 * Proves what the 09-02 owner report asked for — "sub agent ismi ve başlığı ile bu çıktı
 * basılsın ama biz sadece özetini görelim, çok hepsini okumak istiyorsak tıklayıp tümünü
 * okuyalım":
 *
 *   1. a finished dispatch gets its OWN card, named (agent + subagent type) and headed by the
 *      run's own one-line summary — while the group's rows stay collapsed
 *   2. collapsed, the report BODY is not in the DOM at all: three lines of transcript, not a wall
 *   3. one click renders it in place as MARKDOWN — headings, lists and code, as the agent wrote it
 *   4. both carriers work: a SYNCHRONOUS dispatch reports off its own tool_result, and a
 *      BACKGROUNDED one (whose tool_result is only "started in the background") off its
 *      sidechain transcript, fetched lazily on the first open
 *   5. a background SHELL gets no report card — `npm test` is not an agent with something to say
 *   6. the card's own "Open the whole run" still reaches the full drill-in
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/ws/agent-chat` route, the real
 * `/api/agent/chat-history?subagent=` sidechain route, and the real React surface in Chromium.
 * Every assertion is measured off the live DOM, never computed from the source by hand.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is replaced, for this run only, by a scripted
 * stand-in in an isolated fake HOME (see scripts/verify/chat-steer.mjs for why the fake HOME
 * makes the substitution airtight). It emits a two-agent fan-out shaped like a real one: the
 * `task_*` lifecycle frames, both dispatch modes' tool_results, and a backgrounded shell as
 * the control.
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
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-subagent-report');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

// Task ids must match `sanitizeSubagentId` (`[a-z0-9-]+` — no underscore), or the sidechain
// route rejects them before it ever looks at the disk.
const BG_TASK = 'sub-bg';
const SYNC_TASK = 'sub-sync';

// ─── the two reports, and the phrases that prove WHERE each one came from ─────────────
//
// Each body carries a marker that exists in exactly one carrier, so "the report is on screen"
// can never pass by accident on the other one's text.
const SYNC_MARK = 'SYNCMARK-tool-result-carrier';
const BG_MARK = 'BGMARK-sidechain-carrier';

const SYNC_REPORT = `## Frontend review

SOLID with one nit. Three files read, no blocking findings.

- \`ChatPane.tsx\` — the suppression gate is keyed by tool_use_id, correct.
- \`SubAgentCard.tsx\` — rows collapse on landing.
- ${SYNC_MARK}

\`\`\`ts
const reports = reportableRuns(runs);
\`\`\`
`;

const BG_REPORT = `## Security review

NEEDS_WORK. Three blocking findings, two of them defects in the plan.

1. The "raw text never reaches analytics" claim is false.
2. The sanitizer strips the wrong character set.
3. ${BG_MARK}
`;

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-subagent-report.mjs. */
const fs = require('fs');
const path = require('path');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false;

const BG_TASK = ${JSON.stringify(BG_TASK)};
const SYNC_TASK = ${JSON.stringify(SYNC_TASK)};
const SYNC_REPORT = ${JSON.stringify(SYNC_REPORT)};
const BG_REPORT = ${JSON.stringify(BG_REPORT)};

// ── the session id, and the transcripts THIS process is responsible for ──────────────
//
// The id must come from argv, not be invented here: the app pins a fresh conversation with
// \`--session-id <uuid>\` (agent-chat.ts), and the sidechain route derives its path from the
// PARENT transcript's filename — so a transcript written under any other id is a file the
// server will never look at. Getting this wrong is exactly how the first run of this script
// failed: both the report card and the drill-in reported the transcript unflushed while the
// fixture sat on disk under a different name.
//
// Writing them here is also the faithful arrangement — the real CLI is the writer.
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; };
const SID = flag('--session-id') || flag('--resume') || 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function entry(i, type, message, extra) {
  const stamp = new Date(Date.parse('2026-09-02T10:00:00Z') + i * 60000).toISOString();
  return JSON.stringify(Object.assign({
    type, uuid: type + '-' + i + '-' + Math.random().toString(16).slice(2, 10),
    timestamp: stamp, cwd: process.cwd(), sessionId: SID, version: '2.1.220', gitBranch: 'main', message,
  }, extra || {}));
}

function writeTranscripts() {
  const dir = path.join(process.env.HOME, '.claude', 'projects', 'scratch-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), [
    entry(0, 'user', { role: 'user', content: [{ type: 'text', text: 'review this' }] }),
    entry(0, 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'Dispatching two reviewers.' }] }),
  ].join('\\n') + '\\n');

  // The BACKGROUNDED agent's own sidechain, at the path the server derives:
  // <slug>/<conv>/subagents/agent-<taskId>.jsonl. It deliberately ends with a TOOL call
  // AFTER the verdict — the ordering that hides a report from a naive "last entry" reader,
  // and what a real agent does when it runs one more command after writing up.
  const subDir = path.join(dir, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-' + BG_TASK + '.jsonl'), [
    entry(0, 'user', { role: 'user', content: [{ type: 'text', text: 'Review the plan for security defects.' }] }, { isSidechain: true }),
    entry(1, 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'Reading the routes…' }] }, { isSidechain: true }),
    entry(2, 'assistant', { role: 'assistant', content: [{ type: 'text', text: BG_REPORT }] }, { isSidechain: true }),
    entry(3, 'assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sub_tail', name: 'Bash', input: { command: 'git status --porcelain', description: 'Check the tree' } }] }, { isSidechain: true }),
    entry(3, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub_tail', content: [{ type: 'text', text: '' }] }] }, { isSidechain: true }),
  ].join('\\n') + '\\n');
}
writeTranscripts();

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: ['compact'] });
  await sleep(150);

  // ── agent 1: BACKGROUNDED. Its tool_result is the CLI's receipt, not the report — which is
  //    why the card has to go and read the sidechain. This is the shape every fan-out skill
  //    in this project produces.
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Security review', subagent_type: 'review-security', prompt: 'Review the plan for security defects.', run_in_background: true } }] } });
  await sleep(120);
  out({ type: 'system', subtype: 'task_started', task_id: BG_TASK, tool_use_id: 'toolu_bg', task_type: 'local_agent', subagent_type: 'review-security', description: 'Security review', prompt: 'Review the plan for security defects.' });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text: 'Agent started in the background with ID: ' + BG_TASK }] }] } });
  await sleep(200);
  out({ type: 'system', subtype: 'task_progress', task_id: BG_TASK, description: 'Running Grep for dataLayer', tool_name: 'Grep' });

  // ── agent 2: SYNCHRONOUS. Its tool_result IS the report, so its card needs no fetch.
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sync', name: 'Agent', input: { description: 'Frontend review', subagent_type: 'review-frontend', prompt: 'Review the diff for frontend defects.' } }] } });
  await sleep(120);
  out({ type: 'system', subtype: 'task_started', task_id: SYNC_TASK, tool_use_id: 'toolu_sync', task_type: 'local_agent', subagent_type: 'review-frontend', description: 'Frontend review', prompt: 'Review the diff for frontend defects.' });
  await sleep(500);

  // ── the control: a backgrounded SHELL. Rides the identical task_* frames and must NOT
  //    produce a report card.
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: 'npm test', description: 'Run the suite', run_in_background: true } }] } });
  out({ type: 'system', subtype: 'task_started', task_id: 'sub-shell', tool_use_id: 'toolu_sh', task_type: 'local_bash', description: 'Run the suite' });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sh', content: [{ type: 'text', text: 'Command running in background with ID: sub-shell' }] }] } });
  await sleep(300);

  // ── both agents land. The notification carries the human-facing SUMMARY — the standfirst.
  out({ type: 'system', subtype: 'task_notification', task_id: SYNC_TASK, tool_use_id: 'toolu_sync', status: 'completed', summary: 'SOLID with one nit — no blocking findings', total_tokens: 8210, total_tool_use_count: 6, total_duration_ms: 41000 });
  // \`tool_use_result\` is a TOP-LEVEL sibling of \`message\`, not a field inside it — see
  // fromToolUseResult in chatProtocol.ts. Nested, the run silently loses its model chip.
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sync', content: [{ type: 'text', text: SYNC_REPORT }] }] }, tool_use_result: { agentId: SYNC_TASK, resolvedModel: 'claude-opus-5', totalTokens: 8210, totalToolUseCount: 6, totalDurationMs: 41000 } });
  await sleep(250);
  out({ type: 'system', subtype: 'task_notification', task_id: BG_TASK, tool_use_id: 'toolu_bg', status: 'completed', summary: 'NEEDS_WORK — three blocking findings', total_tokens: 15400, total_tool_use_count: 14, total_duration_ms: 252000 });
  await sleep(250);

  // ── and the main agent RELAYS, in the shape chat-surface.ts now asks for: which agent, the
  //    one thing it changes, what happens next. Not the report.
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'RELAY-LINE: review-security came back NEEDS_WORK — I am fixing the two plan defects before touching anything else. ' + prompt }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: SID });
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

// ─── setup (mirrors scripts/verify/chat-toolrows.mjs + chat-scroll.mjs's seeding) ─────

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
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const shot = process.env.VERIFY_SHOTS;

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
  ok('the turn finishes', await until(async () => !(await busy()) && (await paneText()).includes('RELAY-LINE'), 60000),
    (await paneText()).slice(-300));
  await page.waitForTimeout(600);

  // ── 1 — a card per landed agent, named, while the group's rows stay collapsed ──────
  console.log('── the cards: one per landed agent, named');
  ok('the two-agent fan-out is ONE group card, and its rows collapsed when the last run landed',
    (await vis('.chat-subagents').count()) === 1 && (await vis('.chat-subagents[data-open]').count()) === 0);
  ok('exactly TWO report cards — one per dispatched agent that landed',
    (await vis('.chat-subreport').count()) === 2,
    `saw ${await vis('.chat-subreport').count()}`);
  const cardText = (await vis('.chat-subreport').allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
  ok('each card names WHOSE report it is — the run name and its subagent type',
    cardText.includes('Security review') && cardText.includes('review-security')
    && cardText.includes('Frontend review') && cardText.includes('review-frontend'),
    cardText.slice(0, 300));
  ok('…and leads with the run\'s OWN summary, not a description written by the UI',
    cardText.includes('NEEDS_WORK — three blocking findings')
    && cardText.includes('SOLID with one nit'),
    cardText.slice(0, 300));
  ok('every card offers the way in', cardText.includes('read the full report'), cardText.slice(0, 200));

  // ── 5 — the control: a background SHELL is not an agent with something to say ──────
  ok('a backgrounded SHELL got NO report card, though it rode the identical task_* frames',
    !cardText.includes('Run the suite'), cardText.slice(0, 300));

  // ── 2 — collapsed, the wall is NOT in the transcript ──────────────────────────────
  console.log('── collapsed: a standfirst, not a wall');
  const collapsedPane = await paneText();
  ok('neither report BODY is on screen — the marker phrases are absent, not merely clipped',
    !collapsedPane.includes(SYNC_MARK) && !collapsedPane.includes(BG_MARK));
  ok('…and no report prose is mounted at all', (await page.locator('.chat-subreport-prose').count()) === 0);
  const heights = await vis('.chat-subreport').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  ok('a collapsed card costs ~3 lines of transcript, not a screenful',
    heights.length === 2 && heights.every((h) => h > 0 && h <= 110), JSON.stringify(heights));
  if (shot) await vis('.chat-subagents').first().screenshot({ path: `${shot}/subagent-reports-collapsed-${theme}.png` });

  // ── 3 + 4a — the SYNCHRONOUS carrier: the report was already in hand ──────────────
  console.log('── open: the tool_result carrier (synchronous dispatch)');
  const syncCard = vis('.chat-subreport').filter({ hasText: 'Frontend review' }).first();
  await syncCard.locator('.chat-subreport-head').click();
  ok('clicking a card renders its report IN PLACE',
    await until(async () => (await syncCard.locator('.chat-subreport-prose').count()) === 1, 10000));
  ok('…from its own tool_result — no fetch was needed for a synchronous dispatch',
    await until(async () => (await syncCard.innerText()).includes(SYNC_MARK), 10000),
    (await syncCard.innerText()).slice(0, 300));
  ok('and it is rendered as MARKDOWN, not flattened prose — a heading, a list and a code block',
    (await syncCard.locator('.chat-subreport-prose h2').count()) >= 1
    && (await syncCard.locator('.chat-subreport-prose li').count()) >= 3
    && (await syncCard.locator('.chat-subreport-prose pre').count()) >= 1,
    `h2=${await syncCard.locator('.chat-subreport-prose h2').count()} li=${await syncCard.locator('.chat-subreport-prose li').count()} pre=${await syncCard.locator('.chat-subreport-prose pre').count()}`);
  if (shot) await syncCard.screenshot({ path: `${shot}/subagent-report-open-${theme}.png` });

  // ── 4b — the BACKGROUNDED carrier: fetched from the sidechain, lazily ─────────────
  console.log('── open: the sidechain carrier (backgrounded dispatch)');
  const bgCard = vis('.chat-subreport').filter({ hasText: 'Security review' }).first();
  await bgCard.locator('.chat-subreport-head').click();
  ok('a BACKGROUNDED agent — whose tool_result is only "started in the background" — still '
    + 'shows its report, read from its own sidechain transcript on first open',
    await until(async () => (await bgCard.innerText()).includes(BG_MARK), 15000),
    (await bgCard.innerText()).slice(0, 400));
  ok('…and the CLI\'s background receipt is not what got shown',
    !(await bgCard.innerText()).includes('started in the background'),
    (await bgCard.innerText()).slice(0, 200));
  ok('a TRAILING tool call after the verdict did not hide it — the report is the last PROSE, '
    + 'not the last entry',
    !(await bgCard.innerText()).includes('git status --porcelain'));

  // ── 6 — the whole run is still one click further in ───────────────────────────────
  console.log('── the drill-in is still there');
  await bgCard.locator('.chat-subreport-open').click();
  ok('"Open the whole run" opens the full sidechain drill-in',
    await until(async () => (await vis('.chat-slideover-panel').count()) > 0, 10000));
  ok('…on that agent, and showing its real transcript rather than the degrade note',
    await until(async () => {
      const t = (await vis('.chat-slideover-panel').innerText()).replace(/\s+/g, ' ');
      return t.includes('Security review') && t.includes('Reading the routes');
    }, 10000),
    (await vis('.chat-slideover-panel').innerText()).replace(/\s+/g, ' ').slice(0, 300));
  // Closed by its OWN button, not Escape: Escape left the scrim mounted and it swallowed
  // every later click, which reads in the log as a card that refuses to collapse.
  await vis('.chat-slideover-close').first().click();
  ok('…and it closes again', await until(async () => (await vis('.chat-slideover-panel').count()) === 0, 8000));

  // ── collapsing again puts the wall away ──────────────────────────────────────────
  await syncCard.locator('.chat-subreport-head').click();
  await page.waitForTimeout(300);
  ok('a card closes again, and takes its wall with it',
    (await syncCard.locator('.chat-subreport-prose').count()) === 0);

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
  console.log('· setting up scratch vault + scripted claude (which writes its own transcripts)…');
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
