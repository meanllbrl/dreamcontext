#!/usr/bin/env node
/**
 * The app approval card end to end (app-onay-karti, owner 2026-11-09). A scratch HOME holds one
 * project with two fictional apps and a LOCAL app host (a folder of bare repos standing in for
 * GitHub). The API runs from source with the desktop flag and an owner key; the notch page gets
 * the key from a stand-in shell, so Onayla and Reddet go through the real owner-only decide route.
 *
 *   Kargo Takip, published once by the owner, then changed and committed:
 *     Apps page, its own page: the band "a newer version is not published" (before)
 *   An agent asks, the notch shows the card, the owner decides:
 *     Hava Notu public publish → card with the red warning → Reddet → the request is rejected
 *     Kargo Takip logo → card with the picture → Onayla → the printed command sets that logo
 *     Kargo Takip update publish → card → Onayla → the printed command publishes
 *   Apps page again: the band is gone (after)
 *   Telegram: the message each card sends, rendered from the real `appRequestHtml`
 *
 *   dreamcontext builder heavy -- node scripts/verify/app-onay.mjs [--out <dir>]
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scratchDir, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outArg = process.argv.indexOf('--out');
const SHOTS = outArg > 0 ? process.argv[outArg + 1] : join(REPO, 'tmp', 'verify', 'app-onay', String(process.pid));
mkdirSync(SHOTS, { recursive: true });
const scratch = scratchDir(`dc-verify-app-onay-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, 'home');
const proj = join(scratch, 'proj');
const hostDir = join(scratch, 'host');
for (const d of [join(home, '.dreamcontext'), hostDir, join(proj, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
const bin = join(home, '.local', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
chmodSync(join(bin, 'claude'), 0o755);

const KEY = randomBytes(32).toString('base64url');
const LOGIN = 'ornek-kisi';
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_|CODEX_)/.test(k)));
const baseEnv = { ...clean, HOME: home, PATH: `${bin}:${process.env.PATH}`, npm_config_cache: join(process.env.HOME ?? home, '.npm'), DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0', DREAMCONTEXT_APPS_LOCAL_HOST: hostDir, DREAMCONTEXT_APPS_LOCAL_LOGIN: LOGIN, GIT_CONFIG_GLOBAL: '/dev/null' };
const TSX = ['npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts')]];
const dc = (...args) => {
  const r = spawnSync(TSX[0], [...TSX[1], ...args], { cwd: proj, env: baseEnv, encoding: 'utf-8' });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout}${r.stderr}` };
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...baseEnv, GIT_AUTHOR_NAME: 'Ornek Yazar', GIT_AUTHOR_EMAIL: 'yazar@example.com', GIT_COMMITTER_NAME: 'Ornek Yazar', GIT_COMMITTER_EMAIL: 'yazar@example.com' }, encoding: 'utf-8' });

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
// The new logo the agent proposes: a teal tile with a white parcel.
const LOGO = png(256, (x, y) => (Math.abs(x - 0.5) < 0.24 && Math.abs(y - 0.52) < 0.2 ? (Math.abs(x - 0.5) < 0.03 ? [13, 148, 136, 255] : [255, 255, 255, 255]) : [13, 148, 136, 255]));
const LICENSE = 'MIT License\n\nCopyright (c) 2026 Ornek Yazar\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n';

function makeApp(slug, name, readme) {
  const r = dc('apps', 'new', slug, '--name', name);
  if (!r.ok) throw new Error(`apps new ${slug}: ${r.out}`);
  const root = join(`${proj}-apps`, slug);
  writeFileSync(join(root, 'README.md'), readme);
  writeFileSync(join(root, 'LICENSE'), LICENSE);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'first');
  return root;
}

dc('vaults', 'add', 'proj', proj);
const kargo = makeApp('kargo-takip', 'Kargo Takip', '---\ntagline: Shows where each parcel is.\n---\n\n# Kargo Takip\n\n## What it does\nLists every parcel you track and where it is right now.\n');
makeApp('hava-notu', 'Hava Notu', '---\ntagline: Shows the weather note for the city you set.\n---\n\n# Hava Notu\n\n## What it does\nEvery morning it writes a short note about today\'s weather in your city.\n');

const apiPort = await freePort();
const procs = [];
const killAll = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { killAll(); process.exit(1); });
const api = spawn(TSX[0], [...TSX[1], 'dashboard', '--no-open', '-p', String(apiPort)], { cwd: proj, env: { ...baseEnv, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', openSync(join(SHOTS, 'api.log'), 'w'), openSync(join(SHOTS, 'api.err.log'), 'w')], detached: true });
procs.push(api);
api.stdin.write(`${KEY}\n`);
const ownerHeaders = { 'content-type': 'application/json', origin: `http://127.0.0.1:${apiPort}`, 'sec-fetch-site': 'same-origin', 'x-dreamcontext-owner-key': KEY };
const SHELL = `window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'owner_key' ? ${JSON.stringify(KEY)} : cmd === 'confirm_dialog' ? true : null), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;
/** The notch as the desktop app loads it: window `assistant`, the owner key from the shell. */
const NOTCH_SHELL = `(() => { const handlers = new Map(); let seq = 0;
  const drop = (event, id) => { const l = handlers.get(event); if (l) l.delete(id); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: drop };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'assistant' }, currentWebview: { windowLabel: 'assistant', label: 'assistant' } },
    transformCallback: (cb) => { const id = ++seq; window['_' + id] = cb; return id; },
    invoke: async (cmd, args) => {
      if (cmd === 'owner_key') return ${JSON.stringify(KEY)};
      if (cmd === 'plugin:event|listen') { const l = handlers.get(args.event) ?? new Set(); l.add(args.handler); handlers.set(args.event, l); return args.handler; }
      if (cmd === 'plugin:event|unlisten') { drop(args.event, args.eventId); return null; }
      if (cmd.startsWith('mic_take_')) throw new Error('Command ' + cmd + ' not found');
      if (cmd === 'plugin:window|outer_position') return { x: 0, y: 0 };
      if (cmd === 'plugin:window|scale_factor') return 1;
      return null;
    },
  }; })();`;
const NOISE = /\/@vite\/|\/__vite_ping|favicon\.ico|\/api\/.*\/ws\b|\/api\/apps\/[^/]+\/icon/;

/** The agent's ask, `--wait 0`: the request id, and the card's view as the notch reads it. */
async function ask(...args) {
  const r = dc(...args, '--ask', '--wait', '0', '--json');
  const json = (() => { try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return null; } })();
  check(!!json?.request && json.state === 'pending', `ask ${args.join(' ')}: ${r.out.slice(-400)}`);
  return json?.request ?? '';
}
async function openCards() {
  // A kept-alive socket the server already closed fails once: the read is retried on a new one.
  const url = `http://127.0.0.1:${apiPort}/api/assistant/proposals`;
  const r = await fetch(url).catch(() => new Promise((ok) => setTimeout(ok, 300)).then(() => fetch(url)));
  const body = await r.json().catch(() => ({}));
  return (body.proposals ?? []).filter((p) => p.app);
}
const status = (id) => { const r = dc('apps', 'grant', id, '--wait', '0', '--json'); try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return { state: `unparsed: ${r.out.slice(-200)}` }; } };

let browser;
const telegram = [];
try {
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`, api);
  writeFileSync(join(home, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: api.pid, port: apiPort, launchToken: 'x'.repeat(43), appBundleId: 'com.dreamcontext.verify' }), { mode: 0o600 });

  step('the owner publishes Kargo Takip once (his Share click, the push with its grant)');
  const g = await (await fetch(`http://127.0.0.1:${apiPort}/api/apps/kargo-takip/publish/grant`, { method: 'POST', headers: ownerHeaders, body: '{}' })).json();
  check(!!g.grant, `owner grant: ${JSON.stringify(g)}`);
  const first = dc('apps', 'publish', 'kargo-takip', '--go', '--grant', String(g.grant));
  check(first.ok, `first publish: ${first.out.slice(-400)}`);
  writeFileSync(join(kargo, 'public', 'saat.js'), 'export const every = "1h";\n');
  git(kargo, 'add', '-A');
  git(kargo, 'commit', '-qm', 'hourly refresh');

  const vitePort = await freePort();
  const vite = spawn(join(REPO, 'dashboard', 'node_modules', '.bin', 'vite'), ['--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: join(REPO, 'dashboard'), env: { ...clean, DC_API_TARGET: `http://localhost:${apiPort}` }, stdio: 'ignore', detached: true });
  procs.push(vite);
  const base = `http://127.0.0.1:${vitePort}`;
  await waitFor(base, vite);
  browser = await chromium.launch();

  const watch = (page, where) => {
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text()) && !/status of 4\d\d/.test(m.text())) findings.push(`${where} console: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => findings.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
  };

  /** Kargo Takip's own page; `band` true = the unpublished band must show, false = must not. */
  async function appsPage(width, band, name) {
    const w = width > 600 ? 'desktop' : 'phone';
    const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 } });
    await markAnnouncementsSeen(context, base);
    await context.addInitScript(SHELL);
    const page = await context.newPage();
    watch(page, `apps ${w}`);
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    if (width <= 600) {
      await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 });
      await page.getByText('Apps', { exact: true }).first().click({ timeout: 10_000 });
    } else {
      await page.locator('[aria-label="Apps"]').first().click({ timeout: 10_000 });
    }
    await page.waitForTimeout(1500);
    await page.locator('.app-tile').filter({ hasText: 'Kargo Takip' }).first().locator('.app-tile__open').click({ timeout: 10_000 });
    await page.locator('.share-sheet--page').last().waitFor({ state: 'visible', timeout: 10_000 });
    const bandRow = page.locator('.app-card__note--accent').filter({ has: page.getByRole('button', { name: /Publish the update|Güncellemeyi yayınla/ }) });
    // `unpublished` fills on a background check: the second poll (3 s) carries it.
    const seen = await bandRow.first().waitFor({ state: 'visible', timeout: band ? 15_000 : 7_000 }).then(() => true, () => false);
    check(seen === band, `apps ${w}: band ${band ? 'missing' : 'still showing'}`);
    if (seen) {
      const text = await bandRow.first().innerText();
      check(/not published|yayınlanmamış/.test(text), `apps ${w}: band text is "${text}"`);
    }
    await page.waitForTimeout(600); // the page sheet's open fade settles first
    await page.screenshot({ path: join(SHOTS, `${name}-${w}.png`) });
    await context.close();
  }

  for (const width of [1440, 390]) { step(`Apps page band, before (${width})`); await appsPage(width, true, '1-band-before'); }

  // ── The notch at its own open size ──
  const ctx = await browser.newContext({ viewport: { width: 580, height: 560 } });
  await ctx.addInitScript(NOTCH_SHELL);
  await ctx.route('**/api/agent/voice/focus', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, holder: null, ducked: false, gain: 1, paused: [] }) }));
  const notch = await ctx.newPage();
  watch(notch, 'notch');
  await notch.goto(`${base}/?assistant=1`);
  await notch.waitForSelector('.dc-notch__pill', { timeout: 20_000 });
  /** Waits for the one app card, opens the notch on it, shoots it at the notch size and at a phone width. */
  async function card(action, name) {
    const row = notch.locator(`.dc-proposal--app[data-action="${action}"]`);
    const end = Date.now() + 15_000;
    while (!(await row.isVisible().catch(() => false)) && Date.now() < end) {
      if (await notch.locator('.dc-notch__panel').isHidden().catch(() => true)) await notch.click('.dc-notch__pill').catch(() => {});
      const tab = notch.getByRole('tab', { name: /Now/ });
      if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {});
      await notch.waitForTimeout(700);
    }
    check(await row.isVisible(), `notch: no ${action} card`);
    await notch.waitForTimeout(400);
    await notch.screenshot({ path: join(SHOTS, `${name}-notch.png`) });
    return row;
  }

  step('public publish of Hava Notu → card → Reddet');
  const pubId = await ask('apps', 'publish', 'hava-notu', '--public');
  const pubView = (await openCards()).find((p) => p.app.action === 'publish')?.app;
  check(!!pubView?.warn, `public card has no warning: ${JSON.stringify(pubView)}`);
  if (pubView) telegram.push(['public', pubView]);
  const pubRow = await card('publish', '2-public');
  check(await pubRow.locator('.dc-proposal__eyebrow').textContent() === 'Onayını bekliyor', 'public card: eyebrow');
  await pubRow.getByRole('button', { name: 'Reddet' }).click();
  await notch.waitForTimeout(1500);
  check(status(pubId).state === 'rejected', `public: after Reddet the request is ${status(pubId).state}`);
  check(!(await pubRow.isVisible().catch(() => false)), 'public: the card stayed after Reddet');

  step('logo of Kargo Takip → card with the picture → Onayla → the command sets it');
  writeFileSync(join(kargo, 'public', 'logo-yeni.png'), LOGO);
  git(kargo, 'add', '-A');
  git(kargo, 'commit', '-qm', 'new logo file');
  const logoId = await ask('apps', 'logo', 'kargo-takip', join(kargo, 'public', 'logo-yeni.png'));
  const logoView = (await openCards()).find((p) => p.app.action === 'logo')?.app;
  if (logoView) telegram.push(['logo', logoView]);
  const logoRow = await card('logo', '3-logo');
  const img = logoRow.locator('.dc-proposal__image');
  check(await img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false), 'logo card: the picture did not load');
  await logoRow.getByRole('button', { name: 'Onayla' }).click();
  await notch.waitForTimeout(1500);
  const logoGrant = status(logoId);
  check(logoGrant.state === 'approved' && !!logoGrant.grant?.command, `logo: after Onayla ${JSON.stringify(logoGrant)}`);
  if (logoGrant.grant?.command) {
    const argv = logoGrant.grant.command.replace(/^dreamcontext\s+/, '').match(/'[^']*'|"[^"]*"|\S+/g).map((s) => s.replace(/^['"]|['"]$/g, ''));
    const run = dc(...argv);
    check(run.ok, `logo spend: ${run.out.slice(-300)}`);
    const logoDir = join(home, '.dreamcontext', 'apps', 'logo');
    check(existsSync(logoDir) && readdirSync(logoDir).some((f) => f.endsWith('.png')), 'logo: nothing stored after the spend');
    check(dc(...argv).out.includes('grant_used'), 'logo: a second spend was not refused as used');
  }

  step('a card whose app changed after it opened: Onayla approves nothing and says so');
  const staleId = await ask('apps', 'publish', 'kargo-takip', '--note', 'Kargo durumunu saatte bir yeniler');
  const staleRow = await card('publish', '4a-before-change');
  writeFileSync(join(kargo, 'public', 'saat.js'), 'export const every = "30m";\n');
  git(kargo, 'add', '-A');
  git(kargo, 'commit', '-qm', 'every half hour');
  await staleRow.getByRole('button', { name: 'Onayla' }).click();
  const notice = notch.locator('.dc-proposal__notice');
  check(await notice.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false), 'stale: no notice after Onayla on a changed app');
  check(/hiçbir şey onaylanmadı/.test(await notice.innerText().catch(() => '')), 'stale: the notice does not say nothing was approved');
  check(status(staleId).state === 'stale', `stale: the request is ${status(staleId).state}`);
  await notch.waitForTimeout(3500); // a poll passes: the notice stays until Tamam
  check(await notice.isVisible(), 'stale: the notice went away by itself');
  await notch.screenshot({ path: join(SHOTS, '4b-stale-notice-notch.png') });
  await notice.getByRole('button', { name: 'Tamam' }).click();

  step('update publish of Kargo Takip → card → Onayla → the command publishes');
  const updId = await ask('apps', 'publish', 'kargo-takip', '--note', 'Kargo durumunu saatte bir yeniler');
  const updView = (await openCards()).find((p) => p.app.action === 'publish')?.app;
  if (updView) telegram.push(['update', updView]);
  check(JSON.stringify(updView?.lines ?? []).includes('saat.js'), `update card does not list the changed file: ${JSON.stringify(updView?.lines)}`);
  const updRow = await card('publish', '4-update');
  await updRow.getByRole('button', { name: 'Onayla' }).click();
  await notch.waitForTimeout(1500);
  const updGrant = status(updId);
  check(updGrant.state === 'approved' && !!updGrant.grant?.command, `update: after Onayla ${JSON.stringify(updGrant)}`);
  if (updGrant.grant?.command) {
    const argv = updGrant.grant.command.replace(/^dreamcontext\s+/, '').match(/'[^']*'|"[^"]*"|\S+/g).map((s) => s.replace(/^['"]|['"]$/g, ''));
    const run = dc(...argv);
    check(run.ok, `update spend: ${run.out.slice(-300)}`);
  }
  // The notch at a phone width too (the card must not overflow a narrow panel).
  await notch.setViewportSize({ width: 390, height: 560 });
  await notch.waitForTimeout(400);
  await notch.screenshot({ path: join(SHOTS, '5-after-notch-390.png') });
  await ctx.close();

  for (const width of [1440, 390]) { step(`Apps page band, after (${width})`); await appsPage(width, false, '6-band-after'); }

  // ── Telegram: the message each card sends, through the real renderer ──
  step('Telegram messages from appRequestHtml');
  const renderer = join(scratch, 'render.mts');
  writeFileSync(renderer, `import { appRequestHtml } from ${JSON.stringify(join(REPO, 'src', 'server', 'telegram', 'app-requests.ts'))};\nconst views = JSON.parse(process.argv[2]);\nprocess.stdout.write(JSON.stringify(views.map((v: unknown) => appRequestHtml(v as never))));\n`);
  const rendered = spawnSync('npx', ['--yes', 'tsx', renderer, JSON.stringify(telegram.map(([, v]) => v))], { cwd: REPO, env: { ...clean, HOME: home }, encoding: 'utf-8' });
  const htmls = (() => { try { return JSON.parse(rendered.stdout); } catch { return []; } })();
  check(htmls.length === telegram.length && htmls.length === 3, `telegram render: ${rendered.stdout.slice(-200)}${rendered.stderr.slice(-300)}`);
  const tg = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (let i = 0; i < htmls.length; i++) {
    const [kind] = telegram[i];
    const pic = kind === 'logo' ? `<img src="data:image/png;base64,${LOGO.toString('base64')}" style="width:220px;border-radius:12px;display:block;margin-bottom:6px"><div class="cap">Kargo Takip: yeni logo</div>` : '';
    await tg.setContent(`<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#8fb4cf;font:15px/1.4 -apple-system,system-ui,sans-serif;padding:16px}
      .bar{background:#517da2;color:#fff;margin:-16px -16px 16px;padding:14px 16px;font-weight:600}
      .bub{background:#fff;border-radius:14px;padding:9px 12px;max-width:310px;white-space:pre-wrap;word-break:break-word;margin-bottom:6px}
      .cap{font-size:13px;color:#555}.btns{display:flex;gap:6px;max-width:334px}
      .btns div{flex:1;background:rgba(0,0,0,.25);color:#fff;text-align:center;border-radius:8px;padding:9px;font-weight:600}
    </style><div class="bar">Super</div>${pic ? `<div class="bub">${pic}</div>` : ''}<div class="bub">${htmls[i]}</div><div class="btns"><div>Onayla</div><div>Reddet</div></div>`);
    await tg.screenshot({ path: join(SHOTS, `7-telegram-${kind}.png`) });
  }
  await tg.close();
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.stack ?? err.message : err}`);
} finally {
  await browser?.close().catch(() => {});
  killAll();
  rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write(`shots: ${SHOTS}\n`);
if (findings.length) { process.stdout.write(`FINDINGS:\n${findings.map((f) => `  - ${f}`).join('\n')}\n`); process.exit(1); }
process.stdout.write('app-onay: clean\n');
