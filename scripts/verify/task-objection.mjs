#!/usr/bin/env node
/**
 * "Why was this opened" and "Object to this task", proven in the real app (task
 * 2-dalga-gorev-sayfasi, approved drafts 1-5).
 *
 *   npm run build && node scripts/verify/task-objection.mjs
 *
 * Boots the BUILT dashboard against an isolated scratch vault (fake HOME, DREAMCONTEXT_DESKTOP=1)
 * seeded with FICTIONAL fixtures — a project called "Lumen Notes": a parent whose plan has two
 * waves as sub-tasks (wave 1 closed, wave 2 open), a sleep-filed sub-task on an owner ask, a
 * sleep-filed top-level task to object to, a defect, an older task with no reason recorded, the
 * owner's own task, and an objection that stopped midway. Then, at 1440 and 390 px, it drives
 * Chromium: the filing row, the dialog, the objection, the rule sleep learned (written with the
 * built CLI's `tasks rules set`), "Finish" on the unfinished one, and a parent with an open
 * sub-task refused on the board (right-click and drag) and in the drawer's status select.
 * Screenshots: tmp/verify-task-objection/<name>-<width>.png. A `window.confirm` call is a FAIL.
 *
 * FAILURE POLICY — collect, don't fail fast. Exit 1 on any FAIL or console error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = process.env.PORT || '4823';
const URL = `http://127.0.0.1:${PORT}`;
const SHOTS = join(REPO, 'tmp', 'verify-task-objection');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};

// ─── Scratch vault ───────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), 'dc-objection-'));
const vaultDir = join(home, 'lumen');
const dc = join(vaultDir, '_dream_context');
const state = join(dc, 'state');
for (const d of [state, join(dc, 'overrides'), join(home, '.dreamcontext')]) mkdirSync(d, { recursive: true });
writeFileSync(join(state, '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ version: 1, vaults: [{ name: 'lumen', path: vaultDir }] }, null, 2));
writeFileSync(join(dc, 'overrides', 'task.md'), '---\nstatuses:\n  - name: Cancelled\n    key: cancelled\n    kind: cancelled\n    order: 99\n---\n');

const yaml = (v) => (v === null ? 'null' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : typeof v === 'boolean' ? String(v) : v);
const fm = (o) => Object.entries(o).map(([k, v]) => (v && typeof v === 'object'
  ? `${k}:\n${Object.entries(v).map(([kk, vv]) => `  ${kk}: ${yaml(vv)}`).join('\n')}`
  : `${k}: ${yaml(v)}`)).join('\n');
const seed = (slug, front, body = '## Why\n\nFor the Lumen Notes lesson planner.\n') => writeFileSync(join(state, `${slug}.md`), `---\n${fm({
  id: `task_${slug.slice(0, 10)}`, name: slug, description: '', priority: 'medium', urgency: 'medium', status: 'todo',
  created_at: '2026-10-20', updated_at: '2026-10-20', parent_task: null, related_feature: null, version: null, ...front,
})}\ntags: []\n---\n\n${body}\n`);

const PARENT = 'ders-plani-ekrani-yeniden-yapilir';
const W1 = '1-dalga-veri-modeli';
const W2 = '2-dalga-ekran';
const ASKED = 'haftalik-gorunumde-dersler-surukle-birakla-tasinir';
const TOP = 'takvimde-tatil-gunleri-gri-gorunur';
const DEFECT = 'ders-listesi-bosken-sayfa-cokuyor';
const OLD = 'eski-bir-gorev';
const MINE = 'sahibin-kendi-gorevi';
const HALF = 'yarim-kalmis-itiraz';

seed(PARENT, { name: 'Ders planı ekranı yeniden yapılır', status: 'in_progress', priority: 'high' }, `## Why

Teachers rebuild the week by hand in Lumen Notes.

## Technical Details

WAVE MAP: EXECUTION: lead | W1 ${W1} (src/model.ts) | W2 ${W2} (src/screen.tsx)
`);
seed(W1, { name: '1. dalga: veri modeli', status: 'completed', parent_task: PARENT, filed_by: 'plan', filing_basis: { kind: 'plan', quote: `W1 ${W1} (src/model.ts)`, at: '2026-10-20', verified: false } });
seed(W2, { name: '2. dalga: ekran', status: 'in_progress', parent_task: PARENT, filed_by: 'plan', filing_basis: { kind: 'plan', quote: `W2 ${W2} (src/screen.tsx)`, at: '2026-10-20', verified: false } });
seed(ASKED, { name: 'Haftalık görünümde dersler sürükle-bırakla taşınır', parent_task: PARENT, filed_by: 'sleep', filing_basis: { kind: 'ask', quote: 'haftalık görünümde dersi tutup başka güne çekebileyim', session: 's1', at: '2026-10-23', verified: true } }, `## Why

A teacher deletes and re-creates a lesson to move it to another day.

## Acceptance Criteria

- [ ] A lesson dragged to another day keeps its time
- [ ] The student gets one notice for a moved lesson
`);
seed(TOP, { name: 'Takvimde tatil günleri gri görünür', filed_by: 'sleep', filing_basis: { kind: 'ask', quote: 'tatil günlerini de bir şekilde göstersek', session: 's1', at: '2026-10-22', verified: true } });
seed(DEFECT, { name: 'Ders listesi boşken sayfa çöküyor', filed_by: 'sleep', filing_basis: { kind: 'defect', quote: 'TypeError: lessons is undefined', session: 's2', at: '2026-10-23', verified: true } });
seed(OLD, { name: 'Eski bir görev', created_at: '2026-08-01' });
seed(MINE, { name: 'Sahibin kendi görevi', filed_by: 'human' });
seed(HALF, { name: 'Yarım kalmış itiraz', status: 'cancelled', filed_by: 'agent', filing_basis: { kind: 'note', quote: 'An agent thought this was needed.', at: '2026-10-21', verified: false } }, `## Why

An agent thought this was needed.

## Changelog

### 2026-10-23 - Objection
- itiraz obj_halfdone01 (not-a-task): Bu konuşuldu ama hiç istenmedi, görev değil.
`);
// An objection that stopped after its last step (the task is cancelled, `applied` was never stamped).
writeFileSync(join(state, '.task-objections.json'), JSON.stringify([{
  id: 'obj_halfdone01', task: HALF,
  snapshot: { name: 'Yarım kalmış itiraz', description: '', why: 'An agent thought this was needed.', filing_basis: null, filed_by: 'agent', created_at: '2026-10-20' },
  as: 'not-a-task', target: null, note: 'Bu konuşuldu ama hiç istenmedi, görev değil.', by: 'owner', via: 'ui',
  at: '2026-10-23T09:00:00.000Z', steps: ['decline', 'log', 'cancel'], error: 'crash after cancel (test)', applied: null,
}], null, 2));

const cli = (...args) => spawnSync(process.execPath, [distIndex(REPO), ...args], { cwd: vaultDir, env: { ...process.env, HOME: home }, encoding: 'utf-8' });
const fmOf = (slug) => readFileSync(join(state, `${slug}.md`), 'utf-8');

// ─── Server ──────────────────────────────────────────────────────────────────

const server = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '--port', PORT], {
  cwd: vaultDir,
  env: { ...process.env, HOME: home, DREAMCONTEXT_DESKTOP: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const waitForServer = async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${URL}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

let browser;
const consoleErrors = [];
const failedRequests = [];
const expected409 = {};
try {
  if (!(await waitForServer())) {
    check('server boots', false, `no /api/health after 40s. log tail: ${serverLog.slice(-400)}`);
    throw new Error('server did not boot');
  }
  check('server boots', true);
  browser = await chromium.launch();

  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    await markAnnouncementsSeen(context, URL);
    // A browser dialog primitive is a silent no-op in the desktop app: none may be called.
    await context.addInitScript(() => {
      window.__confirms = 0;
      window.confirm = () => { window.__confirms += 1; return true; };
      window.alert = () => { window.__confirms += 1; };
    });
    const page = await context.newPage();
    // The refusals this script provokes on purpose come back as 409s, which Chromium logs as a
    // console error per request: they are counted, and checked against the refusals made.
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/status of 409 \(Conflict\)/.test(m.text())) { expected409[width] = (expected409[width] ?? 0) + 1; return; }
      consoleErrors.push(`${width}: ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleErrors.push(`${width} pageerror: ${e.message}`));
    page.on('requestfailed', (r) => failedRequests.push(`${width}: ${r.failure()?.errorText} ${r.url()}`));
    const wait = (ms) => page.waitForTimeout(ms);
    const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(150); } return false; };
    const shot = async (name) => { await wait(400); await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`) }); };
    const dismiss = async () => { for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(400); } };
    const openBoard = async () => {
      await page.goto(`${URL}/?vault=lumen`, { waitUntil: 'networkidle' });
      await wait(1000);
      await dismiss();
      const nav = page.locator('.sidebar-item', { hasText: 'Tasks' }).first();
      if (await nav.isVisible().catch(() => false)) await nav.click();
      else await page.goto(`${URL}/?vault=lumen#tasks`, { waitUntil: 'networkidle' });
      await until(async () => (await page.locator('.bd-card').count()) > 0, 15000);
      await wait(500);
    };
    const card = (slug) => page.locator(`.bd-card[data-task-slug="${slug}"]`).first();
    const columnOf = (slug) => card(slug).evaluate((el) => el.closest('[data-column]')?.getAttribute('data-column') ?? null);
    const closeDrawer = async () => { await page.keyboard.press('Escape'); await wait(400); };
    const openTask = async (slug) => {
      // A sub-task is listed under its parent's card: expand that list when the row is not shown.
      const raw = /^name: (.*)$/m.exec(fmOf(slug))?.[1]?.trim() ?? slug;
      const name = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw.startsWith('"') ? JSON.parse(raw) : raw;
      const subRow = page.locator('.bd-sub-row', { hasText: name }).first();
      let target = card(slug);
      if (!(await target.isVisible().catch(() => false))) {
        if (!(await subRow.isVisible().catch(() => false))) {
          await page.locator(`.bd-card[data-task-slug="${PARENT}"] .bd-sub-chip`).first().click().catch(() => {});
          await wait(400);
        }
        target = subRow;
      }
      // The title corner: the middle of a parent's card may be its open sub-task list.
      await target.click({ position: { x: 24, y: 14 } });
      await until(async () => (await page.locator('.detail-panel').count()) === 1);
      await wait(700);
    };
    const W = `@${width}`;

    // ── Board: the waves under their parent (draft 4) ─────────────────────────
    await openBoard();
    const parentText = await card(PARENT).innerText().catch(() => '');
    check(`${W} board: the parent card counts its sub-tasks`, /\b1\/4\b|\b1\/3\b/.test(parentText), parentText.replace(/\s+/g, ' ').slice(0, 120));
    await shot('board');

    // ── Draft 1: why the sleep-filed sub-task was opened ──────────────────────
    await openTask(ASKED);
    const row = page.locator('[data-testid="filing-row"]');
    const rowText = await row.innerText().catch(() => '');
    check(`${W} draft 1: the row names sleep, the date and the owner's words`, /Sleep opened it · Oct 23/.test(rowText) && /The owner asked:/.test(rowText) && rowText.includes('haftalık görünümde dersi tutup başka güne çekebileyim'), rowText.replace(/\s+/g, ' '));
    check(`${W} draft 1: "Object to this task" is there`, await page.locator('[data-testid="object-btn"]').isVisible());
    const rowBox = await row.boundingBox();
    const panelBox = await page.locator('.detail-panel').boundingBox();
    check(`${W} draft 1: the row fits the drawer (no overflow)`, rowBox && panelBox && rowBox.x >= panelBox.x - 1 && rowBox.x + rowBox.width <= panelBox.x + panelBox.width + 1, JSON.stringify({ rowBox, panelBox }));
    await shot('filing');
    await closeDrawer();

    // The other filers.
    await openTask(DEFECT);
    check(`${W} a defect reads as an error, in italics`, /Error:/.test(await row.innerText()) && (await page.locator('.filing-quote--defect').count()) === 1);
    if (width === 390) {
      await page.locator('[data-testid="object-btn"]').click();
      const dlg = page.locator('[data-testid="objection-dialog"]');
      await page.locator('input[value="criterion-on"]').check();
      await page.locator('[data-testid="objection-target"]').selectOption(PARENT);
      await page.locator('[data-testid="objection-note"]').fill('Bu, ders planı ekranının bir kriteri olmalıydı.');
      const box = await dlg.boundingBox();
      check(`${W} the dialog fits the phone screen`, box && box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
      await shot('dialog');
      await page.keyboard.press('Escape');
      await wait(300);
      check(`${W} Esc closes the dialog and keeps the drawer`, (await dlg.count()) === 0 && (await page.locator('.detail-panel').count()) === 1);
    }
    await closeDrawer();
    await openTask(W2);
    check(`${W} a wave reads "Wave 2 of the approved plan"`, /Plan opened it/.test(await row.innerText()) && /Wave 2 of the approved plan/.test(await row.innerText()));
    await shot('wave');
    await closeDrawer();
    await openTask(OLD);
    check(`${W} an older task says the reason was not recorded, button still there`, /Reason not recorded/.test(await row.innerText()) && await page.locator('[data-testid="object-btn"]').isVisible());
    await closeDrawer();
    await openTask(MINE);
    check(`${W} the owner's own task has no row and no button`, (await row.count()) === 0 && (await page.locator('[data-testid="object-btn"]').count()) === 0);
    await closeDrawer();

    // ── Draft 2: the dialog ───────────────────────────────────────────────────
    await openTask(TOP);
    if (width === 1440) {
      await page.locator('[data-testid="object-btn"]').click();
      const dialog = page.locator('[data-testid="objection-dialog"]');
      check(`${W} draft 2: the dialog opens with five kinds`, await dialog.isVisible() && (await dialog.locator('input[type=radio]').count()) === 5);
      const confirm = page.locator('[data-testid="objection-confirm"]');
      check(`${W} draft 2: confirm waits for a target and a 15-char reason`, await confirm.isDisabled());
      const options = await page.locator('[data-testid="objection-target"] option').allInnerTexts();
      check(`${W} draft 2: the picker offers open top-level tasks only`, options.includes('Ders planı ekranı yeniden yapılır') && !options.includes('1. dalga: veri modeli') && !options.includes('2. dalga: ekran') && !options.includes('Takvimde tatil günleri gri görünür'), options.join(' | '));
      await page.locator('[data-testid="objection-target"]').selectOption(PARENT);
      await page.locator('[data-testid="objection-note"]').fill('Tatil günleri ders planı ekranının bir parçası, ayrı görev değil.');
      const preview = await page.locator('.objection-preview').innerText();
      check(`${W} draft 2: the preview says what happens`, /moves under «Ders planı ekranı yeniden yapılır»/.test(preview), preview);
      check(`${W} draft 2: confirm is ready`, await confirm.isEnabled());
      await shot('dialog');
      // Esc closes the dialog, not the drawer.
      await page.keyboard.press('Escape');
      await wait(300);
      check(`${W} Esc closes the dialog and keeps the drawer`, (await dialog.count()) === 0 && (await page.locator('.detail-panel').count()) === 1);
      await page.locator('[data-testid="object-btn"]').click();
      await page.locator('[data-testid="objection-target"]').selectOption(PARENT);
      await page.locator('[data-testid="objection-note"]').fill('Tatil günleri ders planı ekranının bir parçası, ayrı görev değil.');
      await confirm.click();
      await until(async () => (await page.locator('[data-testid="objection-box"]').count()) === 1, 8000);
      const box = await page.locator('[data-testid="objection-box"]').innerText().catch(() => '');
      check(`${W} draft 3: the box shows the objection and where it went`, /You objected/.test(box) && /moved under «Ders planı ekranı yeniden yapılır»/.test(box), box.replace(/\s+/g, ' '));
      check(`${W} draft 3: the task now sits under the parent, still open`, /parent_task: ders-plani-ekrani-yeniden-yapilir/.test(fmOf(TOP)) && /status: '?todo'?/.test(fmOf(TOP)));
      check(`${W} draft 3: the button is gone once applied`, (await page.locator('[data-testid="object-btn"]').count()) === 0);
      await shot('after');
      // Sleep learns a rule from it (the CLI is the only writer of the rules file).
      const ledger = JSON.parse(readFileSync(join(state, '.task-objections.json'), 'utf-8'));
      const applied = ledger.find((r) => r.task === TOP && r.applied);
      const set = cli('tasks', 'rules', 'set', '--title', 'Parts of a screen are not tasks',
        '--dont', 'Open a separate task for a part of a screen.', '--do', 'Make it a sub-task or a criterion of that screen\'s task.',
        '--rests-on', applied?.id ?? 'missing');
      check(`${W} the CLI learns a rule resting on it`, set.status === 0, (set.stdout + set.stderr).trim().slice(0, 200));
      await closeDrawer();
      await page.reload({ waitUntil: 'networkidle' });
      await wait(800);
    }
    await openBoard();
    await openTask(TOP);
    const learned = await page.locator('[data-testid="objection-learned"]').innerText().catch(() => '');
    check(`${W} draft 3: "Sleep learned" shows the rule`, /Sleep learned · R1:/.test(learned) && /Open a separate task for a part of a screen\./.test(learned), learned);
    await shot('learned');
    await closeDrawer();

    // ── Unfinished: "Finish" on a cancelled task ──────────────────────────────
    await page.locator('[data-testid="toolbar-search"], input[type=search]').first().fill('').catch(() => {});
    if (width === 1440) {
      // The cancelled task sits in the Cancelled column (off to the right): open it there.
      const inDom = (await card(HALF).count()) === 1;
      check(`${W} unfinished: the cancelled task is on the board`, inDom);
      if (inDom) {
        await card(HALF).scrollIntoViewIfNeeded();
        await openTask(HALF);
        const box = await page.locator('[data-testid="objection-box"]').innerText().catch(() => '');
        check(`${W} unfinished: "Unfinished · Finish" shows on the cancelled task`, /Unfinished/.test(box) && await page.locator('[data-testid="objection-finish"]').isVisible(), box.replace(/\s+/g, ' '));
        check(`${W} unfinished: no second objection button beside it`, (await page.locator('[data-testid="object-btn"]').count()) === 0);
        await shot('pending');
        await page.locator('[data-testid="objection-finish"]').click();
        await until(async () => (await page.locator('[data-testid="objection-finish"]').count()) === 0, 8000);
        const after = await page.locator('[data-testid="objection-box"]').innerText().catch(() => '');
        check(`${W} unfinished: Finish completes it (one record, applied)`, (await page.locator('[data-testid="objection-finish"]').count()) === 0
          && /not a task; sleep will not open it again/.test(after)
          && JSON.parse(readFileSync(join(state, '.task-objections.json'), 'utf-8')).filter((r) => r.task === HALF && r.applied).length === 1, after.replace(/\s+/g, ' '));
        await shot('finished');
        await closeDrawer();
      }
      await openBoard();
    }

    // ── Draft 4/5 refusal: a parent with an open sub-task cannot be completed ─
    const before = await columnOf(PARENT);
    await card(PARENT).click({ button: 'right' });
    // The status flyout opens on hover (a click on its row toggles it).
    await page.locator('.bd-row', { hasText: 'Move to status' }).first().hover();
    await wait(300);
    await page.locator('.bd-pop .bd-pop .bd-row', { hasText: 'Completed' }).first().click();
    await until(async () => (await page.locator('[data-testid="board-toast"]').count()) === 1, 6000);
    const toast = await page.locator('[data-testid="board-toast"]').innerText().catch(() => '');
    check(`${W} board (right-click): the refusal names the open sub-tasks`, /still has open sub-tasks:/.test(toast) && toast.includes('2. dalga: ekran') && !toast.includes('1. dalga') && !/Moved to/.test(toast), toast.replace(/\s+/g, ' '));
    await wait(600);
    check(`${W} board (right-click): the card stays in its column`, (await columnOf(PARENT)) === before && before === 'in_progress', `${before} → ${await columnOf(PARENT)}`);
    const toastBox = await page.locator('[data-testid="board-toast"]').boundingBox().catch(() => null);
    check(`${W} board: the toast fits the screen`, !toastBox || (toastBox.x >= 0 && toastBox.x + toastBox.width <= width), JSON.stringify(toastBox));
    await shot('refusal');
    await wait(6200);
    if (width === 1440) {
      const done = page.locator('[data-column="completed"]').first();
      await card(PARENT).dragTo(done).catch(() => {});
      const dragged = await until(async () => (await page.locator('[data-testid="board-toast"]').count()) === 1, 6000);
      const dragToast = dragged ? await page.locator('[data-testid="board-toast"]').innerText() : '';
      check(`${W} board (drag): the same refusal, the card back in its column`, /still has open sub-tasks:/.test(dragToast) && (await columnOf(PARENT)) === 'in_progress', dragToast.replace(/\s+/g, ' ') || 'no toast after the drag');
    }

    // The drawer's status select says the same.
    await openTask(PARENT);
    await page.locator('#tf-status').selectOption('completed');
    await until(async () => (await page.locator('.detail-error').count()) === 1, 6000);
    const derr = await page.locator('.detail-error').innerText().catch(() => '');
    check(`${W} drawer: the status select is refused with the open sub-tasks named`, /still has open sub-tasks:/.test(derr) && derr.includes('2. dalga: ekran'), derr);
    check(`${W} drawer: the select snaps back`, (await page.locator('#tf-status').inputValue()) === 'in_progress');
    await shot('drawer-refusal');
    await closeDrawer();

    check(`${W} no browser confirm()/alert() was called`, (await page.evaluate(() => window.__confirms)) === 0);
    const provoked = width === 1440 ? 3 : 2; // right-click, (drag), drawer select
    check(`${W} the only failed requests are the refusals provoked (409 × ${provoked})`, (expected409[width] ?? 0) === provoked, `${expected409[width] ?? 0}`);
    await context.close();
  }
} catch (e) {
  check('run finished', false, e.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '));
  if (failedRequests.length) console.log(`failed requests: ${failedRequests.slice(0, 5).join(' || ')}`);
  console.log(`screenshots: ${SHOTS}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  rmSync(home, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
