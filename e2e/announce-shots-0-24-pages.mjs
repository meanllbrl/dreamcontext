/**
 * The v0.24.0 announcement's PAGE shots, separated from the strip shots.
 *
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots-0-24-pages.mjs
 *
 * Split from `announce-shots-0-24.mjs` on purpose: that script's value is that it
 * OPENS several real projects to build a genuine multi-project strip, which takes
 * a while and leaves modals behind. Re-shooting a page should not cost that, and a
 * page shot wants a clean single-project window anyway.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';
const ID = 'v0-24-0';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

function out(name) {
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

async function dismissScrims() {
  for (let i = 0; i < 3; i += 1) {
    const scrims = page.locator('.cmd-modal-scrim, .announcements-modal-scrim, .psw-modal');
    if (!(await scrims.count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}

async function openSidebar(label) {
  await dismissScrims();
  await page.locator('.sidebar-item', { hasText: label }).first().click();
  await page.waitForTimeout(2000);
}

async function crop(name, selector, maxHeight = 620) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.screenshot({
    path: out(name),
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, maxHeight) },
  });
  console.log('  ✓', name);
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: '.agent-dock { display: none !important }' });
await page.waitForTimeout(1800);
await dismissScrims();

for (const [label, name, selector] of [
  ['Automations', 'automations', '.automations-page, main'],
  ['Insights', 'insights', '.lab-page, .insights-page, main'],
  ['Hypotheses', 'hypotheses', '.hypotheses-page, .theses-board, main'],
]) {
  try {
    await openSidebar(label);
    await crop(name, selector);
  } catch (err) {
    console.log('  ! failed', name, '-', err.message.split('\n')[0]);
  }
}

await b.close();
console.log('done');
