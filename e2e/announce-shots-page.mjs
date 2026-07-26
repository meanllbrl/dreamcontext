/**
 * Third and last screenshot pass: the Announcements surfaces photographing
 * THEMSELVES — the feed page and the full-screen reader — for the story that
 * announces them.
 *
 * Runs after the stories are authored and the dashboard is rebuilt, because it
 * is the only pass whose subject is the new format itself.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(rel, target = page) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  console.log('  ✓', rel);
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// The on-load What's New popup fires on the newest unread story — dismiss it so
// the feed behind is photographed clean (it gets its own shot first).
const modal = page.locator('.announcements-modal');
if (await modal.count()) {
  await page.waitForTimeout(1500);
  await shot('announcements/popup.png');
  await page.locator('.announcements-modal-close').click();
  await page.waitForTimeout(800);
}

await page.locator('.sidebar-item', { hasText: 'Announcements' }).first().click();
await page.waitForTimeout(2500);
await shot('announcements/page.png');

// Open the newest story in the full-screen reader.
await page.locator('.announcement-story-teaser').first().click();
await page.waitForTimeout(2500);
await shot('announcements/reader.png');

// And scrolled down, where the screenshots and blocks live.
await page.locator('.announcement-reader').first().evaluate((el) => el.scrollBy(0, 900));
await page.waitForTimeout(1200);
await shot('announcements/reader-blocks.png');

await b.close();
console.log('done');
