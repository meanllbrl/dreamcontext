#!/usr/bin/env node
/**
 * Wave 1 lane G (plan r10 1c, mockup r8-11): a task assigned to a member with a reviewer, after
 * one failed review round, shows on its drawer WHO IT WAITS ON ("Reviewer at work · round 2/5",
 * "nothing needed from you"), the round the reviewer sent back with the reviewer's name and its
 * findings, and the reviewer's face on the board card.
 *
 *   node scripts/verify/task-review-line.mjs
 *
 * No build: the API from source (tsx) and the UI from Vite (scripts/verify/lib/app.mjs), on a fake
 * HOME and a scratch project with a stand-in `claude`. The members are created and the task is
 * assigned through the real CLI (so this machine's ledger holds the assignment and no "assigned
 * outside the app" row appears); the job is then put where it stands after one failed round, as
 * the host writes it: round 2 in review on another Mac, round 1 sent back by the reviewer with
 * its findings on the changelog. Fictional names only.
 *
 * Screenshots at 1440 and 390 in tmp/verify/task-review-line/. Every assertion that fails, every
 * console error, page error, failed request and sideways overflow is a finding; exit 0 iff none.
 * The app's locale is English (the provider starts on `en`), so the English strings are asserted;
 * the Turkish ones are pinned in tests/unit/task-review-ui.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(REPO, 'tmp', 'verify', 'task-review-line');
mkdirSync(OUT, { recursive: true });

const TASK = { slug: 'set-the-annual-plan-price', name: 'Set the annual plan price' };
const DOER = { slug: 'rota', title: 'Rota' };
const REVIEWER = { slug: 'gantt', title: 'Gantt' };
const FINDINGS = 'Revenue table has no VAT; the monthly and yearly difference is rounded wrong.';

const app = await openApp({ suite: 'task-review-line' });
const fail = (what) => app.findings.push(`ASSERT ${what}`);

/** The real CLI, from source, on the scratch HOME and project, with no agent-session variables. */
function cli(args) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_|VITEST)/.test(k)));
  const env = {
    ...clean, HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}`,
    npm_config_cache: join(process.env.HOME ?? app.home, '.npm'),
  };
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), ...args], { cwd: app.proj, env, encoding: 'utf-8', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`dreamcontext ${args.join(' ')} failed: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, 800)}`);
  return r.stdout ?? '';
}

const taskPath = join(app.proj, '_dream_context', 'state', `${TASK.slug}.md`);

function seed() {
  cli(['agents', 'create', DOER.slug, '--title', DOER.title, '--prompt', 'You set prices and write the pricing page.']);
  cli(['agents', 'create', REVIEWER.slug, '--title', REVIEWER.title, '--prompt', 'You review pricing work criterion by criterion.']);
  writeFileSync(taskPath, matter.stringify(
    ['', '## Why', '', 'The annual plan has no price yet.', '', '## Acceptance Criteria', '', '- [ ] The revenue table includes VAT.', '- [ ] Monthly and yearly prices round the same way.', '', '## Changelog', '', ''].join('\n'),
    { id: 'task_annualplan', name: TASK.name, description: TASK.name, priority: 'high', urgency: 'medium', status: 'todo', created_at: '2026-11-01', updated_at: '2026-11-01', tags: [], parent_task: null, related_feature: null },
  ));
  // A start tomorrow: the ledger and the armed ticket are written, nothing runs.
  cli(['tasks', 'assign-agent', TASK.slug, DOER.slug, '--reviewer', REVIEWER.slug, '--at', new Date(Date.now() + 86_400_000).toISOString()]);

  // Where the job stands after one failed round, as the host and the delivery write it.
  const doc = matter(readFileSync(taskPath, 'utf-8'));
  const day1 = '2026-11-01';
  const day2 = '2026-11-02';
  const data = {
    ...doc.data,
    status: 'in_review',
    agent_state: 'running',
    agent_step: 'review',
    agent_start_at: null,
    agent_claimed_machine: 'Studio Mac',
    review_round: 2,
    review_cap: 5,
    review_passed: false,
    deliveries: [
      { round: 1, at: `${day1}T10:00:00.000Z`, by: DOER.slug, note: 'First price table.', refs: [], branch: null, commits: [] },
      { round: 2, at: `${day2}T09:00:00.000Z`, by: DOER.slug, note: 'Added VAT, fixed rounding.', refs: [], branch: null, commits: [] },
    ],
  };
  const entries = [
    `### ${day2} - Status → in_review (by agent:${DOER.slug})`, '- Delivered round 2.',
    `### ${day1} - Status → in_progress (by reviewer:${REVIEWER.slug})`, `- Review round 1: sent back (${REVIEWER.title}): ${FINDINGS}`,
    `### ${day1} - Status → in_review (by agent:${DOER.slug})`, '- Delivered round 1.',
  ].join('\n');
  const body = doc.content.replace(/## Changelog\n+/, `## Changelog\n\n${entries}\n\n`);
  writeFileSync(taskPath, matter.stringify(body, data));
}

try {
  seed();
} catch (err) {
  app.findings.push(`SEED ${String(err.message ?? err).slice(0, 600)}`);
  await app.stop();
  for (const f of app.findings) process.stdout.write(`FINDING: ${f}\n`);
  process.exit(1);
}

const until = async (fn, ms = 20_000, step = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};

/** Run one step; a throw (a timeout, a detached element) becomes a finding, never a crash. */
const step = async (label, fn) => {
  try { return await fn(); } catch (err) { fail(`${label}: ${String(err?.message ?? err).split('\n')[0].slice(0, 300)}`); return undefined; }
};
const shot = (page, file) => step(`screenshot ${file}`, () => page.screenshot({ path: join(OUT, file) }));
const closeAnnouncements = async (page) => {
  for (let i = 0; i < 4; i++) {
    const x = page.locator('.announcements-modal-close');
    if (!(await x.count().catch(() => 0))) break;
    await x.first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
};
/** True when the element under `loc`'s centre belongs to it: it is the visible page, nothing covers it. */
const onTop = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const x = Math.min(Math.max(r.left + Math.min(24, r.width / 2), 0), window.innerWidth - 1);
  const y = Math.min(Math.max(r.top + Math.min(14, r.height / 2), 0), window.innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  return !!hit && el.contains(hit);
}).catch(() => false);

try {
await app.look('/?vault=proj', async (page, w) => {
  const tag = `@${w.width}`;
  try {
    await closeAnnouncements(page);

    // To the board through the shell's rail: the left rail on the desktop, the bottom bar on the
    // phone (Chat, Tasks, AI Team, Insights, More). The old sidebar is only a fallback.
    const rail = page.locator('[data-testid="ns-rail-tasks"]:visible').first();
    const onTasks = async () => (await page.locator('[data-testid="ns-rail-tasks"][data-on="true"]').count()) > 0;
    if (await until(async () => (await rail.count()) > 0, 15_000)) {
      for (let i = 0; i < 3 && !(await onTasks()); i++) {
        await step(`${tag} tap Tasks in the rail`, () => rail.click({ timeout: 8_000 }));
        await until(onTasks, 4_000);
        await closeAnnouncements(page);
      }
      if (!(await onTasks())) fail(`${tag} the rail never marked Tasks as the open page`);
    } else {
      fail(`${tag} no Tasks button in the rail; trying the sidebar`);
      await step(`${tag} sidebar Tasks`, () => page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Tasks$/ }) }).first().click({ timeout: 8_000 }));
    }

    const card = page.locator(`.bd-card[data-task-slug="${TASK.slug}"]:visible`).first();
    if (!(await until(async () => (await card.count()) > 0, 20_000))) {
      fail(`${tag} the task's card never showed`);
      await shot(page, `board-${w.width}.png`);
      return;
    }
    await step(`${tag} scroll the card into view`, () => card.scrollIntoViewIfNeeded({ timeout: 5_000 }));
    await page.waitForTimeout(500);
    // The board must be the page in front: the card's own pixel is the card's, not a chat's.
    if (!(await until(() => onTop(card), 8_000))) fail(`${tag} the board is not the visible page (something covers the card)`);
    if ((await card.locator('[data-testid="card-reviewer"]').count().catch(() => 0)) !== 1) fail(`${tag} the card shows no reviewer face`);
    await shot(page, `board-${w.width}.png`);

    await step(`${tag} open the task`, () => card.click({ position: { x: 24, y: 14 }, timeout: 8_000 }));
    const panel = page.locator(`.detail-panel[data-task-slug="${TASK.slug}"]`).first();
    if (!(await until(async () => (await panel.count()) > 0, 10_000))) {
      fail(`${tag} the task's drawer did not open`);
      await shot(page, `task-${w.width}.png`);
      await shot(page, `rounds-${w.width}.png`);
      return;
    }
    const wait = panel.locator('[data-testid="job-wait"]').first();
    if (!(await until(async () => (await wait.count()) > 0, 15_000))) {
      fail(`${tag} the drawer shows no job line`);
    } else {
      const line = ((await step(`${tag} read the job line`, () => wait.innerText({ timeout: 5_000 }))) ?? '').replace(/\s+/g, ' ').trim();
      const key = await wait.getAttribute('data-wait').catch(() => null);
      if (key !== 'reviewer') fail(`${tag} the job line waits on ${key}, not the reviewer`);
      if (!/Reviewer at work · round 2\/5/.test(line)) fail(`${tag} the job line reads "${line}", not "Reviewer at work · round 2/5"`);
      if (!/nothing needed from you/.test(line)) fail(`${tag} the job line does not say nothing is needed from the owner: "${line}"`);
      await step(`${tag} scroll the job line into view`, () => wait.scrollIntoViewIfNeeded({ timeout: 5_000 }));
    }
    // The status stays the project's own: In Review.
    if (!/In Review/i.test(await panel.innerText({ timeout: 5_000 }).catch(() => ''))) fail(`${tag} the drawer does not show the status In Review`);
    await page.waitForTimeout(600);
    await shot(page, `task-${w.width}.png`);

    // The round the reviewer sent back: who, and the findings, on the task itself.
    const round1 = panel.locator('.drev-row[data-round-result="sent-back"]').first();
    if (!(await until(async () => (await round1.count()) > 0, 8_000))) fail(`${tag} no sent-back round in Review rounds`);
    else {
      const text = ((await step(`${tag} read round 1`, () => round1.innerText({ timeout: 5_000 }))) ?? '').replace(/\s+/g, ' ');
      if (!text.includes(REVIEWER.title)) fail(`${tag} the sent-back round does not name ${REVIEWER.title}: "${text}"`);
      if (!text.includes('Revenue table has no VAT')) fail(`${tag} the sent-back round does not carry the findings: "${text}"`);
    }
    if ((await panel.locator('.drev-row[data-round-result="reviewing"]').count().catch(() => 0)) !== 1) fail(`${tag} round 2 is not shown as in review`);
    const rounds = panel.locator('.drev-list').first();
    if (await rounds.count().catch(() => 0)) await step(`${tag} scroll Review rounds into view`, () => rounds.scrollIntoViewIfNeeded({ timeout: 5_000 }));
    await page.waitForTimeout(400);
    await shot(page, `rounds-${w.width}.png`);
  } catch (err) {
    fail(`${tag} unexpected: ${String(err?.message ?? err).split('\n')[0].slice(0, 300)}`);
    for (const f of [`board-${w.width}.png`, `task-${w.width}.png`, `rounds-${w.width}.png`]) await shot(page, f);
  }
}, { name: 'task-review-line' });
} catch (err) {
  // A page that never loaded (goto) is a finding too, and the report still prints.
  fail(`the page run stopped: ${String(err?.message ?? err).split('\n')[0].slice(0, 300)}`);
}

process.stdout.write(`screenshots also in ${OUT}\n`);
process.exit(await app.finish());
