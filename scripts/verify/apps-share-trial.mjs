#!/usr/bin/env node
/**
 * Shared apps end to end on this Mac, nothing sent to GitHub (paylasilan-app-ler plan r3).
 * A scratch HOME holds two projects, `pub` (the publisher) and `kur` (the installer), and a LOCAL
 * app host: a folder of bare git repos standing in for GitHub (DREAMCONTEXT_APPS_LOCAL_HOST). The API
 * runs from source with the desktop flag and an owner key on stdin; the page gets the same key from
 * a stand-in shell, so every click goes through the real owner-only routes. The "signed-in account"
 * switches by restarting the API with another DREAMCONTEXT_APPS_LOCAL_LOGIN on the same port.
 *
 *   publisher: an app's own page → Share hands the publish to Claude (no form: Chat opens with the
 *              prompt and a one-hour grant); the trial stands in for Claude and publishes with
 *              `apps publish --go --grant` (private, invite); a second app; a wrong, spent or
 *              another app's grant is refused
 *   installer: Shared Apps → Accept → the store page → Install → settings → the app's page → the
 *              backend answers; My apps shows Made here and From others
 *   publisher: a new version, and a third app published publicly
 *   installer: the copy is changed → Update asks → Merge → Undo is there; Make it my own copy;
 *              Install from a link (public); Uninstall → Removed apps → Restore
 * Five fictional apps cover every icon case: a full-bleed icon (Hava Notu), one that draws its own
 * tile (Funnel Saati), and placeholders drawn as the monogram (Sayac, Kreatif Takip, Reklam Paneli).
 *
 *   dreamcontext builder heavy -- node scripts/verify/apps-share-trial.mjs [--out <dir>]
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scratchDir, shotsDir, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outArg = process.argv.indexOf('--out');
const SHOTS = outArg > 0 ? process.argv[outArg + 1] : join(shotsDir(REPO, 'apps-share'), String(process.pid));
mkdirSync(SHOTS, { recursive: true });
const scratch = scratchDir(`dc-verify-apps-share-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, 'home');
const hostDir = join(scratch, 'host');
const pub = join(scratch, 'pub');
const kur = join(scratch, 'kur');
for (const d of [join(home, '.dreamcontext'), hostDir, join(pub, '_dream_context', 'state'), join(kur, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
const bin = join(home, '.local', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
chmodSync(join(bin, 'claude'), 0o755);

const KEY = randomBytes(32).toString('base64url');
const PUBLISHER = 'ornek-yayinci';
const INSTALLER = 'ornek-kurucu';
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const baseEnv = { ...clean, HOME: home, PATH: `${bin}:${process.env.PATH}`, npm_config_cache: join(process.env.HOME ?? home, '.npm'), DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0', DREAMCONTEXT_APPS_LOCAL_HOST: hostDir, GIT_CONFIG_GLOBAL: '/dev/null' };
const TSX = ['npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts')]];
const dc = (cwd, ...args) => spawnSync(TSX[0], [...TSX[1], ...args], { cwd, env: { ...baseEnv, DREAMCONTEXT_APPS_LOCAL_LOGIN: PUBLISHER }, encoding: 'utf-8' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...baseEnv, GIT_AUTHOR_NAME: 'Ornek Yazar', GIT_AUTHOR_EMAIL: 'yazar@example.com', GIT_COMMITTER_NAME: 'Ornek Yazar', GIT_COMMITTER_EMAIL: 'yazar@example.com' }, encoding: 'utf-8' });

const findings = [];
const steps = [];
const step = (s) => { steps.push(s); process.stdout.write(`step: ${s}\n`); };
const check = (ok, what) => { if (!ok) findings.push(what); return ok; };

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

// ─── The two projects and the synthetic apps ────────────────────────────────────────
dc(pub, 'vaults', 'add', 'pub', pub);
dc(kur, 'vaults', 'add', 'kur', kur);

/** A tiny RGBA PNG writer (no dependency): `paint(x, y)` → [r, g, b, a]. */
function png(size, paint) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, body) => { const l = Buffer.alloc(4); l.writeUInt32BE(body.length); const tb = Buffer.from(t, 'latin1'); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([tb, body]))); return Buffer.concat([l, tb, body, c]); };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = y * (size * 4 + 1) + 1 + x * 4; const [r, g, b2, a] = paint(x / size, y / size); raw[o] = r; raw[o + 1] = g; raw[o + 2] = b2; raw[o + 3] = a; }
  const h = Buffer.alloc(13); h.writeUInt32BE(size, 0); h.writeUInt32BE(size, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', h), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// Hava Notu: full bleed, a sky with a sun and a cloud (the mask is dreamcontext's).
const HAVA_ICON = png(512, (x, y) => {
  const sky = mix([59, 130, 246], [30, 64, 175], y);
  if (Math.hypot(x - 0.42, y - 0.4) < 0.16) return [255, 209, 102, 255];
  const cloud = Math.hypot(x - 0.58, y - 0.62) < 0.17 || Math.hypot(x - 0.4, y - 0.68) < 0.12 || (y > 0.62 && y < 0.8 && x > 0.32 && x < 0.74);
  return cloud ? [255, 255, 255, 255] : [...sky, 255];
});
// Funnel Saati: an older icon that draws its own rounded tile with a margin (trimmed on read).
const FUNNEL_ICON = png(512, (x, y) => {
  const m = 0.1, r = 0.18, qx = Math.abs(x - 0.5) - (0.5 - m - r), qy = Math.abs(y - 0.5) - (0.5 - m - r);
  if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) > r) return [0, 0, 0, 0];
  const bg = mix([245, 158, 11], [180, 83, 9], y);
  const w = 0.3 * (1 - (y - 0.28) / 0.5);
  return y > 0.28 && y < 0.72 && Math.abs(x - 0.5) < Math.max(0.05, w) ? [255, 255, 255, 255] : [...bg, 255];
});
const SHOT_TODAY = png(320, (x, y) => (y < 0.12 ? [30, 64, 175, 255] : y > 0.3 && y < 0.36 && x > 0.08 && x < 0.6 ? [148, 163, 184, 255] : y > 0.45 && y < 0.7 && x > 0.08 && x < 0.4 ? [59, 130, 246, 255] : [248, 250, 252, 255]));

function makeApp(project, slug, name, { readme, icon, config = false, shots = [] } = {}) {
  const r = dc(project, 'apps', 'new', slug, '--name', name);
  if (r.status !== 0) throw new Error(`apps new ${slug}: ${r.stdout}${r.stderr}`);
  const root = join(`${project}-apps`, slug);
  const m = JSON.parse(readFileSync(join(root, 'dreamcontext-app.json'), 'utf-8'));
  if (config) m.config = [{ key: 'city', type: 'text', label: 'Which city', required: true }, { key: 'WEATHER_KEY', type: 'secret', label: 'Weather key' }];
  m.actions.push({ id: 'settings', title: 'Show the settings the app runs with', method: 'GET', path: '/api/settings' });
  if (slug === 'hava-notu') m.schedules = [{ id: 'morning-note', schedule: { days: 'daily', at: '08:00' }, call: { method: 'GET', path: '/api/hello' } }];
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify(m, null, 2));
  const server = readFileSync(join(root, 'server.mjs'), 'utf-8').replace("  'GET /api/hello': async (_req, res) => {", "  'GET /api/settings': async (_req, res) => {\n    res.writeHead(200, { 'content-type': 'application/json' });\n    res.end(JSON.stringify({ config: JSON.parse(process.env.DC_CONFIG || '{}'), keySet: !!process.env.WEATHER_KEY }));\n  },\n  'GET /api/hello': async (_req, res) => {");
  writeFileSync(join(root, 'server.mjs'), server);
  writeFileSync(join(root, 'public', 'note.js'), 'export const version = 1;\n');
  if (icon) writeFileSync(join(root, 'icon.png'), icon);
  if (shots.length) { mkdirSync(join(root, 'store'), { recursive: true }); shots.forEach(([f, b]) => writeFileSync(join(root, 'store', f), b)); }
  if (readme !== undefined) writeFileSync(join(root, 'README.md'), readme);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'first');
  return root;
}
const HAVA_README = `---
tagline: Shows the weather note for the city you set.
category: Weather
---

# Hava Notu

## What it does
Every morning it writes a short note about today's weather in your city: how warm, whether to take an umbrella, and what tomorrow looks like.

## Screenshots
![Today](store/today.png)

## What's new
### 1 · 2026-11-03
- First version.
`;
const havaRoot = makeApp(pub, 'hava-notu', 'Hava Notu', { readme: HAVA_README, icon: HAVA_ICON, config: true, shots: [['today.png', SHOT_TODAY]] });
const sayacRoot = makeApp(pub, 'sayac', 'Sayac', { readme: '# Sayac\n\nCounts things with one tap. It keeps the total on this Mac.\n', config: true });
makeApp(pub, 'kreatif-takip', 'Kreatif Takip', { readme: '# Kreatif Takip\n\nLists this week\'s creatives with their spend.\n\n## What it does\nA weekly list of every creative and what it cost, sorted by spend.\n' });
makeApp(kur, 'reklam-paneli', 'Reklam Paneli');
makeApp(kur, 'funnel-saati', 'Funnel Saati', { icon: FUNNEL_ICON, readme: '---\ntagline: Times each funnel step and flags the slow one.\n---\n\n# Funnel Saati\n\n## What it does\nIt times every step of a sign-up funnel and marks the slowest one.\n\n## What\'s new\n### 1 · 2026-11-02\n- First version.\n' });
void sayacRoot;

// ─── API (restartable as another account) + Vite ────────────────────────────────────
const apiPort = await freePort();
let api = null;
const procs = [];
const killAll = () => { for (const p of [...procs, api]) { if (!p) continue; try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { killAll(); process.exit(1); });

async function startApi(login) {
  if (api) { try { process.kill(-api.pid, 'SIGTERM'); } catch { /* gone */ } await new Promise((r) => setTimeout(r, 1500)); }
  api = spawn(TSX[0], [...TSX[1], 'dashboard', '--no-open', '-p', String(apiPort)], { cwd: pub, env: { ...baseEnv, DREAMCONTEXT_APPS_LOCAL_LOGIN: login, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  api.on('error', () => {});
  api.stdin.write(`${KEY}\n`);
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`, api);
  // The CLI finds the app's server through this file (the real app writes it; a server run from
  // source does not).
  writeFileSync(join(home, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: api.pid, port: apiPort, launchToken: 'x'.repeat(43), appBundleId: 'com.dreamcontext.trial' }), { mode: 0o600 });
}

const SHELL = `window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'owner_key' ? ${JSON.stringify(KEY)} : null), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;

let browser;
let base;
const NOISE = /\/@vite\/|\/__vite_ping|favicon\.ico|\/api\/.*\/ws\b|\/api\/apps\/[^/]+\/icon/;
async function open(vault, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 } });
  await markAnnouncementsSeen(context, base);
  await context.addInitScript(SHELL);
  const page = await context.newPage();
  const where = `${vault}@${width}`;
  page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text()) && !/status of 4\d\d/.test(m.text())) findings.push(`${where} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => findings.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
  page.on('websocket', (ws) => chatSockets.push(ws.url()));
  await page.goto(`${base}/?vault=${vault}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  if (width <= 600) {
    await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 });
    await page.getByText('Apps', { exact: true }).first().click({ timeout: 10_000 });
  } else {
    await page.locator('[aria-label="Apps"]').first().click({ timeout: 10_000 });
  }
  await page.waitForTimeout(1500);
  return { page, context };
}
// `--matrix before|after`: every shot also at the other width and in both themes, named
// `<prefix>-<name>-<width>-<theme>.png`, and the rendered sheet (or page) is measured: text under
// 4.5:1 against what is really behind it, and text cut by its own box.
const mArg = process.argv.indexOf('--matrix');
const MATRIX = mArg > 0 ? process.argv[mArg + 1] : null;
const measured = [];
async function measure(page, label) {
  const out = await page.evaluate(() => {
    const parse = (s) => { const n = (s.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number); return s.startsWith('color(') ? [n[0] * 255, n[1] * 255, n[2] * 255, n.length > 3 ? n[3] : 1] : [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; };
    const lum = (c) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const root = document.querySelector('.share-sheet') ?? document.querySelector('.apps-page');
    if (!root) return { low: [], cut: [], n: 0, min: null };
    const low = []; const cut = []; let n = 0; let min = null;
    for (const el of root.querySelectorAll('*')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
      const r = el.getBoundingClientRect();
      if (!own && !(el instanceof HTMLInputElement && el.value)) continue;
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      const layers = []; let op = 1;
      for (let n = el; n; n = n.parentElement) { const cs = getComputedStyle(n); op *= Number(cs.opacity); const bg = parse(cs.backgroundColor); if (bg[3] > 0) layers.push(bg); if (bg[3] >= 1) break; }
      let base = [255, 255, 255];
      if (!layers.length || layers[layers.length - 1][3] < 1) { const rt = parse(getComputedStyle(document.documentElement).backgroundColor); if (rt[3] >= 1) base = rt.slice(0, 3); }
      for (let i = layers.length - 1; i >= 0; i--) { const [r2, g, b, a] = layers[i]; base = [r2 * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]; }
      const fg = parse(getComputedStyle(el).color); const a = fg[3] * op;
      const ink = [fg[0] * a + base[0] * (1 - a), fg[1] * a + base[1] * (1 - a), fg[2] * a + base[2] * (1 - a)];
      const l1 = lum(ink); const l2 = lum(base);
      const ratio = Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
      const text = (own || el.value).slice(0, 40);
      n++; if (!min || ratio < min.ratio) min = { ratio, text };
      const disabled = el.closest('button:disabled, input:disabled');
      if (ratio < 4.5 && !disabled) low.push(`${text} ${ratio}`);
      if (el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(getComputedStyle(el).overflowX)) cut.push(text);
    }
    return { low, cut, n, min };
  });
  measured.push({ shot: label, ...out });
  for (const l of out.low) findings.push(`${label} low contrast: ${l}`);
  for (const c of out.cut) findings.push(`${label} text cut: ${c}`);
}
async function capture(page, file, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) findings.push(`${label} overflows sideways by ${over}px`);
  await page.screenshot({ path: file });
  process.stdout.write(`screenshot: ${file}\n`);
}
const shot = async (page, name) => {
  await page.waitForTimeout(400); // the sheet's 200 ms fade settles first
  if (!MATRIX) { await capture(page, join(SHOTS, `${name}.png`), name); return; }
  const size = page.viewportSize();
  const base = name.replace(/-(?:390|1440)$/, '');
  for (const w of size.width > 600 ? [1440, 390] : [390, 1440]) {
    await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(250);
      const label = `${MATRIX}-${base}-${w}-${theme}`;
      await measure(page, label);
      await capture(page, join(SHOTS, `${label}.png`), label);
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.setViewportSize(size);
  await page.waitForTimeout(250);
};
const seen = (page, text, ms = 10_000) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const tile = (page, name) => page.locator('.app-tile').filter({ hasText: name }).first();
const appPage = (page) => page.locator('.share-sheet--page').last();
const sheet = (page) => page.locator('.share-sheet').last();
const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
async function openPage(page, name) {
  await tile(page, name).locator('.app-tile__open').click();
  await appPage(page).waitFor({ state: 'visible', timeout: 10_000 });
}
/**
 * Share on the app's page (owner 2026-11-06, yayinla-claude): no publish form opens, Chat comes up
 * with the publish prompt in its box. Returns the grant the prompt carries; `shotName` saves Chat.
 */
async function handOff(page, name, shotName) {
  await manage(page, name, 'Share');
  // The chat on screen takes it in its box; with none (or a draft in it) a new chat starts with it.
  // Only THIS app's prompt counts: an earlier, unsent one can still sit in a box as its draft.
  const inBox = () => page.evaluate((n) => [...document.querySelectorAll('textarea.chat-cmp-input')].find((t) => t.offsetParent && t.value.includes(`Publish the app "${n}"`))?.value ?? null, name);
  // A new chat carries its opening prompt on the socket it opens to the server.
  const handed = () => chatSockets.map((u) => { try { return new URL(u).searchParams.get('prompt'); } catch { return null; } }).find((t) => t && t.includes(`Publish the app "${name}"`)) ?? null;
  let text = null; let via = null;
  for (const end = Date.now() + 25_000; Date.now() < end && !text; await page.waitForTimeout(300)) {
    const box = await inBox();
    if (box) { text = box; via = 'the chat box'; break; }
    const sent = handed();
    if (sent && !handedSeen.has(sent)) { handedSeen.add(sent); text = sent; via = 'a new chat'; }
  }
  check(!!text, `${name}: Share did not hand the publish prompt to Chat`);
  if (!text) { await shot(page, `x-handoff-missing-${name.toLowerCase().replace(/ /g, '-')}`); return null; }
  check(text.includes(`/apps Publish the app`) && text.includes(`(${name.toLowerCase().replace(/ /g, '-')})`), `${name}: the prompt is not the publish ask: ${text.slice(0, 120)}`);
  check(await page.locator('.share-sheet').count() === 0, `${name}: a sheet is still open after Share (the old form?)`);
  check(!(await page.getByText('Who can install it').count()), `${name}: the publish form is on screen`);
  await page.waitForTimeout(800);
  if (shotName) await shot(page, shotName);
  step(`${name}: Share → ${via} got the publish prompt`);
  return /--grant ([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
}
const handedSeen = new Set();
const chatSockets = [];
/** Claude's last step, the CLI push with the grant (the trial stands in for Claude). */
function cliPublish(slug, grant, ...flags) {
  const r = dc(pub, 'apps', 'publish', slug, '--go', '--grant', String(grant), ...flags);
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
async function manage(page, name, action) {
  await openPage(page, name);
  await appPage(page).getByRole('button', { name: action, exact: true }).click();
}
// Escape closes the top sheet only (a sheet opened from an app's page sits on that page).
async function closeTop(page) {
  for (let n = await page.locator('.share-sheet').count(); n > 0; n--) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const left = await page.locator('.share-sheet').count();
    if (left >= n) { findings.push(`Escape did not close the top sheet (after: ${steps[steps.length - 1] ?? 'start'}; ${n} open)`); await page.locator('.share-sheet__x').last().click(); }
  }
}

let code = 1;
try {
  await startApi(PUBLISHER);
  const vitePort = await freePort();
  const vite = spawn(join(REPO, 'dashboard', 'node_modules', '.bin', 'vite'), ['--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: join(REPO, 'dashboard'), env: { ...clean, DC_API_TARGET: `http://localhost:${apiPort}` }, stdio: 'ignore', detached: true });
  procs.push(vite);
  base = `http://127.0.0.1:${vitePort}`;
  await waitFor(base, vite);
  browser = await chromium.launch();

  // 1. The publisher: its own app's page, then Share with the store block; two apps go privately.
  {
    const { page, context } = await open('pub');
    check(await seen(page, 'Made here'), 'publisher: no Made here shelf');
    await shot(page, '0-uygulamalarim');
    await openPage(page, 'Hava Notu');
    check(await seen(page, 'Shows the weather note for the city you set.'), 'own page: the README tagline is missing');
    check(await seen(page, 'Every day at 08:00'), 'own page: the schedule is not said in words');
    await shot(page, '0b-kendi-sayfam');
    await closeTop(page);
    await context.close();
  }
  {
    const { page, context } = await open('pub');
    const grant = await handOff(page, 'Hava Notu', '1-yayinla-sohbet');
    await context.close();
    check((await cliPublish('hava-notu', 'not-the-grant', '--invite', INSTALLER)).out.includes('Publishing needs the owner'), 'publish: a made-up grant was not refused');
    const k = await open('pub');
    const otherGrant = await handOff(k.page, 'Kreatif Takip', null);
    await k.context.close();
    check(!(await cliPublish('hava-notu', otherGrant)).ok, 'publish: another app\'s grant published Hava Notu');
    const first = cliPublish('hava-notu', grant, '--invite', INSTALLER);
    check(first.ok && first.out.includes('is on GitHub'), `publish Hava Notu with the grant failed: ${first.out.slice(-300)}`);
    check((await cliPublish('hava-notu', grant)).out.includes('Publishing needs the owner'), 'publish: a spent grant published again');
    // Kreatif Takip: no tagline yet, the placeholder icon; Claude writes the one line.
    const kt1 = cliPublish('kreatif-takip', otherGrant, '--invite', INSTALLER, '--tagline', 'Lists this week\'s creatives with their spend.');
    check(kt1.ok, `publish Kreatif Takip failed: ${kt1.out.slice(-300)}`);
    step('Share handed both publishes to Chat (prompt + grant, no form); a made-up, another app\'s and a spent grant were refused');
    const log = execFileSync('git', ['--git-dir', join(hostDir, PUBLISHER, 'hava-notu-app.git'), 'log', '--format=%an|%ae|%cd', '--date=raw'], { encoding: 'utf-8' }).trim();
    check(/^ornek-yayinci\|0\+ornek-yayinci@users\.noreply\.github\.com\|\d+ \+0000$/.test(log), `publish: commit identity is ${log}`);
    const files = execFileSync('git', ['--git-dir', join(hostDir, PUBLISHER, 'hava-notu-app.git'), 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf-8' });
    check(!/\.env|data\//.test(files), 'publish: .env or data travelled');
    check(/store\/today\.png/.test(files), 'publish: the store screenshot did not travel');
    const kt = readFileSync(join(`${pub}-apps`, 'kreatif-takip', 'README.md'), 'utf-8');
    check(/^---\ntagline: Lists this week's creatives with their spend\.\n---/.test(kt) && /### 1 · \d{4}-\d{2}-\d{2}\n- First version\./.test(kt), `publish: the README did not get the tagline and the first entry:\n${kt}`);
    check(git(join(`${pub}-apps`, 'kreatif-takip'), 'status', '--porcelain').trim() === '', 'publish: the written-back README is not committed');
    step(`publisher published Hava Notu and Kreatif Takip privately (commit ${log}); README got tagline + What's new`);
  }

  // 2. The installer: Shared Apps, accept, the store page, install, settings, the app's page.
  await startApi(INSTALLER);
  {
    const { page, context } = await open('kur');
    check(await seen(page, 'Made here'), 'installer: no Made here shelf');
    await tab(page, 'Shared Apps');
    check(await seen(page, 'invited you'), 'installer: no invitation');
    await shot(page, '2-shared-apps-davet');
    for (let i = 0; i < 2; i++) { await page.getByRole('button', { name: 'Accept' }).first().click(); await page.waitForTimeout(1500); }
    check(await seen(page, 'Hava Notu'), 'installer: the app is not listed after Accept');
    check(await seen(page, 'Lists this week\'s creatives with their spend.'), 'Shared Apps: the tagline is missing on the row');
    await shot(page, '2a-shared-apps');
    await page.locator('.store-row').filter({ hasText: 'Hava Notu' }).getByRole('button', { name: 'Get' }).click();
    check(await seen(page, 'This app was written by ornek-yayinci. It runs on your Mac with your permissions.'), 'install: the warning is missing');
    check(await seen(page, 'Shows the weather note for the city you set.'), 'install: the tagline is missing');
    check(await appPage(page).locator('.pp-shots img').count() === 1, 'install: the screenshot is not drawn');
    check(await appPage(page).locator('.pp-top img').count() === 1, 'install: the icon is not drawn');
    await shot(page, '2b-urun-sayfasi');
    await appPage(page).getByRole('button', { name: 'Install', exact: true }).click();
    await page.getByLabel(/Which city/).fill('Izmir');
    await page.getByLabel(/Weather key/).fill('demo-key-not-real');
    await shot(page, '2c-ayarlar');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Install' }).click();
    await appPage(page).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    check(await page.locator('.share-sheet--page').filter({ hasText: 'by ornek-yayinci' }).first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false), 'install: the page does not say who it came from');
    await shot(page, '2d-kuruldu');
    await closeTop(page);
    await tab(page, 'My apps');
    check(await seen(page, 'From others'), 'installer: no From others shelf');
    await shot(page, '2e-my-apps');
    await context.close();
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/apps/hava-notu/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'kur' }, body: JSON.stringify({ method: 'GET', path: '/api/settings' }) });
    const j = await r.json();
    check(r.ok && JSON.parse(j.body ?? '{}').config?.city === 'Izmir' && JSON.parse(j.body).keySet === true, `install: the backend did not run with its settings (${JSON.stringify(j).slice(0, 200)})`);
    step(`installer accepted, installed and ran Hava Notu (backend answered ${j.body})`);
    const refused = await fetch(`http://127.0.0.1:${apiPort}/api/apps/hava-notu/detach`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'kur' }, body: '{}' });
    check(refused.status === 403, `an agent's request to an owner route got ${refused.status}`);
    step(`an agent's request to /detach without the owner key: ${refused.status}`);
  }

  // 3. The publisher pushes a new version, and publishes Sayac publicly.
  await startApi(PUBLISHER);
  {
    writeFileSync(join(havaRoot, 'public', 'note.js'), 'export const version = 2;\n');
    git(havaRoot, 'commit', '-qam', 'v2');
    const a = await open('pub');
    const g2 = await handOff(a.page, 'Hava Notu', null);
    await a.context.close();
    const v2 = cliPublish('hava-notu', g2, '--note', 'Shows tomorrow too');
    check(v2.ok, `update publish failed: ${v2.out.slice(-300)}`);
    const b = await open('pub');
    const g3 = await handOff(b.page, 'Sayac', null);
    await b.context.close();
    check(!cliPublish('sayac', g3, '--public').ok, 'public publish went out without the name confirmed');
    const pubOut = cliPublish('sayac', g3, '--public', '--confirm-name', 'Sayac');
    check(pubOut.ok, `public publish failed: ${pubOut.out.slice(-300)}`);
    const hn = readFileSync(join(havaRoot, 'README.md'), 'utf-8');
    check(/### 2 · \d{4}-\d{2}-\d{2}\n- Shows tomorrow too/.test(hn), 'publish: the note did not become What\'s new version 2');
    step('publisher pushed Hava Notu v2 (README What\'s new 2) and published Sayac publicly');
  }

  // 4. The installer: a changed copy, the update question, merge, undo; my own copy; public install; uninstall/restore.
  await startApi(INSTALLER);
  {
    const inst = join(`${kur}-apps`, 'installed', 'hava-notu');
    writeFileSync(join(inst, 'public', 'index.html'), readFileSync(join(inst, 'public', 'index.html'), 'utf-8').replace('</body>', '<p>my own line</p></body>'));
    const { page, context } = await open('kur');
    await manage(page, 'Hava Notu', 'Check for updates');
    check(await seen(page, 'You changed 1 file'), 'update: the changed copy is not asked about');
    check(await seen(page, 'Shows tomorrow too'), 'update: the change note is missing');
    await page.getByText('Merge', { exact: true }).click();
    await shot(page, '3-guncelleme-sorusu');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Update' }).click();
    check(await seen(page, 'Settings and data are untouched'), 'update: not applied');
    await shot(page, '3b-guncellendi-geri-al');
    await page.getByRole('button', { name: 'Close' }).last().click();
    check(readFileSync(join(inst, 'public', 'note.js'), 'utf-8') === 'export const version = 2;\n' && readFileSync(join(inst, 'public', 'index.html'), 'utf-8').includes('my own line'), 'update: merge lost a side');
    step('installer changed the copy, the update asked, Merge kept both sides');

    await appPage(page).getByRole('button', { name: 'Make it my own copy' }).click();
    check(await seen(page, 'Updates stop'), 'detach: the confirmation text is missing');
    await shot(page, '4-kendi-kopyam');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Make it my own copy' }).click();
    check(await seen(page, 'Your own copy'), 'detach: the page does not say my own copy');
    await closeTop(page);
    step('installer made Hava Notu its own copy');

    await page.getByRole('button', { name: 'Install from a link' }).click();
    await page.getByLabel(/GitHub link/).fill(`https://github.com/${PUBLISHER}/sayac-app`);
    await page.getByRole('button', { name: 'Preview' }).click();
    check(await seen(page, 'someone you do not know'), 'public install: the stronger warning is missing');
    check(await appPage(page).getByRole('button', { name: 'Install', exact: true }).isDisabled(), 'public install: Install is not waiting for the tick');
    await page.getByText('I understand').click();
    await shot(page, '5-herkese-acik-kurulum');
    await appPage(page).getByRole('button', { name: 'Install', exact: true }).click();
    await page.getByLabel(/Which city/).fill('Ankara');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Install' }).click();
    // The install sheet closes and the new app's page opens once the list has it: wait for that page.
    check(await page.locator('.share-sheet--page').filter({ hasText: 'Sayac' }).first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false), 'public install: the app page did not open');
    await closeTop(page);
    step('installer installed Sayac from its public link');

    await manage(page, 'Sayac', 'Uninstall');
    await shot(page, '6-kaldir');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Uninstall' }).click();
    check(await seen(page, 'Removed apps'), 'uninstall: no Removed apps');
    await page.getByRole('button', { name: /Removed apps/ }).click();
    await shot(page, '6b-kaldirildi');
    await page.locator('.apps-other').filter({ hasText: 'Sayac' }).getByRole('button', { name: 'Restore' }).click();
    check(await tile(page, 'Sayac').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false), 'restore: Sayac did not come back');
    step('installer uninstalled Sayac to the trash and restored it');
    await context.close();
    const ph = await open('kur', 390);
    await shot(ph.page, '7-apps-telefon-390');
    await ph.context.close();
  }
  code = findings.length ? 1 : 0;
} catch (e) {
  findings.push(`crashed: ${(e && e.stack) || e}`);
} finally {
  await browser?.close().catch(() => {});
  killAll();
}
writeFileSync(join(SHOTS, MATRIX ? `${MATRIX}-report.json` : 'report.json'), JSON.stringify({ steps, findings, measured }, null, 1));
for (const f of findings) process.stdout.write(`FINDING: ${f}\n`);
process.stdout.write(`${findings.length ? `${findings.length} finding(s)` : 'CLEAN'} (${join(SHOTS, MATRIX ? `${MATRIX}-report.json` : 'report.json')})\n`);
process.exit(code);
