/**
 * Marketing reel v2 — REAL dashboard screenshots of the fictional "orbit" brain.
 *
 *   ROOT=/tmp/dc-reel-v2 ./marketing/build-demo-vault-v2.sh
 *   (cd /tmp/dc-reel-v2/proj && HOME=/tmp/dc-reel-v2/home DREAMCONTEXT_DESKTOP=1 \
 *      node <repo>/dist/index.js dashboard --no-open -p 45901)
 *   node e2e/reel-shots-v2.mjs                 # every page
 *   ONLY=chat node e2e/reel-shots-v2.mjs        # one group: chat|pages
 *
 * 1600x1000 viewport, DPR 2, dark (SCHEME=light OUT=marketing/remotion/capture-v2-light for light). Never opens the launcher (straight to ?vault=).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45901';
const OUT = process.env.OUT ?? 'marketing/remotion/capture-v2';
const ONLY = process.env.ONLY ?? 'all';
const SCHEME = process.env.SCHEME === 'light' ? 'light' : 'dark';
const QUESTION = 'Trial-to-paid dropped this week. What changed?';
mkdirSync(OUT, { recursive: true });

const CLEAN_BASE = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"]{display:none!important}`;
const CLEAN_PAGES = `${CLEAN_BASE} .agent-fab{display:none!important}`;

const b = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: SCHEME });
// the app keeps its own theme choice in localStorage; pin it so the scheme is what we asked for
await page.addInitScript((t) => localStorage.setItem('dreamcontext-theme', t), SCHEME);
page.setDefaultTimeout(15000);

async function shot(name, css = CLEAN_PAGES) {
  await page.addStyleTag({ content: css });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, name) });
  console.log('  ✓', name);
}
async function until(label, fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) { console.log('  ·', label); return true; }
    await page.waitForTimeout(700);
  }
  console.log('  ·', label, 'TIMEOUT');
  return false;
}
const bodyHas = (re) => async () => re.test(await page.locator('body').innerText());
async function nav(name) {
  const loc = name === 'Map'
    ? page.locator('.sidebar-item').filter({ has: page.getByText('Map', { exact: true }) })
    : page.locator('.sidebar-item', { hasText: name });
  await loc.first().click();
  await page.waitForTimeout(600);
}
async function dismissPopups() {
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));
}

await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar-item', { timeout: 30000 });
await page.waitForTimeout(1500);
await dismissPopups();

if (ONLY === 'all' || ONLY === 'pages') {
  // ── Tasks ──
  await nav('Tasks');
  await until('tasks', bodyHas(/Investigate trial-to-paid drop/));
  await shot('tasks.png');

  // ── Insights ──
  await nav('Insights');
  await until('insights', bodyHas(/Trial-to-paid conversion[\s\S]*Weekly active teams|Weekly active teams[\s\S]*Trial-to-paid/));
  await page.waitForTimeout(1200);
  await shot('insights.png');
  await page.getByText('Trial-to-paid conversion', { exact: true }).first().click();
  await until('insight detail', bodyHas(/UPDATE HISTORY|Update history/i));
  await page.waitForTimeout(1200);
  await shot('insight-detail.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ── Knowledge ──
  await nav('Knowledge');
  await until('knowledge tree', bodyHas(/Decisions/));
  await page.getByText('Decisions', { exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByText('Research', { exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByText('usage-based-pricing', { exact: true }).first().click();
  await until('knowledge doc', bodyHas(/We charge by tracked events/));
  await shot('knowledge.png');

  // ── Patterns (knowledge/patterns folder) ──
  await page.getByText('Decisions', { exact: true }).first().click();
  await page.getByText('Research', { exact: true }).first().click();
  await page.getByText('Patterns', { exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByText('pricing-page-experiments', { exact: true }).first().click();
  await until('pattern doc', bodyHas(/One change per test/), 90000);
  await shot('patterns.png');

  // ── Hypotheses ──
  await nav('Hypotheses');
  await until('hypotheses', bodyHas(/Trials that connect a second/));
  const mark = page.getByText('Mark all read', { exact: true });
  if (await mark.count()) { await mark.first().click(); await page.waitForTimeout(800); }
  await until('toast gone', async () => !(await bodyHas(/marked read/)()), 15000);
  await shot('hypotheses.png');
  await page.getByText(/^Trials that connect a second/).first().click();
  await until('hypothesis detail', bodyHas(/EVIDENCE LEDGER|Evidence ledger/i));
  await page.waitForTimeout(800);
  await shot('hypothesis-detail.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ── Automations ──
  await nav('Automations');
  await page.locator('button').filter({ hasText: /^\s*Agents/ }).first().click();
  await until('automations board', bodyHas(/Nightly churn check/));
  await page.waitForTimeout(800);
  await shot('automations.png');
  await page.locator('button').filter({ hasText: /^\s*Messages/ }).first().click();
  await page.waitForTimeout(1500);
  await shot('automations-messages.png');
  await page.locator('button').filter({ hasText: /^\s*Agents/ }).first().click();
  await page.waitForTimeout(800);
  await page.locator('button', { hasText: /^\s*Runs\s*$/ }).first().click();
  await page.waitForTimeout(2500);
  await shot('automation-detail.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ── Roadmap ──
  await nav('Roadmap');
  await until('roadmap', bodyHas(/Ship the public beta/));
  await page.waitForTimeout(1000);
  await shot('roadmap.png');

  // ── Sleep ──
  await nav('Sleep Cycle');
  await until('sleep', bodyHas(/Work sessions|LAST SLEEP/i));
  await page.waitForTimeout(1000);
  await shot('sleep.png');

  // ── Map ──
  await nav('Map');
  await until('map', bodyHas(/\d+ nodes · \d+ links/), 120000);
  // close the graph-settings panel if it is open
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === 'GRAPH SETTINGS' || e.textContent?.trim() === 'Graph settings');
    const panel = h?.closest('div')?.parentElement;
    const btns = panel ? [...panel.querySelectorAll('button')] : [];
    const x = btns.find((bt) => /^[×✕x]$/i.test(bt.textContent.trim()));
    x?.click();
  });
  await page.waitForTimeout(6000); // let the force layout settle (visual, not data)
  await shot('map.png');
}

if (ONLY === 'all' || ONLY === 'chat') {
  await nav('Chat');
  await page.waitForTimeout(1000);
  if (!(await page.locator('textarea.chat-cmp-input').count())) {
    await page.getByText('Start chat').first().click();
  }
  await until('composer', async () => (await page.locator('textarea.chat-cmp-input').count()) > 0);
  const input = page.locator('textarea.chat-cmp-input').first();
  await input.click();

  await input.click();
  await input.type(QUESTION, { delay: 35 });
  await page.waitForTimeout(700);
  await shot('chat-typed.png', CLEAN_BASE);

  await page.keyboard.press('Enter');
  await until('assistant replied', async () => (await page.locator('.chat-msg-assistant-body').count()) > 0, 240000);
  // wait for the turn to END: assistant text stable for 12s
  let last = '', stable = 0; const end = Date.now() + 480000;
  while (Date.now() < end && stable < 12) {
    for (const allow of ['Allow', 'Yes', 'Approve']) {
      const btn = page.locator('button', { hasText: new RegExp(`^\\s*${allow}\\b`) });
      if (await btn.count()) await btn.first().click().catch(() => {});
    }
    const t = await page.locator('.chat-transcript').innerText().catch(() => '');
    stable = t === last ? stable + 1 : 0; last = t;
    await page.waitForTimeout(1000);
  }
  console.log('  · toolcards:', await page.locator('.chat-toolcard').count(), '| assistant bodies:', await page.locator('.chat-msg-assistant-body').count());
  await shot('chat-live-end.png', CLEAN_BASE);
  const sc = page.locator('.chat-scroll').first();
  if (await sc.count()) {
    await sc.evaluate((e) => { e.scrollTop = 0; });
    await page.waitForTimeout(1000);
    await shot('chat-live.png', CLEAN_BASE);
  }
  console.log('--- TRANSCRIPT (tail) ---\n' + last.slice(-2500));
}

if (ONLY === 'all' || ONLY === 'chat' || ONLY === 'slash') {
  // The "/" menu is populated once the chat session has initialised (after its first turn).
  await nav('Chat');
  await until('composer', async () => (await page.locator('textarea.chat-cmp-input').count()) > 0);
  const sc = page.locator('.chat-scroll').first();
  // expand the "Looked around" tool summary at the top of the reply
  for (let i = 0; i < 4; i++) { await sc.evaluate((e) => { e.scrollTop = 0; }); await page.waitForTimeout(800); }
  const looked = page.locator('button.chat-m-cardhead-hit[aria-label^="Looked around"]').first();
  console.log('  · looked-around buttons:', await page.locator('button.chat-m-cardhead-hit').count(), await sc.evaluate((e) => e.scrollTop));
  if (await looked.count()) {
    await looked.click(); await page.waitForTimeout(1500);
    await sc.evaluate((e) => { e.scrollTop = 0; }); await page.waitForTimeout(800);
    await shot('chat-tools.png', CLEAN_BASE);
    await looked.click(); await page.waitForTimeout(500);
  }
  const input = page.locator('textarea.chat-cmp-input').first();
  await input.click();
  await page.keyboard.type('/pat', { delay: 80 });
  await until('slash menu', bodyHas(/\/pattern-pricing-page-experiments/), 20000);
  await page.waitForTimeout(800);
  await shot('patterns-slash.png', CLEAN_BASE);
  await input.fill('');
}

await b.close();
console.log('done');
