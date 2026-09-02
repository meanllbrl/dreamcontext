#!/usr/bin/env node
/**
 * The dreamcontext Reports template + window honesty — runtime proof.
 *
 *   npm run build && npm run verify:lab-report-template
 *
 * Boots the REAL dashboard server on an isolated scratch vault and proves,
 * in a real Chromium, what the unit suite pins only structurally:
 *
 *   1. the report page wears the dreamcontext identity: masthead (mark +
 *      logotype + REPORTS kicker), gradient rule, title block, meta chips,
 *      and the signing footer;
 *   2. window inheritance: an aligned item wears the report's 7-day chip, a
 *      pinned item keeps (and shows) its 30-day window, a manual tile says
 *      "own", and the genuinely mixed section wears the warning strip;
 *   3. the date navigator IS the window: a past week RE-MEASURES (an echo
 *      script whose value = the measured window's year proves it), and Live
 *      restores the current window;
 *   4. section prose renders its inline markdown (**bold** → <strong>,
 *      `code` → <code>) instead of literal asterisks;
 *   5. stat items PACK: two number cards share a row instead of stacking;
 *   6. AI commentary generates only on an explicit Analyze click (fake
 *      claude binary via DREAMCONTEXT_CLAUDE_BIN) and renders labelled;
 *   7. the template holds in BOTH themes (screenshots for eyeballing).
 *
 * Same harness contract as the other verify scripts: real server, isolated
 * fake HOME, COLLECT-DON'T-FAIL-FAST reporting. Screenshots land in
 * <scratch>/shots.
 */

import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-report-template');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45751;
const CLI = join(REPO, 'dist', 'index.js');
const LAB = join(PROJ, '_dream_context', 'lab');

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);

function dc(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  }).toString();
}

const SERIES = (v) => `export default async function (ctx) {
  return [{ name: 'metric', points: [{ t: '2026-08-30', v: ${v} }, { t: '2026-08-31', v: ${v + 1} }] }];
}`;

/** ECHOES the measured window: value = the YEAR of the window's end. Live →
 *  the current year; a navigated past week → THAT year. The value changing
 *  with the date navigator is the proof that the report truly re-measured. */
const ECHO_YEAR = `export default async function (ctx) {
  const { fromISO, toISO } = ctx.resolvedTweaks.range;
  return [{ name: 'metric', points: [{ t: toISO, v: Number(toISO.slice(0, 4)) }] }];
}`;

const MATRIX_SCRIPT = `export default async function (ctx) {
  return {
    kind: 'matrix/v1',
    dims: [{ key: 'funnel', label: 'Funnel' }, { key: 'language', label: 'Language' }],
    rows: [
      { d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200 },
      { d: { funnel: 'F3000', language: 'EN' }, v: 84000, n: 3100 },
    ],
    total: { v: 203000, n: 7300 },
  };
}`;

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  // A fake `claude` for the commentary run — the layer under test is the
  // report surface, not the model. Slightly slow so the "writing…" state is
  // observable.
  writeFileSync(join(SCRATCH, 'fake-claude'), [
    '#!/bin/sh',
    'sleep 1',
    'echo "**Okuma:** harcama sabitken CAC dustu — kreatif tarafi bu hafta verimli."',
    'echo ""',
    'echo "## 1 · Scorecard"',
    'echo "Skor tablosunda tek risk pROAS: hala olculmuyor."',
  ].join('\n'), 'utf-8');
  chmodSync(join(SCRATCH, 'fake-claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'), JSON.stringify({ github: { token: 'gho_fake_verify_token', login: 'verify-user' } }));
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort — lab only needs lab/ */ }

  mkdirSync(join(LAB, 'scripts'), { recursive: true });
  const seeds = [
    ['spend-7d', 'Ad spend (7d)', 'number', ECHO_YEAR],
    ['cac-30d', 'CAC', 'number', SERIES(280)],
    ['proas-nowin', 'pROAS', 'number', SERIES(3)],
    ['upsell-breakdown', 'Upsell breakdown', 'breakdown', MATRIX_SCRIPT],
  ];
  for (const [slug, title, render] of seeds) {
    dc(['lab', 'create', slug, '--title', title, '--render', render, '--adapter', 'script', '--group', 'Verify']);
  }
  for (const [slug, , , script] of seeds) {
    writeFileSync(join(LAB, 'scripts', `${slug}.mjs`), `${script}\n`, 'utf-8');
  }
  // spend-7d matches the weekly report's inherited 7-day window (aligned);
  // cac-30d keeps a 30-day tweak AND is pinned in the report (visible pin).
  dc(['lab', 'tweak', 'spend-7d', 'range', 'last_7_days']);
  dc(['lab', 'tweak', 'cac-30d', 'range', 'last_30_days']);
  dc(['lab', 'sync', '--all']);

  // proas-nowin becomes a MANUAL tile (no source) — it cannot re-measure a
  // window, and the surface must say so instead of pretending.
  const proasPath = join(LAB, 'insights', 'proas-nowin.md');
  const proas = readFileSync(proasPath, 'utf-8').replace(/^source:[\s\S]*?(?=^[a-z_]+:|\n---)/m, '');
  writeFileSync(proasPath, proas, 'utf-8');

  dc([
    'lab', 'report', 'create', 'weekly-marketing',
    '--title', 'Weekly Marketing Report',
    '--description', 'The week: spend, CAC and the upsell split.',
    '--date-nav', 'weekly',
    '--insights', 'spend-7d,cac-30d,proas-nowin,upsell-breakdown',
  ]);
  // Hand-write the manifest: prose with inline markdown + a pinned item.
  const reportPath = join(LAB, 'reports', 'weekly-marketing.md');
  const manifest = [
    '---',
    'title: Weekly Marketing Report',
    'description: "The week: spend, CAC and the upsell split."',
    'date_nav: weekly',
    'sections:',
    '  - title: 1 · Scorecard',
    '    prose: >-',
    '      Window is **7 DAYS** — the one exception is `proas-nowin`, which declares none.',
    '    items:',
    '      - insight: spend-7d',
    '      - insight: cac-30d',
    '        window: last_30_days',
    '      - insight: proas-nowin',
    '  - title: 2 · Upsell split',
    '    items:',
    '      - insight: upsell-breakdown',
    '---',
    '## Notes',
    '',
    'Read **spend before CAC** — see `docs`.',
  ].join('\n');
  writeFileSync(reportPath, manifest, 'utf-8');
}

async function waitForServer(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  setup();
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ,
    env: {
      ...process.env,
      HOME,
      DREAMCONTEXT_DESKTOP: '1',
      DREAMCONTEXT_CLAUDE_BIN: join(SCRATCH, 'fake-claude'),
    },
    stdio: 'ignore',
  });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/lab`);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    const shoot = async (name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

    await page.goto(`http://127.0.0.1:${PORT}/lab/reports/weekly-marketing?vault=proj`, { waitUntil: 'networkidle' });
    if (await page.locator('.announcements-modal-scrim').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.waitForSelector('.report-sheet', { timeout: 15000 });
    // Let the scoped sync job settle so items leave their skeletons.
    await page.waitForTimeout(2500);
    await shoot('report-light');

    const sheet = page.locator('.report-sheet');

    // ── 1. the dreamcontext identity ─────────────────────────────────────
    ok('masthead logotype says dreamcontext',
      (await page.locator('.report-logotype').innerText()) === 'dreamcontext');
    ok('masthead kicker says Reports',
      (await page.locator('.report-kicker').innerText()).toLowerCase() === 'reports');
    ok('the gradient rule renders', await page.locator('.report-rule').count() === 1);
    ok('the title block renders', (await page.locator('.report-title').innerText()).includes('Weekly Marketing Report'));
    ok('meta chips: Live data + counts',
      (await page.locator('.report-metaline').innerText()).includes('Live data')
      && (await page.locator('.report-metaline').innerText()).includes('2 sections'));
    ok('the footer signs the document',
      (await page.locator('.report-foot').innerText()).includes('Generated with dreamcontext Reports'));

    // ── 2. window honesty + inheritance (live) ────────────────────────────
    // Wait out the live window job (upsell-breakdown's canonical window is the
    // engine default, so its 7-day target needs a transient measurement).
    await page.waitForTimeout(4000);
    const sheetText = await sheet.innerText();
    ok('an aligned 7-day item wears its window chip', /7-day · /.test(sheetText));
    ok('the PINNED item keeps its 30-day window', /30-day · /.test(sheetText));
    ok('the manual tile says it keeps its own window',
      sheetText.includes('own · no declared window'));
    const warn = page.locator('.report-mix-warn');
    ok('the genuinely mixed section wears the warning strip', await warn.count() === 1);
    ok('the warning names the windows',
      (await warn.first().innerText()).includes('7-day') && (await warn.first().innerText()).includes('30-day'));
    ok('the inherited section carries NO warning',
      !(await page.locator('.report-section', { hasText: 'Upsell split' }).first().locator('.report-mix-warn').count()));
    ok('the echo item measured the LIVE window (value = current year)',
      sheetText.includes('2,026'));

    // ── 3. prose inline markdown ──────────────────────────────────────────
    const prose = page.locator('.report-section-prose').first();
    ok('prose renders **bold** as <strong>', await prose.locator('strong', { hasText: '7 DAYS' }).count() === 1);
    ok('prose renders `code` as <code>', await prose.locator('code', { hasText: 'proas-nowin' }).count() === 1);
    ok('no literal asterisks leak', !(await prose.innerText()).includes('**'));
    const notes = page.locator('.report-notes');
    ok('notes render inline markdown too', await notes.locator('strong').count() >= 1);

    // ── 4. stat items pack into a row ─────────────────────────────────────
    const statBoxes = await page.locator('.report-item--stat').evaluateAll(
      (els) => els.map((el) => el.getBoundingClientRect()),
    );
    ok('three stat cards render', statBoxes.length === 3);
    const sameRow = statBoxes.length >= 2 && Math.abs(statBoxes[0].top - statBoxes[1].top) < 4;
    ok('stat cards share a row (grid, not a stack)', sameRow,
      `tops: ${statBoxes.map((b) => Math.round(b.top)).join(', ')}`);
    ok('the breakdown item runs full-width',
      await page.locator('.report-item:not(.report-item--stat) table').count() >= 1);
    ok('items carry the as-of stamp', (sheetText.match(/as of /g) ?? []).length >= 4);

    // ── 5. the date navigator IS the window: a past week RE-MEASURES ──────
    await page.locator('input[aria-label="Window end"]').fill('2020-01-06');
    await page.waitForTimeout(6000); // window sync job for the past week
    const datedText = await sheet.innerText();
    ok('the past week re-measured: the echo value is THAT year, not a snapshot',
      datedText.includes('2,020'), datedText.slice(0, 400));
    ok('the re-measured chip wears the selected week', /7-day · Dec 3[01] – Jan 6/.test(datedText));
    ok('the pinned item re-anchored its 30-day window at the selected date',
      /30-day · Dec [0-9]+ – Jan 6/.test(datedText));
    // The manual tile cannot re-measure; with no snapshot that far back it
    // shows the honest empty (never a substituted window), not a chip.
    ok('the manual tile stays honest on a past date (own chip or the no-snapshot empty)',
      datedText.includes('own ·') || datedText.includes('No snapshot at or before 2020-01-06'));
    await shoot('report-past-week');
    await page.locator('.report-page button', { hasText: 'Live' }).click();
    await page.waitForTimeout(2500);
    ok('back to Live: the echo value returns to the current year',
      (await sheet.innerText()).includes('2,026'));

    // ── 6. AI commentary: explicit click, labelled output ─────────────────
    const panel = page.locator('.report-commentary');
    ok('the commentary panel offers Analyze (nothing generated without a click)',
      (await panel.innerText()).includes('Analyze')
      && (await panel.innerText()).includes('No commentary for this view yet'));
    await panel.locator('button', { hasText: 'Analyze' }).click();
    await page.waitForTimeout(4500); // fake model sleeps 1s + poll interval
    const panelText = await panel.innerText();
    ok('the OVERALL reading renders in the top panel', panelText.includes('kreatif tarafi bu hafta verimli'));
    ok('the panel does NOT swallow the section note', !panelText.includes('Skor tablosunda tek risk'));
    ok('the section note renders INSIDE its section', await page
      .locator('.report-section', { hasText: 'Scorecard' }).first()
      .locator('.report-ai-note', { hasText: 'Skor tablosunda tek risk' }).count() === 1);
    ok('the commentary is labelled AI-generated with its model', /AI-generated · \w+/.test(panelText));
    ok('the Analyze button becomes Regenerate', panelText.includes('Regenerate'));
    await shoot('report-commentary');

    // ── 6b. free custom range: [from] → [to] in the navigator ─────────────
    await page.locator('input[aria-label="Window start"]').fill('2024-03-01');
    await page.waitForTimeout(500);
    await page.locator('input[aria-label="Window end"]').fill('2024-03-15');
    await page.waitForTimeout(6000); // window sync for the custom range
    const customText = await sheet.innerText();
    ok('the custom range re-measured (echo value = 2024)', customText.includes('2,024'), customText.slice(0, 300));
    ok('the custom range chip wears the exact span', customText.includes('14-day window'));
    ok('the pinned item still holds its 30-day pin under a custom range',
      /30-day · Feb .* – Mar 15/.test(customText));
    await shoot('report-custom-range');

    // Quick presets: picking "Last 30 days" sets the range in one move.
    await page.locator('select[aria-label="Window preset"]').selectOption('30');
    await page.waitForTimeout(6000);
    const presetText = await sheet.innerText();
    ok('the Last-30-days preset applies the range in one move', presetText.includes('30-day window'));
    ok('the preset re-measured the echo item over 30 days', /30-day · /.test(presetText));
    await page.locator('.report-page button', { hasText: 'Live' }).click();
    await page.waitForTimeout(2500);
    ok('Live clears the custom range', (await sheet.innerText()).includes('2,026'));

    // ── 7. the dark theme ─────────────────────────────────────────────────
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'dark'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.report-sheet', { timeout: 15000 });
    await page.waitForTimeout(1500);
    ok('dark theme: the sheet still renders the masthead',
      (await page.locator('.report-logotype').innerText()) === 'dreamcontext');
    await shoot('report-dark');

    await browser.close();
  } finally {
    server.kill();
  }

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Shots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
