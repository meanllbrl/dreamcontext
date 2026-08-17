#!/usr/bin/env node
/**
 * Task delete, end to end — does the button actually delete, and does saying no
 * actually stop it?
 *
 *   node scripts/verify/task-delete-confirm.mjs
 *
 * WHY THIS EXISTS: the delete buttons were dead in the desktop app and NOTHING
 * caught it. `window.confirm` returns `false` in that webview (wry's
 * WKUIDelegate implements no JavaScript panel methods, so WebKit shows no
 * dialog and answers no), which turned `if (!window.confirm(…)) return;` into an
 * unconditional early return. Unit tests never saw it because the call site was
 * never executed past the guard, and a browser tab never saw it because
 * `window.confirm` genuinely works there.
 *
 * `tests/unit/no-window-confirm.test.ts` guards the SOURCE (nobody reintroduces
 * `window.confirm`). This guards the BEHAVIOUR: with `confirmAction` in place,
 * a confirmed delete removes the task from disk and a cancelled one does not.
 *
 * WHAT IT CANNOT PROVE: that the native NSAlert sheet renders inside the real
 * .app. This drives Chromium, where `confirmAction` takes its browser fallback.
 * The desktop branch is covered by the source assertions in the unit test plus
 * `cargo check`; seeing the sheet needs the built app and a human.
 *
 * FAILURE POLICY — collect, don't fail fast: every check reports, then the
 * process exits non-zero if any failed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = process.env.PORT || '4793';
const URL = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Isolated scratch HOME — this test DELETES things, so it must never be able to
// reach the author's real vault.
const home = mkdtempSync(join(tmpdir(), 'dc-del-'));
const vaultDir = join(home, 'scratch');
const stateDir = join(vaultDir, '_dream_context', 'state');
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
mkdirSync(join(home, '.dreamcontext'), { recursive: true });
writeFileSync(
  join(home, '.dreamcontext', 'vaults.json'),
  JSON.stringify({ version: 1, vaults: [{ name: 'scratch', path: vaultDir }] }, null, 2),
);

const seedTask = (slug, name) => {
  writeFileSync(
    join(stateDir, `${slug}.md`),
    `---\nid: task_${slug}\nname: ${name}\ndescription: ${name}\n`
      + `priority: medium\nurgency: medium\nstatus: todo\ncreated_at: '2026-08-17'\n`
      + `updated_at: '2026-08-17'\ntags: []\nparent_task: null\nrelated_feature: null\n---\n\n`
      + `## Why\n\nSeeded by scripts/verify/task-delete-confirm.mjs.\n`,
  );
};
seedTask('doomed-task', 'Doomed task');
seedTask('spared-task', 'Spared task');

const onDisk = (slug) => existsSync(join(stateDir, `${slug}.md`));

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
    check('server boots', true, `${URL}/api/health`);
    check('both tasks seeded', onDisk('doomed-task') && onDisk('spared-task'));

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // The dialog verdict is what this whole file is about, so it is set per
    // check rather than once: `accept` is the user pressing Delete, `dismiss` is
    // the user pressing Cancel.
    let verdict = 'dismiss';
    page.on('dialog', (d) => (verdict === 'accept' ? d.accept() : d.dismiss()));

    await page.goto(`${URL}/?vault=scratch`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // A fresh vault has read no announcement, so the "What's New" popup opens
    // over everything and its scrim swallows pointer events at the window
    // level — every later click then fails as a 30s timeout that reads like a
    // broken button rather than a covered one.
    async function dismissAnnouncements() {
      for (let i = 0; i < 3; i += 1) {
        if (!(await page.locator('.announcements-modal-scrim').count())) return;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
      }
    }
    await dismissAnnouncements();
    check(
      'announcements popup dismissed',
      (await page.locator('.announcements-modal-scrim').count()) === 0,
    );

    // Board cards are `.bd-card` — read off the real DOM rather than guessed,
    // because a wrong selector here fails as a 30s timeout that looks like a
    // product bug.
    // Each scenario starts from a FRESH load. A cancelled delete leaves the
    // detail panel open over the board and Escape does not close it, so
    // reusing the page makes the second scenario fail on a covered card — a
    // harness artifact that reads exactly like the product bug under test.
    const openTask = async (label) => {
      await page.goto(`${URL}/?vault=scratch`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      await dismissAnnouncements();
      await page.locator('.sidebar-item', { hasText: 'Tasks' }).first().click();
      await page.waitForTimeout(1200);
      await page.locator('.bd-card', { hasText: label }).first().click();
      await page.waitForTimeout(1200);
    };

    const clickDelete = async () => {
      const btn = page.locator('button', { hasText: /^Delete task$/ }).first();
      await btn.waitFor({ state: 'visible', timeout: 8000 });
      await btn.click();
      await page.waitForTimeout(1800);
    };

    // D1 — cancelling must NOT delete. This is the half that a "just remove the
    // confirm entirely" fix would silently break.
    verdict = 'dismiss';
    await openTask('Spared task');
    await clickDelete();
    check('D1 cancelling the confirm leaves the task on disk', onDisk('spared-task'));

    // D2 — confirming must delete. The reported bug, inverted.
    verdict = 'accept';
    await openTask('Doomed task');
    await clickDelete();
    check('D2 confirming the delete removes the task from disk', !onDisk('doomed-task'));

    // D3 — it deleted the RIGHT one. A delete that takes the whole folder with
    // it would still pass D2.
    check(
      'D3 only the confirmed task was deleted',
      onDisk('spared-task') && !onDisk('doomed-task'),
      `state/: ${readdirSync(stateDir).filter((f) => f.endsWith('.md')).join(', ') || '(no task files)'}`,
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
