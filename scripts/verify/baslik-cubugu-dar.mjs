#!/usr/bin/env node
/**
 * Dar pencerede başlık çubuğu: menü sekmeleri ve proje etiketi her genişlikte tam kalır, uyku
 * göstergesi kademeli küçülür. 1440, 1100, 900, 760 px, açık ve koyu. Ölçer: çubukta yatay taşma
 * yok, her sekme çubuğun içinde, hiçbir sekme sağ kümeyle üst üste binmez, tek satır, console
 * hatası yok. Uyku borcu 67/60 ("Must Sleep") taklit edilir.
 *
 *   BAR_OUT=<dir> BAR_TAG=after dreamcontext builder heavy -- node scripts/verify/baslik-cubugu-dar.mjs
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const OUT = process.env.BAR_OUT ?? null;
const TAG = process.env.BAR_TAG ?? 'after';
const WIDTHS = (process.env.BAR_WIDTHS ?? '1440,1100,900,760').split(',').map(Number);
const NAME = process.env.BAR_NAME ?? null;
if (OUT) mkdirSync(OUT, { recursive: true });

const app = await openApp({ suite: 'baslik-cubugu-dar' });
const browser = await chromium.launch();

async function measure(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="ns-titlebar"]');
    const r = (el) => el?.getBoundingClientRect();
    const tabs = [...document.querySelectorAll('[data-testid^="ns-tab-"]')].map((el) => ({ id: el.getAttribute('data-testid'), r: r(el), h: el.scrollWidth - el.clientWidth }));
    const right = bar.querySelector('.ns-tb-right');
    const picker = bar.querySelector('.ns-tb-picker');
    const name = bar.querySelector('.ns-tb-picker-name');
    const tracker = bar.querySelector('.sleep-tracker');
    const barBox = r(bar);
    const rightBox = r(right);
    const tabsRight = Math.max(...tabs.map((t) => t.r.right));
    const rows = new Set(tabs.map((t) => Math.round(t.r.top)));
    return {
      squeeze: bar.getAttribute('data-squeeze'),
      overflow: bar.scrollWidth - bar.clientWidth,
      tabs: tabs.length,
      tabsRight: Math.round(tabsRight),
      rightLeft: Math.round(rightBox.left),
      rightRight: Math.round(rightBox.right),
      barRight: Math.round(barBox.right),
      overlap: tabsRight > rightBox.left + 0.5,
      oneRow: rows.size === 1,
      tabCut: tabs.some((t) => t.h > 0 || t.r.right > barBox.right + 0.5 || t.r.left < 0),
      pickerCut: name ? name.scrollWidth - name.clientWidth : 0,
      pickerW: Math.round(r(picker).width),
      tracker: tracker ? Math.round(r(tracker).width) : null,
      trackerIn: tracker ? r(tracker).right <= barBox.right + 0.5 : null,
    };
  });
}

try {
  for (const theme of ['light', 'dark']) for (const w of WIDTHS) {
    const context = await browser.newContext({ viewport: { width: w, height: 700 }, colorScheme: theme });
    await setTheme(context, theme);
    await markAnnouncementsSeen(context, app.base);
    await context.route('**/api/sleep', async (route) => {
      const res = await route.fetch();
      const body = await res.json().catch(() => ({}));
      await route.fulfill({ response: res, json: { ...body, debt: 67, effective_debt: 67 } });
    });
    const page = await context.newPage();
    const where = `${w} ${theme}`;
    page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|\/ws\b|WebSocket/.test(m.text())) app.findings.push(`${where} console: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => app.findings.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
    await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('ns-titlebar').waitFor({ timeout: 60_000 });
    await page.getByTestId('ns-tab-tasks').click();
    await page.waitForTimeout(2000);
    if (NAME) { await page.evaluate((n) => { document.querySelector('.ns-tb-picker-name').textContent = n; }, NAME); await page.waitForTimeout(500); }
    const m = await measure(page);
    process.stdout.write(`${where}: ${JSON.stringify(m)}\n`);
    if (m.overflow > 0) app.findings.push(`${where}: the bar overflows by ${m.overflow}px`);
    if (m.overlap) app.findings.push(`${where}: the tabs reach under the right cluster`);
    if (!m.oneRow) app.findings.push(`${where}: the tabs are not on one row`);
    if (m.tabCut) app.findings.push(`${where}: a tab is cut`);
    if (m.trackerIn === false) app.findings.push(`${where}: the sleep tracker is outside the bar`);
    const file = join(app.shots, `bar-${TAG}-${w}-${theme}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: 56 } });
    app.taken.push(file);
    if (OUT) copyFileSync(file, join(OUT, `bar-${TAG}-${w}-${theme}.png`));
    await context.close();
  }
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
await browser.close();
process.exit(await app.finish());
