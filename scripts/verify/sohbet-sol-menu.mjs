#!/usr/bin/env node
/**
 * Chat's left menu lists only the open project (Navigation B): four fictional projects, Chat page,
 * screenshots at 1440 light and 1180 dark, plus a Super tab. Counts the project labels in the drawer.
 *
 *   SOL_MENU_OUT=<dir> SOL_MENU_TAG=sonra dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/sohbet-sol-menu.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const OUT = process.env.SOL_MENU_OUT ?? null;
const TAG = process.env.SOL_MENU_TAG ?? 'sonra';
const PROJECTS = ['proj', 'pocket-ledger', 'northwind', 'orbit'];
const app = await openApp({ suite: 'sohbet-sol-menu' });
const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}` };
for (const name of PROJECTS.slice(1)) {
  const dir = join(dirname(app.proj), name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, dir], { cwd: dir, env, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`register ${name}: ${r.stderr.slice(-200)}`);
}
const browser = await chromium.launch();
for (const { width, height, theme } of [{ width: 1440, height: 900, theme: 'light' }, { width: 1180, height: 800, theme: 'dark' }]) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await markAnnouncementsSeen(context, app.base);
  const page = await context.newPage();
  page.on('pageerror', (e) => app.findings.push(`crash: ${String(e.message).slice(0, 200)}`));
  await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-drawer').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  const labels = await page.locator('.ns-drawer [data-drawer-project]').count();
  const text = (await page.locator('.ns-drawer').innerText()).replace(/\s+/g, ' ');
  console.log(`${width} ${theme} ${TAG}: project blocks in drawer = ${labels} | ${text.slice(0, 140)}`);
  const file = `${TAG}-${width}-${theme}.png`;
  const p = join(app.shots, file);
  await page.screenshot({ path: p });
  if (OUT) { mkdirSync(OUT, { recursive: true }); copyFileSync(p, join(OUT, file)); }
  await context.close();
}
await browser.close();
process.exit(await app.finish());
