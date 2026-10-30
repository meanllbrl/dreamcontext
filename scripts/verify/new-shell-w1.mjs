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
 *   node scripts/verify/new-shell-w1.mjs --url http://127.0.0.1:45781 --vault acme --out <dir> [--only 1440]
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
mkdirSync(OUT, { recursive: true });

const WIDTHS = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const RUNS = [
  ...WIDTHS.map(([w, h]) => ({ w, h, theme: 'dark' })),
  { w: 1440, h: 900, theme: 'light' },
].filter((r) => !ONLY || String(r.w) === ONLY);

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

  if (errors.length) report.failures.push(`console@${run.w}-${run.theme}: ${errors.slice(0, 3).join(' | ')}`);
  report.shots.push({ run: `${run.w}-${run.theme}`, consoleErrors: errors });
  await context.close();
}

// OFF at 1440: the classic shell, for comparison (the caller flips the switch first with --off).
await browser.close();
console.log(JSON.stringify(report, null, 1));
process.exit(report.failures.length ? 1 : 0);
