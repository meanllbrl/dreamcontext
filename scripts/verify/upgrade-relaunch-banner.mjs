#!/usr/bin/env node
/**
 * The update strip never closes the app on its own — end-to-end in Chromium.
 *
 *   R1  an update is ready, no agent works: the strip says so with Relaunch + Later, and after
 *       25 s (the old countdown was 20) NOTHING has asked the server to relaunch;
 *   R2  a Relaunch click with no agent at work relaunches straight away (one relaunch call);
 *   R3  two agents at work: the click opens the inline confirm ("2 agent(s) are working …"),
 *       no relaunch yet; Cancel closes it, "Relaunch anyway" relaunches.
 *
 *   npm run build && node scripts/verify/upgrade-relaunch-banner.mjs [shots-dir]
 *
 * The real dashboard server and React bundle in a fake HOME. Only two things are stubbed: the
 * desktop marker (`__TAURI_INTERNALS__`, so the desktop-only strip renders), and /api/health's
 * `upgradeReady` + `agentsWorking` on top of the real response. /api/launcher/relaunch is
 * intercepted and COUNTED, answering ok:false, so nothing ever quits.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-upgrade-relaunch');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = resolve(process.argv[2] ?? join(REPO, 'tmp', 'verify-upgrade-relaunch'));

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  spawnSync(process.execPath, [DIST_INDEX, 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME } });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  seed();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  const state = { working: 0, relaunchCalls: 0 };

  const open = async (width, height) => {
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });
    await ctx.route('**/api/health', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, upgradeReady: '99.0.0', agentsWorking: state.working } });
    });
    await ctx.route('**/api/launcher/relaunch', async (route) => {
      state.relaunchCalls++;
      await route.fulfill({ json: { ok: false, reason: 'verify: counted, never armed' } });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/?vault=proj`);
    await page.locator('.upgrade-relaunch-banner').first().waitFor({ timeout: 20_000 });
    return { ctx, page, errors };
  };
  const strip = (page) => page.locator('.upgrade-relaunch-banner').first();
  const button = (page, label) => strip(page).locator('button', { hasText: label });

  // R1 + R2 — desktop width.
  {
    state.working = 0; state.relaunchCalls = 0;
    const { ctx, page, errors } = await open(1280, 800);
    const text = await strip(page).innerText();
    check('R1 strip reads "Update ready" with Relaunch + Later',
      /Update ready/.test(text) && await button(page, 'Relaunch now').count() === 1 && await button(page, 'Later').count() === 1, JSON.stringify(text));
    check('R1 no countdown in the strip', !/relaunching in \d+s/i.test(text));
    await page.screenshot({ path: join(SHOTS, 'hazir-desktop-1280.png') });
    await page.waitForTimeout(25_000);
    check('R1 25 s untouched: no relaunch was asked for', state.relaunchCalls === 0, `calls=${state.relaunchCalls}`);
    check('R1 strip still there, unchanged', /Update ready/.test(await strip(page).innerText()));
    await button(page, 'Relaunch now').click();
    await page.waitForTimeout(1_500);
    check('R2 click with no agent working relaunches straight away', state.relaunchCalls === 1, `calls=${state.relaunchCalls}`);
    console.log('console errors (R1/R2):', errors.length ? errors : 'none');
    await ctx.close();
  }

  // R3 — two agents working, desktop + phone width.
  for (const [w, h, tag] of [[1280, 800, 'desktop-1280'], [390, 844, 'phone-390']]) {
    state.working = 2; state.relaunchCalls = 0;
    const { ctx, page, errors } = await open(w, h);
    await page.screenshot({ path: join(SHOTS, `calisiyor-once-${tag}.png`) });
    await button(page, 'Relaunch now').click();
    await strip(page).locator('button', { hasText: 'Relaunch anyway' }).waitFor({ timeout: 5_000 });
    const text = await strip(page).innerText();
    check(`R3 ${tag} confirm names the 2 working agents`, /2 agent\(s\) are working/.test(text), JSON.stringify(text));
    check(`R3 ${tag} no relaunch before the confirm`, state.relaunchCalls === 0, `calls=${state.relaunchCalls}`);
    await page.screenshot({ path: join(SHOTS, `calisiyor-onay-${tag}.png`) });
    await button(page, 'Cancel').click();
    check(`R3 ${tag} Cancel closes the confirm, nothing relaunched`,
      await button(page, 'Relaunch now').count() === 1 && state.relaunchCalls === 0);
    await button(page, 'Relaunch now').click();
    await button(page, 'Relaunch anyway').click();
    await page.waitForTimeout(1_500);
    check(`R3 ${tag} "Relaunch anyway" relaunches`, state.relaunchCalls === 1, `calls=${state.relaunchCalls}`);
    console.log(`console errors (R3 ${tag}):`, errors.length ? errors : 'none');
    await ctx.close();
  }

  await browser.close();
  srv.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed · shots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
