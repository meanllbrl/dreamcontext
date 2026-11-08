#!/usr/bin/env node
/**
 * The open AI Team member is the selected row in the left menu (owner 2026-11-04), observed:
 * the member's row has the selected wash and tick (aria-current), the Team row itself does not,
 * folded or open, light and dark.
 *
 *   npm run build && node scripts/verify/uye-secili.mjs [outDir]
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, openMember, reporter, startServer, superStandin, until } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-uye-secili-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'uye-secili'));
const NAMES = [['front-desk', 'Front Desk'], ['ozel-hat', 'Özel Hat izleme'], ['hoca-masasi', 'Hoca masası'], ['pacioli', 'Pacioli'], ['doctor', 'Doctor']];
const env = () => cleanEnv(HOME);
const dc = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: PROJ, env: env(), encoding: 'utf-8' });
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
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  for (const [slug, title] of NAMES) {
    const c = dc('agents', 'create', slug, '--title', title, '--prompt', `${title} işini yapar.`);
    if (c.status !== 0) throw new Error(`agent ${slug}: ${c.stderr || c.stdout}`);
  }
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const key = `dc.drawer.team.${VAULT}`;
  const row = page.locator('[data-testid="drawer-team-row"]:visible').first();
  for (const open of [true, false]) {
    await page.evaluate(([k, o]) => { if (o) localStorage.setItem(k, '1'); else localStorage.removeItem(k); }, [key, open]).catch(() => {});
    await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.evaluate(([k, o]) => { if (o) localStorage.setItem(k, '1'); else localStorage.removeItem(k); }, [key, open]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    ok(`${open ? 'open' : 'folded'}: the Team row is there`, await until(page, async () => (await row.count()) === 1, 20000));
    ok(`${open ? 'open' : 'folded'}: nothing selected before a member opens`, (await page.locator('.ns-team-mrow.is-sel').count()) === 0);
    await openMember(page, 'pacioli');
    ok(`${open ? 'open' : 'folded'}: Pacioli is the selected row`, await until(page, async () => (await page.locator('.ns-team-mrow.is-sel[data-slug="pacioli"]').count()) === 1, 15000));
    ok(`${open ? 'open' : 'folded'}: exactly one selected member`, (await page.locator('.ns-team-mrow.is-sel').count()) === 1);
    ok(`${open ? 'open' : 'folded'}: aria-current on it`, (await page.locator('.ns-team-mrow.is-sel').first().getAttribute('aria-current')) === 'page');
    ok(`${open ? 'open' : 'folded'}: the Team row is NOT selected`, !(await row.getAttribute('class')).includes('is-sel'));
    for (const theme of ['light', 'dark']) {
      await applyTheme(page, theme);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT, `after-${open ? 'acik' : 'kapali'}-${theme}.png`) });
    }
    await applyTheme(page, 'light');
  }
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
