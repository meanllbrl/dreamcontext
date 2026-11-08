#!/usr/bin/env node
/**
 * The Super chat's separate "Working… 28s" pill goes; its time joins the quiet step line
 * (owner 2026-11-07). One running Super turn with thinking gaps (before the first step and
 * between steps) and slow tool steps, at 1440 and 390, dark:
 *   1 while the turn runs, no `.chat-working` pill is ever drawn in the Super stage;
 *   2 the live line is never empty and carries the turn's elapsed time at its end;
 *   3 between steps it reads "Thinking", during a step the step in hand;
 *   4 the line's top edge never moves while steps come and go (no layout jump);
 *   5 once the answer lands the line goes away, as before.
 *
 *   npm run build && node scripts/verify/super-working-satiri.mjs [outDir] [prefix]
 *
 * Run it on the old dist with prefix `before` for the comparison shots (its checks go red there,
 * which is the point). The real dashboard server from dist (scratch HOME) and a scripted
 * stand-in `claude` playing main Super; no tokens are spent. Console errors are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, reporter, sayOnStage, stage, startServer, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-working-satiri-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'super-working-satiri'));
const PREFIX = process.argv[3] || 'after';

const env = () => cleanEnv(HOME);
const { ok, summary } = reporter();

/** Main Super's turn: think 2.5 s, then three slow steps with a 3 s thinking gap after each. */
const MAIN = `
  const steps = [
    ['Bash', { command: 'dreamcontext tasks list -s todo', description: 'List open tasks' }, 'Tasks: 2'],
    ['Bash', { command: 'dreamcontext tasks log launch-banner "Owner: banner copy approved"' }, '✓ Logged to launch-banner'],
    ['Bash', { command: 'dreamcontext tasks status launch-banner completed' }, '✓ Status: completed'],
  ];
  await sleep(2500);
  for (const [name, input, result] of steps) {
    const id = 'toolu_' + Math.random().toString(36).slice(2);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    await sleep(2500);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } });
    await sleep(3000);
  }
  return "Tamam. Banner onaylı olarak işlendi; görev kapandı.";
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

async function oneTurn(page, width, message) {
  const s = stage(page, 'main');
  await sayOnStage(page, 'main', message);
  const samples = [];
  let shotThinking = false;
  let shotStep = false;
  const t0 = Date.now();
  // Sample every 250 ms until the answer lands.
  while (Date.now() - t0 < 30000) {
    const snap = await s.evaluate((root) => {
      const pill = root.querySelectorAll('.chat-working').length;
      const lines = [...root.querySelectorAll('[data-testid="super-steps"][data-live], [data-testid="super-live-line"]')];
      const line = lines[lines.length - 1];
      const box = line?.getBoundingClientRect();
      // The lowest edge of the live block (the line, or a pill under it): what the reader sees jump.
      const live = [...root.querySelectorAll('.chat-working'), ...(line ? [line] : [])].map((el) => el.getBoundingClientRect().bottom);
      const bottom = live.length ? Math.round(Math.max(...live)) : null;
      const answer = [...root.querySelectorAll('.chat-msg-assistant-row')].some((r) => r.textContent?.includes('Banner onaylı'));
      return { pill, lineText: line ? line.textContent.replace(/[▸▾]/g, '').trim() : null, top: box ? Math.round(box.top) : null, h: box ? Math.round(box.height) : null, bottom, answer };
    });
    samples.push(snap);
    if (snap.answer) break;
    const elapsed = Date.now() - t0;
    // A thinking gap: after the first step landed (≈ 5.5-8 s into the turn).
    if (!shotThinking && elapsed > 6200) { await page.screenshot({ path: join(OUT, `${PREFIX}-thinking-${width}.png`) }); shotThinking = true; }
    // A running step: the second step is in hand ≈ 8.5-11 s.
    if (!shotStep && elapsed > 9500) { await page.screenshot({ path: join(OUT, `${PREFIX}-step-${width}.png`) }); shotStep = true; }
    await page.waitForTimeout(250);
  }
  // From the first frame that shows the turn at all (a pill or a line), until the answer.
  const first = samples.findIndex((x) => x.pill || x.lineText !== null);
  const live = first < 0 ? [] : samples.slice(first).filter((x) => !x.answer);
  const withLine = live.filter((x) => x.lineText !== null);
  const linePhase = live.filter((x) => x.lineText !== null);
  ok(`${width} the answer lands`, samples.some((x) => x.answer));
  ok(`${width} 1 no Working pill while the turn runs`, live.every((x) => x.pill === 0), `pill seen in ${live.filter((x) => x.pill).length}/${live.length} samples`);
  ok(`${width} 2 a live line in every sample, never empty, with the elapsed time`,
    live.length > 0 && live.every((x) => x.lineText && /\d+\s?(s|sn)\b/.test(x.lineText)),
    [...new Set(live.map((x) => x.lineText))].slice(0, 12).join(' | '));
  ok(`${width} 3 "Thinking" between steps and a step in hand during one`,
    withLine.some((x) => /^Thinking/.test(x.lineText)) && withLine.some((x) => /…/.test(x.lineText)));
  const tops = linePhase.filter((x) => x.top !== null).map((x) => x.top);
  const heights = linePhase.filter((x) => x.h !== null).map((x) => x.h);
  ok(`${width} 4 the line never moves or changes height while the turn runs`,
    tops.length > 5 && tops.every((t) => t === tops[0]) && heights.every((h) => h === heights[0]),
    `tops ${[...new Set(tops)].join(',')} heights ${[...new Set(heights)].join(',')}`);
  const bottoms = live.filter((x) => x.bottom !== null).map((x) => x.bottom);
  ok(`${width} 4b the live block's lower edge never jumps (no pill coming and going)`,
    bottoms.length > 5 && bottoms.every((b) => b === bottoms[0]), `bottoms ${[...new Set(bottoms)].join(',')}`);
  ok(`${width} 5 the line goes away once the answer lands`, await until(page, async () => (await s.locator('[data-testid="super-steps-line"], [data-testid="super-live-line"]').count()) === 0, 8000));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${PREFIX}-landed-${width}.png`) });
}

async function run(base, width, height) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  {
    // Opened at desktop width (the side menu reaches the Super Agent there), then sized down.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await markAnnouncementsSeen(context, base);
    const page = await context.newPage();
    const watch = watchPage(page, String(width));
    await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
    await applyTheme(page, 'dark');
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
    ok(`${width} main Super stage opens`, await toMainStage(page));
    if (width !== 1440) { await page.setViewportSize({ width, height }); await page.waitForTimeout(800); }
    await oneTurn(page, width, `Banner metnini onayladım (${width})`);
    ok(`${width} no console errors`, watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
    ok(`${width} no failed requests`, watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
    await context.close();
  }
  await browser.close();
}

async function main() {
  // A fresh scratch and server per width: a second page on one server re-attaches the same turn.
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    let srv = null;
    try {
      setup();
      const port = await freePort();
      srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
      await run(`http://127.0.0.1:${port}`, width, height);
    } catch (e) { ok(`${width} ran to the end`, false, e?.stack ?? e); }
    finally { srv?.kill(); rmSync(SCRATCH, { recursive: true, force: true }); }
  }
  console.log(`\nscreenshots: ${OUT}`);
  process.exit(summary() ? 0 : 1);
}

main();
