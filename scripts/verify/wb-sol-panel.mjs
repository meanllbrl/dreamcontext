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
  /* ── L: the branches the first run did not reach ── */
  // What is selected in a project's open body: the Super Agent, a window or a chat row.
  const selOf = (page, name) => page.evaluate((v) => {
    const el = document.querySelector(`[data-drawer-project="${v}"] .ns-dr-child.is-sel`);
    return el ? `${el.getAttribute('data-testid')}:${el.getAttribute('data-window-id') ?? el.getAttribute('data-chat-id') ?? ''}` : null;
  }, name);
  const currentBoard = (page) => page.evaluate(() => document.querySelector('.wbx-row[data-current="true"] .wbx-name')?.textContent ?? null);
  const order = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="chat-drawer"] [data-drawer-project]:not([data-hidden-project])')).map((e) => e.dataset.drawerProject));
  const enter = async (page, name, ms = 1800) => {
    await header(page, name).click();
    await page.waitForFunction((v) => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') === v, name, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };
  /** Every POST and every WebSocket input frame, for the "nothing is sent" checks (K6c). */
  const watchSends = (page) => {
    const all = [];
    // A hand-over without `quiet` queues the Super Agent's hand-over turn: name it so.
    page.on('request', (r) => { if (r.method() !== 'POST') return; const u = r.url().replace(app.base, ''); all.push(/\/super\/enable/.test(u) && !/"quiet"\s*:\s*true/.test(r.postData() ?? '') ? `${u} (turn queued: not quiet)` : u); });
    page.on('websocket', (ws) => ws.on('framesent', (f) => { const d = typeof f.payload === 'string' ? f.payload : ''; if (/"type"\s*:\s*"input"/.test(d)) all.push(`ws input ${d.slice(0, 80)}`); }));
    return all;
  };
  const turnLike = (u) => /ws input|not quiet|\/super\/(fresh|recap)|turn|message|send|prompt/i.test(u);
  {
    // L1 Whiteboards: a project left on a board comes back on that board.
    const { context, page } = await open(1440, 900, 'light');
    await tab(page, 'whiteboards');
    await page.waitForSelector('[data-testid="sidebar-explorer"] .wbx-row', { timeout: 20_000 }).catch(() => {});
    await enter(page, 'northwind');
    await page.locator('[data-testid="sidebar-explorer"] .wbx-row', { hasText: 'Riskler' }).first().click();
    await page.waitForTimeout(1200);
    const left = await currentBoard(page);
    await enter(page, 'orbit');
    const onOrbit = await currentBoard(page);
    await enter(page, 'northwind');
    const back = await currentBoard(page);
    check('L1 Whiteboards: a project comes back on the board it was left on', left === 'Riskler' && back === 'Riskler' && onOrbit !== 'Riskler', JSON.stringify({ left, onOrbit, back }));
    let f = join(app.shots, 'sonra-7-son-tahta-light-1440.png');
    await page.screenshot({ path: f }); keep(f, 'sonra-7-son-tahta-light-1440.png');

    // L7 keyboard on the open header: Enter folds, Space unfolds.
    await header(page, 'northwind').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const enterFold = (await layout(page)).projects.northwind.open === false && (await activeVault(page)) === 'northwind';
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
    const spaceOpen = (await layout(page)).projects.northwind.open === true;
    check('L7 Enter folds and Space unfolds the open header, project kept', enterFold && spaceOpen, JSON.stringify({ enterFold, spaceOpen }));
    // ⌥↓ / ⌥↑ move a project in the list and back.
    const o0 = await order(page);
    await header(page, 'northwind').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(600);
    const o1 = await order(page);
    await header(page, 'northwind').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForTimeout(600);
    const o2 = await order(page);
    check('L7 ⌥↓ moves the project down one place, ⌥↑ puts it back', o1.indexOf('northwind') === o0.indexOf('northwind') + 1 && o2.join() === o0.join() && (await activeVault(page)) === 'northwind', JSON.stringify({ o0, o1, o2 }));
    // Drag a folded header in view (orbit) above the first one, then back with ⌥↓.
    const dragName = 'orbit';
    const from = await header(page, dragName).boundingBox();
    const to = await header(page, o0[0]).boundingBox();
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y - 20, { steps: 6 });
    await page.mouse.move(to.x + 40, to.y + 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const o3 = await order(page);
    check('L7 drag moves a project to the top, and entering nothing', o3[0] === dragName && (await activeVault(page)) === 'northwind', JSON.stringify({ dragName, o3 }));
    for (let i = 0; i < o0.length && (await order(page)).join() !== o0.join(); i += 1) {
      await header(page, dragName).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForTimeout(250);
    }
    // Right-click opens the project menu, Escape closes it.
    await header(page, 'orbit').click({ button: 'right' });
    await page.waitForTimeout(300);
    const menuOpen = await page.getByTestId('drawer-project-menu').count();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('L7 right-click opens the project menu, without entering', menuOpen === 1 && (await page.getByTestId('drawer-project-menu').count()) === 0 && (await activeVault(page)) === 'northwind', JSON.stringify({ menuOpen }));
    // Hide a project from its menu: it moves into the Hidden group; show it again.
    await page.locator('[data-drawer-project="orbit"] [data-testid="drawer-project-more"]').first().click();
    await page.getByTestId('drawer-project-hide-item').click();
    await page.waitForTimeout(800);
    const hiddenNow = await page.locator('[data-testid="drawer-hidden-group"]').count();
    const orbitListed = (await order(page)).includes('orbit');
    await page.getByTestId('drawer-hidden-row').click();
    await page.waitForTimeout(400);
    await page.locator('[data-hidden-project="orbit"] [data-testid="drawer-project-more"]').first().click();
    await page.getByTestId('drawer-project-show-item').click();
    await page.waitForTimeout(800);
    check('L7 hide moves a project into the Hidden group, show brings it back', hiddenNow === 1 && !orbitListed && (await order(page)).includes('orbit'), JSON.stringify({ hiddenNow, orbitListed }));
    // Project search filters the list; Escape closes it.
    await page.getByTestId('drawer-project-search-btn').click();
    await page.getByTestId('drawer-project-search').fill('orb');
    await page.waitForTimeout(400);
    const found = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="chat-drawer"] [data-drawer-project]')).map((e) => e.dataset.drawerProject));
    await page.getByTestId('drawer-project-search').press('Escape');
    await page.waitForTimeout(300);
    check('L7 project search lists only the match', found.length === 1 && found[0] === 'orbit', JSON.stringify(found));
    // Board search narrows the open project's boards.
    const before = await page.locator('[data-testid="sidebar-explorer"] .wbx-row').count();
    await page.getByTestId('sidebar-board-search').fill('Göç');
    await page.waitForTimeout(500);
    const rows = await page.locator('[data-testid="sidebar-explorer"] .wbx-row .wbx-name').allTextContents();
    await page.getByTestId('sidebar-board-search').fill('');
    check('L7 board search narrows the boards', rows.length >= 1 && rows.length < before && rows.some((r) => r.includes('Göç')), JSON.stringify({ before, rows }));
    await context.close();
  }
  {
    // L2 Chat: a project with a chat. Make one in northwind from the New window menu.
    const { context, page } = await open(1440, 900, 'light');
    await tab(page, 'chat');
    const sends = watchSends(page);
    await page.getByTestId('drawer-new-window').click();
    await page.getByTestId('drawer-new-menu').getByRole('menuitem', { name: 'northwind', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') === 'northwind', null, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const made = await selOf(page, 'northwind');
    check('L2 setup: a chat window is open in northwind', !!made && !made.startsWith('drawer-super-row'), String(made));
    // Fold and unfold the active header: the open chat stays.
    await header(page, 'northwind').click();
    await page.waitForTimeout(500);
    const folded = (await layout(page)).projects.northwind.open === false;
    const stillVault = await activeVault(page);
    await header(page, 'northwind').click();
    await page.waitForTimeout(700);
    const again = await selOf(page, 'northwind');
    check('L2 Chat: folding the open header keeps the project and its open chat', folded && stillVault === 'northwind' && again === made, JSON.stringify({ folded, stillVault, made, again }));
    // Leave and come back: lands on that chat, not the Super Agent (a mounted project).
    await enter(page, 'orbit');
    await enter(page, 'northwind');
    const backTo = await selOf(page, 'northwind');
    check('L1 Chat: a project with a chat comes back on its last chat (mounted here)', backTo === made, JSON.stringify({ made, backTo }));
    let f = join(app.shots, 'sonra-8-chat-son-sohbet-light-1440.png');
    await page.screenshot({ path: f }); keep(f, 'sonra-8-chat-son-sohbet-light-1440.png');
    check('K6c no turn started in L2 (every POST listed)', !sends.some(turnLike), sends.join(', ') || 'none');
    console.log(`POSTs L2: ${sends.join(', ') || 'none'}`);
    await page.waitForTimeout(1500);
    await context.close();
  }
  {
    // L1b + L5: a fresh window, northwind NOT mounted, its saved chat read on the press. Folded
    // headers carry a question (orbit) and work (proj): their summaries answer with the marks.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await setTheme(context, 'light');
    await markAnnouncementsSeen(context, app.base);
    await context.route(/\/api\/agent\/sessions\?summary=1/, async (route) => {
      const v = route.request().headers()['x-dreamcontext-vault'];
      const res = await route.fetch();
      if (v !== 'orbit' && v !== 'proj') return route.fulfill({ response: res });
      const body = await res.json();
      return route.fulfill({ response: res, json: v === 'orbit' ? { ...body, superAsking: true } : { ...body, superOn: true, superWorking: 1 } });
    });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|\/ws\b|WebSocket/.test(m.text())) app.findings.push(`L5 console: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => app.findings.push(`L5 crash: ${String(e.message).slice(0, 200)}`));
    await page.goto(`${app.base}/?vault=${BIG}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('ns-titlebar').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await tab(page, 'chat');
    await page.waitForTimeout(3000);
    const marks = await page.evaluate(() => Object.fromEntries(['orbit', 'proj', 'northwind'].map((v) => {
      const h = document.querySelector(`[data-drawer-project="${v}"] > .ns-dr-proj`);
      return [v, { asking: !!h?.querySelector('[data-testid="mark-asking"]'), working: !!h?.querySelector('[data-testid="mark-working"]'), askRow: h?.getAttribute('data-ask-row') === 'true', label: h?.querySelector('.ns-dr-toggle')?.getAttribute('aria-label') ?? '' }];
    })));
    measures.marksChat = marks;
    check('L5 Chat: a folded header carries its question mark', marks.orbit.asking && marks.orbit.askRow, JSON.stringify(marks.orbit));
    check('L5 Chat: a folded header carries its work mark', marks.proj.working, JSON.stringify(marks.proj));
    let f = join(app.shots, 'sonra-9-isaretler-chat-light-1440.png');
    await page.screenshot({ path: f }); keep(f, 'sonra-9-isaretler-chat-light-1440.png');
    const mountedNow = await page.evaluate(() => Array.from(document.querySelectorAll('.project-instance')).map((e) => e.getAttribute('data-instance-vault')));
    const sends = watchSends(page);
    await enter(page, 'northwind', 2500);
    const landed = await selOf(page, 'northwind');
    check('L1 Chat: a project NOT mounted with a saved chat lands on that chat, not the Super Agent', !mountedNow.includes('northwind') && !!landed && !landed.startsWith('drawer-super-row'), JSON.stringify({ mountedNow, landed }));
    f = join(app.shots, 'sonra-10-chat-kayitli-sohbet-light-1440.png');
    await page.screenshot({ path: f }); keep(f, 'sonra-10-chat-kayitli-sohbet-light-1440.png');
    // Super Agent pick on a project with no chat: every POST listed.
    await enter(page, 'cedar', 2500);
    const cedarSuper = await page.locator('[data-drawer-project="cedar"] [data-testid="drawer-super-row"].is-sel').count();
    check('K6c Chat: cedar (no chat) opens on its Super Agent', cedarSuper === 1, String(cedarSuper));
    check('K6c no turn started (every POST listed)', !sends.some(turnLike), sends.join(', ') || 'none');
    console.log(`POSTs L1b/K6c: ${sends.join(', ') || 'none'}`);
    // The same marks on Whiteboards' folded headers.
    await tab(page, 'whiteboards');
    await page.waitForTimeout(2000);
    const wb = await page.evaluate(() => Object.fromEntries(['orbit', 'proj'].map((v) => {
      const h = document.querySelector(`[data-drawer-project="${v}"] > .ns-dr-proj`);
      return [v, { asking: !!h?.querySelector('[data-testid="mark-asking"]'), working: !!h?.querySelector('[data-testid="mark-working"]'), count: h?.querySelector('[data-testid="sidebar-board-count"]')?.textContent ?? null }];
    })));
    measures.marksWb = wb;
    // Its 3 seeded boards, plus the default one the app adds on a project's first open.
    check('L5 Whiteboards: folded headers carry question, work and board count', wb.orbit.asking && wb.proj.working && Number(wb.orbit.count) >= 3, JSON.stringify(wb));
    f = join(app.shots, 'sonra-11-isaretler-wb-light-1440.png');
    await page.screenshot({ path: f }); keep(f, 'sonra-11-isaretler-wb-light-1440.png');
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
