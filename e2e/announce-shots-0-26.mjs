/**
 * Capture the v0.26.1 announcement screenshots — the release where a project stops
 * being alone.
 *
 * Run against a dashboard serving the cut's own build, over the REAL vault, in
 * desktop mode (the launcher's Space view and the vault logos only exist there):
 *   npm run build
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots-0-26.mjs
 *
 * Back up `_dream_context/state/.agent-sessions.json` before running and restore it
 * after — opening tabs rewrites the saved roster (the skill's first hard rule).
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
// The single entrance, by design — no CLI verb, no menu item.
try {
  await vis('.space-core').first().click();
  await page.waitForSelector('.meeting-room, .meeting-rail', { timeout: 12000 });
  await page.waitForTimeout(1800);
  await shot('meeting-room');
  // No roster crop: an empty room has no participant strip to shoot, and a claim
  // whose picture cannot be taken is dropped rather than illustrated with a stand-in.
} catch (err) {
  console.log('  ! skipped meeting-room -', err.message.split('\n')[0]);
}

// ─── The composer's @ menu: a peer you can address, wearing its own logo ─────
await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await dismissScrims();
// NOTE the ordering: the dock is hidden AFTER the surface is expanded, not before.
// `display: none` on `.agent-dock` also kills the chip that expands it, so hiding
// first makes the click a silent no-op and the composer wait burns its full timeout.

// The surface starts DOCKED: its composer is in the DOM but has no box, so a bare
// `.chat-cmp-input` wait passes on something the camera can't see while a `:visible`
// wait hangs forever. The dock CHIP is the expander (`.agent-surface` itself is not
// clickable-to-expand — clicking it does nothing and the run burns its timeout).
if (!(await page.locator('.agent-surface.expanded').count())) {
  await page.locator('.agent-dock-chip').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(3000);
}
// Deliberately NOT "New chat": a fresh session spends 90s+ on the SessionStart brain
// preload before its composer paints, and the shot we want here is a CROP of the `@`
// picker, so whatever sits behind it never reaches the frame.
if (!(await vis('.chat-cmp-input').count())) {
  await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
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
