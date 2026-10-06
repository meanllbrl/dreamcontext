#!/usr/bin/env node
/**
 * The board's agent in a side panel: end-to-end proof in the real dashboard, in real Chromium.
 *
 *   npm run build && npm run verify:whiteboard-agent-panel
 *
 * Same isolation as whiteboard-agent.mjs (built dashboard + CLI, fake HOME, a stand-in `claude`
 * on its PATH that records every spawn and turn and answers in stream-json; no network, no
 * tokens). Fictional fixture (Northwind Outfitters): board "Control Panel" is home to two
 * agents, Copy Desk and Ops Desk, and holds a Copy Desk card at M; board "Growth" is home to
 * Growth Scout.
 *
 *   P1  the corner agent dock and Chat button are hidden on the Whiteboard page.
 *   P2  the bar's Agent toggle opens the panel on the right; it pushes the canvas narrower; it
 *       shows the board's first home agent by title (Copy Desk) and a picker of both; opening
 *       it spawns ONE session, as that card's agent on this board.
 *   P3  while the panel shows Copy Desk, its card says so and offers Show it here.
 *   P4  a message typed in the panel reaches the stand-in and its answer shows in the panel.
 *   P5  leaving for Tasks (the dock is back there) and coming back: the same board, the panel
 *       still open, the same conversation on screen, and no new spawn (the session lived on).
 *   P6  picking Ops Desk spawns Ops Desk's own session (never Copy Desk's); the Copy Desk card
 *       steps back in with the SAME conversation (its answer, no new spawn).
 *   P7  Show it here closes the panel.
 *   P8  with the panel open, switching to the Growth board switches to Growth Scout, and
 *       Control Panel's idle home sessions end (their stand-in processes exit).
 *   P9  no page errors. P8 also: the panel continues the conversation the agent's card had
 *       before the panel (opened before the card mounts, never a fresh one).
 *   P10 two cards of one home agent: exactly one shows the conversation, the other says it is in
 *       its other card, also after both remount at once (back from Tasks); no new spawn.
 *
 * Once per theme, each on a fresh vault and server. COLLECT-DON'T-FAIL-FAST.
 * Screenshots: tmp/verify-whiteboard-agent-panel/.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SHOTS = join(REPO, 'tmp', 'verify-whiteboard-agent-panel');
const SCRATCH_ROOT = join(tmpdir(), 'dc-ui-whiteboard-agent-panel');

const BOARD = 'control-panel';
const OTHER = 'growth';
const COPY = { slug: 'copy-desk', title: 'Copy Desk' };
const OPS = { slug: 'ops-desk', title: 'Ops Desk' };
const SCOUT = { slug: 'growth-scout', title: 'Growth Scout' };
const MSG = 'Summarise what this board says about pricing.';

const report = { pass: 0, fail: 0 };
const check = (label, ok, ev = '') => {
  if (ok) { report.pass += 1; console.log(`  ✓ ${label}`); }
  else { report.fail += 1; console.log(`  ✗ ${label}${ev ? `\n      ${String(ev).slice(0, 600)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    await sleep(step);
  }
  return v;
}

/** The stand-in `claude`. As a chat (stream-json) it records its spawn, then each turn with
 *  what the project's real UserPromptSubmit hook added, and answers in stream-json. As a run
 *  it records the call and answers like `-p --output-format json`. */
function standin(callsDir) {
  return [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    "const { spawnSync } = require('node:child_process');",
    'const argv = process.argv.slice(2);',
    "if (argv.includes('--version')) { process.stdout.write('2.1.285 (Claude Code)\\n'); process.exit(0); }",
    'const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };',
    'const env = {};',
    "for (const [k, v] of Object.entries(process.env)) if (k.startsWith('DREAMCONTEXT_')) env[k] = v;",
    `const dir = ${JSON.stringify(callsDir)};`,
    'fs.mkdirSync(dir, { recursive: true });',
    "const record = (o) => fs.writeFileSync(path.join(dir, `${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 6)}.json`), JSON.stringify(o));",
    "if (flag('--input-format') === 'stream-json') {",
    "  const sessionId = flag('--resume') || flag('--session-id') || crypto.randomUUID();",
    "  let briefing = null;",
    "  try { briefing = fs.readFileSync(flag('--append-system-prompt-file'), 'utf-8'); } catch { /* none */ }",
    "  const base = { pid: process.pid, argv, env, briefing, sessionId, cwd: process.cwd() };",
    "  record({ kind: 'spawn', ...base });",
    "  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "  let turn = 0;",
    "  let buf = '';",
    "  process.stdin.on('data', (c) => {",
    "    buf += c.toString('utf-8');",
    "    let nl;",
    "    while ((nl = buf.indexOf('\\n')) !== -1) {",
    "      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);",
    "      if (!line) continue;",
    "      let o; try { o = JSON.parse(line); } catch { continue; }",
    "      if (o.type !== 'user') continue;",
    "      const content = (o.message && o.message.content) || [];",
    "      const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');",
    "      turn += 1;",
    `      const hook = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'hook', 'user-prompt-submit'], {`,
    "        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: sessionId, cwd: process.cwd() }),",
    "        encoding: 'utf-8', cwd: process.cwd(), env: process.env,",
    "      });",
    "      record({ kind: 'turn', turn, prompt: text, hookOut: hook.stdout || '', hookErr: hook.stderr || '', ...base });",
    "      if (turn === 1) out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-5-5', cwd: process.cwd(), permissionMode: flag('--permission-mode'), slash_commands: [] });",
    "      const answer = turn === 1 ? 'Stand-in answer: the board is in order.' : 'Stand-in reply: noted.';",
    "      out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });",
    "      out({ type: 'result', subtype: 'success', is_error: false, result: answer, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sessionId });",
    "    }",
    "  });",
    "  process.stdin.on('end', () => process.exit(0));",
    "} else {",
    "  const r = argv.indexOf('--resume');",
    '  const sessionId = r >= 0 ? argv[r + 1] : crypto.randomUUID();',
    "  record({ kind: 'run', argv, env, prompt: flag('-p'), sessionId, cwd: process.cwd() });",
    "  const result = r >= 0 ? 'Stand-in reply: noted.' : 'Stand-in answer: the board is in order.';",
    "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: sessionId, num_turns: 1, total_cost_usd: 0, usage: {} }) + '\\n');",
    "}",
    '',
  ].join('\n');
}

function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDE') || k.startsWith('DREAMCONTEXT_')) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function paths(theme) {
  const scratch = join(SCRATCH_ROOT, theme);
  return { scratch, home: join(scratch, 'home'), proj: join(scratch, 'proj'), calls: join(scratch, 'calls') };
}

function cliFor(p) {
  return (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: p.proj, env: cleanEnv({ HOME: p.home }), encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`dreamcontext ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
}

function setup(p) {
  rmSync(p.scratch, { recursive: true, force: true });
  mkdirSync(join(p.home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(p.home, '.dreamcontext'), { recursive: true });
  mkdirSync(join(p.proj, '_dream_context', 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: p.proj });
  const dc = cliFor(p);
  dc(['vaults', 'add', 'proj', p.proj]);
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }
  dc(['whiteboard', 'create', 'Control Panel']);
  dc(['whiteboard', 'create', 'Growth']);
  const promptFile = join(p.scratch, 'prompt.md');
  writeFileSync(promptFile, 'Write short, plain product copy for Northwind Outfitters when asked.\n');
  for (const [a, board] of [[COPY, BOARD], [OPS, BOARD], [SCOUT, OTHER]]) {
    dc(['automations', 'create', a.slug, '--title', a.title, '--mode', 'call', '--no-notify', '--prompt-file', promptFile, '--whiteboard', board]);
  }
  const card = JSON.parse(dc(['whiteboard', 'add', BOARD, 'agent', '--ref', COPY.slug, '--size', 'm', '--at', '0,0', '--json'])).id;
  // A second card of the same home agent (P10): one conversation, drawn on one card only.
  dc(['whiteboard', 'add', BOARD, 'agent', '--ref', COPY.slug, '--size', 'm', '--at', '700,0', '--json']);
  // Growth Scout's card on Growth, talked to before the panel existed (P8: its conversation is
  // handed to the panel, never shadowed by a fresh one).
  const scoutCard = JSON.parse(dc(['whiteboard', 'add', OTHER, 'agent', '--ref', SCOUT.slug, '--size', 'm', '--at', '0,0', '--json'])).id;
  writeFileSync(join(p.home, '.local', 'bin', 'claude'), standin(p.calls));
  chmodSync(join(p.home, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(p.home, '.local', 'bin', 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(p.home, '.local', 'bin', 'osascript'), 0o755);
  return { card, scoutCard };
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(p, port) {
  const PATH = [join(p.home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: p.proj, env: cleanEnv({ HOME: p.home, PATH, DREAMCONTEXT_DESKTOP: '1' }), stdio: 'ignore',
  });
  const up = await until(async () => (await fetch(`http://127.0.0.1:${port}/api/whiteboards`)).ok, 30000, 250);
  if (!up) { srv.kill(); throw new Error('server did not come up'); }
  return srv;
}

function readCalls(p) {
  if (!existsSync(p.calls)) return [];
  return readdirSync(p.calls).filter((n) => n.endsWith('.json')).sort()
    .map((n) => { try { return JSON.parse(readFileSync(join(p.calls, n), 'utf-8')); } catch { return null; } })
    .filter(Boolean);
}
/** Chat sessions spawned (the stand-in's stream-json starts), oldest first. */
const spawnsOf = (p) => readCalls(p).filter((c) => c.kind === 'spawn');
const turnsOf = (p) => readCalls(p).filter((c) => c.kind === 'turn');

async function runTheme(theme) {
  console.log(`\n═══ ${theme} ═══`);
  const p = paths(theme);
  const { scoutCard } = setup(p);
  const port = await freePort();
  const server = await startServer(p, port);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: theme, locale: 'en-US' });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const shoot = (name) => page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
    const panel = page.locator('.wb-agent-panel');
    const card = page.locator('.wb-widget[data-widget-kind="agent"]').first();
    const nav = async (re) => { await page.locator('.sidebar-item', { hasText: re }).first().click(); await sleep(1200); };
    const openBoard = async (name) => {
      await page.locator('.wbt-all').click();
      await page.locator('.wbs-panel--boards .wbs-row-open', { hasText: name }).click();
      await page.locator('.wbt-tab[aria-selected="true"]', { hasText: name }).waitFor({ timeout: 8000 });
      await sleep(800);
    };
    const canvasWidth = () => page.locator('.wbp-canvas').evaluate((n) => Math.round(n.getBoundingClientRect().width));

    await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'networkidle' });
    await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme);
    if (await until(() => page.locator('.announcements-modal-scrim').count(), 3000)) { await page.keyboard.press('Escape'); await sleep(300); }
    await nav(/Whiteboard(?!s)/);
    await openBoard('Control Panel');

    // P1
    check('P1 the corner dock and Chat button are hidden on the Whiteboard page',
      (await page.locator('.agent-fab:visible, .agent-dock:not(.agent-dock--floating):visible').count()) === 0);
    check('P1 …and no session spawned by opening the board', spawnsOf(p).length === 0, `${spawnsOf(p).length}`);

    // P2
    const wide = await canvasWidth();
    await page.locator('.wbp-agent-toggle').click();
    check('P2 the Agent toggle opens the panel', !!await until(() => panel.isVisible(), 5000));
    check('P2 …and pushes the canvas narrower', (await canvasWidth()) < wide - 200, `${wide} -> ${await canvasWidth()}`);
    const pick = panel.locator('.wb-agent-panel-pick');
    check('P2 …with a picker of both home agents', JSON.stringify(await pick.locator('option').allInnerTexts()) === JSON.stringify([COPY.title, OPS.title]),
      JSON.stringify(await pick.locator('option').allInnerTexts().catch(() => [])));
    check('P2 …showing the first by title, Copy Desk', (await pick.inputValue().catch(() => '')) === COPY.slug);
    const first = await until(() => spawnsOf(p)[0], 15000, 250);
    check('P2 opening it spawns one session, as Copy Desk on this board',
      first?.env?.DREAMCONTEXT_CARD_AGENT === COPY.slug && first?.env?.DREAMCONTEXT_CARD_BOARD === BOARD, JSON.stringify(first?.env ?? {}));
    check('P2 …and the panel has a composer', !!await until(() => panel.locator('.chat-cmp-input').count(), 8000));

    // P3
    check('P3 the Copy Desk card says it is talking in the panel',
      !!await until(async () => /in the panel/.test(await card.innerText()), 5000), (await card.innerText().catch(() => '')).slice(0, 200));
    check('P3 …and offers Show it here', await card.getByRole('button', { name: 'Show it here' }).count() === 1);

    // P4
    const input = panel.locator('.chat-cmp-input').first();
    await input.click();
    await input.type(MSG, { delay: 8 });
    await page.keyboard.press('Enter');
    const turn = await until(() => turnsOf(p).find((t) => t.prompt.includes(MSG)), 30000, 250);
    check('P4 the panel message reaches the stand-in in the Copy Desk session', turn?.sessionId === first?.sessionId, JSON.stringify(turn?.sessionId));
    check('P4 …and the answer shows in the panel', !!await until(async () => /Stand-in answer/.test(await panel.innerText()), 30000, 300));
    await shoot('panel');

    // P5
    const spawnsBefore = spawnsOf(p).length;
    await nav(/^Tasks/);
    check('P5 the dock or Chat button is back on another page', (await page.locator('.agent-fab:visible, .agent-dock:visible').count()) > 0);
    await sleep(1500);
    await nav(/Whiteboard(?!s)/);
    check('P5 coming back opens the same board',
      !!await until(async () => (await page.locator('.wbt-tab[aria-selected="true"]').innerText()).includes('Control Panel'), 8000));
    check('P5 …with the panel still open', !!await until(() => panel.isVisible(), 5000));
    check('P5 …and the same conversation on screen', !!await until(async () => /Stand-in answer/.test(await panel.innerText()), 8000),
      (await panel.innerText().catch(() => '')).slice(0, 300));
    check('P5 …without a new spawn (the session lived on)', spawnsOf(p).length === spawnsBefore, `${spawnsBefore} -> ${spawnsOf(p).length}`);

    // P6
    await pick.selectOption(OPS.slug);
    const ops = await until(() => spawnsOf(p).find((s) => s.env?.DREAMCONTEXT_CARD_AGENT === OPS.slug), 15000, 250);
    check('P6 picking Ops Desk spawns Ops Desk\'s own session', !!ops && ops.sessionId !== first?.sessionId, JSON.stringify(ops?.sessionId));
    check('P6 …the panel no longer shows Copy Desk\'s conversation',
      !!await until(async () => !/Stand-in answer/.test(await panel.innerText()), 8000));
    const afterOps = spawnsOf(p).length;
    check('P6 the Copy Desk card steps back in with the same conversation',
      !!await until(async () => /Stand-in answer/.test(await card.innerText()), 8000), (await card.innerText().catch(() => '')).slice(0, 300));
    check('P6 …without a new spawn', spawnsOf(p).length === afterOps, `${afterOps} -> ${spawnsOf(p).length}`);

    // P7
    await pick.selectOption(COPY.slug);
    // A card's buttons take clicks once the card is active (one click on it, as for any card).
    await until(async () => /in the panel/.test(await card.innerText()), 5000);
    const box = await card.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 12);
    await card.getByRole('button', { name: 'Show it here' }).click({ timeout: 8000 });
    check('P7 Show it here closes the panel', !!await until(async () => !(await panel.isVisible()), 5000));
    check('P7 …and the card shows the conversation', !!await until(async () => /Stand-in answer/.test(await card.innerText()), 8000));

    // P10: both Copy Desk cards mount in one commit with the session alive (back from Tasks).
    const cards = page.locator('.wb-widget[data-widget-kind="agent"]');
    const cardTexts = async () => Promise.all((await cards.all()).map((c) => c.innerText().catch(() => '')));
    const oneEach = async () => {
      const t = await cardTexts();
      return t.filter((x) => /Stand-in answer/.test(x)).length === 1 && t.filter((x) => /its other card/.test(x)).length === 1;
    };
    check('P10 two cards of one home agent: one shows the chat, the other says where it is',
      !!await until(oneEach, 8000), JSON.stringify((await cardTexts()).map((x) => x.slice(0, 80))));
    const beforeTrip = spawnsOf(p).length;
    await nav(/^Tasks/);
    await nav(/Whiteboard(?!s)/);
    check('P10 …still so after both remount at once (never two blanks)',
      !!await until(oneEach, 8000), JSON.stringify((await cardTexts()).map((x) => x.slice(0, 80))));
    check('P10 …and the shown chat has its composer', (await page.locator('.wb-widget[data-widget-kind="agent"] .chat-cmp-input').count()) === 1);
    check('P10 …with no new spawn', spawnsOf(p).length === beforeTrip, `${beforeTrip} -> ${spawnsOf(p).length}`);
    await shoot('two-cards');

    // P8
    const LEGACY = '0b5e7c1a-6d2f-4c1e-9a7b-3f2d1c0e9b8a';
    await page.evaluate(({ card, id }) => {
      // The card key's vault part, as the app writes it (Copy Desk's home key on Control Panel).
      const k = Object.keys(localStorage).find((x) => x.startsWith('dc.wbAgentConv.') && x.endsWith('.control-panel.home.copy-desk'));
      const vault = k.slice('dc.wbAgentConv.'.length, -'.control-panel.home.copy-desk'.length);
      localStorage.setItem(`dc.wbAgentConv.${vault}.growth.${card}`, id);
    }, { card: scoutCard, id: LEGACY });
    await page.locator('.wbp-agent-toggle').click();
    await until(() => panel.isVisible(), 5000);
    await openBoard('Growth');
    check('P8 switching boards switches to that board\'s agent',
      !!await until(async () => (await panel.locator('.wb-agent-panel-title').innerText()) === SCOUT.title, 8000),
      await panel.locator('.wb-agent-panel-head').innerText().catch(() => ''));
    const scout = await until(() => spawnsOf(p).find((s) => s.env?.DREAMCONTEXT_CARD_AGENT === SCOUT.slug), 15000, 250);
    check('P8 …in its own session', !!scout);
    check('P8 …which continues the conversation its card had before the panel (never a fresh one)',
      scout?.sessionId === LEGACY, JSON.stringify(scout?.sessionId));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const controlPids = spawnsOf(p).filter((s) => s.env?.DREAMCONTEXT_CARD_BOARD === BOARD).map((s) => s.pid);
    check('P8 …and Control Panel\'s idle home sessions end (no claude left running)',
      controlPids.length >= 2 && !!await until(() => controlPids.every((pid) => !alive(pid)), 15000, 300),
      JSON.stringify(controlPids.map((pid) => [pid, alive(pid)])));
    await shoot('switched');

    // P9
    check('P9 no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
}

for (const theme of ['light', 'dark']) {
  try { await runTheme(theme); } catch (e) { check(`${theme}: the run finished`, false, e.stack ?? String(e)); }
}
console.log(`\n${report.pass} passed, ${report.fail} failed`);
process.exit(report.fail ? 1 : 0);
