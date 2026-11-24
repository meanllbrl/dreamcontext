#!/usr/bin/env node
/**
 * Live links, the OWNER's screens (tunel-paylasim K1, K8, K13): the Live link sheet on an app's
 * page and on a board, in each face (form, starting, open, broken), and the Live links pill
 * (sidebar open, collapsed, new-shell rail), at 390 and 1440 px, light and dark.
 *
 * No tunnel here: `GET /api/shares` and the reveal are answered with fixed rows per face (the
 * real tunnel, door and guest are scripts/verify/shares.mjs). The screens are what is judged.
 *
 *   node scripts/verify/shares-owner.mjs      (through `dreamcontext builder heavy`)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = await openApp({ suite: 'shares-owner' });
const dc = (...args) => spawnSync(join(REPO, 'node_modules', '.bin', 'vite-node'), ['--root', REPO, join(REPO, 'src', 'cli', 'index.ts'), ...args], {
  cwd: app.proj, env: { ...process.env, HOME: app.home }, encoding: 'utf-8',
});

const made = dc('apps', 'new', 'funnel', '--name', 'Funnel Masası');
if (made.status !== 0) app.findings.push(`apps new failed: ${(made.stdout + made.stderr).slice(-300)}`);

const now = new Date(Date.now() - 4 * 60_000).toISOString();
const row = (over) => ({ id: 'sh_app', kind: 'app', vault: 'proj', slug: 'funnel', name: 'Funnel Masası', state: 'open', stage: null, people: 2, password: true, ai: false, openedAt: now, ...over });
const FACES = {
  form: [],
  download: [row({ state: 'starting', stage: 'download', people: 0 })],
  starting: [row({ state: 'starting', stage: 'tunnel', people: 0 })],
  open: [row({})],
  broken: [row({ state: 'broken', people: 0, error: 'cloudflared stopped' })],
};
const boardRow = (over) => row({ id: 'sh_board', kind: 'board', slug: 'control-panel', name: 'Control Panel', password: false, people: 1, ...over });
const REVEAL = { link: 'https://kuzey-limon-ornek.trycloudflare.com/k/6f1c2a9e0b7d4e3f8a5c1b2d9e0f7a6c', password: 'deniz-masa-kalem' };

// What makes the page believe it is in the Mac app (dashboard/src/lib/desktop.ts): the app page draws its buttons only there.
const DESKTOP_FLAG = `window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;
const theme = (t, extra = '', after = '') => () => `localStorage.setItem('dreamcontext-theme', '${t}');${extra}${DESKTOP_FLAG}${after}`;
/** The Mac app's native calls, recorded (a copy is the clipboard plugin's write with the text). */
const RECORD_INVOKES = `window.__TAURI_INTERNALS__.invoke = async (cmd, args) => { (window.__dcInvokes = window.__dcInvokes || []).push([cmd, args]); return null; };`;

/** Answer the live-link routes with `rows` (the sheet shows a live share's face instead of the form). */
async function fixRows(page, rows) {
  await page.route('**/api/shares', (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ json: { ...rows[0] ?? row({ state: 'starting', stage: 'download', people: 0 }), existing: false } });
    return route.fulfill({ json: { shares: rows } });
  });
  await page.route('**/api/shares/*/reveal', (route) => route.fulfill({ json: REVEAL }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

async function goApps(page, w) {
  if (w.width <= 600) {
    await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 });
    await page.getByText('Apps', { exact: true }).first().click({ timeout: 10_000 });
  } else {
    await page.locator('[aria-label="Apps"]').first().click({ timeout: 10_000 });
  }
  await page.waitForTimeout(1200);
}

async function goBoard(page, w) {
  if (w.width <= 600) {
    await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 });
    await page.getByText(/^Whiteboard$/).first().click({ timeout: 10_000 });
  } else {
    await page.locator('[aria-label="Whiteboard"]').first().click({ timeout: 10_000 });
  }
  await page.waitForTimeout(2500);
}

async function expectText(page, where, text) {
  const seen = await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false);
  if (!seen) app.findings.push(`${where}: "${text}" is not on the page`);
}

/** Run one step; a stuck step is a finding and the page is still shot as it stands. */
const step = (where, fn) => async (page, w) => { try { await fn(page, w); } catch (err) { app.findings.push(`${where}@${w.name}: ${err instanceof Error ? err.message.split("\n")[0] : err}`); } };

const SAYS = { form: 'Open link', download: 'downloading the tunnel tool (1/3)', starting: 'opening the tunnel (2/3)', open: 'Copy', broken: 'Try again' };

try {
  for (const t of ['light', 'dark']) {
    for (const [face, rows] of Object.entries(FACES)) {
      await app.look('/?vault=proj', step(`app-${face}-${t}`, async (page, w) => {
        await fixRows(page, rows);
        await goApps(page, w);
        await page.locator('.app-tile__open').first().click({ timeout: 10_000 });
        await page.waitForTimeout(800);
        await page.locator('[data-testid="live-share-app"]').first().click({ timeout: 10_000 });
        await page.waitForTimeout(1200);
        await expectText(page, `app-${face}-${t}@${w.name}`, SAYS[face]);
      }), { name: `app-${face}-${t}`, init: theme(t) });
    }
    for (const face of ['form', 'open']) {
      await app.look('/?vault=proj', step(`board-${face}-${t}`, async (page, w) => {
        await fixRows(page, face === 'form' ? [] : [boardRow({})]);
        await goBoard(page, w);
        const btn = page.locator('[data-testid="live-share-board"]').first();
        if (!(await btn.waitFor({ timeout: 15_000 }).then(() => true, () => false))) { app.findings.push(`board-${face}-${t}@${w.name}: no Live link button on the board`); return; }
        await btn.click({ timeout: 10_000 });
        await page.waitForTimeout(1200);
        await expectText(page, `board-${face}-${t}@${w.name}`, SAYS[face]);
      }), { name: `board-${face}-${t}`, init: theme(t) });
    }
    // The pill: an open app link and a starting board link, its list opened.
    for (const [shell, extra] of [['rail', '']]) {
      await app.look('/?vault=proj', step(`pill-${shell}-${t}`, async (page, w) => {
        await fixRows(page, [row({}), boardRow({ state: 'starting', stage: 'probe', people: 0 })]);
        const pill = page.locator('[data-testid="live-shares-pill"]').first();
        if (!(await pill.isVisible().catch(() => false))) {
          if (w.width > 600) app.findings.push(`pill-${shell}-${t}@${w.name}: the Live links pill is not visible`);
          return;
        }
        await pill.click({ timeout: 10_000 });
        await page.waitForTimeout(800);
        await expectText(page, `pill-${shell}-${t}@${w.name}`, 'Close all');
      }), { name: `pill-${shell}-${t}`, init: theme(t, extra) });
    }
  }
  // The classic shell's sidebar, open (the text pill) and collapsed (the glyph face).
  await fetch(`${app.base}/api/launcher/ui-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell: 'classic' }) });
  for (const t of ['light', 'dark']) {
    for (const [shell, collapsed] of [['classic-open', '0'], ['classic-collapsed', '1']]) {
      await app.look('/?vault=proj', step(`pill-${shell}-${t}`, async (page, w) => {
        await fixRows(page, [row({}), boardRow({ state: 'starting', stage: 'probe', people: 0 })]);
        const pill = page.locator('[data-testid="live-shares-pill"]').first();
        if (!(await pill.isVisible().catch(() => false))) {
          if (w.width > 600) app.findings.push(`pill-${shell}-${t}@${w.name}: the Live links pill is not visible`);
          return;
        }
        await pill.click({ timeout: 10_000 });
        await page.waitForTimeout(800);
        await expectText(page, `pill-${shell}-${t}@${w.name}`, 'Close all');
      }), { name: `pill-${shell}-${t}`, init: theme(t, `localStorage.setItem('dreamcontext.dashboard.sidebarCollapsed', '${collapsed}');`) });
    }
  }
  for (const t of ['light', 'dark']) {
    await app.look('/?vault=proj', step(`pill-actions-${t}`, async (page, w) => {
      let rows = [row({}), boardRow({ people: 0 })];
      const calls = [];
      await page.route('**/api/shares', (route) => route.fulfill({ json: { shares: rows } }));
      await page.route('**/api/shares/*/reveal', (route) => { calls.push(`reveal ${route.request().url().split('/').at(-2)}`); return route.fulfill({ json: REVEAL }); });
      await page.route('**/api/shares/*/close', (route) => {
        const id = route.request().url().split('/').at(-2);
        calls.push(`close ${id}`);
        rows = id === 'all' ? [] : rows.filter((r) => r.id !== id);
        return route.fulfill({ json: { ok: true } });
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      const where = `pill-actions-${t}@${w.name}`;
      const pill = page.locator('[data-testid="live-shares-pill"]').first();
      if (!(await pill.isVisible().catch(() => false))) { if (w.width > 600) app.findings.push(`${where}: the pill is not visible`); return; }
      await pill.click();
      const pop = page.locator('.live-pop');
      // Copy: the link is revealed and lands on the clipboard; the row says Copied.
      await pop.locator('.live-pop__row', { hasText: 'Funnel Masası' }).getByRole('button', { name: 'Copy' }).click();
      await expectText(page, where, 'Copied');
      const handed = await page.evaluate(() => JSON.stringify(window.__dcInvokes ?? []));
      if (!handed.includes(REVEAL.link) || !/clipboard/.test(handed)) app.findings.push(`${where}: Copy did not hand the link to the Mac clipboard: ${handed.slice(0, 300)}`);
      await page.screenshot({ path: join(app.shots, `pill-actions-${t}-copied-${w.name}.png`) });
      // Close: that row's link closes and leaves the list.
      await pop.locator('.live-pop__row', { hasText: 'Control Panel' }).getByRole('button', { name: 'Close' }).click();
      const boardGone = await pop.locator('.live-pop__row', { hasText: 'Control Panel' }).waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false);
      if (!boardGone) app.findings.push(`${where}: the closed board row is still listed`);
      await page.screenshot({ path: join(app.shots, `pill-actions-${t}-closed-one-${w.name}.png`) });
      // Close all: every link closes and the pill goes away.
      await pop.getByRole('button', { name: 'Close all' }).click();
      const pillGone = await pill.waitFor({ state: 'hidden', timeout: 5_000 }).then(() => true, () => false);
      if (!pillGone) app.findings.push(`${where}: the pill is still shown after Close all`);
      const want = ['reveal sh_app', 'close sh_board', 'close all'];
      if (JSON.stringify(calls) !== JSON.stringify(want)) app.findings.push(`${where}: calls ${JSON.stringify(calls)}, wanted ${JSON.stringify(want)}`);
    }), { name: `pill-actions-${t}`, init: theme(t, "localStorage.setItem('dreamcontext.dashboard.sidebarCollapsed', '0');", RECORD_INVOKES) });
  }
} catch (err) {
  app.findings.push(`script: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
}
process.exit(await app.finish());
