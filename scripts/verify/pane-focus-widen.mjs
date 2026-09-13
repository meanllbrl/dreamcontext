#!/usr/bin/env node
/**
 * "The pane I click widens with a KÜT, not a slide" — runtime proof of the fix.
 *
 *   npm run build && npm run verify:pane-widen
 *
 * THE BUG (owner report 09-14, screen recording): clicking another session's pane snapped
 * the split to its new geometry in ONE frame. Measured off the recording first — the focused
 * pane's accent band jumped [4,1876] → [1200,3116] between two 60fps samples, three times in
 * the clip, with no intermediate width.
 *
 * TWO CAUSES, both of which had to go, and neither of which shows up in review:
 *   1. `.agent-pane` was `flex: 1 1 auto`. A transition from the `auto` KEYWORD to a length
 *      is not interpolable, so the row jumps however the transition is written.
 *   2. `transition: flex-basis var(--transition-normal, 240ms) ease` — the token already
 *      carries its easing (`240ms ease`), so the shorthand expanded to `flex-basis 240ms
 *      ease ease`, which is INVALID and dropped whole. Computed `transition-property` read
 *      back as `all 0s`: the stylesheet said 240ms and the browser had no transition at all.
 *
 * WHAT IS PROVEN HERE, in the real app (real server, real bundle, real Chromium, real mouse):
 *   T1  setup — two chat panes, the LEFT one active
 *   T2  a real click in the background pane widens it across MANY animation frames, sampled
 *       per rAF from inside the page. One distinct width = the bug; the fix produces ~29.
 *       The computed `transition` is printed alongside, because cause 2 is invisible in the
 *       source and only the computed value tells the truth.
 *
 * SCRATCH HOME, ALWAYS — vault registry, agent-ui.json and the fake `claude` all live in an
 * isolated HOME the server is spawned with. Nothing reads the developer's own ~/.claude*.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is a scripted stand-in that answers nothing.
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
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-pane-widen');
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
/** Inert stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/pane-focus-widen.mjs. */
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

  // ── THE MEASUREMENT — does the widening ANIMATE, or land in one frame? ───────────
  // Sampled per animation frame from inside the page, on a real mouse click in the
  // background pane. An eased slide produces many distinct widths over ~240ms; a snap
  // produces one. This is the assertion the owner's screen recording failed.
  const box = await trigger.boundingBox();
  // The computed transition is the evidence for cause 2 — read it off the live element.
  await page.evaluate(() => {
    window.__evts = [];
    for (const el of document.querySelectorAll('.agent-pane')) {
      for (const t of ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) {
        el.addEventListener(t, (e) => {
          if (e.target !== el) return;
          window.__evts.push([t, e.propertyName, Math.round(performance.now())]);
        });
      }
    }
    window.__before = [...document.querySelectorAll('.agent-pane')].map((el) => {
      const cs = getComputedStyle(el);
      return { cls: el.className, basis: cs.flexBasis, grow: cs.flexGrow, tr: cs.transitionProperty + ' ' + cs.transitionDuration };
    });
  });
  const samplePromise = page.evaluate(async (pane) => {
    const el = document.querySelector(`.agent-pane-slot[data-pane="${pane}"]`);
    const out = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        out.push([Math.round(performance.now() - t0), Math.round(el.getBoundingClientRect().width)]);
        if (performance.now() - t0 < 600) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    return out;
  }, bgPane);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const samples = await samplePromise;
  const widths = [...new Set(samples.map((s) => s[1]))];
  const first = samples[0][1];
  const last = samples[samples.length - 1][1];
  const diag = await page.evaluate(() => ({
    evts: window.__evts,
    before: window.__before,
    after: [...document.querySelectorAll('.agent-pane')].map((el) => {
      const cs = getComputedStyle(el);
      return { cls: el.className, basis: cs.flexBasis, grow: cs.flexGrow, tr: cs.transitionProperty + ' ' + cs.transitionDuration };
    }),
  }));

  check('T2 the focused pane WIDENS over many frames rather than in one',
    widths.length > 5 && Math.abs(last - first) > 100,
    `distinct=${widths.length} ${first}px → ${last}px · computed=${diag.after.map((d) => d.tr).join(' | ')} · trace=${JSON.stringify(samples.filter((_, i) => i % 3 === 0).slice(0, 10))}`);

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
