#!/usr/bin/env node
/**
 * Mağaza D1, observed (criteria 1, 2, 6, 9, 12, 13): a scratch project with no plugin data, then
 * with roadmap data, looked at 390 and 1440 px in the light and the dark theme.
 *
 *   dreamcontext builder heavy -- node scripts/verify/plugins.mjs [--out <dir>]
 *
 * Screens: the new project's rail, Mağaza home, a category, a plugin page, install from the plugin
 * page (rail row + Aç), Launchpad with its context menu, remove through the in-app confirm, an
 * uninstalled plugin's page shown as its Mağaza page, an existing project whose objectives make
 * Roadmap installed, and a reload on an installed plugin's page. Exit 0 = clean, 1 = findings.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openApp } from './lib/app.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const app = await openApp({ suite: 'plugins' });
const V = 'proj';
const api = async (method, path, body) => {
  const r = await fetch(`${app.base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': V },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const state = async () => Object.fromEntries(((await api('GET', '/plugins')).body?.plugins ?? []).map((p) => [p.id, p]));
const check = (ok, what) => { if (!ok) app.findings.push(what); };
const visible = (page, sel, ms = 8_000) => page.locator(sel).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const gone = (page, sel, ms = 8_000) => page.locator(sel).first().waitFor({ state: 'detached', timeout: ms }).then(() => true, () => false);
const theme = (t) => () => `try { localStorage.setItem('dreamcontext-theme', '${t}'); } catch {}`;
/** The rail's row for a page: on the bottom bar (390) a page may sit in More. */
const railHas = async (page, w, id) => {
  if ((await page.locator(`[data-testid="ns-rail-${id}"]`).count()) > 0) return true;
  if (w.width > 600) return false;
  const more = page.locator('[data-testid="ns-rail-more"]');
  if (!(await more.count())) return false;
  await more.click();
  const n = await page.locator(`[data-testid="ns-more-${id}"]`).count();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 120).catch(() => {});
  return n > 0;
};
/** Go to a page by the rail (More on the bottom bar), as the owner would: a rail click also
 *  folds the chat the new shell opens over the page at start. */
const go = async (page, id) => {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const row = page.locator(`[data-testid="ns-rail-${id}"]`);
  if (await row.isVisible().catch(() => false)) await row.click();
  else {
    await page.locator('[data-testid="ns-rail-more"]').click();
    await page.locator(`[data-testid="ns-more-${id}"]`).click();
  }
  await page.waitForTimeout(600);
  if (await page.locator('.agent-surface.expanded').count()) app.findings.push(`the chat still covers ${id} after a rail click`);
};

try {
  // 1. A new project is core only: nothing installed, nothing written under overrides/plugins.
  const s0 = await state();
  check(Object.values(s0).length === 5 && Object.values(s0).every((p) => !p.installed && p.source === 'none'), `new project: expected five plugins not installed, got ${JSON.stringify(s0)}`);

  for (const t of ['light', 'dark']) {
    const init = theme(t);
    const reset = async () => { for (const id of ['hypotheses', 'roadmap', 'lab', 'council', 'marketing']) await api('POST', `/plugins/${id}/remove`, {}); };
    await reset();

    await app.look(`/?vault=${V}`, async (page, w) => {
      await visible(page, '[data-testid="ns-rail"]');
      for (const id of ['roadmap', 'lab', 'hypotheses', 'council']) check(!(await railHas(page, w, id)), `${t}@${w.name}: the new project's rail shows ${id}`);
      check(await railHas(page, w, 'store'), `${t}@${w.name}: no Mağaza on the rail`);
    }, { name: `01-new-project-${t}`, init });

    await app.look(`/?vault=${V}`, async (page, w) => {
      await go(page, 'store');
      check(await visible(page, '[data-testid="plugin-store"][data-view="home"]'), `${t}@${w.name}: store home not shown`);
      for (const id of ['roadmap', 'hypotheses', 'lab', 'council', 'marketing']) check(await visible(page, `[data-testid="plugin-add-${id}"]`, 3_000), `${t}@${w.name}: no + for ${id}`);
    }, { name: `02-store-home-${t}`, init });

    await app.look(`/?vault=${V}`, async (page, w) => {
      await go(page, 'store');
      await page.locator('[data-testid="plugin-cat-data"]').click();
      check(await visible(page, '[data-testid="plugin-store"][data-view="cat"]'), `${t}@${w.name}: category page not shown`);
      check((await page.locator('[data-testid^="plugin-row-"]').count()) === 2, `${t}@${w.name}: data category should list two plugins`);
    }, { name: `03-store-category-${t}`, init });

    await app.look(`/?vault=${V}`, async (page, w) => {
      await go(page, 'store');
      await page.locator('[data-testid="plugin-row-hypotheses"]').click();
      check(await visible(page, '[data-testid="plugin-page-hypotheses"]'), `${t}@${w.name}: plugin page not shown`);
      check(await visible(page, '[data-testid="plugin-install"]'), `${t}@${w.name}: no Kur on the plugin page`);
      check((await page.locator('[data-testid^="plugin-give-"]').count()) === 4, `${t}@${w.name}: hypotheses should list four gives`);
    }, { name: `04-plugin-page-${t}`, init });

    // 5. Install from the plugin page: Kur turns into Aç, the page is on the rail.
    await app.look(`/?vault=${V}`, async (page, w) => {
      await api('POST', '/plugins/hypotheses/remove', {});
      await go(page, 'store');
      await page.locator('[data-testid="plugin-row-hypotheses"]').click();
      await page.locator('[data-testid="plugin-install"]').click();
      check(await visible(page, '[data-testid="plugin-open"]'), `${t}@${w.name}: Kur did not turn into Aç`);
      check(await railHas(page, w, 'hypotheses'), `${t}@${w.name}: after install Hypotheses is not on the rail`);
      check((await state()).hypotheses?.installed === true, `${t}@${w.name}: the server does not report hypotheses installed`);
    }, { name: `05-installed-${t}`, init });

    // 6. Launchpad: the installed plugin's tile and its context menu.
    await app.look(`/?vault=${V}`, async (page, w) => {
      await go(page, 'apps');
      check(await visible(page, '[data-testid="launchpad-plugin-hypotheses"]'), `${t}@${w.name}: Launchpad has no Hypotheses tile`);
      check((await page.locator('[data-testid="launchpad-plugin-roadmap"]').count()) === 0, `${t}@${w.name}: Launchpad shows an uninstalled plugin`);
      await page.locator('[data-testid="launchpad-plugin-hypotheses"]').click({ button: 'right' });
      check(await visible(page, '[data-testid="launchpad-plugin-menu"]'), `${t}@${w.name}: no context menu`);
    }, { name: `06-launchpad-${t}`, init });

    // 7. Remove through the in-app confirm: the tile and the rail row go, the data stays.
    await app.look(`/?vault=${V}`, async (page, w) => {
      await api('POST', '/plugins/hypotheses/install', {});
      await go(page, 'apps');
      await page.locator('[data-testid="launchpad-plugin-hypotheses"]').click({ button: 'right' });
      await page.locator('[data-testid="launchpad-remove"]').click();
      check(await visible(page, '[data-testid="plugin-remove-confirm"]'), `${t}@${w.name}: no in-app confirm`);
      await page.locator('[data-testid="plugin-remove-ok"]').click();
      check(await gone(page, '[data-testid="launchpad-plugin-hypotheses"]'), `${t}@${w.name}: the tile stayed after remove`);
      check(!(await railHas(page, w, 'hypotheses')), `${t}@${w.name}: the rail row stayed after remove`);
    }, { name: `07-removed-${t}`, init });

    // 8. Removed while on its page (a teammate's remove on the poll): the Mağaza page shows in
    //    place, with Kur; the URL-linked `?page=roadmap` lands on the same page.
    await app.look(`/?vault=${V}&page=roadmap`, async (page, w) => {
      check(await visible(page, '[data-testid="plugin-page-roadmap"]'), `${t}@${w.name}: ?page=roadmap did not show Roadmap's Mağaza page`);
      await api('POST', '/plugins/roadmap/install', {});
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await go(page, 'roadmap');
      check(await gone(page, '[data-testid="plugin-page-roadmap"]'), `${t}@${w.name}: installed Roadmap still shows its Mağaza page`);
      await api('POST', '/plugins/roadmap/remove', {});
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
      check(await visible(page, '[data-testid="plugin-page-roadmap"]', 20_000), `${t}@${w.name}: removing Roadmap while on its page did not show its Mağaza page`);
      check(await visible(page, '[data-testid="plugin-install"]'), `${t}@${w.name}: no Kur in place of the roadmap page`);
    }, { name: `08-uninstalled-in-place-${t}`, init });
  }

  // 9. An existing project: objectives on disk and no owner entry make Roadmap installed.
  await api('POST', '/plugins/roadmap/remove', {});
  const { rmSync } = await import('node:fs');
  rmSync(join(app.proj, '_dream_context', 'overrides', 'plugins', 'roadmap.json'), { force: true });
  // As on a Mac that never ran this CLI: no pins yet, so the first read pins what is installed.
  const localPath = join(app.proj, '_dream_context', 'state', '.brain-local.json');
  try {
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    delete local.pluginPins;
    writeFileSync(localPath, JSON.stringify(local, null, 2));
  } catch { /* no local file: nothing pinned yet */ }
  mkdirSync(join(app.proj, '_dream_context', 'core', 'objectives'), { recursive: true });
  writeFileSync(join(app.proj, '_dream_context', 'core', 'objectives', 'grow-signups.md'), '---\nslug: grow-signups\ntitle: Grow signups\nstatus: active\n---\n\nGrow weekly signups.\n');
  const s9 = await state();
  check(s9.roadmap?.installed === true && s9.roadmap?.source === 'data', `existing project: roadmap should be installed from data, got ${JSON.stringify(s9.roadmap)}`);
  await app.look(`/?vault=${V}&page=roadmap`, async (page, w) => {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    check((await page.locator('[data-testid="plugin-page-roadmap"]').count()) === 0, `existing@${w.name}: the installed Roadmap page was replaced by its Mağaza page`);
    check(await railHas(page, w, 'roadmap'), `existing@${w.name}: Roadmap (data, pinned on first read) is not on the rail`);
    await go(page, 'roadmap');
    check((await page.locator('[data-testid="plugin-page-roadmap"]').count()) === 0, `existing@${w.name}: Roadmap shows its Mağaza page after a rail click`);
  }, { name: '09-existing-reload-roadmap-light', init: theme('light') });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}

if (values.out) {
  mkdirSync(values.out, { recursive: true });
  for (const f of app.taken) copyFileSync(f, join(values.out, f.split('/').pop()));
}
process.exit(await app.finish());
