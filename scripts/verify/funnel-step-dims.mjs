#!/usr/bin/env node
/**
 * A funnel step measured only in SOME breakdowns (`steps[].dims`), end to end in
 * the real dashboard and the real CLI.
 *
 *   npm run build && npm run verify:funnel-step-dims
 *   node scripts/verify/funnel-step-dims.mjs --shots=<dir>      (also copy the screenshots there)
 *
 * Acme Messenger (synthetic): a landing button, then a chat. The landing click
 * carries the language and the source but no channel (the chat app is picked
 * after it), so the step declares `dims: ["language", "source"]`. Under a
 * Channel filter that step is NOT MEASURED: it reads "not measured" with its
 * reason, never 0, the next step has no drop rate from it, and the biggest drop
 * is never landing -> chat. Under a Language filter it keeps its real count.
 *
 * Follows the funnel-explorer conventions: the REAL server from dist/ on an
 * isolated scratch vault under the OS temp dir, a fake HOME (no user state
 * touched), every CLI call through dist/index.js, WebKit (the engine the desktop
 * app ships). Two explorer cards (English, and `--locale tr`), then the funnel
 * detail page (the step lane + its table), each with Channel and with Language.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
const SHOTS_OUT = shotsArg ? resolve(shotsArg.slice('--shots='.length)) : null;

const SCRATCH = join(tmpdir(), 'dreamcontext-verify-funnel-step-dims');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 46231;
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');

const EN = 'acme-chat';
const TR = 'acme-chat-tr';
const BOARD = 'acme-chat';
const CATEGORY = 'Acme Chat';
const FUNNEL = 'messenger';
const cardIdOf = (slug) => `c-${slug}`;

// ─── The snapshot ────────────────────────────────────────────────────────────

const WINDOW = { from: '2026-09-07', to: '2026-10-04' };
const DIMENSIONS = [
  { key: 'language', label: 'Language', mode: 'client', values: [{ value: 'EN' }, { value: 'RU' }] },
  { key: 'source', label: 'Source', mode: 'client', values: [{ value: 'ads' }, { value: 'organic' }] },
  { key: 'channel', label: 'Channel', mode: 'client', values: [{ value: 'telegram' }, { value: 'whatsapp' }] },
];
/** Landing clicks: language x source only. Chat steps: language x source x channel. */
const CELLS = [
  { dims: { language: 'EN', source: 'ads' }, users: 500, steps: [{ key: 'clicked', users: 500 }] },
  { dims: { language: 'EN', source: 'organic' }, users: 200, steps: [{ key: 'clicked', users: 200 }] },
  { dims: { language: 'RU', source: 'ads' }, users: 300, steps: [{ key: 'clicked', users: 300 }] },
  { dims: { language: 'EN', source: 'ads', channel: 'telegram' }, users: 250, steps: [{ key: 'chat_started', users: 250 }, { key: 'first_reply', users: 120 }] },
  { dims: { language: 'EN', source: 'ads', channel: 'whatsapp' }, users: 150, steps: [{ key: 'chat_started', users: 150 }, { key: 'first_reply', users: 80 }] },
  { dims: { language: 'EN', source: 'organic', channel: 'telegram' }, users: 100, steps: [{ key: 'chat_started', users: 100 }, { key: 'first_reply', users: 50 }] },
  { dims: { language: 'RU', source: 'ads', channel: 'telegram' }, users: 100, steps: [{ key: 'chat_started', users: 100 }, { key: 'first_reply', users: 50 }] },
];
const DATA = {
  kind: 'funnel-set/v1',
  low_sample_threshold: 30,
  dimensions: DIMENSIONS,
  window: WINDOW,
  provenance: { source: 'Acme product analytics (synthetic fixture)', pulled_at: '2026-10-05T08:00:00Z', freshness: 'daily' },
  funnels: [{
    id: FUNNEL,
    name: 'Acme Messenger: landing to chat',
    metrics: {},
    steps: [
      { key: 'clicked', label: 'Landing button', users: 1000, dims: ['language', 'source'] },
      { key: 'chat_started', label: 'Chat started', users: 600 },
      { key: 'first_reply', label: 'First reply', users: 300 },
    ],
    segments: CELLS,
  }],
};
const FILTERS = [
  { field: 'product', op: '=', value: 'acme-messenger', source: 'request' },
  { field: 'event_date', op: 'between', values: [WINDOW.from, WINDOW.to], source: 'request' },
];
const SNAPSHOT = {
  source: {
    vault: 'acme',
    chart: 'chart-acme-chat',
    chart_name: 'Acme chat funnel',
    queries: [{ chart: 'chart-acme-chat', chart_name: 'Acme chat funnel', dims: ['language', 'source', 'channel'], applied_filters: FILTERS, freshness: 'daily' }],
    applied_filters: FILTERS,
    freshness: 'daily',
    pulled_at: '2026-10-05T08:00:00Z',
    via: 'synthetic fixture',
  },
  data: DATA,
};

// ─── Report ──────────────────────────────────────────────────────────────────

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail: pass ? '' : String(detail).slice(0, 900) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* retry */ }
    await sleep(step);
  }
  return last;
}
function run(args, { cwd = PROJ } = {}) {
  const r = spawnSync('node', [CLI, ...args], { cwd, env: { ...process.env, HOME, NO_COLOR: '1', FORCE_COLOR: '0' }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function dc(args, opts) {
  const r = run(args, opts);
  if (r.code !== 0) throw new Error(`dreamcontext ${args.join(' ')} exited ${r.code}: ${r.out.slice(0, 600)}`);
  return r.out;
}

// ─── In-page reader: what the step rows SHOW (data-* only locate them) ──────────

function stepsInPage(root) {
  const visible = (el) => {
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const text = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
  return {
    rows: [...root.querySelectorAll('[data-lab-step]')].filter(visible).map((r) => ({
      key: r.getAttribute('data-lab-step'),
      measured: r.getAttribute('data-measured') !== 'false',
      users: r.hasAttribute('data-users') ? Number(r.getAttribute('data-users')) : null,
      worst: r.getAttribute('data-worst') === 'true' || !!r.querySelector('[data-lab-worst-tag]'),
      text: text(r),
    })),
    notMeasured: [...root.querySelectorAll('[data-lab-not-measured]')].filter(visible).map((e) => ({ key: e.getAttribute('data-lab-not-measured'), text: text(e) })),
    worstNote: root.querySelector('[data-lab-worst-note]')?.getAttribute('data-lab-worst-note') ?? null,
    flowWorst: [...root.querySelectorAll('.funnel-flow-worst')].filter(visible).map((e) => e.closest('[data-lab-flow-stage], [data-lab-step], li, div')?.textContent ?? '').join(' | '),
    laneNodes: [...root.querySelectorAll('.funnel-node')].filter(visible).map((n) => ({ text: text(n), worst: n.classList.contains('funnel-node--worst'), unmeasured: n.getAttribute('data-measured') === 'false' })),
    body: text(root),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  run(['init', '--yes']);

  // ── CLI: the agent's flow, then lab show --select ───────────────────────────
  const file = join(SCRATCH, 'snapshot.json');
  writeFileSync(file, JSON.stringify(SNAPSHOT));
  dc(['lab', 'create', EN, '--title', 'Acme Messenger', '--category', CATEGORY, '--preset', 'funnel-explorer']);
  const wrote = run(['lab', 'data', 'write', EN, '--file', file]);
  ok('lab data write accepts the snapshot with steps[].dims, no dims notice', wrote.code === 0 && !/are not declared dimensions|not a list of dimension keys/.test(wrote.out), wrote.out.slice(0, 600));
  dc(['lab', 'create', TR, '--title', 'Acme Messenger (tr)', '--category', CATEGORY, '--preset', 'funnel-explorer', '--locale', 'tr']);
  dc(['lab', 'data', 'write', TR, '--file', file]);

  const tg = run(['lab', 'show', EN, '--select', 'channel=telegram']);
  ok('lab show --select channel=telegram: the landing step reads "not measured (no Channel breakdown)"', /Landing button\s+not measured \(no Channel breakdown\)/.test(tg.out), tg.out);
  ok('lab show --select channel=telegram: never a 0 on the landing step, worst drop on First reply',
    !/Landing button\s+0\b/.test(tg.out) && /First reply .*◄ worst drop/.test(tg.out) && !/Chat started .*◄ worst drop/.test(tg.out), tg.out);
  const ru = run(['lab', 'show', EN, '--select', 'language=RU']);
  ok('lab show --select language=RU: the landing step is counted (300)', /Landing button\s+300\b/.test(ru.out), ru.out);
  const board = run(['lab', 'board', 'show', BOARD, '--select', 'channel=telegram', '--json']);
  let steps = null;
  try {
    steps = JSON.parse(board.out).cards.find((c) => c.id === cardIdOf(EN))?.blocks.find((b) => b.tab === 'Steps')?.explorer ?? null;
  } catch { /* reported below */ }
  const clickedDrop = steps?.drops?.find((d) => d.key === 'clicked');
  ok('lab board show --select channel=telegram: Steps prints the landing step not measured with its reason, worst = first_reply',
    clickedDrop?.measured === false && steps?.slice?.steps?.[0]?.reason === 'no Channel breakdown' && steps?.drops?.find((d) => d.worst)?.key === 'first_reply',
    JSON.stringify(steps?.drops ?? board.out.slice(0, 600)));

  // ── The dashboard ───────────────────────────────────────────────────────────
  const taken = await fetch(`${BASE}/api/lab`).then(() => true, () => false);
  if (taken) throw new Error(`port ${PORT} is already serving something; stop it first (lsof -nP -iTCP:${PORT})`);
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  let browser;
  try {
    await until(() => fetch(`${BASE}/api/lab`).then((r) => r.ok, () => false), 30000, 250);
    browser = await webkit.launch();
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
    page.setDefaultTimeout(15000);
    await page.addLocatorHandler(page.locator('.announcements-modal-scrim'), async () => {
      const gotIt = page.getByRole('button', { name: /^got it$/i });
      if (await gotIt.count()) await gotIt.first().click();
      else await page.keyboard.press('Escape');
    });
    const shot = async (loc, name) => {
      await loc.screenshot({ path: join(SHOTS, name) });
      if (SHOTS_OUT) {
        mkdirSync(SHOTS_OUT, { recursive: true });
        copyFileSync(join(SHOTS, name), join(SHOTS_OUT, name));
      }
    };
    const gotoBoard = async () => {
      await page.goto(`${BASE}/lab/b/${BOARD}?vault=proj`, { waitUntil: 'domcontentloaded' });
      await page.locator(`[data-lab-board="${BOARD}"]`).waitFor({ timeout: 20000 });
      await sleep(900);
    };
    const card = (slug) => page.locator(`[data-lab-card="${cardIdOf(slug)}"]`).first();
    const openTab = async (scope, key) => {
      await scope.locator(`[data-lab-tab-key="${key}"]`).first().click();
      await sleep(450);
    };
    /** Exactly `sel` on the card: the chips, or (a compact header) one select per dimension. */
    const select = async (scope, sel) => {
      if (await scope.locator('[data-lab-breakdown-all]').count()) {
        await scope.locator('[data-lab-breakdown-all]').first().click();
        await sleep(200);
        for (const [dim, value] of Object.entries(sel)) {
          await scope.locator(`[data-lab-breakdown-dim="${dim}"] [data-lab-breakdown-chip="${value}"]`).first().click();
          await sleep(250);
        }
        return;
      }
      const selects = scope.locator('[data-lab-breakdown-select]');
      for (let i = 0; i < await selects.count(); i++) {
        const dim = await selects.nth(i).getAttribute('data-lab-breakdown-select');
        await selects.nth(i).selectOption(sel[dim] ?? '');
        await sleep(250);
      }
    };
    const read = (loc) => loc.evaluate(stepsInPage);

    await gotoBoard();
    for (const [slug, loc, word, why] of [[EN, 'en', /not measured/i, /no Channel breakdown/], [TR, 'tr', /ölçülmüyor/i, /Channel kırılımı yok/]]) {
      const c = card(slug);
      await c.scrollIntoViewIfNeeded();
      ok(`the ${loc} explorer card is on the board`, await c.count() === 1);

      // Steps, Channel = telegram.
      await select(c, { channel: 'telegram' });
      await openTab(c, 'steps');
      let m = await read(c);
      const landing = m.rows.find((r) => r.key === 'clicked');
      ok(`[${loc}] Steps, Channel=telegram: the landing row says "${word.source}" with the reason, and no figure`,
        !!landing && landing.measured === false && landing.users === null && word.test(landing.text) && why.test(landing.text) && !/(^|\s)0(\s|$)/.test(landing.text),
        JSON.stringify(m.rows));
      ok(`[${loc}] Steps, Channel=telegram: the biggest drop is not landing -> chat (it is chat -> reply)`,
        m.rows.find((r) => r.worst)?.key === 'first_reply' && !m.rows.find((r) => r.key === 'chat_started')?.worst && m.worstNote === 'first_reply',
        JSON.stringify({ rows: m.rows.map((r) => [r.key, r.worst]), note: m.worstNote }));
      ok(`[${loc}] Steps, Channel=telegram: the chat step is the top (100% of top, no drop into it)`,
        /450/.test(m.rows.find((r) => r.key === 'chat_started')?.text ?? '') && /100/.test(m.rows.find((r) => r.key === 'chat_started')?.text ?? ''),
        JSON.stringify(m.rows.find((r) => r.key === 'chat_started')));
      await shot(c, `${loc}-steps-channel-telegram.png`);

      // Flow, Channel = telegram.
      await openTab(c, 'flow');
      m = await read(c);
      ok(`[${loc}] Flow, Channel=telegram: the landing stage is not measured`, m.notMeasured.some((n) => n.key === 'clicked'), JSON.stringify(m.notMeasured));
      ok(`[${loc}] Flow, Channel=telegram: the biggest-drop badge is not on the chat stage`, !/Chat started/.test(m.flowWorst), m.flowWorst);
      await shot(c, `${loc}-flow-channel-telegram.png`);

      // Compare: a Channel lane and a Language lane side by side.
      await select(c, { channel: 'telegram' });
      await c.locator('[data-lab-lane-pin]').first().click();
      await sleep(300);
      await select(c, { language: 'RU' });
      await c.locator('[data-lab-lane-pin]').first().click();
      await sleep(300);
      await openTab(c, 'compare');
      m = await read(c);
      ok(`[${loc}] Compare: exactly the Channel lane says not measured at the landing step`,
        m.notMeasured.filter((n) => n.key === 'clicked').length === 1, JSON.stringify(m.notMeasured));
      await shot(c, `${loc}-compare-channel-vs-language.png`);
      if (await c.locator('[data-lab-lanes-clear]').count()) await c.locator('[data-lab-lanes-clear]').first().click();
      await sleep(300);

      // Steps, Language = RU: a real count.
      await select(c, { language: 'RU' });
      await openTab(c, 'steps');
      m = await read(c);
      const ruLanding = m.rows.find((r) => r.key === 'clicked');
      ok(`[${loc}] Steps, Language=RU: the landing row shows its count (300)`, ruLanding?.measured === true && ruLanding.users === 300 && /300/.test(ruLanding.text), JSON.stringify(m.rows));
      await shot(c, `${loc}-steps-language-ru.png`);
      await select(c, {});
    }

    // ── The funnel detail page (the step lane + its table) ─────────────────────
    const detail = async (flt) => {
      await page.goto(`${BASE}/lab/${EN}/f/${FUNNEL}?vault=proj&flt=${encodeURIComponent(flt)}`, { waitUntil: 'domcontentloaded' });
      const root = page.locator('.funnel-det').first();
      await root.locator('.funnel-steptable').first().waitFor({ timeout: 20000 });
      await sleep(600);
      return root;
    };
    let root = await detail('channel:telegram');
    let m = await read(root);
    const row = m.rows.find((r) => r.key === 'clicked');
    ok('detail page, Channel=telegram: the step table row says "Not measured: no Channel breakdown", no figure',
      row?.measured === false && /Not measured: no Channel breakdown/.test(row.text) && row.users === null, JSON.stringify(m.rows));
    ok('detail page, Channel=telegram: the worst drop is marked on First reply, not on Chat started',
      m.rows.find((r) => r.worst)?.key === 'first_reply', JSON.stringify(m.rows.map((r) => [r.key, r.worst])));
    const node = m.laneNodes.find((n) => n.unmeasured);
    ok('detail page, Channel=telegram: the lane draws the landing node as not measured, and the worst node is not Chat started',
      !!node && /Landing button/.test(node.text) && /Not measured/.test(node.text) && !m.laneNodes.find((n) => n.worst && /Chat started/.test(n.text)),
      JSON.stringify(m.laneNodes));
    await shot(root, 'detail-channel-telegram.png');

    root = await detail('language:RU');
    m = await read(root);
    ok('detail page, Language=RU: the landing row shows 300', m.rows.find((r) => r.key === 'clicked')?.users === 300, JSON.stringify(m.rows));
    await shot(root, 'detail-language-ru.png');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main()
  .catch((e) => ok('verify run (threw)', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `\n      ${r.detail}`}`);
    console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots: ${SHOTS}`);
    process.exit(failed.length > 0 ? 1 : 0);
  });
