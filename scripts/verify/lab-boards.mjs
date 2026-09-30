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
 *                     "hover truth" datum check.
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
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { webkit } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-lab-boards');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const EMPTY = join(SCRATCH, 'empty');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45817;
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

const MUTATION = (process.argv.find((a) => a.startsWith('--mutation=')) ?? '').slice('--mutation='.length) || null;
/** A second home for the screenshots (the owner's review folder). A mutation run never writes there. */
const SHOTS_OUT = MUTATION ? null : ((process.argv.find((a) => a.startsWith('--shots=')) ?? '').slice('--shots='.length) || null);

/** name -> the assertion names that MUST fail under it. */
const MUTATIONS = {
  'sidebar-alpha': ['sidebar shows Insights as Beta'],
  'put-lies': ['first UI edit materializes every derived board', 'drag persists to the board file', 'resize persists to the board file'],
  'symlink-follow': ['board GET: symlinked cache yields no data', 'board GET: the symlinked html input is an empty frame', 'lab board show: symlinked cache yields no data', 'html block: symlinked input yields no data'],
  'filter-syncs': ['filter clicks send ZERO sync requests'],
  'placeholder-slot': ['no data-lab-placeholder element (inspector open)'],
  'chart-overflow': ['line (small) fits its cell, no inner scroll', 'line (large) fits its cell, no inner scroll',
    'bar (small) fits its cell, no inner scroll', 'bar (large) fits its cell, no inner scroll',
    'pie (small) fits its cell, no inner scroll', 'pie (large) fits its cell, no inner scroll'],
  'hover-offset': ['hover truth: line (narrow) 2026-09-19', 'hover truth: line (narrow) 2026-09-22', 'hover truth: line (narrow) 2026-09-26',
    'hover truth: line (wide) 2026-09-19', 'hover truth: line (wide) 2026-09-22', 'hover truth: line (wide) 2026-09-26',
    'hover truth: bar (narrow) south', 'hover truth: bar (narrow) east', 'hover truth: bar (narrow) west',
    'hover truth: bar (wide) south', 'hover truth: bar (wide) east', 'hover truth: bar (wide) west'],
  'repaint-by-rank': ["color follows the entity: a filter chip keeps the surviving slice's color",
    "color follows the entity: a series pick keeps ios's stroke"],
  'heading-hidden': ['every h-* heading card shows its heading text'],
  'tab-clip': ['tabs: every tab label lies inside its button and the tab bar (m-tabs)'],
  'ticks-overlap': ['axis tick labels never overlap: line (large)'],
  'sticky-lost': ['table: the sticky header stays at the top after scrolling'],
};
if (MUTATION && !MUTATIONS[MUTATION]) {
  console.error(`unknown mutation "${MUTATION}"; known: ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail: cond ? '' : String(detail) });
  return !!cond;
};
/** Run one section; a throw is ONE failure line, never an abort. */
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(`${name} (section threw)`, false, (e && e.stack) ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dc(args, { cwd = PROJ, allowFail = false } = {}) {
  try {
    return execFileSync('node', [ENTRY, ...args], {
      cwd, env: { ...process.env, HOME, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (e) {
    if (allowFail) return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    throw new Error(`dreamcontext ${args.join(' ')} failed: ${e.stderr ?? e.message}`);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
const INLINE_HTML = `<div class="dc-card" id="kit"><div class="dc-card-title">Plans by kit</div><span class="dc-chip" id="chip">kit</span></div>
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

/** Bundle (JS asset) string mutations: [regex, replacement]. */
const BUNDLE_MUTATIONS = {
  'sidebar-alpha': [/(labelKey:"nav\.labpage",maturity:)"beta"/, '$1"alpha"'],
  'filter-syncs': [/(className:"lab-block-chip",)/g, '$1onMouseDown:()=>fetch("/api/lab/sync-jobs",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),'],
  'placeholder-slot': [/("data-lab-inspector":!0)/, '$1,"data-lab-placeholder":!0'],
  // hover.ts nearestIndex: `return x - positions[lo] <= positions[hi] - x ? lo : hi` answers one index later.
  'hover-offset': [/return (\w+)-(\w+)\[(\w+)\]<=\2\[(\w+)\]-\1\?\3:\4\}/, 'return Math.min($2.length-1,($1-$2[$3]<=$2[$4]-$1?$3:$4)+1)}'],
  // LineChart.tsx entityDomain(domain, names): the unfiltered domain is ignored, colours follow the drawn rank.
  'repaint-by-rank': [/function (\w+)\((\w+),(\w+)\)\{if\(!\2\|\|\2\.length===0\)return\[\.\.\.\3\];/, 'function $1($2,$3){return[...$3];'],
};

/** Stylesheet mutations: a rule appended to the served CSS bundle. */
const CSS_MUTATIONS = {
  'chart-overflow': '.lab-chart-plot{flex:none!important;min-height:calc(100% + 48px)!important;min-width:calc(100% + 48px)!important}',
  'heading-hidden': '.board-card--heading .board-card-block{visibility:hidden!important}',
  'tab-clip': '.lab-block-tab{height:10px!important;min-height:0!important;padding-top:0!important;padding-bottom:0!important;overflow:hidden!important}',
  'ticks-overlap': '.lab-chart-tick{font-size:40px!important}',
  'sticky-lost': '.lab-table-head th{position:static!important}',
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

/** The chart types that must fit their cell, each at a large and a small size: [type, block options]. */
const FIT_CASES = [
  ['line', { data: 'trend' }],
  ['stacked', { data: 'trend' }],
  ['bar', { data: 'regions', orientation: 'v' }],
  ['pie', { data: 'regions' }],
  ['heatmap', { data: 'grid2', cellLabels: true }],
  ['stat', { data: 'big-trend', series: ['enterprise'], spark: true, delta: 'prev', goal: 150000 }],
  ['funnel', { data: 'funnels' }],
];
const FIT_SIZES = { large: { w: 8, h: 6 }, small: { w: 3, h: 3 } };

function fitBoardSpec() {
  const cards = [];
  let y = 0;
  for (const [type, opts] of FIT_CASES) {
    const { data, ...rest } = opts;
    const block = { [type]: { data, ...rest } };
    cards.push({ id: `m-${type}-large`, title: `${type} large`, at: { x: 0, y, ...FIT_SIZES.large }, blocks: [block] });
    cards.push({ id: `m-${type}-small`, title: `${type} small`, at: { x: 8, y, ...FIT_SIZES.small }, blocks: [block] });
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
    // The What's New modal can open at any point after load; dismiss it whenever it covers an action.
    await page.addLocatorHandler(page.locator('.announcements-modal-scrim'), async () => {
      const gotIt = page.getByRole('button', { name: /^got it$/i });
      if (await gotIt.count()) await gotIt.first().click();
      else await page.keyboard.press('Escape');
    });
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    const bundle = BUNDLE_MUTATIONS[MUTATION];
    let bundlePatched = 0;
    if (bundle) {
      await page.route(/\/assets\/.*\.js(\?.*)?$/, async (route) => {
        const res = await route.fetch();
        const body = await res.text();
        const next = body.replace(bundle[0], bundle[1]);
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
    /**
     * Both themes. The board scrolls inside the app shell (a fullPage shot is just
     * the viewport), so the viewport grows to the board's height for the shot.
     */
    const shoot = async (name) => {
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
        await saveShot(`${name}-${theme}.png`, (path) => page.screenshot({ path }));
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
        ok(`control: ${b.id} and its twin render identically`, twin === baseSig[b.id], 'signature is unstable; option comparisons for this type are meaningless');
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
      const kit = frame && await frame.evaluate(() => {
        const k = getComputedStyle(document.getElementById('kit'));
        const p = getComputedStyle(document.getElementById('plain'));
        return { kitPad: k.paddingTop, kitBorder: k.borderTopWidth, plainPad: p.paddingTop, chipBg: getComputedStyle(document.getElementById('chip')).backgroundColor };
      });
      ok('the dc- kit applies inside the html block', kit && kit.kitPad === '14px' && kit.kitBorder === '1px' && kit.plainPad === '0px', JSON.stringify(kit));
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
        dc(['lab', 'create', ins.slug, '--title', ins.title, '--render', ins.render, '--adapter', 'script']);
        writeFileSync(join(LAB, 'scripts', `${ins.slug}.mjs`), `${ins.script}\n`, 'utf-8');
        dc(['lab', 'sync', ins.slug, '--force'], { allowFail: true });
        ok(`chart fixture ${ins.slug} synced`, existsSync(join(LAB, 'cache', `${ins.slug}.json`)));
      }
      const boards = [...optionBoards.map((b) => [b.slug, b.spec]), ['fit', fitBoardSpec()], ['hover', hoverBoardSpec()]];
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
      for (const [type] of FIT_CASES) {
        for (const size of Object.keys(FIT_SIZES)) {
          const id = `m-${type}-${size}`;
          await card(id).scrollIntoViewIfNeeded();
          await sleep(150);
          const m = await card(id).evaluate(measureCardInPage);
          ok(`${type} (${size}) fits its cell, no inner scroll`, m.scroll.length === 0, `${m.size.join('x')}: ${m.scroll.join(' | ')}`);
          ok(`axis tick labels never overlap: ${type} (${size})`, m.overlaps.length === 0, m.overlaps.join(' | '));
          ok(`chart labels stay inside the card: ${type} (${size})`, m.outside.length === 0, m.outside.slice(0, 6).join(' | '));
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

    if (bundle) ok(`mutation ${MUTATION} was applied to the served bundle`, bundlePatched > 0, 'pattern not found in any JS asset');
    const pageErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver loop|net::ERR_ABORTED|Failed to load resource/i.test(e));
    if (pageErrors.length) console.log(`console errors (informational):\n  ${pageErrors.slice(0, 12).join('\n  ')}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
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
