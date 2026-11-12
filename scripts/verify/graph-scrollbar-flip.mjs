#!/usr/bin/env node
/**
 * The kit's dc-graph settles on a page whose height straddles its frame's scroll threshold
 * (owner 2026-11-12: a report page on a Super card re-laid its graph every ~175 ms and jumped
 * back to its top). With CLASSIC scrollbars (a Mac with a mouse paired: 15 px), a layout that
 * moves the page's height across the threshold brings the bar or takes it away, which moves
 * the graph's width, which asks for a layout again.
 *
 *   node scripts/verify/graph-scrollbar-flip.mjs                 WebKit, the desktop app's engine
 *   VERIFY_ENGINE=chromium node scripts/verify/graph-scrollbar-flip.mjs
 *   VERIFY_MUTATE=no-hold …       the engine with the re-layout's height hold taken out (must FAIL)
 *
 * WHAT IT DRIVES: the kit's own CSS and graph engine (chat-html-kit.css, chat-html-graph.js),
 * as written, in a bare page at 600x900, a classic 15 px scrollbar, a top-down graph of seven
 * nodes and a spacer under it. The spacer sweeps the page's height across the window's in 3 px
 * steps, so some step lands where one layout's height has a bar and the other's has none.
 *
 * WHAT IT PROVES: at every step, after the first second, the graph is laid out at most once more
 * over the next 2 s (no loop), and a page scrolled to its bottom is still there 2 s later.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = process.env.VERIFY_ENGINE === 'chromium' ? 'chromium' : 'webkit';
const MUTATE = process.env.VERIFY_MUTATE || '';
const CSS = readFileSync(join(REPO, 'dashboard/src/components/sleepy/chat/chat-html-kit.css'), 'utf-8');
let JS = readFileSync(join(REPO, 'dashboard/src/components/sleepy/chat/chat-html-graph.js'), 'utf-8');
if (MUTATE === 'no-hold') JS = JS.replace("var held = g.classList.contains(LAID) ? g.offsetHeight : 0;", 'var held = 0;');
const BAR = '::-webkit-scrollbar{width:15px;height:15px}::-webkit-scrollbar-thumb{background:#5a5b66}::-webkit-scrollbar-track{background:#e4e4ea}';

const page = (spacer) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style><style>${BAR} body{margin:0;padding:16px}</style></head><body>
<div class="dc-doc">
  <h1 class="dc-h1">Ledger sync: going live</h1>
  <div class="dc-graph" id="g">
    <div class="dc-node" id="a">Merge the PR</div>
    <div class="dc-node" id="b">Database change</div>
    <div class="dc-node" id="c">Two keys + setting</div>
    <div class="dc-node dc-node--accent" id="d">Ship by hand</div>
    <div class="dc-node dc-node--decision" id="e">Health check</div>
    <div class="dc-node dc-node--good" id="f">Three-person pilot</div>
    <div class="dc-node dc-node--bad" id="h">Roll back</div>
    <div class="dc-edge" data-from="a" data-to="b"></div>
    <div class="dc-edge" data-from="b" data-to="c"></div>
    <div class="dc-edge" data-from="c" data-to="d"></div>
    <div class="dc-edge" data-from="d" data-to="e"></div>
    <div class="dc-edge" data-from="e" data-to="f" data-label="clean"></div>
    <div class="dc-edge" data-from="e" data-to="h" data-label="problem"></div>
  </div>
  <div id="spacer" style="height:${spacer}px"></div>
</div>
<script>window.__layouts = 0; new MutationObserver(function () { window.__layouts += 1; }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-laid-width'] });</script>
<script>${JS}</script>
</body></html>`;

const pw = await import('@playwright/test');
const browser = await pw[ENGINE].launch();
const ctx = await browser.newContext({ viewport: { width: 600, height: 900 } });
const tab = await ctx.newPage();
let fails = 0;
let worst = { spacer: null, layouts: 0, drop: 0 };
try {
  // Where the page's height meets the window's, with no spacer.
  await tab.setContent(page(0));
  await tab.waitForTimeout(800);
  const base = await tab.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  const vh = 900;
  const from = Math.max(0, vh - base - 90);
  const to = vh - base + 90;
  console.log(`\n── ${ENGINE}${MUTATE ? ` (mutated: ${MUTATE})` : ''}: page ${base}px with no spacer, window ${vh}px; spacer ${from}..${to} px`);
  let steps = 0;
  for (let s = from; s <= to; s += 3) {
    steps += 1;
    await tab.setContent(page(s));
    await tab.waitForTimeout(1000);
    const start = await tab.evaluate(() => window.__layouts);
    // Scrolled to the bottom, if there is one: does it stay there?
    const y0 = await tab.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); return Math.round(window.scrollY); });
    await tab.waitForTimeout(2000);
    const r = await tab.evaluate(() => ({ layouts: window.__layouts, y: Math.round(window.scrollY) }));
    const more = r.layouts - start;
    const drop = Math.max(0, y0 - r.y);
    if (more > worst.layouts || drop > worst.drop) worst = { spacer: s, layouts: Math.max(more, worst.layouts), drop: Math.max(drop, worst.drop) };
    if (more > 1 || drop > 20) {
      fails += 1;
      if (fails <= 6) console.log(`  ✗ spacer ${s}px: ${more} layouts in 2 s, scroll ${y0} → ${r.y}`);
    }
  }
  if (steps < 20) { fails += 1; console.log(`  ✗ only ${steps} heights tried: the sweep never crossed the window's height`); }
  console.log(`  · ${steps} heights tried; worst: ${JSON.stringify(worst)}`);
  console.log(fails ? `  ✗ ${fails} heights kept re-laying the graph or lost the scroll` : '  ✓ at every height the graph settles (≤ 1 more layout in 2 s) and the page keeps its scroll');
} finally {
  await browser.close();
}
process.exit(fails ? 1 : 0);
