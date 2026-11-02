#!/usr/bin/env node
/**
 * Every AI Team member IS a Super Agent (plan-r10 Wave 3, AC2, AC7, AC9, AC15, AC16, AC18, AC22):
 * one Ekip row per project, its list with the on/off switch, the Global ekip row, the New chat
 * menu, a member's own stage with two children, a task's face landing on the task strip, the
 * approval band, "Üyeleri yönet", and the phone's rows and sheet.
 *
 *   npm run build && node scripts/verify/super-members.mjs            (ENGINES=chromium)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1, Mac mode over the loopback
 * stand-in tunnel for the phone), the real dashboard and chat WebSockets, real members made with
 * `dreamcontext agents create`, and the real CLI run from INSIDE each Super's own process.
 * `claude` is a scripted stand-in (lib/super-scratch.mjs, no tokens spent) that plays main Super,
 * each member's Super (`mode: 'super'` + its chatAgent, DREAMCONTEXT_MEMBER_SUPER=<slug>) and
 * their children.
 *
 * Fixture (fictional names, pattern synthetic-fixtures-for-published-artifacts): project
 * acme-storefront; members Rota (asks the owner a question), Mira (two live children from two
 * `super delegate`), Pera (works only for main: main's `team ask` request, so "Super için"), Kip
 * (turned off), Gantt (reviewer of Rota's task, idle); one global member Ada
 * (~/.dreamcontext/agents/ada.md in the scratch HOME) with a hand edit after its approval (a
 * hash mismatch: its one approval card waits); task set-the-annual-plan-price: doer Rota,
 * reviewer Gantt.
 *
 *   (a) ONE Ekip row (`drawer-team-row`) with faces and one count = owner-facing questions +
 *       owner unread + approval cards of the project's members (from summary=1 `members`).
 *   (b) its list (`team-list`): Rota first, Mira before Pera, Pera "Super için" with no count, Kip
 *       "Kapalı", no global member; Kip's switch (`team-member-switch`) turns it on through
 *       POST /api/agents/kip/enabled and back off.
 *   (c) the Global ekip row (`drawer-global-team-row`) below every project, Ada in it, its count
 *       taking Ada's card once; its list (`global-team-list`) names the project.
 *   (d) the New chat menu (`new-chat-menu` -> `new-chat-claude`, `new-chat-member`): Mira twice is
 *       the same session (one member Super process); Claude opens a plain new chat.
 *   (e) Mira's stage (`super-surface[data-super-id="m:mira"]`, `super-member-name`) with its two
 *       children's cards, which do not overlap; the stage header's buttons do not overlap (1920,
 *       1440 and 390). Stage shots at 390 close the drawer first (there it is a sheet over the stage).
 *   (f) the task's face (`task-agent-face[data-slug=rota]`) lands on Rota's stage with
 *       `super-task-strip[data-task=<slug>]`; a message sent there reaches Rota's Super with
 *       `[About task <slug>]` (read in the stand-in's stdin).
 *   (g) Ada's stage shows `member-approval-band` and `member-project-chip`.
 *   (h) "Üyeleri yönet" (`team-manage`) opens `manage-members-modal`, with no chat pane inside.
 *   (i) phone 390: `phone-team-row` and `phone-global-team-row`; the sheet (`phone-team-sheet`)
 *       opens a member's stage.
 *   (j) main's stage unchanged: the Super Agent row still opens main.
 *   Console errors and failed requests are recorded per page: any is a FAIL.
 *
 * Screenshots: tmp/verify/super-members/<nn>-<what>-<width>-<theme>.png (1440 and 390, light and
 * dark; the phone at 390 only). Exit non-zero on any FAIL; prints 'N passed M failed'.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { closeDrawer, drawerShown, openDrawer } from './lib/phone-shell.mjs';
import {
  applyTheme, cleanEnv, freePort, openMember, pageFetch, readJson, readNd, reporter, sayOnStage, stage,
  stageComposer, startServer, superStandin, toMainStage, until, watchPage,
} from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-members-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify', 'super-members');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const MEMBERS_DIR = join(PROJ, '_dream_context', 'state', '.super', 'members');
const TASK = 'set-the-annual-plan-price';
const ENGINES = (process.env.ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const THEMES = ['light', 'dark'];
const SIZES = [[1440, 900], [390, 844]];

const MEMBERS = [
  ['rota', 'Rota', 'Fiyat ve paket kararlarını verir.'],
  ['mira', 'Mira', 'Pazarlama kampanyalarını yazar.'],
  ['pera', 'Pera', 'Rakip analizini yapar.'],
  ['kip', 'Kip', 'Destek yanıtlarını yazar.'],
  ['gantt', 'Gantt', 'Proje planını tutar ve teslimleri gözden geçirir.'],
];

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
    if (text.startsWith('[super')) { report({ kind: 'main-event', text: text.slice(0, 3000) }); return 'noted'; }
    if (text.includes('GO-PERA')) {
      const step = cli('super', 'team', 'ask', 'pera', 'Rakiplerin yıllık plan fiyatlarını çıkar.', '--brief', 'Rakip fiyatları');
      report({ kind: 'team', step });
      return 'Pera\\'ya verdim.';
    }
    return 'ok';`,
  member: `
    const req = /- item=(\\S+) event=request/.exec(text);
    if (req) { report({ kind: 'request-delivered', slug, item: req[1] }); return 'Rakip fiyatlarına bakıyorum.'; }
    if (text.includes('GO-ASK')) {
      const step = cli('super', 'ask', 'Yıllık planda indirim yüzde kaç olsun?', '--options', '%10|%20', '--no-show');
      report({ kind: 'ask', slug, step });
      return 'Sana bir soru sordum.';
    }
    if (text.includes('GO-TWO')) {
      const steps = [
        cli('super', 'delegate', '--prompt', 'MIRA-CHILD Kampanya taslağı bir', '--brief', 'Taslak bir'),
        cli('super', 'delegate', '--prompt', 'MIRA-CHILD Kampanya taslağı iki', '--brief', 'Taslak iki'),
      ];
      report({ kind: 'two', slug, steps });
      return 'İki taslağı başlattım.';
    }
    if (text.includes('[About task')) { report({ kind: 'about-task', slug, text: text.slice(0, 2000) }); return 'Görevi okudum.'; }
    return 'ok';`,
  // Mira's children hold their turn: two live, working children for the stage's two cards.
  child: `if (text.includes('MIRA-CHILD')) return null; return 'ok';`,
});

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const reports = () => readNd(REPORTS);
const memberRecord = (slug) => readJson(join(MEMBERS_DIR, `${slug}.json`), null);
const { result, ok, summary } = reporter();

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const steps = [['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })]];
  for (const [slug, title, prompt] of MEMBERS) steps.push([`agent ${slug}`, dc('agents', 'create', slug, '--title', title, '--prompt', prompt)]);
  steps.push(['global ada', dc('agents', 'create', 'ada', '--scope', 'global', '--title', 'Ada', '--prompt', 'Reklam bütçesini bütün projelerde izler.')]);
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  // A change Ada's owner never stamped (a hand edit after its approval): its one card waits.
  appendFileSync(join(HOME, '.dreamcontext', 'agents', 'ada.md'), 'Haftalık özet de yazar.\n');
  // The task: doer Rota, reviewer Gantt, starting tomorrow (nothing runs).
  writeFileSync(join(PROJ, '_dream_context', 'state', `${TASK}.md`), [
    '---', 'id: task_annualplan', 'name: Set the annual plan price', 'description: Set the annual plan price',
    'priority: high', 'urgency: medium', 'status: todo', "created_at: '2026-11-01'", "updated_at: '2026-11-01'",
    'tags: []', 'parent_task: null', 'related_feature: null', '---', '', '## Why', '', 'The annual plan has no price yet.', '',
    '## Changelog', '', '',
  ].join('\n'));
  const assign = dc('tasks', 'assign-agent', TASK, 'rota', '--reviewer', 'gantt', '--at', new Date(Date.now() + 86_400_000).toISOString());
  if (assign.status !== 0) throw new Error(`assign-agent failed: ${assign.stderr || assign.stdout}`);
}

const taken = [];
/** One check's pictures: 1440 and 390 (or `sizes`), light and dark; `prepare` re-opens what a
 *  resize closed (a popover, the drawer at 390). */
async function shots(page, nn, what, prepare, sizes = SIZES, rest = [1440, 900]) {
  for (const [w, h] of sizes) for (const theme of THEMES) {
    await page.setViewportSize({ width: w, height: h });
    await applyTheme(page, theme);
    await page.waitForTimeout(700);
    if (prepare) await prepare(w).catch(() => {});
    await page.waitForTimeout(500);
    const file = join(OUT, `${nn}-${what}-${w}-${theme}.png`);
    await page.screenshot({ path: file }).catch(() => {});
    taken.push(file);
  }
  await applyTheme(page, 'light');
  if (rest) await page.setViewportSize({ width: rest[0], height: rest[1] }).catch(() => {});
  await page.waitForTimeout(500);
}

/** The drawer on screen (at 390 it is a toggle). */
async function ensureDrawer(page) {
  if (await page.locator('[data-testid="drawer-team-row"]:visible, [data-testid="drawer-global-team-row"]:visible').count()) return;
  if (await page.getByTestId('ns-drawer-toggle').count()) await openDrawer(page).catch(() => {});
}

/** A stage shot at 390: the drawer is a sheet over the stage there, so it is closed first
 *  (and waited out) to show the stage itself. At desktop widths the drawer sits beside it. */
async function stageOnly(page, w) {
  if (w > 600) return;
  for (let i = 0; i < 3 && await drawerShown(page); i++) { await closeDrawer(page).catch(() => {}); await page.waitForTimeout(400); }
  await until(page, async () => !(await drawerShown(page)), 4000);
  await page.waitForTimeout(400);
}

/** Do any two of these boxes overlap (1px tolerance)? Returns the first pair that does, or null. */
const overlapping = (boxes) => {
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]; const b = boxes[j];
    if (!a || !b) continue;
    if (a.x + a.width - 1 > b.x && b.x + b.width - 1 > a.x && a.y + a.height - 1 > b.y && b.y + b.height - 1 > a.y) return [a, b];
  }
  return null;
};

/** The visible buttons of a member stage's header (the nearest ancestor of `super-member-name`
 *  holding two or more buttons), as boxes. */
const headerButtons = (page, superId) => stage(page, superId).getByTestId('super-member-name').evaluate((name) => {
  let head = name.parentElement;
  while (head && head.querySelectorAll('button, [role="button"]').length < 2 && !head.matches('[data-testid="super-surface"]')) head = head.parentElement;
  if (!head) return [];
  return [...head.querySelectorAll('button, [role="button"]')].map((b) => {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' ? { x: r.x, y: r.y, width: r.width, height: r.height, label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30) } : null;
  }).filter(Boolean);
}).catch(() => []);

/** The last whole number a row shows (its count), 0 when it shows none. */
const lastInt = (text) => { const m = /(\d+)(?!.*\d)/s.exec(text ?? ''); return m ? Number(m[1]) : 0; };

async function summaryMembers(page) {
  const r = await pageFetch(page, VAULT, 'GET', '/agent/sessions?summary=1');
  return Array.isArray(r.json?.members) ? r.json.members : [];
}
/** The count the plan pins for a row: owner-facing questions + owner unread + approval cards. */
const countOf = (ms) => ms.reduce((n, m) => n + (m.asking ? 1 : 0) + (Number(m.unread) || 0) + (m.approval ? 1 : 0), 0);

async function handOver(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => reports().some((r) => r.kind === 'handover'), 90000);
}

async function run(engineName, base, port) {
  const pw = await import('playwright');
  const browserType = engineName === 'webkit' ? pw.webkit : pw.chromium;
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  // An unapproved member gets no Super record: its stage asks for its birth and hears 409
  // member_unapproved, which the stage shows as the approval band (plan-r10 1). Expected, nothing else.
  const desk = watchPage(page, `${engineName}/desk`, { expected: [/^409 POST \/api\/super\/member\b/, /status of 409/] });
  const sockets = [];
  page.on('websocket', (w) => sockets.push(w.url()));
  const tag = (s) => `[${engineName}] ${s}`;

  console.log(`\n── ${engineName}: setup (hand-over, Kip off, Pera for main, Rota asks)`);
  ok(tag('main Super handed over'), await handOver(page, base));
  const off = await pageFetch(page, VAULT, 'POST', '/agents/kip/enabled', { enabled: false });
  ok(tag('setup: Kip turned off through POST /api/agents/kip/enabled'), off.status === 200, JSON.stringify(off));
  await page.waitForTimeout(1000);
  const teamBefore = reports().filter((r) => r.kind === 'team').length;
  await sayOnStage(page, 'main', 'GO-PERA');
  await until(page, async () => reports().filter((r) => r.kind === 'team').length > teamBefore, 30000);
  const pera = reports().filter((r) => r.kind === 'team')[teamBefore]?.step;
  ok(tag('setup: main\'s `super team ask pera` makes a request'), pera?.status === 0 && typeof pera?.json?.request === 'string', pera?.out);
  ok(tag('setup: the window spawns Pera\'s Super and its pump delivers the request'), await until(page, async () =>
    reports().some((r) => r.kind === 'request-delivered' && r.slug === 'pera'), 60000), JSON.stringify(memberRecord('pera')?.queue ?? null).slice(0, 400));
  await openMember(page, 'rota');
  ok(tag('setup: Rota\'s stage opens'), await until(page, async () => (await stage(page, 'm:rota').count()) > 0, 20000));
  await until(page, async () => (await stageComposer(page, 'm:rota')).isVisible(), 20000);
  await sayOnStage(page, 'm:rota', 'GO-ASK yıllık plan');
  ok(tag('setup: Rota\'s Super asks the owner (`super ask`, owner-origin)'), await until(page, async () =>
    reports().some((r) => r.kind === 'ask' && r.slug === 'rota' && r.step?.status === 0), 45000),
    JSON.stringify(reports().filter((r) => r.kind === 'ask')).slice(0, 400));

  console.log(`── ${engineName}: (d) the New chat menu`);
  await toMainStage(page);
  await ensureDrawer(page);
  const menu = page.locator('[data-testid="new-chat-menu"]:visible').first();
  const openMenu = async () => { await ensureDrawer(page); if (!(await page.locator('[data-testid="new-chat-claude"]:visible').count())) await page.locator('[data-testid="new-chat-menu"]:visible').first().click(); };
  ok(tag('(d) the New chat chevron is there'), await until(page, async () => (await menu.count()) === 1, 15000));
  await openMenu().catch(() => {});
  ok(tag('(d) it offers Claude and the members'), await until(page, async () =>
    (await page.locator('[data-testid="new-chat-claude"]:visible').count()) === 1
    && (await page.locator('[data-testid="new-chat-member"][data-slug="mira"]:visible').count()) === 1, 10000));
  await shots(page, '04', 'new-chat-menu', () => openMenu());
  await openMenu().catch(() => {});
  await page.locator('[data-testid="new-chat-member"][data-slug="mira"]:visible').first().click();
  ok(tag('(d) Mira opens her stage'), await until(page, async () => (await stage(page, 'm:mira').count()) > 0, 20000));
  const miraSpawned = () => reports().filter((r) => r.kind === 'spawn' && r.role === 'member' && r.slug === 'mira');
  await until(page, async () => miraSpawned().length > 0, 30000);
  const session1 = memberRecord('mira')?.session ?? null;
  await toMainStage(page);
  await openMenu().catch(() => {});
  await page.locator('[data-testid="new-chat-member"][data-slug="mira"]:visible').first().click().catch(() => {});
  await until(page, async () => (await stage(page, 'm:mira').count()) > 0, 20000);
  await page.waitForTimeout(3000);
  const session2 = memberRecord('mira')?.session ?? null;
  const miraSockets = [...new Set(sockets.filter((u) => /sessionId=/.test(u) && session1 && u.includes(session1)))];
  ok(tag('(d) Mira twice = the same session, one member Super process'), !!session1 && session1 === session2 && miraSpawned().length === 1,
    JSON.stringify({ session1, session2, spawns: miraSpawned().length, miraSockets: miraSockets.length }));
  ok(tag('(d) …her chat socket names that session'), miraSockets.length >= 1, JSON.stringify(sockets.slice(-6)));

  console.log(`── ${engineName}: (e) Mira's stage with two children`);
  await sayOnStage(page, 'm:mira', 'GO-TWO kampanya');
  ok(tag('(e) her Super delegates twice'), await until(page, async () => {
    const two = reports().find((r) => r.kind === 'two' && r.slug === 'mira');
    return !!two && two.steps.every((s) => s.status === 0);
  }, 45000), JSON.stringify(reports().filter((r) => r.kind === 'two')).slice(0, 600));
  const liveKids = () => Object.values(memberRecord('mira')?.children ?? {}).filter((c) => c.endedAt === undefined);
  ok(tag('(e) her record holds two live children'), await until(page, async () => liveKids().length === 2, 30000), JSON.stringify(memberRecord('mira')?.children ?? null).slice(0, 400));
  ok(tag('(e) both children run under her crew'), await until(page, async () =>
    reports().filter((r) => r.kind === 'spawn' && r.role === 'child' && r.crew === 'mira').length === 2, 30000),
    JSON.stringify(reports().filter((r) => r.kind === 'spawn' && r.role === 'child').map((r) => r.crew)));
  ok(tag('(e) the stage is hers: super-member-name reads Mira'), await until(page, async () =>
    /Mira/.test(await stage(page, 'm:mira').getByTestId('super-member-name').innerText().catch(() => '')), 15000));
  // Wide enough that the stage keeps its cards out of Others.
  await page.setViewportSize({ width: 1920, height: 1080 });
  const cards = () => stage(page, 'm:mira').locator('[data-container-id][data-kind="chat"]');
  ok(tag('(e) two children cards on her stage'), await until(page, async () => (await cards().count()) === 2, 20000), String(await cards().count()));
  // Let the cards' entrance land before measuring them.
  await until(page, async () => cards().evaluateAll((els) => els.every((e) => !e.getAnimations().length)), 5000);
  const cardBoxes = await cards().evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  ok(tag('(e) the two child cards do not overlap'), cardBoxes.length === 2 && !overlapping(cardBoxes), JSON.stringify(cardBoxes));
  for (const [w, h] of [[1920, 1080], [1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    await stageOnly(page, w);
    const btns = await headerButtons(page, 'm:mira');
    const hit = overlapping(btns);
    ok(tag(`(e) at ${w} px the stage header's buttons do not overlap`), btns.length >= 2 && !hit, JSON.stringify(hit ?? btns));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await shots(page, '05', 'member-stage-two-children', (w) => stageOnly(page, w));

  console.log(`── ${engineName}: (a) one Ekip row`);
  ok(tag('(j) the Super Agent row opens main\'s stage'), await toMainStage(page));
  const row = page.locator(`[data-testid="drawer-team-row"][data-vault="${VAULT}"]`);
  await ensureDrawer(page);
  ok(tag('(a) Rota\'s question reaches the summary (asking, owner-facing)'), await until(page, async () =>
    (await summaryMembers(page)).some((m) => m.slug === 'rota' && m.asking), 20000), JSON.stringify(await summaryMembers(page)));
  ok(tag('(a) ONE Ekip row for the project'), await until(page, async () => (await row.count()) === 1 && await row.isVisible(), 15000), String(await row.count()));
  const faces = await row.locator('img, .agent-av').count();
  ok(tag('(a) with faces (one to three)'), faces >= 1 && faces <= 3, String(faces));
  let want = -1;
  let shown = -1;
  ok(tag('(a) its one count = owner questions + owner unread + approval cards'), await until(page, async () => {
    want = countOf((await summaryMembers(page)).filter((m) => !m.global));
    shown = lastInt(await row.innerText());
    return want >= 1 && shown === want;
  }, 20000), `row ${shown}, summary ${want}: ${(await row.innerText().catch(() => '')).replace(/\s+/g, ' ')}`);
  await shots(page, '01', 'ekip-row', () => ensureDrawer(page));

  console.log(`── ${engineName}: (b) its list and the switch`);
  const list = page.locator('[data-testid="team-list"]:visible');
  const openList = async () => { await ensureDrawer(page); if (!(await list.count())) await row.click(); };
  await openList();
  ok(tag('(b) the list opens'), await until(page, async () => (await list.count()) === 1, 10000));
  const order = await list.locator('[data-testid="team-list-member"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-slug')));
  const at = (s) => order.indexOf(s);
  ok(tag('(b) in the drawn order: Rota first, Mira, then Pera, then the idle and off ones'),
    at('rota') === 0 && at('mira') > 0 && at('pera') > at('mira') && at('kip') > at('pera') && at('gantt') > at('pera'), JSON.stringify(order));
  ok(tag('(b) no global member in the project\'s list'), at('ada') === -1, JSON.stringify(order));
  const peraRow = list.locator('[data-testid="team-list-member"][data-slug="pera"]');
  const peraText = (await peraRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok(tag('(b) Pera is tagged "Super için"'), /Super için|for (the )?Super/i.test(peraText), peraText);
  ok(tag('(b) …with no count'), !/(^|\s)\d+(\s|$)/.test(peraText), peraText);
  const kipText = (await list.locator('[data-testid="team-list-member"][data-slug="kip"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok(tag('(b) Kip reads "Kapalı"'), /Kapalı|\bOff\b/i.test(kipText), kipText);
  const sw = list.locator('[data-testid="team-member-switch"][data-slug="kip"]');
  ok(tag('(b) Kip\'s switch is off'), (await sw.getAttribute('aria-checked').catch(() => null)) === 'false');
  await shots(page, '02', 'ekip-list', () => openList());
  await openList();
  const flip = async (to) => {
    const wait = page.waitForResponse((r) => /\/api\/agents\/kip\/enabled/.test(r.url()) && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
    await sw.click();
    const r = await wait;
    let body = null; try { body = JSON.parse(r?.request().postData() ?? 'null'); } catch { /* none */ }
    return { status: r?.status() ?? 0, body, checked: await until(page, async () => (await sw.getAttribute('aria-checked')) === String(to), 8000) };
  };
  const on = await flip(true);
  ok(tag('(b) the switch turns Kip on: POST /api/agents/kip/enabled {enabled:true} 200'), on.status === 200 && on.body?.enabled === true && on.checked, JSON.stringify(on));
  ok(tag('(b) …and the summary says Kip is on'), await until(page, async () => (await summaryMembers(page)).find((m) => m.slug === 'kip')?.enabled === true, 10000));
  const back = await flip(false);
  ok(tag('(b) …and back off'), back.status === 200 && back.body?.enabled === false && back.checked, JSON.stringify(back));
  await page.keyboard.press('Escape');

  console.log(`── ${engineName}: (c) the Global ekip row, (g) Ada's stage`);
  const grow = page.locator('[data-testid="drawer-global-team-row"]');
  await ensureDrawer(page);
  ok(tag('(c) ONE Global ekip row'), await until(page, async () => (await grow.count()) === 1 && await grow.isVisible(), 15000));
  const below = await page.evaluate((v) => {
    const g = document.querySelector('[data-testid="drawer-global-team-row"]')?.getBoundingClientRect();
    const others = [...document.querySelectorAll(`[data-drawer-project], [data-testid="drawer-team-row"][data-vault="${v}"]`)].map((e) => e.getBoundingClientRect().top);
    return !!g && others.every((t) => g.top > t);
  }, VAULT);
  ok(tag('(c) at the bottom, below every project'), below);
  let gWant = -1;
  let gShown = -1;
  ok(tag('(c) its count takes Ada\'s approval card once'), await until(page, async () => {
    gWant = countOf((await summaryMembers(page)).filter((m) => m.global));
    gShown = lastInt(await grow.innerText());
    return gWant >= 1 && gShown === gWant;
  }, 15000), `row ${gShown}, summary ${gWant}`);
  await shots(page, '03', 'global-ekip-row', () => ensureDrawer(page));
  const glist = page.locator('[data-testid="global-team-list"]:visible');
  const openGlist = async () => { await ensureDrawer(page); if (!(await glist.count())) await grow.click(); };
  await openGlist();
  ok(tag('(c) its list opens with Ada and her project'), await until(page, async () => {
    const t = await glist.innerText().catch(() => '');
    return /Ada/.test(t) && t.includes(VAULT);
  }, 10000), await glist.innerText().catch(() => ''));
  await shots(page, '03', 'global-ekip-list', () => openGlist());
  await openGlist();
  await glist.getByText('Ada', { exact: false }).first().click();
  ok(tag('(c) Ada opens her stage in the project'), await until(page, async () => (await stage(page, 'm:ada').count()) > 0, 20000));
  ok(tag('(g) her stage shows the approval band'), await until(page, async () => (await stage(page, 'm:ada').getByTestId('member-approval-band').isVisible().catch(() => false)), 15000));
  ok(tag('(g) …and the project chip'), await until(page, async () => (await stage(page, 'm:ada').getByTestId('member-project-chip').isVisible().catch(() => false)), 15000));
  await shots(page, '07', 'global-member-approval-band', (w) => stageOnly(page, w));

  console.log(`── ${engineName}: (h) Üyeleri yönet`);
  await toMainStage(page);
  const modal = page.locator('[data-testid="manage-members-modal"]:visible');
  const openModal = async () => {
    if (await modal.count()) return;
    await openList();
    await page.locator('[data-testid="team-manage"]:visible').first().click();
  };
  await openModal();
  ok(tag('(h) "Üyeleri yönet" opens the modal'), await until(page, async () => (await modal.count()) === 1, 10000));
  const chatInside = await modal.locator('.chat-cmp-input, .chat-pane, [data-testid="agent-conversation"], [data-testid="super-surface"]').count();
  ok(tag('(h) with no chat pane inside'), chatInside === 0, String(chatInside));
  await shots(page, '08', 'manage-members', () => openModal());
  await page.keyboard.press('Escape');
  await until(page, async () => (await modal.count()) === 0, 5000);

  console.log(`── ${engineName}: (f) a task's face lands on the strip`);
  const rail = page.locator('[data-testid="ns-rail-tasks"]:visible').first();
  if (await rail.count()) await rail.click();
  else await page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Tasks\s*\d*\s*$/ }).first().click().catch(() => {});
  const card = page.locator(`.bd-card[data-task-slug="${TASK}"]:visible`).first();
  ok(tag('(f) the task\'s card is on the board'), await until(page, async () => (await card.count()) === 1, 20000));
  let face = card.locator('[data-testid="task-agent-face"][data-slug="rota"]');
  if (!(await face.count())) {
    await card.click({ position: { x: 24, y: 14 } }).catch(() => {});
    face = page.locator(`.detail-panel[data-task-slug="${TASK}"] [data-testid="task-agent-face"][data-slug="rota"]`);
  }
  ok(tag('(f) the doer\'s face is a button with role doer'), await until(page, async () => (await face.count()) >= 1 && (await face.first().getAttribute('data-role')) === 'doer', 15000));
  ok(tag('(f) the reviewer Gantt has its face too (role reviewer)'), (await page.locator('[data-testid="task-agent-face"][data-slug="gantt"][data-role="reviewer"]').count()) >= 1);
  await shots(page, '06', 'task-faces', undefined);
  await face.first().scrollIntoViewIfNeeded().catch(() => {});
  await face.first().click();
  ok(tag('(f) the click lands on Rota\'s stage'), await until(page, async () => (await stage(page, 'm:rota').count()) > 0, 20000));
  ok(tag('(f) …with the task strip for that task'), await until(page, async () =>
    stage(page, 'm:rota').locator(`[data-testid="super-task-strip"][data-task="${TASK}"]`).isVisible(), 15000));
  await shots(page, '06', 'task-strip', (w) => stageOnly(page, w));
  await sayOnStage(page, 'm:rota', 'Bu görevde inceleyici ne dedi?');
  ok(tag(`(f) the message reaches Rota's Super carrying [About task ${TASK}]`), await until(page, async () =>
    reports().filter((r) => r.kind === 'member-turn' && r.slug === 'rota')
      .some((r) => r.text.includes(`[About task ${TASK}]`) && r.text.includes('inceleyici ne dedi')), 30000),
    JSON.stringify(reports().filter((r) => r.kind === 'member-turn' && r.slug === 'rota').map((r) => r.text.slice(0, 160))));

  console.log(`── ${engineName}: (j) main's stage unchanged`);
  ok(tag('(j) the Super Agent row opens main again'), await toMainStage(page));
  ok(tag('(j) …and no member stage is drawn over it'), (await page.locator('[data-testid="super-surface"][data-super-id^="m:"]:visible').count()) === 0);
  await shots(page, '10', 'main-stage', () => ensureDrawer(page));

  console.log(`── ${engineName}: (d) Claude in the New chat menu`);
  await openMenu().catch(() => {});
  await page.locator('[data-testid="new-chat-claude"]:visible').first().click().catch(() => {});
  ok(tag('(d) "Claude" opens a plain new chat, not a Super stage'), await until(page, async () =>
    (await page.locator('[data-testid="super-surface"]:visible').count()) === 0 && (await page.locator('.chat-cmp-input:visible').count()) >= 1, 15000));

  console.log(`── ${engineName}: (i) the phone`);
  const setup = await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/setup`, { method: 'POST', headers: { 'X-Dreamcontext-Vault': VAULT, 'Content-Type': 'application/json' }, body: '{}' });
  const start = await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/start`, { method: 'POST', headers: { 'X-Dreamcontext-Vault': VAULT, 'Content-Type': 'application/json' }, body: JSON.stringify({ vaults: [VAULT] }) });
  const qr = (await (await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/qr`, { method: 'POST', headers: { 'X-Dreamcontext-Vault': VAULT } })).json().catch(() => ({}))).url;
  ok(tag('(i) Mac mode starts and gives a sign-in link'), setup.ok && start.ok && typeof qr === 'string', `${setup.status} ${start.status} ${qr}`);
  let phoneWatch = { errors: [], failed: [] };
  if (typeof qr === 'string') {
    const pctx = await browser.newContext({ ...pw.devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    await markAnnouncementsSeen(pctx, `http://127.0.0.1:${port}`);
    const phone = await pctx.newPage();
    phoneWatch = watchPage(phone, `${engineName}/phone`);
    await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    ok(tag('(i) the phone signs in and lands in the project'), await until(phone, async () => phone.url().includes(`vault=${VAULT}`), 25000), phone.url());
    for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
    await until(phone, () => drawerShown(phone), 20000);
    const prow = phone.locator(`[data-testid="phone-team-row"][data-vault="${VAULT}"]`);
    ok(tag('(i) the phone shows the project\'s Ekip row'), await until(phone, async () => (await prow.count()) === 1 && await prow.isVisible(), 20000));
    ok(tag('(i) …and the Global ekip row'), await until(phone, async () => phone.locator('[data-testid="phone-global-team-row"]').isVisible(), 15000));
    await shots(phone, '09', 'phone-rows', () => openDrawer(phone), [[390, 844]], null);
    const sheet = phone.locator('[data-testid="phone-team-sheet"]:visible');
    const openSheet = async () => { if (!(await sheet.count())) { await openDrawer(phone); await prow.click(); } };
    await openSheet();
    ok(tag('(i) its sheet opens'), await until(phone, async () => (await sheet.count()) === 1, 10000));
    await shots(phone, '09', 'phone-team-sheet', () => openSheet(), [[390, 844]], null);
    await openSheet();
    await sheet.getByText('Rota', { exact: false }).first().click();
    ok(tag('(i) the sheet opens Rota\'s stage'), await until(phone, async () =>
      (await phone.locator('[data-super-id="m:rota"]:visible').count()) > 0
      || ((await sheet.count()) === 0 && !(await drawerShown(phone)) && /Rota/.test(await phone.locator('.agent-surface:visible').first().innerText().catch(() => ''))), 20000));
    await shots(phone, '09', 'phone-member-stage', (w) => stageOnly(phone, w), [[390, 844]], null);
    await pctx.close();
  }

  for (const w of [desk, phoneWatch]) {
    ok(tag(`no console errors (${w === desk ? 'desk' : 'phone'})`), w.errors.length === 0, w.errors.slice(0, 6).join('\n'));
    ok(tag(`no failed requests (${w === desk ? 'desk' : 'phone'})`), w.failed.length === 0, w.failed.slice(0, 8).join('\n'));
  }
  await browser.close();
}

async function main() {
  for (const engine of ENGINES) {
    let srv = null;
    try {
      setupScratch();
      const port = await freePort();
      srv = await startServer({
        cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log'),
        extraEnv: { DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log') },
      });
      await run(engine, `http://127.0.0.1:${port}`, port);
    } catch (e) { ok(`[${engine}] ran to the end`, false, e?.stack ?? e); }
    finally {
      writeFileSync(join(OUT, `${engine}-reports.json`), JSON.stringify(reports(), null, 1));
      srv?.kill(); spawnSync('pkill', ['-f', SCRATCH]);
    }
  }
  console.log(`\n${summary()}`);
  console.log(`screenshots (${taken.length}): ${OUT}`);
  if (process.env.KEEP_SCRATCH) console.log(`scratch kept: ${SCRATCH}`); else rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
