#!/usr/bin/env node
/**
 * `super team ask`, end to end, on the REQUEST route (plan-r10 1, Wave 3: every AI Team member is
 * a Super Agent of its own; task super-agent-ai-team-uyelerine-is-verir-…).
 *
 *   npm run build && node scripts/verify/super-team.mjs            (ENGINES=chromium,webkit)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard, the real
 * chat WebSockets, real AI Team members (`dreamcontext agents create`) and the real CLI run from
 * INSIDE each Super's own process. `claude` is a scripted stand-in (lib/super-scratch.mjs, no
 * tokens spent): it plays main Super AND a member's own Super (`mode: 'super'` + its chatAgent,
 * DREAMCONTEXT_MEMBER_SUPER), which closes main's request with `super team done`.
 *
 *   T1  the member is not approved on this Mac (a teammate's edit): `super team ask` is refused
 *       409 say_unapproved and nothing is queued for it; main's record holds ONE escalated
 *       `approval` item; the owner's queue strip leads with it, naming the member, with the button
 *       to its card and Reply (screenshot at 1920 px). Asked again: still one item.
 *   T2  that button lands on the member's approval card: the band on the member's own stage
 *       (`member-approval-band`), or "Üyeleri yönet" (`manage-members-modal`), never the old AI
 *       Team page (screenshots, 1440 and 390, light and dark).
 *   T3  the owner approves it (`agents approve --yes`), main asks again: 200, a `request` in the
 *       MEMBER's own Super queue, the approval item done and the strip empty; the window spawns
 *       the member's Super, its pump delivers the request as a `[super events]` turn (never an
 *       owner message), the member runs `super team done`, main hears ONE event line with the
 *       result, `super state` shows the job done; the member's stage shows the request as a
 *       "Super Agent'tan" block (`super-request-block`).
 *   T4  the member's ONE card on main's stage: face and name, done from the member record with its
 *       result, in the shared tone map's colour on tile and frame (screenshot at 1920 px); a click
 *       opens the MEMBER'S conversation (the request and its answer), never the empty "Say
 *       something to start"; the owner writes there, it reaches the member's Super as a plain
 *       message, the member answers, main hears nothing of it.
 *   T5  (plan-r10 1b) three `super team ask` to ONE member (Gantt): three requests in its one
 *       Super (one process), one root and two follow-ups `by: super` on main's record, ONE card on
 *       the stage reading "3 iş" ("3 jobs" in English). Screenshots at 1440 and 390 in
 *       tmp/verify/super-team/.
 *   T6  (plan-r10 1e) an agent-made prompt edit (`agents edit` from inside the member's own run,
 *       DREAMCONTEXT_AGENT_SELF) stamps itself: the member is approved, the edit is traced, and its
 *       stage and "Üyeleri yönet" show no approve button anywhere. Screenshots at 1440 and 390.
 *   No console errors.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTheme, openManageMembers, openMember, readJson, stage, stageComposer, superStandin, toMainStage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-team-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-team');
/** Wave 1's shots (plan-r10 1b and 1e), read by the lead. */
const OUT_W1 = join(REPO, 'tmp', 'verify', 'super-team');
/** A second member, approved by the owner, for one conversation and one card (T5) and the agent's edit (T6). */
const MEMBER2 = 'gantt';
const THREE = ['Fix the ClickUp assignments', 'Rename Ozan in the plan', 'Close the sprint'];
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const MEMBER = 'scout';
const MEMBER_ANSWER = 'Signups fell 4% on Tuesday; the drop is all on the pricing step.';
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
    // Every turn is already logged as 'super-turn' by the stand-in (lib/super-scratch.mjs).
    if (text.startsWith('[super')) return 'noted';
    if (text.includes('GO-TEAM')) {
      const steps = [cli('super', 'team', 'ask', ${JSON.stringify(MEMBER)}, 'Look at this week\\'s signup funnel and name the step that dropped.', '--brief', 'Funnel check')];
      report({ kind: 'team', steps });
      return 'asked the team';
    }
    if (text.includes('GO-THREE')) {
      const steps = ${JSON.stringify(THREE)}.map((job) => cli('super', 'team', 'ask', ${JSON.stringify(MEMBER2)}, job, '--brief', job));
      report({ kind: 'three', steps });
      return 'asked the same member three times';
    }
    if (text.includes('GO-STATE')) {
      const s = cli('super', 'state');
      report({ kind: 'state', team: s.json?.team ?? null, out: s.out.slice(0, 2000) });
      return 'read state';
    }
    return 'ok';`,
  // A member's own Super (DREAMCONTEXT_MEMBER_SUPER): its pump delivers main's request as a
  // [super events] turn; it closes it with \`super team done\` and answers the owner in text.
  member: `
    const req = /- item=(\\S+) event=request/.exec(text);
    if (req) {
      report({ kind: 'request-delivered', slug, item: req[1], text: text.slice(0, 3000) });
      const result = slug === ${JSON.stringify(MEMBER)} ? ${JSON.stringify(MEMBER_ANSWER)} : 'Done: ' + (text.split('Super Agent\\'tan: ')[1] || '').split('</untrusted-project-output>')[0].split('\\n')[0].slice(0, 80);
      const step = cli('super', 'team', 'done', req[1], result);
      report({ kind: 'team-done', slug, item: req[1], step });
      return result;
    }
    if (text.includes('which step?')) return 'The pricing step: the drop is all there.';
    return 'ok';`,
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
/** A clean environment: none of the calling session's Claude or dreamcontext variables. */
const env = () => {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_')));
  return { ...e, HOME, DREAMCONTEXT_DESKTOP: '1' };
};
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT, OUT_W1]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [what, r] of [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' })],
    ['agent', dc('agents', 'create', MEMBER, '--title', 'Scout', '--prompt', 'Reads the product funnel and names what moved.')],
    ['agent 2', dc('agents', 'create', MEMBER2, '--title', 'Gantt', '--prompt', 'Keeps the project plan and the ClickUp assignments right.')],
  ]) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  // A teammate's edit: the member is no longer approved on this Mac.
  appendFileSync(join(PROJ, '_dream_context', 'agents', `${MEMBER}.md`), 'It also checks the pricing page.\n');
  if (!/needs approval/.test(dc('agents', 'list').stdout)) throw new Error('the member should need approval');
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { queue: [], team: [] }; } };
/** A member's own Super record (plan-r10 1): state/.super/members/<slug>.json. */
const memberRecord = (slug) => readJson(join(PROJ, '_dream_context', 'state', '.super', 'members', `${slug}.json`), null);
const approvals = () => (record().queue ?? []).filter((q) => q.kind === 'approval' && q.member === MEMBER);

const result = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
  else { result.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
}
async function sayToSuper(page, text) {
  const input = await stageComposer(page, 'main');
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
const countOf = (kind) => reports().filter((r) => r.kind === kind).length;
async function superDoes(page, word, kind, ms = 30000) {
  const before = countOf(kind);
  await sayToSuper(page, word);
  await until(page, async () => countOf(kind) > before, ms);
  return reports().filter((r) => r.kind === kind)[before];
}

async function run(engineName, base) {
  const { chromium, webkit } = await import('playwright');
  const browserType = engineName === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // T1/T2: the unapproved member's stage asks for its birth and is refused 409 member_unapproved
  // (plan-r10 1). Chromium logs that as a bare "status of 409" console error: allowed once per such
  // response, nothing else.
  const refusedBirths = [];
  page.on('response', (r) => { if (r.status() === 409 && r.request().method() === 'POST' && /\/api\/super\/member(\?|$)/.test(r.url())) refusedBirths.push(r.url()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const tag = (s) => `[${engineName}] ${s}`;
  /** One test's steps: a throw (a timeout) is a red with its crash shot, and the next test runs. */
  const section = async (name, fn) => {
    try { await fn(); } catch (e) {
      await page.screenshot({ path: join(OUT, `${engineName}-${name}-crash.png`) }).catch(() => {});
      ok(tag(`${name} ran to the end`), false, e?.stack ?? e);
    }
  };

  console.log(`\n── ${engineName}: hand over`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('handed over'), await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));

  console.log(`── ${engineName}: T1 a member not approved here`);
  const t1 = await superDoes(page, 'GO-TEAM', 'team');
  const s1 = t1?.steps?.[0];
  ok(tag('T1 super team ask is refused 409 say_unapproved'), s1 && s1.status !== 0 && /say_unapproved/.test(s1.out), s1?.out);
  ok(tag('T1 …and says the owner approves it, not the super'), /You cannot approve it: the owner does/.test(s1?.out ?? ''), s1?.out);
  ok(tag('T1 …and nothing is queued for the member'), !memberRecord(MEMBER) || !(memberRecord(MEMBER).queue ?? []).some((q) => q.kind === 'request'), JSON.stringify(memberRecord(MEMBER)?.queue ?? null));
  ok(tag('T1 the record holds ONE escalated approval item for the member'), approvals().length === 1 && approvals()[0].state === 'escalated', JSON.stringify(record().queue));
  const head = page.locator('[data-testid="super-queue-head"][data-kind="approval"]');
  ok(tag('T1 the queue strip leads with it'), await until(page, async () => (await head.count()) === 1, 15000));
  let headText = '';
  ok(tag('T1 in the owner\'s words, naming the member by its name, on one uncut line'), await until(page, async () => {
    headText = await head.innerText();
    const cut = await head.locator('.super-queue-text').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    return /Scout needs your approval\./.test(headText) && !cut;
  }, 10000), headText);
  const openCard = head.getByTestId('super-queue-open-team');
  ok(tag('T1 with the button to its card and Reply'), (await openCard.count()) === 1 && (await head.locator('.super-queue-btn--reply').count()) === 1);
  // Under about 1600 px the stage folds its cards into Others: wide enough to keep this one out.
  for (const w of [1920]) {
    await page.setViewportSize({ width: w, height: w === 1280 ? 800 : 1080 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${engineName}-approval-${w}.png`) });
    const cut = await head.locator('.super-queue-text').evaluate((el) => el.scrollWidth > el.clientWidth + 1).catch(() => true);
    ok(tag(`T1 the line is uncut at ${w} px`), !cut);
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  const t1b = await superDoes(page, 'GO-TEAM', 'team');
  ok(tag('T1 asked again: refused again, still one item'), t1b?.steps?.[0]?.status !== 0 && approvals().length === 1, JSON.stringify(record().queue));

  console.log(`── ${engineName}: T2 the button leads to the member's approval card`);
  await openCard.click();
  // plan-r10 1e/Wave 3: the one card lives on the member's stage band (and in "Üyeleri yönet").
  const band = stage(page, `m:${MEMBER}`).getByTestId('member-approval-band');
  const modalCard = page.locator('[data-testid="manage-members-modal"]:visible [data-team-approval]');
  let where = '';
  ok(tag('T2 it lands on Scout\'s stage band (or "Üyeleri yönet") with its approval card'), await until(page, async () => {
    if (await band.isVisible().catch(() => false)) { where = 'band'; return true; }
    if (await modalCard.isVisible().catch(() => false)) { where = 'modal'; return true; }
    return false;
  }, 15000), `${await page.locator('[data-testid="super-surface"]:visible').getAttribute('data-super-id').catch(() => 'none')}`);
  if (where === 'band') ok(tag('T2 …on the stage of Scout'), /Scout/.test(await stage(page, `m:${MEMBER}`).getByTestId('super-member-name').innerText().catch(() => '')));
  ok(tag('T2 …never the old AI Team page'), (await page.locator('.aiteam:visible .aiteam-stage:visible').count()) === 0);
  await page.screenshot({ path: join(OUT, `${engineName}-approval-card-${where || 'none'}.png`) });
  // The card's stage band, light and dark, at the owner's two widths.
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: h });
    await applyTheme(page, theme);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT_W1, `${engineName}-approval-card-${w}-${theme}.png`) });
  }
  await applyTheme(page, 'light');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.keyboard.press('Escape');

  console.log(`── ${engineName}: T3 approved, asked again: a request in the member's own Super`);
  const ap = dc('agents', 'approve', MEMBER, '--yes');
  ok(tag('T3 the owner approves it'), ap.status === 0, ap.stderr || ap.stdout);
  await openChat(page, base);
  ok(tag('T3 back on main\'s stage'), await toMainStage(page));
  await page.waitForTimeout(1500);
  const t3 = await superDoes(page, 'GO-TEAM', 'team');
  const s3 = t3?.steps?.[0];
  const requestId = s3?.json?.request;
  ok(tag('T3 super team ask goes through as a request'), s3?.status === 0 && s3?.json?.member === MEMBER && typeof requestId === 'string' && s3?.json?.queued === true, s3?.out);
  ok(tag('T3 the approval item is done'), approvals().length === 1 && approvals()[0].state === 'done', JSON.stringify(approvals()));
  ok(tag('T3 the strip no longer asks'), await until(page, async () => (await head.count()) === 0, 10000));
  const job = () => (record().team ?? []).find((j) => j.member === MEMBER && j.request === requestId);
  ok(tag('T3 main\'s record has the team job naming the request'), job()?.brief === 'Funnel check', JSON.stringify(record().team));
  ok(tag('T3 the member\'s own record holds the request'), (memberRecord(MEMBER)?.queue ?? []).some((q) => q.id === requestId && q.kind === 'request'), JSON.stringify(memberRecord(MEMBER)?.queue ?? null).slice(0, 500));
  ok(tag('T3 the window spawns the member\'s Super'), await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'member' && r.slug === MEMBER), 45000),
    JSON.stringify(reports().filter((r) => r.kind === 'spawn')));
  const delivered = () => reports().find((r) => r.kind === 'request-delivered' && r.slug === MEMBER && r.item === requestId);
  ok(tag('T3 its pump delivers the request as a [super events] turn, never an owner message'), await until(page, async () => !!delivered(), 45000)
    && delivered().text.startsWith('[super events]') && delivered().text.includes("Super Agent'tan") && /signup funnel/.test(delivered().text), delivered()?.text?.slice(0, 600));
  const doneStep = () => reports().find((r) => r.kind === 'team-done' && r.item === requestId)?.step;
  ok(tag('T3 the member closes it: `super team done` 200'), await until(page, async () => doneStep()?.status === 0, 30000), doneStep()?.out);
  const closed = (memberRecord(MEMBER)?.queue ?? []).find((q) => q.id === requestId);
  ok(tag('T3 the request is done, with its result'), closed?.state === 'done' && /Signups fell 4%/.test(closed?.result ?? ''), JSON.stringify(closed));
  const doneLines = () => reports().filter((r) => r.kind === 'super-turn' && r.text.includes(`team=${job()?.id} `) && /event=done/.test(r.text));
  ok(tag('T3 main hears it as one event line'), await until(page, async () => doneLines().length >= 1, 45000), JSON.stringify(reports().filter((r) => r.kind === 'super-turn').map((r) => r.text.slice(0, 200))));
  await page.waitForTimeout(8000);
  ok(tag('T3 …exactly one, with the member\'s result'), doneLines().length === 1 && /Signups fell 4%/.test(doneLines()[0]?.text ?? ''), doneLines().map((r) => r.text.slice(0, 300)).join('\n'));
  let row = null;
  await until(page, async () => {
    const st = await superDoes(page, 'GO-STATE', 'state', 20000);
    row = (st?.team ?? []).find((j) => j.member === MEMBER && j.status !== undefined) ?? null;
    return row?.status === 'done';
  }, 60000);
  ok(tag('T3 super state shows the team job done'), row?.status === 'done', JSON.stringify(row));
  await page.screenshot({ path: join(OUT, `${engineName}-after.png`) });

  await section('T3b', async () => {
  console.log(`── ${engineName}: T3 the request on the member's stage`);
  // The delivered turn, as the member's Super got it, read with the dashboard's own rule
  // (superHandover.ts superRequestOf): so a red here says whether the turn or the stage is off.
  const got = delivered()?.text ?? '';
  const lines = got.split('\n');
  const parses = /^\[super events\] batch=[A-Za-z0-9_-]{1,80} items=1$/.test(lines[0] ?? '')
    && /^- item=([A-Za-z0-9_-]{1,80}) event=(request|reply)\b[^\n<]*\bfrom=super(?: [^\n<]*)?$/.test(lines[1] ?? '')
    && /^<untrusted-project-output vault="[^"\n]*">Super Agent'tan: /.test(lines.slice(2).join('\n'));
  ok(tag('T3 the delivered turn has the request block\'s exact shape (head, item line, fence)'), parses, got.slice(0, 600));
  await openMember(page, MEMBER);
  const memberStage = stage(page, `m:${MEMBER}`);
  await until(page, async () => (await memberStage.count()) > 0, 15000);
  const block = memberStage.getByTestId('super-request-block');
  // superStage.member.fromSuper: "From Super Agent" (en) / "Super Agent'tan" (tr).
  const blockShows = async () => {
    const t = await block.first().innerText().catch(() => '');
    return /From Super Agent|Super Agent'tan/.test(t) && /signup funnel/.test(t);
  };
  await until(page, blockShows, 30000);
  await page.screenshot({ path: join(OUT, `${engineName}-member-request-block.png`) });
  const blockOk = await blockShows();
  // What the stage draws instead, for the report: the folded event line, and whether "Show" opens the block.
  let instead = '';
  if (!blockOk) {
    const line = memberStage.getByText(/Super Agent event/).first();
    instead = `event line drawn: ${await line.isVisible().catch(() => false)}`;
    await memberStage.getByRole('button', { name: /^Show$|^Göster$/ }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    instead += `; after Show, block: ${await blockShows()}`;
    await page.screenshot({ path: join(OUT, `${engineName}-member-request-after-show.png`) });
  }
  ok(tag('T3 Scout\'s stage shows it as a "From Super Agent" / "Super Agent\'tan" block with its full text'), blockOk,
    `turn parses: ${parses}; ${instead}; stage: ${(await memberStage.innerText().catch(() => '')).slice(0, 300)}`);
  ok(tag('T3 back on main'), await toMainStage(page));
  });

  await section('T4', async () => {
  console.log(`── ${engineName}: T4 the member's card on main's stage`);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const card = page.locator('[data-testid="super-team-tile"]:visible').filter({ hasText: 'Scout' });
  await until(page, async () => (await card.count()) === 1, 15000);
  await page.screenshot({ path: join(OUT, `${engineName}-team-card-1920.png`) });
  ok(tag('T4 the member has its card on the stage'), (await card.count()) === 1, String(await card.count()));
  // New cards wait while the owner types (G1) and then play their entrance: the card must end up
  // really drawn (its frame no longer pending, fully opaque), not just present in the DOM.
  const shown = async () => card.evaluate((el) => {
    const frame = el.closest('[data-container-id]');
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return !!frame && !frame.classList.contains('super-card-frame--pending') && o > 0.99;
  }).catch(() => false);
  ok(tag('T4 it is revealed: drawn fully opaque once the owner stops typing'), await until(page, shown, 30000));
  ok(tag('T4 with the member\'s face and its name'), await until(page, async () =>
    /Scout/.test(await card.getByTestId('super-team-took').innerText().catch(() => ''))
    && (await card.locator('.super-team-who .agent-av, .super-team-who img').count()) === 1, 15000));
  ok(tag('T4 it reads done (from the member record), with the member\'s result'), await until(page, async () =>
    (await card.getAttribute('data-team-status')) === 'done'
    && /Signups fell 4%/.test(await card.getByTestId('super-team-line').innerText().catch(() => '')), 30000),
    `${await card.getAttribute('data-team-status').catch(() => '')} | ${await card.getByTestId('super-team-line').innerText().catch(() => '')}`);
  // The same tone language as a chat card: the state word is drawn in the tone superTone.css maps
  // its status to (done -> idle -> the accent token), and the frame carries that tone too.
  const tones = await card.evaluate((el) => {
    const frame = el.closest('[data-container-id]');
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { tile: el.getAttribute('data-super-tone'), frame: frame?.getAttribute('data-super-tone'), word: getComputedStyle(el.querySelector('.super-tile-state')).color, accent };
  }).catch((e) => ({ error: String(e) }));
  ok(tag('T4 its tone is the shared map\'s (idle for done), on the tile and the frame'), tones.tile === 'idle' && tones.frame === 'idle' && tones.word === tones.accent, JSON.stringify(tones));
  await page.screenshot({ path: join(OUT, `${engineName}-team-card-1920.png`) });
  const box = await card.boundingBox();
  ok(tag('T4 the card is on screen and drawn at 1920 px'), !!box && box.width > 100 && box.x >= 0 && box.x + box.width <= 1920 && await shown(), JSON.stringify(box));
  // Lane B's design (TeamJobConversation.tsx, a REQUEST job): the large card shows the member
  // Super's own transcript and a "Sohbeti aç" button; it has NO composer: the owner writes on the
  // member's stage. A real mouse click on the card opens it on main's stage.
  // Pinned by its id: once open, the frame no longer holds the tile, so a filter on it would lose it.
  const frameId = await card.evaluate((el) => el.closest('[data-container-id]')?.getAttribute('data-container-id') ?? '');
  const frame = page.locator(`[data-container-id="${frameId}"]`).first();
  const convo = frame.locator('[data-testid="team-job-conversation"]:visible').first();
  const isOpen = async () => (await frame.getAttribute('data-where').catch(() => null)) !== 'float' && await convo.isVisible().catch(() => false);
  const cb = await card.boundingBox();
  await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await until(page, isOpen, 15000);
  // The transcript loads after the card opens ("Loading the history…"): wait for it, then read.
  await until(page, async () => {
    const t = await convo.innerText().catch(() => '');
    return !/Loading the history|Geçmiş yükleniyor/i.test(t) && /signup funnel/.test(t) && /Signups fell 4%/.test(t);
  }, 45000);
  await until(page, async () => frame.evaluate((f) => !f.getAnimations().length && getComputedStyle(f).opacity === '1'), 5000);
  await page.screenshot({ path: join(OUT, `${engineName}-team-card-opened.png`) });
  ok(tag('T4 a click opens the card on main\'s stage, as the member\'s conversation'), await isOpen(), await frame.getAttribute('data-where').catch(() => ''));
  ok(tag('T4 …of that request'), (await convo.getAttribute('data-request').catch(() => null)) === requestId, await convo.getAttribute('data-request').catch(() => ''));
  const cardText = await convo.innerText().catch(() => '');
  ok(tag('T4 …showing the conversation: the request and the member\'s answer'), /signup funnel/.test(cardText) && /Signups fell 4%/.test(cardText), cardText.slice(0, 500));
  ok(tag('T4 …NEVER the empty "Say something to start"'), !/Say something to start/i.test(cardText) && !/Say something to start/i.test(await frame.innerText().catch(() => '')), cardText.slice(0, 300));
  ok(tag('T4 …and never the composer of a new conversation'), !/Start a new conversation/.test(await frame.innerHTML().catch(() => '')));
  ok(tag('T4 …no composer on the card (the owner writes on the member\'s stage)'), (await frame.locator('.chat-cmp-input, [data-testid="team-job-reply"]').count()) === 0);
  ok(tag('T4 …and its "Sohbeti aç" button'), (await convo.getByTestId('team-job-open-member').count()) === 1);
  // The keyboard does what the click does: back to its tile, Enter on the focused card opens it too.
  await frame.getByTestId('super-card-minimize').click().catch(() => {});
  ok(tag('T4 minimized, it is a floating tile again'), await until(page, async () =>
    (await frame.getAttribute('data-where').catch(() => null)) === 'float' && (await card.count()) === 1 && await shown(), 15000));
  await page.waitForTimeout(600);
  await frame.evaluate((el) => el.focus()).catch(() => {});
  await page.keyboard.press('Enter');
  ok(tag('T4 Enter on the focused card opens it on the stage too'), await until(page, isOpen, 15000));
  // The opened card at the owner's two widths.
  for (const w of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w[0], height: w[1] });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, `${engineName}-team-card-${w[0]}-open.png`) });
    console.log(`  card at ${w[0]}: conversation visible ${await convo.isVisible().catch(() => false)}, overflow ${await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)}`);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await until(page, isOpen, 5000);
  // "Sohbeti aç": the member's stage, its one conversation, and there the owner writes.
  const memberStage = stage(page, `m:${MEMBER}`);
  await convo.getByTestId('team-job-open-member').click().catch(() => {});
  await until(page, async () => (await memberStage.count()) > 0, 15000);
  await page.screenshot({ path: join(OUT, `${engineName}-team-card-member-stage.png`) });
  ok(tag('T4 "Sohbeti aç" opens Scout\'s stage'), (await memberStage.count()) > 0);
  const stageText = () => memberStage.innerText().catch(() => '');
  ok(tag('T4 …on its one conversation (the request is there), never "Say something to start"'), await until(page, async () => /signup funnel/.test(await stageText()), 15000)
    && !/Say something to start/i.test(await stageText()), (await stageText()).slice(0, 400));
  const memberInput = await stageComposer(page, `m:${MEMBER}`);
  ok(tag('T4 …and it can be written to there'), await until(page, async () => (await memberInput.isVisible().catch(() => false)) && await memberInput.isEnabled(), 20000));
  const ownerTurns = () => reports().filter((r) => r.kind === 'member-turn' && r.slug === MEMBER && r.text.includes('which step?'));
  await memberInput.click().catch(() => {}); await memberInput.fill('which step?').catch(() => {}); await page.keyboard.press('Enter');
  const sentAt = Date.now();
  await until(page, async () => ownerTurns().length > 0, 60000);
  const reachedMs = ownerTurns()[0] ? ownerTurns()[0].t - sentAt : null;
  console.log(`  the owner's message reached the member's Super after ${reachedMs ?? 'never (60 s)'} ms`);
  await until(page, async () => /The pricing step/.test(await stageText()), 30000);
  await page.screenshot({ path: join(OUT, `${engineName}-member-stage-answered.png`) });
  ok(tag('T4 …the owner\'s words reach the member\'s Super as a plain message'), ownerTurns().length === 1 && !ownerTurns()[0].text.startsWith('[super'),
    JSON.stringify(reports().filter((r) => r.kind === 'member-turn').map((r) => r.text.slice(0, 120))));
  ok(tag('T4 …and the member answers there'), /The pricing step/.test(await stageText()), (await stageText()).slice(-300));
  ok(tag('T4 …the Super Agent hears nothing of it (owner and member only)'), !reports().some((r) => r.kind === 'super-turn' && /which step\?/.test(r.text)));
  await page.setViewportSize({ width: 1600, height: 1000 });
  ok(tag('T4 back on main'), await toMainStage(page));
  });

  await section('T5', async () => {
  console.log(`── ${engineName}: T5 three asks to one member, one card`);
  // Under about 1600 px the stage folds its cards into Others (T4): wide enough to keep them out.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(800);
  // T4 left Scout's card open large, which folds the other cards into Others: back to its tile.
  for (const f of await page.locator('[data-container-id][data-kind="team"]').all()) {
    if ((await f.getAttribute('data-where').catch(() => 'float')) !== 'float') await f.getByTestId('super-card-minimize').click().catch(() => {});
  }
  await until(page, async () => (await page.locator('[data-container-id][data-kind="team"]:not([data-where="float"])').count()) === 0, 10000);
  const t5 = await superDoes(page, 'GO-THREE', 'three', 90000);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(OUT, `${engineName}-three-asks-1920.png`) });
  ok(tag('T5 three team asks to one member all go through as requests'), (t5?.steps ?? []).length === 3 && t5.steps.every((x) => x.status === 0 && typeof x.json?.request === 'string'), JSON.stringify(t5?.steps?.map((x) => x.out.slice(0, 200))));
  const gJobs = (record().team ?? []).filter((j) => j.member === MEMBER2);
  const gRoots = gJobs.filter((j) => !j.followUpOf);
  ok(tag('T5 the record holds three jobs for the member, Super\'s follow-ups marked by super'), gJobs.length === 3 && gRoots.length === 1 && gJobs.filter((j) => j.followUpOf).every((j) => j.by === 'super'), JSON.stringify(gJobs));
  ok(tag('T5 the member\'s own Super holds the three requests'), (memberRecord(MEMBER2)?.queue ?? []).filter((q) => q.kind === 'request').length === 3, JSON.stringify(memberRecord(MEMBER2)?.queue ?? null).slice(0, 500));
  ok(tag('T5 ONE member Super process for them (its one conversation)'), await until(page, async () => reports().filter((r) => r.kind === 'spawn' && r.role === 'member' && r.slug === MEMBER2).length === 1, 45000)
    && await until(page, async () => reports().filter((r) => r.kind === 'request-delivered' && r.slug === MEMBER2).length === 3, 90000),
    JSON.stringify(reports().filter((r) => r.slug === MEMBER2).map((r) => r.kind)));
  const gCards = (record().containers ?? []).filter((c) => c.kind === 'team' && gJobs.some((j) => j.id === c.ref));
  ok(tag('T5 ONE card for the member on the record, pointing at its current root'), gCards.length === 1 && gCards[0].ref === gRoots[0]?.id, JSON.stringify(gCards));
  const gTile = page.locator('[data-testid="super-team-tile"]:visible').filter({ hasText: 'Gantt' });
  ok(tag('T5 ONE Gantt tile on the stage'), await until(page, async () => (await gTile.count()) === 1, 45000), String(await gTile.count()));
  // No \b after "iş": in JS a word boundary never follows a non-ASCII letter.
  const threeJobs = /(^|[^0-9])3 (iş|jobs)(?![A-Za-z])/;
  ok(tag('T5 it reads "3 iş"'), await until(page, async () => threeJobs.test(await gTile.getByTestId('super-team-jobs').innerText().catch(() => '')), 20000),
    await gTile.getByTestId('super-team-jobs').innerText().catch(() => ''));
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1500);
    // The card is drawn at this width (on the stage, or in Others when the stage folds it there).
    const seen = page.locator('[data-testid="super-team-tile"]').filter({ hasText: 'Gantt' });
    if (!(await seen.first().isVisible().catch(() => false))) {
      await page.locator('[data-testid="super-others-open"]:visible').first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
    const drawn = await seen.first().isVisible().catch(() => false);
    const reads = drawn ? await seen.first().getByTestId('super-team-jobs').innerText().catch(() => '') : '';
    ok(tag(`T5 at ${w} px the one Gantt card is drawn and reads "3 iş"`), drawn && threeJobs.test(reads), `${drawn} | ${reads}`);
    await page.screenshot({ path: join(OUT_W1, `${engineName}-one-card-${w}.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });

  });

  await section('T6', async () => {
  console.log(`── ${engineName}: T6 an agent's prompt edit asks nothing`);
  const edit = spawnSync(process.execPath, [CLI, 'agents', 'edit', MEMBER2, '--prompt', 'Keeps the project plan and the ClickUp assignments right.\nNames the owner of each item.'],
    { cwd: PROJ, env: { ...env(), DREAMCONTEXT_AGENT_SELF: MEMBER2 }, encoding: 'utf-8' });
  ok(tag('T6 the member\'s own run edits its prompt'), edit.status === 0, edit.stderr || edit.stdout);
  const listed = dc('agents', 'list', '--json');
  let gRow = null; try { gRow = JSON.parse(listed.stdout).agents.find((a) => a.slug === MEMBER2); } catch { /* reported below */ }
  ok(tag('T6 it stays approved to run, with no card'), gRow?.approvedToRun === true, listed.stdout.slice(0, 400));
  const traced = dc('agents', 'amendments', MEMBER2, '--json');
  ok(tag('T6 the edit is traced, by agent, waiting for nothing'), /"by": "agent"/.test(traced.stdout) && !/"waits": true/.test(traced.stdout), traced.stdout.slice(0, 400));
  const approveIn = async (scope) => (await scope.locator('[data-testid="member-approval-band"], [data-team-approval], [data-approval-review], .adp-approve-btn, [data-review-approval]').count())
    + (await scope.getByRole('button', { name: /^(Approve|Onayla)/ }).count());
  await openMember(page, MEMBER2);
  const gStage = stage(page, `m:${MEMBER2}`);
  ok(tag('T6 the member\'s stage opens'), await until(page, async () => (await gStage.count()) === 1, 15000));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT_W1, `${engineName}-agent-edit-stage.png`) });
  ok(tag('T6 no approval band nor approve button on its stage'), (await approveIn(gStage)) === 0, String(await approveIn(gStage)));
  await openManageMembers(page, MEMBER2);
  const modal = page.locator('[data-testid="manage-members-modal"]:visible');
  ok(tag('T6 "Üyeleri yönet" opens on the member'), await until(page, async () => (await modal.count()) === 1 && /Gantt/.test(await modal.innerText()), 15000));
  await page.waitForTimeout(1000);
  ok(tag('T6 no approve button in "Üyeleri yönet" either'), (await approveIn(modal)) === 0, String(await approveIn(modal)));
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1500);
    const scope = (await modal.count()) ? modal : gStage;
    ok(tag(`T6 at ${w} px the member shows no approve button`), (await approveIn(scope)) === 0, String(await approveIn(scope)));
    await page.screenshot({ path: join(OUT_W1, `${engineName}-agent-edit-no-approve-${w}.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  });
  let allowed = refusedBirths.length;
  const left = errors.filter((e) => { if (allowed > 0 && /status of 409 \(Conflict\)/.test(e)) { allowed--; return false; } return true; });
  ok(tag('no console errors (beyond the expected 409 of an unapproved member\'s birth)'), left.length === 0, left.slice(0, 5).join('\n'));
  await browser.close();
}

async function main() {
  for (const engine of ENGINES) {
    setupScratch();
    const port = await freePort();
    const srv = await startServer(port);
    try { await run(engine, `http://127.0.0.1:${port}`); }
    catch (e) { ok(`[${engine}] ran to the end`, false, e?.stack ?? e); }
    finally { srv.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
  }
  console.log(`\n${result.pass} passed, ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  console.log(`screenshots: ${OUT} and ${OUT_W1}`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
