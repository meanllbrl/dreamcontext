#!/usr/bin/env node
/**
 * Team row ring: drawn only while the group is folded. States: folded and open, light and dark, 1440.
 *   dreamcontext builder heavy -- node scripts/verify/team-yukleniyor.mjs <outDir> <prefix>
 * The summary's `members` is staged (one member works for the owner); everything else is live.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';

const out = resolve(process.argv[2] || 'tmp/verify/team-yukleniyor');
const prefix = process.argv[3] || 'after';
mkdirSync(out, { recursive: true });
const members = [{ slug: 'meta-the-x', global: false, enabled: true, ownerWorking: 1, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 9, pending: 0 }];

const app = await openApp({ suite: 'team-yukleniyor' });
const browser = await chromium.launch();
let bad = 0;
for (const theme of ['light', 'dark']) for (const open of [false, true]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  const page = await ctx.newPage();
  await page.addInitScript(([o, t]) => {
    try { localStorage.setItem('dc.drawer.team.proj', o ? '1' : ''); if (!o) localStorage.removeItem('dc.drawer.team.proj'); localStorage.setItem('theme', t); localStorage.setItem('dc-theme', t); } catch {}
  }, [open, theme]);
  await page.route('**/agent/sessions?summary=1*', async (r) => {
    const res = await r.fetch(); const j = await res.json().catch(() => ({}));
    await r.fulfill({ response: res, json: { ...j, members } });
  });
  await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
  await page.waitForTimeout(2500);
  const rows = await page.locator('[data-testid="drawer-team-row"]').count();
  const ring = await page.locator('[data-testid="drawer-team-row"] [data-testid="team-row-ring"]').count();
  const state = await page.locator('[data-testid="drawer-team-row-section"]').getAttribute('data-open').catch(() => null);
  console.log(`${prefix} ${theme} open=${open}: rows=${rows} sectionOpen=${state} ringOnTeamRow=${ring}`);
  const el = page.locator('[data-testid="drawer-team-row-section"]').first();
  const box = await el.boundingBox().catch(() => null);
  const clip = box ? { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 40), width: 360, height: Math.min(260, box.height + 80) } : undefined;
  await page.screenshot({ path: join(out, `${prefix}-${open ? 'acik' : 'kapali'}-1440-${theme}.png`), clip });
  await ctx.close();
}
await browser.close();
process.exit(await app.finish());
