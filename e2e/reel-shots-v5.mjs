/**
 * Reel v5 (sleep model) — REAL captures of the fictional "orbit" brain around ONE real sleep.
 *
 *   ROOT=/tmp/dc-reel-v5 DC=<repo>/marketing/dist-snap/index.js ./marketing/build-demo-vault-v5.sh
 *   (cd /tmp/dc-reel-v5/proj && HOME=/tmp/dc-reel-v5/home DREAMCONTEXT_DESKTOP=1 \
 *      node <repo>/marketing/dist-snap/index.js dashboard --no-open -p 45911)
 *   STEP=before node e2e/reel-shots-v5.mjs      # before the day session + sleep
 *   STEP=pill   TAG=d34 node e2e/reel-shots-v5.mjs   # one sleep-debt pill state
 *   STEP=after  node e2e/reel-shots-v5.mjs      # after the real sleep
 *
 * 1440x900, DPR 2, light. Never opens the launcher. Unlike v4 the sleep-debt pill is ON
 * camera here (it is the subject); the live-session docks stay hidden.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45911';
const OUT = process.env.OUT ?? 'marketing/remotion/capture-v5';
const STEP = process.env.STEP ?? 'before';
const TAG = process.env.TAG ?? STEP;
mkdirSync(OUT, { recursive: true });

const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],.agent-fab,.auto-dispatch-pill{display:none!important}`;

const b = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
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
  await page.waitForTimeout(900);
}
async function guard(name) {
  // privacy gate: no email address may ever be on a frame
  const t = await page.locator('body').innerText();
  if (/@[a-z0-9-]+\.[a-z]/i.test(t)) console.log('  ⚠', name, 'PAGE TEXT CARRIES AN EMAIL — do not use');
}
async function shot(name, opts = {}) {
  await page.addStyleTag({ content: CLEAN });
  await page.waitForTimeout(350);
  await guard(name);
  await page.screenshot({ path: join(OUT, `${name}.png`), ...opts });
  console.log('  ✓', name);
}
async function clipOf(name, sel, pad = 0) {
  const r = await page.locator(sel).first().boundingBox();
  if (!r) { console.log('  ✗', name, '(not found)'); return; }
  await shot(name, { clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 } });
}
/** the smallest framed box around the element whose own text starts with `text` (v4 frags) */
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
  await shot(name, { clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 } });
}

await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar-item', { timeout: 30000 });
await page.waitForTimeout(1500);
for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));

async function pill() {
  await page.waitForTimeout(2500); // the tracker polls
  await clipOf(`pill-${TAG}`, '.sleep-tracker-wrap', 6);
  await shot(`top-${TAG}`, { clip: { x: 0, y: 0, width: 1440, height: 90 } });
}

if (STEP === 'pill') {
  await nav('Tasks');
  await pill();
}

if (STEP === 'live') {
  // the Sleep Cycle page while a REAL sleep runs: one frame every LIVE_EVERY ms until LIVE_N
  await nav('Sleep Cycle');
  const n = Number(process.env.LIVE_N ?? 60), every = Number(process.env.LIVE_EVERY ?? 10000);
  mkdirSync(join(OUT, 'live'), { recursive: true });
  for (let i = 0; i < n; i++) {
    await shot(`live/s${String(i).padStart(3, '0')}`);
    await page.waitForTimeout(every);
  }
}

if (STEP === 'before' || STEP === 'after') {
  await nav('Tasks');
  await until('tasks', bodyHas(/Investigate trial-to-paid drop/));
  await pill();
  await shot(`win-tasks-${TAG}`);

  await nav('Sleep Cycle');
  await page.waitForTimeout(1500);
  await shot(`win-sleep-${TAG}`);
  await clipOf(`sidebar-${TAG}`, 'aside, .sidebar', 0);

  await nav('Knowledge');
  await page.waitForTimeout(1500);
  await shot(`win-knowledge-${TAG}`);
  const doc = page.getByText('trial-interviews-sept', { exact: true });
  if (await doc.count()) {
    await doc.first().click();
    await until('kdoc', bodyHas(/Value only appears once a second data source/));
    await page.waitForTimeout(800);
    await shot(`win-kdoc-${TAG}`);
  }

  await nav('Hypotheses');
  await until('hyp', bodyHas(/The new onboarding emails/));
  const mark = page.getByText('Mark all read', { exact: true });
  if (await mark.count()) { await mark.first().click(); await page.waitForTimeout(1500); }
  await shot(`win-hyp-${TAG}`);
  await card(`hyp-emails-${TAG}`, 'The new onboarding emails', { maxW: 400 });
  await card(`hyp-second-${TAG}`, 'Trials that connect a second', { maxW: 400 });

  await nav('Roadmap');
  await until('roadmap', bodyHas(/Ship the public beta/));
  await page.waitForTimeout(1500);
  await shot(`win-roadmap-${TAG}`);
  await card(`obj-beta-${TAG}`, 'Ship the public beta', { maxW: 1100 });
}

await b.close();
console.log('done', STEP, TAG);
