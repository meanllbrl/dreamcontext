#!/usr/bin/env node
/**
 * "Send to backlog" and the tag picker, proven against the real server.
 *
 *   node scripts/verify/task-backlog-and-tags.mjs
 *
 * WHY: backlog is a TAG, not a status, so putting a task there meant typing
 * `backlog` by hand into a free-text box — and typing tags by hand is exactly
 * how this vault ended up with both `decisions` and `decision` in its
 * vocabulary. Two things are checked, and the second is the one a unit test
 * cannot reach: that the tag the button writes actually triggers the BACKEND's
 * "backlog ⇒ undated" rule, rather than the UI keeping its own private copy of
 * that rule.
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
seed('shelve-me', 'Shelve me', []);
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
      await page.waitForTimeout(1200);
      await dismissAnnouncements();
      await page.locator('.sidebar-item', { hasText: 'Tasks' }).first().click();
      await page.waitForTimeout(1200);
    };

    // B1 — the quick action exists and writes the tag.
    await openBoard();
    await page.locator('.bd-card', { hasText: 'Shelve me' }).first().click({ button: 'right' });
    await page.waitForTimeout(700);
    const row = page.locator('.bd-row', { hasText: 'Send to backlog' }).first();
    check('B1 the context menu offers "Send to backlog"', (await row.count()) > 0);
    await row.click();
    await page.waitForTimeout(1800);

    const fm = frontmatter('shelve-me');
    check('B2 the backlog tag was written', /backlog/.test(fm), fm.match(/tags:.*/)?.[0]);
    // B3 is the real point: the UI wrote only a tag, and the BACKEND undated it.
    check(
      'B3 the backend cleared both dates (backlog ⇒ undated)',
      !/due_date: '2026/.test(fm) && !/start_date: '2026/.test(fm),
      fm.match(/due_date:.*/)?.[0],
    );

    // B4 — the row is gone once the task is already there, rather than a no-op.
    await openBoard();
    await page.locator('.bd-card', { hasText: 'Shelve me' }).first().click({ button: 'right' });
    await page.waitForTimeout(700);
    check(
      'B4 the row hides for a task already in backlog',
      (await page.locator('.bd-row', { hasText: 'Send to backlog' }).count()) === 0,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // T1/T2 — the tag picker lists what the vault already knows, and can create.
    await openBoard();
    await page.locator('.bd-card', { hasText: 'Other task' }).first().click();
    await page.waitForTimeout(1400);
    const labels = page.locator('.task-section-header, .task-section', { hasText: 'Labels' }).first();
    if (await labels.count()) { await labels.click().catch(() => {}); await page.waitForTimeout(500); }
    const picker = page.locator('.task-tag-picker .ss-trigger').first();
    await picker.waitFor({ state: 'visible', timeout: 8000 });
    await picker.click();
    await page.waitForTimeout(600);
    const offered = await page.locator('.task-tag-picker .ss-item').allTextContents();
    check(
      'T1 the picker offers tags the vault already uses',
      offered.some((t) => t.includes('backlog')),
      offered.slice(0, 6).join(' | ') || '(none)',
    );

    await page.locator('.task-tag-picker .ss-search').fill('brand-new-tag');
    await page.waitForTimeout(500);
    const custom = page.locator('.task-tag-picker .ss-item', { hasText: 'Use' }).first();
    check('T2 an unknown tag can still be created', (await custom.count()) > 0);
    await custom.click();
    await page.waitForTimeout(1800);
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
