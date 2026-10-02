/**
 * Capture the v0.30.0 announcement screenshots — the release where Insights became
 * boards you build, and the agents got a channel.
 *
 * Run against a dashboard serving THIS CUT's own build over the fictional "orbit"
 * demo vault (fake HOME, nothing real on screen):
 *   npm run build
 *   ROOT=/tmp/dc-ann-030 ./marketing/build-demo-vault-v2.sh
 *   (then seed the Growth board, the Funnels board with the funnel-explorer preset over
 *    scripts/verify/fixtures/funnel-explorer-demo.mjs, and the "Trial-to-paid war room"
 *    whiteboard — the commands are in the 0.30.0 pre-publish checklist task)
 *   (cd /tmp/dc-ann-030/proj && HOME=/tmp/dc-ann-030/home DREAMCONTEXT_DESKTOP=1 \
 *      node <repo>/dist/index.js dashboard --no-open -p 45930)
 *   BASE=http://127.0.0.1:45930 node e2e/announce-shots-0-30.mjs
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that cannot be reached is reported and skipped, so
 * the story is built from what was actually captured.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45930';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';
const ID = 'v0-30-0';
const VAULT = process.env.DEMO_VAULT ?? 'orbit';
const ONLY = (process.env.ONLY ?? 'all').split(',');
const on = (g) => ONLY.includes('all') || ONLY.includes(g);

const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab{display:none!important}`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await page.addInitScript(() => localStorage.setItem('dreamcontext-theme', 'dark'));
page.setDefaultTimeout(15000);

const captured = [];
const failed = [];
const sleep = (ms) => page.waitForTimeout(ms);

async function shot(name) {
  await page.addStyleTag({ content: CLEAN });
  await sleep(500);
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
  captured.push(name);
  console.log('  ✓', name);
}

async function scene(name, fn) {
  if (!on(name)) return;
  try { await fn(); } catch (e) { failed.push(name); console.log('  ✗', name, String(e).slice(0, 200)); }
}

async function home() {
  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
  await sleep(1200);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(200); }
  await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));
}

async function insights(board) {
  await home();
  await page.locator('.sidebar-item[title^="Insights"]').first().click();
  const tab = page.locator(`[data-lab-board-tab="${board}"]`).first();
  await tab.waitFor({ timeout: 15000 });
  await tab.click();
  await page.locator(`[data-lab-board="${board}"]`).waitFor({ timeout: 15000 });
  await sleep(2000);
}

await scene('board', async () => {
  await insights('growth');
  await shot('board');
});

await scene('inspector', async () => {
  await insights('growth');
  const toggle = page.locator('[data-lab-edit-toggle]').first();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await sleep(400);
  const card = page.locator('[data-lab-card="c-pay"]');
  await card.locator('[data-lab-card-menu]').first().click();
  await page.locator('[data-lab-menu-item="edit-blocks"]').first().click();
  const insp = page.locator('[data-lab-inspector]').first();
  await insp.waitFor({ timeout: 8000 });
  if (await insp.locator('[data-lab-inspector-block="0"]').count()) await insp.locator('[data-lab-inspector-block="0"]').first().click();
  await sleep(800);
  await shot('inspector');
});

await scene('explorer', async () => {
  await insights('funnels');
  await shot('explorer');
});

await scene('whiteboard', async () => {
  await home();
  await page.locator('.sidebar-item[title^="Whiteboard"]').first().click();
  await sleep(1500);
  // The page opens on the default board; the war room is one pick away in the switcher.
  await page.locator('.wbs-current').first().click();
  await sleep(600);
  await page.locator('.wbs-list [role="option"]', { hasText: 'Trial-to-paid war room' }).first().click();
  await sleep(3500);
  await shot('whiteboard');
});

await b.close();
console.log(`\ncaptured ${captured.length}: ${captured.join(', ')}${failed.length ? `\nFAILED: ${failed.join(', ')}` : ''}`);
