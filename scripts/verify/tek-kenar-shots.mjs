#!/usr/bin/env node
/**
 * Tek kenar çubuğu, AC1: the shell as built, in a scratch HOME with seven fictional projects.
 * Chat, Tasks and Whiteboards at 1440×900 and 1180×800, light and dark, then 800×700 (the sidebar
 * floats closed, Insights and Apps sit in More). Per screen it checks: the sidebar with the logo at
 * the top and Settings at the foot, no page icon strip, no picker caret, no centred brand, the tabs
 * Chat · Tasks · Insights · Whiteboards · Apps · More with the shown page lit, a drag region in the
 * bar, and no console errors. The screenshots are for reading beside kareler/o3-*.png.
 *
 *   TEK_KENAR_OUT=<dir> dreamcontext builder heavy -- node scripts/verify/tek-kenar-shots.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const OUT = process.env.TEK_KENAR_OUT ?? null;
const PROJECTS = ['proj', 'pocket-ledger', 'northwind', 'orbit', 'lumen', 'harbor', 'quill'];
const PAGES = [['chat', 'chat'], ['tasks', 'tasks'], ['wb', 'whiteboards']];
const SIZES = [[1440, 900], [1180, 800]];
const TABS = ['ns-tab-chat', 'ns-tab-tasks', 'ns-tab-lab', 'ns-tab-whiteboards', 'ns-tab-apps', 'ns-tab-more'];

const app = await openApp({ suite: 'tek-kenar-shots' });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}` };
for (const name of PROJECTS.slice(1)) {
  const dir = join(dirname(app.proj), name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, dir], { cwd: dir, env, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`register ${name}: ${r.stderr.slice(-200)}`);
}
if (OUT) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const keep = (file, name) => { app.taken.push(file); if (OUT) copyFileSync(file, join(OUT, name)); };

/** What AC1 asks of the shell, read off the page. */
async function checkShell(page, where, { narrow = false, page: shown = null } = {}) {
  const s = await page.evaluate((tabs) => {
    const q = (sel) => document.querySelector(sel);
    const aside = q('[data-testid="chat-drawer"]');
    const box = aside?.getBoundingClientRect();
    const lit = q('[data-testid^="ns-tab-"][data-on]')?.getAttribute('data-testid') ?? null;
    return {
      sidebar: !!aside && !!box && box.width > 0 && box.right > 0,
      logo: !!aside?.querySelector('[data-testid="sidebar-brand"] img, [data-testid="sidebar-brand"] svg'),
      settings: !!aside?.querySelector('[data-testid="sidebar-settings"]'),
      rail: !!q('[data-testid^="ns-rail-"]'),
      caret: !!q('.ns-tb-caret'),
      brand: !!q('.ns-tb-brand'),
      tabs: tabs.filter((t) => q(`[data-testid="${t}"]`)),
      lit,
      // The bar is the window's drag handle wherever no control (data-no-drag) sits: some free
      // point along its middle must hit the bar itself or a non-control child.
      drag: (() => {
        const bar = q('[data-testid="ns-titlebar"]');
        if (!bar) return false;
        const r = bar.getBoundingClientRect();
        for (let x = r.left + 90; x < r.right - 10; x += 12) {
          const hit = document.elementFromPoint(x, r.top + r.height / 2);
          if (hit && bar.contains(hit) && !hit.closest('[data-no-drag]')) return true;
        }
        return false;
      })(),
    };
  }, TABS);
  const bad = [];
  if (!narrow && !s.sidebar) bad.push('no sidebar');
  if (narrow && s.sidebar) bad.push('the sidebar is open at 800 px');
  if (!narrow && !s.logo) bad.push('no logo at the top of the sidebar');
  if (!narrow && !s.settings) bad.push('no Settings at the foot of the sidebar');
  if (s.rail) bad.push('a page icon strip is drawn');
  if (s.caret) bad.push('the picker caret is drawn');
  if (s.brand) bad.push('the centred brand is drawn');
  const want = narrow ? TABS.filter((t) => t !== 'ns-tab-lab' && t !== 'ns-tab-apps') : TABS;
  for (const t of want) if (!s.tabs.includes(t)) bad.push(`tab ${t} missing`);
  if (narrow) for (const t of ['ns-tab-lab', 'ns-tab-apps']) if (s.tabs.includes(t)) bad.push(`${t} still in the bar at 800 px`);
  if (shown && s.lit !== `ns-tab-${shown}`) bad.push(`lit tab ${s.lit}, not ns-tab-${shown}`);
  if (!s.drag) bad.push('no drag region in the title bar');
  for (const b of bad) app.findings.push(`${where}: ${b}`);
}

async function open(width, height, theme) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await setTheme(context, theme);
  await markAnnouncementsSeen(context, app.base);
  const page = await context.newPage();
  const where = `${width}x${height} ${theme}`;
  page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|\/ws\b|WebSocket/.test(m.text())) app.findings.push(`${where} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => app.findings.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
  await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('ns-titlebar').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

const go = async (page, tab) => {
  await page.getByTestId(`ns-tab-${tab}`).click();
  await page.waitForFunction((t) => {
    const p = document.querySelector('.project-instance[data-active]')?.getAttribute('data-page');
    return t === 'chat' ? !!document.querySelector('[data-testid="ns-tab-chat"][data-on]') : p === t;
  }, tab, { timeout: 15_000 }).catch(() => app.findings.push(`${tab} never shown`));
  await page.waitForTimeout(1200);
};

try {
  for (const [w, h] of SIZES) for (const theme of ['light', 'dark']) {
    const { context, page } = await open(w, h, theme);
    for (const [short, tab] of PAGES) {
      await go(page, tab);
      await checkShell(page, `${short} ${w} ${theme}`, { page: tab });
      const file = join(app.shots, `tk-${short}-${w}-${theme}.png`);
      await page.screenshot({ path: file });
      keep(file, `tk-${short}-${w}-${theme}.png`);
    }
    await context.close();
  }
  // 800×700: the sidebar floats closed; Insights and Apps move into More.
  const { context, page } = await open(800, 700, 'light');
  await go(page, 'tasks');
  await checkShell(page, 'tasks 800 light', { narrow: true, page: 'tasks' });
  let file = join(app.shots, 'tk-tasks-800-light.png');
  await page.screenshot({ path: file });
  keep(file, 'tk-tasks-800-light.png');
  await page.getByTestId('ns-tab-more').click();
  await page.waitForTimeout(400);
  file = join(app.shots, 'tk-more-800-light.png');
  await page.screenshot({ path: file });
  keep(file, 'tk-more-800-light.png');
  await context.close();
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
await browser.close();
process.exit(await app.finish());
