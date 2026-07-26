/**
 * Screenshots for the version-grouped What's New feed (0.22): the surfaces the
 * v0.20.0 and v0.22.0 release stories claim things about.
 *
 * Run AFTER `npm run build`, against a dashboard serving a real vault, so the
 * Hypotheses board and the funnel view have actual content in them:
 *
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777 &
 *   node e2e/announce-shots-versions.mjs
 *
 * The What's New shots are the only pass whose subject is the feature being
 * announced, so they must run once the new stories are already authored.
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

async function nav(label) {
  await page.locator('.sidebar-item', { hasText: label }).first().click();
  await page.waitForTimeout(2000);
}

// `networkidle` is unreliable here: the dashboard holds a live websocket, so
// "no network for 500ms" depends on whether an agent happens to be talking.
// Wait on the shell being painted instead.
await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'domcontentloaded' });
await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);

// The author's own docked agent sessions float over every page. They are real
// UI, but in these shots they are somebody else's session names sitting on top
// of the subject — hide the dock rather than photograph it.
await page.addStyleTag({ content: '.agent-dock { display: none !important; }' });

// The on-load What's New popup fires on the newest unread release — dismiss it
// so the pages behind are photographed clean.
const modal = page.locator('.announcements-modal');
if (await modal.count()) {
  await page.locator('.announcements-modal-close').click();
  await page.waitForTimeout(800);
}

// ─── v0.20.0: the proactive learning layer ───────────────────────────────────
await nav('Hypotheses');
await page.locator('.thb-summary').first().waitFor({ timeout: 15000 });
await page.waitForTimeout(1200);
await shot('v0-20-0/hypotheses.png');

// One thesis open: claim, confidence, registered predictions, evidence ledger.
// Deliberately a thesis that has been THROUGH the loop — a draft with an empty
// ledger photographs the form, not the mechanism.
const settled = page.locator('.thc-card', { hasText: 'supporting' }).filter({ hasNotText: '0 supporting' });
await ((await settled.count()) ? settled.first() : page.locator('.thc-card').first()).click();
await page.locator('.td-claim').first().waitFor({ timeout: 10000 });
await page.waitForTimeout(1500);
await shot('v0-20-0/thesis.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(800);

// ─── v0.20.0: funnels in Lab ─────────────────────────────────────────────────
await nav('Insights');
const funnelCard = page.locator('.lab-card', { hasText: 'unnel' }).first();
if (await funnelCard.count()) {
  await funnelCard.click();
  await page.waitForTimeout(2500);
  // The overview routes to a per-funnel step lane; take the lane if we get one,
  // the comparison table otherwise.
  const firstFunnel = page.locator('.funnel-ovw table tbody tr, .funnel-ovw-row').first();
  if (await firstFunnel.count()) {
    await firstFunnel.click();
    await page.waitForTimeout(2500);
  }
  // The lane is wide and short; the page around it is mostly empty. Crop to the
  // breadcrumb → step lane → metrics panel so the shot is all signal.
  await page.screenshot({
    path: join(ROOT, 'v0-20-0/funnel.png'),
    clip: { x: 250, y: 64, width: 1330, height: 390 },
  });
  console.log('  ✓ v0-20-0/funnel.png');
} else {
  console.log('  ! no funnel insight found — skipping v0-20-0/funnel.png');
}

// ─── v0.22.0: What's New as a release history ────────────────────────────────
await nav('Announcements');
await page.locator('.announcements-hero').first().waitFor({ timeout: 10000 });
await page.waitForTimeout(2000);
await shot('v0-22-0/whats-new.png');

// ─── v0.20.0: a release open in the full-screen reader ───────────────────────
await page.locator('.announcement-story-teaser').first().click();
await page.locator('.announcement-reader').first().waitFor({ timeout: 10000 });
await page.waitForTimeout(2500);
await shot('v0-20-0/reader.png');

await b.close();
console.log('done');
