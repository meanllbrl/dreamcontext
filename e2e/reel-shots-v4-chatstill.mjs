/**
 * Reel v4 — re-shoot the finished chat (no new turn): the account banner dismissed and hidden,
 * the transcript stepped from the top, plus the on-page rects of the answer's key phrases.
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const BASE = 'http://127.0.0.1:45911';
const OUT = 'marketing/remotion/capture-v4';
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab,.auto-dispatch-pill,.sleep-tracker-wrap{display:none!important}`;
const PHRASES = ['18.1%', '13.2% in the week of Sep 21', '78% confidence', '83% confidence', 'three of the eight September interviewees said exactly that about the day-2 email', 'Looked around', 'The two explanations already on file'];
const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
await page.addInitScript(() => localStorage.setItem('dreamcontext-theme', 'light'));
await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar-item', { timeout: 30000 });
await page.waitForTimeout(1500);
for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));
await page.locator('.sidebar-item').filter({ has: page.getByText('Chat', { exact: true }) }).first().click();
const end = Date.now() + 60000;
while (Date.now() < end && !(await page.getByText('Trial-to-paid dropped this week. What changed?').count())) await page.waitForTimeout(700);
await page.waitForTimeout(2500);
async function hideBanner() {
  await page.addStyleTag({ content: CLEAN });
  return page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 12) continue;
      const t = el.textContent || '';
      if (/Claude account changed/.test(t) && /@/.test(t)) {
        // walk up to the full-width strip, stop before the chat pane itself
        let s = el;
        while (s.parentElement && s.parentElement.getBoundingClientRect().height < 60) s = s.parentElement;
        s.style.display = 'none'; n++;
      }
    }
    return n;
  });
}
console.log('banner hidden:', await hideBanner());
await page.waitForTimeout(600);
const body = await page.locator('body').innerText();
if (/@gmail|account changed/i.test(body)) console.log('!! BANNER TEXT STILL IN BODY');
const sc = await page.evaluateHandle(() => {
  const all = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY));
  return all.sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
});
const meta = { steps: [] };
const geo = await sc.evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight, r: e.getBoundingClientRect().toJSON() }));
meta.scroller = geo;
for (let y = 0, k = 0; y < geo.sh - geo.ch + 200 && k < 8; y += 160, k++) {
  await sc.evaluate((e, yy) => { e.scrollTop = yy; }, y);
  await page.waitForTimeout(450);
  await hideBanner();
  const top = await sc.evaluate((e) => e.scrollTop);
  const rects = await page.evaluate((phrases) => {
    const out = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const p of phrases) {
      for (const node of nodes) {
        const i = node.textContent.indexOf(p);
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + p.length);
        out[p] = [...r.getClientRects()].map((x) => ({ x: x.x, y: x.y, w: x.width, h: x.height }));
        break;
      }
      if (!out[p]) {
        // phrase split across nodes: match on the block's text
        const el = [...document.querySelectorAll('p, li, div, span, button')].filter((e) => (e.textContent || '').includes(p)).sort((a, b) => a.textContent.length - b.textContent.length)[0];
        if (el) out[p] = [{ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, block: true }];
      }
    }
    return out;
  }, PHRASES);
  const name = `chat-still-${k}.png`;
  await page.screenshot({ path: join(OUT, name) });
  meta.steps.push({ name, scrollTop: top, rects });
  console.log('  ✓', name, 'scrollTop', top);
}
writeFileSync(join(OUT, 'meta-chatstill.json'), JSON.stringify(meta, null, 2));
await b.close();
console.log('done');
