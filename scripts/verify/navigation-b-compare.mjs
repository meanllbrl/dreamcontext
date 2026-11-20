#!/usr/bin/env node
/**
 * Navigation B, criterion 8: nothing but navigation changed. One scratch HOME and API server; two
 * Vite servers, this branch's dashboard and dev's (DEV_DASHBOARD=<dev checkout>/dashboard). Pages
 * the branch never touched (Chat, Lab, Roadmap, Brain) at 1440×900 light, and the classic
 * shell. The branch is drawn 64 px wider, so its page region (right of the project rail, below the
 * title bar) has the exact size dev's has; that region is compared pixel by pixel.
 *
 *   DEV_DASHBOARD=/tmp/navb-dev/dashboard NAV_B_OUT=<dir> dreamcontext builder heavy -- node scripts/verify/navigation-b-compare.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const DEV = process.env.DEV_DASHBOARD;
const OUT = process.env.NAV_B_OUT ?? null;
if (!DEV) { console.error('DEV_DASHBOARD is required'); process.exit(78); }
const RAIL = 64;
const BAR = 42;

const app = await openApp({ suite: 'navigation-b-compare' });
const port = await new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const vite = spawn(join(DEV, 'node_modules', '.bin', 'vite'), ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
  cwd: DEV, env: { ...clean, DC_API_TARGET: app.base }, stdio: 'ignore', detached: true,
});
const devBase = `http://127.0.0.1:${port}`;
for (let i = 0; i < 120; i++) { if (await fetch(devBase).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 500)); }

const browser = await chromium.launch();
const rows = [];
async function shoot(base, path, { width, classic, file, rail }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light' });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  page.on('pageerror', (e) => app.findings.push(`${file} crash: ${String(e.message).slice(0, 160)}`));
  if (classic) {
    await page.route('**/api/launcher/ui-settings', (route) => (route.request().method() === 'GET'
      ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ shell: 'classic' }) })
      : route.continue()));
  }
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // The new shell opens on the remembered page (a deep link is the classic shell's): the page
  // rail goes there, as the owner would.
  if (rail) {
    await page.getByTestId(`ns-rail-${rail}`).click();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  // Animations and carets would differ between two runs of the same code.
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  await page.mouse.move(width - 2, 899);
  await page.waitForTimeout(400);
  const p = join(app.shots, file);
  await page.screenshot({ path: p });
  await context.close();
  return p;
}

async function compare(name, path, classic = false, rail = null) {
  const before = await shoot(devBase, path, { width: 1440, classic, rail, file: `${name}-dev.png` });
  const after = await shoot(app.base, path, { width: classic ? 1440 : 1440 + RAIL, classic, rail, file: `${name}-dal.png` });
  // The page region: below the title bar; on the branch right of the project rail.
  const region = { top: BAR, width: 1440, height: 900 - BAR };
  const a = await sharp(before).extract({ left: 0, ...region }).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(after).extract({ left: classic ? 0 : RAIL, ...region }).raw().toBuffer({ resolveWithObject: true });
  let diff = 0;
  const ch = a.info.channels;
  for (let i = 0; i < a.data.length; i += ch) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 24) diff++;
  }
  const pct = (100 * diff) / (region.width * region.height);
  rows.push({ name, diff, pct });
  if (pct > 0.1) app.findings.push(`${name}: page region differs in ${diff} px (${pct.toFixed(2)} %)`);
  // Side by side: dev left, branch right, labelled.
  const label = (t) => Buffer.from(`<svg width="700" height="40"><rect width="700" height="40" fill="#111"/><text x="14" y="27" font-family="Helvetica" font-size="20" fill="#fff">${t}</text></svg>`);
  const W = 1440 + (classic ? 1440 : 1440 + RAIL) + 24;
  const out = join(app.shots, `kriter8-${name}.png`);
  await sharp({ create: { width: W, height: 940, channels: 3, background: '#ffffff' } })
    .composite([
      { input: label(`ÖNCE (dev) · ${name}`), left: 0, top: 0 },
      { input: before, left: 0, top: 40 },
      { input: label(`SONRA (bu dal) · fark ${pct.toFixed(2)} %`), left: 1464, top: 0 },
      { input: after, left: 1464, top: 40 },
    ]).png().toFile(out);
  if (OUT) { mkdirSync(OUT, { recursive: true }); copyFileSync(out, join(OUT, `kriter8-${name}.png`)); }
}

try {
  await compare('chat', '/?vault=proj');
  await compare('roadmap', '/?vault=proj', false, 'roadmap');
  await compare('lab', '/?vault=proj', false, 'lab');
  await compare('brain', '/?vault=proj', false, 'brain');
  await compare('klasik-tasks', '/?vault=proj&page=tasks', true);
  await compare('klasik-roadmap', '/?vault=proj&page=roadmap', true);
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
await browser.close();
try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ }
for (const r of rows) process.stdout.write(`${r.name}: ${r.diff} px differ (${r.pct.toFixed(3)} %)\n`);
process.exit(await app.finish());
