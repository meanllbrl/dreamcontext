/**
 * Capture the v0.24.0 announcement screenshots.
 *
 * Run against a dashboard started on the REAL vault, in desktop mode so the
 * chip strip exists at all:
 *   npm run build
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots-0-24.mjs
 *
 * `chip-strip` is the full window (hero) — the release's headline IS the window.
 * Everything else is an element crop: a whole 1600px window scaled into a
 * split's half-column is unreadable.
 *
 * The strip is driven the way `scripts/verify/project-tabs.mjs` drives it —
 * `.project-tabs-add` opens the launcher, a row in it adds that project as a
 * chip — because that is the only path that produces a REAL multi-project strip
 * rather than a mocked one.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';
const ID = 'v0-24-0';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(name, target = page) {
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  console.log('  ✓', name);
}

// Every open project's pane stays MOUNTED in an off-screen garage — that is the
// whole point of the chip strip — so a bare selector matches a hidden pane
// belonging to another project and the camera shoots nothing. Scope to `:visible`.
async function crop(name, selector, maxHeight = 560) {
  const box = await page.locator(selector).locator('visible=true').first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({
    path,
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, maxHeight) },
  });
  console.log('  ✓', name);
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: '.agent-dock { display: none !important }' });
await page.waitForTimeout(1600);

// The What's New popup arrives on its own schedule and swallows clicks at the
// window level; Escape must dismiss it before anything else is driveable.
const scrim = page.locator('.announcements-modal-scrim');
if (await scrim.count()) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  if (await scrim.count()) await scrim.click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(700);
}

// Adding a project leaves the launcher's own scrim mounted, and it swallows
// pointer events at the window level — every later sidebar click retries for
// 30s against an element it can see but can never reach. Clear it first.
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
  await page.waitForTimeout(1600);
}

// --- The strip: add real projects so the hero is a genuine multi-project window.
// The launcher is `ProjectSwitcher` (`.psw-modal`): a filter input over `.psw-row`
// buttons. Type-then-click the named row rather than trusting row order — the
// list is re-ranked by recency, so an index would open a different project on a
// different day. If the row never appears the modal is dismissed, because a left
// -open scrim intercepts every later click at the window level.
async function addProject(name) {
  await page.locator('.project-tabs-add').click();
  await page.waitForSelector('.psw-modal', { timeout: 8000 });
  await page.locator('.psw-input').fill(name);
  await page.waitForTimeout(500);
  const row = page.locator('.psw-row', { hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: 6000 });
  await row.click();
  await page.waitForSelector('.psw-modal', { state: 'detached', timeout: 8000 });
  await page.waitForTimeout(2600);
  console.log('  + opened', name);
}

for (const name of (process.env.PROJECTS ?? 'Genevous,Tilki,kader-matematik').split(',')) {
  try {
    await addProject(name.trim());
  } catch (err) {
    console.log('  ! could not open', name, '-', err.message.split('\n')[0]);
    // Never leave the launcher open: its scrim swallows every later click.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
}

await page.waitForTimeout(1800);
await shot('chip-strip');
await crop('chip-status', '.project-tabs', 200);

// --- The rest of the release, on the real vault's real content.
await openSidebar('Insights');
await crop('insights', '.lab-page, .insights-page, main', 620);

await openSidebar('Hypotheses');
await crop('hypotheses', '.hypotheses-page, .theses-board, main', 620);

await b.close();
console.log('done');
