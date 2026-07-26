/**
 * Refinement pass: re-capture the shots that sit in a SPLIT block as element
 * crops rather than whole windows.
 *
 * A split gives its screenshot about half of a 920px column. A full 1600px
 * window scaled into that is legible as "a picture of the app" but not as the
 * control it is pointing at, which defeats the block. Cropping to the panel
 * keeps the same pixels at three times the size.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(rel, target) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  console.log('  ✓', rel);
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const modalClose = page.locator('.announcements-modal-close');
if (await modalClose.count()) { await modalClose.click(); await page.waitForTimeout(600); }

// Settings → Agents, cropped to the section card itself.
await page.locator('.sidebar-item', { hasText: 'Settings' }).first().click();
await page.waitForTimeout(1000);
await page.locator('.settings-nav-item').filter({ hasText: /^Agents/ }).first().click();
await page.waitForTimeout(1000);
await shot('v0-22-0/settings.png', page.locator('.settings-section').first());

// The ＋ New menu, cropped to the split button and its open menu.
for (let i = 0; i < 2; i++) {
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
  await page.waitForTimeout(90);
}
await page.waitForTimeout(1500);
await page.locator('.agent-add-caret').first().click();
await page.waitForTimeout(700);
const split = page.locator('.agent-new-split').first();
const box = await split.boundingBox();
if (box) {
  const path = join(ROOT, 'chat-is-the-default/new-menu.png');
  mkdirSync(dirname(path), { recursive: true });
  // The menu is absolutely positioned UNDER the button, so the element box alone
  // clips it — screenshot the region instead, with room for the popup and a
  // margin of surrounding chrome for context.
  await page.screenshot({
    path,
    clip: {
      x: Math.max(0, box.x - 150),
      y: Math.max(0, box.y - 20),
      width: Math.min(1600 - Math.max(0, box.x - 150), box.width + 190),
      height: 250,
    },
  });
  console.log('  ✓ chat-is-the-default/new-menu.png');
}

await b.close();
console.log('done');
