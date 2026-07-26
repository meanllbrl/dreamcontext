/** Capture the HUMAN surface: creating and steering roadmap items in the dashboard app. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4401';
const ROOT = 'marketing/remotion/capture';
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"]{display:none!important}`;
const b = await chromium.launch();
const page = await b.newPage({ viewport:{width:1600,height:1000}, deviceScaleFactor:2, colorScheme:'dark' });
async function shot(rel){ const p=join(ROOT,rel); mkdirSync(dirname(p),{recursive:true}); await page.addStyleTag({content:CLEAN}); await page.screenshot({path:p}); console.log('  ✓',rel); }
async function until(l,fn,ms=30000){const e=Date.now()+ms;while(Date.now()<e){if(await fn()){console.log('  ·',l);return true}await page.waitForTimeout(800)}console.log('  ·',l,'TIMEOUT');return false}
const M = (sel) => page.locator('.ocm-overlay').locator(sel);

await page.goto(`${BASE}/?vault=orbit`,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(2500);
for(let i=0;i<4;i++){await page.keyboard.press('Escape');await page.waitForTimeout(300)}
await page.locator('.sidebar-item',{hasText:'Roadmap'}).first().click();
await until('board', async()=>/Ship the public beta/.test(await page.locator('body').innerText()));
await page.waitForTimeout(1200);
await shot('a1-board.png');

await page.getByText('+ New Objective').first().click();
await page.waitForTimeout(1500);
await shot('a2-modal-empty.png');

// type the title, like a person
const title = M('input').first();
await title.click();
await title.type('Cut p95 latency under 200ms', { delay: 42 });
await page.waitForTimeout(700);
await shot('a3-modal-typed.png');

// Key Result: switch from tasks to a metric
const metricBtn = M('text=Track by a metric').first();
if (await metricBtn.count()) {
  await metricBtn.click();
  await page.waitForTimeout(1100);
  await shot('a4-modal-metric.png');
  console.log('--- METRIC SECTION ---');
  console.log((await page.locator('.ocm-overlay').innerText()).slice(0, 900));
}

// Depends on: open the picker
const dep = M('input[placeholder*="depend"]').first();
if (await dep.count()) {
  await dep.click(); await dep.type('ship', { delay: 60 });
  await page.waitForTimeout(1100);
  await shot('a5-modal-depends.png');
}
await b.close(); console.log('done');
