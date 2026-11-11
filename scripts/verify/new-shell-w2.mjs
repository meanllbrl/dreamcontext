#!/usr/bin/env node
/**
 * /verify for the new shell, wave 2 (task codex-tarzi-yeni-kabuk, W2 AC 6b-12, 17), plus a
 * re-shoot of W1's screens and overlays at every width.
 *
 * Drives a RUNNING dashboard on a scratch HOME with fictional projects (acme, globex, initech;
 * `shell: "new"`), at 1440/1024/768/390 dark plus 1440 light. 390 = a narrow viewport WITHOUT
 * touch (a touch phone is a device shell, checked in new-shell-w1). Every shot records console errors
 * and horizontal overflow; page shots also record how many page titles show and the title row's
 * height. Prints one JSON report; exit 1 on any error, overflow or failed check.
 *
 *   node scripts/verify/new-shell-w2.mjs --url http://127.0.0.1:45782 --vault acme --out <dir> [--only 1440] [--once]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const BASE = arg('url', 'http://127.0.0.1:45782');
const VAULT = arg('vault', 'acme');
const OUT = arg('out', 'tmp/develop/w2-shots');
const ONLY = arg('only', null);
const ONCE = process.argv.includes('--once');
mkdirSync(OUT, { recursive: true });

const WIDTHS = [[1440, 900], [1024, 768], [768, 1024], [390, 844]];
const RUNS = [
  ...WIDTHS.map(([w, h]) => ({ w, h, theme: 'dark' })),
  { w: 1440, h: 900, theme: 'light' },
].filter((r) => !ONCE && (!ONLY || String(r.w) === ONLY));

const report = { shots: [], failures: [], checks: {} };
const fail = (m) => report.failures.push(m);
const settle = (page, ms = 700) => page.waitForTimeout(ms);

async function dismissWhatsNew(page) {
  const got = page.getByRole('button', { name: 'Got it' });
  if (await got.isVisible().catch(() => false)) { await got.click(); await settle(page, 300); }
}

async function metrics(page) {
  return page.evaluate(() => {
    const inst = document.querySelector('.project-instance:not([hidden])');
    const titles = [...(inst?.querySelectorAll('.page-bar-title') ?? [])].filter((el) => el.getClientRects().length > 0);
    const row = titles[0]?.closest('[data-page-row], .page-bar');
    const drawer = document.querySelector('[data-testid="chat-drawer"]');
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      titles: titles.length,
      titleText: titles[0]?.textContent?.trim() ?? null,
      titleRowH: row ? Math.round(row.getBoundingClientRect().height) : null,
      titleFont: titles[0] ? getComputedStyle(titles[0]).fontSize : null,
      drawer: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
      chatOpen: !!inst?.querySelector('.agent-surface.expanded'),
    };
  });
}

async function shot(page, run, name, extra = {}) {
  const file = join(OUT, `${name}-${run.w}-${run.theme}.png`);
  await page.screenshot({ path: file });
  const m = await metrics(page);
  const entry = { name, width: run.w, theme: run.theme, file, ...m, ...extra };
  report.shots.push(entry);
  if (m.overflowX) fail(`${name}@${run.w}: horizontal overflow`);
  return entry;
}

async function gotoRail(page, run, id) {
  const direct = page.getByTestId(`ns-rail-${id}`);
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
  } else {
    await page.getByTestId('ns-rail-more').click();
    await settle(page, 200);
    await page.getByTestId(`ns-more-${id}`).click();
  }
  await settle(page, run.w <= 600 ? 900 : 700);
  await dismissWhatsNew(page);
}

/** On Chat, with the drawer on screen (≤900 it floats: open it with the title-bar button). */
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

async function expandAll(page) {
  for (const name of ['acme', 'globex', 'initech']) {
    const row = page.locator(`[data-drawer-project="${name}"] [data-testid="drawer-project-row"]`);
    if ((await row.getAttribute('aria-expanded').catch(() => null)) === 'false') { await row.click(); await settle(page, 300); }
  }
  await settle(page, 1200);
}

const PAGES = ['tasks', 'automations', 'lab', 'roadmap', 'hypotheses', 'whiteboards', 'knowledge', 'brain', 'settings',
  'council', 'core', 'sleep', 'packs'];
const TITLES = {
  tasks: 'Tasks', automations: 'AI Team', lab: 'Insights', roadmap: 'Roadmap', hypotheses: 'Hypotheses', whiteboards: 'Whiteboard',
  knowledge: 'Knowledge', brain: 'Map', settings: 'Settings', council: 'Council', core: 'Core',
  sleep: 'Sleep Cycle', packs: 'Packs',
};

const browser = await chromium.launch();
for (const run of RUNS) {
  const context = await browser.newContext({ viewport: { width: run.w, height: run.h }, hasTouch: false, isMobile: false });
  await context.addInitScript((theme) => { try { localStorage.setItem('dreamcontext-theme', theme); } catch { /* ignore */ } }, run.theme);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${BASE}/?vault=${encodeURIComponent(VAULT)}`);
  await page.getByTestId('ns-titlebar').waitFor({ timeout: 15_000 });
  await settle(page, 2500);
  await dismissWhatsNew(page);

  // 6b: the window's first project opens on Chat (the drawer beside it above 900).
  {
    const m = await metrics(page);
    report.checks[`openOnChat@${run.w}-${run.theme}`] = m.chatOpen;
    if (!m.chatOpen) fail(`open-on-chat@${run.w}: the first project did not open on Chat`);
    if (run.w > 900 && !m.drawer) fail(`open-on-chat@${run.w}: no drawer beside Chat`);
  }

  // 7: the drawer, every project expanded.
  if (await showDrawer(page)) {
    await expandAll(page);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-drawer-project]')].map((p) => ({
      name: p.getAttribute('data-drawer-project'),
      children: [...p.querySelectorAll('.ns-dr-child')].map((c) => c.className.match(/ns-dr-(super|member|win)/)?.[1]),
    })));
    report.checks[`drawerRows@${run.w}-${run.theme}`] = rows;
    for (const r of rows) {
      if (r.children[0] !== 'super') fail(`drawer@${run.w}: ${r.name} has no Super row first`);
      if (r.children[r.children.length - 1] !== 'win') fail(`drawer@${run.w}: ${r.name} has no window row last`);
    }
    await shot(page, run, 'chat-drawer');

    // A window row opens that project's chat, the drawer stays (above 900).
    await page.locator('[data-drawer-project="globex"] [data-testid="drawer-window-row"]').click();
    await settle(page, 1500);
    const picked = (await page.getByTestId('ns-picker-btn').textContent())?.trim();
    const after = await metrics(page);
    report.checks[`windowRow@${run.w}`] = { picked, chatOpen: after.chatOpen, drawer: after.drawer };
    if (picked !== 'globex' || !after.chatOpen) fail(`window-row@${run.w}: did not open globex's chat (${picked}, ${after.chatOpen})`);
    if (run.w > 900 && !after.drawer) fail(`window-row@${run.w}: the drawer left`);
    await shot(page, run, 'chat-globex');

    // Overlays: New chat window's picker, a project's right-click menu, History.
    if (await showDrawer(page)) {
      await page.getByTestId('drawer-new-window').click();
      await settle(page, 300);
      await shot(page, run, 'overlay-new-window');
      await page.keyboard.press('Escape');
      await settle(page, 200);
    }
    if (await showDrawer(page)) {
      await page.locator('[data-drawer-project="acme"] [data-testid="drawer-project-row"]').click({ button: 'right' });
      await settle(page, 300);
      const inside = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="drawer-project-menu"]')?.getBoundingClientRect();
        return r ? r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 : false;
      });
      await shot(page, run, 'overlay-project-menu', { inside });
      if (!inside) fail(`project-menu@${run.w}: leaves the window`);
      await page.keyboard.press('Escape');
      await settle(page, 200);
    }
    if (await showDrawer(page)) {
      await page.getByTestId('drawer-history').click();
      await settle(page, 1500);
      await page.getByRole('tab', { name: 'All projects' }).click().catch(() => {});
      await settle(page, 1500);
      await shot(page, run, 'overlay-history');
      await page.keyboard.press('Escape');
      await settle(page, 300);
    }
  } else {
    fail(`drawer@${run.w}: no drawer on Chat`);
  }

  // W1 overlays at every width (criterion 17 for W1): the picker, More, the search palette.
  await gotoRail(page, run, 'tasks');
  await page.getByTestId('ns-picker-btn').click();
  await settle(page, 300);
  await shot(page, run, 'overlay-picker');
  await page.keyboard.press('Escape');
  await settle(page, 200);
  await page.getByTestId('ns-rail-more').click();
  await settle(page, 300);
  await shot(page, run, 'overlay-more');
  await page.keyboard.press('Escape');
  await settle(page, 200);
  await page.getByTestId('ns-search').click().catch(() => {});
  await settle(page, 400);
  await shot(page, run, 'overlay-search');
  await page.keyboard.press('Escape');
  await settle(page, 200);

  // 11: every non-chat page, one title in its own row.
  for (const p of PAGES) {
    await gotoRail(page, run, p);
    const e = await shot(page, run, `page-${p}`);
    if (e.titles !== 1) fail(`page-${p}@${run.w}: ${e.titles} page titles`);
    if (e.titleText !== TITLES[p]) fail(`page-${p}@${run.w}: title "${e.titleText}"`);
    if (e.titleRowH !== null && (e.titleRowH < 52 || e.titleRowH > 64)) fail(`page-${p}@${run.w}: title row ${e.titleRowH}px`);
    if (e.drawer) fail(`page-${p}@${run.w}: the chat drawer shows on a page`);
  }

  // 12: Settings search and Models.
  await gotoRail(page, run, 'settings');
  await page.getByTestId('settings-search').fill('model');
  await settle(page, 600);
  const found = await page.evaluate(() => [...document.querySelectorAll('.settings-content .setting-row:not([data-search-hidden])')]
    .filter((r) => r.getClientRects().length > 0 && !r.closest('[data-search-hidden]')).map((r) => r.querySelector('.setting-row-title')?.textContent));
  report.checks[`settingsSearch@${run.w}`] = found.length;
  if (!found.length) fail(`settings-search@${run.w}: "model" found nothing`);
  await shot(page, run, 'settings-search');
  await page.getByTestId('settings-search').fill('zzqqxx');
  await settle(page, 400);
  if (!(await page.getByTestId('settings-search-empty').isVisible().catch(() => false))) fail(`settings-search@${run.w}: no empty state`);
  await page.getByTestId('settings-search').fill('');
  await settle(page, 300);
  await page.locator('.settings-nav-item', { hasText: 'Models' }).click();
  await settle(page, 1200);
  const modelRows = await page.locator('.settings-content .setting-row-title').allTextContents();
  report.checks[`models@${run.w}`] = modelRows;
  for (const r of ['New chats', 'Super Agent', 'Assistant', 'Sleep cycle']) if (!modelRows.includes(r)) fail(`models@${run.w}: no ${r} row`);
  await shot(page, run, 'settings-models');
  if (run.w === 1440) {
    await page.locator('.settings-nav-item', { hasText: /^Chat|Agents/ }).first().click().catch(() => {});
    await settle(page, 900);
    const eco = page.locator('.setting-row', { hasText: 'Eco mode' });
    if (await eco.count()) { await eco.scrollIntoViewIfNeeded(); await settle(page, 300); }
    report.checks[`eco@${run.theme}`] = await eco.count();
    if (!(await eco.count())) fail(`eco@${run.w}: no Eco mode row`);
    await shot(page, run, 'settings-eco');
  }

  // Whiteboards: ⌘B toggles its own explorer, not the chat drawer.
  if (run.w === 1440) {
    await gotoRail(page, run, 'whiteboards');
    const before = await page.locator('.wbp-explorer-toggle').count();
    await page.keyboard.press('Meta+b');
    await settle(page, 500);
    const afterT = await page.locator('.wbp-explorer-toggle').count();
    report.checks[`wbToggle@${run.theme}`] = { before, after: afterT };
    if (before === afterT) fail(`whiteboards@${run.w}: ⌘B did not toggle the explorer`);
    await shot(page, run, 'whiteboards-cmdb');
    await page.keyboard.press('Meta+b');
    await settle(page, 300);
  }

  if (errors.length) fail(`console@${run.w}-${run.theme}: ${errors.slice(0, 3).join(' | ')}`);
  report.shots.push({ run: `${run.w}-${run.theme}`, consoleErrors: errors });
  await context.close();
}

// Once, at 1440 dark: the Super row (8), restart persistence (10), OFF.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('dreamcontext-theme', 'dark'); } catch { /* ignore */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const post = (body) => page.evaluate(async ([u, b]) => (await fetch(`${u}/api/launcher/ui-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(), [BASE, body]);
  const open = async () => {
    await page.goto(`${BASE}/?vault=${encodeURIComponent(VAULT)}`);
    await page.getByTestId('ns-titlebar').waitFor({ timeout: 15_000 });
    await settle(page, 2500);
    await dismissWhatsNew(page);
  };
  await page.goto(`${BASE}/api/health`);
  await post({ shell: 'new' });
  await open();

  // 8: the Super row on a project with NO chat and no Super record (initech at 1440, globex at
  // 1024): it starts a chat first (auto), then hands over; the drawer stays beside the stage.
  const superRow = async (vault, w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await open();
    const before = await page.evaluate(async ([u, v]) => {
      const r = await fetch(`${u}/api/agent/sessions`, { headers: { 'x-dreamcontext-vault': v } });
      const s = await fetch(`${u}/api/super/state`, { headers: { 'x-dreamcontext-vault': v } }).then((x) => x.json()).catch(() => ({}));
      return { tabs: (await r.json()).sessions?.length ?? null, superOn: !!(s.enabled ?? s.state?.enabled) };
    }, [BASE, vault]);
    if (!(await showDrawer(page))) { fail(`super-row@${w}: no drawer`); return; }
    await expandAll(page);
    await page.locator(`[data-drawer-project="${vault}"] [data-testid="drawer-super-row"]`).click();
    await settle(page, 7000);
    const st = await page.evaluate(async ([u, v]) => {
      const r = await fetch(`${u}/api/agent/sessions`, { headers: { 'x-dreamcontext-vault': v } }).then((x) => x.json());
      return {
        stage: !!document.querySelector('.project-instance:not([hidden]) .super-surface'),
        drawer: !!document.querySelector('[data-testid="chat-drawer"]'),
        picker: document.querySelector('[data-testid="ns-picker-btn"]')?.textContent?.trim(),
        spawned: (r.sessions ?? []).map((m) => ({ kind: m.kind, bypass: m.bypass })),
        chatPermissionMode: r.chatPermissionMode,
      };
    }, [BASE, vault]);
    report.checks[`superRow@${w}`] = { before, after: st };
    await page.screenshot({ path: join(OUT, `super-row-${vault}-${w}-dark.png`) });
    if (before.tabs !== 0 || before.superOn) fail(`super-row@${w}: ${vault} was not a fresh no-chat project (${JSON.stringify(before)})`);
    if (!st.stage) fail(`super-row@${w}: no Super stage on ${vault} (${JSON.stringify(st)})`);
    if (!st.drawer) fail(`super-row@${w}: the drawer left beside the stage`);
    if (!st.spawned.some((m) => m.kind === 'chat' && m.bypass === false)) fail(`super-row@${w}: no starter chat in auto (${JSON.stringify(st.spawned)})`);
    if (vault === 'initech' && st.chatPermissionMode !== 'bypass') fail(`super-row@${w}: the remembered bypass mode changed to ${st.chatPermissionMode}`);
  };
  await superRow('initech', 1440, 900);
  await superRow('globex', 1024, 768);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 10: order, width and expanded projects survive a restart.
  await open();
  await showDrawer(page);
  const handle = page.locator('.ns-dr-handle');
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 3, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 63, box.y + 200, { steps: 6 });
    await page.mouse.up();
    await settle(page, 600);
  }
  // Move initech up one with ⌥↑.
  await page.locator('[data-drawer-project="initech"] [data-testid="drawer-project-row"]').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await settle(page, 800);
  const before = await page.evaluate(() => ({
    width: Math.round(document.querySelector('[data-testid="chat-drawer"]')?.getBoundingClientRect().width ?? 0),
    order: [...document.querySelectorAll('[data-drawer-project]')].map((p) => p.getAttribute('data-drawer-project')),
    expanded: [...document.querySelectorAll('[data-drawer-project] [aria-expanded="true"]')].length,
  }));
  await settle(page, 800);
  await open();
  await showDrawer(page);
  const afterR = await page.evaluate(() => ({
    width: Math.round(document.querySelector('[data-testid="chat-drawer"]')?.getBoundingClientRect().width ?? 0),
    order: [...document.querySelectorAll('[data-drawer-project]')].map((p) => p.getAttribute('data-drawer-project')),
    expanded: [...document.querySelectorAll('[data-drawer-project] [aria-expanded="true"]')].length,
  }));
  report.checks.restart = { before, after: afterR };
  await page.screenshot({ path: join(OUT, 'restart-drawer-1440-dark.png') });
  if (JSON.stringify(before) !== JSON.stringify(afterR)) fail(`restart: drawer layout not kept (${JSON.stringify(before)} → ${JSON.stringify(afterR)})`);

  // OFF at 1440: the classic shell, no drawer, no page bars, classic Settings.
  await post({ shell: 'classic' });
  for (const p of ['tasks', 'settings']) {
    await page.goto(`${BASE}/?vault=${VAULT}&page=${p}`);
    await settle(page, 2500);
    await dismissWhatsNew(page);
    const off = await page.evaluate(() => ({
      newShell: document.querySelectorAll('[data-testid="ns-titlebar"], [data-testid="chat-drawer"], [data-testid="page-bar"], [data-testid="settings-search"]').length,
      sidebar: document.querySelectorAll('nav.sidebar').length,
    }));
    report.checks[`off-${p}`] = off;
    await page.screenshot({ path: join(OUT, `off-${p}-1440-dark.png`) });
    if (off.newShell !== 0 || off.sidebar !== 1) fail(`off-${p}: classic did not come back clean (${JSON.stringify(off)})`);
  }
  await post({ shell: 'new' });
  if (errors.length) fail(`console@once: ${errors.slice(0, 3).join(' | ')}`);
  report.checks.consoleOnce = errors;
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
process.exit(report.failures.length ? 1 : 0);
