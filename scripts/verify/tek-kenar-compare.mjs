#!/usr/bin/env node
/**
 * Tek kenar çubuğu, AC8: nothing but navigation changed. One scratch HOME and API server; two Vite
 * servers, this branch's dashboard and dev's (DEV_DASHBOARD=<dev checkout>/dashboard). Pages the
 * branch never touched (Tasks, Lab, Roadmap, Brain) at 1440×900 light, and the classic shell.
 *
 * Dev's new shell has a page rail on the left; the branch has the sidebar instead. The branch's
 * window is drawn wider by the difference of the two left columns (both measured, never assumed),
 * so its page region (right of the left column, below the title bar) is exactly dev's size; that
 * region is compared pixel by pixel. The classic shell is compared whole: 0 px.
 *
 * Base: navigation B's criterion 8 check (super/navigasyon-b 4f401ea86).
 *
 *   DEV_DASHBOARD=/tmp/dev/dashboard TEK_KENAR_OUT=<dir> dreamcontext builder heavy -- node scripts/verify/tek-kenar-compare.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, copyFileSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const DEV = process.env.DEV_DASHBOARD;
const OUT = process.env.TEK_KENAR_OUT ?? null;
if (!DEV) { console.error('DEV_DASHBOARD is required'); process.exit(78); }
const H = 900;
const W = 1440;

const app = await openApp({ suite: 'tek-kenar-compare' });
const port = await new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
// dev's Vite output, for when it does not come up.
const devLog = openSync(join(app.shots, 'dev-vite.log'), 'w');
const vite = spawn(join(DEV, 'node_modules', '.bin', 'vite'), ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
  cwd: DEV, env: { ...clean, DC_API_TARGET: app.base }, stdio: ['ignore', devLog, devLog], detached: true,
});
const devBase = `http://127.0.0.1:${port}`;
let devUp = false;
for (let i = 0; i < 240 && !devUp; i++) { devUp = await fetch(devBase).then((r) => r.ok, () => false); if (!devUp) await new Promise((r) => setTimeout(r, 500)); }
if (!devUp) { process.stdout.write(`dev Vite never answered; its log:\n${readFileSync(join(app.shots, 'dev-vite.log'), 'utf-8').slice(-1500)}\n`); }

const browser = await chromium.launch();
const rows = [];
const MORE = new Set(['roadmap', 'hypotheses', 'knowledge', 'brain', 'council', 'core', 'sleep', 'stats']);

/** Opens `target` the way the owner would: dev's page rail, or the branch's tabs (More for a More page). */
async function goTo(page, target, side) {
  if (side === 'dev') { await page.getByTestId(`ns-rail-${target}`).click(); return; }
  if (MORE.has(target)) { await page.getByTestId('ns-tab-more').click(); await page.getByTestId(`ns-more-${target}`).click(); return; }
  await page.getByTestId(`ns-tab-${target}`).click();
}

/** The page region's left edge and top: the instances' body, below the title bar. */
const regionOf = (page) => page.evaluate(() => {
  const body = document.querySelector('.window-chrome-body');
  const r = body?.getBoundingClientRect();
  return r ? { left: Math.round(r.left), top: Math.round(r.top) } : { left: 0, top: 0 };
});

async function shoot(base, path, { width, classic, file, target, side }) {
  const context = await browser.newContext({ viewport: { width, height: H }, colorScheme: 'light' });
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
  if (target) {
    await goTo(page, target, side);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  await page.mouse.move(width - 2, H - 1);
  await page.waitForTimeout(400);
  const region = classic ? { left: 0, top: 0 } : await regionOf(page);
  const p = join(app.shots, file);
  await page.screenshot({ path: p });
  await context.close();
  return { path: p, region };
}

/** Dev's and the branch's left column, measured once on Tasks. */
async function leftColumns() {
  const probe = async (base, side) => {
    const context = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'light' });
    await markAnnouncementsSeen(context, base);
    const page = await context.newPage();
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await goTo(page, 'tasks', side);
    await page.waitForTimeout(1500);
    const r = await regionOf(page);
    await context.close();
    return r.left;
  };
  return { dev: await probe(devBase, 'dev'), branch: await probe(app.base, 'branch') };
}

async function compare(name, path, { classic = false, target = null, extra = 0 } = {}) {
  const before = await shoot(devBase, path, { width: W, classic, target, side: 'dev', file: `${name}-dev.png` });
  const after = await shoot(app.base, path, { width: W + (classic ? 0 : extra), classic, target, side: 'branch', file: `${name}-dal.png` });
  const top = Math.max(before.region.top, after.region.top);
  const size = { top, width: W - before.region.left, height: H - top };
  const a = await sharp(before.path).extract({ left: before.region.left, ...size }).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(after.path).extract({ left: after.region.left, ...size }).raw().toBuffer({ resolveWithObject: true });
  let diff = 0;
  const ch = a.info.channels;
  for (let i = 0; i < a.data.length; i += ch) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 24) diff++;
  }
  const pct = (100 * diff) / (size.width * size.height);
  rows.push({ name, diff, pct });
  if (diff > 0) app.findings.push(`${name}: page region differs in ${diff} px (${pct.toFixed(3)} %)`);
  const label = (t) => Buffer.from(`<svg width="900" height="40"><rect width="900" height="40" fill="#111"/><text x="14" y="27" font-family="Helvetica" font-size="20" fill="#fff">${t}</text></svg>`);
  const afterW = W + (classic ? 0 : extra);
  const out = join(app.shots, `ac8-${name}.png`);
  await sharp({ create: { width: W + afterW + 24, height: H + 40, channels: 3, background: '#ffffff' } })
    .composite([
      { input: label(`ÖNCE (dev) · ${name}`), left: 0, top: 0 },
      { input: before.path, left: 0, top: 40 },
      { input: label(`SONRA (bu dal) · fark ${diff} px`), left: W + 24, top: 0 },
      { input: after.path, left: W + 24, top: 40 },
    ]).png().toFile(out);
  if (OUT) { mkdirSync(OUT, { recursive: true }); copyFileSync(out, join(OUT, `ac8-${name}.png`)); }
}

try {
  const cols = await leftColumns();
  const extra = cols.branch - cols.dev;
  process.stdout.write(`left column: dev ${cols.dev} px, branch ${cols.branch} px (branch drawn ${extra} px wider)\n`);
  await compare('tasks', '/?vault=proj', { target: 'tasks', extra });
  await compare('lab', '/?vault=proj', { target: 'lab', extra });
  await compare('roadmap', '/?vault=proj', { target: 'roadmap', extra });
  await compare('brain', '/?vault=proj', { target: 'brain', extra });
  await compare('klasik-tasks', '/?vault=proj&page=tasks', { classic: true });
  await compare('klasik-roadmap', '/?vault=proj&page=roadmap', { classic: true });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
await browser.close();
try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ }
for (const r of rows) process.stdout.write(`${r.name}: ${r.diff} px differ (${r.pct.toFixed(3)} %)\n`);
process.exit(await app.finish());
