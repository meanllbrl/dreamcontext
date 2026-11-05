#!/usr/bin/env node
/**
 * AI Team approvals are asked on the Super Agent's screen (owner 2026-11-06, task
 * ai-team-onaylari-super-ekraninda-istenir-kart-ve-waiting-on-you-satiri).
 *
 *   npm run build && node scripts/verify/super-approvals.mjs        (OUT=<dir> for the shots)
 *   PHASE=before node scripts/verify/super-approvals.mjs            (an older build: shots only)
 *
 * The real dashboard server from the built dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real
 * dashboard, the real CLI; `claude` is the scripted stand-in (lib/super-scratch.mjs, no tokens).
 * The project has a member whose instructions changed by a teammate's edit (not approved here) and
 * a routine the Super Agent set up from its own session (`automations create` inside a Claude
 * session: it waits for the owner).
 *
 *   A1  main Super's screen shows ONE approval card above its chat, one row for the member and one
 *       for the routine, each with Review, Decline and Approve (shots 1440 light + dark, 390).
 *   A2  the agenda's Waiting on you lists both, its count includes them, and a row brings its
 *       card row into view.
 *   A3  the Super Agent cannot approve: from its own process `agents approve` and
 *       `automations approve` are refused, and a bare POST to both approve routes is 403
 *       owner_page_only; nothing is approved after.
 *   A4  the owner's Approve on the routine: approved here, its row leaves the card and the agenda,
 *       and the Super hears `event=automation automation=<slug> decision=approved`.
 *   A5  the owner's Decline on the member: turned off, its row leaves, the card is gone, and the
 *       Super hears `event=automation member=<slug> decision=rejected`.
 *   No console errors, no failed requests.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyTheme, cleanEnv, freePort, readNd, reporter, stage, stageComposer, startServer, superStandin, toMainStage, until, watchPage,
} from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PHASE = process.env.PHASE === 'before' ? 'before' : 'after';
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-approvals-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = process.env.CLI || join(REPO, 'dist', 'index.js');
const OUT = process.env.OUT || join(REPO, 'tmp', 'verify', 'super-approvals');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const MEMBER = 'scout';
const ROUTINE = 'deneme-rutin-5dk';

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
    if (text.startsWith('[super')) { report({ kind: 'events', text: text.slice(0, 4000) }); return 'noted'; }
    if (text.includes('GO-SELF')) {
      // The Super tries to give the approval itself, from its own process.
      const steps = [cli('agents', 'approve', ${JSON.stringify(MEMBER)}, '--yes'), cli('automations', 'approve', ${JSON.stringify(ROUTINE)}, '--yes')];
      report({ kind: 'self', steps });
      return 'tried';
    }
    return 'ok';`,
});

const reports = () => readNd(REPORTS);
const env = (extra = {}) => cleanEnv(HOME, extra);
const dc = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(extra), encoding: 'utf-8' });
const { ok, result, summary } = reporter();

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const steps = [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' })],
    ['member', dc(['agents', 'create', MEMBER, '--title', 'Scout', '--prompt', 'Reads the product funnel and names what moved.'])],
    ['approved member', dc(['agents', 'create', 'gantt', '--title', 'Gantt', '--prompt', 'Keeps the project plan right.'])],
    // Set up from inside a Claude session (the Super's own): it waits for the owner.
    ['routine', dc(['automations', 'create', ROUTINE, '--title', 'Deneme rutin 5dk', '--agent', 'gantt', '--job', 'Write the time and "rutin calisti" to your thread.', '--days', 'daily', '--at', '09:00'], { CLAUDECODE: '1' })],
  ];
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  // A teammate's edit: the member's instructions changed, so it is no longer approved here.
  appendFileSync(join(PROJ, '_dream_context', 'agents', `${MEMBER}.md`), 'It also checks the pricing page.\n');
  // An agent's clean routine is approved on the spot (plan-r10 1e); a teammate's edit to its job
  // makes it wait for the owner, like the member.
  const rPath = join(PROJ, '_dream_context', 'automations', `${ROUTINE}.md`);
  const rText = readFileSync(rPath, 'utf-8');
  if (!rText.includes('"rutin calisti" to your thread.')) throw new Error('the routine job text moved');
  writeFileSync(rPath, rText.replace('"rutin calisti" to your thread.', '"rutin calisti" to your thread, weekends too.'));
  const list = dc(['agents', 'list']).stdout;
  if (!/needs approval/.test(list)) throw new Error(`the member should need approval:\n${list}`);
}

async function handOver(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
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
  await toMainStage(page);
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => reports().some((r) => r.kind === 'handover'), 90000);
}

async function say(page, text) {
  const input = await stageComposer(page, 'main');
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

const shot = (page, name) => page.screenshot({ path: join(OUT, `${PHASE}-${name}.png`) });
/** The server's own read (no Origin needed for a GET). */
let BASE = '';
const api = async (path) => (await fetch(`${BASE}/api${path}`, { headers: { 'X-Dreamcontext-Vault': 'acme-app' } })).json();
const memberNow = async () => (await api('/agents')).agents?.find((a) => a.slug === MEMBER) ?? null;
const routineNow = async () => (await api('/automations')).automations?.find((a) => a.slug === ROUTINE) ?? null;

async function main() {
  setup();
  const port = await freePort();
  const server = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
  const base = `http://127.0.0.1:${port}`;
  BASE = base;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const watch = watchPage(page, 'main');
    ok('handed over to the Super Agent', await handOver(page, base));
    await until(page, async () => (await stage(page, 'main').count()) > 0, 15000);
    await page.waitForTimeout(2500);

    const card = page.locator('[data-testid="super-approvals"]');
    const rows = card.locator('[data-testid="super-approval-row"]');
    if (PHASE === 'before') {
      await applyTheme(page, 'light');
      await shot(page, '1440-light');
      await applyTheme(page, 'dark');
      await shot(page, '1440-dark');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(800);
      await applyTheme(page, 'light');
      await shot(page, '390-light');

    // A6 the owner's Approve on a member: the Super hears `member=… decision=approved`.
    const eventsLate = reports().filter((r) => r.kind === 'events').length;
    const ganttRow = card.locator('[data-super-approval="agent:gantt"]');
    await ganttRow.locator('[data-testid="super-approval-review"]').click();
    ok('A6 Approve comes on once the fresh read lands', await until(page, async () => ganttRow.locator('[data-testid="super-approval-approve"]').isEnabled().catch(() => false), 10000));
    await ganttRow.locator('[data-testid="super-approval-approve"]').click();
    ok('A6 the member row leaves', await until(page, async () => (await ganttRow.count()) === 0, 15000));
    ok('A6 the Super hears the member YES', await until(page, async () => reports().filter((r) => r.kind === 'events').slice(eventsLate)
      .some((r) => r.text.includes('event=automation member=gantt decision=approved')), 30000),
      JSON.stringify(reports().filter((r) => r.kind === 'events').map((r) => r.text.slice(0, 300))));
      console.log(`before: approval card rows on the Super screen: ${await rows.count()}`);
      return;
    }

    // A1
    ok('A1 one approval card on the Super screen', await until(page, async () => (await card.count()) === 1, 20000));
    const keys = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-super-approval')));
    ok('A1 one row for the member and one for the routine', keys.join(',') === `agent:${MEMBER},routine:${ROUTINE}`, keys.join(','));
    const text = await card.innerText();
    ok('A1 the rows say what waits, in the AI Team words', /Scout/.test(text) && /Deneme rutin 5dk/.test(text), text);
    ok('A1 each row has Review and Decline; Approve waits inside Review', (await card.locator('[data-testid="super-approval-review"]').count()) === 2
      && (await card.locator('[data-testid="super-approval-decline"]').count()) === 2 && (await card.locator('[data-testid="super-approval-approve"]').count()) === 0);
    ok('A1 the card sits above the Super chat, inside the stage', await stage(page, 'main').locator('[data-testid="super-approvals-top"]').count() === 1);
    await card.locator(`[data-super-approval="routine:${ROUTINE}"] [data-testid="super-approval-review"]`).click();
    ok('A1 Review shows the text Approve grants', await until(page, async () => /rutin calisti/.test(await card.locator('.aiteam-approval-pre').innerText().catch(() => '')), 10000));
    {
      // Approve, under the text, is in view inside the card without scrolling it.
      const a = await card.locator('[data-testid="super-approval-approve"]').boundingBox();
      const top = await page.locator('[data-testid="super-approvals-top"]').boundingBox();
      ok('A1 Approve is in view under the text', !!a && !!top && a.y + a.height <= top.y + top.height + 1, JSON.stringify([a, top]));
    }
    await applyTheme(page, 'light');
    await shot(page, '1440-light-review');
    await card.locator(`[data-super-approval="routine:${ROUTINE}"] [data-testid="super-approval-review"]`).click();
    await shot(page, '1440-light');
    await applyTheme(page, 'dark');
    await shot(page, '1440-dark');
    await applyTheme(page, 'light');

    // A2
    // The agenda floats as its counts tile: Waiting counts both; sized large it lists them.
    const agendaCard = page.locator('[data-testid="super-container"][data-kind="agenda"]');
    if (!(await agendaCard.count())) await page.locator('[data-testid="super-agenda-open"]:visible').first().click().catch(() => {});
    const tileN = page.locator('[data-testid="super-agenda-tile-waiting"] .super-agenda-tile-v');
    if (await tileN.count()) {
      ok('A2 the agenda tile counts both under Waiting', await until(page, async () => Number(await tileN.first().innerText()) >= 2, 15000), await tileN.first().innerText().catch(() => ''));
      // A small tile keeps its size choice under "more".
      const sizeBtn = agendaCard.locator('[data-testid="super-card-size-btn"]');
      if (await sizeBtn.count()) { await agendaCard.hover(); await sizeBtn.click(); }
      else { await agendaCard.hover(); await agendaCard.locator('[data-testid="super-card-more"]').click(); }
      await page.getByTestId('super-size-large').click();
    }
    const waiting = page.locator('[data-testid="super-agenda-section-waiting"]');
    ok('A2 Waiting on you lists both approvals', await until(page, async () => (await waiting.locator('[data-kind="approval"]').count()) === 2, 15000),
      await page.locator('[data-testid="super-agenda"]').first().innerText().catch(() => 'no agenda'));
    const n = Number(await page.locator('[data-testid="super-agenda-count-waiting"]').first().innerText().catch(() => '0'));
    ok('A2 its count includes them', n >= 2, String(n));
    await shot(page, '1440-light-agenda');
    await waiting.locator(`[data-row="agent:${MEMBER}"] button`).first().click();
    ok('A2 a row brings its card row into view (flash)', await until(page, async () => (await card.locator(`[data-super-approval="agent:${MEMBER}"][data-flash="true"]`).count()) === 1, 3000));

    // A3
    await say(page, 'GO-SELF');
    ok('A3 the Super tried from its own process', await until(page, async () => reports().some((r) => r.kind === 'self'), 30000));
    const self = reports().find((r) => r.kind === 'self');
    ok('A3 agents approve and automations approve are refused inside the Super', self?.steps?.every((s) => s.status !== 0), JSON.stringify(self?.steps?.map((s) => [s.args, s.status, s.out.slice(0, 200)])));
    for (const path of [`/api/agents/${MEMBER}/approve`, `/api/automations/${ROUTINE}/approve`]) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'acme-app' }, body: '{}' });
      const body = await r.json().catch(() => ({}));
      ok(`A3 a bare POST ${path} is 403 owner_page_only`, r.status === 403 && body.error === 'owner_page_only', `${r.status} ${JSON.stringify(body)}`);
    }
    const [m3, r3] = [await memberNow(), await routineNow()];
    ok('A3 nothing was approved', m3?.approvedToRun === false && r3?.approved === false, JSON.stringify([m3?.approvedToRun, r3?.approved]));
    ok('A3 both rows still wait', (await rows.count()) === 2);

    // A4
    const eventsBefore = reports().filter((r) => r.kind === 'events').length;
    const routineRow = card.locator(`[data-super-approval="routine:${ROUTINE}"]`);
    await routineRow.locator('[data-testid="super-approval-review"]').click();
    ok('A4 Approve comes on once the fresh read lands', await until(page, async () => routineRow.locator('[data-testid="super-approval-approve"]').isEnabled().catch(() => false), 10000));
    await routineRow.locator('[data-testid="super-approval-approve"]').click();
    ok('A4 the routine row leaves the card', await until(page, async () => (await card.locator(`[data-super-approval="routine:${ROUTINE}"]`).count()) === 0, 15000));
    ok('A4 …and the agenda', await until(page, async () => (await waiting.locator(`[data-row="routine:${ROUTINE}"]`).count()) === 0, 15000));
    ok('A4 the routine is approved on this Mac', await until(page, async () => (await routineNow())?.approved === true, 10000));
    ok('A4 the Super hears the decision', await until(page, async () => reports().slice(0).filter((r) => r.kind === 'events').slice(eventsBefore)
      .some((r) => r.text.includes(`event=automation automation=${ROUTINE} decision=approved`)), 30000),
      JSON.stringify(reports().filter((r) => r.kind === 'events').map((r) => r.text.slice(0, 300))));
    await shot(page, '1440-light-after-approve');

    // A5
    const eventsMid = reports().filter((r) => r.kind === 'events').length;
    await card.locator(`[data-super-approval="agent:${MEMBER}"] [data-testid="super-approval-decline"]`).click();
    ok('A5 deciding the last row still says what happened', await until(page, async () => (await card.locator('[data-testid="super-approvals-toast"]').count()) === 1, 10000));
    ok('A5 the card is gone once nothing waits', await until(page, async () => (await card.count()) === 0, 15000));
    ok('A5 the member is off, its file kept', await until(page, async () => (await memberNow())?.enabled === false, 10000), JSON.stringify(await memberNow()).slice(0, 400));
    ok('A5 the Super hears the NO', await until(page, async () => reports().filter((r) => r.kind === 'events').slice(eventsMid)
      .some((r) => r.text.includes(`event=automation member=${MEMBER} decision=rejected`)), 30000),
      JSON.stringify(reports().filter((r) => r.kind === 'events').map((r) => r.text.slice(0, 300))));
    ok('A5 Waiting on you has no approval row left', (await waiting.locator('[data-kind="approval"]').count()) === 0);
    await shot(page, '1440-light-after-decline');

    // 390 with something waiting again: a second teammate edit on the approved member.
    appendFileSync(join(PROJ, '_dream_context', 'agents', 'gantt.md'), 'It also keeps the sprint dates.\n');
    await page.setViewportSize({ width: 390, height: 844 });
    ok('390 the card comes back for a newly changed member', await until(page, async () => (await card.locator('[data-super-approval="agent:gantt"]').count()) === 1, 40000));
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ok('390 no horizontal overflow', !overflow);
    await shot(page, '390-light');

    // A6 the owner's Approve on a member: the Super hears `member=… decision=approved`.
    const eventsLate = reports().filter((r) => r.kind === 'events').length;
    const ganttRow = card.locator('[data-super-approval="agent:gantt"]');
    await ganttRow.locator('[data-testid="super-approval-review"]').click();
    ok('A6 Approve comes on once the fresh read lands', await until(page, async () => ganttRow.locator('[data-testid="super-approval-approve"]').isEnabled().catch(() => false), 10000));
    await ganttRow.locator('[data-testid="super-approval-approve"]').click();
    ok('A6 the member row leaves', await until(page, async () => (await ganttRow.count()) === 0, 15000));
    ok('A6 the Super hears the member YES', await until(page, async () => reports().filter((r) => r.kind === 'events').slice(eventsLate)
      .some((r) => r.text.includes('event=automation member=gantt decision=approved')), 30000),
      JSON.stringify(reports().filter((r) => r.kind === 'events').map((r) => r.text.slice(0, 300))));

    ok('no console errors or failed requests', watch.errors.length === 0 && watch.failed.length === 0, [...watch.errors, ...watch.failed].join('\n'));
  } finally {
    await browser.close().catch(() => {});
    server.kill();
    if (!process.env.KEEP) rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(`\n${summary()}`);
  console.log(`shots: ${OUT}`);
  process.exit(PHASE === 'before' || result.fails.length === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(2); });
