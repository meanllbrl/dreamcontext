#!/usr/bin/env node
/**
 * "Side-by-side chats: clicking a pane must not grow it" — runtime proof.
 *
 *   npm run build && npm run verify:pane-focus-width        (SHOTS=<dir> to keep screenshots)
 *
 * Owner (0.40.0): with two or three chats side by side, every click grew the clicked pane.
 * Since 0.40.1 panes tile equally and focus only marks the pane (ring + top bar); the focused
 * pane takes width ONLY when its equal share is under `--pane-read-min` (280px), and then
 * only up to it (AgentTerminal.css, `.agent-panes.split > .agent-pane.active`).
 *
 *   W1  2 and 3 panes at 1440 and 1920: clicking each pane in turn moves focus to it, and
 *       every pane's width is identical before and after the click.
 *   W2  3 panes at 1024 (equal share under 280px): the clicked pane grows to the floor
 *       (280px, or less if the others would drop under `--pane-min`), the others share the rest.
 *
 * Real server, real bundle, real Chromium, real mouse, scratch HOME; an inert `claude`
 * stand-in (no tokens). Exit 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-pane-focus-width');
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
/** Inert stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/pane-focus-width.mjs. */
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

const SHOTS = process.env.SHOTS ? resolvePath(process.env.SHOTS) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let server;
let browser;
try {
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();

  async function openPanes(width, n) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: 'dark' });
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
    await until(async () => (await vis('.chat-cmp-input').count()) > 0, 25000);
    for (let k = 2; k <= n; k++) {
      await vis('.chat-cmp-input').last().click();
      await page.keyboard.press('Meta+d');
      await until(async () => (await vis('.agent-pane-slot[data-pane]').count()) >= k, 20000);
      await page.waitForTimeout(1200);
    }
    await page.waitForTimeout(800);
    return page;
  }

  const probe = (page) => page.$$eval('.agent-panes > .agent-pane', (els) => {
    const surf = getComputedStyle(document.querySelector('.agent-surface'));
    const row = document.querySelector('.agent-panes').getBoundingClientRect().width;
    return {
      row,
      read: parseFloat(surf.getPropertyValue('--pane-read-min')),
      min: parseFloat(surf.getPropertyValue('--pane-min')),
      panes: els.map((e) => ({ w: e.getBoundingClientRect().width, active: e.classList.contains('active') })),
      tabs: [...document.querySelectorAll('.agent-overlay-tabs > .agent-pane-tabbar')].map((t) => t.getBoundingClientRect().width),
    };
  });
  // Click a spot in the pane's transcript area that is not a control: the middle of the pane,
  // a third of the way down.
  async function clickPane(page, i) {
    const box = await page.locator('.agent-panes > .agent-pane').nth(i).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
    await page.waitForTimeout(600);
  }
  const ws = (p) => p.panes.map((x) => Math.round(x.w)).join('/');

  // ── W1 — wide windows: a click moves the focus, never the width ─────────────────
  for (const width of [1440, 1920]) {
    for (const n of [2, 3]) {
      const tag = `${n} panes @${width}`;
      const page = await openPanes(width, n);
      const start = await probe(page);
      check(`${tag}: setup has ${n} panes`, start.panes.length === n, `got ${start.panes.length}`);
      const equal = Math.max(...start.panes.map((x) => x.w)) - Math.min(...start.panes.map((x) => x.w)) <= 2;
      check(`${tag}: panes start equal`, equal, ws(start));
      // Click every pane, including back onto the first, so each one is clicked from unfocused.
      const order = [...Array(n).keys()].map((k) => (k + 1) % n).concat([0]);
      for (const i of order) {
        const before = await probe(page);
        await clickPane(page, i);
        const after = await probe(page);
        const same = before.panes.every((p, k) => Math.abs(p.w - after.panes[k].w) <= 1);
        const focused = after.panes[i]?.active === true;
        check(`${tag}: click pane ${i + 1} — focus moved to it, widths unchanged`,
          same && focused, `before ${ws(before)} after ${ws(after)} active=${after.panes.findIndex((x) => x.active) + 1}`);
      }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${n}-panes-${width}.png`) });
      await page.close();
    }
  }

  // ── W2 — narrow window: the clicked pane grows to the floor, and only to it ──────
  {
    const width = 1024, n = 3, tag = `${n} panes @${width}`;
    const page = await openPanes(width, n);
    const start = await probe(page);
    check(`${tag}: setup has ${n} panes, equal share under the floor`,
      start.panes.length === n && start.row / n < start.read, `row=${Math.round(start.row)} share=${Math.round(start.row / n)} floor=${start.read}`);
    for (const i of [0, 1, 2, 0]) {
      await clickPane(page, i);
      const p = await probe(page);
      const want = Math.max(p.row / n, Math.min(p.read, p.row - (n - 1) * p.min));
      const act = p.panes.findIndex((x) => x.active);
      const others = p.panes.filter((_, k) => k !== act).map((x) => x.w);
      const okW = act === i && Math.abs(p.panes[act].w - want) <= 2 && Math.abs(others[0] - others[1]) <= 2;
      check(`${tag}: click pane ${i + 1} — it grows to ${Math.round(want)}px, the others share the rest`,
        okW, `widths ${ws(p)} active=${act + 1}`);
      const tabsAligned = p.tabs.length === n && p.tabs.every((t, k) => Math.abs(t - p.panes[k].w) <= 2);
      check(`${tag}: click pane ${i + 1} — the tab groups stay edge-for-edge with their panes`,
        tabsAligned, `tabs ${p.tabs.map(Math.round).join('/')} panes ${ws(p)}`);
      if (SHOTS && i === 1) await page.screenshot({ path: join(SHOTS, `3-panes-1024-pane2-focused.png`) });
    }
    await page.close();
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
