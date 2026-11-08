#!/usr/bin/env node
/**
 * Every AI Team member's stage has its OWN agenda (plan-r10 AC1, AC18, section 1c): its notepad
 * lines (Waiting / Now / Done) and "Görevleri", the tasks it does or reviews, on a card on its
 * stage exactly like main's; its own Super keeps it with `super note`; main's agenda is untouched.
 *
 *   npm run build && node scripts/verify/member-agenda.mjs           (SHOTS=<dir> copies the shots)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), real Chromium, members made
 * with `dreamcontext agents create`, the real CLI run from inside each Super's own process, and a
 * scripted stand-in `claude` (lib/super-scratch.mjs, no tokens spent).
 *
 * Fixture (fictional, pattern synthetic-fixtures-for-published-artifacts): project
 * acme-storefront; Mira (the owner opens her stage; doer of the task), Gantt (reviewer of it),
 * Pera (opened only by main's `super team ask`).
 *
 *   (a) Mira's stage, opened by the owner: her record holds an agenda card, floating, and the
 *       stage draws it (not in Others).
 *   (b) her briefing tells her the agenda is her notepad and names `super note`.
 *   (c) her `super note add now` lands in HER record and on her stage's agenda; never in main's.
 *   (d) "Görevleri" lists the task, Mira as doer; Gantt's lists it as reviewer.
 *   (e) Pera, born by main's `team ask`: her record holds the agenda, her note is on her stage.
 *   (f) the owner's minimise of Mira's agenda stands across her next write (never re-shown).
 *   (g) main's agenda card is still there, holding main's line only.
 *   Console errors and failed requests are recorded: any is a FAIL.
 *
 * Shots: tmp/verify/member-agenda/<nn>-<what>-<width>.png. Exit 1 on any FAIL.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import {
  cleanEnv, freePort, openMember, pageFetch, readJson, readNd, reporter, sayOnStage, stage,
  stageComposer, startServer, superStandin, toMainStage, until, watchPage,
} from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-member-agenda-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify', 'member-agenda');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SUPER_DIR = join(PROJ, '_dream_context', 'state', '.super');
const TASK = 'write-the-spring-campaign';

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) {
      report({ kind: 'main-note', step: cli('super', 'note', 'add', 'now', 'Ana plan MAINLINE') });
      return 'arranged';
    }
    if (text.includes('GO-PERA')) {
      report({ kind: 'team', step: cli('super', 'team', 'ask', 'pera', 'Rakip fiyatlarını çıkar.', '--brief', 'Rakip fiyatları') });
      return 'Pera\\'ya verdim.';
    }
    return 'ok';`,
  member: `
    if (!globalThis.__told) { globalThis.__told = true; report({ kind: 'brief', slug, agenda: brief.includes('## The agenda (your notepad)'), note: brief.includes('super note add now') }); }
    if (/- item=(\\S+) event=request/.test(text)) {
      report({ kind: 'member-note', slug, step: cli('super', 'note', 'add', 'now', 'Pera notu PERALINE') });
      return 'Bakıyorum.';
    }
    const m = /GO-NOTE (\\S+)/.exec(text);
    if (m) { report({ kind: 'member-note', slug, step: cli('super', 'note', 'add', 'now', 'Mira notu ' + m[1]) }); return 'Not aldım.'; }
    return 'ok';`,
});

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const reports = () => readNd(REPORTS);
const record = (id) => readJson(id === 'main' ? join(PROJ, '_dream_context', 'state', '.super-agent.json') : join(SUPER_DIR, 'members', `${id}.json`), null);
const agendaOf = (rec) => rec?.containers?.find((c) => c.kind === 'agenda') ?? null;
const padText = (rec) => (rec?.pad ?? []).map((p) => p.text).join(' | ');
const { result, ok, summary } = reporter();

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const steps = [['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })]];
  for (const [slug, title, prompt] of [['mira', 'Mira', 'Pazarlama kampanyalarını yazar.'], ['gantt', 'Gantt', 'Teslimleri gözden geçirir.'], ['pera', 'Pera', 'Rakip analizini yapar.']]) {
    steps.push([`agent ${slug}`, dc('agents', 'create', slug, '--title', title, '--prompt', prompt)]);
  }
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  writeFileSync(join(PROJ, '_dream_context', 'state', `${TASK}.md`), [
    '---', 'id: task_springcampaign', 'name: Write the spring campaign', 'description: Write the spring campaign',
    'priority: high', 'urgency: medium', 'status: todo', "created_at: '2026-11-01'", "updated_at: '2026-11-01'",
    'tags: []', 'parent_task: null', 'related_feature: null', '---', '', '## Why', '', 'Spring needs a campaign.', '',
    '## Changelog', '', '',
  ].join('\n'));
  const assign = dc('tasks', 'assign-agent', TASK, 'mira', '--reviewer', 'gantt', '--at', new Date(Date.now() + 86_400_000).toISOString());
  if (assign.status !== 0) throw new Error(`assign-agent failed: ${assign.stderr || assign.stdout}`);
}

const shot = async (page, nn, what, widths = [[1920, 1080], [1440, 900]]) => {
  for (const [w, h] of widths) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `${nn}-${what}-${w}.png`) }).catch(() => {});
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(500);
};

/** The agenda card a stage draws, floating (not the Others pill). */
const agendaCard = (page, superId) => stage(page, superId).locator('[data-testid="super-container"][data-kind="agenda"]');

async function handOver(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => reports().some((r) => r.kind === 'handover' || r.kind === 'main-note'), 90000);
}

async function openStage(page, slug) {
  await openMember(page, slug);
  await until(page, async () => (await stage(page, `m:${slug}`).count()) > 0, 20000);
  return until(page, async () => (await stageComposer(page, `m:${slug}`)).isVisible(), 20000);
}

async function run(base) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk');

  console.log('── setup: main handed over');
  ok('main Super handed over and wrote its own line', await handOver(page, base));
  await until(page, async () => /MAINLINE/.test(padText(record('main'))), 20000);

  console.log('── (a) Mira\'s stage, opened by the owner');
  ok('(a) Mira\'s stage opens', await openStage(page, 'mira'));
  const miraAgenda = agendaOf(record('mira'));
  ok('(a) her record holds an agenda card, floating', miraAgenda?.place === 'float' && !miraAgenda.min, JSON.stringify(record('mira')?.containers ?? null).slice(0, 500));
  ok('(a) her stage draws the agenda card', await until(page, async () => (await agendaCard(page, 'm:mira').count()) === 1, 15000));
  await shot(page, '01', 'mira-stage-opened');

  console.log('── (b) her briefing');
  await sayOnStage(page, 'm:mira', 'GO-NOTE MIRALINE');
  ok('(b) her briefing names the agenda and `super note`', await until(page, async () => reports().some((r) => r.kind === 'brief' && r.slug === 'mira' && r.agenda && r.note), 45000),
    JSON.stringify(reports().filter((r) => r.kind === 'brief')));

  console.log('── (c) her note lands in her record and on her stage');
  ok('(c) her `super note add now` succeeds', await until(page, async () => reports().some((r) => r.kind === 'member-note' && r.slug === 'mira' && r.step?.status === 0), 30000),
    JSON.stringify(reports().filter((r) => r.kind === 'member-note')).slice(0, 500));
  ok('(c) the line is in HER record', /MIRALINE/.test(padText(record('mira'))), padText(record('mira')));
  ok('(c) never in main\'s', !/MIRALINE/.test(padText(record('main'))), padText(record('main')));
  ok('(c) her stage\'s agenda shows it', await until(page, async () => /MIRALINE/.test(await agendaCard(page, 'm:mira').innerText().catch(() => '')), 15000),
    await agendaCard(page, 'm:mira').innerText().catch((e) => String(e)));

  console.log('── (d) Görevleri');
  const tasksBox = agendaCard(page, 'm:mira').getByTestId('member-agenda-tasks');
  ok('(d) her agenda has Görevleri', await until(page, async () => (await tasksBox.count()) === 1, 15000));
  const row = tasksBox.locator(`[data-testid="member-agenda-task"][data-task="${TASK}"]`);
  ok('(d) …listing the task, Mira as doer', await until(page, async () => (await row.getAttribute('data-role').catch(() => null)) === 'doer', 15000));
  await shot(page, '02', 'mira-agenda-note-and-tasks');
  ok('(d) Gantt\'s stage opens', await openStage(page, 'gantt'));
  const ganttRow = agendaCard(page, 'm:gantt').locator(`[data-testid="member-agenda-task"][data-task="${TASK}"]`);
  ok('(d) Gantt\'s agenda lists it with Gantt as reviewer', await until(page, async () => (await ganttRow.getAttribute('data-role').catch(() => null)) === 'reviewer', 20000));
  await shot(page, '03', 'gantt-agenda-reviewer', [[1920, 1080]]);

  console.log('── (e) Pera, opened by main\'s team ask');
  await toMainStage(page);
  await sayOnStage(page, 'main', 'GO-PERA');
  ok('(e) main\'s `super team ask pera` makes a request', await until(page, async () => reports().some((r) => r.kind === 'team' && r.step?.status === 0), 30000),
    JSON.stringify(reports().filter((r) => r.kind === 'team')).slice(0, 500));
  ok('(e) Pera\'s note lands in her record', await until(page, async () => /PERALINE/.test(padText(record('pera'))), 60000), padText(record('pera')));
  ok('(e) her record holds an agenda card', agendaOf(record('pera'))?.place === 'float', JSON.stringify(record('pera')?.containers ?? null).slice(0, 500));
  ok('(e) Pera\'s stage opens', await openStage(page, 'pera'));
  ok('(e) her stage\'s agenda shows her line', await until(page, async () => /PERALINE/.test(await agendaCard(page, 'm:pera').innerText().catch(() => '')), 15000));
  await shot(page, '04', 'pera-agenda-from-team-ask', [[1920, 1080]]);

  console.log('── (f) the owner\'s minimise stands');
  const min = await pageFetch(page, VAULT, 'POST', '/super/layout?superId=m%3Amira', { agenda: 'min' });
  ok('(f) the owner minimises Mira\'s agenda', min.status === 200 && agendaOf(record('mira'))?.min === true, JSON.stringify({ status: min.status, card: agendaOf(record('mira')) }));
  await openStage(page, 'mira');
  const before = reports().filter((r) => r.kind === 'member-note' && r.slug === 'mira').length;
  await sayOnStage(page, 'm:mira', 'GO-NOTE MIRATWO');
  await until(page, async () => reports().filter((r) => r.kind === 'member-note' && r.slug === 'mira').length > before, 30000);
  ok('(f) her next write keeps it minimised (one agenda, min)', record('mira')?.containers.filter((c) => c.kind === 'agenda').length === 1 && agendaOf(record('mira'))?.min === true,
    JSON.stringify(agendaOf(record('mira'))));

  console.log('── (g) main untouched');
  await toMainStage(page);
  ok('(g) main\'s record keeps its one agenda card', record('main')?.containers.filter((c) => c.kind === 'agenda').length === 1);
  ok('(g) main\'s pad holds only main\'s line', /MAINLINE/.test(padText(record('main'))) && !/MIRA|PERALINE/.test(padText(record('main'))), padText(record('main')));
  ok('(g) main\'s stage draws its agenda', await until(page, async () => (await agendaCard(page, 'main').count()) === 1, 15000));
  await shot(page, '05', 'main-stage', [[1920, 1080]]);

  ok('no console errors', watch.errors.length === 0, watch.errors.join('\n'));
  ok('no failed requests', watch.failed.length === 0, watch.failed.join('\n'));
  await browser.close();
}

let srv = null;
try {
  setupScratch();
  const port = await freePort();
  srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log'), extraEnv: { DREAMCONTEXT_DESKTOP: '1' } });
  await run(`http://127.0.0.1:${port}`);
} catch (err) {
  ok(`the run finished (${err?.message ?? err})`, false, err?.stack);
} finally {
  srv?.kill();
  if (process.env.SHOTS) { mkdirSync(process.env.SHOTS, { recursive: true }); cpSync(OUT, process.env.SHOTS, { recursive: true }); }
  console.log(`\n${summary()}`);
  process.exit(result.fails.length ? 1 : 0);
}
