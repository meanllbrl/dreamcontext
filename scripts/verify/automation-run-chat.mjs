#!/usr/bin/env node
/**
 * Automation run → chat hand-off — browser-level verification of the whole path.
 *
 *   npm run build && npm run verify:automation-run-chat
 *
 * The claim under test: pressing a run's button on the Automations board REOPENS that run's
 * claude conversation as a chat tab — with a header that says whose conversation it is —
 * instead of loading a flat list inside the panel. And the claim's dangerous edge: a run
 * whose transcript never landed must be REFUSED, not opened into a blank chat (`--resume`
 * against a missing transcript silently fresh-pins a new empty conversation under the same
 * uuid, which would look exactly like the run and contain none of it).
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/api/automations*` routes, the real
 * `/api/agent/chat-history` replay, the real chat WS bridge, and the real React surface in
 * Chromium, in BOTH themes.
 *
 * WHAT IT DOES NOT TOUCH — your machine. Isolated fake HOME, a scratch project, synthesized
 * manifests/caches/transcripts, and `claude` replaced by a stand-in on that HOME's PATH: a
 * resume spawns a process, sends nothing, and spends no tokens. No launchd, no dispatcher,
 * no automation is ever actually executed.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST (matching verify/past-chats-ui.mjs). Exit 0 iff
 * every check in every theme passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dc-ui-automation-run-chat');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-automation-run-chat');
const TRANSCRIPTS = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));

const SLUG = 'funnel-watch';
const TITLE = 'CalBuddy Funnel Watch';
/** Run #1 has a transcript; run #2's session id was recorded but no transcript ever
 *  landed — the fresh-pin trap this feature has to refuse. */
const SESSION_OK = '11111111-1111-4111-8111-111111111111';
const SESSION_NO_TRANSCRIPT = '22222222-2222-4222-8222-222222222222';

const OUTPUT_REL = `_dream_context/automations/output/${SLUG}/2026-08-03.md`;
const OUTPUT_ABS = join(PROJ, OUTPUT_REL);

/** The real brief `runner.ts` composes — the first "user" turn of every automation run, and
 *  the exact reason the header exists: without it this reads as something the user typed. */
const BRIEF = `You are scheduled dreamcontext automation "${TITLE}" in ${PROJ}. NO user available: never ask, finish autonomously. OUTPUT CONTRACT: your final message is saved verbatim to ${OUTPUT_ABS}.`;
const REPORT = 'Funnel is healthy. Worst step drop: checkout → payment at 38%.';

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
    out({ type: 'system', subtype: 'init', session_id: 'standin', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'default', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'STANDIN ACK' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ACK', num_turns: 1, total_cost_usd: 0, usage: {}, session_id: 'standin' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const jsonl = (e) => e.map((x) => JSON.stringify(x)).join('\n') + '\n';

/** A headless run's transcript as claude actually files it: the brief as the first user
 *  turn, a tool call, then the report as the final assistant message (which IS what the
 *  runner writes to the output document — `--output-format json`'s `result`). */
function runTranscript(id) {
  return jsonl([
    {
      type: 'user', isSidechain: false, uuid: `${id}-u0`, timestamp: '2026-08-03T08:00:00.000Z',
      cwd: PROJ, sessionId: id, gitBranch: 'main', version: '2.1.220',
      message: { role: 'user', content: [{ type: 'text', text: BRIEF }] },
    },
    {
      type: 'assistant', isSidechain: false, uuid: `${id}-a0`, sessionId: id,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'dreamcontext lab insights' } }],
      },
    },
    {
      type: 'user', isSidechain: false, uuid: `${id}-u1`, sessionId: id,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ten insights synced' }] },
    },
    {
      type: 'assistant', isSidechain: false, uuid: `${id}-a1`, sessionId: id,
      message: { role: 'assistant', content: [{ type: 'text', text: REPORT }] },
    },
  ]);
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(TRANSCRIPTS, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const cli = (args) => {
    const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args],
      { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  };

  // The manifest is written by the REAL CLI — a hand-rolled one could drift from the
  // format the route actually reads, and then this script would be verifying its own fixture.
  cli(['vaults', 'add', 'proj', PROJ]);
  cli(['automations', 'create', SLUG, '--title', TITLE, '--days', 'daily', '--at', '11:00']);

  mkdirSync(dirname(OUTPUT_ABS), { recursive: true });
  writeFileSync(OUTPUT_ABS, `# ${TITLE}\n\n${REPORT}\n`);

  // Two recorded runs, newest first — exactly how `recordRun` prepends them.
  const event = (firedAt, sessionId, durationMs, costUsd, numTurns) => ({
    firedAt, startedAt: firedAt, finishedAt: firedAt, status: 'ok', durationMs,
    outputPath: OUTPUT_ABS, error: null, exitCode: 0, sessionId, costUsd, numTurns,
    permissionDenials: 0,
  });
  mkdirSync(join(PROJ, '_dream_context', 'automations', 'cache'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'automations', 'cache', `${SLUG}.json`), JSON.stringify({
    slug: SLUG,
    lastRunAt: '2026-08-03T08:00:00.000Z',
    lastFireAt: '2026-08-03T08:00:00.000Z',
    status: 'ok',
    durationMs: 41000,
    outputPath: OUTPUT_ABS,
    error: null,
    exitCode: 0,
    history: [
      event('2026-08-03T08:00:00.000Z', SESSION_OK, 41000, 0.79, 9),
      event('2026-08-02T08:00:00.000Z', SESSION_NO_TRANSCRIPT, 30000, 0.51, 7),
    ],
  }, null, 2));

  // Only run #1 gets a transcript. Run #2 keeps its recorded session id with no file —
  // the state claude leaves behind when a session never produced a turn, or was pruned.
  writeFileSync(join(TRANSCRIPTS, `${SESSION_OK}.jsonl`), runTranscript(SESSION_OK));

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
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
  page.on('pageerror', (e) => check(`no page error (${String(e).slice(0, 100)})`, false));

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const panel = page.locator('.adp-panel');
  const header = page.locator('.automation-run-header');
  const paneText = async () => (await page.locator('.chat-pane:visible').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  const tabText = async () => (await page.locator('.agent-tab:visible').allInnerTexts()).join(' | ');

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }

  // ── The board → the automation's detail panel ────────────────────────────────────
  await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
  check('the Automations board opens',
    await until(async () => (await page.locator('.auto-card').count()) > 0, 15000),
    await page.locator('.page-content, main').first().innerText().catch(() => '').then((t) => t.slice(0, 120)));
  await page.locator('.auto-card').first().click();
  check('the run history is listed', await until(async () => (await page.locator('.adp-history-row').count()) === 2, 10000));

  // ── The button says what it now does ─────────────────────────────────────────────
  const btns = page.locator('.adp-history-row--openable');
  check('every run with a session offers the hand-off', (await btns.count()) === 2);
  // The "open chat" PILL is gone — the whole row is the affordance now (a 60px
  // target at the right edge of a narrow rail is a target you miss), so the
  // assertion is that the row is a real button naming the run's outcome, not
  // that a literal string 'open chat' is somewhere on screen.
  check('the row itself is the hand-off, and names the run\'s outcome',
    (await btns.first().evaluate((el) => el.tagName)) === 'BUTTON'
      && /completed|failed|timed out|stopped to ask/i.test(await btns.first().innerText()),
    JSON.stringify(await btns.first().innerText()));
  await page.screenshot({ path: join(SHOTS, `panel-${theme}.png`) });

  // ── Run #1: opens as a chat ──────────────────────────────────────────────────────
  await btns.first().click();
  check('the panel gets out of the way once the chat is open',
    await until(async () => (await panel.count()) === 0, 15000));
  check('the run opens as a tab', await until(async () => (await page.locator('.agent-tab:visible').count()) === 1, 20000));
  // STALE SINCE D7, caught here: the marker used to be `· run #1` and is now the
  // run's DATE, because app-open restores every run that needs a human and a
  // strip of tabs has to say WHEN without a click (`automationRunTabTitle`).
  // Asserted structurally rather than against a hardcoded "Aug 3" — the helper
  // formats with `toLocaleDateString`, so a literal date pins this to whatever
  // timezone and locale the machine running it happens to have.
  const t1 = await tabText();
  check('the tab is titled from the automation and marks WHICH run by date',
    t1.includes(TITLE) && / · /.test(t1) && !/run #/.test(t1), JSON.stringify(t1));

  // ── The header: the reason a machine's transcript is readable at all ─────────────
  check('the run header renders above the transcript', await until(async () => (await header.count()) === 1, 15000));
  const head = (await header.innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('…it names the automation', head.includes(TITLE), head.slice(0, 160));
  check('…it says which run and how it ended', /Run #1/.test(head) && /ok/.test(head), head.slice(0, 160));
  check('…it carries the run telemetry (turns, cost)', /9 turns/.test(head) && /\$0\.7900/.test(head), head.slice(0, 200));
  check('…it states the permission asymmetry the transcript cannot show',
    /bypassPermissions/.test(head) && /current mode/.test(head), head.slice(0, 260));
  check('…and it offers the output document', (await page.locator('.arh-output').count()) === 1);

  // ── The transcript itself really is the run's ────────────────────────────────────
  check('the run\'s own report is replayed',
    await until(async () => (await paneText()).includes('checkout → payment at 38%'), 25000),
    (await paneText()).slice(0, 200));
  check('…including the brief that opened it', (await paneText()).includes('You are scheduled dreamcontext automation'));
  // The tool row names its OBJECT, not the raw command — `dreamcontext lab insights` renders
  // as "Insight · insights". Asserting the command string would be asserting against the
  // transcript's own rendering rules, not against this feature.
  check('…and the tool call it made, named by what it touched',
    /Insight/.test(await paneText()), (await paneText()).slice(0, 220));
  await page.screenshot({ path: join(SHOTS, `chat-${theme}.png`) });

  // The composer is the entire point: this is a conversation, not a viewer.
  check('there is a composer to continue in', (await page.locator('.chat-pane:visible .chat-composer, .chat-pane:visible textarea').count()) > 0);

  // ── Run #2: no transcript → refused in place, no blank chat ──────────────────────
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
  await until(async () => (await page.locator('.auto-card').count()) > 0, 15000);
  await page.locator('.auto-card').first().click();
  await until(async () => (await page.locator('.adp-history-row').count()) === 2, 10000);
  await page.locator('.adp-history-row--openable').nth(1).click();

  const refusal = page.locator('.adp-session-empty');
  check('a run with no transcript is refused, with the reason',
    await until(async () => /No transcript on disk/i.test(await refusal.innerText().catch(() => '')), 15000),
    await refusal.innerText().catch(() => '(nothing rendered)'));
  check('…the panel stays open rather than dumping the user somewhere', (await panel.count()) === 1);
  check('…and NO second tab was opened',
    (await page.locator('.agent-tab:visible').count()) <= 1, await tabText());
  await page.screenshot({ path: join(SHOTS, `refused-${theme}.png`) });

  // ── Re-opening run #1 focuses the tab it already has ─────────────────────────────
  await page.locator('.adp-session-head .adp-close').first().click();
  await page.waitForTimeout(400);
  await page.locator('.adp-history-row--openable').first().click();
  await page.waitForTimeout(2500);
  check('reopening the same run does not resume a second CLI onto one transcript',
    (await page.locator('.agent-tab:visible').count()) === 1, await tabText());

  await browser.close();
}

let server = null;
try {
  console.log('· fixture (isolated HOME, synthesized manifest + cache + transcript, stand-in claude)…');
  setup();
  const port = await freePort();
  console.log(`· real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of ['dark', 'light']) {
    // The surface mirrors its tab roster to disk, so the tab the dark run opened would
    // restore as a dormant tab in the light one and every tab count here would be off by one.
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
process.exit(report.fail === 0 ? 0 : 1);
