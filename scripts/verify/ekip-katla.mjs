#!/usr/bin/env node
/**
 * A collapsed project hides its Team row too (owner 2026-11-03): at 1440 dark, the project open
 * shows its Team row at the bottom of its list; folded, the Team row is gone with the rest.
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
