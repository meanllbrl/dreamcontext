#!/usr/bin/env node
/**
 * A member's routine run shows on that member's page, live while it runs and its result after
 * (owner 2026-11-08: "Deneme Rutin's routine ran today, and I just ran it by hand. But it showed on
 * this page neither live nor after it finished.").
 *
 *   npm run build && node scripts/verify/member-run-feed.mjs [outDir]
 *
 * Real dashboard server from dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), main Super handed over, a
 * real member (`agents create`) with TWO approved routines, its own Super running (the scripted
 * stand-in). The owner says something to the member first, so its conversation has a row; then he
 * runs one routine by hand (POST /api/automations/:slug/run, what "Run now" calls). The stand-in's
 * headless run holds ~14 s, then answers. Asserts:
 *   (a) while it runs, the member's stage shows the run's boundary ("… ran · hh:mm · running") and
 *       the Working line, AFTER the owner's message (a live run is the newest thing on the page);
 *   (b) when it ends, the same run reads its duration, no "running", and the run's answer is drawn;
 *   (c) the second routine's earlier run (run before the conversation) is on the page too, above
 *       the owner's message; main's stage draws none of it.
 * Console errors and failed requests are a FAIL. Screenshots: <outDir>/{1-running,2-done}-1440.png
 * and the same at 390 where the phone layout allows.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { cleanEnv, freePort, openMember, pageFetch, readNd, reporter, stage, stageComposer, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-member-run-feed-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'member-run-feed'));
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SLUG = 'desk-helper';
const RUN = 'front-desk-news';
const OLD = 'front-desk-weekly';
const ANSWER = 'Desk is tidy: three parcels filed, one return logged.';

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: "if (text.startsWith('[super handover]')) return 'arranged'; return 'ok';",
  member: "return 'Hello, I keep the desk.';",
  // The routine's headless run: long enough to be seen running, then its answer.
  headless: `
    if (prompt.includes('Weekly desk summary')) return 'Weekly: all quiet at the desk.';
    await sleep(14000);
    return ${JSON.stringify(ANSWER)};
  `,
});

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8', timeout: 120000 });
const { ok, summary } = reporter();
const reports = () => readNd(REPORTS);

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
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const steps = [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })],
    ['agent', dc('agents', 'create', SLUG, '--title', 'Desk Helper', '--prompt', 'Keeps the front desk tidy and reports twice a day.')],
    ['routine', dc('automations', 'create', RUN, '--title', 'Front desk news', '--agent', SLUG, '--job', 'Front desk news round.', '--days', 'daily', '--at', '03:00')],
    ['approve', dc('automations', 'approve', RUN, '-y')],
    ['routine 2', dc('automations', 'create', OLD, '--title', 'Front desk weekly', '--agent', SLUG, '--job', 'Weekly desk summary.', '--days', 'mon', '--at', '03:30')],
    ['approve 2', dc('automations', 'approve', OLD, '-y')],
    // The second routine ran before the owner talked to the member: its run is history.
    ['old run', dc('automations', 'run', OLD, '--force')],
  ];
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

async function handOver(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 60000);
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk', { expected: [/status of 409/, /^409 POST \/api\/super\/member\b/] });
  ok('setup: main Super handed over', await handOver(page, base));

  await openMember(page, SLUG);
  const sid = `m:${SLUG}`;
  const st = stage(page, sid);
  const input = await stageComposer(page, sid);
  ok('the member\'s stage opens with its composer', await until(page, async () => input.isVisible().catch(() => false), 30000));
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await input.click();
  await input.fill('Good morning desk');
  await page.keyboard.press('Enter');
  ok('the member answers in its conversation', await until(page, async () => (await st.getByText('Hello, I keep the desk.').count()) > 0, 30000));

  ok('(c) the earlier routine\'s run is on the member\'s page', await until(page, async () => (await st.locator(`[data-feed-boundary^="${OLD}::"]`).count()) === 1, 30000));

  // ── Run now, by hand.
  const r = await pageFetch(page, VAULT, 'POST', `/automations/${RUN}/run`, {});
  ok('run now accepted', r.status === 200, JSON.stringify(r).slice(0, 300));
  const runB = st.locator(`[data-feed-boundary^="${RUN}::"]`);
  ok('(a) the run shows while it runs: its boundary says running', await until(page, async () => /running/.test((await runB.first().textContent().catch(() => '')) ?? ''), 30000),
    await runB.first().textContent().catch(() => 'none'));
  ok('(a) …with the Working line under it', (await st.locator(`[data-feed-working^="${RUN}::"]`).count()) === 1);
  const pos = await st.evaluate((root, [o, rn]) => {
    const all = [...root.querySelectorAll('*')];
    const msg = [...root.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent?.trim() === 'Good morning desk');
    const ob = root.querySelector(`[data-feed-boundary^="${o}::"]`);
    const lb = root.querySelector(`[data-feed-working^="${rn}::"]`);
    return { msg: msg ? all.indexOf(msg) : -1, old: ob ? all.indexOf(ob) : -1, live: lb ? all.indexOf(lb) : -1 };
  }, [OLD, RUN]);
  ok('(a) the live run sits after the owner\'s message', pos.msg >= 0 && pos.live > pos.msg, JSON.stringify(pos));
  ok('(c) the earlier run sits above the owner\'s message', pos.old >= 0 && pos.old < pos.msg, JSON.stringify(pos));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, '1-running-1440.png') });

  ok('(b) when it ends, the boundary drops "running" and reads a duration', await until(page, async () => {
    const tx = (await runB.first().textContent().catch(() => '')) ?? '';
    return !/running/.test(tx) && /\d+ (s|min)/.test(tx);
  }, 60000), await runB.first().textContent().catch(() => 'none'));
  ok('(b) the run\'s answer is drawn on the member\'s page', await until(page, async () => (await st.getByText(ANSWER).count()) > 0, 20000));
  ok('(b) no Working line is left', (await st.locator(`[data-feed-working^="${RUN}::"]`).count()) === 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, '2-done-1440.png') });

  // Owner 2026-11-08: no underlined "Full report"; the run's document is a tile that opens in the
  // chat's side file panel, never inline.
  const tile = st.locator(`[data-run-foot^="${RUN}::"] [data-run-doc]`);
  ok('(d) no "Full report" link anywhere on the page', (await st.getByText('Full report').count()) === 0 && (await st.locator('[data-feed-report]').count()) === 0);
  ok('(d) the run\'s document is a tile with its opening lines', await until(page, async () => (await tile.count()) === 1 && /Desk is tidy/.test((await tile.innerText()) ?? ''), 20000), await tile.first().innerText().catch(() => 'none'));
  ok('(d) the run with no steps or document has nothing extra', (await st.locator(`[data-run-foot^="${OLD}::"] [data-run-doc]`).count()) <= 1);
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: join(OUT, '4-belge-sonra-1440.png') });
  await tile.locator('button').first().click();
  ok('(d) clicking the tile opens the document in the side file panel', await until(page, async () => (await page.locator('.chat-slideover-head:visible').count()) > 0, 10000));
  ok('(d) …and nothing expanded inline', (await st.locator('[data-testid="run-report"]').count()) === 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '4-belge-panel-1440.png') });
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  await runB.first().scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: join(OUT, '3-done-390.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

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
