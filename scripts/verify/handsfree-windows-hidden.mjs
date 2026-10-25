#!/usr/bin/env node
/**
 * Hands-free hides where the server says Mac mode cannot run (owner, 2026-10-25: "hands-free
 * Windows'ta gizlensin"), and the Mac keeps it.
 *
 *   npm run build && node scripts/verify/handsfree-windows-hidden.mjs
 *
 * The real dashboard server (scratch HOME, desktop flag) at a laptop (1440x900) and a phone
 * (390x844) width; the Settings card is checked at the laptop width. "mac": the server's own answer on this Mac (`supported: true`): the chrome's
 * hands-free button and the Settings → GitHub hands-free card are there. "windows": the same
 * page with GET /api/handsfree/mac/status answering `supported: false`, which is what a win32
 * server sends (tests/unit/handsfree-windows-gate.test.ts proves the server half): neither is
 * there. Across the run: no console error.
 *
 * Screenshots: tmp/verify-handsfree-windows-hidden/*.png. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-windows-hidden');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-windows-hidden');
const CLI = join(REPO, 'dist', 'index.js');

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
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

let server = null;
let browser = null;
try {
  const { chromium } = await import('@playwright/test');
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), PROJ, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the hands-free platform check']);
  cli(['vaults', 'add', 'proj', PROJ]);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log'), DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(await until(async () => (await fetch(`${base}/`)).ok, 30000, 300))) throw new Error('server did not come up');
  const real = await (await fetch(`${base}/api/handsfree/mac/status`)).json();
  report.check(`this Mac's server says supported: true (got ${real.supported})`, real.supported === true);
  browser = await chromium.launch();
  const errors = [];

  const look = async (os, width, height) => {
    const tag = `${os} ${width}px`;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    await markAnnouncementsSeen(ctx, base);
    if (os === 'windows') {
      // What a win32 server answers: the same status, `supported: false`.
      await ctx.route('**/api/handsfree/mac/status', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), supported: false } });
      });
    }
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${String(e).slice(0, 160)}`));
    const statusSeen = page.waitForResponse((r) => r.url().includes('/api/handsfree/mac/status'), { timeout: 20000 });
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await statusSeen;
    await page.waitForTimeout(800);
    const btn = page.locator('[data-testid="hf-button"]');
    if (os === 'mac') report.check(`${tag}: the hands-free button is in the bar`, await until(async () => (await btn.count()) === 1, 15000));
    else report.check(`${tag}: no hands-free button`, (await btn.count()) === 0, `count ${await btn.count()}`);
    await page.screenshot({ path: join(SHOTS, `bar-${os}-${width}.png`), clip: { x: Math.max(0, width - 560), y: 0, width: Math.min(560, width), height: 64 } });

    // Settings → GitHub, the section the card lives in, the way a user gets there. The phone
    // width folds the sidebar away, so the laptop width is where the card is clicked to.
    if (width >= 1000) {
      await page.getByRole('button', { name: /^Settings$/ }).or(page.getByText('Settings', { exact: true })).first().click();
      await until(async () => (await page.locator('.settings-nav').count()) > 0, 15000);
      await page.locator('.settings-nav-item', { hasText: /GitHub/ }).first().click();
    }
    if (width < 1000) { await ctx.close(); return; }
    const settingsUp = await until(async () => (await page.locator('.settings-nav-item--active', { hasText: /GitHub/ }).count()) === 1, 15000);
    report.check(`${tag}: Settings → GitHub opened`, settingsUp);
    await page.waitForTimeout(1200);
    const card = page.locator('[data-testid="hf-settings"]');
    if (os === 'mac') report.check(`${tag}: the hands-free settings card is there`, await until(async () => (await card.count()) === 1, 10000));
    else report.check(`${tag}: no hands-free settings card`, (await card.count()) === 0, `count ${await card.count()}`);
    if (await card.count()) await card.scrollIntoViewIfNeeded();
    else await page.locator('.settings-body').evaluate((el) => el.scrollIntoView({ block: 'end' })).catch(() => {});
    await page.screenshot({ path: join(SHOTS, `settings-${os}-${width}.png`), fullPage: false });
    await ctx.close();
  };

  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await look('mac', w, h);
    await look('windows', w, h);
  }
  report.check('no console error', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `:\n  - ${report.fails.join('\n  - ')}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(report.fails.length ? 1 : 0);
