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
 * (~/.dreamcontext/agents/ada.md in the scratch HOME) that was never approved on this Mac (its one
 * approval card waits); task set-the-annual-plan-price: doer Rota,
 * reviewer Gantt.
 *
 *   (a) ONE Ekip row (`drawer-team-row`), no faces, with ONE end mark (option A): the red count of
 *       owner-facing questions + approval cards, else a spinner while members work for the owner,
 *       else the grey unread count (from summary=1 `members`).
 *   (b) its list (`team-list`, opened in place under the row): Rota first, Mira before Pera, Pera
 *       "Super için" with no count, Kip dimmed, the global member Ada after every own member with
 *       its globe (`team-member-global`), no switch (plan r4 R2); Kip's
 *       stage's Üye card switch (`member-card-switch`) turns it on through
 *       POST /api/agents/kip/enabled and back off.
 *   (c) no Global ekip row anywhere (owner 2026-11-17); Ada opens from the project's own list.
 *   (d) the New chat menu (`new-chat-menu` -> `new-chat-claude`, `new-chat-member`): Mira twice is
 *       the same session (one member Super process); Claude opens a plain new chat.
 *   (e) Mira's stage (`super-surface[data-super-id="m:mira"]`, `super-member-name`) with its two
 *       children's cards, which do not overlap; the stage header's buttons do not overlap (1920,
 *       1440 and 390). Stage shots at 390 close the drawer first (there it is a sheet over the stage).
 *   (f) the task's face (`task-agent-face[data-slug=rota]`) lands on Rota's stage with
 *       `super-task-strip[data-task=<slug>]`; a message sent there reaches Rota's Super with
 *       `[About task <slug>]` (read in the stand-in's stdin).
 *   (g) Ada's stage shows `member-approval-band`; its head starts with the project
 *       (`super-member-project`, the side menu's project name) and carries the Global chip, no
 *       project switcher (`member-project-chip` gone); the head stays one row at 1440 and keeps
 *       the project name at 420.
 *   (h) "Üyeleri yönet" (`team-manage`, in the Team row's "⋯" menu) opens `manage-members-modal`, with no chat pane inside.
 *   (i) phone 390: `phone-team-row` and no `phone-global-team-row`; the sheet (`phone-team-sheet`)
 *       opens Rota's conversation (the phone's mirror tab of her live Super), and her open question
 *       is answered there: the summary stops asking and her Super gets the answer.
 *   (j) main's stage unchanged: the Super Agent row still opens main.
 *   Console errors and failed requests are recorded per page: any is a FAIL.
 *
 * Screenshots: tmp/verify/super-members/<nn>-<what>-<width>-<theme>.png (1440 and 390, light and
 * dark; the phone at 390 only). Exit non-zero on any FAIL; prints 'N passed M failed'.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Ada was never approved on this Mac (her grant is gone from the machine's `global` bucket): her one
  // card waits and she cannot run. A hand edit after an approval no longer does this: it keeps the
  // member working on its last approved text (owner 2026-11-08, `approvedTarget`), so it is no card.
  const ledger = join(HOME, '.dreamcontext', 'automations.json');
  const reg = JSON.parse(readFileSync(ledger, 'utf-8'));
  delete reg.projects?.global?.agentApprovals?.ada;
  writeFileSync(ledger, JSON.stringify(reg, null, 2));
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
  if (await page.locator('[data-testid="drawer-team-row"]:visible').count()) return;
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
 *  holding two or more VISIBLE buttons: at 390 the member head itself holds only "Profile", the
 *  agenda, jobs and ⋯ chips sit in the bar around it), as boxes. */
const headerButtons = (page, superId) => stage(page, superId).getByTestId('super-member-name').evaluate((name) => {
  const boxes = (root) => [...root.querySelectorAll('button, [role="button"]')].map((b) => {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' ? { x: r.x, y: r.y, width: r.width, height: r.height, label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30) } : null;
  }).filter(Boolean);
  let head = name.parentElement;
  while (head && boxes(head).length < 2 && !head.matches('[data-testid="super-surface"]')) head = head.parentElement;
  return head ? boxes(head) : [];
}).catch(() => []);

/** The last whole number a row shows (its count), 0 when it shows none. */
const lastInt = (text) => { const m = /(\d+)(?!.*\d)/s.exec(text ?? ''); return m ? Number(m[1]) : 0; };

async function summaryMembers(page) {
  const r = await pageFetch(page, VAULT, 'GET', '/agent/sessions?summary=1');
  return Array.isArray(r.json?.members) ? r.json.members : [];
}
// The folded Ekip row's ONE end mark (option A, owner 2026-11-09; teamModel.ts ekipMark): what waits
// on the owner wins (a filled red count: each approval card plus each open owner-facing question,
// `waiting` or 1), else work for the owner (a small grey spinner), else unread replies (a grey count).
// A member working for main's Super or turned off adds only its approval card. No faces, no ring.
const askingOf = (ms) => ms.reduce((n, m) => n + (m.approval ? 1 : 0)
  + (m.asking && !m.superOnly && m.enabled ? Math.max(1, Number(m.waiting) || 0) : 0), 0);
const unreadOf = (ms) => ms.reduce((n, m) => n + (m.enabled && !m.superOnly ? (Number(m.unread) || 0) : 0), 0);
const workingOf = (ms) => ms.filter((m) => m.enabled && !m.superOnly && Number(m.ownerWorking) > 0).length;
/** What the one mark must be for these members: {kind, n} (n = 0 for the spinner and for none). */
const wantMark = (ms) => {
  const asking = askingOf(ms);
  if (asking > 0) return { kind: 'asking', n: asking };
  if (workingOf(ms) > 0) return { kind: 'working', n: 0 };
  const unread = unreadOf(ms);
  return unread > 0 ? { kind: 'unread', n: unread } : { kind: 'none', n: 0 };
};
/** What a row draws: its one mark's kind and number. */
async function drawnMark(loc) {
  for (const kind of ['asking', 'working', 'unread']) {
    const el = loc.getByTestId(`mark-${kind}`);
    const n = await el.count();
    if (n > 1) return { kind: 'many', n };
    if (n === 1) return { kind, n: kind === 'working' ? 0 : lastInt(await el.innerText()) };
  }
  return { kind: 'none', n: 0 };
}

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
  const menu = page.locator('[data-testid="drawer-project-more"]:visible').first();
  // The chevron sits beside the project row's "+" and shows on the row's hover (its box takes no
  // pointer until then): hover the row through the always-there "+", as a person does, then click.
  const openMenu = async () => {
    await ensureDrawer(page);
    if (await page.locator('[data-testid="new-chat-claude"]:visible').count()) return;
    await page.locator('[data-testid="drawer-project-add"]:visible').first().hover();
    await page.locator('[data-testid="drawer-project-more"]:visible').first().click();
    await page.locator('[data-testid="drawer-project-newchat-item"]:visible').first().click();
  };
  ok(tag('(d) the project menu is there'), await until(page, async () => (await menu.count()) === 1, 15000));
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
  // Option A (owner 2026-11-09): the Team row has no faces and no ring, only its one end mark.
  const faces = await row.locator('img, .agent-av').count();
  ok(tag('(a) the row draws no faces (option A)'), faces === 0, String(faces));
  let want = { kind: 'none', n: 0 };
  let shown = { kind: 'none', n: 0 };
  ok(tag('(a) its ONE mark: owner questions + approval cards in red, else a spinner while members work for the owner, else unread'), await until(page, async () => {
    // Its own members and the global ones (the project in view counts Ada's approval card).
    want = wantMark(await summaryMembers(page));
    shown = await drawnMark(row);
    return want.kind !== 'none' && shown.kind === want.kind && shown.n === want.n;
  }, 20000), `row ${JSON.stringify(shown)}, summary ${JSON.stringify(want)}: ${(await row.innerText().catch(() => '')).replace(/\s+/g, ' ')}`);
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
  ok(tag('(b) the global member Ada is in the project\'s list, after every own member'),
    at('ada') > 0 && ['rota', 'mira', 'pera', 'kip', 'gantt'].every((x) => at(x) < at('ada')), JSON.stringify(order));
  ok(tag('(b) …with the globe on her row'), (await list.locator('[data-testid="team-list-member"][data-slug="ada"] [data-testid="team-member-global"]').count()) === 1);
  const peraRow = list.locator('[data-testid="team-list-member"][data-slug="pera"]');
  const peraText = (await peraRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
  // "Super için" is a glyph on the face's corner (SuperBadge), its words in the aria-label and title.
  const peraBadge = peraRow.locator('[data-testid="team-mark-super"]');
  const peraSays = `${await peraBadge.getAttribute('aria-label').catch(() => '')} ${await peraBadge.getAttribute('title').catch(() => '')}`;
  ok(tag('(b) Pera is tagged "Super için"'), (await peraBadge.count()) === 1 && /Super için|for (the )?Super/i.test(peraSays), `${peraText} | ${peraSays}`);
  ok(tag('(b) …with no count'), !/(^|\s)\d+(\s|$)/.test(peraText), peraText);
  ok(tag('(b) Kip is drawn off (dimmed)'), (await list.locator('[data-testid="team-list-member"][data-slug="kip"]').getAttribute('data-off').catch(() => null)) === 'true');
  // r3 R2: the sidebar list has no switch; it is on the member's stage, in its Üye card.
  ok(tag('(b) the sidebar list has no switch'), (await list.locator('[role="switch"]').count()) === 0);
  await shots(page, '02', 'ekip-list', () => openList());
  await openMember(page, 'kip');
  ok(tag('(b) Kip\'s stage opens with its own cards'), await until(page, async () => (await stage(page, 'm:kip').locator('[data-kind="member"]').count()) > 0, 20000));
  const openUye = async () => {
    const st = stage(page, 'm:kip');
    if (await st.getByTestId('member-card-switch').isVisible().catch(() => false)) return;
    const others = st.locator('[data-testid="super-others-stack"], [data-testid="super-others-open"]').first();
    if (await others.isVisible().catch(() => false)) await others.click();
    const item = page.locator('[data-testid="super-others-item"]').filter({ hasText: /Üye|Member/ }).first();
    if (await item.isVisible().catch(() => false)) await item.click();
  };
  await openUye();
  const sw = stage(page, 'm:kip').getByTestId('member-card-switch');
  ok(tag('(b) the Üye card\'s switch is there, and off'), await until(page, async () => (await sw.getAttribute('aria-checked').catch(() => null)) === 'false', 15000));
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
  await toMainStage(page);

  console.log(`── ${engineName}: (c) no Global ekip row, (g) Ada's stage`);
  await ensureDrawer(page);
  ok(tag('(c) no Global ekip row, no "Projelerden bağımsız"'), (await page.locator('[data-testid="drawer-global-team-row"], .ns-team-global-head').count()) === 0);
  await openList();
  await list.locator('[data-testid="team-list-member"][data-slug="ada"]').click();
  ok(tag('(c) Ada opens her stage from the project\'s list'), await until(page, async () => (await stage(page, 'm:ada').count()) > 0, 20000));
  ok(tag('(g) her stage shows the approval band'), await until(page, async () => (await stage(page, 'm:ada').getByTestId('member-approval-band').isVisible().catch(() => false)), 15000));
  const head = stage(page, 'm:ada').getByTestId('super-member-head');
  const projectName = (await head.getByTestId('super-member-project').innerText().catch(() => '')).trim();
  ok(tag('(g) her head starts with the project, named as the side menu names it'), projectName === VAULT, projectName);
  ok(tag('(g) …with the Global chip and no project switcher'),
    (await head.getByTestId('super-member-global').isVisible().catch(() => false)) && (await page.getByTestId('member-project-chip').count()) === 0 && (await head.locator('select').count()) === 0);
  const headAt = async () => head.evaluate((el) => {
    const r = (q) => el.querySelector(q)?.getBoundingClientRect() ?? null;
    const p = r('[data-testid="super-member-project"]');
    const n = r('[data-testid="super-member-name"]');
    const tops = [...el.children].filter((c) => c.getBoundingClientRect().width > 0).map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2));
    const pn = el.querySelector('.super-member-project-name');
    const cut = (x) => !!x && x.scrollWidth > x.clientWidth + 1;
    const btns = [...el.closest('.super-centre-head, [data-testid="super-member-head"]').querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0);
    return { project: p ? Math.round(p.width) : 0, name: n ? Math.round(n.width) : 0, oneRow: Math.max(...tops) - Math.min(...tops) <= 4,
      projectCut: cut(pn), buttonCut: btns.some(cut), text: el.textContent };
  });
  const wide = await headAt();
  ok(tag('(g) 1440: the head is one row, the project name whole, no button cut'), wide.oneRow && !wide.projectCut && !wide.buttonCut && wide.name > 30, JSON.stringify(wide));
  const vp = page.viewportSize();
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(400);
  const narrow = await headAt();
  ok(tag('(g) 420: the project name still shows, the name keeps its first word'), narrow.oneRow && narrow.project > 24 && narrow.name > 24, JSON.stringify(narrow));
  if (vp) await page.setViewportSize(vp);
  await page.waitForTimeout(300);
  await shots(page, '07', 'global-member-approval-band', (w) => stageOnly(page, w));
  // The head alone, wide and at a 420 centre (light): the owner reads these.
  await shots(page, '07', 'global-member-head', (w) => stageOnly(page, w), [[1440, 900], [420, 900]], [1440, 900]);

  console.log(`── ${engineName}: (h) Üyeleri yönet`);
  await toMainStage(page);
  const modal = page.locator('[data-testid="manage-members-modal"]:visible');
  const openModal = async () => {
    if (await modal.count()) return;
    // "Üyeleri yönet" is in the Team row's "⋯" menu (option A, 2026-11-09), which shows on the row's hover.
    await ensureDrawer(page);
    await row.hover();
    await page.locator('[data-testid="drawer-team-row-section"] [data-testid="team-more"]:visible').first().click();
    await page.locator('[data-testid="team-manage"]:visible').first().click();
  };
  await openModal();
  ok(tag('(h) "Üyeleri yönet" opens the modal'), await until(page, async () => (await modal.count()) === 1, 10000));
  const chatInside = await modal.locator('.chat-cmp-input, .chat-pane, [data-testid="agent-conversation"], [data-testid="super-surface"]').count();
  ok(tag('(h) with no chat pane inside'), chatInside === 0, String(chatInside));
  await shots(page, '08', 'manage-members', () => openModal());
  await page.keyboard.press('Escape');
  await until(page, async () => (await modal.count()) === 0, 5000);
  // The Ekip "⋯" menu offers "Tüm projelerde çalışan üye"; it opens the form with All projects picked.
  const openMore = async () => {
    await ensureDrawer(page);
    if (await page.locator('[data-testid="team-more-menu"]:visible').count()) return;
    await row.hover();
    await page.locator('[data-testid="drawer-team-row-section"] [data-testid="team-more"]:visible').first().click();
  };
  await openMore();
  ok(tag('(h) the "⋯" menu offers a member of all projects'), await until(page, async () => (await page.locator('[data-testid="team-new-global-member"]:visible').count()) === 1, 8000));
  await shots(page, '08', 'team-more-menu', () => openMore(), [[1440, 900]]);
  await openMore();
  await page.locator('[data-testid="team-new-global-member"]:visible').first().click();
  ok(tag('(h) …which opens the new-member form on "All projects"'), await until(page, async () => (await modal.locator('[data-new-scope="all"][aria-pressed="true"]').count()) === 1, 10000));
  await page.keyboard.press('Escape');
  await until(page, async () => (await modal.count()) === 0, 5000);
  // A global member's profile says its edits apply in every project.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dreamcontext-manage-members', { detail: { slug: 'ada' } })));
  ok(tag('(h) Ada\'s profile says a change applies in every project'), await until(page, async () => (await modal.locator('[data-testid="global-profile-note"]').isVisible().catch(() => false)), 10000));
  await shots(page, '08', 'global-profile-note', async () => {
    if (!(await modal.count())) await page.evaluate(() => window.dispatchEvent(new CustomEvent('dreamcontext-manage-members', { detail: { slug: 'ada' } })));
  }, [[1440, 900]]);
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
    ok(tag('(i) …and no Global ekip row'), (await phone.locator('[data-testid="phone-global-team-row"]').count()) === 0);
    await shots(phone, '09', 'phone-rows', () => openDrawer(phone), [[390, 844]], null);
    const sheet = phone.locator('[data-testid="phone-team-sheet"]:visible');
    const openSheet = async () => { if (!(await sheet.count())) { await openDrawer(phone); await prow.click(); } };
    await openSheet();
    ok(tag('(i) its sheet opens'), await until(phone, async () => (await sheet.count()) === 1, 10000));
    await shots(phone, '09', 'phone-team-sheet', () => openSheet(), [[390, 844]], null);
    await openSheet();
    await sheet.getByText('Rota', { exact: false }).first().click();
    // The phone opens a LIVE member's Super as its mirror tab (50271fd8): Rota's conversation.
    const mirrorText = () => phone.locator('[data-super-id="m:rota"]:visible, .agent-surface:visible').first().innerText().catch(() => '');
    ok(tag('(i) the sheet opens Rota\'s conversation (its mirror tab)'), await until(phone, async () =>
      (await sheet.count()) === 0 && !(await drawerShown(phone)) && /Rota|ROTA SUPER/.test(await mirrorText())
      && /GO-ASK|Sana bir soru sordum/.test(await mirrorText()), 20000), (await mirrorText()).slice(0, 400));
    await shots(phone, '09', 'phone-member-conversation', (w) => stageOnly(phone, w), [[390, 844]], null);
    // Her question is still open (nothing answered it on the desk): answered here, it settles everywhere.
    const qcard = phone.locator('[data-testid="super-question-card"][data-state="open"]:visible').first();
    if (await until(phone, async () => (await qcard.count()) > 0, 10000)) {
      await qcard.locator('.chat-surveycard-opt').filter({ hasText: '%10' }).first().click().catch(() => {});
      await phone.waitForTimeout(300);
      if (await qcard.locator('.chat-btn.primary:visible').count()) await qcard.locator('.chat-btn.primary:visible').first().click().catch(() => {});
      ok(tag('(i) Rota\'s question is answered from the phone'), await until(phone, async () =>
        (await summaryMembers(page)).find((m) => m.slug === 'rota')?.asking === false, 20000), JSON.stringify((await summaryMembers(page)).find((m) => m.slug === 'rota')));
      ok(tag('(i) …and her Super gets the answer'), await until(phone, async () =>
        reports().some((r) => r.kind === 'member-turn' && r.slug === 'rota' && /%10/.test(r.text) && /super answer|\[super/.test(r.text)), 30000),
        JSON.stringify(reports().filter((r) => r.kind === 'member-turn' && r.slug === 'rota').map((r) => r.text.slice(0, 120))));
    } else {
      ok(tag('(i) Rota\'s open question shows as a card on the phone'), (await summaryMembers(page)).find((m) => m.slug === 'rota')?.asking === false,
        `no open question card; summary: ${JSON.stringify((await summaryMembers(page)).find((m) => m.slug === 'rota'))}`);
    }
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
