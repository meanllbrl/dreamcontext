#!/usr/bin/env node
/**
 * Live links end to end (tunel-paylasim validation method): a real pinned cloudflared quick
 * tunnel, a real app with a backend and a real whiteboard, the guest in Playwright at 390 and
 * 1440 px over the PUBLIC link, and a close in the middle of a session. Scratch HOME and project:
 * nothing touches this Mac's own brain (the pinned cloudflared is copied in when this Mac has it,
 * so no download; its sha256 is checked by the product as on any start).
 *
 *   npm run build   (the board viewer is the build's share.html)
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/shares.mjs
 *
 * Checks, by criterion: K1 stages then a reachable link; K2 the guest uses the app (page, backend,
 * a write) with no console error; K3 no dashboard answer over the tunnel, /__dc/api/tasks,
 * embed/chat, notify, schedules refused; K5 password page, 6th wrong try refused, right one in;
 * K6 close: closed page within 1 s, cloudflared and the share dir gone within 70 s; K7 the board
 * guest sees an owner edit within ~5 s, widget titles only, closed within 5 s; K10 quitting kills
 * every cloudflared within 5 s; K11 caffeinate while open; K12 list shows no secret, a request
 * without the owner key is refused.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scratchDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(REPO, 'tmp', 'verify', 'shares', String(process.pid));
mkdirSync(SHOTS, { recursive: true });
const scratch = scratchDir(`dc-verify-shares-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, 'home');
const proj = join(scratch, 'proj');
for (const d of [join(home, '.dreamcontext'), join(proj, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
const bin = join(home, '.local', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
chmodSync(join(bin, 'claude'), 0o755);
// The pinned cloudflared this Mac already has (the product re-checks its sha256 before use).
const pins = JSON.parse(readFileSync(join(REPO, 'assets', 'cloudflared-pins.json'), 'utf8'));
const pinVersion = pins.cloudflared?.version;
const mine = pinVersion ? join(homedir(), '.dreamcontext', 'bin', `cloudflared-${pinVersion}`) : '';
if (mine && existsSync(mine)) {
  mkdirSync(join(home, '.dreamcontext', 'bin'), { recursive: true, mode: 0o700 });
  copyFileSync(mine, join(home, '.dreamcontext', 'bin', `cloudflared-${pinVersion}`));
  chmodSync(join(home, '.dreamcontext', 'bin', `cloudflared-${pinVersion}`), 0o755);
}

const KEY = randomBytes(32).toString('base64url');
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_|CODEX_)/.test(k)));
const baseEnv = { ...clean, HOME: home, PATH: `${bin}:${process.env.PATH}`, npm_config_cache: join(process.env.HOME ?? home, '.npm'), DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
const TSX = ['npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts')]];
const dc = (...args) => {
  const r = spawnSync(TSX[0], [...TSX[1], ...args], { cwd: proj, env: baseEnv, encoding: 'utf-8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

const findings = [];
const timings = {};
const check = (ok, what) => { if (!ok) findings.push(what); return ok; };
const step = (s) => process.stdout.write(`step: ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

// ─── the scratch project: one app with a backend, one board ─────────────────
dc('vaults', 'add', 'proj', proj);
const made = dc('apps', 'new', 'funnel', '--name', 'Funnel Masası');
check(made.ok, `apps new: ${made.out.slice(-300)}`);
const appRoot = join(`${proj}-apps`, 'funnel');
writeFileSync(join(appRoot, 'server.mjs'), `import http from 'node:http';
let count = 0;
const page = '<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Funnel Masası</title>'
  + '<body style="font:16px system-ui;margin:24px"><h1>Funnel Masası</h1><p>Son 7 gün</p><p id="n">…</p><button id="b">Kaydet</button>'
  + '<script>const n=document.getElementById("n");fetch("/api/count").then(r=>r.json()).then(j=>{n.textContent="Kayıt: "+j.count});'
  + 'document.getElementById("b").onclick=()=>fetch("/api/count",{method:"POST"}).then(r=>r.json()).then(j=>{n.textContent="Kayıt: "+j.count+(j.data===200?"":" veri: "+j.data)});</script></body></html>';
http.createServer((req, res) => {
  if (req.headers['x-dc-gateway-secret'] !== process.env.DC_GATEWAY_SECRET) { res.writeHead(401); res.end(); return; }
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/api/count') {
    const done = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ count, data, guest: req.headers['x-dc-guest'] === '1' })); };
    if (req.method !== 'POST') { done(null); return; }
    count++;
    // The app's own data write (K2): the backend's /__dc/data, as a real app saves.
    fetch(process.env.DC_URL + '/__dc/data/write', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.DC_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'kayit.json', content: JSON.stringify({ count }) }) })
      .then((r) => done(r.status), (e) => done('error ' + e.message));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
}).listen(Number(process.env.PORT), process.env.HOST);
`);
const manifestPath = join(appRoot, 'dreamcontext-app.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
writeFileSync(manifestPath, JSON.stringify({ ...manifest, backend: { command: 'node server.mjs', health: '/health' } }, null, 2));
const board = dc('whiteboard', 'create', 'Lansman akışı', '--json');
const boardSlug = (() => { try { return JSON.parse(board.out.slice(board.out.indexOf('{'))).slug; } catch { return 'lansman-akisi'; } })();
check(dc('whiteboard', 'add', boardSlug, 'note', '--title', 'Reklam', '--text', 'Reklam metni').ok, 'board note');
check(dc('whiteboard', 'add', boardSlug, 'web', '--title', 'Paywall testi', '--url', 'https://example.com/gizli-adres').ok, 'board web card');
const picture = join(proj, 'kapak.png');
copyFileSync(join(REPO, 'dashboard', 'public', 'icons', 'icon-192.png'), picture);
check(dc('whiteboard', 'add', boardSlug, 'image', '--file', picture).ok, 'board picture');

// ─── the server, as the Mac app's own (owner key on stdin) ──────────────────
const apiPort = await freePort();
const procs = [];
const killAll = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { killAll(); process.exit(1); });
const api = spawn(TSX[0], [...TSX[1], 'dashboard', '--no-open', '-p', String(apiPort)], { cwd: proj, env: { ...baseEnv, DREAMCONTEXT_OWNER_KEY_STDIN: '1', DREAMCONTEXT_PARENT_PID: String(process.pid) }, stdio: ['pipe', openSync(join(SHOTS, 'api.log'), 'w'), openSync(join(SHOTS, 'api.err.log'), 'w')], detached: true });
procs.push(api);
api.stdin.write(`${KEY}\n`);
const local = `http://127.0.0.1:${apiPort}`;
const owner = { 'content-type': 'application/json', origin: local, 'sec-fetch-site': 'same-origin', 'x-dreamcontext-owner-key': KEY };
const plain = { 'content-type': 'application/json' };
const j = async (r) => { try { return await r.json(); } catch { return null; } };
const listShares = async () => ((await j(await fetch(`${local}/api/shares`))) ?? {}).shares ?? [];
const cloudflareds = () => {
  const r = spawnSync('pgrep', ['-f', join(home, '.dreamcontext', 'bin')], { encoding: 'utf-8' });
  return r.stdout.split('\n').map(Number).filter(Boolean);
};

async function openAndReveal(body, label) {
  const r = await fetch(`${local}/api/shares`, { method: 'POST', headers: owner, body: JSON.stringify(body) });
  const s = await j(r);
  if (!check(r.status === 201 && s?.id, `${label}: open answered ${r.status} ${JSON.stringify(s)}`)) return null;
  const stages = new Set();
  const until = Date.now() + 240_000;
  let row = null;
  while (Date.now() < until) {
    row = (await listShares()).find((x) => x.id === s.id);
    if (row?.stage) stages.add(row.stage);
    if (!row || row.state !== 'starting') break;
    await sleep(500);
  }
  if (!check(row?.state === 'open', `${label}: never opened (${JSON.stringify(row)})`)) return null;
  check(JSON.stringify(row).indexOf('trycloudflare') < 0 && !('token' in row) && !('link' in row), `${label}: the list carries a secret: ${JSON.stringify(row)}`);
  step(`${label}: open after stages ${[...stages].join(' > ') || '(too fast to see)'}`);
  const rev = await j(await fetch(`${local}/api/shares/${s.id}/reveal`, { method: 'POST', headers: owner, body: '{}' }));
  check(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/k\/[A-Za-z0-9_-]{40,}$/.test(rev?.link ?? ''), `${label}: reveal gave ${JSON.stringify(rev)}`);
  // K1: the link the owner gets answers at once.
  const first = await fetch(rev.link, { redirect: 'manual' }).catch((e) => ({ status: `error ${e.message}` }));
  check(first.status === 200, `${label}: the revealed link did not answer at once (${first.status})`);
  return { id: s.id, ...rev, origin: new URL(rev.link).origin };
}

let browser;
try {
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${local}/api/health`)).ok) break; } catch { /* not yet */ } await sleep(300); }
  const sentinel = (await j(await fetch(`${local}/api/health`)))?.version;
  check(!!sentinel, 'the dashboard health has no version sentinel');

  step('K12: without the owner key, open and reveal are refused');
  const noKey = await fetch(`${local}/api/shares`, { method: 'POST', headers: plain, body: JSON.stringify({ kind: 'app', vault: 'proj', slug: 'funnel' }) });
  check(noKey.status === 403 && (await j(noKey))?.error === 'owner_page_only', `open without the key: ${noKey.status}`);

  step('K1: the owner opens the app link with a password');
  const PW = 'kavun-deniz-fener';
  const app = await openAndReveal({ kind: 'app', vault: 'proj', slug: 'funnel', password: PW }, 'app');
  check(!!app?.password && app.password === PW, 'reveal did not return the password');
  const revealNoKey = await fetch(`${local}/api/shares/${app?.id}/reveal`, { method: 'POST', headers: plain, body: '{}' });
  check(revealNoKey.status === 403, `reveal without the key: ${revealNoKey.status}`);

  step('K11: caffeinate holds the Mac while a link is open');
  const serverPid = Number(spawnSync('lsof', ['-nP', `-iTCP:${apiPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf-8' }).stdout.trim().split('\n')[0]);
  check(serverPid > 0, 'K11: the server pid (listening on the API port) was not found');
  const serverCaff = () => spawnSync('pgrep', ['-P', String(serverPid), 'caffeinate'], { encoding: 'utf-8' }).stdout.trim().split('\n').filter(Boolean).map(Number);
  const assertions = spawnSync('pmset', ['-g', 'assertions'], { encoding: 'utf-8' }).stdout;
  const caff = serverCaff();
  check(caff.length > 0 && caff.some((p) => new RegExp(`pid ${p}\\(caffeinate\\)`).test(assertions)), `K11: no caffeinate child of the server (pid ${serverPid}) holding an assertion while open`);
  timings.k11ServerPid = serverPid;
  timings.k11Caffeinate = caff;

  step('K5 + K3: password page, the 6th wrong try, the right one, then the closed rooms');
  const door = await fetch(app.link, { redirect: 'manual' });
  const doorHtml = await door.text();
  // The password page names the app (approved drawing, section 5); the app itself (its record count, its Kaydet button) stays behind it.
  check(/şifre/i.test(doorHtml) && /type="password"/.test(doorHtml) && !/Kaydet|Kayıt:/.test(doorHtml), 'the link with a password shows more than the password page');
  const ticket = (door.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  let last = 0;
  for (let i = 1; i <= 6; i++) {
    const r = await fetch(`${app.origin}/__share/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ticket, origin: app.origin }, body: `p=yanlis-sifre-${i}` });
    last = r.status;
  }
  check(last === 429, `6th wrong password answered ${last}, not 429`);

  browser = await chromium.launch();
  const guestErrors = [];
  for (const w of [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }]) {
    const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height } });
    const page = await ctx.newPage();
    // After the owner closes the link the closed page answers 410: that console line is the close, not an error.
    let closing = false;
    page.on('console', (m) => { if (m.type() === 'error' && !closing) guestErrors.push(`app@${w.name}: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => guestErrors.push(`app@${w.name} crash: ${e.message.slice(0, 160)}`));
    await page.goto(app.link, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: join(SHOTS, `guest-password-${w.name}.png`) });
    // A fresh IP window: the limiter counted the fetches above per IP for one minute.
    if (w.name === 'phone') await sleep(61_000);
    await page.locator('input[type=password]').fill(PW);
    await page.locator('button[type=submit], input[type=submit]').first().click();
    const inApp = await page.getByRole('heading', { name: 'Funnel Masası' }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
    check(inApp, `K2 @${w.name}: the right password did not open the app`);
    await page.getByText(/Kayıt: \d+/).waitFor({ timeout: 10_000 }).catch(() => check(false, `K2 @${w.name}: the backend never answered`));
    const before = Number((await page.locator('#n').textContent())?.match(/\d+/)?.[0] ?? -1);
    await page.getByRole('button', { name: 'Kaydet' }).click();
    await page.waitForFunction((b) => Number(document.getElementById('n')?.textContent?.match(/\d+/)?.[0] ?? -1) === b + 1, before, { timeout: 10_000 }).catch(() => check(false, `K2 @${w.name}: the write did not land`));
    const saved = (await page.locator('#n').textContent()) ?? '';
    check(!/veri:/.test(saved), `K2 @${w.name}: the app's /__dc/data write failed: ${saved}`);
    await page.screenshot({ path: join(SHOTS, `guest-app-${w.name}.png`) });
    if (w.name === 'desktop') {
      const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
      const health = await (await fetch(`${app.origin}/api/health`, { headers: { cookie } })).text();
      check(!(sentinel && health.includes(sentinel)), 'K3: a dashboard health answer came back over the tunnel');
      for (const p of ['/__dc/api/tasks', '/__dc/embed/chat', '/__dc/notify', '/__dc/schedules']) {
        const r = await fetch(`${app.origin}${p}`, { headers: { cookie, origin: app.origin } });
        check(r.status === 403 || r.status === 404, `K3: ${p} answered ${r.status}`);
      }
      step('K6: the owner closes the app link in the middle of the session');
      closing = true;
      const t0 = Date.now();
      await fetch(`${local}/api/shares/${app.id}/close`, { method: 'POST', headers: plain, body: '{}' });
      let closedSeen = false;
      while (Date.now() - t0 < 1_000 && !closedSeen) {
        closedSeen = /Bu paylaşım kapandı/.test(await (await fetch(`${app.origin}/anything`, { headers: { cookie, accept: 'text/html' } })).text());
        if (!closedSeen) await sleep(100);
      }
      check(closedSeen, 'K6: the link did not say "Bu paylaşım kapandı" within 1 s');
      timings.k6ClosedPageMs = Date.now() - t0;
      await page.reload({ waitUntil: 'domcontentloaded' });
      check(await page.getByText('Bu paylaşım kapandı').first().isVisible(), 'K6: the guest page after close is not the closed page');
      await page.screenshot({ path: join(SHOTS, `guest-closed-${w.name}.png`) });
    }
    await ctx.close();
  }
  for (const e of guestErrors) findings.push(`K2 console: ${e}`);

  step('K7: the board link, live and read-only');
  const brd = await openAndReveal({ kind: 'board', vault: 'proj', slug: boardSlug }, 'board');
  for (const w of [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }]) {
    const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errs.push(`crash: ${e.message.slice(0, 160)}`));
    const scene = [];
    page.on('response', async (r) => { if (r.url().includes('/__share/board')) scene.push(await r.text().catch(() => '')); });
    const pictures = [];
    page.on('response', (r) => { const u = new URL(r.url()); if (u.origin === brd.origin && u.pathname.startsWith('/__share/files')) pictures.push(r.status()); });
    // The viewer's own assets (fonts above all) must answer 200 from the share: a miss sends Excalidraw to its CDN fallback.
    page.on('response', (r) => { const u = new URL(r.url()); if (u.origin === brd.origin && u.pathname.startsWith('/excalidraw-assets/') && r.status() !== 200) errs.push(`asset ${r.status()} ${u.pathname}`); });
    page.on('requestfailed', (r) => { const u = new URL(r.url()); if (u.origin === brd.origin) errs.push(`request failed ${u.pathname}: ${r.failure()?.errorText ?? ''}`); });
    await page.goto(brd.link, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4_000);
    check(scene.some((s) => s.includes('Paywall testi')) && !scene.some((s) => s.includes('gizli-adres')), `K7 @${w.name}: the scene is missing the card title or leaks its url`);
    if (w.name === 'desktop') {
      // The edit runs WITHOUT blocking this loop (a sync spawn would hide when the guest got it), and
      // the edit lands on disk somewhere between the CLI's start and its exit: arrival minus exit is
      // the latency's floor, arrival minus start its ceiling. The ceiling must be within 5 s once the
      // CLI's own start-up (npx tsx) is taken out, i.e. arrival minus exit within 5 s.
      let arrivedAt = 0;
      page.on('response', async (r) => { if (!arrivedAt && r.url().includes('/__share/board') && (await r.text().catch(() => '')).includes('Yeni not')) arrivedAt = Date.now(); });
      const started = Date.now();
      const code = await new Promise((done) => {
        const p = spawn(TSX[0], [...TSX[1], 'whiteboard', 'add', boardSlug, 'note', '--title', 'Funnel', '--text', 'Yeni not'], { cwd: proj, env: baseEnv, stdio: 'ignore' });
        p.on('exit', done);
      });
      const exited = Date.now();
      check(code === 0, `K7: the owner edit failed (exit ${code})`);
      while (Date.now() - exited < 15_000 && !arrivedAt) await sleep(100);
      timings.k7OwnerEdit = { cliMs: exited - started, afterCliExitMs: arrivedAt ? arrivedAt - exited : null, afterCliStartMs: arrivedAt ? arrivedAt - started : null };
      check(!!arrivedAt && arrivedAt - exited <= 5_000, `K7: the owner edit did not reach the guest within 5 s (${JSON.stringify(timings.k7OwnerEdit)})`);
      step(`K7: owner edit reached the guest ${timings.k7OwnerEdit.afterCliExitMs} ms after the CLI exited (${timings.k7OwnerEdit.afterCliStartMs} ms after it started)`);
    }
    await page.waitForTimeout(500);
    const drawn = await page.evaluate(() => [...document.querySelectorAll('img, canvas')].length);
    check(scene.some((s) => s.includes('"image"')) && pictures.includes(200), `K7 @${w.name}: the picture did not load (scene image: ${scene.some((s) => s.includes('"image"'))}, /__share/files answers ${JSON.stringify(pictures)})`);
    await page.screenshot({ path: join(SHOTS, `guest-board-${w.name}.png`) });
    timings[`k7Pictures_${w.name}`] = { responses: pictures, elements: drawn };
    for (const e of errs) findings.push(`K7 console @${w.name}: ${e}`);
    if (w.name === 'desktop') {
      const tc = Date.now();
      await fetch(`${local}/api/shares/${brd.id}/close`, { method: 'POST', headers: plain, body: '{}' });
      const shown = await page.getByText('Bu paylaşım kapandı').first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
      timings.k7ClosedFaceMs = Date.now() - tc;
      check(shown, `K7: the open viewer did not say "Bu paylaşım kapandı" within 5 s (${timings.k7ClosedFaceMs} ms)`);
      await page.screenshot({ path: join(SHOTS, `guest-board-closed-${w.name}.png`) });
    }
    await ctx.close();
  }

  step('K6: cloudflared and the share dir go within 70 s of the close');
  const t1 = Date.now();
  const shareDirs = () => existsSync(join(home, '.dreamcontext', 'shares')) && readdirSync(join(home, '.dreamcontext', 'shares'), { withFileTypes: true }).some((d) => d.isDirectory());
  while (Date.now() - t1 < 70_000 && (cloudflareds().length || shareDirs() || serverCaff().length)) await sleep(500);
  timings.k6TeardownMs = Date.now() - t1;
  check(cloudflareds().length === 0, `K6: cloudflared still running ${Math.round((Date.now() - t1) / 1000)} s after the close`);
  const leftDirs = existsSync(join(home, '.dreamcontext', 'shares')) ? readdirSync(join(home, '.dreamcontext', 'shares'), { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  check(leftDirs.length === 0, `K6: share dirs left: ${leftDirs.map((d) => d.name).join(', ')}`);
  check(serverCaff().length === 0, `K11: the server's caffeinate still held 70 s after the last close`);

  step('K12: shares list prints no secret');
  const third = await openAndReveal({ kind: 'board', vault: 'proj', slug: boardSlug }, 'board again');
  const listed = dc('shares', 'list');
  check(listed.ok && !/trycloudflare|\/k\//.test(listed.out) && (!third?.password || !listed.out.includes(third.password)), `shares list: ${listed.out.slice(-300)}`);

  step('K12: dreamcontext shares close <id> closes one');
  const closedByCli = dc('shares', 'close', third?.id ?? 'none');
  check(closedByCli.ok, `K12: shares close failed: ${closedByCli.out.slice(-300)}`);
  const afterCli = (await listShares()).find((x) => x.id === third?.id);
  check(!afterCli || afterCli.state === 'closing', `K12: after shares close the row is ${JSON.stringify(afterCli)}`);
  const thirdPage = await (await fetch(third.link, { headers: { accept: 'text/html' } })).text();
  check(/Bu paylaşım kapandı/.test(thirdPage), 'K12: the link closed from the CLI does not say "Bu paylaşım kapandı"');

  step('Owner 1: the app link without a password opens the app itself');
  const open4 = await openAndReveal({ kind: 'app', vault: 'proj', slug: 'funnel' }, 'app without password');
  check(!open4?.password, 'the app link without a password revealed a password');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(open4.link, { waitUntil: 'domcontentloaded' });
    const inApp = await page.getByText(/Kayıt: \d+/).waitFor({ timeout: 20_000 }).then(() => true, () => false);
    check(inApp && !(await page.locator('input[type=password]').count()), 'the app link without a password did not open the app directly');
    await page.screenshot({ path: join(SHOTS, 'guest-app-nopassword-phone.png') });
    await ctx.close();
  }

  step('K10: quitting dreamcontext kills every cloudflared (one open, one in its grace) within 5 s');
  check(cloudflareds().length >= 2, `K10: expected two cloudflared (open + grace), found ${cloudflareds().length}`);
  process.kill(-api.pid, 'SIGTERM');
  const t2 = Date.now();
  while (Date.now() - t2 < 5_000 && cloudflareds().length) await sleep(200);
  timings.k10QuitMs = Date.now() - t2;
  check(cloudflareds().length === 0, 'K10: cloudflared survived the quit by 5 s');
} catch (e) {
  findings.push(`crashed: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  killAll();
  for (const pid of cloudflareds()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

writeFileSync(join(SHOTS, 'report.json'), `${JSON.stringify({ findings, timings }, null, 1)}\n`);
for (const f of readdirSync(SHOTS).filter((n) => n.endsWith('.png'))) process.stdout.write(`screenshot: ${join(SHOTS, f)}\n`);
for (const f of findings) process.stdout.write(`FINDING: ${f}\n`);
process.stdout.write(`${findings.length === 0 ? 'CLEAN' : `${findings.length} finding(s)`}: read the screenshots yourself (${SHOTS})\n`);
process.exit(findings.length === 0 ? 0 : 1);
