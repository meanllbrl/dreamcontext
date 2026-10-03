#!/usr/bin/env node
/**
 * Whiteboard tabs: the boards sit side by side as Chrome-style tabs, in real Chromium.
 *
 *   npm run build && node scripts/verify/whiteboard-tabs.mjs
 *
 * Boots the REAL dashboard server from the BUILT dashboard + CLI on an isolated scratch vault
 * (fake HOME), seeds three boards with the CLI, then proves:
 *   T1  opening boards from "All boards" adds them as tabs, in one row, left to right;
 *   T2  a tab click switches the board (the hash follows);
 *   T3  "Add tab to new group" makes a coloured, named group; a second tab joins it from the
 *       menu and the two sit together after the chip; recolouring changes the chip's hue;
 *   T4  a chip click collapses the group (its other tabs leave the strip, the open one stays)
 *       and another click unfolds it;
 *   T5  the layout (order, group, colour, collapse) survives a reload;
 *   T6  dragging a tab onto the strip's start reorders it;
 *   T7  closing a tab first asks "are you sure" (Cancel keeps it); confirmed, it takes the tab
 *       off the strip, the board still exists on disk, the open board moves to its
 *       neighbour; the last tab has no close button;
 *   T8  a deleted board lands in a gitignored local trash, "Recently deleted" lists it, and
 *       Restore brings it back with its content and opens it.
 * Screenshots both themes to <scratch>/shots.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-whiteboard-tabs');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45763;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
const dc = (args, cwd = PROJ) => execFileSync('node', [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not come up at ${url}`);
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], REPO);
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }
  for (const name of ['Launch plan', 'Research notes', 'Pricing ideas']) dc(['whiteboard', 'create', name]);
}

const tabNames = (page) => page.locator('.wbt-tab .wbt-tab-name').allInnerTexts();
const activeName = (page) => page.locator('.wbt-tab[aria-selected="true"] .wbt-tab-name').innerText();

async function openFromAll(page, name) {
  await page.locator('.wbt-all').click();
  await page.locator('.wbs-panel--boards .wbs-row-open', { hasText: name }).click();
  await page.locator('.wbt-tab[aria-selected="true"]', { hasText: name }).waitFor({ timeout: 5000 });
}

async function main() {
  setup();
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(`${ORIGIN}/api/whiteboards`);
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${ORIGIN}/?vault=proj`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    if (await page.locator('.announcements-modal-scrim').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.locator('.sidebar-item', { hasText: /Whiteboard(?!s)/ }).first().click();
    await page.locator('.wbt-tab').first().waitFor({ timeout: 10000 });

    // T1
    ok('T1 the default board opens as the one tab', JSON.stringify(await tabNames(page)) === '["Control Panel"]', JSON.stringify(await tabNames(page)));
    ok('T1 …without a close button while it is the last tab', await page.locator('.wbt-tab-close').count() === 0);
    await openFromAll(page, 'Launch plan');
    await openFromAll(page, 'Research notes');
    await openFromAll(page, 'Pricing ideas');
    const names = await tabNames(page);
    ok('T1 boards opened from All boards become tabs, in order', JSON.stringify(names) === JSON.stringify(['Control Panel', 'Launch plan', 'Research notes', 'Pricing ideas']), JSON.stringify(names));
    const boxes = await page.locator('.wbt-tab').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width })));
    ok('T1 the tabs sit side by side in one row', boxes.every((b) => Math.abs(b.y - boxes[0].y) < 1) && boxes.every((b, i) => i === 0 || b.x >= boxes[i - 1].x + boxes[i - 1].w - 1), JSON.stringify(boxes));
    ok('T1 no dropdown chevron beside the board name any more', await page.locator('.wbt-tab .wbs-chevron').count() === 0);

    // T2
    await page.locator('.wbt-tab', { hasText: 'Launch plan' }).click();
    await page.waitForFunction(() => location.hash.includes('launch-plan'), null, { timeout: 5000 }).catch(() => {});
    ok('T2 a tab click opens its board', (await activeName(page)) === 'Launch plan' && (await page.evaluate(() => location.hash)).includes('launch-plan'), await page.evaluate(() => location.hash));

    // T3
    await page.locator('.wbt-tab', { hasText: 'Research notes' }).click({ button: 'right' });
    await page.locator('.wbt-menu-item', { hasText: 'Add tab to new group' }).click();
    await page.locator('.wbt-editor-name').fill('Research');
    await page.locator('.wbt-swatch[data-color="green"]').click();
    await page.keyboard.press('Escape');
    const chip = page.locator('.wbt-chip');
    ok('T3 a named group chip appears', (await chip.count()) === 1 && (await chip.innerText()).includes('Research'));
    ok('T3 …in the colour picked', await chip.getAttribute('data-color') === 'green');
    const chipBg = await chip.evaluate((e) => getComputedStyle(e).backgroundColor);
    await page.locator('.wbt-tab', { hasText: 'Pricing ideas' }).click({ button: 'right' });
    await page.locator('.wbt-menu-item', { hasText: 'Add to “Research”' }).click();
    const order = await page.locator('.wbt-strip .wbt-chip, .wbt-strip .wbt-tab').evaluateAll((els) => els.map((e) => (e.classList.contains('wbt-chip') ? '[chip]' : e.textContent.trim())));
    ok('T3 the joined tab sits with its group, after the chip', JSON.stringify(order.slice(0, 5)) === JSON.stringify(['Control Panel', 'Launch plan', '[chip]', 'Research notes', 'Pricing ideas']), JSON.stringify(order));
    ok('T3 grouped tabs carry the group colour', await page.locator('.wbt-tab[data-grouped][data-color="green"]').count() === 2);
    const line = await page.locator('.wbt-group').evaluate((g) => {
      const after = getComputedStyle(g, '::after');
      const box = g.getBoundingClientRect();
      const tabs = [...g.querySelectorAll('.wbt-tab')].map((t) => t.getBoundingClientRect());
      return { bg: after.backgroundColor, h: after.height, right: box.right, lastTab: tabs[tabs.length - 1].right, chip: getComputedStyle(g.querySelector('.wbt-chip')).backgroundColor };
    });
    ok('T3 one coloured line runs under the whole group, chip to last tab', line.h === '2px' && line.bg === line.chip && Math.abs(line.right - line.lastTab) < 1, JSON.stringify(line));
    await chip.click({ button: 'right' });
    await page.locator('.wbt-swatch[data-color="blue"]').click();
    await page.keyboard.press('Escape');
    await page.locator('.wbt-tab', { hasText: 'Research notes' }).click();
    const outline = await page.locator('.wbt-tab[aria-selected="true"]').evaluate((t) => [getComputedStyle(t).borderTopColor, getComputedStyle(t.closest('.wbt-group').querySelector('.wbt-chip')).backgroundColor]);
    ok('T3 the open tab of a group is outlined in the group colour', outline[0] === outline[1], JSON.stringify(outline));
    ok('T3 recolouring changes the chip', (await chip.getAttribute('data-color')) === 'blue' && (await chip.evaluate((e) => getComputedStyle(e).backgroundColor)) !== chipBg);
    await page.screenshot({ path: join(SHOTS, 'tabs-light.png'), clip: { x: 0, y: 0, width: 1440, height: 120 } });

    await page.locator('.wbt-tab', { hasText: 'Launch plan' }).click();
    // T4 (open board is Launch plan, outside the group)
    await chip.click();
    ok('T4 a chip click collapses the group', JSON.stringify(await tabNames(page)) === '["Control Panel","Launch plan"]', JSON.stringify(await tabNames(page)));
    ok('T4 …and the chip shows how many tabs it holds', (await chip.innerText()).includes('2'));
    await chip.click();
    ok('T4 another click unfolds it', (await tabNames(page)).length === 4);
    await chip.click();

    // T5
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.wbt-tab').first().waitFor({ timeout: 10000 });
    ok('T5 the layout survives a reload (collapsed, coloured, named)',
      JSON.stringify(await tabNames(page)) === '["Control Panel","Launch plan"]'
      && (await page.locator('.wbt-chip').getAttribute('data-color')) === 'blue'
      && (await page.locator('.wbt-chip').innerText()).includes('Research'),
      JSON.stringify(await tabNames(page)));
    await page.locator('.wbt-chip').click();

    // T6
    await page.locator('.wbt-tab', { hasText: 'Launch plan' }).dragTo(page.locator('.wbt-tab', { hasText: 'Control Panel' }), { targetPosition: { x: 4, y: 10 } });
    const dragged = await tabNames(page);
    ok('T6 dragging a tab to the start reorders it', dragged[0] === 'Launch plan' && dragged[1] === 'Control Panel', JSON.stringify(dragged));

    // T7
    const launch = page.locator('.wbt-tab', { hasText: 'Launch plan' });
    await launch.hover();
    await launch.locator('.wbt-tab-close').click();
    const ask = page.locator('.wbt-confirm');
    ok('T7 the close button asks first', await ask.isVisible() && (await ask.innerText()).includes('Launch plan'), await ask.innerText().catch(() => ''));
    ok('T7 …and the tab is still there while it asks', (await tabNames(page)).includes('Launch plan'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, 'close-confirm.png'), clip: { x: 0, y: 0, width: 1440, height: 260 } });
    await ask.locator('button', { hasText: 'Cancel' }).click();
    ok('T7 Cancel keeps the tab', (await tabNames(page)).includes('Launch plan') && await ask.count() === 0);
    await launch.hover();
    await launch.locator('.wbt-tab-close').click();
    await ask.locator('button', { hasText: /^Close$/ }).click();
    const after = await tabNames(page);
    ok('T7 closing a tab takes it off the strip', !after.includes('Launch plan'), JSON.stringify(after));
    ok('T7 …the open board moves to its neighbour', (await activeName(page)) === 'Control Panel', await activeName(page));
    ok('T7 …and the board itself still exists', existsSync(join(PROJ, '_dream_context', 'whiteboards', 'launch-plan')));

    // T8
    dc(['whiteboard', 'add', 'pricing-ideas', 'note', '--text', 'hand-made plan']);
    await page.locator('.wbt-all').click();
    const row = page.locator('.wbs-panel--boards .wbs-row', { hasText: 'Pricing ideas' });
    await row.hover();
    await row.locator('.wbs-row-delete').click();
    await page.locator('.wbs-row--confirm button', { hasText: 'Delete' }).click();
    // The confirm row stands in for the board's row while it asks, so wait for the trash, not the list.
    await page.locator('.wbs-trash-toggle').waitFor({ timeout: 5000 });
    const trashDir = join(PROJ, '_dream_context', 'whiteboards', '.trash');
    ok('T8 a delete moves the board to the local trash', !existsSync(join(PROJ, '_dream_context', 'whiteboards', 'pricing-ideas')) && existsSync(trashDir));
    let ignored = true;
    try { execFileSync('git', ['check-ignore', '-q', join(trashDir, 'x')], { cwd: PROJ }); } catch { ignored = false; }
    ok('T8 …which git ignores', ignored);
    const toggle = page.locator('.wbs-trash-toggle');
    await toggle.waitFor({ timeout: 5000 });
    ok('T8 "Recently deleted" counts it', (await page.locator('.wbs-trash-count').innerText()) === '1', await toggle.innerText());
    await toggle.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, 'trash.png'), clip: { x: 900, y: 0, width: 540, height: 600 } });
    await page.locator('.wbs-trash-row', { hasText: 'Pricing ideas' }).locator('button', { hasText: 'Restore' }).click();
    await page.locator('.wbt-tab[aria-selected="true"]', { hasText: 'Pricing ideas' }).waitFor({ timeout: 5000 });
    const shown = JSON.parse(dc(['whiteboard', 'show', 'pricing-ideas', '--json']));
    ok('T8 Restore brings the board back, content and all, and opens it',
      JSON.stringify(shown).includes('hand-made plan'), JSON.stringify(shown).slice(0, 200));
    ok('T8 …and the trash is empty again', (await page.locator('.wbs-trash-toggle').count()) === 0);

    // dark theme shot
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const rn = page.locator('.wbt-tab', { hasText: 'Control Panel' });
    await rn.hover();
    await rn.locator('.wbt-tab-close').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, 'close-confirm-dark.png'), clip: { x: 0, y: 0, width: 1440, height: 260 } });
    await page.keyboard.press('Escape');
    ok('T7 Escape dismisses the question and keeps the tab', (await page.locator('.wbt-confirm').count()) === 0 && (await tabNames(page)).includes('Control Panel'));
    await page.locator('.wbt-tab', { hasText: 'Research notes' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, 'tabs-dark.png'), clip: { x: 0, y: 0, width: 1440, height: 120 } });
  } finally {
    await browser?.close();
    server.kill();
  }
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} green`);
  console.log(`shots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
