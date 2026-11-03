#!/usr/bin/env node
/**
 * A project report page on a Super web card gets the dc- kit's RUNTIME, not just its CSS: a
 * `dc-graph` is laid out and draws its arrows, a `dc-tabs` switches (found 2026-11-03: the stage
 * drew a graph as a row of chips with no arrows, and its tabs did not switch, while the same
 * markup in a chat `dream-html` block worked).
 *
 *   npm run build && node scripts/verify/super-web-kit.mjs
 *   VERIFY_EXTRA_PAGE=<an .html file> node scripts/verify/super-web-kit.mjs   # also open a real page
 *
 * WHAT IT DRIVES: the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium, and a stand-in `claude` that, as the Super Agent, runs
 * `super open web _dream_context/tmp/kit/rapor.html` (no tokens spent). The page is fictional
 * ("Pocket Ledger"), brings NO `<style>` of its own (so the page default CSS applies, which is
 * where an svg used to lose its height), and holds a branching dc-graph of 4 nodes / 3 edges,
 * a dc-tabs of 3 tabs and a plain inline svg.
 *
 * WHAT IT PROVES, light and dark: the graph is laid out (nodes on more than one row and column),
 * draws 3 edge paths each with a non-zero box inside an svg taller than 0; tab 2 shows panel 2
 * and hides panel 1; a node click holds its trace; the plain svg still gets the page default (max-width 100%); the frame's
 * sandbox and CSP are unchanged. Screenshots: tmp/super-web-kit/. Exit 0 iff all pass.
 * With VERIFY_EXTRA_PAGE it also opens that page and REPORTS (never fails on) its graphs: svg
 * count per graph and whether a node click still lights its path (two engines would cancel).
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTheme, cleanEnv, freePort, readJson, readNd, reporter, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-web-kit-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = process.env.VERIFY_OUT || join(REPO, 'tmp', 'super-web-kit');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const EXTRA = process.env.VERIFY_EXTRA_PAGE || '';
/** VERIFY_PROBE_ENGINE=1: on a build whose frame lacks the engine, inject it by hand and print the svg it drew. */
const PROBE = process.env.VERIFY_PROBE_ENGINE === '1';
const PAGE = '_dream_context/tmp/kit/rapor.html';
const EXTRA_REF = EXTRA ? `_dream_context/tmp/kit/${basename(EXTRA)}` : '';

const MAIN = `
  if (text.startsWith('[super handover]')) { report({ kind: 'verb', steps: [cli('super', 'open', 'web', ${JSON.stringify(PAGE)})] }); return 'arranged'; }
  const m = text.match(/GO-CLI\\s+([^\\n]+)/);
  if (m) { report({ kind: 'verb', steps: [cli(...m[1].trim().split(/\\s+/))] }); return 'did'; }
  return 'ok';`;

const KIT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ledger report</title></head><body>
<div class="dc-doc">
  <h1 class="dc-h1">Where a receipt goes</h1>
  <div class="dc-graph" id="g">
    <div class="dc-node" id="scan">Scan receipt</div>
    <div class="dc-node dc-node--good" id="book">Book it</div>
    <div class="dc-node dc-node--warn" id="ask">Ask owner</div>
    <div class="dc-node dc-node--ghost" id="drop">Discard</div>
    <div class="dc-edge" data-from="scan" data-to="book" data-label="clear"></div>
    <div class="dc-edge" data-from="scan" data-to="ask" data-label="unclear"></div>
    <div class="dc-edge dc-edge--dashed" data-from="scan" data-to="drop"></div>
  </div>
  <div class="dc-tabs" id="t">
    <div class="dc-tablist"><button class="dc-tab dc-tab--on">Week</button><button class="dc-tab">Month</button><button class="dc-tab">Year</button></div>
    <div class="dc-panels">
      <div class="dc-panel dc-panel--on" id="p1"><p class="dc-p">Twelve receipts this week.</p></div>
      <div class="dc-panel" id="p2"><p class="dc-p">Forty receipts this month.</p></div>
      <div class="dc-panel" id="p3"><p class="dc-p">Five hundred receipts this year.</p></div>
    </div>
  </div>
  <svg id="plain" width="1200" height="60" viewBox="0 0 1200 60"><rect width="1200" height="60" class="dc-f1"></rect></svg>
</div>
</body></html>`;

const { result, ok, summary } = reporter();
const env = () => cleanEnv(HOME);

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, '_dream_context', 'tmp', 'kit'), OUT]) mkdirSync(d, { recursive: true });
  // The handover button is the CLASSIC shell's Super tab; the new shell's way in is its drawer row.
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
  writeFileSync(join(PROJ, PAGE), KIT_PAGE);
  if (EXTRA) copyFileSync(EXTRA, join(PROJ, EXTRA_REF));
}

const idOf = (ref) => readJson(join(PROJ, '_dream_context', 'state', '.super-agent.json'), { containers: [] }).containers.find((c) => c.ref === ref)?.id;
const card = (page, id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(900));
async function frameOf(page, id) {
  const el = await card(page, id).locator('iframe.doc-reader-html-frame').first().elementHandle({ timeout: 20000 });
  return el.contentFrame();
}

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

/** A real click on a node: does it hold the trace? Two engines each toggling it would leave it dark. */
async function litOnClick(frame, sel) {
  const n = frame.locator(sel).first();
  if (!(await n.count())) return null;
  await n.scrollIntoViewIfNeeded();
  await n.click();
  await frame.page().waitForTimeout(250);
  const on = await n.evaluate((el) => el.classList.contains('dc-node--on'));
  await frame.page().keyboard.press('Escape');
  return on;
}

/** What the graph, tabs and plain svg look like inside the frame, measured. */
const readKit = (frame) => frame.evaluate(() => {
  const g = document.getElementById('g');
  const nodes = [...g.querySelectorAll('.dc-node')].map((n) => n.getBoundingClientRect());
  const svgs = [...g.querySelectorAll('svg.dc-graph-svg')];
  const svgBox = svgs[0]?.getBoundingClientRect();
  const paths = svgs.flatMap((s) => [...s.querySelectorAll('path.dc-edge-path')]).map((p) => p.getBoundingClientRect());
  const distinct = (xs) => new Set(xs.map((v) => Math.round(v / 4))).size;
  const vis = (id) => { const el = document.getElementById(id); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none'; };
  const plain = document.getElementById('plain');
  return {
    laid: g.hasAttribute('data-laid-width'),
    svgCount: svgs.length,
    svgH: svgBox ? Math.round(svgBox.height) : 0,
    svgW: svgBox ? Math.round(svgBox.width) : 0,
    paths: paths.length,
    pathsWithBox: paths.filter((b) => b.width > 0 || b.height > 0).length,
    rows: distinct(nodes.map((b) => b.top + b.height / 2)),
    cols: distinct(nodes.map((b) => b.left + b.width / 2)),
    panels: [vis('p1'), vis('p2'), vis('p3')],
    plainMaxW: getComputedStyle(plain).maxWidth,
    plainW: Math.round(plain.getBoundingClientRect().width),
    bodyW: Math.round(document.body.getBoundingClientRect().width),
  };
});

let server = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  const port = await freePort();
  setupScratch();
  server = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
  const base = `http://127.0.0.1:${port}`;
  browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  lastPage = page;
  const watch = watchPage(page, 'stage', { expected: [/Content Security Policy/] });

  console.log('\n── the Super Agent opens the report page as a web card');
  await openStage(page, base);
  ok('the page is on the stage', await until(page, async () => !!idOf(PAGE), 60000));
  await settle(page);
  const id = idOf(PAGE);
  ok('…drawn in its sandboxed frame', await until(page, async () => (await card(page, id).locator('iframe.doc-reader-html-frame').count()) > 0, 20000));
  const iframe = card(page, id).locator('iframe.doc-reader-html-frame').first();
  ok('the sandbox grant is unchanged (allow-scripts only, allow="")', (await iframe.getAttribute('sandbox')) === 'allow-scripts' && (await iframe.getAttribute('allow')) === '');
  const frame = await frameOf(page, id);
  const csp = await frame.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
  ok("the frame's CSP is unchanged (default-src 'none', no host)", csp.includes("default-src 'none'") && !/https?:|'self'|blob:/.test(csp), csp);
  await frame.waitForFunction(() => document.getElementById('g')?.hasAttribute('data-laid-width'), null, { timeout: 8000 }).catch(() => {});
  if (PROBE && !(await frame.evaluate(() => document.getElementById('g').hasAttribute('data-laid-width')))) {
    // A build without the kit runtime: run the engine by hand, to see what the page CSS does to its svg.
    await frame.evaluate(readFileSync(join(REPO, 'dashboard/src/components/sleepy/chat/chat-html-graph.js'), 'utf-8'));
    await page.waitForTimeout(800);
    const p = await frame.evaluate(() => { const s = document.querySelector('#g svg.dc-graph-svg'); return s && { attrH: s.getAttribute('height'), cssH: getComputedStyle(s).height, boxH: Math.round(s.getBoundingClientRect().height) }; });
    console.log(`  · PROBE engine injected by hand: svg ${JSON.stringify(p)}`);
  }

  for (const theme of ['light', 'dark']) {
    console.log(`\n── ${theme}`);
    await applyTheme(page, theme);
    await page.waitForTimeout(700);
    const k = await readKit(frame);
    console.log(`  · ${JSON.stringify(k)}`);
    ok(`${theme}: the graph is laid out (engine ran)`, k.laid, JSON.stringify(k));
    ok(`${theme}: its nodes sit on more than one row and column, not a row of chips`, k.rows >= 2 && k.cols >= 2, JSON.stringify(k));
    ok(`${theme}: one svg, taller and wider than 0`, k.svgCount === 1 && k.svgH > 0 && k.svgW > 0, JSON.stringify(k));
    ok(`${theme}: 3 edge paths, each with a non-zero box`, k.paths === 3 && k.pathsWithBox === 3, JSON.stringify(k));
    ok(`${theme}: a node click holds its trace (one engine, not two cancelling)`, (await litOnClick(frame, '#g .dc-node')) === true);
    ok(`${theme}: a plain page svg still gets the page default (max-width 100%, fits the body)`, k.plainMaxW === '100%' && k.plainW <= k.bodyW, JSON.stringify(k));
    await card(page, id).screenshot({ path: join(OUT, `${theme}-1-card.png`) });

    await frame.locator('.dc-tab').nth(1).click();
    await page.waitForTimeout(300);
    const t2 = (await readKit(frame)).panels;
    ok(`${theme}: tab 2 shows panel 2 and hides panel 1`, t2[1] && !t2[0] && !t2[2], JSON.stringify(t2));
    await frame.locator('#t').scrollIntoViewIfNeeded();
    await card(page, id).screenshot({ path: join(OUT, `${theme}-2-tab2.png`) });
    await frame.locator('.dc-tab').nth(0).click();
    await frame.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(OUT, `${theme}-3-stage.png`) });
  }
  await applyTheme(page, 'light');

  if (EXTRA) {
    console.log(`\n── the extra page (${EXTRA_REF}), reported`);
    const before = readNd(REPORTS).filter((r) => r.kind === 'verb').length;
    const input = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
    await input.click();
    await input.fill(`GO-CLI super open web ${EXTRA_REF}`);
    await page.keyboard.press('Enter');
    await until(page, async () => readNd(REPORTS).filter((r) => r.kind === 'verb').length > before, 40000);
    await settle(page);
    const xid = idOf(EXTRA_REF);
    ok('the extra page opens on the stage', await until(page, async () => (await card(page, xid).locator('iframe.doc-reader-html-frame').count()) > 0, 20000));
    const xf = await frameOf(page, xid);
    await page.waitForTimeout(2500);
    const x = await xf.evaluate(() => {
      const gs = [...document.querySelectorAll('.dc-graph, .dc-flow')];
      return gs.map((g) => ({
        laid: g.hasAttribute('data-laid-width'),
        svgs: g.querySelectorAll('svg.dc-graph-svg').length,
        svgH: Math.round(g.querySelector('svg.dc-graph-svg')?.getBoundingClientRect().height ?? 0),
        edges: g.querySelectorAll('svg.dc-graph-svg path.dc-edge-path').length,
        labels: g.querySelectorAll('.dc-edge-label').length,
      }));
    });
    console.log(`  · graphs: ${JSON.stringify(x)}`);
    // A node click lights its path; two engines each toggling it would leave it dark.
    const lit = await litOnClick(xf, '.dc-graph .dc-node');
    console.log(`  · a node click lights it: ${lit}`);
    console.log(`  · REPORT (not a check): ${x.every((g) => g.svgs === 1) ? 'one svg per graph, no double drawing' : 'MORE THAN ONE svg in a graph: double drawing'}; node focus ${lit === false ? 'CANCELLED (two engines toggle it)' : 'works'}`);
    await card(page, xid).screenshot({ path: join(OUT, 'extra-card.png') });
    await xf.evaluate(() => document.querySelector('.dc-graph')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(500);
    await card(page, xid).screenshot({ path: join(OUT, 'extra-card-graph.png') });
  }

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
