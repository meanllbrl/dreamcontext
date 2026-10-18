#!/usr/bin/env node
/**
 * "Move to Later" and the tag picker, proven against the real server.
 *
 *   node scripts/verify/task-backlog-and-tags.mjs   (npm run verify:task-backlog)
 *
 * WHY: the board's old "Send to backlog" wrote a `backlog` TAG. Since the task
 * rebuild (plan r3 § 5b/5c) "later" is a place on the "when?" axis: the context
 * menu's "Move to Later" plans the card into the Later queue through
 * `POST /api/tasks/:slug/plan`, so the card file says `queue: later`, carries
 * no backlog tag, and the board shows it in the Later column. The tag picker
 * still offers the tags the vault already uses (typing tags by hand is how a
 * vocabulary ends up with both `decisions` and `decision`), now on the task page.
 *
 * Runs against an ISOLATED scratch HOME — it mutates tasks.
 *
 * FAILURE POLICY — collect, don't fail fast.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = process.env.PORT || '4797';
const URL = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const home = mkdtempSync(join(tmpdir(), 'dc-bl-'));
const vaultDir = join(home, 'scratch');
const stateDir = join(vaultDir, '_dream_context', 'state');
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
mkdirSync(join(home, '.dreamcontext'), { recursive: true });
writeFileSync(
  join(home, '.dreamcontext', 'vaults.json'),
  JSON.stringify({ version: 1, vaults: [{ name: 'scratch', path: vaultDir }] }, null, 2),
);

/** A DATED task, so the backend's backlog rule has something to clear. */
const seed = (slug, name, tags) => writeFileSync(
  join(stateDir, `${slug}.md`),
  `---\nid: task_${slug}\nname: ${name}\ndescription: ${name}\n`
    + `priority: medium\nurgency: medium\nstatus: todo\ncreated_at: '2026-08-17'\n`
    + `updated_at: '2026-08-17'\ntags: [${tags.join(', ')}]\nparent_task: null\n`
    + `related_feature: null\nstart_date: '2026-08-18'\ndue_date: '2026-08-25'\n---\n\n`
    + `## Why\n\nSeeded by scripts/verify/task-backlog-and-tags.mjs.\n`,
);
// The second task exists to put a REAL tag in the vault's vocabulary, so the
// picker has something pre-existing to offer.
seed('shelve-me', 'Shelve me', ['ux']);
seed('other-task', 'Other task', ['layer:frontend']);

const frontmatter = (slug) => readFileSync(join(stateDir, `${slug}.md`), 'utf8').split('---')[1] ?? '';

const server = spawn(process.execPath, ['dist/index.js', 'dashboard', '--no-open', '--port', PORT], {
  env: { ...process.env, HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${URL}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

let browser;
try {
  if (!(await waitForServer())) {
    check('server boots', false, `no /api/health after 30s. log tail: ${serverLog.slice(-400)}`);
  } else {
    check('server boots', true);
    check('seed is dated', /due_date: '2026-08-25'/.test(frontmatter('shelve-me')));

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    const dismissAnnouncements = async () => {
      for (let i = 0; i < 3; i += 1) {
        if (!(await page.locator('.announcements-modal-scrim').count())) return;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
      }
    };

    const openBoard = async () => {
      await page.goto(`${URL}/?vault=scratch`, { waitUntil: 'networkidle' });
      await dismissAnnouncements();
      await page.locator('.sidebar-item', { hasText: 'Tasks' }).first().click();
      await page.locator('.bd-card', { hasText: 'Shelve me' }).first().waitFor({ state: 'visible', timeout: 15000 });
    };
    const laterColumn = () => page.locator('[data-board-column="later"]').first();

    // B1 — the quick action exists and plans the card into Later.
    await openBoard();
    await page.locator('.bd-card', { hasText: 'Shelve me' }).first().click({ button: 'right' });
    const row = page.locator('.bd-row', { hasText: 'Move to Later' }).first();
    await row.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check('B1 the context menu offers "Move to Later"', (await row.count()) > 0);
    await row.click();
    await laterColumn().locator('.bd-card', { hasText: 'Shelve me' }).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

    const fm = frontmatter('shelve-me');
    check('B2 the card is planned into Later (queue: later)', /\nqueue: later\b/.test(fm), fm.match(/queue:.*/)?.[0] ?? '(no queue)');
    // B3: Later is a place on the axis, not a tag, so nothing else on the card moves.
    check('B3 no backlog tag is written and the dates stay', !/backlog/.test(fm) && /due_date: '2026-08-25'/.test(fm), fm.match(/tags:.*/)?.[0]);
    check('B4 the board shows it in the Later column', (await laterColumn().locator('.bd-card', { hasText: 'Shelve me' }).count()) > 0);

    // B5 — the row is gone once the task is already there, rather than a no-op.
    await openBoard();
    await page.locator('.bd-card', { hasText: 'Shelve me' }).first().click({ button: 'right' });
    await page.locator('.bd-row', { hasText: 'Open task' }).first().waitFor({ state: 'visible', timeout: 5000 });
    check(
      'B5 the row hides for a task already in Later',
      (await page.locator('.bd-row', { hasText: 'Move to Later' }).count()) === 0,
    );
    await page.keyboard.press('Escape');

    // T1/T2 — on the task page, the tag picker lists what the vault already knows, and can create.
    await openBoard();
    await page.locator('.bd-card', { hasText: 'Other task' }).first().click();
    await page.locator('[data-task-ready="other-task"]').waitFor({ timeout: 10000 });
    const labels = page.locator('.task-section-head', { hasText: 'Labels' }).first();
    if ((await labels.getAttribute('aria-expanded')) !== 'true') await labels.click();
    const picker = page.locator('.task-tag-picker .ss-trigger').first();
    await picker.waitFor({ state: 'visible', timeout: 8000 });
    await picker.click();
    await page.locator('.task-tag-picker .ss-item').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const offered = await page.locator('.task-tag-picker .ss-item').allTextContents();
    check(
      'T1 the picker offers tags the vault already uses',
      offered.some((t) => t.includes('ux')),
      offered.slice(0, 6).join(' | ') || '(none)',
    );

    await page.locator('.task-tag-picker .ss-search').fill('brand-new-tag');
    const custom = page.locator('.task-tag-picker .ss-item', { hasText: 'Use' }).first();
    await custom.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check('T2 an unknown tag can still be created', (await custom.count()) > 0);
    await custom.click();
    await page.locator('.task-tag', { hasText: 'brand-new-tag' }).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    check(
      'T3 the created tag was saved',
      /brand-new-tag/.test(frontmatter('other-task')),
      frontmatter('other-task').match(/tags:.*/)?.[0],
    );
  }
} catch (err) {
  check('harness completes', false, err.message.split('\n')[0]);
} finally {
  await browser?.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
