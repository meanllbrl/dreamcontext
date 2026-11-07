#!/usr/bin/env node
/**
 * The composer, made roomier (owner 2026-11-07), on the Super Agent's stage at 1440 and 390 px:
 *   1 the checkout chip (`main`) sits in the composer's bottom row, right after the `+`, and the
 *     shelf row it used to stand on alone above the composer is gone;
 *   2 while Claude works, with text typed, the composer shows TWO discs (Stop and the filled
 *     Send), never the hollow queue disc, and the row fits a 390 px phone without overflow.
 *
 *   npm run build && node scripts/verify/composer-sade.mjs [outDir]
 *
 * The real dashboard server from dist (scratch HOME) and a scripted stand-in `claude` that holds
 * main Super's turn open, so the composer stays in its working state. No tokens are spent.
 * Console errors and failed requests are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, reporter, sayOnStage, stage, stageComposer, startServer, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-composer-sade-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'composer-sade'));
const TAG = process.argv[3] || 'sonra';

const env = () => cleanEnv(HOME);
const { ok, summary } = reporter();

/** Main Super's turn: one step, then HOLD (null), so the chat stays working. */
const MAIN = `
  const id = 'toolu_' + Math.random().toString(36).slice(2);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'dreamcontext tasks list', description: 'List tasks' } }] } });
  await sleep(200);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Tasks: 2', is_error: false }] } });
  return null;
`;

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q', '-b', 'main'], { encoding: 'utf-8' });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: join(SCRATCH, 'reports.ndjson'), cli: CLI, main: MAIN }));
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}

/** Where the checkout chip is, and what the composer's discs are. */
async function measure(page) {
  const s = stage(page, 'main');
  return s.evaluate((root) => {
    const card = root.querySelector('[data-super-slot="centre"] .chat-cmp-card') || root.querySelector('.chat-cmp-card');
    const toolbar = card?.querySelector('.chat-cmp-toolbar');
    const chip = [...root.querySelectorAll('.pin-chip')].find((el) => /\bmain\b/.test(el.textContent || ''));
    const plus = toolbar?.querySelector('button[aria-label="Attach"]');
    const discs = toolbar ? [...toolbar.querySelectorAll('.chat-cmp-send')].map((b) => b.className) : [];
    const shelf = root.querySelector('.pin-shelf');
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const cb = r(chip); const pb = r(plus); const tb = r(toolbar);
    // The chip's previous element sibling chain inside the toolbar: the first control before it.
    let before = chip?.closest('.chat-cmp-toolbar') ? chip.closest('.pin-inline')?.previousElementSibling : null;
    return {
      chipInToolbar: !!(chip && toolbar && toolbar.contains(chip)),
      chipAfterPlus: !!(before && plus && (before === plus || before.contains(plus))),
      chipRightOfPlus: !!(cb && pb && cb.left >= pb.right - 1 && Math.abs((cb.top + cb.bottom) / 2 - (pb.top + pb.bottom) / 2) < 6),
      shelfDrawn: !!shelf && r(shelf).height > 0,
      discs,
      toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : -1,
      chipFits: !!(cb && tb && cb.right <= tb.right + 1),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk');
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await applyTheme(page, 'light');
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  ok('main Super stage opens', await toMainStage(page));
  const s = stage(page, 'main');

  console.log('── a working turn, with the next message typed');
  await sayOnStage(page, 'main', 'Görevlere bak');
  ok('the stop disc shows (Claude works)', await until(page, async () => (await s.locator('.chat-cmp-send.is-stop').count()) === 1, 30000));
  const input = await stageComposer(page, 'main');
  await input.click();
  await input.fill('Sonra şunu da yap');
  ok('the checkout chip arrives', await until(page, async () => (await s.locator('.pin-chip', { hasText: 'main' }).count()) > 0, 20000));
  await page.waitForTimeout(500);

  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    const m = await measure(page);
    console.log(`   ${w}px`, JSON.stringify(m));
    ok(`${w} the branch chip sits in the composer's bottom row`, m.chipInToolbar);
    ok(`${w} …right after the +`, m.chipAfterPlus && m.chipRightOfPlus);
    ok(`${w} no shelf row of its own above the composer`, !m.shelfDrawn);
    ok(`${w} two discs while working: Stop and the filled Send`, m.discs.length === 2 && m.discs.some((c) => c.includes('is-stop')) && m.discs.some((c) => c.includes('is-enabled')), m.discs.join(' | '));
    ok(`${w} no hollow queue disc`, !m.discs.some((c) => c.includes('is-queue')));
    ok(`${w} the toolbar does not overflow`, m.toolbarOverflow <= 0 && m.chipFits, `overflow ${m.toolbarOverflow}`);
    ok(`${w} no sideways page overflow`, m.pageOverflow <= 0, `overflow ${m.pageOverflow}`);
    await page.screenshot({ path: join(OUT, `${TAG}-${w}.png`) });
    const card = s.locator('.chat-cmp-card').last();
    const box = await card.boundingBox();
    if (box) await page.screenshot({ path: join(OUT, `${TAG}-${w}-composer.png`), clip: { x: 0, y: Math.max(0, box.y - 90), width: w, height: Math.min(h, box.height + 100) } });
  }

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
