#!/usr/bin/env node
/**
 * Insights v2 (boards of data-bound blocks) — end-to-end UI verification.
 *
 *   npm run build && npm run verify:lab-boards
 *   node scripts/verify/lab-boards.mjs --mutation=<name>    (see MUTATIONS below)
 *
 * Boots the REAL dashboard server from `dist/` on an isolated scratch vault
 * (fake HOME, no user state touched, no network: every insight is a local
 * `lab/scripts/*.mjs`), then drives it in WebKit (the engine the desktop
 * .app ships) with Playwright and proves every UI-observable acceptance
 * criterion of the Insights v2 task:
 *
 *   1. LEGACY OPEN: a vault with categories + groups + `.lab-prefs.json` opens
 *      on boards DERIVED one per category, in the saved tab order, the saved
 *      in-group card order honoured, every insight present and rendering as
 *      v1 (series, table, funnel, value, dataset/v1 table, html/v1, app/v1),
 *      and NOTHING under `lab/` written (byte snapshot) until the first edit.
 *      Opening that all-fresh board starts ZERO sync jobs.
 *   2. FIRST EDIT: one UI drag materializes EVERY derived board into
 *      `lab/boards/` at once, and the drag itself is in the file.
 *   3. EDIT MODE: drag + resize persist to `lab/boards/<slug>.md` and survive
 *      a reload; a drag burst never 409s; an external change -> 409 -> a
 *      conflict toast and the external edit survives (no silent overwrite);
 *      a PUT routed to 500 keeps the edit on screen with a retry toast, and
 *      Retry writes it.
 *   4. INSPECTOR: type, data and an option change without code, the board
 *      file reflects each, Cmd+Z undoes the last one in the file.
 *   5. CATALOG: every catalog block type renders from a fixture in light AND
 *      dark (and the theme visibly repaints it), and EVERY catalog option
 *      visibly changes the render: a variant card is compared with a
 *      baseline card of the same type and data by a geometry+paint
 *      signature (relative boxes, computed colors, svg geometry, text). A
 *      twin of each baseline must produce an IDENTICAL signature, so a
 *      "difference" is never noise. A catalog option with no case here is
 *      itself a failure (the catalog is read from `lab block list --json`).
 *   6. TABS switch panels; FILTER narrows the sibling table client-side with
 *      ZERO sync requests and a total that is the filtered one under `limit`.
 *   7. HTML BLOCKS: the full `dc-` kit applies inside the sandbox, the frame
 *      fills its grid cell (a taller cell = a taller frame), a declared input
 *      answers, an undeclared `lab.data()` name is refused, and a symlinked
 *      cache / `../` / `%2F` binding yields no data at board GET, at
 *      `lab board show` and inside the block. A library block (CLI-saved)
 *      is reused by `ref` on two cards on two boards; one saved from the UI
 *      is reused by `ref` too.
 *   8. FRESHNESS: the skip reason ("upstream unchanged", from a real
 *      probe run in setup) is on the card; the source's note renders as
 *      plain text.
 *   9. EMPTY STATE: a vault with no insights shows the showcase and its CTA
 *      creates a board on disk.
 *  10. SIDEBAR shows Insights as Beta; `.lab-prefs.json` keeps order /
 *      catOrder / category / collapsed / columns after use and gains
 *      activeBoard; NO `data-lab-placeholder` element and no stand-in slot
 *      text anywhere, in view mode, edit mode, inspector and add-card menu.
 *
 * The chart standard (task "blocks reach a polished, fully customizable chart
 * standard"), on boards of their own built from dedicated chart fixtures:
 *
 *  11. EVERY OPTION VALUE: one board per block type (`opt-<type>`) holds a
 *      card for every catalog option, and for an enum every non-default
 *      value, each compared with its baseline + twin by the same signature
 *      (a value visible only in the tooltip, e.g. a pie's format, is compared
 *      by hovering the same mark on both). The coverage guard is per value.
 *  12. FIT: line, stacked, bar, pie, heatmap, stat and funnel at a small and a
 *      large cell: no inner scroll (scrollHeight <= clientHeight and
 *      scrollWidth <= clientWidth on every box from the card down to the
 *      plot), axis tick label boxes never overlap, every label stays inside
 *      the card. Table and pivot scroll with a header that stays on top.
 *  13. HOVER TRUTH: the real pointer goes to 3 dates of a line and 3
 *      categories of a bar, each at 2 widths, positioned from the fixture and
 *      the RENDERED axis labels (never the hover code's own maths); the
 *      tooltip must show exactly that datum's value. A pie slice's tooltip
 *      shows its value and share.
 *  14. DEFECTS: every derived h-* heading card shows visible heading text;
 *      every tab label's text box lies inside its button and the tab bar.
 *  15. COLOR FOLLOWS THE ENTITY: a legend toggle, a series pick and a filter
 *      chip never repaint a surviving series or slice.
 *
 * The owner's demo findings (Acceptance Criteria "Demo finding 1..5"), on a
 * board of their own ("Quarterly revenue review", slug `findings`):
 *
 *  16. FINDING 1: a library html block added by ref through the add-card menu,
 *      bound to another insight, shows that insight's rows in the SAME page
 *      load; rebinding its input in the inspector shows the new rows, still
 *      without a reload.
 *  17. FINDING 2: line, stacked, bar (h and v), pie and heatmap at 3x3, 9x2 and
 *      12x2: the expected size class, a drawn plot of non-trivial size, every
 *      text box inside the card, no inner scroll, a y axis of 0 or >= 2 labels;
 *      a compact line at 9x2 answers the pointer in its floating tooltip with
 *      the datum under it.
 *  18. FINDING 3: the demo's 4x4 table has no horizontal scroll and no cut
 *      cell, >= 4 full rows between the sticky header and total, what it
 *      dropped in each row's tooltip, the word unit once in the header; a
 *      12-wide copy keeps every column.
 *  19. FINDING 4: inside a board cell a single root dc-card dissolves into the
 *      chrome (0 padding, 0 border) while the kit still styles everything in
 *      it; two root cards keep their own boxes; an untitled card has no header
 *      row and its menu is reachable by keyboard.
 *  20. FINDING 5: a ~24-character board name reads whole on its tab (or the
 *      tab carries it in title + aria-label); the detail panel never shows the
 *      scaffold's "(What does this number MEAN? ...)" placeholder.
 *
 * The funnel explorer (task "every page a bindable block, and the whole
 * explorer as one interactive page"), on the `explorer-demo` board built
 * through the CLI (`add-card --preset funnel-explorer` + `--block` cards) from
 * the synthetic fixture scripts/verify/fixtures/funnel-explorer-demo.mjs; every
 * expected number is read from that fixture's own payload, never from the UI:
 *
 *  21. SETUP, PAYLOAD, PRIVACY: the preset card is breakdown + tabs Daily,
 *      Benchmark, Flow, Steps and one Segments tab per dim; the board GET is
 *      <= 300 KB and only trend frames carry daily; no locally registered
 *      project name in the fixtures, the preset card, the board GET or the
 *      skill's explorer docs.
 *  22. LOOKUP + NOT MEASURED: a one-axis and a platform x language selection
 *      draw exactly the fixture's own path (never a sum); an unmeasured chip is
 *      aria-disabled, its reason shows on hover and on focus, a click changes
 *      nothing; an unmeasured metric reads "Not measured: reason" with no
 *      ruler marker; no 0 or 0% for either.
 *  23. ONE INTERACTIVE PAGE: the selection holds on every preset tab (each
 *      page's numbers are the selected path's); a same-insight table narrows
 *      and its total follows, a table without the dim says "Not split by";
 *      chip and tab clicks send ZERO sync requests.
 *  24. EVERY PAGE A BLOCK: the separate cards draw; the inspector's pick
 *      fields list the frame's funnels, dims and metrics, and a pick edits
 *      the board file and the render.
 *  25. LANES: 3 pinned lanes side by side, each lane's users and drops from
 *      its own path, a missing step is a dash, the 5th pin is disabled.
 *  26. BENCHMARK, FLOW, SEGMENTS, TREND: the current marker within 1px of its
 *      scale position, delta, status (better: lower flips it), sources,
 *      inherited band; flow stages proportional within 1%, one badge per link,
 *      the worst drop as stepDrops computes; segment rows per value under the
 *      cross-selection with tone washes, a faded low-sample row, sortable;
 *      trend hover shows the slice's exact daily value at 2 dates, the metric
 *      switch changes the series.
 *  27. FULLSCREEN: from the card menu, >= 95% of the viewport, selection and
 *      tab kept both ways, closes on Esc / exit / Back, reopens from
 *      ?card=<id>, an app card has ONE iframe.
 *  28. V1 APP + CLI PARITY + PRESET: nav:false is today's card, `page` pins a
 *      page, nav:true pills and in-frame lab.navigate both switch pages (a
 *      fresh frame); `lab board show --select` equals the DOM; the dashboard's
 *      add-card preset and `add-card --preset` write deep-equal blocks.
 * Plus: section 5/11 cases for every new option value and section 12 fit
 * cases for breakdown, trend, benchmark, segments and the flow layout.
 * Explorer screenshots (both themes) go to `--explorer-shots=<dir>` too.
 *
 * Same harness contract as the other verify scripts: real server, isolated
 * fake HOME, COLLECT-DON'T-FAIL-FAST (every section runs and reports; a
 * thrown section is one FAIL line, not an abort). Screenshots, both themes,
 * land in <scratch>/shots, and also in `--shots=<dir>` when given (never on a
 * mutation run): every board light and dark, plus hover states of a line, a
 * bar and a pie.
 *
 * ── MUTATIONS (pattern: mutation-test your assertions) ─────────────────────
 * Each key assertion names the mutation that must turn it red. Run one with
 * `--mutation=<name>`; the run then EXPECTS the named assertions to FAIL and
 * exits 0 only if they did (a mutation nobody notices is a hole in this
 * script). The mutation is applied to the artifact under test (the served
 * dashboard bundle, the network, or a scratch copy of dist/), never to src/.
 *
 *   sidebar-alpha     bundle: the Insights rail entry's maturity "beta" -> "alpha".
 *                     Must fail: "sidebar shows Insights as Beta".
 *   put-lies          network: every board PUT answers 200 with the unchanged
 *                     board and writes nothing. Must fail: "first UI edit
 *                     materializes every derived board", "drag persists to the
 *                     board file", "resize persists to the board file".
 *   symlink-follow    scratch dist copy: the store's symlink refusal and realpath
 *                     containment are removed (server AND CLI run the copy). Must
 *                     fail: "board GET: symlinked cache yields no data", "board GET:
 *                     the symlinked html input is an empty frame", "lab board show:
 *                     symlinked cache yields no data", "html block: symlinked input
 *                     yields no data".
 *   filter-syncs      bundle: a chip click also starts a sync job (the filter is
 *                     wired to the network). Must fail: "filter clicks send ZERO
 *                     sync requests".
 *   placeholder-slot  bundle: the inspector root carries data-lab-placeholder
 *                     (a stand-in slot). Must fail: "no data-lab-placeholder
 *                     element (inspector open)".
 *   chart-overflow    stylesheet: every chart plot is forced 48px taller and
 *                     wider than its frame. Must fail: the "fits its cell, no
 *                     inner scroll" checks of line / bar / pie (both sizes).
 *   hover-offset      bundle: the pointer-to-datum mapping answers the NEXT
 *                     index (an off-by-one). Must fail: every line and bar
 *                     "hover truth" datum check, the compact line's included.
 *   repaint-by-rank   bundle: colours key on the drawn entities only (the
 *                     unfiltered domain is dropped), so survivors re-rank.
 *                     Must fail: "color follows the entity: a filter chip keeps
 *                     the surviving slice's color", "... a series pick keeps
 *                     ios's stroke".
 *   heading-hidden    stylesheet: a heading card's text is visibility:hidden.
 *                     Must fail: "every h-* heading card shows its heading text".
 *   tab-clip          stylesheet: tab buttons squeezed to 10px with overflow
 *                     hidden. Must fail: "tabs: every tab label lies inside its
 *                     button and the tab bar (m-tabs)" (and c-tabs).
 *   ticks-overlap     stylesheet: tick labels at 40px. Must fail: "axis tick
 *                     labels never overlap: line (large)".
 *   sticky-lost       stylesheet: the table header cells are position:static.
 *                     Must fail: "table: the sticky header stays at the top
 *                     after scrolling".
 *   html-no-wait      bundle: the html block mounts its frame at once with whatever
 *                     inputs it holds (no wait for the current binding's frames,
 *                     no remount when they land): the pre-fix behaviour. Must
 *                     fail: the two "finding 1" data checks.
 *   compact-off       bundle: the size policy never answers "compact" (a 2-row
 *                     chart stays regular). Must fail: the "finding 2" checks of
 *                     the 2-row line / stacked / bar cards (see MUTATIONS).
 *   table-cell-units  bundle: the word unit is no longer lifted into the header
 *                     (every figure carries "users"). Must fail: "finding 3: the
 *                     header carries the unit once, no body cell repeats it".
 *   table-padding     stylesheet: the pre-fix cell padding and line height. Must
 *                     fail: "finding 3: the 4x4 table shows >= 4 full rows between
 *                     header and total".
 *   table-prefix      bundle + stylesheet: the pre-fix table (the fit ladder is empty,
 *                     so nothing gives way, and the text column is squeezed and
 *                     ellipsized). Must fail: "finding 3: no table cell cuts its
 *                     text (4x4)", "... has no horizontal scroll".
 *   card-in-card      bundle: the html cell's root-card rule is dropped. Must
 *                     fail: "finding 4: a single root dc-card dissolves into the
 *                     cell (0 padding, 0 border)".
 *   filter-syncs      (also) the breakdown chip is wired to the network. Must fail:
 *                     "explorer: breakdown chip and tab clicks send ZERO sync requests".
 *   lookup-sums       bundle: frameOps never takes the lookup branch (the
 *                     `segmentMode === "lookup"` literal), so a lookup set is summed
 *                     like cells. Must fail: the "lookup never sums" path checks.
 *   unmeasured-zero   bundle: an unmeasured chip is enabled and clickable, and an
 *                     unmeasured benchmark row draws "0%". Must fail: the chip's
 *                     aria-disabled / click checks and the "Not measured" row checks.
 *   state-per-tab     bundle: switching a tab clears the card's selection and lanes
 *                     (cardViewState setTab). Must fail: "one page: the selection
 *                     holds on every tab".
 *   lane-spine        bundle: a lane's drops are computed on the spine with 0 for a
 *                     step the lane lacks. Must fail: the lanes own-path + dash checks.
 *   fullscreen-remount bundle: the fullscreen card gets no held view (a fresh card
 *                     state). Must fail: the fullscreen keeps-selection / keeps-tab checks.
 *   ruler-shift       stylesheet: the benchmark's current marker shifted 12px. Must
 *                     fail: "benchmark: the current marker sits within 1px of its
 *                     scale position".
 *   app-nav-pinned    bundle: the app card ignores page switches (the pinned page
 *                     stays). Must fail: the pill and lab.navigate page-switch checks.
 *   chip-contrast     stylesheet: an active chip's label is white again (the pre-fix ink).
 *                     Must fail: "breakdown: an active chip's label is readable (... light)".
 *   breakdown-band    stylesheet: the breakdown block takes a flex share of the card again.
 *                     Must fail: both "the tabs start right under the chips" checks.
 *   bench-fit         bundle: the benchmark plans with 40px lines, so it falls to its lower
 *                     tiers. Must fail: the preset prints / 6x6 shows all 5 rows checks.
 *   lanes-squeeze     stylesheet: lane cells capped at 4px. Must fail: the 8x7 lanes check.
 *   flow-squeeze      stylesheet: flow stages capped at 3px. Must fail: the flow fit checks.
 *   breakdown-no-compact bundle: the small-cell selects never replace the chips. Must
 *                     fail: "breakdown (small): every row of controls lies inside the cell".
 *   trend-no-select   bundle: the narrow metric select never replaces the buttons. Must
 *                     fail: "trend (small): the metric switch never ellipsizes a label".
 *   seg-wrap          stylesheet: segment cells wrap anywhere in a fixed table. Must fail:
 *                     "segments (small): no word is broken mid-word".
 *   seg-sticky-lost   stylesheet: the value column is not sticky. Must fail: the small
 *                     segments' last-column / sticky check.
 *   seg-tint          stylesheet: a dark tint under the figures. Must fail: the light
 *                     band-tint contrast check.
 *
 * A mutation run uses its own port and scratch dir, so several can run at once.
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import matter from 'gray-matter';
import { webkit } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MUTATION = (process.argv.find((a) => a.startsWith('--mutation=')) ?? '').slice('--mutation='.length) || null;
const SCRATCH = join(tmpdir(), `dreamcontext-verify-lab-boards${MUTATION ? `-${MUTATION}` : ''}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const EMPTY = join(SCRATCH, 'empty');
const SHOTS = join(SCRATCH, 'shots');
/** A small stable offset per mutation name: parallel mutation runs never share a server. */
const PORT = 45817 + (MUTATION ? 1 + ([...MUTATION].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 400) : 0);
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');
/** The entry the server AND every CLI call run: dist/, or its mutated copy under a server mutation. */
let ENTRY = CLI;
const DC = join(PROJ, '_dream_context');
const LAB = join(DC, 'lab');
const BOARDS = join(LAB, 'boards');
const PREFS = join(DC, 'state', '.lab-prefs.json');
/** A number that exists ONLY in the file a symlinked cache points at: seeing it anywhere is a leak. */
const LEAK = 987654;

/** A second home for the screenshots (the owner's review folder). A mutation run never writes there. */
const SHOTS_OUT = MUTATION ? null : ((process.argv.find((a) => a.startsWith('--shots=')) ?? '').slice('--shots='.length) || null);
/** The funnel explorer's screenshots only (sections 21-28), for the owner's review. Never on a mutation run. */
const EXPLORER_SHOTS_OUT = MUTATION ? null : ((process.argv.find((a) => a.startsWith('--explorer-shots=')) ?? '').slice('--explorer-shots='.length) || null);
/** A development aid: run only the sections whose name matches this regex (setup always runs). */
const ONLY = (() => {
  const s = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
  return s ? new RegExp(s) : null;
})();

/** name -> the assertion names that MUST fail under it. */
const MUTATIONS = {
  'sidebar-alpha': ['sidebar shows Insights as Beta'],
  'put-lies': ['first UI edit materializes every derived board', 'drag persists to the board file', 'resize persists to the board file'],
  'symlink-follow': ['board GET: symlinked cache yields no data', 'board GET: the symlinked html input is an empty frame', 'lab board show: symlinked cache yields no data', 'html block: symlinked input yields no data'],
  'filter-syncs': ['filter clicks send ZERO sync requests', 'explorer: breakdown chip and tab clicks send ZERO sync requests'],
  'placeholder-slot': ['no data-lab-placeholder element (inspector open)'],
  'chart-overflow': ['line (small) fits its cell, no inner scroll', 'line (large) fits its cell, no inner scroll',
    'bar (small) fits its cell, no inner scroll', 'bar (large) fits its cell, no inner scroll',
    'pie (small) fits its cell, no inner scroll', 'pie (large) fits its cell, no inner scroll'],
  'hover-offset': ['finding 2: hover truth: compact line (9x2) 2026-09-19', 'finding 2: hover truth: compact line (9x2) 2026-09-22',
    'finding 2: hover truth: compact line (9x2) 2026-09-26', 'hover truth: line (narrow) 2026-09-19', 'hover truth: line (narrow) 2026-09-22', 'hover truth: line (narrow) 2026-09-26',
    'hover truth: line (wide) 2026-09-19', 'hover truth: line (wide) 2026-09-22', 'hover truth: line (wide) 2026-09-26',
    'hover truth: bar (narrow) south', 'hover truth: bar (narrow) east', 'hover truth: bar (narrow) west',
    'hover truth: bar (wide) south', 'hover truth: bar (wide) east', 'hover truth: bar (wide) west'],
  'repaint-by-rank': ["color follows the entity: a filter chip keeps the surviving slice's color",
    "color follows the entity: a series pick keeps ios's stroke"],
  'heading-hidden': ['every h-* heading card shows its heading text'],
  'tab-clip': ['tabs: every tab label lies inside its button and the tab bar (m-tabs)'],
  'ticks-overlap': ['axis tick labels never overlap: line (large)'],
  'sticky-lost': ['table: the sticky header stays at the top after scrolling'],
  'html-no-wait': ["finding 1: a library block added by ref through the UI shows its bound insight's rows without a reload",
    'finding 1: rebinding the html input in the inspector shows the new rows without a reload'],
  'compact-off': ['finding 2: line 9x2 is compact size', 'finding 2: line 9x2 draws a plot of non-trivial size', 'finding 2: line 12x2 draws a plot of non-trivial size',
    'finding 2: stacked 9x2 draws a plot of non-trivial size', 'finding 2: bar-v 9x2 draws a plot of non-trivial size',
    "finding 2: the compact line's tooltip floats outside the card"],
  'table-cell-units': ['finding 3: the header carries the unit once, no body cell repeats it'],
  'table-padding': ['finding 3: the 4x4 table shows >= 4 full rows between header and total'],
  'table-prefix': ['finding 3: no table cell cuts its text (4x4)', 'finding 3: the 4x4 table has no horizontal scroll'],
  'card-in-card': ['finding 4: a single root dc-card dissolves into the cell (0 padding, 0 border)'],
  'lookup-sums': ['lookup never sums: platform=Meta Ads draws the fixture\'s own path',
    'lookup never sums: the benchmark for platform x language reads the intersection\'s own metrics'],
  'unmeasured-zero': ['not measured: an unmeasured chip is aria-disabled', 'not measured: clicking an unmeasured chip changes nothing',
    'not measured: an unmeasured metric reads "Not measured: reason" with no ruler marker', 'not measured: no 0 or 0% is drawn for an unmeasured metric'],
  'state-per-tab': ['one page: the selection holds on every tab'],
  'lane-spine': ["lanes: each lane's users and drops come from its own path", 'lanes: a missing step shows a dash (Unattributed has no email step)'],
  'fullscreen-remount': ['fullscreen keeps the breakdown selection', 'fullscreen keeps the active tab', 'closing fullscreen keeps the tab changed inside it'],
  'ruler-shift': ['benchmark: the current marker sits within 1px of its scale position'],
  'app-nav-pinned': ['app card: a pill click switches the page in the card (a fresh frame)',
    'app card: an in-frame lab.navigate switches the page in the card (a fresh frame)'],
  'chip-contrast': ["breakdown: an active chip's label is readable (contrast >= 4.5:1, light)"],
  'breakdown-band': ['one page: the tabs start right under the chips (no blank band > 24px)', 'fullscreen: the tabs start right under the chips (no blank band > 24px)'],
  'bench-fit': ["benchmark: the preset card prints every row's sources and its floor / target / previous numbers", 'benchmark: the 6x6 card shows all 5 rows (no "+N more"), no clipped text'],
  'lanes-squeeze': ['lanes: every users and % cell is >= 10px tall with its text painted, no clipped text (the 8x7 Steps card)'],
  'flow-squeeze': ['flow (small): every stage label and users figure is visible', 'flow (large): every stage label and users figure is visible'],
  'breakdown-no-compact': ['breakdown (small): every row of controls lies inside the cell (nothing cut)'],
  'trend-no-select': ['trend (small): the metric switch never ellipsizes a label', 'trend (small): no clipped text'],
  'seg-wrap': ['segments (small): no word is broken mid-word'],
  'seg-sticky-lost': ['segments (small): the last column is reachable by scrolling and the value column stays stuck'],
  'seg-tint': ['segments: every band-tinted figure reads at >= 4.5:1 (light)'],
};
if (MUTATION && !MUTATIONS[MUTATION]) {
  console.error(`unknown mutation "${MUTATION}"; known: ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail: cond ? '' : String(detail), measured: String(detail) });
  return !!cond;
};
/** Run one section; a throw is ONE failure line, never an abort. */
/** The page under test, once the browser is up: a thrown section leaves a screenshot of it. */
let sectionPage = null;
async function section(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await fn();
  } catch (e) {
    ok(`${name} (section threw)`, false, (e && e.stack) ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
    if (sectionPage) await sectionPage.screenshot({ path: join(SHOTS, `threw-${name.replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dc(args, { cwd = PROJ, allowFail = false } = {}) {
  try {
    return execFileSync('node', [ENTRY, ...args], {
      cwd, env: { ...process.env, HOME, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    }).toString();
  } catch (e) {
    if (allowFail) return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    throw new Error(`dreamcontext ${args.join(' ')} failed: ${e.stderr ?? e.message}`);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** The funnel explorer's insights (created by the "explorer fixtures via CLI" section, before any board names them). */
const EXPLORER = 'acme-funnel-explorer';
/** The same script plus a platform x language table and a higher low-sample line (narrowing + faded rows). */
const EXPLORER_PLUS = 'acme-explorer-plus';
/** The synthetic 3-page app/v1 insight. */
const APP = 'acme-onboarding-app';
const EXPLORER_FIXTURE = join(REPO, 'scripts', 'verify', 'fixtures', 'funnel-explorer-demo.mjs');
const APP_FIXTURE = join(REPO, 'scripts', 'verify', 'fixtures', 'acme-onboarding-app.mjs');
/**
 * The dashboard's own generated frameOps (TypeScript, bundled here on the fly):
 * the board GET sends identical funnel frames once, and `expandFrames(frames,
 * frameAliases)` is how the client gets every key back.
 */
const { expandFrames } = await import(`data:text/javascript;base64,${Buffer.from(buildSync({
  entryPoints: [join(REPO, 'dashboard', 'src', 'generated', 'frameOps.ts')], bundle: true, format: 'esm', write: false, platform: 'neutral',
}).outputFiles[0].text).toString('base64')}`);

const DAYS_HELPER = `
function days(n) {
  const out = [];
  const end = Date.UTC(2026, 8, 28);
  for (let i = n - 1; i >= 0; i--) out.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
  return out;
}
`;

/** Plans x countries: distinct values; the TR rows sum to exactly 1000 (the filter check). */
const PLAN_ROWS = [
  ['team', 'TR', 400], ['pro', 'TR', 300], ['starter', 'TR', 200], ['trial', 'TR', 100],
  ['team', 'US', 520], ['pro', 'US', 410], ['starter', 'US', 260], ['trial', 'US', 90],
  ['team', 'DE', 330], ['pro', 'DE', 240], ['starter', 'DE', 150], ['trial', 'DE', 60],
];
const PLAN_TOTAL = PLAN_ROWS.reduce((s, r) => s + r[2], 0);

/**
 * The legacy vault. Categories + groups exactly as a v1 user had them; one
 * insight per frame kind the engine builds (value, series, table from a
 * dataset/v1, funnel), the two legacy bodies (html/v1, app/v1), a probed
 * insight (freshness gate), a recently-errored one and one whose cache will
 * become a symlink.
 */
const INSIGHTS = [
  {
    slug: 'signups', title: 'Signups', render: 'number', category: 'Growth', group: 'Acquisition', unit: 'users',
    script: `${DAYS_HELPER}
export default async function () {
  return [{ name: 'signups', points: days(30).map((t, i) => ({ t, v: 100 + i * 3 + (i % 4) * 7 })) }];
}`,
  },
  {
    slug: 'sessions', title: 'Sessions', render: 'line', category: 'Growth', group: 'Acquisition', unit: 'sessions',
    script: `${DAYS_HELPER}
export default async function () {
  return ['web', 'ios', 'android'].map((name, s) => ({
    name, points: days(30).map((t, i) => ({ t, v: 40 + s * 35 + ((i * (s + 3)) % 17) * (s + 1) })),
  }));
}`,
  },
  {
    slug: 'traffic-mix', title: 'Traffic mix', render: 'pie', category: 'Growth', group: 'Mix', unit: 'visits',
    script: `${DAYS_HELPER}
export default async function () {
  return [['organic', 900], ['direct', 520], ['referral', 260], ['social', 130]].map(([name, base]) => ({
    name, points: days(14).map((t, i) => ({ t, v: base + i })),
  }));
}`,
  },
  {
    // Freshness gate fixture: the script names its own marker, and a cheap
    // freshness() probe returns the SAME marker, so a user sync is 1 probe 0 fetches.
    slug: 'probed', title: 'Probed metric', render: 'number', category: 'Growth', group: 'Mix', unit: 'rows',
    script: `${DAYS_HELPER}
const FRESH = { marker: 'fixture-v1', asOf: '2026-09-28', note: 'Source says <b>as of 09:00</b>' };
export async function freshness() { return FRESH; }
export default async function () {
  return { data: [{ name: 'rows', points: days(10).map((t, i) => ({ t, v: 50 + i })) }], freshness: FRESH };
}`,
  },
  {
    slug: 'plans', title: 'Plans', render: 'table', category: 'Revenue', group: 'Plans', unit: 'usd',
    script: `export default async function () {
  const rows = ${JSON.stringify(PLAN_ROWS)}.map(([plan, country, v], i) => ({ d: { plan, country, tier: i % 2 === 0 ? 'self' : 'sales' }, v, n: 10 + i, prev: v - 15 - i }));
  return {
    kind: 'dataset/v1',
    primary: 'plans',
    datasets: [{
      key: 'plans',
      label: 'Plans',
      dims: [{ key: 'plan', label: 'Plan' }, { key: 'country', label: 'Country' }, { key: 'tier', label: 'Tier' }],
      rows,
      total: { v: ${PLAN_TOTAL}, n: 186, prev: ${PLAN_TOTAL - 300} },
    }],
  };
}`,
  },
  {
    slug: 'funnels', title: 'Funnels', render: 'funnel', category: 'Revenue', group: 'Plans',
    script: `export default async function () {
  const funnel = (id, name, users, mid, done) => ({
    id, name, metrics: { users: { v: users, format: 'count' } },
    steps: [
      { key: 'visit', label: 'Visit', users },
      { key: 'signup', label: 'Signup', users: mid },
      { key: 'pay', label: 'Pay', users: done },
    ],
  });
  return {
    kind: 'funnel-set/v1', primary: 'users',
    funnels: [funnel('f1', 'Checkout A', 1200, 600, 180), funnel('f2', 'Checkout B', 900, 300, 60), funnel('f3', 'Checkout C', 400, 220, 90)],
  };
}`,
  },
  {
    slug: 'html-card', title: 'Legacy html card', render: 'number', category: 'Legacy', group: 'Bodies',
    script: `export default async function () {
  return {
    data: [{ name: 'v', points: [{ t: '2026-09-27', v: 5 }, { t: '2026-09-28', v: 8 }] }],
    html: '<div class="lk-stat"><span class="lk-label">Legacy html body</span><span class="lk-value" id="legacy-html">8</span></div>',
  };
}`,
  },
  {
    slug: 'app-card', title: 'Legacy app card', render: 'app', category: 'Legacy', group: 'Bodies',
    script: `export default async function () {
  return {
    data: { kind: 'dataset/v1', datasets: [{ key: 'main', dims: [{ key: 'k' }], rows: [{ d: { k: 'a' }, v: 1 }, { d: { k: 'b' }, v: 2 }], total: { v: 3 } }] },
    app: { kind: 'app/v1', entry: 'home', pages: [{ id: 'home', title: 'Home', html: '<div class="lk-title" id="legacy-app">Legacy app page</div>' }] },
  };
}`,
  },
  {
    slug: 'broken-metric', title: 'Broken metric', render: 'number', category: null, group: null,
    script: `export default async function () { throw new Error('upstream rejected the query (verify fixture)'); }`,
  },
  {
    slug: 'symlinked', title: 'Symlinked cache', render: 'table', category: 'Hazards', group: null,
    script: `export default async function () { return [{ name: 'x', points: [{ t: '2026-09-28', v: 1 }] }]; }`,
  },
];
const INSIGHT_SLUGS = INSIGHTS.map((i) => i.slug);

/** The legacy prefs a v1 user left behind (server file). */
const LEGACY_PREFS = {
  order: { 'Growth / Acquisition': ['sessions', 'signups'] },
  collapsed: ['Growth / Mix'],
  category: 'Revenue',
  catOrder: ['Revenue', 'Growth', 'Legacy', 'Hazards'],
  columns: { funnels: ['users'] },
};
const EXPECTED_TAB_TITLES = ['Revenue', 'Growth', 'Legacy', 'Hazards'];

/** A CLI-saved library block: reads its one declared input and prints the row count. */
const LIBRARY_HTML = `<div class="dc-card"><div class="dc-card-title" id="lib-title">Library KPI</div><div id="lib-rows">pending</div></div>
<script>
lab.data('rows').then(function (f) { document.getElementById('lib-rows').textContent = 'lib-rows=' + (f && f.rows ? f.rows.length : 'none'); },
  function (e) { document.getElementById('lib-rows').textContent = 'lib-error:' + e.message; });
</script>`;

/** The inline html block: kit probe, one declared input, one undeclared name. */
const INLINE_HTML = `<div class="dc-card" id="kit"><div class="dc-card-title" id="kit-title">Plans by kit</div><span class="dc-chip" id="chip">kit</span></div>
<div id="plain">plain</div>
<pre id="ok">pending</pre><pre id="refused">pending</pre><pre id="inputs">pending</pre>
<script>
document.getElementById('inputs').textContent = 'inputs=' + JSON.stringify(window.lab && window.lab.inputs);
lab.data('rows').then(function (f) { document.getElementById('ok').textContent = 'rows=' + (f && f.rows ? f.rows.length : 'none') + ';kind=' + (f && f.kind); },
  function (e) { document.getElementById('ok').textContent = 'error:' + e.message; });
lab.data('secret').then(function (f) { document.getElementById('refused').textContent = 'LEAK:' + JSON.stringify(f).slice(0, 120); },
  function (e) { document.getElementById('refused').textContent = 'refused:' + e.message; });
</script>`;

/** The hazard html block: every input is a hostile binding; each must resolve to no data. */
const HAZARD_HTML = `<pre id="hz">pending</pre>
<script>
var names = ['a', 'b', 'c'];
Promise.all(names.map(function (n) {
  return lab.data(n).then(function (f) { return n + ':' + (f && f.kind) + ':' + JSON.stringify(f).slice(0, 200); }, function (e) { return n + ':refused'; });
})).then(function (lines) { document.getElementById('hz').textContent = lines.join('\\n'); });
</script>`;

function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[relative(root, p)] = 'symlink';
      else if (st.isDirectory()) walk(p);
      else out[relative(root, p)] = createHash('sha1').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(DC, 'state'), { recursive: true });
  mkdirSync(join(EMPTY, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'), JSON.stringify({ github: { token: 'gho_fake_verify_token', login: 'verify-user' } }));
  for (const dir of [PROJ, EMPTY]) execFileSync('git', ['init', '-q'], { cwd: dir });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  dc(['vaults', 'add', 'empty', EMPTY], { cwd: REPO });
  dc(['init', '--yes'], { allowFail: true });
  dc(['init', '--yes'], { cwd: EMPTY, allowFail: true });

  mkdirSync(join(LAB, 'scripts'), { recursive: true });
  for (const ins of INSIGHTS) {
    dc([
      'lab', 'create', ins.slug, '--title', ins.title, '--render', ins.render, '--adapter', 'script',
      ...(ins.category ? ['--category', ins.category] : []),
      ...(ins.group ? ['--group', ins.group] : []),
      ...(ins.unit ? ['--unit', ins.unit] : []),
    ]);
    writeFileSync(join(LAB, 'scripts', `${ins.slug}.mjs`), `${ins.script}\n`, 'utf-8');
  }
  // One failing insight makes the run exit non-zero: that IS the recently-errored fixture.
  const syncOut = dc(['lab', 'sync', '--all'], { allowFail: true });
  const probeOut = dc(['lab', 'sync', 'probed', '--force', '--json'], { allowFail: true });

  // The symlinked cache: a VALID cache outside lab/cache/, carrying the leak marker.
  const outside = join(SCRATCH, 'outside-cache.json');
  const real = JSON.parse(readFileSync(join(LAB, 'cache', 'symlinked.json'), 'utf-8'));
  real.latest = LEAK;
  real.series = [{ name: 'leak', points: [{ t: '2026-09-28', v: LEAK }] }];
  writeFileSync(outside, JSON.stringify(real, null, 2));
  rmSync(join(LAB, 'cache', 'symlinked.json'));
  symlinkSync(outside, join(LAB, 'cache', 'symlinked.json'));

  writeFileSync(PREFS, JSON.stringify(LEGACY_PREFS, null, 2));

  // The CLI-saved library block (not a board write: boards stay derived).
  const libFile = join(SCRATCH, 'kpi-tile.html');
  writeFileSync(libFile, LIBRARY_HTML);
  dc(['lab', 'block', 'save', 'kpi-tile', '--file', libFile, '--inputs', 'rows:table', '--title', 'KPI tile']);
  return { syncOut, probeOut };
}

// ─── Mutations applied to the artifact under test ────────────────────────────

/**
 * Bundle (JS asset) string mutations: [regex, replacement], or a list of such
 * pairs (each pair must apply somewhere, or the run says the mutation missed).
 */
const BUNDLE_MUTATIONS = {
  'sidebar-alpha': [/(labelKey:"nav\.labpage",maturity:)"beta"/, '$1"alpha"'],
  'filter-syncs': [/(className:"lab-(?:block|breakdown)-chip",)/g, '$1onMouseDown:()=>fetch("/api/lab/sync-jobs",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),'],
  // frameOps funnelSlice / cellsNoRates: the lookup branch is never taken, so a lookup set is summed like cells.
  'lookup-sums': [/segmentMode(===|!==)"lookup"/g, 'segmentMode$1"__lookup_off"'],
  'unmeasured-zero': [
    // BreakdownBlock: an unmeasured chip is neither aria-disabled nor inert.
    [/"aria-disabled":([\w$]+)\.enabled\?void 0:!0,("aria-describedby":[^,]+,onClick:\(\)=>\{)\1\.enabled&&/, '"aria-disabled":void 0,$2!0&&'],
    // BenchmarkBlock: an unmeasured row draws a zero value instead of "Not measured: reason".
    [/([\w$]+)\.jsx\("span",\{className:"lab-bench-unmeasured","data-lab-bench-unmeasured":"",children:[\w$]+\([\w$]+,[\w$]+\.reason\)\}\)/,
      '$1.jsx("span",{className:"lab-bench-value","data-lab-bench-value":"",children:"0%"})'],
  ],
  // cardViewState setTab: a tab switch also drops the selection and the lanes.
  'state-per-tab': [/\{\.\.\.([\w$]+),tabs:\{\.\.\.\1\.tabs,\[([\w$]+)\]:([\w$]+)\}\}/, '{...$1,selection:{},lanes:{},tabs:{...$1.tabs,[$2]:$3}}'],
  // FunnelLanes laneModel: a lane's drops run over the spine, a step the lane lacks counted as 0 users.
  'lane-spine': [/(spine:[\w$]+\(\[\{steps:([\w$]+)\},\.\.\.[\w$]+\.map\([\w$]+=>\(\{steps:[\w$]+\.slice\.steps\}\)\)\]\),lanes:[\w$]+\.map\(([\w$]+)=>\{var [\w$]+;const [\w$]+=\3\.slice\.measured\?([\w$]+)\()\3\.slice\.steps\)/,
    '$1$2.map(q=>({...q,users:($3.slice.steps.find(w=>w.key===q.key)||{users:0}).users})))'],
  // BoardPage cardNode: the fullscreen copy of a card gets no held view (it starts from a fresh state).
  'fullscreen-remount': [/view:([\w$]+)\[([\w$]+)\.id\],onView:([\w$]+)\?([\w$]+)=>([\w$]+)\(\{type:"update",board:\3,card:\2\.id,fn:\4\}\):void 0,fullscreen:([\w$]+),/,
    'view:$6?void 0:$1[$2.id],onView:$6?void 0:$3?$4=>$5({type:"update",board:$3,card:$2.id,fn:$4}):void 0,fullscreen:$6,'],
  // BenchmarkBlock BENCH_PX: a row line 40px instead of 16, so the fit ladder drops to its lower tiers.
  'bench-fit': [/\{pad:7,line:16,gap:4,legend:20,note:20\}/, '{pad:7,line:40,gap:4,legend:20,note:20}'],
  // BreakdownBlock: the small-cell form (selects) is never drawn; the chip rows stay at any size.
  'breakdown-no-compact': [/return ([\w$]+)\?([\w$]+)\.jsxs\("div",\{ref:([\w$]+),className:"lab-block-fill lab-breakdown lab-breakdown--compact"/,
    'return !1?$2.jsxs("div",{ref:$3,className:"lab-block-fill lab-breakdown lab-breakdown--compact"'],
  // TrendBlock: the narrow-cell metric select is never drawn; the segmented buttons stay at any width.
  'trend-no-select': [/([\w$]+)&&([\w$]+)\?([\w$]+)\.jsx\("select",\{className:"lab-trend-select"/, '$1&&!1?$3.jsx("select",{className:"lab-trend-select"'],
  // LabAppBody go(): a page switch (pill or lab.navigate) is swallowed; the pinned page stays.
  'app-nav-pinned': [/([\w$]+)=([\w$]+)=>\{\2!==[\w$]+&&\([\w$]+\?[\w$]+\(\2\):[\w$]+\(\2\)\)\}(,[\w$]+=![\w$]+&&[\w$]+\?[\w$]+\.jsx\("p",\{className:"lab-app-card-note")/,
    '$1=$2=>{}$3'],
  'placeholder-slot': [/("data-lab-inspector":!0)/, '$1,"data-lab-placeholder":!0'],
  // hover.ts nearestIndex: `return x - positions[lo] <= positions[hi] - x ? lo : hi` answers one index later.
  'hover-offset': [/return (\w+)-(\w+)\[(\w+)\]<=\2\[(\w+)\]-\1\?\3:\4\}/, 'return Math.min($2.length-1,($1-$2[$3]<=$2[$4]-$1?$3:$4)+1)}'],
  // LineChart.tsx entityDomain(domain, names): the unfiltered domain is ignored, colours follow the drawn rank.
  'repaint-by-rank': [/function (\w+)\((\w+),(\w+)\)\{if\(!\2\|\|\2\.length===0\)return\[\.\.\.\3\];/, 'function $1($2,$3){return[...$3];'],
  // HtmlBlock.tsx HtmlBlockBody: `!current && !gaveUp ? <waiting/> : <HtmlBlockFrame key={fingerprint} inputs={currentInputs}/>`
  // becomes `<HtmlBlockFrame {...frame}/>`: mounted at once, raw inputs, never remounted when the frames land.
  'html-no-wait': [/return!([\w$]+)&&!([\w$]+)\?([\w$]+)\.jsx\("div",\{className:"lab-block-empty","data-lab-html-waiting":!0,children:[\w$]+\}\):\3\.jsx\(([\w$]+),\{\.\.\.([\w$]+),inputs:[\w$]+\},[\w$]+\(\5\.declared,[\w$]+\)\)/,
    'return $3.jsx($4,{...$5})'],
  // fit.ts chartSizeClass: `height < f*COMPACT_HEIGHT || width < f*COMPACT_WIDTH ? 'compact' : ...` never holds.
  'compact-off': [/(return )([\w$]+)<([\w$]+)\*[\w$]+\|\|([\w$]+)<\3\*[\w$]+\?"compact":(\2<\3\*[\w$]+\|\|\4<\3\*[\w$]+\?"small")/, '$1!1?"compact":$5'],
  // MetricTable.tsx wordUnit(): no word unit is lifted into the header, so every figure carries it.
  'table-cell-units': [/(function [\w$]+\([\w$]+,[\w$]+\)\{const ([\w$]+)=[\w$]+\([\w$]+,[\w$]+\);return )\2\.startsWith\(" "\)\?\2\.trim\(\):null\}/, '$1null}'],
  // MetricTable.tsx frameLadder(): nothing ever gives way, every column stays at any width. With the
  // stylesheet half below: the pre-fix table.
  'table-prefix': [/(function [\w$]+\([\w$]+\)\{const [\w$]+=[\w$]+=>[\w$]+\.includes\([\w$]+\),[\w$]+=[\w$]+\.filter\([\w$]+=>![\w$]+\([\w$]+\)\);return)\[\{drop:"n"\},\{compact:!0\},\{drop:"prev"\},\{noBar:!0\},\{drop:"delta"\},\.\.\.[\w$]+\.slice\(1\)\.reverse\(\)\.map\([\w$]+=>\(\{drop:[\w$]+\}\)\)\]\}/, '$1[]}'],
  // htmlBlockBridge.ts HTML_BLOCK_CELL_CSS: the single root dc-card keeps its own box inside the cell.
  'card-in-card': [/body:not\(:has\(> \.dc-card ~ \.dc-card\)\) > \.dc-card \{/, '.verify-card-in-card {'],
};

/** Stylesheet mutations: a rule appended to the served CSS bundle. */
const CSS_MUTATIONS = {
  'chart-overflow': '.lab-chart-plot{flex:none!important;min-height:calc(100% + 48px)!important;min-width:calc(100% + 48px)!important}',
  'heading-hidden': '.board-card--heading .board-card-block{visibility:hidden!important}',
  'tab-clip': '.lab-block-tab{height:10px!important;min-height:0!important;padding-top:0!important;padding-bottom:0!important;overflow:hidden!important}',
  'ticks-overlap': '.lab-chart-tick{font-size:40px!important}',
  'sticky-lost': '.lab-table-head th{position:static!important}',
  // MetricTable.css before finding 3: a 4px cell inset and the normal line height.
  // MetricTable.css before finding 3: the text column squeezed and ellipsized (with the bundle half above).
  'table-prefix': '.lab-table-text{max-width:0!important;min-width:var(--space-16)!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}',
  'table-padding': '.lab-table th,.lab-table td,.lab-table-sort,.lab-table-static{padding:var(--space-1) var(--space-2)!important}.lab-table{line-height:var(--line-height-normal)!important}',
  'ruler-shift': '.lab-bench-current{margin-left:12px!important}',
  'chip-contrast': ".lab-breakdown-chip[aria-pressed='true'],.lab-breakdown-chip[aria-pressed='true'] .lab-breakdown-chip-value{color:#fff!important}",
  'breakdown-band': ".board-card-block[data-lab-block='breakdown']{flex:1 1 0!important}",
  'lanes-squeeze': '.funnel-lanes-cell{max-height:4px!important;overflow:hidden!important}',
  'flow-squeeze': '.funnel-flow-stage{max-height:3px!important;overflow:hidden!important}',
  'seg-wrap': '.lab-seg-table{width:100%!important;table-layout:fixed!important}.lab-seg-table th,.lab-seg-table td{white-space:normal!important;overflow-wrap:anywhere!important;word-break:break-all!important}',
  'seg-sticky-lost': '.lab-seg-table .lab-seg-value,.lab-seg-table thead th:first-child{position:static!important}',
  'seg-tint': '.lab-seg-table td[data-tone]{background:rgb(52,52,60)!important;box-shadow:none!important}',
};

/** Server mutation: a scratch copy of dist/ with the store's containment removed. */
function mutatedDist() {
  const target = join(SCRATCH, 'dist-mut');
  cpSync(join(REPO, 'dist'), target, { recursive: true });
  cpSync(join(REPO, 'package.json'), join(SCRATCH, 'package.json'));
  if (!existsSync(join(SCRATCH, 'node_modules'))) symlinkSync(join(REPO, 'node_modules'), join(SCRATCH, 'node_modules'));
  let patched = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'dashboard') walk(p); continue; }
      if (!name.endsWith('.js')) continue;
      const src = readFileSync(p, 'utf-8');
      const next = src
        .replace(/if \((\w+)\.isSymbolicLink\(\) \|\| !\1\.isFile\(\)\) return null;/g, () => { patched += 1; return ''; })
        .replace(/return (realpathSync\w*)\((\w+)\) === (\w+) \? \2 : null;/g, (_m, _fn, p2) => { patched += 1; return `return ${p2};`; });
      if (next !== src) writeFileSync(p, next);
    }
  };
  walk(target);
  if (patched < 2) throw new Error(`symlink-follow: expected 2 patches in dist, applied ${patched}`);
  return join(target, 'index.js');
}

// ─── Browser helpers ─────────────────────────────────────────────────────────

async function waitForServer(url, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server did not come up at ${url}`);
}

/** Poll a condition (sync or async) until it holds or the time runs out. */
async function until(fn, ms = 5000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* retry */ }
    await sleep(step);
  }
  return last;
}

function readBoard(slug) {
  const p = join(BOARDS, `${slug}.md`);
  if (!existsSync(p)) return null;
  return matter(readFileSync(p, 'utf-8')).data;
}
const fileCard = (slug, id) => readBoard(slug)?.cards?.find((c) => c.id === id) ?? null;
const boardFiles = () => (existsSync(BOARDS) ? readdirSync(BOARDS).filter((f) => f.endsWith('.md')).sort() : []);

/** The first line where two signatures differ (for a failure's detail). */
function sigDiff(a, b) {
  const x = String(a ?? '').split('\n');
  const y = String(b ?? '').split('\n');
  const i = x.findIndex((l, k) => l !== y[k]);
  return i < 0 ? `lengths ${x.length} vs ${y.length}` : `line ${i}: ${x[i]} ≠ ${y[i]}`;
}

/**
 * A render's geometry + paint signature, relative to the block root: what a
 * user can SEE (boxes, colors, svg shapes, text), never data-* attributes
 * or class names (an option that only flips a data attribute has not
 * changed the render). Gradient/clip ids are normalized so twins compare equal.
 */
function signatureInPage(root) {
  const r0 = root.getBoundingClientRect();
  const out = [];
  const ATTRS = ['d', 'points', 'x', 'y', 'width', 'height', 'r', 'cx', 'cy', 'x1', 'x2', 'y1', 'y2', 'fill', 'stroke', 'transform', 'stroke-dasharray'];
  const walk = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    // A `display: contents` element draws no box of its own (its rect is the viewport origin): its children only.
    if (cs.display === 'contents') {
      for (const c of el.children) walk(c);
      return;
    }
    const r = el.getBoundingClientRect();
    const parts = [el.tagName, Math.round(r.x - r0.x), Math.round(r.y - r0.y), Math.round(r.width), Math.round(r.height),
      cs.color, cs.backgroundColor, cs.fill, cs.stroke, cs.borderLeftColor, cs.borderTopColor, cs.opacity, cs.fontWeight];
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) parts.push(`${a}=${v}`);
    }
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) parts.push(`"${n.textContent.trim()}"`);
    out.push(parts.join('|'));
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out.join('\n').replace(/url\([^)]*\)/g, 'url()');
}

// ─── The catalog fixture (section 5) ─────────────────────────────────────────

/** [type, base options (incl. data), variant options]. Options covered elsewhere are listed in COVERED_ELSEWHERE. */
const OPTION_CASES = [
  ['stat', { data: 'signups' }, { delta: 'prev' }],
  ['stat', { data: 'signups' }, { spark: true }],
  ['stat', { data: 'signups' }, { unit: 'people' }],
  ['stat', { data: 'signups' }, { format: 'percent' }],
  ['stat', { data: 'sessions' }, { series: ['ios'] }],
  ['line', { data: 'sessions' }, { area: true }],
  ['line', { data: 'sessions' }, { color: 4 }],
  ['line', { data: 'sessions' }, { series: ['ios'] }],
  ['line', { data: 'sessions' }, { limit: 7 }],
  ['bar', { data: 'plans' }, { orientation: 'v' }],
  ['bar', { data: 'plans' }, { color: 4 }],
  ['bar', { data: 'plans' }, { comparePrev: true }],
  ['bar', { data: 'plans' }, { where: { country: ['TR'] } }],
  ['bar', { data: 'plans' }, { sort: 'plan' }],
  ['bar', { data: 'plans' }, { limit: 3 }],
  ['bar', { data: 'sessions' }, { series: ['ios'] }],
  ['stacked', { data: 'sessions' }, { color: 4 }],
  ['stacked', { data: 'plans' }, { where: { country: ['TR'] } }],
  ['stacked', { data: 'sessions' }, { series: ['web', 'ios'] }],
  ['stacked', { data: 'sessions' }, { limit: 7 }],
  // 12 slices would degrade to bars (the pie's own 7+ rule), where donut has nothing to draw: 4 slices.
  ['pie', { data: 'plans', where: { country: ['US'] } }, { donut: true }],
  ['pie', { data: 'plans' }, { where: { country: ['US'] } }],
  ['pie', { data: 'plans' }, { sort: 'plan' }],
  ['pie', { data: 'plans' }, { limit: 3 }],
  ['table', { data: 'plans' }, { columns: ['plan', 'v'] }],
  ['table', { data: 'plans' }, { where: { country: ['TR'] } }],
  ['table', { data: 'plans' }, { sort: '-v' }],
  ['table', { data: 'plans' }, { limit: 3 }],
  ['heatmap', { data: 'sessions' }, { color: 4 }],
  ['heatmap', { data: 'plans' }, { where: { country: ['TR'] } }],
  ['funnel', { data: 'funnels' }, { compact: true }],
  ['pivot', { data: 'plans' }, { rows: 'country' }],
  ['pivot', { data: 'plans' }, { cols: 'tier' }],
  ['pivot', { data: 'plans' }, { where: { country: ['TR'] } }],
  ['text', { markdown: '### Alpha heading' }, { markdown: '### Beta heading\n\nWith a second paragraph.' }],
  ['callout', { markdown: 'Heads up' }, { tone: 'danger' }],
  ['callout', { markdown: 'Heads up' }, { markdown: 'A different note, longer than the first one.' }],
  ['filter', { data: 'plans', dim: 'plan' }, { dim: 'country' }],
  // The funnel explorer blocks (bound to the synthetic explorer; the ladder funnel has other steps, dims and metrics).
  ['funnel', { data: 'funnels' }, { funnel: 'f2' }],
  ['funnel', { data: 'funnels' }, { layout: 'flow' }],
  ['funnel', { data: 'funnels' }, { markWorst: true }],
  ['breakdown', { data: EXPLORER }, { funnel: 'activation-ladder' }],
  ['breakdown', { data: EXPLORER }, { dims: ['language', 'platform'] }],
  ['breakdown', { data: EXPLORER }, { counts: true }],
  ['breakdown', { data: EXPLORER }, { lanes: false }],
  ['trend', { data: EXPLORER }, { funnel: 'activation-ladder' }],
  ['trend', { data: EXPLORER }, { metrics: ['conversion', 'visit_to_lead'] }],
  ['trend', { data: EXPLORER }, { chart: 'bar' }],
  ['trend', { data: EXPLORER }, { switch: false }],
  ['trend', { data: EXPLORER, switch: false }, { legend: 'top' }],
  ['trend', { data: EXPLORER }, { axes: 'x' }],
  ['trend', { data: EXPLORER }, { grid: false }],
  ['trend', { data: EXPLORER }, { format: 'percent' }],
  ['benchmark', { data: EXPLORER }, { funnel: 'activation-ladder' }],
  ['benchmark', { data: EXPLORER }, { metrics: ['conversion', 'cost_per_lead'] }],
  ['benchmark', { data: EXPLORER }, { comparePrev: false }],
  // One metric: its row is drawn in full (the source line shows) at the catalog size.
  ['benchmark', { data: EXPLORER, metrics: ['conversion'] }, { sources: false }],
  ['segments', { data: EXPLORER }, { funnel: 'activation-ladder' }],
  ['segments', { data: EXPLORER }, { by: 'language' }],
  ['segments', { data: EXPLORER }, { metrics: ['conversion'] }],
  ['segments', { data: EXPLORER }, { bands: false }],
  ['segments', { data: EXPLORER }, { sort: '-users' }],
  ['segments', { data: EXPLORER }, { limit: 2 }],
  ['segments', { data: EXPLORER }, { density: 'comfortable' }],
];
/** type -> option keys proven by a dedicated section instead of a signature pair. */
const COVERED_ELSEWHERE = {
  tabs: ['tabs'],
  html: ['html', 'ref', 'inputs'],
};
const CATALOG_SIZE = { w: 6, h: 5 };

function catalogBoardSpec() {
  const cards = [];
  let y = 0;
  const bases = new Map();
  const place = (id, type, opts, title) => {
    const { data, ...rest } = opts;
    const block = { [type]: { ...(data ? { data } : {}), ...rest } };
    cards.push({ id, title, at: { x: cards.length % 2 === 0 ? 0 : 6, y, ...CATALOG_SIZE }, blocks: [block] });
    if (cards.length % 2 === 0) y += CATALOG_SIZE.h;
  };
  const baseId = (type, base) => {
    const key = `${type}:${JSON.stringify(base)}`;
    if (!bases.has(key)) bases.set(key, `b-${type}-${bases.size}`);
    return bases.get(key);
  };
  const baseList = [];
  for (const [type, base] of OPTION_CASES) {
    const id = baseId(type, base);
    if (!baseList.some((b) => b.id === id)) baseList.push({ id, type, base });
  }
  // Baseline + twin side by side (the twin is the noise control).
  for (const b of baseList) {
    place(b.id, b.type, b.base, `${b.type} baseline`);
    place(`${b.id}-twin`, b.type, b.base, `${b.type} baseline`);
  }
  const variants = OPTION_CASES.map(([type, base, variant], i) => {
    const id = `v-${i}-${type}-${Object.keys(variant).join('-')}`.toLowerCase();
    place(id, type, { ...base, ...variant }, `${type} baseline`);
    return { id, type, option: Object.keys(variant)[0], base: baseId(type, base) };
  });
  if (cards.length % 2 === 1) y += CATALOG_SIZE.h;
  // tabs, filter, inline html (two heights), library reuse, inspector target.
  cards.push({ id: 'c-tabs', title: 'Tabs', at: { x: 0, y, w: 6, h: 6 }, blocks: [{ tabs: { tabs: [
    { label: 'Trend', blocks: [{ line: { data: 'sessions' } }] },
    { label: 'Rows', blocks: [{ table: { data: 'plans' } }] },
  ] } }] });
  cards.push({ id: 'c-filter', title: 'Filter', at: { x: 6, y, w: 6, h: 8 }, blocks: [
    { filter: { data: 'plans', dim: 'country' } },
    { table: { data: 'plans', limit: 2 } },
  ] });
  y += 8;
  cards.push({ id: 'c-html-short', title: 'Html short', at: { x: 0, y, w: 6, h: 4 }, blocks: [{ html: { html: INLINE_HTML, inputs: { rows: 'plans' } } }] });
  cards.push({ id: 'c-html-tall', title: 'Html tall', at: { x: 6, y, w: 6, h: 8 }, blocks: [{ html: { html: INLINE_HTML, inputs: { rows: 'plans' } } }] });
  y += 8;
  cards.push({ id: 'c-lib-a', title: 'Library A', at: { x: 0, y, w: 6, h: 4 }, blocks: [{ html: { ref: 'kpi-tile', inputs: { rows: 'plans' } } }] });
  cards.push({ id: 'c-insp', title: 'Inspector target', at: { x: 6, y, w: 6, h: 4 }, blocks: [{ line: { data: 'sessions' } }] });
  return { spec: { title: 'Catalog', order: 90, cards }, baseList, variants };
}

// ─── Chart fixtures (sections 11-15) ─────────────────────────────────────────

/** 12 days, two series, every value distinct from its neighbours (an off-by-one hover reads a different number). */
const TREND_DAYS = Array.from({ length: 12 }, (_, i) => `2026-09-${String(17 + i).padStart(2, '0')}`);
const TREND = {
  alpha: [1200, 1350, 1280, 1500, 1620, 1490, 1710, 1800, 1760, 1950, 2040, 1990],
  beta: [600, 720, 650, 800, 770, 910, 880, 950, 1020, 990, 1100, 1180],
};
/** The dates the pointer visits (interior: an edge-clamped axis label never positions it). */
const HOVER_DATES = ['2026-09-19', '2026-09-22', '2026-09-26'];
/** One dim, mid values (450..4200: `compact` differs from `auto` here). [region, v, prev]. */
const REGIONS = [['north', 4200, 3900], ['south', 2600, 2800], ['east', 3400, 3100], ['west', 1500, 1600], ['central', 900, 850], ['islands', 450, 500]];
const REGIONS_TOTAL = REGIONS.reduce((s, r) => s + r[1], 0);
/** The bars the pointer visits (never the first or last category). */
const HOVER_BARS = ['south', 'east', 'west'];
/** One dim, big values (>= 10,000: `number` differs from `auto` here). */
const ACCOUNTS = [['enterprise', 86000, 80000], ['mid-market', 54000, 56000], ['smb', 31000, 29000], ['startup', 18000, 15000], ['nonprofit', 12000, 12500]];
/** The demo's country table, verbatim: [country, v, prev, n]. */
const COUNTRIES = [
  ['United States', 12400, 11800, 88100], ['Germany', 5200, 4900, 35600], ['United Kingdom', 4700, 4650, 31900],
  ['Brazil', 3900, 3350, 24800], ['Japan', 3300, 3400, 26100], ['India', 2900, 2400, 17200],
  ['France', 2600, 2500, 17800], ['Canada', 2100, 2050, 14900], ['Netherlands', 1400, 1290, 9800], ['Spain', 1300, 1210, 8700],
];

const tableScript = (dims, rows) => `export default async function () {
  const rows = ${JSON.stringify(rows)};
  const v = rows.reduce((s, r) => s + r.v, 0);
  return { kind: 'dataset/v1', primary: 'main', datasets: [{ key: 'main', dims: ${JSON.stringify(dims)}, rows,
    total: { v, n: rows.length, prev: rows.reduce((s, r) => s + (r.prev ?? 0), 0) } }] };
}`;
const CHART_INSIGHTS = [
  {
    slug: 'trend', title: 'Trend', render: 'line',
    script: `export default async function () {
  return ${JSON.stringify(Object.entries(TREND).map(([name, vs]) => ({ name, points: vs.map((v, i) => ({ t: TREND_DAYS[i], v })) })))};
}`,
  },
  {
    slug: 'big-trend', title: 'Big trend', render: 'line',
    script: `${DAYS_HELPER}
export default async function () {
  return [
    { name: 'enterprise', points: days(14).map((t, i) => ({ t, v: 42000 + i * 3500 + (i % 3) * 1200 })) },
    { name: 'smb', points: days(14).map((t, i) => ({ t, v: 12000 + i * 900 })) },
  ];
}`,
  },
  {
    slug: 'regions', title: 'Regions', render: 'table',
    script: tableScript([{ key: 'region', label: 'Region' }], REGIONS.map(([region, v, prev]) => ({ d: { region }, v, prev }))),
  },
  {
    slug: 'accounts', title: 'Accounts', render: 'table',
    script: tableScript([{ key: 'segment', label: 'Segment' }], ACCOUNTS.map(([segment, v, prev]) => ({ d: { segment }, v, prev }))),
  },
  {
    // Two dims, each (region, quarter) pair once: grouped / stacked bars and a heat matrix.
    slug: 'grid2', title: 'Region by quarter', render: 'table',
    script: tableScript([{ key: 'region', label: 'Region' }, { key: 'quarter', label: 'Quarter' }],
      ['north', 'south', 'east', 'west'].flatMap((region, r) => ['Q1', 'Q2', 'Q3', 'Q4'].map((quarter, q) => {
        const v = 1000 + r * 1700 + q * 600 + ((r * q) % 3) * 250;
        return { d: { region, quarter }, v, prev: v - 150 };
      }))),
  },
  {
    // Finding 3: the demo's "Top countries" table (a word unit, v / prev / n, long names).
    slug: 'countries', title: 'Top countries by active users', render: 'table', unit: 'users',
    script: `export default async function () {
  const rows = ${JSON.stringify(COUNTRIES.map(([country, v, prev, n]) => ({ d: { country }, v, prev, n })))};
  return { kind: 'dataset/v1', primary: 'main', datasets: [{ key: 'main', dims: [{ key: 'country', label: 'Country' }], rows,
    total: { v: rows.reduce((s, r) => s + r.v, 0), prev: rows.reduce((s, r) => s + r.prev, 0) } }] };
}`,
  },
];

/**
 * [type, base options (incl. data), variant options, { hover }]: one case per
 * catalog option VALUE the older OPTION_CASES does not cover (every non-default
 * enum value, every boolean flipped, one value per number/string). `hover`: the
 * value only shows in the tooltip, so both cards are also compared hovered.
 * A `format` case sits on data where that format differs from `auto` (auto =
 * grouped below 10,000, compact above): `number` on big values, the others on mid.
 */
const OPTION_VALUE_CASES = [
  ['stat', { data: 'signups' }, { size: 'sm' }],
  ['stat', { data: 'signups' }, { size: 'lg' }],
  ['stat', { data: 'signups' }, { goal: 500 }],
  ['stat', { data: 'big-trend', series: ['enterprise'] }, { format: 'compact' }],
  ['stat', { data: 'big-trend', series: ['enterprise'] }, { format: 'currency' }],

  ['line', { data: 'sessions' }, { curve: 'smooth' }],
  ['line', { data: 'sessions' }, { curve: 'step' }],
  ['line', { data: 'sessions' }, { points: 'always' }],
  ['line', { data: 'trend' }, { points: 'never' }],
  ['line', { data: 'sessions' }, { yMin: 'zero' }],
  ['line', { data: 'sessions' }, { reference: 100 }],
  ['line', { data: 'sessions', reference: 100 }, { referenceLabel: 'Target' }],
  ['line', { data: 'sessions' }, { legend: 'top' }],
  ['line', { data: 'sessions' }, { legend: 'right' }],
  ['line', { data: 'sessions' }, { legend: 'none' }],
  ['line', { data: 'sessions' }, { axes: 'x' }],
  ['line', { data: 'sessions' }, { axes: 'y' }],
  ['line', { data: 'sessions' }, { axes: 'none' }],
  ['line', { data: 'sessions' }, { grid: false }],
  ['line', { data: 'big-trend' }, { format: 'number' }],
  ['line', { data: 'trend' }, { format: 'compact' }],
  ['line', { data: 'trend' }, { format: 'percent' }],
  ['line', { data: 'trend' }, { format: 'currency' }],

  ['bar', { data: 'regions', orientation: 'v' }, { valueLabels: false }],
  ['bar', { data: 'regions' }, { topN: 3 }],
  // `sort` shorthands: unset ranks by value (= desc), so desc is compared against asc.
  ['bar', { data: 'regions' }, { sort: 'asc' }],
  ['bar', { data: 'regions' }, { sort: 'none' }],
  ['bar', { data: 'regions', sort: 'asc' }, { sort: 'desc' }],
  ['bar', { data: 'grid2', orientation: 'v' }, { group: 'stacked' }],
  ['bar', { data: 'accounts' }, { format: 'number' }],
  ['bar', { data: 'regions' }, { format: 'compact' }],
  ['bar', { data: 'regions' }, { format: 'percent' }],
  ['bar', { data: 'regions' }, { format: 'currency' }],
  ['bar', { data: 'regions', orientation: 'v' }, { axes: 'x' }],
  ['bar', { data: 'regions', orientation: 'v' }, { axes: 'y' }],
  ['bar', { data: 'regions', orientation: 'v' }, { axes: 'none' }],
  ['bar', { data: 'regions', orientation: 'v' }, { grid: false }],
  ['bar', { data: 'grid2', orientation: 'v' }, { legend: 'top' }],
  ['bar', { data: 'grid2', orientation: 'v' }, { legend: 'right' }],
  ['bar', { data: 'grid2', orientation: 'v' }, { legend: 'none' }],

  ['stacked', { data: 'sessions' }, { mode: 'area' }],
  ['stacked', { data: 'sessions' }, { normalize: true }],
  ['stacked', { data: 'sessions' }, { legend: 'top' }],
  ['stacked', { data: 'sessions' }, { legend: 'right' }],
  ['stacked', { data: 'sessions' }, { legend: 'none' }],
  ['stacked', { data: 'big-trend' }, { format: 'number' }],
  ['stacked', { data: 'trend' }, { format: 'compact' }],
  ['stacked', { data: 'trend' }, { format: 'percent' }],
  ['stacked', { data: 'trend' }, { format: 'currency' }],
  ['stacked', { data: 'sessions' }, { axes: 'x' }],
  ['stacked', { data: 'sessions' }, { axes: 'y' }],
  ['stacked', { data: 'sessions' }, { axes: 'none' }],
  ['stacked', { data: 'sessions' }, { grid: false }],

  ['pie', { data: 'regions' }, { centerTotal: true }],
  ['pie', { data: 'regions' }, { labels: 'outside' }],
  ['pie', { data: 'regions' }, { labels: 'inside' }],
  ['pie', { data: 'regions' }, { labels: 'none' }],
  ['pie', { data: 'regions' }, { topN: 3 }],
  ['pie', { data: 'regions' }, { color: 3 }],
  ['pie', { data: 'regions' }, { sort: 'none' }],
  ['pie', { data: 'regions' }, { sort: 'asc' }],
  ['pie', { data: 'accounts' }, { format: 'number' }, { hover: true }],
  ['pie', { data: 'regions' }, { format: 'compact' }, { hover: true }],
  ['pie', { data: 'regions' }, { format: 'percent' }, { hover: true }],
  ['pie', { data: 'regions' }, { format: 'currency' }, { hover: true }],

  ['table', { data: 'regions' }, { density: 'comfortable' }],
  ['table', { data: 'regions' }, { bars: true }],
  ['table', { data: 'regions' }, { deltaColor: false }],
  ['table', { data: 'accounts' }, { format: 'number' }],
  ['table', { data: 'regions' }, { format: 'compact' }],
  ['table', { data: 'regions' }, { format: 'percent' }],
  ['table', { data: 'regions' }, { format: 'currency' }],

  ['heatmap', { data: 'grid2' }, { scale: 'diverging' }],
  ['heatmap', { data: 'grid2' }, { cellLabels: true }],
  ['heatmap', { data: 'big-trend' }, { format: 'number' }, { hover: true }],
  ['heatmap', { data: 'trend' }, { format: 'compact' }, { hover: true }],
  ['heatmap', { data: 'trend' }, { format: 'percent' }, { hover: true }],
  ['heatmap', { data: 'trend' }, { format: 'currency' }, { hover: true }],

  ['funnel', { data: 'funnels' }, { showConversion: false }],
  ['callout', { markdown: 'Heads up' }, { tone: 'success' }],
  ['callout', { markdown: 'Heads up' }, { tone: 'warning' }],

  // Trend: every non-default enum value (the multi-series base, so a legend has entries to place).
  ['trend', { data: EXPLORER, switch: false }, { legend: 'right' }],
  ['trend', { data: EXPLORER, switch: false }, { legend: 'none' }],
  ['trend', { data: EXPLORER, switch: false }, { axes: 'y' }],
  ['trend', { data: EXPLORER, switch: false }, { axes: 'none' }],
  ['trend', { data: EXPLORER_PLUS, funnel: 'traffic' }, { format: 'number' }, { hover: true }],
  ['trend', { data: EXPLORER, switch: false }, { format: 'compact' }, { hover: true }],
  ['trend', { data: EXPLORER, switch: false }, { format: 'currency' }],
  ['funnel', { data: EXPLORER }, { layout: 'flow' }],
  // The v1 app insight: `nav` adds the page pills; `page` pins a page (the selected pill moves).
  ['insight', { data: APP }, { nav: true }],
  ['insight', { data: APP, nav: true }, { page: 'pricing' }],
];

/** One board per block type: every baseline beside its twin, then one card per option value. */
function optionBoardSpecs() {
  const types = [...new Set(OPTION_VALUE_CASES.map((c) => c[0]))];
  return types.map((type, ti) => {
    const cases = OPTION_VALUE_CASES.filter((c) => c[0] === type);
    const cards = [];
    let y = 0;
    const place = (id, opts, title) => {
      const { data, ...rest } = opts;
      cards.push({ id, title, at: { x: cards.length % 2 === 0 ? 0 : 6, y, ...CATALOG_SIZE }, blocks: [{ [type]: { ...(data ? { data } : {}), ...rest } }] });
      if (cards.length % 2 === 0) y += CATALOG_SIZE.h;
    };
    const bases = [];
    const baseOf = (base) => {
      const key = JSON.stringify(base);
      let b = bases.find((x) => x.key === key);
      if (!b) { b = { key, id: `ob-${type}-${bases.length}`, type, base, hover: false }; bases.push(b); }
      return b;
    };
    for (const [, base, , flags] of cases) if (flags?.hover) baseOf(base).hover = true; else baseOf(base);
    for (const b of bases) {
      place(b.id, b.base, `${type} baseline ${bases.indexOf(b) + 1}`);
      place(`${b.id}-twin`, b.base, `${type} baseline ${bases.indexOf(b) + 1} (twin)`);
    }
    const variants = cases.map(([, base, variant, flags], i) => {
      const [option, value] = Object.entries(variant)[0];
      const id = `ov-${type}-${i}-${option}-${String(value)}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
      place(id, { ...base, ...variant }, `${option}: ${String(value)} (vs baseline ${bases.indexOf(baseOf(base)) + 1})`);
      return { id, type, option, value, base: baseOf(base).id, hover: !!flags?.hover };
    });
    return { slug: `opt-${type}`, spec: { title: `Options: ${type}`, order: 100 + ti, cards }, bases, variants };
  });
}

/** The chart types that must fit their cell, each at a large and a small size: [type, block options, key (default the type)]. */
const FIT_CASES = [
  ['line', { data: 'trend' }],
  ['stacked', { data: 'trend' }],
  ['bar', { data: 'regions', orientation: 'v' }],
  ['pie', { data: 'regions' }],
  ['heatmap', { data: 'grid2', cellLabels: true }],
  ['stat', { data: 'big-trend', series: ['enterprise'], spark: true, delta: 'prev', goal: 150000 }],
  ['funnel', { data: 'funnels' }],
  // The funnel explorer blocks and the flow layout (segments scrolls with a sticky header instead).
  ['breakdown', { data: EXPLORER, counts: true }],
  ['trend', { data: EXPLORER }],
  ['benchmark', { data: EXPLORER }],
  ['segments', { data: EXPLORER, by: 'country' }],
  ['funnel', { data: EXPLORER, layout: 'flow', markWorst: true }, 'flow'],
];
const FIT_SIZES = { large: { w: 8, h: 6 }, small: { w: 3, h: 3 } };
/** Explorer blocks whose small cell may scroll inside the block (a table), with the header on top. */
const FIT_SCROLLERS = new Set(['segments']);
/** The explorer fit cases: also checked for clipped text, and shot for the owner. */
const EXPLORER_FIT = new Set(['breakdown', 'trend', 'benchmark', 'segments', 'flow']);
const fitKey = ([type, , key]) => key ?? type;

function fitBoardSpec() {
  const cards = [];
  let y = 0;
  for (const c of FIT_CASES) {
    const [type, opts] = c;
    const { data, ...rest } = opts;
    const block = { [type]: { data, ...rest } };
    cards.push({ id: `m-${fitKey(c)}-large`, title: `${fitKey(c)} large`, at: { x: 0, y, ...FIT_SIZES.large }, blocks: [block] });
    cards.push({ id: `m-${fitKey(c)}-small`, title: `${fitKey(c)} small`, at: { x: 8, y, ...FIT_SIZES.small }, blocks: [block] });
    y += FIT_SIZES.large.h;
  }
  // Scrolling blocks: a short cell so they must scroll, and the header must stay on top.
  cards.push({ id: 'm-table', title: 'Table scroll', at: { x: 0, y, w: 6, h: 3 }, blocks: [{ table: { data: 'plans' } }] });
  cards.push({ id: 'm-pivot', title: 'Pivot scroll', at: { x: 6, y, w: 6, h: 2 }, blocks: [{ pivot: { data: 'plans', rows: 'plan', cols: 'country' } }] });
  y += 3;
  cards.push({ id: 'm-tabs', title: 'Tabs', at: { x: 0, y, w: 4, h: 5 }, blocks: [{ tabs: { tabs: [
    { label: 'Weekly trend', blocks: [{ line: { data: 'trend' } }] },
    { label: 'Regional split', blocks: [{ pie: { data: 'regions' } }] },
    { label: 'Accounts', blocks: [{ table: { data: 'accounts' } }] },
  ] } }] });
  return { title: 'Fit and scroll', order: 120, cards };
}

function hoverBoardSpec() {
  return {
    title: 'Hover and color', order: 121, cards: [
      { id: 'hv-line-narrow', title: 'Line narrow', at: { x: 0, y: 0, w: 4, h: 5 }, blocks: [{ line: { data: 'trend' } }] },
      { id: 'hv-line-wide', title: 'Line wide', at: { x: 4, y: 0, w: 8, h: 5 }, blocks: [{ line: { data: 'trend' } }] },
      { id: 'hv-bar-narrow', title: 'Bar narrow', at: { x: 0, y: 5, w: 4, h: 5 }, blocks: [{ bar: { data: 'regions', orientation: 'v' } }] },
      { id: 'hv-bar-wide', title: 'Bar wide', at: { x: 4, y: 5, w: 8, h: 5 }, blocks: [{ bar: { data: 'regions', orientation: 'v' } }] },
      { id: 'hv-pie', title: 'Pie', at: { x: 0, y: 10, w: 6, h: 5 }, blocks: [{ pie: { data: 'regions' } }] },
      { id: 'cl-pie-filter', title: 'Filter and pie', at: { x: 6, y: 10, w: 6, h: 6 }, blocks: [{ filter: { data: 'regions', dim: 'region' } }, { pie: { data: 'regions' } }] },
      { id: 'cl-line', title: 'Line legend', at: { x: 0, y: 16, w: 6, h: 5 }, blocks: [{ line: { data: 'sessions' } }] },
      { id: 'cl-line-pick', title: 'Line pick', at: { x: 6, y: 16, w: 6, h: 5 }, blocks: [{ line: { data: 'sessions', series: ['ios', 'android'] } }] },
      { id: 'cl-stacked', title: 'Stacked legend', at: { x: 0, y: 21, w: 6, h: 5 }, blocks: [{ stacked: { data: 'sessions' } }] },
    ],
  };
}

// ─── Demo findings fixtures (sections 16-20) ─────────────────────────────────

/** Finding 5: a board name of ~24 characters (the demo's "Northwind Notes: growth" is 23). */
const FINDINGS_TITLE = 'Quarterly revenue review';
/** Finding 2: [key, block]: each drawn at every COMPACT_SIZES size. */
const COMPACT_CASES = [
  ['line', { line: { data: 'trend' } }],
  ['stacked', { stacked: { data: 'trend' } }],
  ['bar-h', { bar: { data: 'regions', orientation: 'h' } }],
  ['bar-v', { bar: { data: 'regions', orientation: 'v' } }],
  ['pie', { pie: { data: 'regions' } }],
  ['heatmap', { heatmap: { data: 'grid2' } }],
];
/**
 * The grid's extreme sizes and the size class each must draw in (fit.ts): a 2-row
 * cell leaves no room for axes (compact: a sparkline-style mark with end labels),
 * a 3x3 cell keeps its axes and yields the legend first (small).
 */
const COMPACT_SIZES = { '3x3': { w: 3, h: 3, size: 'small' }, '9x2': { w: 9, h: 2, size: 'compact' }, '12x2': { w: 12, h: 2, size: 'compact' } };
/** In compact mode the drawn plot is at least this share of its block's content box. */
const COMPACT_PLOT_MIN = 0.4;

/** Finding 4: the kit on INNER elements, inside one root card (which dissolves into the cell). */
const KIT_HTML = `<div class="dc-card" id="kit"><div class="dc-card-title" id="kit-title">Plans by kit</div>
<span class="dc-chip" id="chip">kit</span> <button class="dc-btn" id="btn">Now</button>
<div class="dc-tabs"><div class="dc-tablist"><button class="dc-tab dc-tab--on" id="tab-on">One</button><button class="dc-tab" id="tab-off">Two</button></div></div></div>`;
/** Finding 4: two root cards are a deliberate grid of boxes: each keeps its box. */
const TWO_CARDS_HTML = `<div class="dc-card" id="card-a"><div class="dc-card-title">A</div></div>
<div class="dc-card" id="card-b"><div class="dc-card-title">B</div></div>`;

/** Inside an html block's frame: the kit's computed styles on its inner elements, and every root dc-card's box. */
function kitInPage() {
  const cs = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      pad: `${s.paddingTop} ${s.paddingRight}`, radius: s.borderTopLeftRadius, weight: s.fontWeight, bg: s.backgroundColor,
      border: s.borderTopWidth, borderBottom: `${s.borderBottomWidth} ${s.borderBottomStyle}`, color: s.color, display: s.display,
    };
  };
  const cards = {};
  for (const el of document.querySelectorAll('body > .dc-card')) {
    const s = getComputedStyle(el);
    cards[el.id || `card${Object.keys(cards).length}`] = { pad: `${s.paddingTop} ${s.paddingLeft}`, border: s.borderTopWidth, bg: s.backgroundColor };
  }
  return {
    title: cs('kit-title') ?? cs('title'), chip: cs('chip'), btn: cs('btn'), tabOn: cs('tab-on'), tabOff: cs('tab-off'),
    plain: cs('plain'), cards,
  };
}
const transparent = (c) => !c || c === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(c);
/** The kit's own values (chatHtmlKit.ts): chip 3px 9px pill, title 650, button 5px 12px bordered, tab 6px 12px with an accent rule. */
function kitApplies(k, { buttons = true } = {}) {
  if (!k || !k.chip || !k.title) return false;
  const chip = k.chip.pad === '3px 9px' && parseFloat(k.chip.radius) >= 100 && Number(k.chip.weight) >= 600 && !transparent(k.chip.bg) && k.chip.display === 'inline-flex';
  const title = Number(k.title.weight) >= 650;
  const plain = !k.plain || k.plain.pad === '0px 0px';
  if (!buttons) return chip && title && plain;
  const btn = !!k.btn && k.btn.pad === '5px 12px' && k.btn.border === '1px' && !transparent(k.btn.bg);
  const tabs = !!k.tabOn && !!k.tabOff && k.tabOn.pad === '6px 12px' && k.tabOn.borderBottom === '2px solid' && k.tabOn.color !== k.tabOff.color;
  return chip && title && plain && btn && tabs;
}
const rootDissolved = (k, id) => !!k?.cards?.[id] && k.cards[id].pad === '0px 0px' && k.cards[id].border === '0px' && transparent(k.cards[id].bg);
const rootKept = (k, id) => !!k?.cards?.[id] && k.cards[id].pad === '14px 16px' && k.cards[id].border === '1px' && !transparent(k.cards[id].bg);

function findingsBoardSpec() {
  const cards = [];
  let y = 0;
  for (const [key, block] of COMPACT_CASES) {
    cards.push({ id: `f-${key}-9x2`, title: `${key} 9x2`, at: { x: 0, y, w: 9, h: 2 }, blocks: [block] });
    cards.push({ id: `f-${key}-3x3`, title: `${key} 3x3`, at: { x: 9, y, w: 3, h: 3 }, blocks: [block] });
    cards.push({ id: `f-${key}-12x2`, title: `${key} 12x2`, at: { x: 0, y: y + 3, w: 12, h: 2 }, blocks: [block] });
    y += 5;
  }
  // The demo's table exactly as the demo placed it (4x4, bound, bars on), and a 12-wide copy.
  cards.push({ id: 'f-table', title: 'Top countries', insight: 'countries', at: { x: 0, y, w: 4, h: 4 }, blocks: [{ table: { data: 'countries', bars: true } }] });
  // No title and no insight: no header row (finding 4). One root dc-card.
  cards.push({ id: 'f-untitled', at: { x: 4, y, w: 4, h: 4 }, blocks: [{ html: { html: KIT_HTML } }] });
  cards.push({ id: 'f-two-cards', title: 'Two cards', at: { x: 8, y, w: 4, h: 4 }, blocks: [{ html: { html: TWO_CARDS_HTML } }] });
  y += 4;
  cards.push({ id: 'f-table-wide', title: 'Top countries (wide)', insight: 'countries', at: { x: 0, y, w: 12, h: 4 }, blocks: [{ table: { data: 'countries', bars: true } }] });
  return { title: FINDINGS_TITLE, order: 0, cards };
}

/**
 * Finding 2, one card: its size class, the drawn plot against the block's content
 * box, every text box against the card, the y labels. The plot is the union of the
 * data marks (a line, an area, bars, slices, cells) and the plot rectangle they are
 * drawn in (gridlines, the axis rule, the hover area), never the frame, the axis
 * labels or the legend around them.
 */
function compactInPage(cardEl) {
  const c = cardEl.getBoundingClientRect();
  const chart = cardEl.querySelector('.lab-chart');
  const blk = cardEl.querySelector('.board-card-block');
  const bs = getComputedStyle(blk);
  const br = blk.getBoundingClientRect();
  const content = {
    w: br.width - parseFloat(bs.paddingLeft) - parseFloat(bs.paddingRight),
    h: br.height - parseFloat(bs.paddingTop) - parseFloat(bs.paddingBottom),
  };
  const u = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
  let marks = 0;
  for (const el of blk.querySelectorAll('path[data-series], rect[data-series], [data-bar], [data-slice], [data-heat-cell], [data-area], .lab-chart-grid line, .lab-chart-axis-line, [data-chart-hit]')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    if (el.matches('path[data-series], rect[data-series], [data-bar], [data-slice], [data-heat-cell], [data-area]')) marks += 1;
    u.l = Math.min(u.l, r.left); u.t = Math.min(u.t, r.top); u.r = Math.max(u.r, r.right); u.b = Math.max(u.b, r.bottom);
  }
  const plot = marks ? { w: (u.r - u.l) / content.w, h: (u.b - u.t) / content.h, px: [Math.round(u.r - u.l), Math.round(u.b - u.t)] } : { w: 0, h: 0, px: [0, 0] };
  // Every painted text: HTML text nodes by their range, SVG text by its box.
  const outside = [];
  const hidden = (el) => {
    for (let e = el; e && e !== cardEl.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
      if (/inset\(50%\)/.test(cs.clipPath) || (cs.position === 'absolute' && e.clientWidth <= 1 && e.clientHeight <= 1)) return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(cardEl, NodeFilter.SHOW_TEXT);
  let texts = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim() || hidden(n.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = n.parentElement.closest('svg') ? n.parentElement.getBoundingClientRect() : range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    texts += 1;
    if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) {
      outside.push(`"${n.textContent.trim().slice(0, 24)}" ${Math.round(r.left - c.left)},${Math.round(r.top - c.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(c.width)}x${Math.round(c.height)}`);
    }
  }
  return {
    size: chart?.getAttribute('data-size') ?? null,
    form: chart?.getAttribute('data-pie-form') ?? chart?.getAttribute('data-heat-form') ?? null,
    marks,
    plot,
    area: plot.w * plot.h,
    outside,
    texts,
    yTicks: cardEl.querySelectorAll('[data-axis="y"] .lab-chart-tick').length,
    xTicks: cardEl.querySelectorAll('[data-axis="x"] .lab-chart-tick').length,
    endLabels: cardEl.querySelectorAll('[data-end-label]').length,
    legend: cardEl.querySelectorAll('.lab-chart-legend-item').length,
    card: [Math.round(c.width), Math.round(c.height)],
    content: [Math.round(content.w), Math.round(content.h)],
  };
}

/**
 * Finding 3, one table card: horizontal scroll, cut cells, the rows that sit
 * wholly between the header and the total (cell rects: WebKit does not move a
 * row group's rect with sticky), the row tooltips and where the unit is written.
 */
function tableFitInPage(cardEl) {
  const wrap = cardEl.querySelector('.lab-table-wrap');
  const table = cardEl.querySelector('table');
  if (!wrap || !table) return null;
  const cut = [...table.querySelectorAll('td, th')].filter((el) => el.scrollWidth > el.clientWidth + 1)
    .map((el) => `${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 20)}" ${el.scrollWidth}>${el.clientWidth}`);
  const hScroll = [];
  for (let el = wrap; el && el !== cardEl.parentElement; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) hScroll.push(`${el.className || el.tagName} ${el.scrollWidth}>${el.clientWidth}`);
  }
  const heads = [...table.querySelectorAll('thead th')];
  const foots = [...table.querySelectorAll('tfoot td')];
  const headBottom = Math.max(...heads.map((th) => th.getBoundingClientRect().bottom));
  const w = wrap.getBoundingClientRect();
  const footTop = foots.length ? Math.min(...foots.map((td) => td.getBoundingClientRect().top)) : Infinity;
  const limit = Math.min(footTop, w.bottom);
  const rows = [...table.querySelectorAll('tbody tr')];
  const full = rows.filter((tr) => {
    const r = tr.querySelector('td').getBoundingClientRect();
    return r.top >= headBottom - 0.5 && r.bottom <= limit + 0.5;
  }).length;
  return {
    hScroll, cut, full, rows: rows.length,
    headBottom: Math.round(headBottom - w.top), footTop: Math.round(limit - w.top),
    columns: (table.getAttribute('data-columns') ?? '').split(',').filter(Boolean),
    dropped: (table.getAttribute('data-dropped') ?? '').split(',').filter(Boolean),
    headers: heads.map((th) => th.textContent.trim()),
    titles: rows.map((tr) => tr.getAttribute('title') ?? ''),
    // Each row: its label, whether it is the "Other" fold, its title and its cells keyed by column.
    byRow: rows.map((tr) => {
      const cols = (table.getAttribute('data-columns') ?? '').split(',');
      const tds = [...tr.querySelectorAll('td')];
      return {
        label: tds[0]?.textContent.trim() ?? '', other: tr.hasAttribute('data-other'), title: tr.getAttribute('title') ?? '',
        cells: Object.fromEntries(cols.map((c, i) => [c, tds[i]?.textContent.trim() ?? ''])),
      };
    }),
    bodyTexts: rows.flatMap((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())),
  };
}

// ─── Funnel explorer fixtures (sections 21-28) ───────────────────────────────

/** Signups by platform x language (the plus insight's own table): the selection narrows it, its total follows. */
const BY_PLATFORM = [
  ['Meta Ads', 'EN', 4210], ['Meta Ads', 'ES', 1880], ['Meta Ads', 'DE', 1270], ['Meta Ads', 'PT', 790],
  ['TikTok Ads', 'EN', 3150], ['TikTok Ads', 'ES', 1420], ['TikTok Ads', 'DE', 880], ['TikTok Ads', 'PT', 610],
  ['Unattributed', 'EN', 1040], ['Unattributed', 'ES', 420], ['Unattributed', 'DE', 310], ['Unattributed', 'PT', 190],
];
/** The plus insight's low-sample line: the Unattributed x EN path (about 2,000 users) falls under it, the others do not. */
const PLUS_LOW_SAMPLE = 2500;
/**
 * The plus insight: the demo script as-is (imported beside it), one more table,
 * a higher low-sample line, and a third funnel whose daily metric runs in the
 * tens of thousands (where a trend's `number` format differs from `auto`).
 */
const PLUS_SCRIPT = `import demo from './${EXPLORER}.mjs';
const ROWS = ${JSON.stringify(BY_PLATFORM.map(([platform, language, v]) => ({ d: { platform, language }, v })))};
const DAYS = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 15 + i)).toISOString().slice(0, 10));
export default async function () {
  const out = await demo();
  out.data.funnel.low_sample_threshold = ${PLUS_LOW_SAMPLE};
  out.data.funnel.funnels.push({
    id: 'traffic', name: 'Store traffic',
    steps: [{ key: 'visit', label: 'Visit', users: 48200 }, { key: 'browse', label: 'Browse', users: 31900 }],
    metrics: { visits: { v: 48200, prev: 45100, format: 'count', label: 'Visits' } },
    daily: DAYS.map((t, i) => ({ t, m: { visits: 41000 + i * 530 + (i % 3) * 1210 } })),
  });
  out.data.datasets.push({
    key: 'by_platform', label: 'Signups by platform', unit: 'signups',
    dims: [{ key: 'platform', label: 'Platform' }, { key: 'language', label: 'Language' }],
    rows: ROWS, total: { v: ROWS.reduce((s, r) => s + r.v, 0) },
  });
  return out;
}`;

/** The preset's tab labels (EN), in order: the pages, then one segments tab per client dim. */
const PRESET_TABS = ['Daily', 'Benchmark', 'Flow', 'Steps', 'Platform', 'Language', 'Country'];

/**
 * The demo board's separate cards (the plan's W4 setup), added one by one with
 * `lab board add-card --block` (a card of several blocks gets its first block
 * there and the rest through `lab board set`: add-card writes one block per
 * card). `explorer-proof` holds the extra cards some checks need, so the demo
 * board itself is exactly the plan's (its GET size is a criterion).
 */
const EXPLORER_CARDS = [
  { board: 'explorer-demo', id: 'x-steps', title: 'Steps', at: '0,12,8,7', blocks: [{ breakdown: { data: EXPLORER } }, { funnel: { data: EXPLORER, layout: 'bars', markWorst: true } }] },
  { board: 'explorer-demo', id: 'x-bench', title: 'Benchmark', at: '0,19,6,6', blocks: [{ breakdown: { data: EXPLORER } }, { benchmark: { data: EXPLORER } }] },
  { board: 'explorer-demo', id: 'x-countries', title: 'Countries', at: '6,19,6,6', blocks: [{ segments: { data: EXPLORER, by: 'country' } }] },
  // Payment: loss reasons as tables of the same insight (a stat reads value/series frames, not tables).
  { board: 'explorer-demo', id: 'x-payment', title: 'Payment', at: '0,25,6,6', blocks: [{ filter: { data: `${EXPLORER}/declines`, dim: 'cohort' } }, { bar: { data: `${EXPLORER}/declines` } }, { table: { data: `${EXPLORER}/decline_rate` } }] },
  { board: 'explorer-demo', id: 'x-daily', title: 'Daily', at: '6,25,6,4', blocks: [{ trend: { data: EXPLORER } }] },
  { board: 'explorer-demo', id: 'x-app', title: 'Onboarding app', at: '0,31,6,8', blocks: [{ insight: { data: APP, nav: true, page: 'overview' } }] },
  { board: 'explorer-proof', id: 'x-trend', title: 'Conversion trend', at: '0,0,6,4', blocks: [{ trend: { data: EXPLORER, metrics: ['conversion', 'visit_to_lead'] } }] },
  { board: 'explorer-proof', id: 'x-app-plain', title: 'App card', at: '6,0,3,4', blocks: [{ insight: { data: APP } }] },
  { board: 'explorer-proof', id: 'x-app-pinned', title: 'App pinned', at: '9,0,3,4', blocks: [{ insight: { data: APP, page: 'pricing' } }] },
  { board: 'explorer-proof', id: 'x-plus', title: 'Signups and declines', at: '0,4,12,14', blocks: [
    { breakdown: { data: EXPLORER_PLUS } },
    { segments: { data: EXPLORER_PLUS, by: 'platform' } },
    { table: { data: `${EXPLORER_PLUS}/by_platform` } },
    { table: { data: `${EXPLORER_PLUS}/declines`, limit: 4 } },
  ] },
];

const sameDims = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
/** The fixture's own path for a selection (lookup: exact match), or null. */
const fixtureSegment = (funnel, dims) => (Object.keys(dims).length === 0
  ? { dims: {}, users: funnel.steps[0].users, steps: funnel.steps, metrics: funnel.metrics, daily: funnel.daily, measured: true }
  : funnel.segments.find((s) => sameDims(s.dims, dims)) ?? null);
/** stepDrops, recomputed here from the fixture (never the UI's maths): dropPct per step, the worst the first max. */
function fixtureDrops(steps) {
  const out = steps.map((s, i) => ({ key: s.key, users: s.users, dropPct: i === 0 || !steps[i - 1].users ? null : (1 - s.users / steps[i - 1].users) * 100 }));
  let worst = null;
  for (const d of out) if (d.dropPct !== null && (worst === null || d.dropPct > worst.dropPct)) worst = d;
  return { drops: out, worst: worst?.key ?? null };
}
/** A band status as frameOps defines it, `better` deciding which way is good. */
function fixtureStatus(v, band) {
  if (v === null || v === undefined) return 'unmeasured';
  if (!band || (band.floor == null && band.target == null)) return 'no-band';
  const worse = (a, b) => (band.better === 'lower' ? a > b : a < b);
  if (band.floor != null && worse(v, band.floor)) return 'below';
  if (band.target != null && !worse(v, band.target)) return 'above';
  return 'between';
}
/** A shown number equals `want` at the precision it is shown with ("12.3%" vs 12.34). */
function shownEquals(text, want) {
  const s = String(text ?? '').replace(/ /g, ' ').replace('−', '-');
  const m = /(-?[\d,]*\.?\d+)\s*([KMB])?/i.exec(s);
  if (!m || want === null || want === undefined) return false;
  const k = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase()] ?? 1;
  const decimals = (m[1].split('.')[1] ?? '').length;
  return Number(m[1].replace(/,/g, '')) === Number((want / k).toFixed(decimals));
}
/** A stored block, in either spelling ({type, data, options, tabs} or the short {type: {...}}), as one shape. */
function normBlock(b) {
  if (!b || typeof b !== 'object') return b;
  let type;
  let data;
  let options;
  let tabs;
  if (typeof b.type === 'string') {
    ({ type, data } = b);
    options = { ...(b.options ?? {}) };
    tabs = b.tabs ?? options.tabs;
  } else {
    [type] = Object.keys(b);
    const { data: d, tabs: t, ...rest } = b[type] ?? {};
    data = d;
    tabs = t;
    options = rest;
  }
  delete options.tabs;
  const out = { type, data: data ?? null, options: Object.fromEntries(Object.entries(options).sort(([a], [z]) => a.localeCompare(z))) };
  if (tabs) out.tabs = tabs.map((tb) => ({ label: tb.label, blocks: (tb.blocks ?? []).map(normBlock) }));
  return out;
}
/** The block at a frame path ("1.3.0" = block 1, tab 3, child 0) of a stored card. */
function blockAtPath(cardData, path) {
  const [i, tab, child] = path.split('.').map(Number);
  const b = normBlock(cardData?.blocks?.[i]);
  if (tab === undefined) return b;
  return b?.tabs?.[tab]?.blocks?.[child] ?? null;
}

/** The project names registered on THIS machine (outside the repo): none may appear in what the explorer publishes. */
function registeredVaultNames() {
  const registry = join(homedir(), '.dreamcontext', 'vaults.json');
  if (!existsSync(registry)) return [];
  try {
    const parsed = JSON.parse(readFileSync(registry, 'utf8'));
    return (parsed.vaults ?? []).map((v) => v.name)
      .filter((n) => typeof n === 'string' && n.length > 2 && !['dreamcontext', 'proj', 'empty'].includes(n.toLowerCase()));
  } catch {
    return [];
  }
}

// ─── In-page measurement (run inside the page; no closures over this module) ──

/** A point where the mark is really under the pointer (elementFromPoint), scanning its box; else its centre. */
function markPointInPage(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    for (let gy = 1; gy < 8; gy++) {
      for (let gx = 1; gx < 8; gx++) {
        const x = r.x + (r.width * gx) / 8;
        const y = r.y + (r.height * gy) / 8;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit))) return { x, y };
      }
    }
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  return null;
}

/**
 * Fit + label geometry of one card: every box from the card down to the plot
 * (and any scrollable element inside the block) must not scroll; axis tick
 * boxes must not overlap (rotated labels: perpendicular spacing >= glyph
 * height); every chart label must lie inside the card.
 */
function measureCardInPage(cardEl) {
  const c = cardEl.getBoundingClientRect();
  const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ')[0]}`;
  const boxes = new Set([cardEl, ...cardEl.querySelectorAll('.board-card-body, .board-card-block, .board-card-block > *, .lab-chart, .lab-chart-plot')]);
  for (const el of cardEl.querySelectorAll('.board-card-block *')) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(`${cs.overflowX} ${cs.overflowY}`)) boxes.add(el);
  }
  const scroll = [];
  for (const el of boxes) {
    if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
      scroll.push(`${name(el)} ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
    }
  }
  const overlaps = [];
  for (const svg of cardEl.querySelectorAll('svg')) {
    const ticks = [...svg.querySelectorAll('[data-axis] .lab-chart-tick')].map((t) => ({
      text: t.textContent, r: t.getBoundingClientRect(), rotated: t.closest('[data-axis]').getAttribute('data-rotated') === 'true',
      axis: t.closest('[data-axis]').getAttribute('data-axis'), x: Number(t.getAttribute('x')), h: t.getBBox().height,
    }));
    for (let i = 0; i < ticks.length; i++) {
      for (let j = i + 1; j < ticks.length; j++) {
        const a = ticks[i];
        const b = ticks[j];
        if (a.rotated && b.rotated) {
          // Parallel -45deg strips: they clear when the anchors are a glyph height apart across the strip.
          if (Math.abs(a.x - b.x) * Math.SQRT1_2 < Math.min(a.h, b.h) * 0.8) overlaps.push(`${a.text} / ${b.text} (rotated)`);
          continue;
        }
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 1 && h > 1) overlaps.push(`${a.axis}:${a.text} / ${b.axis}:${b.text}`);
      }
    }
  }
  const outside = [];
  const labels = cardEl.querySelectorAll('.lab-chart-tick, [data-value-label], [data-pie-label], [data-cell-label], .lab-chart-legend-item, [data-center-total] text');
  for (const l of labels) {
    const r = l.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) {
      outside.push(`${name(l)} "${(l.textContent || '').slice(0, 24)}" ${Math.round(r.left - c.left)},${Math.round(r.top - c.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(c.width)}x${Math.round(c.height)}`);
    }
  }
  // How much of its block the drawing uses: the union of every painted leaf (marks, labels, legend).
  const blk = cardEl.querySelector('.board-card-block');
  let fill = null;
  if (blk) {
    const br = blk.getBoundingClientRect();
    const u = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
    for (const el of blk.querySelectorAll('*')) {
      if (el.children.length > 0 || el.matches('[data-chart-hit], svg, .lab-chart, .lab-chart-plot')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      u.l = Math.min(u.l, r.left); u.t = Math.min(u.t, r.top); u.r = Math.max(u.r, r.right); u.b = Math.max(u.b, r.bottom);
    }
    fill = u.r > u.l ? { w: (u.r - u.l) / br.width, h: (u.b - u.t) / br.height } : { w: 0, h: 0 };
  }
  return { scroll, overlaps, outside, fill, ticks: cardEl.querySelectorAll('[data-axis] .lab-chart-tick').length, size: [Math.round(c.width), Math.round(c.height)] };
}

/**
 * Every painted text in a card that is CUT: a text box reaching past an
 * ancestor that clips (overflow other than visible, up to the card), or an
 * element whose own text overflows its box while it clips (ellipsis). Hidden
 * text (screen-reader only, display none, a closed tooltip) is not painted.
 * Text inside a scrolling box is exempt on the axis it scrolls: a table
 * scrolls by design (its rows and columns are reached by scrolling, not cut).
 */
function clippedTextInPage(cardEl) {
  const out = [];
  const hidden = (el) => {
    for (let e = el; e && e !== cardEl.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
      if (/inset\(50%\)/.test(cs.clipPath) || /rect\(0/.test(cs.clip) || (cs.position === 'absolute' && e.clientWidth <= 1 && e.clientHeight <= 1)) return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(cardEl, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el || hidden(el) || el.closest('svg')) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const label = `"${n.textContent.trim().slice(0, 28)}"`;
    const ownCs = getComputedStyle(el);
    if (ownCs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) {
      out.push(`${label} overflows its ${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${el.scrollWidth}>${el.clientWidth}`);
      continue;
    }
    // A text range's box is the font's whole content area (ascent + descent), taller than its ink and
    // than a tight line box: vertically, only what reaches past that half-leading counts as cut.
    const slackY = Math.max(1, (r.height - parseFloat(ownCs.fontSize)) / 2 + 1);
    // Past a box that scrolls on an axis, that axis is reached by scrolling: outer clips no longer cut it.
    let viaScrollX = false;
    let viaScrollY = false;
    for (let a = el; a && a !== cardEl.parentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const clipsX = cs.overflowX !== 'visible' && !viaScrollX;
      const clipsY = cs.overflowY !== 'visible' && !viaScrollY;
      if (!clipsX && !clipsY) continue;
      const scrollsY = /(auto|scroll)/.test(cs.overflowY);
      const scrollsX = /(auto|scroll)/.test(cs.overflowX);
      const ar = a.getBoundingClientRect();
      const bx = a.clientLeft;
      const by = a.clientTop;
      const cutX = clipsX && !scrollsX && (r.left < ar.left + bx - 1 || r.right > ar.left + bx + a.clientWidth + 1);
      const cutY = clipsY && !scrollsY && (r.top < ar.top + by - slackY || r.bottom > ar.top + by + a.clientHeight + slackY);
      if (cutX || cutY) {
        out.push(`${label} cut by ${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]} (${cutX ? 'x' : ''}${cutY ? 'y' : ''}) text ${Math.round(r.left - ar.left)},${Math.round(r.top - ar.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${a.clientWidth}x${a.clientHeight}`);
        break;
      }
      viaScrollX = viaScrollX || scrollsX;
      viaScrollY = viaScrollY || scrollsY;
    }
  }
  return out;
}

/**
 * What the funnel explorer blocks under `root` SHOW: text, geometry and aria
 * state read from the rendered DOM (the data-* hooks only locate things; the
 * numbers compared are the painted ones).
 */
function explorerInPage(root) {
  const num = (s) => {
    const m = /-?[\d,]*\.?\d+/.exec(String(s ?? '').replace(/−/g, '-'));
    return m ? Number(m[0].replace(/,/g, '')) : null;
  };
  const ownText = (el) => [...(el?.childNodes ?? [])].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const visible = (el) => {
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const center = (el, ref) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2 - ref.left;
  };
  const q = (sel) => [...root.querySelectorAll(sel)].filter(visible);

  const chips = q('[data-lab-breakdown-chip]').map((c) => ({
    dim: c.closest('[data-lab-breakdown-dim]')?.getAttribute('data-lab-breakdown-dim') ?? null,
    value: c.getAttribute('data-lab-breakdown-chip'),
    pressed: c.getAttribute('aria-pressed') === 'true',
    disabled: c.getAttribute('aria-disabled') === 'true',
    text: c.innerText.trim(),
  }));
  const fx = root.querySelector('[data-lab-funnel-explorer]');
  const bars = q('.funnel-bars-row').map((r) => ({
    label: r.querySelector('.funnel-bars-label')?.textContent.trim() ?? '',
    users: num(ownText(r.querySelector('.funnel-bars-value'))),
    worst: r.hasAttribute('data-lab-worst'),
  }));
  const flowEl = q('[data-lab-flow]')[0];
  const flow = flowEl ? {
    stages: [...flowEl.querySelectorAll('[data-lab-flow-stage]')].map((s) => {
      const track = s.querySelector('.funnel-flow-track').getBoundingClientRect();
      const shape = s.querySelector('.funnel-flow-shape').getBoundingClientRect();
      return {
        key: s.getAttribute('data-lab-flow-stage'), label: s.querySelector('.funnel-flow-label')?.textContent.trim() ?? '',
        users: num(ownText(s.querySelector('.funnel-flow-value'))), widthPct: track.width > 0 ? (shape.width / track.width) * 100 : null,
      };
    }),
    links: [...flowEl.querySelectorAll('[data-lab-drop]')].map((l) => ({
      key: l.getAttribute('data-lab-drop'), badges: l.querySelectorAll('.funnel-flow-badge').length,
      badge: l.querySelector('.funnel-flow-badge-pct')?.textContent.trim() ?? '', worst: l.hasAttribute('data-lab-worst'),
      worstWord: l.querySelector('.funnel-flow-worst')?.textContent.trim() ?? '',
    })),
  } : null;
  const lanesEl = q('[data-lab-lanes]').find((e) => e.classList.contains('funnel-lanes'));
  const lanes = lanesEl ? {
    n: Number(lanesEl.getAttribute('data-lab-lanes')),
    heads: [...lanesEl.querySelectorAll('.funnel-lanes-head')].map((h) => {
      const r = h.getBoundingClientRect();
      return { lane: Number(h.getAttribute('data-lab-lane')), name: h.querySelector('.funnel-lanes-name')?.textContent.trim() ?? '', left: r.left, top: r.top };
    }),
    cells: [...lanesEl.querySelectorAll('.funnel-lanes-cell')].map((c) => ({
      lane: Number(c.getAttribute('data-lane')), missing: c.getAttribute('data-lab-lane-missing'),
      users: c.hasAttribute('data-lab-lane-missing') ? null : num(ownText(c.querySelector('.funnel-lanes-value'))), text: c.innerText.trim(),
    })),
    spine: [...lanesEl.querySelectorAll('[data-lab-lane-step]')].map((s) => s.getAttribute('data-lab-lane-step')),
    drops: [...lanesEl.querySelectorAll('.funnel-lanes-drop[data-lab-drop]')].map((d) => ({
      lane: Number(d.getAttribute('data-lane')), key: d.getAttribute('data-lab-drop'), text: d.textContent.trim(), worst: d.hasAttribute('data-lab-worst'),
    })),
  } : null;
  const bench = q('[data-lab-bench-row]').map((row) => {
    const ruler = row.querySelector('[data-lab-bench-ruler]');
    const rr = ruler ? ruler.getBoundingClientRect() : null;
    const mark = (sel) => {
      const el = ruler?.querySelector(sel);
      return el && rr ? center(el, rr) : null;
    };
    return {
      key: row.getAttribute('data-lab-bench-row'), status: row.getAttribute('data-status'), better: row.getAttribute('data-better'),
      trend: row.getAttribute('data-trend'), label: row.querySelector('.lab-bench-label')?.textContent.trim() ?? '',
      value: row.querySelector('[data-lab-bench-value]')?.textContent.trim() ?? null,
      delta: row.querySelector('.lab-bench-delta-text')?.textContent.trim() ?? null,
      trendWord: row.querySelector('.lab-bench-trend')?.textContent.trim() ?? null,
      statusWord: row.querySelector('.lab-bench-status-word')?.textContent.trim() ?? null,
      sources: row.querySelector('[data-lab-bench-source]')?.textContent.trim() ?? null,
      unmeasured: row.querySelector('[data-lab-bench-unmeasured]')?.textContent.trim() ?? null,
      markers: { floor: mark('[data-lab-bench-floor]'), target: mark('[data-lab-bench-target]'), current: mark('[data-lab-bench-current]'), prev: mark('[data-lab-bench-prev]') },
      anyMarker: !!row.querySelector('.lab-bench-mark'),
      boundLabels: { floor: row.querySelector('[data-lab-bench-bound-label="floor"]')?.textContent.trim() ?? null, target: row.querySelector('[data-lab-bench-bound-label="target"]')?.textContent.trim() ?? null },
      prevValue: row.querySelector('[data-lab-bench-prev-value]')?.textContent.trim() ?? null,
      // A per-row inherited mark: an attribute on the row or inside it, or the word in the row's own text.
      inheritedMark: row.hasAttribute('data-inherited') || !!row.querySelector('[data-inherited], [data-lab-bench-inherited]') || /inherit|whole funnel/i.test(row.innerText),
      text: row.innerText.replace(/\s+/g, ' ').trim(),
    };
  });
  const segEl = q('[data-lab-segments]')[0];
  const seg = segEl ? {
    by: segEl.getAttribute('data-by'),
    headers: [...segEl.querySelectorAll('thead th')].map((th) => ({ col: th.getAttribute('data-col'), sort: th.getAttribute('aria-sort'), text: th.textContent.trim() })),
    rows: [...segEl.querySelectorAll('tbody tr')].map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      return {
        value: tr.getAttribute('data-lab-segment-row'), active: tr.hasAttribute('data-active'), low: tr.hasAttribute('data-lab-low-sample'),
        unmeasured: tr.hasAttribute('data-lab-unmeasured'), opacity: Number(getComputedStyle(tr).opacity) * Number(getComputedStyle(tds[0] ?? tr).opacity),
        users: tds[1]?.querySelector('[data-lab-seg-unmeasured]') ? null : num(tds[1]?.textContent),
        usersText: tds[1]?.innerText.trim() ?? '',
        cells: Object.fromEntries([...tr.querySelectorAll('td[data-metric]')].map((td) => [td.getAttribute('data-metric'), {
          text: td.querySelector('.lab-seg-v')?.textContent.trim() ?? null, dash: !!td.querySelector('[data-lab-seg-unmeasured]'),
          tone: td.getAttribute('data-tone'), bg: getComputedStyle(td).backgroundColor,
        }])),
      };
    }),
    notes: [...segEl.querySelectorAll('.lab-seg-note')].map((n) => n.textContent.trim()),
  } : null;
  const trendEl = q('[data-lab-trend]')[0];
  const trend = trendEl ? {
    state: trendEl.getAttribute('data-state'),
    series: trendEl.querySelector('[data-lab-trend-series]')?.getAttribute('data-lab-trend-series') ?? null,
    metrics: [...trendEl.querySelectorAll('[data-lab-trend-metric]')].map((b) => ({ key: b.getAttribute('data-lab-trend-metric'), on: b.getAttribute('aria-checked') === 'true' })),
    paths: [...trendEl.querySelectorAll('path[data-series]')].map((p) => p.getAttribute('d')).join('|'),
  } : null;
  return {
    chips, bars, flow, lanes, bench, seg, trend,
    funnel: fx ? { layout: fx.getAttribute('data-lab-funnel-explorer'), id: fx.getAttribute('data-lab-funnel'), selection: fx.getAttribute('data-lab-selection'), measured: fx.getAttribute('data-lab-measured') } : null,
    notMeasured: q('[data-lab-not-measured]').map((e) => e.textContent.trim()),
    notSplit: q('[data-lab-not-split]').map((e) => e.textContent.trim()),
    worstNote: root.querySelector('[data-lab-worst-note]')?.getAttribute('data-lab-worst-note') ?? null,
    pin: (() => { const p = root.querySelector('[data-lab-lane-pin]'); return p ? { disabled: p.disabled, blocked: p.getAttribute('data-blocked') } : null; })(),
    laneChips: q('[data-lab-breakdown-lanes] [data-lab-lane]').length,
    benchMore: (() => { const e = q('.lab-bench-more')[0]; return e ? num(e.textContent) : 0; })(),
  };
}

/**
 * The explorer card's chrome as a user sees it: every pressed breakdown chip's
 * label contrast (its colour over its own background composited on the first
 * opaque ancestor), and the blank band between the breakdown's painted content
 * and the next block.
 */
function chipsAndBandInPage(cardEl) {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    const s = /color\(srgb ([^)]+)\)/.exec(c);
    if (s) {
      const p = s[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) out = over(l, out);
    return out;
  };
  const chips = [...cardEl.querySelectorAll('[data-lab-breakdown-chip][aria-pressed="true"], [data-lab-breakdown-all][aria-pressed="true"]')].map((c) => {
    const label = c.querySelector('.lab-breakdown-chip-value') ?? c;
    const fg = parse(getComputedStyle(label).color);
    const bg = backdrop(c);
    if (!fg) return { value: c.textContent.trim(), ratio: null, fg: getComputedStyle(label).color };
    const ink = fg.a < 1 ? over(fg, bg) : fg;
    const [hi, lo] = [lum(ink), lum(bg)].sort((a, b) => b - a);
    return { value: c.textContent.trim(), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, fg: getComputedStyle(label).color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` };
  });
  const blk = cardEl.querySelector('.board-card-block[data-lab-block="breakdown"]');
  let band = null;
  if (blk && blk.nextElementSibling) {
    let bottom = -Infinity;
    for (const el of blk.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) bottom = Math.max(bottom, r.bottom);
    }
    const next = blk.nextElementSibling.getBoundingClientRect();
    band = Math.round(next.top - bottom);
  }
  return { chips, band };
}

/**
 * Small-cell legibility of one card's explorer block: every box a user must see
 * (flow stage labels and users, breakdown selects / chips / pins) has a real
 * size and lies inside the card, with no clipping ancestor cutting it.
 */
function smallFormInPage(cardEl) {
  const c = cardEl.getBoundingClientRect();
  const problems = [];
  const visibleBox = (el, minH) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return 'hidden';
    if (r.height < minH || r.width < 4) return `${Math.round(r.width)}x${Math.round(r.height)}px`;
    if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) return `outside the card at ${Math.round(r.left - c.left)},${Math.round(r.top - c.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(c.width)}x${Math.round(c.height)}`;
    for (let a = el.parentElement; a && a !== cardEl.parentElement; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (r.left < ar.left - 1 || r.right > ar.right + 1 || r.top < ar.top - 1 || r.bottom > ar.bottom + 1) return `cut by ${a.className.split(' ')[0]}`;
    }
    return null;
  };
  const flow = cardEl.querySelector('[data-lab-flow]');
  const stages = flow ? [...flow.querySelectorAll('[data-lab-flow-stage]')] : [];
  for (const st of stages) {
    for (const [what, el] of [['label', st.querySelector('.funnel-flow-label')], ['users', st.querySelector('.funnel-flow-value')]]) {
      const bad = el ? visibleBox(el, 8) : 'missing';
      if (bad) problems.push(`flow ${st.getAttribute('data-lab-flow-stage')} ${what}: ${bad}`);
    }
  }
  const bd = cardEl.querySelector('[data-lab-breakdown]');
  const controls = bd ? [...bd.querySelectorAll('[data-lab-breakdown-select], [data-lab-breakdown-chip], [data-lab-breakdown-all], [data-lab-lane-pin], .lab-breakdown-dim-label')] : [];
  for (const el of controls) {
    const bad = visibleBox(el, 8);
    if (bad) problems.push(`breakdown ${el.getAttribute('data-lab-breakdown-select') ?? el.getAttribute('data-lab-breakdown-chip') ?? el.className.split(' ')[0]}: ${bad}`);
  }
  return {
    problems,
    flowMode: flow?.getAttribute('data-flow-mode') ?? null,
    stages: stages.length,
    breakdownCompact: bd?.getAttribute('data-compact') === 'true',
    selects: bd ? bd.querySelectorAll('[data-lab-breakdown-select]').length : 0,
    chips: bd ? bd.querySelectorAll('[data-lab-breakdown-chip]').length : 0,
  };
}

/**
 * Every trend metric switch under `root`: segmented buttons must show their
 * whole label (no ellipsis); a select must be wide enough for its selected
 * label (measured in the select's own font, minus its padding and arrow).
 */
function trendSwitchInPage(root) {
  const out = [];
  const ctx = document.createElement('canvas').getContext('2d');
  for (const sw of root.querySelectorAll('[data-lab-trend-switch]')) {
    if (sw.tagName === 'SELECT') {
      const cs = getComputedStyle(sw);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const label = sw.options[sw.selectedIndex]?.textContent ?? '';
      const room = sw.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const need = ctx.measureText(label).width;
      out.push({ form: 'select', label, cut: need > room + 0.5, need: Math.round(need), room: Math.round(room) });
    } else {
      // A button cut by the switch row (it overflows the row's box) is as unreadable as an ellipsized one.
      const row = sw.getBoundingClientRect();
      for (const b of sw.querySelectorAll('[data-lab-trend-metric]')) {
        const r = b.getBoundingClientRect();
        const outside = r.left < row.left - 1 || r.right > row.right + 1;
        out.push({ form: 'buttons', label: b.textContent, cut: b.scrollWidth > b.clientWidth + 1 || outside, need: b.scrollWidth, room: b.clientWidth, outside });
      }
    }
  }
  return out;
}

/**
 * The segments table as a reader meets it: words broken across lines (a word
 * whose text spans 2 line boxes), the value column stuck on the left and the
 * last column reachable after scrolling the table to its end, and every
 * band-tinted cell's figure contrast over its composited tint.
 */
async function segmentsTableInPage(cardEl) {
  const wrap = cardEl.querySelector('[data-lab-segments] .lab-table-wrap');
  const table = wrap?.querySelector('table');
  if (!wrap || !table) return null;
  const broken = [];
  for (const cell of table.querySelectorAll('th, td')) {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text))) {
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) broken.push(m[0]);
      }
    }
  }
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    const s = /color\(srgb ([^)]+)\)/.exec(c);
    if (s) { const p = s[1].split(/[\s/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const lum = (c) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let o = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) o = over(l, o);
    return o;
  };
  const tints = [...table.querySelectorAll('td[data-tone]')].map((td) => {
    const fig = td.querySelector('.lab-seg-v') ?? td;
    const fg = parse(getComputedStyle(fig).color);
    const bg = backdrop(td);
    const ink = fg && fg.a < 1 ? over(fg, bg) : fg;
    const [hi, lo] = ink ? [lum(ink), lum(bg)].sort((a, b) => b - a) : [0, 0];
    return { tone: td.getAttribute('data-tone'), ratio: ink ? Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 : null };
  });
  const scrolls = wrap.scrollWidth > wrap.clientWidth + 1;
  const firstHead = table.querySelector('thead th');
  const lastHead = [...table.querySelectorAll('thead th')].pop();
  const firstLeft0 = firstHead.getBoundingClientRect().left;
  wrap.scrollLeft = wrap.scrollWidth;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const w = wrap.getBoundingClientRect();
  const lr = lastHead.getBoundingClientRect();
  const fr = firstHead.getBoundingClientRect();
  const firstCell = table.querySelector('tbody td');
  const fc = firstCell?.getBoundingClientRect();
  const hitFirst = fc ? document.elementFromPoint(fc.left + Math.min(8, fc.width / 2), fc.top + fc.height / 2) : null;
  const hitLast = document.elementFromPoint(Math.max(lr.left + 2, lr.right - 6), lr.top + lr.height / 2);
  return {
    broken, tints, scrolls, scrolled: wrap.scrollLeft,
    lastVisible: lr.right <= w.right + 1 && lr.left >= fr.right - 1 && !!hitLast && (hitLast === lastHead || lastHead.contains(hitLast)),
    stickyFirst: Math.abs(fr.left - firstLeft0) <= 1 && !!hitFirst && (hitFirst === firstCell || firstCell.contains(hitFirst)),
    lastLabel: lastHead.textContent.trim(),
  };
}

/** The text contrast of every element matching `selector` under `root` (its ink over its composited backdrop). */
function contrastInPage(root, selector) {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    const s = /color\(srgb ([^)]+)\)/.exec(c);
    if (s) { const p = s[1].split(/[\s/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const lum = (c) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  return [...root.querySelectorAll(selector)].map((el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) bg = over(l, bg);
    const fg = parse(getComputedStyle(el).color);
    if (!fg) return { text: el.textContent.trim(), ratio: null };
    const ink = fg.a < 1 ? over(fg, bg) : fg;
    const [hi, lo] = [lum(ink), lum(bg)].sort((a, b) => b - a);
    return { text: el.textContent.trim(), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, fg: getComputedStyle(el).color };
  });
}

/** Scroll a card's scrolling block to its end; the header cell must still sit at the scroller's top, on top. */
async function stickyInPage(cardEl) {
  const sc = [...cardEl.querySelectorAll('.board-card-block *')].find((e) => {
    const cs = getComputedStyle(e);
    return /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1;
  });
  if (!sc) return { scrolls: false };
  const th = sc.querySelector('thead th, [role="columnheader"]');
  if (!th) return { scrolls: true, header: false };
  const before = th.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  sc.scrollTop = sc.scrollHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const a = sc.getBoundingClientRect();
  const b = th.getBoundingClientRect();
  const hit = document.elementFromPoint(b.x + Math.min(8, b.width / 2), b.y + b.height / 2);
  const out = { scrolls: true, header: true, scrolled: sc.scrollTop, before: Math.round(before), after: Math.round(b.top - a.top), onTop: !!hit && (hit === th || th.contains(hit)) };
  sc.scrollTop = 0;
  return out;
}

/**
 * Every heading card: the text it PAINTS inside the card, outside its menu (the menu's glyph is
 * not a heading). A text node counts when its box is non-empty, inside the card and no ancestor
 * hides it (visibility, display, opacity 0, transparent ink).
 */
function headingsInPage(root) {
  return [...root.querySelectorAll('[data-lab-card^="h-"]')].map((cardEl) => {
    const c = cardEl.getBoundingClientRect();
    const painted = [];
    const walker = document.createTreeWalker(cardEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest('[data-lab-card-menu], .board-card-heading-menu, .board-card-menu')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      let shown = r.width > 0 && r.height > 0 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
      for (let el = n.parentElement; shown && el && el !== cardEl.parentElement; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0 || cs.color === 'rgba(0, 0, 0, 0)') shown = false;
      }
      if (shown) painted.push(n.textContent.trim());
    }
    return { id: cardEl.getAttribute('data-lab-card'), text: painted.join(' ').slice(0, 60) };
  });
}

/** Every tab label's text box against its button and the tab bar; a clipped button (scroll > client) counts too. */
function tabsInPage(cardEl) {
  const bar = cardEl.querySelector('.lab-block-tabs-bar, [role="tablist"]');
  if (!bar) return null;
  const br = bar.getBoundingClientRect();
  const inside = (o, i) => i.left >= o.left - 0.5 && i.right <= o.right + 0.5 && i.top >= o.top - 0.5 && i.bottom <= o.bottom + 0.5;
  return [...bar.querySelectorAll('[role="tab"]')].map((b) => {
    const range = document.createRange();
    range.selectNodeContents(b);
    const r = range.getBoundingClientRect();
    const bb = b.getBoundingClientRect();
    return {
      label: b.textContent, inBar: inside(br, r), inButton: inside(bb, r),
      clipped: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1,
      text: [Math.round(r.top), Math.round(r.bottom)], button: [Math.round(bb.top), Math.round(bb.bottom)],
    };
  });
}

/** The first number in a formatted value ("1,710", "4.2K", "$2,600", "34.5%"); K/M/B expand. */
function parseShown(s) {
  const m = /(-?[\d.,]+)\s*([KMB])?/i.exec(String(s ?? '').replace(/ /g, ' '));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  const k = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase()] ?? 1;
  return Number.isFinite(n) ? n * k : null;
}

/** "Sep 20" (the day axis) as its YYYY-MM-DD in the fixture's year; anything else is null. */
function parseDayTick(text) {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})$/.exec(String(text).trim());
  if (!m) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1]);
  return month < 0 ? null : `2026-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
const dayMs = (key) => Date.parse(`${key}T00:00:00Z`);

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { syncOut, probeOut } = setup();
  ok('setup: the probed insight skipped its fetch as upstream-unchanged (1 probe, 0 fetches)',
    /upstream-unchanged|upstream unchanged/i.test(probeOut), probeOut.slice(0, 400));
  ok('setup: the broken insight failed its first sync (recently-errored fixture)', /broken-metric/.test(syncOut), syncOut.slice(0, 300));
  const catalog = JSON.parse(dc(['lab', 'block', 'list', '--json'])).catalog;
  /** The explorer fixture's own payload: every expected explorer number comes from here, never from the UI. */
  const demo = await (await import(pathToFileURL(EXPLORER_FIXTURE).href)).default();
  const quiz = demo.data.funnel.funnels.find((f) => f.id === 'quiz-checkout');
  const setBands = demo.data.funnel.benchmarks;
  const stepLabel = (key) => quiz.steps.find((s) => s.key === key)?.label ?? key;
  const pathOf = (seg) => (seg?.steps ?? []).map((s) => [stepLabel(s.key), s.users]);

  // Another checkout's verify run on this port would be tested instead of ours: refuse.
  const taken = await fetch(`${BASE}/api/lab`).then(() => true, () => false);
  if (taken) throw new Error(`port ${PORT} is already serving something; stop it first (lsof -nP -iTCP:${PORT})`);
  if (MUTATION === 'symlink-follow') ENTRY = mutatedDist();
  const server = spawn('node', [ENTRY, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(`${BASE}/api/lab`);
    browser = await webkit.launch();
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    sectionPage = page;
    // The What's New modal can open at any point after load; dismiss it whenever it covers an action.
    await page.addLocatorHandler(page.locator('.announcements-modal-scrim'), async () => {
      const gotIt = page.getByRole('button', { name: /^got it$/i });
      if (await gotIt.count()) await gotIt.first().click();
      else await page.keyboard.press('Escape');
    });
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    const bundle = BUNDLE_MUTATIONS[MUTATION];
    const bundlePairs = bundle ? (Array.isArray(bundle[0]) ? bundle : [bundle]) : [];
    const pairHits = bundlePairs.map(() => 0);
    let bundlePatched = 0;
    if (bundle) {
      await page.route(/\/assets\/.*\.js(\?.*)?$/, async (route) => {
        const res = await route.fetch();
        const body = await res.text();
        let next = body;
        bundlePairs.forEach(([re, rep], i) => {
          const after = next.replace(re, rep);
          if (after !== next) pairHits[i] += 1;
          next = after;
        });
        if (next !== body) bundlePatched += 1;
        await route.fulfill({ response: res, body: next });
      });
    }
    const cssMutation = CSS_MUTATIONS[MUTATION];
    if (cssMutation) {
      await page.route(/\/assets\/.*\.css(\?.*)?$/, async (route) => {
        const res = await route.fetch();
        bundlePatched += 1;
        await route.fulfill({ response: res, body: `${await res.text()}\n${cssMutation}\n` });
      });
    }
    if (MUTATION === 'put-lies') {
      await page.route(/\/api\/lab\/boards\/[^/?]+$/, async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        const res = await route.fetch({ method: 'GET', postData: undefined });
        await route.fulfill({ response: res });
      });
    }

    /** Every request to /api/lab/sync*, split by method. */
    const syncReqs = [];
    page.on('request', (req) => { if (/\/api\/lab\/sync/.test(req.url())) syncReqs.push({ method: req.method(), url: req.url(), at: Date.now() }); });
    const syncPosts = (since = 0) => syncReqs.filter((r) => r.method === 'POST' && r.at >= since);
    const putStatuses = [];
    page.on('response', (res) => {
      if (res.request().method() === 'PUT' && /\/api\/lab\/boards\//.test(res.url())) putStatuses.push(res.status());
    });

    const setTheme = async (t) => {
      await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t);
      await sleep(250);
    };
    if (SHOTS_OUT) mkdirSync(SHOTS_OUT, { recursive: true });
    /** Save to the scratch shots dir, and to --shots when given. */
    const saveShot = async (name, take) => {
      await take(join(SHOTS, name));
      if (SHOTS_OUT) cpSync(join(SHOTS, name), join(SHOTS_OUT, name));
    };
    if (EXPLORER_SHOTS_OUT) mkdirSync(EXPLORER_SHOTS_OUT, { recursive: true });
    /** A funnel explorer shot: the scratch dir (prefixed), --shots, and --explorer-shots when given. */
    const saveExplorerShot = async (name, take) => {
      await saveShot(`explorer-${name}`, take);
      if (EXPLORER_SHOTS_OUT) cpSync(join(SHOTS, `explorer-${name}`), join(EXPLORER_SHOTS_OUT, name));
    };
    /** An explorer shot in both themes: `<name>-light.png`, `<name>-dark.png`. */
    const explorerShotBoth = async (name, take) => {
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await saveExplorerShot(`${name}-${theme}.png`, take);
      }
      await setTheme('light');
    };
    /**
     * Both themes. The board scrolls inside the app shell (a fullPage shot is just
     * the viewport), so the viewport grows to the board's height for the shot.
     */
    const shoot = async (name, { explorer = false } = {}) => {
      // The page's main scroller: the tallest scrolling box around or inside the board (a table's own scroller is small).
      const need = await page.evaluate(() => {
        const b = document.querySelector('[data-lab-board]');
        if (!b) return 0;
        const around = [];
        for (let el = b; el; el = el.parentElement) around.push(el);
        const scrollers = [...around, ...b.querySelectorAll('*')].filter((el) => el.clientHeight > 300
          && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1);
        const main = scrollers.sort((p, q) => q.clientHeight - p.clientHeight)[0];
        if (!main) return 0;
        main.scrollTop = 0;
        return main.scrollHeight - main.clientHeight;
      });
      const tall = Math.min(16000, 1000 + Math.max(0, need));
      if (tall > 1000) { await page.setViewportSize({ width: 1600, height: tall }); await sleep(500); }
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        if (explorer) await saveExplorerShot(`${name}-${theme}.png`, (path) => page.screenshot({ path }));
        else await saveShot(`${name}-${theme}.png`, (path) => page.screenshot({ path }));
      }
      await setTheme('light');
      if (tall > 1000) { await page.setViewportSize({ width: 1600, height: 1000 }); await sleep(300); }
    };
    const placeholders = async () => page.evaluate(() => {
      const els = document.querySelectorAll('[data-lab-placeholder], .board-slot, .board-slot-note, .board-block-placeholder').length;
      const text = /not available yet|henüz kullanılamıyor|stand-in|placeholder renderer/i.exec(document.body.innerText);
      return { els, text: text ? text[0] : null };
    });
    const card = (id) => page.locator(`[data-lab-card="${id}"]`);
    /** A board tab when it is on the tab row; else the board's own address (a tab may sit in the "+N" overflow). */
    const openBoard = async (slug) => {
      const tab = page.locator(`[data-lab-board-tab="${slug}"]`).first();
      if (await tab.count() && await tab.isVisible()) await tab.click();
      else {
        await page.evaluate((b) => {
          window.history.pushState(null, '', `/lab/b/${encodeURIComponent(b)}${window.location.search}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, slug);
      }
      await page.locator(`[data-lab-board="${slug}"]`).waitFor({ timeout: 15000 });
      await sleep(700);
    };
    const gotoInsights = async (vault = 'proj') => {
      await page.goto(`${BASE}/?vault=${vault}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.sidebar-item').first().waitFor();
      if (await page.locator('.announcements-modal-scrim').count()) {
        await page.keyboard.press('Escape');
        await sleep(300);
      }
      await page.locator('.sidebar-item[title^="Insights"]').first().click();
    };
    const editMode = async (on) => {
      const toggle = page.locator('[data-lab-edit-toggle]').first();
      const pressed = await toggle.getAttribute('aria-pressed');
      const editing = pressed === 'true' || (pressed === null && await page.locator('[data-lab-drag-handle]').count() > 0);
      if (editing !== on) await toggle.click();
      await sleep(300);
    };
    /** Drag a handle's center by (dx, dy) with real pointer events (hovering its card first: handles may show on hover). */
    const dragBy = async (loc, dx, dy, steps = 12) => {
      await loc.evaluate((e) => e.closest('[data-lab-card]')?.scrollIntoView({ block: 'center' }));
      const cardBox = await loc.evaluate((e) => { const r = e.closest('[data-lab-card]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(cardBox.x, cardBox.y);
      await sleep(80);
      const box = await loc.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
      await page.mouse.up();
    };
    const colWidth = async () => page.evaluate(() => {
      const c = document.querySelector('[data-lab-card]');
      const grid = c && c.parentElement;
      return grid ? grid.getBoundingClientRect().width / 12 : 0;
    });
    const rowHeight = async (id) => page.evaluate((cid) => {
      const c = document.querySelector(`[data-lab-card="${cid}"]`);
      return c ? c.getBoundingClientRect().height / Number(c.getAttribute('data-lab-card-h')) : 0;
    }, id);

    // A partial (--only) run skips the section that first opens the page.
    if (ONLY && !ONLY.test('legacy open')) await gotoInsights().catch(() => {});

    // ── 1. Legacy open: derived boards, nothing written, zero sync ─────────────
    const labBefore = hashTree(LAB);
    const openedAt = Date.now();
    let derivedList = null;
    await section('legacy open', async () => {
      await gotoInsights();
      await page.locator('[data-lab-board]').first().waitFor({ timeout: 20000 });
      await sleep(3000); // the board-open staleness check + 1 poll cycle
      derivedList = await page.evaluate(async () => (await fetch('/api/lab/boards')).json());
      ok('GET /api/lab/boards reports derived boards', derivedList.derived === true, JSON.stringify(derivedList).slice(0, 200));
      const titles = derivedList.boards.map((b) => b.title);
      ok('one derived board per category, in the saved catOrder, Other last',
        JSON.stringify(titles.slice(0, 4)) === JSON.stringify(EXPECTED_TAB_TITLES) && derivedList.boards.length === 5,
        JSON.stringify(titles));
      const tabSlugs = await page.locator('[data-lab-board-tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lab-board-tab')));
      ok('the tab row shows the derived boards in that order', JSON.stringify(tabSlugs) === JSON.stringify(derivedList.boards.map((b) => b.slug)),
        `${JSON.stringify(tabSlugs)} vs ${JSON.stringify(derivedList.boards.map((b) => b.slug))}`);
      ok('the open board is marked derived', await page.locator('[data-lab-board][data-lab-board-derived="true"]').count() === 1);
      ok('opening an all-fresh board starts ZERO sync jobs', syncPosts(openedAt).length === 0,
        JSON.stringify(syncPosts(openedAt)));
      await shoot('legacy-first-board');

      // Visit every board; the Hazards board would auto-sync its (unreadable)
      // symlinked cache and replace the link, so its sync is held off the wire.
      await page.route(/\/api\/lab\/sync/, (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
      const seen = new Map();
      for (const b of derivedList.boards) {
        await openBoard(b.slug);
        const cards = await page.locator('[data-lab-card]').evaluateAll((els) => els.map((e) => ({
          id: e.getAttribute('data-lab-card'),
          x: Number(e.getAttribute('data-lab-card-x')),
          y: Number(e.getAttribute('data-lab-card-y')),
          blocks: [...e.querySelectorAll('[data-lab-block]')].map((x) => x.getAttribute('data-lab-block')),
          drawn: !!e.querySelector('svg, table, iframe, .lab-block-stat, [class*="number"]') && !e.querySelector('[data-lab-block="insight"] > .lab-block-empty'),
          text: e.innerText.slice(0, 120),
        })));
        for (const c of cards) seen.set(c.id, { ...c, board: b.slug });
        const ph = await placeholders();
        ok(`board ${b.slug}: no placeholder element or stand-in text`, ph.els === 0 && !ph.text, JSON.stringify(ph));
        await shoot(`legacy-${b.slug}`);
      }
      await page.unroute(/\/api\/lab\/sync/);
      const missing = INSIGHT_SLUGS.filter((s) => !seen.has(`c-${s}`));
      ok('every insight is present on a derived board', missing.length === 0, `missing: ${missing.join(', ')}`);
      ok('legacy cards render through the insight block', INSIGHT_SLUGS.every((s) => seen.get(`c-${s}`)?.blocks.includes('insight')),
        JSON.stringify([...seen.values()].map((c) => [c.id, c.blocks])));
      const undrawn = INSIGHT_SLUGS.filter((s) => !['broken-metric', 'symlinked'].includes(s) && !seen.get(`c-${s}`)?.drawn);
      ok('every synced legacy insight draws a body (series, table, funnel, value, html/v1, app/v1)', undrawn.length === 0,
        undrawn.map((s) => `${s}: ${seen.get(`c-${s}`)?.text}`).join(' || '));
      const heads = [...seen.keys()].filter((id) => id.startsWith('h-'));
      ok('each group became a heading card', heads.length >= 4, heads.join(', '));
      const ses = seen.get('c-sessions');
      const sig = seen.get('c-signups');
      ok('the saved in-group card order is honoured (sessions before signups)',
        ses && sig && (ses.y < sig.y || (ses.y === sig.y && ses.x < sig.x)), JSON.stringify({ ses, sig }));

      // Legacy bodies really are their v1 bodies (lk- kit inside the sandbox).
      await openBoard(derivedList.boards.find((b) => b.title === 'Legacy').slug);
      const bodyText = async (id, sel) => {
        const frame = await card(id).locator('iframe').first().elementHandle().then((h) => h && h.contentFrame());
        return frame ? until(() => frame.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel), 6000) : null;
      };
      ok('html/v1 body renders as before', (await bodyText('c-html-card', '#legacy-html')) === '8');
      ok('app/v1 body renders as before', (await bodyText('c-app-card', '#legacy-app')) === 'Legacy app page');

      ok('NOTHING under lab/ was written by opening and browsing a legacy vault',
        JSON.stringify(hashTree(LAB)) === JSON.stringify(labBefore),
        JSON.stringify(Object.entries(hashTree(LAB)).filter(([k, v]) => labBefore[k] !== v)));
      ok('no lab/boards/ and no staging dir before the first edit',
        !existsSync(BOARDS) && readdirSync(LAB).every((n) => !n.startsWith('.boards-staging')), readdirSync(LAB).join(','));
    });

    // ── 8. Freshness line: skip reason + plain-text note ───────────────────────
    await section('freshness', async () => {
      const growth = derivedList.boards.find((b) => b.title === 'Growth').slug;
      await openBoard(growth);
      const line = await card('c-probed').locator('[data-lab-freshness]').first().innerText();
      ok('the skip reason is on the card (upstream unchanged)', /unchanged/i.test(line), line);
      const noteHtml = await card('c-probed').evaluate((el) => ({ text: el.innerText, bold: [...el.querySelectorAll('b')].some((b) => /as of 09:00/.test(b.textContent)) }));
      ok("the source's freshness note renders as plain text, never markup", /<b>as of 09:00<\/b>/.test(noteHtml.text) && !noteHtml.bold, noteHtml.text);
    });

    // ── 2 + 3. First edit materializes; drag/resize persist; burst; 409; 500 ────
    let revenue = null;
    await section('first edit + edit mode', async () => {
      revenue = derivedList.boards.find((b) => b.title === 'Revenue').slug;
      await openBoard(revenue);
      await editMode(true);
      const ph = await placeholders();
      ok('edit mode: no placeholder element or stand-in text', ph.els === 0 && !ph.text, JSON.stringify(ph));
      const col = await colWidth();
      const x0 = Number(await card('c-plans').getAttribute('data-lab-card-x'));
      const w0 = Number(await card('c-plans').getAttribute('data-lab-card-w'));
      await dragBy(card('c-plans').locator('[data-lab-drag-handle]').first(), col * 2, 0);
      await until(() => boardFiles().length > 0, 6000);
      const expected = derivedList.boards.map((b) => `${b.slug}.md`).sort();
      ok('first UI edit materializes every derived board', JSON.stringify(boardFiles()) === JSON.stringify(expected),
        `${JSON.stringify(boardFiles())} vs ${JSON.stringify(expected)}`);
      const moved = await until(() => fileCard(revenue, 'c-plans')?.at?.x === x0 + 2, 5000);
      ok('drag persists to the board file', moved, JSON.stringify(fileCard(revenue, 'c-plans')));
      ok('the other boards kept every card on materialize',
        INSIGHT_SLUGS.every((s) => derivedList.boards.some((b) => readBoard(b.slug)?.cards?.some((c) => c.id === `c-${s}`))));

      const rowH = await rowHeight('c-plans');
      const h0 = Number(await card('c-plans').getAttribute('data-lab-card-h'));
      await dragBy(card('c-plans').locator('[data-lab-resize-handle]').first(), col, rowH);
      const resized = await until(() => {
        const c = fileCard(revenue, 'c-plans');
        return c && c.at.w === w0 + 1 && c.at.h === h0 + 1;
      }, 5000);
      ok('resize persists to the board file', resized, JSON.stringify(fileCard(revenue, 'c-plans')));

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(`[data-lab-board="${revenue}"]`).waitFor({ timeout: 20000 });
      await sleep(800);
      const after = await card('c-plans').evaluate((e) => ['x', 'y', 'w', 'h'].map((k) => Number(e.getAttribute(`data-lab-card-${k}`))));
      const f = fileCard(revenue, 'c-plans')?.at;
      ok('drag + resize survive a reload', f && JSON.stringify(after) === JSON.stringify([f.x, f.y, f.w, f.h]), `${JSON.stringify(after)} vs ${JSON.stringify(f)}`);
      await shoot('edited-revenue');

      // A drag burst: many quick drags, one card; single-flight PUTs never 409 against themselves.
      await editMode(true);
      const burstStart = putStatuses.length;
      const handle = card('c-funnels').locator('[data-lab-drag-handle]').first();
      for (let i = 0; i < 6; i++) await dragBy(handle, i % 2 === 0 ? col : -col, 0, 4);
      await sleep(2500);
      const burst = putStatuses.slice(burstStart);
      ok('a drag burst never 409s against itself', burst.length > 0 && !burst.includes(409), JSON.stringify(burst));
      const uiX = Number(await card('c-funnels').getAttribute('data-lab-card-x'));
      ok('after the burst the file matches the screen', fileCard(revenue, 'c-funnels')?.at?.x === uiX,
        `${JSON.stringify(fileCard(revenue, 'c-funnels'))} vs x=${uiX}`);

      // External change -> 409 -> conflict toast; the external edit survives.
      const extStart = putStatuses.length;
      dc(['lab', 'board', 'add-card', revenue, '--block', '{"callout": {"markdown": "external edit"}}', '--id', 'c-external']);
      await dragBy(handle, col, 0, 4);
      await sleep(2000);
      ok('an external change makes the next save 409', putStatuses.slice(extStart).includes(409), JSON.stringify(putStatuses.slice(extStart)));
      ok('the 409 shows the conflict toast', await page.locator('[data-lab-toast="conflict"]').count() > 0);
      ok('the external edit is never silently overwritten', !!fileCard(revenue, 'c-external'));
      await until(async () => (await card('c-external').count()) > 0, 5000);
      ok('the board reloads and shows the external card', await card('c-external').count() === 1);

      // A failed PUT keeps the edit on screen, pending, with Retry.
      await editMode(true);
      const before = fileCard(revenue, 'c-funnels')?.at?.x;
      const fail = async (route) => (route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"boom","message":"verify fixture"}}' })
        : route.continue());
      await page.route(/\/api\/lab\/boards\/[^/?]+$/, fail);
      const target = before === 0 ? 1 : before - 1;
      await dragBy(handle, (target - before) * col, 0, 6);
      await sleep(1500);
      ok('a failed save shows the save-failed toast', await page.locator('[data-lab-toast="save-failed"]').count() > 0);
      ok('the failed save keeps the edit on screen', Number(await card('c-funnels').getAttribute('data-lab-card-x')) === target,
        `${await card('c-funnels').getAttribute('data-lab-card-x')} vs ${target}`);
      ok('the failed save wrote nothing', fileCard(revenue, 'c-funnels')?.at?.x === before);
      await page.unroute(/\/api\/lab\/boards\/[^/?]+$/, fail);
      await page.locator('[data-lab-toast-retry]').first().click();
      ok('Retry writes the kept edit', await until(() => fileCard(revenue, 'c-funnels')?.at?.x === target, 5000),
        JSON.stringify(fileCard(revenue, 'c-funnels')));
      await editMode(false);
    });

    // ── The funnel explorer's insights (the catalog, option and fit boards bind them too) ──
    let explorerSynced = false;
    await section('explorer fixtures via CLI', async () => {
      const make = (slug, title, render, script) => {
        dc(['lab', 'create', slug, '--title', title, '--render', render, '--adapter', 'script', '--no-board']);
        writeFileSync(join(LAB, 'scripts', `${slug}.mjs`), script, 'utf-8');
        const out = dc(['lab', 'sync', slug, '--force'], { allowFail: true });
        const path = join(LAB, 'cache', `${slug}.json`);
        const cache = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
        ok(`explorer fixture ${slug} synced`, !!cache && !cache.error, `${out.slice(0, 300)} ${cache?.error ?? ''}`);
        return cache;
      };
      const c = make(EXPLORER, 'Acme funnel explorer', 'funnel', readFileSync(EXPLORER_FIXTURE, 'utf-8'));
      ok('the explorer bundle writes both cache.datasets and cache.funnel',
        (c?.funnel?.set?.funnels?.length ?? 0) === 2 && (c?.datasets?.bundle?.datasets?.length ?? 0) === 2 && (c?.funnelHistory?.length ?? 0) > 0,
        JSON.stringify(Object.keys(c ?? {})));
      make(EXPLORER_PLUS, 'Acme explorer plus', 'funnel', PLUS_SCRIPT);
      const a = make(APP, 'Acme onboarding app', 'app', readFileSync(APP_FIXTURE, 'utf-8'));
      ok('the app fixture declares 3 pages', a?.app?.spec?.pages?.length === 3, JSON.stringify(a?.app?.spec?.pages?.map((p) => p.id)));
      explorerSynced = true;
    });

    // ── The catalog, hazard and reuse boards (CLI writes, boards now materialized)
    const { spec, baseList, variants } = catalogBoardSpec();
    const catalogFile = join(SCRATCH, 'catalog.json');
    writeFileSync(catalogFile, JSON.stringify(spec));
    await section('catalog board via CLI', async () => {
      dc(['lab', 'board', 'create', 'catalog', '--title', 'Catalog']);
      const out = dc(['lab', 'board', 'set', 'catalog', '--file', catalogFile], { allowFail: true });
      ok('lab board set accepts the catalog fixture', /Board saved/.test(out), out.slice(0, 600));
      // The library block reused by ref on a SECOND board.
      dc(['lab', 'board', 'add-card', revenue, '--block', '{"html": {"ref": "kpi-tile", "inputs": {"rows": "plans"}}}', '--id', 'c-lib-b']);
      // Hand-written hazard board: hostile bindings a strict write would refuse (a lenient read keeps them).
      writeFileSync(join(BOARDS, 'hazards-x.md'), matter.stringify('', {
        title: 'Hazard bindings', order: 95, cards: [
          { id: 'c-hz-sym', at: { x: 0, y: 0, w: 4, h: 4 }, blocks: [{ table: { data: 'symlinked' } }] },
          { id: 'c-hz-dot', at: { x: 4, y: 0, w: 4, h: 4 }, blocks: [{ table: { data: '../plans' } }] },
          { id: 'c-hz-enc', at: { x: 8, y: 0, w: 4, h: 4 }, blocks: [{ table: { data: 'plans%2F..%2Fplans' } }] },
          // The symlinked input on its own: a safe slug, so only the reader's containment stands between it and the data.
          { id: 'c-hz-html-sym', at: { x: 0, y: 4, w: 6, h: 4 }, blocks: [{ html: { html: HAZARD_HTML, inputs: { a: 'symlinked' } } }] },
          { id: 'c-hz-html', at: { x: 6, y: 4, w: 6, h: 4 }, blocks: [{ html: { html: HAZARD_HTML, inputs: { b: '../plans', c: 'plans%2F..' } } }] },
        ],
      }));
    });

    // ── 7a. Containment at the API and the CLI ─────────────────────────────────
    await section('containment (api + cli)', async () => {
      const res = await page.evaluate(async () => { const r = await fetch('/api/lab/boards/hazards-x'); return { status: r.status, body: await r.text() }; });
      const body = JSON.parse(res.body);
      const frames = body.frames ?? {};
      const kindOf = (id) => Object.entries(frames).filter(([k]) => k.startsWith(`${id}:`)).map(([, f]) => f.kind);
      ok('board GET: symlinked cache yields no data', kindOf('c-hz-sym').every((k) => k === 'empty') && !res.body.includes(String(LEAK)),
        `${JSON.stringify(kindOf('c-hz-sym'))} leak=${res.body.includes(String(LEAK))}`);
      ok('board GET: a ../ binding yields no data', kindOf('c-hz-dot').length > 0 && kindOf('c-hz-dot').every((k) => k === 'empty'), JSON.stringify(kindOf('c-hz-dot')));
      ok('board GET: a %2F binding yields no data', kindOf('c-hz-enc').length > 0 && kindOf('c-hz-enc').every((k) => k === 'empty'), JSON.stringify(kindOf('c-hz-enc')));
      // A lenient read may drop a hostile input outright (no frame) or keep it as an empty frame: either is "no data".
      ok('board GET: no hostile html input resolves to data', kindOf('c-hz-html').every((k) => k === 'empty'), JSON.stringify(kindOf('c-hz-html')));
      ok('board GET: the symlinked html input is an empty frame', kindOf('c-hz-html-sym').length === 1 && kindOf('c-hz-html-sym')[0] === 'empty',
        JSON.stringify(kindOf('c-hz-html-sym')));
      const show = dc(['lab', 'board', 'show', 'hazards-x', '--json'], { allowFail: true });
      let parsed = null;
      try { parsed = JSON.parse(show); } catch { /* reported below */ }
      ok('lab board show: symlinked cache yields no data', parsed !== null && !show.includes(String(LEAK)), show.slice(0, 300));
      const route = await page.evaluate(async () => (await fetch('/api/lab/boards/..%2Fplans')).status);
      ok('a %2F route param never reads a board', route === 400 || route === 404, String(route));
    });

    // ── 5. Every block type, light + dark; every option changes the render ─────
    await section('catalog render + options', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-lab-board]').first().waitFor({ timeout: 20000 });
      await openBoard('catalog');
      await sleep(1500);
      const types = catalog.map((c) => c.type);
      const sigOf = async (id) => card(id).locator('[data-lab-block]').first().evaluate(signatureInPage);
      const drawnTypes = new Set();
      const themeSigs = {};
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        for (const b of baseList) {
          const loc = card(b.id).locator('[data-lab-block]').first();
          await loc.scrollIntoViewIfNeeded();
          const state = await loc.evaluate((el) => ({ empty: !!el.querySelector('.lab-block-empty, [data-empty-reason]'), size: el.innerText.length + el.querySelectorAll('svg *, td, th').length }));
          const drew = !state.empty && state.size > 0;
          ok(`${b.type} renders from its fixture (${theme})`, drew, JSON.stringify(state));
          if (drew) drawnTypes.add(b.type);
          themeSigs[`${b.id}:${theme}`] = await sigOf(b.id);
        }
      }
      await setTheme('light');
      for (const b of baseList) {
        ok(`${b.type} (${b.id}) repaints between light and dark`, themeSigs[`${b.id}:light`] !== themeSigs[`${b.id}:dark`]);
      }
      // The block types with no signature pair are proven by their own sections below.
      for (const t of types.filter((ty) => !baseList.some((b) => b.type === ty))) {
        ok(`catalog type ${t} has a fixture (own section)`, ['tabs', 'html', 'insight'].includes(t), t);
      }
      await shoot('catalog');

      const baseSig = {};
      for (const b of baseList) {
        baseSig[b.id] = await sigOf(b.id);
        const twin = await sigOf(`${b.id}-twin`);
        ok(`control: ${b.id} and its twin render identically`, twin === baseSig[b.id], `signature is unstable; option comparisons for this type are meaningless; ${sigDiff(baseSig[b.id], twin)}`);
      }
      for (const v of variants) {
        const s = await sigOf(v.id);
        ok(`option ${v.type}.${v.option} visibly changes the render`, s !== baseSig[v.base], `${v.id} rendered identically to ${v.base}`);
      }
      // Coverage: every catalog option has a case (or a dedicated section), and every
      // non-default value of an enum option has its own case (section 11 runs them).
      const allCases = [...OPTION_CASES, ...OPTION_VALUE_CASES];
      for (const entry of catalog) {
        for (const o of entry.options) {
          const covered = allCases.some(([ty, , variant]) => ty === entry.type && o.key in variant) || (COVERED_ELSEWHERE[entry.type] ?? []).includes(o.key);
          ok(`catalog option ${entry.type}.${o.key} has a verify case`, covered);
          if (o.type !== 'enum') continue;
          for (const value of o.enum.filter((v) => v !== o.default)) {
            ok(`catalog option ${entry.type}.${o.key}=${value} has a verify case`,
              allCases.some(([ty, , variant]) => ty === entry.type && variant[o.key] === value));
          }
        }
      }
    });

    // ── 6. tabs + filter ───────────────────────────────────────────────────────
    await section('tabs + filter', async () => {
      const tabs = card('c-tabs');
      await tabs.scrollIntoViewIfNeeded();
      const panelTypes = async () => tabs.locator('[data-lab-block]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lab-block')));
      const first = await panelTypes();
      ok('tab buttons carry data-lab-tab', await tabs.locator('[data-lab-tab]').count() === 2, String(await tabs.locator('[data-lab-tab]').count()));
      const tabBtn = (await tabs.locator('[data-lab-tab]').count()) ? tabs.locator('[data-lab-tab]') : tabs.locator('[role="tab"]');
      await tabBtn.nth(1).click();
      await sleep(500);
      const second = await panelTypes();
      ok('tabs start on the first panel (line, no table)', first.includes('line') && !first.includes('table'), JSON.stringify(first));
      ok('clicking the second tab switches the panel (table, no line)', second.includes('table') && !second.includes('line'), JSON.stringify(second));

      const f = card('c-filter');
      await f.scrollIntoViewIfNeeded();
      const total = async () => f.evaluate((el) => {
        const hook = el.querySelector('[data-lab-filter-total]');
        const foot = el.querySelector('tfoot tr[data-total-count]');
        return {
          hook: !!hook,
          count: hook ? hook.getAttribute('data-lab-filter-total') : foot ? foot.getAttribute('data-total-count') : null,
          text: (hook ?? foot)?.textContent ?? '',
          rows: el.querySelectorAll('tbody tr').length,
        };
      });
      const t0 = await total();
      ok('filtered total hook present (data-lab-filter-total)', t0.hook, JSON.stringify(t0));
      ok('unfiltered total counts every row under limit 2', /12/.test(String(t0.count)) && t0.rows === 2, JSON.stringify(t0));
      const chip = (v) => f.locator(`[data-lab-filter-chip="${v}"]`).or(f.locator('.lab-block-chip', { hasText: new RegExp(`^${v}$`) })).first();
      ok('filter chips carry data-lab-filter-chip', await f.locator('[data-lab-filter-chip="TR"]').count() === 1);
      const clickAt = Date.now();
      await chip('TR').click();
      await sleep(1200);
      const t1 = await total();
      const digits = t1.text.replace(/[^0-9]/g, '');
      ok('after the TR chip: the total counts the 4 TR rows, 2 shown under the limit', /\b4\b/.test(String(t1.count)) && t1.rows === 2, JSON.stringify(t1));
      ok('after the TR chip: the total value is the TR sum (1000)', digits.includes('1000') || /1(\.0)?\s?K/i.test(t1.text), JSON.stringify(t1));
      await chip('US').click();
      await sleep(600);
      ok('filter clicks send ZERO sync requests', syncReqs.filter((r) => r.at >= clickAt).length === 0,
        JSON.stringify(syncReqs.filter((r) => r.at >= clickAt)));
      await shoot('tabs-filter');
    });

    // ── 7b. html blocks in the browser ─────────────────────────────────────────
    const frameOf = async (id) => {
      const h = await card(id).locator('[data-lab-html-block], iframe').first().elementHandle({ timeout: 10000 });
      return h ? h.contentFrame() : null;
    };
    const frameText = async (id, sel, pred = (v) => v && v !== 'pending') => {
      const frame = await frameOf(id);
      return frame ? until(async () => { const v = await frame.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel); return pred(v) ? v : null; }, 8000) : null;
    };
    await section('html blocks', async () => {
      await card('c-html-short').scrollIntoViewIfNeeded();
      ok('html block uses the data-lab-html-block iframe', await card('c-html-short').locator('iframe[data-lab-html-block]').count() === 1);
      const frame = await frameOf('c-html-short');
      // The kit is proven on INNER elements (a board cell dissolves a single root dc-card into its
      // chrome, finding 4, so the root card's own box is no longer the kit's witness).
      const kit = frame && await frame.evaluate(kitInPage);
      ok('the dc- kit applies inside the html block (inner elements)', kitApplies(kit, { buttons: false }), JSON.stringify(kit));
      ok('finding 4: a single root dc-card dissolves into the cell (0 padding, 0 border)', rootDissolved(kit, 'kit'), JSON.stringify(kit?.cards));
      ok('a declared input answers with its frame', (await frameText('c-html-short', '#ok')) === 'rows=12;kind=table', await frameText('c-html-short', '#ok'));
      const refused = await frameText('c-html-short', '#refused');
      ok('an undeclared lab.data() name is refused', typeof refused === 'string' && refused.startsWith('refused:'), refused);
      ok('lab.inputs lists only the declared names', (await frameText('c-html-short', '#inputs')) === 'inputs=["rows"]', await frameText('c-html-short', '#inputs'));

      const geo = async (id) => card(id).evaluate((el) => {
        const f = el.querySelector('iframe');
        const c = el.getBoundingClientRect();
        const r = f ? f.getBoundingClientRect() : { width: 0, height: 0, bottom: 0 };
        return { cw: c.width, ch: c.height, fw: r.width, fh: r.height, gapBottom: c.bottom - r.bottom };
      });
      const s = await geo('c-html-short');
      const t = await geo('c-html-tall');
      ok('the html block fills its grid cell (width)', s.fw >= s.cw * 0.85, JSON.stringify(s));
      ok('the html block fills its grid cell (height, short card)', s.fh >= s.ch * 0.6 && s.gapBottom < 40, JSON.stringify(s));
      ok('a taller cell gives a taller html block (no fixed height)', t.fh > s.fh * 1.6, `short ${s.fh} tall ${t.fh}`);

      // Library reuse by ref: on the catalog board and on the revenue board.
      ok('library block renders by ref (catalog board)', (await frameText('c-lib-a', '#lib-rows')) === 'lib-rows=12', await frameText('c-lib-a', '#lib-rows'));
      await openBoard(revenue);
      await card('c-lib-b').scrollIntoViewIfNeeded();
      ok('the same library block is reused by ref on another board', (await frameText('c-lib-b', '#lib-rows')) === 'lib-rows=12', await frameText('c-lib-b', '#lib-rows'));

      // The hazard board: the block itself gets no data for any hostile input.
      // Precondition: the cache is still a symlink. A sync of `symlinked` (a mutation
      // run's stray sync-all, say) replaces the link with a real file by rename; that
      // is contained, but it would test the insight's own data instead of the link.
      const symPath = join(LAB, 'cache', 'symlinked.json');
      if (!lstatSync(symPath).isSymbolicLink()) {
        console.log('note: a sync replaced the symlinked-cache fixture; restored it before the html hazard check');
        rmSync(symPath);
        symlinkSync(join(SCRATCH, 'outside-cache.json'), symPath);
      }
      await page.route(/\/api\/lab\/sync/, (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-lab-board]').first().waitFor({ timeout: 20000 });
      await openBoard('hazards-x');
      const hz = await frameText('c-hz-html', '#hz');
      const hzSym = await frameText('c-hz-html-sym', '#hz');
      const noData = (text, n) => (text ?? '').split('\n').some((l) => l.startsWith(`${n}:refused`) || l.startsWith(`${n}:empty`));
      ok('html block: symlinked input yields no data', noData(hzSym, 'a') && !(hzSym ?? '').includes(String(LEAK)), hzSym);
      ok('html block: a ../ input yields no data', noData(hz, 'b'), hz);
      ok('html block: a %2F input yields no data', noData(hz, 'c'), hz);
      ok('the hazard board never shows the leak marker', !(await page.locator('[data-lab-board]').innerText()).includes(String(LEAK)));
      await shoot('hazards');
      await page.unroute(/\/api\/lab\/sync/);
    });

    // ── 4. Inspector: type / data / option, file reflects, Cmd+Z undoes ────────
    await section('inspector', async () => {
      await openBoard('catalog');
      await editMode(true);
      await card('c-insp').scrollIntoViewIfNeeded();
      await card('c-insp').locator('[data-lab-card-menu]').first().click();
      await page.locator('[data-lab-menu-item="edit-blocks"]').first().click();
      const insp = page.locator('[data-lab-inspector]').first();
      await insp.waitFor({ timeout: 8000 });
      const ph = await placeholders();
      ok('no data-lab-placeholder element (inspector open)', ph.els === 0 && !ph.text, JSON.stringify(ph));
      if (await insp.locator('[data-lab-inspector-block="0"]').count()) await insp.locator('[data-lab-inspector-block="0"]').first().click();
      const setField = async (name, value) => {
        const el = insp.locator(`[data-lab-field="${name}"]`).first();
        const tag = await el.evaluate((e) => `${e.tagName}:${e.getAttribute('type') ?? ''}`);
        if (tag.startsWith('SELECT')) await el.selectOption(String(value));
        else if (tag === 'INPUT:checkbox') await el.setChecked(!!value);
        else { await el.fill(String(value)); await el.press('Enter'); await el.evaluate((e) => e.blur()); }
      };
      const block0 = () => fileCard('catalog', 'c-insp')?.blocks?.[0] ?? {};
      await setField('type', 'bar');
      ok('inspector: changing the type writes it to the board file', await until(() => 'bar' in block0(), 5000), JSON.stringify(block0()));
      await setField('data', 'traffic-mix');
      ok('inspector: changing the data writes it to the board file', await until(() => block0().bar?.data === 'traffic-mix', 5000), JSON.stringify(block0()));
      await setField('color', 5);
      ok('inspector: changing an option writes it to the board file', await until(() => block0().bar?.color === 5, 5000), JSON.stringify(block0()));
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      await page.keyboard.press('Meta+z');
      ok('Cmd+Z undoes the last inspector edit in the file', await until(() => block0().bar && block0().bar.color !== 5, 5000), JSON.stringify(block0()));
      await shoot('inspector');

      // Save to library from the UI, then reuse it by ref.
      await page.keyboard.press('Escape');
      await card('c-html-short').scrollIntoViewIfNeeded();
      await card('c-html-short').locator('[data-lab-card-menu]').first().click();
      await page.locator('[data-lab-menu-item="edit-blocks"]').first().click();
      await insp.waitFor();
      if (await insp.locator('[data-lab-inspector-block="0"]').count()) await insp.locator('[data-lab-inspector-block="0"]').first().click();
      await page.locator('[data-lab-save-to-library]').first().click();
      const dialog = page.locator('[data-lab-save-to-library-dialog]').first();
      await dialog.waitFor();
      await dialog.locator('[data-lab-field="library-title"]').fill('Saved from UI');
      await dialog.locator('[data-lab-field="library-slug"]').fill('saved-from-ui');
      if (!(await dialog.count())) await page.screenshot({ path: join(SHOTS, 'save-dialog-gone.png'), fullPage: true });
      ok('the save-to-library dialog stays open while it is filled in', await dialog.count() === 1);
      const submit = dialog.locator('[data-lab-save-to-library-submit]');
      await submit.scrollIntoViewIfNeeded();
      const cover = await submit.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], disabled: el.disabled, top: top === el || el.contains(top) ? 'self' : `${top?.tagName}.${top?.className}` };
      });
      ok('the save-to-library submit is clickable (nothing covers it)', cover.top === 'self' && !cover.disabled, JSON.stringify(cover));
      if (cover.top !== 'self') await page.screenshot({ path: join(SHOTS, 'save-dialog-covered.png') });
      // Covered: still prove the save path itself (the coverage failure above is the UX finding).
      if (cover.top === 'self') await submit.click({ timeout: 5000 });
      else await submit.evaluate((el) => el.click());
      const saved = await until(() => existsSync(join(LAB, 'blocks', 'saved-from-ui.md')), 5000);
      ok('Save to library writes lab/blocks/<slug>.md', saved);
      await page.keyboard.press('Escape');
      await editMode(false);
      if (saved) {
        dc(['lab', 'board', 'add-card', 'catalog', '--block', '{"html": {"ref": "saved-from-ui", "inputs": {"rows": "plans"}}}', '--id', 'c-reuse-ui']);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-lab-board]').first().waitFor({ timeout: 20000 });
        await openBoard('catalog');
        await card('c-reuse-ui').scrollIntoViewIfNeeded();
        ok('a block saved from the UI is reusable by ref on another card', (await frameText('c-reuse-ui', '#ok')) === 'rows=12;kind=table', await frameText('c-reuse-ui', '#ok'));
      }
    });

    // ── Add-card menu: real, not a stand-in ────────────────────────────────────
    await section('add-card menu', async () => {
      await openBoard(revenue);
      await editMode(true);
      const add = page.locator('[data-lab-add-card]');
      if (await add.count() === 0) {
        const btn = page.getByRole('button', { name: /add card|kart ekle/i }).first();
        if (await btn.count()) await btn.click();
      }
      await add.first().waitFor({ timeout: 6000 });
      const ph = await placeholders();
      ok('no data-lab-placeholder element (add-card menu open)', ph.els === 0 && !ph.text, JSON.stringify(ph));
      ok('the add-card menu offers insights, catalog blocks and custom HTML',
        await add.locator('[data-lab-add-insight]').count() > 0 && await add.locator('[data-lab-add-type]').count() > 0 && await add.locator('[data-lab-add-html]').count() > 0);
      await page.keyboard.press('Escape');
      await editMode(false);
    });

    // ── 11-15. The chart standard: fixtures and boards via the CLI ────────────
    const optionBoards = optionBoardSpecs();
    let chartBoardsReady = false;
    await section('chart fixtures via CLI', async () => {
      for (const ins of CHART_INSIGHTS) {
        dc(['lab', 'create', ins.slug, '--title', ins.title, '--render', ins.render, '--adapter', 'script', ...(ins.unit ? ['--unit', ins.unit] : [])]);
        writeFileSync(join(LAB, 'scripts', `${ins.slug}.mjs`), `${ins.script}\n`, 'utf-8');
        dc(['lab', 'sync', ins.slug, '--force'], { allowFail: true });
        ok(`chart fixture ${ins.slug} synced`, existsSync(join(LAB, 'cache', `${ins.slug}.json`)));
      }
      const boards = [...optionBoards.map((b) => [b.slug, b.spec]), ['fit', fitBoardSpec()], ['hover', hoverBoardSpec()], ['findings', findingsBoardSpec()]];
      for (const [slug, spec] of boards) {
        dc(['lab', 'board', 'create', slug, '--title', spec.title]);
        const file = join(SCRATCH, `${slug}.json`);
        writeFileSync(file, JSON.stringify(spec));
        const out = dc(['lab', 'board', 'set', slug, '--file', file], { allowFail: true });
        ok(`lab board set accepts the ${slug} fixture`, /Board saved/.test(out), out.slice(0, 600));
      }
      chartBoardsReady = true;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-lab-board]').first().waitFor({ timeout: 20000 });
    });

    /** The tooltip text a card shows with the pointer on its first mark ('' = none). */
    const hoverTip = async (id) => {
      const blk = card(id).locator('[data-lab-block]').first();
      await blk.scrollIntoViewIfNeeded();
      const pt = await blk.evaluate(markPointInPage, ['[data-slice]', '[data-heat-cell]', '[data-bar]', '[data-chart-hit]']);
      if (!pt) return '';
      await page.mouse.move(pt.x, pt.y, { steps: 3 });
      const tip = await until(() => blk.evaluate((el) => el.querySelector('[data-chart-tooltip]')?.innerText ?? ''), 1500);
      await page.mouse.move(1, 1);
      await sleep(150);
      return tip ?? '';
    };
    const sigOf = async (id) => card(id).locator('[data-lab-block]').first().evaluate(signatureInPage);

    // ── 11. Every option value visibly changes the render ─────────────────────
    await section('option values', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      for (const b of optionBoards) {
        await openBoard(b.slug);
        await sleep(1200);
        const baseSig = {};
        const baseTip = {};
        for (const base of b.bases) {
          await card(base.id).scrollIntoViewIfNeeded();
          const empty = await card(base.id).locator('[data-lab-block]').first().evaluate((el) => !!el.querySelector('.lab-block-empty, [data-empty-reason]'));
          ok(`${base.id} (${b.slug}) renders its baseline`, !empty, JSON.stringify(base.base));
          baseSig[base.id] = await sigOf(base.id);
          ok(`control: ${base.id} and its twin render identically`, (await sigOf(`${base.id}-twin`)) === baseSig[base.id], 'signature is unstable');
          if (base.hover) {
            baseTip[base.id] = await hoverTip(base.id);
            const twinTip = await hoverTip(`${base.id}-twin`);
            ok(`control: ${base.id} shows a tooltip, the same as its twin's`, baseTip[base.id] !== '' && twinTip === baseTip[base.id], `${JSON.stringify(baseTip[base.id])} vs ${JSON.stringify(twinTip)}`);
          }
        }
        for (const v of b.variants) {
          await card(v.id).scrollIntoViewIfNeeded();
          const s = await sigOf(v.id);
          let differs = s !== baseSig[v.base];
          let detail = `${v.id} rendered identically to ${v.base}`;
          if (!differs && v.hover) {
            const tip = await hoverTip(v.id);
            differs = tip !== '' && tip !== baseTip[v.base];
            detail = `tooltip ${JSON.stringify(tip)} vs baseline ${JSON.stringify(baseTip[v.base])}`;
          }
          ok(`option ${v.type}.${v.option}=${JSON.stringify(v.value)} visibly changes the render${v.hover ? ' (hovered)' : ''}`, differs, detail);
        }
        await shoot(`board-${b.slug}`);
      }
    });

    // ── 12. Fit: no inner scroll, no tick overlap, labels inside; sticky headers ─
    await section('fit and scroll', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      await openBoard('fit');
      await sleep(1500);
      for (const c of FIT_CASES) {
        const [type] = c;
        const key = fitKey(c);
        for (const size of Object.keys(FIT_SIZES)) {
          const id = `m-${key}-${size}`;
          await card(id).scrollIntoViewIfNeeded();
          await sleep(150);
          const m = await card(id).evaluate(measureCardInPage);
          if (FIT_SCROLLERS.has(key)) {
            // A table block: only its own table box may scroll (never the card, body or block), with the header on top.
            const outer = m.scroll.filter((s) => !/lab-table-wrap/.test(s));
            ok(`${key} (${size}) fits its cell, only its table scrolls`, outer.length === 0, `${m.size.join('x')}: ${m.scroll.join(' | ')}`);
            const st = await card(id).evaluate(stickyInPage);
            if (st.scrolls) {
              ok(`${key} (${size}): the sticky header stays at the top after scrolling`, st.header && st.scrolled > 0 && Math.abs(st.after - st.before) <= 1 && st.onTop, JSON.stringify(st));
            }
          } else {
            ok(`${key} (${size}) fits its cell, no inner scroll`, m.scroll.length === 0, `${m.size.join('x')}: ${m.scroll.join(' | ')}`);
          }
          if (EXPLORER_FIT.has(key)) {
            const clip = await card(id).evaluate(clippedTextInPage);
            ok(`${key} (${size}): no clipped text`, clip.length === 0, clip.slice(0, 6).join(' | '));
            const sf = await card(id).evaluate(smallFormInPage);
            if (key === 'flow') {
              ok(`flow (${size}): every stage label and users figure is visible`, sf.stages === quiz.steps.length && sf.problems.length === 0,
                `${sf.flowMode} ${sf.stages} stages; ${sf.problems.slice(0, 6).join(' | ')}`);
            }
            if (key === 'breakdown') {
              ok(`breakdown (${size}): every row of controls lies inside the cell (nothing cut)`, (sf.selects + sf.chips) > 0 && sf.problems.length === 0,
                `${sf.breakdownCompact ? 'compact' : 'chips'} ${sf.selects} selects ${sf.chips} chips; ${sf.problems.slice(0, 6).join(' | ')}`);
            }
            if (key === 'trend') {
              const sw = await card(id).evaluate(trendSwitchInPage);
              ok(`trend (${size}): the metric switch never ellipsizes a label`, sw.length > 0 && sw.every((x) => !x.cut), `${sw[0]?.form}: ${sw.map((x) => `${x.label} ${x.need}/${x.room}px${x.cut ? ' CUT' : ''}`).join(', ')}`);
            }
            if (key === 'segments') {
              const st = await card(id).evaluate(segmentsTableInPage);
              ok(`segments (${size}): no word is broken mid-word`, !!st && st.broken.length === 0, JSON.stringify(st?.broken.slice(0, 8)));
              if (st?.scrolls) {
                ok(`segments (${size}): the last column is reachable by scrolling and the value column stays stuck`, st.lastVisible && st.stickyFirst,
                  JSON.stringify({ last: st.lastLabel, lastVisible: st.lastVisible, stickyFirst: st.stickyFirst, scrolled: st.scrolled }));
              }
              if (size === 'small') ok('segments (small): the table needs a sideways scroll at 3x3 (precondition)', !!st?.scrolls, JSON.stringify(st));
              if (size === 'small' && st?.scrolls) await explorerShotBoth('segments-scrolled', (path) => card(id).screenshot({ path }));
            }
            await saveExplorerShot(`fit-${key}-${size}.png`, (path) => card(id).screenshot({ path }));
            if (size === 'small' && ['flow', 'breakdown', 'trend'].includes(key)) await explorerShotBoth(`${key}-3x3`, (path) => card(id).screenshot({ path }));
          }
          ok(`axis tick labels never overlap: ${key} (${size})`, m.overlaps.length === 0, m.overlaps.join(' | '));
          ok(`chart labels stay inside the card: ${key} (${size})`, m.outside.length === 0, m.outside.slice(0, 6).join(' | '));
          if (['line', 'stacked', 'bar', 'pie', 'heatmap'].includes(type)) {
            // A chart fills its cell: its drawing spans >= 85% of the block on one axis and >= 60% on the other
            // (a pie is round, so a wide cell leaves it width to spare).
            const f = m.fill ?? { w: 0, h: 0 };
            ok(`${type} (${size}) fills its cell`, Math.max(f.w, f.h) >= 0.85 && Math.min(f.w, f.h) >= 0.6,
              `drawing spans ${Math.round(f.w * 100)}% x ${Math.round(f.h * 100)}% of its block`);
          }
          if (['line', 'stacked', 'bar'].includes(type) && size === 'large') {
            ok(`${type} (large) draws x and y axis labels`, m.ticks >= 4, `${m.ticks} ticks`);
          }
        }
      }
      for (const [id, label] of [['m-table', 'table'], ['m-pivot', 'pivot']]) {
        await card(id).scrollIntoViewIfNeeded();
        await sleep(200);
        const s = await card(id).evaluate(stickyInPage);
        ok(`${label}: scrolls inside its own block`, s.scrolls, JSON.stringify(s));
        ok(`${label}: the sticky header stays at the top after scrolling`, s.scrolls && s.header && s.scrolled > 0 && Math.abs(s.after - s.before) <= 1 && s.onTop, JSON.stringify(s));
      }
      await shoot('board-fit');
    });

    // ── 13. Hover truth: the tooltip shows the datum under the real pointer ────
    /** The tooltip's value for `series` (or its first row), after the pointer moved to (x, y). */
    const tooltipAt = async (id, x, y, series) => {
      await page.mouse.move(x, y, { steps: 4 });
      return until(() => card(id).evaluate((el, s) => {
        const tip = el.querySelector('[data-chart-tooltip]');
        if (!tip || getComputedStyle(tip).visibility === 'hidden') return null;
        const row = s ? tip.querySelector(`[data-series="${s}"]`) : tip.querySelector('[data-series]');
        return {
          value: row?.querySelector('[data-value]')?.textContent ?? null,
          label: row?.querySelector('.lab-chart-tooltip-label')?.textContent ?? '',
          title: tip.querySelector('.lab-chart-tooltip-title')?.textContent ?? '',
          text: tip.innerText,
        };
      }, series), 2000);
    };
    await section('hover truth', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      await openBoard('hover');
      await sleep(1500);
      for (const width of ['narrow', 'wide']) {
        const id = `hv-line-${width}`;
        await card(id).scrollIntoViewIfNeeded();
        await sleep(200);
        // The x of a date, from the RENDERED day labels: two labelled days fix the linear time axis.
        const axis = await card(id).evaluate((el) => {
          const svg = el.querySelector('[data-chart="line"] svg');
          const hit = el.querySelector('[data-chart-hit]');
          if (!svg || !hit) return null;
          const s = svg.getBoundingClientRect();
          const h = hit.getBoundingClientRect();
          return {
            ticks: [...svg.querySelectorAll('[data-axis="x"] .lab-chart-tick')].map((t) => ({ text: t.textContent, x: s.left + Number(t.getAttribute('x')) })),
            midY: h.top + h.height / 2,
          };
        });
        const known = (axis?.ticks ?? []).map((t) => ({ ...t, key: parseDayTick(t.text) })).filter((t) => t.key);
        // Edge labels may be clamped inside the cell: position from the interior ones when there are enough.
        const inner = known.length >= 4 ? known.slice(1, -1) : known;
        ok(`hover truth: line (${width}) has at least 2 dated x labels to position from`, inner.length >= 2, JSON.stringify(axis?.ticks));
        if (inner.length < 2) continue;
        const [a, b] = [inner[0], inner[inner.length - 1]];
        const xOf = (key) => a.x + ((dayMs(key) - dayMs(a.key)) / (dayMs(b.key) - dayMs(a.key))) * (b.x - a.x);
        for (const key of HOVER_DATES) {
          const i = TREND_DAYS.indexOf(key);
          const alpha = await tooltipAt(id, xOf(key), axis.midY, 'alpha');
          const beta = await tooltipAt(id, xOf(key), axis.midY, 'beta');
          ok(`hover truth: line (${width}) ${key}`, parseShown(alpha?.value) === TREND.alpha[i] && parseShown(beta?.value) === TREND.beta[i],
            `pointer x ${Math.round(xOf(key))}: tooltip ${JSON.stringify([alpha?.title, alpha?.value, beta?.value])}, fixture ${TREND.alpha[i]} / ${TREND.beta[i]}`);
          if (width === 'wide' && key === HOVER_DATES[1]) {
            for (const theme of ['light', 'dark']) {
              await setTheme(theme);
              await page.mouse.move(xOf(key), axis.midY);
              await sleep(250);
              await saveShot(`hover-line-${theme}.png`, (path) => card(id).screenshot({ path }));
            }
            await setTheme('light');
          }
        }
        await page.mouse.move(1, 1);
      }
      for (const width of ['narrow', 'wide']) {
        const id = `hv-bar-${width}`;
        await card(id).scrollIntoViewIfNeeded();
        await sleep(200);
        // The x of a category, from its RENDERED axis label (its anchor is the band centre).
        const axis = await card(id).evaluate((el) => {
          const svg = el.querySelector('[data-chart="bar"] svg');
          const hit = el.querySelector('[data-chart-hit]');
          if (!svg || !hit) return null;
          const s = svg.getBoundingClientRect();
          const h = hit.getBoundingClientRect();
          return {
            ticks: [...svg.querySelectorAll('[data-axis="x"] .lab-chart-tick')].map((t) => ({ text: t.textContent, x: s.left + Number(t.getAttribute('x')) })),
            midY: h.top + h.height * 0.5,
          };
        });
        for (const name of HOVER_BARS) {
          const tick = axis?.ticks.find((t) => t.text === name) ?? axis?.ticks.find((t) => t.text.replace(/…$/, '') && name.startsWith(t.text.replace(/…$/, '')));
          const want = REGIONS.find((r) => r[0] === name)[1];
          if (!tick) { ok(`hover truth: bar (${width}) ${name}`, false, `no x label for ${name}: ${JSON.stringify(axis?.ticks)}`); continue; }
          const tip = await tooltipAt(id, tick.x, axis.midY, null);
          ok(`hover truth: bar (${width}) ${name}`, parseShown(tip?.value) === want && (tip?.title ?? '').includes(name),
            `pointer x ${Math.round(tick.x)}: tooltip ${JSON.stringify([tip?.title, tip?.value])}, fixture ${name} = ${want}`);
          if (width === 'wide' && name === 'east') {
            for (const theme of ['light', 'dark']) {
              await setTheme(theme);
              await page.mouse.move(tick.x, axis.midY);
              await sleep(250);
              await saveShot(`hover-bar-${theme}.png`, (path) => card(id).screenshot({ path }));
            }
            await setTheme('light');
          }
        }
        await page.mouse.move(1, 1);
      }
      // Pie: the pointer on a slice (where the slice really is under it) shows its value and share.
      await card('hv-pie').scrollIntoViewIfNeeded();
      await sleep(200);
      for (const name of ['east', 'west']) {
        const pt = await card('hv-pie').evaluate(markPointInPage, [`[data-slice="${name}"]`]);
        const want = REGIONS.find((r) => r[0] === name)[1];
        const tip = pt ? await tooltipAt('hv-pie', pt.x, pt.y, null) : null;
        const share = /([\d.,]+)\s*%/.exec(tip?.label ?? '')?.[1];
        const shown = share === undefined ? null : Number(share.replace(',', '.'));
        const decimals = share?.split(/[.,]/)[1]?.length ?? 0;
        const expected = Number(((want / REGIONS_TOTAL) * 100).toFixed(decimals));
        ok(`hover truth: pie slice ${name} shows its value and share`, (tip?.title ?? '') === name && parseShown(tip?.value) === want && shown === expected,
          `tooltip ${JSON.stringify(tip)}, fixture ${want} = ${expected}%`);
        if (name === 'east' && pt) {
          for (const theme of ['light', 'dark']) {
            await setTheme(theme);
            await page.mouse.move(pt.x, pt.y);
            await sleep(250);
            await saveShot(`hover-pie-${theme}.png`, (path) => card('hv-pie').screenshot({ path }));
          }
          await setTheme('light');
        }
        await page.mouse.move(1, 1);
      }
    });

    // ── 15. Color follows the entity ───────────────────────────────────────────
    await section('color follows the entity', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      await openBoard('hover');
      await sleep(800);
      /** series id -> its mark's paint (line stroke, stacked/pie fill), first mark wins. */
      const paints = async (id, sel, attr) => card(id).evaluate((el, [s, a]) => {
        const out = {};
        for (const m of el.querySelectorAll(s)) {
          const k = m.getAttribute(a.key);
          if (k && !(k in out)) out[k] = getComputedStyle(m)[a.paint];
        }
        return out;
      }, [sel, attr]);
      const kept = (before, after, skip) => Object.keys(after).length > 0
        && Object.entries(after).every(([k, v]) => k === skip || before[k] === v);

      const LINE = ['svg path[data-series]:not([data-area])', { key: 'data-series', paint: 'stroke' }];
      await card('cl-line').scrollIntoViewIfNeeded();
      const l0 = await paints('cl-line', ...LINE);
      await card('cl-line').locator('.lab-chart-legend-item[data-series="web"]').click();
      await sleep(400);
      const l1 = await paints('cl-line', ...LINE);
      ok('color follows the entity: hiding a line series in the legend keeps the others\' strokes',
        !('web' in l1) && kept(l0, l1) && Object.keys(l1).length === 2, `${JSON.stringify(l0)} -> ${JSON.stringify(l1)}`);
      await card('cl-line').locator('.lab-chart-legend-item[data-series="web"]').click();

      const pick = await paints('cl-line-pick', ...LINE);
      ok("color follows the entity: a series pick keeps ios's stroke", !!pick.ios && pick.ios === l0.ios && pick.android === l0.android,
        `all series ${JSON.stringify(l0)} vs pick ${JSON.stringify(pick)}`);

      const STACK = ['[data-series]:is(path, rect, g)', { key: 'data-series', paint: 'fill' }];
      await card('cl-stacked').scrollIntoViewIfNeeded();
      const s0 = await paints('cl-stacked', ...STACK);
      await card('cl-stacked').locator('.lab-chart-legend-item[data-series="web"]').click();
      await sleep(400);
      const s1 = await paints('cl-stacked', ...STACK);
      ok('color follows the entity: hiding a stacked series keeps the others\' fills', !('web' in s1) && kept(s0, s1), `${JSON.stringify(s0)} -> ${JSON.stringify(s1)}`);

      const SLICE = ['[data-slice]', { key: 'data-slice', paint: 'fill' }];
      await card('cl-pie-filter').scrollIntoViewIfNeeded();
      const p0 = await paints('cl-pie-filter', ...SLICE);
      await card('cl-pie-filter').locator('.lab-chart-legend-item[data-series="north"]').click();
      await sleep(400);
      const p1 = await paints('cl-pie-filter', ...SLICE);
      ok('color follows the entity: hiding a slice in the legend keeps the others\' fills', kept(p0, p1, 'north'), `${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`);
      await card('cl-pie-filter').locator('.lab-chart-legend-item[data-series="north"]').click();
      await sleep(300);
      await card('cl-pie-filter').locator('[data-lab-filter-chip="east"]').click();
      await sleep(600);
      const p2 = await paints('cl-pie-filter', ...SLICE);
      ok("color follows the entity: a filter chip keeps the surviving slice's color", !!p2.east && p2.east === p0.east && Object.keys(p2).length === 1,
        `${JSON.stringify(p0)} -> ${JSON.stringify(p2)}`);
      await card('cl-pie-filter').locator('[data-lab-filter-chip="east"]').click();
      await sleep(300);
      await shoot('board-hover');
    });

    // ── 17. Finding 2: charts stay legible at the grid's extreme sizes ─────────
    await section('finding 2: extreme sizes', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      await openBoard('findings');
      await sleep(1500);
      const table = [];
      for (const [key] of COMPACT_CASES) {
        for (const [label, sz] of Object.entries(COMPACT_SIZES)) {
          const id = `f-${key}-${label}`;
          await card(id).scrollIntoViewIfNeeded();
          await sleep(150);
          const m = await card(id).evaluate(compactInPage);
          const fit = await card(id).evaluate(measureCardInPage);
          const name = `${key} ${label}`;
          table.push(`${name.padEnd(14)} size=${m.size} form=${m.form ?? '-'} plot=${m.plot.px.join('x')}px ${Math.round(m.plot.w * 100)}%x${Math.round(m.plot.h * 100)}% (${Math.round(m.area * 100)}%) marks=${m.marks} y=${m.yTicks} x=${m.xTicks} end=${m.endLabels} legend=${m.legend} content=${m.content.join('x')}`);
          ok(`finding 2: ${name} is ${sz.size} size`, m.size === sz.size, `data-size=${m.size}`);
          // A plot that is really drawn: marks exist, the plot is at least 40% of the block's height
          // (axis labels and a legend never eat the rest) and 40% of its shorter side wide (a pie is
          // round); in compact mode (no axes to spend room on) it covers COMPACT_PLOT_MIN of the box.
          const tall = m.plot.px[1] >= 0.4 * m.content[1];
          const wide = m.plot.px[0] >= 0.4 * Math.min(...m.content);
          const covers = sz.size !== 'compact' || m.area >= COMPACT_PLOT_MIN;
          ok(`finding 2: ${name} draws a plot of non-trivial size`, m.marks > 0 && tall && wide && covers,
            `${m.marks} marks; plot ${m.plot.px.join('x')}px = ${Math.round(m.plot.w * 100)}% x ${Math.round(m.plot.h * 100)}% (${Math.round(m.area * 100)}% of the area) of a ${m.content.join('x')} block`);
          ok(`finding 2: ${name} keeps every text inside the card`, m.texts > 0 && m.outside.length === 0, `${m.texts} texts; outside: ${m.outside.slice(0, 5).join(' | ')}`);
          ok(`finding 2: ${name} has no inner scroll`, fit.scroll.length === 0, fit.scroll.join(' | '));
          ok(`finding 2: ${name} y axis shows 0 or >= 2 labels`, m.yTicks !== 1, `${m.yTicks} y labels`);
        }
      }
      console.log(`finding 2 measurements:\n  ${table.join('\n  ')}`);

      // Hover truth on the compact line: no axis to position from, so the pointer goes to the
      // RENDERED line's vertices (the mark the reader points at), and the floating tooltip must
      // name exactly that datum.
      const id = 'f-line-9x2';
      await card(id).scrollIntoViewIfNeeded();
      await sleep(200);
      const geo = await card(id).evaluate((el) => {
        const path = el.querySelector('svg path[data-series="alpha"]:not([data-area])');
        const hit = el.querySelector('[data-chart-hit]');
        if (!path || !hit) return null;
        const nums = (path.getAttribute('d') ?? '').match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
        const m = path.getScreenCTM();
        const pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const p = new DOMPoint(nums[i], nums[i + 1]).matrixTransform(m);
          pts.push(p.x);
        }
        const h = hit.getBoundingClientRect();
        return { xs: pts, midY: h.top + h.height / 2, d: (path.getAttribute('d') ?? '').slice(0, 60) };
      });
      ok('finding 2: the compact line draws one vertex per datum', geo && geo.xs.length === TREND_DAYS.length, JSON.stringify(geo));
      if (geo && geo.xs.length === TREND_DAYS.length) {
        const floatTip = async (x, series) => {
          await page.mouse.move(x, geo.midY, { steps: 4 });
          return until(() => page.evaluate(([cid, s]) => {
            const tip = [...document.querySelectorAll('[data-chart-tooltip]')].find((t) => getComputedStyle(t).visibility !== 'hidden');
            if (!tip) return null;
            const row = tip.querySelector(`[data-series="${s}"]`);
            return {
              value: row?.querySelector('[data-value]')?.textContent ?? null,
              floating: tip.getAttribute('data-chart-tooltip') === 'floating',
              inCard: !!tip.closest(`[data-lab-card="${cid}"]`),
              title: tip.querySelector('.lab-chart-tooltip-title')?.textContent ?? '',
            };
          }, [id, series]), 2000);
        };
        let floats = null;
        for (const key of HOVER_DATES) {
          const i = TREND_DAYS.indexOf(key);
          const alpha = await floatTip(geo.xs[i], 'alpha');
          const beta = await floatTip(geo.xs[i], 'beta');
          floats = floats ?? alpha;
          ok(`finding 2: hover truth: compact line (9x2) ${key}`, parseShown(alpha?.value) === TREND.alpha[i] && parseShown(beta?.value) === TREND.beta[i],
            `pointer x ${Math.round(geo.xs[i])}: tooltip ${JSON.stringify([alpha?.title, alpha?.value, beta?.value])}, fixture ${TREND.alpha[i]} / ${TREND.beta[i]}`);
          if (key === HOVER_DATES[1]) await saveShot('finding-compact-line-hover.png', (path) => page.screenshot({ path }));
        }
        ok("finding 2: the compact line's tooltip floats outside the card", !!floats && floats.floating && !floats.inCard, JSON.stringify(floats));
        await page.mouse.move(1, 1);
      }
      await shoot('board-findings');
    });

    // ── 18. Finding 3: the demo-size table fits its width ─────────────────────
    await section('finding 3: table at the demo size', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      // The demo's viewport (1440 wide): its 4x4 card is narrower than this run's 1600.
      await page.setViewportSize({ width: 1440, height: 900 });
      try { await tableAtDemoSize(); } finally { await page.setViewportSize({ width: 1600, height: 1000 }); await sleep(300); }
    });
    async function tableAtDemoSize() {
      await openBoard('findings');
      await card('f-table').scrollIntoViewIfNeeded();
      await sleep(600);
      const t = await card('f-table').evaluate(tableFitInPage);
      console.log(`finding 3 measurements: ${JSON.stringify({ ...t, titles: t?.titles.slice(0, 2), bodyTexts: t?.bodyTexts.slice(0, 6), byRow: t?.byRow.slice(-2) })}`);
      if (!t) { ok('finding 3: the 4x4 table renders', false, 'no .lab-table-wrap / table'); return; }
      ok('finding 3: the 4x4 table has no horizontal scroll', t.hScroll.length === 0, t.hScroll.join(' | '));
      ok('finding 3: no table cell cuts its text (4x4)', t.cut.length === 0, t.cut.slice(0, 6).join(' | '));
      ok('finding 3: the 4x4 table shows >= 4 full rows between header and total', t.full >= 4,
        `${t.full} of ${t.rows} rows between header bottom ${t.headBottom} and total top ${t.footTop}`);
      // What the fit dropped is still readable: each row's tooltip quotes it as the full (12-wide)
      // table writes that cell.
      await card('f-table-wide').scrollIntoViewIfNeeded();
      await sleep(400);
      const w = await card('f-table-wide').evaluate(tableFitInPage);
      await card('f-table').scrollIntoViewIfNeeded();
      const missing = [];
      const named = t.byRow.filter((r) => !r.other);
      for (const r of named) {
        const full = w?.byRow.find((x) => x.label === r.label);
        if (!full) { missing.push(`no wide row "${r.label}"`); continue; }
        if (!r.title.startsWith(r.label)) missing.push(`title "${r.title}" does not name ${r.label}`);
        for (const key of t.dropped) if (!full.cells[key] || !r.title.includes(full.cells[key])) missing.push(`${r.label}: ${key} "${full.cells[key]}" not in "${r.title}"`);
      }
      ok("finding 3: each row's tooltip carries what the 4x4 table dropped", t.dropped.length > 0 && named.length >= 8 && missing.length === 0,
        `dropped ${JSON.stringify(t.dropped)}; ${named.length} named rows; ${missing.slice(0, 4).join(' | ')}`);
      const unitHeads = t.headers.filter((h) => /\busers\b/.test(h));
      const unitCells = t.bodyTexts.filter((x) => /\busers\b/.test(x));
      ok('finding 3: the header carries the unit once, no body cell repeats it', unitHeads.length === 1 && unitCells.length === 0,
        `headers ${JSON.stringify(t.headers)}; cells with the unit: ${JSON.stringify(unitCells.slice(0, 4))}`);
      await saveShot('finding-table-4x4.png', (path) => card('f-table').screenshot({ path }));

      const all = ['country', 'v', 'prev', 'n'];
      ok('finding 3: a 12-wide copy keeps every column', !!w && w.dropped.length === 0 && all.every((c) => w.columns.includes(c))
        && [...t.columns, ...t.dropped].every((c) => w.columns.includes(c)) && w.hScroll.length === 0 && w.cut.length === 0,
        JSON.stringify({ wide: w?.columns, dropped: w?.dropped, narrow: t.columns, narrowDropped: t.dropped, hScroll: w?.hScroll, cut: w?.cut }));
    }

    // ── 19. Finding 4: no card in a card; an untitled card has no header ──────
    await section('finding 4: html cell + untitled card', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      await openBoard('findings');
      await card('f-untitled').scrollIntoViewIfNeeded();
      await sleep(600);
      const inFrame = async (id) => {
        const h = await card(id).locator('iframe').first().elementHandle({ timeout: 10000 });
        const f = h && await h.contentFrame();
        return f ? until(() => f.evaluate(kitInPage).then((k) => (Object.keys(k.cards).length ? k : null)), 6000) : null;
      };
      const one = await inFrame('f-untitled');
      ok('the dc- kit applies inside the html block (inner elements)', kitApplies(one), JSON.stringify(one));
      ok('finding 4: a single root dc-card dissolves into the cell (0 padding, 0 border)', rootDissolved(one, 'kit'), JSON.stringify(one?.cards));
      const two = await inFrame('f-two-cards');
      ok('finding 4: two root dc-cards keep their own boxes', rootKept(two, 'card-a') && rootKept(two, 'card-b'), JSON.stringify(two?.cards));

      const head = await card('f-untitled').evaluate((el) => {
        const art = el.querySelector('article') ?? el;
        const h = art.querySelector('.board-card-head');
        const blk = art.querySelector('.board-card-block');
        const a = art.getBoundingClientRect();
        return {
          head: h ? Math.round(h.getBoundingClientRect().height) : 0,
          titleRows: art.querySelectorAll('.board-card-title').length,
          gap: blk ? Math.round(blk.getBoundingClientRect().top - a.top) : null,
          pad: parseFloat(getComputedStyle(art.querySelector('.board-card-body') ?? art).paddingTop),
        };
      });
      const titled = await card('f-two-cards').evaluate((el) => {
        const art = el.querySelector('article') ?? el;
        const blk = art.querySelector('.board-card-block');
        return blk ? Math.round(blk.getBoundingClientRect().top - art.getBoundingClientRect().top) : null;
      });
      ok('finding 4: an untitled card has no header row', head.head === 0 && head.titleRows === 0 && head.gap !== null && titled !== null && head.gap < titled,
        JSON.stringify({ ...head, titledGap: titled }));

      // Keyboard: Tab from the element before it lands on the (floating) menu, which shows and opens.
      const kb = await card('f-untitled').evaluate((el) => {
        const btn = el.querySelector('[data-lab-card-menu]');
        if (!btn) return { btn: false };
        const tabbable = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
          .filter((e) => e.tabIndex >= 0 && !e.disabled && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0);
        const i = tabbable.indexOf(btn);
        if (i <= 0) return { btn: true, index: i };
        tabbable[i - 1].setAttribute('data-verify-before-menu', '');
        return { btn: true, index: i };
      });
      let reach = { ...kb };
      if (kb.btn && kb.index > 0) {
        await page.locator('[data-verify-before-menu]').first().focus();
        // Option+Tab: WebKit's plain Tab skips buttons unless "Press Tab to highlight each item" is
        // on (Safari's default is off); Option+Tab is the keyboard path to every control there.
        await page.keyboard.press('Alt+Tab');
        await sleep(300);
        reach = await card('f-untitled').evaluate((el) => {
          const btn = el.querySelector('[data-lab-card-menu]');
          const float = btn.closest('.board-card-float-menu');
          return { focused: document.activeElement === btn, opacity: float ? getComputedStyle(float).opacity : null };
        });
        await page.keyboard.press('Enter');
        await sleep(300);
        reach.opened = await page.locator('[data-lab-menu-item]').evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).length);
        await page.keyboard.press('Escape');
        await page.evaluate(() => document.querySelector('[data-verify-before-menu]')?.removeAttribute('data-verify-before-menu'));
      }
      ok("finding 4: an untitled card's menu is reachable by keyboard", reach.focused === true && reach.opacity === '1' && reach.opened > 0, JSON.stringify(reach));
      await saveShot('finding-untitled-and-two-cards.png', (path) => page.screenshot({ path }));
    });

    // ── 20. Finding 5: readable board tab, no placeholder meaning ─────────────
    await section('finding 5: tab name + meaning', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      await openBoard('findings');
      const tab = await page.locator('[data-lab-board-tab="findings"]').first().evaluate((b) => {
        const l = b.querySelector('.board-tab-label') ?? b;
        const range = document.createRange();
        range.selectNodeContents(l);
        const r = range.getBoundingClientRect();
        const lr = l.getBoundingClientRect();
        return {
          text: l.textContent, whole: l.scrollWidth <= l.clientWidth + 1 && r.right <= lr.right + 1,
          title: b.getAttribute('title'), aria: b.getAttribute('aria-label'), visible: b.getClientRects().length > 0,
        };
      }).catch((e) => ({ error: String(e).slice(0, 120) }));
      ok('finding 5: a 24-character board name reads whole on its tab, or the tab carries it',
        tab.visible && tab.text === FINDINGS_TITLE && (tab.whole || (tab.title === FINDINGS_TITLE && tab.aria === FINDINGS_TITLE)), JSON.stringify(tab));

      const manifest = readFileSync(join(LAB, 'insights', 'countries.md'), 'utf-8');
      ok('finding 5: precondition: the insight still carries the scaffold Meaning placeholder', /What does this number MEAN\?/.test(manifest), manifest.slice(0, 300));
      await card('f-table').scrollIntoViewIfNeeded();
      await card('f-table').hover();
      await card('f-table').locator('[data-lab-card-menu]').first().click();
      await page.locator('[data-lab-menu-item="open-detail"]').first().click();
      const panel = page.locator('.idp-panel').first();
      await panel.waitFor({ timeout: 8000 });
      await sleep(1200);
      const text = await panel.innerText();
      ok('finding 5: the detail panel never shows the Meaning placeholder', text.length > 0 && !/What does this number MEAN/i.test(text), text.slice(0, 400));
      await saveShot('finding-detail-panel.png', (path) => page.screenshot({ path }));
      await page.keyboard.press('Escape');
      await sleep(400);
      if (await panel.count()) await page.goBack().catch(() => {});
    });

    // ── 16. Finding 1: a library block by ref / a rebind gets its data now ────
    await section('finding 1: library add + rebind, no reload', async () => {
      if (!chartBoardsReady) throw new Error('chart boards were not created');
      await openBoard('findings');
      await page.evaluate(() => { window.__verifyNoReload = 'same-load'; });
      const sameLoad = () => page.evaluate(() => window.__verifyNoReload === 'same-load');
      /** What the library block prints, polled (a remount is a new frame: re-found each time) until it reads `want`. */
      const libRows = async (id, want) => {
        let last = null;
        await until(async () => {
          if (!(await card(id).locator('iframe').count())) return false;
          const h = await card(id).locator('iframe').first().elementHandle({ timeout: 2000 });
          const f = h && await h.contentFrame();
          last = f ? await f.evaluate(() => document.getElementById('lib-rows')?.textContent ?? null) : null;
          return last === want;
        }, 15000, 250);
        return last;
      };

      await editMode(true);
      const before = await page.locator('[data-lab-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lab-card')));
      await page.locator('[data-lab-add-card-open]').first().click();
      const menu = page.locator('[data-lab-add-card]').first();
      await menu.waitFor();
      await menu.locator('[data-lab-field="bind-to"]').selectOption('regions');
      await menu.locator('[data-lab-add-html="kpi-tile"]').first().click();
      const id = await until(async () => (await page.locator('[data-lab-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lab-card')))).find((x) => !before.includes(x)), 10000);
      const saved = !!id && await until(() => fileCard('findings', id)?.blocks?.[0]?.html?.ref === 'kpi-tile', 10000);
      ok('finding 1: the add-card menu adds the library block by ref', saved, JSON.stringify(id && fileCard('findings', id)));
      if (!id) return;
      await card(id).scrollIntoViewIfNeeded();
      const added = await libRows(id, `lib-rows=${REGIONS.length}`);
      ok("finding 1: a library block added by ref through the UI shows its bound insight's rows without a reload",
        added === `lib-rows=${REGIONS.length}` && await sameLoad(), `block says ${JSON.stringify(added)}; binding ${JSON.stringify(fileCard('findings', id)?.blocks?.[0]?.html?.inputs)}`);
      await saveShot('finding-library-added.png', (path) => card(id).screenshot({ path }));

      await card(id).hover();
      await card(id).locator('[data-lab-card-menu]').first().click();
      await page.locator('[data-lab-menu-item="edit-blocks"]').first().click();
      const insp = page.locator('[data-lab-inspector]').first();
      await insp.waitFor({ timeout: 8000 });
      if (await insp.locator('[data-lab-inspector-block="0"]').count()) await insp.locator('[data-lab-inspector-block="0"]').first().click();
      const bind = insp.locator('[data-lab-field="input-0-binding"]').first();
      await bind.fill('accounts');
      await bind.press('Enter');
      await bind.evaluate((e) => e.blur());
      await until(() => fileCard('findings', id)?.blocks?.[0]?.html?.inputs?.rows === 'accounts', 5000);
      const rebound = await libRows(id, `lib-rows=${ACCOUNTS.length}`);
      ok('finding 1: rebinding the html input in the inspector shows the new rows without a reload',
        rebound === `lib-rows=${ACCOUNTS.length}` && await sameLoad(), `block says ${JSON.stringify(rebound)}; file binding ${JSON.stringify(fileCard('findings', id)?.blocks?.[0]?.html?.inputs)}`);
      await page.keyboard.press('Escape');
      await editMode(false);
    });

    // ── 21-28. The funnel explorer ────────────────────────────────────────────
    const X = 'explorer-demo';
    const XP = 'explorer-proof';
    /** The selection the one-page and parity checks use: a measured platform x language path. */
    const SEL = { platform: 'TikTok Ads', language: 'EN' };
    const selSeg = fixtureSegment(quiz, SEL);
    let explorerReady = false;
    const xin = (loc) => loc.evaluate(explorerInPage);
    const chip = (scope, dim, value) => scope.locator(`[data-lab-breakdown-dim="${dim}"] [data-lab-breakdown-chip="${value}"]`).first();
    /** Set a scope's breakdown selection to exactly `sel` through the chips (All traffic first). */
    const selectChips = async (scope, sel) => {
      await scope.locator('[data-lab-breakdown-all]').first().click();
      await sleep(200);
      for (const [dim, value] of Object.entries(sel)) {
        await chip(scope, dim, value).click();
        await sleep(250);
      }
    };
    const tabBtn = (scope, label) => scope.locator('[data-lab-tab]').nth(PRESET_TABS.indexOf(label));
    const openTab = async (scope, label) => {
      await tabBtn(scope, label).click();
      await sleep(450);
    };
    const pressed = (m) => Object.fromEntries(m.chips.filter((c) => c.pressed).map((c) => [c.dim, c.value]));
    const users = (rows) => rows.map((r) => r.users);
    /** The x of each dated label on the trend's line (two labelled days fix the linear time axis), and a y to hover at. */
    const trendAxis = (loc) => loc.evaluate((el) => {
      const svg = el.querySelector('[data-lab-trend] [data-chart="line"] svg');
      const hit = el.querySelector('[data-lab-trend] [data-chart-hit]');
      if (!svg || !hit) return null;
      const s = svg.getBoundingClientRect();
      const h = hit.getBoundingClientRect();
      return { ticks: [...svg.querySelectorAll('[data-axis="x"] .lab-chart-tick')].map((t) => ({ text: t.textContent, x: s.left + Number(t.getAttribute('x')) })), midY: h.top + h.height / 2 };
    });
    /** The trend tooltip's first value with the real pointer on `date` (positioned from the rendered axis labels). */
    const trendTipAt = async (scope, date) => {
      const axis = await trendAxis(scope);
      const known = (axis?.ticks ?? []).map((t) => ({ ...t, key: parseDayTick(t.text) })).filter((t) => t.key);
      const inner = known.length >= 4 ? known.slice(1, -1) : known;
      if (inner.length < 2) return { value: null, detail: `no dated x labels: ${JSON.stringify(axis?.ticks)}` };
      const [a, b] = [inner[0], inner[inner.length - 1]];
      const x = a.x + ((dayMs(date) - dayMs(a.key)) / (dayMs(b.key) - dayMs(a.key))) * (b.x - a.x);
      await page.mouse.move(x, axis.midY, { steps: 4 });
      const tip = await until(() => scope.evaluate((el) => {
        const t = el.querySelector('[data-lab-trend] [data-chart-tooltip]');
        if (!t || getComputedStyle(t).visibility === 'hidden') return null;
        return { value: t.querySelector('[data-series] [data-value]')?.textContent ?? null, title: t.querySelector('.lab-chart-tooltip-title')?.textContent ?? '' };
      }), 2000);
      await page.mouse.move(1, 1);
      await sleep(120);
      return { value: tip?.value ?? null, detail: `pointer x ${Math.round(x)}: tooltip ${JSON.stringify(tip)}` };
    };
    /** Close any open fullscreen card (a thrown check must not leave the overlay over the next section). */
    const closeOverlay = async () => {
      for (let i = 0; i < 3 && await page.locator('[data-lab-fullscreen]').count(); i++) {
        if (await page.locator('[data-lab-card-exit]').count()) await page.locator('[data-lab-card-exit]').first().click().catch(() => {});
        else await page.keyboard.press('Escape');
        await sleep(400);
      }
    };
    /** Two interior dates of a daily list. */
    const twoDates = (daily) => [daily[Math.floor(daily.length / 3)].t, daily[Math.floor((daily.length * 2) / 3)].t];
    /** A table block's rows and total inside a card (by block path). */
    const tableAt = (loc, path) => loc.evaluate((el, p) => {
      const blk = el.querySelector(`.board-card-block[data-lab-block-path="${p}"]`);
      const foot = blk?.querySelector('tfoot tr[data-total-count]');
      return blk ? {
        rows: [...blk.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()),
        count: foot ? Number(foot.getAttribute('data-total-count')) : null,
        total: foot?.innerText.replace(/\s+/g, ' ').trim() ?? '',
        notSplit: blk.querySelector('[data-lab-not-split]')?.textContent.trim() ?? null,
      } : null;
    }, String(path));

    // ── 21. Setup through the CLI, payload, privacy ────────────────────────────
    await section('explorer: board via CLI, payload, privacy', async () => {
      if (!explorerSynced) throw new Error('the explorer fixtures were not synced');
      if (!page.url().startsWith(BASE)) await gotoInsights();
      dc(['lab', 'board', 'create', X, '--title', 'Funnel explorer demo']);
      dc(['lab', 'board', 'create', XP, '--title', 'Explorer proof cards']);
      const presetOut = dc(['lab', 'board', 'add-card', X, '--preset', 'funnel-explorer', '--insight', EXPLORER, '--id', 'x-explorer'], { allowFail: true });
      ok('lab board add-card --preset funnel-explorer adds the explorer card', /card "x-explorer" added/.test(presetOut), presetOut.slice(0, 300));
      for (const c of EXPLORER_CARDS) {
        const out = dc(['lab', 'board', 'add-card', c.board, '--id', c.id, '--at', c.at, '--block', JSON.stringify(c.blocks[0])], { allowFail: true });
        ok(`lab board add-card --block adds ${c.id}`, out.includes(`card "${c.id}" added`), out.slice(0, 300));
      }
      // The rest of each multi-block card, and every card's title, through `lab board set`.
      for (const slug of [X, XP]) {
        const data = readBoard(slug);
        const spec = {
          title: data.title, ...(data.order !== undefined ? { order: data.order } : {}),
          cards: data.cards.map((cd) => {
            const c = EXPLORER_CARDS.find((x) => x.id === cd.id);
            return c ? { ...cd, title: c.title, blocks: [...(cd.blocks ?? []), ...c.blocks.slice(1)] } : cd;
          }),
        };
        const file = join(SCRATCH, `${slug}.json`);
        writeFileSync(file, JSON.stringify(spec));
        const setOut = dc(['lab', 'board', 'set', slug, '--file', file], { allowFail: true });
        ok(`lab board set completes the multi-block cards (${slug})`, /Board saved/.test(setOut), setOut.slice(0, 600));
      }

      // The preset card: breakdown + tabs (the pages, then one segments tab per dim), 12x12.
      const pc = fileCard(X, 'x-explorer');
      const blocks = (pc?.blocks ?? []).map(normBlock);
      const tabs = blocks[1]?.tabs ?? [];
      ok('the preset card is a breakdown over tabs Daily, Benchmark, Flow, Steps and one Segments tab per dim',
        blocks[0]?.type === 'breakdown' && blocks[1]?.type === 'tabs' && JSON.stringify(tabs.map((t) => t.label)) === JSON.stringify(PRESET_TABS),
        JSON.stringify(blocks).slice(0, 600));
      const kinds = tabs.map((t) => t.blocks.map((b) => `${b.type}${b.options.layout ? `:${b.options.layout}` : ''}${b.options.by ? `:${b.options.by}` : ''}`).join('+'));
      ok('the preset pages are trend, benchmark, funnel flow, funnel bars and segments by each dim',
        JSON.stringify(kinds) === JSON.stringify(['trend', 'benchmark', 'funnel:flow', 'funnel:bars', 'segments:platform', 'segments:language', 'segments:country']), JSON.stringify(kinds));
      ok('the preset card is 12x12 and bound to the insight', pc?.at?.w === 12 && pc?.at?.h === 12 && pc?.insight === EXPLORER, JSON.stringify(pc?.at));

      // Refusals: --preset with --block, and an insight with no funnel yet.
      const both = dc(['lab', 'board', 'add-card', X, '--preset', 'funnel-explorer', '--insight', EXPLORER, '--block', '{"text": {"markdown": "x"}}'], { allowFail: true });
      ok('add-card refuses --preset together with --block', /mutually exclusive/i.test(both), both.slice(0, 200));
      dc(['lab', 'create', 'acme-unsynced', '--title', 'Acme unsynced', '--render', 'funnel', '--adapter', 'script', '--no-board']);
      const unsynced = dc(['lab', 'board', 'add-card', X, '--preset', 'funnel-explorer', '--insight', 'acme-unsynced'], { allowFail: true });
      ok('add-card --preset refuses an unsynced insight ("sync <slug> first")', /sync acme-unsynced first/.test(unsynced), unsynced.slice(0, 200));
      ok('the refused preset calls wrote nothing', (readBoard(X)?.cards ?? []).length === EXPLORER_CARDS.filter((c) => c.board === X).length + 1, String((readBoard(X)?.cards ?? []).length));

      // The board GET: <= 300 KB; per-block projection keeps daily only where a trend draws it.
      const getBoard = (slug) => page.evaluate(async (sl) => {
        const r = await fetch(`/api/lab/boards/${sl}`);
        const text = await r.text();
        return { status: r.status, bytes: new TextEncoder().encode(text).length, text };
      }, slug);
      const res = await getBoard(X);
      const body = JSON.parse(res.text);
      const frames = expandFrames(body.frames ?? {}, body.frameAliases);
      const stored = readBoard(X);
      const bySize = Object.entries(body.frames ?? {}).map(([key, f]) => {
        const [cardId, path] = key.split(':');
        return `${key} ${blockAtPath(stored.cards.find((cd) => cd.id === cardId), path)?.type} ${Math.round(JSON.stringify(f).length / 1024)}KB`;
      });
      ok('explorer: the demo board GET is <= 300 KB', res.status === 200 && res.bytes <= 300 * 1024,
        `${res.status} ${Math.round(res.bytes / 1024)} KB; frames: ${bySize.join(', ')}`);
      const withDaily = [];
      const trendNoDaily = [];
      const missingFrames = [];
      for (const cd of stored.cards) {
        const walk = (b, path) => {
          const nb = normBlock(b);
          if (nb.tabs) nb.tabs.forEach((tb, ti) => tb.blocks.forEach((c, ci) => walk(c, `${path}.${ti}.${ci}`)));
          // An insight block reads the insight's cache, not a frame.
          else if (nb.data && nb.type !== 'insight' && !frames[`${cd.id}:${path}`]) missingFrames.push(`${cd.id}:${path}`);
        };
        (cd.blocks ?? []).forEach((b, i) => walk(b, String(i)));
      }
      ok('explorer: every bound block has its frame once the GET\'s aliases are expanded (expandFrames)', missingFrames.length === 0, missingFrames.join(', '));
      for (const [key, frame] of Object.entries(frames)) {
        if (frame?.kind !== 'funnel') continue;
        const [cardId, path] = key.split(':');
        const blk = blockAtPath(stored.cards.find((cd) => cd.id === cardId), path);
        const has = frame.funnels.some((fn) => (fn.daily?.length ?? 0) > 0 || (fn.segments ?? []).some((s) => (s.daily?.length ?? 0) > 0));
        if (blk?.type === 'trend' && !has) trendNoDaily.push(key);
        if (blk?.type !== 'trend' && has) withDaily.push(`${key} (${blk?.type})`);
      }
      ok('explorer: only trend frames carry daily in the board GET', withDaily.length === 0 && trendNoDaily.length === 0,
        `non-trend with daily: ${withDaily.join(', ')}; trend without: ${trendNoDaily.join(', ')}`);

      // Privacy: no project registered on this machine is named by what the explorer publishes.
      const names = registeredVaultNames();
      const doc = readFileSync(join(REPO, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
      const from = doc.indexOf('### Funnel explorer');
      const docSection = from >= 0 ? doc.slice(from, doc.indexOf('\n### ', from + 10)) : '';
      ok('the skill docs have a Funnel explorer section', docSection.length > 200, String(docSection.length));
      const published = {
        'explorer fixture': readFileSync(EXPLORER_FIXTURE, 'utf-8'), 'app fixture': readFileSync(APP_FIXTURE, 'utf-8'),
        'preset card': JSON.stringify(pc), 'board GET': res.text, 'proof board GET': (await getBoard(XP)).text, 'skill docs (Funnel explorer)': docSection,
      };
      const leaks = [];
      for (const [what, text] of Object.entries(published)) {
        for (const n of names) if (text.toLowerCase().includes(n.toLowerCase())) leaks.push(`${what}: a registered project name (${n.length} chars)`);
      }
      ok(`privacy: no locally registered project name in the explorer fixtures, preset, board GET or docs (${names.length} names checked)`, leaks.length === 0, leaks.join(' | '));
      explorerReady = true;
    });

    // ── 22. Lookup never sums; not measured is not zero ────────────────────────
    await section('explorer: lookup + not measured', async () => {
      if (!explorerReady) throw new Error('the explorer board was not built');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-lab-board]').first().waitFor({ timeout: 20000 });
      await openBoard(X);
      await sleep(1200);
      const steps = card('x-steps');
      await steps.scrollIntoViewIfNeeded();
      await selectChips(steps, { platform: 'Meta Ads' });
      let m = await xin(steps);
      const meta = fixtureSegment(quiz, { platform: 'Meta Ads' });
      ok("lookup never sums: platform=Meta Ads draws the fixture's own path",
        JSON.stringify(m.bars.map((b) => [b.label, b.users])) === JSON.stringify(pathOf(meta)), `${JSON.stringify(m.bars)} vs ${JSON.stringify(pathOf(meta))}`);
      await selectChips(steps, { platform: 'Meta Ads', language: 'EN' });
      m = await xin(steps);
      const metaEn = fixtureSegment(quiz, { platform: 'Meta Ads', language: 'EN' });
      ok("lookup never sums: platform x language draws the fixture's intersection path",
        JSON.stringify(m.bars.map((b) => [b.label, b.users])) === JSON.stringify(pathOf(metaEn)), `${JSON.stringify(m.bars)} vs ${JSON.stringify(pathOf(metaEn))}`);

      // Meta Ads x PT has no measured path: its chip.
      await selectChips(steps, { platform: 'Meta Ads' });
      m = await xin(steps);
      const pt = m.chips.find((c) => c.dim === 'language' && c.value === 'PT');
      const ptSeg = fixtureSegment(quiz, { platform: 'Meta Ads', language: 'PT' });
      ok('fixture precondition: Meta Ads x PT is not measured', ptSeg && ptSeg.measured === false, JSON.stringify(ptSeg));
      ok('not measured: an unmeasured chip is aria-disabled', pt?.disabled === true, JSON.stringify(pt));
      const tip = page.locator('[data-lab-chip-reason]');
      await chip(steps, 'language', 'PT').hover();
      await sleep(300);
      const hovered = await tip.count() ? { visible: await tip.first().isVisible(), text: await tip.first().innerText() } : null;
      ok("not measured: the chip's reason shows on hover", !!hovered?.visible && hovered.text.includes(ptSeg.reason), JSON.stringify(hovered));
      // The shot: the card and the floating reason under it.
      const box = await steps.boundingBox();
      if (box) {
        await explorerShotBoth('disabled-chip-reason', async (path) => {
          await chip(steps, 'language', 'PT').hover();
          await sleep(250);
          await page.screenshot({ path, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(1600 - box.x, box.width + 16), height: Math.min(1000 - box.y, box.height + 80) } });
        });
      }
      await page.mouse.move(1, 1);
      await sleep(250);
      await chip(steps, 'language', 'PT').focus();
      await sleep(300);
      const focused = await tip.count() ? { visible: await tip.first().isVisible(), text: await tip.first().innerText() } : null;
      ok("not measured: the chip's reason shows on keyboard focus", !!focused?.visible && focused.text.includes(ptSeg.reason), JSON.stringify(focused));
      const before = { sel: pressed(m), funnel: m.funnel?.selection, bars: JSON.stringify(m.bars) };
      // aria-disabled keeps the chip focusable and clickable for a pointer: the click must do nothing.
      await chip(steps, 'language', 'PT').click({ force: true });
      await sleep(400);
      const after = await xin(steps);
      ok('not measured: clicking an unmeasured chip changes nothing',
        JSON.stringify(pressed(after)) === JSON.stringify(before.sel) && after.funnel?.selection === before.funnel && JSON.stringify(after.bars) === before.bars,
        `${JSON.stringify(before.sel)} ${before.funnel} -> ${JSON.stringify(pressed(after))} ${after.funnel?.selection}`);
      const zero = /(^|[^\d.,])0(?:[.,]0+)?\s*%?(?![\d.,])/;
      ok('not measured: the unmeasured chip draws no 0', !zero.test(pt?.text ?? ''), pt?.text);
      await steps.locator('[data-lab-breakdown-all]').first().click();

      // An unmeasured metric on the benchmark ruler (all traffic: checkout_to_purchase has a broken denominator),
      // on the preset card's Benchmark page (every row drawn in full there).
      const bench = card('x-explorer');
      await bench.scrollIntoViewIfNeeded();
      await selectChips(bench, {});
      await openTab(bench, 'Benchmark');
      const b = await xin(bench);
      const row = b.bench.find((r) => r.key === 'checkout_to_purchase');
      const want = `Not measured: ${quiz.metrics.checkout_to_purchase.reason}`;
      ok('not measured: an unmeasured metric reads "Not measured: reason" with no ruler marker',
        row?.unmeasured === want && row?.anyMarker === false && row?.status === 'unmeasured', JSON.stringify(row));
      ok('not measured: no 0 or 0% is drawn for an unmeasured metric', !!row && !zero.test(row.text.replace(row.label, '')), row?.text);

      // Lookup: the benchmark of a platform x language path reads THAT path's metrics (a sum has none).
      await selectChips(bench, SEL);
      const bs = await xin(bench);
      const measuredKeys = Object.entries(selSeg.metrics).filter(([, v]) => v.v !== null && v.measured !== false).map(([k]) => k);
      const wrong = measuredKeys.filter((k) => !shownEquals(bs.bench.find((r) => r.key === k)?.value, selSeg.metrics[k].v));
      ok("lookup never sums: the benchmark for platform x language reads the intersection's own metrics", measuredKeys.length >= 3 && wrong.length === 0,
        `wrong: ${wrong.map((k) => `${k} shows ${bs.bench.find((r) => r.key === k)?.value} want ${selSeg.metrics[k].v}`).join('; ')} rows ${JSON.stringify(bs.bench.map((r) => [r.key, r.value]))}`);
    });

    // ── 23. One interactive page: the preset card ──────────────────────────────
    await section('explorer: one interactive page', async () => {
      if (!explorerReady) throw new Error('the explorer board was not built');
      await openBoard(X);
      const ex = card('x-explorer');
      await ex.scrollIntoViewIfNeeded();
      await sleep(400);
      const labels = await ex.locator('[data-lab-tab]').allInnerTexts();
      ok('one page: the preset card shows its tabs in order', JSON.stringify(labels.map((l) => l.trim())) === JSON.stringify(PRESET_TABS), JSON.stringify(labels));
      const t0 = Date.now();
      await selectChips(ex, SEL);
      const bad = [];
      let chipTabSyncs = [];
      for (const label of PRESET_TABS) {
        await openTab(ex, label);
        const m = await xin(ex);
        const chipsKept = JSON.stringify(pressed(m)) === JSON.stringify(SEL);
        let drew = false;
        let detail = '';
        if (label === 'Daily') {
          const date = twoDates(selSeg.daily)[0];
          const key = m.trend?.metrics.find((x) => x.on)?.key ?? Object.keys(selSeg.metrics)[0];
          const tip = await trendTipAt(ex, date);
          const want = selSeg.daily.find((d) => d.t === date)?.m[key];
          drew = m.trend?.state === 'ok' && shownEquals(tip.value, want);
          detail = `${key} ${date}: ${tip.detail} want ${want}`;
        } else if (label === 'Benchmark') {
          const r = m.bench.find((x) => x.key === 'visit_to_lead');
          drew = shownEquals(r?.value, selSeg.metrics.visit_to_lead.v);
          detail = `visit_to_lead shows ${r?.value} want ${selSeg.metrics.visit_to_lead.v}`;
        } else if (label === 'Flow') {
          drew = JSON.stringify(users(m.flow?.stages ?? [])) === JSON.stringify(selSeg.steps.map((s) => s.users));
          detail = `${JSON.stringify(users(m.flow?.stages ?? []))} want ${JSON.stringify(selSeg.steps.map((s) => s.users))}`;
        } else if (label === 'Steps') {
          drew = JSON.stringify(m.bars.map((b) => [b.label, b.users])) === JSON.stringify(pathOf(selSeg));
          detail = `${JSON.stringify(m.bars.map((b) => b.users))} want ${JSON.stringify(pathOf(selSeg).map((p) => p[1]))}`;
        } else if (label === 'Platform' || label === 'Language') {
          const dim = label.toLowerCase();
          const active = m.seg?.rows.find((r) => r.active);
          drew = active?.value === SEL[dim] && shownEquals(active?.usersText, selSeg.users);
          detail = `active ${JSON.stringify(active)} want ${SEL[dim]} ${selSeg.users}`;
        } else {
          // Country under platform x language: no such path in the fixture, so every row is unmeasured (dashes, no 0).
          drew = (m.seg?.rows.length ?? 0) === 8 && m.seg.rows.every((r) => r.unmeasured && r.users === null);
          detail = JSON.stringify(m.seg?.rows.map((r) => [r.value, r.usersText]));
        }
        ok(`one page: the ${label} tab draws the selected path`, chipsKept && drew, `chips ${JSON.stringify(pressed(m))}; ${detail}`);
        const clip = await ex.evaluate(clippedTextInPage);
        ok(`one page: the ${label} tab has no clipped text (12x12 preset card)`, clip.length === 0, clip.slice(0, 5).join(' | '));
        if (!(chipsKept && drew)) bad.push(label);
        await explorerShotBoth(`tab-${label.toLowerCase()}`, (path) => ex.screenshot({ path }));
      }
      ok('one page: the selection holds on every tab', bad.length === 0, `tabs that lost it: ${bad.join(', ')}`);
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        const cb = await ex.evaluate(chipsAndBandInPage);
        ok(`breakdown: an active chip's label is readable (contrast >= 4.5:1, ${theme})`, cb.chips.length >= 2 && cb.chips.every((c) => c.ratio !== null && c.ratio >= 4.5),
          cb.chips.map((c) => `${c.value} ${c.ratio}:1`).join(', '));
        if (theme === 'light') {
          ok('one page: the tabs start right under the chips (no blank band > 24px)', cb.band !== null && cb.band <= 24, `blank band ${cb.band}px`);
        }
      }
      await setTheme('light');
      await openTab(ex, 'Daily');
      ok('one page: back on the first tab the chips still hold the selection', JSON.stringify(pressed(await xin(ex))) === JSON.stringify(SEL));
      chipTabSyncs = syncReqs.filter((r) => r.at >= t0);

      // Same-insight tables: the one split by the dim narrows (its total follows), the other says so.
      await openBoard(XP);
      const plus = card('x-plus');
      await plus.scrollIntoViewIfNeeded();
      const t1 = await tableAt(plus, 2);
      const t3 = Date.now();
      await selectChips(plus, { language: 'EN' });
      const t2 = await tableAt(plus, 2);
      chipTabSyncs = [...chipTabSyncs, ...syncReqs.filter((r) => r.at >= t3)];
      const en = BY_PLATFORM.filter((r) => r[1] === 'EN');
      const enSum = en.reduce((s, r) => s + r[2], 0);
      ok('one page: a same-insight table narrows by the selection and its total follows',
        t1?.count === BY_PLATFORM.length && t2?.rows.length === en.length && t2?.count === en.length
          && (t2.total.replace(/[^\d]/g, '').includes(String(enSum)) || new RegExp(`${(enSum / 1000).toFixed(1)}\\s?K`, 'i').test(t2.total)),
        `before ${JSON.stringify(t1)} after ${JSON.stringify(t2)} want ${en.length} rows, total ${enSum}`);
      const d = await tableAt(plus, 3);
      ok('one page: a table without the dim says "Not split by language"', /not split/i.test(d?.notSplit ?? '') && /language/i.test(d?.notSplit ?? '') && d?.count === 15,
        JSON.stringify(d));
      ok('explorer: breakdown chip and tab clicks send ZERO sync requests', chipTabSyncs.length === 0, JSON.stringify(chipTabSyncs));
    });

    // ── 24. Every page a bindable block: the separate cards + the inspector's picks ──
    await section('explorer: every page a block', async () => {
      if (!explorerReady) throw new Error('the explorer board was not built');
      await openBoard(X);
      const drawn = {};
      for (const id of ['x-steps', 'x-daily', 'x-bench', 'x-countries', 'x-payment']) {
        await card(id).scrollIntoViewIfNeeded();
        await sleep(150);
        drawn[id] = await xin(card(id));
      }
      ok('every page: the Steps card draws funnel bars with the worst drop marked', drawn['x-steps'].funnel?.layout === 'bars' && drawn['x-steps'].bars.length >= 2 && drawn['x-steps'].bars.filter((b) => b.worst).length === 1,
        JSON.stringify(drawn['x-steps'].bars));
      ok('every page: the Daily card draws a trend', drawn['x-daily'].trend?.state === 'ok' && drawn['x-daily'].trend.paths.length > 0, JSON.stringify(drawn['x-daily'].trend));
      // A 6x6 card draws what fits and counts the rest in words ("+N more"), never a scroll.
      const bm = drawn['x-bench'];
      ok('every page: the Benchmark card accounts for every metric (rows drawn + "+N more")', bm.bench.length >= 1 && bm.bench.length + (bm.benchMore ?? 0) === Object.keys(quiz.metrics).length,
        `${JSON.stringify(bm.bench.map((r) => r.key))} + ${bm.benchMore}`);
      const countries = demo.data.funnel.dimensions.find((dm) => dm.key === 'country').values.map((v) => v.value);
      const cRows = drawn['x-countries'].seg?.rows ?? [];
      const cWrong = countries.filter((c) => !shownEquals(cRows.find((r) => r.value === c)?.usersText, fixtureSegment(quiz, { country: c }).users));
      ok("every page: the Countries card lists one row per country (none folded into Other), each the fixture's own users",
        cRows.length === countries.length && !cRows.some((r) => /other/i.test(r.value)) && cWrong.length === 0, `${JSON.stringify(cRows.map((r) => [r.value, r.usersText]))} wrong ${cWrong}`);
      const pay = await card('x-payment').evaluate((el) => ({
        chips: el.querySelectorAll('[data-lab-filter-chip]').length, bars: el.querySelectorAll('[data-bar]').length, rows: el.querySelectorAll('tbody tr').length,
      }));
      ok('every page: the Payment card draws its cohort filter, decline bars and rate table', pay.chips >= 3 && pay.bars > 0 && pay.rows === 3, JSON.stringify(pay));
      await shoot('explorer-demo', { explorer: true });
      await openBoard(XP);
      const xt = (await xin(card('x-trend'))).trend;
      ok('every page: a trend with a metrics pick draws those metrics', (xt?.metrics ?? []).map((x) => x.key).join(',') === 'conversion,visit_to_lead', JSON.stringify(xt));
      await shoot('explorer-proof', { explorer: true });
      await openBoard(X);

      // The inspector: pick fields list the frame's funnels, dims and metrics; a pick edits file + render.
      await editMode(true);
      const cc = card('x-countries');
      await cc.scrollIntoViewIfNeeded();
      await cc.locator('[data-lab-card-menu]').first().click();
      await page.locator('[data-lab-menu-item="edit-blocks"]').first().click();
      const insp = page.locator('[data-lab-inspector]').first();
      await insp.waitFor({ timeout: 8000 });
      if (await insp.locator('[data-lab-inspector-block="0"]').count()) await insp.locator('[data-lab-inspector-block="0"]').first().click();
      await sleep(400);
      const opts = (field) => insp.locator(`select[data-lab-field="${field}"] option`).evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
      const checks = (field) => insp.locator(`[data-lab-field="${field}"] input[type="checkbox"]`).evaluateAll((els) => els.map((e) => e.value));
      const funnels = await opts('funnel');
      const dims = await opts('by');
      const metrics = await checks('metrics');
      ok("inspector: the funnel pick lists the frame's funnels", JSON.stringify(funnels) === JSON.stringify(demo.data.funnel.funnels.map((f) => f.id)), JSON.stringify(funnels));
      ok("inspector: the by pick lists the frame's dims", JSON.stringify(dims) === JSON.stringify(demo.data.funnel.dimensions.map((dm) => dm.key)), JSON.stringify(dims));
      ok("inspector: the metrics pick lists the funnel's metrics", JSON.stringify(metrics) === JSON.stringify(Object.keys(quiz.metrics)), JSON.stringify(metrics));
      await explorerShotBoth('inspector-picks', (path) => page.screenshot({ path }));
      await insp.locator('select[data-lab-field="by"]').first().selectOption('language');
      const saved = await until(() => normBlock(fileCard(X, 'x-countries')?.blocks?.[0])?.options?.by === 'language', 5000);
      await sleep(600);
      const langRows = (await xin(cc)).seg?.rows.map((r) => r.value) ?? [];
      ok('inspector: picking by=language writes the board file and the card splits by language',
        !!saved && JSON.stringify(langRows) === JSON.stringify(demo.data.funnel.dimensions.find((dm) => dm.key === 'language').values.map((v) => v.value)),
        `${JSON.stringify(fileCard(X, 'x-countries')?.blocks?.[0])} rows ${JSON.stringify(langRows)}`);
      await insp.locator('select[data-lab-field="by"]').first().selectOption('country');
      await until(() => normBlock(fileCard(X, 'x-countries')?.blocks?.[0])?.options?.by === 'country', 5000);
      await page.keyboard.press('Escape');
      await editMode(false);
    });

    // ── 25. Lanes ──────────────────────────────────────────────────────────────
    await section('explorer: lanes', async () => {
      if (!explorerReady) throw new Error('the explorer board was not built');
      await openBoard(X);
      const steps = card('x-steps');
      await steps.scrollIntoViewIfNeeded();
      if (await steps.locator('[data-lab-lanes-clear]').count()) await steps.locator('[data-lab-lanes-clear]').first().click();
      const picks = [{ platform: 'Meta Ads' }, { platform: 'TikTok Ads' }, { platform: 'Unattributed' }];
      for (const sel of picks) {
        await selectChips(steps, sel);
        await steps.locator('[data-lab-lane-pin]').first().click();
        await sleep(300);
      }
      const m = await xin(steps);
      const heads = m.lanes?.heads ?? [];
      ok('lanes: 3 pinned lanes draw side by side on one step spine',
        m.lanes?.n === 3 && heads.length === 3 && heads.every((h, i) => i === 0 || (Math.abs(h.top - heads[0].top) < 2 && h.left > heads[i - 1].left))
          && JSON.stringify(m.lanes.spine) === JSON.stringify(quiz.steps.map((s) => s.key)),
        JSON.stringify({ n: m.lanes?.n, heads, spine: m.lanes?.spine }));
      const n = m.lanes?.n ?? 0;
      const problems = [];
      picks.forEach((sel, li) => {
        const seg = fixtureSegment(quiz, sel);
        const own = fixtureDrops(seg.steps);
        (m.lanes?.spine ?? []).forEach((key, si) => {
          const cell = m.lanes.cells[si * n + li];
          const st = seg.steps.find((s) => s.key === key);
          if (st ? cell?.users !== st.users : cell?.missing !== key) problems.push(`lane ${li + 1} ${key}: ${JSON.stringify(cell)} want ${st?.users ?? 'dash'}`);
        });
        for (const d of own.drops.filter((x) => x.dropPct !== null)) {
          const shown = m.lanes.drops.find((x) => x.lane === li + 1 && x.key === d.key);
          const a = Math.abs(d.dropPct);
          const want = `${d.dropPct < 0 ? '▲' : '▼'} ${a.toFixed(a >= 10 ? 0 : 1)}%`;
          if (shown?.text !== want) problems.push(`lane ${li + 1} drop ${d.key}: ${shown?.text} want ${want}`);
        }
        const worst = m.lanes.drops.filter((x) => x.lane === li + 1 && x.worst).map((x) => x.key);
        if (JSON.stringify(worst) !== JSON.stringify([own.worst])) problems.push(`lane ${li + 1} worst ${worst} want ${own.worst}`);
      });
      ok("lanes: each lane's users and drops come from its own path", problems.length === 0, problems.slice(0, 6).join(' | '));
      const dash = m.lanes?.cells.find((c) => c.lane === 3 && c.missing === 'email');
      ok('lanes: a missing step shows a dash (Unattributed has no email step)', dash?.text === '—' && !m.lanes.cells.some((c) => c.lane === 3 && c.users === 0),
        JSON.stringify(m.lanes?.cells.filter((c) => c.lane === 3)));
      const laneClip = await steps.evaluate(clippedTextInPage);
      // Every users-and-% cell: >= 10px tall, its users figure and a percent painted (a visible box, not hidden).
      const unpainted = await steps.evaluate((el) => {
        const shown = (e) => {
          if (!e) return false;
          for (let a = e; a && a !== el; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
          }
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height >= 8;
        };
        return [...el.querySelectorAll('.funnel-lanes-cell:not(.funnel-lanes-cell--missing)')].flatMap((c) => {
          const h = c.getBoundingClientRect().height;
          const users = shown(c.querySelector('.funnel-lanes-value'));
          const pct = [...c.querySelectorAll('.funnel-lanes-pct, .funnel-lanes-share')].some(shown);
          return h >= 10 && users && pct ? [] : [`lane ${c.getAttribute('data-lane')} "${c.textContent.trim().slice(0, 16)}" ${Math.round(h)}px users ${users} pct ${pct}`];
        });
      });
      ok('lanes: every users and % cell is >= 10px tall with its text painted, no clipped text (the 8x7 Steps card)', laneClip.length === 0 && unpainted.length === 0,
        `${unpainted.length} bad cells: ${unpainted.slice(0, 5).join(', ')} | ${laneClip.slice(0, 4).join(' | ')}`);
      await explorerShotBoth('3-lanes', (path) => steps.screenshot({ path }));
      await explorerShotBoth('lanes-8x7', (path) => steps.screenshot({ path }));
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        const nums = await steps.evaluate(contrastInPage, '.funnel-lanes-num, .lab-breakdown-lane-num');
        ok(`lanes: every lane number reads at >= 4.5:1 (${theme})`, nums.length >= 6 && nums.every((x) => x.ratio !== null && x.ratio >= 4.5), nums.map((x) => `${x.text} ${x.ratio}:1`).join(', '));
      }
      await setTheme('light');
      await selectChips(steps, { language: 'EN' });
      await steps.locator('[data-lab-lane-pin]').first().click();
      await sleep(300);
      await selectChips(steps, { language: 'ES' });
      const full = await xin(steps);
      ok('lanes: the 5th pin is disabled', full.lanes?.n === 4 && full.pin?.disabled === true && full.pin?.blocked === 'full', JSON.stringify({ n: full.lanes?.n, pin: full.pin }));
      await steps.locator('[data-lab-lane-pin]').first().click({ force: true }).catch(() => {});
      await sleep(250);
      ok('lanes: a click on the disabled 5th pin adds nothing', (await xin(steps)).lanes?.n === 4);
      if (await steps.locator('[data-lab-lanes-clear]').count()) await steps.locator('[data-lab-lanes-clear]').first().click();
      await selectChips(steps, {});
    });

    // ── 26. Benchmark ruler, flow, segments, trend ─────────────────────────────
    await section('explorer: benchmark, flow, segments, trend', async () => {
      if (!explorerReady) throw new Error('the explorer board was not built');
      await closeOverlay();
      await openBoard(X);
      // The preset card's Benchmark page: every row in full (the ruler, delta, status, sources).
      const bench = card('x-explorer');
      await bench.scrollIntoViewIfNeeded();
      await openTab(bench, 'Benchmark');
      const offsets = [];
      for (const sel of [{}, { platform: 'TikTok Ads' }]) {
        await selectChips(bench, sel);
        const rows = (await xin(bench)).bench;
        const seg = fixtureSegment(quiz, sel);
        for (const r of rows) {
          const band = sel.platform ? (seg.benchmarks ?? {})[r.key] : setBands[r.key];
          const v = seg.metrics[r.key]?.v;
          if (!band || band.floor == null || band.target == null || v == null || r.markers.floor === null || r.markers.target === null) continue;
          const want = r.markers.floor + ((v - band.floor) * (r.markers.target - r.markers.floor)) / (band.target - band.floor);
          offsets.push({ sel: JSON.stringify(sel), key: r.key, off: r.markers.current === null ? Infinity : Math.abs(r.markers.current - want) });
        }
      }
      ok('benchmark: the current marker sits within 1px of its scale position', offsets.length >= 4 && offsets.every((o) => o.off <= 1),
        JSON.stringify(offsets.map((o) => [o.sel, o.key, Number.isFinite(o.off) ? o.off.toFixed(2) : 'none'])));

      // TikTok Ads: its own band (sources own p25/p75 and book), cost per lead better: lower.
      const tik = fixtureSegment(quiz, { platform: 'TikTok Ads' });
      const rows = (await xin(bench)).bench;
      const deltaBad = [];
      const statusBad = [];
      for (const r of rows) {
        const mv = tik.metrics[r.key];
        // Per-metric inheritance: a metric without its own band reads the set's band.
        const want = fixtureStatus(mv.measured === false ? null : mv.v, (tik.benchmarks ?? {})[r.key] ?? setBands[r.key]);
        if (r.status !== want) statusBad.push(`${r.key} ${r.status} want ${want}`);
        if (mv.v == null || mv.prev == null) continue;
        const delta = mv.v - mv.prev;
        const signOk = delta > 0 ? /\+/.test(r.delta ?? '') : delta < 0 ? /[−-]/.test(r.delta ?? '') : true;
        if (!signOk || !shownEquals(r.delta, Math.abs(delta))) deltaBad.push(`${r.key} "${r.delta}" want ${delta.toFixed(3)}`);
      }
      ok("benchmark: the delta vs the previous window is the fixture's current minus previous", deltaBad.length === 0 && rows.some((r) => r.delta), deltaBad.join(' | '));
      ok('benchmark: each status is the band status of the fixture value', statusBad.length === 0, statusBad.join(' | '));
      const cpl = rows.find((r) => r.key === 'cost_per_lead');
      const cplHigher = fixtureStatus(tik.metrics.cost_per_lead.v, { ...tik.benchmarks.cost_per_lead, better: 'higher' });
      ok('benchmark: better: lower flips the status (cost per lead)', cpl?.better === 'lower' && cpl?.status === 'between' && cplHigher === 'below' && /between/i.test(cpl?.statusWord ?? ''),
        `${JSON.stringify(cpl)} (as higher-is-better it would read ${cplHigher})`);
      const cplDelta = tik.metrics.cost_per_lead.v - tik.metrics.cost_per_lead.prev;
      const cplTrend = cplDelta < 0 ? 'improving' : cplDelta > 0 ? 'worsening' : 'flat';
      ok('benchmark: better: lower flips the trend word', cpl?.trend === cplTrend && (cpl?.trendWord ?? '').toLowerCase().includes(cplTrend), `${cpl?.trend} "${cpl?.trendWord}" want ${cplTrend} (delta ${cplDelta.toFixed(2)})`);
      // The preset card itself (12x12): every row prints its sources, its floor / target numbers and the previous window.
      const printBad = [];
      for (const r of rows) {
        const mv = tik.metrics[r.key];
        if (mv.v == null || mv.measured === false) continue;
        const band = (tik.benchmarks ?? {})[r.key] ?? setBands[r.key];
        if (band?.floor != null && !shownEquals(r.boundLabels.floor, band.floor)) printBad.push(`${r.key} floor label "${r.boundLabels.floor}" want ${band.floor}`);
        if (band?.target != null && !shownEquals(r.boundLabels.target, band.target)) printBad.push(`${r.key} target label "${r.boundLabels.target}" want ${band.target}`);
        if (mv.prev != null && !shownEquals(r.prevValue, mv.prev)) printBad.push(`${r.key} previous "${r.prevValue}" want ${mv.prev}`);
        const srcs = [band?.floor_source, band?.target_source].filter(Boolean);
        if (srcs.some((src) => !(r.sources ?? '').includes(src))) printBad.push(`${r.key} sources "${r.sources}" want ${srcs.join(' + ')}`);
      }
      const presetMode = await bench.locator('[data-lab-benchmark]').first().getAttribute('data-mode');
      ok('benchmark: the preset card prints every row\'s sources and its floor / target / previous numbers',
        printBad.length === 0 && rows.length === Object.keys(quiz.metrics).length, `mode ${presetMode}; ${printBad.join(' | ')}`);

      // Per-metric inheritance: TikTok Ads has its own band for 2 metrics; the other banded rows inherit the set's,
      // and each row says which (the card, and `lab board show --select` the same).
      const ownKeys = Object.keys(tik.benchmarks ?? {});
      const inheritKeys = Object.keys(setBands).filter((k) => !ownKeys.includes(k) && tik.metrics[k]?.measured !== false && tik.metrics[k]?.v != null);
      const markBad = rows.filter((r) => (inheritKeys.includes(r.key) && !r.inheritedMark) || (ownKeys.includes(r.key) && r.inheritedMark)).map((r) => `${r.key} marked ${r.inheritedMark}`);
      const cardNote = await bench.locator('[data-lab-bench-inherited]').allInnerTexts();
      ok('benchmark: each inheriting row is marked inherited, each own-band row is not (TikTok Ads, per metric)', markBad.length === 0 && inheritKeys.length >= 1,
        `inherit ${inheritKeys.join(',')}; own ${ownKeys.join(',')}; wrong ${markBad.join(' | ') || '-'}; card note ${JSON.stringify(cardNote)}`);
      const tikView = JSON.parse(dc(['lab', 'board', 'show', X, '--select', 'platform=TikTok Ads', '--json']));
      const cliRows = tikView.cards.find((c) => c.id === 'x-explorer')?.blocks.find((bl) => bl.tab === 'Benchmark')?.explorer?.rows ?? [];
      const cliBad = cliRows.filter((r) => r.inherited !== inheritKeys.includes(r.key)).map((r) => `${r.key} ${r.inherited}`);
      ok('benchmark: lab board show --select marks the same rows inherited (per metric)', cliRows.length > 0 && cliBad.length === 0, cliBad.join(', '));
      await explorerShotBoth('benchmark', (path) => bench.screenshot({ path }));

      // Fullscreen: all 5 rows, nothing folded into "+N more", sources printed.
      await bench.locator('[data-lab-card-menu]').first().click();
      await page.locator('[data-lab-card-fullscreen="open"]').first().click();
      const fsBench = page.locator('[data-lab-fullscreen="x-explorer"]');
      await fsBench.waitFor({ timeout: 6000 }).catch(() => {});
      await sleep(500);
      const fsAll = (await fsBench.count()) ? await xin(fsBench) : null;
      const fsRows = fsAll?.bench ?? [];
      const vtl = fsRows.find((r) => r.key === 'visit_to_lead');
      const cplFs = fsRows.find((r) => r.key === 'cost_per_lead');
      ok('benchmark: fullscreen shows all 5 rows with their sources',
        fsRows.length === Object.keys(quiz.metrics).length && (fsAll?.benchMore ?? 1) === 0
          && /own p25 \(8 wk\)/.test(vtl?.sources ?? '') && /own p75 \(8 wk\)/.test(vtl?.sources ?? '') && /book/.test(cplFs?.sources ?? ''),
        `${fsRows.length} rows + ${fsAll?.benchMore}; ${vtl?.sources} / ${cplFs?.sources}`);
      await explorerShotBoth('benchmark-fullscreen', (path) => page.screenshot({ path }));
      await closeOverlay();
      await selectChips(bench, { platform: 'Meta Ads' });
      ok('benchmark: an all-inherited selection (Meta Ads) notes its inherited band', await bench.locator('[data-lab-bench-inherited]').count() === 1);
      await selectChips(bench, {});

      // The plan's 6x6 Benchmark card (breakdown + benchmark) shows all 5 rows.
      const b6 = card('x-bench');
      await b6.scrollIntoViewIfNeeded();
      await sleep(300);
      const b6m = await xin(b6);
      const b6clip = await b6.evaluate(clippedTextInPage);
      ok('benchmark: the 6x6 card shows all 5 rows (no "+N more"), no clipped text', b6m.bench.length === Object.keys(quiz.metrics).length && b6m.benchMore === 0 && b6clip.length === 0,
        `${b6m.bench.length} rows + ${b6m.benchMore}; ${b6clip.slice(0, 4).join(' | ')}`);
      await explorerShotBoth('benchmark-6x6', (path) => b6.screenshot({ path }));

      // Flow (the preset card's Flow page under the selection).
      const ex = card('x-explorer');
      await ex.scrollIntoViewIfNeeded();
      await selectChips(ex, SEL);
      await openTab(ex, 'Flow');
      const f = (await xin(ex)).flow;
      const max = Math.max(...selSeg.steps.map((s) => s.users));
      const widthBad = (f?.stages ?? []).filter((s, i) => Math.abs(s.widthPct - (selSeg.steps[i].users / max) * 100) > 1);
      ok('flow: stage widths are proportional to users within 1%', (f?.stages.length ?? 0) === selSeg.steps.length && widthBad.length === 0
        && JSON.stringify(users(f.stages)) === JSON.stringify(selSeg.steps.map((s) => s.users)),
        JSON.stringify((f?.stages ?? []).map((s, i) => [s.key, s.users, s.widthPct?.toFixed(2), ((selSeg.steps[i]?.users ?? 0) / max * 100).toFixed(2)])));
      ok('flow: one drop badge per link', (f?.links.length ?? 0) === selSeg.steps.length - 1 && f.links.every((l) => l.badges === 1), JSON.stringify(f?.links));
      const worstWant = fixtureDrops(selSeg.steps).worst;
      const worstShown = (f?.links ?? []).filter((l) => l.worst);
      ok('flow: the worst drop is marked as stepDrops computes it', worstShown.length === 1 && worstShown[0].key === worstWant && worstShown[0].worstWord !== '',
        `${JSON.stringify(worstShown)} want ${worstWant}`);
      await openTab(ex, 'Daily');

      // Trend: the slice's exact daily value at 2 dates (the preset's Daily page under the selection).
      const trendKey = (await xin(ex)).trend?.metrics.find((x) => x.on)?.key ?? 'visit_to_lead';
      for (const date of twoDates(selSeg.daily)) {
        const tip = await trendTipAt(ex, date);
        const want = selSeg.daily.find((d) => d.t === date)?.m[trendKey];
        ok(`trend: hover shows the slice's exact daily value (${date})`, shownEquals(tip.value, want), `${trendKey}: ${tip.detail} want ${want}`);
      }
      // The metric switch changes the series (the Daily card: the funnel level).
      const daily = card('x-daily');
      await daily.scrollIntoViewIfNeeded();
      const t1 = (await xin(daily)).trend;
      await daily.locator('[data-lab-trend-metric="conversion"]').first().click();
      await sleep(400);
      const t2 = (await xin(daily)).trend;
      const date = twoDates(quiz.daily)[1];
      const tip = await trendTipAt(daily, date);
      const want = quiz.daily.find((d) => d.t === date)?.m.conversion;
      const sws = [...await daily.evaluate(trendSwitchInPage), ...await ex.evaluate(trendSwitchInPage)];
      ok('trend: the Daily card and the preset Daily page never ellipsize a metric label', sws.length > 0 && sws.every((x) => !x.cut), JSON.stringify(sws.filter((x) => x.cut)));
      ok('trend: the metric switch changes the series', t1?.series !== 'conversion' && t2?.series === 'conversion' && t1?.paths !== t2?.paths && shownEquals(tip.value, want),
        `${t1?.series} -> ${t2?.series}; ${tip.detail} want ${want}`);

      // Segments (the plus card: language=EN, platforms as rows, the Unattributed x EN path under the low-sample line).
      await openBoard(XP);
      const plus = card('x-plus');
      await plus.scrollIntoViewIfNeeded();
      await selectChips(plus, { language: 'EN' });
      const s = (await xin(plus)).seg;
      const platforms = demo.data.funnel.dimensions.find((dm) => dm.key === 'platform').values.map((v) => v.value);
      const rowWrong = platforms.filter((p) => !shownEquals(s?.rows.find((r) => r.value === p)?.usersText, fixtureSegment(quiz, { platform: p, language: 'EN' })?.users));
      ok("segments: one row per platform under language=EN, each the intersection's own users", s?.rows.length === platforms.length && rowWrong.length === 0,
        `${JSON.stringify(s?.rows.map((r) => [r.value, r.usersText]))} wrong ${rowWrong}`);
      const toned = (s?.rows ?? []).flatMap((r) => Object.values(r.cells)).filter((c) => c.tone);
      const byTone = {};
      for (const c of toned) (byTone[c.tone] ??= new Set()).add(c.bg);
      const tones = Object.keys(byTone);
      ok('segments: band tones wash the cells (a tinted background per tone)', toned.length > 0 && toned.every((c) => !transparent(c.bg))
        && (tones.length < 2 || tones.every((t, i) => i === 0 || [...byTone[t]].every((bg) => !byTone[tones[0]].has(bg)))),
        JSON.stringify(Object.fromEntries(tones.map((t) => [t, [...byTone[t]]]))));
      const low = (s?.rows ?? []).filter((r) => r.low);
      const lowWant = platforms.filter((p) => (fixtureSegment(quiz, { platform: p, language: 'EN' })?.users ?? Infinity) < PLUS_LOW_SAMPLE);
      ok('segments: a low-sample row is faded, the others are not',
        JSON.stringify(low.map((r) => r.value)) === JSON.stringify(lowWant) && low.every((r) => r.opacity < 0.95) && s.rows.filter((r) => !r.low).every((r) => r.opacity > 0.99),
        JSON.stringify(s?.rows.map((r) => [r.value, r.low, r.opacity])));
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        const st = await plus.evaluate(segmentsTableInPage);
        ok(`segments: every band-tinted figure reads at >= 4.5:1 (${theme})`, !!st && st.tints.length > 0 && st.tints.every((x) => x.ratio !== null && x.ratio >= 4.5),
          `${st?.tints.length} tinted cells, lowest ${Math.min(...(st?.tints ?? []).map((x) => x.ratio ?? 0))}:1; failing ${JSON.stringify(st?.tints.filter((x) => !(x.ratio >= 4.5)).slice(0, 6))}`);
        ok(`segments: no word is broken mid-word (the plus card, ${theme})`, !!st && st.broken.length === 0, JSON.stringify(st?.broken.slice(0, 8)));
        await plus.evaluate((el) => { const w = el.querySelector('[data-lab-segments] .lab-table-wrap'); if (w) w.scrollLeft = 0; });
      }
      await setTheme('light');
      await explorerShotBoth('segments', (path) => plus.screenshot({ path }));
      const head = plus.locator('.board-card-block[data-lab-block="segments"] thead th[data-col="__users"] button').first();
      await head.click();
      await sleep(250);
      const s1 = (await xin(plus)).seg;
      await head.click();
      await sleep(250);
      const s2 = (await xin(plus)).seg;
      const u1 = s1.rows.map((r) => r.users);
      const u2 = s2.rows.map((r) => r.users);
      const sortedDesc = (a) => a.every((v, i) => i === 0 || a[i - 1] >= v);
      const sortedAsc = (a) => a.every((v, i) => i === 0 || a[i - 1] <= v);
      const st1 = s1.headers.find((h) => h.col === '__users')?.sort;
      const st2 = s2.headers.find((h) => h.col === '__users')?.sort;
      ok('segments: a header click sorts the rows, a second click flips the order',
        st1 !== 'none' && st2 !== 'none' && st1 !== st2 && ((sortedDesc(u1) && sortedAsc(u2)) || (sortedAsc(u1) && sortedDesc(u2))) && JSON.stringify(u1) !== JSON.stringify(u2),
        `${st1} ${JSON.stringify(u1)} / ${st2} ${JSON.stringify(u2)}`);
      await selectChips(plus, {});
    });

    // ── 27. Fullscreen ─────────────────────────────────────────────────────────
    await section('explorer: fullscreen', async () => {
      if (!explorerReady) throw new Error('the explorer board was not built');
      await closeOverlay();
      await openBoard(X);
      const ex = card('x-explorer');
      await ex.scrollIntoViewIfNeeded();
      await selectChips(ex, SEL);
      await openTab(ex, 'Steps');
      const overlay = page.locator('[data-lab-fullscreen]');
      const openFs = async (loc) => {
        await loc.scrollIntoViewIfNeeded();
        await loc.locator('[data-lab-card-menu]').first().click();
        await page.locator('[data-lab-card-fullscreen="open"]').first().click();
        await overlay.first().waitFor({ timeout: 6000 }).catch(() => {});
        await sleep(500);
      };
      await openFs(ex);
      const ov = page.locator('[data-lab-fullscreen="x-explorer"]');
      const geo = await ov.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight, role: el.getAttribute('role'), modal: el.getAttribute('aria-modal') };
      }).catch(() => null);
      ok('fullscreen opens from the card menu at >= 95% of the viewport (a modal dialog)',
        !!geo && geo.w >= geo.vw * 0.95 && geo.h >= geo.vh * 0.95 && geo.role === 'dialog' && geo.modal === 'true', JSON.stringify(geo));
      ok('fullscreen puts ?card=<id> in the address', new URL(page.url()).searchParams.get('card') === 'x-explorer', page.url());
      ok('fullscreen: the grid slot is an empty lifted box (one live copy)',
        await page.locator('[data-lab-card-lifted="x-explorer"]').count() === 1 && await ex.locator('[data-lab-block]').count() === 0);
      const fm = geo ? await xin(ov) : null;
      const fsBand = geo ? (await ov.evaluate(chipsAndBandInPage)).band : null;
      ok('fullscreen: the tabs start right under the chips (no blank band > 24px)', fsBand !== null && fsBand <= 24, `blank band ${fsBand}px`);
      ok('fullscreen keeps the breakdown selection', !!fm && JSON.stringify(pressed(fm)) === JSON.stringify(SEL), JSON.stringify(fm && pressed(fm)));
      ok('fullscreen keeps the active tab', geo !== null && await tabBtn(ov, 'Steps').getAttribute('aria-selected') === 'true');
      if (geo) {
        await explorerShotBoth('fullscreen', (path) => page.screenshot({ path }));
        await tabBtn(ov, 'Flow').click();
        await sleep(300);
      }
      await page.keyboard.press('Escape');
      await sleep(500);
      ok('fullscreen closes on Esc', await overlay.count() === 0);
      ok('closing fullscreen keeps the tab changed inside it', await tabBtn(ex, 'Flow').getAttribute('aria-selected') === 'true');
      await openFs(ex);
      await page.locator('[data-lab-card-exit]').first().click();
      await sleep(500);
      ok('fullscreen closes on its exit button', await overlay.count() === 0);
      await openFs(ex);
      const wasOpen = await overlay.count() === 1;
      await page.goBack();
      await sleep(700);
      ok('fullscreen closes on browser Back', wasOpen && await overlay.count() === 0 && !new URL(page.url()).searchParams.has('card'), page.url());
      const url = new URL(page.url());
      url.searchParams.set('card', 'x-explorer');
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      await page.locator('[data-lab-fullscreen="x-explorer"]').waitFor({ timeout: 20000 }).catch(() => {});
      ok('fullscreen reopens from ?card=<id>', await page.locator('[data-lab-fullscreen="x-explorer"]').count() === 1, page.url());
      if (await page.locator('[data-lab-card-exit]').count()) await page.locator('[data-lab-card-exit]').first().click();
      await sleep(500);
      // An app card: ONE iframe while fullscreen (the grid slot is lifted, never a second frame).
      const app = card('x-app');
      await openFs(app);
      const frames = await page.evaluate(() => ({
        overlay: document.querySelectorAll('[data-lab-fullscreen="x-app"] iframe').length,
        slot: document.querySelectorAll('[data-lab-card="x-app"] iframe').length,
      }));
      ok('fullscreen: an app card has exactly one iframe', frames.overlay === 1 && frames.slot === 0, JSON.stringify(frames));
      if (await page.locator('[data-lab-card-exit]').count()) await page.locator('[data-lab-card-exit]').first().click();
      await sleep(400);
    });

    // ── 28. The v1 app insight on a board; CLI parity; the preset both ways ────
    await section('explorer: app card, CLI parity, preset', async () => {
      if (!explorerReady) throw new Error('the explorer board was not built');
      await closeOverlay();
      await openBoard(X);
      const inFrame = async (loc) => {
        const h = await loc.locator('iframe').first().elementHandle({ timeout: 8000 }).catch(() => null);
        return h ? h.contentFrame() : null;
      };
      const framePage = async (loc) => {
        const f = await inFrame(loc);
        return f ? until(() => f.evaluate(() => document.getElementById('page')?.dataset.page ?? null), 8000) : null;
      };
      await openBoard(XP);
      const plain = card('x-app-plain');
      await plain.scrollIntoViewIfNeeded();
      const plainState = await plain.evaluate((el) => ({ nav: el.querySelectorAll('[data-lab-app-nav]').length, pills: el.querySelectorAll('[data-lab-app-pill]').length, frames: el.querySelectorAll('iframe').length }));
      const plainPage = await framePage(plain);
      ok("app card: nav:false keeps today's card (no pills, one frame, the app's card page)", plainState.nav === 0 && plainState.pills === 0 && plainState.frames === 1 && plainPage === 'overview',
        `${JSON.stringify(plainState)} page ${plainPage}`);
      const pinnedPage = await framePage(card('x-app-pinned'));
      ok('app card: the page option pins an app page', pinnedPage === 'pricing', String(pinnedPage));
      await openBoard(X);

      const app = card('x-app');
      await app.scrollIntoViewIfNeeded();
      const pills = await app.locator('[data-lab-app-pill]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-lab-app-pill'), e.getAttribute('aria-selected')]));
      ok('app card: nav:true shows one pill per page, the pinned page selected',
        JSON.stringify(pills) === JSON.stringify([['overview', 'true'], ['pricing', 'false'], ['activation', 'false']]), JSON.stringify(pills));
      const f0 = await inFrame(app);
      const first = await framePage(app);
      if (f0) await f0.evaluate(() => { window.__verifyMark = 'first-frame'; });
      await app.locator('[data-lab-app-pill="pricing"]').click();
      await until(async () => (await app.locator('[data-lab-app-nav]').getAttribute('data-lab-app-page')) === 'pricing', 5000);
      await sleep(400);
      const f1 = await inFrame(app);
      const second = await framePage(app);
      const fresh1 = f1 ? await f1.evaluate(() => window.__verifyMark === undefined).catch(() => false) : false;
      ok('app card: a pill click switches the page in the card (a fresh frame)', first === 'overview' && second === 'pricing' && fresh1,
        `${first} -> ${second}, fresh ${fresh1}`);
      await explorerShotBoth('app-page-2', (path) => app.screenshot({ path }));
      if (f1) await f1.evaluate(() => { window.__verifyMark = 'second-frame'; }).catch(() => {});
      // The page's own button calls lab.navigate('activation') (a real click inside the frame).
      let clickErr = null;
      if (f1) await f1.locator('#next').click({ timeout: 5000 }).catch((e) => { clickErr = String(e).split('\n').slice(0, 4).join(' | '); });
      await until(async () => (await app.locator('[data-lab-app-nav]').getAttribute('data-lab-app-page')) === 'activation', 5000);
      await sleep(400);
      const f2 = await inFrame(app);
      const third = await framePage(app);
      const fresh2 = f2 ? await f2.evaluate(() => window.__verifyMark === undefined).catch(() => false) : false;
      ok('app card: an in-frame lab.navigate switches the page in the card (a fresh frame)', third === 'activation' && fresh2,
        `${second} -> ${third}, fresh ${fresh2}${clickErr ? `; click: ${clickErr}` : ''}`);

      // CLI parity: the preset card under SEL, DOM vs `lab board show --select`.
      const ex = card('x-explorer');
      await ex.scrollIntoViewIfNeeded();
      await selectChips(ex, SEL);
      await openTab(ex, 'Benchmark');
      const domBench = (await xin(ex)).bench;
      await openTab(ex, 'Steps');
      const domSteps = await xin(ex);
      await openTab(ex, 'Platform');
      const domSeg = (await xin(ex)).seg;
      const selArg = Object.entries(SEL).map(([k, v]) => `${k}=${v}`).join(',');
      const view = JSON.parse(dc(['lab', 'board', 'show', X, '--select', selArg, '--json']));
      const cliBlocks = view.cards.find((c) => c.id === 'x-explorer')?.blocks ?? [];
      const cliOf = (tab) => cliBlocks.find((b) => b.tab === tab)?.explorer ?? null;
      const cb = cliOf('Benchmark');
      const benchPairs = (cb?.rows ?? []).map((r) => [r.key, r.status, domBench.find((d) => d.key === r.key)]);
      ok('CLI parity: --select benchmark rows equal the DOM',
        benchPairs.length === domBench.length && benchPairs.length > 0
          && benchPairs.every(([k, st, d]) => d && d.status === st && (d.value === null ? cb.rows.find((r) => r.key === k).current === null : shownEquals(d.value, cb.rows.find((r) => r.key === k).current))),
        JSON.stringify(benchPairs.map(([k, st, d]) => [k, st, d?.status, d?.value, cb.rows.find((r) => r.key === k)?.current])));
      const cs = cliOf('Steps');
      ok('CLI parity: --select step users equal the DOM', JSON.stringify((cs?.slice?.steps ?? []).map((s) => s.users)) === JSON.stringify(domSteps.bars.map((b) => b.users)),
        `${JSON.stringify(cs?.slice?.steps?.map((s) => s.users))} vs ${JSON.stringify(domSteps.bars.map((b) => b.users))}`);
      const cliWorst = cs?.drops?.find((d) => d.worst)?.key ?? null;
      const domWorst = quiz.steps.find((s) => s.label === domSteps.bars.find((b) => b.worst)?.label)?.key ?? null;
      ok('CLI parity: --select worst step equals the DOM', cliWorst !== null && cliWorst === domWorst, `${cliWorst} vs ${domWorst}`);
      const cg = cliOf('Platform');
      const segPairs = (cg?.rows ?? []).map((r, i) => [r, domSeg?.rows[i]]);
      ok('CLI parity: --select segment rows equal the DOM',
        segPairs.length > 0 && segPairs.length === (domSeg?.rows.length ?? -1)
          && segPairs.every(([c, d]) => d && c.value === d.value && (c.measured ? shownEquals(d.usersText, c.users) : d.users === null)),
        `${JSON.stringify(cg?.rows?.map((r) => [r.value, r.users, r.measured]))} vs ${JSON.stringify(domSeg?.rows.map((r) => [r.value, r.usersText]))}`);
      await openTab(ex, 'Daily');

      // The preset from the dashboard's add-card menu deep-equals the CLI's.
      dc(['lab', 'board', 'create', 'explorer-ui', '--title', 'Explorer from the menu']);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-lab-board]').first().waitFor({ timeout: 20000 });
      await openBoard('explorer-ui');
      await editMode(true);
      const opener = page.locator('[data-lab-add-card-open], [data-lab-add-first-card]').first();
      await opener.click();
      const menu = page.locator('[data-lab-add-card]').first();
      await menu.waitFor({ timeout: 6000 });
      await menu.locator('[data-lab-field="bind-to"]').selectOption(EXPLORER);
      const presetBtn = menu.locator('[data-lab-add-preset="funnel-explorer"]').first();
      await presetBtn.waitFor({ timeout: 8000 }).catch(() => {});
      const offered = await presetBtn.count() === 1;
      ok('the add-card menu offers the Funnel explorer preset for a funnel insight', offered);
      if (offered) await presetBtn.click();
      const made = await until(() => (readBoard('explorer-ui')?.cards ?? []).length === 1, 8000);
      const ui = readBoard('explorer-ui')?.cards?.[0];
      const cli = fileCard(X, 'x-explorer');
      ok('preset: the dashboard add-card entry and lab board add-card --preset write deep-equal blocks',
        !!made && JSON.stringify((ui?.blocks ?? []).map(normBlock)) === JSON.stringify((cli?.blocks ?? []).map(normBlock))
          && ui.at.w === cli.at.w && ui.at.h === cli.at.h && ui.insight === cli.insight,
        `ui ${JSON.stringify(ui).slice(0, 400)} | cli ${JSON.stringify(cli).slice(0, 400)}`);
      await page.keyboard.press('Escape');
      await editMode(false);
    });

    // ── 14. Defects: heading text, tab labels ─────────────────────────────────
    await section('defects: headings + tabs', async () => {
      const found = [];
      for (const b of derivedList?.boards ?? []) {
        await openBoard(b.slug);
        found.push(...(await page.locator('[data-lab-board]').first().evaluate(headingsInPage)).map((h) => ({ ...h, board: b.slug })));
      }
      const bad = found.filter((h) => !h.text);
      ok('every h-* heading card shows its heading text', found.length >= 4 && bad.length === 0,
        `${found.length} heading cards; blank or unpainted: ${JSON.stringify(bad)}`);
      for (const [board, id] of [['fit', 'm-tabs'], ['catalog', 'c-tabs']]) {
        await openBoard(board);
        await card(id).scrollIntoViewIfNeeded();
        await sleep(300);
        const tabs = await card(id).evaluate(tabsInPage);
        const wrong = (tabs ?? []).filter((x) => !x.inBar || !x.inButton || x.clipped);
        ok(`tabs: every tab label lies inside its button and the tab bar (${id})`, tabs && tabs.length >= 2 && wrong.length === 0, JSON.stringify(wrong.length ? wrong : tabs));
      }
    });

    // ── 10. Sidebar + prefs ────────────────────────────────────────────────────
    await section('sidebar + prefs', async () => {
      const title = await page.locator('.sidebar-item[title^="Insights"]').first().getAttribute('title');
      ok('sidebar shows Insights as Beta', title === 'Insights (Beta)', title);
      await openBoard('catalog');
      await sleep(1500);
      const prefs = JSON.parse(readFileSync(PREFS, 'utf-8'));
      for (const key of Object.keys(LEGACY_PREFS)) {
        ok(`.lab-prefs.json keeps ${key}`, JSON.stringify(prefs[key]) === JSON.stringify(LEGACY_PREFS[key]), `${JSON.stringify(prefs[key])} vs ${JSON.stringify(LEGACY_PREFS[key])}`);
      }
      ok('.lab-prefs.json gains activeBoard (the board in use)', prefs.activeBoard === 'catalog', JSON.stringify(prefs.activeBoard));
    });

    // ── 9. Empty state click-through ───────────────────────────────────────────
    await section('empty state', async () => {
      await gotoInsights('empty');
      const cta = page.locator('[data-lab-create-first-board]').first();
      await cta.waitFor({ timeout: 15000 });
      await shoot('empty-state');
      await cta.click();
      await sleep(400);
      const input = page.locator('[data-lab-board-form] input').first();
      if (await input.count()) {
        await input.fill('First board');
        await input.press('Enter');
      }
      const dir = join(EMPTY, '_dream_context', 'lab', 'boards');
      const made = await until(() => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.md')), 6000);
      ok('the empty-state CTA creates a board on disk', made, existsSync(dir) ? readdirSync(dir).join(',') : 'no lab/boards');
      ok('the new board opens', await until(async () => (await page.locator('[data-lab-board]').count()) > 0, 5000));
    });

    if (bundle) {
      ok(`mutation ${MUTATION} was applied to the served bundle`, bundlePatched > 0 && pairHits.every((n) => n > 0),
        `patched assets ${bundlePatched}; hits per pattern ${JSON.stringify(pairHits)}`);
    }
    const pageErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver loop|net::ERR_ABORTED|Failed to load resource/i.test(e));
    if (pageErrors.length) console.log(`console errors (informational):\n  ${pageErrors.slice(0, 12).join('\n  ')}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  // The measured value behind every passing demo-finding check (a PASS line alone does not show it).
  const MEASURED = /board GET|active chip|blank band|benchmark:|lanes:|flow \(|breakdown \(|trend \(|trend:|segments/;
  console.log('\nmeasured (passing demo-finding checks):');
  for (const r of results) if (r.pass && MEASURED.test(r.name) && r.measured) console.log(`  ${r.name} — ${r.measured.slice(0, 260)}`);
  console.log(`shots: ${SHOTS}`);
  const fails = results.filter((r) => !r.pass);
  if (!MUTATION) {
    console.log(fails.length ? `${fails.length} FAILED of ${results.length}` : `all ${results.length} green`);
    process.exit(fails.length ? 1 : 0);
  }
  const expected = MUTATIONS[MUTATION];
  const caught = expected.filter((n) => fails.some((f) => f.name === n));
  const missed = expected.filter((n) => !caught.includes(n));
  console.log(`\nmutation ${MUTATION}: expected to fail ${expected.length}, caught ${caught.length}`);
  for (const n of missed) console.log(`  NOT CAUGHT: ${n}`);
  process.exit(missed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
