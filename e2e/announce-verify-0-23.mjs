/** Look at the shipped v0.23.0 story in the real app. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' });
await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: '.agent-dock { display: none !important }' });
await page.waitForTimeout(1600);
const scrim = page.locator('.announcements-modal-scrim');
if (await scrim.count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(700); }
await page.locator('.sidebar-item', { hasText: 'Announcements' }).first().click();
await page.waitForTimeout(1800);
mkdirSync('tmp', { recursive: true });
await page.screenshot({ path: 'tmp/verify-feed.png' });
// Open the newest story.
await page.locator('text=Everything your agent knows').first().click();
await page.waitForTimeout(1800);
await page.screenshot({ path: 'tmp/verify-story-top.png' });
for (const n of [1, 2, 3]) {
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `tmp/verify-story-${n}.png` });
}
// A broken shot renders as nothing — count what actually loaded.
const imgs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('img')).map(i => ({ src: i.getAttribute('src'), ok: i.naturalWidth > 0 })));
console.log(JSON.stringify(imgs, null, 1));
await b.close();
