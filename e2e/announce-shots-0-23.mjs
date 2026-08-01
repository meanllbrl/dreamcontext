/**
 * Capture the v0.23.0 announcement screenshots.
 *
 * Run against a dashboard started on the REAL vault:
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots-0-23.mjs
 *
 * `core` is the full window (hero). `people` and `patterns` are element crops —
 * a whole 1600px window scaled into a split's half-column is unreadable.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';
const ID = 'v0-23-0';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(name, target = page) {
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  console.log('  ✓', name);
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: '.agent-dock { display: none !important }' });
await page.waitForTimeout(1600);

const scrim = page.locator('.announcements-modal-scrim');
if (await scrim.count()) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  if (await scrim.count()) await scrim.click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(700);
}

async function openSidebar(label) {
  await page.locator('.sidebar-item', { hasText: label }).first().click();
  await page.waitForTimeout(1600);
}

// Hero — the whole Core page: a PEOPLE roster where 1.user.md used to be.
await openSidebar('Core');
await shot('core');
// Crop tight to the populated rows — the list is a full-height column with a
// lot of empty space below taxonomy, and a split would scale that to nothing.
// Read the real box rather than guessing pixels.
const listBox = await page.locator('.core-list').boundingBox();
const lastRow = await page.locator('.core-list >> text=taxonomy').first().boundingBox();
await page.screenshot({
  path: join(ROOT, ID, 'people.png'),
  clip: {
    x: listBox.x,
    y: listBox.y,
    width: listBox.width,
    height: Math.min(lastRow.y + lastRow.height + 12 - listBox.y, 560),
  },
});
console.log('  \u2713 people');

// Patterns now carry the project's conditional rules as their own folder.
await openSidebar('Knowledge');
await page.locator('text=Patterns').first().click();
await page.waitForTimeout(1400);
// Clip the folder+card column: the right reader pane is empty until a file is
// picked, and a split gives this about half a 920px column. Read the real box —
// guessed pixel offsets clipped the labels on the first pass. Cap the height so
// the crop stays roughly square rather than a very tall ribbon.
const kBox = await page.locator('.bsearch-list').boundingBox();
await page.screenshot({
  path: join(ROOT, ID, 'patterns.png'),
  clip: { x: kBox.x, y: kBox.y, width: kBox.width, height: Math.min(kBox.height, 560) },
});
console.log('  \u2713 patterns');

await b.close();
console.log('done');
