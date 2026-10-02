/**
 * Marketing reel — Automations (agents), REAL dashboard screenshots of the fictional "orbit" brain.
 *
 *   ROOT=/tmp/dc-reel-v2 ./marketing/build-demo-vault-v2.sh   (+ the agents seeded in the capture notes)
 *   (cd /tmp/dc-reel-v2/proj && HOME=/tmp/dc-reel-v2/home DREAMCONTEXT_DESKTOP=1 \
 *      node <repo>/dist/index.js dashboard --no-open -p 45901)
 *   SCHEME=light node e2e/reel-shots-agents.mjs            # every shot
 *   ONLY=create|agents|channel|thread|detail|approve|mention node e2e/reel-shots-agents.mjs
 *
 * 1600x1000 viewport, DPR 2. Never opens the launcher (straight to ?vault=).
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45901';
const OUT = process.env.OUT ?? 'marketing/remotion/capture-agents-light';
const VAULT = process.env.VAULT ?? '/tmp/dc-reel-v2/proj';
const ONLY = (process.env.ONLY ?? 'all').split(',');
// `all` is every read-only shot. The live ones (mention, thread) and the approval flip run only when named.
const STILLS = ['agents', 'create', 'channel', 'report', 'ask', 'detail'];
const on = (g) => ONLY.includes(g) || (ONLY.includes('all') && STILLS.includes(g));
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light';
const DESCRIPTION = "Every Monday at 9, tell me what sold over the weekend, what didn't, what shipped and what broke.";
const REPLY = 'Starter only, please. Tell me what those four teams had in common.';
// The same sentence led by a name and an HH:MM time: the two things the dialog derives on its own.
const DESCRIPTION_NAMED = "Weekend recap. Every Monday at 09:00, tell me what sold over the weekend, what didn't, what shipped and what broke.";
const EN_PLACEHOLDER = 'Every morning at 09:00, read yesterday\'s insights and write a three-point summary; if something dropped, find out why.';
const MENTION = '@pricing-page-review What should we test next on the pricing page?';
mkdirSync(OUT, { recursive: true });

const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab,.auto-dispatch-pill{display:none!important}`;

const b = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: SCHEME });
await page.addInitScript((t) => localStorage.setItem('dreamcontext-theme', t), SCHEME);
page.setDefaultTimeout(15000);

async function shot(name, opts = {}) {
  await page.addStyleTag({ content: CLEAN });
  await page.waitForTimeout(400);
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
async function dismissPopups() {
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));
}
async function openAutomations() {
  await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
  await until('automations page', visible('.agents-switch'));
}
async function view(name) {
  await page.locator('.agents-switch-opt', { hasText: new RegExp(`^\\s*${name}`) }).first().click();
  await page.waitForTimeout(300);
}

await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar-item', { timeout: 30000 });
await until('app idle', async () => !(await page.locator('.announcements-modal-scrim').count()), 4000);
await dismissPopups();
await openAutomations();

if (on('peek')) {
  await view('Agents');
  await until('cards', async () => (await page.locator('.agent-card').count()) >= 4);
  await shot('peek-agents.png');
  await view('Messages');
  await until('feed', bodyHas(/Weekend sold 5 new paid teams/));
  await page.waitForTimeout(2500);
  await shot('peek-messages.png');
}

// ── 1. The member list ──
if (on('agents')) {
  await view('Agents');
  await until('cards', async () => (await page.locator('.agent-card').count()) >= 4);
  await until('photos', async () => page.evaluate(() => [...document.querySelectorAll('.agent-card img')].every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll('.agent-card img').length >= 4));
  await shot('agents.png');
}

// ── 2-5. New agent dialog ──
if (on('create')) {
  await view('Agents');
  const openDialog = async () => {
    await page.locator('.agents-new-btn').click();
    await until('dialog', visible('.agent-modal'));
    // The shipped placeholder is a Turkish example naming a real analytics vendor; swap in an English one for the reel.
    await page.evaluate((ph) => { const t = document.querySelector('.agent-modal textarea'); if (t) t.setAttribute('placeholder', ph); }, EN_PLACEHOLDER);
  };
  await openDialog();
  await shot('create-empty.png');

  const ta = page.locator('.agent-modal textarea');
  await ta.click();
  await page.keyboard.type(DESCRIPTION, { delay: 18 });
  await until('typed', async () => (await ta.inputValue()) === DESCRIPTION);
  await shot('create-typed.png');

  // The self-filling pass: a name first and an HH:MM time, so Name and time derive themselves.
  await page.locator('.agent-modal .agent-btn', { hasText: 'Cancel' }).click();
  await openDialog();
  await ta.click();
  await page.keyboard.type(DESCRIPTION_NAMED, { delay: 14 });
  await until('name derived', async () => (await page.locator('.agent-modal .agent-row3 input').first().inputValue()) === 'Weekend recap');
  // "Every Monday": the days are not derived, so the owner leaves only Mo on.
  for (const d of ['Tu', 'We', 'Th', 'Fr']) {
    const chip = page.locator('.agent-modal .agent-chip--day', { hasText: new RegExp(`^${d}$`) });
    if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
  }
  await page.locator('.agent-modal .agent-preset').nth(2).click();
  await until('preset preview', visible('.agent-modal .agent-photo-preview img'));
  await page.locator('.agent-modal textarea').evaluate((e) => e.blur());
  await page.waitForTimeout(400);
  await shot('create-filled.png');

  await page.locator('.agent-modal .agent-chip', { hasText: 'Only when I call it' }).click();
  await until('on-call note', bodyHas(/Runs only when you call it/));
  await page.waitForTimeout(500); // the reveal animates 220ms
  await shot('mode.png');
  await page.locator('.agent-modal .agent-chip', { hasText: 'On a schedule' }).click();
  await page.waitForTimeout(500);
  await shot('mode-schedule.png');
  await page.locator('.agent-modal .agent-btn', { hasText: 'Cancel' }).click();
}

const recapMsg = () => page.locator('article.agent-msg').filter({ has: page.locator('.agent-msg-board') }).first();
async function boardReady() {
  await until('board drawn', async () => page.evaluate(() => {
    const b = document.querySelector('.agent-msg-board');
    return !!b && !!b.querySelector('canvas, svg') && !/Loading|couldn/i.test(b.innerText);
  }), 60000);
  await page.waitForTimeout(1500);
}

// ── 7. Channel, before anything is read ──
if (on('channel')) {
  await view('Messages');
  await until('feed', bodyHas(/Weekend sold 5 new paid teams/));
  await until('chips', visible('.agents-chips'));
  await boardReady();
  await shot('channel.png');
  // the older posts above the hero
  const first = page.locator('.agents-feed-day, article.agent-msg').first();
  await first.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(800);
  await shot('channel-top.png');
}

// ── 6. The hero report ──
if (on('report')) {
  await view('Messages');
  await until('feed', bodyHas(/Weekend sold 5 new paid teams/));
  await recapMsg().evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await boardReady();
  await recapMsg().evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(600);
  await shot('report.png');
  // the board on the full canvas
  await recapMsg().getByText(/Full screen/).first().click();
  await page.waitForTimeout(3500);
  await shot('report-board.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

// ── 8. The question with options ──
if (on('ask')) {
  await view('Messages');
  const q = page.locator('article.agent-msg').filter({ hasText: 'Dig in?' }).last();
  await until('question', async () => (await q.count()) > 0);
  await q.evaluate((e) => e.scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(800);
  await shot('ask.png');
}

// ── 9. Answer in the thread (a live resume), then the thread ──
if (on('thread')) {
  await view('Messages');
  const q = page.locator('article.agent-msg').filter({ hasText: 'Dig in?' }).last();
  await until('question', async () => (await q.count()) > 0);
  await q.evaluate((e) => e.scrollIntoView({ block: 'end' }));
  await q.getByText('Reply in thread', { exact: true }).first().click();
  await until('thread panel', visible('.agent-thread-body'));
  const input = page.locator('.agent-thread-composer textarea').first();
  await input.click();
  await page.keyboard.type(REPLY, { delay: 25 });
  await page.waitForTimeout(400);
  await shot('thread-typed.png');
  await page.keyboard.press('Enter');
  const cache = join(VAULT, '_dream_context/automations/cache/weekend-recap.json');
  await until('resumed run finished', async () => {
    const c = JSON.parse(readFileSync(cache, 'utf8'));
    return c.status === 'ok';
  }, 900000);
  await until('thread shows follow-up', bodyHas(/Reply delivered|Finished|replied/i), 60000);
  await page.waitForTimeout(3000);
  await shot('thread.png');
  await page.locator('.agent-thread-body').first().evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await page.waitForTimeout(800);
  await shot('thread-end.png');
  await page.keyboard.press('Escape');
}

// ── 10. Detail panel: flow, pattern, runs ──
if (on('detail')) {
  await view('Agents');
  await until('cards', async () => (await page.locator('.agent-card').count()) >= 4);
  await page.locator('.agent-card').filter({ hasText: 'Weekend recap' }).getByRole('button', { name: 'Runs' }).click();
  await until('detail', visible('.adp-panel'));
  await until('flow drawn', async () => !(await bodyHas(/Loading flow|Loading…/)()), 30000);
  await page.waitForTimeout(1500);
  await shot('detail.png');
  const body = page.locator('.adp-body').first();
  await body.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await page.waitForTimeout(800);
  await shot('detail-history.png');
  await page.keyboard.press('Escape');
}

// ── 11. Blocked until approved on this machine ──
if (on('approve')) {
  const slug = process.env.APPROVE_SLUG ?? 'release-notes-writer';
  await view('Agents');
  await until('needs approval', bodyHas(/needs approval/), 30000);
  await page.waitForTimeout(600);
  await shot('approve-card.png');
  await page.locator('.agent-card').filter({ hasText: 'Release notes writer' }).getByRole('button', { name: 'Runs' }).click();
  await until('blocked panel', visible('.adp-approve-btn'));
  await page.locator('.adp-approve-btn').evaluate((e) => e.scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(800);
  await shot('approve.png');
  if (process.env.CLICK_APPROVE !== '0') {
    await page.locator('.adp-approve-btn').click();
    await until('approved', bodyHas(/approved — it will run on this machine/), 20000);
    await page.waitForTimeout(600);
    await shot('approve-done.png');
  }
  console.log('  · approved', slug);
}

// ── A real @mention: the on-call agent answers in the channel (one live run) ──
if (on('mention')) {
  await view('Messages');
  const input = page.locator('.agents-composer textarea').first();
  await input.click();
  await page.keyboard.type('@pricing', { delay: 60 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter'); // pick from the @ menu
  await page.waitForTimeout(300);
  const typed = await input.inputValue();
  if (!/@pricing-page-review/.test(typed)) await input.fill('@pricing-page-review ');
  await page.keyboard.type(MENTION.replace('@pricing-page-review ', ''), { delay: 25 });
  await page.waitForTimeout(500);
  console.log('  · draft:', await input.inputValue());
  await page.keyboard.press('Enter');
  const cache = join(VAULT, '_dream_context/automations/cache/pricing-page-review.json');
  await until('mention run finished', async () => existsSync(cache) && JSON.parse(readFileSync(cache, 'utf8')).status === 'ok', 600000);
}

await b.close();
console.log("done");
