/**
 * Reel v4 — the composer close-up at DPR 3: the question typed character by character into
 * the chat composer and NEVER sent (no Claude turn, no cost), clipped to the composer box.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const BASE = 'http://127.0.0.1:45911';
const OUT = 'marketing/remotion/capture-v4/composer3';
const QUESTION = 'Trial-to-paid dropped this week. What changed?';
mkdirSync(OUT, { recursive: true });
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab,.auto-dispatch-pill,.sleep-tracker-wrap{display:none!important}`;
const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3, colorScheme: 'light' });
await page.addInitScript(() => localStorage.setItem('dreamcontext-theme', 'light'));
await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar-item', { timeout: 30000 });
await page.waitForTimeout(1500);
for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));
await page.locator('.sidebar-item').filter({ has: page.getByText('Chat', { exact: true }) }).first().click();
const end = Date.now() + 60000;
while (Date.now() < end && !(await page.locator('textarea').count())) await page.waitForTimeout(600);
await page.waitForTimeout(2000);
await page.addStyleTag({ content: CLEAN });
const input = page.locator('textarea').last();
await input.click();
await input.fill('');
const body = await page.locator('body').innerText();
if (/account changed|@gmail/i.test(body)) console.log('!! banner present');
const ta = await input.boundingBox();
console.log('textarea', ta);
const clip = { x: 226, y: 766, width: 1208, height: 134 };
await page.mouse.move(700, 300);
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'empty.png'), clip });
for (let i = 0; i < QUESTION.length; i++) {
  await page.keyboard.type(QUESTION[i]);
  await page.waitForTimeout(40);
  await page.screenshot({ path: join(OUT, `t${String(i + 1).padStart(3, '0')}.png`), clip });
}
// leave the composer as we found it: nothing is sent
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
await page.keyboard.press('Backspace');
await b.close();
console.log('done');
