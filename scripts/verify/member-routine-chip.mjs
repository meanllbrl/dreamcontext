#!/usr/bin/env node
/**
 * "+ New routine" on a member's Super stage hands the job to Claude (owner 2026-11-05: "on this
 * screen it should not open a form; the card should land in the chat box as a reference, the
 * cursor after it, I say what I want and Super sets the routine up"). Observed the owner's way:
 *
 *   npm run build && node scripts/verify/member-routine-chip.mjs [outDir] [prefix]
 *
 * Real dashboard server from dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), a real member with its
 * own Super running (the scripted stand-in), main handed over. On the member's stage a real mouse
 * presses "+ New routine" on the floating Routines card. Asserts: no dialog opens; the member's
 * composer holds ONE card chip titled "New routine"; the caret sits after it with focus in the
 * box; the owner's words typed there go out as `@card:<routines card> “New routine” <words>` to
 * the MEMBER's Super (never main's); the member's briefing carries the new-routine rule; the
 * stand-in, doing what that rule says, creates the routine and it shows on the card. With the
 * member turned off (no Super running) the same button still opens the form.
 * Console errors and failed requests are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { cleanEnv, freePort, openMember, pageFetch, readNd, reporter, stage, stageComposer, startServer, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-member-routine-chip-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'member-routine-chip'));
const PREFIX = process.argv[3] || 'shot';
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SLUG = 'desk-helper';

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: "if (text.startsWith('[super handover]')) return 'arranged'; return 'ok';",
  // The member's Super doing what its briefing's new-routine line says (the real one is Claude).
  member: `
    report({ kind: 'brief', slug, rule: brief.includes('titled “New routine”') && brief.includes('automations create <routine-slug> --agent ' + slug) });
    if (/@card:member-[0-9a-f]{12} “New routine”/.test(text)) {
      report({ kind: 'routine-create', step: cli('automations', 'create', 'front-desk-noon', '--title', 'Front desk noon', '--agent', slug, '--job', 'Noon round of the front desk.', '--days', 'mon-fri', '--at', '12:00') });
      return 'routine set up';
    }
    return 'ok';
  `,
});

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const { ok, summary } = reporter();
const reports = () => readNd(REPORTS);
/** The card chips in a composer's value (the composer's chip encoding, as card-chip.mjs reads it). */
const cardChipsIn = (v) => [...v.matchAll(/⁨ ? ⁠? ⁠? ([^⁩]*?) ?[⁡-⁤]+⁩/g)].map((m) => m[1].replace(/ /g, ' '));

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

/** Press a locator with a real mouse at its centre; false when something else is on top. */
async function press(page, loc) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const box = await loc.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  const hit = await loc.evaluate((el, [px, py]) => { const top = document.elementFromPoint(px, py); return !!top && el.contains(top); }, [x, y]);
  await page.mouse.click(x, y);
  return hit;
}

const routinesCard = (page, st) => st.locator('[data-testid="super-container"]').filter({ has: page.locator('[data-member-card="routines"]') }).first();
const dialogOpen = (page) => page.locator('[data-member-card-layer] > *').first().isVisible().catch(() => false);

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk', { expected: [/status of 409/, /^409 POST \/api\/super\/member\b/] });
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const r0 = await pageFetch(page, VAULT, 'POST', '/automations', { title: 'Front desk evening', agent: SLUG, job: 'Evening round.', mode: 'sched', days: 'daily', at: '18:30' });
  ok('setup: one routine', r0.status === 200, JSON.stringify(r0).slice(0, 300));
  ok('setup: main Super handed over', await handOver(page, base));

  // ── 1. The member is on: its Super runs, its stage has a composer.
  await openMember(page, SLUG);
  const st = stage(page, `m:${SLUG}`);
  ok('the member\'s stage opens with its composer', await until(page, async () => (await stageComposer(page, `m:${SLUG}`)).isVisible().catch(() => false), 30000));
  ok('its Super runs', await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'member'), 30000));
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  const card = routinesCard(page, st);
  ok('the Routines card is on the stage', await until(page, async () => (await card.locator('[data-routine]').count()) === 1, 15000));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${PREFIX}-1-stage.png`) });

  const input = await stageComposer(page, `m:${SLUG}`);
  ok('"+ New routine" is what the pointer meets', await press(page, card.getByTestId('member-routine-new')));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `${PREFIX}-2-new-routine.png`) });
  ok('no form opens on the stage', !(await dialogOpen(page)));
  if (await dialogOpen(page)) for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  const v = await input.inputValue();
  const chips = cardChipsIn(v);
  ok('the member\'s composer holds one "New routine" card chip', chips.length === 1 && /New routine/.test(chips[0]) && !v.includes('@card:'), JSON.stringify(v));
  const caret = await input.evaluate((el) => ({ focused: document.activeElement === el, at: el.selectionStart, len: el.value.length }));
  ok('the caret is in the box, after the chip', caret.focused && caret.at === caret.len && caret.len > 0, JSON.stringify(caret));

  await page.keyboard.type('weekdays at noon, a front desk round', { delay: 5 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${PREFIX}-3-typed.png`) });
  await page.keyboard.press('Enter');
  const sent = () => reports().find((r) => r.kind === 'member-turn' && r.text.includes('“New routine”'));
  ok('the member\'s Super gets the Routines card chip “New routine” and his words', await until(page, async () => !!sent(), 30000),
    JSON.stringify(reports().filter((r) => /turn/.test(r.kind)).map((r) => r.text.slice(0, 200))));
  ok('…as one message: the chip, then what he typed', /@card:member-[0-9a-f]{12} “New routine” weekdays at noon, a front desk round/.test(sent()?.text ?? ''), sent()?.text?.slice(0, 300));
  ok('main\'s Super never got it', !reports().some((r) => r.kind === 'super-turn' && r.text.includes('“New routine”')));
  ok('its briefing carries the new-routine rule', await until(page, async () => reports().some((r) => r.kind === 'brief' && r.rule), 20000), JSON.stringify(reports().filter((r) => r.kind === 'brief')));
  const made = () => reports().find((r) => r.kind === 'routine-create');
  ok('the rule\'s command creates the member\'s routine', await until(page, async () => made()?.step?.status === 0, 30000), JSON.stringify(made()?.step ?? null).slice(0, 400));
  ok('the new routine shows on the Routines card', await until(page, async () => (await card.locator('[data-routine]').filter({ hasText: 'Front desk noon' }).count()) === 1, 20000));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${PREFIX}-4-made.png`) });

  // ── 2. The member off: no Super runs on its stage, so the button keeps today's form.
  const off = await pageFetch(page, VAULT, 'POST', `/agents/${SLUG}/enabled`, { enabled: false });
  ok('setup: member turned off', off.status === 200, JSON.stringify(off).slice(0, 200));
  await toMainStage(page);
  await page.waitForTimeout(800);
  await openMember(page, SLUG);
  const card2 = routinesCard(page, stage(page, `m:${SLUG}`));
  await until(page, async () => (await card2.getByTestId('member-routine-new').count()) === 1, 15000);
  // Its Super has stopped: the stage has no composer, or a closed one.
  await until(page, async () => !(await (await stageComposer(page, `m:${SLUG}`)).isVisible().catch(() => false)), 15000);
  await page.waitForTimeout(1200);
  await press(page, card2.getByTestId('member-routine-new'));
  ok('member off: "+ New routine" opens the form as before', await until(page, async () => dialogOpen(page), 5000));
  await page.screenshot({ path: join(OUT, `${PREFIX}-5-off-form.png`) });

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
