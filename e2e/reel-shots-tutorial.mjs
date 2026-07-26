/** Capture the DEMO VAULT ("orbit") roadmap surface for the tutorial video. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4401';
const ROOT = 'marketing/remotion/capture';
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"]{display:none!important}`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
async function shot(rel) {
  const p = join(ROOT, rel); mkdirSync(dirname(p), { recursive: true });
  await page.addStyleTag({ content: CLEAN });
  await page.screenshot({ path: p }); console.log('  ✓', rel);
}
async function until(label, fn, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) { console.log('  ·', label); return true; } await page.waitForTimeout(900); }
  console.log('  ·', label, '— TIMED OUT'); return false;
}

await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }

await page.locator('.sidebar-item', { hasText: 'Roadmap' }).first().click();
await until('board resolved', async () => {
  const t = await page.locator('body').innerText();
  return /41/.test(t) && /Ship the public beta/.test(t);
});
await page.waitForTimeout(1500);
await shot('d1-board.png');

await page.locator('.sidebar-item', { hasText: 'Insights' }).first().click();
await until('insights', async () => /Paying customers/.test(await page.locator('body').innerText()), 20000);
await page.waitForTimeout(1500);
await shot('d2-insights.png');

await b.close(); console.log('done');
