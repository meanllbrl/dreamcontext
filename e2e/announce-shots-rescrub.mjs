/**
 * Re-capture the announcement screenshots that shipped the author's private data.
 *
 * Five stills in three released stories were shot on a real machine and published
 * inside the npm tarball:
 *
 *   v0-24-0/chip-strip.png   a client's entire task board, in Turkish, plus 4 vault names
 *   v0-24-0/chip-status.png  the same 4 vault names, cropped
 *   v0-23-1/core.png         the owner's full name in the PEOPLE section
 *   v0-23-1/people.png       the same, cropped to it
 *   v0-26-1/{launcher,peer-mention}.png  (already re-shot by announce-shots-0-26.mjs)
 *
 * This script re-takes the first four against the demo vault set, framing the SAME
 * claim each original made — same surface, same crop, nothing real on screen.
 *
 *   npm run build
 *   node e2e/announce-demo-vaults.mjs
 *   HOME=$(node e2e/announce-demo-vaults.mjs --print-home) \
 *     DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45778
 *   BASE=http://127.0.0.1:45778 node e2e/announce-shots-rescrub.mjs
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that can't be reached is reported and skipped.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45778';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const captured = [];
const vis = (sel) => page.locator(sel).locator('visible=true');

async function shot(id, name) {
  const path = join(ROOT, id, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
  captured.push(`${id}/${name}`);
  console.log('  ✓', id + '/' + name);
}

async function crop(id, name, selector, opts = {}) {
  const box = await vis(selector).first().boundingBox();
  if (!box) throw new Error('no box for ' + selector);
  const pad = opts.pad ?? 12;
  const path = join(ROOT, id, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({
    path,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(1600, box.width + pad * 2),
      height: Math.min(opts.maxHeight ?? 1000, box.height + pad * 2),
    },
  });
  captured.push(`${id}/${name}`);
  console.log('  ✓', id + '/' + name);
}

async function dismissScrims() {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.count()) {
    await gotIt.first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
}

// The author's own docked session names float over every page and read as clutter
// in someone else's release notes.
const HIDE_DOCK = '.agent-dock, .agent-fab { display: none !important; }';

/** Open a chat in the active project WITHOUT sending anything.
 *  A started-but-unsent session is what puts a live count on the chip, and it costs
 *  nothing — no turn is spent until a message goes. That is the honest way to shoot
 *  "every one of them still running": the sessions in the frame are real. */
async function startIdleChat() {
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const expander = (await page.locator('.agent-dock-chip').count())
      ? page.locator('.agent-dock-chip')
      : page.locator('.agent-fab');
    await expander.first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).first().click().catch(() => {});
    await page.locator('.chat-cmp-input').locator('visible=true').first()
      .waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
  }
  // Collapse again so the next project opens onto its own page, not this overlay.
  await page.locator('.agent-overlay-collapse').first().click().catch(() => {});
  await page.waitForTimeout(800);
}

// ─── v0.24.0: the chip strip — every project open in one window ──────────────
// The claim is "four projects, one window, none of them asleep", so the strip has to
// carry four chips WITH live counts. `?vault=` REPLACES the open project rather than
// adding to it — that is why the first re-shoot came back with a single chip. The
// strip's own `+` is the add.
try {
  await page.goto(`${BASE}/?vault=acme-storefront`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await dismissScrims();
  await startIdleChat();

  for (const v of ['acme-payments', 'acme-design', 'atlas-mobile']) {
    await page.locator('.project-tabs-add').first().click();
    await page.waitForTimeout(900);
    await page.getByText(v, { exact: true }).first().click();
    await page.waitForTimeout(2500);
    await dismissScrims();
    if (v !== 'atlas-mobile') await startIdleChat();
  }

  // Back to the project whose board has something on it — the original framed the
  // active project's tasks under the strip, and an empty board photographs as
  // "No tasks match these filters".
  await page.locator('.project-tab-main').filter({ hasText: 'acme-storefront' }).first().click();
  await page.waitForTimeout(2500);
  await page.addStyleTag({ content: HIDE_DOCK });
  await page.waitForTimeout(1000);
  await shot('v0-24-0', 'chip-strip');

  await crop('v0-24-0', 'chip-status', '.project-tabs', { pad: 10, maxHeight: 120 });
} catch (err) {
  console.log('  ! skipped chip strip -', err.message.split('\n')[0]);
}

// ─── v0.23.1: the Core page — a person, then the core files ─────────────────
// The original shot the owner's real full name under PEOPLE. A demo vault's person is
// the generic "Owner" `init` writes, which is the same shape and nobody's identity.
try {
  await page.goto(`${BASE}/?vault=acme-storefront`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await dismissScrims();
  // The route is a nav click, not a hash — `#/core` leaves you on the board.
  await page.getByText(/^Core$/).first().click();
  await page.waitForSelector('.core-page', { timeout: 12000 });
  await page.waitForTimeout(1800);
  await page.addStyleTag({ content: HIDE_DOCK });
  await page.waitForTimeout(600);
  await shot('v0-23-1', 'core');

  await crop('v0-23-1', 'people', '.core-list', { pad: 8, maxHeight: 900 });
} catch (err) {
  console.log('  ! skipped core/people -', err.message.split('\n')[0]);
}

await b.close();
console.log('captured:', captured.join(', ') || '(none)');
