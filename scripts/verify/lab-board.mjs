#!/usr/bin/env node
/**
 * Insights board redesign (08-08) — end-to-end UI verification.
 *
 *   npm run build && npm run verify:lab-board
 *
 * Boots the REAL dashboard server on an isolated scratch vault (fake HOME, no
 * user state touched, no network — every seeded insight is backed by a local
 * `lab/scripts/*.mjs`), then drives the board with Playwright and proves the
 * redesign contract:
 *
 *   1. a MIXED board renders every registry render — number (with sparkline),
 *      line, pie (<7 series), pie with ≥7 series (the bar degrade), bar,
 *      bar_compare, stacked, table, heatmap, funnel;
 *   2. the SIZE-AWARE grid: funnel/table span 2 columns and a `size: l` card
 *      does too, everything else spans 1, no card overflows its own box — and
 *      under the narrow breakpoint the wide cards degrade to 1 column instead
 *      of pushing the board sideways;
 *   3. RangeControl on a card chains PATCH → sync (#235): the preset persists to
 *      the MANIFEST FILE and the tile re-renders with data from the new window;
 *      a deliberately failing source reports the failure honestly instead of
 *      claiming success;
 *   4. RangeControl custom from→to on the funnel overview writes the URL params
 *      and the page's data-window label follows;
 *   5. every tweak surface shows HUMAN labels — no `last_7_days` in any visible
 *      text — and the tweak editor no longer competes with the range control;
 *   6. the funnel overview's COLUMN PICKER: a derived step-conversion column can
 *      be switched on, computes a plausible %, sorts, writes the `cols` URL param,
 *      survives a reload on that URL, and Reset returns to the default set.
 *
 * Same harness contract as the other verify scripts: real server, isolated fake
 * HOME, COLLECT-DON'T-FAIL-FAST reporting. Screenshots (both themes) land in
 * <scratch>/shots for eyeballing.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-lab-board');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45743;
const CLI = join(REPO, 'dist', 'index.js');
const LAB = join(PROJ, '_dream_context', 'lab');

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);

function dc(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  }).toString();
}

/** The window-walking preamble every seeded script shares: real data for the
 *  window the engine resolved, so a range change visibly changes the tile. */
const DAYS_HELPER = `
function days(ctx) {
  const { fromISO, toISO } = ctx.resolvedTweaks.range;
  const out = [];
  for (let d = new Date(\`\${fromISO}T00:00:00Z\`); d <= new Date(\`\${toISO}T00:00:00Z\`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
`;

/** slug → { title, render, size, unit, script }. One card per registry render,
 *  plus the two the redesign added rules for (a ≥7-slice pie, a `size: l`). */
const INSIGHTS = [
  {
    slug: 'signups', title: 'Signups', render: 'number', unit: 'users',
    // Value = day index, so the LATEST value is the window's length: a range
    // change is visible in the tile without inventing a fake data source.
    script: `${DAYS_HELPER}
export default async function (ctx) {
  return [{ name: 'signups', points: days(ctx).map((t, i) => ({ t, v: i + 1 })) }];
}`,
  },
  {
    slug: 'sessions', title: 'Sessions', render: 'line', unit: 'sessions',
    tweaks: [
      { key: 'cohort', type: 'enum', options: ['new_users', 'returning_users'], default: 'new_users' },
    ],
    script: `${DAYS_HELPER}
export default async function (ctx) {
  return ['web', 'ios', 'android'].map((name, s) => ({
    name,
    points: days(ctx).map((t, i) => ({ t, v: 40 + s * 25 + ((i * (s + 3)) % 17) })),
  }));
}`,
  },
  {
    slug: 'traffic-mix', title: 'Traffic mix', render: 'pie', unit: 'visits',
    script: `${DAYS_HELPER}
export default async function (ctx) {
  const ts = days(ctx);
  return [['organic', 900], ['direct', 520], ['referral', 260], ['social', 130]].map(([name, base]) => ({
    name, points: ts.map((t, i) => ({ t, v: base + i })),
  }));
}`,
  },
  {
    slug: 'browser-share', title: 'Browser share', render: 'pie', unit: 'users',
    script: `${DAYS_HELPER}
export default async function (ctx) {
  const ts = days(ctx);
  const names = ['chrome', 'safari', 'firefox', 'edge', 'opera', 'brave', 'vivaldi', 'other'];
  return names.map((name, s) => ({ name, points: ts.map((t, i) => ({ t, v: 800 - s * 90 + i })) }));
}`,
  },
  {
    slug: 'revenue-by-plan', title: 'Revenue by plan', render: 'bar', unit: 'usd',
    script: `${DAYS_HELPER}
export default async function (ctx) {
  const ts = days(ctx);
  return [['team', 4200], ['pro', 2600], ['starter', 1100], ['trial', 300]].map(([name, base]) => ({
    name, points: ts.map((t, i) => ({ t, v: base + i * 3 })),
  }));
}`,
  },
  {
    slug: 'weekly-compare', title: 'Weekly compare', render: 'bar_compare', unit: 'runs',
    script: `${DAYS_HELPER}
export default async function (ctx) {
  const ts = days(ctx);
  return ['builds', 'deploys', 'rollbacks'].map((name, s) => ({
    name, points: ts.map((t, i) => ({ t, v: 60 - s * 18 + ((i * (s + 2)) % 11) })),
  }));
}`,
  },
  {
    slug: 'channel-stack', title: 'Channel stack', render: 'stacked', unit: 'events',
    script: `${DAYS_HELPER}
export default async function (ctx) {
  const ts = days(ctx);
  return ['email', 'push', 'in_app'].map((name, s) => ({
    name, points: ts.map((t, i) => ({ t, v: 30 + s * 12 + ((i * (s + 1)) % 9) })),
  }));
}`,
  },
  {
    slug: 'metric-table', title: 'Metric table', render: 'table', unit: 'events',
    script: `${DAYS_HELPER}
export default async function (ctx) {
  const ts = days(ctx);
  const names = ['recall', 'sleep', 'sync', 'lab', 'council', 'automations'];
  return names.map((name, s) => ({ name, points: ts.map((t, i) => ({ t, v: 500 - s * 60 + i * (s + 1) })) }));
}`,
  },
  {
    slug: 'daily-heat', title: 'Daily heat', render: 'heatmap', unit: 'commits',
    script: `${DAYS_HELPER}
export default async function (ctx) {
  return [{
    name: 'commits',
    points: days(ctx).map((t) => {
      const wd = new Date(\`\${t}T00:00:00Z\`).getUTCDay();
      return { t, v: wd === 0 || wd === 6 ? 1 : wd * 4 };
    }),
  }];
}`,
  },
  {
    slug: 'wide-number', title: 'Wide number', render: 'number', size: 'l', unit: 'mrr',
    script: `${DAYS_HELPER}
export default async function (ctx) {
  return [{ name: 'mrr', points: days(ctx).map((t, i) => ({ t, v: 12000 + i * 40 })) }];
}`,
  },
  {
    slug: 'activation-funnels', title: 'Activation funnels', render: 'funnel',
    script: `export default async function (ctx) {
  const { fromISO, toISO } = ctx.resolvedTweaks.range;
  void fromISO; void toISO;
  const funnel = (id, name, users, mid, done, spend) => ({
    id, name,
    meta: { url: \`https://example.com/f/\${id}\` },
    metrics: {
      users: { v: users, format: 'count' },
      spend: { v: spend, format: 'usd' },
      finish_rate: { v: Math.round((done / users) * 1000) / 10, format: 'pct' },
    },
    steps: [
      { key: 'session_start', label: 'Session start', users },
      { key: 'email_input', label: 'Email input', users: mid },
      { key: 'finish', label: 'Finish', users: done },
    ],
  });
  return {
    kind: 'funnel-set/v1',
    dimensions: [{ key: 'language', label: 'Language', mode: 'client' }],
    primary: 'users',
    funnels: [
      funnel('516', 'en-start-516', 1240, 640, 210, 831),
      funnel('517', 'tr-start-517', 880, 402, 96, 512),
      funnel('518', 'de-start-518', 460, 190, 61, 244),
    ],
  };
}`,
  },
  {
    slug: 'broken-metric', title: 'Broken metric', render: 'number', unit: 'rows',
    // The honest-toast fixture: a source that always fails, so a range change
    // has to report "saved, but the refresh failed" instead of "applied".
    script: `export default async function () {
  throw new Error('upstream rejected the query (verify fixture)');
}`,
  },
];

/** Replace `tweaks: []` in a manifest with declared knobs (the CLI only sets
 *  VALUES; a declaration is an authoring act, which is a file edit). */
function declareTweaks(slug, tweaks) {
  const path = join(LAB, 'insights', `${slug}.md`);
  const yaml = tweaks.map((t) => [
    `  - key: ${t.key}`,
    `    type: ${t.type}`,
    ...(t.options ? ['    options:', ...t.options.map((o) => `      - ${o}`)] : []),
    ...(t.default ? [`    default: ${t.default}`] : []),
  ].join('\n')).join('\n');
  const source = readFileSync(path, 'utf-8');
  if (!source.includes('tweaks: []')) throw new Error(`${slug}: no empty tweaks block to declare into`);
  writeFileSync(path, source.replace('tweaks: []', `tweaks:\n${yaml}`), 'utf-8');
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'), JSON.stringify({ github: { token: 'gho_fake_verify_token', login: 'verify-user' } }));
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/some-code-repo.git'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort — lab only needs lab/ */ }

  mkdirSync(join(LAB, 'scripts'), { recursive: true });
  for (const insight of INSIGHTS) {
    dc([
      'lab', 'create', insight.slug,
      '--title', insight.title,
      '--render', insight.render,
      '--adapter', 'script',
      '--group', 'Mixed renders',
      ...(insight.unit ? ['--unit', insight.unit] : []),
      ...(insight.size ? ['--size', insight.size] : []),
    ]);
    writeFileSync(join(LAB, 'scripts', `${insight.slug}.mjs`), `${insight.script}\n`, 'utf-8');
    if (insight.tweaks) declareTweaks(insight.slug, insight.tweaks);
  }
  // One failing insight makes the whole run exit non-zero — that IS the fixture.
  try { dc(['lab', 'sync', '--all']); } catch { /* broken-metric is meant to fail */ }
}

/** The manifest's stored value for one tweak key ('' when unset) — the on-disk
 *  proof that a UI range change persisted. */
function manifestTweak(slug, key) {
  const source = readFileSync(join(LAB, 'insights', `${slug}.md`), 'utf-8');
  const block = new RegExp(`- key: ${key}\\n(?:\\s+.*\\n)*?\\s+value: (.*)`).exec(source);
  return block ? block[1].trim().replace(/^'|'$/g, '') : '';
}

async function waitForServer(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

/** The card for one insight title. */
const cardOf = (page, title) => page.locator('.lab-card', { hasText: title }).first();

/** The derived step-conversion column the picker scenario switches on — labelled
 *  from the fixture's own step labels, never an invented translation. */
const CONV_HEADER = 'Session start → Email input %';

/** How many board columns this card actually occupies, measured (the grid's
 *  span is a container query — computed style would only report `span 2`). */
async function spanOf(page, title, unitWidth) {
  const box = await cardOf(page, title).boundingBox();
  return Math.round(box.width / unitWidth);
}

async function main() {
  setup();
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/lab`);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const setTheme = async (t) => { await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t); await page.waitForTimeout(150); };
    const shoot = async (name) => {
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), fullPage: true });
      }
      await setTheme('light');
    };

    await page.goto(`http://127.0.0.1:${PORT}/?vault=proj`, { waitUntil: 'networkidle' });
    if (await page.locator('.announcements-modal-scrim').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.getByText('Insights', { exact: true }).first().click();
    await page.waitForTimeout(1200);

    // ── 1. mixed board: every render draws its own body ────────────────────
    ok('board renders one card per seeded insight', await page.locator('.lab-card').count() === INSIGHTS.length,
      `${await page.locator('.lab-card').count()} cards`);

    const bodies = [
      ['number card draws the value + inline sparkline', 'Signups', 'svg[aria-label="Trend"]'],
      ['line render draws a line chart', 'Sessions', 'svg[aria-label="Line chart"]'],
      ['pie render draws a pie under 7 slices', 'Traffic mix', 'svg[aria-label="Pie chart"]'],
      ['bar render draws the shared bar list', 'Revenue by plan', '[aria-label="Share by series"]'],
      ['bar_compare draws grouped bars', 'Weekly compare', 'svg[aria-label="Grouped bar chart"]'],
      ['stacked draws stacked bars', 'Channel stack', 'svg[aria-label="Stacked bar chart"]'],
      ['funnel card draws the overview preview table', 'Activation funnels', 'table.funnel-preview'],
    ];
    for (const [name, title, selector] of bodies) {
      ok(name, await cardOf(page, title).locator(selector).count() > 0);
    }
    ok('table render draws the metric table (sortable headers)',
      await cardOf(page, 'Metric table').locator('th button', { hasText: 'Latest' }).count() > 0
      && await cardOf(page, 'Metric table').locator('th button', { hasText: 'Δ' }).count() > 0);
    ok('heatmap render draws dated day cells',
      await cardOf(page, 'Daily heat').locator('div[title*="-"][title*=":"]').count() >= 20);

    // The degrade rule: 8 series is past the ≥7 threshold, so the pie IS a bar list.
    const wide = cardOf(page, 'Browser share');
    ok('a pie with ≥7 series degrades to the bar list', await wide.locator('[aria-label="Share by series"]').count() > 0);
    ok('the degraded pie draws no pie at all', await wide.locator('svg[aria-label="Pie chart"]').count() === 0);
    ok('the degraded card caps its rows (top 5 + "+k more")',
      /\+3 more/.test(await wide.innerText()), await wide.innerText());

    // ── 2. size-aware grid ─────────────────────────────────────────────────
    const unit = (await cardOf(page, 'Signups').boundingBox()).width;
    const spans = {};
    for (const title of ['Signups', 'Sessions', 'Traffic mix', 'Browser share', 'Revenue by plan',
      'Weekly compare', 'Channel stack', 'Daily heat', 'Metric table', 'Wide number', 'Activation funnels']) {
      spans[title] = await spanOf(page, title, unit);
    }
    ok('funnel card spans 2 columns on a wide viewport', spans['Activation funnels'] === 2, JSON.stringify(spans));
    ok('table card spans 2 columns (its registry default)', spans['Metric table'] === 2, JSON.stringify(spans));
    ok('a `size: l` manifest override spans 2 columns', spans['Wide number'] === 2, JSON.stringify(spans));
    const singles = ['Signups', 'Sessions', 'Traffic mix', 'Browser share', 'Revenue by plan', 'Weekly compare', 'Channel stack', 'Daily heat'];
    ok('every other card spans 1 column', singles.every((t) => spans[t] === 1), JSON.stringify(spans));

    // The body is the scroll container (`overflow: auto`), so IT is where a chart
    // that is too wide for its column shows up — the card box itself would never
    // report the overflow it clips.
    const overflow = await page.$$eval('.lab-card', (cards) => cards
      .filter((c) => {
        const body = c.querySelector('.lab-card-body');
        return body && body.scrollWidth > body.clientWidth + 1;
      })
      .map((c) => c.querySelector('.lab-card-title')?.textContent ?? '?'));
    ok('no card body overflows horizontally (funnel preview included)', overflow.length === 0, overflow.join(', '));
    const boardOverflow = await page.$eval('.lab-board', (b) => b.scrollWidth > b.clientWidth + 1);
    ok('the board itself never scrolls sideways', boardOverflow === false);
    await shoot('board');

    // Narrow: the wide span must DEGRADE, not force an implicit second column.
    await page.setViewportSize({ width: 720, height: 1000 });
    await page.waitForTimeout(500);
    const narrowUnit = (await cardOf(page, 'Signups').boundingBox()).width;
    ok('under the narrow breakpoint the funnel card drops to 1 column',
      await spanOf(page, 'Activation funnels', narrowUnit) === 1);
    const narrowOverflow = await page.$$eval('.lab-card', (cards) => cards
      .filter((c) => {
        const body = c.querySelector('.lab-card-body');
        return body && body.scrollWidth > body.clientWidth + 1;
      })
      .map((c) => c.querySelector('.lab-card-title')?.textContent ?? '?'));
    ok('no card overflows at the narrow breakpoint either', narrowOverflow.length === 0, narrowOverflow.join(', '));
    await page.screenshot({ path: join(SHOTS, 'board-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(400);

    // ── 3. humanized labels (no raw manifest key ever reaches the UI) ───────
    await cardOf(page, 'Sessions').locator('.lab-card-tweaks-toggle').click();
    await page.waitForTimeout(250);
    const optionText = await cardOf(page, 'Sessions').locator('select option').allInnerTexts();
    ok('enum tweak options render as human labels', optionText.join('|') === 'New Users|Returning Users', optionText.join('|'));
    const editorKeys = await cardOf(page, 'Sessions').locator('.lab-card-tweaks').innerText();
    ok('the tweak editor no longer competes with the range control (no range/from/to)',
      !/Date range|From|To\b/.test(editorKeys), editorKeys.replace(/\n/g, ' / '));
    const visible = await page.locator('.lab-board').innerText();
    ok('no raw relative-range key is visible anywhere on the board',
      !/last_\d+_(day|week|month|year)s?/.test(visible),
      (visible.match(/last_\d+_\w+/g) ?? []).join(', '));
    ok('the range chip shows the humanized window', /Last 30 days/.test(visible));
    await cardOf(page, 'Sessions').locator('.lab-card-tweaks-toggle').click();

    // ── 4. RangeControl on a card: PATCH → sync, persisted to the manifest ──
    const signups = cardOf(page, 'Signups');
    const before = await signups.locator('.lab-card-body').innerText();
    await signups.locator('.lab-range-chip').click();
    await page.waitForTimeout(300);
    await page.locator('.lab-range-pop-presets .lab-range-pill', { hasText: 'Last 7 days' }).first().click();
    await page.waitForTimeout(2500);
    const toast = await page.locator('.lab-toast').count() ? await page.locator('.lab-toast').innerText() : '';
    ok('picking a preset reports it applied', /applied/i.test(toast), toast);
    ok('the preset persisted to the manifest FILE', manifestTweak('signups', 'range') === 'last_7_days', manifestTweak('signups', 'range'));
    const after = await signups.locator('.lab-card-body').innerText();
    ok('the tile re-rendered on the new window (data follows the control)', after !== before, `${before} → ${after}`);
    ok('the chip now reads the new window', /Last 7 days/.test(await signups.innerText()));

    // The same chain on a source that FAILS must say so, not claim success.
    const broken = cardOf(page, 'Broken metric');
    await broken.locator('.lab-range-chip').click();
    await page.waitForTimeout(300);
    await page.locator('.lab-range-pop-presets .lab-range-pill', { hasText: 'Last 7 days' }).first().click();
    await page.waitForTimeout(2500);
    const failToast = await page.locator('.lab-toast').count() ? await page.locator('.lab-toast').innerText() : '';
    ok('a failing source reports the refresh failure honestly', /refresh failed/i.test(failToast), failToast);
    ok('the failure names the underlying cause', /verify fixture/.test(failToast), failToast);
    ok('the tweak still persisted even though the sync failed',
      manifestTweak('broken-metric', 'range') === 'last_7_days', manifestTweak('broken-metric', 'range'));

    // ── 5. funnel overview: custom from→to, URL params, window label ────────
    await cardOf(page, 'Activation funnels').click();
    await page.waitForTimeout(1200);
    ok('the funnel card routes to its overview page', /\/lab\/activation-funnels/.test(page.url()), page.url());
    ok('the overview shows every funnel row', await page.locator('.funnel-ovw table tbody tr').count() >= 3);
    const windowBefore = await page.locator('.funnel-ovw-window').innerText();
    ok('the overview states its data window', /\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/.test(windowBefore), windowBefore);

    await page.locator('.funnel-ovw-toolbar .lab-range-pill', { hasText: 'Custom' }).click();
    await page.waitForTimeout(300);
    const day = (n) => page.locator('.lab-range-cal-day:not(.lab-range-cal-day--outside)', { hasText: new RegExp(`^${n}$`) }).first();
    await day(10).click();
    await day(20).click();
    await page.locator('.lab-range-pop-apply').click();
    await page.waitForTimeout(2500);
    const params = new URL(page.url()).searchParams;
    ok('a custom window writes from/to into the URL', !!params.get('from') && !!params.get('to'), page.url());
    ok('a custom window clears the preset param', params.get('range') === null, page.url());
    const windowAfter = await page.locator('.funnel-ovw-window').innerText();
    ok('the window label follows the picked dates',
      windowAfter.includes(params.get('from')) && windowAfter.includes(params.get('to')), `${windowAfter} vs ${params}`);
    ok('the custom window persisted to the manifest FILE',
      manifestTweak('activation-funnels', 'from') === params.get('from')
      && manifestTweak('activation-funnels', 'to') === params.get('to'),
      `${manifestTweak('activation-funnels', 'from')} → ${manifestTweak('activation-funnels', 'to')}`);
    ok('no raw range key leaks into the funnel page either',
      !/last_\d+_(day|week|month|year)s?/.test(await page.locator('.funnel-ovw').innerText()));
    await shoot('funnel-overview');

    // ── 6. funnel overview: the column picker (derived step columns) ────────
    const headers = () => page.locator('.funnel-ovw-table thead th');
    const headerCount = await headers().count();
    ok('the overview starts on the payload metric columns only',
      await page.locator('.funnel-ovw-table thead th', { hasText: CONV_HEADER }).count() === 0);

    await page.locator('.funnel-ovw-colbtn').click();
    await page.waitForTimeout(300);
    const picker = page.locator('.funnel-ovw-colpick');
    // Group headings are uppercased by CSS — match the words, not the casing.
    const pickerText = await picker.innerText();
    ok('the columns popover groups metric and derived columns',
      /Metrics/i.test(pickerText) && /Step conversion/i.test(pickerText) && /% of top/i.test(pickerText),
      pickerText.replace(/\n/g, ' / '));

    await picker.locator('.funnel-ovw-colpick-row', { hasText: CONV_HEADER }).click();
    await page.waitForTimeout(400);
    ok('enabling a derived column adds its header to the table',
      await page.locator('.funnel-ovw-table thead th', { hasText: CONV_HEADER }).count() === 1);
    ok('the table gained exactly one column', await headers().count() === headerCount + 1);
    const tableText = await page.locator('.funnel-ovw-table').innerText();
    // 640 of 1240 users reach email_input on funnel 516 — the honest number.
    ok('the derived column shows the computed conversion %', tableText.includes('51.6%'), tableText.replace(/\n/g, ' / '));
    ok('the derived column\'s URL param is written', /(^|&)cols=/.test(new URL(page.url()).search), page.url());
    ok('the cols param carries the derived key',
      (new URL(page.url()).searchParams.get('cols') ?? '').includes('session_start'),
      new URL(page.url()).searchParams.get('cols') ?? '');

    // Sort by the derived column: the sorted order must be the RATES' order.
    await page.locator('.funnel-ovw-table thead th', { hasText: CONV_HEADER }).locator('button').click();
    await page.waitForTimeout(300);
    const firstRow = await page.locator('.funnel-ovw-table tbody tr').first().innerText();
    ok('sorting on the derived column ranks by its rate (516 leads at 51.6%)',
      firstRow.includes('51.6%'), firstRow.replace(/\n/g, ' / '));

    await page.keyboard.press('Escape');
    // `networkidle` never settles here (the board polls) — wait for the table itself.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.funnel-ovw-table').waitFor({ timeout: 20000 });
    await page.waitForTimeout(600);
    ok('a reload on the same URL keeps the derived column visible',
      await page.locator('.funnel-ovw-table thead th', { hasText: CONV_HEADER }).count() === 1, page.url());
    await shoot('funnel-columns');

    await page.locator('.funnel-ovw-colbtn').click();
    await page.waitForTimeout(300);
    await page.locator('.funnel-ovw-colpick-reset').click();
    await page.waitForTimeout(400);
    ok('Reset returns the table to the default column set',
      await page.locator('.funnel-ovw-table thead th', { hasText: CONV_HEADER }).count() === 0
      && await headers().count() === headerCount);
    ok('Reset clears the cols URL param (no param = no opinion)',
      new URL(page.url()).searchParams.get('cols') === null, page.url());

    await browser.close();
  } finally {
    server.kill();
  }

  console.log(results.join('\n'));
  console.log(`shots: ${SHOTS}`);
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(fails.length ? `${fails.length} FAILED` : `all ${results.length} green`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
