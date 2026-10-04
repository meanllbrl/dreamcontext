#!/usr/bin/env node
/**
 * A whiteboard draws a funnel as its explorer, any Lab card as a widget, and the date window on
 * the card: end-to-end proof in the real dashboard, in real Chromium.
 *
 *   npm run build && node scripts/verify/whiteboard-lab-card.mjs
 *
 * Boots the REAL dashboard server from the BUILT dashboard + CLI on an isolated scratch vault
 * (fake HOME, no network: the funnel is the synthetic Acme Storefront lab script in
 * fixtures/funnel-explorer-demo.mjs, a lookup funnel with platform / language / country dims).
 * Seeds a Lab board with the funnel-explorer preset card and a whiteboard holding an M funnel
 * insight widget, an XL funnel insight widget and a lab-card widget, then checks:
 *
 *   F1  the M funnel widget is a headline over a mini lane (one bar per step, every bar's name
 *       carries users, % of previous and % of top), never a table.
 *   F2  the XL funnel widget is the Lab funnel explorer: breakdown chips and the preset's tabs,
 *       opened on Steps, every step row says its % of the previous step.
 *   F3  a chip pick on the board narrows the card (the Language segments tab under
 *       platform=Meta Ads lists measured rows, no "Not measured" over the table).
 *   W1  every funnel widget prints the data window ("Sep 1 – Sep 28" style, from the cache).
 *   W2  the window chip opens Lab's range control; a preset writes the insight's range tweak,
 *       re-syncs, and the label follows.
 *   L1  the lab-card widget draws the board's card (title, chips, tabs); full screen opens over
 *       the app and Esc closes it.
 *   E   no page errors. Screenshots (light + dark) in tmp/whiteboard-lab-card-shots/.
 *
 * COLLECT-DON'T-FAIL-FAST: every check reports; the exit code is non-zero if any failed.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-wb-lab-card');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'whiteboard-lab-card-shots');
const PORT = 45767;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');
const DC = join(PROJ, '_dream_context');
const LAB = join(DC, 'lab');

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dc(args) {
  return execFileSync('node', [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

async function until(fn, ms = 10000, step = 150) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    await sleep(step);
  }
  return v;
}

async function waitForServer(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server did not come up at ${url}`);
}

const FUNNEL = 'acme-funnel';
const BOARD = 'acquisition';

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(DC, 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ]);
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }

  // The synthetic demo's funnel member, as a funnel render's script (one funnel-set/v1).
  dc(['lab', 'create', FUNNEL, '--title', 'Acme acquisition funnel', '--render', 'funnel', '--adapter', 'script', '--no-board']);
  const demo = readFileSync(join(REPO, 'scripts', 'verify', 'fixtures', 'funnel-explorer-demo.mjs'), 'utf-8')
    .replace('export default async function () {', 'async function demo() {');
  writeFileSync(join(LAB, 'scripts', `${FUNNEL}.mjs`), `${demo}\nexport default async function () { return (await demo()).data.funnel; }\n`, 'utf-8');
  dc(['lab', 'sync', FUNNEL]);

  dc(['lab', 'board', 'create', BOARD, '--title', 'Acquisition']);
  dc(['lab', 'board', 'add-card', BOARD, '--preset', 'funnel-explorer', '--insight', FUNNEL, '--locale', 'en']);

  // The default board (the rail's Whiteboard entry opens it), seeded before the dashboard makes it.
  dc(['whiteboard', 'create', 'Control Panel']);
  const add = (args) => JSON.parse(dc(['whiteboard', 'add', 'control-panel', ...args, '--json'])).id;
  return {
    mini: add(['insight', '--ref', FUNNEL, '--size', 'm', '--at', '0,0']),
    wide: add(['insight', '--ref', FUNNEL, '--size', 'xl', '--at', '0,196']),
    card: add(['lab-card', '--ref', `${BOARD}/c-${FUNNEL}`, '--at', '0,588']),
  };
}

function rangeTweak() {
  const md = readFileSync(join(LAB, 'insights', `${FUNNEL}.md`), 'utf-8');
  const m = /key:\s*range[\s\S]*?value:\s*["']?([a-z0-9_]+)/.exec(md);
  return m ? m[1] : null;
}

async function main() {
  const ids = setup();
  ok('fixture: the funnel synced', dc(['lab', 'show', FUNNEL]).includes('Quiz checkout'));
  ok('fixture: three widgets on the board', !!(ids.mini && ids.wide && ids.card));
  const lookupNote = dc(['lab', 'board', 'show', BOARD, '--select', 'platform=Meta Ads']);
  const languageTab = lookupNote.slice(lookupNote.indexOf('(tab Language)'));
  ok('F3 CLI: the Language segments tab under platform=Meta Ads prints no "Not measured" header',
    languageTab.length > 0 && !/^\s*Not measured\s*$/m.test(languageTab.split('\n').slice(0, 3).join('\n')), languageTab.split('\n').slice(0, 3).join(' | '));

  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(`${ORIGIN}/api/whiteboards`);
    const api = await (await fetch(`${ORIGIN}/api/lab/explorer/${FUNNEL}?locale=en`)).json();
    ok('API: /api/lab/explorer builds the one-card board', api?.board?.cards?.[0]?.blocks?.[0]?.type === 'breakdown');
    const notFunnel = await fetch(`${ORIGIN}/api/lab/explorer/no-such-insight`);
    ok('API: an unknown insight is a 404', notFunnel.status === 404, String(notFunnel.status));

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${ORIGIN}/?vault=proj`, { waitUntil: 'networkidle' });
    // What's New greets a fresh HOME: Esc closes it, as a user does.
    if (await until(() => page.locator('.announcements-modal-scrim').count(), 3000)) {
      await page.keyboard.press('Escape');
      await sleep(300);
    }
    await page.locator('.sidebar-item', { hasText: /Whiteboard(?!s)/ }).click();
    await until(() => page.locator('[data-widget-kind]').count().then((n) => n >= 3), 20000);
    // Fit the three widgets in view (Excalidraw's zoom-to-fit), so every one is mounted and visible.
    await page.locator('.wbp-canvas .excalidraw-container').first().focus().catch(() => {});
    await page.keyboard.press('Shift+1');
    await sleep(800);

    // F1: the M funnel widget.
    const mini = page.locator('[data-wb-funnel-mini]').first();
    ok('F1 the M funnel widget draws a headline over a mini lane', await mini.count() === 1);
    const bars = await page.locator('[data-wb-funnel-mini] .wb-funnel-lane-step').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    ok('F1 one lane bar per step (7)', bars.length === 7, String(bars.length));
    ok('F1 every bar names users, % of previous and % of top', bars.slice(1).every((b) => /of previous/.test(b) && /of top/.test(b)), bars[1] ?? '');
    ok('F1 no table in the M funnel widget', await page.locator('[data-widget-size="m"][data-widget-kind="insight"] table').count() === 0);

    // F2: the XL funnel widget is the explorer.
    const xl = page.locator('[data-widget-size="xl"][data-widget-kind="insight"]');
    await until(() => xl.locator('[data-wb-labcard]').count(), 15000);
    ok('F2 the XL funnel widget draws the Lab card', await xl.locator('[data-wb-labcard]').count() === 1);
    const tabs = await xl.locator('[role="tab"]').allTextContents();
    ok('F2 the preset tabs are there (Daily, Benchmark, Flow, Steps, one per dim)', ['Daily', 'Benchmark', 'Flow', 'Steps', 'Platform', 'Language', 'Country'].every((t) => tabs.some((x) => x.includes(t))), tabs.join(','));
    const selected = await xl.locator('[role="tab"][aria-selected="true"]').allTextContents();
    ok('F2 it opens on Steps', selected.some((s) => s.includes('Steps')), selected.join(','));
    const stepText = await xl.locator('.lab-block-funnel').first().innerText().catch(() => '');
    ok('F2 the steps say their % of the previous step', /of prev/.test(stepText), stepText.slice(0, 160));

    // W1: the window.
    const chips = await page.locator('[data-wb-window]').evaluateAll((els) => els.map((e) => ({ w: e.getAttribute('data-wb-window'), t: e.textContent })));
    ok('W1 every funnel widget prints its data window', chips.length >= 3 && chips.every((c) => /\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/.test(c.w ?? '')), JSON.stringify(chips));
    ok('W1 the label is a short date range', chips.every((c) => /[A-Z][a-z]{2} \d{1,2}/.test(c.t ?? '')), JSON.stringify(chips));

    for (const theme of ['light', 'dark']) {
      await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme);
      await sleep(300);
      await page.screenshot({ path: join(SHOTS, `board-${theme}.png`) });
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

    // F3: activate the XL widget, pick a chip, open the Language tab.
    const xlBox = await xl.boundingBox();
    await page.mouse.click(xlBox.x + xlBox.width / 2, xlBox.y + xlBox.height / 2);
    await sleep(300);
    const chip = xl.locator('button', { hasText: 'Meta Ads' }).first();
    await chip.click();
    await sleep(200);
    await xl.locator('[role="tab"]', { hasText: 'Language' }).first().click();
    await sleep(300);
    const seg = await xl.locator('[data-lab-segments]').first().innerText().catch(() => '');
    ok('F3 under platform=Meta Ads the Language tab lists rows', /EN/.test(seg) && /ES/.test(seg), seg.slice(0, 160));
    ok('F3 and no "Not measured" over them', !/^Not measured/m.test(seg));
    await page.screenshot({ path: join(SHOTS, 'explorer-selected.png') });

    // W2: change the window from the chip.
    const before = rangeTweak();
    const wideChip = xl.locator('[data-wb-window]');
    await wideChip.click();
    const pop = page.locator('.wb-window-pop');
    await until(() => pop.count(), 4000);
    ok('W2 the chip opens the range control', await pop.count() === 1);
    await page.screenshot({ path: join(SHOTS, 'window-picker.png') });
    const preset = pop.locator('.lab-range-pill', { hasText: /90/ }).first();
    const hasPreset = await preset.count() === 1;
    ok('W2 the declared presets are offered', hasPreset);
    if (hasPreset) {
      await preset.click();
      const after = await until(() => { const r = rangeTweak(); return r && r !== before ? r : null; }, 15000);
      ok('W2 a preset writes the insight range tweak', !!after && /90/.test(after), `${before} -> ${after}`);
      const label = await until(async () => {
        const w = await wideChip.getAttribute('data-wb-window');
        return w && !/Syncing/.test(await wideChip.innerText()) ? w : null;
      }, 20000);
      ok('W2 the label follows the re-synced data', !!label, String(label));
    }

    // L1: the lab-card widget and full screen.
    const card = page.locator('[data-widget-kind="lab-card"]');
    ok('L1 the lab-card widget draws the board card', await card.locator('[data-wb-labcard]').count() === 1);
    ok('L1 with its title', /Acme acquisition funnel/.test(await card.innerText()));
    const cardBox = await card.boundingBox();
    await page.mouse.click(cardBox.x + 120, cardBox.y + 16);
    await sleep(300);
    const fsBtn = card.locator('.wb-widget-actions button').first();
    await until(() => fsBtn.count(), 3000);
    ok('L1 the active widget offers full screen', await fsBtn.count() === 1);
    if (await fsBtn.count()) await fsBtn.click();
    const fs = page.locator('[data-wb-labcard-fullscreen]');
    await until(() => fs.count(), 4000);
    ok('L1 full screen opens over the app', await fs.count() === 1);
    if (await fs.count()) {
      const box = await fs.boundingBox();
      ok('L1 full screen spans the window', !!box && box.width >= 1500 && box.height >= 1000, JSON.stringify(box));
      await page.screenshot({ path: join(SHOTS, 'lab-card-fullscreen.png') });
      await page.keyboard.press('Escape');
      await sleep(300);
      ok('L1 Esc closes it', await fs.count() === 0);
    }

    ok('E no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    ok('the run finished', false, String(err?.stack ?? err));
  } finally {
    await browser?.close();
    server.kill();
  }

  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main();
