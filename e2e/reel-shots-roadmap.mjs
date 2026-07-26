/**
 * Capture the LIVE Roadmap surface for the roadmap feature video.
 * Waits on DOM CONTENT (real progress labels), never a stopwatch — the roadmap
 * query resolves after the objectives list, so a timed shot catches "no tasks".
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4399';
const ROOT = 'marketing/remotion/capture';
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"]{display:none!important}`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(rel) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  await page.addStyleTag({ content: CLEAN });
  await page.screenshot({ path });
  console.log('  ✓', rel);
}
async function until(label, fn, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) { console.log(`  · ${label}`); return true; }
    await page.waitForTimeout(1000);
  }
  console.log(`  · ${label} — TIMED OUT`);
  return false;
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
for (let i = 0; i < 4; i++) {
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);
  if (!(await page.locator('.announcements-modal-scrim').count())) break;
}

await page.locator('.sidebar-item', { hasText: 'Tasks' }).first().click();
await until('tasks board loaded', async () => (await page.locator('text=/To Do/').count()) > 0);
await page.waitForTimeout(1200);
await shot('c1-tasks.png');

await page.locator('.sidebar-item', { hasText: 'Roadmap' }).first().click();
// the real proof the join resolved: the KR metric label and a done/total ratio
await until('roadmap progress resolved', async () => {
  const t = await page.locator('body').innerText();
  return /857/.test(t) && /13\/13|35\/40/.test(t);
});
await page.waitForTimeout(1500);
await shot('c2-timeline.png');

for (const [name, label] of [['c3-business', 'Make it a Business'], ['c4-helloworld', 'Hello World PR']]) {
  try {
    await page.getByText(new RegExp(`^${label}$`)).first().click({ force: true });
    await until(`${label} panel`, async () => (await page.locator('[class*="detail-panel"],[class*="ObjectiveDetail"],aside').count()) > 0, 15000);
    await page.waitForTimeout(1800);
    await shot(`${name}.png`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1400);
  } catch (e) { console.log(`  ✗ ${name}:`, e.message.slice(0, 90)); }
}
await b.close();
console.log('done');
