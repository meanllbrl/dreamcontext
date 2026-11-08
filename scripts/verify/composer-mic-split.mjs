#!/usr/bin/env node
/**
 * The composer's mic split (owner, 2026-11-08), driven and photographed without building the app.
 *
 *   node scripts/verify/composer-mic-split.mjs [tag] [outDir]
 *
 * Drives the REAL `Composer` through the composer-voice harness (Vite dev, real CSS and theme
 * tokens), told it is the desktop shell. `?perm=` answers the shell's permission commands and
 * `?dict=0` starts with no dictation model (see the harness's stubs.ts). For each mode (super,
 * chat), theme (light, dark) and width (1440, 390):
 *   ready    permission granted, model installed: the split, no amber dot, the menu (spoken
 *            replies only on the Super stage, Voice settings);
 *   missing  never asked, no model: the mic is STILL drawn (the bug), carries the amber dot, a
 *            press opens the menu instead of recording, the permission step asks macOS, the model
 *            step installs through the existing route and shows progress, then both steps leave.
 * Asserts there is no separate speaker button anywhere, and collects console errors.
 *
 * Output: <outDir or tmp/verify-mic-split/<tag>>/<mode>-<theme>-<width>-<state>.png + report.json.
 * HONEST LIMIT: Chromium, not WKWebView; the macOS prompt itself is the shell's (mocked here).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASH = join(REPO, 'dashboard');
const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'composer-voice');
const TAG = process.argv[2] || 'run';
const OUT = process.argv[3] ? resolve(process.argv[3]) : join(REPO, 'tmp', 'verify-mic-split', TAG);
const MODES = (process.env.MODES || 'super,chat').split(',');
const THEMES = (process.env.THEMES || 'light,dark').split(',');
const WIDTHS = (process.env.WIDTHS || '1440,390').split(',').map(Number);

const fromDash = (p) => import(pathToFileURL(join(DASH, 'node_modules', p)).href);
const { createServer } = await fromDash('vite/dist/node/index.js');
const react = (await fromDash('@vitejs/plugin-react/dist/index.js')).default;

mkdirSync(OUT, { recursive: true });
const server = await createServer({
  configFile: false,
  root: HARNESS,
  logLevel: 'error',
  plugins: [react()],
  define: { __DC_VERSION__: JSON.stringify('0.0.0-harness') },
  resolve: {
    alias: [
      { find: /^react$/, replacement: join(DASH, 'node_modules', 'react') },
      { find: /^react\/(.*)$/, replacement: join(DASH, 'node_modules', 'react', '$1') },
      { find: /^react-dom$/, replacement: join(DASH, 'node_modules', 'react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: join(DASH, 'node_modules', 'react-dom', '$1') },
      { find: /^@tanstack\/react-query$/, replacement: join(DASH, 'node_modules', '@tanstack', 'react-query') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 0, host: '127.0.0.1', fs: { allow: [REPO] } },
  optimizeDeps: { entries: [join(HARNESS, 'index.html')] },
});
await server.listen();
const base = server.resolvedUrls.local[0];

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];
let failed = 0;
const check = (row, name, cond, detail = '') => {
  row.checks.push({ name, ok: !!cond, ...(detail ? { detail } : {}) });
  if (!cond) { failed++; console.log(`    ✗ ${row.id}: ${name}${detail ? ` (${detail})` : ''}`); }
};

/** The composer, plus the menu above it when one is open. */
async function shot(page, name) {
  const card = await page.locator('.chat-cmp').boundingBox();
  const menu = await page.locator('.chat-cmp-micmenu').boundingBox().catch(() => null);
  const top = Math.max(0, Math.min(card.y, menu ? menu.y : card.y) - 12);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: top, width: page.viewportSize().width, height: card.y + card.height + 8 - top } });
  return file;
}

const press = (page, type) => page.locator('.chat-cmp-mic').dispatchEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 });
const menuRows = (page) => page.$$eval('.chat-cmp-micmenu-row', (els) => els.map((e) => e.querySelector('.chat-cmp-micmenu-text > span')?.textContent ?? ''));

try {
  for (const mode of MODES) for (const theme of THEMES) for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2, permissions: ['microphone'] });
    const id = `${mode}-${theme}-${width}`;
    const row = { id, shots: {}, checks: [], errors: [] };
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') row.errors.push(m.text()); });
    page.on('pageerror', (e) => row.errors.push(String(e)));

    // ── ready ───────────────────────────────────────────────────────────────
    await page.goto(`${base}?mode=${mode}&theme=${theme}&perm=granted&readAloud=1`);
    await page.waitForSelector('.chat-cmp-mic', { timeout: 20_000 });
    await sleep(500);
    check(row, 'no separate speaker button', await page.locator('.chat-cmp-readaloud').count() === 0);
    check(row, 'the mic sits in the split with a caret', await page.locator('.chat-cmp-micsplit .chat-cmp-mic').count() === 1 && await page.locator('.chat-cmp-micsplit-caret').count() === 1);
    check(row, 'no amber dot when nothing is missing', await page.locator('.chat-cmp-micdot.is-step').count() === 0);
    check(row, mode === 'super' ? 'blue dot: replies are read aloud' : 'no blue dot outside the Super stage',
      (await page.locator('.chat-cmp-micdot.is-speaking').count() === 1) === (mode === 'super'));
    row.shots.ready = await shot(page, `${id}-ready`);
    await page.locator('.chat-cmp-micsplit-caret').click();
    await page.waitForSelector('.chat-cmp-micmenu', { timeout: 5000 });
    await sleep(250);
    const readyRows = await menuRows(page);
    row.readyMenu = readyRows;
    check(row, 'ready menu lists spoken replies (Super only) then Voice settings',
      JSON.stringify(readyRows) === JSON.stringify(mode === 'super' ? ['Reply aloud when I speak', 'Voice settings…'] : ['Voice settings…']), JSON.stringify(readyRows));
    row.shots.readyMenu = await shot(page, `${id}-ready-menu`);
    if (mode === 'super') {
      await page.locator('[role="menuitemcheckbox"]').click();
      await sleep(150);
      check(row, 'the switch turns spoken replies off (stored, dot gone)',
        await page.evaluate(() => localStorage.getItem('dreamcontext-read-aloud')) === '0' && await page.locator('.chat-cmp-micdot.is-speaking').count() === 0);
    }
    await page.keyboard.press('Escape');

    // ── missing: never asked, no model ───────────────────────────────────────
    await page.goto(`${base}?mode=${mode}&theme=${theme}&perm=prompt&dict=0`);
    await page.waitForSelector('.chat-cmp-mic', { timeout: 20_000 });
    await page.waitForSelector('.chat-cmp-micdot.is-step', { timeout: 5000 }).catch(() => {});
    await sleep(300);
    check(row, 'the mic is drawn with no permission and no model', await page.locator('.chat-cmp-mic').count() === 1);
    check(row, 'amber dot on the mic', await page.locator('.chat-cmp-micdot.is-step').count() === 1);
    row.shots.missing = await shot(page, `${id}-missing`);
    await press(page, 'pointerdown');
    await sleep(80);
    await press(page, 'pointerup');
    const opened = await page.waitForSelector('.chat-cmp-micmenu', { timeout: 3000 }).then(() => true, () => false);
    check(row, 'a press opens the menu, not a recording', opened && await page.locator('.chat-cmp-mic.is-recording').count() === 0);
    await sleep(400);
    const missingRows = await menuRows(page);
    row.missingMenu = missingRows;
    check(row, 'the steps lead the menu, permission first', missingRows[0] === 'Allow microphone access' && missingRows[1] === 'Set up dictation', JSON.stringify(missingRows));
    row.shots.missingMenu = await shot(page, `${id}-missing-menu`);

    await page.locator('.chat-cmp-micmenu-row.is-step', { hasText: 'Allow microphone access' }).click();
    await page.waitForFunction(() => !document.querySelector('.chat-cmp-micmenu')?.textContent?.includes('Allow microphone access'), null, { timeout: 4000 }).catch(() => {});
    check(row, 'the permission step asked the shell and left', (await page.evaluate(() => window.__invokes)).includes('mic_permission_request')
      && !(await menuRows(page)).includes('Allow microphone access'));

    await page.locator('.chat-cmp-micmenu-row.is-step', { hasText: 'Set up dictation' }).click();
    await page.waitForSelector('.chat-cmp-micmenu-bar', { timeout: 4000 }).catch(() => {});
    await sleep(300);
    check(row, 'the model step posted to the existing install route and shows progress',
      await page.evaluate(() => window.__dictPosts) === 1 && await page.locator('.chat-cmp-micmenu-bar').count() === 1);
    row.shots.installing = await shot(page, `${id}-installing`);
    await page.waitForFunction(() => !document.querySelector('.chat-cmp-micdot.is-step'), null, { timeout: 12_000 }).catch(() => {});
    await sleep(300);
    check(row, 'when the install lands both steps are gone', await page.locator('.chat-cmp-micdot.is-step').count() === 0 && !(await menuRows(page)).includes('Set up dictation'));
    row.shots.done = await shot(page, `${id}-done`);

    // ── refused: the step opens System Settings ─────────────────────────────
    await page.goto(`${base}?mode=${mode}&theme=${theme}&perm=denied`);
    await page.waitForSelector('.chat-cmp-micdot.is-step', { timeout: 8000 }).catch(() => {});
    await page.locator('.chat-cmp-micsplit-caret').click();
    await page.waitForSelector('.chat-cmp-micmenu', { timeout: 3000 });
    await sleep(200);
    row.shots.denied = await shot(page, `${id}-denied-menu`);
    await page.locator('.chat-cmp-micmenu-row.is-step').first().click();
    await sleep(300);
    check(row, 'a refused permission opens System Settings', (await page.evaluate(() => window.__invokes)).includes('mic_open_settings'));

    check(row, 'no console errors', row.errors.length === 0, row.errors.slice(0, 3).join(' | '));
    report.push(row);
    console.log(`  ${id}: ${row.checks.filter((c) => c.ok).length}/${row.checks.length}`);
    await ctx.close();
  }
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
}
console.log(`shots: ${OUT}`);
console.log(failed ? `FAILED: ${failed}` : 'ALL GREEN');
process.exit(failed ? 1 : 0);
