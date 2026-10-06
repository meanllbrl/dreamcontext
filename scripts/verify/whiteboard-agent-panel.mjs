#!/usr/bin/env node
/**
 * The board's agents in a side panel, and their cards as their faces: end-to-end proof in the
 * real dashboard, in real Chromium (round 2, owner 2026-10-06).
 *
 *   npm run build && npm run verify:whiteboard-agent-panel
 *
 * Same isolation as whiteboard-agent.mjs (built dashboard + CLI, fake HOME, a stand-in `claude`
 * on its PATH that records every spawn and turn and answers in stream-json; no network, no
 * tokens). Fictional fixture (Northwind Outfitters): board "Control Panel" is home to Copy Desk
 * and Ops Desk, holds two Copy Desk cards, a Pricing Analyst card (an agent whose home is no
 * board) and a note; board "Growth" is home to Growth Scout.
 *
 *   P1  the corner agent dock and Chat button are hidden on the Whiteboard page.
 *   P2  the Agent toggle opens the panel on the right, pushing the canvas narrower; opening it
 *       spawns ONE session, as Copy Desk on this board, with a composer.
 *   W4  the panel's strip lists EVERY agent on the board by title (home agents and the carded
 *       Pricing Analyst), Copy Desk shown; a tab switches to that agent's own session; an agent
 *       card added from the CLI while the panel is open joins the strip.
 *   W5  no card holds a chat; the cards of the agent the panel shows say so and are outlined;
 *       after a turn they show its last lines read-only; Find its card brings the card into
 *       view and flashes it, then the next one; a click on a card opens the panel on that agent.
 *   W6  a note dragged over a card shows that card as the drop target, and over the panel the
 *       panel; dropped, the note goes back, the panel opens on that agent with the chip in its
 *       composer, a chip flies there and a toast says what happened.
 *   P4  a message typed in the panel reaches the stand-in and its answer shows in the panel.
 *   P5  leaving for Tasks and coming back: same board, panel open, same conversation, no spawn.
 *   P8  switching to the Growth board switches to Growth Scout, continuing the conversation its
 *       card had before the panel; Control Panel's idle sessions end.
 *   P9  no page errors.
 *
 * Once per theme, each on a fresh vault and server. COLLECT-DON'T-FAIL-FAST. Screenshots:
 * tmp/verify-whiteboard-agent-panel/; the dark run is also recorded, cut into one video per item
 * in tmp/videos/round2/ (W4, W5, W6), with a caption bar and a visible cursor.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
const PRICE = { slug: 'pricing-analyst', title: 'Pricing Analyst' };
const VIDEOS = join(REPO, 'tmp', 'videos', 'round2');
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
  for (const [a, board] of [[COPY, BOARD], [OPS, BOARD], [SCOUT, OTHER], [PRICE, null]]) {
    dc(['automations', 'create', a.slug, '--title', a.title, '--mode', 'call', '--no-notify', '--prompt-file', promptFile, ...(board ? ['--whiteboard', board] : [])]);
  }
  const add = (args) => JSON.parse(dc(['whiteboard', 'add', BOARD, ...args, '--json'])).id;
  // Two cards of one home agent (one conversation), an agent at home nowhere with a card here,
  // and a note to drag onto them. Agent cards come in at their own tall box.
  const card = add(['agent', '--ref', COPY.slug, '--at', '0,0']);
  const card2 = add(['agent', '--ref', COPY.slug, '--at', '1600,0']);
  const price = add(['agent', '--ref', PRICE.slug, '--at', '400,0']);
  const note = add(['note', '--text', 'Raise the starter plan to $12', '--title', 'Pricing idea', '--at', '800,0', '--size', 's']);
  // Growth Scout's card on Growth, talked to before the panel existed (P8: its conversation is
  // handed to the panel, never shadowed by a fresh one).
  const scoutCard = JSON.parse(dc(['whiteboard', 'add', OTHER, 'agent', '--ref', SCOUT.slug, '--size', 'm', '--at', '0,0', '--json'])).id;
  writeFileSync(join(p.home, '.local', 'bin', 'claude'), standin(p.calls));
  chmodSync(join(p.home, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(p.home, '.local', 'bin', 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(p.home, '.local', 'bin', 'osascript'), 0o755);
  return { card, card2, price, note, scoutCard };
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

/** The Excalidraw App instance (scene + state + its own methods). */
const APP = `(() => {
  const root = document.querySelector('.wbp-canvas .excalidraw');
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
  for (let f = key ? root[key] : null; f; f = f.return) { const s = f.stateNode; if (s && s.scene && s.state && s.state.zoom) return s; }
  return null;
})()`;
const readScene = (page) => page.evaluate(`(() => { const s = ${APP}; if (!s) return null; const st = s.state;
  return { zoom: st.zoom.value, scrollX: st.scrollX, scrollY: st.scrollY, offsetLeft: st.offsetLeft, offsetTop: st.offsetTop,
    elements: s.scene.getElementsIncludingDeleted().filter((e) => !e.isDeleted).map((e) => ({ id: e.id, x: e.x, y: e.y, width: e.width, height: e.height, kind: e.customData?.dc?.kind, ref: e.customData?.dc?.ref })) }; })()`);
const toClient = (s, x, y) => ({ x: (x + s.scrollX) * s.zoom + s.offsetLeft, y: (y + s.scrollY) * s.zoom + s.offsetTop });
const showElements = (page, list) => page.evaluate(`(() => { const s = ${APP}; const want = new Set(${JSON.stringify(list)});
  const els = s.scene.getNonDeletedElements().filter((e) => want.has(e.id));
  s.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.85, animate: false }); })()`);

/** A caption bar and a visible cursor for the recording: Playwright's video shows neither. */
const OVERLAY = `(() => {
  if (window.top !== window) return;
  const install = () => {
    if (document.getElementById('rec-cap')) return;
    const cap = document.createElement('div');
    cap.id = 'rec-cap';
    cap.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:none;'
      + 'background:rgba(20,18,30,.92);color:#fff;font:600 17px/1.35 system-ui;padding:10px 18px;border-radius:12px;max-width:80vw;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35)';
    document.body.appendChild(cap);
    const dot = document.createElement('div');
    dot.id = 'rec-cursor';
    dot.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;z-index:2147483647;pointer-events:none;'
      + 'background:rgba(124,92,255,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4);transition:transform .08s';
    document.body.appendChild(dot);
    addEventListener('pointermove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
    addEventListener('pointerdown', () => { dot.style.transform = 'scale(.7)'; }, true);
    addEventListener('pointerup', () => { dot.style.transform = ''; }, true);
  };
  if (document.body) install(); else addEventListener('DOMContentLoaded', install);
})()`;

async function runTheme(theme) {
  console.log(`\n═══ ${theme} ═══`);
  const p = paths(theme);
  const ids = setup(p);
  const port = await freePort();
  const server = await startServer(p, port);
  const browser = await chromium.launch();
  const record = theme === 'dark';
  const rawDir = join(p.scratch, 'raw-video');
  /** Where each recorded item starts and ends, in seconds from the recording's start. */
  const segments = [];
  let t0 = 0;
  const begin = (name) => { if (record) segments.push({ name, from: (Date.now() - t0) / 1000, to: null }); };
  const end = () => { const s = segments.at(-1); if (s && s.to === null) s.to = (Date.now() - t0) / 1000; };
  const VIEW = { width: 1600, height: 1000 };
  try {
    const ctx = await browser.newContext({ viewport: VIEW, colorScheme: theme, locale: 'en-US', ...(record ? { recordVideo: { dir: rawDir, size: VIEW } } : {}) });
    t0 = Date.now();
    if (record) await ctx.addInitScript(OVERLAY);
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const shoot = (name) => page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
    const say = (text) => (record ? page.evaluate((t) => { const c = document.getElementById('rec-cap'); if (c) { c.textContent = t; c.style.display = t ? '' : 'none'; } }, text) : Promise.resolve());
    const pause = (ms) => sleep(record ? ms : Math.min(ms, 250));
    const panel = page.locator('.wb-agent-panel');
    const tabs = panel.locator('.wb-agent-tab');
    const tabNames = () => tabs.evaluateAll((ns) => ns.map((n) => (n.getAttribute('aria-label') || '').split(' · ')[0]));
    const shownAgent = () => panel.getAttribute('data-agent').catch(() => null);
    const cardsOf = (slug) => page.locator(`.wb-agent[data-agent="${slug}"]`);
    const nav = async (re) => { await page.locator('.sidebar-item', { hasText: re }).first().click(); await sleep(1200); };
    const openBoard = async (name) => {
      await page.locator('.wbt-all').click();
      await page.locator('.wbs-panel--boards .wbs-row-open', { hasText: name }).click();
      await page.locator('.wbt-tab[aria-selected="true"]', { hasText: name }).waitFor({ timeout: 8000 });
      await sleep(800);
    };
    const canvasWidth = () => page.locator('.wbp-canvas').evaluate((n) => Math.round(n.getBoundingClientRect().width));
    const el = async (id) => (await readScene(page)).elements.find((e) => e.id === id);
    const at = async (id, fx = 0.5, fy = 0.5) => { const s = await readScene(page); const e = s.elements.find((x) => x.id === id); return toClient(s, e.x + e.width * fx, e.y + e.height * fy); };
    const glide = async (from, to, steps = 18) => { await page.mouse.move(from.x, from.y); await page.mouse.move(to.x, to.y, { steps }); };
    const inCanvas = async (id) => {
      const c = await at(id);
      const r = await page.locator('.wbp-canvas').boundingBox();
      return c.x > r.x && c.x < r.x + r.width && c.y > r.y && c.y < r.y + r.height;
    };

    await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'networkidle' });
    await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme);
    if (await until(() => page.locator('.announcements-modal-scrim').count(), 3000)) { await page.keyboard.press('Escape'); await sleep(300); }
    await nav(/Whiteboard(?!s)/);
    await openBoard('Control Panel');
    if (record) await page.evaluate(OVERLAY);
    await showElements(page, [ids.card, ids.price, ids.note]);
    await sleep(600);

    // P1
    check('P1 the corner dock and Chat button are hidden on the Whiteboard page',
      (await page.locator('.agent-fab:visible, .agent-dock:not(.agent-dock--floating):visible').count()) === 0);
    check('P1 …and no session spawned by opening the board', spawnsOf(p).length === 0, `${spawnsOf(p).length}`);

    // ── W4: the panel knows every agent on the board ─────────────────────────────────────────
    begin('W4-panel-tahtadaki-ajanlari-tanir');
    await say('Panel tahtadaki BÜTÜN ajanları tanır: ev ajanları ve tahtada kartı olanlar');
    await pause(1800);
    const wide = await canvasWidth();
    const toggle = await page.locator('.wbp-agent-toggle').boundingBox();
    await glide({ x: toggle.x - 300, y: toggle.y + 200 }, { x: toggle.x + toggle.width / 2, y: toggle.y + toggle.height / 2 });
    await page.locator('.wbp-agent-toggle').click();
    check('P2 the Agent toggle opens the panel', !!await until(() => panel.isVisible(), 5000));
    check('P2 …and pushes the canvas narrower', (await canvasWidth()) < wide - 200, `${wide} -> ${await canvasWidth()}`);
    const names = await until(async () => { const n = await tabNames(); return n.length === 3 ? n : null; }, 8000);
    check('W4 the strip lists every agent on the board by title: both home agents and the carded one',
      JSON.stringify(names) === JSON.stringify([COPY.title, OPS.title, PRICE.title]), JSON.stringify(await tabNames()));
    check('W4 …showing the first, Copy Desk', (await shownAgent()) === COPY.slug, String(await shownAgent()));
    check('W4 …and never says the board has no agent', !/no agent yet/.test(await panel.innerText()));
    const first = await until(() => spawnsOf(p)[0], 15000, 250);
    check('P2 opening it spawns one session, as Copy Desk on this board',
      first?.env?.DREAMCONTEXT_CARD_AGENT === COPY.slug && first?.env?.DREAMCONTEXT_CARD_BOARD === BOARD, JSON.stringify(first?.env ?? {}));
    check('P2 …and the panel has a composer', !!await until(() => panel.locator('.chat-cmp-input').count(), 8000));
    await pause(1200);
    await shoot('strip');

    await say('Şeritte bir ajana tıklayınca panel o ajanın bu tahtadaki konuşmasına geçer');
    const opsTab = tabs.nth(1);
    const ob = await opsTab.boundingBox();
    await glide({ x: ob.x - 200, y: ob.y + 260 }, { x: ob.x + ob.width / 2, y: ob.y + ob.height / 2 });
    await pause(500);
    await opsTab.click();
    const ops = await until(() => spawnsOf(p).find((s) => s.env?.DREAMCONTEXT_CARD_AGENT === OPS.slug), 15000, 250);
    check('W4 a tab switches to that agent\'s own session', !!ops && ops.sessionId !== first?.sessionId && (await shownAgent()) === OPS.slug, JSON.stringify(ops?.sessionId));
    check('W4 …an agent with no card offers no Find its card', (await panel.locator('.wb-agent-locate').count()) === 0);
    await pause(1600);

    await say('Kart CLI ile eklense bile panel onu hemen tanır');
    await pause(800);
    cliFor(p)(['whiteboard', 'add', BOARD, 'agent', '--ref', SCOUT.slug, '--at', '1200,0']);
    const four = await until(async () => { const n = await tabNames(); return n.length === 4 ? n : null; }, 15000, 250);
    check('W4 an agent card added from the CLI while the panel is open joins the strip',
      JSON.stringify(four) === JSON.stringify([COPY.title, SCOUT.title, OPS.title, PRICE.title]), JSON.stringify(await tabNames()));
    await pause(2200);
    await shoot('strip-four');
    end();

    // ── W5: the card is the agent's face ─────────────────────────────────────────────────────
    begin('W5-ajan-karti-kimlik-son-satirlar');
    await say('Kart ajanın yüzü: kim, ne durumda, konuşmanın son satırları. Sohbet panelde.');
    await tabs.nth(0).click();
    check('W5 no card holds a chat (the conversation is in the panel)',
      (await page.locator('.wb-widget[data-widget-kind="agent"] .chat-cmp-input').count()) === 0);
    const marked = await until(async () => (await cardsOf(COPY.slug).evaluateAll((ns) => ns.filter((n) => n.classList.contains('is-in-panel') && /Open in the panel/.test(n.textContent)).length)) === 2, 6000);
    check('W5 both cards of the agent the panel shows say "Open in the panel"', !!marked);
    check('W5 …and only those are marked', (await page.locator('.wb-agent.is-in-panel').count()) === 2);
    const outline = await cardsOf(COPY.slug).first().evaluate((n) => getComputedStyle(n.closest('.wb-widget')).boxShadow);
    check('W5 …outlined', !!outline && outline !== 'none', outline);
    await pause(1500);

    await say('Panelde yazılan mesaj ve cevabı kartta salt okunur son satırlar olarak görünür');
    const input = panel.locator('.chat-cmp-input').first();
    await input.click();
    await input.type(MSG, { delay: record ? 35 : 8 });
    await page.keyboard.press('Enter');
    const turn = await until(() => turnsOf(p).find((t) => t.prompt.includes(MSG)), 30000, 250);
    check('P4 the panel message reaches the stand-in in the Copy Desk session', turn?.sessionId === first?.sessionId, JSON.stringify(turn?.sessionId));
    check('P4 …and the answer shows in the panel', !!await until(async () => /Stand-in answer/.test(await panel.innerText()), 30000, 300));
    const lines = await until(async () => (await cardsOf(COPY.slug).evaluateAll((ns) => ns.filter((n) => {
      const l = n.querySelector('.wb-agent-lines');
      return l && /Stand-in answer/.test(l.textContent) && /Summarise what this board says/.test(l.textContent);
    }).length)) === 2, 10000);
    check('W5 after the turn both Copy Desk cards show its last lines, read-only', !!lines,
      (await cardsOf(COPY.slug).first().innerText().catch(() => '')).slice(0, 300));
    await showElements(page, [ids.card, ids.price]);
    await pause(2500);
    await shoot('card-lines');

    await say('"Kartı bul": panel ajanın kartını tahtada gösterir ve parlatır');
    await page.evaluate(`(() => { const s = ${APP}; s.updateScene({ appState: { scrollX: -6000, scrollY: -4000 } }); })()`);
    await pause(900);
    check('W5 (the Copy Desk card is out of view first)', !(await inCanvas(ids.card)));
    const locate = panel.locator('.wb-agent-locate');
    const lb = await locate.boundingBox();
    await glide({ x: lb.x - 120, y: lb.y + 160 }, { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 });
    await locate.click();
    const found = await until(async () => (await inCanvas(ids.card)) && (await page.locator('.wb-agent.is-flashing').count()) === 1, 4000);
    check('W5 Find its card brings the card into view and flashes it', !!found);
    await pause(1800);
    await locate.click();
    check('W5 …pressed again, the agent\'s next card', !!await until(() => inCanvas(ids.card2), 4000));
    await pause(1800);

    await say('Bir karta tıklayınca panel o ajanda açılır');
    await showElements(page, [ids.card, ids.price, ids.note]);
    await pause(700);
    const pc = await at(ids.price, 0.5, 0.45);
    await glide({ x: pc.x - 260, y: pc.y + 120 }, pc);
    await page.mouse.click(pc.x, pc.y);
    const price = await until(() => spawnsOf(p).find((s) => s.env?.DREAMCONTEXT_CARD_AGENT === PRICE.slug), 15000, 250);
    check('W5 a click on a card opens the panel on that agent, in its own session on this board',
      (await shownAgent()) === PRICE.slug && price?.env?.DREAMCONTEXT_CARD_BOARD === BOARD, `${await shownAgent()} ${JSON.stringify(price?.env ?? {})}`);
    check('W5 …and that card is now the marked one', !!await until(async () => (await cardsOf(PRICE.slug).evaluateAll((ns) => ns.filter((n) => n.classList.contains('is-in-panel')).length)) === 1, 4000));
    await pause(2200);
    await shoot('card-click');
    end();

    // ── W6: dropping on an agent ─────────────────────────────────────────────────────────────
    begin('W6-ajana-birakma');
    await page.keyboard.press('Escape');
    await say('Bir öğeyi ajan kartının üstüne sürükle: kart nereye gideceğini söyler');
    await pause(1200);
    const before = await el(ids.note);
    const grab = await at(ids.note, 0.2, 0.12);
    const onCopy = await at(ids.card, 0.5, 0.5);
    await page.mouse.move(grab.x, grab.y, { steps: 6 });
    await page.mouse.down();
    await page.mouse.move((grab.x + onCopy.x) / 2, grab.y + 40, { steps: record ? 20 : 6 });
    await page.mouse.move(onCopy.x, onCopy.y, { steps: record ? 24 : 6 });
    await sleep(300);
    const hover = await until(async () => {
      const n = cardsOf(COPY.slug).first();
      const t = await n.innerText();
      return (await n.evaluate((x) => x.classList.contains('is-drop-target'))) && /Add to the chat with Copy Desk/.test(t) && /Pricing idea/.test(t);
    }, 3000);
    check('W6 dragging over a card shows it as the drop target, naming the agent and what would land', !!hover);
    await pause(1400);
    await shoot('drop-hover-card');
    await page.mouse.up();
    const flew = await until(() => page.locator('.wb-drop-flight').count(), 1500, 30);
    check('W6 …dropped, a chip flies to the panel', !!flew);
    const back = await until(async () => { const e = await el(ids.note); return e && e.x === before.x && e.y === before.y ? e : null; }, 3000);
    check('W6 …the note goes back where it was', !!back, JSON.stringify(await el(ids.note)));
    check('W6 …the panel opens on that agent', !!await until(async () => (await shownAgent()) === COPY.slug, 4000), String(await shownAgent()));
    const chip = panel.locator('.chat-cmp-attachment', { hasText: 'Pricing idea' });
    check('W6 …with the chip in its composer', !!await until(() => chip.count(), 5000));
    const toast = await until(async () => { const t = await page.locator('.Toast__message').innerText().catch(() => ''); return /added to the chat with Copy Desk/.test(t) ? t : null; }, 4000);
    check('W6 …and a toast says what happened', !!toast, String(toast));
    check('W6 …and no card is left a drop target', (await page.locator('.wb-agent.is-drop-target').count()) === 0);
    await pause(2600);
    await shoot('drop-done');

    await say('Panelin üstüne bırakmak da olur: öğe paneldeki ajanın mesajına eklenir');
    await pause(1000);
    const grab2 = await at(ids.note, 0.2, 0.12);
    const pb = await panel.boundingBox();
    const onPanel = { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 };
    await page.mouse.move(grab2.x, grab2.y, { steps: 6 });
    await page.mouse.down();
    await page.mouse.move(grab2.x + 120, grab2.y + 30, { steps: record ? 16 : 5 });
    await page.mouse.move(onPanel.x, onPanel.y, { steps: record ? 30 : 8 });
    await sleep(300);
    check('W6 dragging over the panel shows the panel as the drop target, and what would land',
      !!await until(async () => (await panel.evaluate((n) => n.classList.contains('is-drop-target'))) && /Add to the chat with Copy Desk/.test(await panel.innerText())
        && (await panel.locator('.wb-agent-drop-what', { hasText: 'Pricing idea' }).count()) === 1, 3000));
    await pause(1400);
    await shoot('drop-hover-panel');
    await page.mouse.up();
    check('W6 …dropped, its chip lands in the panel\'s composer too', !!await until(async () => (await chip.count()) === 2, 5000), String(await chip.count()));
    check('W6 …and the note is back again', !!await until(async () => { const e = await el(ids.note); return e && e.x === before.x && e.y === before.y; }, 3000));
    await pause(2600);
    end();
    await say('');

    // P5
    const spawnsBefore = spawnsOf(p).length;
    await nav(/^Tasks/);
    check('P5 the dock or Chat button is back on another page', (await page.locator('.agent-fab:visible, .agent-dock:visible').count()) > 0);
    await sleep(1500);
    await nav(/Whiteboard(?!s)/);
    check('P5 coming back opens the same board',
      !!await until(async () => (await page.locator('.wbt-tab[aria-selected="true"]').innerText()).includes('Control Panel'), 8000));
    check('P5 …with the panel still open, on the same agent', !!await until(async () => (await panel.isVisible()) && (await shownAgent()) === COPY.slug, 5000));
    check('P5 …the same conversation on screen', !!await until(async () => /Stand-in answer/.test(await panel.innerText()), 8000),
      (await panel.innerText().catch(() => '')).slice(0, 300));
    check('P5 …without a new spawn (the session lived on)', spawnsOf(p).length === spawnsBefore, `${spawnsBefore} -> ${spawnsOf(p).length}`);

    // P8
    const LEGACY = '0b5e7c1a-6d2f-4c1e-9a7b-3f2d1c0e9b8a';
    await page.evaluate(({ card, id }) => {
      // The card key's vault part, as the app writes it (Copy Desk's key on Control Panel).
      const k = Object.keys(localStorage).find((x) => x.startsWith('dc.wbAgentConv.') && x.endsWith('.control-panel.home.copy-desk'));
      const vault = k.slice('dc.wbAgentConv.'.length, -'.control-panel.home.copy-desk'.length);
      localStorage.setItem(`dc.wbAgentConv.${vault}.growth.${card}`, id);
    }, { card: ids.scoutCard, id: LEGACY });
    await openBoard('Growth');
    check('P8 switching boards switches to that board\'s agent',
      !!await until(async () => (await shownAgent()) === SCOUT.slug && (await tabNames()).join() === SCOUT.title, 8000),
      JSON.stringify(await tabNames()));
    const scout = await until(() => spawnsOf(p).find((s) => s.env?.DREAMCONTEXT_CARD_AGENT === SCOUT.slug && s.env?.DREAMCONTEXT_CARD_BOARD === OTHER), 15000, 250);
    check('P8 …in its own session', !!scout);
    check('P8 …which continues the conversation its card had before the panel (never a fresh one)',
      scout?.sessionId === LEGACY, JSON.stringify(scout?.sessionId));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const controlPids = spawnsOf(p).filter((s) => s.env?.DREAMCONTEXT_CARD_BOARD === BOARD).map((s) => s.pid);
    check('P8 …and Control Panel\'s idle sessions end (no claude left running)',
      controlPids.length >= 3 && !!await until(() => controlPids.every((pid) => !alive(pid)), 15000, 300),
      JSON.stringify(controlPids.map((pid) => [pid, alive(pid)])));
    await shoot('switched');

    // P9
    check('P9 no page errors', pageErrors.length === 0, pageErrors.join(' | '));

    const video = record ? page.video() : null;
    await ctx.close();
    if (video) {
      const webm = await video.path();
      mkdirSync(VIDEOS, { recursive: true });
      for (const s of segments) {
        const mp4 = join(VIDEOS, `${s.name}.mp4`);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, s.from - 0.3)), '-to', String((s.to ?? s.from + 30) + 0.5), '-i', webm,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', mp4]);
        console.log(`  video: ${mp4}`);
      }
    }
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
