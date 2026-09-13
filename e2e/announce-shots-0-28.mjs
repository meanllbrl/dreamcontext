/**
 * Capture the v0.28.0 announcement screenshots — the release where the agent starts
 * listening, and draws.
 *
 * Run against a dashboard serving THIS CUT's own build, in desktop mode, over the
 * DEMO VAULT SET — never over the author's real registry:
 *   npm run build
 *   node e2e/announce-demo-vaults.mjs
 *   HOME=$(node e2e/announce-demo-vaults.mjs --print-home) \
 *     DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45779
 *   BASE=http://127.0.0.1:45779 node e2e/announce-shots-0-28.mjs
 *
 * The fake HOME carries the same reason it carried for 0.27.0: the Agents settings
 * page names every Claude account the author is signed into. Nothing real is on
 * screen here.
 *
 * THE DESKTOP FLAG IS FAKED FOR THE VOICE SCENES, and only for them. `isDesktop()`
 * reads `window.__TAURI_INTERNALS__`, and two of this version's surfaces are drawn
 * only in the desktop app — the composer's microphone, and the Voice card's own
 * "hold the microphone" note (the web build correctly says voice is desktop-only).
 * Shooting them from Chromium without the flag would publish the FALLBACK copy as if
 * it were the feature. The flag is set on the page and nothing else is stubbed: every
 * pixel below is the same component tree the .app renders, and any Tauri call it
 * makes is dynamically imported and already falls back on absence.
 *
 * Deterministic scenes ONLY — surfaces at rest or one click deep. No message is sent,
 * no account is probed, no microphone is opened.
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that cannot be reached is reported and skipped, so
 * the story is built from what was actually captured rather than from what was planned.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45779';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';
const ID = 'v0-28-0';
const VAULT = process.env.DEMO_VAULT ?? 'acme-storefront';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
// See the header: the desktop half of two surfaces cannot be photographed without it.
await page.addInitScript(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
});
// The account panel's live refresh spawns a real `claude` per account; against the
// demo home that cannot succeed and every row would read "Signed out". Cancelling it
// leaves the CACHED reading on screen, which is what a real machine draws between
// refreshes. (Same reasoning, same route, as the 0.27.0 script.)
await page.route('**/api/agent/accounts/refresh', (route) => route.abort());

/** The app's own title bar + tab strip. A crop must never start above this: the strip is
 *  chrome, and a sliver of a cut-off tab in a release screenshot reads as a bug. */
const CHROME_PX = 120;

const captured = [];
const vis = (sel) => page.locator(sel).locator('visible=true');

async function shot(name) {
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
  captured.push(name);
  console.log('  ✓', name);
}

async function crop(name, selector, opts = {}) {
  try {
    const box = await vis(selector).first().boundingBox();
    if (!box) throw new Error('no box');
    const pad = opts.pad ?? 12;
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - (opts.padTop ?? pad)),
      width: Math.min(1600, box.width + pad * 2),
      height: Math.min(opts.maxHeight ?? 700, box.height + pad + (opts.padTop ?? pad)),
    };
    const path = join(ROOT, ID, `${name}.png`);
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, clip });
    captured.push(name);
    console.log('  ✓', name);
  } catch (err) {
    console.log('  ! skipped', name, '-', err.message.split('\n')[0]);
  }
}

/** Dismiss the What's New popup the way a reader does. Never Escape — several scenes
 *  here are overlays and a stray Escape closes what was just opened. */
async function dismissScrims() {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.count()) {
    await gotIt.first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
}

const HIDE_DOCK = '.agent-dock, .agent-fab { display: none !important; }';

async function openVault() {
  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await dismissScrims();
  await page.addStyleTag({ content: HIDE_DOCK });
}

async function nav(label) {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).first().click();
  await page.waitForTimeout(2500);
}

async function openSettings(section) {
  await nav('Settings');
  await page.getByRole('button', { name: new RegExp(`^${section}`) }).first().click();
  await page.waitForTimeout(2000);
}

/** Put `selector` at the TOP of the viewport, then clip to it. The settings page grows
 *  rather than scrolls internally, so a card near the bottom is simply off-screen until
 *  something scrolls the window — and a boundingBox below the fold clips to nothing. */
async function cropTop(name, selector, opts = {}) {
  try {
    const el = vis(selector).first();
    await el.evaluate((n) => { n.scrollIntoView({ block: 'start' }); window.scrollBy(0, -140); });
    await page.waitForTimeout(opts.settle ?? 800);
    const box = await el.boundingBox();
    if (!box) throw new Error('no box');
    const pad = opts.pad ?? 16;
    const top = Math.max(CHROME_PX, box.y - pad);
    const path = join(ROOT, ID, `${name}.png`);
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({
      path,
      clip: {
        x: Math.max(0, box.x - pad),
        y: top,
        width: Math.min(1600 - Math.max(0, box.x - pad), box.width + pad * 2),
        height: Math.min(1000 - top, Math.min(opts.maxHeight ?? 900, box.height + pad * 2)),
      },
    });
    captured.push(name);
    console.log('  ✓', name);
  } catch (err) {
    console.log('  ! skipped', name, '-', err.message.split('\n')[0]);
  }
}

/** Clip the region that RUNS FROM one element TO the bottom of another. A crop keyed to a
 *  single container photographs whatever that container happens to hold — here, the whole
 *  Claude-accounts group, when the subject is only the policy at the end of it. */
async function cropSpan(name, fromSel, toSel, opts = {}) {
  try {
    const from = vis(fromSel).first();
    // `block: 'start'` parks the subject directly under the app's own tab bar, so a clip
    // that pads upward bleeds a cut-off tab and a zoom control into the shot. Nudge the
    // page back down so the padding lands on empty page instead of on chrome — and clamp
    // the clip below {@link CHROME_PX} as well, because a nudge alone is a guess about a
    // header height that the clip can still overshoot.
    await from.evaluate((n) => { n.scrollIntoView({ block: 'start' }); window.scrollBy(0, -140); });
    await page.waitForTimeout(opts.settle ?? 800);
    const a = await from.boundingBox();
    const b2 = await vis(toSel).first().boundingBox();
    if (!a || !b2) throw new Error('no box');
    const pad = opts.pad ?? 20;
    const top = Math.max(CHROME_PX, a.y - pad);
    const path = join(ROOT, ID, `${name}.png`);
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({
      path,
      clip: {
        x: Math.max(0, a.x - pad),
        y: top,
        width: Math.min(1600 - Math.max(0, a.x - pad), Math.max(a.width, b2.width) + pad * 2),
        height: Math.min(1000 - top, b2.y + b2.height + pad - top),
      },
    });
    captured.push(name);
    console.log('  ✓', name);
  } catch (err) {
    console.log('  ! skipped', name, '-', err.message.split('\n')[0]);
  }
}

// ─── 1 · The Voice card ──────────────────────────────────────────────────────
// One key, one push-to-talk chord, and the preferences that decide how it listens and
// how it answers. Folded by default at the bottom of Agents, so it takes one click.
try {
  await openVault();
  await openSettings('Agents');
  await page.waitForTimeout(1500);
  const voice = page.getByText(/Voice — J\.A\.R\.V\.I\.S mode/).first();
  await voice.evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await voice.click();
  await page.waitForTimeout(1200);
  await cropTop('voice-settings', '.setting-group:has-text("J.A.R.V.I.S")', { maxHeight: 900 });
} catch (err) {
  console.log('  ! skipped voice-settings -', err.message.split('\n')[0]);
}

// ─── 2 · Every account, and the policy that picks between them ───────────────
// Shot at rest: no account is switched and no live probe is fired. The bars come from
// each sandbox's own usage cache, read by the ordinary reader.
try {
  await openVault();
  await openSettings('Agents');
  await page.waitForSelector('.dc-acct-list', { timeout: 15000 });
  await page
    .locator('.dc-acct-list')
    .locator('text=/Reading usage/')
    .first()
    .waitFor({ state: 'detached', timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  await cropTop('accounts', '.dc-acct-list', { maxHeight: 620 });
  await cropSpan('switch-policy', 'text=How the next account is picked', '.dc-acct-weight-formula');
} catch (err) {
  console.log('  ! skipped accounts -', err.message.split('\n')[0]);
}

await b.close();
console.log('captured:', captured.join(', ') || '(none)');
