#!/usr/bin/env node
/**
 * /verify for the new shell, wave 1 (task codex-tarzi-yeni-kabuk, W1 AC 3-5c, 17).
 *
 * Drives a RUNNING dashboard (scratch HOME with fictional projects, `shell: "new"` in its
 * launcher-ui.json) and shoots every screen and overlay the wave touched at 1440/1024/768/390
 * dark plus 1440 light. The 390 shots use a narrow viewport WITHOUT touch emulation (with touch,
 * `useIsMobile` correctly falls back to classic). For each shot it records console errors and
 * horizontal overflow; for the boards and Project Relations it records whether `.shell-main`
 * scrolls vertically. Prints one JSON report; exit 1 on any error, overflow or failed check.
 *
 *   node scripts/verify/new-shell-w1.mjs --url http://127.0.0.1:45781 --vault acme --out <dir> [--only 1440] [--once]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const BASE = arg('url', 'http://127.0.0.1:45781');
const VAULT = arg('vault', 'acme');
const OUT = arg('out', 'tmp/develop/w1-shots');
const ONLY = arg('only', null);
/** Only the once-per-run checks (launch, Settings row, phone, OFF): a re-run after a fix there. */
const ONCE = process.argv.includes('--once');
mkdirSync(OUT, { recursive: true });

const WIDTHS = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const RUNS = [
  ...WIDTHS.map(([w, h]) => ({ w, h, theme: 'dark' })),
  { w: 1440, h: 900, theme: 'light' },
].filter((r) => !ONCE && (!ONLY || String(r.w) === ONLY));

const report = { shots: [], failures: [] };

async function settle(page, ms = 700) {
  await page.waitForTimeout(ms);
}

async function dismissWhatsNew(page) {
  const got = page.getByRole('button', { name: 'Got it' });
  if (await got.isVisible().catch(() => false)) { await got.click(); await settle(page, 300); }
}

async function frameMetrics(page) {
  return page.evaluate(() => {
    const inst = document.querySelector('.project-instance:not([hidden])');
    const main = inst?.querySelector('.shell-main');
    const r = main?.getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      mainScrollsY: main ? main.scrollHeight > main.clientHeight + 1 : null,
      mainScrollHeight: main?.scrollHeight ?? null,
      mainClientHeight: main?.clientHeight ?? null,
      mainLeft: r ? Math.round(r.left) : null,
      railRight: Math.round(document.querySelector('.ns-rail')?.getBoundingClientRect().right ?? -1),
    };
  });
}

async function shot(page, run, name, extra = {}) {
  const file = join(OUT, `${name}-${run.w}-${run.theme}.png`);
  await page.screenshot({ path: file });
  const m = await frameMetrics(page);
  const entry = { name, width: run.w, theme: run.theme, file, ...m, ...extra };
  report.shots.push(entry);
  if (m.overflowX) report.failures.push(`${name}@${run.w}: horizontal overflow`);
  return entry;
}

async function gotoRail(page, run, page_) {
  const narrow = run.w <= 600;
  const direct = page.getByTestId(`ns-rail-${page_}`);
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
  } else {
    await page.getByTestId('ns-rail-more').click();
    await settle(page, 200);
    await page.getByTestId(`ns-more-${page_}`).click();
  }
  await settle(page, narrow ? 900 : 700);
  await dismissWhatsNew(page);
}

const RAIL_PAGES = ['tasks', 'automations', 'lab', 'roadmap', 'hypotheses', 'whiteboards', 'knowledge', 'brain', 'settings'];
const MORE_PAGES = ['council', 'core', 'taxonomy', 'sleep', 'packs', 'announcements', 'about'];
const NO_SCROLL = new Set(['tasks', 'roadmap', 'hypotheses', 'relations']);

const browser = await chromium.launch();
for (const run of RUNS) {
  const context = await browser.newContext({ viewport: { width: run.w, height: run.h }, hasTouch: false, isMobile: false });
  await context.addInitScript((theme) => {
    try { localStorage.setItem('dreamcontext-theme', theme); } catch { /* ignore */ }
  }, run.theme);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${BASE}/?vault=${encodeURIComponent(VAULT)}`);
  await page.getByTestId('ns-titlebar').waitFor({ timeout: 15_000 });
  await settle(page, 1500);
  await dismissWhatsNew(page);

  for (const p of [...RAIL_PAGES, ...MORE_PAGES]) {
    await gotoRail(page, run, p);
    const e = await shot(page, run, `page-${p}`);
    if (NO_SCROLL.has(p) && run.w >= 1024 && e.mainScrollsY) report.failures.push(`page-${p}@${run.w}: .shell-main scrolls vertically`);
  }

  // Project Relations is opened from the drawer in W2; in W1 it is reachable by its page id.
  await page.goto(`${BASE}/?vault=${encodeURIComponent(VAULT)}&page=relations`);
  await page.getByTestId('relations-page').waitFor({ timeout: 15_000 });
  await settle(page, 1500);
  await dismissWhatsNew(page);
  {
    const e = await shot(page, run, 'page-relations');
    if (run.w >= 1024 && e.mainScrollsY) report.failures.push(`page-relations@${run.w}: .shell-main scrolls (${e.mainScrollHeight} > ${e.mainClientHeight})`);
  }

  // Chat in the frame.
  const chat = page.getByTestId('ns-rail-chat');
  if (await chat.isVisible().catch(() => false)) {
    await chat.click();
    await settle(page, 1200);
    const bounded = await page.evaluate(() => {
      const s = document.querySelector('.project-instance:not([hidden]) .agent-surface.expanded');
      const rail = document.querySelector('.ns-rail')?.getBoundingClientRect();
      const r = s?.getBoundingClientRect();
      return r && rail ? { left: Math.round(r.left), top: Math.round(r.top), railRight: Math.round(rail.right), railTop: Math.round(rail.top) } : null;
    });
    await shot(page, run, 'chat', { bounded });
    if (bounded && run.w > 600 && bounded.left <= bounded.railRight) report.failures.push(`chat@${run.w}: overlay covers the rail`);
    // Back to a page.
    await gotoRail(page, run, 'tasks');
  } else {
    report.failures.push(`chat@${run.w}: no Chat rail item`);
  }

  // Overlays: the picker, More, the search palette.
  await page.getByTestId('ns-picker-btn').click();
  await settle(page, 300);
  await shot(page, run, 'overlay-picker');
  await page.keyboard.press('Escape');
  await settle(page, 200);

  await page.getByTestId('ns-rail-more').click();
  await settle(page, 300);
  const moreInside = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="ns-more-menu"]')?.getBoundingClientRect();
    return r ? r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight : false;
  });
  await shot(page, run, 'overlay-more', { moreInside });
  if (!moreInside) report.failures.push(`overlay-more@${run.w}: More menu leaves the window`);
  await page.keyboard.press('Escape');
  await settle(page, 200);

  await page.getByTestId('ns-search').click();
  await settle(page, 400);
  await shot(page, run, 'overlay-search');
  await page.keyboard.press('Escape');
  await settle(page, 200);

  // AC 5c, at 1440: the full-screen views. In-frame ones stay right of the rail; the Insights
  // card and a Lab app cover the whole window with their own Exit on top.
  if (run.w === 1440) {
    const rect = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    }, sel);
    const railRight = () => page.evaluate(() => Math.round(document.querySelector('.ns-rail')?.getBoundingClientRect().right ?? 0));

    // The task: the drawer variant, then the full page.
    await gotoRail(page, run, 'tasks');
    await page.getByText('Checkout page shows the total').first().click();
    await settle(page, 900);
    await shot(page, run, 'fs-task-drawer', { panel: await rect('.detail-panel') });
    await page.getByRole('button', { name: 'Open in full page' }).click();
    await settle(page, 900);
    const full = await rect('.detail-overlay--fullscreen');
    const rr = await railRight();
    await shot(page, run, 'fs-task-fullpage', { full, railRight: rr });
    if (!full || full.left < rr) report.failures.push(`fs-task-fullpage@${run.w}: covers the rail (${JSON.stringify(full)})`);
    await page.getByRole('button', { name: 'Close' }).first().click();
    await settle(page, 400);

    // Knowledge's full-screen document.
    await gotoRail(page, run, 'knowledge');
    await page.getByText('pricing-decisions').first().click().catch(() => {});
    await settle(page, 900);
    await page.getByRole('button', { name: 'Full screen' }).first().click();
    await settle(page, 800);
    const kfs = await rect('.fullscreen-overlay');
    await shot(page, run, 'fs-knowledge', { kfs, railRight: rr });
    if (!kfs || kfs.left < rr) report.failures.push(`fs-knowledge@${run.w}: covers the rail (${JSON.stringify(kfs)})`);
    await page.keyboard.press('Escape');
    await settle(page, 400);

    // The Insights card full screen: the whole window, its Exit on top.
    await gotoRail(page, run, 'lab');
    await settle(page, 1500);
    const cardId = await page.evaluate(() => document.querySelector('[data-lab-card]')?.getAttribute('data-lab-card') ?? null);
    if (!cardId) report.failures.push(`fs-insights-card@${run.w}: no card on the Insights board`);
    await page.goto(`${BASE}/?vault=${encodeURIComponent(VAULT)}&page=lab&card=${encodeURIComponent(cardId ?? '')}`);
    await page.getByTestId('ns-titlebar').waitFor({ timeout: 15_000 });
    await settle(page, 2500);
    await dismissWhatsNew(page);
    const exitCard = page.getByRole('button', { name: /Exit full screen/ }).first();
    const exitVisible = await exitCard.isVisible().catch(() => false);
    const cardTop = await page.evaluate(() => {
      const ex = [...document.querySelectorAll('button')].find((b) => /Exit full screen/.test(b.getAttribute('aria-label') ?? ''));
      if (!ex) return null;
      const r = ex.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { onTop: !!hit && (hit === ex || ex.contains(hit)) };
    });
    await shot(page, run, 'fs-insights-card', { exitVisible, cardTop });
    if (!exitVisible || !cardTop?.onTop) report.failures.push(`fs-insights-card@${run.w}: Exit not visible on top`);
    await exitCard.click().catch(() => {});
    await settle(page, 600);
    const closed = !(await page.getByRole('button', { name: /Exit full screen/ }).first().isVisible().catch(() => false));
    if (!closed) report.failures.push(`fs-insights-card@${run.w}: Exit did not close it`);

    // A Lab app at ?fs=1.
    await page.goto(`${BASE}/lab/demo-growth?fs=1&vault=${encodeURIComponent(VAULT)}`);
    await settle(page, 2500);
    await dismissWhatsNew(page);
    const lab = await rect('.lab-app-page--fullscreen');
    await shot(page, run, 'fs-lab-app', { lab });
    if (!lab || lab.top > 0 || lab.left > 0) report.failures.push(`fs-lab-app@${run.w}: does not cover the window (${JSON.stringify(lab)})`);
    await page.keyboard.press('Escape');
    await settle(page, 600);
    const labOut = await page.evaluate(() => !document.querySelector('.lab-app-page--fullscreen'));
    if (!labOut) report.failures.push(`fs-lab-app@${run.w}: Escape did not exit`);
  }

  if (errors.length) report.failures.push(`console@${run.w}-${run.theme}: ${errors.slice(0, 3).join(' | ')}`);
  report.shots.push({ run: `${run.w}-${run.theme}`, consoleErrors: errors });
  await context.close();
}

// Once, at 1440 dark: the launch, the Settings row, the phone, and OFF.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('dreamcontext-theme', 'dark'); } catch { /* ignore */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const post = (body) => page.evaluate(async ([u, b]) => (await fetch(`${u}/api/launcher/ui-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(), [BASE, body]);

  // AC 3: the launcher window ("/") opens on the last project.
  await page.goto(`${BASE}/api/health`);
  await post({ shell: 'new', lastVault: 'globex' });
  await page.goto(`${BASE}/`);
  await page.getByTestId('ns-titlebar').waitFor({ timeout: 15_000 });
  await settle(page, 1500);
  await dismissWhatsNew(page);
  const pickerName = (await page.getByTestId('ns-picker-btn').textContent())?.trim();
  report.shots.push({ name: 'launch-last-project', pickerName, file: join(OUT, 'launch-last-project-1440-dark.png') });
  await page.screenshot({ path: join(OUT, 'launch-last-project-1440-dark.png') });
  if (pickerName !== 'globex') report.failures.push(`launch: opened on ${pickerName}, not the last project globex`);
  await post({ lastVault: VAULT });

  // AC 1: the Settings row, ON.
  await page.goto(`${BASE}/?vault=${VAULT}&page=settings`);
  await page.getByTestId('ns-titlebar').waitFor({ timeout: 15_000 });
  await settle(page, 1000);
  await dismissWhatsNew(page);
  await page.getByRole('button', { name: /Dependencies/ }).first().click();
  await settle(page, 800);
  await page.getByTestId('new-layout-setting').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'settings-new-layout-1440-dark.png') });
  const on = await page.getByTestId('new-layout-setting').locator('input.setting-switch').isChecked().catch(() => null);
  report.shots.push({ name: 'settings-new-layout', on });
  if (on !== true) report.failures.push(`settings: the New layout row does not read ON (${on})`);

  // AC 6: a phone (narrow + touch) keeps today's UI whatever the switch says.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/?vault=${VAULT}&page=tasks`);
  await pp.waitForTimeout(3000);
  const phoneNew = await pp.getByTestId('ns-titlebar').count();
  await pp.screenshot({ path: join(OUT, 'phone-classic-390-dark.png') });
  report.shots.push({ name: 'phone-classic', newShellNodes: phoneNew });
  if (phoneNew !== 0) report.failures.push('phone: the new shell drew on a touch phone');
  await phone.close();

  // OFF at 1440: the classic shell comes back after a restart (a reload here).
  await post({ shell: 'classic' });
  await page.goto(`${BASE}/?vault=${VAULT}&page=tasks`);
  await settle(page, 2500);
  await dismissWhatsNew(page);
  const offNew = await page.getByTestId('ns-titlebar').count();
  const offSidebar = await page.locator('nav.sidebar').count();
  await page.screenshot({ path: join(OUT, 'off-tasks-1440-dark.png') });
  report.shots.push({ name: 'off-tasks', newShellNodes: offNew, classicSidebar: offSidebar });
  if (offNew !== 0 || offSidebar !== 1) report.failures.push('off: the classic shell did not come back');
  await post({ shell: 'new' });
  if (errors.length) report.failures.push(`console@once: ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
process.exit(report.failures.length ? 1 : 0);
