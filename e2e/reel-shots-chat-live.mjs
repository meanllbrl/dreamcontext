/** Capture the user's LIVE chat session in orbit-demo (already run in the app). */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const BASE = process.env.BASE ?? 'http://127.0.0.1:58578';
const ROOT = 'marketing/remotion/capture';
const CLEAN = `[class*="sleep-debt"],[class*="debt-badge"]{display:none!important}`;
const b = await chromium.launch();
const page = await b.newPage({ viewport:{width:1600,height:1000}, deviceScaleFactor:2, colorScheme:'dark' });
async function shot(rel, t=page){ const p=join(ROOT,rel); mkdirSync(dirname(p),{recursive:true}); await page.addStyleTag({content:CLEAN}); await t.screenshot({path:p}); console.log('  ✓',rel); }
async function until(l,sel,ms){const e=Date.now()+ms;while(Date.now()<e){if(await page.locator(sel).count()){console.log('  ·',l);return true}await page.waitForTimeout(1500)}console.log('  ·',l,'TIMEOUT');return false}

await page.goto(`${BASE}/?vault=orbit-demo`,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(5000);
for(let i=0;i<3;i++){await page.keyboard.press('Escape');await page.waitForTimeout(300)}

if (!(await page.locator('.agent-surface.expanded').count())) {
  for (const sel of ['.agent-fab','.agent-overlay-head','.agent-surface']) {
    const el=page.locator(sel).first();
    if (await el.count()){ await el.click({force:true}).catch(()=>{}); await page.waitForTimeout(1800); }
    if (await page.locator('.agent-surface.expanded').count()){ console.log('  · opened via',sel); break; }
  }
}
await page.waitForTimeout(2500);
await shot('h1-chat-live.png');
console.log('  · toolcards:', await page.locator('.chat-toolcard').count(),
            '| assistant bodies:', await page.locator('.chat-msg-assistant-body').count());
if (await until('transcript','.chat-msg-assistant-body',20000)) {
  // scroll to the top of the conversation: the human's sentence
  const pane = page.locator('.chat-pane').first();
  if (await pane.count()) { await pane.evaluate(e=>{e.scrollTop=0}); await page.waitForTimeout(1200); await shot('h2-chat-top.png'); }
  // then the end: what Claude concluded
  if (await pane.count()) { await pane.evaluate(e=>{e.scrollTop=e.scrollHeight}); await page.waitForTimeout(1200); await shot('h3-chat-end.png'); }
}
console.log('--- VISIBLE TEXT ---');
console.log((await page.locator('body').innerText()).slice(-1500));
await b.close(); console.log('done');
