/**
 * Look at the shipped announcement feed the way a reader does: the page, then
 * the 0.22.0 story scrolled top to bottom.
 *
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-verify-0-22.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const OUT = 'e2e/shots/verify-0-22';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: 'dark' });

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: '.agent-dock { display: none !important }' });
await page.waitForTimeout(1500);

// The popup is itself part of what we are verifying.
const scrim = page.locator('.announcements-modal-scrim');
if (await scrim.count()) {
  await page.screenshot({ path: `${OUT}/popup.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  if (await scrim.count()) await scrim.click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(600);
}

await page.locator('.sidebar-item', { hasText: 'Announcements' }).first().click();
await page.waitForTimeout(1400);
await page.screenshot({ path: `${OUT}/feed.png` });

// Open the newest release and walk down it.
const hero = page.locator('.ann-hero-card, .announcement-card, .ann-card').first();
if (await hero.count()) {
  await hero.click();
  await page.waitForTimeout(1600);
  for (let i = 0; i < 5; i++) {
    await page.screenshot({ path: `${OUT}/story-${i}.png` });
    await page.mouse.wheel(0, 950);
    await page.waitForTimeout(700);
  }
} else {
  console.log('! no announcement card found');
}

await b.close();
console.log('verify shots in', OUT);
