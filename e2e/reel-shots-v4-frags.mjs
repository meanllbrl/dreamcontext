/**
 * Reel v4 — single REAL cards of the orbit brain, clipped to their own box (DPR 2, light),
 * for the collage ring and the pieces that float off the product scenes.
 *   node e2e/reel-shots-v4-frags.mjs   (server as in reel-shots-v4.mjs)
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:45911';
const OUT = 'marketing/remotion/capture-v4/frag';
mkdirSync(OUT, { recursive: true });
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab,.auto-dispatch-pill,.sleep-tracker-wrap{display:none!important}`;

const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
await page.addInitScript(() => localStorage.setItem('dreamcontext-theme', 'light'));
page.setDefaultTimeout(15000);
const bodyHas = (re) => async () => re.test(await page.locator('body').innerText());
async function until(label, fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(500); }
  console.log('  ·', label, 'TIMEOUT');
  return false;
}
async function nav(name) {
  await page.locator('.sidebar-item').filter({ has: page.getByText(name, { exact: true }) }).first().click();
  await page.waitForTimeout(800);
}
/** the smallest bordered/shadowed box around the element whose own text starts with `text` */
async function card(name, text, { minW = 180, minH = 50, maxW = 900, pad = 0 } = {}) {
  await page.addStyleTag({ content: CLEAN });
  const r = await page.evaluate(({ text, minW, minH, maxW }) => {
    const leaf = [...document.querySelectorAll('body *')].find((e) => {
      const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      return own.startsWith(text) && e.getBoundingClientRect().width > 0;
    });
    if (!leaf) return null;
    let el = leaf;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const framed = (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') || cs.boxShadow !== 'none' || parseFloat(cs.borderRadius) >= 8;
      if (framed && r.width >= minW && r.height >= minH && r.width <= maxW) return { x: r.x, y: r.y, width: r.width, height: r.height };
      el = el.parentElement;
    }
    return null;
  }, { text, minW, minH, maxW });
  if (!r) { console.log('  ✗', name, '(not found)'); return; }
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 };
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${name}.png`), clip });
  console.log('  ✓', name, Math.round(clip.width), 'x', Math.round(clip.height));
}

await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar-item', { timeout: 30000 });
await page.waitForTimeout(1500);
for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));

await nav('Tasks');
await until('tasks', bodyHas(/Investigate trial-to-paid drop/));
await card('task-investigate', 'Investigate trial-to-paid drop');
await card('task-onboarding', 'Onboarding email sequence v2');
await card('task-annual', 'Annual plan on pricing page');
await card('task-beta', 'Beta signup page');

await nav('Insights');
await page.getByText('Revenue', { exact: true }).first().click();
await until('revenue', bodyHas(/Trial-to-paid conversion/));
await page.waitForTimeout(1800);
await card('ins-churn', 'Monthly churn');
await card('ins-mrr', 'MRR');
await card('ins-paying', 'Paying customers');
await card('ins-trial', 'Trial-to-paid conversion');
await page.getByText('Product', { exact: true }).first().click();
await page.waitForTimeout(1800);
await card('ins-wat', 'Weekly active teams');

await nav('Hypotheses');
await until('hyp', bodyHas(/Trials that connect a second/));
const mark = page.getByText('Mark all read', { exact: true });
if (await mark.count()) { await mark.first().click(); await page.waitForTimeout(1500); }
await card('hyp-alerts', 'Teams that set up a usage alert', { maxW: 400 });
await card('hyp-emails', 'The new onboarding emails', { maxW: 400 });
await card('hyp-second', 'Trials that connect a second', { maxW: 400 });
await card('hyp-invite', 'Teams invited by a teammate', { maxW: 400 });

await nav('Knowledge');
await until('kn', bodyHas(/Decisions/));
await page.getByText('Decisions', { exact: true }).first().click();
await page.waitForTimeout(400);
await card('kn-row-pricing', 'usage-based-pricing', { maxW: 400 });
await page.getByText('usage-based-pricing', { exact: true }).first().click();
await until('doc', bodyHas(/We charge by tracked events/));
await page.waitForTimeout(600);
await card('kn-doc-pricing', 'Usage-based pricing', { minW: 600, maxW: 1300 });
await page.getByText('Research', { exact: true }).first().click();
await page.waitForTimeout(400);
await card('kn-row-interviews', 'trial-interviews-sept', { maxW: 400 });
await page.getByText('Patterns', { exact: true }).first().click();
await page.waitForTimeout(400);
await card('kn-row-tone', 'onboarding-email-tone', { maxW: 400 });

await nav('Automations');
await page.locator('.agents-switch-opt', { hasText: /^\s*Agents/ }).first().click();
await page.waitForTimeout(1000);
await card('agent-digest', 'Monday metrics digest', { maxW: 700 });
await card('agent-churn', 'Nightly churn check', { maxW: 700 });

await nav('Chat');
await until('chat', bodyHas(/Trial-to-paid dropped this week/), 30000);
await page.waitForTimeout(2000);
await card('chat-ask', 'Trial-to-paid dropped this week. What changed?', { minW: 120, minH: 30 });
await card('chat-looked', 'Looked around', { maxW: 1200 });
await card('chat-chart', 'Trial-to-paid conversion', { maxW: 500 });

await b.close();
console.log('done');
