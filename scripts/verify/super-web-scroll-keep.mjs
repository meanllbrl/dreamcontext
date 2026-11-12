#!/usr/bin/env node
/**
 * A project report page on a Super web card keeps its scroll (owner 2026-11-12, a screen
 * recording: "there was a flicker and a bug here"; he wheeled down a presented report page, a
 * dc-graph ladder and the text under it, and about half a second after each wheel stopped the
 * page jumped back to its top, three times in five seconds).
 *
 *   npm run build && node scripts/verify/super-web-scroll-keep.mjs
 *   VERIFY_ENGINE=webkit …      the desktop app's engine (WKWebView)
 *   VERIFY_SCROLLBARS=overlay … no classic 15 px bar (the bug needs the bar)
 *   VERIFY_VIDEO=<dir> …        record the run as a video into <dir>
 *
 * WHAT IT DRIVES: the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard, a stand-in `claude` that as the Super Agent runs `super open web <page>` (no tokens).
 * The page is fictional ("Pocket Ledger" rollout plan): a heading, a top-down dc-graph of seven
 * nodes with one decision, then a list and two callouts, taller than the card.
 *
 * WHAT IT PROVES: with the card large, a real mouse wheel over the page scrolls it down; over the
 * next SAMPLE_MS the page's scroll never drops back toward the top, the frame is the same
 * document (a marker set in it survives) and nothing else moves it. A second and a third wheel
 * the same. Every scroll position sampled is written out. Exit 0 iff all pass.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, freePort, readJson, reporter, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-web-scroll-keep-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = process.env.VERIFY_OUT || join(REPO, 'tmp', 'super-web-scroll-keep');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const ENGINE = process.env.VERIFY_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const SAMPLE_MS = Number(process.env.VERIFY_SAMPLE_MS || 3000);
const PAGE = '_dream_context/tmp/kit/plan.html';

const MAIN = `
  if (text.startsWith('[super handover]')) { report({ kind: 'verb', steps: [cli('super', 'open', 'web', ${JSON.stringify(PAGE)})] }); return 'arranged'; }
  const busy = text.match(/GO-BUSY\\s+(\\d+)/);
  if (busy) {
    for (let i = 1; i <= Number(busy[1]); i++) {
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPER working, line ' + i + ': the page shows what changes.' }] } });
      await sleep(150);
    }
    return 'busy done';
  }
  const m = text.match(/GO-CLI\\s+([^\\n]+)/);
  if (m) { report({ kind: 'verb', steps: [cli(...m[1].trim().split(/\\s+/))] }); return 'did'; }
  return 'ok';`;

const PLAN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ledger sync: going live</title></head><body>
<div class="dc-doc">
  <h1 class="dc-h1">Ledger sync: going live</h1>
  <p class="dc-lede">Built, tests green, two review rounds clean. Going live and a three-person pilot need your yes.</p>
  <h2 class="dc-h2">What happens on yes</h2>
  <div class="dc-graph" id="g">
    <div class="dc-node" id="merge">Merge the PR</div>
    <div class="dc-node" id="db">Database change</div>
    <div class="dc-node" id="keys">Two keys + setting</div>
    <div class="dc-node dc-node--accent" id="ship">Ship by hand</div>
    <div class="dc-node dc-node--decision" id="health">Health check</div>
    <div class="dc-node dc-node--good" id="pilot">Three-person pilot</div>
    <div class="dc-node dc-node--bad" id="back">Roll back</div>
    <div class="dc-edge" data-from="merge" data-to="db"></div>
    <div class="dc-edge" data-from="db" data-to="keys"></div>
    <div class="dc-edge" data-from="keys" data-to="ship"></div>
    <div class="dc-edge" data-from="ship" data-to="health"></div>
    <div class="dc-edge" data-from="health" data-to="pilot" data-label="clean"></div>
    <div class="dc-edge" data-from="health" data-to="back" data-label="problem"></div>
  </div>
  <ul class="dc-list">
    <li><b>Database:</b> only new tables are added; existing rows are not touched.</li>
    <li><b>Ship:</b> only the sync service; going back is one earlier version.</li>
    <li><b>Pilot:</b> a few lines are added to three people's settings; removing them stops the flow.</li>
    <li><b>Cost:</b> the server stays up, about $20-50 a month. No model calls.</li>
  </ul>
  <h2 class="dc-h2">Two things to know</h2>
  <div class="dc-callout dc-callout--warn">Turning it on for everyone needs the account owner; the pilot is set by hand.</div>
  <div class="dc-callout">Not yet tried against the real client, only a test one. On day one the pilot checks two things.</div>
  <h2 class="dc-h2">Out of scope</h2>
  <p class="dc-p">The counters on the other side are a separate job.</p>
</div>
</body></html>`;

const { result, ok, summary } = reporter();
const env = () => cleanEnv(HOME);

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, '_dream_context', 'tmp', 'kit'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'classic' }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: REPORTS, cli: CLI, main: MAIN }));
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  writeFileSync(join(PROJ, PAGE), PLAN_PAGE);
}

const idOf = (ref) => readJson(join(PROJ, '_dream_context', 'state', '.super-agent.json'), { containers: [] }).containers.find((c) => c.ref === ref)?.id;
const card = (page, id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(900));

async function openStage(page, base) {
  await page.goto(`${base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await page.waitForTimeout(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
}

async function say(page, text) {
  const input = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

let server = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  const port = await freePort();
  setupScratch();
  server = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
  const base = `http://127.0.0.1:${port}`;
  browser = await pw[ENGINE].launch();
  const context = await browser.newContext({ viewport: { width: Number(process.env.VERIFY_W || 1440), height: Number(process.env.VERIFY_H || 900) }, colorScheme: 'light', ...(process.env.VERIFY_VIDEO ? { recordVideo: { dir: process.env.VERIFY_VIDEO, size: { width: Number(process.env.VERIFY_W || 1440), height: Number(process.env.VERIFY_H || 900) } } } : {}) });
  // The owner's Mac draws CLASSIC scrollbars (Automatic + a mouse paired): a bar that takes 15 px
  // of width. Headless engines draw none, so every frame gets one (VERIFY_SCROLLBARS=overlay: none).
  if (process.env.VERIFY_SCROLLBARS !== 'overlay') {
    await context.addInitScript(() => {
      const css = '::-webkit-scrollbar{width:15px;height:15px}::-webkit-scrollbar-thumb{background:#5a5b66;border-radius:8px}::-webkit-scrollbar-track{background:#e4e4ea}';
      const add = () => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); };
      if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
    });
  }
  const page = await context.newPage();
  lastPage = page;
  const watch = watchPage(page, 'stage', { expected: [/Content Security Policy/] });

  console.log(`\n── ${ENGINE}: the Super Agent opens a report page as a web card, then presents it`);
  await openStage(page, base);
  ok('the page is on the stage', await until(page, async () => !!idOf(PAGE), 60000));
  await settle(page);
  const id = idOf(PAGE);
  // A narrow window already shows the one card as a sheet over the chat; a wide one presents it.
  if ((await card(page, id).locator('[data-web-state="large"]').count()) === 0) {
    await say(page, `GO-CLI super present ${id}`);
    await page.waitForTimeout(2500);
    await settle(page);
  }
  ok('…drawn in its sandboxed frame', await until(page, async () => (await card(page, id).locator('iframe.doc-reader-html-frame').count()) > 0, 20000));
  const iframe = card(page, id).locator('iframe.doc-reader-html-frame').first();
  const frame = await (await iframe.elementHandle({ timeout: 20000 })).contentFrame();
  await frame.waitForFunction(() => document.getElementById('g')?.hasAttribute('data-laid-width'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // Everything that moves the page's scroll, from inside, with a stack.
  await frame.evaluate(() => {
    window.__keepMark = 'same-document';
    window.__log = [];
    const t0 = performance.now();
    const log = (what) => window.__log.push({ t: Math.round(performance.now() - t0), what, y: Math.round(window.scrollY), ih: window.innerHeight, iw: window.innerWidth, sh: document.documentElement.scrollHeight });
    window.addEventListener('scroll', () => log('scroll'));
    window.addEventListener('resize', () => log('resize'));
    window.__layouts = 0;
    new MutationObserver(() => { window.__layouts += 1; }).observe(document.getElementById('g'), { attributes: true, attributeFilter: ['data-laid-width'] });
    const orig = window.scrollTo.bind(window);
    window.scrollTo = function (...a) { log(`scrollTo(${JSON.stringify(a)}) ${new Error().stack.split('\n').slice(1, 4).join(' | ')}`); return orig(...a); };
  });
  const st = await card(page, id).getAttribute('data-web-state').catch(() => null);
  const box = await iframe.boundingBox();
  console.log(`  · card state ${await card(page, id).locator('[data-web-state]').first().getAttribute('data-web-state').catch(() => st)}, frame box ${JSON.stringify(box && { w: Math.round(box.width), h: Math.round(box.height) })}`);
  await page.waitForTimeout(2000);
  const idle = await frame.evaluate(() => window.__layouts);
  console.log(`  · graph layouts over 2 s with nobody touching the page: ${idle}`);
  ok('the graph is laid out once and holds still (no re-layout loop)', idle === 0, `${idle} layouts in 2 s`);
  const doc = await frame.evaluate(() => ({ ih: window.innerHeight, sh: document.documentElement.scrollHeight }));
  ok('the page is taller than its frame (it has somewhere to scroll)', doc.sh > doc.ih + 200, JSON.stringify(doc));
  await page.screenshot({ path: join(OUT, `${ENGINE}-0-top.png`) });

  const BUSY = process.env.VERIFY_BUSY === '1';
  for (let round = 1; round <= 3; round++) {
    // VERIFY_BUSY=1: the Super Agent's turn streams while the owner scrolls (the stage re-renders on each line).
    if (BUSY) { await say(page, 'GO-BUSY 40'); await page.waitForTimeout(400); }
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 60); await page.waitForTimeout(16); }
    await page.waitForTimeout(150);
    const after = await frame.evaluate(() => Math.round(window.scrollY));
    const samples = [];
    const end = Date.now() + SAMPLE_MS;
    while (Date.now() < end) { samples.push(await frame.evaluate(() => Math.round(window.scrollY)).catch(() => -1)); await page.waitForTimeout(50); }
    const low = Math.min(...samples);
    const same = await frame.evaluate(() => window.__keepMark).catch(() => null);
    console.log(`  · round ${round}: after the wheel y=${after}; over ${SAMPLE_MS} ms min y=${low}, last y=${samples.at(-1)}`);
    ok(`round ${round}: the wheel scrolled the page down`, after > 0, `y=${after}`);
    ok(`round ${round}: the page keeps that scroll (never drops back toward the top)`, low >= after - 2, `samples ${samples.join(',')}`);
    ok(`round ${round}: the frame is the same document (no reload)`, same === 'same-document', String(same));
    await page.screenshot({ path: join(OUT, `${ENGINE}-${round}-after.png`) });
  }
  const log = await frame.evaluate(() => window.__log).catch(() => []);
  writeFileSync(join(OUT, `${ENGINE}-scroll-log.json`), JSON.stringify(log, null, 1));
  const jumps = log.filter((e) => /^scrollTo|resize/.test(e.what));
  console.log(`  · resize / scrollTo events in the frame: ${jumps.length}${jumps.length ? `\n      ${jumps.slice(0, 8).map((e) => `${e.t}ms ${e.what} y=${e.y} ih=${e.ih} iw=${e.iw}`).join('\n      ')}` : ''}`);
  ok('no console errors', watch.errors.length === 0, watch.errors.slice(0, 5).join('\n'));
  await context.close();
} catch (e) {
  result.fails.push(`crashed: ${e?.stack || e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
console.log(`\n${summary()}. Screenshots: ${OUT}`);
process.exit(result.fails.length === 0 ? 0 : 1);
