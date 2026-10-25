#!/usr/bin/env node
/**
 * AI Team v2 C2, the task-assignment UI end to end (AC-C2-1..5), in the real dashboard against the
 * real server, the real task host and runner, and the real CLI, with `claude` replaced by a
 * stand-in that does what its queue says (deliver, review pass or fail, wait).
 *
 *   npm run build && node scripts/verify/task-agent-flow.mjs
 *
 * WHAT IT PROVES, each check naming the mutation it guards:
 *   C2-1 the composer: only the owner's agents, Now or a time (the scheduler-off warning), Docs,
 *        a reviewer; a later start is stored as an instant and the job waits `scheduled`.
 *   C2-2 the drawer: the agent row by state (scheduled: Change time / Start now / Unassign; a
 *        stuck task's three actions with NO Super session), Deliveries, Review rounds, History.
 *   C2-3 the board: the job's chip on the card; the Agent filter with its counts and "No agent".
 *   C2-4 the rows waiting on the owner where the app already lists them: AI Team's "waiting for
 *        you" (Open the task; the page draws no stage cards, owner 2026-10-25) and the notch.
 *   C2-5 the flow: assign scheduled → tick → the doer delivers → the reviewer fails → rework →
 *        the reviewer passes → the owner's row → the owner completes.
 *   End review r1: a teammate's agent's task shows its job and NO button; a stuck task with no
 *        row on this machine still shows its three actions; the composer and the delivered
 *        drawer at every width and theme.
 *
 * Widths 1440 and 390, light and dark; every console error, page error and failed request is
 * counted (zero allowed). Screenshots in tmp/verify-task-agent-flow/. Fake HOME, scratch project,
 * fictional names; nothing on this machine is touched. Collect, don't fail fast; exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, scratchDir, setTheme, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const SCRATCH = scratchDir('dc-verify-task-agent-flow');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const STATE = join(CONTEXT_ROOT, 'state');
const QUEUE = join(SCRATCH, 'queue');
const RELEASE = join(SCRATCH, 'release-live');
const SHOTS = shotsDir(REPO, 'task-agent-flow');
const BIN = join(HOME, '.local', 'bin');

const SCOUT = { slug: 'scout', title: 'Scout' };
const CRITIC = { slug: 'critic', title: 'Critic' };

const TASKS = {
  flow: { slug: 'write-the-onboarding-guide', name: 'Write the onboarding guide' },
  stuck: { slug: 'tighten-the-pricing-page', name: 'Tighten the pricing page' },
  live: { slug: 'sort-the-support-inbox', name: 'Sort the support inbox' },
  idle: { slug: 'rename-the-tag-groups', name: 'Rename the tag groups' },
  // Seeded after the flow (the board's filter counts are checked before): a teammate's agent's
  // delivered task, and a stuck task whose job ran elsewhere (no row on this machine).
  shared: { slug: 'review-the-brand-colors', name: 'Review the brand colors' },
  elsewhere: { slug: 'trim-the-faq', name: 'Trim the FAQ' },
};
const HELPER = { slug: 'helper', title: 'Helper' };

/**
 * The stand-in `claude`: what it does is read from QUEUE/<agent>.json (FIFO; the last entry
 * repeats). A task step delivers or records a verdict with the env its host gave it; `wait`
 * holds the run open (writing a transcript line first) until RELEASE exists.
 */
const STANDIN = `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const sid = at('--session-id') || at('--resume') || '00000000-0000-4000-8000-000000000000';
const agent = process.env.DREAMCONTEXT_AUTOMATION_SLUG || 'unknown';
const taskId = process.env.DREAMCONTEXT_TASK_ID || null;
const qf = join(${JSON.stringify(QUEUE)}, agent + '.json');
let action = { kind: 'done' };
if (taskId && existsSync(qf)) {
  const q = JSON.parse(readFileSync(qf, 'utf8'));
  action = q.length > 1 ? q.shift() : q[0];
  writeFileSync(qf, JSON.stringify(q));
}
appendFileSync(join(${JSON.stringify(SCRATCH)}, 'calls.jsonl'), JSON.stringify({ agent, taskId, action, argv, at: Date.now() }) + '\\n');
const cli = (args) => spawnSync(process.execPath, [${JSON.stringify(DIST_INDEX)}, ...args], { env: process.env, encoding: 'utf8' });
if (action.kind === 'wait') {
  const until = Date.now() + 1200000;
  while (!existsSync(${JSON.stringify(RELEASE)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
}
if (action.kind === 'deliver') cli(['tasks', 'deliver', taskId, '--note', action.note]);
if (action.kind === 'verdict') cli(['tasks', 'review', taskId, '--verdict', action.verdict, ...(action.finding ? ['--finding', action.finding] : [])]);
process.stdout.write(JSON.stringify({ session_id: sid, is_error: false, result: 'Done.', total_cost_usd: 0.01, num_turns: 1,
  duration_ms: 500, permission_denials: [], subtype: 'success' }) + '\\n');
`;

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  PASS ${label}`); }
  else { report.fail++; console.log(`  FAIL ${label}${ev ? `\n      ${String(ev).slice(0, 600)}` : ''}`); }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, HOME, PATH: [BIN, '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':') };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('DREAMCONTEXT_') || k.startsWith('VITEST')) delete env[k];
  }
  return { ...env, ...extra };
}

function cli(args) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], { cwd: PROJ, env: cleanEnv(), encoding: 'utf-8', timeout: 120_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${out.slice(0, 600)}`);
  return out;
}

const taskPath = (t) => join(STATE, `${t.slug}.md`);
const taskText = (t) => (existsSync(taskPath(t)) ? readFileSync(taskPath(t), 'utf-8') : '');
const field = (t, key) => (new RegExp(`^${key}: ['"]?([^'"\\n]*)['"]?$`, 'm').exec(taskText(t)) ?? [])[1] ?? null;
const queue = (agent, actions) => writeFileSync(join(QUEUE, `${agent.slug}.json`), JSON.stringify(actions));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await Promise.resolve().then(fn).catch(() => false)) return true; await sleep(step); }
  return false;
}

function seedTask(t, status = 'todo', tags = [], extra = []) {
  writeFileSync(taskPath(t),
    `---\nid: task_${t.slug.slice(0, 12)}\nname: ${t.name}\ndescription: ${t.name}\npriority: medium\nurgency: medium\n`
    + `status: ${status}\ncreated_at: '2026-10-01'\nupdated_at: '2026-10-01'\ntags: [${tags.join(', ')}]\nparent_task: null\nrelated_feature: null\n${extra.map((l) => `${l}\n`).join('')}---\n\n`
    + `## Why\n\nSeeded by scripts/verify/task-agent-flow.mjs.\n\n## Acceptance Criteria\n\n- [ ] It reads well.\n\n## Changelog\n\n`);
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), BIN, join(CONTEXT_ROOT, 'core'), STATE, QUEUE, SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(STATE, '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false } }));
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  writeFileSync(join(BIN, 'claude'), STANDIN);
  chmodSync(join(BIN, 'claude'), 0o755);
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now() + 3_600_000,
      utilization: {
        five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
        seven_day: { utilization: 10, resets_at: new Date(Date.now() + 40 * 3_600_000).toISOString() },
      },
    },
  }));
  cli(['vaults', 'add', 'proj', PROJ]);
  cli(['agents', 'create', SCOUT.slug, '--title', SCOUT.title, '--prompt', 'You write and tidy project documents.']);
  cli(['agents', 'create', CRITIC.slug, '--title', CRITIC.title, '--prompt', 'You review deliveries criterion by criterion.']);
  seedTask(TASKS.flow);
  seedTask(TASKS.stuck);
  seedTask(TASKS.live);
  seedTask(TASKS.idle);
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...cleanEnv(), DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(await until(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok, 30000, 250))) { srv.kill(); throw new Error('server did not come up'); }
  return srv;
}

async function openPage(browser, { theme, width, base }) {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 960 }, colorScheme: theme, deviceScaleFactor: phone ? 2 : 1 });
  await setTheme(context, theme);
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => { if (!/\/ws|websocket|net::ERR_ABORTED/i.test(`${r.url()} ${r.failure()?.errorText}`)) failed.push(`failed ${r.url()} ${r.failure()?.errorText}`); });
  const nav = async (label) => {
    if (phone) { const menu = page.locator('.phone-bar button').first(); if (await menu.count()) { await menu.click(); await page.waitForTimeout(400); } }
    await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: new RegExp(`^${label}$`) }) }).first().click();
  };
  const toBoard = async () => {
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    for (let i = 0; i < 4 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
    await nav('Tasks');
    await until(async () => (await page.locator('.bd-card').count()) > 0, 15000);
  };
  const card = (t) => page.locator(`.bd-card[data-task-slug="${t.slug}"]`).first();
  const openTask = async (t) => {
    await toBoard();
    await card(t).click({ position: { x: 24, y: 14 } });
    return until(async () => (await page.locator(`.detail-panel[data-task-slug="${t.slug}"]`).count()) === 1, 8000);
  };
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: join(SHOTS, `${width}-${theme}-${name}.png`) }); };
  return { context, page, errors, failed, nav, toBoard, card, openTask, noOverflow, shot };
}

/** C2-1, C2-2 (scheduled), C2-3, C2-5: the flow, light at 1440. */
async function flow(browser, base) {
  const ui = await openPage(browser, { theme: 'light', width: 1440, base });
  const { page } = ui;
  const composer = page.locator('.modal.ata');
  const row = page.locator('.djob');
  try {
    console.log('\n═══ C2-1. The composer: a later start, Docs, a reviewer ═══');
    await ui.openTask(TASKS.flow);
    await page.locator('[data-testid="give-to-agent"]').first().click({ timeout: 10000 });
    await page.locator('.gta-menu [data-testid^="give-agent-"]').first().click({ timeout: 8000 });
    check('Give to agent opens the composer', await until(async () => (await composer.count()) === 1, 8000));
    const names = await composer.locator('.ata-option-name').allInnerTexts();
    check('it offers the owner\'s agents', names.includes('Scout') && names.includes('Critic'), names.join(', '));
    await composer.locator('.ata-option', { hasText: 'Scout' }).click();
    await composer.locator('.ata-seg-opt', { hasText: 'At a time' }).click();
    const when = composer.locator('input[type="datetime-local"]');
    check('"At a time" shows a local date-time field', (await when.count()) === 1);
    // Guards a composer that lets a scheduled start depend on the app being open without saying so.
    check('…and warns that the scheduler is off on this Mac, with a way to turn it on',
      await until(async () => (await composer.locator('.ata-warn').count()) === 1, 8000), await composer.innerText().catch(() => ''));
    const target = new Date(Date.now() + 2 * 3_600_000);
    const p2 = (n) => String(n).padStart(2, '0');
    await when.fill(`${target.getFullYear()}-${p2(target.getMonth() + 1)}-${p2(target.getDate())}T${p2(target.getHours())}:${p2(target.getMinutes())}`);
    await composer.locator('.ata-seg-opt', { hasText: 'Docs' }).click();
    await composer.locator('label.field', { hasText: 'Reviewer' }).locator('select').selectOption(CRITIC.slug);
    const reviewerOpts = await composer.locator('label.field', { hasText: 'Reviewer' }).locator('option').allInnerTexts();
    // Guards a reviewer picker that offers the doer itself.
    check('the reviewer picker offers the owner and the other agents, never the doer', reviewerOpts.includes('Critic') && !reviewerOpts.includes('Scout'), reviewerOpts.join(', '));
    await ui.shot('1-composer');
    await composer.locator('.modal-actions .btn--primary').click();
    check('Assign confirms the start time in place',
      await until(async () => /starts on this task at/.test(await composer.locator('.ata-done').innerText()), 10000), await composer.innerText().catch(() => ''));
    // Guards a UI that drops the time and starts now.
    check('the task waits: agent_state scheduled, a start two hours out, the reviewer recorded',
      field(TASKS.flow, 'agent_state') === 'scheduled' && field(TASKS.flow, 'reviewer') === CRITIC.slug
        && Math.abs(Date.parse(field(TASKS.flow, 'agent_start_at') ?? '') - target.getTime()) < 90_000,
      taskText(TASKS.flow).split('---')[1]);
    await composer.locator('.modal-actions .btn--primary').click();

    console.log('\n═══ C2-2. The drawer while it waits ═══');
    check('the drawer shows the agent row with the job\'s chip', await until(async () => (await row.locator('.job-chip[data-job="scheduled"]').count()) === 1, 10000), await row.innerText().catch(() => '(none)'));
    const acts = await row.locator('.djob-btn').allInnerTexts();
    check('…and Change time, Start now, Unassign', ['Change time', 'Start now', 'Unassign'].every((a) => acts.includes(a)), acts.join(' | '));
    check('Properties show the agent, the reviewer and where it works',
      /Critic/.test(await page.locator('.task-field', { hasText: 'Reviewer' }).innerText().catch(() => ''))
        && /Docs/.test(await page.locator('.task-field', { hasText: 'Where it works' }).innerText().catch(() => '')));
    await ui.shot('2-drawer-scheduled');

    console.log('\n═══ C2-3. The board: chip and Agent filter ═══');
    await ui.toBoard();
    check('the card carries the job\'s chip (Starts …)', /Starts/.test(await ui.card(TASKS.flow).locator('.job-chip').innerText().catch(() => '')));
    await page.locator('[data-testid="filter-chip"]').click();
    await page.locator('.bd-row', { hasText: /^Agent/ }).first().click();
    const scoutRow = page.locator('.bd-row', { hasText: 'Scout' }).first();
    const noneRow = page.locator('.bd-row', { hasText: 'No agent' }).first();
    check('the Agent filter lists the agents with counts and "No agent"',
      /Scout\s*1/.test(await scoutRow.innerText().catch(() => '')) && /No agent\s*3/.test(await noneRow.innerText().catch(() => '')),
      `${await scoutRow.innerText().catch(() => '')} / ${await noneRow.innerText().catch(() => '')}`);
    await scoutRow.getByRole('button', { name: 'Include Scout' }).click();
    // Guards a filter field that is drawn but never applied.
    check('…and including Scout leaves only its task on the board',
      await until(async () => (await page.locator('.bd-card').count()) === 1 && (await ui.card(TASKS.flow).count()) === 1, 5000), String(await page.locator('.bd-card').count()));
    await ui.shot('3-board-filter');
    await scoutRow.getByRole('button', { name: 'Include Scout' }).click();
    await page.keyboard.press('Escape');

    console.log('\n═══ C2-5. Tick → deliver → reviewer fails → rework → pass → the owner completes ═══');
    queue(SCOUT, [{ kind: 'deliver', note: 'Drafted the guide in docs/onboarding.md.' }, { kind: 'deliver', note: 'Added the missing setup step.' }]);
    queue(CRITIC, [{ kind: 'verdict', verdict: 'fail', finding: 'It reads well: the setup step is missing.' }, { kind: 'verdict', verdict: 'pass' }]);
    // The start comes due (moved to a minute ago by the CLI twin of "Change time"), then the scheduler's tick.
    cli(['tasks', 'agent-action', TASKS.flow.slug, 'reschedule', new Date(Date.now() - 60_000).toISOString()]);
    cli(['automations', 'tick']);
    const passed = await until(() => field(TASKS.flow, 'agent_state') === 'delivered' && field(TASKS.flow, 'review_passed') === 'true', 90000, 500);
    check('the doer delivered twice, the reviewer failed then passed: delivered and passed', passed, taskText(TASKS.flow).split('## Changelog')[1]?.slice(0, 900));
    await ui.openTask(TASKS.flow);
    check('the drawer says the reviewer passed it', await until(async () => (await row.locator('.job-chip[data-job="passed"]').count()) === 1, 15000), await row.innerText().catch(() => ''));
    const deliveries = page.locator('[data-section="deliveries"] .ddel-item');
    check('Deliveries lists both rounds with their notes', (await deliveries.count()) === 2
      && /missing setup step/.test(await deliveries.first().innerText()), await page.locator('[data-section="deliveries"]').innerText().catch(() => '(none)'));
    const rounds = page.locator('[data-section="review-rounds"] .drev-row');
    check('Review rounds: round 2 passed, round 1 sent back',
      /Round 2[\s\S]*Passed/.test(await rounds.nth(0).innerText().catch(() => '')) && /Round 1[\s\S]*Sent back/.test(await rounds.nth(1).innerText().catch(() => '')),
      await page.locator('[data-section="review-rounds"]').innerText().catch(() => '(none)'));
    const hist = await page.locator('[data-section="history"]').innerText().catch(() => '');
    // Guards a history that loses who moved the status.
    check('History names who moved it: you, Scout, Critic (reviewer)', /by you/.test(hist) && /by Scout/.test(hist) && /by Critic \(reviewer\)/.test(hist), hist.slice(0, 400));
    await ui.shot('4-drawer-passed');
    await page.locator('.djob-btn', { hasText: 'Approve and complete' }).first().click();
    check('"Approve and complete" completes the task by the owner',
      await until(() => field(TASKS.flow, 'status') === 'completed' && /Completed \(by owner\)/.test(taskText(TASKS.flow)), 10000),
      `status=${field(TASKS.flow, 'status')}`);
    await ui.shot('5-drawer-completed');
    check('[1440 light] no console or page errors', ui.errors.length === 0, ui.errors.slice(0, 4).join(' | '));
    check('[1440 light] no failed requests', ui.failed.length === 0, ui.failed.slice(0, 4).join(' | '));
  } finally {
    await ui.context.close();
  }
}

/** A stuck task (cap 1, the reviewer fails) and a live one (the doer waits) for the other surfaces. */
async function setupStuckAndLive(base) {
  queue(SCOUT, [{ kind: 'deliver', note: 'Shortened the hero copy.' }, { kind: 'wait' }]);
  queue(CRITIC, [{ kind: 'verdict', verdict: 'fail', finding: 'The price table still repeats the hero.' }]);
  const assign = (t, body) => fetch(`${base}/api/tasks/${t.slug}/assign-agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
  const s1 = await assign(TASKS.stuck, { agent: SCOUT.slug, reviewer: CRITIC.slug, reviewCap: 1, workspace: 'doc' });
  check('a second task is assigned with one review round', s1 === 202, String(s1));
  check('…the reviewer fails it at the cap: stuck', await until(() => field(TASKS.stuck, 'agent_state') === 'stuck', 90000, 500), taskText(TASKS.stuck).split('---')[1]);
  const s2 = await assign(TASKS.live, { agent: SCOUT.slug, workspace: 'doc' });
  check('a third task is running (the doer is still at it)', s2 === 202 && await until(() => field(TASKS.live, 'agent_state') === 'running', 60000, 500), `${s2} ${field(TASKS.live, 'agent_state')}`);
  // A teammate's agent (its owner is someone else) arrived by the brain sync, with a delivered task.
  cli(['agents', 'create', HELPER.slug, '--title', HELPER.title, '--prompt', 'You help.']);
  const helperFile = join(CONTEXT_ROOT, 'agents', `${HELPER.slug}.md`);
  writeFileSync(helperFile, readFileSync(helperFile, 'utf-8').replace(/^owner:.*$/m, 'owner: alice'));
  seedTask(TASKS.shared, 'in_review', [], [`agent: ${HELPER.slug}`, 'agent_state: delivered', 'agent_step: work', 'review_round: 1']);
  seedTask(TASKS.elsewhere, 'in_progress', [], [`agent: ${SCOUT.slug}`, 'agent_state: stuck', 'agent_step: review', 'review_round: 5', 'review_cap: 5']);
}

/** C2-2 (stuck, no Super session), C2-4 (AI Team's list, notch), at one width and theme. */
async function surfaces(browser, base, theme, width) {
  const tag = `[${width} ${theme}]`;
  console.log(`\n═══ ${tag} drawer, board, AI Team, notch ═══`);
  const ui = await openPage(browser, { theme, width, base });
  const { page } = ui;
  try {
    await ui.openTask(TASKS.stuck);
    const row = page.locator('.djob');
    check(`${tag} a stuck task's drawer shows its three actions (no Super session runs)`,
      await until(async () => {
        const acts = await row.locator('.djob-btn').allInnerTexts();
        return ['One more round', "I'll take it", 'Cancel the task'].every((a) => acts.includes(a));
      }, 15000), await row.innerText().catch(() => '(none)'));
    check(`${tag} …and the finding the reviewer left`, /repeats the hero/.test(await row.innerText().catch(() => '')));
    check(`${tag} the drawer does not overflow sideways`, await ui.noOverflow());
    await ui.shot('drawer-stuck');

    // Guards a drawer whose owner buttons exist only through this machine's rows (end review r1).
    await ui.openTask(TASKS.elsewhere);
    check(`${tag} a stuck task whose job ran elsewhere (no row here) still offers its three actions`,
      await until(async () => {
        const acts = await row.locator('.djob-btn').allInnerTexts();
        return ['One more round', "I'll take it", 'Cancel the task'].every((a) => acts.includes(a));
      }, 15000), await row.innerText().catch(() => '(none)'));

    // Guards write controls on a teammate's agent (end review r1): its job is shown, never answered.
    await ui.openTask(TASKS.shared);
    check(`${tag} a teammate's agent's delivered task shows its job and no button`,
      await until(async () => (await row.locator('.job-chip').count()) === 1, 15000)
        && (await row.locator('.djob-btn, textarea').count()) === 0
        && (await page.locator('[data-testid="give-to-agent"]').count()) === 0, await row.innerText().catch(() => '(none)'));
    await ui.shot('drawer-teammate');

    // The delivered drawer at this width and theme: Deliveries, Review rounds, History.
    await ui.openTask(TASKS.flow);
    check(`${tag} the completed task keeps its Deliveries, Review rounds and History`,
      await until(async () => (await page.locator('[data-section="deliveries"] .ddel-item').count()) === 2
        && (await page.locator('[data-section="review-rounds"] .drev-row').count()) === 2
        && /by Critic \(reviewer\)/.test(await page.locator('[data-section="history"]').innerText().catch(() => '')), 15000));
    await page.locator('[data-section="deliveries"]').scrollIntoViewIfNeeded().catch(() => {});
    // Guards a closed task whose job row still offers "Approve and complete" (end review r1 observed check).
    check(`${tag} …its job row says it is completed and offers nothing`,
      (await row.locator('.djob-btn').count()) === 0 && /It is completed/.test(await row.innerText().catch(() => '')), await row.innerText().catch(() => ''));
    check(`${tag} …and does not overflow sideways`, await ui.noOverflow());
    await ui.shot('drawer-delivered');

    // The composer at this width and theme: the owner's agents only (never the teammate's).
    await ui.openTask(TASKS.idle);
    await page.locator('[data-testid="give-to-agent"]').first().click({ timeout: 10000 });
    await page.locator('.gta-menu [data-testid^="give-agent-"]').first().click({ timeout: 8000 });
    const composer = page.locator('.modal.ata');
    check(`${tag} the composer opens`, await until(async () => (await composer.count()) === 1, 8000));
    const names = await composer.locator('.ata-option-name').allInnerTexts();
    check(`${tag} …offers Scout and Critic, never the teammate's Helper`, names.includes('Scout') && names.includes('Critic') && !names.includes('Helper'), names.join(', '));
    await composer.locator('.ata-option', { hasText: 'Scout' }).click();
    await composer.locator('.ata-seg-opt', { hasText: 'At a time' }).click();
    check(`${tag} …"At a time" shows the date-time field and the scheduler warning`,
      (await composer.locator('input[type="datetime-local"]').count()) === 1 && await until(async () => (await composer.locator('.ata-warn').count()) === 1, 8000));
    check(`${tag} …and does not overflow sideways`, await ui.noOverflow());
    await ui.shot('composer');
    await page.keyboard.press('Escape');

    await ui.toBoard();
    check(`${tag} the board's cards carry their chips (stuck, working)`,
      (await ui.card(TASKS.stuck).locator('.job-chip[data-job="stuck"]').count()) === 1
        && (await ui.card(TASKS.live).locator('.job-chip[data-job="running"]').count()) === 1);
    check(`${tag} the board does not overflow sideways`, await ui.noOverflow());
    await ui.shot('board');

    await ui.nav('AI Team');
    await page.locator('[data-team-row="scout"]').first().click();
    // The left list's "waiting for you" row opens the task (C2-4; the stage has no cards: owner 2026-10-25).
    const inboxRow = page.locator('[data-owner-inbox] [data-inbox-row="task-stuck"]');
    if (width < 600) await page.locator('.aiteam-back').first().click().catch(() => {});
    check(`${tag} AI Team's "waiting for you" list offers the stuck task's "Open the task", never a raw key`,
      await until(async () => /Open the task/.test(await inboxRow.innerText()) && !/aiteam\.inbox\./.test(await inboxRow.innerText()), 10000), await inboxRow.innerText().catch(() => '(none)'));
    check(`${tag} the AI Team page draws no stage cards`, (await page.locator('.aiteam-card, .aiteam-stage-side').count()) === 0);
    await ui.shot('aiteam');
    await inboxRow.locator('button', { hasText: 'Open the task' }).click();
    check(`${tag} "Open the task" lands on the task`, await until(async () => (await page.locator(`.detail-panel[data-task-slug="${TASKS.stuck.slug}"]`).count()) === 1, 10000));

    const notch = await ui.context.newPage();
    notch.on('pageerror', (e) => ui.errors.push(`notch pageerror: ${e}`));
    notch.on('console', (m) => { if (m.type() === 'error') ui.errors.push(`notch console: ${m.text()}`); });
    notch.on('response', (r) => { if (r.status() >= 400) ui.failed.push(`notch ${r.status()} ${r.url()}`); });
    await notch.setViewportSize({ width: 420, height: 640 });
    await notch.goto(`${base}/?assistant=1`);
    await notch.waitForSelector('.dc-notch__pill', { timeout: 20000 });
    await notch.waitForTimeout(800);
    await notch.locator('.dc-notch__pill').click();
    await notch.locator('.dc-notch__tab', { hasText: 'Now' }).first().click();
    const waiting = notch.locator('section[aria-label="Tasks waiting on you"]');
    check(`${tag} the notch lists the stuck task under "Waiting on you"`,
      await until(async () => (await waiting.isVisible()) && /Tighten the pricing page/.test(await waiting.innerText()), 15000), await notch.locator('.dc-notch').innerText().catch(() => '(none)'));
    await notch.waitForTimeout(500);
    await notch.screenshot({ path: join(SHOTS, `${width}-${theme}-notch.png`) });
    await notch.close();

    check(`${tag} no console or page errors`, ui.errors.length === 0, ui.errors.slice(0, 4).join(' | '));
    check(`${tag} no failed requests`, ui.failed.length === 0, ui.failed.slice(0, 4).join(' | '));
  } finally {
    await ui.context.close();
  }
}

async function main() {
  console.log('· fixture: fake HOME, stand-in claude, agents Scout and Critic, four tasks');
  seed();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  // The notch is the assistant's window: it needs one (as the notch's own verify scripts do).
  const created = await fetch(`${base}/api/assistant/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nova' }) }).then((r) => r.status).catch(() => 0);
  console.log(`· POST /api/assistant/create → ${created}`);
  const browser = await chromium.launch();
  try {
    await flow(browser, base);
    await setupStuckAndLive(base);
    await surfaces(browser, base, 'light', 1440);
    await surfaces(browser, base, 'dark', 1440);
    await surfaces(browser, base, 'light', 390);
    await surfaces(browser, base, 'dark', 390);
  } finally {
    writeFileSync(RELEASE, 'go');
    await browser.close();
    await sleep(1500);
    srv.kill();
  }
}

main()
  .catch((err) => { report.fail++; console.log(`\n  FAIL run crashed: ${err && err.stack ? err.stack : err}`); })
  .finally(() => {
    console.log(`\n${report.fail === 0 ? 'PASS' : 'FAIL'}: ${report.pass} passed, ${report.fail} failed`);
    console.log(`  screenshots: ${SHOTS}`);
    process.exit(report.fail === 0 ? 0 : 1);
  });
