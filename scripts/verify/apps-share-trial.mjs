#!/usr/bin/env node
/**
 * Shared apps end to end on this Mac, nothing sent to GitHub (paylasilan-app-ler plan r3).
 * A scratch HOME holds two projects, `pub` (the publisher) and `kur` (the installer), and a LOCAL
 * app host: a folder of bare git repos standing in for GitHub (DREAMCONTEXT_APPS_LOCAL_HOST). The API
 * runs from source with the desktop flag and an owner key on stdin; the page gets the same key from
 * a stand-in shell, so every click goes through the real owner-only routes. The "signed-in account"
 * switches by restarting the API with another DREAMCONTEXT_APPS_LOCAL_LOGIN on the same port.
 *
 *   publisher: Share (private, invite) → publish
 *   installer: Shared with you → Accept → Install (the warning) → settings → the backend answers
 *   publisher: a new version, and a second app published publicly
 *   installer: the copy is changed → Update asks → Merge → Undo is there; Make it my own copy;
 *              Install a public app by link; Uninstall → Removed apps → Restore
 *
 *   dreamcontext builder heavy -- node scripts/verify/apps-share-trial.mjs [--out <dir>]
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
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
function makeApp(slug, name, page) {
  const r = dc(pub, 'apps', 'new', slug, '--name', name);
  if (r.status !== 0) throw new Error(`apps new ${slug}: ${r.stdout}${r.stderr}`);
  const root = join(`${pub}-apps`, slug);
  const m = JSON.parse(readFileSync(join(root, 'dreamcontext-app.json'), 'utf-8'));
  m.config = [{ key: 'city', type: 'text', label: 'Which city', required: true }, { key: 'WEATHER_KEY', type: 'secret', label: 'Weather key' }];
  m.actions.push({ id: 'settings', title: 'Show the settings the app runs with', method: 'GET', path: '/api/settings' });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify(m, null, 2));
  const server = readFileSync(join(root, 'server.mjs'), 'utf-8').replace("  'GET /api/hello': async (_req, res) => {", "  'GET /api/settings': async (_req, res) => {\n    res.writeHead(200, { 'content-type': 'application/json' });\n    res.end(JSON.stringify({ config: JSON.parse(process.env.DC_CONFIG || '{}'), keySet: !!process.env.WEATHER_KEY }));\n  },\n  'GET /api/hello': async (_req, res) => {");
  writeFileSync(join(root, 'server.mjs'), server);
  writeFileSync(join(root, 'public', 'note.js'), page);
  writeFileSync(join(root, 'README.md'), `# ${name}\n\nA small sample app: it shows the weather note for the city you set.\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'first');
  return root;
}
const havaRoot = makeApp('hava-notu', 'Hava Notu', 'export const version = 1;\n');
const sayacRoot = makeApp('sayac', 'Sayac', 'export const count = 0;\n');

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
const card = (page, name) => page.locator('.app-card').filter({ hasText: name }).first();

let code = 1;
try {
  await startApi(PUBLISHER);
  const vitePort = await freePort();
  const vite = spawn(join(REPO, 'dashboard', 'node_modules', '.bin', 'vite'), ['--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: join(REPO, 'dashboard'), env: { ...clean, DC_API_TARGET: `http://localhost:${apiPort}` }, stdio: 'ignore', detached: true });
  procs.push(vite);
  base = `http://127.0.0.1:${vitePort}`;
  await waitFor(base, vite);
  browser = await chromium.launch();

  // 1. The publisher shares Hava Notu privately with the installer.
  {
    for (const w of [390, 1440]) {
      const { page, context } = await open('pub', w);
      await card(page, 'Hava Notu').getByRole('button', { name: 'Share' }).click();
      check(await seen(page, 'Ready to go'), `publish sheet@${w}: the gate is not clear`);
      await page.getByPlaceholder('ali, ayse').fill(INSTALLER);
      await shot(page, `1-yayin-ekrani-${w}`);
      if (w === 1440) {
        await page.getByRole('button', { name: 'Publish', exact: true }).click();
        check(await seen(page, 'is on GitHub'), 'publish: no "is on GitHub" after Publish');
        await shot(page, '1b-yayinlandi-1440');
      }
      await context.close();
    }
    const log = execFileSync('git', ['--git-dir', join(hostDir, PUBLISHER, 'hava-notu-app.git'), 'log', '--format=%an|%ae|%cd', '--date=raw'], { encoding: 'utf-8' }).trim();
    check(/^ornek-yayinci\|0\+ornek-yayinci@users\.noreply\.github\.com\|\d+ \+0000$/.test(log), `publish: commit identity is ${log}`);
    const files = execFileSync('git', ['--git-dir', join(hostDir, PUBLISHER, 'hava-notu-app.git'), 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf-8' });
    check(!/\.env|data\//.test(files), 'publish: .env or data travelled');
    step(`publisher published Hava Notu privately (commit ${log})`);
  }

  // 2. The installer accepts the invitation and installs it.
  await startApi(INSTALLER);
  {
    const { page, context } = await open('kur');
    check(await seen(page, 'Shared with you'), 'installer: no Shared with you');
    check(await seen(page, 'invited you'), 'installer: no invitation');
    await page.getByRole('button', { name: 'Accept' }).click();
    check(await seen(page, 'Hava Notu'), 'installer: the app is not listed after Accept');
    await page.locator('.apps-other').filter({ hasText: 'Hava Notu' }).getByRole('button', { name: 'Install' }).click();
    check(await seen(page, 'This app was written by ornek-yayinci. It runs on your Mac with your permissions.'), 'install: the warning is missing');
    await page.getByLabel(/Which city/).fill('Izmir');
    await page.getByLabel(/Weather key/).fill('demo-key-not-real');
    await shot(page, '2-kurulum-uyarisi-1440');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Install' }).click();
    check(await seen(page, 'follows the original'), 'install: the card does not say where it came from');
    await shot(page, '2b-kuruldu-1440');
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
    const { page, context } = await open('pub');
    await card(page, 'Hava Notu').getByRole('button', { name: 'Share' }).click();
    await page.getByPlaceholder('First version').fill('Shows tomorrow too');
    await page.getByRole('button', { name: 'Publish the new version' }).click();
    check(await seen(page, 'is on GitHub'), 'update publish failed');
    await page.getByRole('button', { name: 'Close' }).last().click();
    await card(page, 'Sayac').getByRole('button', { name: 'Share' }).click();
    await page.getByText('Anyone with the link').click();
    await page.getByLabel(/Type the app's name/).fill('Sayac');
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    check(await seen(page, 'is on GitHub'), 'public publish failed');
    await context.close();
    step('publisher pushed Hava Notu v2 and published Sayac publicly');
  }

  // 4. The installer: a changed copy, the update question, merge, undo; my own copy; public install; uninstall/restore.
  await startApi(INSTALLER);
  {
    const inst = join(`${kur}-apps`, 'installed', 'hava-notu');
    writeFileSync(join(inst, 'public', 'index.html'), readFileSync(join(inst, 'public', 'index.html'), 'utf-8').replace('</body>', '<p>my own line</p></body>'));
    const { page, context } = await open('kur');
    await card(page, 'Hava Notu').getByRole('button', { name: 'Check for updates' }).click();
    check(await seen(page, 'You changed 1 file'), 'update: the changed copy is not asked about');
    check(await seen(page, 'Shows tomorrow too'), 'update: the change note is missing');
    await page.getByText('Merge', { exact: true }).click();
    await shot(page, '3-guncelleme-sorusu-1440');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Update' }).click();
    check(await seen(page, 'Settings and data are untouched'), 'update: not applied');
    await shot(page, '3b-guncellendi-geri-al-1440');
    await page.getByRole('button', { name: 'Close' }).last().click();
    check(readFileSync(join(inst, 'public', 'note.js'), 'utf-8') === 'export const version = 2;\n' && readFileSync(join(inst, 'public', 'index.html'), 'utf-8').includes('my own line'), 'update: merge lost a side');
    step('installer changed the copy, the update asked, Merge kept both sides');

    await card(page, 'Hava Notu').getByRole('button', { name: 'Make it my own copy' }).click();
    check(await seen(page, 'Updates stop'), 'detach: the confirmation text is missing');
    await shot(page, '4-kendi-kopyam-1440');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Make it my own copy' }).click();
    check(await seen(page, 'Your own copy'), 'detach: the card does not say my own copy');
    step('installer made Hava Notu its own copy');

    await page.getByRole('button', { name: 'Install a public app' }).click();
    await page.getByLabel(/GitHub link/).fill(`https://github.com/${PUBLISHER}/sayac-app`);
    await page.getByRole('button', { name: 'Preview' }).click();
    check(await seen(page, 'someone you do not know'), 'public install: the stronger warning is missing');
    await page.getByLabel(/Which city/).fill('Ankara');
    await page.getByText('I understand').click();
    await shot(page, '5-herkese-acik-kurulum-1440');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Install' }).click();
    check(await seen(page, 'Sayac'), 'public install failed');
    step('installer installed Sayac from its public link');

    await card(page, 'Sayac').getByRole('button', { name: 'Uninstall' }).click();
    await shot(page, '6-kaldir-1440');
    await page.locator('.share-sheet__foot').getByRole('button', { name: 'Uninstall' }).click();
    check(await seen(page, 'Removed apps'), 'uninstall: no Removed apps');
    await shot(page, '6b-kaldirildi-1440');
    await page.locator('.apps-other').filter({ hasText: 'Sayac' }).getByRole('button', { name: 'Restore' }).click();
    check(await card(page, 'Sayac').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false), 'restore: Sayac did not come back');
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
