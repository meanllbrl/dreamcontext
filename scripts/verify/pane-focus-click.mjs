#!/usr/bin/env node
/**
 * "The first click in a background pane is EATEN" — runtime proof of the fix.
 *
 *   npm run build && npm run verify:pane-focus-click
 *
 * THE BUG (owner report 09-13, on the widening that landed in 72eda28): with two chat panes
 * open, clicking a control in the pane that is NOT action-focused did nothing except widen
 * that pane. The click had to be made twice.
 *
 * THE MECHANISM, and why it is a geometry bug rather than a handler bug: the focused pane
 * claims `--pane-focus-bonus` (340px) through `flex-basis`, animated over 240ms. Switching on
 * `mousedown` starts that slide WHILE THE BUTTON IS STILL HELD — by `mouseup`, ~120ms of human
 * press later, the control has travelled ~200px out from under the cursor. The browser then
 * fires `click` on the nearest common ancestor of the mousedown and mouseup targets, which is
 * a container, never the button. The press is spent entirely on the widening.
 *
 * WHAT IS PROVEN HERE, in the real app (real server, real bundle, real Chromium, real mouse):
 *   T1  setup — two chat panes, the LEFT one active (see the note at the press: only the
 *       right pane's contents actually travel when it widens, so that is where the bug lives)
 *   T2  ONE human-paced press (down, 120ms hold, up) on a control in the BACKGROUND pane opens
 *       that control's menu. This is the user-visible claim: the first click counts.
 *   T3  the mechanism — the pressed control does NOT move while the button is held. Sampled
 *       mid-press against its own pre-press position; this is the assertion the old code fails
 *       (it has already slid ~200px by the same sample).
 *   T4  the feature still works — after the release the pressed pane IS the active one and it
 *       has grown by the focus bonus.
 *   T5  the keyboard path is untouched — a focus landing in the other pane with no pointer
 *       involved switches the active pane immediately (nothing to wait for, no click to lose).
 *
 * HONEST LIMIT — T5 drives `.focus()` rather than a real Tab traversal (the chat body is a
 * portaled subtree and Tab order through it is not what this fix touches). It exercises the
 * same `focusin` listener the Tab path raises.
 *
 * SCRATCH HOME, ALWAYS — vault registry, agent-ui.json and the fake `claude` all live in an
 * isolated HOME the server is spawned with. Nothing reads the developer's own ~/.claude*.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is a scripted stand-in that answers nothing; this
 * script only needs the composer chrome to exist, not a turn to run.
 *
 * FAILURE POLICY — collect, don't fail fast. Exit 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-pane-focus-click');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
// Deliberately inert: it speaks enough stream-json to be a live session and never answers.
const STANDIN = `#!${process.execPath}
/** Inert stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/pane-focus-click.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-session' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

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
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
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
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; }
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── the run ──────────────────────────────────────────────────────────────────────────

let server;
let browser;
try {
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;

  browser = await chromium.launch();
  // `reducedMotion: no-preference` on purpose: the 240ms flex-basis slide IS the bug's
  // vehicle, and the stylesheet drops it under `prefers-reduced-motion`.
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 }, colorScheme: 'dark', reducedMotion: 'no-preference',
  });
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-dock-chip', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  const oneChat = await until(async () => (await vis('.chat-cmp-input').count()) > 0, 25000);
  check('precondition: a chat pane is live on the real surface', oneChat);

  // ── T1 — split into two chat panes ───────────────────────────────────────────────
  // ⌘D is the only split affordance besides dragging a tab, and its listener lives on the
  // surface HOST — so the keydown has to originate inside the surface. Click the composer
  // first (it is inside the pane slot) and the chord reaches the handler by bubbling.
  await vis('.chat-cmp-input').first().click();
  await page.keyboard.press('Meta+d');
  await until(async () => (await vis('.agent-pane-slot[data-pane]').count()) >= 2, 20000);
  await page.waitForTimeout(1500);
  const paneIds = await page.$$eval('.agent-pane-slot[data-pane]', (els) => els.map((e) => e.dataset.pane));
  const activeOf = () => page.$$eval('.agent-pane', (els) => {
    const i = els.findIndex((e) => e.classList.contains('active'));
    return { index: i, count: els.length };
  });
  // The press has to land in the RIGHT pane, with the LEFT one active. That is not a
  // detail: a flex row grows a pane from its far edge, so widening the LEFT pane leaves its
  // own left-anchored contents exactly where they were — a press there survives even the
  // broken code. It is the right pane whose left edge travels the whole 340px bonus, and
  // therefore the right pane where the button genuinely slides out from under the finger.
  // (Measured: with the fix reverted, the same press in the LEFT pane drifts 2px and lands.)
  // Focus the left pane WITHOUT the mouse, so the setup cannot itself be the thing under test.
  // Retried: a freshly split pane grabs focus back asynchronously (the homing pass opens and
  // focuses its session a frame later), so a single `.focus()` can be undone under us.
  await until(async () => {
    // blur-then-focus: after the split, DOM focus is still sitting in the LEFT composer while
    // the RIGHT pane is the active one, and re-focusing an already-focused node fires nothing.
    await page.$eval(`.agent-pane-slot[data-pane="${paneIds[0]}"] .chat-cmp-input`,
      (el) => { el.blur(); el.focus(); });
    await page.waitForTimeout(400);
    return (await activeOf()).index === 0;
  }, 8000);
  await page.waitForTimeout(700);
  const a0 = await activeOf();
  check('T1 two chat panes, with the LEFT one active and the right one in the background',
    paneIds.length === 2 && a0.count === 2 && a0.index === 0,
    `panes=${JSON.stringify(paneIds)} active=${a0.index}`);

  // The pane the user is NOT in — the one whose clicks were being eaten.
  const bgIndex = 1;
  const bgPane = paneIds[bgIndex];
  const trigger = page.locator(`.agent-pane-slot[data-pane="${bgPane}"] .chat-cmp-modeltrigger`).first();
  const haveTrigger = await trigger.count();
  check('precondition: the background pane carries a real menu control to press',
    haveTrigger === 1, `found=${haveTrigger}`);

  // ── T2/T3 — one human-paced press: 120ms of hold, like a hand ────────────────────
  const boxBefore = await trigger.boundingBox();
  const x = boxBefore.x + boxBefore.width / 2;
  const y = boxBefore.y + boxBefore.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(80);            // mid-press: the old code is ~200px into its slide
  const boxHeld = await trigger.boundingBox();
  await page.waitForTimeout(40);
  await page.mouse.up();

  const drift = Math.round(Math.abs(boxHeld.x - boxBefore.x));
  check('T3 the pressed control does not move while the button is held',
    drift <= 2, `drift=${drift}px (before x=${Math.round(boxBefore.x)}, mid-press x=${Math.round(boxHeld.x)})`);

  const opened = await until(async () => (await trigger.getAttribute('aria-expanded')) === 'true', 3000);
  const menus = await vis('.chat-cmp-modemenu').count();
  check('T2 ONE press in the background pane opens its menu — the first click counts',
    opened && menus === 1, `aria-expanded=${await trigger.getAttribute('aria-expanded')} menus=${menus}`);

  // ── T4 — and the widening still follows the click ────────────────────────────────
  const widthOf = (pane) => page.$eval(`.agent-pane-slot[data-pane="${pane}"]`,
    (el) => el.getBoundingClientRect().width);
  await page.waitForTimeout(700);           // let the 240ms slide finish
  const a1 = await activeOf();
  const wBg = await widthOf(bgPane);
  const wOther = await widthOf(paneIds[0]);
  check('T4 focus followed the click — the pressed pane is active and wider',
    a1.index === bgIndex && wBg - wOther > 200,
    `active=${a1.index} (was ${a0.index}) widths=${Math.round(wBg)}/${Math.round(wOther)}`);

  // ── T5 — the keyboard path still switches immediately ────────────────────────────
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const otherPane = paneIds[0];
  await page.$eval(`.agent-pane-slot[data-pane="${otherPane}"] .chat-cmp-input`,
    (el) => { el.blur(); el.focus(); });
  const switched = await until(async () => (await activeOf()).index === 0, 2000);
  const a2 = await activeOf();
  check('T5 a focus landing in the other pane switches it with no click to wait for',
    switched, `active=${a2.index} (expected 0)`);

  if (process.env.SHOT) {
    await page.screenshot({ path: process.env.SHOT });
    console.log(`      shot: ${process.env.SHOT}`);
  }
} catch (err) {
  check('the run completed', false, String(err?.stack || err).slice(0, 600));
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
