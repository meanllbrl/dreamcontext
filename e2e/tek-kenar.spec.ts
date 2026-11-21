import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- the verify harness is plain ESM without types
import { openApp } from '../scripts/verify/lib/app.mjs';
// @ts-expect-error -- the verify harness is plain ESM without types
import { markAnnouncementsSeen } from '../scripts/verify/lib/measure.mjs';

/**
 * Tek kenar çubuğu (AC2, AC3, AC5, AC6, AC7): the one sidebar's modes, one-click switches,
 * back/forward and keys across projects, and the sidebar toggle. Seven fictional projects in a
 * scratch HOME (the verify harness: API from source, the dashboard's Vite), never ~/.dreamcontext.
 *
 *   dreamcontext builder heavy -- npx playwright test -c e2e/tek-kenar.config.ts
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = ['proj', 'pocket-ledger', 'northwind', 'orbit', 'lumen', 'harbor', 'quill'];

type App = { base: string; home: string; proj: string; stop: () => Promise<void> };
let app: App;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  app = await openApp({ suite: 'tek-kenar-e2e', onHarness: 'throw' });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}` };
  for (const name of PROJECTS.slice(1)) {
    const dir = join(dirname(app.proj), name);
    mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, dir], { cwd: dir, env, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`register ${name}: ${r.stderr.slice(-200)}`);
  }
  const post = (v: string, path: string, body: unknown) => fetch(`${app.base}/api${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': v }, body: JSON.stringify(body),
  });
  for (const v of PROJECTS) await post(v, '/whiteboards', { name: v === 'pocket-ledger' ? 'Launch plan' : `${v} map` });
  await post('northwind', '/tasks', { name: 'Approve beta list', why: 'Who gets the beta.' });
  await post('proj', '/tasks', { name: 'Warehouse import', why: 'Move the stock list.' });
});

test.afterAll(async () => { await app?.stop(); });

test.use({ viewport: { width: 1440, height: 900 } });

const active = (page: Page) => page.evaluate(() => {
  const inst = document.querySelector('.project-instance[data-active]');
  return { vault: inst?.getAttribute('data-instance-vault') ?? null, page: inst?.getAttribute('data-page') ?? null, item: inst?.getAttribute('data-item') ?? null };
});
const expectActive = (page: Page, want: { vault?: string; page?: string; item?: string | null }) =>
  expect.poll(async () => {
    const a = await active(page);
    return Object.fromEntries(Object.keys(want).map((k) => [k, a[k as keyof typeof a]]));
  }, { timeout: 12_000 }).toEqual(want);
const mode = (page: Page) => page.getByTestId('chat-drawer').getAttribute('data-mode');
const row = (page: Page, name: string) => page.locator(`[data-row-key="project:${name}"]`).first();
const tab = (page: Page, p: string) => page.getByTestId(`ns-tab-${p}`);

async function open(page: Page, path = '/?vault=proj') {
  await markAnnouncementsSeen(page.context(), app.base);
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`${app.base}${path}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-drawer').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
}

test('AC2 modes: projects on Tasks, boards on Whiteboards, chats on Chat', async ({ page }) => {
  await open(page);
  await tab(page, 'tasks').click();
  await expect.poll(() => mode(page)).toBe('projects');
  await expect(page.locator('[data-row-key^="project:"]')).toHaveCount(PROJECTS.length);
  await expect(page.getByTestId('drawer-chat-row')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-brand')).toBeVisible();
  await expect(page.getByTestId('sidebar-settings')).toBeVisible();
  // No 'acme ▾' picker: the project label stays (it opens the picker) but carries no caret.
  await expect(page.getByTestId('ns-picker-btn')).toHaveAttribute('data-local', 'true');
  await expect(page.locator('[data-testid="ns-picker-btn"] .ns-tb-caret')).toHaveCount(0);

  await tab(page, 'whiteboards').click();
  await expect.poll(() => mode(page)).toBe('boards');
  // The active project's own explorer sits under its row, with New board and New folder.
  await expect(page.getByTestId('sidebar-explorer')).toBeVisible();
  await expect(page.getByTestId('sidebar-boards-foot').getByRole('button', { name: /New board|Yeni board/ })).toBeVisible();
  await expect(page.getByTestId('sidebar-boards-foot').getByRole('button', { name: /New folder|Yeni klasör/ })).toBeVisible();
  // Another project folds open by its chevron and lists its boards.
  await page.locator('[data-drawer-project="pocket-ledger"] [data-testid="sidebar-boards-chevron"]').click();
  await expect(page.locator('[data-testid="sidebar-boards"][data-vault="pocket-ledger"]').getByText('Launch plan')).toBeVisible({ timeout: 12_000 });
  // Search boards filters the other projects' lists.
  await page.getByTestId('sidebar-board-search').fill('launch');
  await expect(page.locator('[data-testid="sidebar-boards"][data-vault="pocket-ledger"] [data-testid="sidebar-board-row"]')).toHaveCount(1);
  await page.getByTestId('sidebar-board-search').fill('');

  await tab(page, 'chat').click();
  await expect.poll(() => mode(page)).toBe('chat');
  await expect(page.getByTestId('drawer-new-window')).toBeVisible();
});

test('AC3 one click: same page in B, a board row of B, Chat on Chat, the item left open', async ({ page }) => {
  await open(page);
  await tab(page, 'tasks').click();
  await expectActive(page, { vault: 'proj', page: 'tasks' });
  await row(page, 'northwind').click();
  await expectActive(page, { vault: 'northwind', page: 'tasks' });

  // A board row of B opens that board in B.
  await tab(page, 'whiteboards').click();
  await page.locator('[data-drawer-project="pocket-ledger"] [data-testid="sidebar-boards-chevron"]').click().catch(() => {});
  const board = page.locator('[data-testid="sidebar-boards"][data-vault="pocket-ledger"] [data-testid="sidebar-board-row"]').first();
  await board.waitFor({ timeout: 12_000 });
  const slug = await board.getAttribute('data-slug');
  await board.click();
  await expectActive(page, { vault: 'pocket-ledger', page: 'whiteboards', item: slug });

  // Chat on Chat: on Chat the sidebar's rows are the chat drawer's own (a row folds), so the move
  // is ⌘N, which follows the sidebar order.
  await tab(page, 'chat').click();
  await expect(tab(page, 'chat')).toHaveAttribute('data-on', 'true');
  const order = await page.locator('[data-drawer-project]:not([data-hidden-project])').evaluateAll((els) => els.map((e) => e.getAttribute('data-drawer-project')));
  await page.keyboard.press(`Meta+${order.indexOf('orbit') + 1}`);
  await expectActive(page, { vault: 'orbit' });
  await expect(tab(page, 'chat')).toHaveAttribute('data-on', 'true');
  await expect.poll(() => mode(page)).toBe('chat');
});

test('AC5 back and forward walk places across projects', async ({ page }) => {
  // A place is recorded once it stayed on screen 400 ms (navRecorder SETTLE_MS: a quick hop is
  // not a stop), so each stop here dwells like a person would.
  const stay = () => page.waitForTimeout(600);
  await open(page);
  await tab(page, 'tasks').click();
  await expectActive(page, { vault: 'proj', page: 'tasks' });
  await stay();
  await row(page, 'northwind').click();
  await expectActive(page, { vault: 'northwind', page: 'tasks' });
  await stay();
  await tab(page, 'whiteboards').click();
  await expectActive(page, { vault: 'northwind', page: 'whiteboards' });
  await stay();
  await row(page, 'orbit').click();
  await expectActive(page, { vault: 'orbit', page: 'whiteboards' });
  await stay();

  await page.getByTestId('ns-back').click();
  await expectActive(page, { vault: 'northwind', page: 'whiteboards' });
  await stay();
  await page.getByTestId('ns-back').click();
  await expectActive(page, { vault: 'northwind', page: 'tasks' });
  await stay();
  await page.getByTestId('ns-forward').click();
  await expectActive(page, { vault: 'northwind', page: 'whiteboards' });
  await stay();
  await page.getByTestId('ns-forward').click();
  await expectActive(page, { vault: 'orbit', page: 'whiteboards' });
  await stay();
  // A fast double back walks two places.
  await page.getByTestId('ns-back').click();
  await page.getByTestId('ns-back').click();
  await expectActive(page, { vault: 'northwind', page: 'tasks' });
  await stay();
});

test('AC6 keys: ⌘2 follows the sidebar order and pressed twice keeps one switch; ⌘K reaches another project', async ({ page }) => {
  await open(page);
  await tab(page, 'tasks').click();
  await expectActive(page, { vault: 'proj', page: 'tasks' });
  const order = await page.locator('[data-row-key^="project:"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-key')!.slice('project:'.length)));
  const second = order[1];
  await page.evaluate(() => { (window as Window & { __dcReveal?: unknown[] }).__dcReveal = []; });
  await page.keyboard.press('Meta+2');
  await page.keyboard.press('Meta+2');
  await expectActive(page, { vault: second, page: 'tasks' });
  await page.waitForTimeout(1600);
  const log = await page.evaluate(() => (window as Window & { __dcReveal?: { vault: string }[] }).__dcReveal ?? []);
  expect(log.filter((e) => e.vault === second)).toHaveLength(1);

  // ⌘K finds northwind's task and opens it there.
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('Approve beta list');
  // The open project's own hits come first; northwind's group lands below them.
  const hit = page.locator('.cmdk-row', { has: page.getByTestId('cmdk-row-vault') }).filter({ hasText: 'Approve beta list' }).first();
  await hit.waitFor({ timeout: 12_000 });
  await hit.click();
  await expectActive(page, { vault: 'northwind', page: 'tasks' });
});

test('AC7 the sidebar toggles on every page, survives a reload, floats at a narrow window', async ({ page }) => {
  await open(page);
  for (const p of ['tasks', 'whiteboards', 'chat']) {
    await tab(page, p).click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('chat-drawer')).toBeVisible();
  }
  await tab(page, 'tasks').click();
  await page.keyboard.press('Meta+b');
  await expect(page.getByTestId('chat-drawer')).toBeHidden();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('ns-tabs').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('chat-drawer')).toBeHidden();
  await page.getByTestId('ns-drawer-toggle').click();
  await expect(page.getByTestId('chat-drawer')).toBeVisible();

  await page.setViewportSize({ width: 800, height: 700 });
  await page.waitForTimeout(800);
  await expect(tab(page, 'lab')).toHaveCount(0);
  await expect(tab(page, 'apps')).toHaveCount(0);
  await tab(page, 'more').click();
  await expect(page.getByTestId('ns-more-menu')).toBeVisible();
});
