#!/usr/bin/env node
/**
 * A reply the Super wrote for the owner is drawn in place, whatever steps surround it
 * (owner 2026-11-14, "hani? mesela bak anlatmamış ama anlattım diyor"), at 1440 dark:
 *   1 his turn: a long `<!-- re:… -->` reply written BEFORE the last tool call of the turn
 *     (the shape of the dreamcontext Super's five-part answer) stays on screen;
 *   2 an event turn the window shows in full (a job he started finished): the reply after the
 *     steps is on screen;
 *   3 an event turn the window FOLDS into one line (a job the Super started on its own finished)
 *     whose reply is marked for him: the reply is drawn under the line, the steps stay folded.
 *     Today's code folds the reply away with the steps, while the server counts it as told.
 *
 *   npm run build && node scripts/verify/super-cevap-katlanmaz.mjs [outDir]
 *   VERIFY_CLI=<package>/dist/index.js runs it against another build (a before/after pair).
 *
 * The real dashboard server from dist (scratch HOME) and a scripted stand-in `claude` (no tokens,
 * fictional "acme-storefront"). Console errors and failed requests are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, reporter, sayOnStage, stage, startServer, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-cevap-katlanmaz-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const CLI = process.env.VERIFY_CLI ? resolve(process.env.VERIFY_CLI) : join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'super-cevap-katlanmaz'));

const env = () => cleanEnv(HOME);
const { ok, summary } = reporter();

const LONG1 = 'BES-PARCA: **Banner:** onaylandı ve işlendi. **Ödeme sayfası:** metin geçişi için iş açıldı. **Kargo:** ücretsiz kargo eşiği 500 TL olarak kaldı. **Kampanya:** hafta sonu indirimini ertelemeyi öneriyorum. **Destek:** iki açık talep cevaplandı.';
const LONG2 = 'IS-SONUCU: **Stok sayımı bitti:** 42 üründen 3 tanesinde fark var, listesi hazır. En acil olanı kırmızı kazak, sistemde 12 görünüyor ama rafta 4 tane var.';
const LONG3 = 'KENDI-ISI: **Fiyat taraması bitti:** rakiplerden ikisi bu hafta kargo ücretini kaldırmış. Bizim eşiğimiz şimdilik en yükseği, istersen bunu ayrıca konuşalım.';

/** Main Super. Each step is streamed the way Claude Code streams it: a block per message. */
const MAIN = `
  const g = globalThis;
  const step = async (name, input, result) => {
    const id = 'toolu_' + Math.random().toString(36).slice(2);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    await sleep(120);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } });
    await sleep(60);
  };
  const say = (t) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const own = /<owner-msg ref="([a-z0-9]+)"/.exec(text);
  if (own) g.lastOwner = own[1];
  if (text.startsWith('[super handover]') || text.startsWith('[super recap]') || text.startsWith('[super fresh]')) return 'hazir';
  const first = text.split('\\n')[0];
  if (/BIRINCI/.test(first)) {
    await step('Bash', { command: 'dreamcontext tasks list -s todo' }, 'Tasks: 2');
    say('<!-- re:' + g.lastOwner + ' -->\\n' + ${JSON.stringify(LONG1)});
    await step('Bash', { command: 'dreamcontext tasks log launch-banner "Owner: approved"' }, '✓ Logged');
    return 'Ödeme sorusu ekranında, cevabını bekliyor.';
  }
  if (/IKINCI/.test(first)) {
    const r = cli('super', 'delegate', '--prompt', 'STOK-SAY', '--brief', 'Stok sayımı');
    report({ kind: 'delegated', which: 'owner', out: r.out.slice(0, 300) });
    return 'Stok sayımını başlattım.';
  }
  if (text.startsWith('[super events]')) {
    const ref = /ref=([a-z0-9]+)/.exec(text);
    g.events = (g.events || 0) + 1;
    await step('Bash', { command: 'dreamcontext super read child' }, 'report');
    await step('Bash', { command: 'dreamcontext tasks list' }, 'Tasks: 2');
    if (g.events === 1) {
      // The job HE started: its result, then a job of the Super's own (nobody waits on it).
      const r = cli('super', 'delegate', '--prompt', 'FIYAT-TARA', '--brief', 'Fiyat taraması');
      report({ kind: 'delegated', which: 'own', out: r.out.slice(0, 300) });
      return '\\n<!-- re:' + (ref ? ref[1] : g.lastOwner) + ' -->\\n' + ${JSON.stringify(LONG2)};
    }
    // Its own job finished: a reply marked for his last message.
    return '\\n<!-- re:' + g.lastOwner + ' -->\\n' + ${JSON.stringify(LONG3)};
  }
  return 'tamam';
`;

const CHILD = `
  await sleep(800);
  return /FIYAT/.test(text) ? 'Fiyat raporu hazır.' : 'Stok raporu hazır.';
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
  writeFileSync(bin, superStandin({ reports: join(SCRATCH, 'reports.ndjson'), cli: CLI, main: MAIN, child: CHILD }));
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}

const reports = () => { try { return readFileSync(join(SCRATCH, 'reports.ndjson'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return null; } };

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
  const drawn = (needle) => s.locator('.chat-msg-assistant-row', { hasText: needle });
  const toEnd = async () => { await s.locator('.chat-msg-assistant-row').last().scrollIntoViewIfNeeded().catch(() => {}); };
  const shot = async (name) => { await toEnd(); await page.mouse.move(5, 5); await page.waitForTimeout(400); await page.screenshot({ path: join(OUT, name) }); };

  console.log('── 1 his turn: a reply written before the last tool call');
  await sayOnStage(page, 'main', 'Beş şeyi sordum BIRINCI');
  ok('1 the turn lands', await until(page, async () => (await drawn('Ödeme sorusu ekranında').count()) === 1, 40000));
  await page.waitForTimeout(800);
  ok('1 the long reply before the tool call is drawn', (await drawn('BES-PARCA').count()) === 1);
  await shot('1-sahip-turu-1440-dark.png');

  console.log('── 2 a job he started finishes (an event turn shown in full)');
  await sayOnStage(page, 'main', 'Stok sayımını başlat IKINCI');
  ok('2 the child was delegated', await until(page, async () => reports().some((r) => r.kind === 'delegated' && r.which === 'owner'), 40000));
  ok('2 the result turn lands', await until(page, async () => reports().some((r) => r.kind === 'super-turn' && r.text.startsWith('[super events]')), 60000));
  ok('2 his result is drawn', await until(page, async () => (await drawn('IS-SONUCU').count()) === 1, 30000));
  await shot('2-sonuc-turu-1440-dark.png');

  console.log('── 3 a job of the Super\'s own finishes (an event turn folded into one line)');
  ok('3 the Super started its own job', await until(page, async () => reports().some((r) => r.kind === 'delegated' && r.which === 'own'), 30000));
  ok('3 its event turn ran', await until(page, async () => reports().filter((r) => r.kind === 'super-turn' && r.text.startsWith('[super events]')).length >= 2, 60000));
  await page.waitForTimeout(3000);
  const rec = record();
  const evTurns = reports().filter((r) => r.kind === 'super-turn' && r.text.startsWith('[super events]'));
  const lastBatch = /batch=(\S+)/.exec(evTurns.at(-1)?.text ?? '')?.[1];
  console.log(`   last event batch ${lastBatch}; ownerBatches ${JSON.stringify(rec?.ownerBatches)}`);
  ok('3 the server does NOT show that turn in full (it is a folded one)', !!lastBatch && !(rec?.ownerBatches ?? []).includes(lastBatch));
  ok('3 the reply marked for him is drawn', await until(page, async () => (await drawn('KENDI-ISI').count()) === 1, 10000));
  ok('3 its steps stay folded (no step card in the transcript)', (await s.locator('.chat-transcript > .chat-toolcard, .chat-toolrun').count()) === 0);
  await shot('3-katli-tur-1440-dark.png');

  await applyTheme(page, 'light');
  await page.waitForTimeout(500);
  await shot('3-katli-tur-1440-light.png');

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
  finally { srv?.kill(); if (!process.env.VERIFY_KEEP) rmSync(SCRATCH, { recursive: true, force: true }); }
  console.log(`\nscreenshots: ${OUT}`);
  process.exit(summary() ? 0 : 1);
}

main();
