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
 * Same harness contract as the other verify scripts: real server, isolated
 * fake HOME, COLLECT-DON'T-FAIL-FAST (every section runs and reports; a
 * thrown section is one FAIL line, not an abort). Screenshots, both themes,
 * land in <scratch>/shots.
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

/** name -> the assertion names that MUST fail under it. */
const MUTATIONS = {
  'sidebar-alpha': ['sidebar shows Insights as Beta'],
  'put-lies': ['first UI edit materializes every derived board', 'drag persists to the board file', 'resize persists to the board file'],
  'symlink-follow': ['board GET: symlinked cache yields no data', 'board GET: the symlinked html input is an empty frame', 'lab board show: symlinked cache yields no data', 'html block: symlinked input yields no data'],
  'filter-syncs': ['filter clicks send ZERO sync requests'],
  'placeholder-slot': ['no data-lab-placeholder element (inspector open)'],
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
    const shoot = async (name) => {
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), fullPage: true });
      }
      await setTheme('light');
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
      // Coverage: every catalog option has a case (or a dedicated section).
      for (const entry of catalog) {
        for (const o of entry.options) {
          const covered = OPTION_CASES.some(([ty, , variant]) => ty === entry.type && o.key in variant) || (COVERED_ELSEWHERE[entry.type] ?? []).includes(o.key);
          ok(`catalog option ${entry.type}.${o.key} has a verify case`, covered);
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
