#!/usr/bin/env node
/**
 * A member row in the left menu opens that member's stage, never a blank page (owner 2026-11-07:
 * "Product Owner" under Team gave an empty white main area; Super Agent brought the stage back).
 *
 *   npm run build && node scripts/verify/uye-bos-sayfa.mjs [outDir] [prefix]
 *
 * Real dashboard server from dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), main's Super handed
 * over to the scripted stand-in, a member with a routine whose own Super was born (a chat). Every
 * switch is a real mouse click on the drawer row: main -> member -> main -> member, folded Team
 * row (the open member under it) and open. After each click the main area must hold a drawn stage
 * with cards, and console errors are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { cleanEnv, freePort, pageFetch, readNd, reporter, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-uye-bos-sayfa-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'uye-bos-sayfa'));
const PREFIX = process.argv[3] || 'shot';
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SLUG = 'product-owner';

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const { ok, summary, result } = reporter();

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: REPORTS, cli: CLI }));
  chmodSync(bin, 0o755);
  const steps = [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })],
    ['agent', dc('agents', 'create', SLUG, '--title', 'Product Owner', '--prompt', 'Reads the funnels and reports to the Super.')],
  ];
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

async function handOver(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => readNd(REPORTS).some((r) => r.kind === 'spawn'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 60000);
}

/** What the main area draws now: the stage on screen, its super, and how many cards it holds. */
const mainArea = (page) => page.evaluate(() => {
  const surf = [...document.querySelectorAll('[data-testid="super-surface"]')].find((el) => el.getBoundingClientRect().width > 0);
  const cards = surf ? [...surf.querySelectorAll('[data-testid="super-container"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length : 0;
  return { surface: !!surf, superId: surf?.getAttribute('data-super-id') ?? null, cards, text: (document.querySelector('main')?.innerText ?? '').trim().length };
});

const memberRow = (page) => page.locator(`.ns-team-mrow[data-slug="${SLUG}"]:visible`).first();
const superRow = (page) => page.locator('aside, nav').getByText('Super Agent', { exact: true }).first();

async function shows(page, superId, label, shot) {
  const drawn = await until(page, async () => { const a = await mainArea(page); return a.surface && a.superId === superId && a.cards > 0; }, 15000);
  const a = await mainArea(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${PREFIX}-${shot}.png`) });
  ok(`${label}: the main area draws the ${superId} stage with cards`, drawn, JSON.stringify(a));
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'uye', { expected: [/status of 409/, /^409 POST \/api\/super\/member\b/] });
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const r = await pageFetch(page, VAULT, 'POST', '/automations', { title: 'Daily funnel read', agent: SLUG, job: 'Read the funnels.', mode: 'sched', days: 'daily', at: '09:30' });
  ok('setup: a routine for the member', r.status === 200, JSON.stringify(r).slice(0, 300));
  ok('setup: main Super handed over', await handOver(page, base));
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }

  // Folded Team row: open it once to reach the member row the first time.
  const team = page.locator('[data-testid="drawer-team-row"]:visible').first();
  if ((await team.getAttribute('aria-expanded')) !== 'true') await team.click();
  ok('the member row is in the left menu', await until(page, async () => (await memberRow(page).count()) === 1, 15000));
  await memberRow(page).click();
  await shows(page, `m:${SLUG}`, '1st member click', '1-member');
  // Its Super was born on that open: a chat now exists for it.
  ok('the member\'s Super chat was spawned', await until(page, async () => readNd(REPORTS).filter((x) => x.kind === 'spawn').length >= 2, 20000));

  await superRow(page).click();
  await shows(page, 'main', 'back to Super Agent', '2-main');
  await memberRow(page).click();
  await shows(page, `m:${SLUG}`, '2nd member click (open list)', '3-member');

  // Folded: the open member stays under the row; from main it is a pop-out only if it has news.
  await team.click();
  await superRow(page).click();
  await shows(page, 'main', 'Super Agent, Team folded', '4-main-folded');
  if (await memberRow(page).count()) {
    await memberRow(page).click();
    await shows(page, `m:${SLUG}`, 'member click from the folded row', '5-member-folded');
  }
  // Fast switching: the click lands while the previous open is still on its way.
  for (let i = 0; i < 3; i++) {
    await team.click().catch(() => {});
    if (await memberRow(page).count()) await memberRow(page).click();
    await superRow(page).click();
    if (!(await memberRow(page).count())) await team.click();
    await memberRow(page).click();
  }
  await shows(page, `m:${SLUG}`, 'after fast switching', '6-member-fast');

  // Frame by frame (the owner's recording: ONE painted frame blank white, the Super row still
  // selected, then the member's stage). That white is the "arriving" cover a drawer click raises
  // for a project it brings forward; on the project already on screen it must never come up. The
  // CPU is slowed 6x (his Mac was at load 100) so a cover that does come up gets painted.
  const cdp = await context.newCDPSession(page);
  for (const [from, to, label] of [['main', `m:${SLUG}`, 'main -> member'], [`m:${SLUG}`, 'main', 'member -> main'], ['main', `m:${SLUG}`, 'main -> member again']]) {
    if (from === 'main') await superRow(page).click(); else { if (!(await memberRow(page).count())) await team.click(); await memberRow(page).click(); }
    await shows(page, from, `frames ${label}: start`, `f-${label.replace(/[^a-z]+/g, '-')}`);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.evaluate(() => {
      const log = []; window.__frames = log; window.__cover = 0;
      const coverOn = () => [...document.querySelectorAll('[data-testid="agent-arriving"]')].some((el) => el.getBoundingClientRect().width > 0);
      new MutationObserver(() => { if (coverOn()) window.__cover += 1; }).observe(document.body, { childList: true, subtree: true });
      const tick = () => {
        const surf = [...document.querySelectorAll('[data-testid="super-surface"]')].find((el) => el.getBoundingClientRect().width > 0);
        const cards = surf ? [...surf.querySelectorAll('[data-testid="super-container"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).opacity !== '0'; }).length : 0;
        log.push({ id: surf?.getAttribute('data-super-id') ?? null, cards, cover: coverOn() });
        if (log.length < 120) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    if (to === 'main') await superRow(page).click(); else { if (!(await memberRow(page).count())) await team.click(); await memberRow(page).click(); }
    await page.waitForTimeout(3000);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const frames = await page.evaluate(() => window.__frames);
    const cover = await page.evaluate(() => window.__cover);
    const empty = frames.filter((f) => !f.id || f.cards === 0 || f.cover);
    ok(`frames ${label}: the white cover never comes up on the project already on screen`, cover === 0, `cover seen in ${cover} DOM changes`);
    ok(`frames ${label}: no frame without a drawn stage`, empty.length === 0, `${empty.length}/${frames.length} empty: ${JSON.stringify(frames.filter((f) => !f.id || f.cards === 0 || f.cover).slice(0, 6))}`);
    await shows(page, to, `frames ${label}: lands`, `f-${label.replace(/[^a-z]+/g, '-')}-end`);
  }

  // A busy Mac (the owner's): the member's open answers late. The click must show its stage at
  // once, not a blank main area while the open is out. Sampled for 3 s after the click.
  await superRow(page).click();
  await shows(page, 'main', 'Super Agent before the slow open', '7-main');
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  await page.route("**/api/super/member", async (route) => { await held; await route.continue().catch(() => {}); });
  if (!(await memberRow(page).count())) await team.click();
  await memberRow(page).click();
  const samples = [];
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(300); samples.push(await mainArea(page)); }
  await page.screenshot({ path: join(OUT, `${PREFIX}-8-slow-open.png`) });
  const blank = samples.filter((a) => !a.surface || a.cards === 0);
  ok('slow open: the main area is never blank while the open is out', blank.length === 0, JSON.stringify(samples));
  ok('slow open: it is the member\'s stage that shows', samples.every((a) => a.superId === `m:${SLUG}`), JSON.stringify(samples.map((a) => a.superId)));
  release();
  await page.unroute('**/api/super/member');
  await shows(page, `m:${SLUG}`, 'slow open, once answered', '9-slow-answered');

  ok('no console errors', watch.errors.length === 0, watch.errors.join('\n'));
  await browser.close();
}

async function main() {
  let srv = null;
  try {
    setup();
    const port = await freePort();
    srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
    await run(`http://127.0.0.1:${port}`);
  } catch (e) { ok('ran to the end', false, e?.stack ?? e); }
  finally { srv?.kill(); }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(summary());
  process.exit(result.fails.length ? 1 : 0);
}
main();
