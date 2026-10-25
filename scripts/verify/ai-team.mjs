#!/usr/bin/env node
/**
 * AI Team — the page in a real browser, against a running scratch dashboard.
 *
 *   node scripts/verify/ai-team.mjs <base-url> <vault> [outDir]
 *
 * The server and its vault are the caller's (a fake HOME, seeded with fictional teammates).
 * For each theme (light, dark) and width (1440 desktop, 390 phone) it opens the AI Team from
 * the rail and takes the screens the board `ai-team-ekranlari` drew: the conversation with a
 * question waiting, the Routines panel, the temporary model picker, a routine set up from the
 * chat, and on the phone the list, then one conversation. Page errors and console errors are
 * collected and printed; any one fails the run.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { dispatcherState, mockDispatcher, setTheme } from './lib/measure.mjs';

const [base, vault, outArg] = process.argv.slice(2);
if (!base || !vault) {
  console.error('usage: ai-team.mjs <base-url> <vault> [outDir]');
  process.exit(2);
}
const OUT = outArg ?? join(process.cwd(), 'tmp', 'verify-shots', 'ai-team');
mkdirSync(OUT, { recursive: true });

const errors = [];
const shots = [];

async function open(browser, theme, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2 });
  await setTheme(context, theme);
  // What's New popups out of the way, and the scheduler reported as on (a fake HOME has none).
  await context.addInitScript(() => { try { localStorage.setItem('dreamcontext.announcements.seen', '9999'); } catch { /* private */ } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${theme}/${width} pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${theme}/${width} console: ${m.text()}`); });
  await mockDispatcher(page, dispatcherState());
  await page.goto(`${base}/?vault=${encodeURIComponent(vault)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 4 && (await page.locator('.announcements-modal-scrim').count()); i++) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  }
  return { context, page };
}

async function shot(page, name) {
  await page.waitForTimeout(600);
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  shots.push(path);
}

async function openTeam(page, phone) {
  if (phone) {
    // The phone's rail is a drawer behind the top bar's menu button.
    const menu = page.locator('.phone-bar button').first();
    if (await menu.count()) { await menu.click(); await page.waitForTimeout(400); }
  }
  await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^AI Team$/ }) }).first().click();
  await page.locator('.aiteam').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
}

/**
 * A teammate opens on its conversation (AI Team v2: the real Chat pane); the routines' activity
 * these screens are about is one click away ("See activity" in its header).
 */
async function toActivity(page) {
  if (!(await page.locator('.aiteam-stage').first().isVisible().catch(() => false))) return;
  await page.locator('[data-team-activity]').first().click();
  await page.locator('[data-team-stage]').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
}

const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    // ── desktop ──
    {
      const { context, page } = await open(browser, theme, 1440, 900);
      await openTeam(page, false);
      await shot(page, `1440-${theme}-0-stage`);
      await toActivity(page);
      await shot(page, `1440-${theme}-1-conversation`);
      await page.locator('[data-team-routines]').click();
      await page.locator('.aiteam-panel').waitFor();
      await shot(page, `1440-${theme}-2-routines`);
      await page.locator('.aiteam-panel-close').click();
      // The temporary model: open the trigger and pick another model.
      await page.locator('[data-team-row="sabah-brifingi"]').click();
      await page.waitForTimeout(800);
      await toActivity(page);
      await page.locator('.chat-cmp-modeltrigger').click();
      await page.locator('.chat-cmp-modelmenu').waitFor();
      await shot(page, `1440-${theme}-3-model-menu`);
      await page.locator('.chat-cmp-modelrow').filter({ hasText: /Sonnet/ }).first().click();
      await page.locator('.aiteam-temp').waitFor();
      await shot(page, `1440-${theme}-4-model-temporary`);
      await page.locator('.aiteam-temp .aiteam-linkbtn').click();
      await page.locator('[data-team-row="arastirmaci"]').click();
      await page.waitForTimeout(800);
      await toActivity(page);
      await page.locator('[data-team-event]').first().waitFor();
      await shot(page, `1440-${theme}-5-routine-created`);
      await page.locator('.aiteam-newbtn').click();
      await page.locator('.aiteam-new').waitFor();
      await shot(page, `1440-${theme}-6-new-teammate`);
      await context.close();
    }
    // ── phone ──
    {
      const { context, page } = await open(browser, theme, 390, 844);
      await openTeam(page, true);
      await shot(page, `390-${theme}-1-list`);
      await page.locator('[data-team-row="buyume-analisti"]').click();
      await page.locator('.aiteam-stage').first().waitFor();
      await shot(page, `390-${theme}-2-stage`);
      await toActivity(page);
      await shot(page, `390-${theme}-2-conversation`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}

console.log(shots.join('\n'));
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log('\nconsole clean');
