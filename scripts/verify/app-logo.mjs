#!/usr/bin/env node
/**
 * An app's own logo from its Settings, end to end on this Mac (owner 2026-11-09). A scratch HOME
 * holds one project with one fictional app (Hava Notu, a sky icon). The API runs from source with
 * the desktop flag and an owner key; the page gets the key from a stand-in shell, so Save goes
 * through the real owner-only routes.
 *
 *   app page → Settings: the Logo row shows the app's own icon (before)
 *   Choose image (PNG) → preview → Save → the file sits beside the settings, the card's icon is it
 *   Settings again: the custom logo, "Use the app's own" (after); an SVG goes up as the PNG the page drew
 *   Use the app's own → Save → the logo file is gone and the card draws the app's icon again
 *
 *   dreamcontext builder heavy -- node scripts/verify/app-logo.mjs [--out <dir>]
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scratchDir, shotsDir, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outArg = process.argv.indexOf('--out');
const SHOTS = outArg > 0 ? process.argv[outArg + 1] : join(shotsDir(REPO, 'app-logo'), String(process.pid));
mkdirSync(SHOTS, { recursive: true });
const scratch = scratchDir(`dc-verify-app-logo-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, 'home');
const proj = join(scratch, 'proj');
for (const d of [join(home, '.dreamcontext'), join(proj, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
const bin = join(home, '.local', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
chmodSync(join(bin, 'claude'), 0o755);

const KEY = randomBytes(32).toString('base64url');
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const baseEnv = { ...clean, HOME: home, PATH: `${bin}:${process.env.PATH}`, npm_config_cache: join(process.env.HOME ?? home, '.npm'), DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const TSX = ['npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts')]];
const dc = (...args) => spawnSync(TSX[0], [...TSX[1], ...args], { cwd: proj, env: baseEnv, encoding: 'utf-8' });

const findings = [];
const check = (ok, what) => { if (!ok) findings.push(what); return ok; };
const step = (s) => process.stdout.write(`step: ${s}\n`);
const freePort = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
async function waitFor(url, proc, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (proc && proc.exitCode != null) throw new Error(`exited ${proc.exitCode}`);
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no answer from ${url}`);
}

/** A tiny RGBA PNG writer: `paint(x, y)` → [r, g, b, a]. */
function png(size, paint) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, body) => { const l = Buffer.alloc(4); l.writeUInt32BE(body.length); const tb = Buffer.from(t, 'latin1'); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([tb, body]))); return Buffer.concat([l, tb, body, c]); };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = y * (size * 4 + 1) + 1 + x * 4; const [r, g, b2, a] = paint(x / size, y / size); raw[o] = r; raw[o + 1] = g; raw[o + 2] = b2; raw[o + 3] = a; }
  const h = Buffer.alloc(13); h.writeUInt32BE(size, 0); h.writeUInt32BE(size, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', h), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// The app's own icon: a sky with a sun. The owner's logo: an orange tile with a white bar.
const SKY = png(256, (x, y) => (Math.hypot(x - 0.42, y - 0.4) < 0.16 ? [255, 209, 102, 255] : [59, 130, 246, 255]));
const LOGO = png(256, (x, y) => (Math.abs(y - 0.5) < 0.1 && Math.abs(x - 0.5) < 0.3 ? [255, 255, 255, 255] : [234, 88, 12, 255]));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#16a34a"/><circle cx="32" cy="32" r="16" fill="#fff"/></svg>';
const sha = (b) => createHash('sha256').update(b).digest('hex');

dc('vaults', 'add', 'proj', proj);
const made = dc('apps', 'new', 'hava-notu', '--name', 'Hava Notu');
if (made.status !== 0) throw new Error(`apps new: ${made.stdout}${made.stderr}`);
const appRoot = join(`${proj}-apps`, 'hava-notu');
writeFileSync(join(appRoot, 'icon.png'), SKY);
const files = join(scratch, 'files');
mkdirSync(files);
writeFileSync(join(files, 'logo.png'), LOGO);
writeFileSync(join(files, 'logo.svg'), SVG);
const logoDir = join(home, '.dreamcontext', 'apps', 'logo');
const logoFiles = () => (existsSync(logoDir) ? readdirSync(logoDir) : []);

const apiPort = await freePort();
const procs = [];
const killAll = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { killAll(); process.exit(1); });
const api = spawn(TSX[0], [...TSX[1], 'dashboard', '--no-open', '-p', String(apiPort)], { cwd: proj, env: { ...baseEnv, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
procs.push(api);
api.stdin.write(`${KEY}\n`);
const SHELL = `window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'owner_key' ? ${JSON.stringify(KEY)} : cmd === 'confirm_dialog' ? true : null), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;
const NOISE = /\/@vite\/|\/__vite_ping|favicon\.ico|\/api\/.*\/ws\b|\/api\/apps\/[^/]+\/icon/;

let browser;
try {
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`, api);
  const vitePort = await freePort();
  const vite = spawn(join(REPO, 'dashboard', 'node_modules', '.bin', 'vite'), ['--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: join(REPO, 'dashboard'), env: { ...clean, DC_API_TARGET: `http://localhost:${apiPort}` }, stdio: 'ignore', detached: true });
  procs.push(vite);
  const base = `http://127.0.0.1:${vitePort}`;
  await waitFor(base, vite);
  browser = await chromium.launch();

  for (const width of [1440, 390]) {
    const w = width > 600 ? 'desktop' : 'phone';
    const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 } });
    await markAnnouncementsSeen(context, base);
    await context.addInitScript(SHELL);
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text()) && !/status of 4\d\d/.test(m.text())) findings.push(`${w} console: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => findings.push(`${w} crash: ${String(e.message).slice(0, 200)}`));
    page.on('requestfailed', (r) => { if (!NOISE.test(r.url())) findings.push(`${w} request failed: ${r.url()}`); });
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    if (width <= 600) {
      await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 });
      await page.getByText('Apps', { exact: true }).first().click({ timeout: 10_000 });
    } else {
      await page.locator('[aria-label="Apps"]').first().click({ timeout: 10_000 });
    }
    await page.waitForTimeout(1500);
    const appPage = page.locator('.share-sheet--page').last();
    const sheet = page.locator('.share-sheet').last();
    const openSettings = async () => {
      if (!(await appPage.isVisible().catch(() => false))) {
        await page.locator('.app-tile').filter({ hasText: 'Hava Notu' }).first().locator('.app-tile__open').click();
        await appPage.waitFor({ state: 'visible', timeout: 10_000 });
      }
      await appPage.getByRole('button', { name: 'Settings', exact: true }).click();
      await sheet.locator('.share-field--logo').waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(500);
    };
    const shot = async (name) => { await page.screenshot({ path: join(SHOTS, `${name}-${w}.png`) }); };
    const saveAndWait = async (route) => {
      const done = page.waitForResponse((r) => r.url().includes(route) && r.request().method() === 'POST', { timeout: 20_000 });
      await sheet.getByRole('button', { name: 'Save', exact: true }).click();
      const r = await done;
      check(r.ok(), `${w}: ${route} answered ${r.status()} ${await r.text().catch(() => '')}`);
      await page.waitForTimeout(3500);
    };
    const cardIcon = async () => {
      const src = await appPage.locator('.pp-top img').first().getAttribute('src').catch(() => null);
      if (!src) return null;
      const r = await page.request.get(new URL(src, base).toString());
      return r.ok() ? sha(await r.body()) : null;
    };

    step(`${w}: Settings, before`);
    await openSettings();
    check(await sheet.getByText('Logo', { exact: true }).isVisible(), `${w}: no Logo row`);
    check(!(await sheet.getByRole('button', { name: 'Use the app\'s own' }).isVisible()), `${w}: reset offered with no logo set`);
    await shot('1-before');

    step(`${w}: pick a PNG, preview, save`);
    await sheet.locator('input[type=file]').setInputFiles(join(files, 'logo.png'));
    await page.waitForTimeout(400);
    check((await sheet.locator('.share-logo-row img').first().getAttribute('src'))?.startsWith('blob:'), `${w}: the picked image is not previewed`);
    await shot('2-picked');
    await saveAndWait('/logo');
    check(logoFiles().some((f) => f.endsWith('.png')), `${w}: no logo stored beside the settings (${logoFiles().join(',')})`);
    check(!existsSync(join(appRoot, 'logo.png')) && readFileSync(join(appRoot, 'icon.png')).equals(SKY), `${w}: the app's repo was touched`);
    check(await cardIcon() === sha(LOGO), `${w}: the app page does not draw the owner's logo`);

    step(`${w}: Settings, after`);
    await openSettings();
    check(await sheet.getByRole('button', { name: 'Use the app\'s own' }).isVisible(), `${w}: no reset with a logo set`);
    await shot('3-after');

    if (width > 600) {
      step('an SVG goes up as the PNG the page drew');
      await sheet.locator('input[type=file]').setInputFiles(join(files, 'logo.svg'));
      await page.waitForTimeout(600);
      // The server takes PNG and JPEG only (an SVG body is a 415), so an OK save is the page's PNG.
      await saveAndWait('/logo');
      check(logoFiles().length === 1 && logoFiles()[0].endsWith('.png'), `svg: stored as ${logoFiles().join(',')}`);
      const svgPng = cardIcon();
      check((await svgPng) !== sha(LOGO), 'svg: the logo did not change');
      await openSettings();
      await shot('4-svg');
    }

    step(`${w}: back to the app's own`);
    if (!(await sheet.isVisible().catch(() => false))) await openSettings();
    await sheet.getByRole('button', { name: 'Use the app\'s own' }).click();
    await page.waitForTimeout(400);
    await saveAndWait('/logo/reset');
    check(logoFiles().length === 0, `${w}: the logo is still there after reset (${logoFiles().join(',')})`);
    check(await cardIcon() === sha(SKY), `${w}: the app page does not draw the app's own icon after reset`);
    await shot('5-reset');
    await context.close();
  }
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
} finally {
  await browser?.close().catch(() => {});
  killAll();
  rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write(`shots: ${SHOTS}\n`);
if (findings.length) { process.stdout.write(`FINDINGS:\n${findings.map((f) => `  - ${f}`).join('\n')}\n`); process.exit(1); }
process.stdout.write('app-logo: clean\n');
