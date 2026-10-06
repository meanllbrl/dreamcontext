/**
 * Reel v5 — ONE live chat turn in the orbit demo vault AFTER its real sleep, so the answer on screen
 * cites the post-sleep brain (81%, the sleep-written trial-interviews-sept page).
 *
 *   STEP=live  node e2e/reel-shots-v5-chat.mjs   # types the question, sends it, waits, saves the answer text
 *   STEP=still PHRASES='a|b|c' node e2e/reel-shots-v5-chat.mjs
 *              # no new turn: window shot at scrollTop 0, one tall strip of the transcript, phrase rects
 *
 * The server must run with env -i (fake HOME, account CLAUDE_CONFIG_DIR, DREAMCONTEXT_DESKTOP=1) so the
 * spawned chat sees none of the producing session's env.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45911';
const OUT = process.env.OUT ?? 'marketing/remotion/capture-v5/chat';
const STEP = process.env.STEP ?? 'live';
const QUESTION = 'Trial-to-paid dropped this week. What changed?';
const W = 1440, H = 900;
const COMPOSER = '[contenteditable="true"], textarea';
mkdirSync(OUT, { recursive: true });
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab,.auto-dispatch-pill,.sleep-tracker-wrap{display:none!important}`;

const b = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'light' });
await page.addInitScript(() => localStorage.setItem('dreamcontext-theme', 'light'));
page.setDefaultTimeout(15000);

async function clean() {
  await page.addStyleTag({ content: CLEAN });
  return page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 12) continue;
      const t = el.textContent || '';
      if (/Claude account changed/.test(t) && /@/.test(t)) {
        let s = el;
        while (s.parentElement && s.parentElement.getBoundingClientRect().height < 60) s = s.parentElement;
        s.style.display = 'none';
        n++;
      }
    }
    return n;
  });
}
async function open() {
  await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar-item', { timeout: 30000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));
  await page.locator('.sidebar-item').filter({ has: page.getByText('Chat', { exact: true }) }).first().click();
  await page.waitForTimeout(1200);
}
const scroller = () => page.evaluateHandle(() => {
  const all = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY));
  return all.sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
});

await open();

if (STEP === 'live') {
  // a fresh chat if an earlier attempt left one behind
  if (await page.getByText(QUESTION).count()) {
    await page.locator('button.agent-tab-btn.close').first().click();
    await page.waitForTimeout(1500);
    for (const t of ['Close', 'Discard', 'Yes']) {
      const c = page.locator('button', { hasText: new RegExp(`^\\s*${t}\\b`) });
      if (await c.count()) { await c.first().click().catch(() => {}); break; }
    }
    await page.waitForTimeout(1000);
    if (!(await page.locator(COMPOSER).count()) || (await page.getByText(QUESTION).count())) await page.locator('button[aria-label="New chat"]').first().click();
    await page.waitForTimeout(2500);
  }
  const startBtn = page.getByText('Start chat', { exact: false }).first();
  if (await startBtn.count()) await startBtn.click();
  const end0 = Date.now() + 60000;
  while (Date.now() < end0 && !(await page.locator(COMPOSER).count())) await page.waitForTimeout(500);
  await page.waitForTimeout(2500);
  const input = page.locator(COMPOSER).last();
  await input.click();
  await page.keyboard.type(QUESTION, { delay: 30 });
  await page.waitForTimeout(400);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  let last = '', stable = 0, n = 0;
  const end = Date.now() + 480000;
  while (Date.now() < end && stable < 12) {
    for (const allow of ['Allow', 'Yes', 'Approve']) {
      const btn = page.locator('button', { hasText: new RegExp(`^\\s*${allow}\\b`) });
      if (await btn.count()) await btn.first().click().catch(() => {});
    }
    await page.waitForTimeout(1000);
    const t = await page.locator('body').innerText().catch(() => '');
    stable = t === last && t.includes(QUESTION) && Date.now() - t0 > 15000 ? stable + 1 : 0;
    last = t;
    if (++n % 15 === 0) console.log('  ·', Math.round((Date.now() - t0) / 1000), 's');
  }
  console.log('  · done after', Math.round((Date.now() - t0) / 1000), 's');
  await clean();
  writeFileSync(join(OUT, 'answer.txt'), await page.locator('body').innerText());
  await page.screenshot({ path: join(OUT, 'chat-end.png') });
}

if (STEP === 'still') {
  // a fresh browser re-attaches to a saved chat through "Resume session" (no new turn is sent)
  const end = Date.now() + 90000;
  const asked = () => page.locator('.chat-msg, [class*="message"], [class*="bubble"]').filter({ hasText: QUESTION });
  while (Date.now() < end && !(await asked().count())) {
    const resume = page.getByRole('button', { name: 'Resume session' });
    if (await resume.count()) await resume.first().click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2500);
  console.log('banner hidden:', await clean());
  await page.screenshot({ path: join(OUT, 'debug.png') });
  const body = await page.locator('body').innerText();
  if (/@|account changed/i.test(body)) console.log('!! "@" OR BANNER TEXT IN BODY');
  let sc = await scroller();
  await sc.evaluate((e) => { e.scrollTop = 0; });
  await page.waitForTimeout(600);
  await clean();
  await page.screenshot({ path: join(OUT, 'win-chat.png') });
  const geo = await sc.evaluate((e) => { e.setAttribute('data-v5-sc', '1'); return { sh: e.scrollHeight, ch: e.clientHeight, r: e.getBoundingClientRect().toJSON() }; });
  // one tall viewport holds the whole transcript without scrolling: a single clean strip
  await page.setViewportSize({ width: W, height: Math.min(6000, Math.ceil(H + geo.sh - geo.ch + 40)) });
  await page.waitForTimeout(1500);
  await clean();
  const g2 = await page.evaluate(() => { const e = document.querySelector('[data-v5-sc]'); e.scrollTop = 0; return { sh: e.scrollHeight, ch: e.clientHeight, r: e.getBoundingClientRect().toJSON() }; });
  await page.waitForTimeout(400);
  const clip = { x: g2.r.x, y: g2.r.y, width: g2.r.width, height: Math.min(g2.r.height, g2.sh) };
  await page.screenshot({ path: join(OUT, 'strip.png'), clip });
  const phrases = (process.env.PHRASES ?? '').split('|').filter(Boolean);
  const rects = await page.evaluate((phrases) => {
    const out = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const p of phrases) {
      for (const node of nodes) {
        const i = node.textContent.indexOf(p);
        if (i < 0) continue;
        const rg = document.createRange(); rg.setStart(node, i); rg.setEnd(node, i + p.length);
        out[p] = [...rg.getClientRects()].map((x) => ({ x: x.x, y: x.y, w: x.width, h: x.height }));
        break;
      }
      if (!out[p]) {
        const el = [...document.querySelectorAll('p, li, div, span, img, svg')].filter((e) => (e.textContent || '').includes(p)).sort((a, b) => a.textContent.length - b.textContent.length)[0];
        if (el) { const q = el.getBoundingClientRect(); out[p] = [{ x: q.x, y: q.y, w: q.width, h: q.height, block: true }]; }
      }
    }
    return out;
  }, phrases);
  for (const k of Object.keys(rects)) rects[k] = rects[k].map((q) => ({ ...q, x: q.x - clip.x, y: q.y - clip.y }));
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ scroller: geo, tall: g2, clip, rects }, null, 2));
  console.log(JSON.stringify({ geo, g2, clip, rects }));
}
await b.close();
console.log('done');
