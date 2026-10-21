#!/usr/bin/env node
/**
 * The window chrome's Hands-free button wears the hands-free mark, not the retired cloud
 * (owner, 2026-10-21: "Handsfree ikonu neden burada gözükmüyor?").
 *
 *   npm run build && node scripts/verify/handsfree-chrome-button.mjs
 *
 * The real dashboard server (scratch HOME, desktop flag, the power runner only logging, the
 * loopback stand-in for cloudflared), the laptop window at 1440x900 in light and dark, Mac mode
 * off and on. Per state: the button holds exactly one hands-free mark, 16px tall, and no other
 * svg (the cloud is gone); the accent dot only while Mac mode is on; a close-up screenshot.
 * Across the run: no console error.
 *
 * Screenshots: tmp/verify-handsfree-chrome-button/*.png. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-chrome-button');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-chrome-button');
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
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the chrome button check']);
  cli(['vaults', 'add', 'proj', PROJ]);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log'), DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(await until(async () => (await fetch(`${base}/`)).ok, 30000, 300))) throw new Error('server did not come up');
  const mac = async (path, body) => (await fetch(`${base}/api/handsfree/mac/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })).status;
  report.check('Mac mode is set up', (await mac('setup')) === 200);
  browser = await chromium.launch();
  const errors = [];

  const look = async (theme, on) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    await setTheme(ctx, theme);
    await markAnnouncementsSeen(ctx, base);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${theme}/${on ? 'on' : 'off'}: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 160)}`));
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    const btn = page.locator('[data-testid="hf-button"]').first();
    report.check(`${theme}, mac ${on ? 'on' : 'off'}: the button is in the bar`, await until(async () => (await btn.count()) === 1, 15000));
    if (on) await until(async () => (await btn.getAttribute('data-phase')) === 'mac', 15000);
    await page.waitForTimeout(600);
    const m = await btn.evaluate((el) => {
      const marks = el.querySelectorAll('[data-testid="handsfree-mark"]');
      const mark = marks[0];
      const r = mark?.getBoundingClientRect();
      const dot = el.querySelector('[data-testid="hf-button-dot"]');
      return {
        marks: marks.length,
        svgs: el.querySelectorAll('svg').length,
        h: r ? Math.round(r.height) : 0, w: r ? Math.round(r.width) : 0,
        phase: el.getAttribute('data-phase'),
        dot: dot ? getComputedStyle(dot).backgroundColor : null,
        accent: getComputedStyle(document.body).getPropertyValue('--color-accent').trim(),
        label: el.textContent?.trim(),
        theme: document.documentElement.getAttribute('data-theme'),
      };
    });
    report.check(`${theme}, mac ${on ? 'on' : 'off'}: one hands-free mark, 16px tall (${m.w}x${m.h}), and no other svg (no cloud)`, m.marks === 1 && m.svgs === 1 && m.h === 16, JSON.stringify(m));
    report.check(`${theme}, mac ${on ? 'on' : 'off'}: ${on ? 'the accent dot is on the mark' : 'no dot'} ("${m.label}")`, on ? m.phase === 'mac' && !!m.dot : m.phase === 'home' && m.dot === null, JSON.stringify(m));
    const box = await btn.boundingBox();
    await page.screenshot({ path: join(SHOTS, `button-${theme}-${on ? 'on' : 'off'}.png`), clip: { x: box.x - 12, y: box.y - 8, width: box.width + 24, height: box.height + 16 } });
    await page.screenshot({ path: join(SHOTS, `bar-${theme}-${on ? 'on' : 'off'}.png`), clip: { x: 900, y: 0, width: 540, height: 60 } });
    await ctx.close();
  };

  for (const theme of ['light', 'dark']) await look(theme, false);
  report.check('Mac mode starts (loopback stand-in tunnel)', (await mac('start', { vaults: ['proj'] })) === 200);
  for (const theme of ['light', 'dark']) await look(theme, true);
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
