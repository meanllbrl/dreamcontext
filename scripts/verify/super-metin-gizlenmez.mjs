#!/usr/bin/env node
/**
 * Every text block the Super writes in a turn is on the owner's screen (owner 2026-11-07,
 * "hani nerede?"). One Super turn shaped like the one he reported: a long summary as text, then
 * tool steps, then a one-line closing text. At 1440 and 390, dark:
 *   0 while it streams its opening thinking, the live line stays (nothing goes blank);
 *   1 while the turn runs, the long text is visible once the steps start;
 *   2 once the turn lands, the long text and the closing line are both visible, in that order,
 *     and the quiet steps line is put away as before;
 *   3 after a reload (the transcript replay path) both are still visible, in order;
 *   2c/3b a thinking block (whose summary can carry a paraphrase of the Super's words and the
 *     summarizer's own note, Tilki 2026-11-07) is never drawn on the Super's screen.
 *
 *   npm run build && node scripts/verify/super-metin-gizlenmez.mjs [outDir] [prefix]
 *
 * The real dashboard server from dist (scratch HOME) and a scripted stand-in `claude` playing
 * main Super; no tokens are spent. Console errors are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, reporter, sayOnStage, stage, startServer, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-metin-gizlenmez-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'super-metin-gizlenmez'));
const PREFIX = process.argv[3] || 'after';

const LONG_MARK = 'Kuruldu (0.9.4)';
const SHORT_MARK = 'Dökümü yukarıda';
const LEAK_MARK = 'Bu üç blok da Claude kendi önceki metni';
const env = () => cleanEnv(HOME);
const { ok, summary, result } = reporter();

/** Main Super's turn: a streamed thinking opening, a long summary as text, two slow steps, a
 *  thinking summary, then the one closing line. */
const MAIN = `
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  for (const piece of ['Önce durumu ', 'okuyorum, ', 'sonra özet.']) {
    await sleep(700);
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: piece } } });
  }
  await sleep(700);
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  const long = [
    '**${LONG_MARK}:** banner metni yayında, ödeme sayfasındaki yazım hatası düzeldi.',
    '',
    '**Bitti, kurulumu bekliyor:**',
    '- **Sepet:** boş sepette görünen hata kalktı, testten geçti.',
    '- **Kampanya:** indirim kodu büyük küçük harf ayırmadan kabul ediliyor.',
    '- **Arama:** Türkçe karakterli ürün adları artık bulunuyor (ğ, ş, ı, İ).',
    '',
    '**Sürüyor:** stok uyarısı e-postası; inceleme bekliyor.',
  ].join('\\n');
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long }] } });
  row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long }] } });
  await sleep(1500);
  const steps = [
    ['Bash', { command: 'dreamcontext tasks list -s todo', description: 'List open tasks' }, 'Tasks: 2'],
    ['Bash', { command: 'dreamcontext tasks log launch-banner "Owner: summary sent"' }, '✓ Logged to launch-banner'],
  ];
  for (const [name, input, result] of steps) {
    const id = 'toolu_' + Math.random().toString(36).slice(2);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    await sleep(2500);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } });
    row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } });
    await sleep(1500);
  }
  // The shape of Tilki's turn (2026-11-07): a thinking block whose summary carries the
  // summarizer's own note and a paraphrase of the Super's words. It is not the Super's text.
  const th = [{ type: 'thinking', thinking: '${LEAK_MARK}; üç ayrı narration değil, tek bir kısa yeniden yazım. Banner yayında.', signature: 'sig' }];
  out({ type: 'assistant', message: { role: 'assistant', content: th } });
  row({ type: 'assistant', message: { role: 'assistant', content: th } });
  await sleep(1500);
  return '${SHORT_MARK}. Hangisini önce kuralım?';
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

/** Where each marked text sits among the stage's assistant rows (-1 = not drawn) and whether it is visible. */
function readTexts(s) {
  return s.evaluate((root, marks) => {
    const rows = [...root.querySelectorAll('.chat-msg-assistant-row')];
    const at = (m) => rows.findIndex((r) => r.textContent?.includes(m));
    const shown = (m) => {
      const r = rows.find((x) => x.textContent?.includes(m));
      if (!r) return false;
      const b = r.getBoundingClientRect();
      return b.height > 8 && getComputedStyle(r).visibility !== 'hidden' && getComputedStyle(r).display !== 'none';
    };
    return {
      long: at(marks[0]), short: at(marks[1]), longShown: shown(marks[0]), shortShown: shown(marks[1]),
      leak: root.textContent?.includes(marks[2]) ?? false,
      thoughtBox: [...root.querySelectorAll('*')].some((el) => el.children.length === 0 && /Thought it through|Thinking it through/.test(el.textContent ?? '')),
      stepsLine: root.querySelectorAll('[data-testid="super-steps-line"], [data-testid="super-live-line"]').length,
    };
  }, [LONG_MARK, SHORT_MARK, LEAK_MARK]);
}

async function run(base, width, height) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
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
  const s = stage(page, 'main');
  await sayOnStage(page, 'main', `Bitti mi her şey, neler yaptın özetle (${width})`);

  // 0 while it streams its thinking (before any step), the live Thinking line holds the turn.
  const opening = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(300);
    opening.push(await s.evaluate((root) => ({
      line: root.querySelectorAll('[data-testid="super-live-line"], [data-testid="super-steps"][data-live]').length,
      pill: root.querySelectorAll('.chat-working').length,
    })));
  }
  ok(`${width} 0 while the Super thinks, its live line stays on screen`, opening.every((x) => x.line + x.pill > 0), JSON.stringify(opening));
  await page.screenshot({ path: join(OUT, `${PREFIX}-thinking-${width}.png`) });

  // 1 mid-turn: a step is running and the long text stands above it.
  ok(`${width} a step starts`, await until(page, async () => (await s.locator('[data-testid="super-steps"][data-live], [data-testid="super-live-line"]').count()) > 0, 15000));
  await page.waitForTimeout(1200);
  const mid = await readTexts(s);
  await page.screenshot({ path: join(OUT, `${PREFIX}-during-${width}.png`) });
  ok(`${width} 1 during the steps the long text is visible`, mid.long >= 0 && mid.longShown, JSON.stringify(mid));

  // 2 landed: both texts, in order; the quiet line put away.
  ok(`${width} the closing line lands`, await until(page, async () => (await readTexts(s)).short >= 0, 20000));
  await page.waitForTimeout(1200);
  await page.mouse.move(5, 5);
  const landed = await readTexts(s);
  await page.screenshot({ path: join(OUT, `${PREFIX}-landed-${width}.png`) });
  ok(`${width} 2 after the turn both texts are visible, long first`, landed.longShown && landed.shortShown && landed.long >= 0 && landed.long < landed.short, JSON.stringify(landed));
  ok(`${width} 2c no thinking box and no summarizer note on the Super's screen`, !landed.leak && !landed.thoughtBox, JSON.stringify(landed));
  ok(`${width} 2b the quiet steps line is put away as before`, landed.stepsLine === 0, JSON.stringify(landed));

  // 3 reload: the transcript replay draws the same.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  if (width !== 1440) { await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(500); }
  await toMainStage(page);
  if (width !== 1440) { await page.setViewportSize({ width, height }); await page.waitForTimeout(800); }
  ok(`${width} replay draws the turn`, await until(page, async () => (await readTexts(stage(page, 'main'))).short >= 0, 15000));
  await page.waitForTimeout(800);
  const replay = await readTexts(stage(page, 'main'));
  await page.screenshot({ path: join(OUT, `${PREFIX}-reloaded-${width}.png`) });
  ok(`${width} 3 after a reload both texts are visible, long first`, replay.longShown && replay.shortShown && replay.long < replay.short, JSON.stringify(replay));
  ok(`${width} 3b after a reload no thinking box and no summarizer note`, !replay.leak && !replay.thoughtBox, JSON.stringify(replay));

  ok(`${width} no console errors`, watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok(`${width} no failed requests`, watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  await context.close();
  await browser.close();
}

async function main() {
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
  console.log(summary());
  process.exit(result.fails.length ? 1 : 0);
}

main();
