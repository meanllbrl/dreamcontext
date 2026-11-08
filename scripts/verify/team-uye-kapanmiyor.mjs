#!/usr/bin/env node
/**
 * A folded Team row draws NO member row under it (owner 2026-11-08), whatever the members carry:
 * a member working for the owner, one with unread, the member whose stage is open; across a reload.
 *   dreamcontext builder heavy -- node scripts/verify/team-uye-kapanmiyor.mjs <outDir> <prefix>
 * The summary's `members` is staged; everything else is live.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';

const out = resolve(process.argv[2] || 'tmp/verify/team-uye-kapanmiyor');
const prefix = process.argv[3] || 'after';
mkdirSync(out, { recursive: true });
const base = { global: false, enabled: true, ownerWorking: 0, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 9, pending: 0 };
const members = [
  { ...base, slug: 'meta-the-x', ownerWorking: 1 },
  { ...base, slug: 'okuyucu', unread: 2, lastAt: 8 },
];

const app = await openApp({ suite: 'team-uye-kapanmiyor' });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.route('**/agent/sessions?summary=1*', async (r) => {
  const res = await r.fetch(); const j = await res.json().catch(() => ({}));
  await r.fulfill({ response: res, json: { ...j, members } });
});
const sec = page.locator('[data-testid="drawer-team-row-section"]').first();
const row = page.locator('[data-testid="drawer-team-row"]').first();
const memberRows = () => sec.locator('.ns-team-mrow').count();
const shot = async (name) => {
  const box = await sec.boundingBox().catch(() => null);
  const clip = box ? { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 60), width: 360, height: Math.min(300, box.height + 120) } : undefined;
  await page.screenshot({ path: join(out, `${prefix}-${name}.png`), clip });
};
const report = [];
const check = async (label) => {
  const open = await sec.getAttribute('data-open');
  const n = await memberRows();
  const sel = await row.getAttribute('aria-current');
  report.push(`${prefix} ${label}: open=${open} memberRows=${n} teamRowCurrent=${sel ?? '-'}`);
  return { open, n };
};

await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.evaluate(() => localStorage.removeItem('dc.drawer.team.proj'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
let bad = 0;
const folded1 = await check('folded'); await shot('1-kapali');
if (folded1.n !== 0) bad++;
await row.click(); await page.waitForTimeout(500);
const open1 = await check('opened'); await shot('2-acik');
if (open1.n !== 2) bad++;
// Open the working member's stage, then fold the group while it is on screen.
await sec.locator('.ns-team-mrow[data-slug="meta-the-x"]').click(); await page.waitForTimeout(1200);
await row.click(); await page.waitForTimeout(500);
const folded2 = await check('folded with its stage open'); await shot('3-kapali-uye-acik');
if (folded2.n !== 0 || (await row.getAttribute('aria-current')) !== 'page') bad++;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2500);
const folded3 = await check('after reload'); await shot('4-reload');
if (folded3.n !== 0 || folded3.open !== 'false') bad++;
console.log(report.join('\n'));
console.log(bad ? `FOLD CHECK: ${bad} failing` : 'FOLD CHECK: clean');
await browser.close();
const code = await app.finish();
process.exit(bad ? 1 : code);
