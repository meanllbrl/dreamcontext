/**
 * HERO capture: a person says what they want in Chat; Claude proposes the objective
 * and asks before writing (proactive capture protocol). Real Claude turn against the
 * isolated demo vault. Selectors follow the proven announce-shots-chat.mjs harness.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4403';
const ROOT = 'marketing/remotion/capture';
const CLEAN = `[class*="minimized"],[class*="sleep-debt"],[class*="debt-badge"]{display:none!important}`;
const PROMPT = "We want to cut p95 latency under 200ms by the end of September. Put it on the roadmap.";

const b = await chromium.launch();
const page = await b.newPage({ viewport:{width:1600,height:1000}, deviceScaleFactor:2, colorScheme:'dark' });
async function shot(rel, target = page){ const p=join(ROOT,rel); mkdirSync(dirname(p),{recursive:true}); await page.addStyleTag({content:CLEAN}); await target.screenshot({path:p}); console.log('  ✓',rel); }
async function until(label, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs; const t0 = Date.now();
  while (Date.now() < deadline) {
    if (await page.locator(selector).count()) { console.log(`  · ${label} after ${Math.round((Date.now()-t0)/1000)}s`); return true; }
    await page.waitForTimeout(2500);
  }
  console.log(`  · ${label} — TIMED OUT`); return false;
}

await page.goto(`${BASE}/?vault=orbit-demo`,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(4000);
for(let i=0;i<3;i++){await page.keyboard.press('Escape');await page.waitForTimeout(300)}

// open the overlay (Ctrl double-tap, as in the proven harness)
for (let i=0;i<2;i++){ await page.keyboard.down('Control'); await page.keyboard.up('Control'); await page.waitForTimeout(90); }
await page.waitForTimeout(2000);
if (!(await page.locator('.agent-add-btn').count())) {
  const fab = page.locator('.agent-fab').first();
  if (await fab.count()) { await fab.click({force:true}); await page.waitForTimeout(2000); }
}
console.log('  · add-btn present:', await page.locator('.agent-add-btn').count());

await page.locator('.agent-add-btn').first().click();
await page.waitForTimeout(4500);
await shot('h1-chat-empty.png');

const composer = page.locator('.chat-pane textarea').first();
await composer.click();
await composer.fill(PROMPT);
await page.waitForTimeout(400);
await shot('h2-chat-typed.png');
await composer.press('Enter');
console.log('  · sent — waiting on the DOM');

await until('first tool card', '.chat-toolcard', 300000);
await page.waitForTimeout(2500);
await shot('h3-chat-tools.png');
await until('assistant prose', '.chat-msg-assistant-body', 300000);
await page.waitForTimeout(3000);
await shot('h4-chat-answer.png');
if (await until('question card', '.chat-surveycard', 120000)) {
  await page.locator('.chat-surveycard').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await shot('h5-chat-question.png');
}
console.log('--- TAIL ---');
console.log((await page.locator('body').innerText()).slice(-1800));
await b.close(); console.log('done');
