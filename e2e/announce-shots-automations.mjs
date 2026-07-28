/**
 * Capture the Automations screenshots for the v0.22.0 announcement story.
 *
 * Run against a dashboard started on the REAL vault:
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots-automations.mjs [zero|full]
 *
 * `zero` shoots the empty-state showcase and must run BEFORE any automation
 * exists; `full` shoots the board, the detail panel's pattern + run history,
 * and a run's session drill-in, and needs seeded automations.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';
const ID = process.env.SHOT_ID ?? 'v0-22-0-automations';
const MODE = process.argv[2] ?? 'full';
const VIEW = { width: 1600, height: 1000 };

const b = await chromium.launch();
const page = await b.newPage({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(name, target = page) {
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  console.log('  ✓', name);
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
// The author's own docked sessions float over every page and read as clutter
// in someone else's release notes.
await page.addStyleTag({ content: '.agent-dock { display: none !important }' });
await page.waitForTimeout(1600);

// The unread-announcement popup fires on load and its scrim swallows every
// click underneath it — dismiss it before driving anything.
const scrim = page.locator('.announcements-modal-scrim');
if (await scrim.count()) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  if (await scrim.count()) await scrim.click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(700);
}

await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
await page.waitForTimeout(1400);

if (MODE === 'zero') {
  await shot('zero-state');
  await b.close();
  console.log('zero-state captured');
  process.exit(0);
}

// Wait on the DOM, not a stopwatch: the board paints before its fetch lands.
await page.locator('.auto-card').first().waitFor({ timeout: 20000 }).catch(() => {});
await page.waitForTimeout(900);
// The cards sit in one row at the top of an otherwise empty page, so the grid
// is the shot, not the window.
await shot('board', page.locator('.auto-board-grid').first());

// ── Detail panel: the pattern and the run history ───────────────────────────
const row = page.locator('.auto-card').first();
if (await row.count()) {
  await row.click();
  await page.waitForTimeout(1500);
  await shot('detail');

  // A split gives its image about half a 920px column, so the detail crops are
  // element shots, not whole windows scaled down to illegibility.
  const pattern = page.locator('.adp-pattern').first();
  if (await pattern.count()) {
    await pattern.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot('pattern', pattern);
  }

  const history = page.locator('.adp-history').first();
  if (await history.count()) await shot('history', history);

  // ── Session drill-in on a run that actually had one ───────────────────────
  const sessionBtn = page.locator('.adp-history-session').first();
  if (await sessionBtn.count()) {
    await sessionBtn.click();
    await page.waitForTimeout(1800);
    await shot('session');
    // Scroll past the system prompt to the tool calls — the failures are the
    // point of the drill-in, and they are below the fold.
    // Anchor on where the tool calls START, not on a scroll fraction and not on
    // a single failed call — either lands wherever the longest assistant turn
    // happens to be, and the point of the drill-in is the RUN of calls.
    const items = page.locator('.adp-session-items').first();
    const shown = await items.evaluate((el) => {
      const first = el.querySelector('.adp-session-tool-arg');
      if (!first) return false;
      const top = first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTop = Math.max(0, top - 40);
      return true;
    });
    if (shown) {
      await page.waitForTimeout(700);
      await shot('session-tools', page.locator('.adp-session').first());
    } else {
      console.log('  ! no tool calls to anchor on');
    }
  } else {
    console.log('  ! no Session button found');
  }
} else {
  console.log('  ! no automation row found');
}

await b.close();
console.log('done');
