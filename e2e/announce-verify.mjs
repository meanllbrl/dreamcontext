/**
 * Verification pass for the What's New feed: opens every release in the reader,
 * scrolls it, and reports any screenshot that failed to load. A broken shot path
 * renders as NOTHING in the story, so a missing picture is silent — this is what
 * catches it.
 *
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777 &
 *   node e2e/announce-verify.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const OUT = process.env.OUT ?? '/tmp/announce-verify';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const failed = [];
page.on('requestfailed', (r) => { if (r.url().includes('/announcements/')) failed.push(r.url()); });
page.on('response', (r) => { if (r.url().includes('/announcements/') && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'domcontentloaded' });
await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
await page.addStyleTag({ content: '.agent-dock { display: none !important; }' });

// The popup fires on the newest unread release — photograph it, then dismiss.
const modal = page.locator('.announcements-modal');
if (await modal.count()) {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, 'popup.png') });
  await page.locator('.announcements-modal-close').click();
  await page.waitForTimeout(800);
}

await page.locator('.sidebar-item', { hasText: 'Announcements' }).first().click();
await page.locator('.announcements-hero').first().waitFor({ timeout: 15000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: join(OUT, 'feed.png') });

const versions = await page
  .locator('.announcements-hero-version, .announcement-row-version')
  .allTextContents();
console.log('feed versions:', versions.join('  '));

// Open the newest release, then page through every older one with "Older →".
await page.locator('.announcement-story-teaser').first().click();
await page.locator('.announcement-reader').first().waitFor({ timeout: 15000 });

for (let i = 0; i < versions.length; i++) {
  await page.waitForTimeout(1800);
  const version = (await page.locator('.announcement-reader-version').first().textContent())?.trim();
  const reader = page.locator('.announcement-reader').first();

  // Count rendered story images vs the shots the document declares.
  const imgs = await reader.locator('img').evaluateAll((els) =>
    els.map((el) => ({ src: el.getAttribute('src'), ok: el.naturalWidth > 0 })),
  );
  const broken = imgs.filter((i) => !i.ok).map((i) => i.src);
  console.log(`${version}: ${imgs.length} images, ${broken.length} broken${broken.length ? ' → ' + broken.join(', ') : ''}`);

  await page.screenshot({ path: join(OUT, `${version}-top.png`) });
  await reader.evaluate((el) => el.scrollBy(0, el.scrollHeight));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, `${version}-bottom.png`) });

  const older = page.locator('.announcement-reader-pager-btn', { hasText: 'Older' });
  if (await older.isDisabled()) break;
  await older.click();
}

console.log(failed.length ? `FAILED REQUESTS:\n  ${failed.join('\n  ')}` : 'no failed announcement requests');
await b.close();
