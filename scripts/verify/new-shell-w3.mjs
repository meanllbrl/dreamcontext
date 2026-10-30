#!/usr/bin/env node
/**
 * /verify for the new shell, wave 3 (task codex-tarzi-yeni-kabuk, W3 AC 13-17): named chat windows.
 *
 * Drives a RUNNING dashboard on a scratch HOME with fictional projects, seeded so:
 *  - `launcher-ui.json` has NO `shell` (a HOME that never chose): the app must open in the new shell;
 *  - acme's roster has two named windows (Chat: two panes, Refactor: two tabs);
 *  - globex's roster is a legacy file (no `windows`): one window with every tab;
 *  - initech's roster holds 40 tabs: a new window is refused with the lasting notice.
 * Tabs carry no conversation id, so they restore dormant and nothing is spawned.
 *
 * At 1440/1024/768/390 dark plus 1440 light (390 = narrow WITHOUT touch): the drawer's window rows,
 * the window menu, the inline rename, the second window on screen, a new window, the 40-tab notice.
 * Once at 1440: rename + restart keeps the name, the roster on disk keeps windows + every tab, and OFF
 * (explicit classic) draws every window's tabs in one surface and saves the windows back unchanged.
 * Prints one JSON report; exit 1 on any console error, overflow or failed check.
 *
 *   node scripts/verify/new-shell-w3.mjs --url http://127.0.0.1:45783 --scratch tmp/develop/scratch --out <dir> [--only 1440]
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const BASE = arg('url', 'http://127.0.0.1:45783');
const SCRATCH = arg('scratch', 'tmp/develop/scratch');
const OUT = arg('out', 'tmp/develop/w3-shots');
const ONLY = arg('only', null);
mkdirSync(OUT, { recursive: true });

const WIDTHS = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const RUNS = [...WIDTHS.map(([w, h]) => ({ w, h, theme: 'dark' })), { w: 1440, h: 900, theme: 'light' }]
  .filter((r) => !ONLY || String(r.w) === ONLY);

const report = { shots: [], failures: [], checks: {}, consoleErrors: [] };
const fail = (m) => report.failures.push(m);
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const roster = (vault) => JSON.parse(readFileSync(join(SCRATCH, vault, '_dream_context', 'state', '.agent-sessions.json'), 'utf-8'));

async function dismissWhatsNew(page) {
  const got = page.getByRole('button', { name: 'Got it' });
  if (await got.isVisible().catch(() => false)) { await got.click(); await settle(page, 300); }
}

async function shot(page, run, name, extra = {}) {
  const file = join(OUT, `${name}-${run.w}-${run.theme}.png`);
  await page.screenshot({ path: file });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  report.shots.push({ name, width: run.w, theme: run.theme, file, overflowX, ...extra });
  if (overflowX) fail(`${name}@${run.w}-${run.theme}: horizontal overflow`);
}

async function showDrawer(page) {
  if (await page.getByTestId('chat-drawer').isVisible().catch(() => false)) return true;
  if (!(await page.locator('.project-instance:not([hidden]) .agent-surface.expanded').count())) {
    await page.getByTestId('ns-rail-chat').click();
    await settle(page, 900);
  }
  if (!(await page.getByTestId('chat-drawer').isVisible().catch(() => false))) {
    await page.getByTestId('ns-drawer-toggle').click().catch(() => {});
    await settle(page, 500);
  }
  return page.getByTestId('chat-drawer').isVisible().catch(() => false);
}

async function expand(page, names) {
  for (const name of names) {
    const row = page.locator(`[data-drawer-project="${name}"] [data-testid="drawer-project-row"]`);
    if ((await row.getAttribute('aria-expanded').catch(() => null)) === 'false') { await row.click(); await settle(page, 300); }
  }
  await settle(page, 1500);
}

const windowRows = (page, vault) => page.locator(`[data-drawer-project="${vault}"] [data-testid="drawer-window-row"]`);
const tabTitles = (page) => page.evaluate(() => [...document.querySelectorAll('.project-instance:not([hidden]) .agent-surface .agent-tab')]
  .filter((el) => el.getClientRects().length > 0).map((el) => el.textContent?.trim() ?? ''));

const browser = await chromium.launch();
async function open(run) {
  const context = await browser.newContext({ viewport: { width: run.w, height: run.h }, hasTouch: false, isMobile: false });
  await context.addInitScript((theme) => { try { localStorage.setItem('dreamcontext-theme', theme); } catch { /* ignore */ } }, run.theme);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { context, page, errors };
}

for (const run of RUNS) {
  const { context, page, errors } = await open(run);
  const tag = `${run.w}-${run.theme}`;
  await page.goto(`${BASE}/?vault=acme`);
  // AC16: a HOME that never chose opens in the new shell.
  const titlebar = await page.getByTestId('ns-titlebar').waitFor({ timeout: 20_000 }).then(() => true, () => false);
  report.checks[`freshHomeNewShell@${tag}`] = titlebar;
  if (!titlebar) { fail(`fresh HOME@${tag}: did not open in the new shell`); await context.close(); continue; }
  await settle(page, 2500);
  await dismissWhatsNew(page);

  if (!(await showDrawer(page))) { fail(`drawer@${tag}: not on screen`); await context.close(); continue; }
  await expand(page, ['acme', 'globex', 'initech']);

  // AC13/14: acme lists its two windows by name; globex (legacy file) one window.
  const acmeRows = await windowRows(page, 'acme').allTextContents();
  const globexRows = await windowRows(page, 'globex').count();
  report.checks[`acmeWindows@${tag}`] = acmeRows;
  report.checks[`globexWindows@${tag}`] = globexRows;
  if (acmeRows.length !== 2 || !acmeRows[1].includes('Refactor')) fail(`acme windows@${tag}: ${JSON.stringify(acmeRows)}`);
  if (globexRows !== 1) fail(`globex (legacy) windows@${tag}: ${globexRows}`);
  // The window a restart reopened (the one last on screen), then the first window, explicitly.
  report.checks[`reopenedWindow@${tag}`] = await page.evaluate(() => document.querySelector('[data-drawer-project="acme"] .ns-dr-win.is-sel')?.getAttribute('data-window-id') ?? null);
  await windowRows(page, 'acme').first().click();
  await settle(page, 1200);
  await showDrawer(page);
  const firstTabs = await tabTitles(page);
  report.checks[`acmeChatTabs@${tag}`] = firstTabs;
  if (!(firstTabs.join('|').includes('Checkout total') && firstTabs.join('|').includes('Invoice CSV'))) fail(`acme Chat window tabs@${tag}: ${JSON.stringify(firstTabs)}`);
  if (firstTabs.join('|').includes('Search archive')) fail(`acme Chat window shows a Refactor tab@${tag}`);
  await shot(page, run, 'drawer-windows');

  // The second window on screen: only its tabs.
  await windowRows(page, 'acme').nth(1).click();
  await settle(page, 1200);
  if (!(await showDrawer(page))) fail(`drawer after window pick@${tag}`);
  const refTabs = await tabTitles(page);
  report.checks[`refactorTabs@${tag}`] = refTabs;
  if (!(refTabs.join('|').includes('Search archive') && !refTabs.join('|').includes('Checkout total'))) fail(`Refactor window tabs@${tag}: ${JSON.stringify(refTabs)}`);
  const sel = await windowRows(page, 'acme').nth(1).getAttribute('class');
  if (!sel?.includes('is-sel')) fail(`Refactor row not selected@${tag}`);
  await shot(page, run, 'window-refactor');

  // The window row's menu (right-click): Rename, Close window.
  await windowRows(page, 'acme').nth(1).click({ button: 'right' });
  await settle(page, 400);
  const menu = page.getByTestId('drawer-window-menu');
  const items = await menu.locator('[role="menuitem"]').allTextContents().catch(() => []);
  report.checks[`windowMenu@${tag}`] = items;
  if (items.length !== 2) fail(`window menu@${tag}: ${JSON.stringify(items)}`);
  const box = await menu.boundingBox();
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > run.w || box.y + box.height > run.h) fail(`window menu outside the window@${tag}`);
  await shot(page, run, 'overlay-window-menu');

  // Inline rename (blank reverts; a name sticks).
  await page.getByTestId('drawer-window-rename-item').click();
  await settle(page, 300);
  const input = page.getByTestId('drawer-window-rename');
  await input.fill('   ');
  await input.press('Enter');
  await settle(page, 600);
  const afterBlank = await windowRows(page, 'acme').nth(1).textContent();
  if (!afterBlank?.includes('Refactor')) fail(`blank rename did not revert@${tag}: ${afterBlank}`);
  await windowRows(page, 'acme').nth(1).click({ button: 'right' });
  await settle(page, 300);
  await page.getByTestId('drawer-window-rename-item').click();
  await settle(page, 300);
  await input.fill(`Refactor ${run.w}`);
  await shot(page, run, 'overlay-window-rename');
  await input.press('Enter');
  await settle(page, 900);
  const renamed = await windowRows(page, 'acme').nth(1).textContent();
  if (!renamed?.includes(`Refactor ${run.w}`)) fail(`rename@${tag}: ${renamed}`);

  // A new window with "+": a third row, selected, and the 40-tab notice on initech.
  await page.locator('[data-drawer-project="acme"] [data-testid="drawer-project-add"]').click();
  await settle(page, 1500);
  if (!(await showDrawer(page))) fail(`drawer after new window@${tag}`);
  const nWin = await windowRows(page, 'acme').count();
  report.checks[`afterNew@${tag}`] = nWin;
  if (nWin !== 3) fail(`new window@${tag}: ${nWin} rows`);
  await shot(page, run, 'window-new');
  // …and close it again from its menu (no running chat: no question).
  await windowRows(page, 'acme').nth(2).click({ button: 'right' });
  await settle(page, 300);
  await page.getByTestId('drawer-window-close-item').click();
  await settle(page, 1200);
  if (!(await showDrawer(page))) fail(`drawer after close@${tag}`);
  const afterClose = await windowRows(page, 'acme').count();
  if (afterClose !== 2) fail(`close window@${tag}: ${afterClose} rows`);

  await page.locator('[data-drawer-project="initech"] [data-testid="drawer-project-add"]').click();
  await settle(page, 2500);
  const notice = await page.getByTestId('agent-tab-cap').isVisible().catch(() => false);
  report.checks[`tabCapNotice@${tag}`] = notice;
  if (!notice) fail(`40-tab notice@${tag}: not shown`);
  if (await showDrawer(page)) {
    const initRows = await windowRows(page, 'initech').count();
    if (initRows !== 1) fail(`initech refused a 41st tab yet has ${initRows} windows@${tag}`);
  }
  await shot(page, run, 'notice-tabs-full');

  // Put acme back where it was for the next width: the rename is undone.
  await page.locator('[data-drawer-project="acme"] [data-testid="drawer-window-row"]').first().click();
  await settle(page, 1500);
  const errs = errors.filter((e) => !/Failed to load resource.*(404|401)/.test(e));
  report.consoleErrors.push(...errs.map((e) => `${tag}: ${e}`));
  if (errs.length) fail(`console errors@${tag}: ${errs.slice(0, 3).join(' | ')}`);
  await context.close();
}

// ── Once at 1440: restart persistence, the roster on disk, and OFF ───────────────────────────
if (!ONLY || ONLY === '1440') {
  const run = { w: 1440, h: 900, theme: 'dark' };
  const { context, page, errors } = await open(run);
  await page.goto(`${BASE}/?vault=acme`);
  await page.getByTestId('ns-titlebar').waitFor({ timeout: 20_000 });
  await settle(page, 3000);
  await dismissWhatsNew(page);
  await showDrawer(page);
  await expand(page, ['acme']);
  const names = await windowRows(page, 'acme').allTextContents();
  report.checks.restartNames = names;
  if (!names.some((n) => n.includes('Refactor 1440'))) fail(`restart: the renamed window did not survive (${JSON.stringify(names)})`);
  const disk = roster('acme');
  report.checks.diskAfterNew = { windows: disk.windows, tabs: disk.sessions.map((m) => [m.title, m.window, m.pane]) };
  if (disk.sessions.length < 4 || !disk.windows?.length) fail('disk: tabs or windows lost');
  const panes = disk.sessions.filter((m) => ['Checkout total', 'Invoice CSV', 'Search archive'].includes(m.title)).map((m) => m.pane);
  if (new Set(panes).size !== 3) fail(`disk: a downgraded reader would merge panes (${JSON.stringify(panes)})`);
  await shot(page, run, 'restart-names');
  const errs = errors.filter((e) => !/Failed to load resource.*(404|401)/.test(e));
  if (errs.length) fail(`console errors@restart: ${errs.slice(0, 3).join(' | ')}`);
  await context.close();

  // OFF: an explicit classic stays classic, shows every window's tabs, saves the windows back.
  const before = roster('acme');
  const off = await open(run);
  await off.page.goto(`${BASE}/api/health`);
  await off.page.evaluate(async (u) => {
    await fetch(`${u}/api/launcher/ui-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell: 'classic' }) });
  }, BASE);
  await off.context.close();
  const off2 = await open(run);
  await off2.page.goto(`${BASE}/?vault=acme`);
  await settle(off2.page, 5000);
  await dismissWhatsNew(off2.page);
  const classic = await off2.page.evaluate(() => ({
    newShell: document.querySelectorAll('[data-testid="ns-titlebar"]').length,
    sidebar: document.querySelectorAll('.sidebar').length,
  }));
  report.checks.offClassic = classic;
  if (classic.newShell !== 0) fail('OFF: explicit classic opened the new shell');
  // Classic's way into the chat: the dock (unfold it, then a chip), or the FAB with no tabs.
  if (await off2.page.locator('.agent-dock-anchor').isVisible().catch(() => false)) {
    if (!(await off2.page.locator('.agent-dock-tiles').isVisible().catch(() => false))) await off2.page.locator('.agent-dock-anchor').click();
    await settle(off2.page, 500);
    // By its title: a tile's first button is its ✕.
    await off2.page.locator('.agent-dock-tiles').getByText('Invoice CSV').first().click().catch(() => {});
  } else {
    await off2.page.locator('.agent-fab').first().click().catch(() => {});
  }
  await settle(off2.page, 1500);
  const allTabs = await tabTitles(off2.page);
  report.checks.offTabs = allTabs;
  for (const t of ['Checkout total', 'Invoice CSV', 'Search archive', 'Team size step']) {
    if (!allTabs.join('|').includes(t)) fail(`OFF: classic does not show "${t}" (${JSON.stringify(allTabs)})`);
  }
  await shot(off2.page, run, 'off-chat-all-tabs');
  await off2.page.goto(`${BASE}/?vault=acme&page=tasks`);
  await settle(off2.page, 2500);
  await shot(off2.page, run, 'off-tasks');
  await settle(off2.page, 1500);
  const afterClassic = roster('acme');
  const sameWindows = JSON.stringify((afterClassic.windows ?? []).map((w) => [w.id, w.name])) === JSON.stringify((before.windows ?? []).map((w) => [w.id, w.name]));
  const sameHomes = JSON.stringify(afterClassic.sessions.map((m) => [m.title, m.window]).sort()) === JSON.stringify(before.sessions.map((m) => [m.title, m.window]).sort());
  report.checks.offSavesBack = { sameWindows, sameHomes };
  if (!sameWindows || !sameHomes) fail(`OFF: a classic save changed the windows (${JSON.stringify(afterClassic.windows)})`);
  const errs2 = off2.errors.filter((e) => !/Failed to load resource.*(404|401)/.test(e));
  if (errs2.length) fail(`console errors@off: ${errs2.slice(0, 3).join(' | ')}`);
  await off2.context.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
process.exit(report.failures.length ? 1 : 0);
