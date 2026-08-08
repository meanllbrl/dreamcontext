#!/usr/bin/env node
/**
 * Hypotheses board redesign (08-08) — end-to-end UI verification.
 *
 *   npm run build && npm run verify:hypotheses
 *
 * Boots the REAL dashboard server on an isolated scratch vault (fake HOME, no
 * user state touched, no tokens spent), seeds five theses across the lifecycle
 * via the real CLI, then drives the UI with Playwright and proves the redesign
 * contract:
 *
 *   1. the ACTIVITY LIST is the default view: one row per thesis with the
 *      status WORD, verdict %, split bar, and an unread dot + "what changed"
 *      line (inbox semantics — everything unread on a fresh profile);
 *   2. the list scope tabs filter (Needs attention = drafts, blocked, fresh
 *      flips, settled-but-unpromoted);
 *   3. the DETAIL MODAL is hero-first: lifecycle actions render in the header
 *      next to the verdict, and evidence notes are clamped to two lines and
 *      expand on click;
 *   4. SEEN-STATE works: opening a thesis clears its unread dot, "Mark all
 *      read" clears the rest;
 *   5. the BOARD (kanban) view still renders with the new card anatomy, and
 *      the view choice is REMEMBERED across a reload (persisted prefs).
 *
 * Same harness contract as the other verify scripts: real server, isolated
 * fake HOME, COLLECT-DON'T-FAIL-FAST reporting. Screenshots (both themes) land
 * in <scratch>/shots for eyeballing.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-hypotheses');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45741;
const CLI = join(REPO, 'dist', 'index.js');

const results = [];
const ok = (name, cond) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);

function dc(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  }).toString();
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
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort — theses only need state/ */ }
  dc(['theses', 'enable']);

  dc(['theses', 'create', 'Hybrid recall beats BM25F-only on the 60-query gold set', '--slug', 'hybrid-recall-wins', '--kind', 'experimental',
    '--prediction', 'Precision@5 at least 5pp above raw BM25F', '--prediction', 'No gold-set query regresses under hybrid']);
  dc(['theses', 'status', 'hybrid-recall-wins', 'open']);
  dc(['theses', 'evidence', 'hybrid-recall-wins', '--verdict', 'supports', '--source', 'task', '--note',
    'Beta rollout task updated with A/B eval v2: held-out r@5 90.0 to 96.7 (+6.7pp), zero regressions - gates met for default-on consideration.', '--cycle', '3', '--date', '2026-08-02']);
  dc(['theses', 'evidence', 'hybrid-recall-wins', '--verdict', 'supports', '--source', 'changelog', '--note',
    'eval/RESULTS.md v2 documents the complete A/B verdict: all four default-on gates met, held-out r@5 +6.7pp exceeds the 5pp threshold.', '--cycle', '4', '--date', '2026-08-06']);
  dc(['theses', 'evidence', 'hybrid-recall-wins', '--verdict', 'no-signal', '--source', 'changelog', '--note',
    'Gold set repointed after archival; recall-eval suite green again.', '--cycle', '4', '--date', '2026-08-07']);

  dc(['theses', 'create', 'Snapshot pre-load eliminates the session-start search spiral', '--slug', 'snapshot-preload',
    '--prediction', 'First-turn tool calls drop below 2 on average']);
  dc(['theses', 'status', 'snapshot-preload', 'open']);
  dc(['theses', 'evidence', 'snapshot-preload', '--verdict', 'supports', '--source', 'insight', '--note',
    'Lab insight: average first-turn tool calls 0.4 across 32 sessions.', '--cycle', '2', '--date', '2026-08-05']);
  dc(['theses', 'status', 'snapshot-preload', 'validated', '--cite', '0']);

  dc(['theses', 'create', 'Turkish queries underperform English on recall@5', '--slug', 'turkish-recall-gap',
    '--prediction', 'Turkish held-out r@5 stays 10pp or more below English']);
  dc(['theses', 'status', 'turkish-recall-gap', 'open']);
  dc(['theses', 'evidence', 'turkish-recall-gap', '--verdict', 'contradicts', '--source', 'changelog', '--note',
    'Turkish held-out r@5 90 to 100 after the analyzer fix.', '--cycle', '3', '--date', '2026-08-01']);

  dc(['theses', 'create', 'Sleep debt score predicts consolidation need', '--slug', 'sleep-debt-predicts']);
  dc(['theses', 'block', 'sleep-debt-predicts', 'per-session', 'consolidation', 'outcome', 'quality']);

  dc(['theses', 'create', 'Glyph icons on cards improve scannability', '--slug', 'glyphs-scannability',
    '--prediction', 'Users identify status faster with glyphs than words']);
  dc(['theses', 'status', 'glyphs-scannability', 'open']);
  dc(['theses', 'evidence', 'glyphs-scannability', '--verdict', 'contradicts', '--source', 'external', '--note',
    'Owner design review 08-08: glyph soup called out; statuses unreadable without a legend.', '--cycle', '4', '--date', '2026-08-08']);
  dc(['theses', 'status', 'glyphs-scannability', 'invalidated', '--cite', '0']);
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
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/theses`);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const setTheme = async (t) => { await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t); await page.waitForTimeout(150); };

    await page.goto(`http://127.0.0.1:${PORT}/?vault=proj`, { waitUntil: 'networkidle' });
    if (await page.locator('.announcements-modal-scrim').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.getByText('Hypotheses', { exact: true }).first().click();
    await page.waitForTimeout(800);

    // 1 — activity list default, inbox semantics
    ok('list view is the default and renders all rows', await page.locator('.thl-row').count() >= 5);
    ok('fresh profile: every row unread', await page.locator('.thl-row--unread').count() >= 5);
    ok('status rendered as a word on rows', await page.locator('.thl-row .thc-status', { hasText: 'Validated' }).count() > 0);
    for (const theme of ['light', 'dark']) { await setTheme(theme); await page.screenshot({ path: join(SHOTS, `list-${theme}.png`) }); }

    // 2 — scope tabs
    await page.locator('.thl-tab', { hasText: 'Needs attention' }).click();
    await page.waitForTimeout(200);
    ok('needs-attention tab filters to actionable theses', await page.locator('.thl-row').count() >= 3);
    await page.locator('.thl-tab', { hasText: 'All' }).click();

    // 3 — detail modal: hero actions + clamped evidence
    await page.locator('.thl-row', { hasText: 'Hybrid recall' }).first().click();
    await page.waitForTimeout(600);
    ok('modal hero carries the lifecycle actions', await page.locator('.td-actions-row .td-btn').count() >= 2);
    ok('evidence notes are clamped by default', await page.locator('.td-evidence-note--clamped').count() >= 1);
    const firstNote = page.locator('.td-evidence-note').first();
    await firstNote.click();
    await page.waitForTimeout(150);
    ok('clicking an evidence note expands it', !(await firstNote.evaluate((el) => el.classList.contains('td-evidence-note--clamped'))));
    for (const theme of ['dark', 'light']) { await setTheme(theme); await page.screenshot({ path: join(SHOTS, `detail-${theme}.png`) }); }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 4 — seen-state
    const hybridRow = page.locator('.thl-row', { hasText: 'Hybrid recall' }).first();
    ok('opened thesis is marked read', !(await hybridRow.evaluate((el) => el.classList.contains('thl-row--unread'))));
    ok('remaining rows stay unread', (await page.locator('.thl-row--unread').count()) === 4);
    await page.locator('.thb-markread').click();
    await page.waitForTimeout(300);
    ok('mark all read clears every dot', (await page.locator('.thl-row--unread').count()) === 0);

    // 5 — board view + persisted choice
    await page.locator('button', { hasText: 'Board' }).first().click();
    await page.waitForTimeout(400);
    ok('board view renders status columns', await page.locator('.thc-col').count() >= 4);
    ok('board cards use the shared anatomy (status word)', await page.locator('.thc-card .thc-status').count() >= 4);
    for (const theme of ['light', 'dark']) { await setTheme(theme); await page.screenshot({ path: join(SHOTS, `board-${theme}.png`) }); }
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    ok('view choice survives a reload', await page.locator('.thc-col').count() >= 4);

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
