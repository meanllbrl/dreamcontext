#!/usr/bin/env node
/**
 * The left drawer, owner 2026-11-03, at 1440 dark:
 *   0 a collapsed project hides its Team row too; open, the Team row is the last row.
 *   A the Projects header's search filters the list (Turkish-safe); Esc restores it.
 *   B a drawer nobody sized opens at its narrowest width; a dragged width is kept over a reload.
 *   C a project with no member reads "Set your team" (a plain row, no faces); a click opens Manage members.
 *
 *   npm run build && node scripts/verify/ekip-katla.mjs [outDir]
 *
 * The real dashboard server from dist (scratch HOME), two real members made with
 * `dreamcontext agents create`. Console errors and failed requests are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, reporter, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-ekip-katla-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
/** No member of its own (C), and Turkish names for the search (A). */
const EMPTY = 'tilki-ogretmen';
const OTHER = 'çiçek-atölyesi';
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'ekip-katla'));

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const { ok, summary } = reporter();

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: join(SCRATCH, 'reports.ndjson'), cli: CLI }));
  chmodSync(bin, 0o755);
  const steps = [['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })]];
  steps.push(['agent ua-manager', dc('agents', 'create', 'ua-manager', '--title', 'UA Manager', '--prompt', 'Ücretli edinmeyi izler.')]);
  steps.push(['agent veri-analisti', dc('agents', 'create', 'veri-analisti', '--title', 'Veri Analisti', '--prompt', 'Veriyi okur.')]);
  for (const v of [EMPTY, OTHER]) {
    mkdirSync(join(SCRATCH, v, '_dream_context', 'state'), { recursive: true });
    spawnSync('git', ['-C', join(SCRATCH, v), 'init', '-q'], { encoding: 'utf-8' });
    steps.push([`vaults add ${v}`, spawnSync(process.execPath, [CLI, 'vaults', 'add', v, join(SCRATCH, v)], { env: env(), encoding: 'utf-8' })]);
  }
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk');
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await applyTheme(page, 'dark');
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }

  const project = page.locator(`[data-drawer-project="${VAULT}"]`).first();
  const toggle = project.locator('[data-testid="drawer-project-row"]').first();
  const teamRow = project.locator('[data-testid="drawer-team-row"]');
  ok('the project row is drawn', await until(page, async () => (await toggle.count()) === 1, 20000));
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  ok('open: the project is expanded', await until(page, async () => (await toggle.getAttribute('aria-expanded')) === 'true', 5000));
  ok('open: its Team row shows', await until(page, async () => (await teamRow.count()) === 1, 15000));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'acik-1440-dark.png') });

  await toggle.click();
  ok('folded: the project is collapsed', await until(page, async () => (await toggle.getAttribute('aria-expanded')) === 'false', 5000));
  ok('folded: its Team row is gone too', await until(page, async () => (await teamRow.count()) === 0, 5000), String(await teamRow.count()));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'kapali-1440-dark.png') });

  await toggle.click();
  ok('reopened: the Team row is back', await until(page, async () => (await teamRow.count()) === 1, 10000));

  console.log('── B the drawer width');
  const drawer = page.getByTestId('chat-drawer');
  const width = async () => Math.round((await drawer.boundingBox())?.width ?? 0);
  ok('B nobody sized it: it opens at 200 (the narrowest)', (await width()) === 200, String(await width()));
  await page.screenshot({ path: join(OUT, 'b-dar-varsayilan-1440-dark.png') });
  const handle = page.locator('.ns-dr-handle');
  const hb = await handle.boundingBox();
  if (hb) {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
    await page.mouse.down();
    await page.mouse.move(hb.x + 120, hb.y + 200, { steps: 8 });
    await page.mouse.up();
  }
  ok('B the owner drags it wider', await until(page, async () => (await width()) > 300, 5000), String(await width()));
  const dragged = await width();
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  ok('B his width is kept over a reload', await until(page, async () => (await width()) === dragged, 10000), `${await width()} vs ${dragged}`);
  await page.screenshot({ path: join(OUT, 'b-surüklenen-genislik-korunur-1440-dark.png') });

  console.log('── A search');
  const projects = page.locator('[data-drawer-project]');
  ok('A three projects listed', await until(page, async () => (await projects.count()) === 3, 10000), String(await projects.count()));
  await page.getByTestId('drawer-project-search-btn').click();
  const field = page.getByTestId('drawer-project-search');
  ok('A the field opens in the header, focused', await until(page, async () => (await field.count()) === 1 && await field.evaluate((el) => el === document.activeElement), 3000));
  await field.fill('TİLKİ');
  ok('A "TİLKİ" finds tilki-ogretmen only', await until(page, async () => (await projects.count()) === 1 && (await projects.first().getAttribute('data-drawer-project')) === EMPTY, 3000));
  await field.fill('cicek');
  ok('A "cicek" finds çiçek-atölyesi', await until(page, async () => (await projects.count()) === 1 && (await projects.first().getAttribute('data-drawer-project')) === OTHER, 3000));
  await page.screenshot({ path: join(OUT, 'a-arama-1440-dark.png') });
  await field.fill('zzz');
  ok('A no match says so', await until(page, async () => (await page.getByTestId('drawer-project-nomatch').count()) === 1 && (await projects.count()) === 0, 3000));
  await field.press('Escape');
  ok('A Esc closes it and restores the list', await until(page, async () => (await field.count()) === 0 && (await projects.count()) === 3, 3000));

  console.log('── C an empty Team row');
  const emptyProj = page.locator(`[data-drawer-project="${EMPTY}"]`).first();
  const emptyToggle = emptyProj.locator('[data-testid="drawer-project-row"]').first();
  if ((await emptyToggle.getAttribute('aria-expanded')) !== 'true') await emptyToggle.click();
  const emptyRow = emptyProj.locator('[data-testid="drawer-team-row"]');
  ok('C the memberless project shows its Team row', await until(page, async () => (await emptyRow.count()) === 1, 15000));
  ok('C it reads "Set your team", no faces', (await emptyRow.getAttribute('data-empty')) === 'true' && (await emptyRow.innerText()).trim() === 'Set your team'
    && (await emptyRow.locator('.ns-team-faces, .ns-team-chev').count()) === 0);
  ok('C the member project still shows faces', (await teamRow.first().getAttribute('data-empty')) === null);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'c-uyesiz-proje-team-1440-dark.png') });
  await emptyRow.click();
  const modal = page.locator('[data-testid="manage-members-modal"]:visible');
  ok('C a click opens Manage members', await until(page, async () => (await modal.count()) === 1, 20000));
  ok('C with its New member button', await until(page, async () => (await modal.getByTestId('manage-members-new').count()) === 1, 5000));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'c-tiklayinca-uyeleri-yonet-1440-dark.png') });
  ok('no console errors', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('no failed requests', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  await browser.close();
}

async function main() {
  let srv = null;
  try {
    setup();
    const port = await freePort();
    srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
    await run(`http://127.0.0.1:${port}`);
  } catch (e) { ok('ran to the end', false, e?.stack ?? e); }
  finally { srv?.kill(); }
  console.log(`\nscreenshots: ${OUT}`);
  process.exit(summary() ? 0 : 1);
}

main();
