#!/usr/bin/env node
/**
 * The Team block reads as a hierarchy (owner, 3 Nov): in the drawer, a Team's members sit one
 * level deeper than the Team row (their avatar starts past the Team row's chevron, on the
 * drawer's own nested tree line), one step smaller and lighter than the project's rows, and
 * "Manage members" lines up with them. Same for the Global team. Measured, then drawn.
 *
 *   npm run build && node scripts/verify/ekip-hiza.mjs [outDir] [prefix]
 *   CLASSIC=1 node scripts/verify/ekip-hiza.mjs [outDir]   (the classic rail)
 *
 * prefix (default "after") names the screenshots: <prefix>-1440-light.png, <prefix>-1440-dark.png,
 * <prefix>-390-light.png, <prefix>-390-dark.png. The geometry checks run in every case, so on the
 * old code they FAIL (that is the point: they are the claim).
 *
 *   h1 open, 6 members + a global one: depth, size, avatar, manage alignment, the tree line.
 *   h2 the Global team: the same depth relative to its own row.
 *   h3 open, 20 members: still a box 8 rows tall that scrolls inside; the row under it holds still.
 *   h4 folded, a member with unread pops out at the members' depth with its count.
 *   h5 no member: one plain "Set your team" row whose text starts where "Chat" starts (1px), in
 *      every width and theme; no faces, no chevron.
 * Console errors and failed requests are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { closeDrawer, drawerShown, openDrawer } from './lib/phone-shell.mjs';
import { applyTheme, cleanEnv, freePort, reporter, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-ekip-hiza-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'ekip-hiza'));
const CLASSIC = process.env.CLASSIC === '1';
const PREFIX = process.argv[3] || (CLASSIC ? 'classic' : 'after');

const SIX = [['veri-analisti', 'Veri Analisti'], ['ua-manager', 'UA Manager'], ['icerik-yazari', 'İçerik Yazarı'],
  ['destek-uzmani', 'Destek Uzmanı'], ['tasarimci', 'Tasarımcı'], ['fiyat-analisti', 'Fiyat Analisti']];
const MORE = Array.from({ length: 14 }, (_, i) => [`uye-${i + 1}`, `Üye ${i + 1}`]);
const GLOBAL = ['genel-asistan', 'Genel Asistan'];

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const { ok, summary } = reporter();

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  // CLASSIC=1: the classic rail (its Team is the same TeamSection, its indent its own).
  if (CLASSIC) writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'classic' }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  // One chat window named "Chat" (the row h5 lines "Set your team" up with).
  writeFileSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({
    sessions: [{ title: 'Chat', kind: 'chat', sessionId: '6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b', pane: 0, active: true, window: 'main', size: 1, bypass: false, minimized: false }],
    activePane: 0, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 0 }], generation: 1,
  }));
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: join(SCRATCH, 'reports.ndjson'), cli: CLI }));
  chmodSync(bin, 0o755);
  const steps = [['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })]];
  for (const [slug, title] of [...SIX, ...MORE, GLOBAL]) steps.push([`agent ${slug}`, dc('agents', 'create', slug, '--title', title, '--prompt', `${title} işini yapar.`)]);
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

let staged = null;
const m = (slug, o = {}) => ({ slug, global: false, enabled: true, ownerWorking: 0, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 0, pending: 0, ...o });
const g = m(GLOBAL[0], { global: true, unread: 1, lastAt: 3 });
const STATES = {
  six: [m('veri-analisti', { asking: true, lastAt: 9 }), m('ua-manager', { unread: 2, lastAt: 8 }), m('icerik-yazari', { ownerWorking: 1, lastAt: 7 }),
    m('destek-uzmani'), m('tasarimci', { superOnly: true }), m('fiyat-analisti', { enabled: false }), g],
  twenty: [...SIX.map(([s]) => m(s)), ...MORE.map(([s]) => m(s)), g],
  folded: [m('ua-manager', { unread: 1, lastAt: 5 }), ...SIX.filter(([s]) => s !== 'ua-manager').map(([s]) => m(s))],
  empty: [],
};

const row = (page) => page.locator(`[data-testid="drawer-team-row"][data-vault="${VAULT}"]:visible`).first();
async function ensureDrawer(page) {
  if (await page.locator('[data-testid="drawer-team-row"]:visible').count()) return;
  if (await page.getByTestId('ns-drawer-toggle').count()) await openDrawer(page).catch(() => {});
}
async function show(page, base, key, { open = true, globalOpen = true } = {}) {
  staged = STATES[key];
  await page.evaluate(([k, o, go]) => {
    if (o) localStorage.setItem(k, '1'); else localStorage.removeItem(k);
    if (go) localStorage.setItem('dc.drawer.team.global', '1'); else localStorage.removeItem('dc.drawer.team.global');
  }, [`dc.drawer.team.${VAULT}`, open, globalOpen]);
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  await ensureDrawer(page);
  return until(page, async () => (await row(page).count()) === 1, 20000);
}

/** The geometry of one Team section: the row's chevron and label, the members, the manage link. */
const measure = (page, rowSel) => page.evaluate((sel) => {
  const r = document.querySelector(sel);
  if (!r) return null;
  const sec = r.closest('.ns-team-sec');
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
  const fs = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null);
  const mrow = sec?.querySelector('.ns-team-mrow');
  // The line belongs to the members' box (open list or pop-outs), so it never scrolls with them.
  const li = mrow?.closest('.ns-team-open-list') ?? mrow?.closest('ul');
  const before = li ? getComputedStyle(li, '::before') : null;
  const manage = sec?.querySelector('[data-testid="team-manage"]');
  let manageText = null;
  if (manage?.firstChild) { const rg = document.createRange(); rg.selectNodeContents(manage); manageText = box(rg); }
  return {
    chev: box(r.querySelector('.ns-team-chev')),
    faces: box(r.querySelector('.ns-team-faces')),
    label: box(r.querySelector('.ns-team-label')),
    labelFs: fs(r.querySelector('.ns-team-label')),
    labelColor: getComputedStyle(r.querySelector('.ns-team-label') ?? r).color,
    avatar: box(mrow?.querySelector('.agent-av')),
    mrow: box(mrow),
    nameFs: fs(mrow?.querySelector('.ns-team-mname')),
    nameColor: mrow ? getComputedStyle(mrow.querySelector('.ns-team-mname')).color : null,
    line: before && before.content !== 'none' && before.content !== 'normal'
      ? { left: li.getBoundingClientRect().left + parseFloat(before.left || '0'), w: parseFloat(before.width), h: parseFloat(before.height) } : null,
    manage: box(manage),
    manageText,
    manageFs: fs(manage),
  };
}, rowSel);

/** The member checks every Team section must pass. */
function hierarchy(tag, g) {
  ok(`${tag}: measured`, !!g && !!g.mrow && !!g.chev, JSON.stringify(g));
  if (!g?.mrow || !g.chev) return;
  ok(`${tag}: a member's avatar starts past the Team row's chevron (one level deeper)`, g.avatar && g.avatar.l >= g.chev.r + 4, `avatar ${g.avatar?.l} chevron right ${g.chev.r}`);
  ok(`${tag}: and no further than the Team row's faces`, g.avatar && g.faces && g.avatar.l <= g.faces.l + 2, `avatar ${g.avatar?.l} faces ${g.faces?.l}`);
  ok(`${tag}: member names one step smaller than the Team label`, g.nameFs < g.labelFs, `name ${g.nameFs} label ${g.labelFs}`);
  ok(`${tag}: a smaller avatar (under 22px)`, g.avatar && g.avatar.w < 22, `avatar ${g.avatar?.w}`);
  ok(`${tag}: a tree line on the members' left, past the Team row's own start`, !!g.line && g.line.left > g.chev.l - 1 && g.line.left < g.avatar.l, JSON.stringify(g.line));
  if (g.manage) {
    ok(`${tag}: "Manage members" starts where the member avatars start`, g.manageText && Math.abs(g.manageText.l - g.avatar.l) <= 1, `manage ${g.manageText?.l} avatar ${g.avatar?.l}`);
    ok(`${tag}: "Manage members" in the members' size`, g.manageFs === g.nameFs, `manage ${g.manageFs} name ${g.nameFs}`);
  }
}

async function shots(page, prepare) {
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: h });
    await applyTheme(page, theme);
    await page.waitForTimeout(600);
    await prepare(w).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, `${PREFIX}-${w}-${theme}.png`) }).catch(() => {});
  }
  await applyTheme(page, 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
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
  const watch = watchPage(page, 'desk');
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  console.log('── h1 open, 6 members');
  ok('h1 the row is there', await show(page, base, 'six'));
  ok('h1 six members listed', await until(page, async () => (await page.locator('[data-testid="team-list"]:visible [data-testid="team-list-member"]').count()) === 6, 8000));
  const own = await measure(page, `[data-testid="drawer-team-row"][data-vault="${VAULT}"]`);
  hierarchy('h1 project team', own);
  const list = page.locator('[data-testid="team-list"]:visible');
  for (const id of ['team-mark-question', 'team-mark-unread', 'team-mark-working', 'team-mark-super']) ok(`h1 one ${id}`, (await list.getByTestId(id).count()) === 1);
  ok('h1 the off member is dimmed', (await list.locator('[data-slug="fiyat-analisti"]').getAttribute('data-off')) === 'true');

  console.log('── h2 the Global team');
  ok('h2 the global list is open', await until(page, async () => (await page.locator('[data-testid="global-team-list"]:visible [data-testid="team-list-member"]').count()) === 1, 8000));
  hierarchy('h2 global team', await measure(page, '[data-testid="drawer-global-team-row"]'));

  await shots(page, async (w) => {
    await ensureDrawer(page);
    if (w > 600) return;
    if (!(await drawerShown(page))) await openDrawer(page).catch(() => {});
  });

  console.log('── h3 open, 20 members');
  ok('h3 the row is there', await show(page, base, 'twenty'));
  const box = page.locator('[data-testid="team-list"]:visible');
  ok('h3 boxed', (await box.getAttribute('data-boxed')) === 'true');
  const geo = await box.evaluate((el) => {
    const rows = [...el.querySelectorAll('.ns-team-mrow')];
    const rh = rows[0]?.getBoundingClientRect().height ?? 0;
    const manage = el.parentElement?.querySelector('[data-testid="team-manage"]');
    const before = manage?.getBoundingClientRect().top;
    el.scrollTop = 200;
    const after = manage?.getBoundingClientRect().top;
    return { client: el.clientHeight, scroll: el.scrollHeight, rh, scrolled: el.scrollTop, before, after };
  });
  ok('h3 the box is 8 rows tall', Math.abs(geo.client - 8 * geo.rh) <= 2, JSON.stringify(geo));
  ok('h3 it scrolls inside', geo.scroll > geo.client && geo.scrolled > 0, JSON.stringify(geo));
  ok('h3 the row under it holds still', geo.before === geo.after, JSON.stringify(geo));
  ok('h3 the search field is there', (await page.getByTestId('team-search').count()) === 1);
  hierarchy('h3 project team (boxed)', await measure(page, `[data-testid="drawer-team-row"][data-vault="${VAULT}"]`));

  console.log('── h4 folded, one member with unread');
  ok('h4 the row is there', await show(page, base, 'folded', { open: false }));
  ok('h4 folded', (await row(page).getAttribute('aria-expanded')) === 'false');
  const pop = page.locator('[data-testid="team-popout"]:visible');
  ok('h4 UA Manager pops out with its count', (await pop.count()) === 1 && (await pop.first().getByTestId('team-mark-unread').innerText()).trim() === '1');
  const pg = await measure(page, `[data-testid="drawer-team-row"][data-vault="${VAULT}"]`);
  ok('h4 the pop-out sits at the members\' depth', pg?.avatar && own?.avatar && Math.abs(pg.avatar.l - own.avatar.l) <= 1, `pop ${pg?.avatar?.l} open ${own?.avatar?.l}`);

  // The classic rail draws no Team row for an empty team (SidebarTeam); the drawer reads "Set your team".
  if (!CLASSIC) {
    console.log('── h5 no member');
    ok('h5 the row is there', await show(page, base, 'empty', { open: false }));
    const r = row(page);
    ok('h5 it reads "Set your team"', (await r.getAttribute('data-empty')) === 'true' && (await r.innerText()).trim() === 'Set your team');
    ok('h5 no faces, no chevron, no empty slot', (await r.locator('.ns-team-faces, .ns-team-chev, [data-testid="team-empty-slot"]').count()) === 0);
    /** The left edge of a row's painted text, and its type. */
    const edges = () => page.evaluate((v) => {
      const text = (btn) => {
        const t = btn?.querySelector('.ns-dr-t');
        if (!t) return null;
        const rg = document.createRange(); rg.selectNodeContents(t);
        const cs = getComputedStyle(t);
        return { cls: btn.classList.contains('ns-dr-row') && btn.classList.contains('ns-dr-child'), l: rg.getBoundingClientRect().left, r: btn.getBoundingClientRect().right, fs: cs.fontSize, fw: cs.fontWeight, color: cs.color, h: btn.getBoundingClientRect().height };
      };
      const proj = document.querySelector(`[data-drawer-project="${v}"]`) ?? document;
      const vis = (sel) => [...proj.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
      const team = vis('[data-testid="drawer-team-row"]');
      const pane = team?.closest('.ns-dr-children')?.getBoundingClientRect();
      return { team: text(team), chat: text(vis('[data-testid="drawer-window-row"]')), paneR: pane?.right ?? null };
    }, VAULT);
    for (const [w, h] of [[1440, 900], [390, 844]]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: w, height: h });
      await applyTheme(page, theme);
      await page.waitForTimeout(500);
      await ensureDrawer(page);
      if (w <= 600 && !(await drawerShown(page))) await openDrawer(page).catch(() => {});
      await page.waitForTimeout(500);
      const e = await edges();
      const tag = `h5 ${w} ${theme}`;
      await page.screenshot({ path: join(OUT, `${PREFIX}-empty-${w}-${theme}.png`) }).catch(() => {});
      ok(`${tag}: a "Chat" row to compare with`, !!e.chat && !!e.team, JSON.stringify(e));
      if (!e.chat || !e.team) continue;
      ok(`${tag}: "Set your team" starts where "Chat" starts (1px)`, Math.abs(e.team.l - e.chat.l) <= 1, `team ${e.team.l} chat ${e.chat.l}`);
      // Chat is the row on screen (selected), so weight and colour are compared through the classes: the same row rules.
      ok(`${tag}: Chat's row (its classes, size and height)`, e.team.cls && e.team.fs === e.chat.fs && e.team.h === e.chat.h, JSON.stringify(e));
      ok(`${tag}: no overflow past the drawer`, e.paneR === null || e.team.r <= e.paneR + 0.5, JSON.stringify(e));
    }
    await applyTheme(page, 'light');
    await page.setViewportSize({ width: 1440, height: 900 });
    await r.click();
    ok('h5 a click opens Manage members', await until(page, async () => (await page.locator('[data-testid="manage-members-modal"]:visible').count()) === 1, 20000));
  }

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
