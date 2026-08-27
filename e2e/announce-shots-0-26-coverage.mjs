/**
 * Capture the 0.26.x scenes the first cut of the v0.26.1 story left out.
 *
 * The story shipped covering peer mail, the Meeting Room and vault logos — and
 * nothing else, while the same window also delivered the Lab reporting rework and
 * the agent-written-HTML chat surface. A release history that names a third of a
 * release is the hole this closes.
 *
 * These scenes run against the PRODUCT'S OWN vault, not the demo set: every Lab
 * insight in this repo is a `demo-*` fixture with synthetic numbers (example.com
 * URLs, invented MRR), so the surface photographs with real structure and no real
 * data. That is the test for shooting anywhere but the demo home — not "is it my
 * project" but "is anything on this screen somebody's private information".
 *
 *   npm run build
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots-0-26-coverage.mjs
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that can't be reached is reported and skipped.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';
const ID = 'v0-26-1';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const captured = [];
const vis = (sel) => page.locator(sel).locator('visible=true');

async function shot(name) {
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
  captured.push(name);
  console.log('  ✓', name);
}

async function crop(name, selector, opts = {}) {
  const box = await vis(selector).first().boundingBox();
  if (!box) throw new Error('no box for ' + selector);
  const pad = opts.pad ?? 12;
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({
    path,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(1600, box.width + pad * 2),
      height: Math.min(opts.maxHeight ?? 1000, box.height + pad * 2),
    },
  });
  captured.push(name);
  console.log('  ✓', name);
}

async function dismissScrims() {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.count()) {
    await gotIt.first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
}

const HIDE_DOCK = '.agent-dock, .agent-fab { display: none !important; }';

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await dismissScrims();

// ─── Lab: the board, and what a render actually looks like ──────────────────
try {
  await page.getByText(/^Insights$/).first().click();
  await page.waitForTimeout(3000);
  await page.addStyleTag({ content: HIDE_DOCK });
  await page.waitForTimeout(800);
  await shot('lab-board');
} catch (err) {
  console.log('  ! skipped lab-board -', err.message.split('\n')[0]);
}

// The funnel is the render with the most structure on screen — steps, drop-offs and
// the metric rail beside them — so it carries the "Lab reads like a report" claim.
try {
  await page.getByText(/Demo: Onboarding Funnels/).first().click();
  await page.waitForTimeout(3000);
  await page.addStyleTag({ content: HIDE_DOCK });
  await page.waitForTimeout(800);
  await shot('lab-funnel');
} catch (err) {
  console.log('  ! skipped lab-funnel -', err.message.split('\n')[0]);
}

await b.close();
console.log('captured:', captured.join(', ') || '(none)');
