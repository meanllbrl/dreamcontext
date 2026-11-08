#!/usr/bin/env node
/**
 * The phone's composer follows the scroll, never the keyboard.
 *
 *   npm run build && node scripts/verify/phone-composer-scroll.mjs
 *
 * THE REPORT (owner, 2026-11-01, from the phone): the composer was one row, a tap on it opened the
 * keyboard and made it two, then a tap on Opus closed the keyboard, which folded the composer and
 * took the model picker with it. Effort and mode the same. Owner's rule: at the bottom the
 * composer is open, scrolling up folds it, a tap on the text field goes to the bottom.
 *
 * WHAT IT DRIVES: the real dashboard server (scratch HOME, a scripted `claude` stand-in, no tokens)
 * and Chromium as a phone (390x844, touch, coarse pointer) dressed as Mac mode's phone surface.
 * Scrolls are real touch gestures (CDP synthesizeScrollGesture), so the transcript's own
 * "the user moved up" signal is what runs, not a written scrollTop.
 *
 * CHECKS: open at the bottom with the field unfocused; the reported flow (focus the field, tap the
 * model) leaves the picker on screen; a short scroll does not fold; a long one does, with no
 * flicker while it rests; a tap on the field goes to the bottom and opens it; a draft and an open
 * menu hold it open.
 *
 * `DC_CLI=<dist/index.js>` runs another build. FAILURE POLICY: collect, don't fail fast; exit 0
 * iff every check passed. Screenshots: tmp/verify-phone-composer-scroll/*.png
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawerShown, newChat, submit } from './lib/phone-shell.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-phone-composer-scroll');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-phone-composer-scroll');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\`: one long plain answer. */
const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    const text = Array.from({ length: 80 }, (_, i) => 'Paragraph ' + (i + 1) + ' of a long answer about the invoice export.').join('\\n\\n') + '\\n\\nAll tests pass.';
    out({ type: 'assistant', message: { id: 'msg_' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const report = {
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  mkdirSync(join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the phone composer check']);
  const r = cli(['vaults', 'add', 'proj', PROJ]);
  if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`[server] ${s}`); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const state = (page) => page.evaluate(() => {
  const cmp = [...document.querySelectorAll('.agent-surface[data-mobile] .chat-cmp')].find((e) => e.getBoundingClientRect().height > 0);
  const scroll = [...document.querySelectorAll('.agent-surface[data-mobile] .chat-scroll')].find((e) => e.getBoundingClientRect().height > 0);
  const shown = (s) => { const e = cmp?.querySelector(s); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  return {
    folded: cmp?.hasAttribute('data-folded') ?? null,
    height: Math.round(cmp?.getBoundingClientRect().height ?? 0),
    model: shown('.chat-cmp-model-wrap .chat-cmp-modeltrigger'),
    mode: shown('.chat-cmp-perm-wrap .chat-cmp-modeltrigger'),
    modelMenu: shown('.chat-cmp-modelmenu'),
    fromBottom: scroll ? Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) : null,
  };
});

let server = null;
let browser = null;
try {
  const { chromium, devices } = await import('@playwright/test');
  console.log(`· build: ${CLI}`);
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive' || document.querySelector('meta[name="dreamcontext-surface"]')) return;
      const m = document.createElement('meta'); m.name = 'dreamcontext-surface'; m.content = 'mac'; document.head.appendChild(m);
    });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await until(() => drawerShown(page), 25000);
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
  await newChat(page, 'proj');
  const input = page.locator('.chat-cmp-input:visible').first();
  report.check('"New chat" opens a chat', await until(async () => (await input.count()) > 0, 20000));
  await page.waitForTimeout(800);
  await input.click(); await input.fill('LONG'); await submit(page);
  report.check('the long answer arrived', await until(async () => (await page.locator('.chat-scroll:visible').innerText()).includes('All tests pass'), 30000));
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(1200);

  const cdp = await ctx.newCDPSession(page);
  /** A real touch drag: positive `up` moves the view towards older messages. */
  const swipe = async (up, y = 420) => {
    await cdp.send('Input.synthesizeScrollGesture', { x: 195, y, yDistance: up, gestureSourceType: 'touch', speed: 900, preventFling: true });
    await page.waitForTimeout(350);
  };
  const trigger = page.locator('.chat-cmp-model-wrap .chat-cmp-modeltrigger:visible').first();

  let s = await state(page);
  report.check('at the bottom, unfocused, the composer is open with the model on it', s.folded === false && s.model && s.mode, JSON.stringify(s));
  const openHeight = s.height;
  await page.screenshot({ path: join(SHOTS, '1-bottom-open.png') });

  // The reported flow: into the field, then onto the model, as a finger does it.
  await input.tap();
  await page.waitForTimeout(400);
  await trigger.tap();
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(700);
  s = await state(page);
  report.check('field, then model: the picker is on screen and stays there', s.modelMenu && s.model && s.folded === false, JSON.stringify(s));
  await page.screenshot({ path: join(SHOTS, '2-model-picker.png') });

  // A finger on the transcript closes a menu like a tap anywhere else, so it is the transcript
  // moving by itself that a menu has to survive; that case is below, once the view is off the bottom.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await swipe(-3000);
  s = await state(page);
  report.check('back at the bottom with the menu put away', !s.modelMenu && s.fromBottom <= 48, JSON.stringify(s));

  await swipe(90);
  s = await state(page);
  report.check(`a short scroll leaves it open (${s.fromBottom}px up)`, s.fromBottom > 0 && s.folded === false && s.model, JSON.stringify(s));
  await trigger.tap();
  await page.waitForTimeout(300);
  await page.evaluate(() => { const e = [...document.querySelectorAll('.agent-surface[data-mobile] .chat-scroll')].find((x) => x.getBoundingClientRect().height > 0); e.scrollTop -= 400; });
  await page.waitForTimeout(300);
  s = await state(page);
  report.check(`an open menu holds the composer open while the view moves (${s.fromBottom}px up)`, s.modelMenu && s.folded === false && s.fromBottom >= 160, JSON.stringify(s));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await swipe(-3000);

  await swipe(600);
  s = await state(page);
  report.check(`scrolling up folds it to one row (${openHeight}px to ${s.height}px, ${s.fromBottom}px up)`, s.folded === true && !s.model && s.height < openHeight, JSON.stringify(s));
  const delta = openHeight - s.height;
  report.check(`the height it gives back (${delta}px) stays under the fold distance's margin`, delta <= 96);
  await page.screenshot({ path: join(SHOTS, '3-scrolled-up-folded.png') });
  const samples = await page.evaluate(() => new Promise((done) => {
    const cmp = [...document.querySelectorAll('.agent-surface[data-mobile] .chat-cmp')].find((e) => e.getBoundingClientRect().height > 0);
    const seen = []; let n = 0;
    const tick = () => { seen.push(cmp.hasAttribute('data-folded')); if (++n < 45) requestAnimationFrame(tick); else done(seen); };
    tick();
  }));
  report.check('at rest it does not flicker', new Set(samples).size === 1, samples.join(','));

  // The fold's own hysteresis: creep back down until just past the slack, then up again.
  await swipe(-(s.fromBottom - 80));
  s = await state(page);
  report.check(`still folded just above the bottom (${s.fromBottom}px up)`, s.folded === true, JSON.stringify(s));

  await page.locator('.chat-cmp-input:visible').first().tap();
  await page.waitForTimeout(600);
  s = await state(page);
  report.check('a tap on the field goes to the bottom and opens the composer', s.folded === false && s.model && s.fromBottom <= 48, JSON.stringify(s));
  await page.screenshot({ path: join(SHOTS, '4-field-tap.png') });

  await input.fill('half a thought');
  await page.waitForTimeout(200);
  await swipe(600);
  s = await state(page);
  report.check(`something typed holds it open through a scroll (${s.fromBottom}px up)`, s.fromBottom >= 160 && s.folded === false && s.model, JSON.stringify(s));
} catch (e) {
  report.check(`the run finished: ${e?.message ?? e}`, false);
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
for (const f of report.fails) console.log(`  ✗ ${f}`);
process.exit(report.fails.length ? 1 : 0);
