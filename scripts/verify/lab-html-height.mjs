#!/usr/bin/env node
/**
 * html/v1 AUTOMATIC HEIGHT — end-to-end UI verification.
 *
 *   npm run build && npm run verify:lab-html-height
 *
 * The defect this pins (owner report via peer project, 2026-09-08): the
 * reference promises every body author that "height is automatic … no fixed
 * card size to fight", and `app/v1` delivered it — but `html/v1` was drawn at a
 * hard-coded 232px (420px in the detail panel). A body taller than the box fell
 * into the iframe's own scrollbar, and the author's only lever was to shrink the
 * type until it fit — which means overriding the very typography scale the kit
 * exists to provide. A layout defect no string assertion can see: the markup is
 * valid, every class is defined, nothing errors, and the reader just cannot read
 * it. Only a real browser is a witness.
 *
 * Three fixtures, one per case the clamp has to get right:
 *   short  (~64px of content)  → floors at the CARD minimum, not the old 232px
 *   medium (~250px)            → grows to fit exactly, no inner scrollbar
 *   tall   (~700px)            → CAPS at the card maximum (the board grid's
 *                                bound, not the author's) and reads IN FULL in
 *                                the detail panel
 *
 * Same harness contract as the other verify scripts: real server, isolated fake
 * HOME, no network, COLLECT-DON'T-FAIL-FAST. Screenshots (both themes) land in
 * <scratch>/shots.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-lab-html-height');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45751;
const CLI = join(REPO, 'dist', 'index.js');
const LAB = join(PROJ, '_dream_context', 'lab');

/** The clamp under test — must stay in step with HtmlInsightBody.tsx and
 *  LabAppFrame.tsx (tests/unit/lab-html-body.test.ts pins them equal). */
const CARD_MIN = 120;
const CARD_MAX = 320;

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);

function dc(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  }).toString();
}

/** A body of `rows` kit-classed bar rows — real content at the kit's own type
 *  scale, which is the whole point: nothing here is shrunk to fit. */
const body = (rows) => `'<div class="lk-title">Rows</div>' + ${JSON.stringify(
  Array.from({ length: 40 }, (_, i) => i),
)}.slice(0, ${rows}).map(function (i) {
    return '<div class="lk-bar"><span class="lk-bar-label">row ' + i + '</span>'
      + '<span class="lk-bar-track"><span class="lk-bar-fill" style="width:' + (20 + i * 2) + '%"></span></span>'
      + '<span class="lk-bar-value">' + (100 + i) + '</span></div>';
  }).join('')`;

const INSIGHTS = [
  { slug: 'html-short', title: 'Height Short', rows: 2, expect: 'floor' },
  { slug: 'html-medium', title: 'Height Medium', rows: 10, expect: 'fits' },
  { slug: 'html-tall', title: 'Height Tall', rows: 34, expect: 'caps' },
];

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* lab/ is all this needs */ }

  mkdirSync(join(LAB, 'scripts'), { recursive: true });
  for (const insight of INSIGHTS) {
    dc(['lab', 'create', insight.slug, '--title', insight.title,
      '--render', 'line', '--adapter', 'script', '--group', 'Height']);
    // `{ data, html }` — data MANDATORY, exactly as a bare return.
    writeFileSync(join(LAB, 'scripts', `${insight.slug}.mjs`), `export default async function () {
  return {
    data: [{ name: 'rows', points: [{ t: '2026-09-01', v: ${insight.rows} }, { t: '2026-09-02', v: ${insight.rows + 1} }] }],
    html: ${body(insight.rows)},
  };
}
`, 'utf-8');
  }
  dc(['lab', 'sync', '--all']);
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

/** The rendered height of a body iframe, and the height of the DOCUMENT inside
 *  it — the pair is what proves "fits" rather than "is some number". Content
 *  height is read through the frame's own document, which the harness may do
 *  and the page may not (that is what the sandbox is for). */
async function inner(frameEl) {
  return (await frameEl.elementHandle()).contentFrame();
}

async function measure(frameEl) {
  const box = await frameEl.boundingBox();
  const content = await (await inner(frameEl)).evaluate(
    () => Math.ceil(document.body.getBoundingClientRect().height),
  );
  return { frame: Math.round(box.height), content };
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
    const shoot = async (name) => {
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), fullPage: true });
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    };

    await page.goto(`http://127.0.0.1:${PORT}/?vault=proj`, { waitUntil: 'networkidle' });
    if (await page.locator('.announcements-modal-scrim').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.getByText('Insights', { exact: true }).first().click();
    await page.locator('.lab-html-body').first().waitFor({ timeout: 20000 });
    // The bridge posts on parse; the retry beat covers a message that raced it.
    await page.waitForTimeout(1500);

    ok('every html/v1 card drew its sandboxed body',
      await page.locator('.lab-html-body').count() === INSIGHTS.length);

    const measured = {};
    for (const insight of INSIGHTS) {
      const frame = cardOf(page, insight.title).locator('.lab-html-body');
      measured[insight.slug] = await measure(frame);
    }
    await shoot('cards');

    // The regression itself: 232px for everything, whatever the content was.
    ok('no card is stuck at the old hard-coded 232px',
      Object.values(measured).every((m) => m.frame !== 232),
      JSON.stringify(measured));

    // 1. SHORT — floors at the card minimum instead of leaving 170px of void.
    const short = measured['html-short'];
    ok('a short body floors at the card MINIMUM, not the old fixed box',
      short.frame === CARD_MIN, JSON.stringify(short));

    // 2. MEDIUM — the promise, literally: the frame IS the content height.
    const medium = measured['html-medium'];
    ok('a medium body gets EXACTLY its content height (± the 1px rounding)',
      Math.abs(medium.frame - medium.content) <= 1 && medium.frame > CARD_MIN && medium.frame < CARD_MAX,
      JSON.stringify(medium));
    ok('and therefore has NO scrollbar of its own',
      await (await inner(cardOf(page, 'Height Medium').locator('.lab-html-body')))
        .evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1));

    // 3. TALL — capped, because the cap belongs to the BOARD, not the author.
    const tall = measured['html-tall'];
    ok('a tall body CAPS at the card maximum (the grid\'s bound, documented)',
      tall.frame === CARD_MAX && tall.content > CARD_MAX, JSON.stringify(tall));
    ok('a tall card does not deform the board (it stays within one grid row)',
      (await cardOf(page, 'Height Tall').boundingBox()).height
        <= (await cardOf(page, 'Height Short').boundingBox()).height + CARD_MAX,
      'a capped card must not stretch its row past the cap');

    // 4. DETAIL — where a long body is actually READ: effectively unbounded.
    // The TITLE, not the card centre: the body is an iframe, and a sandboxed
    // frame consumes the pointer event rather than letting it reach the card.
    await cardOf(page, 'Height Tall').locator('.lab-card-title').click();
    await page.locator('.idp-panel').waitFor({ timeout: 20000 });
    await page.locator('.idp-chart .lab-html-body').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    const detail = await measure(page.locator('.idp-chart .lab-html-body').first());
    await shoot('detail-tall');
    ok('the detail panel gives the SAME body its full content height',
      Math.abs(detail.frame - detail.content) <= 1 && detail.frame > CARD_MAX,
      JSON.stringify(detail));
    ok('so nothing is clipped where the body is read (no inner scrollbar)',
      await (await inner(page.locator('.idp-chart .lab-html-body').first()))
        .evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
      JSON.stringify(detail));
    ok('the typed data TWIN is still there next to it (a11y, unchanged)',
      await page.locator('.idp-panel .idp-chart').count() >= 2);

    await browser.close();
  } catch (error) {
    // COLLECT-DON'T-FAIL-FAST: a harness break must still print what passed.
    ok(`harness reached the end without throwing`, false, String(error).split('\n')[0]);
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
