#!/usr/bin/env node
/**
 * A GLOBAL member asked by the Super Agent (`super team ask`) never becomes a tab in a chat window
 * (owner 2026-11-18: "Super Agent'ın çağırdığı global agent'ların sessionleri farklı bir chat
 * window'unda açılıyor"). The same flow for a project member is the control.
 *
 *   npm run build && node scripts/verify/super-global-member-tab.mjs      (ENGINES=chromium)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard, real
 * members (`dreamcontext agents create`, Ada with `--scope global` in the scratch HOME) and the real
 * CLI run from inside each Super's process; `claude` is the scripted stand-in (lib/super-scratch.mjs).
 *
 *   G1  main asks Gantt (project member): its Super takes the request and starts one helper;
 *       no chat window shows a tab for Gantt's Super or its helper.
 *   G2  main asks Ada (global member): the same, for Ada.
 *   G3  after a reload of the window, neither member's sessions show as tabs.
 *
 * Fixture names are fictional (acme-app, Ada, Gantt). Shots: tmp/verify/super-global-member-tab/.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanEnv, freePort, openMember, readJson, readNd, reporter, stageComposer, startServer, superStandin, toMainStage, until } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-global-tab-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
/** A second project where Ada worked before (a global member is in every project). */
const PROJ2 = join(SCRATCH, 'globex');
// BUILD_REPO: another checkout's build (the before shots), this script's own otherwise.
const CLI = join(process.env.BUILD_REPO || REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify', 'super-global-member-tab', process.env.SHOT_TAG || 'after');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const ENGINES = (process.env.ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
    if (text.startsWith('[super')) return 'noted';
    const m = /ASK-(\\w+)/.exec(text);
    if (m) {
      const step = cli('super', 'team', 'ask', m[1].toLowerCase(), 'Check the launch tags for ' + m[1], '--brief', 'Launch tags ' + m[1]);
      report({ kind: 'asked', member: m[1].toLowerCase(), step: { status: step.status, out: step.out.slice(0, 600) } });
      return 'asked ' + m[1];
    }
    return 'ok';`,
  member: `
    const req = /- item=(\\S+) event=request/.exec(text);
    if (req) {
      const step = cli('super', 'delegate', '--prompt', 'HOLD helper of ' + slug, '--brief', 'Helper of ' + slug, '--for', req[1]);
      report({ kind: 'member-helper', slug, item: req[1], step: { status: step.status, out: step.out.slice(0, 600) } });
      return 'a helper is on it';
    }
    return 'ok';`,
  child: `
    if (text.includes('HOLD')) return null;
    return 'ok';`,
});

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const reports = () => readNd(REPORTS);
const memberRecord = (slug) => readJson(join(PROJ, '_dream_context', 'state', '.super', 'members', `${slug}.json`), null);

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true, newShell: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  mkdirSync(join(PROJ2, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', PROJ2, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [what, r] of [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' })],
    ['vaults add 2', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'globex', PROJ2], { env: env(), encoding: 'utf-8' })],
    ['gantt', dc('agents', 'create', 'gantt', '--title', 'Gantt', '--prompt', 'Keeps the project plan right.')],
    ['ada', dc('agents', 'create', 'ada', '--scope', 'global', '--title', 'Ada', '--prompt', 'Watches ad budgets in every project.')],
  ]) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  console.log(dc('agents', 'list').stdout);
}

async function chatTabs(page) {
  // Every chat window of the drawer, one after the other: the tabs each draws.
  const out = [];
  const rows = page.getByTestId('drawer-window-row');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click().catch(() => {});
    await page.waitForTimeout(900);
    const tabs = await page.locator('.agent-overlay-tabs [role="tab"], .agent-overlay-tabs .agent-tab').allTextContents().catch(() => []);
    out.push({ window: (await rows.nth(i).textContent().catch(() => '')) ?? '', tabs });
  }
  return out;
}

async function run(engineName, base) {
  const { chromium, webkit } = await import('playwright');
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const { ok } = rep;
  const tag = (s) => `[${engineName}] ${s}`;
  // Globex open first (Ada worked there before), then acme-app: both stay open in the drawer.
  await page.goto(`${base}/?vault=globex`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  // The owner talked to Ada in globex before: her Super there is live in this window.
  if (process.env.ADA_IN_GLOBEX !== '0') {
    await openMember(page, 'ada');
    const live = await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'member' && r.slug === 'ada'), 30000);
    console.log('   ada live in globex:', live);
    await page.waitForTimeout(1500);
  }
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await page.screenshot({ path: join(OUT, `${engineName}-0-load.png`) });
  console.log('   testids:', JSON.stringify(await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].slice(0, 80))));
  // An owner chat first (the hand-over needs one), then hand over.
  await page.getByTestId('ns-rail-chat').click().catch(() => {});
  await page.waitForTimeout(1200);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).first().click({ timeout: 5000 }).catch((e) => console.log('   start chat:', String(e).slice(0, 200)));
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  await page.screenshot({ path: join(OUT, `${engineName}-1-chat.png`) });
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('My own chat'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child'), 20000);
  await page.getByTestId('drawer-super-row').first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, `${engineName}-2-super.png`) });
  console.log('   testids2:', JSON.stringify(await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].filter((t) => /super|hand/.test(t)))));
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('handed over'), await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));

  for (const [label, slug] of [['G1 project member', 'gantt'], ['G2 global member', 'ada']]) {
    const say = await stageComposer(page, 'main');
    await say.click(); await say.fill(`ASK-${slug.toUpperCase()}`); await page.keyboard.press('Enter');
    const helped = await until(page, async () => reports().some((r) => r.kind === 'member-helper' && r.slug === slug), 60000);
    ok(tag(`${label}: its Super took the request and started a helper`), helped, JSON.stringify(reports().filter((r) => r.kind === 'asked' || r.kind === 'member-helper' || (r.kind === 'spawn' && r.role !== 'child')).slice(-6)));
    await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child' && r.crew === slug), 20000);
    await page.waitForTimeout(4000);
    const rec = memberRecord(slug);
    console.log(`   ${slug} record session=${rec?.session} children=${Object.keys(rec?.children ?? {}).join(',')}`);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByTestId('drawer-super-row').first().click().catch(() => {});
  await page.waitForTimeout(2500);
  // Status tracking, Gantt (project member) as the reference: a card on main's stage, the team
  // rows' working mark, the agenda.
  const tiles = async (name) => page.locator('[data-testid="super-team-tile"]').filter({ hasText: name }).count();
  const rowMark = async (testid) => page.locator(`[data-testid="${testid}"]`).first().evaluate((el) => {
    const sec = el.closest('[data-testid$="-section"]') ?? el.parentElement;
    return { text: (el.textContent ?? '').trim().slice(0, 80), working: !!sec?.querySelector('[data-testid="mark-working"]') || !!el.querySelector('[data-testid="mark-working"]') };
  }).catch(() => null);
  const agenda = (await page.getByTestId('super-agenda').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  const status = {
    tileGantt: await tiles('Gantt'), tileAda: await tiles('Ada'),
    projectRow: await rowMark('drawer-team-row'), globalRow: await rowMark('drawer-global-team-row'),
    agendaGantt: /Gantt/.test(agenda), agendaAda: /Ada/.test(agenda), agenda: agenda.slice(0, 400),
  };
  console.log('   status:', JSON.stringify(status));
  await page.screenshot({ path: join(OUT, `${engineName}-stage.png`) });
  ok(tag('S1 Gantt (reference) has a card on main\'s stage'), status.tileGantt > 0, JSON.stringify(status));
  ok(tag('S2 Ada has a card on main\'s stage'), status.tileAda > 0, JSON.stringify(status));
  // A member working for the Super is not the owner's work: the Team rows stay quiet for it (owner,
  // task sol-menu-dogru-yere-goturur). The global member must read exactly as the project one.
  ok(tag('S3 the Global team row reads Ada\'s work as the Team row reads Gantt\'s'), !!status.globalRow && !!status.projectRow && status.globalRow.working === status.projectRow.working, JSON.stringify(status));
  ok(tag('S5 the agenda names Ada as it names Gantt'), status.agendaAda === status.agendaGantt, JSON.stringify(status));
  // The owner's screen (1280): the stage folds cards into Others; Ada sits where Gantt does.
  await page.setViewportSize({ width: 1280, height: 830 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, `${engineName}-stage-1280.png`) });
  await page.setViewportSize({ width: 1600, height: 1000 });
  const tabsLive = await chatTabs(page);
  await page.screenshot({ path: join(OUT, `${engineName}-chat-window.png`) });
  const leak = (tabs, slug) => tabs.flatMap((w) => w.tabs).filter((t) => new RegExp(`${slug}|Helper of ${slug}`, 'i').test(t));
  console.log('   chat windows:', JSON.stringify(tabsLive));
  ok(tag('G1 no tab for Gantt or its helper in a chat window'), leak(tabsLive, 'gantt').length === 0, JSON.stringify(tabsLive));
  ok(tag('G2 no tab for Ada or her helper in a chat window'), leak(tabsLive, 'ada').length === 0, JSON.stringify(tabsLive));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  const tabsAfter = await chatTabs(page);
  await page.getByTestId('drawer-window-row').first().click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, `${engineName}-chat-window-reload.png`) });
  console.log('   after reload:', JSON.stringify(tabsAfter));
  ok(tag('G3 after a reload, no member tab in a chat window'), leak(tabsAfter, 'gantt').length === 0 && leak(tabsAfter, 'ada').length === 0, JSON.stringify(tabsAfter));
  await browser.close();
}

const rep = reporter();
setup();
const port = await freePort();
const srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
try {
  for (const e of ENGINES) await run(e, `http://127.0.0.1:${port}`);
} catch (e) {
  rep.ok('ran to the end', false, e?.stack ?? e);
} finally {
  srv.kill();
}
// Which project each conversation ran in (its transcript's folder).
try {
  const { readdirSync } = await import('node:fs');
  const base = join(HOME, '.claude', 'projects');
  for (const d of readdirSync(base)) console.log(`   transcripts ${d}: ${readdirSync(join(base, d)).length}`);
} catch { /* none */ }
console.log(`\nscratch: ${SCRATCH}`);
console.log(rep.summary());
process.exit(rep.result.fails.length ? 1 : 0);
