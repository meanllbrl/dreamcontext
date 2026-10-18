#!/usr/bin/env node
/**
 * The rebuilt task screens, proven in a real browser (plan r3 § 5f; C5's validation).
 *
 *   npm run build && npm run verify:task-ui
 *   npm run verify:task-ui -- --url http://127.0.0.1:4173 --vault <name> --read-only
 *
 * SCRATCH MODE (the default) builds a synthetic brain under a fake HOME through the real
 * libraries (scripts/verify/fixtures/task-ui-seed.mts): Turkish-named tasks, a 300 KB legacy
 * card with an in-card Changelog and two mermaid fences, a parent with three open and one done
 * sub-task, an active, a closed and a planned cycle, finished and cancelled work that was never
 * planned, a proposal and a change card, a fully and a half evidenced review, audit records
 * (force, accept, held open, an approval with no browser Origin), a learned rule and a filing
 * rule change, and XSS payloads in a card section, a criterion, a journal entry, a proposal
 * name and a learned quote.
 *
 * On {390×844, 1440×900} × {light, dark} it opens: the board (grouped by Now / Next / Later
 * with a parent expanded and the Done lane closed, then by status), the task page, the Inbox,
 * Planning (and the Close deck), Releases, and the door with each choice it offers.
 *
 * It FAILS on: any console error or page error; a failed request (a network failure, any 5xx,
 * or a 4xx from the task screens' own routes); horizontal overflow; `window.__xss` being set,
 * or an `img[onerror]`, `svg[onload]`, `script`, `iframe` or `a[href^="javascript:"]` inside a
 * task, inbox, planning or releases root; and a completed or cancelled never-planned card in
 * the Next or Later column.
 *
 * It OUTPUTS a screenshot of every page × width × theme (read them), and the 300 KB task's time
 * from the click to `[data-task-ready]`: the median of three, which must stay under 1000 ms.
 * Then it runs the owner's flows once, each through the UI (so each request carries the
 * browser's Origin, as the real UI's do): send back, approve, plan by select and by drag, rank,
 * the Close deck, revert a learned rule, accept a proposal.
 *
 * `--url <base> --read-only` drives an already running app on a real brain: navigation and
 * screenshots only, no fixture assertions, no flows, nothing written.
 *
 * FAILURE POLICY — collect, don't fail fast. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, scratchDir, setTheme, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const URL_ARG = flag('--url');
const READ_ONLY = argv.includes('--read-only');
if (URL_ARG && !READ_ONLY) {
  console.error('--url drives a real brain: pass --read-only as well (this script never writes to one).');
  process.exit(2);
}
const SCRATCH_MODE = !URL_ARG;

const SHOTS = shotsDir(REPO, READ_ONLY ? 'task-ui-readonly' : 'task-ui');
const SCRATCH = scratchDir('dc-ui-task-ui');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'scratch');
const CTX = join(PROJ, '_dream_context');
const VAULT = SCRATCH_MODE ? 'scratch' : flag('--vault');

const WIDTHS = [{ w: 390, h: 844 }, { w: 1440, h: 900 }];
const THEMES = ['light', 'dark'];
const TASK_ROUTES = /\/api\/(tasks|cycles|inbox|learned|releases|task-proposals|board)\b/;
const XSS_SELECTOR = 'img[onerror], svg[onload], script, iframe, a[href^="javascript:"]';
const ROOTS = '[data-task-page], .ibx-page, .pln-page, .rel-page, [data-give-to-agent]';

const report = { pass: 0, fail: 0 };
const check = (label, ok, ev = '') => {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${String(ev).slice(0, 400)}` : ''}`); }
};
const info = (msg) => console.log(`  · ${msg}`);

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

// ── the scratch brain ─────────────────────────────────────────────────────────
function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(CTX, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  writeFileSync(join(CTX, 'state', '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
  writeFileSync(join(HOME, '.dreamcontext', 'vaults.json'), JSON.stringify({ version: 1, vaults: [{ name: VAULT, path: PROJ }] }, null, 2));
  const r = spawnSync('npx', ['tsx', join(REPO, 'scripts', 'verify', 'fixtures', 'task-ui-seed.mts'), CTX, SCRATCH], {
    cwd: REPO, env: { ...process.env, HOME }, encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`fixture seed failed: ${r.stderr || r.stdout}`);
  if (r.stderr.trim()) console.log(r.stderr.trim());
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const fm = (slug) => readFileSync(join(CTX, 'state', `${slug}.md`), 'utf-8').split('---')[1] ?? '';

async function startServer(port) {
  const srv = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error(`server did not come up: ${log.slice(-400)}`);
}

// ── page helpers ──────────────────────────────────────────────────────────────
function watch(page, label) {
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e)}`));
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    // A navigation away aborts the requests still in flight: that is not a failure.
    if (!/ERR_ABORTED/.test(why)) problems.push(`requestfailed: ${r.url()} ${why}`);
  });
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 500 || (s >= 400 && TASK_ROUTES.test(r.url()))) problems.push(`HTTP ${s}: ${r.request().method()} ${r.url()}`);
  });
  return {
    take: () => problems.splice(0),
    label,
  };
}

async function dismissAnnouncements(page) {
  for (let i = 0; i < 3; i += 1) {
    if (!(await page.locator('.announcements-modal-scrim').count())) return;
    await page.keyboard.press('Escape');
    await page.locator('.announcements-modal-scrim').first().waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
  }
}

const pageUrl = (base, page) => `${base}/?${VAULT ? `vault=${encodeURIComponent(VAULT)}&` : ''}page=${page}`;

async function go(page, base, id, ready) {
  await page.goto(pageUrl(base, id), { waitUntil: 'domcontentloaded' });
  await dismissAnnouncements(page);
  await page.locator(ready).first().waitFor({ timeout: 15000 });
  await dismissAnnouncements(page);
}

async function noOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const over = doc.scrollWidth > doc.clientWidth + 1;
    const roots = [...document.querySelectorAll('[data-task-page], .ibx-page, .pln-page, .rel-page')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className || el.tagName);
    return { ok: !over && roots.length === 0, detail: `doc ${doc.scrollWidth}/${doc.clientWidth} ${roots.join(',')}` };
  });
}

async function noXss(page) {
  return page.evaluate(({ sel, roots }) => {
    const live = [...document.querySelectorAll(roots)].flatMap((r) => [...r.querySelectorAll(sel)].map((n) => n.outerHTML.slice(0, 80)));
    return { ok: !window.__xss && live.length === 0, detail: `__xss=${window.__xss ?? 'unset'} nodes=${live.join(' | ')}` };
  }, { sel: XSS_SELECTOR, roots: ROOTS });
}

async function settle(page, w, label, tag) {
  const o = await noOverflow(page);
  check(`${tag} no horizontal overflow`, o.ok, o.detail);
  const x = await noXss(page);
  check(`${tag} no payload ran or reached the DOM`, x.ok, x.detail);
  const problems = w.take();
  check(`${tag} no console error, page error or failed request`, problems.length === 0, problems.join('\n      '));
  await page.screenshot({ path: join(SHOTS, `${label}.png`), fullPage: false });
}

/** Open every collapsed section of the task page, so each one's text is on screen. */
async function openAllSections(page) {
  for (let i = 0; i < 12; i += 1) {
    const closed = page.locator('[data-task-page] .task-section-head[aria-expanded="false"]').first();
    if (!(await closed.count())) return;
    await closed.click();
  }
}

async function openTaskFromBoard(page, base, slug) {
  await go(page, base, 'tasks', '[data-board-column]');
  const card = page.locator(`[data-task-card="${slug}"]`).first();
  if (!(await card.isVisible().catch(() => false))) {
    // On a phone the board shows one column at a time: find the column that holds it.
    for (const btn of await page.locator('.bd-seg[role="group"] .bd-seg-btn').all()) {
      await btn.click();
      if (await card.isVisible().catch(() => false)) break;
    }
  }
  await card.click();
  await page.locator(`[data-task-ready="${slug}"]`).waitFor({ timeout: 15000 });
}

// ── the grid ──────────────────────────────────────────────────────────────────
async function grid(browser, base, ids) {
  for (const theme of THEMES) {
    for (const { w, h } of WIDTHS) {
      const tag = `${w}·${theme}`;
      console.log(`\n${tag}`);
      const context = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
      await setTheme(context, theme);
      const page = await context.newPage();
      const watcher = watch(page, tag);

      // Board, grouped by Now / Next / Later.
      await go(page, base, 'tasks', '[data-board-column]');
      if (SCRATCH_MODE) {
        const inColumn = async (col, slug) => page.locator(`[data-board-column="${col}"] [data-task-card="${slug}"]`).count();
        let leaked = [];
        for (const col of ['next', 'later']) {
          if (w < 640) await page.locator('.bd-seg-btn', { hasText: col === 'next' ? 'Next' : 'Later' }).first().click();
          for (const slug of ['done-unplaced', 'cancelled-unplaced', 'cancelled-later']) if (await inColumn(col, slug)) leaked.push(`${slug} in ${col}`);
        }
        check(`${tag} board: no finished or cancelled never-planned card in Next or Later`, leaked.length === 0, leaked.join(', '));
        if (w < 640) await page.locator('.bd-seg-btn', { hasText: 'Now' }).first().click();
        check(`${tag} board: the Done lane is closed`, (await page.locator('[data-board-column="done"] .bd-col-head').first().getAttribute('aria-expanded').catch(() => 'missing')) === 'false');
        const roll = page.locator('[data-task-card="epic-parent"] .bd-rollup').first();
        check(`${tag} board: the parent shows n/m`, /1\/4|1\/3/.test((await roll.innerText().catch(() => '')) || ''), await roll.innerText().catch(() => '(no roll-up)'));
        await roll.click();
        check(`${tag} board: the parent expands (aria-expanded)`, (await roll.getAttribute('aria-expanded')) === 'true');
        await page.locator('.bd-nested [data-task-card="child-cart"]').first().waitFor({ timeout: 5000 }).catch(() => {});
        check(`${tag} board: its sub-tasks nest under it`, (await page.locator('.bd-nested [data-task-card="child-cart"]').count()) > 0);
        check(`${tag} board: the Turkish name is verbatim`, (await page.locator('body').innerText()).includes('Gölge İşleri: ığdır şubesi ödemesi') || w < 640);
      }
      await settle(page, watcher, `board-order-${w}-${theme}`, `${tag} board (order)`);

      // Board, grouped by status.
      await page.locator('.bd-toolbar .bd-seg-btn', { hasText: 'Status' }).first().click();
      await page.locator('.bd-toolbar .bd-seg-btn[aria-pressed="true"]', { hasText: 'Status' }).first().waitFor({ timeout: 5000 });
      await settle(page, watcher, `board-status-${w}-${theme}`, `${tag} board (status)`);
      await page.locator('.bd-toolbar .bd-seg-btn', { hasText: 'Now / Next / Later' }).first().click();

      // The task page, every section open.
      if (SCRATCH_MODE) {
        await openTaskFromBoard(page, base, 'xss-card');
        await openAllSections(page);
        await settle(page, watcher, `task-xss-${w}-${theme}`, `${tag} task page (payload card)`);
        await openTaskFromBoard(page, base, 'legacy-giant');
        check(`${tag} task page: criteria with evidence chips`, (await page.locator('.tkp-chip--legacy').count()) > 0);
        await settle(page, watcher, `task-legacy-${w}-${theme}`, `${tag} task page (300 KB legacy)`);
        await openTaskFromBoard(page, base, 'odeme-akisi');
        check(`${tag} task page: the name as written`, (await page.locator('.tkp-title').innerText()) === 'Gölge İşleri: ığdır şubesi ödemesi', await page.locator('.tkp-title').innerText());
        await settle(page, watcher, `task-turkish-${w}-${theme}`, `${tag} task page (Turkish)`);
      } else {
        await page.locator('.bd-card').first().click();
        await page.locator('[data-task-ready]').first().waitFor({ timeout: 15000 });
        await settle(page, watcher, `task-${w}-${theme}`, `${tag} task page`);
      }

      // The door, and each choice it offers.
      await page.locator('[data-task-page] .tkp-header-top .tkp-btn--primary').first().click();
      await page.locator('[data-give-ready="true"]').waitFor({ timeout: 15000 });
      await settle(page, watcher, `door-${w}-${theme}`, `${tag} door`);
      const choices = await page.locator('[data-give-choice]:not([disabled])').evaluateAll((els) => els.map((e) => e.getAttribute('data-give-choice')));
      // A task's door offers Develop, a named agent and a custom prompt; the first and last need the
      // in-app agent (desktop, Agents on), which a scratch Chromium does not have.
      if (choices.length < 3) info(`${tag} door offers ${choices.join(', ') || 'nothing'} (the in-app agent is not ready here)`);
      check(`${tag} door: a named agent is always offered`, choices.includes('agent'), choices.join(','));
      for (const c of choices) {
        await page.locator(`[data-give-choice="${c}"]`).click();
        const open = c === 'develop' ? '[data-give-choice-panel="develop"]' : '.modal-overlay, [role="dialog"]';
        await page.locator(open).first().waitFor({ timeout: 10000 });
        await settle(page, watcher, `door-${c}-${w}-${theme}`, `${tag} door: ${c}`);
        await page.keyboard.press('Escape');
        if (await page.locator('[data-give-to-agent]').count()) await page.locator('.gta-close').first().click().catch(() => {});
        await page.locator('.modal-overlay').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => page.locator('.modal-close').first().click().catch(() => {}));
        await page.locator('[data-task-page] .tkp-header-top .tkp-btn--primary').first().click();
        await page.locator('[data-give-ready="true"]').waitFor({ timeout: 15000 });
      }
      await page.locator('.gta-close').first().click().catch(() => {});

      // Inbox, Planning (with the Close deck), Releases.
      await go(page, base, 'inbox', '[data-inbox-ready]');
      if (SCRATCH_MODE) {
        check(`${tag} inbox: the half-proven review says evidence incomplete`, (await page.locator('[data-inbox-review="review-partial"] .ibx-tag--warn').count()) > 0);
        check(`${tag} inbox: the no-origin record is tinted and labelled`, (await page.locator('[data-via="no-origin"].ibx-row--warn .ibx-warn-label').count()) > 0);
        check(`${tag} inbox: records carry via`, (await page.locator('[data-inbox-record]').count()) >= 3 && (await page.locator('[data-inbox-record]:not([data-via])').count()) === 0);
        check(`${tag} inbox: the held-open flag is listed`, (await page.locator('[data-inbox-flag]').count()) > 0);
        check(`${tag} inbox: a learned rule and a filing rule are listed`, (await page.locator('[data-inbox-learned]').count()) >= 2);
      }
      await settle(page, watcher, `inbox-${w}-${theme}`, `${tag} inbox`);

      await go(page, base, 'planning', '[data-planning-ready]');
      await settle(page, watcher, `planning-${w}-${theme}`, `${tag} planning`);
      const closeBtn = page.locator('.pln-cycle[data-status="active"] .pln-btn', { hasText: 'Close' }).first();
      if (await closeBtn.count()) {
        await closeBtn.click();
        await page.locator('[data-close-deck]').waitFor({ timeout: 10000 });
        await settle(page, watcher, `close-deck-${w}-${theme}`, `${tag} close deck`);
        await page.locator('[data-close-deck] .pln-actions .pln-btn', { hasText: 'Cancel' }).first().click();
      } else if (SCRATCH_MODE) {
        check(`${tag} planning: the active cycle offers Close`, false);
      }

      await go(page, base, 'releases', '[data-releases-ready]');
      await settle(page, watcher, `releases-${w}-${theme}`, `${tag} releases`);

      await context.close();
    }
  }
}

// ── the 300 KB task, click to ready ───────────────────────────────────────────
async function timing(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await setTheme(context, 'light');
  const page = await context.newPage();
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    await go(page, base, 'tasks', '[data-task-card="legacy-giant"]');
    const t0 = Date.now();
    await page.locator('[data-task-card="legacy-giant"]').first().click();
    await page.locator('[data-task-ready="legacy-giant"]').waitFor({ timeout: 15000 });
    runs.push(Date.now() - t0);
  }
  runs.sort((a, b) => a - b);
  console.log(`\n300 KB legacy task, click → [data-task-ready]: ${runs.join(' / ')} ms (median ${runs[1]} ms)`);
  check('the 300 KB task opens in under 1000 ms (median of 3)', runs[1] < 1000, `${runs.join(', ')}`);
  await context.close();
}

// ── the owner's flows, through the UI ─────────────────────────────────────────
async function flows(browser, base, ids) {
  console.log('\nflows');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await setTheme(context, 'light');
  const page = await context.newPage();
  const watcher = watch(page, 'flows');
  const confirm = async () => {
    const dialog = page.locator('[data-confirm-dialog]');
    await dialog.waitFor({ timeout: 5000 });
    await dialog.locator('[data-confirm-accept]').click();
  };
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return fn();
  };

  // Send back, with a note, from the task page.
  await openTaskFromBoard(page, base, 'review-partial');
  await page.locator('[data-verdict-bar="review-partial"] .tkp-btn', { hasText: 'Send back' }).first().click();
  await page.locator('#verdict-note-review-partial').fill('The docs criterion is not proven yet.');
  await page.locator('[data-verdict-bar="review-partial"] button[type="submit"]').click();
  check('flow: send back moves the task out of review', await until(() => !/status: "?in_review/.test(fm('review-partial'))), fm('review-partial').match(/status:.*/)?.[0]);

  // Approve, from the Inbox.
  await go(page, base, 'inbox', '[data-inbox-ready]');
  await page.locator('[data-inbox-review="review-ready"] .tkp-btn--primary').first().click();
  check('flow: approve completes the fully proven review', await until(() => /status: "?completed/.test(fm('review-ready'))), fm('review-ready').match(/status:.*/)?.[0]);

  // Accept a proposal, from the Inbox (accept unchanged from the old board section).
  const accept = page.locator('[data-inbox-section="proposals"] button', { hasText: /^Accept$/ }).first();
  await accept.waitFor({ timeout: 8000 }).catch(() => {});
  if (await accept.count()) {
    await accept.click();
    check('flow: accepting the proposal files a task', await until(async () => (await page.locator('[data-inbox-section="proposals"] button', { hasText: /^Accept$/ }).count()) === 0));
  } else check('flow: the proposal offers Accept', false);

  // Revert the learned rule (through confirmAction).
  const revert = page.locator(`[data-inbox-learned="${ids.learned}"] .ibx-btn`, { hasText: 'Revert' }).first();
  if (ids.learned && (await revert.count())) {
    await revert.click();
    await confirm();
    check('flow: revert takes the learned pattern out', await until(() => !existsSync(join(CTX, 'knowledge', 'patterns', 'commit-messages.md'))));
  } else check('flow: the learned rule offers Revert', false, `learned=${ids.learned}`);

  // Plan by select, plan by drag, rank: on Planning, the planned cycle is on the board.
  await go(page, base, 'planning', '[data-planning-board]');
  const lane = page.locator('[data-planning-lane="cycle"]');
  await page.locator('[data-planning-item="odeme-akisi"] select').selectOption(ids.planned);
  check('flow: "Move to" plans into the cycle', await until(() => fm('odeme-akisi').includes(ids.planned)), fm('odeme-akisi').match(/cycle:.*/)?.[0]);
  await page.locator('[data-planning-item="xss-card"]').dragTo(lane);
  check('flow: a drag plans into the cycle', await until(() => fm('xss-card').includes(ids.planned)), fm('xss-card').match(/cycle:.*/)?.[0]);
  await lane.locator('[data-planning-item="xss-card"]').waitFor({ timeout: 8000 }).catch(() => {});
  const items = await lane.locator('[data-planning-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-planning-item')));
  if (items.length >= 2) {
    const [first, second] = items;
    await lane.locator(`[data-planning-item="${first}"] .pln-icon-btn`).nth(1).click();
    const rankOf = (slug) => Number(/rank: (-?[\d.]+)/.exec(fm(slug))?.[1] ?? NaN);
    check('flow: Down ranks the first card after the second', await until(() => rankOf(first) > rankOf(second)), `${first}=${rankOf(first)} ${second}=${rankOf(second)}`);
  } else check('flow: two cards to rank in the cycle', false, items.join(','));

  // The Close deck: every leaf back to Next, then close.
  await go(page, base, 'planning', '[data-planning-ready]');
  await page.locator('.pln-cycle[data-status="active"] .pln-btn', { hasText: 'Close' }).first().click();
  await page.locator('[data-close-deck]').waitFor({ timeout: 10000 });
  const submit = page.locator('[data-close-deck] .pln-btn--primary');
  check('flow: Close stays disabled until every leaf is decided', await submit.isDisabled());
  await page.locator('[data-close-deck] .cld-rest select').selectOption('back');
  await page.locator('[data-close-deck] .cld-rest .pln-btn').click();
  await submit.click();
  const cyclesFile = () => readFileSync(join(CTX, 'core', 'CYCLES.json'), 'utf-8');
  check('flow: the Close deck closes the cycle', await until(() => {
    const active = JSON.parse(cyclesFile()).find?.((c) => c.id === ids.active) ?? (JSON.parse(cyclesFile()).cycles ?? []).find((c) => c.id === ids.active);
    return active?.status === 'closed';
  }), cyclesFile().slice(0, 300));

  const problems = watcher.take();
  check('flows: no console error, page error or failed request', problems.length === 0, problems.join('\n      '));
  await context.close();
}

// ── main ──────────────────────────────────────────────────────────────────────
let server = null;
let browser = null;
try {
  mkdirSync(SHOTS, { recursive: true });
  let base = URL_ARG?.replace(/\/$/, '') ?? '';
  let ids = {};
  if (SCRATCH_MODE) {
    ids = seed();
    check('fixture: a change card was seeded', !!ids.change);
    check('fixture: a learned rule was seeded', !!ids.learned);
    const port = await freePort();
    server = await startServer(port);
    base = `http://127.0.0.1:${port}`;
  }
  browser = await chromium.launch();
  await grid(browser, base, ids);
  if (SCRATCH_MODE) {
    await timing(browser, base);
    await flows(browser, base, ids);
  }
} catch (err) {
  check('harness completes', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(`\n${report.pass} passed, ${report.fail} failed · screenshots: ${SHOTS}`);
process.exit(report.fail ? 1 : 0);
