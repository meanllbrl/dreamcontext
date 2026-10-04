/**
 * Marketing reel v4 (light, reel rhythm) — REAL dashboard captures of the fictional "orbit" brain.
 *
 *   ROOT=/tmp/dc-reel-v4 DC=<repo>/marketing/dist-snap/index.js ./marketing/build-demo-vault-v2.sh
 *   (cd /tmp/dc-reel-v4/proj && HOME=/tmp/dc-reel-v4/home DREAMCONTEXT_DESKTOP=1 \
 *      node <repo>/marketing/dist-snap/index.js dashboard --no-open -p 45911)
 *   ONLY=pages node e2e/reel-shots-v4.mjs     # pages | chat | agent | map  (comma list; default all but chat)
 *
 * 1440x900 viewport, DPR 2, light. Never opens the launcher (straight to ?vault=).
 * The chat group runs ONE live Claude turn and records it as it streams (stop-motion of
 * real frames), plus the on-page boxes of the answer's key phrases for highlight overlays.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45911';
const OUT = process.env.OUT ?? 'marketing/remotion/capture-v4';
const ONLY = (process.env.ONLY ?? 'pages,agent,map').split(',');
const on = (g) => ONLY.includes(g);
const QUESTION = 'Trial-to-paid dropped this week. What changed?';
const AGENT_ASK = 'Monday metrics. Every Monday at 09:00, tell me which numbers moved last week, by how much, and why.';
const W = 1440, H = 900;
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'type'), { recursive: true });
mkdirSync(join(OUT, 'stream'), { recursive: true });
mkdirSync(join(OUT, 'agent-type'), { recursive: true });

// Never on camera: the sleep-debt alert, live-session docks, the floating chat button.
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab,.auto-dispatch-pill,.sleep-tracker-wrap{display:none!important}`;

const b = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'light' });
await page.addInitScript(() => localStorage.setItem('dreamcontext-theme', 'light'));
page.setDefaultTimeout(15000);

async function clean() {
  await page.addStyleTag({ content: CLEAN });
  // the top-bar sleep-debt pill ("Alert 5/60") has no stable class: hide it by its text
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, div')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^Alert \d+\/\d+$/.test(t) && el.getBoundingClientRect().width < 200) el.style.visibility = 'hidden';
    }
  });
}
async function shot(name, opts = {}) {
  await clean();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, name), ...opts });
  console.log('  ✓', name);
}
async function until(label, fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) { console.log('  ·', label); return true; }
    await page.waitForTimeout(500);
  }
  console.log('  ·', label, 'TIMEOUT');
  return false;
}
const bodyHas = (re) => async () => re.test(await page.locator('body').innerText());
const visible = (sel) => async () => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible());
async function nav(name) {
  await page.locator('.sidebar-item').filter({ has: page.getByText(name, { exact: true }) }).first().click();
  await page.waitForTimeout(700);
}
async function dismissPopups() {
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));
}
/** element box in CSS px (multiply by DPR 2 for the PNG) */
const box = async (loc) => loc.first().boundingBox();

await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar-item', { timeout: 30000 });
await page.waitForTimeout(1500);
await dismissPopups();
const meta = {};

if (on('pages')) {
  await nav('Tasks');
  await until('tasks', bodyHas(/Investigate trial-to-paid drop/));
  await shot('tasks.png');

  await nav('Insights');
  await page.getByText('Revenue', { exact: true }).first().click();
  await until('revenue insights', bodyHas(/Trial-to-paid conversion/));
  await page.waitForTimeout(1500);
  await shot('insights.png');
  await page.getByText('Trial-to-paid conversion', { exact: true }).first().click();
  await until('insight detail', bodyHas(/UPDATE HISTORY|Update history|Meaning/i));
  await page.waitForTimeout(1500);
  await shot('insight-detail.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await nav('Knowledge');
  await until('knowledge tree', bodyHas(/Decisions/));
  await page.getByText('Decisions', { exact: true }).first().click();
  await page.waitForTimeout(400);
  await page.getByText('usage-based-pricing', { exact: true }).first().click();
  await until('knowledge doc', bodyHas(/We charge by tracked events/));
  await page.waitForTimeout(800);
  await shot('knowledge.png');
  await page.getByText('Research', { exact: true }).first().click();
  await page.waitForTimeout(400);
  await page.getByText('trial-interviews-sept', { exact: true }).first().click().catch(() => {});
  await until('research doc', bodyHas(/Eight teams, 30 minutes each/));
  await page.waitForTimeout(800);
  await shot('knowledge-research.png');
  await page.getByText('Patterns', { exact: true }).first().click();
  await page.waitForTimeout(400);
  await page.getByText('onboarding-email-tone', { exact: true }).first().click().catch(() => {});
  await until('pattern doc', bodyHas(/One action per email/), 60000);
  await page.waitForTimeout(800);
  await shot('pattern.png');

  await nav('Hypotheses');
  await until('hypotheses', bodyHas(/Trials that connect a second/));
  const mark = page.getByText('Mark all read', { exact: true });
  if (await mark.count()) { await mark.first().click(); await page.waitForTimeout(800); }
  await until('toast gone', async () => !(await bodyHas(/marked read/)()), 15000);
  await shot('hypotheses.png');

  await nav('Roadmap');
  await until('roadmap', bodyHas(/Ship the public beta/));
  await page.waitForTimeout(1500);
  await shot('roadmap.png');

  await nav('Sleep Cycle');
  await until('sleep', bodyHas(/Work sessions|LAST SLEEP|Last sleep/i));
  await page.waitForTimeout(1000);
  await shot('sleep.png');
}

if (on('map')) {
  await nav('Map');
  await until('map', bodyHas(/\d+ nodes · \d+ links/), 120000);
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('*')].find((e) => /^graph settings$/i.test(e.textContent?.trim() || ''));
    const panel = h?.closest('div')?.parentElement;
    const x = panel ? [...panel.querySelectorAll('button')].find((bt) => /^[×✕x]$/i.test(bt.textContent.trim())) : null;
    x?.click();
  });
  await page.waitForTimeout(7000); // the force layout settles (visual only)
  await shot('map.png');
}

if (on('agent')) {
  await nav('Automations');
  await until('automations page', visible('.agents-switch'));
  const view = async (name) => {
    await page.locator('.agents-switch-opt', { hasText: new RegExp(`^\\s*${name}`) }).first().click();
    await page.waitForTimeout(400);
  };
  await view('Agents');
  await page.waitForTimeout(800);
  await shot('agents.png');
  await page.locator('.agents-new-btn').first().click();
  await until('dialog', visible('.agent-modal'));
  // the shipped placeholder is a Turkish example naming a real analytics vendor: an English one for the reel
  await page.evaluate(() => document.querySelector('.agent-modal textarea')?.setAttribute('placeholder', 'Every morning at 09:00, read yesterday\'s insights and write a three-point summary.'));
  await page.waitForTimeout(500);
  await shot('agent-empty.png');
  const ta = page.locator('.agent-modal textarea').first();
  await ta.click();
  meta.agentTextarea = await box(ta);
  meta.agentModal = await box(page.locator('.agent-modal'));
  for (let i = 0; i < AGENT_ASK.length; i++) {
    await page.keyboard.type(AGENT_ASK[i]);
    if (i % 3 === 2 || i === AGENT_ASK.length - 1) {
      await page.waitForTimeout(60);
      await page.screenshot({ path: join(OUT, 'agent-type', `t${String(i + 1).padStart(3, '0')}.png`) });
    }
  }
  await until('name derived', async () => (await page.locator('.agent-modal .agent-row3 input').first().inputValue()) === 'Monday metrics', 8000);
  // "Every Monday": the days are not derived, so leave only Mo on
  for (const d of ['Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
    const chip = page.locator('.agent-modal .agent-chip--day', { hasText: new RegExp(`^${d}$`) });
    if ((await chip.count()) && (await chip.first().getAttribute('aria-pressed')) === 'true') {
      await chip.first().click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(OUT, 'agent-type', `day-${d}.png`) });
    }
  }
  await ta.evaluate((e) => e.blur());
  await page.mouse.move(8, 892);
  await page.waitForTimeout(500);
  await shot('agent-filled.png');
  const boxes = {};
  for (const [k, sel] of Object.entries({ name: '.agent-modal .agent-row3 input', days: '.agent-modal .agent-chip--day', schedule: '.agent-modal .agent-chip' })) {
    boxes[k] = await page.locator(sel).evaluateAll((els) => els.map((e) => ({ t: (e.value ?? e.textContent ?? '').trim().slice(0, 40), r: e.getBoundingClientRect().toJSON() })));
  }
  meta.agentBoxes = boxes;
  await page.keyboard.press('Escape');
}

if (on('chat')) {
  await nav('Chat');
  await page.waitForTimeout(1000);
  const startBtn = page.getByText('Start chat', { exact: false }).first();
  if (await startBtn.count()) await startBtn.click();
  await until('composer', async () => (await page.locator('textarea').count()) > 0, 60000);
  await page.waitForTimeout(2500);
  const input = page.locator('textarea').last();
  await input.click();
  await shot('chat-empty.png');
  meta.composer = await box(input);
  for (let i = 0; i < QUESTION.length; i++) {
    await page.keyboard.type(QUESTION[i]);
    await page.waitForTimeout(40);
    await page.screenshot({ path: join(OUT, 'type', `t${String(i + 1).padStart(3, '0')}.png`) });
  }
  await page.waitForTimeout(500);
  await shot('chat-typed.png');
  // the send button, for the cursor's click target
  const send = page.locator('button[aria-label*="Send" i], button[title*="Send" i], .chat-cmp-send').first();
  meta.send = (await send.count()) ? await box(send) : null;
  console.log('  · send box', meta.send);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  let n = 0, last = '', stable = 0;
  const stamps = [];
  const end = Date.now() + 480000;
  while (Date.now() < end && stable < 10) {
    for (const allow of ['Allow', 'Yes', 'Approve']) {
      const btn = page.locator('button', { hasText: new RegExp(`^\\s*${allow}\\b`) });
      if (await btn.count()) await btn.first().click().catch(() => {});
    }
    await clean();
    const name = `s${String(++n).padStart(3, '0')}.png`;
    await page.screenshot({ path: join(OUT, 'stream', name) });
    stamps.push({ name, t: (Date.now() - t0) / 1000 });
    const t = await page.locator('body').innerText().catch(() => '');
    stable = t === last ? stable + 1 : 0;
    last = t;
    await page.waitForTimeout(900);
  }
  meta.stream = stamps;
  await shot('chat-end.png');
  // scroll the transcript to the top so the question + the head of the answer show together
  const sc = await page.evaluateHandle(() => {
    const all = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY));
    return all.sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
  });
  if (sc) {
    await sc.evaluate((e) => { e.scrollTop = 0; });
    await page.waitForTimeout(800);
    await shot('chat-top.png');
    const h = await sc.evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight }));
    meta.chatScroll = h;
    // a tall stitched strip of the whole answer: one shot per viewport step
    let k = 0;
    for (let y = 0; y < h.sh; y += Math.round(h.ch * 0.8)) {
      await sc.evaluate((e, yy) => { e.scrollTop = yy; }, y);
      await page.waitForTimeout(350);
      await shot(`chat-scroll-${k++}.png`);
    }
  }
  const answer = (await page.locator('body').innerText()).slice(-4000);
  writeFileSync(join(OUT, 'chat-answer.txt'), answer);
  console.log('--- ANSWER (tail) ---\n' + answer.slice(-2500));
}

writeFileSync(join(OUT, `meta-${ONLY.join('-')}.json`), JSON.stringify(meta, null, 2));
await b.close();
console.log('done');
