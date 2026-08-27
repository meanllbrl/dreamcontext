/**
 * Capture the v0.26.1 announcement screenshots — the release where a project stops
 * being alone.
 *
 * Run against a dashboard serving the cut's own build in desktop mode (the launcher's
 * Space view and the vault logos only exist there) over the DEMO VAULT SET — never
 * over the author's real registry:
 *   npm run build
 *   node e2e/announce-demo-vaults.mjs
 *   HOME=$(node e2e/announce-demo-vaults.mjs --print-home) \
 *     DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45778
 *   BASE=http://127.0.0.1:45778 node e2e/announce-shots-0-26.mjs
 *
 * The demo home is not a nicety. Every scene below frames the PROJECT LIST — the
 * orbit, the `@` picker, the peer rows — so shooting it on a real machine publishes
 * the author's client work inside the npm tarball. It did: the first cut of this
 * story shipped five private project names and a peer product's business description.
 * `announce-demo-vaults.mjs` gives `listVaults()` a synthetic registry via $HOME, so
 * there is nothing real on screen to leak.
 *
 * Because the demo home is isolated, there is no `.agent-sessions.json` of the
 * author's to protect — opening tabs here rewrites a throwaway roster.
 *
 * Deterministic scenes ONLY. Every shot here is a surface at rest or one click deep:
 * no message is sent, no peer is woken, no announcement is posted. Waking every vault
 * for a screenshot costs N real Claude turns, and the room reads the same empty.
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that can't be reached is reported and skipped, so
 * the story includes only what was actually captured.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';
const ID = 'v0-26-1';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const captured = [];
const vis = (sel) => page.locator(sel).locator('visible=true');

/** Shoot a NAMED page — needed since the Meeting Room became its own window, which in a
 *  browser arrives as a second page rather than an overlay on this one. */
async function shotOf(target, name) {
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  captured.push(name);
  console.log('  ✓', name);
}

async function shot(name) {
  await shotOf(page, name);
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
      height: Math.min(opts.maxHeight ?? 620, box.height + pad + (opts.padTop ?? pad)),
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
 * if you rip its node out. Dismiss it the way a reader does — the button also writes
 * the read state, so it stays gone for the rest of the run. Never Escape: the agent
 * surface is itself an overlay and a stray Escape closes what we just opened.
 */
async function dismissScrims() {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.count()) {
    await gotIt.first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
}

// The author's own docked session names float over every page and read as clutter
// in someone else's release notes.
const HIDE_DOCK = '.agent-dock { display: none !important; }';

// ─── The launcher: every vault wearing its logo ──────────────────────────────
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await dismissScrims();
await page.addStyleTag({ content: HIDE_DOCK });

try {
  // The launcher remembers its last view and List is the common landing. Space is
  // where the core logo (the room's only entrance) and the wired orbit live.
  const spaceToggle = page.getByRole('button', { name: /^Space$/ });
  if (await spaceToggle.count()) {
    await spaceToggle.first().click();
    await page.waitForTimeout(2500);
  }
  await page.waitForSelector('.space-core', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await shot('launcher');
} catch (err) {
  console.log('  ! skipped launcher -', err.message.split('\n')[0]);
}

// ─── The Meeting Room: the hidden surface behind the core logo ───────────────
// The single entrance, by design — no CLI verb, no menu item. Since 0.26.2 the core
// opens the room in its OWN window, which in a browser is a new PAGE — so the shot has
// to be taken on the page the click produced, not on the launcher that stays behind.
try {
  const opened = page.context().waitForEvent('page', { timeout: 12000 });
  await vis('.space-core').first().click();
  const room = await opened;
  await room.setViewportSize(page.viewportSize());
  await room.waitForSelector('.meeting-window', { timeout: 12000 });
  await room.waitForTimeout(1800);
  await shotOf(room, 'meeting-room');
  await room.close();
  // No roster crop: an empty room has no participant strip to shoot, and a claim
  // whose picture cannot be taken is dropped rather than illustrated with a stand-in.
} catch (err) {
  console.log('  ! skipped meeting-room -', err.message.split('\n')[0]);
}

// ─── The composer's @ menu: a peer you can address, wearing its own logo ─────
// A demo vault that HAS peers — `acme-storefront` is wired to acme-payments and
// acme-design, so the `@` picker has rows to draw. Pointing this at the real vault
// is what put a client product's description in the shipped story.
const PEER_VAULT = process.env.PEER_VAULT ?? 'acme-storefront';
await page.goto(`${BASE}/?vault=${PEER_VAULT}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await dismissScrims();
// NOTE the ordering: the dock is hidden AFTER the surface is expanded, not before.
// `display: none` on `.agent-dock` also kills the chip that expands it, so hiding
// first makes the click a silent no-op and the composer wait burns its full timeout.

// The surface starts DOCKED: its composer is in the DOM but has no box, so a bare
// `.chat-cmp-input` wait passes on something the camera can't see while a `:visible`
// wait hangs forever. `.agent-surface` itself is not clickable-to-expand — clicking
// it does nothing and the run burns its timeout.
//
// TWO expanders, and which one exists depends on the vault's session history: a vault
// with sessions docks them as `.agent-dock-chip`s, a vault with NONE docks a single
// `.agent-fab`. The demo vault is always the second case, so a chip-only wait is what
// made this scene time out at 90s and ship the old, leaking crop unchanged.
if (!(await page.locator('.agent-surface.expanded').count())) {
  const expander = (await page.locator('.agent-dock-chip').count())
    ? page.locator('.agent-dock-chip')
    : page.locator('.agent-fab');
  await expander.first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(3000);
}
// A fresh session CAN spend 90s+ on the SessionStart brain preload before its composer
// paints — on a mature vault. The demo brain is small, so this returns in about a
// second; the wait below is sized for the slow case either way.
if (!(await vis('.chat-cmp-input').count())) {
  await page.getByRole('button', { name: /Start chat/ }).first().click().catch(() => {});
}

try {
  // The spawn carries the SessionStart brain preload — wait on the DOM, not a clock.
  await page.locator('.chat-cmp-input').locator('visible=true').first()
    .waitFor({ state: 'visible', timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.addStyleTag({ content: HIDE_DOCK });

  await vis('.chat-cmp-input').first().click();
  await page.keyboard.type('@');
  await page.waitForSelector('.chat-cmp-mention', { timeout: 8000 });
  await page.waitForTimeout(800);

  // The picker alone crops to a ~2700x190 strip, which renders as a hairline in a
  // `split` column. Shoot the picker TOGETHER with the composer it sits above: the
  // typed `@` is what explains the menu, and the pair has a readable aspect ratio.
  try {
    const menuBox = await vis('.chat-cmp-mention').first().boundingBox();
    const cmpBox = await vis('.chat-cmp-card, .chat-cmp').first().boundingBox();
    if (!menuBox || !cmpBox) throw new Error('no box');
    const top = Math.max(0, menuBox.y - 16);
    const bottom = Math.min(2000, cmpBox.y + cmpBox.height + 16);
    const path = join(ROOT, ID, 'peer-mention.png');
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({
      path,
      clip: {
        x: Math.max(0, menuBox.x - 16),
        y: top,
        width: Math.min(1600, menuBox.width + 32),
        height: bottom - top,
      },
    });
    captured.push('peer-mention');
    console.log('  ✓ peer-mention');
  } catch (err) {
    console.log('  ! skipped peer-mention -', err.message.split('\n')[0]);
  }

  // Leave the composer as we found it.
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
} catch (err) {
  console.log('  ! skipped mention-menu -', err.message.split('\n')[0]);
}

await b.close();
console.log('captured:', captured.join(', ') || '(none)');
