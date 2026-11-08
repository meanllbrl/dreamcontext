#!/usr/bin/env node
/**
 * The Apps page title bar against AI Team and Tasks, at 390 and 1440 px, light and dark:
 * the bar's height, the title's font size, the rule and the left edge must match.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/apps-title.mjs
 */
import { openApp } from './lib/app.mjs';

const app = await openApp({ suite: 'apps-title' });
const rows = [];
const PAGES = [['apps', 'Apps'], ['aiteam', 'AI Team'], ['tasks', 'Tasks']];

async function go(page, w, label) {
  if (w.width <= 600) {
    await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 }).catch(() => {});
    await page.getByText(label, { exact: true }).first().click({ timeout: 10_000 }).catch(async () => {
      await page.locator(`[aria-label="${label}"]`).first().click({ timeout: 10_000 });
    });
  } else {
    await page.locator(`[aria-label="${label}"]`).first().click({ timeout: 10_000 });
  }
  await page.waitForTimeout(1500);
}

try {
  for (const theme of ['light', 'dark']) {
    for (const [id, label] of PAGES) {
      await app.look('/?vault=proj', async (page, w) => {
        await page.evaluate((t) => { localStorage.setItem('dreamcontext-theme', t); document.documentElement.setAttribute('data-theme', t); }, theme);
        await go(page, w, label);
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.waitForTimeout(300);
        const m = await page.evaluate(() => {
          const t = document.querySelector('.page-bar-title');
          const bar = t?.closest('[data-page-row], .page-bar');
          if (!t || !bar) return null;
          const br = bar.getBoundingClientRect(); const tr = t.getBoundingClientRect();
          const cs = getComputedStyle(t); const bs = getComputedStyle(bar);
          return { barTop: Math.round(br.top), barH: Math.round(br.height * 10) / 10, barLeft: Math.round(br.left), titleLeft: Math.round(tr.left), font: cs.fontSize, weight: cs.fontWeight, rule: bs.borderBottomWidth + ' ' + bs.borderBottomColor, titleText: t.textContent };
        });
        rows.push({ id, theme, w: w.width, ...m });
        if (!m) app.findings.push(`${id}/${theme}@${w.name}: no page bar found`);
      }, { name: `${id}-${theme}` });
    }
  }
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
for (const r of rows) process.stdout.write(`MEASURE ${JSON.stringify(r)}\n`);
process.exit(await app.finish());
