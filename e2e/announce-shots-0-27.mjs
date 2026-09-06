/**
 * Capture the v0.27.0 announcement screenshots — the release where one agent stops
 * being one account.
 *
 * Run against a dashboard serving THIS CUT's own build, in desktop mode, over the
 * DEMO VAULT SET — never over the author's real registry:
 *   npm run build
 *   node e2e/announce-demo-vaults.mjs
 *   HOME=$(node e2e/announce-demo-vaults.mjs --print-home) \
 *     DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45779
 *   BASE=http://127.0.0.1:45779 node e2e/announce-shots-0-27.mjs
 *
 * The fake HOME is not a nicety and not optional here. Two of this version's headline
 * scenes are the WORST possible things to shoot on a real machine: the account list
 * names every Claude account the author is signed into, and the task board names their
 * work. `announce-demo-vaults.mjs` repoints `listVaults()` via $HOME, so there is
 * nothing real on screen to leak. Five stories have already shipped with real names in
 * them; that is what this harness exists to stop.
 *
 * Deterministic scenes ONLY. Every shot is a surface at rest or one click deep — no
 * message is sent, no account is switched, no limit is probed against the real API.
 * A live switch would cost a real turn and would put a real account's usage on screen.
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that cannot be reached is reported and skipped, so
 * the story is built only from what was actually captured. A claim whose picture could
 * not be taken gets dropped from the story rather than illustrated with an old shot.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45779';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';
const ID = 'v0-27-0';
const VAULT = process.env.DEMO_VAULT ?? 'acme-storefront';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const captured = [];
const vis = (sel) => page.locator(sel).locator('visible=true');

/**
 * Never let the account panel's live refresh reach the machine.
 *
 * `POST /api/agent/accounts/refresh` spawns a real `claude` per account to re-read its
 * limits. Against the demo home that spawn cannot succeed — the sandboxes hold a
 * synthetic identity and no credential — so the panel correctly falls back to
 * "Signed out — sign in again to read its usage" on every row, and the headline shot
 * ends up advertising the feature as broken. Cancelling the request leaves the panel
 * showing its CACHED reading, which is exactly what a real machine with valid logins
 * draws between refreshes. Nothing is faked: the bars are read from the cache file.
 */
await page.route('**/api/agent/accounts/refresh', (route) => route.abort());

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

/**
 * The What's New popup arrives on its own schedule and, being React state, re-mounts
 * if you rip its node out. Dismiss it the way a reader does. Never Escape: several
 * surfaces here are overlays and a stray Escape closes what we just opened.
 */
async function dismissScrims() {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.count()) {
    await gotIt.first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
}

// The author's own docked session names float over every page and read as clutter in
// someone else's release notes. Hidden AFTER any click that needs the dock's own chip.
const HIDE_DOCK = '.agent-dock { display: none !important; }';

/**
 * Land on the vault window with the scrims gone and the dock hidden.
 *
 * NOT a hash route. The app navigates by clicking its own sidebar, and a `#/tasks`
 * URL simply leaves you on whatever page was already up — which is how the first run
 * of this script "captured" three different scenes that were all the same shell.
 */
async function openVault() {
  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await dismissScrims();
  await page.addStyleTag({ content: HIDE_DOCK });
}

/** Click a top-level sidebar destination by label. */
async function nav(label) {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).first().click();
  await page.waitForTimeout(2500);
}

/** Settings, then one of its own nav rows. */
async function openSettings(section) {
  await nav('Settings');
  await page.getByRole('button', { name: new RegExp(`^${section}`) }).first().click();
  await page.waitForTimeout(2000);
}

// ─── 1 · Multi-account agents: the headline ──────────────────────────────────
// Both limits per account, drawn as bars, with the list order being the priority.
// Shot at rest: no account is switched and no live probe is fired, so nothing here
// reaches the real API or puts a real account's usage on screen.
try {
  await openVault();
  await openSettings('Agents');
  await page.waitForSelector('.dc-accts', { timeout: 15000 });
  // The panel fires a live usage probe on mount. Shooting through it captures three
  // rows saying "Reading usage…" with half-drawn bars — technically the real app, but
  // the hero is meant to show the READING, not the fetch. Wait for the probe to settle
  // (each row falls back to "read N ago"), then shoot.
  await page
    .locator('.dc-acct-list')
    .locator('text=/Reading usage/')
    .first()
    .waitFor({ state: 'detached', timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
  await shot('agents-accounts');
  await crop('agents-accounts-crop', '.dc-acct-list', { maxHeight: 560 });
} catch (err) {
  console.log('  ! skipped agents-accounts -', err.message.split('\n')[0]);
}

// ─── 2 · Statuses you declare ────────────────────────────────────────────────
// The board is the proof: a status that exists only because this project declared it,
// sitting alongside the four shipped ones.
try {
  await openVault();
  await nav('Tasks');
  // The proof is the two columns that exist only because this project declared them.
  await page.getByText('Blocked', { exact: false }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await shot('task-board');
} catch (err) {
  console.log('  ! skipped task-board -', err.message.split('\n')[0]);
}

// ─── 3 · Sleep on thresholds you set ─────────────────────────────────────────
// The ladder — Drowsy < Sleepy < Must Sleep — is what the brain now consolidates on
// without being asked. (The word "Sleepy" here is the DEBT LEVEL, which this version
// keeps; the Lab capture bar of the same name is what it removed.)
try {
  await openVault();
  await openSettings('Sleep$');
  await page.waitForSelector('.settings-page', { timeout: 15000 });
  await page.waitForTimeout(1200);
  await shot('sleep-thresholds');
} catch (err) {
  console.log('  ! skipped sleep-thresholds -', err.message.split('\n')[0]);
}

// ─── 4 · Settings, one grammar ───────────────────────────────────────────────
// Four groups, one description each, no Save button — the page that stopped repeating
// itself. Also the shot that PROVES the Sleepy section is gone: its nav row is absent.
try {
  await openVault();
  await openSettings('Platforms');
  await page.waitForTimeout(1000);
  await crop('settings-nav', '.settings-nav', { maxHeight: 900 });
} catch (err) {
  console.log('  ! skipped settings-nav -', err.message.split('\n')[0]);
}

// ─── 5 · Lab reports: one window, inherited ──────────────────────────────────
try {
  await openVault();
  await nav('Insights');
  await page.waitForTimeout(1500);
  await shot('lab');
} catch (err) {
  console.log('  ! skipped lab -', err.message.split('\n')[0]);
}

// ─── 6 · The launcher, after the startup work ────────────────────────────────
// Nothing about the fix is visible in a still — it is four waits that no longer
// happen. The shot earns its place as the surface those waits were in FRONT of, and
// the block's copy carries the measured numbers rather than asking the picture to.
try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await dismissScrims();
  await page.addStyleTag({ content: HIDE_DOCK });
  await page.waitForTimeout(1000);
  await shot('launcher');
} catch (err) {
  console.log('  ! skipped launcher -', err.message.split('\n')[0]);
}

await b.close();
console.log('captured:', captured.join(', ') || '(none)');
