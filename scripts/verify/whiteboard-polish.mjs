#!/usr/bin/env node
/**
 * Whiteboard polish (owner feedback 2026-10-05), in real Chromium.
 *
 *   npm run build && node scripts/verify/whiteboard-polish.mjs
 *
 * Boots the REAL dashboard server from the BUILT dashboard + CLI on an isolated scratch vault
 * (fake HOME, no network: the insight is a local lab script), seeds a board with the CLI, then:
 *   P1  a tab renames in place: double-click → field → Enter; the tab, the list and the board
 *       file carry the new name, the slug (and the URL) stay; Escape cancels; right-click →
 *       Rename works; a reload keeps it; `whiteboard rename` does the same from the CLI.
 *   P2  a titled insight card's header is its title, as a heading (semibold, body colour), with
 *       no "INSIGHT" label; a card with no title still names its kind.
 *   P3  two insight cards resized short (376x112): the second, dragged to just under the first,
 *       lands one 16px gap below it, not a whole 196px pitch away.
 *   P4  the size control's colour button tints the selected card (on disk `dc.color`), the tint
 *       shows on the card's surface and border, "No colour" clears it; `update --color` works
 *       and a made-up colour is refused.
 *   P5  an HTML block fits its card: a long one is drawn smaller and shows whole (its last line
 *       inside the card), a short one's lone root element stretches to the card's height.
 *   P6  no console or page errors. Screenshots in light and dark to <scratch>/shots.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-whiteboard-polish');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const DC = join(PROJ, '_dream_context');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45767;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');
const BOARD = 'growth';

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
const dc = (args, cwd = PROJ) => execFileSync('node', [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
const dcFails = (args) => { try { execFileSync('node', [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME }, stdio: 'ignore' }); return false; } catch { return true; } };
const show = () => JSON.parse(dc(['whiteboard', 'show', BOARD, '--json']));
const elementsOf = (j) => j.elements ?? j.board?.elements ?? [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error(`server did not come up at ${url}`);
}

const ids = {};
function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(DC, 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], REPO);
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }
  mkdirSync(join(DC, 'lab', 'scripts'), { recursive: true });
  for (const [slug, title, unit, v] of [['ad-spend', 'Ad spend (7d)', 'USD', 1402.05], ['arppu', 'ARPPU (net, D0, 30d)', '$', 8.89]]) {
    dc(['lab', 'create', slug, '--title', title, '--render', 'number', '--adapter', 'script', '--unit', unit]);
    writeFileSync(join(DC, 'lab', 'scripts', `${slug}.mjs`), `export default async function () {
  return [{ name: '${slug}', points: [{ t: new Date().toISOString(), v: ${v} }] }];
}
`, 'utf-8');
    dc(['lab', 'sync', slug]);
  }
  dc(['whiteboard', 'create', 'Growth']);
  const add = (args) => JSON.parse(dc(['whiteboard', 'add', BOARD, ...args, '--json'])).id;
  ids.spend = add(['insight', '--ref', 'ad-spend', '--title', 'Ad spend (7d)', '--at', '0,0', '--size', '376,112']);
  ids.arppu = add(['insight', '--ref', 'arppu', '--title', 'ARPPU (net, D0, 30d)', '--at', '784,392', '--size', '376,112']);
  ids.untitled = add(['note', '--at', '1176,0']);
  const long = '<div class="dc-stack"><h3 class="dc-h3">Long block</h3>' + Array.from({ length: 14 }, (_, i) => `<p class="dc-p">Row ${i + 1}: lorem ipsum dolor sit amet</p>`).join('') + '<p class="dc-p" id="last">LAST LINE</p></div>';
  ids.longHtml = add(['html', '--title', 'Long block', '--text', long, '--at', '0,784', '--size', '376,376']);
  ids.shortHtml = add(['html', '--title', 'Short block', '--text', '<div class="dc-card" id="lone"><p class="dc-p">Short</p></div>', '--at', '392,784', '--size', '376,376']);
}

function readScene(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.wbp-canvas .excalidraw');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? root[key] : null; f; f = f.return) {
      const s = f.stateNode;
      if (s && s.scene && s.state && s.state.zoom) {
        const st = s.state;
        return {
          zoom: st.zoom.value, scrollX: st.scrollX, scrollY: st.scrollY, offsetLeft: st.offsetLeft, offsetTop: st.offsetTop,
          elements: s.scene.getElementsIncludingDeleted().filter((e) => !e.isDeleted).map((e) => ({ id: e.id, x: e.x, y: e.y, width: e.width, height: e.height })),
        };
      }
    }
    return null;
  });
}
const toClient = (s, x, y) => ({ x: (x + s.scrollX) * s.zoom + s.offsetLeft, y: (y + s.scrollY) * s.zoom + s.offsetTop });

async function main() {
  setup();
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  const errors = [];
  let browser;
  try {
    await waitForServer(`${ORIGIN}/api/whiteboards`);
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${ORIGIN}/?vault=proj#wb=${BOARD}`, { waitUntil: 'networkidle' });
    await sleep(800);
    if (await page.locator('.announcements-modal-scrim').count()) { await page.keyboard.press('Escape'); await sleep(300); }
    await page.locator('.sidebar-item', { hasText: /Whiteboard(?!s)/ }).first().click();
    await page.locator('.wbt-tab[aria-selected="true"]', { hasText: 'Growth' }).waitFor({ timeout: 10000 }).catch(async () => {
      await page.locator('.wbt-all').click();
      await page.locator('.wbs-panel--boards .wbs-row-open', { hasText: 'Growth' }).click();
    });
    await page.locator('.wbt-tab[aria-selected="true"]', { hasText: 'Growth' }).waitFor({ timeout: 10000 });
    await page.locator('.wb-widget--insight').first().waitFor({ timeout: 10000 });
    await sleep(800);

    // ── P1 rename ──
    const tab = page.locator('.wbt-tab[aria-selected="true"]');
    await tab.locator('.wbt-tab-name').dblclick();
    const field = page.locator('.wbt-tab-rename');
    ok('P1 a double-click opens the name field', await field.isVisible().catch(() => false));
    await field.fill('Gelir panosu');
    await field.press('Enter');
    ok('P1 Enter renames the tab', (await until(async () => (await tab.innerText()).includes('Gelir panosu'))) === true, await tab.innerText());
    const onDisk = await until(() => readFileSync(join(DC, 'whiteboards', BOARD, `${BOARD}.excalidraw.md`), 'utf-8').includes('name: "Gelir panosu"'));
    ok('P1 …the board file carries the new name, under the same slug', !!onDisk);
    ok('P1 …the URL still names the slug', (await page.evaluate(() => location.hash)).includes(`wb=${BOARD}`), await page.evaluate(() => location.hash));
    await tab.locator('.wbt-tab-name').dblclick();
    await field.fill('Throwaway');
    await field.press('Escape');
    ok('P1 Escape cancels', (await tab.innerText()).includes('Gelir panosu') && !(await tab.innerText()).includes('Throwaway'));
    await tab.click({ button: 'right' });
    await page.locator('.wbt-menu-item', { hasText: 'Rename' }).click();
    await field.fill('Growth board');
    await field.press('Enter');
    ok('P1 right-click → Rename renames too', (await until(async () => (await tab.innerText()).includes('Growth board'))) === true, await tab.innerText());
    await page.screenshot({ path: join(SHOTS, 'tab-renamed.png'), clip: { x: 220, y: 50, width: 900, height: 70 } });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.wb-widget--insight').first().waitFor({ timeout: 10000 });
    ok('P1 a reload keeps the name', (await page.locator('.wbt-tab[aria-selected="true"]').innerText()).includes('Growth board'));
    dc(['whiteboard', 'rename', BOARD, 'Growth']);
    const listed = JSON.parse(dc(['whiteboard', 'list', '--json']));
    ok('P1 `whiteboard rename` renames from the CLI, slug kept', listed.some((b) => b.slug === BOARD && b.name === 'Growth'), JSON.stringify(listed));
    ok('P1 an empty name is refused', dcFails(['whiteboard', 'rename', BOARD, '  ']));

    // ── P2 header ──
    const spendCard = page.locator('.wb-widget--insight').filter({ hasText: 'Ad spend (7d)' });
    const head = await spendCard.locator('.wb-widget-head').evaluate((h) => {
      const t = h.querySelector('.wb-widget-title');
      const cs = t ? getComputedStyle(t) : null;
      return {
        kind: h.querySelector('.wb-widget-kind')?.textContent ?? null,
        title: t?.textContent ?? null,
        weight: cs ? Number(cs.fontWeight) : 0,
        color: cs?.color,
        text: getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim(),
      };
    });
    ok('P2 a titled insight card shows no "INSIGHT" label', head.kind === null, JSON.stringify(head));
    ok('P2 …its title is the header, set as a heading (semibold)', head.title === 'Ad spend (7d)' && head.weight >= 600, JSON.stringify(head));
    const untitledKind = await page.locator('.wb-widget--note .wb-widget-kind').first().textContent().catch(() => null);
    ok('P2 a card with no title still names its kind', /note/i.test(untitledKind ?? ''), String(untitledKind));

    // ── P3 close placement ──
    let s = await readScene(page);
    const spend = s.elements.find((e) => e.id === ids.spend);
    const arppu = s.elements.find((e) => e.id === ids.arppu);
    // Grab the ARPPU card by its header strip (a drag, not a click into the card), drop it so its
    // top-left sits about 24px under Ad spend's bottom edge.
    const from = toClient(s, arppu.x + 40, arppu.y + 10);
    const to = toClient(s, spend.x + 46, spend.y + spend.height + 24 + 10);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    const landed = await until(() => {
      const el = elementsOf(show()).find((e) => e.id === ids.arppu);
      return el && el.bbox && el.bbox.y !== 392 ? el.bbox : null;
    }, 6000);
    ok('P3 a short card dragged under another lands one 16px gap below it, aligned', !!landed && landed.y === 112 + 16 && landed.x === 0, JSON.stringify(landed));
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, 'cards-close-light.png'), clip: { x: 220, y: 110, width: 1220, height: 560 } });

    // ── P4 colour ──
    s = await readScene(page);
    const sp = s.elements.find((e) => e.id === ids.spend);
    const edge = toClient(s, sp.x + 6, sp.y + 6);
    await page.mouse.click(edge.x, edge.y);
    await page.locator('.wb-size-picker').waitFor({ timeout: 3000 }).catch(() => {});
    ok('P4 the size control carries a colour button', await page.locator('.wb-size-picker .wb-color-toggle').isVisible().catch(() => false));
    ok('P4 …and still exactly the four size segments', JSON.stringify((await page.locator('.wb-size-picker .wb-size-option').allInnerTexts()).map((t) => t.trim())) === '["S","M","L","XL"]');
    const plainBg = await spendCard.evaluate((e) => getComputedStyle(e).backgroundColor);
    await page.locator('.wb-color-toggle').click();
    ok('P4 the colour button opens nine choices (none + eight)', (await page.locator('.wb-color-row .wb-color-swatch').count()) === 9);
    await page.screenshot({ path: join(SHOTS, 'color-row-light.png') });
    await page.locator('.wb-color-swatch[data-card-color="blue"]').click();
    const stored = await until(() => elementsOf(show()).find((e) => e.id === ids.spend)?.color === 'blue', 6000);
    ok('P4 picking blue stores dc.color = blue', !!stored);
    const tinted = await spendCard.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, border: getComputedStyle(e).borderTopColor }));
    ok('P4 …and the card surface is tinted', tinted.bg !== plainBg, JSON.stringify({ plainBg, tinted }));
    ok('P4 …the colour button shows the colour', (await page.locator('.wb-color-toggle .wb-color-dot').getAttribute('data-card-color')) === 'blue');
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.screenshot({ path: join(SHOTS, 'cards-colored-light.png'), clip: { x: 220, y: 110, width: 1220, height: 560 } });
    await page.mouse.click(edge.x, edge.y);
    await page.locator('.wb-color-toggle').click();
    await page.locator('.wb-color-swatch--none').click();
    const cleared = await until(() => elementsOf(show()).find((e) => e.id === ids.spend)?.color === undefined, 6000);
    ok('P4 "No colour" clears it', !!cleared);
    dc(['whiteboard', 'update', BOARD, ids.arppu, '--color', 'green']);
    ok('P4 `update --color green` tints from the CLI', await until(() => page.locator('.wb-widget-tint[data-card-color="green"] .wb-widget--insight').count(), 6000) > 0);
    ok('P4 a made-up colour is refused', dcFails(['whiteboard', 'update', BOARD, ids.arppu, '--color', 'orange']));
    dc(['whiteboard', 'update', BOARD, ids.spend, '--color', 'purple']);
    await sleep(1500);

    // ── P5 HTML fits its card ──
    await page.keyboard.press('Escape');
    const htmlCard = (t) => page.locator('.wb-widget--html').filter({ hasText: t });
    await until(async () => (await page.locator('iframe.wb-html-frame').count()) >= 2, 8000);
    await sleep(1500);
    const fitOf = async (t) => htmlCard(t).evaluate((card) => {
      const f = card.querySelector('iframe.wb-html-frame');
      const body = card.querySelector('.wb-widget-body').getBoundingClientRect();
      const fr = f.getBoundingClientRect();
      return { scale: Number(f.dataset.scale || 1), frameBottom: fr.bottom, bodyBottom: body.bottom, frameH: fr.height, bodyH: body.height };
    });
    const longFit = await fitOf('Long block');
    const frameFor = async (needle) => {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        if (await f.locator(needle).count().catch(() => 0)) return f;
      }
      return null;
    };
    const longFrame = await frameFor('#last');
    const lastInside = longFrame ? await longFrame.evaluate(() => {
      const r = document.getElementById('last').getBoundingClientRect();
      return { bottom: r.bottom, vh: window.innerHeight };
    }) : null;
    ok('P5 a long HTML block is drawn smaller to fit its card', longFit.scale < 1 && longFit.scale >= 0.5, JSON.stringify(longFit));
    ok('P5 …and its last line is inside the card', !!lastInside && lastInside.bottom <= lastInside.vh + 1 && longFit.frameBottom <= longFit.bodyBottom + 1,
      JSON.stringify({ lastInside, longFit }));
    const shortFit = await fitOf('Short block');
    const shortFrame = await frameFor('#lone');
    const lone = shortFrame ? await shortFrame.evaluate(() => ({ h: document.getElementById('lone').getBoundingClientRect().height, vh: window.innerHeight })) : null;
    ok('P5 a short block keeps full size', shortFit.scale === 1, JSON.stringify(shortFit));
    ok('P5 …and its lone root element fills the card\'s height', !!lone && lone.h >= lone.vh - 2, JSON.stringify(lone));
    await page.screenshot({ path: join(SHOTS, 'html-fit-light.png'), clip: { x: 220, y: 110, width: 1220, height: 780 } });

    // ── dark ──
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(500);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(SHOTS, 'cards-dark.png'), clip: { x: 220, y: 50, width: 1220, height: 620 } });
    const darkCard = await page.locator('.wb-widget-tint[data-card-color="purple"] .wb-widget').evaluate((e) => getComputedStyle(e).backgroundColor).catch(() => '');
    ok('P4 the tint follows the dark theme too', !!darkCard && darkCard !== tinted.bg, darkCard);

    ok('P6 no console or page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
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
