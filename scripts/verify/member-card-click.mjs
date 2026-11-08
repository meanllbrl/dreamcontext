#!/usr/bin/env node
/**
 * A member's floating stage cards are live (owner 2026-11-05: "I click a routine on the Super
 * stage's Routines card and nothing happens, enlarged too"). Every floating card body is
 * `pointer-events: none` (the card is one grab handle); the agenda had its carve-out, the
 * member's cards (Rutinler, Talimatlar, Üye) did not, so no click reached a row, a switch or
 * "+ New routine". Measured the way the owner does it: a real mouse at the row's centre.
 *
 *   npm run build && node scripts/verify/member-card-click.mjs [outDir] [prefix]
 *
 * Real dashboard server from dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), a real member and two
 * real routines, main's Super handed over to the scripted stand-in. Asserts, on the FLOATING
 * Routines card (never side by side): the row is the element under the pointer; a click opens it
 * (its editor and "Run now"); a second row's switch flips only the switch; "+ New routine" opens
 * the dialog; the card head still drags the card; the Talimatlar card's Edit is reachable.
 * Console errors and failed requests are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { cleanEnv, freePort, openMember, pageFetch, readNd, reporter, stage, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-member-card-click-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'member-card-click'));
const PREFIX = process.argv[3] || 'shot';
const REPORTS = join(SCRATCH, 'reports.ndjson');

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
  writeFileSync(bin, superStandin({ reports: REPORTS, cli: CLI }));
  chmodSync(bin, 0o755);
  const steps = [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })],
    ['agent', dc('agents', 'create', 'desk-helper', '--title', 'Desk Helper', '--prompt', 'Keeps the front desk tidy and reports twice a day.')],
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
  await until(page, async () => readNd(REPORTS).some((r) => r.kind === 'spawn'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 60000);
}

/** The element a real pointer meets at a locator's centre is inside it (pointer-events honoured). */
async function hitAt(page, loc) {
  const box = await loc.boundingBox();
  if (!box) return { hit: false, why: 'no box' };
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  const hit = await loc.evaluate((el, [px, py]) => {
    const top = document.elementFromPoint(px, py);
    return { hit: !!top && el.contains(top), top: top ? `${top.tagName.toLowerCase()}.${String(top.className).split(' ')[0]}` : 'none' };
  }, [x, y]);
  return { ...hit, x, y };
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk', { expected: [/status of 409/, /^409 POST \/api\/super\/member\b/] });
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  for (const [title, at] of [['Front desk evening', '18:30'], ['Front desk morning', '09:30']]) {
    const r = await pageFetch(page, VAULT, 'POST', '/automations', { title, agent: 'desk-helper', job: `${title} round.`, mode: 'sched', days: 'daily', at });
    ok(`setup: routine "${title}"`, r.status === 200, JSON.stringify(r).slice(0, 300));
  }
  const off = await pageFetch(page, VAULT, 'POST', '/agents/desk-helper/enabled', { enabled: false });
  ok('setup: member off (its stage draws without a running Super)', off.status === 200, JSON.stringify(off).slice(0, 200));
  ok('setup: main Super handed over', await handOver(page, base));
  await openMember(page, 'desk-helper');
  const st = stage(page, 'm:desk-helper');
  ok('the member\'s stage opens', await until(page, async () => (await st.locator('[data-kind="member"]').count()) >= 2, 20000));
  // Close the drawer's overlay, if any, so the stage is what the pointer meets.
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }

  const frame = st.locator('[data-testid="super-container"][data-where="float"]').filter({ has: page.locator('[data-member-card="routines"]') }).first();
  ok('the Routines card floats on the stage', await until(page, async () => (await frame.count()) === 1, 10000));
  const rows = frame.locator('[data-routine]');
  ok('it lists both routines', await until(page, async () => (await rows.count()) === 2, 10000));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `${PREFIX}-1-stage.png`) });

  const evening = rows.filter({ hasText: 'Front desk evening' }).first();
  const id = evening.locator('.aiteam-routine-id');
  const h = await hitAt(page, id);
  ok('the routine row is what the pointer meets', h.hit, `top element at the row's centre: ${h.top}`);
  if (h.x !== undefined) await page.mouse.click(h.x, h.y);
  ok('a click on the row opens it', await until(page, async () => (await id.getAttribute('aria-expanded')) === 'true', 4000));
  ok('…with its editor (Run now and the name field)', await until(page, async () => (await evening.locator('.aiteam-routine-actions').isVisible().catch(() => false)) && (await evening.locator('input.agent-input').count()) >= 1, 6000));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${PREFIX}-2-row-clicked.png`) });
  // A second click folds it again (the AI Team page's own toggle), so the next row is in view.
  const h2 = await hitAt(page, id);
  if (h2.x !== undefined) await page.mouse.click(h2.x, h2.y);
  ok('a second click folds it', await until(page, async () => (await id.getAttribute('aria-expanded')) === 'false', 4000));

  const morning = rows.filter({ hasText: 'Front desk morning' }).first();
  const sw = morning.getByRole('switch').first();
  const enabledOf = async () => ((await pageFetch(page, VAULT, 'GET', '/automations')).json?.automations ?? []).find((a) => a.title === 'Front desk morning')?.enabled;
  const was = await enabledOf();
  const hs = await hitAt(page, sw);
  ok('the switch is what the pointer meets', hs.hit, hs.top);
  if (hs.x !== undefined) await page.mouse.click(hs.x, hs.y);
  ok('the switch flips the routine', await until(page, async () => (await enabledOf()) === !was, 8000));
  ok('…and does not open its row', (await morning.locator('.aiteam-routine-id').getAttribute('aria-expanded')) === 'false');

  const add = frame.getByTestId('member-routine-new');
  await add.scrollIntoViewIfNeeded().catch(() => {});
  const ha = await hitAt(page, add);
  ok('"+ New routine" is what the pointer meets', ha.hit, ha.top);
  if (ha.x !== undefined) await page.mouse.click(ha.x, ha.y);
  const dialog = page.locator('[data-member-card-layer] [role="dialog"], [data-member-card-layer] .modal, [data-member-card-layer] > *').first();
  ok('"+ New routine" opens the new-routine dialog', await until(page, async () => dialog.isVisible().catch(() => false), 5000));
  await page.screenshot({ path: join(OUT, `${PREFIX}-3-new-routine.png`) });
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  if (await dialog.isVisible().catch(() => false)) await page.locator('[data-member-card-layer]').getByRole('button', { name: /Cancel|Vazgeç|Close|Kapat/ }).first().click().catch(() => {});

  // The card is still a grab handle by its head: a drag there moves it.
  const head = frame.locator('.super-card-head').first();
  const hb = await head.boundingBox();
  const before = await frame.boundingBox();
  if (hb) {
    await page.mouse.move(hb.x + 30, hb.y + hb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(hb.x + 30 - i * 12, hb.y + hb.height / 2 + i * 6); await page.waitForTimeout(16); }
    await page.mouse.up();
  }
  await page.waitForTimeout(700);
  const after = await frame.boundingBox();
  ok('the card head still drags the card', !!before && !!after && (Math.abs(after.x - before.x) > 5 || Math.abs(after.y - before.y) > 5 || (await frame.getAttribute('data-where')) !== 'float'),
    JSON.stringify({ before, after }));

  const instr = st.locator('[data-testid="super-container"][data-where="float"]').filter({ has: page.locator('[data-member-card="instructions"]') }).first();
  const edit = instr.getByTestId('member-instructions-edit');
  if (await edit.isVisible().catch(() => false)) {
    const he = await hitAt(page, edit);
    ok('Talimatlar\'s Edit is what the pointer meets (same root cause)', he.hit, he.top);
  } else console.log('   (the Instructions card is not a full floating card here: its Edit is not on the stage)');

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
