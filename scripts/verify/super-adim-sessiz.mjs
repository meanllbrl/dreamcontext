#!/usr/bin/env node
/**
 * The Super Agent's tool steps as one quiet line (owner 2026-11-06, draft A), at 1440 dark:
 *   1 while the turn runs: one line, a ring and the step in hand, its height fixed;
 *   2 once it lands: a grey chip "N steps · T", the answer under it, no step cards;
 *   3 a click opens the same rows, a second click closes them;
 *   4 a failed step is counted on the chip and drawn in full under it.
 *
 *   npm run build && node scripts/verify/super-adim-sessiz.mjs [outDir]
 *
 * The real dashboard server from dist (scratch HOME) and a scripted stand-in `claude` that plays
 * main Super: it emits real stream-json tool calls (mostly `dreamcontext` ones, as Super does).
 * No tokens are spent. Console errors and failed requests are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, reporter, sayOnStage, stage, startServer, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-adim-sessiz-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'super-adim-sessiz'));

const env = () => cleanEnv(HOME);
const { ok, summary } = reporter();

/** Main Super's turn: tool calls as Claude streams them. "hata" in the message makes one fail. */
const MAIN = `
  const fail = /hata/i.test(text);
  const steps = fail ? [
    ['Read', { file_path: 'notes/launch.md' }, '12 lines', false],
    ['Bash', { command: 'dreamcontext tasks list -s todo', description: 'List open tasks' }, 'Tasks: 2', false],
    ['Bash', { command: 'dreamcontext tasks status checkout-copy-pass in_progress' }, '✗ Task not found: checkout-copy-pass', false],
    ['Bash', { command: 'dreamcontext tasks log launch-banner "Owner: banner copy approved"' }, '✓ Logged to launch-banner', false],
  ] : [
    ['Read', { file_path: 'notes/launch.md' }, '12 lines', false],
    ['Bash', { command: 'dreamcontext tasks list -s todo', description: 'List open tasks' }, 'Tasks: 2', false],
    ['Bash', { command: 'dreamcontext tasks log launch-banner "Owner: banner copy approved"' }, '✓ Logged to launch-banner', false],
    ['Bash', { command: 'dreamcontext tasks status launch-banner completed' }, '✓ Status: completed', false],
    ['Bash', { command: 'dreamcontext tasks create "Checkout copy pass" --priority high' }, '✓ Task created: checkout-copy-pass.md', false],
    ['Bash', { command: 'dreamcontext memory recall "launch banner"' }, '3 hits', false],
    ['Bash', { command: 'dreamcontext bookmark add "Banner approved"' }, '✓ Bookmarked', false],
  ];
  const hold = /yavas/i.test(text) ? 1600 : 120;
  for (let i = 0; i < steps.length; i++) {
    const [name, input, result, isError] = steps[i];
    const id = 'toolu_' + Math.random().toString(36).slice(2);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    await sleep(hold);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } });
    await sleep(60);
  }
  return fail
    ? "Görevi taşıyamadım: checkout-copy-pass yok. Yeni bir görev açayım mı?"
    : "Tamam. Banner onaylı olarak işlendi, checkout metni için yeni görev açıldı.";
`;

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: join(SCRATCH, 'reports.ndjson'), cli: CLI, main: MAIN }));
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk');
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await applyTheme(page, 'dark');
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  ok('main Super stage opens', await toMainStage(page));
  const s = stage(page, 'main');
  const lines = s.locator('[data-testid="super-steps"]');

  console.log('── 1 a running turn');
  await sayOnStage(page, 'main', 'Banner metnini onayladım, yavas ilerle');
  ok('1 the live line shows', await until(page, async () => (await s.locator('[data-testid="super-steps"][data-live]').count()) === 1, 30000));
  const heights = [];
  for (let i = 0; i < 6; i++) {
    const box = await s.locator('[data-testid="super-steps-line"]').last().boundingBox();
    if (box) heights.push(Math.round(box.height));
    if (i === 2) await page.screenshot({ path: join(OUT, '1-tur-suruyor-1440-dark.png') });
    await page.waitForTimeout(700);
  }
  ok('1 its height never changes while it runs', heights.length > 3 && heights.every((h) => h === heights[0]), heights.join(','));
  ok('1 no step card in the transcript', (await s.locator('.chat-transcript > .chat-toolcard, .chat-toolrun').count()) === 0);

  console.log('── 2 the landed turn');
  ok('2 the chip lands', await until(page, async () => (await lines.count()) === 1 && (await lines.first().getAttribute('data-live')) === null, 30000));
  const chip = (await s.locator('[data-testid="super-steps-line"]').first().innerText()).replace(/\s+/g, ' ').trim();
  ok('2 the chip reads "7 steps · N s"', /^7 steps · \d+ s/.test(chip), chip);
  ok('2 the answer is on screen', (await s.getByText('Banner onaylı olarak işlendi', { exact: false }).count()) > 0);
  const landedH = Math.round((await s.locator('[data-testid="super-steps-line"]').first().boundingBox())?.height ?? 0);
  ok('2 the chip keeps the live line\'s height', landedH === heights[0], `${landedH} vs ${heights[0]}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, '2-tur-bitti-1440-dark.png') });

  console.log('── 3 open and close');
  await s.locator('[data-testid="super-steps-line"]').first().click();
  ok('3 a click opens the seven rows', await until(page, async () => (await s.locator('[data-testid="super-steps-rows"] .chat-toolcard').count()) === 7, 5000));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, '3-acilmis-1440-dark.png') });
  await s.locator('[data-testid="super-steps-line"]').first().click();
  ok('3 a second click closes them', await until(page, async () => (await s.locator('[data-testid="super-steps-rows"]').count()) === 0, 5000));

  console.log('── 4 a failed step');
  await sayOnStage(page, 'main', 'Checkout görevini taşı (hata)');
  ok('4 the second chip lands', await until(page, async () => (await lines.count()) === 2 && (await lines.nth(1).getAttribute('data-live')) === null, 30000));
  const chip2 = (await s.locator('[data-testid="super-steps-line"]').nth(1).innerText()).replace(/\s+/g, ' ').trim();
  ok('4 the chip counts the failure', /4 steps · \d+ s · 1 failed/.test(chip2), chip2);
  ok('4 the failed step stands under the line', await until(page, async () => (await lines.nth(1).locator('[data-testid="super-steps-errors"] .chat-toolcard[data-status="error"]').count()) === 1, 5000));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, '4-hata-disarida-1440-dark.png') });

  await applyTheme(page, 'light');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '5-acik-tema-1440-light.png') });

  ok('no console errors', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('no failed requests', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  await browser.close();
}

async function main() {
  let srv = null;
  try {
    setup();
    const port = await freePort();
    srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
    await run(`http://127.0.0.1:${port}`);
  } catch (e) { ok('ran to the end', false, e?.stack ?? e); }
  finally { srv?.kill(); rmSync(SCRATCH, { recursive: true, force: true }); }
  console.log(`\nscreenshots: ${OUT}`);
  process.exit(summary() ? 0 : 1);
}

main();
