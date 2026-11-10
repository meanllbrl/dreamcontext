#!/usr/bin/env node
/**
 * app-veri-ortak, criterion 13: an app's hand-made data (emekle üretilmiş veri) is shared with the
 * teammates of one brain; the re-fetchable cache stays on each Mac.
 *
 *   node scripts/verify/verify-app-data-share.mjs
 *
 * WHAT IT DRIVES: the CLI and a real dashboard server per machine, both FROM SOURCE (tsx, no build),
 * two scratch projects with fake HOMEs, one local bare remote, `full-repo` with cloud sync on, real
 * git. No tokens are spent (a local-path remote never asks for one). Each server gets an owner key
 * on stdin, as the desktop shell gives it, so the approval goes through the real owner-only route.
 * Fixtures are fictional: a project called "Kite Ads" and a "rival" app (`favorites/` shared,
 * `cache/` local).
 *
 *   §1 A declares `favorites/` shared + `cache/` local, the owner approves, A syncs: the remote has
 *      favorites, never cache.
 *   §2 B pulls: favorites arrive, cache does not; B's Apps list shows the team's app (team-data).
 *   §3 B makes the same app (same slug), adds a favorite, deletes nothing, approves, syncs.
 *   §4 A pulls while its backend runs: the backend is paused for the pull (its log says so) and,
 *      called again, serves the new favorite.
 *   §5 A file B removed by hand from its disk is not deleted on A (absence is not a delete).
 *   Every step prints its output. Collect, don't fail fast; exit 1 on any FAIL.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = scratchDir(`dc-verify-app-data-share-${process.pid}`);
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const BARE = join(SCRATCH, 'remote.git');
const SLUG = 'rival';
const VAULT = 'kite';
const TSX = 'npx';
const TSX_ARGS = ['--yes', 'tsx'];
const ENTRY = join(REPO, 'src', 'cli', 'index.ts');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? `: ${detail}` : ''}`);
};
const step = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_|CODEX_)/.test(k)));
const machines = { A: { key: 'A', login: 'alice' }, B: { key: 'B', login: 'bob' } };
for (const m of Object.values(machines)) {
  m.home = join(SCRATCH, `home-${m.key}`);
  m.proj = join(SCRATCH, `kite-${m.key}`);
  m.dc = join(m.proj, '_dream_context');
  m.code = join(`${m.proj}-apps`, SLUG);
  m.data = join(m.dc, 'apps', SLUG);
  m.ownerKey = randomBytes(32).toString('base64url');
  const bin = join(m.home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'claude'), 0o755);
  m.env = {
    ...clean, HOME: m.home, PATH: `${bin}:${process.env.PATH}`, npm_config_cache: join(process.env.HOME ?? m.home, '.npm'), GITHUB_TOKEN: 'verify-dummy-token', DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: m.login, GIT_AUTHOR_EMAIL: `${m.login}@example.com`,
    GIT_COMMITTER_NAME: m.login, GIT_COMMITTER_EMAIL: `${m.login}@example.com`,
  };
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...clean, GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const cli = (m, ...args) => {
  const r = spawnSync(TSX, [...TSX_ARGS, ENTRY, ...args], { cwd: m.proj, env: m.env, encoding: 'utf-8', timeout: 180_000 });
  console.log(`$ [${m.key}] dreamcontext ${args.join(' ')}  (exit ${r.status})`);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (out) console.log(out.split('\n').slice(0, 40).map((l) => `    ${l}`).join('\n'));
  return { ...r, out };
};
const must = (label, r) => { if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status}): ${r.out.slice(-600)}`); return r; };
const remoteTree = () => git(BARE, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** mtime a minute back: past the "writing" window, so the next sync takes it. */
function put(abs, text) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  const t = new Date(Date.now() - 60_000);
  utimesSync(abs, t, t);
}

const MANIFEST_DATA = {
  shared: [{ path: 'favorites/', why: 'The ads, funnels and paywalls the team picked, with their notes' }],
  local: [{ path: 'cache/', why: 'Fetched again from the ad libraries with Refresh' }],
};
const SERVER = `import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.env.DC_DATA_DIR, 'favorites');
const started = Date.now();
const SECRET = process.env.DC_GATEWAY_SECRET || '';
http.createServer((req, res) => {
  // dcGuard: only the dreamcontext gateway may call this backend.
  if (SECRET === '' || req.headers['x-dc-gateway-secret'] !== SECRET) { res.statusCode = 401; res.end(); return; }
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url === '/favorites') {
    let names = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { /* none yet */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ started, favorites: names.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf-8'))) }));
    return;
  }
  res.statusCode = 404; res.end();
}).listen(Number(process.env.PORT), process.env.HOST);
`;

/** The fictional "rival" app, made the way an agent makes one (`apps new`), then its data declared. */
function makeApp(m) {
  must(`${m.key} apps new`, cli(m, 'apps', 'new', SLUG, '--name', 'Rival Watch'));
  const mf = join(m.code, 'dreamcontext-app.json');
  const manifest = JSON.parse(readFileSync(mf, 'utf-8'));
  manifest.backend = { command: 'node rival-server.mjs', health: '/health' };
  manifest.actions = [{ id: 'favorites', title: 'List the favorites', method: 'GET', path: '/favorites', does: 'Lists the team favorites.', output: '{started, favorites}', topics: ['favorites'] }];
  manifest.data = MANIFEST_DATA;
  writeFileSync(mf, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(m.code, 'rival-server.mjs'), SERVER);
  const v = cli(m, 'apps', 'validate', SLUG);
  check(`${m.key}: the manifest with its data field validates`, v.status === 0, v.out.split('\n').slice(-1)[0]);
}

const freePort = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

async function startServer(m) {
  const port = await freePort();
  const srv = spawn(TSX, [...TSX_ARGS, ENTRY, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: m.proj, env: { ...m.env, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  srv.stdin.write(`${m.ownerKey}\n`);
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  m.serverLog = () => log;
  for (let i = 0; i < 200; i++) {
    if (srv.exitCode != null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status < 500) {
        m.base = `http://127.0.0.1:${port}`;
        m.server = srv;
        // The CLI (apps call/logs) and the sync's pause find the desktop server through this file;
        // only the shell-owned server writes it itself, so stand in for the shell (as apps-share-trial does).
        writeFileSync(join(m.home, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: srv.pid, port, launchToken: 'x'.repeat(43), appBundleId: 'com.dreamcontext.verify' }), { mode: 0o600 });
        return;
      }
    } catch { /* not up */ }
    await wait(300);
  }
  try { process.kill(-srv.pid, 'SIGTERM'); } catch { /* gone */ }
  throw new Error(`dashboard server (${m.key}) did not come up: ${log.slice(-600)}`);
}

/** The owner's approval, as the Apps page sends it: same origin, the shell's owner key. */
async function approve(m, paths) {
  const r = await fetch(`${m.base}/api/apps/${SLUG}/data-share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: m.base, 'sec-fetch-site': 'same-origin', 'x-dreamcontext-owner-key': m.ownerKey, 'x-dreamcontext-vault': VAULT },
    body: JSON.stringify({ approve: paths }),
  });
  const body = await r.text();
  console.log(`    POST data-share ${JSON.stringify(paths)} → ${r.status} ${body.slice(0, 240)}`);
  return r.status;
}

async function appsList(m) {
  const r = await fetch(`${m.base}/api/apps`, { headers: { 'x-dreamcontext-vault': VAULT } });
  return r.json().catch(() => ({}));
}

/** The app's own backend, the way an agent reads it (`apps call`, which starts it under a lease). */
function favoritesOf(m) {
  const r = cli(m, 'apps', 'call', SLUG, 'GET', '/favorites');
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)); } catch { return null; }
}

function writeConfig(m) {
  mkdirSync(join(m.dc, 'state'), { recursive: true });
  writeFileSync(join(m.dc, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'full-repo', enabled: true, autoSync: false } }));
}

function setup() {
  git(SCRATCH, 'init', '-q', '--bare', '--initial-branch=main', BARE);
  const { A } = machines;
  mkdirSync(join(A.home, '.dreamcontext'), { recursive: true });
  for (const d of [join(A.dc, 'state'), join(A.dc, 'knowledge')]) mkdirSync(d, { recursive: true });
  git(A.proj, 'init', '-q', '--initial-branch=main');
  git(A.proj, 'remote', 'add', 'origin', BARE);
  writeConfig(A);
  writeFileSync(join(A.dc, 'knowledge', 'ads.md'), '# Kite Ads\n\nWhat the team learned about rival ads.\n');
  must('A vaults add', cli(A, 'vaults', 'add', VAULT, A.proj));
  must('A first push', cli(A, 'brain', 'sync'));
}

async function main() {
  const { A, B } = machines;
  try {
    step('setup: Kite Ads on A, pushed');
    setup();

    step('§1 A: the rival app declares favorites/ shared and cache/ local; the owner approves; A syncs');
    makeApp(A);
    await startServer(A);
    put(join(A.data, 'favorites', 'fb-001.json'), JSON.stringify({ id: 'fb-001', note: 'try this hook' }));
    put(join(A.data, 'favorites', 'tt-002.json'), JSON.stringify({ id: 'tt-002', note: 'strong paywall' }));
    put(join(A.data, 'cache', 'ads.json'), JSON.stringify({ fetched: 168 }));
    const d0 = cli(A, 'apps', 'data', SLUG);
    check('apps data names both declarations', /favorites\//.test(d0.out) && /cache\//.test(d0.out));
    must('A sync before approval', cli(A, 'brain', 'sync'));
    check('nothing of the app reaches the remote before the owner approves', !remoteTree().some((p) => p.includes(`/apps/${SLUG}/`)));
    check('owner approval answers 200', (await approve(A, ['favorites/'])) === 200);
    const agentTry = await fetch(`${A.base}/api/apps/${SLUG}/data-share`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': VAULT }, body: JSON.stringify({ approve: ['cache/'] }) });
    check('an agent or script cannot approve (no owner key)', agentTry.status === 403, `→ ${agentTry.status}`);
    must('A sync', cli(A, 'brain', 'sync'));
    const t1 = remoteTree();
    check('remote has favorites', t1.includes(`_dream_context/apps/${SLUG}/favorites/fb-001.json`), t1.filter((p) => p.includes('/apps/')).join(', '));
    check('remote never has cache', !t1.some((p) => p.includes(`/apps/${SLUG}/cache/`)));
    const before = favoritesOf(A);
    console.log(`    A favorites (backend running): ${JSON.stringify(before)}`);
    check('A backend serves its two favorites', before?.favorites?.length === 2);

    step('§2 B clones and pulls: favorites arrive, cache does not; the Apps list shows the team\'s app');
    mkdirSync(join(B.home, '.dreamcontext'), { recursive: true });
    git(SCRATCH, 'clone', '-q', '--branch', 'main', BARE, B.proj);
    if (!existsSync(join(B.dc, 'state', '.config.json'))) writeConfig(B);
    must('B vaults add', cli(B, 'vaults', 'add', VAULT, B.proj));
    must('B pull', cli(B, 'brain', 'sync', '--pull-only'));
    check('B has the favorites', existsSync(join(B.data, 'favorites', 'fb-001.json')));
    check('B has no cache', !existsSync(join(B.data, 'cache')));
    await startServer(B);
    const listB = await appsList(B);
    const team = (listB.others ?? []).find((o) => o.slug === SLUG);
    console.log(`    GET /api/apps (B) others → ${JSON.stringify(listB.others ?? null).slice(0, 300)}`);
    check('B sees the team\'s app (kind team-data)', team?.kind === 'team-data', JSON.stringify(team ?? null));

    step('§3 B makes the same app (same slug), adds a favorite, removes one only from its disk, approves, syncs');
    makeApp(B);
    check('B kept the team data when its app took the slug', existsSync(join(B.data, 'favorites', 'fb-001.json')));
    put(join(B.data, 'favorites', 'meta-003.json'), JSON.stringify({ id: 'meta-003', note: 'bob: the funnel to copy' }));
    rmSync(join(B.data, 'favorites', 'tt-002.json')); // absence on B: never a delete (§5)
    check('B approval answers 200', (await approve(B, ['favorites/'])) === 200);
    must('B sync', cli(B, 'brain', 'sync'));
    const t3 = remoteTree();
    check('remote has B\'s favorite', t3.includes(`_dream_context/apps/${SLUG}/favorites/meta-003.json`));
    check('remote still has tt-002 (B\'s missing file is not a delete)', t3.includes(`_dream_context/apps/${SLUG}/favorites/tt-002.json`));

    step('§4 A pulls while its backend runs: paused for the pull, then serves the new favorite');
    favoritesOf(A); // keep the backend up under a fresh lease
    must('A sync', cli(A, 'brain', 'sync'));
    const logs = cli(A, 'apps', 'logs', SLUG);
    check('A\'s backend was paused for the team sync', /paused for a team sync: backend stopped/.test(logs.out), (logs.out.match(/paused for a team sync[^\n]*/) ?? [''])[0]);
    const after = favoritesOf(A);
    console.log(`    A favorites after: ${JSON.stringify(after)}`);
    check('A has B\'s favorite on disk', existsSync(join(A.data, 'favorites', 'meta-003.json')));
    check('A\'s backend serves the new favorite', !!after?.favorites?.some((f) => f.id === 'meta-003'));
    const pullDir = join(A.home, '.dreamcontext', 'apps', 'pull');
    const left = existsSync(pullDir) ? readdirSync(pullDir).filter((n) => n.endsWith('.json')) : [];
    check('A\'s pull record is gone', left.length === 0, left.join(', '));

    step('§5 absence is not a delete; the cache stays where it was made');
    check('A still has tt-002', existsSync(join(A.data, 'favorites', 'tt-002.json')));
    check('A\'s cache is untouched', readFileSync(join(A.data, 'cache', 'ads.json'), 'utf-8').includes('168'));
    check('remote never has cache', !remoteTree().some((p) => p.includes(`/apps/${SLUG}/cache/`)));
  } catch (e) {
    check('run completed', false, e.message);
    for (const m of Object.values(machines)) if (m.serverLog) console.log(`    [${m.key} server log tail] ${m.serverLog().slice(-800)}`);
  } finally {
    for (const m of Object.values(machines)) try { if (m.server) process.kill(-m.server.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (!failed.length) rmSync(SCRATCH, { recursive: true, force: true });
  else console.log(`scratch kept: ${SCRATCH}`);
  process.exit(failed.length ? 1 : 0);
}

main();
