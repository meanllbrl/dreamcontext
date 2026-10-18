#!/usr/bin/env node
/**
 * "Assign to agent" (T1, T2, T5, T7), end to end in the real dashboard and the real CLI.
 *
 *   npm run build && npm run verify:task-agent-assign
 *
 * A task can be handed to one of the project's agents: the task gets `agent: <slug>`, an open
 * task moves to In progress, the agent runs on it through the existing run path, and one result
 * line lands in the task's changelog. This drives that path against the REAL server
 * (`POST /api/tasks/:slug/assign-agent`), the REAL runner and the REAL React surface, with
 * `claude` replaced by a stand-in that records the prompt it got and answers at once.
 *
 * WHAT IT PROVES, each check naming the mutation it guards:
 *   T1  the composer shows what will happen and what syncs (the disclosure); the assignment sets
 *       `agent:`, runs the agent with the task in its prompt, logs the result line, and puts the
 *       agent's face on the task page and the Kanban card. The CLI does the same.
 *       The composer is reached as a person reaches it since the task rebuild (plan r3 § 5e): the
 *       task page's "Give to an agent" door, choice "A named agent". The door reads the task by
 *       slug first, so every step WAITS for its selector (`[data-task-ready]`,
 *       `[data-give-ready]`, the composer), never for a fixed sleep.
 *   T2  a To Do task moves to In progress; an In Review task does NOT move.
 *   T5  `dreamcontext tasks assign-agent` inside an agent run is refused and writes nothing.
 *   T7  an agent not approved to run is refused: the composer opens its review in place with
 *       "Approve and assign", nothing is written before the approval, and it succeeds after it.
 *
 * WHAT IT DOES NOT TOUCH: your machine. Fake HOME, scratch project, a stand-in `claude`.
 * Screenshots (composer, review, detail, board; light and dark) land in tmp/verify-task-agent-assign/.
 *
 * FAILURE POLICY: collect, don't fail fast. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, scratchDir, setTheme, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const SCRATCH = scratchDir('dc-verify-task-agent-assign');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const STATE = join(CONTEXT_ROOT, 'state');
const PROMPTS = join(SCRATCH, 'prompts');
const SHOTS = shotsDir(REPO, 'task-agent-assign');
const BIN = join(HOME, '.local', 'bin');

/** Approved to run (an explicit agent, granted on create). */
const SCOUT = { slug: 'scout', title: 'Scout' };
/** Approved for chat only: a legacy scheduled automation's implicit agent. */
const DIGEST = { slug: 'digest', title: 'Daily digest' };
/** Same shape as digest, kept unapproved for the dark-theme review screenshot. */
const WEEKLY = { slug: 'weekly', title: 'Weekly brief' };

const TASKS = {
  todo: { slug: 'seed-the-funnel-report', name: 'Seed the funnel report', status: 'todo' },
  review: { slug: 'check-the-pricing-copy', name: 'Check the pricing copy', status: 'in_review' },
  gated: { slug: 'summarise-the-week', name: 'Summarise the week', status: 'todo' },
  cli: { slug: 'tidy-the-tag-list', name: 'Tidy the tag list', status: 'todo' },
  dark: { slug: 'draft-the-launch-note', name: 'Draft the launch note', status: 'todo' },
};

/** The runner's `claude -p <prompt> --output-format json`: record the prompt, answer success. */
const STANDIN = `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const i = argv.indexOf('-p');
const prompt = i === -1 ? '' : (argv[i + 1] || '');
const dir = ${JSON.stringify(PROMPTS)};
mkdirSync(dir, { recursive: true });
writeFileSync(dir + '/' + (process.env.DREAMCONTEXT_AUTOMATION_SLUG || 'unknown') + '-' + Date.now() + '-' + process.pid + '.txt', prompt);
process.stdout.write(JSON.stringify({ session_id: 'standin-assign', is_error: false,
  result: 'Done.\\n\\n## Detail\\n\\nLooked at it.\\n', total_cost_usd: 0.01, num_turns: 1,
  duration_ms: 1000, permission_denials: [] }) + '\\n');
`;

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  PASS ${label}`); }
  else { report.fail++; console.log(`  FAIL ${label}${ev ? `\n      ${ev}` : ''}`); }
}

/** The fake HOME with the stand-in first on PATH, minus anything that makes the CLI think it
 *  runs inside a Claude session or an agent run (the orchestrator may be one). */
function cleanEnv(extra = {}) {
  const env = { ...process.env, HOME, PATH: [BIN, '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':') };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('DREAMCONTEXT_')) delete env[k];
  }
  return { ...env, ...extra };
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], { cwd: PROJ, env: cleanEnv(env), encoding: 'utf-8', timeout: 120_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function cli(args) {
  const r = run(args);
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.out.slice(0, 600)}`);
  return r.out;
}

const taskPath = (t) => join(STATE, `${t.slug}.md`);
const taskText = (t) => (existsSync(taskPath(t)) ? readFileSync(taskPath(t), 'utf-8') : '');
const field = (t, key) => (new RegExp(`^${key}: ['"]?([^'"\\n]*)['"]?$`, 'm').exec(taskText(t)) ?? [])[1] ?? null;
const resultLine = (t, agent) => new RegExp(
  `### \\d{4}-\\d{2}-\\d{2} - Agent ${agent.title} \\(\`${agent.slug}\`\\)\\n- Run \\S+: ok\\. Document: `).test(taskText(t));
const promptsFor = (agent) => (existsSync(PROMPTS) ? readdirSync(PROMPTS) : [])
  .filter((f) => f.startsWith(`${agent.slug}-`)).map((f) => readFileSync(join(PROMPTS, f), 'utf-8'));

function registryEntry() {
  const p = join(HOME, '.dreamcontext', 'automations.json');
  if (!existsSync(p)) return null;
  const reg = JSON.parse(readFileSync(p, 'utf-8'));
  const key = Object.keys(reg.projects ?? {}).find((k) => k.endsWith(`${sep}proj`));
  return key ? reg.projects[key] : null;
}

function seedTask(t) {
  writeFileSync(taskPath(t),
    `---\nid: task_${t.slug}\nname: ${t.name}\ndescription: ${t.name}\n`
    + `priority: medium\nurgency: medium\nstatus: ${t.status}\ncreated_at: '2026-10-01'\n`
    + `updated_at: '2026-10-01'\ntags: []\nparent_task: null\nrelated_feature: null\n---\n\n`
    + `## Why\n\nSeeded by scripts/verify/task-agent-assign.mjs.\n\n## Changelog\n\n`);
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(BIN, { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'core'), { recursive: true });
  mkdirSync(STATE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(STATE, '.config.json'), JSON.stringify({
    platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false },
  }));
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  writeFileSync(join(BIN, 'claude'), STANDIN);
  chmodSync(join(BIN, 'claude'), 0o755);
  cli(['vaults', 'add', 'proj', PROJ]);

  cli(['agents', 'create', SCOUT.slug, '--title', SCOUT.title, '--prompt', 'You read the project and report what changed, briefly.']);
  const promptFile = join(SCRATCH, 'prompt.md');
  writeFileSync(promptFile, 'Read the week and write a three-line summary.\n');
  // Legacy scheduled files: their implicit agents may chat (the automation's approval lends
  // them their identity) but may NOT run a task until this Mac approves the agent itself.
  cli(['automations', 'create', DIGEST.slug, '--title', DIGEST.title, '--days', 'daily', '--at', '18:00', '--prompt-file', promptFile]);
  cli(['automations', 'create', WEEKLY.slug, '--title', WEEKLY.title, '--days', 'mon', '--at', '09:00', '--prompt-file', promptFile]);
  for (const t of Object.values(TASKS)) seedTask(t);
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

async function openPage(browser, theme, base) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  await setTheme(context, theme);
  // The 0.32.0 "What's New" popup opens on load and its scrim swallows the first click on the
  // rail: mark every announcement seen before the page loads.
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  /** A fresh load onto the Tasks board. */
  const toBoard = async () => {
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    const tasksRow = page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Tasks$/ }) }).first();
    await tasksRow.waitFor({ timeout: 15000 });
    for (let i = 0; i < 4 && (await page.locator('.announcements-modal-scrim').count()); i++) {
      await page.keyboard.press('Escape');
      await page.locator('.announcements-modal-scrim').first().waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    }
    await tasksRow.click();
    await until(async () => (await page.locator('.bd-card').count()) > 0, 15000);
  };
  const card = (t) => page.locator('.bd-card', { hasText: t.name }).first();
  /** Open a task's page, then the door's "A named agent": the Assign-to-agent composer. */
  const openComposer = async (t) => {
    await toBoard();
    await card(t).click();
    await page.locator('[data-task-ready]').first().waitFor({ timeout: 15000 });
    await page.locator('[data-task-page] .tkp-header-top .tkp-btn--primary').first().click();
    await page.locator('[data-give-ready="true"]').waitFor({ timeout: 15000 });
    await page.locator('[data-give-choice="agent"]').click();
    return until(async () => (await page.locator('.modal.ata').count()) === 1, 8000);
  };
  const composer = page.locator('.modal.ata');
  const option = (agent) => composer.locator('.ata-option', { hasText: agent.title }).first();
  const primary = () => composer.locator('.modal-actions .btn--primary').first();
  return { context, page, errors, until, toBoard, card, openComposer, composer, option, primary };
}

async function functional(browser, base) {
  const ui = await openPage(browser, 'light', base);
  const { page, until, composer, option, primary } = ui;
  try {
    // ── T1/T2: an approved agent, a To Do task ────────────────────────────────────────────
    console.log('\n═══ T1 / T2. Assign a To Do task to an approved agent ═══');
    check('the task page\'s door offers a named agent, which opens the composer', await ui.openComposer(TASKS.todo));
    const disclosure = await composer.locator('.ata-disclosure').innerText().catch(() => '');
    // Guards a composer that hides what syncs: the owner must read it before assigning.
    check('the composer discloses what reaches the task and that it syncs to ClickUp or GitHub',
      /status/i.test(disclosure) && /ClickUp/.test(disclosure) && /GitHub/.test(disclosure), disclosure);
    check('…and says what happens: it starts now, an unstarted task moves to In progress',
      /In progress/.test(disclosure), disclosure);
    await option(SCOUT).click();
    await ui.page.screenshot({ path: join(SHOTS, 'light-1-composer.png') });
    await primary().click();
    check('Assign confirms in place that the status moved',
      await until(async () => /moved to In progress/.test(await composer.locator('.ata-done').innerText()), 10000),
      await composer.innerText().catch(() => ''));
    // Guards an assignment that only shows a face (no field) or forgets the status rule.
    check('the task file now says agent: scout', field(TASKS.todo, 'agent') === SCOUT.slug, taskText(TASKS.todo).slice(0, 400));
    check('…and status: in_progress (moved from To Do)', field(TASKS.todo, 'status') === 'in_progress');
    // Guards a route that commits the field but never starts the run.
    const ran = await until(async () => promptsFor(SCOUT).some((p) => p.includes(TASKS.todo.name)), 30000);
    check('the agent ran through the run path, with the task in its prompt', ran, `prompts: ${promptsFor(SCOUT).length}`);
    // Guards a run whose outcome never reaches the task.
    check('the result line lands in the task changelog: "Agent Scout (`scout`)" then "Run …: ok. Document: …"',
      await until(async () => resultLine(TASKS.todo, SCOUT), 30000), taskText(TASKS.todo).split('## Changelog')[1]?.slice(0, 400));
    await primary().click(); // Close
    const detailFace = page.locator('.task-agent-row .task-agent-face[aria-label="Assigned to Scout"]');
    check('the agent\'s face is on the task page', await until(async () => (await detailFace.count()) > 0, 8000));
    await page.screenshot({ path: join(SHOTS, 'light-2-detail-face.png') });
    await ui.toBoard();
    check('…and on the Kanban card', await until(async () => (await ui.card(TASKS.todo).locator('.task-agent-face').count()) > 0, 8000));
    await page.screenshot({ path: join(SHOTS, 'light-3-board-face.png') });

    // ── T2: an In Review task does not move ───────────────────────────────────────────────
    console.log('\n═══ T2. An In Review task keeps its status ═══');
    await ui.openComposer(TASKS.review);
    await option(SCOUT).click();
    await primary().click();
    check('the assignment goes through', await until(async () => (await composer.locator('.ata-done').count()) === 1, 10000),
      await composer.innerText().catch(() => ''));
    // Guards a status rule that moves every assigned task to In progress.
    check('…the task gets agent: scout but stays in_review', field(TASKS.review, 'agent') === SCOUT.slug
      && field(TASKS.review, 'status') === 'in_review', `agent=${field(TASKS.review, 'agent')} status=${field(TASKS.review, 'status')}`);
    check('…and the confirmation does not claim a status move',
      !/moved to In progress/.test(await composer.locator('.ata-done').innerText().catch(() => '')));
    await until(async () => resultLine(TASKS.review, SCOUT), 30000);

    // ── T7: an agent not approved to run ──────────────────────────────────────────────────
    console.log('\n═══ T7. Approve and assign ═══');
    const gatedBefore = taskText(TASKS.gated);
    await ui.openComposer(TASKS.gated);
    check('the not-yet-approved agent is offered, marked as needing approval',
      /Needs approval/.test(await option(DIGEST).innerText().catch(() => '')), await option(DIGEST).innerText().catch(() => '(missing)'));
    await option(DIGEST).click();
    await primary().click();
    const review = composer.locator('.ata-review');
    check('Assign is refused and the composer opens the agent\'s review in place',
      await until(async () => (await review.locator('.ata-review-text').innerText()).includes('three-line summary'), 10000),
      await composer.innerText().catch(() => ''));
    check('…with "Approve and assign" as the one way forward', (await primary().innerText()).trim() === 'Approve and assign');
    // Guards an assignment committed (or a run started) before the approval check.
    check('…and nothing was written: the task is byte-identical, no run happened',
      taskText(TASKS.gated) === gatedBefore && promptsFor(DIGEST).length === 0);
    check('…and nothing was approved by the refusal', !registryEntry()?.agentApprovals?.[DIGEST.slug]);
    await page.screenshot({ path: join(SHOTS, 'light-4-review.png') });
    await primary().click();
    check('"Approve and assign" approves the agent to run on this machine',
      await until(async () => !!registryEntry()?.agentApprovals?.[DIGEST.slug], 10000));
    check('…then assigns: agent: digest, status in_progress',
      await until(async () => field(TASKS.gated, 'agent') === DIGEST.slug && field(TASKS.gated, 'status') === 'in_progress', 10000),
      taskText(TASKS.gated).slice(0, 300));
    check('…and confirms in place', await until(async () => (await composer.locator('.ata-done').count()) === 1, 10000));
    check('…and the agent ran and logged its result', await until(async () => resultLine(TASKS.gated, DIGEST), 30000),
      taskText(TASKS.gated).split('## Changelog')[1]?.slice(0, 300));

    check('[light] no uncaught page errors', ui.errors.length === 0, ui.errors.slice(0, 3).join(' | '));
  } finally {
    await ui.context.close();
  }
}

async function darkPass(browser, base) {
  console.log('\n═══ dark: the review, the detail, the board ═══');
  const ui = await openPage(browser, 'dark', base);
  const { page, until, composer, option, primary } = ui;
  try {
    const before = taskText(TASKS.dark);
    await ui.openComposer(TASKS.dark);
    await option(WEEKLY).click();
    await page.screenshot({ path: join(SHOTS, 'dark-1-composer.png') });
    await primary().click();
    check('[dark] an unapproved agent opens its review with "Approve and assign"',
      await until(async () => (await composer.locator('.ata-review').count()) === 1
        && (await primary().innerText()).trim() === 'Approve and assign', 10000));
    check('[dark] …and the task is untouched', taskText(TASKS.dark) === before);
    await page.screenshot({ path: join(SHOTS, 'dark-2-review.png') });
    await composer.locator('.modal-actions .btn--ghost').first().click();
    await ui.toBoard();
    await ui.card(TASKS.todo).click();
    await page.locator('[data-task-ready]').first().waitFor({ timeout: 15000 });
    check('[dark] the task page shows the agent\'s face',
      await until(async () => (await page.locator('.task-agent-row .task-agent-face').count()) > 0, 8000));
    await page.screenshot({ path: join(SHOTS, 'dark-3-detail-face.png') });
    await ui.toBoard();
    check('[dark] the Kanban card shows it too', await until(async () => (await ui.card(TASKS.todo).locator('.task-agent-face').count()) > 0, 8000));
    await page.screenshot({ path: join(SHOTS, 'dark-4-board-face.png') });
    check('[dark] no uncaught page errors', ui.errors.length === 0, ui.errors.slice(0, 3).join(' | '));
  } finally {
    await ui.context.close();
  }
}

function cliLeg() {
  // ── T5: refused inside an agent run; the same command works outside one ─────────────────
  console.log('\n═══ T5. The CLI, inside and outside an agent run ═══');
  const before = taskText(TASKS.cli);
  for (const env of [{ DREAMCONTEXT_AUTOMATION_RUN: '1' }, { DREAMCONTEXT_AGENT_SELF: '1' }]) {
    const name = Object.keys(env)[0];
    const r = run(['tasks', 'assign-agent', TASKS.cli.slug, SCOUT.slug], env);
    check(`\`tasks assign-agent\` with ${name} set is refused (non-zero exit, says why)`,
      r.status !== 0 && /cannot assign tasks to agents/i.test(r.out), `exit=${r.status} ${r.out.slice(-200)}`);
    // Guards a refusal that is only printed after the field (or status) was already written.
    check(`…and writes nothing to the task (${name})`, taskText(TASKS.cli) === before);
  }
  const promptsBefore = promptsFor(SCOUT).length;
  // The sentinel: the same command outside a run works, so the refusal above is the env's doing.
  const ok = run(['tasks', 'assign-agent', TASKS.cli.slug, SCOUT.slug]);
  check('outside a run, the same command assigns, runs the agent in the foreground, and logs the result',
    ok.status === 0 && field(TASKS.cli, 'agent') === SCOUT.slug && field(TASKS.cli, 'status') === 'in_progress'
      && promptsFor(SCOUT).length === promptsBefore + 1 && resultLine(TASKS.cli, SCOUT),
    `exit=${ok.status} agent=${field(TASKS.cli, 'agent')} status=${field(TASKS.cli, 'status')} ${ok.out.slice(-300)}`);
}

async function main() {
  console.log('· fixture: fake HOME, stand-in claude, an approved agent, two chat-only agents, five tasks');
  seed();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  try {
    await functional(browser, base);
    await darkPass(browser, base);
  } finally {
    await browser.close();
    srv.kill();
  }
  cliLeg();
}

main()
  .catch((err) => { report.fail++; console.log(`\n  FAIL run crashed: ${err && err.stack ? err.stack : err}`); })
  .finally(() => {
    console.log(`\n${report.fail === 0 ? 'PASS' : 'FAIL'}: ${report.pass} passed, ${report.fail} failed`);
    console.log(`  screenshots: ${SHOTS}`);
    process.exit(report.fail === 0 ? 0 : 1);
  });
