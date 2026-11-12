#!/usr/bin/env node
/**
 * App sharing across two "Macs" on one Mac, with the BUILT CLI and server (dist/), nothing sent
 * to GitHub (app-paylasim-acik). Two fake HOMEs, A and B, each with its own API server, owner key
 * and signed-in login; one scratch brain whose team remote is a local bare repo both clone; a
 * LOCAL app host (DREAMCONTEXT_APPS_LOCAL_HOST: bare repos standing in for GitHub).
 *
 *   1. A makes a synthetic app ("Ekip Notları", `notes/` shared, `cache/` local), shares its data
 *      (the owner's Share click, owner key), the app writes a note, A syncs.
 *   2. A publishes it privately to B (the owner's Share click grant + `apps publish --go`).
 *   3. B accepts the invitation and installs it (the owner's clicks), runs it, restarts it.
 *   4. B says "Keep it local" first; A writes more notes; B syncs and gets none of them; B's app
 *      makes its own `notes/board.json` meanwhile.
 *   5. B approves late (Share): every note the team shared before comes to B's disk at once;
 *      B's own board.json differs from the team's, so both versions are kept and nothing is sent.
 *   6. Large data: A and B each push 15 MB; every sync goes through, A receives B's file, and
 *      A's app page shows the LARGE warning (screenshots at 390 and 1440 px).
 *   7. The page and the CLI of B while it kept the app local never claim it syncs (checked in 4).
 * `apps publish --fresh` needs the real GitHub repo states: unit level (tests/unit/apps-share.test.ts).
 *
 *   dreamcontext builder heavy -- node scripts/verify/app-share-two-macs.mjs
 * Fixtures are fictional. Exit 0 = every check held, 1 = findings.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scratchDir, shotsDir, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO, 'dist', 'index.js');
if (!existsSync(DIST)) { console.error('dist/index.js is missing: build first'); process.exit(78); }
const SHOTS = join(shotsDir(REPO, 'app-share-two-macs'), String(process.pid));
mkdirSync(SHOTS, { recursive: true });
const scratch = scratchDir(`dc-verify-two-macs-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
const hostDir = join(scratch, 'host');
const bare = join(scratch, 'team.git');
mkdirSync(hostDir, { recursive: true });

const MB = 1024 * 1024;
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_|CODEX_|GITHUB_TOKEN|GH_TOKEN)/.test(k)));
const ID = { GIT_AUTHOR_NAME: 'Ornek Yazar', GIT_AUTHOR_EMAIL: 'yazar@example.com', GIT_COMMITTER_NAME: 'Ornek Yazar', GIT_COMMITTER_EMAIL: 'yazar@example.com' };
const findings = [];
const log = [];
const say = (s) => { log.push(s); process.stdout.write(`${s}\n`); };
const check = (ok, what) => { if (!ok) findings.push(what); say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); return ok; };
const freePort = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

/** One fake Mac: its HOME, project folder, login, owner key and API server. */
function mac(name, login) {
  const home = join(scratch, `home-${name}`);
  const proj = join(scratch, `proj-${name}`);
  const bin = join(home, '.local', 'bin');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const env = {
    ...clean, ...ID, HOME: home, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null',
    DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0', DREAMCONTEXT_APPS_LOCAL_HOST: hostDir,
    DREAMCONTEXT_APPS_LOCAL_LOGIN: login, GITHUB_TOKEN: 'two-macs-dummy-token',
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
  if (m.api) await stopApi(m);
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
async function stopApi(m) {
  if (!m.api) return;
  try { process.kill(-m.api.pid, 'SIGTERM'); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 1500));
  m.api = null;
}
/**
 * A request as the owner's page makes it: the owner key, the page's own origin and a same-origin
 * fetch (what a click in the app sends). `owner: false` = as an agent or a script. Plain node:http,
 * so no header is dropped.
 */
function api(m, path, { method = 'GET', body, owner = true } = {}) {
  const origin = `http://127.0.0.1:${m.port}`;
  const data = body !== undefined ? JSON.stringify(body) : null;
  const headers = { 'content-type': 'application/json', 'x-dreamcontext-vault': 'proj', host: `127.0.0.1:${m.port}`, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    ...(owner ? { 'x-dreamcontext-owner-key': m.key, origin, 'sec-fetch-site': 'same-origin' } : {}) };
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
const dataDir = (m) => join(m.proj, '_dream_context', 'apps', 'notlar');
/** Write a file as the app would, settled (mtime a minute back: past the 3 s "writing" window). */
function appWrites(m, rel, data) {
  const abs = join(dataDir(m), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  const t = new Date(Date.now() - 60_000);
  utimesSync(abs, t, t);
}
const onDisk = (m) => { try { return readdirSync(join(dataDir(m), 'notes')).sort(); } catch { return []; } };
const remoteHas = (rel) => { try { return execFileSync('git', ['--git-dir', bare, 'show', `main:_dream_context/apps/notlar/${rel}`], { encoding: 'utf-8' }); } catch { return null; } };
const appData = async (m) => ((await api(m, '/apps')).body.apps ?? []).find((x) => x.slug === 'notlar')?.data ?? null;

const killAll = () => { for (const m of [A, B]) { try { if (m.api) process.kill(-m.api.pid, 'SIGTERM'); } catch { /* gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { killAll(); process.exit(1); });

let browser;
try {
  // ─── the team brain: A's project pushed to a bare remote, B a clone ──────────────
  say('== setup: one brain, two Macs');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  mkdirSync(join(A.proj, '_dream_context', 'knowledge'), { recursive: true });
  mkdirSync(join(A.proj, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(A.proj, '_dream_context', 'knowledge', 'ekip.md'), '# Ekip\n\nOrtak not defteri.\n');
  writeFileSync(join(A.proj, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'full-repo', enabled: true, autoSync: false } }));
  git(A, A.proj, 'init', '-q', '-b', 'main');
  git(A, A.proj, 'add', '-A');
  git(A, A.proj, 'commit', '-qm', 'brain');
  git(A, A.proj, 'remote', 'add', 'origin', bare);
  git(A, A.proj, 'push', '-q', 'origin', 'main');
  check(dc(A, 'vaults', 'add', 'proj', A.proj).ok, 'A: the project is registered');
  await startApi(A);

  // ─── 1. A makes the app and shares its data ─────────────────────────────────────
  say('== 1. A: a synthetic app, its data shared, a first note');
  const made = dc(A, 'apps', 'new', 'notlar', '--name', 'Ekip Notları');
  check(made.ok, `A: apps new notlar (${made.out.split('\n').pop()})`);
  const code = join(`${A.proj}-apps`, 'notlar');
  const man = JSON.parse(readFileSync(join(code, 'dreamcontext-app.json'), 'utf-8'));
  man.data = {
    shared: [{ path: 'notes/', why: "The team's hand-written notes, one file per note" }],
    local: [{ path: 'visits.json', why: 'A visit counter this Mac makes again on its own' }, { path: 'cache/', why: 'Re-fetchable lookups' }],
  };
  man.actions.push({ id: 'notes', title: 'List the notes', method: 'GET', path: '/api/notes', does: 'Lists the notes in the data folder.', output: '{notes}', topics: ['notes'] });
  writeFileSync(join(code, 'dreamcontext-app.json'), JSON.stringify(man, null, 2));
  const srv = readFileSync(join(code, 'server.mjs'), 'utf-8')
    .replace("  'GET /api/hello': async (_req, res) => {", "  'GET /api/notes': async (_req, res) => {\n    let names = [];\n    try { names = (await (await import('node:fs/promises')).readdir(join(DATA, 'notes'))).sort(); } catch { /* none yet */ }\n    json(res, 200, { notes: names });\n  },\n  'GET /api/hello': async (_req, res) => {")
    .replace("dc.actions(['hello']);", "dc.actions(['hello', 'notes']);");
  writeFileSync(join(code, 'server.mjs'), srv);
  git(A, code, 'add', '-A');
  git(A, code, 'commit', '-qm', 'notes');
  const shareA = await api(A, '/apps/notlar/data-share', { method: 'POST', body: { approve: ['notes/'] } });
  check(shareA.status === 200 && shareA.body.data?.mode === 'shared', `A: the owner's Share click → ${shareA.status} mode ${shareA.body.data?.mode}`);
  const agentTry = await api(A, '/apps/notlar/data-share', { method: 'POST', body: { approve: ['notes/'] }, owner: false });
  check(agentTry.status === 403, `A: the same click without the owner key → ${agentTry.status}`);
  appWrites(A, 'notes/n1.json', JSON.stringify({ id: 'n1', text: 'Pazartesi toplantısı 10:00' }));
  appWrites(A, 'visits.json', '{"n":3}');
  const s1 = dc(A, 'brain', 'sync');
  check(s1.ok && remoteHas('notes/n1.json') !== null, `A: brain sync → the note is in the team (${s1.out.split('\n').pop()})`);
  check(remoteHas('visits.json') === null, 'A: the local visits.json never went');

  // ─── 2. A publishes the app privately to B ──────────────────────────────────────
  say('== 2. A: publish the app to B (private)');
  const grant = await api(A, '/apps/notlar/publish/grant', { method: 'POST', body: {} });
  check(grant.status === 200 && !!grant.body.grant, `A: the Share click opened a grant (${grant.status})`);
  const pub = dc(A, 'apps', 'publish', 'notlar', '--go', '--grant', String(grant.body.grant), '--invite', B.login, '--note', 'İlk sürüm');
  check(pub.ok, `A: apps publish --go → ${pub.out.split('\n').filter(Boolean).pop()}`);

  // ─── 3. B clones the brain, installs the app, runs and restarts it ──────────────
  say('== 3. B: clone the brain, accept, install, run, restart');
  execFileSync('git', ['clone', '-q', bare, B.proj], { env: B.env });
  check(dc(B, 'vaults', 'add', 'proj', B.proj).ok, 'B: the project is registered');
  await startApi(B);
  const shared = await api(B, '/apps/shared?refresh=1');
  const inv = (shared.body.invitations ?? [])[0];
  check(!!inv, `B: the invitation is there (${(shared.body.invitations ?? []).length})`);
  if (inv) check((await api(B, '/apps/shared/accept', { method: 'POST', body: { id: inv.id } })).status === 200, 'B: accepted');
  const repo = (inv?.fullName ?? inv?.repo ?? `${A.login}/notlar-app`);
  const prev = await api(B, '/apps/install/preview', { method: 'POST', body: { ref: repo } });
  check(prev.status === 200 && !!prev.body.previewId, `B: install preview of ${repo} → ${prev.status}`);
  const inst = await api(B, '/apps/install', { method: 'POST', body: { previewId: prev.body.previewId, sha: prev.body.sha } });
  check(inst.status === 200 && inst.body.slug === 'notlar', `B: installed → ${inst.status} ${inst.body.slug ?? JSON.stringify(inst.body).slice(0, 160)}`);
  const ranB = await api(B, '/apps/notlar/call', { method: 'POST', body: { method: 'GET', path: '/api/notes' } });
  check(ranB.status === 200, `B: the app runs (GET /api/notes → ${ranB.status} ${JSON.stringify(ranB.body).slice(0, 120)})`);
  const dB0 = await appData(B);
  say(`B: the app's data before B decides: mode ${dB0?.mode}, pending ${JSON.stringify((dB0?.pendingPaths ?? []).map((p) => p.path))}`);
  await startApi(B); // a restart of B's server: the app comes up again
  const ranB2 = await api(B, '/apps/notlar/call', { method: 'POST', body: { method: 'GET', path: '/api/notes' } });
  check(ranB2.status === 200, `B: after a restart the app runs again (${ranB2.status})`);

  // ─── 4. B keeps it local first; the team keeps writing ──────────────────────────
  say('== 4. B: "Keep it local" first; A writes more; B syncs');
  const decline = await api(B, '/apps/notlar/data-share', { method: 'POST', body: { decline: true } });
  check(decline.status === 200 && decline.body.data?.mode === 'local', `B: Keep it local → mode ${decline.body.data?.mode}`);
  appWrites(A, 'notes/n2.json', JSON.stringify({ id: 'n2', text: 'Rakip analizi taslağı' }));
  appWrites(A, 'notes/board.json', JSON.stringify({ columns: ['team'] }));
  check(dc(A, 'brain', 'sync').ok, 'A: brain sync (n2, board.json)');
  const sB1 = dc(B, 'brain', 'sync');
  check(sB1.ok, `B: brain sync while local (${sB1.out.split('\n').pop()})`);
  // n1 came with B's clone (it was in the brain before B decided); n2 and board.json came after the decline.
  check(!onDisk(B).includes('n2.json') && !onDisk(B).includes('board.json'), `B: the team's later notes stay off B's disk while local (${JSON.stringify(onDisk(B))})`);
  appWrites(B, 'notes/board.json', JSON.stringify({ columns: ['mine'] }));
  const dB1 = await appData(B);
  check(dB1?.mode === 'local' && dB1?.large === false, `B: the page says local and never "it all syncs" (mode ${dB1?.mode}, large ${dB1?.large})`);

  // ─── 5. B approves late ─────────────────────────────────────────────────────────
  say('== 5. B: Share later: the team\'s earlier notes arrive; B\'s own board.json is kept as two versions');
  const late = await api(B, '/apps/notlar/data-share', { method: 'POST', body: { decline: false, approve: ['notes/'] } });
  check(late.status === 200 && late.body.data?.mode === 'shared', `B: Share → mode ${late.body.data?.mode}, restored ${late.body.restored}`);
  check(JSON.stringify(onDisk(B)) === JSON.stringify(['board.json', 'n1.json', 'n2.json']), `B: n1 and n2 are on B's disk now (${JSON.stringify(onDisk(B))})`);
  const sB2 = dc(B, 'brain', 'sync');
  check(sB2.ok, `B: brain sync after the late yes (${sB2.out.split('\n').filter(Boolean).slice(-2).join(' | ')})`);
  check(JSON.parse(remoteHas('notes/board.json') ?? '{}').columns?.[0] === 'team', "B: the team's board.json is untouched in the team");
  check(JSON.parse(readFileSync(join(dataDir(B), 'notes', 'board.json'), 'utf-8')).columns[0] === 'mine', "B: B's own board.json is still on B's disk");
  const dB2 = await appData(B);
  check(dB2?.conflicts === 1, `B: the page counts 1 file with two versions (${dB2?.conflicts})`);
  const cliB = dc(B, 'apps', 'data', 'notlar');
  say(`B: apps data notlar →\n${cliB.out.split('\n').map((l) => `    ${l}`).join('\n')}`);
  const ranB3 = await api(B, '/apps/notlar/call', { method: 'POST', body: { method: 'GET', path: '/api/notes' } });
  const notesOf = (r) => { try { return JSON.parse(r.body.body ?? '{}').notes ?? []; } catch { return []; } }; // /call answers the app's body as text
  check(notesOf(ranB3).includes('n2.json'), `B: the app itself reads the team's notes (${JSON.stringify(ranB3.body).slice(0, 160)})`);

  // ─── 6. Large data from both sides ──────────────────────────────────────────────
  say('== 6. A and B each push 15 MB: everything syncs, the page warns');
  appWrites(A, 'notes/big-a.bin', Buffer.alloc(15 * MB, 1));
  check(dc(A, 'brain', 'sync').ok, 'A: brain sync with 15 MB');
  appWrites(B, 'notes/big-b.bin', Buffer.alloc(15 * MB, 2));
  const sB3 = dc(B, 'brain', 'sync');
  check(sB3.ok, `B: brain sync with 15 more MB (${sB3.out.split('\n').filter(Boolean).slice(-1)[0]})`);
  check(/large \(\d+\.\d MB for the team\)/.test(sB3.out), 'B: the sync output says the app\'s team data is large');
  const sA3 = dc(A, 'brain', 'sync');
  check(sA3.ok, `A: brain sync pulls B's 15 MB (${sA3.out.split('\n').filter(Boolean).slice(-1)[0]})`);
  check(existsSync(join(dataDir(A), 'notes', 'big-b.bin')) && statSync(join(dataDir(A), 'notes', 'big-b.bin')).size === 15 * MB, "A: B's 15 MB file is on A's disk, whole");
  const inTeam = (rel) => spawnSync('git', ['--git-dir', bare, 'cat-file', '-e', `main:_dream_context/apps/notlar/${rel}`]).status === 0; // a 15 MB blob: existence only
  check(inTeam('notes/big-a.bin') && inTeam('notes/big-b.bin'), 'the team holds both large files');
  const dA = await appData(A);
  check(dA?.mode === 'shared' && dA?.large === true && dA?.teamBytes > 25 * MB, `A: the app data says LARGE (teamBytes ${Math.round((dA?.teamBytes ?? 0) / MB)} MB)`);

  // ─── the owner's view: A's app page at 390 and 1440 px ──────────────────────────
  say('== screenshots: A\'s app page with the LARGE line');
  browser = await chromium.launch();
  const base = `http://127.0.0.1:${A.port}`;
  const SHELL = `window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'owner_key' ? ${JSON.stringify(A.key)} : null), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 } });
    await markAnnouncementsSeen(context, base);
    await context.addInitScript(SHELL);
    const page = await context.newPage();
    page.on('pageerror', (e) => findings.push(`page@${width} crash: ${String(e.message).slice(0, 200)}`));
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    if (width <= 600) {
      await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 }).catch(() => {});
      await page.getByText('Apps', { exact: true }).first().click({ timeout: 10_000 }).catch(() => {});
    } else {
      await page.locator('[aria-label="Apps"]').first().click({ timeout: 10_000 }).catch(() => {});
    }
    await page.waitForTimeout(1500);
    await page.locator('.app-tile').filter({ hasText: 'Ekip Notları' }).first().locator('.app-tile__open').click({ timeout: 10_000 }).catch((e) => findings.push(`page@${width}: the app tile did not open (${e.message.slice(0, 80)})`));
    await page.waitForTimeout(1200);
    const large = page.getByTestId('app-data-large').first();
    const seen = await large.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false);
    check(seen, `page@${width}: the LARGE line is on A's app page${seen ? `: "${(await large.innerText()).slice(0, 140)}"` : ''}`);
    if (seen) await large.scrollIntoViewIfNeeded();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `page@${width}: no sideways overflow (${over}px)`);
    const file = join(SHOTS, `app-page-large-${width}.png`);
    await page.screenshot({ path: file });
    say(`screenshot: ${file}`);
    await context.close();
  }
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' ') : err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  killAll();
}
writeFileSync(join(SHOTS, 'walk.log'), `${log.join('\n')}\n\nfindings:\n${findings.join('\n') || 'none'}\n`);
say(`\nwalk log: ${join(SHOTS, 'walk.log')}`);
say(findings.length ? `FINDINGS (${findings.length}):\n- ${findings.join('\n- ')}` : 'every check held');
process.exit(findings.length ? 1 : 0);
