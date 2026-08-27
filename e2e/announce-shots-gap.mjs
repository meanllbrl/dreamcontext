#!/usr/bin/env node
/**
 * Capture the scenes the 0.25.0 and 0.26.1 stories claim but never showed.
 *
 * The audit that prompted this: eleven user-facing items shipped between 0.24.1
 * (the last version npm has) and 0.26.1, and the feed named none of them. Some
 * were missing outright; the rest were listed in an "Also in this release" block
 * with no picture under them, which the announcements skill explicitly calls out
 * as not good enough — "either shoot it, or leave it to the changelog".
 *
 * These scenes run against the PRODUCT'S OWN vault, not the demo set: every Lab
 * insight in this repo is a `demo-*` fixture with synthetic numbers, so the
 * surface photographs with real structure and no real data. The test for shooting
 * outside the demo home is not "is it my project" but "is anything on this screen
 * somebody's private information".
 *
 *   npm run build
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots-gap.mjs
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that can't be reached is reported and skipped,
 * so one broken selector doesn't cost the whole run.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});

const captured = [];
const vis = (sel) => page.locator(sel).locator('visible=true');

/** The author's own docked session names float over every page and read as
 *  clutter in someone else's release notes. */
const HIDE_DOCK = '.agent-dock, .agent-fab { display: none !important; }';

async function shot(id, name) {
  const path = join(ROOT, id, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
  captured.push(`${id}/${name}`);
  console.log('  ✓', id, name);
}

/** A fixed-region crop, for surfaces whose content has no stable wrapper class.
 *  Coordinates are CSS pixels in the 1600×1000 viewport above. */
async function clip(id, name, box) {
  const path = join(ROOT, id, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, clip: box });
  captured.push(`${id}/${name}`);
  console.log('  ✓', id, name);
}

async function crop(id, name, selector, opts = {}) {
  const box = await vis(selector).first().boundingBox();
  if (!box) throw new Error('no box for ' + selector);
  const pad = opts.pad ?? 12;
  const path = join(ROOT, id, `${name}.png`);
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
  captured.push(`${id}/${name}`);
  console.log('  ✓', id, name);
}

async function scene(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.log('  ! skipped', label, '-', String(err.message).split('\n')[0]);
  }
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const gotIt = page.getByRole('button', { name: 'Got it' });
if (await gotIt.count()) await gotIt.first().click().catch(() => {});
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// ─── v0.26.1 · Lab `render: app` — the multi-page interactive insight ─────────
// The release shipped script-authored apps (dataset/v1 + app/v1 over a sandboxed
// postMessage bridge) and the story never mentioned them once.
await scene('lab-app', async () => {
  await page.getByText(/^Insights$/).first().click();
  await page.waitForTimeout(2500);
  await page.getByText(/Demo: Acquisition Report/).first().click();
  await page.waitForTimeout(3500);
  await page.addStyleTag({ content: HIDE_DOCK });
  await page.waitForTimeout(1000);
  // CROPPED, not the whole window: an app body is short, so a full 1600×1000 frame
  // is two-thirds empty canvas — and a `split` block gives its image about half a
  // 920px column, where that empty canvas is all you would be able to see.
  await clip('v0-26-1', 'lab-app', { x: 240, y: 66, width: 1345, height: 360 });
});

// The SECOND page — what makes it an app rather than a chart.
// Driven from the HOST's page rail, not the in-body "Retention by cohort →" button:
// that button lives inside the sandboxed iframe, so a page-level getByText never
// reaches it. (The button does work — it calls lab.navigate() over the bridge — it
// just needs a frameLocator to click from out here, and the rail proves the same
// routing with one less moving part.)
await scene('lab-app-page2', async () => {
  await page.getByRole('tab', { name: /Retention/ }).first().click();
  await page.waitForTimeout(2000);
  await clip('v0-26-1', 'lab-app-page2', { x: 240, y: 66, width: 1345, height: 360 });
});

await browser.close();
console.log('captured:', captured.join(', ') || '(none)');
