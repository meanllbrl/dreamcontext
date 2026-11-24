#!/usr/bin/env node
/**
 * Eco Plus screens (task eco-plus-modu-…, plan criterion 10's screenshots), in a scratch HOME:
 * Settings → Chat's "Saving mode" row, Settings → Super Agent's model hint and Stats → dreamcontext's
 * Eco Plus row, at 390 and 1440 px, light and dark.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/eco-plus.mjs
 *
 * Eco Plus is on and its history says it was turned on 2 days ago (so the row reads "short
 * history", no estimate). This Mac's session logs are linked in read-only so the Opus share before
 * is a real one; nothing is written outside the scratch home.
 */
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openApp } from './lib/app.mjs';

const REAL = process.env.REAL_HOME || homedir();
const app = await openApp({ suite: 'eco-plus' });
const { home, base, shots, findings, taken } = app;
const link = (from, to) => { if (existsSync(from) && !existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); symlinkSync(from, to); } };
link(join(REAL, '.claude', 'projects'), join(home, '.claude', 'projects'));
const cache = join(REAL, '.dreamcontext', 'usage-scan-cache.json');
if (existsSync(cache)) copyFileSync(cache, join(home, '.dreamcontext', 'usage-scan-cache.json'));
writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ ecoMode: true, ecoPlus: true }));
writeFileSync(join(home, '.dreamcontext', 'eco-plus-history.jsonl'), `${JSON.stringify({ at: new Date(Date.now() - 2 * 86_400_000).toISOString(), on: true })}\n`);

for (let i = 0; i < 90; i++) {
  const r = await fetch(`${base}/api/agent/stats?range=7d`).then((x) => x.json()).catch(() => null);
  if (r && !r.scanning && i > 0) break;
  await new Promise((d) => setTimeout(d, 2000));
}
const stats = await fetch(`${base}/api/agent/stats?range=7d`).then((x) => x.json()).catch(() => null);
const row = stats?.dc?.ecoPlus;
process.stdout.write(`ecoPlus row: ${JSON.stringify(row)}\n`);
if (!row) findings.push('the stats answer carries no ecoPlus row while Eco Plus is on');
else if (!row.short || row.estSavedCost !== null) findings.push('2 days of Eco Plus must read as short history with no estimate');

const shot = async (page, name) => { await page.waitForTimeout(250); const f = join(shots, `${name}.png`); await page.screenshot({ path: f }); taken.push(f); };
const openSettings = async (page) => {
  const rail = page.getByTestId('ns-rail-settings');
  if (await rail.isVisible().catch(() => false)) await rail.click();
  else await page.goto(`${base}/?vault=proj&page=settings`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('settings-window').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);
};
const go = async (page, id) => { await page.click(`[data-sw-nav="${id}"]`); await page.waitForTimeout(450); };

try {
  for (const theme of ['light', 'dark']) {
    await app.look('/?vault=proj', async (page, w) => {
      const tag = `${w.width}-${theme}`;
      const got = page.getByRole('button', { name: 'Got it' });
      if (await got.isVisible().catch(() => false)) await got.click();
      await openSettings(page);
      await go(page, 'chat');
      const plus = page.getByText('Eco Plus', { exact: true }).first();
      await plus.scrollIntoViewIfNeeded();
      if (!(await plus.isVisible())) findings.push(`${tag}: no Eco Plus choice on Settings → Chat`);
      await shot(page, `settings-chat-${tag}`);
      await go(page, 'super');
      await shot(page, `settings-super-${tag}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.press('Meta+u');
      await page.getByTestId('stats-page').waitFor({ timeout: 15_000 });
      await page.getByRole('tab', { name: 'dreamcontext', exact: true }).click();
      const card = page.getByTestId('stats-eco-plus');
      await card.waitFor({ timeout: 10_000 }).catch(() => findings.push(`${tag}: no Eco Plus row on Stats → dreamcontext`));
      await card.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
      await shot(page, `stats-eco-plus-${tag}`);
    }, { name: `eco-plus-${theme}`, init: () => `try { localStorage.setItem('dreamcontext-theme', '${theme}'); } catch {}` });
  }
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
