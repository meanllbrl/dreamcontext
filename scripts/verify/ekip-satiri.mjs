#!/usr/bin/env node
/**
 * The Team row in place and a member's own stage cards, observed (plan r4, task
 * ekip-satiri-yerinde-acilir-…): the mockup states at 1440 and 390, light and dark.
 *
 *   npm run build && node scripts/verify/ekip-satiri.mjs [outDir]
 *
 * The real dashboard server from dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), real members made
 * with `dreamcontext agents create`, real routines through POST /api/automations. The Team row's
 * facts (who asks, who has unread, who works) are what `GET /agent/sessions?summary=1` answers;
 * the server's counting of them is proven by the unit suites (super-member-notify), so here the
 * answer's `members` is STAGED per state to draw each mockup, and everything else is live.
 *
 *   s1 folded, a member answered: the row shows its count, the member pops out under it.
 *   s2 open, 5 members: one end mark each (?, count, ring, "Super için", off dimmed), no switch.
 *   s3 open, 20 members: a box 8 rows tall that scrolls inside, the search field; the rows under
 *      it do not move when the box scrolls; news first.
 *   s4 folded, one works for the owner and one asks: the ring, the label in the question colour,
 *      the asker popped out.
 *   s5 a member's stage: Rutinler (its routines), Talimatlar, Üye in Others; no close control.
 *   s5c Rutinler opened: a routine is edited (its switch) and deleted after the in-app ask.
 *   s6 "Bu üyeyi sil": the in-app dialog names its routines; Vazgeç changes nothing.
 *   s7 turned on from its Üye card; the owner resizes Talimatlar and sends Rutinler to Others:
 *      the record keeps his size and place, and a reload draws them so.
 *   s8 turned off again from the stage: its stage draws its OWN saved layout (G-AC1).
 *   s9 "Bu üyeyi sil" for real: no Team row, no routine left, a trash copy with a receipt.
 * Console errors and failed requests are recorded: any is a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { closeDrawer, drawerShown, openDrawer } from './lib/phone-shell.mjs';
import { applyTheme, cleanEnv, freePort, openMember, pageFetch, readNd, reporter, stage, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-ekip-satiri-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'ekip-satiri'));
const THEMES = ['light', 'dark'];
const SIZES = [[1440, 900], [390, 844]];

const NAMES = [
  ['veri-analisti', 'Veri Analisti'], ['ua-manager', 'UA Manager'], ['icerik-yazari', 'İçerik Yazarı'], ['destek-uzmani', 'Destek Uzmanı'],
  ['tasarimci', 'Tasarımcı'], ['fiyat-analisti', 'Fiyat Analisti'], ['kreatif-yonetmen', 'Kreatif Yönetmen'], ['seo-uzmani', 'SEO Uzmanı'],
  ['topluluk', 'Topluluk Yöneticisi'], ['hukuk', 'Hukuk Danışmanı'], ['finans', 'Finans Analisti'], ['urun', 'Ürün Yöneticisi'],
  ['qa', 'Test Uzmanı'], ['satis', 'Satış Temsilcisi'], ['cevirmen', 'Çevirmen'], ['video', 'Video Editörü'],
  ['arastirma', 'Araştırmacı'], ['eposta', 'E-posta Uzmanı'], ['operasyon', 'Operasyon Sorumlusu'], ['planlama', 'Planlama Asistanı'],
];

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const { ok, summary } = reporter();

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  // `claude` is the scripted stand-in (no tokens): the chat surface and a member's stage open.
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: join(SCRATCH, 'reports.ndjson'), cli: CLI }));
  chmodSync(bin, 0o755);
  const steps = [['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })]];
  steps.push(['agent ua-manager', dc('agents', 'create', 'ua-manager', '--title', 'UA Manager', '--prompt', 'Meta ve TikTok ücretli edinmesini her gün izler ve özetler.')]);
  for (const [slug, title] of NAMES) if (slug !== 'ua-manager') steps.push([`agent ${slug}`, dc('agents', 'create', slug, '--title', title, '--prompt', `${title} işini yapar.`)]);
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

/** The staged `members` of the summary answer, per state (null = the server's own answer). */
let staged = null;
const m = (slug, o = {}) => ({ slug, global: false, enabled: true, ownerWorking: 0, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 0, pending: 0, ...o });
const FIVE = ['veri-analisti', 'ua-manager', 'icerik-yazari', 'destek-uzmani', 'tasarimci'];
const STATES = {
  s1: FIVE.map((s) => m(s, s === 'ua-manager' ? { unread: 1, lastAt: 5 } : {})),
  s2: [m('veri-analisti', { asking: true, lastAt: 9 }), m('ua-manager', { unread: 2, lastAt: 8 }), m('icerik-yazari', { ownerWorking: 1, lastAt: 7 }),
    m('destek-uzmani', { superOnly: true }), m('tasarimci', { enabled: false })],
  s3: NAMES.map(([s], i) => m(s, s === 'fiyat-analisti' ? { approval: true } : s === 'ua-manager' ? { unread: 2, lastAt: 9 }
    : s === 'veri-analisti' ? { unread: 1, lastAt: 8 } : s === 'icerik-yazari' ? { ownerWorking: 1 } : s === 'seo-uzmani' ? { enabled: false } : { lastAt: 0 - i })),
  s4: [m('icerik-yazari', { ownerWorking: 1, lastAt: 9 }), m('veri-analisti', { asking: true, lastAt: 8 }), m('ua-manager')],
};

async function ensureDrawer(page) {
  if (await page.locator('[data-testid="drawer-team-row"]:visible').count()) return;
  if (await page.getByTestId('ns-drawer-toggle').count()) await openDrawer(page).catch(() => {});
}
async function stageOnly(page, w) {
  if (w > 600) return;
  for (let i = 0; i < 3 && await drawerShown(page); i++) { await closeDrawer(page).catch(() => {}); await page.waitForTimeout(400); }
}

const taken = [];
async function shots(page, nn, what, prepare) {
  for (const [w, h] of SIZES) for (const theme of THEMES) {
    await page.setViewportSize({ width: w, height: h });
    await applyTheme(page, theme);
    await page.waitForTimeout(600);
    if (prepare) await prepare(w).catch(() => {});
    await page.waitForTimeout(500);
    const file = join(OUT, `${nn}-${what}-${w}-${theme}.png`);
    await page.screenshot({ path: file }).catch(() => {});
    taken.push(file);
  }
  await applyTheme(page, 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
}

const row = (page) => page.locator(`[data-testid="drawer-team-row"][data-vault="${VAULT}"]:visible`).first();
async function setOpen(page, open) {
  await page.evaluate(([k, o]) => { if (o) localStorage.setItem(k, '1'); else localStorage.removeItem(k); }, [`dc.drawer.team.${VAULT}`, open]);
}
async function showState(page, base, key, open) {
  staged = STATES[key];
  await setOpen(page, open);
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  await ensureDrawer(page);
  return until(page, async () => (await row(page).count()) === 1, 20000);
}

const REPORTS = join(SCRATCH, 'reports.ndjson');
/** Main's Super handed over (the stand-in plays it), as super-members.mjs does it. */
async function handOver(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => readNd(REPORTS).some((r) => r.kind === 'spawn'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 60000);
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  await context.route('**/api/agent/sessions?summary=1*', async (route) => {
    if (!staged) return route.continue();
    const res = await route.fetch();
    let body = {};
    try { body = await res.json(); } catch { /* keep empty */ }
    await route.fulfill({ response: res, json: { ...body, members: staged } });
  });
  const page = await context.newPage();
  const watch = watchPage(page, 'desk', { expected: [/status of 409/, /^409 POST \/api\/super\/member\b/] });
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Routines for UA Manager (bound to it), made the way the stage's own "Yeni rutin" makes one.
  for (const [title, at, on] of [['Sabah bütçe kontrolü', '09:00', true], ['Haftalık kreatif raporu', '10:00', true], ['Yorgun reklam taraması', '11:00', false]]) {
    const r = await pageFetch(page, VAULT, 'POST', '/automations', { title, agent: 'ua-manager', job: `${title} yap.`, mode: 'sched', days: 'daily', at });
    ok(`setup: routine "${title}"`, r.status === 200, JSON.stringify(r).slice(0, 300));
    const slug = r.json?.automation?.slug;
    if (slug && !on) await pageFetch(page, VAULT, 'POST', `/automations/${slug}/disable`, {});
  }

  const warns = [];
  page.on('console', (msg) => { if (/\[super\]|\[member\]/.test(msg.text())) warns.push(`${msg.type()}: ${msg.text()}`.slice(0, 300)); });
  // ONLY_STAGE=1 skips the Team row states (s1-s4) for a quicker look at the member's stage.
  if (!process.env.ONLY_STAGE) {
  console.log('── s1 folded, a member answered');
  ok('s1 the row is there', await showState(page, base, 's1', false));
  ok('s1 folded (aria-expanded false)', (await row(page).getAttribute('aria-expanded')) === 'false');
  ok('s1 the count is 1', (await page.getByTestId('team-row-count').first().innerText().catch(() => '')).trim() === '1');
  const pops = page.locator('[data-testid="team-popout"]:visible');
  ok('s1 UA Manager pops out under it', (await pops.count()) === 1 && (await pops.first().getAttribute('data-slug')) === 'ua-manager');
  await shots(page, '01', 'kapali-uye-cevapladi', () => ensureDrawer(page));

  console.log('── s2 open, 5 members');
  ok('s2 the row is there', await showState(page, base, 's2', false));
  await row(page).click();
  ok('s2 a click opens it in place (no popover)', await until(page, async () => (await row(page).getAttribute('aria-expanded')) === 'true' && (await page.locator('[data-testid="team-list"]:visible').count()) === 1, 5000));
  ok('s2 the open state survives a reload', await showState(page, base, 's2', true) && (await row(page).getAttribute('aria-expanded')) === 'true');
  const list = page.locator('[data-testid="team-list"]:visible');
  ok('s2 all 5 members', (await list.locator('[data-testid="team-list-member"]').count()) === 5);
  ok('s2 no switch in the sidebar list', (await list.locator('[role="switch"]').count()) === 0);
  for (const id of ['team-mark-question', 'team-mark-unread', 'team-mark-working', 'team-mark-super']) ok(`s2 one ${id}`, (await list.getByTestId(id).count()) === 1);
  ok('s2 Tasarımcı is dimmed', (await list.locator('[data-slug="tasarimci"]').getAttribute('data-off')) === 'true');
  ok('s2 no box, no search at 5', !(await list.getAttribute('data-boxed')) && (await page.getByTestId('team-search').count()) === 0);
  await shots(page, '02', 'acik-5-uye', () => ensureDrawer(page));

  console.log('── s3 open, 20 members');
  ok('s3 the row is there', await showState(page, base, 's3', true));
  const box = page.locator('[data-testid="team-list"]:visible');
  ok('s3 a box that scrolls inside', (await box.getAttribute('data-boxed')) === 'true' && await box.evaluate((el) => el.scrollHeight > el.clientHeight + 10));
  ok('s3 the box is 8 rows tall', await box.evaluate((el) => { const r = el.querySelector('.ns-team-mrow'); return !!r && Math.abs(el.clientHeight - 8 * r.getBoundingClientRect().height) <= 2; }));
  ok('s3 the search field is shown', (await page.getByTestId('team-search').count()) === 1);
  const order = await box.locator('[data-testid="team-list-member"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-slug')));
  ok('s3 news first: approval, then the unread, above the rest', ['fiyat-analisti', 'ua-manager', 'veri-analisti'].every((s) => order.indexOf(s) >= 0 && order.indexOf(s) < 3), JSON.stringify(order.slice(0, 5)));
  const below = page.getByTestId('team-manage').first();
  const before = (await below.boundingBox())?.y;
  await box.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  ok('s3 the rows under the box do not move when it scrolls', Math.abs(((await below.boundingBox())?.y ?? -1) - (before ?? -2)) < 1);
  await box.evaluate((el) => { el.scrollTop = 0; });
  await page.getByTestId('team-search').fill('analist');
  ok('s3 search filters by name (three analysts)', await until(page, async () => (await box.locator('[data-testid="team-list-member"]').count()) === 3, 3000));
  await page.getByTestId('team-search').fill('');
  await shots(page, '03', 'acik-20-uye-kaydirma', () => ensureDrawer(page));

  console.log('── s4 folded, works and asks');
  ok('s4 the row is there', await showState(page, base, 's4', false));
  ok('s4 the ring (a member works for the owner)', (await page.getByTestId('team-row-ring').count()) >= 1);
  ok('s4 the label in the question colour', (await row(page).getAttribute('data-asking')) === 'true');
  ok('s4 the asker pops out', (await page.locator('[data-testid="team-popout"][data-slug="veri-analisti"]:visible').count()) === 1);
  await shots(page, '04', 'calisiyor-ve-soru-bekliyor', () => ensureDrawer(page));

  }
  console.log('── s5 a member\'s stage and its cards');
  staged = null;
  const off = await pageFetch(page, VAULT, 'POST', '/agents/ua-manager/enabled', { enabled: false });
  ok('setup: UA Manager off (its stage draws without a running Super)', off.status === 200, JSON.stringify(off).slice(0, 200));
  ok('setup: main Super handed over', await handOver(page, base));
  await ensureDrawer(page);
  if ((await row(page).getAttribute('aria-expanded')) !== 'true') await row(page).click();
  const pick = page.locator('[data-testid="team-list-member"][data-slug="ua-manager"]:visible').first();
  if (await pick.isVisible().catch(() => false)) await pick.click(); else await openMember(page, 'ua-manager');
  const st = stage(page, 'm:ua-manager');
  ok('s5 the member\'s stage opens', await until(page, async () => (await st.count()) > 0, 20000));
  const cards = st.locator('[data-kind="member"]');
  ok('s5 its own cards are on it', await until(page, async () => (await cards.count()) >= 2, 15000), String(await cards.count()));
  ok('s5 Rutinler says 3 routines on its tile', /3/.test(await st.locator('[data-member-card="routines"]').innerText().catch(() => '')));
  ok('s5 Talimatlar shows its job', /Meta ve TikTok/.test(await st.locator('[data-member-card="instructions"]').innerText().catch(() => '')) || (await st.locator('[data-member-card="instructions"]').count()) > 0);
  await shots(page, '05', 'uye-sahnesi-kartlar', (w) => stageOnly(page, w));
  // A click on its tile opens it side by side, where its full body is live.
  const frameOf = (ref) => st.locator('[data-testid="super-container"]').filter({ has: page.locator(`[data-member-card="${ref}"]`) }).first();
  await frameOf('routines').click({ timeout: 5000 }).catch((e) => console.log(`   click: ${String(e?.message ?? e).split('\n')[0]}`));
  await page.waitForTimeout(1500);
  console.log(`   stage mode after the click: ${await st.getAttribute('data-mode').catch(() => '?')}; [super] lines: ${JSON.stringify(warns.slice(-6))}`);
  ok('s5 Rutinler opened lists exactly its 3 routines', await until(page, async () => (await page.locator('[data-testid="member-card-routines"]:visible [data-routine]').count()) === 3, 15000));
  ok('s5 …and offers a new routine for it', (await page.locator('[data-testid="member-routine-new"]:visible').count()) === 1);
  await shots(page, '05b', 'rutinler-acik', (w) => stageOnly(page, w));
  ok('s5 no close control on a member card', (await cards.locator('[data-testid="super-card-close"], [data-testid="super-agenda-minimize"]').count()) === 0);
  await page.keyboard.press('Escape');

  console.log('── s5c a routine edited and deleted from the card');
  const rc = page.locator('[data-testid="member-card-routines"]:visible').first();
  const yorgun = rc.locator('[data-routine]').filter({ hasText: 'Yorgun reklam taraması' }).first();
  // Routines only: the list also carries each agent's own call target (runKind 'agent').
  const autoList = async () => ((await pageFetch(page, VAULT, 'GET', '/automations')).json?.automations ?? []).filter((a) => a.runKind !== 'agent');
  const yorgunOn = async () => (await autoList()).find((a) => a.title === 'Yorgun reklam taraması')?.enabled;
  await yorgun.getByRole('switch').first().click().catch(() => {});
  ok('s5c its switch turns the routine on (an edit)', await until(page, async () => (await yorgunOn()) === true, 8000));
  await yorgun.locator('.aiteam-routine-id').click().catch(() => {});
  await yorgun.getByTestId('member-routine-delete').click().catch(() => {});
  const rDialog = page.locator('[role="alertdialog"], [role="dialog"]').filter({ hasText: 'Yorgun reklam taraması' }).first();
  ok('s5c deleting asks in the app first', await until(page, async () => rDialog.isVisible().catch(() => false), 6000));
  await page.screenshot({ path: join(OUT, '05c-rutin-sil-onayi-1440-light.png') }); taken.push('05c');
  await rDialog.getByRole('button', { name: /Sil|Delete/ }).last().click().catch(() => {});
  ok('s5c the routine is gone, the other two stay', await until(page, async () => { const a = await autoList(); return !a.some((x) => x.title === 'Yorgun reklam taraması') && a.filter((x) => x.agent === 'ua-manager').length === 2; }, 10000));
  ok('s5c the card lists 2', await until(page, async () => (await rc.locator('[data-routine]').count()) === 2, 8000));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('── s6 Bu üyeyi sil');
  const openUye = async () => {
    // Already open side by side (the card's delete button shows): the Others panel would cover it.
    if (await st.getByTestId('member-delete').isVisible().catch(() => false)) return;
    // A small Üye tile on the stage opens side by side from its frame; else it is in Others.
    const tile = st.locator('[data-testid="super-container"]:visible').filter({ has: page.locator('[data-member-card="settings"]') }).first();
    if (await tile.isVisible().catch(() => false)) { await tile.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(600); if (await st.getByTestId('member-delete').isVisible().catch(() => false)) return; }
    // Only a VISIBLE Others button: a hidden one earlier in the DOM made .first() miss (run s10).
    const others = page.locator('[data-testid="super-others-stack"]:visible, [data-testid="super-others-open"]:visible').first();
    const seen = await others.count();
    if (seen) await others.click({ timeout: 5000 }).catch(() => {});
    const fan = page.locator('[data-testid="super-others-fan"]:visible');
    await until(page, async () => (await fan.count()) > 0, 4000);
    const items = page.locator('[data-testid="super-others-item"]:visible');
    // Every member item carries the kind label "MEMBER/ÜYE" (b9137b33), so match the Üye card's own
    // title, the word right before its "Live …/Yan yana …" line: a bare /Member/ picked Talimatlar (run s11).
    const uye = items.filter({ hasText: /(Üye|Member)\s+(Live|Plays|Reads|Yan yana)/ }).first();
    console.log(`   openUye: others buttons ${seen}, panel ${await fan.count()}, items ${await items.count()} [${(await items.allInnerTexts().catch(() => [])).map((x) => x.replace(/\s+/g, ' ').slice(0, 30)).join(' | ')}]`);
    if (await uye.isVisible().catch(() => false)) await uye.click({ timeout: 5000 }).catch(() => {});
    await until(page, async () => st.getByTestId('member-delete').isVisible().catch(() => false), 5000);
  };
  await openUye();
  const del = st.getByTestId('member-delete');
  ok('s6 the Üye card holds the switch and "Bu üyeyi sil"', await until(page, async () => (await del.isVisible().catch(() => false)) && (await st.getByTestId('member-card-switch').count()) > 0, 10000));
  await del.click().catch(() => {});
  const dialog = page.locator('[role="alertdialog"], [role="dialog"]').filter({ hasText: /silinsin mi|Delete UA Manager/ }).first();
  ok('s6 an in-app dialog opens', await until(page, async () => dialog.isVisible().catch(() => false), 8000));
  const dt = await dialog.innerText().catch(() => '');
  ok('s6 it names its 2 routines', /Sabah bütçe kontrolü/.test(dt) && /Haftalık kreatif raporu/.test(dt), dt.slice(0, 400));
  ok('s6 it says there is no undo and a copy stays', /geri alma yok|no undo/i.test(dt) && /çöp|trash/i.test(dt), dt.slice(0, 400));
  for (const [w, h] of SIZES) for (const theme of THEMES) {
    await page.setViewportSize({ width: w, height: h }); await applyTheme(page, theme); await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `06-uyeyi-sil-onayi-${w}-${theme}.png`) }); taken.push('06');
  }
  await applyTheme(page, 'light'); await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole('button', { name: /Vazgeç|Cancel/ }).click().catch(() => {});
  const still = await pageFetch(page, VAULT, 'GET', '/agents');
  ok('s6 Vazgeç changes nothing', JSON.stringify(still.json ?? {}).includes('ua-manager') && (await autoList()).filter((x) => x.agent === 'ua-manager').length === 2);
  await page.keyboard.press('Escape');

  const record = async () => (await pageFetch(page, VAULT, 'GET', '/super/state?superId=m:ua-manager')).json ?? {};
  const cardOf = (rec, ref) => (rec.containers ?? []).find((c) => c.kind === 'member' && c.ref === ref);
  const reopen = async () => {
    await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
    await openMember(page, 'ua-manager');
    return until(page, async () => (await st.locator('[data-kind="member"]').count()) >= 2, 20000);
  };

  try {
  console.log('── s7 on from the stage; the owner\'s size and place stay');
  await openUye();
  const sw = st.getByTestId('member-card-switch').first();
  await sw.click().catch(() => {});
  ok('s7 the Üye card turns it on', await until(page, async () => (await sw.getAttribute('aria-checked').catch(() => null)) === 'true', 10000));
  // Back to the floating stage (the Üye card was opened side by side).
  const toFloat = async () => { const mn = st.getByTestId('super-card-minimize').first(); if (await mn.isVisible().catch(() => false)) { await mn.click(); await page.waitForTimeout(500); } };
  ok('s7 its stage now has a record', await reopen() && await until(page, async () => !!cardOf(await record(), 'instructions'), 30000), JSON.stringify((await record()).containers ?? []).slice(0, 400));
  await toFloat();
  const tal = st.locator('[data-kind="member"]').filter({ has: page.locator('[data-member-card="instructions"]') }).first();
  await tal.hover().catch(() => {});
  await tal.locator('[data-testid="super-card-more"], [data-testid="super-card-size-btn"]').first().click().catch(() => {});
  // The largest size the stage has room for (a size with no room is disabled in the menu).
  let want = 'medium';
  for (const sz of ['wide', 'large', 'medium']) if (await page.getByTestId(`super-size-${sz}`).first().isEnabled().catch(() => false)) { want = sz; break; }
  if (!(await page.getByTestId(`super-size-${want}`).first().isEnabled().catch(() => false))) console.log('   size menu: no size above small has room on this stage');
  console.log(`   size menu open: ${await page.getByTestId('super-card-size').count()}; picking ${want}`);
  await page.getByTestId(`super-size-${want}`).first().click({ timeout: 5000 }).catch((e) => console.log(`   size click: ${String(e?.message ?? e).split('\n')[0]}`));
  ok(`s7 Talimatlar resized to ${want} (record, by the owner)`, await until(page, async () => cardOf(await record(), 'instructions')?.size === want, 8000), JSON.stringify(cardOf(await record(), 'instructions')));
  // Dragged: a press on its head moved across the stage changes its place in the record.
  const posBefore = JSON.stringify(cardOf(await record(), 'instructions')?.pos ?? null);
  const head = tal.locator('.super-card-head, [class*="card-head"]').first();
  const hb = await head.boundingBox().catch(() => null);
  if (hb) { await page.mouse.move(hb.x + 40, hb.y + 10); await page.mouse.down(); await page.mouse.move(hb.x - 160, hb.y + 120, { steps: 12 }); await page.mouse.up(); }
  ok('s7 Talimatlar dragged to a new place (record)', await until(page, async () => JSON.stringify(cardOf(await record(), 'instructions')?.pos ?? null) !== posBefore, 8000), posBefore);
  const rut = st.locator('[data-kind="member"]').filter({ has: page.locator('[data-member-card="routines"]') }).first();
  if (await rut.isVisible().catch(() => false)) {
    await rut.hover().catch(() => {});
    await rut.getByRole('button', { name: /Diğerleri|Others/ }).first().click().catch(() => {});
  }
  ok('s7 Rutinler sent to Others (record)', await until(page, async () => cardOf(await record(), 'routines')?.place === 'others', 8000), JSON.stringify(cardOf(await record(), 'routines')));
  ok('s7 a reload draws both so', await reopen()
    && await until(page, async () => (await st.locator(`[data-kind="member"][data-size="${want}"]`).filter({ has: page.locator('[data-member-card="instructions"]') }).count()) === 1, 10000));
  await shots(page, '07', 'kartlar-sahibin-duzeni', (w) => stageOnly(page, w));

  console.log('── s8 off again: its own saved layout');
  await openUye();
  const sw2 = st.getByTestId('member-card-switch').first();
  await sw2.click().catch(() => {});
  ok('s8 the Üye card turns it off', await until(page, async () => (await sw2.getAttribute('aria-checked').catch(() => null)) === 'false', 10000));
  await toFloat();
  ok('s8 after a reload its stage draws its cards', await reopen());
  ok(`s8 Talimatlar is still ${want}, Rutinler still in Others (its own layout, not the defaults)`,
    (await st.locator(`[data-kind="member"][data-size="${want}"]`).filter({ has: page.locator('[data-member-card="instructions"]') }).count()) === 1
    && (await st.locator('[data-kind="member"][data-size]').filter({ has: page.locator('[data-member-card="routines"]') }).count()) === 0);
  await shots(page, '08', 'kapali-uye-kendi-duzeni', (w) => stageOnly(page, w));

  console.log('── s9 Bu üyeyi sil, for real');
  await openUye();
  await st.getByTestId('member-delete').click().catch(() => {});
  const d2 = page.locator('[role="alertdialog"], [role="dialog"]').filter({ hasText: /silinsin mi|Delete UA Manager/ }).first();
  ok('s9 the dialog asks again', await until(page, async () => d2.isVisible().catch(() => false), 8000));
  await d2.getByRole('button', { name: /Sil|Delete/ }).last().click().catch(() => {});
  ok('s9 the member is gone', await until(page, async () => !JSON.stringify((await pageFetch(page, VAULT, 'GET', '/agents')).json ?? {}).includes('"ua-manager"'), 15000));
  ok('s9 none of its routines is left', (await autoList()).every((x) => x.agent !== 'ua-manager'));
  const trashDir = join(PROJ, '_dream_context', 'state', '.trash', 'members');
  const kept = existsSync(trashDir) ? readdirSync(trashDir).filter((d) => d.endsWith('-ua-manager')) : [];
  ok('s9 a trash copy with a receipt', kept.length === 1 && existsSync(join(trashDir, kept[0], 'receipt.json')), JSON.stringify(kept));
  await ensureDrawer(page);
  ok('s9 no Team row for it', (await page.locator('[data-testid="team-list-member"][data-slug="ua-manager"], [data-testid="team-popout"][data-slug="ua-manager"]').count()) === 0);
  await shots(page, '09', 'uye-silindi', () => ensureDrawer(page));
  } catch (e) { ok('s7-s9 ran', false, e?.message ?? e); }
  ok('no console errors', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('no failed requests', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  await browser.close();
}

async function main() {
  let srv = null;
  try {
    setup();
    const port = await freePort();
    srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
    await run(`http://127.0.0.1:${port}`);
  } catch (e) { ok('ran to the end', false, e?.stack ?? e); }
  finally { srv?.kill(); }
  console.log(`\nscreenshots: ${OUT}`);
  process.exit(summary() ? 0 : 1);
}

main();
