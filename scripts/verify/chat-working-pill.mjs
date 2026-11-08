#!/usr/bin/env node
/**
 * The plain Chat's "Working… 42s" pill keeps its slot for the whole turn, so the pinned
 * transcript does not jump on every tool step (owner-forwarded user report, 2026-11-08).
 *
 *   npm run build && node scripts/verify/chat-working-pill.mjs
 *
 * The report: a silent screen recording of a dark-theme Chat mid-turn. Each time a step
 * started, the pill under the group vanished and a live row took its place; each time it
 * landed, the pill came back. The two are not the same height, and a view pinned to the
 * bottom moved the whole history up and down under the reader's cursor every step.
 *
 * WHAT IT DRIVES: the real dashboard server, the real `/ws/agent-chat` route and the real
 * React surface in Chromium, with `claude` replaced by a scripted stand-in in a fake HOME
 * (see chat-toolrows.mjs). A requestAnimationFrame sampler records, every frame of the turn,
 * whether the pill is drawn and the transcript's content height.
 *
 * PASS: the pill is drawn on every sampled frame from the first step to the answer, and the
 * content height never shrinks while the turn runs (it may only grow).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-working-pill');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

// A turn shaped like the report: a run of Reads, a slow command, one more Read, a long quiet
// gap (the model thinking), then the answer.
const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0, buf = '', started = false;
const ROOT = '/Users/verify/projects/acme/audit';
const STEPS = [
  // Enough rows that the transcript is taller than the pane: only a view pinned to the bottom jumps.
  ...Array.from({ length: 18 }, (_, i) => 'shot-' + (i + 1) + (i % 2 ? '-390.png' : '-1440.png'))
    .map((f) => ({ name: 'Read', input: { file_path: ROOT + '/' + f }, result: 'img', ms: 350 })),
  { name: 'Bash', input: { command: 'sleep 1', description: 'Wait for the studio' }, result: 'ok', ms: 1600 },
  { name: 'Read', input: { file_path: ROOT + '/tokens.css' }, result: 'x\\ny', ms: 600 },
];
async function call(step) {
  const id = 'toolu_' + (++seq);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: step.name, input: step.input }] } });
  await sleep(step.ms);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: step.result }] }] } });
  await sleep(700);
}
async function runTurn() {
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
  for (const s of STEPS) await call(s);
  await sleep(2500);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ANSWER-DONE' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
}
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type === 'user' && !started) { started = true; runTurn(); }
  }
});
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

async function run(chromium, base, report) {
  const theme = 'dark';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 640 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(100); }
    return false;
  };
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);

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
  ok('a chat session opens', await until(async () => (await vis('.chat-cmp-input').count()) > 0));
  await page.waitForTimeout(800);

  // Sample every animation frame from the moment the message is sent.
  await page.evaluate(() => {
    const w = window;
    w.__samples = [];
    const tick = () => {
      const inner = [...document.querySelectorAll('.chat-scroll-inner')].find((e) => e.getBoundingClientRect().height > 0);
      if (inner) {
        w.__samples.push({
          t: performance.now(),
          // The content's own extent (the inner box may be stretched to fill the pane), and
          // where the group's header sits on screen: the thing the reader sees jump.
          h: (() => { const kids = [...inner.children].filter((k) => k.getBoundingClientRect().height > 0);
            return kids.length ? Math.round(kids[kids.length - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top) : 0; })(),
          top: (() => { const g = inner.querySelector('.chat-toolrun'); return g ? Math.round(g.getBoundingClientRect().top) : null; })(),
          overflow: (() => { const sc = inner.parentElement; return sc ? sc.scrollHeight > sc.clientHeight + 4 : false; })(),
          pill: !!inner.querySelector('.chat-working'),
          live: !!inner.querySelector('.chat-toolcard[data-status="running"], .chat-toolrun [data-live]'),
          rows: inner.querySelectorAll('.chat-toolcard').length,
          busy: !!document.querySelector('.chat-cmp-stop'),
          answered: (inner.textContent || '').includes('ANSWER-DONE'),
        });
      }
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('GO');
  await page.keyboard.press('Enter');

  const shot = process.env.VERIFY_SHOTS;
  // A frame while the slow command runs, and one in the quiet gap before the answer.
  ok('the group shows the slow command running',
    await until(async () => (await vis('.chat-scroll-inner').innerText()).includes('Wait for the studio'), 20000));
  await page.waitForTimeout(500);
  if (shot) await page.screenshot({ path: `${shot}/running-step-${theme}.png` });
  ok('the last step lands', await until(async () => (await vis('.chat-scroll-inner').innerText()).includes('tokens.css'), 20000));
  await page.waitForTimeout(1600);
  if (shot) await page.screenshot({ path: `${shot}/quiet-gap-${theme}.png` });
  ok('the turn answers', await until(async () => (await vis('.chat-scroll-inner').innerText()).includes('ANSWER-DONE'), 20000));
  await page.waitForTimeout(300);
  const samples = await page.evaluate(() => { window.__stop = true; return window.__samples; });

  // The turn's working stretch: first frame with a tool row up to the frame before the answer.
  const first = samples.findIndex((s) => s.rows > 0);
  const last = samples.findIndex((s) => s.answered);
  const mid = first >= 0 && last > first ? samples.slice(first, last) : [];
  ok('the sampler saw the whole turn', mid.length > 60, `${mid.length} frames`);
  const missing = mid.filter((s) => !s.pill).length;
  ok('the Working pill is drawn on EVERY frame of the turn, live step or gap',
    mid.length > 0 && missing === 0, `${missing} of ${mid.length} frames had no pill`);
  const drops = [];
  for (let i = 1; i < mid.length; i++) {
    const d = mid[i].h - mid[i - 1].h;
    if (d < -1) drops.push({ at: Math.round(mid[i].t - mid[0].t), by: d, rows: mid[i].rows });
  }
  ok('the transcript never shrinks while the turn runs, so the pinned history never jumps back',
    drops.length === 0, JSON.stringify(drops.slice(0, 8)));
  // Once the transcript overflows and is pinned, the header may only move UP as rows arrive.
  const pinned = mid.filter((s) => s.overflow && s.top !== null);
  ok('the transcript really overflowed the pane (so it was pinned to the bottom)', pinned.length > 30, `${pinned.length} pinned frames`);
  const downs = [];
  for (let i = 1; i < pinned.length; i++) {
    const d = pinned[i].top - pinned[i - 1].top;
    if (d > 1) downs.push({ at: Math.round(pinned[i].t - mid[0].t), by: d, rows: pinned[i].rows });
  }
  ok('the group never jumps DOWN under the reader while the turn runs', downs.length === 0, JSON.stringify(downs.slice(0, 8)));
  report.note(`header moved down ${downs.length} time(s) over ${pinned.length} pinned frames`);
  const heights = mid.map((s) => s.h);
  report.note(`content height over the turn: ${heights[0]} → ${heights[heights.length - 1]}px, ${drops.length} shrink(s)`);
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
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  await run(chromium, `http://127.0.0.1:${port}`, report);
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
