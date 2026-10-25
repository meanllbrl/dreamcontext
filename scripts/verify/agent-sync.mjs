#!/usr/bin/env node
/**
 * AI Team v2, wave B1 (AC-B1-7): agents ride the brain sync, shown in the real app on three
 * machines of one brain.
 *
 *   npm run build && node scripts/verify/agent-sync.mjs
 *
 * WHAT IT DRIVES: the BUILT CLI and dashboard server, one isolated fake HOME and one clone of a
 * local bare remote per machine, real git, real Chromium. No tokens are spent (a local-path remote
 * never asks for the dummy GITHUB_TOKEN). Fixtures are fictional (a project called "Lumen Notes").
 *
 *   machine A  "Studio Mac"    signed in as alice: owns Scout, confirmed agent sync and pushed.
 *   machine B  "Desk PC"       signed in as bob: received the switch, has not confirmed; its own
 *                              Scribe holds a token in a thread.
 *   machine A2 "Travel Laptop" signed in as alice too: Scout runs on the Studio Mac.
 *
 *   §1 owner view (A): Scout is yours (owner chip), the composer is there, no read-only part, no
 *      migration notice; a task hand-edited to Scout raises an "assigned outside the app" row.
 *   §2 other login (B): the migration notice ("Confirm on this machine") lists the held token by
 *      path; Scout sits under "alice · read-only"; its stage has the read-only banner and no
 *      composer, no edit.
 *   §3 same login, other machine (A2): Scout's stage says it runs on the Studio Mac and offers
 *      Bring it here; pressing it moves it here.
 *   Every view at 1440 and 390, light and dark. Screenshots: tmp/verify-agent-sync/<machine>-<w>-<theme>-<name>.png.
 *   Collect, don't fail fast; exit 1 on any FAIL, console error or failed request.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(REPO, 'tmp', 'verify-agent-sync');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-agent-sync');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const BARE = join(SCRATCH, 'remote.git');
const GHP = `ghp_${'q'.repeat(36)}`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};

const machines = {
  A: { key: 'A', login: 'alice', name: 'Studio Mac', id: 'aaaaaaaaaaaa' },
  B: { key: 'B', login: 'bob', name: 'Desk PC', id: 'bbbbbbbbbbbb' },
  A2: { key: 'A2', login: 'alice', name: 'Travel Laptop', id: 'cccccccccccc' },
};
for (const m of Object.values(machines)) {
  m.home = join(SCRATCH, `home-${m.key}`);
  m.proj = join(SCRATCH, `lumen-${m.key}`);
  m.dc = join(m.proj, '_dream_context');
}

const ENV = (m) => ({ ...process.env, HOME: m.home, GITHUB_TOKEN: 'verify-dummy-token' });
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const cli = (m, ...args) => spawnSync(process.execPath, [distIndex(REPO), ...args], { cwd: m.proj, env: ENV(m), encoding: 'utf-8' });
const must = (label, r) => { if (r.status !== 0) throw new Error(`${label} failed: ${r.stderr || r.stdout}`); return r; };

function homeFor(m) {
  mkdirSync(join(m.home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(m.home, '.dreamcontext', 'machine.json'), JSON.stringify({ id: m.id, name: m.name }));
  writeFileSync(join(m.home, '.dreamcontext', '.secrets.json'), JSON.stringify({ github: { login: m.login } }), { mode: 0o600 });
  writeFileSync(join(m.home, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true,
    screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
}

function identity(m) {
  git(m.proj, 'config', 'user.email', `${m.login}@users.noreply.github.com`);
  git(m.proj, 'config', 'user.name', m.login);
}

function setup() {
  git(SCRATCH, 'init', '-q', '--bare', '--initial-branch=main', BARE);
  const { A, B, A2 } = machines;

  // Machine A: the project, Scout and its routine, a report, agent sync confirmed, pushed.
  homeFor(A);
  for (const d of [join(A.dc, 'state'), join(A.dc, 'knowledge'), join(A.dc, 'automations')]) mkdirSync(d, { recursive: true });
  git(A.proj, 'init', '-q', '--initial-branch=main');
  git(A.proj, 'remote', 'add', 'origin', BARE);
  identity(A);
  writeFileSync(join(A.dc, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } }));
  writeFileSync(join(A.dc, 'knowledge', 'sync-outage.md'), '# Sync outage\n\nThree lessons failed to sync.\n');
  must('A vaults add', cli(A, 'vaults', 'add', 'lumen', A.proj));
  // A first agent writes the private-by-default ignore lines; the project goes up with them.
  must('A agents create keeper', cli(A, 'agents', 'create', 'keeper', '--title', 'Keeper', '--prompt', 'Keeps the Lumen Notes changelog tidy.'));
  must('A first push', cli(A, 'brain', 'sync'));

  // Machine B clones now: before the switch, it makes its own "scout".
  homeFor(B);
  git(SCRATCH, 'clone', '-q', '--branch', 'main', BARE, B.proj);
  identity(B);
  must('B vaults add', cli(B, 'vaults', 'add', 'lumen', B.proj));
  must('B agents create scout', cli(B, 'agents', 'create', 'scout', '--title', 'Bob Scout', '--prompt', 'Bob\'s own scout for the Lumen Notes docs.'));

  must('A agents create', cli(A, 'agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'Watches the Lumen Notes sync and reports what broke.'));
  must('A routine', cli(A, 'automations', 'create', 'scout-daily', '--title', 'Morning sync check', '--agent', 'scout', '--job', 'Check last night\'s sync.', '--days', 'daily', '--at', '08:00'));
  must('A post', cli(A, 'automations', 'post', '--run', '2026-10-24T08:00:00.000Z', 'scout-daily', '--', '- 3 lessons failed to sync last night'));
  must('A sync confirm', cli(A, 'agents', 'sync', '--confirm'));
  must('A brain sync', cli(A, 'brain', 'sync'));

  // Machine B: another login. Its own Scribe holds a token in a thread; it pulls the switch, and
  // alice's Scout arrives where its own "scout" sits.
  must('B agents create', cli(B, 'agents', 'create', 'scribe', '--title', 'Scribe', '--prompt', 'Writes the Lumen Notes release notes.'));
  must('B post', cli(B, 'automations', 'post', '--run', '2026-10-24T09:00:00.000Z', 'scribe', '--', `- pasted the deploy key ${GHP} by mistake`));
  must('B brain sync', cli(B, 'brain', 'sync', '--pull-only'));

  // Machine A2: alice again, a second machine. Scout runs on the Studio Mac.
  homeFor(A2);
  git(SCRATCH, 'clone', '-q', '--branch', 'main', BARE, A2.proj);
  identity(A2);
  must('A2 vaults add', cli(A2, 'vaults', 'add', 'lumen', A2.proj));
  must('A2 sync confirm', cli(A2, 'agents', 'sync', '--confirm'));

  // On A: a task hand-edited to Scout (as if it arrived by sync): it must not start.
  writeFileSync(join(A.dc, 'state', 'retry-the-failed-sync.md'), [
    '---', 'id: task_retry', 'name: Retry the failed sync', "description: ''", 'priority: high', 'urgency: medium', 'status: todo',
    "created_at: '2026-10-24'", "updated_at: '2026-10-24'", 'tags: []', 'parent_task: null', 'related_feature: null', 'version: null', 'agent: scout',
    '---', '', '## Why', '', 'A failed night sync waits for the owner until morning.', '',
  ].join('\n'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    import('node:net').then(({ createServer }) => {
      const srv = createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
  });
}

async function startServer(m, port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: m.proj, env: { ...ENV(m), PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`dashboard server (${m.key}) did not come up: ${log.slice(-400)}`);
}

/** One machine's browser pass: every viewport and theme, `body` does the looking. */
async function machineLeg(m, consoleErrors, failedRequests, body) {
  const port = await freePort();
  const server = await startServer(m, port);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    const legs = [['light', 1440], ['light', 390], ['dark', 1440], ['dark', 390]];
    for (let i = 0; i < legs.length; i++) {
      const [theme, width] = legs[i];
      const tag = `${m.key}-${width}-${theme}`;
      const phone = width === 390;
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      await setTheme(context, theme);
      await markAnnouncementsSeen(context, base);
      const page = await context.newPage();
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`${tag}: ${msg.text()}`); });
      page.on('pageerror', (e) => consoleErrors.push(`${tag} pageerror: ${e.message}`));
      page.on('requestfailed', (r) => { if (!/\/api\/agent\/chat/.test(r.url())) failedRequests.push(`${tag}: ${r.failure()?.errorText} ${r.url()}`); });
      const wait = (ms) => page.waitForTimeout(ms);
      const until = async (fn, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(150); } return false; };
      const shot = async (name) => { await wait(500); await page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) }); };
      const nav = async (label) => {
        if (phone) { const menu = page.locator('.phone-bar button').first(); if (await menu.count()) { await menu.click(); await wait(400); } }
        await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: new RegExp(`^${label}$`) }) }).first().click();
        await wait(800);
      };
      await page.goto(`${base}/?vault=lumen`, { waitUntil: 'domcontentloaded' });
      await wait(2000);
      for (let k = 0; k < 3 && (await page.locator('.announcements-modal-scrim').count()); k++) { await page.keyboard.press('Escape'); await wait(300); }
      await nav('AI Team');
      await until(() => page.locator('[data-team-row]').first().isVisible());
      await body({ page, tag, phone, wait, until, shot, last: i === legs.length - 1, base });
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

async function openRow(page, slug, until, phone) {
  await page.locator(`[data-team-row="${slug}"]`).first().click();
  await until(() => page.locator(`[data-stage="${slug}"], .aiteam-convo`).first().isVisible());
  // The stage view (a conversation may open first): switch when offered.
  const toStage = page.locator('button', { hasText: /^(Stage|Sahne)$/ }).first();
  if (!(await page.locator(`[data-stage="${slug}"]`).count()) && (await toStage.count())) await toStage.click();
  await until(() => page.locator(`[data-stage="${slug}"]`).isVisible());
  void phone;
}

let consoleErrors = [];
let failedRequests = [];
try {
  setup();
  check('three machines set up (A confirmed and pushed, B pulled the switch, A2 confirmed)', true);

  console.log('\n── §1 owner view (A, alice)');
  await machineLeg(machines.A, consoleErrors, failedRequests, async ({ page, tag, phone, until, shot }) => {
    check(`${tag}: no migration notice once confirmed here`, (await page.locator('[data-sync-notice]').count()) === 0);
    check(`${tag}: no read-only part for your own agents`, (await page.locator('[data-readonly-section]').count()) === 0);
    const row = await until(() => page.locator('[data-inbox-row="assigned-outside"]').isVisible());
    check(`${tag}: a hand-edited assignment waits as a row, Start / Ignore`, row
      && (await page.locator('[data-inbox-row="assigned-outside"] button', { hasText: 'Start' }).count()) === 1
      && (await page.locator('[data-inbox-row="assigned-outside"] button', { hasText: 'Ignore' }).count()) === 1);
    await shot('1-roster');
    await openRow(page, 'scout', until, phone);
    check(`${tag}: Scout's stage says it is yours`, await until(() => page.locator('[data-stage="scout"] [data-owner-chip]').filter({ hasText: 'Yours' }).isVisible()));
    check(`${tag}: …and offers its conversation`, await page.locator('[data-stage-start]').isVisible());
    await shot('2-stage');
  });

  console.log('\n── §2 another login (B, bob)');
  await machineLeg(machines.B, consoleErrors, failedRequests, async ({ page, tag, phone, until, shot }) => {
    check(`${tag}: the migration notice asks to confirm on this machine`, await until(() => page.locator('[data-sync-notice="unconfirmed"]').isVisible()));
    await page.locator('[data-sync-notice] .aiteam-syncnote-head').click();
    check(`${tag}: …and names the held token by path`, await until(() => page.locator('[data-sync-hits] li', { hasText: 'automations/threads/scribe/' }).filter({ hasText: 'stays here' }).isVisible()));
    check(`${tag}: …with the confirm button`, await page.locator('[data-sync-confirm]', { hasText: 'Confirm on this machine' }).isVisible());
    await shot('1-notice');
    const section = page.locator('[data-readonly-section="alice"]');
    check(`${tag}: Scout sits under "alice's · read-only"`, await until(() => section.locator('[data-team-row="scout"]').isVisible())
      && (await section.locator('.aiteam-section').innerText()).toLowerCase().includes("alice's · read-only"));
    check(`${tag}: bob's own scout came back as scout-2, with one "renamed" row`, await until(() => page.locator('[data-inbox-row="renamed"]').isVisible())
      && (await page.locator('[data-team-row="scout-2"]').count()) === 1
      && (await page.locator('[data-inbox-row="renamed"]').count()) === 1);
    check(`${tag}: your own Scribe is not read-only`, (await page.locator('[data-readonly-section] [data-team-row="scribe"]').count()) === 0);
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await shot('2-roster');
    await openRow(page, 'scout', until, phone);
    check(`${tag}: Scout's stage has the read-only banner`, await until(() => page.locator('[data-readonly-banner]').isVisible()));
    check(`${tag}: …no composer and no start`, (await page.locator('[data-stage="scout"] [data-stage-start], [data-stage="scout"] textarea').count()) === 0);
    check(`${tag}: …no autonomy edit`, (await page.locator('[data-stage="scout"] button.aiteam-autonomy').count()) === 0);
    check(`${tag}: …no approval strip`, (await page.locator('[data-stage="scout"] .aiteam-approval, [data-stage="scout"] [data-team-approval]').count()) === 0);
    await shot('3-stage');
    // The panel reads, it never writes: no talk, edit, approve or delete; routines without switches.
    const panelBtn = page.locator('[data-stage="scout"] .aiteam-pill', { hasText: /Profile|Profil/ }).first();
    if (!phone) check(`${tag}: the panel is reachable from the stage`, (await panelBtn.count()) > 0);
    if (!phone && await panelBtn.count()) {
      await panelBtn.click();
      check(`${tag}: the profile opens read-only`, await until(() => page.locator('[data-agent-profile="scout"] [data-readonly-owner]').isVisible()));
      check(`${tag}: …with no Talk, Edit, approval review or Delete`, (await page.locator('[data-agent-profile="scout"] .agp-actions, [data-agent-profile="scout"] [data-approval-section], [data-agent-profile="scout"] .agp-btn--danger, [data-agent-profile="scout"] [data-review-approval]').count()) === 0);
      await shot('4-profile');
      const teamTab = page.locator('[data-panel-tab="team"]');
      if (await teamTab.count()) {
        await teamTab.click();
        check(`${tag}: …its Team tab has no Talk, Change manager or Add report`, await until(() => page.locator('[data-team-tab="scout"]').isVisible())
          && (await page.locator('[data-team-tab="scout"] .aiteam-teamtab-actions, [data-team-tab="scout"] [data-add-report]').count()) === 0);
      }
      await page.locator('[data-panel-tab="routines"]').click();
      check(`${tag}: …and its routines have no switch or Run now`, await until(() => page.locator('[data-routine-readonly]').first().isVisible())
        && (await page.locator('.aiteam-panel [role="switch"]').count()) === 0);
      await page.locator('.aiteam-panel-close').click().catch(() => {});
    }
  });

  console.log('\n── §3 same login, other machine (A2, alice)');
  await machineLeg(machines.A2, consoleErrors, failedRequests, async ({ page, tag, phone, until, shot, last, base }) => {
    await openRow(page, 'scout', until, phone);
    check(`${tag}: Scout runs on the Studio Mac`, await until(() => page.locator('[data-elsewhere-banner]', { hasText: 'Studio Mac' }).isVisible()));
    check(`${tag}: …with Bring it here`, await page.locator('[data-bring-here]').isVisible());
    await shot('1-elsewhere');
    if (last) {
      await page.locator('[data-bring-here]').click();
      check(`${tag}: Bring it here moves it to this machine`, await until(() => page.locator('[data-elsewhere-banner]').count().then((n) => n === 0), 15000));
      const summary = await (await fetch(`${base}/api/agents/scout`)).json();
      check(`${tag}: …and the server agrees`, summary.agent?.runsElsewhere === null, JSON.stringify(summary.agent?.runsElsewhere));
      await shot('2-brought');
    }
  });
} catch (err) {
  check('the run completes', false, String(err?.stack ?? err).slice(0, 800));
}

console.log(`\nscreenshots: ${SHOTS}`);
for (const f of readdirSync(SHOTS).sort()) console.log(`  ${join(SHOTS, f)}`);
console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? `\n  ${consoleErrors.join('\n  ')}` : ''}`);
console.log(`failed requests: ${failedRequests.length}${failedRequests.length ? `\n  ${failedRequests.join('\n  ')}` : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || consoleErrors.length || failedRequests.length ? 1 : 0);
