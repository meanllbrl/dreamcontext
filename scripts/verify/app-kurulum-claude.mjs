#!/usr/bin/env node
/**
 * A shared app's settings go to Claude (app-kurulum-claude, owner 2026-11-13), seen on screen with
 * the BUILT CLI and server (dist/), nothing sent to GitHub. Two fake HOMEs, A (the publisher) and
 * B (the installer), each with its own API server, owner key and signed-in login, and a LOCAL app
 * host (DREAMCONTEXT_APPS_LOCAL_HOST: bare repos standing in for GitHub). B's `claude` is a
 * scripted stand-in (no tokens) that answers with what `reply.txt` in its HOME holds.
 *
 *   a. B's install window for "Ekip Panosu" (6 settings, 2 required text fields with `find` hints,
 *      1 key): the Claude path is the default and "I'll fill the settings myself" is offered;
 *      also the form behind that link.
 *   b. Install: the chat with the settings prompt is on screen, no app page over it.
 *   c. The installed app's page: the "Waiting for settings" band with "Let Claude set it up".
 *   d. The approval cards in a chat: `apps install … --ask` (Vardiya Planı, an MCP server: a warn
 *      line) and `apps publish … --ask --public` (Not Defteri: a bad line), each block in the
 *      stand-in's reply, drawn with its plan lines and Onayla / Reddet.
 * Light theme, 390 and 1440 px; console errors, page crashes and failed requests are recorded.
 *
 *   dreamcontext builder heavy -- node scripts/verify/app-kurulum-claude.mjs [--out <dir>]
 * Fixtures are fictional. Exit 0 = every check held, 1 = findings.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scratchDir, shotsDir, markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO, 'dist', 'index.js');
if (!existsSync(DIST)) { console.error('dist/index.js is missing: build first'); process.exit(78); }
const outArg = process.argv.indexOf('--out');
const SHOTS = outArg > 0 ? process.argv[outArg + 1] : join(shotsDir(REPO, 'app-kurulum-claude'), String(process.pid));
mkdirSync(SHOTS, { recursive: true });
const scratch = scratchDir(`dc-verify-kurulum-claude-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
const hostDir = join(scratch, 'host');
mkdirSync(hostDir, { recursive: true });

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_|CODEX_|GITHUB_TOKEN|GH_TOKEN)/.test(k)));
const ID = { GIT_AUTHOR_NAME: 'Ornek Yazar', GIT_AUTHOR_EMAIL: 'yazar@example.com', GIT_COMMITTER_NAME: 'Ornek Yazar', GIT_COMMITTER_EMAIL: 'yazar@example.com' };
const findings = [];
const notes = [];
const log = [];
const say = (s) => { log.push(s); process.stdout.write(`${s}\n`); };
const check = (ok, what) => { if (!ok) findings.push(what); say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); return ok; };
const freePort = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

/** B's `claude`: a stream-json stand-in; each user turn is logged, the reply is reply.txt (or a short line). */
const standIn = (home) => `#!${process.execPath}
const fs = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = 'verify-kurulum-' + process.pid;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    fs.appendFileSync(${JSON.stringify(join(home, 'received.jsonl'))}, JSON.stringify(text) + '\\n');
    let reply = 'Tamam.';
    try { reply = fs.readFileSync(${JSON.stringify(join(home, 'reply.txt'))}, 'utf-8'); } catch {}
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'default', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: reply }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: sid });
  }
});
`;

/** One fake Mac: its HOME, project folder, login, owner key and API server. */
function mac(name, login) {
  const home = join(scratch, `home-${name}`);
  const proj = join(scratch, `proj-${name}`);
  const bin = join(home, '.local', 'bin');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), standIn(home));
  chmodSync(join(bin, 'claude'), 0o755);
  const env = {
    ...clean, ...ID, HOME: home, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null',
    npm_config_cache: join(process.env.HOME ?? home, '.npm'),
    DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0', DREAMCONTEXT_APPS_LOCAL_HOST: hostDir,
    DREAMCONTEXT_APPS_LOCAL_LOGIN: login, GITHUB_TOKEN: 'kurulum-claude-dummy-token',
  };
  return { name, login, home, proj, env, key: randomBytes(32).toString('base64url'), api: null, port: 0 };
}
const A = mac('a', 'ornek-ayse');
const B = mac('b', 'ornek-baris');

const git = (m, cwd, ...args) => execFileSync('git', args, { cwd, env: m.env, encoding: 'utf-8' });
function dc(m, ...args) {
  const r = spawnSync(process.execPath, [DIST, ...args], { cwd: m.proj, env: m.env, encoding: 'utf-8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}
async function startApi(m) {
  m.port = m.port || await freePort();
  m.api = spawn(process.execPath, [DIST, 'dashboard', '--no-open', '-p', String(m.port)], { cwd: m.proj, env: { ...m.env, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  m.api.on('error', () => {});
  m.api.stdin.write(`${m.key}\n`);
  const end = Date.now() + 60_000;
  for (;;) {
    if (m.api.exitCode != null) throw new Error(`${m.name}: the server exited ${m.api.exitCode}`);
    try { const r = await fetch(`http://127.0.0.1:${m.port}/api/health`); if (r.status < 500) break; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`${m.name}: the server never answered`);
    await new Promise((r) => setTimeout(r, 300));
  }
  writeFileSync(join(m.home, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: m.api.pid, port: m.port, launchToken: 'x'.repeat(43), appBundleId: 'com.dreamcontext.trial' }), { mode: 0o600 });
}
/** A request as the owner's page makes it (owner key, same origin). */
function api(m, path, { method = 'GET', body } = {}) {
  const origin = `http://127.0.0.1:${m.port}`;
  const data = body !== undefined ? JSON.stringify(body) : null;
  const headers = { 'content-type': 'application/json', 'x-dreamcontext-vault': 'proj', host: `127.0.0.1:${m.port}`, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    'x-dreamcontext-owner-key': m.key, origin, 'sec-fetch-site': 'same-origin' };
  return new Promise((done) => {
    const req = httpRequest({ host: '127.0.0.1', port: m.port, path: `/api${path}`, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch { /* not json */ } done({ status: res.statusCode, body: json }); });
    });
    req.on('error', (e) => done({ status: 0, body: { error: e.message } }));
    if (data) req.write(data);
    req.end();
  });
}
const killAll = () => { for (const m of [A, B]) { try { if (m.api) process.kill(-m.api.pid, 'SIGTERM'); } catch { /* gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { killAll(); process.exit(1); });

/** Make an app on A with this manifest patch, committed. */
function makeApp(m, slug, name, patch) {
  const made = dc(m, 'apps', 'new', slug, '--name', name);
  check(made.ok, `${m.name}: apps new ${slug} (${made.out.split('\n').pop()})`);
  const code = join(`${m.proj}-apps`, slug);
  const man = JSON.parse(readFileSync(join(code, 'dreamcontext-app.json'), 'utf-8'));
  writeFileSync(join(code, 'dreamcontext-app.json'), JSON.stringify({ ...man, ...patch }, null, 2));
  git(m, code, 'add', '-A');
  git(m, code, 'commit', '-qm', 'settings');
  return code;
}

// ─── the browser side ─────────────────────────────────────────────────────────────
const NOISE = /favicon\.ico|\/api\/apps\/[^/]+\/icon/;
const pathOf = (url) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
const shell = (key) => `window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'owner_key' ? ${JSON.stringify(key)} : cmd === 'confirm_dialog' ? true : null), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;
const errorsBy = {};
let browser;
const sockets = [];
async function openB(width, label) {
  const base = `http://127.0.0.1:${B.port}`;
  const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 } });
  await markAnnouncementsSeen(context, base);
  await setTheme(context, 'light');
  await context.addInitScript(shell(B.key));
  const page = await context.newPage();
  const where = `${label}@${width}`;
  const errs = (errorsBy[where] = errorsBy[where] ?? []);
  page.on('console', (msg) => { if (msg.type() === 'error' && !NOISE.test(msg.text())) errs.push(`console: ${msg.text().slice(0, 220)}`); });
  page.on('pageerror', (e) => errs.push(`crash: ${String(e.message).slice(0, 220)}`));
  page.on('requestfailed', (r) => { if (!NOISE.test(r.url())) errs.push(`failed request: ${r.method()} ${pathOf(r.url())} (${r.failure()?.errorText ?? ''})`); });
  page.on('response', (r) => { if (r.status() >= 400 && !NOISE.test(r.url())) errs.push(`${r.status()}: ${r.request().method()} ${pathOf(r.url())}`); });
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  return { page, context };
}
async function toApps(page, width) {
  if (width <= 600) {
    await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 });
    await page.getByText('Apps', { exact: true }).first().click({ timeout: 10_000 });
  } else {
    await page.locator('[aria-label="Apps"]').first().click({ timeout: 10_000 });
  }
  await page.waitForTimeout(1500);
}
const seen = (page, text, ms = 10_000) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const appPage = (page) => page.locator('.share-sheet--page').last();
async function capture(page, name, width) {
  await page.waitForTimeout(400);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 1, `${name}@${width}: no sideways overflow (${over}px)`);
  const file = join(SHOTS, `${name}-${width}.png`);
  await page.screenshot({ path: file });
  say(`screenshot: ${file}`);
  return file;
}
/** Open the install window of a Shared Apps row. */
async function openInstall(page, width, name) {
  await toApps(page, width);
  await page.getByRole('tab', { name: /^Shared/ }).click({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  await page.locator('.store-row').filter({ hasText: name }).getByRole('button', { name: 'Get' }).click({ timeout: 15_000 });
  return appPage(page).waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
}
const received = () => { const f = join(B.home, 'received.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

const SETTINGS = [
  { key: 'ekipAdi', type: 'text', label: 'Ekip adı', required: true, find: "The team's name: the first heading of this brain's core/soul.md." },
  { key: 'raporKanali', type: 'text', label: 'Rapor kanalı', required: true, help: 'Like #ekip-rapor', find: 'The Slack channel the team posts its weekly report in: the slack MCP server or the project notes.' },
  { key: 'PANO_API_KEY', type: 'secret', label: 'Pano API anahtarı', required: true, help: 'From the Pano account page' },
  { key: 'raporGunu', type: 'choice', label: 'Rapor günü', required: false, choices: ['Pazartesi', 'Cuma'] },
  { key: 'kartSayisi', type: 'number', label: 'Gösterilecek kart sayısı', required: false, help: 'Default 12' },
  { key: 'panoRengi', type: 'text', label: 'Pano rengi', required: false, help: 'A colour name, e.g. mavi' },
];

try {
  say('== setup: A publishes Ekip Panosu and Vardiya Planı privately to B');
  mkdirSync(join(A.proj, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(A.proj, '_dream_context', 'knowledge'), { recursive: true });
  writeFileSync(join(A.proj, '_dream_context', 'knowledge', 'ekip.md'), '# Ekip\n\nOrtak pano.\n');
  git(A, A.proj, 'init', '-q', '-b', 'main');
  git(A, A.proj, 'add', '-A');
  git(A, A.proj, 'commit', '-qm', 'brain');
  check(dc(A, 'vaults', 'add', 'proj', A.proj).ok, 'A: the project is registered');
  mkdirSync(join(B.proj, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(B.proj, '_dream_context', 'core'), { recursive: true });
  writeFileSync(join(B.proj, '_dream_context', 'core', 'soul.md'), '# Kuzey Ekibi\n\nHaftalık pano.\n');
  git(B, B.proj, 'init', '-q', '-b', 'main');
  git(B, B.proj, 'add', '-A');
  git(B, B.proj, 'commit', '-qm', 'brain');
  check(dc(B, 'vaults', 'add', 'proj', B.proj).ok, 'B: the project is registered');
  await startApi(A);

  makeApp(A, 'ekip-panosu', 'Ekip Panosu', { config: SETTINGS });
  makeApp(A, 'vardiya-plani', 'Vardiya Planı', {
    mcp: ['ornek-takvim'],
    config: [
      { key: 'ekipAdi', type: 'text', label: 'Ekip adı', required: true, find: "The first heading of this brain's core/soul.md." },
      { key: 'VARDIYA_TOKEN', type: 'secret', label: 'Vardiya anahtarı', required: true },
    ],
  });
  for (const [slug, tagline] of [['ekip-panosu', "Shows the team's week on one board."], ['vardiya-plani', 'Plans who works which shift.']]) {
    const grant = await api(A, `/apps/${slug}/publish/grant`, { method: 'POST', body: {} });
    check(grant.status === 200 && !!grant.body.grant, `A: the Share click on ${slug} opened a grant (${grant.status})`);
    const pub = dc(A, 'apps', 'publish', slug, '--go', '--grant', String(grant.body.grant), '--invite', B.login, '--note', 'İlk sürüm', '--tagline', tagline);
    check(pub.ok, `A: apps publish ${slug} --go → ${pub.out.split('\n').filter(Boolean).pop()}`);
  }

  await startApi(B);
  const shared = await api(B, '/apps/shared?refresh=1');
  for (const inv of shared.body.invitations ?? []) {
    check((await api(B, '/apps/shared/accept', { method: 'POST', body: { id: inv.id } })).status === 200, `B: accepted ${inv.fullName ?? inv.id}`);
  }
  const listed = await api(B, '/apps/shared?refresh=1');
  say(`B: shared with B: ${JSON.stringify((listed.body.shared ?? []).map((s) => s.fullName))}`);

  browser = await chromium.launch();

  // ─── a. the install window ────────────────────────────────────────────────────
  say('== a. B: the install window of Ekip Panosu');
  for (const width of [390, 1440]) {
    const { page, context } = await openB(width, 'kurulum');
    const opened = await openInstall(page, width, 'Ekip Panosu');
    check(opened, `a@${width}: the install window opened`);
    check(await seen(page, "I'll fill the settings myself"), `a@${width}: "I'll fill the settings myself" is offered`);
    check(await seen(page, 'Claude sets up its settings after the install'), `a@${width}: the Claude path is said`);
    const install = appPage(page).getByRole('button', { name: 'Install', exact: true }).first();
    check(await install.isEnabled().catch(() => false), `a@${width}: Install is not blocked by the empty settings`);
    await capture(page, 'sonra-kurulum', width);
    await page.getByRole('button', { name: "I'll fill the settings myself" }).click();
    check(await seen(page, 'Ekip adı'), `a@${width}: the form shows the settings after the link`);
    await capture(page, 'sonra-form', width);
    await context.close();
  }

  // ─── b. Install: the chat with the settings prompt is on screen ───────────────
  say('== b. B: Install → the chat gets the settings prompt');
  for (const width of [390, 1440]) {
    const { page, context } = await openB(width, 'sohbet');
    check(await openInstall(page, width, 'Ekip Panosu'), `b@${width}: the install window opened`);
    const sockBefore = sockets.length;
    await appPage(page).getByRole('button', { name: 'Install', exact: true }).first().click();
    const inBox = () => page.evaluate(() => [...document.querySelectorAll('textarea.chat-cmp-input')].find((t) => t.offsetParent && t.value.includes('/apps I installed the app'))?.value ?? null);
    let text = null; let via = null;
    for (const end = Date.now() + 30_000; Date.now() < end && !text; await page.waitForTimeout(300)) {
      const box = await inBox();
      if (box) { text = box; via = 'the chat box'; break; }
      const sent = sockets.slice(sockBefore).map((u) => { try { return new URL(u).searchParams.get('prompt'); } catch { return null; } }).find((t) => t && t.includes('/apps I installed the app'));
      if (sent) { text = sent; via = 'a new chat'; }
    }
    check(!!text, `b@${width}: the settings prompt reached a chat (${via ?? 'none'})`);
    if (text) {
      check(text.includes('(ekip-panosu)') && text.includes('Find it:') && text.includes('Required and still empty'), `b@${width}: the prompt names the app, the find hints and what is empty`);
      if (width === 1440) say(`b: the prompt:\n${text.split('\n').map((l) => `    ${l}`).join('\n')}`);
    }
    await page.waitForTimeout(1500);
    const covering = await page.locator('.share-sheet--page:visible').count();
    check(covering === 0, `b@${width}: no app page covers the chat (${covering} open)`);
    const chatVisible = await page.locator('.chat-cmp-input:visible').count();
    check(chatVisible > 0, `b@${width}: a chat composer is on screen`);
    await capture(page, 'sonra-sohbet', width);
    await context.close();
    if (width === 390) {
      const un = await api(B, '/apps/ekip-panosu/uninstall', { method: 'POST', body: { deleteData: true } });
      check(un.status === 200, `B: uninstall between widths → ${un.status} ${JSON.stringify(un.body).slice(0, 120)}`);
    }
  }

  // ─── c. the app page with the band ────────────────────────────────────────────
  say('== c. B: Ekip Panosu\'s page with the settings band');
  const appsB = await api(B, '/apps');
  const row = (appsB.body.apps ?? []).find((x) => x.slug === 'ekip-panosu');
  say(`B: ekip-panosu configMissing ${JSON.stringify(row?.configMissing)} labels ${JSON.stringify(row?.configMissingLabels)}`);
  for (const width of [390, 1440]) {
    const { page, context } = await openB(width, 'band');
    await toApps(page, width);
    await page.locator('.app-tile').filter({ hasText: 'Ekip Panosu' }).first().locator('.app-tile__open').click({ timeout: 10_000 }).catch((e) => findings.push(`c@${width}: the tile did not open (${e.message.slice(0, 80)})`));
    const btn = page.getByRole('button', { name: 'Let Claude set it up' }).first();
    const has = await btn.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
    check(has, `c@${width}: "Let Claude set it up" is on the app page`);
    if (has) await btn.scrollIntoViewIfNeeded();
    check(await seen(page, 'Waiting for settings'), `c@${width}: the band says what it waits for`);
    await capture(page, 'sonra-band', width);
    if (width === 1440 && has) {
      await btn.click();
      const got = await until(async () => (await page.evaluate(() => [...document.querySelectorAll('textarea.chat-cmp-input')].some((t) => t.offsetParent && t.value.includes('/apps I installed the app')))), 15_000);
      check(got, 'c@1440: "Let Claude set it up" put the prompt in a chat');
      await page.waitForTimeout(1000);
      await capture(page, 'sonra-band-sohbet', width);
    }
    await context.close();
  }

  // ─── d. the approval cards in a chat ──────────────────────────────────────────
  say('== d. B: approval cards in a chat');
  const ask = dc(B, 'apps', 'install', `${A.login}/vardiya-plani-app`, '--ask', '--set', 'ekipAdi=Kuzey Ekibi');
  say(`B: apps install --ask →\n${ask.out.split('\n').map((l) => `    ${l}`).join('\n')}`);
  const block1 = ask.out.match(/```dream-view\n.*\n```/)?.[0];
  check(!!block1, 'd: apps install --ask printed the app-request block');
  makeApp(B, 'not-defteri', 'Not Defteri', {});
  writeFileSync(join(`${B.proj}-apps`, 'not-defteri', 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 Ornek Baris\n');
  git(B, join(`${B.proj}-apps`, 'not-defteri'), 'add', '-A');
  git(B, join(`${B.proj}-apps`, 'not-defteri'), 'commit', '-qm', 'license');
  const ask2 = dc(B, 'apps', 'publish', 'not-defteri', '--ask', '--public');
  say(`B: apps publish --ask --public →\n${ask2.out.split('\n').map((l) => `    ${l}`).join('\n')}`);
  const block2 = ask2.out.match(/```dream-view\n.*\n```/)?.[0];
  if (!block2) notes.push('d: the public publish --ask gave no card (see the log); the bad-tone line is not shown');
  writeFileSync(join(B.home, 'reply.txt'), [
    "Vardiya Planı'nı kurmak için onayın gerekiyor: başka birinin yazdığı kod senin Mac'inde çalışacak.",
    '', block1 ?? '(no block)', '',
    ...(block2 ? ["Not Defteri'ni herkese açık yayınlamak için de onayın gerekiyor.", '', block2] : []),
  ].join('\n'));

  for (const width of [390, 1440]) {
    const { page, context } = await openB(width, 'onay');
    const vis = (sel) => page.locator(`${sel}:visible`);
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    if (!(await vis('.chat-cmp-input').count())) {
      for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
        if (await vis('.chat-cmp-input').count()) break;
      }
    }
    if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).first().click().catch(() => {});
    if (!(await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20_000))) { findings.push(`d@${width}: no chat composer`); await capture(page, 'x-onay-yok', width); await context.close(); continue; }
    const before = received().length;
    await vis('.chat-cmp-input').first().click();
    await vis('.chat-cmp-input').first().fill("Vardiya Planı'nı kur, Not Defteri'ni de herkese aç");
    await page.keyboard.press('Enter');
    check(await until(() => received().length > before, 20_000), `d@${width}: the stand-in Claude got the turn`);
    const cards = page.locator('[data-view-kind="app-request"]');
    const drawn = await until(async () => (await cards.filter({ has: page.getByRole('button', { name: 'Onayla' }) }).count()) >= (block2 ? 2 : 1), 20_000);
    check(drawn, `d@${width}: the app-request card(s) are drawn with Onayla (${await cards.count()} cards)`);
    const first = cards.first();
    const lines = await first.locator('.chat-appreq-line').evaluateAll((els) => els.map((e) => `${e.querySelector('dt')?.textContent}: ${e.querySelector('dd')?.textContent} [${e.dataset.tone ?? ''}|${getComputedStyle(e.querySelector('dd')).color}]`)).catch(() => []);
    say(`d@${width}: install card lines:\n${lines.map((l) => `    ${l}`).join('\n')}`);
    check(lines.some((l) => l.includes('[warn|')), `d@${width}: the MCP line carries the warn tone`);
    check(await first.getByRole('button', { name: 'Reddet' }).count() === 1, `d@${width}: Reddet on the install card`);
    // Fit the install card: its top at the top of the transcript.
    await first.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(500);
    await capture(page, 'sonra-onay-karti', width);
    if (block2) {
      const second = cards.nth(1);
      const l2 = await second.locator('.chat-appreq-line').evaluateAll((els) => els.map((e) => `${e.querySelector('dt')?.textContent}: ${e.querySelector('dd')?.textContent} [${e.dataset.tone ?? ''}|${getComputedStyle(e.querySelector('dd')).color}]`)).catch(() => []);
      say(`d@${width}: publish card lines:\n${l2.map((l) => `    ${l}`).join('\n')}`);
      check(l2.some((l) => l.includes('[bad|')), `d@${width}: the public line carries the bad tone`);
      await second.evaluate((el) => el.scrollIntoView({ block: 'end' }));
      await page.waitForTimeout(500);
      await capture(page, 'sonra-onay-karti-yayin', width);
    }
    await context.close();
  }
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' ') : err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  killAll();
}
say('\n== console errors / failed requests per page');
for (const [where, errs] of Object.entries(errorsBy)) say(`${where}: ${errs.length ? `\n    ${[...new Set(errs)].join('\n    ')}` : 'none'}`);
writeFileSync(join(SHOTS, 'walk.log'), `${log.join('\n')}\n\nnotes:\n${notes.join('\n') || 'none'}\n\nfindings:\n${findings.join('\n') || 'none'}\n`);
say(`\nwalk log: ${join(SHOTS, 'walk.log')}`);
if (notes.length) say(`NOTES:\n- ${notes.join('\n- ')}`);
say(findings.length ? `FINDINGS (${findings.length}):\n- ${findings.join('\n- ')}` : 'every check held');
process.exit(findings.length ? 1 : 0);
