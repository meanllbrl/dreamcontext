#!/usr/bin/env node
/**
 * Navigation B, observed (W2): seven fictional projects in a scratch HOME, the project rail, its
 * card, the breadcrumb, ← and ⌘K across projects, clicked the way the owner would and counted.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/navigation-b.mjs
 *
 * Screenshots: 1440×900 light, 1180×800 dark, phone 390×844. Prints each scenario's click count
 * next to the report's target. Exit 0 = every scenario landed and no console error; 1 = findings.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const OUT = process.env.NAV_B_OUT ?? null;
const PROJECTS = ['proj', 'pocket-ledger', 'northwind', 'orbit', 'lumen', 'harbor', 'quill'];
const app = await openApp({ suite: 'navigation-b' });
const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}` };
for (const name of PROJECTS.slice(1)) {
  const dir = join(dirname(app.proj), name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, dir], { cwd: dir, env, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`register ${name}: ${r.stderr.slice(-200)}`);
}

const results = [];
const shots = [];
const browser = await chromium.launch();

async function session({ width, height, theme, name }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await markAnnouncementsSeen(context, app.base);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|\/ws\b|WebSocket/.test(m.text())) app.findings.push(`${name} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => app.findings.push(`${name} crash: ${String(e.message).slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 400) app.findings.push(`${name} ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search.slice(0, 60)} [${r.request().headers()['x-dreamcontext-vault'] ?? ''}]`); });
  return { context, page };
}
const shot = async (page, file) => {
  const p = join(app.shots, file);
  await page.screenshot({ path: p });
  shots.push(p);
  if (OUT) { mkdirSync(OUT, { recursive: true }); copyFileSync(p, join(OUT, file)); }
};
const crumb = (page) => page.getByTestId('ns-crumb').innerText().then((s) => s.replace(/\s+/g, ' ').trim());
const waitCrumb = async (page, re, timeout = 12_000) => {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = await crumb(page).catch(() => '');
    if (re.test(last)) return last;
    await page.waitForTimeout(150);
  }
  return `NOT REACHED (${last})`;
};
const badge = (page, name) => page.locator(`[data-testid="ns-prail-badge"][data-project="${name}"]`);
const goPage = async (page, p) => { await page.getByTestId(`ns-rail-${p}`).click(); await page.waitForTimeout(500); };
const settle = (page) => page.waitForTimeout(700);

// ── 1440 × 900, light: the seven scenarios ──
{
  const { context, page } = await session({ width: 1440, height: 900, theme: 'light', name: '1440-light' });
  await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('ns-prail').waitFor({ timeout: 60_000 });
  // Seed: a board in each project, a task in northwind.
  await page.evaluate(async (names) => {
    const post = (v, path, body) => fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': v }, body: JSON.stringify(body) });
    for (const v of names) await post(v, '/whiteboards', { name: v === 'pocket-ledger' ? 'Launch plan' : v === 'proj' ? 'Q4 roadmap' : `${v} map` });
    await post('northwind', '/tasks', { name: 'Approve beta list', why: 'Who gets the beta.' });
    await post('proj', '/tasks', { name: 'Warehouse import', why: 'Move the stock list.' });
  }, PROJECTS);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('ns-prail').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const badges = await page.getByTestId('ns-prail-badge').count();
  if (badges !== PROJECTS.length) app.findings.push(`rail shows ${badges} badges, expected ${PROJECTS.length}`);
  await shot(page, 'S0-rail-1440-light.png');

  // Setup (not counted): pocket-ledger › Boards › Launch plan, so its last board is known.
  await badge(page, 'pocket-ledger').click();
  await settle(page);
  await goPage(page, 'whiteboards');
  await page.getByText('Launch plan', { exact: true }).first().click();
  await waitCrumb(page, /pocket-ledger › .+ › Launch plan/);
  await settle(page);
  // Then proj › Boards › Q4 roadmap.
  await badge(page, 'proj').click();
  await settle(page);
  await page.getByText('Q4 roadmap', { exact: true }).first().click().catch(() => {});
  await waitCrumb(page, /proj › .+ › Q4 roadmap/);
  await settle(page);

  // S1: from a board, the other project's board: one click on its badge.
  await badge(page, 'pocket-ledger').click();
  results.push({ s: 1, what: 'Panodan başka projenin panosu', target: '1', clicks: 1, landed: await waitCrumb(page, /pocket-ledger › .+ › Launch plan/) });
  await settle(page);
  await shot(page, 'S1-sonra-1440-light.png');

  // S2: from a board, another project's Super: hover the badge (not a click), the card's Super row.
  await badge(page, 'northwind').hover();
  await page.getByTestId('ns-pcard').waitFor({ timeout: 3_000 }).catch(() => app.findings.push('S2: the card did not open on hover'));
  await page.waitForTimeout(300);
  await shot(page, 'S2-kart-1440-light.png');
  await page.getByTestId('ns-pcard-super').click();
  results.push({ s: 2, what: "Panodan başka projenin Super'i", target: '1', clicks: 1, landed: await waitCrumb(page, /northwind › Chat/, 20_000) });
  await settle(page);
  await shot(page, 'S2-sonra-1440-light.png');

  // S3: from Tasks, the other project's tasks.
  await badge(page, 'proj').click();
  await settle(page);
  await goPage(page, 'tasks');
  await waitCrumb(page, /proj › Tasks/);
  await settle(page);
  await badge(page, 'northwind').click();
  results.push({ s: 3, what: "Tasks'tan başka projenin işleri", target: '1', clicks: 1, landed: await waitCrumb(page, /northwind › Tasks/) });
  await settle(page);
  await shot(page, 'S3-sonra-1440-light.png');

  // S4: from Chat, another project's page (orbit › Apps): its badge (Chat carried), then Apps.
  await badge(page, 'proj').click();
  await settle(page);
  await goPage(page, 'chat');
  await page.waitForTimeout(800);
  await badge(page, 'orbit').click();
  await waitCrumb(page, /orbit/);
  await settle(page);
  await goPage(page, 'apps');
  results.push({ s: 4, what: "Chat'ten başka projenin sayfası (orbit › Apps)", target: '1-2', clicks: 2, landed: await waitCrumb(page, /orbit › Apps/) });
  await settle(page);
  await shot(page, 'S4-sonra-1440-light.png');

  // S5: ⌘K finds a board in another project by name; Enter lands it.
  await badge(page, 'northwind').click();
  await settle(page);
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Launch plan');
  await page.waitForTimeout(2500);
  await shot(page, 'S5-cmdk-1440-light.png');
  await page.keyboard.press('Enter');
  results.push({ s: 5, what: 'Başka projede adıyla pano bulmak (⌘K)', target: '1', clicks: 1, landed: await waitCrumb(page, /pocket-ledger › .+ › Launch plan/) });
  await settle(page);

  // S6: ← returns to the place before, in the other project.
  const back = page.locator('[data-testid="ns-back"], button[aria-label^="Back"], button[title^="Back"]').first();
  const tip = await back.getAttribute('title').catch(() => null);
  await back.click();
  results.push({ s: 6, what: 'Geri: önceki projedeki yere dönmek', target: '1', clicks: 1, landed: `${await waitCrumb(page, /northwind/)} (tooltip: ${tip})` });
  await settle(page);
  await shot(page, 'S6-sonra-1440-light.png');

  // S7: the red count opens the first thing waiting (only when something waits in this scratch set).
  const counts = await page.getByTestId('ns-prail-count').count();
  results.push({ s: 7, what: 'Kırmızı işaret seni işe götürür', target: '1', clicks: counts ? 1 : null, landed: counts ? 'count shown' : 'nothing waits in the scratch projects: unit-tested (rail-marks)' });
  await context.close();
}

// ── 1180 × 800, dark: rail + card ──
for (const [w, h, theme] of [[1180, 800, 'dark'], [1440, 900, 'dark'], [1180, 800, 'light']]) {
  const tag = `${w}-${theme}`;
  const { context, page } = await session({ width: w, height: h, theme, name: tag });
  await page.goto(`${app.base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('ns-prail').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await goPage(page, 'whiteboards');
  await page.getByText('Launch plan', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await badge(page, 'northwind').hover();
  await page.getByTestId('ns-pcard').waitFor({ timeout: 3_000 }).catch(() => app.findings.push(`${tag}: no card`));
  await page.waitForTimeout(300);
  await shot(page, `S1-kart-${tag}.png`);
  await context.close();
}

// ── Phone 390 × 844: the strip and the long-press sheet ──
{
  const { context, page } = await session({ width: 390, height: 844, theme: 'light', name: 'phone' });
  await page.goto(`${app.base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('ns-prail-strip').waitFor({ timeout: 60_000 }).catch(() => app.findings.push('phone: no project strip'));
  await page.waitForTimeout(1500);
  await shot(page, 'B-telefon-serit.png');
  const b = badge(page, 'northwind');
  const box = await b.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.getByTestId('ns-pcard-sheet').waitFor({ timeout: 3_000 }).catch(() => app.findings.push('phone: long press opened no sheet'));
    await page.waitForTimeout(400);
    await shot(page, 'B-telefon-sheet.png');
  }
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) app.findings.push(`phone overflows sideways by ${over}px`);
  await context.close();
}

await browser.close();
for (const r of results) {
  const ok = !String(r.landed).startsWith('NOT REACHED');
  if (!ok) app.findings.push(`S${r.s} did not land: ${r.landed}`);
  process.stdout.write(`S${r.s} ${r.what}: ${r.clicks ?? '-'} click(s), target ${r.target} → ${r.landed}\n`);
}
for (const s of shots) process.stdout.write(`shot: ${s}\n`);
process.exit(await app.finish());
