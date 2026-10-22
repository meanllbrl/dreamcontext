#!/usr/bin/env node
/**
 * The simplified Tasks screen, proven in the real app (task gorev-arayuzu…, AC1–AC18).
 *
 *   npm run build && npm run verify:task-ui
 *
 * Boots the BUILT dashboard against an isolated scratch vault (fake HOME, DREAMCONTEXT_DESKTOP=1)
 * seeded with FICTIONAL fixtures — a project called "Lumen Notes": a parent task with three
 * subtasks, a task with png + mp4 + pdf + txt + folder attachments, a task with a mermaid block
 * in Technical Details, one custom field, a saved view stored with layout 'list', and the OLD
 * default card properties — then drives Chromium and checks the DOM facts each criterion names.
 * Screenshots (1440px, light and dark) land in tmp/verify-task-ui/<name>-1440-{light,dark}.png.
 * OS hand-offs (`/api/agent/reveal`) are intercepted, so nothing opens on this Mac.
 *
 * FAILURE POLICY — collect, don't fail fast. Exit 1 on any FAIL or console error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = process.env.PORT || '4811';
const URL = `http://127.0.0.1:${PORT}`;
const SHOTS = join(REPO, 'tmp', 'verify-task-ui');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};

// ─── Scratch vault ───────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), 'dc-taskui-'));
const vaultDir = join(home, 'lumen');
const dc = join(vaultDir, '_dream_context');
const state = join(dc, 'state');
for (const d of [state, join(dc, 'overrides'), join(dc, 'knowledge', 'features'), join(home, '.dreamcontext')]) mkdirSync(d, { recursive: true });
writeFileSync(join(state, '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ version: 1, vaults: [{ name: 'lumen', path: vaultDir }] }, null, 2));

const feature = (slug, name) => writeFileSync(join(dc, 'knowledge', 'features', `${slug}.md`), `---\nname: ${name}\ntype: feature\nrelated_tasks: []\n---\n\n## Why\n\n${name} for Lumen Notes.\n`);
feature('checkout', 'Checkout');
feature('billing', 'Billing');
feature('sync', 'Offline sync');

// One project custom field (overrides/task.md).
writeFileSync(join(dc, 'overrides', 'task.md'), `---\ncustom_fields:\n  - name: Platform\n    key: platform\n    type: select\n    options: [macOS, iOS, Web]\n    sync: []\nstatuses:\n  - name: Cancelled\n    key: cancelled\n    kind: cancelled\n    order: 99\n---\n`);

const fm = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v === null ? 'null' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n');
const seed = (slug, front, body) => writeFileSync(join(state, `${slug}.md`), `---\n${fm({
  id: `task_${slug.slice(0, 8)}`, name: slug, description: '', priority: 'medium', urgency: 'medium', status: 'todo',
  created_at: '2026-10-10', updated_at: '2026-10-10', tags: [], parent_task: null, related_feature: null, version: null, ...front,
})}\n---\n\n${body}\n`);

const PARENT = 'redesign-the-checkout-flow';
seed(PARENT, { name: 'Redesign the checkout flow', status: 'in_progress', priority: 'high', related_feature: 'checkout', version: '1.4.0', tags: ['design', 'person:ada'] }, `## Why

Shoppers abandon the Lumen Notes upgrade at the card form; the checkout needs fewer steps and clearer errors.

## Acceptance Criteria

- [ ] AC1 The card form validates inline <!-- node:s1 -->
- [ ] AC2 The address step autocompletes
- [ ] AC3 A receipt email is sent
- [x] AC4 The total shows taxes
- [ ] AC5 Errors read in plain words
- [ ] AC6 The flow works with a keyboard only

## User Stories

- [ ] As a shopper I see the total before I pay
- [x] As a shopper I get a receipt

## Workflow

\`\`\`mermaid
flowchart LR
  s1[Validate card]:::todo
  s2[Autocomplete address]:::todo
  s3[Send receipt]:::todo
  s1 --> s2 --> s3
\`\`\`

## Constraints & Decisions

- **[2026-10-14]** Keep the old form behind a flag for one release.
- **[2026-10-13]** No third-party address service.
- **[2026-10-12]** Card numbers never leave the device unmasked.
- **[2026-10-11]** One page, not three.

## Technical Details

The form lives in the checkout module. Validation runs on blur.
Address autocomplete reads the local postcode table.
Receipt emails go through the existing mailer.
A fourth line so this section folds.

## Notes

Fixture markup the drawer must strip: <script>window.__xss = 1</script>
<img src="x" onerror="window.__xss = 2">
<iframe src="https://example.com/frame"></iframe>
[a script link](javascript:window.__xss=3) and ![api image](/api/health)
<img srcset="x.png 1x, /api/health 2x"> <table background="/api/health"><tr><td>t</td></tr></table>
<div style="position:fixed;inset:0;background:url(/api/health)">overlay</div>
<svg><image xlink:href="/api/health" width="1" height="1"/></svg>

## Changelog

### 2026-10-14 - Update
- Newest entry
### 2026-10-13 - Update
- Third entry
### 2026-10-12 - Update
- Second entry
### 2026-10-11 - Created
- Oldest entry`);
seed('card-form-validation', { name: 'Card form validation', status: 'completed', parent_task: PARENT, related_feature: 'checkout', version: '1.4.0' }, '## Why\n\nPart of Redesign the checkout flow.\n\n## Acceptance Criteria\n\n- [x] Inline errors\n- [x] Luhn check\n');
seed('address-autocomplete', { name: 'Address autocomplete', status: 'in_progress', parent_task: PARENT, related_feature: 'checkout', version: '1.4.0' }, '## Why\n\nPart of Redesign the checkout flow.\n');
seed('gift-wrap-option', { name: 'Gift wrap option', status: 'cancelled', parent_task: PARENT, related_feature: 'checkout', version: '1.4.0' }, '## Why\n\nPart of Redesign the checkout flow. Dropped.\n');
seed('receipt-email', { name: 'Receipt email', status: 'todo', parent_task: PARENT, related_feature: 'billing', version: '1.4.0' }, '## Why\n\nPart of Redesign the checkout flow.\n');
const MEDIA = 'offline-sync-for-drafts';
seed(MEDIA, { name: 'Offline sync for drafts', status: 'todo', related_feature: 'sync', version: '1.5.0' }, '## Why\n\nDrafts typed on a plane must not be lost.\n\n## Acceptance Criteria\n\n- [ ] Drafts survive a restart\n');
const MERMAID = 'search-index-rebuild';
seed(MERMAID, { name: 'Search index rebuild', status: 'in_review', version: '1.4.0' }, `## Why

The search index drifts after imports.

## Acceptance Criteria

- [ ] Rebuild runs in the background <!-- node:r1 -->
- [ ] Progress is visible

## Technical Details

\`\`\`mermaid
flowchart TD
  r1[Rebuild in background]:::todo
  r2[Show progress]:::todo
  r1 --> r2
\`\`\``);
seed('fix-login-timeout', { name: 'Fix login timeout', status: 'todo', priority: 'critical', due_date: '2026-10-01', start_date: '2026-09-20' }, '## Why\n\nSessions expire mid-sentence.\n');

// Attachments for the media task (state/assets/<slug>/ — local).
const assets = join(state, 'assets', MEDIA);
mkdirSync(join(assets, 'screens'), { recursive: true });
const ff = (args) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'ignore' }).status === 0;
const havePng = ff(['-f', 'lavfi', '-i', 'testsrc=size=640x400:rate=1', '-frames:v', '1', join(assets, 'airplane-mode.png')]);
const haveMp4 = ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-t', '2', '-pix_fmt', 'yuv420p', join(assets, 'sync-demo.mp4')]);
ff(['-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=1', '-frames:v', '1', join(assets, 'screens', 'before.png')]);
ff(['-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=1', '-frames:v', '1', join(assets, 'screens', 'after.png')]);
const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 40 100 Td (Sync spec) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;
writeFileSync(join(assets, 'sync-spec.pdf'), pdf);
writeFileSync(join(assets, 'field-notes.txt'), 'Notes from the flight test.\n');

// Board files: a saved view stored with layout 'list' (active), and the OLD default card props.
const OLD_PROPS = { description: true, tags: true, priority: true, urgency: true, due: true, rice: false, assignee: true, version: false };
const boardShared = { schema: 1, versions: [], cardProps: OLD_PROPS, views: [
  { id: 'all', name: 'All Tasks', removable: false, config: { layout: 'board' } },
  { id: 'oldlist', name: 'Old list view', removable: true, config: { layout: 'list', groupBy: 'priority', subGroupBy: 'version' } },
] };
writeFileSync(join(dc, 'overrides', 'board.json'), JSON.stringify(boardShared, null, 2));
writeFileSync(join(state, 'board.local.json'), JSON.stringify({ schema: 1, activeViewId: 'oldlist', theme: null, localViews: [], overrides: {}, cardProps: null }, null, 2));
const snap = (p) => { try { return { bytes: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs }; } catch { return null; } };
const boardBefore = { shared: snap(join(dc, 'overrides', 'board.json')), local: snap(join(state, 'board.local.json')) };
const taskFile = (slug) => readFileSync(join(state, `${slug}.md`), 'utf8');
const parentBefore = { bytes: taskFile(PARENT), mtime: statSync(join(state, `${PARENT}.md`)).mtimeMs };

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
let pageRef = null;
const consoleErrors = [];
const failedRequests = [];
const reveals = [];
try {
  if (!(await waitForServer())) {
    check('server boots', false, `no /api/health after 40s. log tail: ${serverLog.slice(-400)}`);
    throw new Error('server did not boot');
  }
  check('server boots', true);
  check('fixtures: png + mp4 generated', havePng && haveMp4, `png=${havePng} mp4=${haveMp4}`);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, URL);
  // Headless Chromium ships no built-in PDF viewer, so PdfViewer would (correctly) show its
  // "can't display PDFs" state and never frame the file. Report a viewer, so the frame and its
  // src are in the DOM to check; the bytes are then fetched and checked directly.
  await context.addInitScript(() => { try { Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { get: () => true, configurable: true }); } catch { /* read-only */ } });
  const page = await context.newPage();
  pageRef = page;
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { const u = r.url(); if (!/#t=|\.mp4/.test(u)) failedRequests.push(`${r.failure()?.errorText} ${u}`); });
  await page.route('**/api/agent/reveal', async (route) => {
    try { reveals.push(JSON.parse(route.request().postData() || '{}')); } catch { reveals.push({}); }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(150); } return false; };
  const shoot = async (name) => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await wait(700);
      await page.screenshot({ path: join(SHOTS, `${name}-1440-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await wait(300);
  };
  const dismiss = async () => { for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(400); } };
  const openBoard = async () => {
    await page.goto(`${URL}/?vault=lumen`, { waitUntil: 'networkidle' });
    await wait(1000);
    await dismiss();
    await page.locator('.sidebar-item', { hasText: 'Tasks' }).first().click();
    await until(async () => (await page.locator('.bd-card').count()) > 0, 15000);
    await wait(500);
  };
  const card = (slug) => page.locator(`.bd-card[data-task-slug="${slug}"]`).first();
  const closeDrawer = async () => { await page.keyboard.press('Escape'); await wait(400); if (await page.locator('.detail-overlay').count()) { await page.locator('.detail-overlay').click({ position: { x: 5, y: 5 } }).catch(() => {}); await wait(300); } };
  const openTask = async (slug) => { await card(slug).click(); await until(async () => (await page.locator('.detail-panel').count()) === 1); await wait(700); };

  await page.emulateMedia({ colorScheme: 'light' });

  // ── AC1 / AC3 / AC6 / AC7 — the board ───────────────────────────────────────
  await openBoard();
  const after = { shared: snap(join(dc, 'overrides', 'board.json')), local: snap(join(state, 'board.local.json')) };
  check('AC1 the saved view stored as "list" opens as the board', (await page.locator('[data-column]').count()) >= 4 && /Old list view/.test(await page.locator('body').innerText()));
  check('AC1 opening it rewrote neither overrides/board.json nor state/board.local.json',
    after.shared?.bytes === boardBefore.shared?.bytes && after.shared?.mtime === boardBefore.shared?.mtime
      && after.local?.bytes === boardBefore.local?.bytes && after.local?.mtime === boardBefore.local?.mtime);
  const bodyText = await page.locator('body').innerText();
  check('AC1 no view picker (Kanban/List/Eisenhower/Timeline/Calendar/Heatmap/RICE chips are gone)', !/View type|Eisenhower|Heatmap/.test(bodyText) && (await page.locator('button, [role=button]', { hasText: /^(Kanban|List|Timeline|Calendar)$/ }).count()) === 0);
  check('AC3 no Group chip', (await page.locator('[role=toolbar] >> text=/^Group$/').count()) === 0);
  for (const id of ['versions-chip', 'feature-chip', 'filter-chip', 'props-chip', 'new-task']) {
    const tag = await page.locator(`[data-testid="${id}"]`).first().evaluate((el) => el.tagName).catch(() => 'missing');
    check(`AC3 toolbar ${id} is a real <button>`, tag === 'BUTTON', tag);
  }
  check('AC3 the toolbar reads "Versions & Sprints"', /Versions & Sprints/.test(await page.locator('[role=toolbar]').innerText()));
  const overdue = page.locator('[data-testid="overdue-chip"]');
  check('AC3 the tab row carries an "N overdue" chip (the red banner is gone)', /^1 overdue$/.test((await overdue.innerText().catch(() => '')).trim()) && (await page.locator('text=Attention').count()) === 0, await overdue.innerText().catch(() => 'none'));
  // Column counts equal the cards drawn; children of a visible parent are not cards.
  let countsOk = true; const countDetail = [];
  for (const col of await page.locator('[data-column]').all()) {
    const shown = await col.locator('.bd-card').count();
    const label = Number((await col.locator('.bd-col-count').innerText()).trim());
    countDetail.push(`${await col.getAttribute('data-column')}:${label}/${shown}`);
    if (shown !== label) countsOk = false;
  }
  check('AC6 column counts equal the cards shown', countsOk, countDetail.join(' '));
  check('AC6 a child of a visible parent is not drawn as its own card', (await card('card-form-validation').count()) === 0 && (await card('address-autocomplete').count()) === 0 && (await card('gift-wrap-option').count()) === 0);
  const subChip = card(PARENT).locator('[data-testid="subtask-chip"]');
  check('AC6 the parent card shows "n/m" (done / not cancelled — the cancelled child is not counted) with a bar', /1\/3/.test(await subChip.innerText().catch(() => '')) && (await subChip.locator('.bd-sub-bar').count()) === 1, await subChip.innerText().catch(() => 'none'));
  check('AC7 card shows feature, criteria count, priority chip and the Versions & Sprints chip',
    /Checkout/.test(await card(PARENT).innerText()) && /✓ 1\/6/.test(await card(PARENT).innerText())
      && (await card(PARENT).locator('.bd-prio-chip').count()) === 1 && (await card(PARENT).locator('.bd-ver-chip').count()) === 1);
  check('AC7 old-default card props read as the new defaults (no tags or description on cards)', (await page.locator('.bd-card .bd-tag').count()) === 0);
  const clip = card(MEDIA).locator('[data-testid="card-clip"]');
  check('AC7 a task with assets shows the clip, its count and a first-image thumbnail', /5/.test(await clip.innerText().catch(() => '')) && (await clip.locator('img.bd-clip-cover').count()) === 1, await clip.innerText().catch(() => 'none'));
  await shoot('board');

  // Expanded subtasks + "+ Add subtask".
  await subChip.click();
  await until(async () => (await page.locator('[data-testid="board-subtasks"]').count()) === 1);
  const rows = await page.locator('[data-testid="board-subtasks"] .bd-sub-row').allInnerTexts();
  check('AC6 the chip opens a thin list: status dot + name per child', rows.length === 4 && rows.some((r) => /Receipt email/.test(r)), rows.join(' | '));
  check('AC6 the chip says it is expanded', (await subChip.getAttribute('aria-expanded')) === 'true');
  await page.locator('[data-testid="board-subtasks"] .bd-sub-add').click();
  await page.keyboard.type('Tax line in receipt');
  await page.keyboard.press('Enter');
  const newSlug = 'tax-line-in-receipt';
  check('AC6 Enter creates the subtask via POST with parent_task (inherits version + feature)',
    await until(async () => existsSync(join(state, `${newSlug}.md`)) && /parent_task: redesign-the-checkout-flow/.test(taskFile(newSlug)), 8000),
    existsSync(join(state, `${newSlug}.md`)) ? taskFile(newSlug).split('---')[1]?.replace(/\n/g, ' ').slice(0, 220) : 'no file');
  if (existsSync(join(state, `${newSlug}.md`))) check('AC6 the new subtask inherited version 1.4.0 and feature checkout', /version: 1\.4\.0/.test(taskFile(newSlug)) && /related_feature: checkout/.test(taskFile(newSlug)));
  await page.keyboard.press('Escape');
  await wait(300);
  check('AC6 Esc closes the add input', (await page.locator('.bd-sub-input').count()) === 0);
  await until(async () => /1\/4/.test(await subChip.innerText()), 6000);
  await shoot('subtasks-expanded');

  // A child whose parent is filtered out: a card with "↑ parent".
  await page.locator('[data-testid="feature-chip"]').click();
  await page.locator('[role=menu] button', { hasText: /^Billing/ }).first().click();
  await wait(700);
  check('AC6 a child whose parent is filtered out is a card with "↑ parent name"', /↑ Redesign the checkout flow/.test(await card('receipt-email').innerText().catch(() => '')));
  check('AC3 the Feature chip filters on related_feature', (await page.locator('.bd-card').count()) === 1);
  await page.locator('[data-testid="feature-chip"]').click();
  await page.locator('[role=menu] button', { hasText: /^All/ }).first().click();
  await wait(500);
  // Overdue chip applies the at-risk filter.
  await overdue.click();
  await wait(700);
  check('AC3 clicking the overdue chip applies the at-risk filter', (await page.locator('.bd-card').count()) === 1 && (await card('fix-login-timeout').count()) === 1);
  // Versions & Sprints: single-pick filter + Manage versions.
  await page.locator('[data-testid="filter-chip"]').click();
  await page.locator('.bd-pop button', { hasText: 'Clear all' }).first().click().catch(() => {});
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="versions-chip"]').click();
  check('AC3 the Versions & Sprints chip offers Manage versions', (await page.locator('[data-testid="manage-versions"]').count()) === 1);
  await page.locator('[role=menu] button', { hasText: /^1\.5\.0/ }).first().click();
  await wait(600);
  check('AC7 with a single version filtered, cards drop the version chip', (await page.locator('.bd-card .bd-ver-chip').count()) === 0 && (await page.locator('.bd-card').count()) >= 1);
  await page.locator('[data-testid="versions-chip"]').click();
  await page.locator('[role=menu] button', { hasText: /^All/ }).first().click();
  await wait(500);
  // Sort lives in the Filter popover.
  await page.locator('[data-testid="filter-chip"]').click();
  check('AC3 Sort lives inside the Filter popover', (await page.locator('.bd-pop button', { hasText: /^Sort/ }).count()) === 1);
  await page.keyboard.press('Escape');
  await wait(200);
  check('AC3 Esc closes a toolbar menu', (await page.locator('.bd-pop').count()) === 0);

  // ── AC8 / AC9 — the drawer ──────────────────────────────────────────────────
  await openBoard();
  await openTask(PARENT);
  const panelBox = await page.locator('.detail-panel').boundingBox();
  check('AC8 the drawer is ~980px with a main column and a Properties column', panelBox && panelBox.width > 930 && panelBox.width < 1000 && (await page.locator('.detail-panel .props-col').count()) === 1, panelBox ? `${Math.round(panelBox.width)}px` : 'none');
  check('AC8 the header crumb names the feature', /Checkout/.test(await page.locator('.detail-crumb').innerText()));
  check('AC8 one "Give to agent" button', (await page.locator('[data-testid="give-to-agent"]').count()) === 1 && /Give to agent/.test(await page.locator('[data-testid="give-to-agent"]').innerText()));
  check('AC8 the old Ownership "Assign to agent" buttons are gone', (await page.locator('.task-agent-btn').count()) === 0);
  check('AC9 Status, Priority, Versions & Sprints and Feature are always visible', (await page.locator('.props-col #tf-status').count()) === 1 && (await page.locator('.props-col #tf-priority').count()) === 1 && (await page.locator('.props-col #tf-version').count()) === 1 && /Feature/.test(await page.locator('.props-col').innerText()));
  const more = page.locator('[data-testid="props-more"]');
  check('AC9 More is collapsed by default', (await more.getAttribute('aria-expanded')) === 'false' && (await page.locator('#tf-urgency').count()) === 0);
  await shoot('detail-top');
  await page.locator('[data-testid="give-to-agent"]').click();
  check('AC8 Give to agent opens a menu (AI Team agents / New Claude chat)', (await page.locator('.gta-menu').count()) === 1 && /AI Team/i.test(await page.locator('.gta-menu').innerText()));
  await page.keyboard.press('Escape');
  await wait(300);
  check('AC8 Esc closes the menu, not the drawer', (await page.locator('.gta-menu').count()) === 0 && (await page.locator('.detail-panel').count()) === 1);
  await more.click();
  await wait(400);
  const propsText = await page.locator('.props-col').textContent();
  check('AC9 More holds Prioritization (Urgency, RICE, Objectives), Plan (Start, Due, Parent task, Assignees, Tags, Summary), Custom fields and System',
    ['Prioritization', 'Urgency', 'RICE', 'Objectives', 'Plan', 'Start', 'Due', 'Parent task', 'Assignees', 'Tags', 'Summary', 'System', 'Created', 'Updated', 'ID'].every((w) => propsText.includes(w))
      && (await page.locator('.rice-box').count()) === 4 && (await page.locator('[data-testid="task-delete"]').count()) === 1, propsText.replace(/\s+/g, ' ').slice(0, 200));
  check('AC9 the custom field shows with "+ Add field"', /Platform/.test(propsText) && /\+ Add field/.test(propsText));
  await page.locator('.acf-add-btn', { hasText: '+ Add field' }).click();
  check('AC9 Add field says it reaches every task in the project', /Adds this field to every task in this project/.test(await page.locator('.props-col').innerText()));
  await page.locator('.acf-form button', { hasText: /Cancel/ }).first().click().catch(() => {});
  // AC2 — the tag chip keeps its colour (the palette moved to an always-loaded stylesheet).
  const tagBg = await page.locator('.props-col .task-tag').first().evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => 'none');
  check('AC2 a tag chip in the detail keeps its hue colour', tagBg && !/rgba\(0, 0, 0, 0\)|transparent|none/.test(tagBg), tagBg);
  await shoot('more-open');
  // Remembered across a reopen.
  await closeDrawer();
  await openTask(PARENT);
  check('AC9 More stays open once opened (remembered)', (await page.locator('[data-testid="props-more"]').getAttribute('aria-expanded')) === 'true');

  // ── AC10 / AC11 / AC16 — body sections ──────────────────────────────────────
  const order = await page.locator('.dbody [data-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));
  const want = ['why', 'subtasks', 'acceptance_criteria', 'media', 'user_stories', 'workflow', 'constraints', 'technical_details', 'notes', 'changelog'];
  check('AC10 sections render in the approved order', JSON.stringify(order) === JSON.stringify(want), order.join(','));
  const consText = await page.locator('[data-section="constraints"]').innerText();
  check('AC10 Constraints & Decisions shows the latest 3 + "All 4"', (await page.locator('[data-section="constraints"] .dlog-row').count()) === 3 && /All 4/.test(consText));
  check('AC10 Changelog shows the latest 3 + "All 4" + Add entry', (await page.locator('[data-section="changelog"] .dlog-row').count()) === 3 && /All 4/.test(await page.locator('[data-section="changelog"]').innerText()) && (await page.locator('[data-testid="add-changelog"]').count()) === 1);
  check('AC10 Technical Details and Notes start folded', (await page.locator('[data-section="technical_details"] .dfold:not([data-open])').count()) === 1 && (await page.locator('[data-section="notes"] .dfold:not([data-open])').count()) === 1);
  await page.locator('[data-section="notes"] .dfold-toggle').click();
  await wait(300);
  const xss = await page.evaluate(() => ({
    flag: window.__xss ?? null,
    iframes: document.querySelectorAll('.detail-panel iframe').length,
    jsLinks: document.querySelectorAll('.detail-panel a[href^="javascript"]').length,
    apiImgs: document.querySelectorAll('.detail-panel img[src^="/api/"]').length,
    onerror: document.querySelectorAll('.detail-panel [onerror]').length,
    scripts: document.querySelectorAll('.detail-panel script').length,
    srcset: [...document.querySelectorAll('.detail-panel [srcset]')].filter((e) => /\/api\//.test(e.getAttribute('srcset'))).length,
    background: document.querySelectorAll('[data-section="notes"] [background]').length,
    style: document.querySelectorAll('[data-section="notes"] .markdown-body [style]').length,
    xlink: [...document.querySelectorAll('[data-section="notes"] image')].filter((e) => /\/api\//.test(e.getAttribute('xlink:href') || e.getAttribute('href') || '')).length,
  }));
  check('AC10 body HTML is sanitized (script, iframe, on* handlers, javascript: and /api/ urls stripped)', xss.flag === null && !xss.iframes && !xss.jsLinks && !xss.apiImgs && !xss.onerror && !xss.scripts && !xss.srcset && !xss.background && !xss.style && !xss.xlink, JSON.stringify(xss));
  const wfSvg = page.locator('[data-section="workflow"] .mermaid-stage > svg');
  const wfOk = await until(async () => (await wfSvg.count()) === 1, 10000);
  const wfDebug = await page.locator('[data-section="workflow"]').evaluate((el) => `stage-svg=${el.querySelectorAll('.mermaid-stage > svg').length} any-svg=${el.querySelectorAll('svg').length} wraps=${el.querySelectorAll('.mermaid-rendered').length} ctrl=${el.querySelectorAll('.mermaid-controls button').length} raw=${el.querySelectorAll('pre > code.language-mermaid').length}`).catch((e) => String(e));
  check('AC16 the Workflow mermaid renders as an SVG with zoom controls', wfOk && (await page.locator('[data-section="workflow"] .mermaid-controls button').count()) === 3, wfDebug);
  // Tick the criterion linked to node s1, then two more rapidly.
  const box = (i) => page.locator(`[data-section="acceptance_criteria"] input[data-criterion-index="${i}"]`);
  await box(0).click();
  const linked = await until(async () => /- \[x\] AC1 The card form validates inline/.test(taskFile(PARENT)) && /s1\[Validate card\]:::done/.test(taskFile(PARENT)), 8000);
  check('AC11/AC16 ticking a linked criterion flips that line and its mermaid node', linked);
  // The race the serialization exists for: every PATCH invalidates the task list, and a slow
  // refetch carrying an OLDER body lands in the middle of a burst of ticks.
  await until(async () => (await box(0).isChecked()), 4000);
  await page.route('**/api/tasks', async (route) => { if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
  await box(1).click();
  await wait(350);
  await box(2).click();
  await wait(1100);
  check('AC11 a tick does not visibly undo itself when an older refetch lands', await box(2).isChecked().catch(() => false));
  await box(4).click();
  const rapid = await until(async () => /- \[x\] AC2 /.test(taskFile(PARENT)) && /- \[x\] AC3 /.test(taskFile(PARENT)) && /- \[x\] AC5 /.test(taskFile(PARENT)), 12000);
  await page.unroute('**/api/tasks');
  check('AC11 rapid toggles across a mid-burst refetch are serialized (no lost update)', rapid && /- \[x\] AC1 /.test(taskFile(PARENT)), taskFile(PARENT).split('\n').filter((l) => /AC\d /.test(l)).join(' | '));
  check('AC11 User Stories and the fenced lines were not touched', /- \[ \] As a shopper I see the total/.test(taskFile(PARENT)));
  await until(async () => (await wfSvg.count()) === 1, 8000);
  await page.locator('[data-section="workflow"]').scrollIntoViewIfNeeded();
  await wait(600);
  await shoot('mermaid');
  await page.locator('[data-section="constraints"]').scrollIntoViewIfNeeded();
  await shoot('body-sections');
  check('AC10 "Show all" appears for more than 5 criteria', /Show all 6/.test(await page.locator('[data-section="acceptance_criteria"]').innerText()));

  // Subtask detail: crumb to the parent.
  await page.locator('[data-section="subtasks"] .dsub-row', { hasText: 'Address autocomplete' }).click();
  await wait(700);
  check('AC8 a subtask shows "↑ parent · n/m" in its crumb', /↑\s*Redesign the checkout flow\s*1\/4/.test((await page.locator('[data-testid="crumb-parent"]').innerText().catch(() => '')).replace(/\s+/g, ' ')));
  await page.locator('[data-testid="crumb-parent"]').click();
  await wait(600);
  check('AC8 clicking the crumb opens the parent', /Redesign the checkout flow/.test(await page.locator('.detail-title').innerText()));
  await closeDrawer();

  // Mermaid in Technical Details (another task).
  await openTask(MERMAID);
  await page.locator('[data-section="technical_details"] .dfold-toggle').click();
  check('AC16 a mermaid block in Technical Details renders too', await until(async () => (await page.locator('[data-section="technical_details"] .mermaid-stage > svg').count()) === 1, 10000));
  await closeDrawer();

  // ── AC12 / AC13 / AC14 — media ──────────────────────────────────────────────
  await openTask(MEDIA);
  const media = page.locator('[data-testid="media-section"]');
  await until(async () => (await media.locator('.dmedia-tile').count()) >= 5, 8000);
  const kinds = await media.locator('.dmedia-tile[data-kind]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  check('AC12 the grid lists png, mp4, pdf, txt and the folder (with its count)', ['image', 'video', 'pdf', 'file'].every((k) => kinds.includes(k)) && /screens\/\s*2 files/.test((await media.locator('.dmedia-tile--folder').innerText()).replace(/\s+/g, ' ')), kinds.join(','));
  const imgSrc = await media.locator('.dmedia-tile--image img').getAttribute('src');
  check('AC12 tiles load bytes from the raw route with ?vault=', /\/api\/tasks\/offline-sync-for-drafts\/assets\/raw\?path=.*&vault=lumen/.test(imgSrc ?? ''), imgSrc);
  check('AC14 a .txt tile fetches no bytes (no <img>/<video> for it)', (await media.locator('.dmedia-tile[data-kind="file"] img, .dmedia-tile[data-kind="file"] video').count()) === 0);
  await media.scrollIntoViewIfNeeded();
  await shoot('media-grid');

  // Drag overlay, then drop.
  await media.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped bytes'], 'dropped-note.txt', { type: 'text/plain' }));
    window.__dt = dt;
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await wait(300);
  check('AC13 dragging a file in shows the dashed overlay with honest copy', (await page.locator('[data-testid="media-drop-overlay"]').count()) === 1 && /Saved to this task's assets folder/.test(await page.locator('[data-testid="media-drop-overlay"]').innerText()) && !/in git/i.test(await page.locator('[data-testid="media-drop-overlay"]').innerText()));
  await shoot('drag-overlay');
  await media.evaluate((el) => { el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); });
  check('AC13 a dropped file is uploaded into state/assets/<slug>/', await until(async () => existsSync(join(assets, 'dropped-note.txt')), 8000));
  // Browse — with the upload held for a moment, so the progress tile is on screen to check.
  await page.route('**/api/tasks/*/assets?name=*', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
  await page.locator('[data-testid="media-input"]').setInputFiles({ name: 'browsed.txt', mimeType: 'text/plain', buffer: Buffer.from('browsed') });
  check('AC13 an upload shows a progress tile', await until(async () => (await page.locator('[data-testid="media-progress"]').count()) === 1, 3000));
  await shoot('upload-progress');
  await page.unroute('**/api/tasks/*/assets?name=*');
  check('AC13 Browse uploads a file', await until(async () => existsSync(join(assets, 'browsed.txt')), 8000));
  // ⌘V paste of an image.
  const pngBytes = readFileSync(join(assets, 'airplane-mode.png')).toString('base64');
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], 'image.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, pngBytes);
  const pasted = await until(async () => readdirSync(assets).some((n) => /^paste-\d{8}-\d{6}-\d{3}\.png$/.test(n)), 8000);
  check('AC13 ⌘V pastes an image as paste-YYYYMMDD-HHMMSS-mmm.png', pasted, readdirSync(assets).filter((n) => n.startsWith('paste-')).join(','));
  check('AC13 no partial .upload-* file is left', !readdirSync(assets).some((n) => n.startsWith('.upload-')));
  check('AC13 the grid refreshed with the new files', await until(async () => /browsed\.txt/.test(await media.innerText()), 6000));
  const listed = await (await fetch(`${URL}/api/tasks`, { headers: { 'X-Dreamcontext-Vault': 'lumen' } })).json();
  const att = listed.tasks.find((t) => t.slug === MEDIA)?.attachments;
  check('AC13 the card count follows (GET /api/tasks attachments)', att?.count === 8, JSON.stringify(att));
  // A cross-site upload is refused like every other write.
  const cross = await fetch(`${URL}/api/tasks/${MEDIA}/assets?name=evil.png`, { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Dreamcontext-Vault': 'lumen', 'Content-Type': 'application/octet-stream' }, body: 'x' });
  check('AC13 a cross-site upload is refused', cross.status === 403 && !existsSync(join(assets, 'evil.png')), String(cross.status));

  // Viewer: image → next → …, pdf, txt.
  await media.locator('.dmedia-tile--image').first().click();
  check('AC14 an image opens the full-screen viewer', await until(async () => (await page.locator('.image-viewer').count()) === 1, 6000));
  check('AC14 the desktop viewer shows Open on computer / Reveal in Finder / Copy path', /Open on computer/.test(await page.locator('.image-viewer').innerText()) && /Reveal in Finder/.test(await page.locator('.image-viewer').innerText()));
  await shoot('image-viewer');
  await page.locator('.image-viewer button[aria-label="Next file"]').first().click();
  await wait(500);
  check('AC14 next moves across the task\'s media', (await page.locator('[data-testid="media-viewer"], .image-viewer').count()) === 1);
  // Jump to the PDF and the txt through the tiles.
  await page.keyboard.press('Escape');
  await wait(400);
  if (await page.locator('[data-testid="media-viewer"], .image-viewer').count()) { await page.keyboard.press('Escape'); await wait(400); }
  await media.locator('.dmedia-tile[data-kind="video"]').first().click();
  check('AC14 video plays through MediaEmbed', await until(async () => (await page.locator('[data-testid="media-viewer"] video.mv-video').count()) === 1, 6000));
  await page.locator('.mv-close').click();
  await media.locator('.dmedia-tile[data-kind="pdf"]').first().click();
  const frame = page.locator('[data-testid="media-pdf"] iframe');
  await until(async () => (await frame.count()) === 1, 8000);
  const frameSrc = await frame.getAttribute('src').catch(() => null);
  let pdfOk = false; let pdfInfo = 'no frame';
  if (frameSrc) {
    const r = await fetch(new globalThis.URL(frameSrc, URL));
    pdfInfo = `${r.status} ${r.headers.get('content-type')} csp=${r.headers.get('content-security-policy')}`;
    pdfOk = r.status === 200 && r.headers.get('content-type') === 'application/pdf' && !r.headers.get('content-security-policy');
  }
  check('AC14 the PDF frame src answers 200 application/pdf (no sandbox CSP)', pdfOk, pdfInfo);
  await wait(1200);
  await shoot('pdf-viewer');
  await page.locator('.mv-close').click();
  await media.locator('.dmedia-tile[data-kind="file"]', { hasText: 'field-notes.txt' }).first().click();
  await until(async () => (await page.locator('.mv-file').count()) === 1, 6000);
  check('AC14 another file shows its name and size', /field-notes\.txt/.test(await page.locator('.mv-file').innerText()) && /B/.test(await page.locator('.mv-file-size').innerText()));
  reveals.length = 0;
  await page.locator('[data-testid="media-viewer"] .mv-head .chat-btn', { hasText: 'Open on computer' }).click();
  await until(async () => reveals.length > 0, 4000);
  check('AC14 Open on computer on a .txt sends mode "reveal" (never launched)', reveals[0]?.mode === 'reveal', JSON.stringify(reveals[0] ?? null));
  await page.locator('.mv-close').click();
  await media.locator('.dmedia-tile[data-kind="pdf"]').first().click();
  await until(async () => (await frame.count()) === 1, 6000);
  reveals.length = 0;
  await page.locator('[data-testid="media-viewer"] .mv-head .chat-btn', { hasText: 'Open on computer' }).click();
  await until(async () => reveals.length > 0, 4000);
  check('AC14 Open on computer on a PDF sends mode "auto"', reveals[0]?.mode === 'auto', JSON.stringify(reveals[0] ?? null));
  await page.locator('.mv-close').click();
  await closeDrawer();

  // ── AC15 — regressions: drag between columns, create, delete; opening never rewrites ──
  await openBoard();
  const loginCard = card('fix-login-timeout');
  const target = page.locator('[data-column="in_review"]');
  await loginCard.dragTo(target);
  check('AC15 dragging a card to another column changes its status', await until(async () => /status: in_review/.test(taskFile('fix-login-timeout')), 8000));
  await page.locator('[data-testid="new-task"]').click();
  await wait(500);
  check('AC15 + New Task opens the create modal', (await page.locator('.modal').count()) >= 1);
  await page.locator('.modal .modal-close').first().click().catch(() => {});
  await wait(300);
  // The new subtask is folded into its parent's card: open it from the parent's Subtasks section.
  await openTask(PARENT);
  await page.locator('[data-section="subtasks"] .dsub-row', { hasText: 'Tax line in receipt' }).click();
  await wait(700);
  if ((await page.locator('[data-testid="props-more"]').getAttribute('aria-expanded')) !== 'true') await page.locator('[data-testid="props-more"]').click();
  await page.locator('[data-testid="task-delete"]').click();
  await until(async () => (await page.locator('[data-confirm-dialog]').count()) === 1, 4000);
  await page.locator('[data-confirm-dialog] button', { hasText: /^Delete$/ }).click().catch(() => {});
  check('AC15 Delete task (under More › System) deletes after the in-app confirmation', await until(async () => !existsSync(join(state, `${newSlug}.md`)), 8000));

  // Opening a task never rewrites it: a fresh task opened and closed keeps its bytes.
  const quiet = join(state, `${MERMAID}.md`);
  const qBefore = { bytes: readFileSync(quiet, 'utf8'), mtime: statSync(quiet).mtimeMs };
  await openBoard();
  await openTask(MERMAID);
  await wait(1200);
  await closeDrawer();
  const qAfter = { bytes: readFileSync(quiet, 'utf8'), mtime: statSync(quiet).mtimeMs };
  check('AC15 opening a task never rewrites its file', qBefore.bytes === qAfter.bytes && qBefore.mtime === qAfter.mtime);
  void parentBefore;

  check('AC18 no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '));
  if (failedRequests.length) console.log(`note: failed requests: ${failedRequests.slice(0, 6).join(' || ')}`);
} catch (err) {
  check('harness ran to the end', false, err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' ') : String(err));
  if (consoleErrors.length) console.log(`console errors so far: ${consoleErrors.slice(0, 5).join(' || ')}`);
  if (pageRef) { await pageRef.screenshot({ path: join(SHOTS, 'harness-failure.png') }).catch(() => {}); console.log(`failure url: ${pageRef.url()}`); }
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`); }
process.exit(failed.length ? 1 : 0);
