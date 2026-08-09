#!/usr/bin/env node
/**
 * Delegate MODES — browser-level verification of the composer.
 *
 *   npm run build && npm run verify:delegate-modes
 *
 * The unit suite pins the prompts and the per-mode settings (tests/unit/delegate-modes.test.ts).
 * This proves the part a person actually touches: right-click a real task card, and the modal
 * offers four jobs — Autonomous / Discuss / Is it done? / Summarize — where picking one
 * REDRAFTS the prompt, re-arms the permission toggle to what that job needs, and (for Discuss)
 * promises to open on screen rather than in the corner. Plus the model picker, and the promise
 * that a mode switch never silently eats a prompt you had already edited.
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/api/tasks` + `/api/agent/*` routes,
 * and the real React board in Chromium, in BOTH themes.
 *
 * WHAT IT DOES NOT TOUCH — your machine, and no agent is ever spawned: every check stops at
 * the composer, before Delegate is pressed. Isolated fake HOME + scratch vault, and a `claude`
 * stand-in on that HOME's PATH purely so the capability probe reports the CLI as present.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST. Exit 0 iff every check in every theme passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dc-ui-delegate-modes');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-delegate-modes');

/** Enough of a `claude` to satisfy the capability probe; it is never actually driven here. */
const STANDIN = `#!${process.execPath}\nconsole.log('2.1.220 (Claude Code)');\n`;

const TASK = `---
id: task_VERIFY01
name: Ship the login screen
description: Ship the login screen
priority: high
urgency: high
status: in_progress
created_at: '2026-08-01'
updated_at: '2026-08-08'
tags:
  - 'layer:frontend'
version: null
---
## Why

Users cannot get into the app at all, so nothing else we ship is reachable.

## User Stories

- [ ] As a user, I can sign in with email and password.

## Acceptance Criteria

- [ ] **(A1)** The form validates and reports a wrong password without reloading.
- [ ] **(A2)** A successful sign-in lands on the board.
`;

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  writeFileSync(join(PROJ, '_dream_context', 'state', 'ship-the-login-screen.md'), TASK);

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

const report = { pass: 0, fail: 0 };
const check = (label, ok, ev = '') => {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
};

async function runTheme(base, theme) {
  console.log(`\n═══ ${theme} ═══`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => check(`no page error (${String(e).slice(0, 80)})`, false));

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const modal = page.locator('.modal:visible').filter({ hasText: 'Delegate to Claude' });
  const promptBox = modal.locator('textarea');
  const promptText = () => promptBox.inputValue();
  const chip = (name) => modal.getByRole('radio', { name, exact: true });
  const bypassBox = modal.locator('input[type=checkbox]');

  await page.goto(`${base}/?vault=proj&page=tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }

  // ENTRY — right-click the real card, take the menu item.
  const card = page.locator('.bd-card:visible').first();
  check('the task board renders the seeded task', await until(async () => (await card.count()) > 0, 20000));
  await card.click({ button: 'right' });
  const item = page.getByText('Delegate to Claude', { exact: true }).first();
  check('the context menu offers "Delegate to Claude"', await until(async () => (await item.count()) > 0, 8000));
  await item.click();
  check('the composer opens', await until(async () => (await modal.count()) > 0, 8000));

  // MODES — four jobs, autonomous first and selected.
  const chips = modal.getByRole('radio');
  const labels = await chips.allInnerTexts().catch(() => []);
  check('four modes are offered, in order', JSON.stringify(labels) === JSON.stringify(['Autonomous', 'Discuss', 'Is it done?', 'Summarize']),
    JSON.stringify(labels));
  check('it opens on Autonomous', (await chip('Autonomous').getAttribute('aria-checked')) === 'true');

  const autonomous = await promptText();
  check('the autonomous draft is the original brief', /drive it to completion, fully autonomously/.test(autonomous), autonomous.slice(0, 90));
  check('the draft carries the task body and its source file',
    autonomous.includes('Ship the login screen') && autonomous.includes('**(A1)**')
    && autonomous.includes('_dream_context/state/ship-the-login-screen.md'));
  check('autonomous arms bypass-permissions', await bypassBox.isChecked());
  await page.screenshot({ path: join(SHOTS, `autonomous-${theme}.png`) });

  // MODEL — the picker lists what the CLI offers.
  const models = await modal.locator('select option').allInnerTexts().catch(() => []);
  check('a model picker is offered, with the CLI default marked',
    models.length > 1 && models.some((m) => /\(default\)/.test(m)), JSON.stringify(models));

  // DISCUSS — redrafts, disarms bypass, promises to open on screen.
  await chip('Discuss').click();
  await page.waitForTimeout(300);
  const discuss = await promptText();
  check('picking Discuss redrafts the prompt', discuss !== autonomous);
  check('the discuss draft forbids editing and invites questions',
    /do NOT edit/i.test(discuss) && /questions you genuinely need/i.test(discuss), discuss.slice(0, 120));
  check('the same task body rides along unchanged',
    discuss.includes('Ship the login screen') && discuss.includes('**(A1)**'));
  check('discuss disarms bypass-permissions', !(await bypassBox.isChecked()));
  check('discuss says it will open in Agents rather than the corner',
    /opens in\s*Agents/i.test((await modal.innerText()).replace(/\s+/g, ' ')));
  await page.screenshot({ path: join(SHOTS, `discuss-${theme}.png`) });

  // IS IT DONE? — verifies without building, and can run commands unattended.
  await chip('Is it done?').click();
  await page.waitForTimeout(300);
  const verify = await promptText();
  check('the verify draft checks criteria without implementing them',
    /do NOT build/i.test(verify) && /acceptance criteria/i.test(verify), verify.slice(0, 120));
  check('verify re-arms bypass (it has to run the tests)', await bypassBox.isChecked());
  await page.screenshot({ path: join(SHOTS, `verify-${theme}.png`) });

  // SUMMARIZE — read-only.
  await chip('Summarize').click();
  await page.waitForTimeout(300);
  const summary = await promptText();
  check('the summarize draft is read-only and short by instruction',
    /Read-only/i.test(summary) && /under a minute/i.test(summary), summary.slice(0, 120));
  check('summarize leaves bypass off', !(await bypassBox.isChecked()));
  await page.screenshot({ path: join(SHOTS, `summarize-${theme}.png`) });

  // EDITED PROMPT — a mode switch offers it back instead of eating it.
  await promptBox.fill('MY OWN BRIEF — do exactly this.');
  await chip('Autonomous').click();
  await page.waitForTimeout(300);
  check('switching away from an edited prompt says so and offers a restore',
    (await modal.getByRole('button', { name: /Restore it/i }).count()) > 0);
  await page.screenshot({ path: join(SHOTS, `replaced-${theme}.png`) });
  await modal.getByRole('button', { name: /Restore it/i }).click();
  await page.waitForTimeout(300);
  check('restoring brings the edited text back', (await promptText()) === 'MY OWN BRIEF — do exactly this.');
  check('restoring brings its mode back too', (await chip('Summarize').getAttribute('aria-checked')) === 'true');
  await page.screenshot({ path: join(SHOTS, `restore-${theme}.png`) });

  // Switching with an UNTOUCHED draft is silent — no restore noise.
  await chip('Discuss').click();
  await page.waitForTimeout(200);
  await chip('Is it done?').click();
  await page.waitForTimeout(200);
  check('switching a pristine draft shows no restore notice',
    (await modal.getByRole('button', { name: /Restore it/i }).count()) === 0);

  // Nothing was ever delegated — the surface must hold no session.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('no agent was spawned by this run', (await page.locator('.agent-tab').count()) === 0);

  await browser.close();
}

(async () => {
  setup();
  const port = await freePort();
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const theme of ['dark', 'light']) await runTheme(base, theme);
  } finally {
    srv.kill();
  }
  console.log(`\n${report.fail === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fail} failed · shots: ${SHOTS}`);
  process.exit(report.fail === 0 ? 0 : 1);
})();
