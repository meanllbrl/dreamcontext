#!/usr/bin/env node
/**
 * The board explorer (the Whiteboard page's left sidebar), in real Chromium.
 *
 *   npm run build && node scripts/verify/whiteboard-explorer.mjs [shots-dir]
 *
 * Boots the REAL dashboard server from the BUILT dashboard + CLI on an isolated scratch vault
 * (fake HOME), seeds boards with the CLI (two of them already grouped by an agent), then proves:
 *   E1  at 1440×900 the explorer is open and lists EVERY board (not just the open tab), the open
 *       board highlighted; an ungrouped board sits under Ungrouped;
 *   E2  "New group" makes an empty group; dragging a board onto it moves it (on disk:
 *       `group` + `group-by: owner`); the ⋯ menu's "Move to" moves another from the keyboard;
 *       "Remove from group" takes one out; Pin puts a board under Pinned;
 *   E3  search filters by name and by group; Enter opens the first hit; Esc clears;
 *   E4  groups, pins and the collapsed state survive a reload and a relaunch (localStorage wiped);
 *   E5  hiding the explorer leaves the canvas mounted (same element), the zoom unchanged and a
 *       rectangle drawn before the hide still on the board; the bar's toggle shows it again;
 *   E6  at 390 px on a touch phone (`body[data-phone]`) the explorer is a CLOSED drawer even
 *       with a saved `open: true`; opening it and picking a board opens that board and closes it;
 *   E7  no console error and no page error over the whole run.
 * Screenshots: desktop light, desktop dark, phone with the drawer open → [shots-dir] or <scratch>/shots.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-whiteboard-explorer');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = process.argv[2] || join(SCRATCH, 'shots');
const PORT = 45764;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
const dc = (args, cwd = PROJ) => execFileSync('node', [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
const boardFile = (slug) => readFileSync(join(PROJ, '_dream_context', 'whiteboards', slug, `${slug}.excalidraw.md`), 'utf-8');
const groupOnDisk = (slug) => {
  const m = boardFile(slug).match(/^"group": "(.*)"$/m);
  return m ? m[1] : null;
};
/** The explorer's saved prefs, from `state/.whiteboard-prefs.json` (flat string values). */
const savedExplorer = () => {
  const raw = JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.whiteboard-prefs.json'), 'utf-8'));
  return JSON.parse((raw.settings ?? raw).explorer ?? '{}');
};
/** The live Excalidraw viewport (zoom, scrollX, scrollY), read off the component as whiteboard.mjs does. */
const viewport = (page) => page.evaluate(() => {
  const root = document.querySelector('.wbp-canvas .excalidraw');
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
  for (let f = key ? root[key] : null; f; f = f.return) {
    const st = f.stateNode?.state;
    if (f.stateNode?.scene && st?.zoom) return { zoom: st.zoom.value, scrollX: st.scrollX, scrollY: st.scrollY };
  }
  return null;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error(`server did not come up at ${url}`);
}

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(150);
  }
  return false;
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], REPO);
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }
  dc(['whiteboard', 'create', 'ACQUISITION', '--group', 'Tilki metrics']);
  dc(['whiteboard', 'create', 'REVENUE', '--group', 'Tilki metrics']);
  for (const name of ['CRM', 'Onboarding', 'AI Team screens', 'Test']) dc(['whiteboard', 'create', name]);
}

const consoleErrors = [];
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
}

async function openWhiteboard(page) {
  await page.goto(`${ORIGIN}/?vault=proj`, { waitUntil: 'networkidle' });
  await sleep(600);
  if (await page.locator('.announcements-modal-scrim').count()) { await page.keyboard.press('Escape'); await sleep(300); }
  await page.locator('.sidebar-item', { hasText: /Whiteboard(?!s)/ }).first().click();
  await page.locator('.wbt-tab').first().waitFor({ timeout: 15000 });
}

const rowNames = (page, scope = '.wbx-scroll') => page.locator(`${scope} .wbx-row:not(.wbx-row--group) .wbx-name`).allInnerTexts();
const groupRow = (page, name) => page.locator('.wbx-group', { has: page.locator('.wbx-row--group .wbx-name', { hasText: new RegExp(`^${name}$`) }) });
const boardRow = (page, name, scope = '.wbx-scroll') => page.locator(`${scope} .wbx-row:not(.wbx-row--group)`, { has: page.locator('.wbx-name', { hasText: new RegExp(`^${name}$`) }) }).first();

async function main() {
  setup();
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(`${ORIGIN}/api/whiteboards`);
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    watch(page);
    await openWhiteboard(page);
    await page.locator('.wbx').waitFor({ timeout: 8000 });
    await waitFor(async () => (await rowNames(page)).length >= 7);

    // E1
    const names = await rowNames(page);
    const all = ['ACQUISITION', 'REVENUE', 'CRM', 'Onboarding', 'AI Team screens', 'Test', 'Control Panel'];
    ok('E1 the explorer is open at 1440 px', await page.locator('.wbx').isVisible());
    ok('E1 it lists every board, tab or not', all.every((n) => names.includes(n)), JSON.stringify(names));
    ok('E1 only one tab is open, so the list is not the tabs', (await page.locator('.wbt-tab').count()) === 1);
    ok('E1 the open board is highlighted', (await page.locator('.wbx-row[data-current="true"] .wbx-name').first().innerText()) === 'Control Panel');
    ok('E1 the CLI-grouped boards sit in their group', (await groupRow(page, 'Tilki metrics').locator('.wbx-kids .wbx-name').allInnerTexts()).join(',') === 'ACQUISITION,REVENUE');
    ok('E1 an ungrouped board sits under Ungrouped', (await page.locator('.wbx-ungrouped .wbx-name').allInnerTexts()).includes('CRM'));
    await page.screenshot({ path: join(SHOTS, 'masaustu-acik.png') });

    // E2 — new group, then drag CRM onto it
    await page.locator('.wbx-foot-btn', { hasText: 'New group' }).click();
    await page.locator('.wbx-field').fill('Sales');
    await page.keyboard.press('Enter');
    ok('E2 New group makes an empty group', await groupRow(page, 'Sales').locator('.wbx-count', { hasText: 'empty' }).count() === 1);
    await boardRow(page, 'CRM', '.wbx-ungrouped').dragTo(groupRow(page, 'Sales').locator('.wbx-row--group'));
    ok('E2 dragging a board onto a group moves it (disk: group)', await waitFor(() => groupOnDisk('crm') === 'Sales'), String(groupOnDisk('crm')));
    ok('E2 …written as the owner\'s placement', /"group-by": "owner"/.test(boardFile('crm')));
    ok('E2 …and the row now sits in that group', await waitFor(async () => (await groupRow(page, 'Sales').locator('.wbx-kids .wbx-name').allInnerTexts()).includes('CRM')));
    // keyboard: ⋯ → Move to → Tilki metrics
    await boardRow(page, 'Onboarding', '.wbx-ungrouped').locator('.wbx-more').focus();
    await page.keyboard.press('Enter');
    await page.locator('.wbx-menu .wbx-menu-item', { hasText: 'Tilki metrics' }).click();
    ok('E2 the ⋯ menu moves a board from the keyboard', await waitFor(() => groupOnDisk('onboarding') === 'Tilki metrics'));
    ok('E2 …and keyboard focus comes back into the explorer, not <body>', await waitFor(() => page.evaluate(() => !!document.activeElement?.closest('.wbx'))));
    // Esc in a menu opened from the keyboard closes it and puts focus back on its ⋯.
    await boardRow(page, 'Test', '.wbx-ungrouped').locator('.wbx-more').focus();
    await page.keyboard.press('Enter');
    await page.locator('.wbx-menu').waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    ok('E2 Esc closes the menu and focus returns to its ⋯', await waitFor(async () => (await page.locator('.wbx-menu').count()) === 0
      && page.evaluate(() => document.activeElement?.classList.contains('wbx-more') && document.activeElement.closest('[data-slug="test"]') !== null)));
    // A click on the canvas while a menu is open closes it and leaves focus on the canvas.
    await boardRow(page, 'Test', '.wbx-ungrouped').locator('.wbx-more').click();
    await page.locator('.wbx-menu').waitFor({ timeout: 3000 });
    const cv = await page.locator('.wbp-canvas').boundingBox();
    await page.mouse.click(cv.x + cv.width - 120, cv.y + cv.height - 160);
    await sleep(600);
    ok('E2 a click on the canvas closes the menu and keeps focus out of the explorer', (await page.locator('.wbx-menu').count()) === 0
      && await page.evaluate(() => !document.activeElement?.closest('.wbx')), await page.evaluate(() => document.activeElement?.className));
    // Remove from group
    await waitFor(async () => (await groupRow(page, 'Tilki metrics').locator('.wbx-kids .wbx-name').allInnerTexts()).includes('Onboarding'));
    await boardRow(page, 'Onboarding', '.wbx-group').locator('.wbx-more').click();
    await page.locator('.wbx-menu .wbx-menu-item', { hasText: 'Remove from group' }).click();
    ok('E2 Remove from group takes it out', await waitFor(() => groupOnDisk('onboarding') === null));
    // Pin
    await boardRow(page, 'REVENUE', '.wbx-group').locator('.wbx-more').click();
    await page.locator('.wbx-menu .wbx-menu-item', { hasText: /^Pin$/ }).click();
    ok('E2 Pin puts a board under Pinned', await waitFor(async () => (await page.locator('.wbx-sec', { hasText: 'Pinned' }).first().locator('.wbx-name').allInnerTexts()).includes('REVENUE')));
    // open a board from the explorer: it opens and gets a tab
    await boardRow(page, 'Onboarding', '.wbx-ungrouped').locator('.wbx-row-open').click();
    ok('E2 clicking a row opens that board and gives it a tab', await waitFor(async () => (await page.locator('.wbt-tab[aria-selected="true"] .wbt-tab-name').innerText()) === 'Onboarding'));
    // collapse Tilki metrics
    await groupRow(page, 'Tilki metrics').locator('.wbx-row--group .wbx-row-open').click();
    ok('E2 a group click collapses it', await groupRow(page, 'Tilki metrics').locator('.wbx-kids').count() === 0);

    // E3 — search
    const search = page.locator('.wbx-search-input');
    await search.fill('sales');
    ok('E3 search by group name finds its boards', await waitFor(async () => (await rowNames(page)).join(',') === 'CRM'), JSON.stringify(await rowNames(page)));
    await search.fill('acqu');
    ok('E3 search opens a collapsed group with a hit', (await rowNames(page)).join(',') === 'ACQUISITION');
    await search.press('Enter');
    ok('E3 Enter opens the first hit', await waitFor(async () => (await page.locator('.wbt-tab[aria-selected="true"] .wbt-tab-name').innerText()) === 'ACQUISITION'));
    ok('E3 the search text survives the board switch (the explorer is not remounted)', (await search.inputValue()) === 'acqu');
    await search.press('Escape');
    ok('E3 Esc clears the search', (await search.inputValue()) === '');
    // Fold a group the open board (ACQUISITION, in Tilki metrics) is not in, for E4.
    await groupRow(page, 'Sales').locator('.wbx-row--group .wbx-row-open').click();
    ok('E3 opening a board unfolds its own group', await groupRow(page, 'Tilki metrics').locator('.wbx-kids').count() === 1);

    // E4 — reload and relaunch
    await sleep(800); // prefs write-through debounce
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.wbx').waitFor({ timeout: 10000 });
    await page.evaluate(() => localStorage.clear());
    await openWhiteboard(page);
    await page.locator('.wbx').waitFor({ timeout: 10000 });
    await waitFor(async () => (await rowNames(page)).length >= 3);
    ok('E4 the group survives a relaunch (from the board file)', groupOnDisk('crm') === 'Sales' && (await groupRow(page, 'Sales').locator('.wbx-count').innerText()) === '1');
    ok('E4 the pin survives a relaunch (from state/.whiteboard-prefs.json)', (await page.locator('.wbx-sec', { hasText: 'Pinned' }).first().locator('.wbx-name').allInnerTexts()).includes('REVENUE'));
    ok('E4 the collapsed state survives', JSON.stringify(savedExplorer().collapsed) === '["sales"]' && (await groupRow(page, 'Sales').locator('.wbx-kids').count()) === 0, JSON.stringify(savedExplorer()));

    // E5 — hide/show keeps the canvas
    await boardRow(page, 'Test', '.wbx-ungrouped').locator('.wbx-row-open').click();
    await waitFor(async () => (await page.locator('.wbt-tab[aria-selected="true"] .wbt-tab-name').innerText()) === 'Test');
    await page.locator('.excalidraw canvas.interactive').waitFor({ timeout: 10000 });
    await sleep(800);
    const box = await page.locator('.wbp-canvas').boundingBox();
    await page.locator('.wbp-canvas label:has([data-testid="toolbar-rectangle"])').first().click();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    const vBefore = await viewport(page);
    ok('E5 fixture: the live viewport is readable', !!vBefore && typeof vBefore.zoom === 'number');
    await page.evaluate(() => { document.querySelector('.excalidraw canvas.interactive').__pgzMark = 1; });
    await page.locator('.wbx-head .wbx-icon[aria-label="Hide the board list"]').click();
    ok('E5 Hide takes the explorer away', await page.locator('.wbx').count() === 0);
    ok('E5 …and focus lands on the bar\'s toggle', await waitFor(() => page.evaluate(() => document.activeElement?.classList.contains('wbp-explorer-toggle'))));
    ok('E5 …and a toggle sits at the bar\'s left end', await page.locator('.wbp-bar > .wbp-explorer-toggle').count() === 1);
    await sleep(400);
    await page.screenshot({ path: join(SHOTS, 'masaustu-gizli.png') });
    await page.locator('.wbp-explorer-toggle').click();
    await page.locator('.wbx').waitFor({ timeout: 4000 });
    await sleep(400);
    ok('E5 the canvas was not remounted', await page.evaluate(() => document.querySelector('.excalidraw canvas.interactive')?.__pgzMark === 1));
    const vAfter = await viewport(page);
    ok('E5 zoom, scrollX and scrollY did not change', !!vAfter && JSON.stringify(vAfter) === JSON.stringify(vBefore), `${JSON.stringify(vBefore)} → ${JSON.stringify(vAfter)}`);
    ok('E5 the rectangle is in the live scene too', await page.evaluate(() => {
      const root = document.querySelector('.wbp-canvas .excalidraw');
      const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key ? root[key] : null; f; f = f.return) {
        if (f.stateNode?.scene) return f.stateNode.scene.getNonDeletedElements().some((e) => e.type === 'rectangle');
      }
      return false;
    }));
    const drawn = await waitFor(async () => {
      const r = await fetch(`${ORIGIN}/api/whiteboards/test`);
      const j = await r.json();
      return (j.elements ?? []).some((e) => e.type === 'rectangle' && !e.isDeleted);
    }, 10000);
    ok('E5 the rectangle drawn before the hide is on the board', drawn);

    // Desktop shots, light then dark
    await page.locator('.wbx-search-input').fill('');
    await boardRow(page, 'Onboarding', '.wbx-ungrouped').locator('.wbx-row-open').click();
    await sleep(1200);
    await page.screenshot({ path: join(SHOTS, 'masaustu-acik.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(600);
    await page.screenshot({ path: join(SHOTS, 'masaustu-koyu.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await ctx.close();

    // E6 — phone
    const prefsFile = join(PROJ, '_dream_context', 'state', '.whiteboard-prefs.json');
    const saved = JSON.parse(readFileSync(prefsFile, 'utf-8'));
    const settings = saved.settings ?? saved;
    const ex = JSON.parse(settings.explorer ?? '{}');
    settings.explorer = JSON.stringify({ ...ex, open: true });
    writeFileSync(prefsFile, JSON.stringify(saved.settings ? { ...saved, settings } : settings));
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    const phone = await phoneCtx.newPage();
    watch(phone);
    await phone.goto(`${ORIGIN}/?vault=proj#/whiteboards`, { waitUntil: 'networkidle' });
    await sleep(800);
    for (let i = 0; i < 3; i++) {
      const x = phone.locator('.announcements-modal-close');
      if (!(await x.count())) break;
      await x.first().click().catch(() => {});
      await sleep(300);
    }
    const isPhone = await phone.evaluate(() => document.body.dataset.phone === 'true');
    ok('E6 the phone context is a phone (body data-phone)', isPhone);
    // The phone reaches a page through its Pages menu.
    // (The full-screen chat surface overlaps the bar's hit box, so the menu is clicked in the page.)
    await phone.evaluate(() => document.querySelector('[data-testid="phone-menu"]').click());
    await sleep(400);
    await phone.evaluate(() => document.querySelector('.sidebar-item[title^="Whiteboard"]').click());
    await phone.locator('.wbp-bar').waitFor({ timeout: 15000 });
    ok('E6 the drawer starts closed even with a saved open: true', await phone.locator('.wbx').count() === 0);
    await phone.locator('.wbp-explorer-toggle').tap();
    await phone.locator('.wbx[data-phone]').waitFor({ timeout: 4000 });
    await sleep(400);
    await phone.screenshot({ path: join(SHOTS, 'telefon-cekmece.png') });
    await boardRow(phone, 'REVENUE', '.wbx-sec').locator('.wbx-row-open').tap();
    ok('E6 picking a board opens it', await waitFor(async () => (await phone.evaluate(() => location.hash)).includes('revenue')));
    ok('E6 …and closes the drawer', await waitFor(async () => (await phone.locator('.wbx').count()) === 0));
    ok('E6 the phone did not write `open`', savedExplorer().open === true, JSON.stringify(savedExplorer().open));
    await phoneCtx.close();

    // E7
    ok('E7 no console error and no page error', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    await browser?.close();
    server.kill();
  }
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed · shots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  for (const r of results) console.log(r);
  console.error(e);
  process.exit(1);
});
