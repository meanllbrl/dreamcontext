/** Look at the shipped v0.24.0 story in the real app. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' });
await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: '.agent-dock { display: none !important }' });
await page.waitForTimeout(1800);
for (let i=0;i<3;i++){ const s=page.locator('.cmd-modal-scrim, .announcements-modal-scrim, .psw-modal'); if(!(await s.count())) break; await page.keyboard.press('Escape'); await page.waitForTimeout(600); }
await page.locator('.sidebar-item', { hasText: 'Announcements' }).first().click();
await page.waitForTimeout(2000);
mkdirSync('tmp/verify', { recursive: true });
await page.screenshot({ path: 'tmp/verify/ann-feed.png' });
await page.locator('text=Every project you have open').first().click();
await page.waitForTimeout(2000);
await page.screenshot({ path: 'tmp/verify/ann-story-top.png' });
for (const n of [1, 2, 3]) {
  await page.mouse.wheel(0, 1700);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `tmp/verify/ann-story-${n}.png` });
}
const imgs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('img')).map(i => ({ src: i.getAttribute('src'), ok: i.naturalWidth > 0 })));
console.log(JSON.stringify(imgs));
await b.close();
