#!/usr/bin/env node
/**
 * The sidebar's one-open-project rule (wb-sol-panel, option A), in real Chromium on the dev server.
 * Four fictional projects: pocket-ledger with 34 boards in folders, northwind 9, orbit 3, proj 1.
 *
 *   K1  Whiteboards: a folded header enters that project (its board on screen) and folds the rest.
 *   K2  the open project's header only folds and unfolds: project and board stay the same.
 *   K3  1440×900, 34 boards open: every other header inside the column, body at top and bottom.
 *   K4  the open header and its chevron stay visible with the body scrolled to the end.
 *   K5  a folded header carries its board count (Whiteboards).
 *   K6  Chat: a folded project with no chat, not mounted here (proj), opens on its Super Agent; no message is sent.
 *   K6b the same for a project past the sidebar's background reads (9th+ folded, never mounted).
 *   K7  keyboard: ← folds, → unfolds the open header (aria-expanded follows).
 *   K8  ⌘2 (a move that is not a header) opens the new project and folds the old one.
 *   K9  no console error; shots light + dark at 1440 and 1180, and 390.
 *
 *   WB_SOL_OUT=<dir> dreamcontext builder heavy -- node scripts/verify/wb-sol-panel.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const OUT = process.env.WB_SOL_OUT ?? null;
const BIG = 'pocket-ledger';

const app = await openApp({ suite: 'wb-sol-panel' });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}` };
const tsx = (args, cwd) => spawnSync('npx', ['--yes', 'tsx', ...args], { cwd, env, encoding: 'utf-8' });

const boards = {
  [BIG]: [
    ...['Yol haritası', 'Lansman planı', 'Kayıt akışı', 'Ödeme ekranı'].map((n) => [n, null]),
    ...['Blog fikirleri', 'Fiyat sayfası', 'Kampanya takvimi', 'Mesaj çerçevesi', 'Persona', 'Rakip haritası', 'Meta seti A', 'Meta seti B', 'TikTok kancaları', 'Görsel varyantlar', 'SEO planı'].map((n) => [n, 'Pazarlama']),
    ...['Haftalık', 'Sprint planı', 'Retro', 'Kickoff', 'Yatırımcı', 'Müşteri görüşmesi'].map((n) => [n, 'Toplantılar']),
    ...['Onboarding', 'Ayarlar', 'Bildirimler', 'Profil', 'Arama', 'Boş durumlar', 'Hata ekranları', 'Paylaşım', 'Abonelik', 'Fatura', 'Destek', 'Karanlık tema', 'Tablet'].map((n) => [n, 'Ürün']),
  ],
  northwind: ['Mimari', 'Veri akışı', 'API', 'Yetki', 'Kuyruk', 'Raporlar', 'Göç planı', 'Riskler', 'Yol haritası'].map((n) => [n, null]),
  orbit: ['Fikirler', 'Akış', 'Ekranlar'].map((n) => [n, null]),
  proj: [['Taslak', null]],
};
const seed = (name, dir) => {
  const list = JSON.stringify(boards[name]);
  const code = `import { createWhiteboard } from ${JSON.stringify(join(REPO, 'src', 'lib', 'whiteboards', 'store.ts'))};
const root = ${JSON.stringify(join(dir, '_dream_context'))};
for (const [n, g] of ${list}) createWhiteboard(root, n, '', g ? { group: g, by: 'agent' } : {});`;
  const f = join(dir, 'seed.mts');
  writeFileSync(f, code);
  const r = tsx([f], dir);
  if (r.status !== 0) app.findings.push(`seed ${name}: ${(r.stderr || r.stdout).slice(-300)}`);
};
for (const name of [BIG, 'northwind', 'orbit']) {
  const dir = join(dirname(app.proj), name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = tsx([join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, dir], dir);
  if (r.status !== 0) app.findings.push(`register ${name}: ${r.stderr.slice(-200)}`);
  seed(name, dir);
}
seed('proj', app.proj);
// Enough empty projects that the last ones sit past the sidebar's background reads (8 folded).
const EXTRA = ['lumen', 'harbor', 'quill', 'atlas', 'cedar', 'delta', 'ember', 'fjord'];
const addExtra = () => { for (const name of EXTRA) {
  const dir = join(dirname(app.proj), name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = tsx([join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, dir], dir);
  if (r.status !== 0) app.findings.push(`register ${name}: ${r.stderr.slice(-200)}`);
} };
if (OUT) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const keep = (file, name) => { app.taken.push(file); if (OUT) copyFileSync(file, join(OUT, name)); };
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? ` — ${detail}` : ''}`); if (!cond) app.findings.push(`${name}${detail ? `: ${detail}` : ''}`); };
const measures = {};

async function open(width, height, theme) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await setTheme(context, theme);
  await markAnnouncementsSeen(context, app.base);
  const page = await context.newPage();
  const where = `${width}x${height} ${theme}`;
  page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|\/ws\b|WebSocket/.test(m.text())) app.findings.push(`${where} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => app.findings.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 400) console.log(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(app.base, '')}`); });
  await page.goto(`${app.base}/?vault=${BIG}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('ns-titlebar').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  return { context, page };
}
const activeVault = (page) => page.evaluate(() => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') ?? null);
const tab = async (page, t) => {
  await page.getByTestId(`ns-tab-${t}`).click();
  await page.waitForTimeout(1500);
};
const header = (page, name) => page.locator(`[data-drawer-project="${name}"] > .ns-dr-proj .ns-dr-toggle`);
/** What the column shows: each header's box against the scroll frame, and the open project. */
const layout = (page) => page.evaluate(() => {
  const sc = document.querySelector('[data-testid="chat-drawer"] .ns-dr-scroll');
  const f = sc.getBoundingClientRect();
  const out = { frame: { top: f.top, bottom: f.bottom, h: sc.clientHeight }, projects: {} };
  for (const el of sc.querySelectorAll('[data-drawer-project]')) {
    const head = el.querySelector(':scope > .ns-dr-proj');
    const r = head.getBoundingClientRect();
    const chev = head.querySelector('[data-testid="drawer-project-chevron"]')?.getBoundingClientRect();
    out.projects[el.dataset.drawerProject] = {
      open: el.dataset.open === 'true',
      visible: r.top >= f.top - 1 && r.bottom <= f.bottom + 1,
      chevVisible: !!chev && chev.top >= f.top - 1 && chev.bottom <= f.bottom + 1,
      top: Math.round(r.top), height: Math.round(el.getBoundingClientRect().height),
      count: head.querySelector('[data-testid="sidebar-board-count"]')?.textContent ?? null,
      expanded: head.querySelector('.ns-dr-toggle')?.getAttribute('aria-expanded'),
    };
  }
  return out;
});
const scrollBody = (page, where) => page.evaluate((w) => {
  const b = document.querySelector('[data-open-body]');
  if (!b) return null;
  b.scrollTop = w === 'end' ? b.scrollHeight : 0;
  return { scrollTop: b.scrollTop, scrollHeight: b.scrollHeight, clientHeight: b.clientHeight };
}, where);
const allVisible = (l) => Object.entries(l.projects).filter(([, v]) => !v.visible).map(([k]) => k);

try {
  /* ── 1440×900 light: the full run ── */
  {
    const { context, page } = await open(1440, 900, 'light');
    await tab(page, 'whiteboards');
    await page.waitForSelector('[data-testid="sidebar-explorer"] .wbx-row', { timeout: 20_000 }).catch(() => app.findings.push('the explorer never drew its rows'));
    await page.waitForTimeout(800);
    let l = await layout(page);
    measures.start = l;
    check('K3 the big project is the one open', l.projects[BIG]?.open === true && Object.entries(l.projects).every(([k, v]) => k === BIG || !v.open), JSON.stringify(l.projects));
    check('K3 every header in the column (body at top)', allVisible(l).length === 0, allVisible(l).join(', '));
    const bodyTop = await scrollBody(page, 'top');
    check('K3 the open body scrolls inside itself', !!bodyTop && bodyTop.scrollHeight > bodyTop.clientHeight, JSON.stringify(bodyTop));
    let file = join(app.shots, 'sonra-1-acik-proje-light-1440.png');
    await page.screenshot({ path: file }); keep(file, 'sonra-1-acik-proje-light-1440.png');
    const bodyEnd = await scrollBody(page, 'end');
    await page.waitForTimeout(200);
    l = await layout(page);
    measures.scrolledEnd = { body: bodyEnd, layout: l };
    check('K3 every header in the column (body at its end)', allVisible(l).length === 0, allVisible(l).join(', '));
    check('K4 the open header and its chevron visible with the body scrolled', l.projects[BIG].visible && l.projects[BIG].chevVisible);
    file = join(app.shots, 'sonra-2-kaydirilmis-light-1440.png');
    await page.screenshot({ path: file }); keep(file, 'sonra-2-kaydirilmis-light-1440.png');
    check('K5 folded headers carry their board count', l.projects.northwind?.count === '9' && l.projects.orbit?.count === '3', JSON.stringify({ n: l.projects.northwind?.count, o: l.projects.orbit?.count }));

    // K2: the open header folds and unfolds; nothing else moves.
    const boardBefore = await page.evaluate(() => document.querySelector('.wbx-row[data-current="true"] .wbx-name')?.textContent ?? null);
    await header(page, BIG).click();
    await page.waitForTimeout(500);
    l = await layout(page);
    const boardAfter = await page.evaluate(() => document.querySelector('.wbp-canvas') ? 'canvas' : null);
    check('K2 the open header folds', l.projects[BIG].open === false && l.projects[BIG].expanded === 'false');
    check('K2 folding keeps the project on screen', (await activeVault(page)) === BIG);
    check('K2 folding keeps the board on screen', boardAfter === 'canvas');
    file = join(app.shots, 'sonra-3-katli-light-1440.png');
    await page.screenshot({ path: file }); keep(file, 'sonra-3-katli-light-1440.png');
    await header(page, BIG).click();
    await page.waitForTimeout(800);
    l = await layout(page);
    const boardAgain = await page.evaluate(() => document.querySelector('.wbx-row[data-current="true"] .wbx-name')?.textContent ?? null);
    check('K2 the open header unfolds again, same board', l.projects[BIG].open === true && boardAgain === boardBefore, `${boardBefore} -> ${boardAgain}`);

    // K7: ← folds, → unfolds.
    await header(page, BIG).focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    const leftFold = (await layout(page)).projects[BIG].open === false;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    const rightOpen = (await layout(page)).projects[BIG].open === true;
    check('K7 ← folds and → unfolds the open header', leftFold && rightOpen, JSON.stringify({ leftFold, rightOpen }));

    // K1: a folded header enters its project and folds the rest.
    await header(page, 'northwind').click();
    await page.waitForFunction(() => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') === 'northwind', null, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    l = await layout(page);
    check('K1 a folded header enters its project', (await activeVault(page)) === 'northwind');
    check('K1 only that project is open', l.projects.northwind.open && Object.entries(l.projects).every(([k, v]) => k === 'northwind' || !v.open), JSON.stringify(Object.fromEntries(Object.entries(l.projects).map(([k, v]) => [k, v.open]))));
    check('K1 still on Whiteboards with its explorer', await page.locator('[data-testid="sidebar-explorer"] .wbx-row').count() > 0);
    // Its 34 seeded boards (the page may add one of its own on first open): the count is the list's.
    check('K5 the folded big project shows its board count', Number(l.projects[BIG].count) >= 34, String(l.projects[BIG].count));
    measures.afterEnter = l;
    file = join(app.shots, 'sonra-4-gecis-light-1440.png');
    await page.screenshot({ path: file }); keep(file, 'sonra-4-gecis-light-1440.png');

    // K8: ⌘1-9 (not a header) moves the open set too. The big project is the 2nd in the list order? Use its index.
    const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="chat-drawer"] [data-drawer-project]')).map((e) => e.dataset.drawerProject));
    const idx = order.indexOf('orbit') + 1;
    await page.locator('.wbp-canvas').first().click({ position: { x: 600, y: 400 } }).catch(() => {});
    await page.keyboard.press('Escape');
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
    await page.keyboard.press(`Meta+${idx}`);
    await page.waitForFunction(() => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') === 'orbit', null, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    l = await layout(page);
    check('K8 a ⌘-number move opens the new project and folds the old', (await activeVault(page)) === 'orbit' && l.projects.orbit.open && !l.projects.northwind.open, JSON.stringify({ active: await activeVault(page), orbit: l.projects.orbit.open, northwind: l.projects.northwind.open }));

    // K6: Chat, a folded project with no chat lands on its Super Agent, and nothing is sent.
    await tab(page, 'chat');
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/(turn|message|send|prompt)/i.test(r.url())) posts.push(r.url()); });
    // Chat input travels on the WebSocket (`{ type: 'input' }`): watch those frames too.
    page.on('websocket', (ws) => ws.on('framesent', (f) => { const d = typeof f.payload === 'string' ? f.payload : ''; if (/"type"\s*:\s*"input"/.test(d)) posts.push(`ws input ${d.slice(0, 80)}`); }));
    l = await layout(page);
    measures.chat = l;
    check('K1 Chat: only the project on screen is open', l.projects.orbit?.open && Object.entries(l.projects).every(([k, v]) => k === 'orbit' || !v.open), JSON.stringify(Object.fromEntries(Object.entries(l.projects).map(([k, v]) => [k, v.open]))));
    await header(page, 'proj').click();
    await page.waitForFunction(() => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') === 'proj', null, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    l = await layout(page);
    const superSel = await page.locator('[data-drawer-project="proj"] [data-testid="drawer-super-row"].is-sel').count();
    check('K6 Chat: a folded project with no chat enters on its Super Agent', (await activeVault(page)) === 'proj' && superSel === 1, JSON.stringify({ active: await activeVault(page), superSel }));
    check('K6 Chat: only it is open', l.projects.proj.open && Object.entries(l.projects).every(([k, v]) => k === 'proj' || !v.open));
    check('K6 no message was sent', posts.length === 0, posts.join(', '));
    file = join(app.shots, 'sonra-5-chat-light-1440.png');
    await page.screenshot({ path: file }); keep(file, 'sonra-5-chat-light-1440.png');
    await context.close();
  }
  /* ── the other looks: dark 1440, light + dark 1180, phone 390 ── */
  for (const [w, h, theme] of [[1440, 900, 'dark'], [1180, 800, 'light'], [1180, 800, 'dark']]) {
    const { context, page } = await open(w, h, theme);
    await tab(page, 'whiteboards');
    await page.waitForSelector('[data-testid="sidebar-explorer"] .wbx-row', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const l = await layout(page);
    measures[`${w}-${theme}`] = l;
    check(`K3 ${w} ${theme}: every header in the column`, allVisible(l).length === 0, allVisible(l).join(', '));
    const file = join(app.shots, `sonra-wb-${theme}-${w}.png`);
    await page.screenshot({ path: file }); keep(file, `sonra-wb-${theme}-${w}.png`);
    if (w === 1440) {
      await tab(page, 'chat');
      const f2 = join(app.shots, `sonra-chat-${theme}-${w}.png`);
      await page.screenshot({ path: f2 }); keep(f2, `sonra-chat-${theme}-${w}.png`);
    }
    await context.close();
  }
  /* ── K6b: a project past the sidebar's background reads (registered now, so K3 above measured
     the four-project column) ── */
  {
    addExtra();
    const { context, page } = await open(1440, 900, 'light');
    await tab(page, 'chat');
    await page.waitForTimeout(1500);
    const posts = [];
    page.on('websocket', (ws) => ws.on('framesent', (f) => { const d = typeof f.payload === 'string' ? f.payload : ''; if (/"type"\s*:\s*"input"/.test(d)) posts.push(`ws input ${d.slice(0, 80)}`); }));
    // K6b: the last listed project, past the first 8 folded ones the sidebar reads in the background.
    const listed = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="chat-drawer"] [data-drawer-project]:not([data-hidden-project])')).map((e) => e.dataset.drawerProject));
    const far = listed[listed.length - 1];
    const mountedNow = await page.evaluate(() => Array.from(document.querySelectorAll('.project-instance')).map((e) => e.getAttribute('data-instance-vault')));
    check('K6b the pressed project is past the background reads and not mounted', listed.length > 9 && EXTRA.includes(far) && !mountedNow.includes(far), JSON.stringify({ far, n: listed.length, mountedNow }));
    await header(page, far).click();
    await page.waitForFunction((v) => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') === v, far, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const farSuper = await page.locator(`[data-drawer-project="${far}"] [data-testid="drawer-super-row"].is-sel`).count();
    // Only the project on screen: another mounted project's hidden pane may say it.
    const emptyPane = await page.locator('.project-instance[data-active]').getByText(/No open chats/i).filter({ visible: true }).count();
    check('K6b Chat: a project past the background reads, with no chat, enters on its Super Agent', (await activeVault(page)) === far && farSuper === 1 && emptyPane === 0, JSON.stringify({ active: await activeVault(page), farSuper, emptyPane }));
    check('K6b no message was sent', posts.length === 0, posts.join(', '));
    const f6 = join(app.shots, 'sonra-6-chat-uzak-proje-light-1440.png');
    await page.screenshot({ path: f6 }); keep(f6, 'sonra-6-chat-uzak-proje-light-1440.png');
    await context.close();
  }
  {
    const { context, page } = await open(390, 844, 'light');
    await page.waitForTimeout(1000);
    const file = join(app.shots, 'sonra-telefon-390.png');
    await page.screenshot({ path: file }); keep(file, 'sonra-telefon-390.png');
    await context.close();
  }
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
if (OUT) writeFileSync(join(OUT, 'sonra-olcumler.json'), JSON.stringify(measures, null, 1));
await browser.close();
process.exit(await app.finish());
