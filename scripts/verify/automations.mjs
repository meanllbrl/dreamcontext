#!/usr/bin/env node
/**
 * Automations redesign — runtime proof (T21).
 *
 *   npm run build && npm run verify:automations
 *
 * This is the owner-agreed definition of done for the whole automations redesign (see
 * `_dream_context/tmp/goal-automations-plan.md`, T21). Four checkpoints, each driven
 * against the REAL running app, never asserted by reading source:
 *
 *   1. Creating an automation writes a valid `## Flow` block — parsed back with the real
 *      `parseFlowSection`, round-tripped through `renderFlowSection`, and checked for the
 *      hitl node a default automation must NOT have.
 *   2. The automation detail screen renders the flow — at least 4 nodes, at the exact
 *      coordinates the real `layoutFlow` predicts for the same graph.
 *   3. A HITL question renders inline in chat, replaces the composer while open, and
 *      answering it resumes the bound session.
 *   4. A completed run opens as a chat tab (`data-session-kind="automation"`), titled
 *      `"<name> · <date>"` — asserted structurally (name / separator / two different dates
 *      differ), never against one hardcoded `toLocaleDateString` string.
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/api/automations*` routes, the real
 * chat WS bridge, and the real React surface in Chromium (mirrors `automation-run-chat.mjs`).
 * Checkpoints 1 and 2 additionally run the REAL `parseFlowSection` / `renderFlowSection` /
 * `layoutFlow` functions in-process via `npx tsx` (no dist export exists for them — the CLI
 * only ships a bundled binary), never a reimplementation of their logic.
 *
 * WHAT IT DOES NOT TOUCH — your machine. Isolated fake HOME, a scratch project, `claude`
 * replaced by a stand-in on that HOME's PATH: nothing spawns a real model, spends tokens, or
 * needs auth.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST, matching `automation-run-chat.mjs`. Exit 0 iff
 * every check in every theme passed. A checkpoint that fails because the PRODUCT is wrong is
 * reported as a failure with evidence, never silently worked around.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = join(REPO, 'dist', 'index.js');
const STORE_TS = join(REPO, 'src', 'lib', 'automations', 'store.ts');
const HITL_TS = join(REPO, 'src', 'lib', 'automations', 'hitl.ts');
const SESSION_REGISTRY_TS = join(REPO, 'src', 'lib', 'automations', 'session-registry.ts');
const FLOW_LAYOUT_TS = join(REPO, 'dashboard', 'src', 'components', 'automations', 'flowLayout.ts');

const SCRATCH = join(tmpdir(), 'dc-ui-automations');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const AUTOMATIONS_DIR = join(CONTEXT_ROOT, 'automations');
const SHOTS = join(REPO, 'tmp', 'verify-automations');
const TRANSCRIPTS = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));
const HELPER_PATH = join(SCRATCH, 'flow-helper.mts');

// ─── fixture identities ──────────────────────────────────────────────────────────────────

/** Checkpoint 2 + 4: a review-gated automation (so its flow has a hitl node, 4 nodes total)
 *  with two completed runs on very different calendar dates. */
const AUTO_A_SLUG = 'flow-showcase';
const AUTO_A_TITLE = 'Flow Showcase Runs';
const AUTO_A_RUN_NEW = { firedAt: '2026-08-03T12:00:00.000Z', session: '11111111-1111-4111-8111-111111111111' };
const AUTO_A_RUN_OLD = { firedAt: '2026-06-15T12:00:00.000Z', session: '22222222-2222-4222-8222-222222222222' };

/** Checkpoint 3: one completed run whose session gets re-seeded with a pending `flow-hitl`
 *  question (and a machine-local session binding) fresh for every theme pass. */
const AUTO_B_SLUG = 'nightly-ask';
const AUTO_B_TITLE = 'Nightly Ask Check';
const AUTO_B_RUN = { firedAt: '2026-08-05T09:00:00.000Z', session: '33333333-3333-4333-8333-333333333333' };
const HITL_QUESTION_TEXT = 'Should I publish this week’s digest now, or hold it for a second look?';

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for `+"`claude`"+` — see scripts/verify/automations.mjs.
 *  Branches on the two shapes this codebase actually spawns:
 *   - interactive stream-json (agent-chat.ts, used to open/resume a chat tab) — ACK every
 *     user turn, same pattern as verify/automation-run-chat.mjs's stand-in.
 *   - one-shot -p / --output-format json (verdict.ts's buildResumeArgs, used to resume a
 *     session after a HITL answer) — no stdin interaction, print ONE JSON result and exit. */
const args = process.argv.slice(2);
if (!args.includes('--input-format')) {
  const idx = args.indexOf('--resume');
  const sessionId = idx !== -1 ? args[idx + 1] : 'standin-oneshot';
  process.stdout.write(JSON.stringify({
    session_id: sessionId, is_error: false,
    result: 'Acknowledged your answer — continuing the job.',
    total_cost_usd: 0.01, num_turns: 1, duration_ms: 400, permission_denials: [],
  }) + '\\n');
  process.exit(0);
}
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

/** Runs `parseFlowSection`/`renderFlowSection`/`layoutFlow`/`createQuestion`/
 *  `recordAutomationSession` FOR REAL, in a throwaway `tsx` process — there is no dist
 *  export for any of them (tsup bundles one CLI binary, nothing else), so this is the only
 *  way to invoke the actual functions named in the task rather than reimplementing them. */
const HELPER_SRC = [
  "import { readFileSync } from 'node:fs';",
  `import { parseFlowSection, renderFlowSection } from ${JSON.stringify(STORE_TS)};`,
  `import { layoutFlow } from ${JSON.stringify(FLOW_LAYOUT_TS)};`,
  `import { createQuestion } from ${JSON.stringify(HITL_TS)};`,
  `import { recordAutomationSession } from ${JSON.stringify(SESSION_REGISTRY_TS)};`,
  '',
  'const [, , mode, ...rest] = process.argv;',
  '',
  "if (mode === 'roundtrip' || mode === 'layout') {",
  '  const [manifestPath] = rest;',
  "  const content = readFileSync(manifestPath, 'utf-8');",
  '  const graph = parseFlowSection(content);',
  '  if (!graph) { console.log(JSON.stringify({ graph: null })); process.exit(0); }',
  "  if (mode === 'roundtrip') {",
  "    const rerendered = '## Flow\\n' + renderFlowSection(graph);",
  '    const graph2 = parseFlowSection(rerendered);',
  '    const roundtripOk = JSON.stringify(graph) === JSON.stringify(graph2);',
  "    const hasHitl = graph.nodes.some((n) => n.kind === 'hitl');",
  '    console.log(JSON.stringify({ graph, roundtripOk, hasHitl }));',
  '  } else {',
  '    const spec = layoutFlow(graph);',
  '    console.log(JSON.stringify({ graph, spec }));',
  '  }',
  "} else if (mode === 'seed-hitl') {",
  '  const [contextRoot, slug, runFiredAt, sessionId, home, questionText] = rest;',
  '  recordAutomationSession(slug, sessionId, home);',
  "  const q = createQuestion(contextRoot, { slug, runFiredAt, kind: 'flow-hitl', sessionId, channel: 'chat', question: questionText });",
  '  console.log(JSON.stringify({ id: q.id }));',
  '} else {',
  '  throw new Error(`unknown helper mode: ${mode}`);',
  '}',
  '',
].join('\n');

// ─── small utilities ─────────────────────────────────────────────────────────────────────

function cli(args) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`dreamcontext ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Invokes the real TS functions above via `npx tsx` — see the verify skill: "tsx works" is
 *  the documented house pattern for driving source without a build step for it specifically. */
function runTsxHelper(...args) {
  const r = spawnSync('npx', ['tsx', HELPER_PATH, ...args], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`tsx helper (${args.join(' ')}) failed: ${r.stderr || r.stdout}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function automationManifestPath(slug) {
  return join(AUTOMATIONS_DIR, `${slug}.md`);
}

const jsonl = (entries) => entries.map((x) => JSON.stringify(x)).join('\n') + '\n';

/** A minimal but realistic headless-run transcript: brief → tool call → report. */
function runTranscript(id, title, projDir, report) {
  const brief = `You are scheduled dreamcontext automation "${title}" in ${projDir}. NO user available: never ask, finish autonomously.`;
  return jsonl([
    { type: 'user', isSidechain: false, uuid: `${id}-u0`, timestamp: '2026-08-01T08:00:00.000Z', cwd: projDir, sessionId: id, gitBranch: 'main', version: '2.1.220', message: { role: 'user', content: [{ type: 'text', text: brief }] } },
    { type: 'assistant', isSidechain: false, uuid: `${id}-a0`, sessionId: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo status' } }] } },
    { type: 'user', isSidechain: false, uuid: `${id}-u1`, sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    { type: 'assistant', isSidechain: false, uuid: `${id}-a1`, sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: report }] } },
  ]);
}

function writeCache(slug, runs) {
  const dir = join(AUTOMATIONS_DIR, 'cache');
  mkdirSync(dir, { recursive: true });
  const history = runs.map((r) => ({
    firedAt: r.firedAt, startedAt: r.firedAt, finishedAt: r.firedAt, status: 'ok',
    durationMs: 20000, outputPath: r.outputPath, error: null, exitCode: 0,
    sessionId: r.session, costUsd: 0.42, numTurns: 5, permissionDenials: 0,
  }));
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify({
    slug, lastRunAt: runs[0].firedAt, lastFireAt: runs[0].firedAt, status: 'ok',
    durationMs: 20000, outputPath: runs[0].outputPath, error: null, exitCode: 0, history,
  }, null, 2));
}

// ─── fixture setup ───────────────────────────────────────────────────────────────────────

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(TRANSCRIPTS, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  writeFileSync(HELPER_PATH, HELPER_SRC);

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  cli(['vaults', 'add', 'proj', PROJ]);

  // AUTO_A — review-gated (its derived flow gets a hitl node ⇒ 4 nodes), two runs far apart.
  cli(['automations', 'create', AUTO_A_SLUG, '--title', AUTO_A_TITLE, '--days', 'daily', '--at', '09:00', '--review', 'agent']);
  for (const r of [AUTO_A_RUN_NEW, AUTO_A_RUN_OLD]) {
    r.outputPath = join(CONTEXT_ROOT, 'automations', 'output', AUTO_A_SLUG, `${r.firedAt.slice(0, 10)}.md`);
    mkdirSync(dirname(r.outputPath), { recursive: true });
    writeFileSync(r.outputPath, `# ${AUTO_A_TITLE}\n\nRun report.\n`);
    writeFileSync(join(TRANSCRIPTS, `${r.session}.jsonl`), runTranscript(r.session, AUTO_A_TITLE, PROJ, 'All green.'));
  }
  writeCache(AUTO_A_SLUG, [AUTO_A_RUN_NEW, AUTO_A_RUN_OLD]);

  // AUTO_B — one run whose session gets a fresh pending HITL question per theme pass.
  cli(['automations', 'create', AUTO_B_SLUG, '--title', AUTO_B_TITLE, '--days', 'daily', '--at', '18:00']);
  AUTO_B_RUN.outputPath = join(CONTEXT_ROOT, 'automations', 'output', AUTO_B_SLUG, `${AUTO_B_RUN.firedAt.slice(0, 10)}.md`);
  mkdirSync(dirname(AUTO_B_RUN.outputPath), { recursive: true });
  writeFileSync(AUTO_B_RUN.outputPath, `# ${AUTO_B_TITLE}\n\nStopped to ask.\n`);
  writeFileSync(join(TRANSCRIPTS, `${AUTO_B_RUN.session}.jsonl`), runTranscript(AUTO_B_RUN.session, AUTO_B_TITLE, PROJ, 'Ready to publish, pending your answer.'));
  writeCache(AUTO_B_SLUG, [AUTO_B_RUN]);
}

/** Re-seeds AUTO_B's pending question + machine-local session binding — called fresh at the
 *  top of every theme pass, since checkpoint 3 answers (and thereby consumes) it. */
function seedHitlFixtures() {
  runTsxHelper('seed-hitl', CONTEXT_ROOT, AUTO_B_SLUG, AUTO_B_RUN.firedAt, AUTO_B_RUN.session, HOME, HITL_QUESTION_TEXT);
}

// ─── checkpoint 1: creating an automation writes a valid ## Flow block ────────────────────
//
// The plan's "create-through-chat" mechanism is `AutomationsBoard.tsx`'s "+ New automation"
// button, which dispatches `AUTOMATION_CREATE_CHAT_EVENT` (dashboard/src/lib/
// automationCreateChat.ts) for `AgentSurface.tsx` to pick up and spawn an interview chat.
// `AgentSurface.tsx` never subscribes to that event anywhere — grepped, confirmed absent —
// so the button can never open a chat; `openAutomationCreateChat` always resolves
// `accepted: false`. That is checked directly below (checkpoint 1a) and reported as a real
// product bug if it reproduces, not routed around.
//
// The other half of checkpoint 1 — that creating an automation (via the exact
// `dreamcontext automations create` command the interview brief instructs the agent to run,
// same as `automation-run-chat.mjs`'s own fixture philosophy: "written by the REAL CLI") ends
// with a `## Flow` block that round-trips and carries no default hitl node — is fully
// checkable independent of that wiring bug, and is checkpoint 1b.
function checkpoint1FlowContract() {
  const slug = 'chat-created-flow';
  cli(['automations', 'create', slug, '--title', 'Chat Created Flow', '--days', 'daily', '--at', '11:00']);
  const manifestPath = automationManifestPath(slug);
  const raw = readFileSync(manifestPath, 'utf-8');
  check('1b: the manifest the real CLI writes on create has a ## Flow section', /^##\s+Flow\s*$/m.test(raw));

  const r = runTsxHelper('roundtrip', manifestPath);
  check('1b: parseFlowSection parses it back into a real graph', r.graph !== null, JSON.stringify(r).slice(0, 200));
  if (r.graph) {
    check('1b: the graph round-trips through renderFlowSection + parseFlowSection unchanged', r.roundtripOk === true);
    check('1b: a default automation carries NO hitl node (would block on review forever)', r.hasHitl === false, JSON.stringify(r.graph.nodes.map((n) => n.kind)));
  }
}

// ─── server plumbing (mirrors automation-run-chat.mjs) ────────────────────────────────────

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
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
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}

// ─── theme run: checkpoints 1a, 2, 4, 3 ────────────────────────────────────────────────────

async function runTheme(base, theme) {
  console.log(`\n═══ ${theme} ═══`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => check(`no page error (${String(e).slice(0, 100)})`, false));
  if (process.env.DC_DEBUG_ATTENTION) {
    page.on('console', (m) => { if (/attention|ack|DCATTN/i.test(m.text())) console.log(`    [console] ${m.text()}`); });
    page.on('response', async (r) => {
      if (!r.url().includes('attention')) return;
      console.log(`    [net] ${r.request().method()} ${r.url()} -> ${r.status()} ${JSON.stringify(await r.text().catch(() => '')).slice(0, 160)}`);
    });
  }

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const panel = page.locator('.adp-panel');
  const tabs = () => page.locator('.agent-tab:visible');
  const tabTexts = async () => tabs().allInnerTexts();
  const openAutomationsBoard = async () => {
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    await until(async () => (await page.locator('.auto-card').count()) > 0, 15000);
  };

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // ── checkpoint 5 (D7): a run that stopped to ask opens as a tab BY ITSELF ──────────────
  //
  // Nobody has clicked anything at this point — the page has only just loaded.
  // AUTO_B is seeded with an open `flow-hitl` question whose asking run has a
  // real session, which is exactly the state that used to leave a card saying
  // "waiting for your verdict" on a board nobody was looking at, with no way to
  // reach the conversation that could answer it.
  //
  // Asserted on the TAB ELEMENT's own `data-session-kind`, not the glyph span's:
  // the tab itself now carries the automation colour, and this is what proves
  // the attribute reached the element the CSS targets.
  const autoTabs = () => page.locator('.agent-tab[data-session-kind="automation"]:visible');
  const d7Opened = await until(async () => {
    const texts = await autoTabs().allInnerTexts();
    return texts.some((t) => t.includes(AUTO_B_TITLE));
  }, 25000);
  check(
    '5 (D7): a run holding an open question opens as an automation tab with no user action',
    d7Opened,
    d7Opened ? '' : `visible tabs=${JSON.stringify(await tabTexts())}`,
  );
  // The watermark must NOT be advanced by a mere read — only the ack does that,
  // and the ack fires only once a tab is actually open. POLLED, not sampled
  // once: the ack is a POST that races the tab appearing, and a single fetch
  // taken the instant the tab renders is a coin flip (it passed in one theme
  // and failed in the other, which is the tell).
  //
  // The vault header is NOT optional here, and leaving it off is what made this
  // check fail while the product was working: `ApiClient` sends
  // `X-Dreamcontext-Vault` on every request, so a bare fetch resolves whatever
  // contextRoot the server defaults to. On macOS that alone is enough — tmpdir
  // is `/var/folders/…`, a symlink to `/private/var/folders/…`, so the two
  // resolve to the same project under two different path STRINGS, and the
  // watermark is keyed by that string. The app wrote one key; this read the
  // other, and reported a feature that had just worked as broken.
  const readAttention = async () => page.evaluate(async (b) => {
    const r = await fetch(`${b}/api/automations/attention`, {
      headers: { 'X-Dreamcontext-Vault': 'proj' },
    });
    return r.json();
  }, base);
  const acked = await until(async () => {
    const a = await readAttention();
    return typeof a.watermark === 'string' && Array.isArray(a.runs) && a.runs.length === 0;
  }, 20000);
  const attention = await readAttention();
  check(
    '5 (D7): the machine-local watermark advanced only after the tab opened',
    acked && typeof attention.watermark === 'string',
    JSON.stringify(attention).slice(0, 200),
  );
  check(
    '5 (D7): …and the window is now empty, so a refresh does not re-open the same tab',
    Array.isArray(attention.runs) && attention.runs.length === 0,
    JSON.stringify(attention.runs ?? []).slice(0, 200),
  );
  await page.screenshot({ path: join(SHOTS, `checkpoint5-${theme}.png`) });

  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }

  // ── checkpoint 1a: the UI wiring the plan names for "create-through-chat" ──────────────
  await openAutomationsBoard();
  const tabsBefore = await tabs().count();
  const newBtn = page.locator('.auto-board-new-btn');
  if (await newBtn.count()) {
    await newBtn.click();
    await page.waitForTimeout(2000);
    const opened = (await tabs().count()) > tabsBefore;
    const toast = await page.locator('.auto-toast').innerText().catch(() => '');
    check(
      '1a: "+ New automation" opens an interview chat (create-through-chat, per the plan)',
      opened,
      opened ? '' : `NOT WIRED — AUTOMATION_CREATE_CHAT_EVENT (dashboard/src/lib/automationCreateChat.ts) has no `
        + `subscriber anywhere in AgentSurface.tsx, so openAutomationCreateChat() always resolves accepted:false. `
        + `Toast shown to the user: ${JSON.stringify(toast)}`,
    );
  } else {
    check('1a: "+ New automation" opens an interview chat (create-through-chat, per the plan)', false, 'button not found on a non-empty board');
  }
  await page.screenshot({ path: join(SHOTS, `checkpoint1-${theme}.png`) });

  // RE-BASELINE. Checkpoints 3 and 4 assert "this click added exactly one tab", so they need
  // the count as it stands AFTER 1a — not `tabsBefore`, which predates it. When 1a was
  // failing (the create-chat event had no subscriber) the two happened to be equal, so the
  // absolute `tabsBefore + n` arithmetic passed for the wrong reason; fixing the product
  // broke it. The deltas below are still real assertions, just measured from the right zero.
  const tabsAfterCreate = await tabs().count();

  // ── checkpoint 2: the detail screen renders the flow at layoutFlow's own coordinates ────
  await openAutomationsBoard();
  await page.locator('.auto-card', { hasText: AUTO_A_TITLE }).first().click();
  check('2: the detail panel opens', await until(async () => (await panel.count()) === 1, 10000));
  check('2: the flow canvas renders nodes', await until(async () => (await page.locator('.adp-flow-canvas .fd-node').count()) > 0, 15000));

  const domNodes = await page.locator('.adp-flow-canvas .fd-node rect').evaluateAll((els) => els.map((el) => ({
    x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')),
    w: Number(el.getAttribute('width')), h: Number(el.getAttribute('height')),
  })));
  const { graph: autoAGraph, spec } = runTsxHelper('layout', automationManifestPath(AUTO_A_SLUG));
  check('2: the manifest\'s own flow has at least 4 nodes (trigger/run/ask/report)', autoAGraph.nodes.length >= 4, JSON.stringify(autoAGraph.nodes.map((n) => n.kind)));
  check('2: the canvas rendered exactly the layoutFlow node count', domNodes.length === spec.nodes.length, `dom=${domNodes.length} spec=${spec.nodes.length}`);
  const coordsMatch = spec.nodes.length > 0 && spec.nodes.every((n, i) => domNodes[i]
    && domNodes[i].x === n.x && domNodes[i].y === n.y && domNodes[i].w === n.w && domNodes[i].h === n.h);
  check(
    '2: every node renders at the EXACT coordinate the real layoutFlow predicts',
    coordsMatch,
    JSON.stringify({ dom: domNodes, spec: spec.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })) }),
  );
  await page.screenshot({ path: join(SHOTS, `checkpoint2-${theme}.png`) });

  // ── checkpoint 4: a completed run opens as a chat tab, titled "<name> · <date>" ─────────
  check('4: the run history lists both runs', await until(async () => (await page.locator('.adp-history-row').count()) === 2, 10000));
  // The row ITSELF is the button now (a 60px pill at the right edge of a narrow
  // rail is a target you miss) — and `--openable` is exactly the rows that have a
  // session, so this selector still proves the guard, not just the click.
  const sessBtns = page.locator('.adp-history-row--openable');
  await sessBtns.first().click();
  check('4: a completed run opens as a chat tab', await until(async () => (await tabs().count()) === tabsAfterCreate + 1, 20000));
  // NOT a bare `count() === 1`: checkpoint 5 above proves D7 already opened
  // AUTO_B's tab by itself, so more than one automation tab is now the CORRECT
  // state. What matters is that THIS run's tab is one of them.
  const autoTabTexts1 = await page.locator('.agent-tab[data-session-kind="automation"]:visible').allInnerTexts();
  check(
    '4: the clicked run\'s tab is data-session-kind="automation"',
    autoTabTexts1.some((t) => t.includes(AUTO_A_TITLE)),
    autoTabTexts1.join(' | '),
  );
  // Tab text is "<glyph>\n<title>" (the kind glyph is a separate span sharing the tab's
  // innerText) — the title itself is the LAST non-empty line, never the whole string.
  const tabTitleOnly = (raw) => raw.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  const title1 = tabTitleOnly((await tabTexts()).find((t) => t.includes(AUTO_A_TITLE)) ?? '');
  check('4: the tab is titled from the automation, with a " · " separator', title1.startsWith(AUTO_A_TITLE) && title1.includes('·'), title1);
  // "Opens as a chat tab" means a WORKING one — a tab-strip label with a permanently blank
  // pane behind it is not what this checkpoint is proving. See the root-cause note above
  // checkpoint 3: this is the same `chatPanes` exclusion, caught here independently.
  const rendersTranscript = await until(
    async () => (await page.locator('.chat-pane:visible').first().innerText().catch(() => '')).includes('All green.'),
    15000,
  );
  check(
    '4: …and the tab actually renders the run\'s transcript (not just a tab-strip label)',
    rendersTranscript,
    rendersTranscript ? '' : `.chat-pane count=${await page.locator('.chat-pane').count()} — see the root-cause note on checkpoint 3`,
  );

  await openAutomationsBoard();
  await page.locator('.auto-card', { hasText: AUTO_A_TITLE }).first().click();
  await until(async () => (await page.locator('.adp-history-row').count()) === 2, 10000);
  await sessBtns.nth(1).click();
  check('4: the SECOND run also opens as its own tab', await until(async () => (await tabs().count()) === tabsAfterCreate + 2, 20000));
  const title2 = (await tabTexts()).filter((t) => t.includes(AUTO_A_TITLE)).map(tabTitleOnly).find((t) => t !== title1) ?? '';
  check(
    '4: two runs on different days differ in the date part, not the name (structural, no hardcoded date)',
    title2.startsWith(AUTO_A_TITLE) && title2.includes('·') && title2 !== title1,
    `run1=${JSON.stringify(title1)} run2=${JSON.stringify(title2)}`,
  );
  await page.screenshot({ path: join(SHOTS, `checkpoint4-${theme}.png`) });

  // ── checkpoint 3: a HITL question renders inline, locks the composer, and resumes ───────
  //
  // `tabsAfterCreate` (captured once, above, right after checkpoint 1a) is the only baseline
  // that stays meaningful here — `openAutomationsBoard()`'s Escape presses collapse the agent
  // surface, which makes every already-open `.agent-tab` transiently NOT `:visible`
  // (Playwright's actionability, not a DOM removal); a freshly re-sampled "before" count taken
  // while collapsed would read 0 and then jump by however many tabs are already open once
  // `openAutomationRunChat`'s `setExpanded(true)` re-shows the surface, not by the 1 this
  // specific action actually added. Two tabs are already open from checkpoint 4, so this one
  // is the 3rd.
  //
  // ROOT CAUSE OF THE FAILURE BELOW — confirmed, not guessed. Two hypotheses were tested and
  // both ruled out first: (a) T24's automation-bound resume gate — the actual WS URL connects
  // with `bypass=0` (`AgentSurface.tsx`'s surface-wide `bypass` state, default `false`, is what
  // `openAutomationRunChat` passes to `spawn`), and `shouldRejectAutomationResume` short-
  // circuits `if (!bypass...)` — so it never even reaches the binding check, whether or not
  // `recordAutomationSession` was called; (b) a missing session binding — `seedHitlFixtures`
  // DOES call it for this exact run, and a raw in-page `new WebSocket(...)` probe against this
  // exact uuid still opens with zero application frames either way, matching an UNCLAIMED
  // control uuid too, so WS frame silence on a bare no-prompt resume is normal, not a rejection.
  //
  // The real cause: `AgentSurface.tsx`'s `chatPanes` (the list that actually gets
  // `createPortal`-ed into a visible `.chat-pane`) is `sessionList.filter(m => m.kind ===
  // 'chat' && !m.dormant)` — filtered on the TAB METADATA's `kind`. `openAutomationRunChat`
  // deliberately sets that same tab's `kind: 'automation'` (its own comment: "NOT `s.kind` —
  // the whole C11/C12 fix", for the tab-strip glyph). That single field is double-booked:
  // the glyph needs `'automation'`, `chatPanes` needs `'chat'`, and nothing reconciles the
  // two. The underlying `ChatSession` (`s.kind` is always `'chat'` internally) spawns fine,
  // its WS opens fine, and `GET /api/agent/chat-history` returns the full correct transcript
  // (verified directly: 200, real parsed items) — none of that is broken. It is simply never
  // mounted anywhere: `chatPanes` silently excludes every automation-run tab, so `<ChatPane>`
  // never renders and `document.querySelectorAll('.chat-pane')` is 0 for these tabs — a
  // genuine product defect in T18a/T15's tab-kind plumbing, not a fixture gap, not this
  // script's arithmetic, and not something T21 owns (`AgentSurface.tsx` is a different lane).
  // Checkpoint 4 (above) independently catches the same defect via its own render assertion.
  await openAutomationsBoard();
  await page.locator('.auto-card', { hasText: AUTO_B_TITLE }).first().click();
  await until(async () => (await page.locator('.adp-history-row').count()) === 1, 10000);
  await page.locator('.adp-history-row--openable').first().click();
  // NOT "a new tab appeared" any more, and that change is the POINT: checkpoint
  // 5 proved D7 already opened this exact run on load, so clicking its history
  // row must bring THAT tab forward rather than resume the same conversation
  // into a second one. Two live CLIs `--resume`d onto one transcript interleave
  // their appends and neither sees the other's turns — the bring-forward guard
  // in `openAutomationRunChat` exists precisely to stop this, and reaching the
  // same run from two different routes is the case that exercises it.
  const hitlTabs = page.locator('.agent-tab[data-session-kind="automation"]:visible', { hasText: AUTO_B_TITLE });
  const openedHitlTab = await until(async () => {
    if ((await hitlTabs.count()) !== 1) return false;
    const active = await page.locator('.agent-tab.active:visible').allInnerTexts();
    return active.some((t) => t.includes(AUTO_B_TITLE));
  }, 20000);
  check(
    '3: the asking run is brought forward as ONE tab, never resumed twice',
    openedHitlTab,
    openedHitlTab ? '' : `matching tabs=${await hitlTabs.count()} tabs=${JSON.stringify(await tabTexts())} `
      + `active=${JSON.stringify(await page.locator('.agent-tab.active:visible').allInnerTexts())} `
      + `panelText=${JSON.stringify((await page.locator('.adp-panel').innerText().catch(() => '')).slice(0, 300))} `
      + `refusal=${JSON.stringify(await page.locator('.adp-session-empty').innerText().catch(() => '(none)'))}`,
  );

  const hitlCard = page.locator('.chat-hitlcard');
  const hitlCardShown = await until(async () => (await hitlCard.count()) === 1, 20000);
  check('3: the HITL question renders inline in the message stream', hitlCardShown);
  const questionText = await page.locator('.chat-hitlcard-question').innerText().catch(() => '');
  check('3: …with the run\'s own question text', questionText.includes(HITL_QUESTION_TEXT.slice(0, 20)), questionText);
  check(
    '3: the composer is replaced while the question is open (no way to "just go ahead")',
    await until(async () => (await page.locator('.chat-pane:visible .chat-hitlcard-lock').count()) === 1, 10000),
  );
  check(
    '3: …and there is no live composer to type into instead',
    (await page.locator('.chat-pane:visible .chat-composer, .chat-pane:visible textarea:not(.chat-hitlcard-input)').count()) === 0,
  );
  await page.screenshot({ path: join(SHOTS, `checkpoint3-open-${theme}.png`) });

  // COLLECT, DON'T FAIL FAST: with no card there is nothing to answer — guarded rather than
  // letting an unguarded `.fill()` throw on a missing locator and abort the rest of the run
  // (including the other theme entirely).
  if (hitlCardShown) {
    await page.locator('.chat-hitlcard-input').fill('Go ahead and publish it.');
    await page.locator('.chat-hitlcard-freetext .chat-btn.primary').click();
    check('3: answering resumes the bound session — the card shows a receipt', await until(async () => (await page.locator('.chat-hitlcard-receipt').count()) === 1, 20000));
    check('3: …the composer lock lifts once the question is answered', await until(async () => (await page.locator('.chat-hitlcard-lock').count()) === 0, 10000));
  } else {
    check('3: answering resumes the bound session — the card shows a receipt', false, 'no card to answer — see the root-cause note above');
    check('3: …the composer lock lifts once the question is answered', false, 'no card to answer — see the root-cause note above');
  }
  await page.screenshot({ path: join(SHOTS, `checkpoint3-answered-${theme}.png`) });

  await browser.close();
}

// ─── main ───────────────────────────────────────────────────────────────────────────────

let server = null;
try {
  console.log('· fixture (isolated HOME, real CLI-created manifests, synthesized caches/transcripts, stand-in claude)…');
  setup();
  console.log('\n═══ checkpoint 1b (no browser needed) ═══');
  checkpoint1FlowContract();

  const port = await freePort();
  console.log(`\n· real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of ['dark', 'light']) {
    // The surface mirrors its tab roster to disk — reset between themes so tab-count
    // assertions are never off by whatever the previous theme's pass opened.
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    // Checkpoint 3 ANSWERS the question it drives, consuming it — reseed fresh every pass.
    seedHitlFixtures();
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
