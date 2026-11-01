#!/usr/bin/env node
/**
 * The Stats screen on this Mac's real session logs, in a scratch HOME: the logs are linked in
 * read-only, nothing is written outside the scratch home.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/stats.mjs <out-dir> [cache.json]
 *
 * Shots go to <out-dir>: every tab at phone and desktop width, light and dark, plus the two sheets.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openApp } from './lib/app.mjs';

const out = process.argv[2];
const cache = process.argv[3];
const REAL = process.env.REAL_HOME || homedir();
mkdirSync(out, { recursive: true });
const app = await openApp({ suite: 'stats' });
const { home, base, findings } = app;
const link = (from, to) => { if (existsSync(from) && !existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); symlinkSync(from, to); } };

link(join(REAL, '.claude', 'projects'), join(home, '.claude', 'projects'));
link(join(REAL, '.claude', 'session-env'), join(home, '.claude', 'session-env'));
link(join(REAL, '.claude.json'), join(home, '.claude.json'));
link(join(REAL, '.codex', 'sessions'), join(home, '.codex', 'sessions'));
for (const f of ['codex-accounts.json', 'linked-repos.json', 'codex-usage']) link(join(REAL, '.dreamcontext', f), join(home, '.dreamcontext', f));

const accounts = JSON.parse(readFileSync(join(REAL, '.dreamcontext', 'claude-accounts.json'), 'utf-8'));
const meter = JSON.parse(readFileSync(join(REAL, '.dreamcontext', 'claude-account-usage.json'), 'utf-8'));
const meterOut = { accounts: { ...(meter.accounts[REAL] ? { [home]: meter.accounts[REAL] } : {}) } };
for (const a of accounts.accounts) {
  if (!a.configDir) continue;
  const dir = join(home, '.dreamcontext', 'claude-accounts', a.id);
  mkdirSync(dir, { recursive: true });
  link(join(a.configDir, 'session-env'), join(dir, 'session-env'));
  link(join(a.configDir, '.claude.json'), join(dir, '.claude.json'));
  if (meter.accounts[a.configDir]) meterOut.accounts[dir] = meter.accounts[a.configDir];
  a.configDir = dir;
}
writeFileSync(join(home, '.dreamcontext', 'claude-accounts.json'), JSON.stringify(accounts));
writeFileSync(join(home, '.dreamcontext', 'claude-account-usage.json'), JSON.stringify(meterOut));
const vaultsFile = join(home, '.dreamcontext', 'vaults.json');
const mine = JSON.parse(readFileSync(vaultsFile, 'utf-8'));
const real = JSON.parse(readFileSync(join(REAL, '.dreamcontext', 'vaults.json'), 'utf-8'));
writeFileSync(vaultsFile, JSON.stringify({ ...mine, vaults: [...mine.vaults, ...real.vaults] }));
if (cache) copyFileSync(cache, join(home, '.dreamcontext', 'usage-scan-cache.json'));

// Count the logs before the first picture.
for (let i = 0; i < 90; i++) {
  const r = await fetch(`${base}/api/agent/stats?range=7d`).then((x) => x.json()).catch(() => null);
  if (r && !r.scanning && r.totals?.tokens > 0 && i > 0) break;
  await new Promise((d) => setTimeout(d, 2000));
}
const stats = await fetch(`${base}/api/agent/stats?range=30d`).then((x) => x.json());
writeFileSync(join(out, 'stats-30d.json'), JSON.stringify(stats));
// A rule check over the counted prompts (session ids and times, no words) reads this copy.
if (process.env.STATS_CACHE_OUT) copyFileSync(join(home, '.dreamcontext', 'usage-scan-cache.json'), process.env.STATS_CACHE_OUT);

const tab = async (page, name) => { await page.getByRole('tab', { name, exact: true }).click(); await page.waitForTimeout(250); };
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });

for (const theme of ['dark', 'light']) {
  await app.look('/?vault=proj', async (page, w) => {
    await page.evaluate((t) => localStorage.setItem('dreamcontext-theme', t), theme);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.keyboard.press('Meta+u');
    await page.getByTestId('stats-page').waitFor({ timeout: 15_000 });
    await page.getByTestId('stats-chart').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    const tag = `${w.width}-${theme}`;
    await shot(page, `stats-cost-${tag}`);
    await tab(page, 'Tokens'); await shot(page, `stats-tokens-${tag}`);
    await tab(page, 'Limits'); await shot(page, `stats-limits-${tag}`);
    await tab(page, 'dreamcontext');
    await page.getByTestId('stats-answer').waitFor({ timeout: 5_000 });
    await shot(page, `stats-dc-${tag}`);
    const table = page.getByTestId('stats-projects');
    const toTable = async () => { await table.evaluate((el) => el.scrollIntoView({ block: 'start' })); await page.waitForTimeout(200); };
    await toTable();
    await shot(page, `stats-proje-${tag}`);
    if (await table.evaluate((el) => el.scrollWidth - el.clientWidth) > 1) findings.push(`${tag}: the project table overflows sideways`);
    const rows = page.getByTestId('stats-project-row');
    const costs = await rows.evaluateAll((els) => els.map((e) => e.querySelector('.nm .dim')?.textContent ?? ''));
    if (!costs.length) findings.push(`${tag}: the project table has no rows`);
    if (theme === 'dark') {
      const name = (await rows.first().locator('.nm b').textContent()) ?? '';
      const projectMenu = page.locator('.st-menuwrap .st-btn').first();
      await projectMenu.click();
      await page.locator('.st-mi', { hasText: name }).first().click();
      await page.waitForTimeout(1200);
      if (await rows.count() !== 1) findings.push(`${tag}: one project should leave one row`);
      await toTable();
      await shot(page, `stats-proje-tek-${tag}`);
      await shot(page, `stats-grafik-tek-${tag}`);
      await page.getByTestId('stats-chart-trend').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(200);
      await shot(page, `stats-grafik-tek-zaman-${tag}`);
      await projectMenu.click();
      await page.locator('.st-mi', { hasText: 'All projects' }).first().click();
      await page.waitForTimeout(800);
    }
    for (const range of ['24h', '30d', '90d', '7d']) {
      await page.getByRole('button', { name: range, exact: true }).click();
      await page.waitForTimeout(1200);
      await toTable();
      await shot(page, `stats-grafik-${range}-${tag}`);
      if (w.width < 1000) {
        await page.getByTestId('stats-chart-trend').evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(200);
        await shot(page, `stats-grafik-${range}-zaman-${tag}`);
        await page.getByTestId('stats-chart-trend').locator('.st-hit').last().click();
        await page.waitForTimeout(200);
        await shot(page, `stats-grafik-${range}-ipucu-${tag}`);
        await page.mouse.move(0, 0);
      }
      if (await page.getByTestId('stats-chart-projects').locator('.st-tip').count()) findings.push(`${tag}: a tip stayed open`);
    }
    if (w.width > 1000 && theme === 'dark') {
      await page.getByTestId('stats-chart-line').first().hover();
      await page.waitForTimeout(200);
      await shot(page, `stats-grafik-ipucu-${tag}`);
      await page.mouse.move(0, 0);
    }
    if (await page.locator('.st-body').evaluate((el) => el.scrollWidth - el.clientWidth) > 1) findings.push(`${tag}: the page body overflows sideways`);
    if (w.width > 1000 && theme === 'dark') {
      await page.locator('.st-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(150);
      await shot(page, `stats-dc-bottom-${tag}`);
      await page.locator('.st-runs .st-tr.click').first().click();
      await page.waitForTimeout(200);
      await shot(page, `stats-run-sheet-${tag}`);
      await page.keyboard.press('Escape');
      await tab(page, 'Cost');
      await page.locator('.st-tr.click').first().click();
      await page.waitForTimeout(200);
      await shot(page, `stats-model-sheet-${tag}`);
      await page.keyboard.press('Escape');
    }
  }, { name: `end-${theme}` });
}
process.exit(await app.finish());
