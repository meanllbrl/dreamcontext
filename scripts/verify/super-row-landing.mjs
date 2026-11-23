#!/usr/bin/env node
/**
 * The owner's repro (2026-11-23): on project A's Chat he pressed project B in the sidebar; B's
 * Super row read "Off" (B's Super is on), and pressing it folded B and left him on A.
 * Two fictional projects: proj (A) and tilkisim (B), B with a saved chat (so the press prepares B
 * out of sight) and its Super handed over (stubbed reads: the scratch HOME runs no Super).
 *
 *   S0  390: the floating sidebar closes on B's press; opening it again keeps B landing.
 *   S1  while B is landing, its Super row never says "Off".
 *   S2  a press on B's Super row lands on B, on its Super Agent (B active, its row selected).
 *   S3  no console error; frames at 1440 and 390 (SUPER_ROW_OUT=<dir> keeps them).
 *
 *   SUPER_ROW_OUT=<dir> dreamcontext builder heavy -- node scripts/verify/super-row-landing.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const OUT = process.env.SUPER_ROW_OUT ?? null;
const A = 'proj';
const B = 'tilkisim';

const app = await openApp({ suite: 'super-row-landing' });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}` };
{
  const dir = join(dirname(app.proj), B);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', B, dir], { cwd: dir, env, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`register ${B}: ${r.stderr.slice(-200)}`);
}
if (OUT) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) app.findings.push(`${name}${detail ? `: ${detail}` : ''}`); };
const activeVault = (page) => page.evaluate(() => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') ?? null);

async function openSidebar(page) {
  await page.getByTestId('ns-drawer-toggle').first().click().catch(() => {});
  await page.waitForTimeout(500);
}

async function run(width, height) {
  const where = `${width}`;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
  await setTheme(context, 'light');
  await markAnnouncementsSeen(context, app.base);
  const vaultOf = (route) => route.request().headers()['x-dreamcontext-vault'] ?? new URL(route.request().url()).searchParams.get('vault');
  // B: one saved chat (the press prepares it) and its Super on, in both of its reads.
  await context.route(/\/api\/agent\/sessions\?summary=1/, async (route) => {
    const res = await route.fetch();
    if (vaultOf(route) !== B) return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: { ...(await res.json()), tabs: 1, superOn: true } });
  });
  await context.route(/\/api\/super\/state(\?|$)/, async (route) => {
    const res = await route.fetch();
    if (vaultOf(route) !== B || res.status() !== 200) return route.fulfill({ response: res });
    const body = await res.json();
    // Slow on purpose: a real project's record arrives while it lands; this keeps it unread then.
    await new Promise((r) => setTimeout(r, 2500));
    return route.fulfill({ response: res, json: { ...body, enabled: true } });
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|^Failed to load resource|\/ws\b|WebSocket/.test(m.text())) app.findings.push(`${where} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => app.findings.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
  await page.goto(`${app.base}/?vault=${A}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('ns-titlebar').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.getByTestId('ns-tab-chat').click().catch(() => {});
  await page.waitForTimeout(1500);
  // A phone-width window keeps the sidebar behind its menu button.
  const head = page.locator(`[data-drawer-project="${B}"] > .ns-dr-proj .ns-dr-toggle`);
  if (!(await head.isVisible().catch(() => false))) await openSidebar(page);
  if (!(await head.isVisible().catch(() => false))) {
    const shot = join(app.shots, `super-row-${where}-no-sidebar.png`);
    await page.screenshot({ path: shot });
    console.log(`INFO ${where}: no sidebar header for ${B} on screen (${shot})`);
    await context.close();
    return;
  }
  const shot = async (name) => { const f = join(app.shots, `super-row-${where}-${name}.png`); await page.screenshot({ path: f }); app.taken.push(f); if (OUT) copyFileSync(f, join(OUT, `${where}-${name}.png`)); };
  await shot('1-on-A');
  await head.click();
  const row = page.locator(`[data-drawer-project="${B}"] [data-testid="drawer-super-row"]`);
  // A floating sidebar (a phone-width window) closes on the press: opening it again (the owner
  // reaching B while it lands) must not end the landing, so B is still open there to press.
  if (!(await head.isVisible().catch(() => false))) {
    await openSidebar(page);
    const reopened = { active: await activeVault(page), bOpen: await page.locator(`[data-drawer-project="${B}"][data-open="true"]`).count() };
    if (!(await row.isVisible().catch(() => false))) {
      await shot('2-sidebar-reopened');
      check(`S0 ${where}: reopening the sidebar keeps B landing (its rows open)`, false, JSON.stringify(reopened));
      await context.close();
      return;
    }
    check(`S0 ${where}: reopening the sidebar keeps B landing (its rows open)`, reopened.bOpen === 1, JSON.stringify(reopened));
  }
  await row.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  const during = { active: await activeVault(page), off: await row.getAttribute('data-off').catch(() => null) };
  await shot('2-B-landing');
  check(`S1 ${where}: B's Super row does not say Off while B lands`, during.off !== 'true', JSON.stringify(during));
  // A finger or mouse holds the press ~120 ms: the click fires on release, after what the press did.
  const box = await row.boundingBox();
  if (!box) app.findings.push(`${where}: B's Super row is not on screen to press`);
  else {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
  }
  await page.waitForTimeout(3500);
  // A floating sidebar closed on the pick: open it to read where the press landed.
  if (!(await head.isVisible().catch(() => false))) await openSidebar(page);
  const after = {
    active: await activeVault(page),
    bOpen: await page.locator(`[data-drawer-project="${B}"][data-open="true"]`).count(),
    superSel: await page.locator(`[data-drawer-project="${B}"] [data-testid="drawer-super-row"].is-sel`).count(),
    off: await row.getAttribute('data-off').catch(() => null),
  };
  await shot('3-after-super-press');
  check(`S2 ${where}: the press lands on B's Super Agent`, after.active === B && after.superSel === 1, JSON.stringify(after));
  check(`S2b ${where}: B's Super row reads on once read`, after.off !== 'true', JSON.stringify(after));
  await context.close();
}

try {
  await run(1440, 900);
  await run(390, 844);
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
await browser.close();
process.exit(await app.finish());
