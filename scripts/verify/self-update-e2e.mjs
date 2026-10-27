#!/usr/bin/env node
/**
 * The desktop self-update, end to end, under a scratch HOME — no Claude message, no manual
 * `dreamcontext upgrade`.
 *
 *   npm run build && node scripts/verify/self-update-e2e.mjs
 *
 * What it builds:
 *   - a LOCAL npm registry (127.0.0.1) that publishes this build twice: as 0.35.0 and, repacked
 *     with only the version changed, as 0.35.1 (`latest`). Everything else is proxied to
 *     registry.npmjs.org;
 *   - a scratch npm PREFIX with dreamcontext@0.35.0 installed from it (the "global CLI" the app
 *     runs — deliberately NOT the prefix of the npm on PATH, so a plain `npm install -g` would
 *     land in the wrong place);
 *   - a scratch HOME with two registered, initialised projects.
 *
 * Then it starts the real app-mode server from that prefix the way the Tauri shell does
 * (`dashboard --launcher`, DREAMCONTEXT_DESKTOP=1, DREAMCONTEXT_PARENT_PID = this process,
 * DREAMCONTEXT_GLOBAL_CLI = the prefix's bin), with the first self-update tick at 2 s, and
 * waits. It passes when, on its own: the prefix moved to 0.35.1, both projects were refreshed
 * by the new CLI (setupVersion 0.35.1), ~/.dreamcontext/self-update.json says updated
 * 0.35.0 → 0.35.1, the log has the run, the lock is gone, GET /api/health reports
 * upgradeReady 0.35.1 (the relaunch banner's signal), and the developer's own global
 * dreamcontext is untouched.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dc-verify-self-update-e2e');
const HOME = join(SCRATCH, 'home');
const PREFIX = join(SCRATCH, 'prefix');
const PACKS = join(SCRATCH, 'packs');
const CACHE = join(SCRATCH, 'npm-cache');
const PROJECTS = [join(SCRATCH, 'alpha'), join(SCRATCH, 'beta')];
const OLD = '0.35.0';
const NEW = '0.35.1';
const NODE_DIR = dirname(process.execPath);
const BASE_PATH = [NODE_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

let pass = 0;
let fail = 0;
function check(label, ok, ev) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stderr || r.stdout}`);
  return r.stdout;
}
/** Async: the local registry lives in THIS process, so a blocking spawnSync would starve it. */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed (${code}):\n${out.slice(-3000)}`))));
  });
}
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Two tarballs of this build: OLD and NEW ─────────────────────────────────

function packTwice() {
  mkdirSync(PACKS, { recursive: true });
  const out = run('npm', ['pack', '--pack-destination', PACKS, '--silent'], { cwd: REPO, env: { ...process.env, npm_config_cache: CACHE } }).trim().split('\n').pop();
  const packed = join(PACKS, out);
  const versions = {};
  for (const v of [OLD, NEW]) {
    const dir = join(PACKS, `x-${v}`);
    mkdirSync(dir, { recursive: true });
    run('tar', ['xzf', packed, '-C', dir]);
    const pj = join(dir, 'package', 'package.json');
    const pkg = JSON.parse(readFileSync(pj, 'utf-8'));
    pkg.version = v;
    writeFileSync(pj, JSON.stringify(pkg, null, 2));
    const sw = join(dir, 'package', 'npm-shrinkwrap.json');
    if (existsSync(sw)) {
      const s = JSON.parse(readFileSync(sw, 'utf-8'));
      s.version = v;
      if (s.packages?.['']) s.packages[''].version = v;
      writeFileSync(sw, JSON.stringify(s, null, 2));
    }
    const tgz = join(PACKS, `dreamcontext-${v}.tgz`);
    run('tar', ['czf', tgz, '-C', dir, 'package']);
    const bytes = readFileSync(tgz);
    versions[v] = { pkg, bytes, shasum: createHash('sha1').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  }
  return versions;
}

// ─── A local registry: dreamcontext from here, everything else proxied ───────

function startRegistry(versions, port) {
  const base = `http://127.0.0.1:${port}`;
  const packument = () => ({
    name: 'dreamcontext',
    'dist-tags': { latest: NEW },
    versions: Object.fromEntries(Object.entries(versions).map(([v, x]) => [v, {
      ...x.pkg, _id: `dreamcontext@${v}`,
      dist: { tarball: `${base}/dreamcontext/-/dreamcontext-${v}.tgz`, shasum: x.shasum, integrity: x.integrity },
    }])),
  });
  const hits = [];
  const server = createHttpServer(async (req, res) => {
    const url = req.url ?? '/';
    hits.push(`${req.method} ${url}`);
    if (url === '/dreamcontext') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(packument()));
      return;
    }
    const m = url.match(/^\/dreamcontext\/-\/dreamcontext-(.+)\.tgz$/);
    if (m && versions[m[1]]) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(versions[m[1]].bytes);
      return;
    }
    try {
      const up = await fetch(`https://registry.npmjs.org${url}`, { headers: { accept: req.headers.accept ?? 'application/json' } });
      const body = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(502);
      res.end(String(err));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, base, hits })));
}

// ─── Scratch machine ─────────────────────────────────────────────────────────

function npmEnv(registry) {
  return {
    ...process.env,
    HOME,
    PATH: BASE_PATH,
    npm_config_registry: registry,
    npm_config_cache: CACHE,
    npm_config_omit: 'optional',
    // The shrinkwrap pins every dependency to registry.npmjs.org; keep those as they are instead
    // of rewriting them onto this plain-http registry.
    npm_config_replace_registry_host: 'never',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function realGlobalVersion() {
  // The developer's own global install, read before the registry starts and after it stops.
  const r = spawnSync('npm', ['ls', '-g', 'dreamcontext', '--depth=0', '--json'], { encoding: 'utf-8' });
  try { return JSON.parse(r.stdout).dependencies?.dreamcontext?.version ?? null; } catch { return null; }
}

function setupVersion(project) {
  try { return JSON.parse(readFileSync(join(project, '_dream_context', 'state', '.config.json'), 'utf-8')).setupVersion ?? null; } catch { return null; }
}

async function main() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  const realBefore = realGlobalVersion();
  console.log(`packing this build as ${OLD} and ${NEW}…`);
  const versions = packTwice();
  const reg = await startRegistry(versions, await freePort());
  const env = npmEnv(reg.base);

  console.log(`installing dreamcontext@${OLD} into the scratch prefix…`);
  await runAsync('npm', ['install', '-g', '--prefix', PREFIX, `dreamcontext@${OLD}`], { env, cwd: SCRATCH });
  const bin = join(PREFIX, 'bin', 'dreamcontext');
  const pkgJson = join(PREFIX, 'lib', 'node_modules', 'dreamcontext', 'package.json');
  const prefixVersion = () => JSON.parse(readFileSync(pkgJson, 'utf-8')).version;
  check(`the scratch prefix starts on ${OLD}`, prefixVersion() === OLD, prefixVersion());

  for (const p of PROJECTS) {
    mkdirSync(p, { recursive: true });
    run('git', ['init', '-q'], { cwd: p });
    await runAsync(process.execPath, [bin, 'init', '--yes', '--name', p.split('/').pop(), '--platforms', 'claude'], { cwd: p, env });
    // `update` refuses a project with no installed platform: install Claude's like a real one has.
    await runAsync(process.execPath, [bin, 'install-skill', '--platforms', 'claude'], { cwd: p, env });
    await runAsync(process.execPath, [bin, 'vaults', 'add', p.split('/').pop(), p], { cwd: p, env });
  }
  check(`both projects start on setupVersion ${OLD}`, PROJECTS.every((p) => setupVersion(p) === OLD), PROJECTS.map(setupVersion).join(', '));

  const port = await freePort();
  console.log(`starting the app-mode server from the prefix on :${port} (first self-update tick in 2 s)…`);
  const srv = spawn(process.execPath, [bin, 'dashboard', '--port', String(port), '--no-open', '--launcher'], {
    cwd: HOME,
    env: {
      ...env,
      SHELL: '/bin/zsh',
      DREAMCONTEXT_DESKTOP: '1',
      DREAMCONTEXT_PARENT_PID: String(process.pid),
      DREAMCONTEXT_GLOBAL_CLI: bin,
      DREAMCONTEXT_SELF_UPDATE_FIRST_TICK_MS: '2000',
      DREAMCONTEXT_ORPHAN_SWEEP: '0',
      DREAMCONTEXT_CLAUDE_AUTOUPDATE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  srv.stdout.on('data', (c) => { serverOut += c; });
  srv.stderr.on('data', (c) => { serverOut += c; });
  const stateFile = join(HOME, '.dreamcontext', 'self-update.json');
  const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf-8')); } catch { return null; } };
  try {
    const deadline = Date.now() + 8 * 60_000;
    let state = null;
    while (Date.now() < deadline) {
      state = readState();
      if (state && (state.state === 'updated' || state.state === 'failed' || state.state === 'unknown')) break;
      await sleep(1000);
    }
    console.log(`\nself-update.json: ${JSON.stringify(state)}`);
    check(`the record says updated ${OLD} → ${NEW}`, state?.state === 'updated' && state.from === OLD && state.to === NEW, JSON.stringify(state));
    check(`the scratch prefix is on ${NEW}`, prefixVersion() === NEW, prefixVersion());
    check(`both projects were refreshed by the new CLI (setupVersion ${NEW})`, PROJECTS.every((p) => setupVersion(p) === NEW), PROJECTS.map(setupVersion).join(', '));
    const log = existsSync(join(HOME, '.dreamcontext', 'logs', 'self-update.log')) ? readFileSync(join(HOME, '.dreamcontext', 'logs', 'self-update.log'), 'utf-8') : '';
    console.log(`self-update.log:\n${log.trim().split('\n').map((l) => `    ${l}`).join('\n')}`);
    check('the log has the run', log.includes(`updating: ${OLD} → ${NEW}`) && log.includes(`updated: ${OLD} → ${NEW}`));
    check('the lock is released', !existsSync(join(HOME, '.dreamcontext', 'self-update.lock')));
    check('the latest version was asked of the local registry', reg.hits.includes('GET /dreamcontext'), reg.hits.slice(0, 5).join(' | '));

    let ready = null;
    const readyBy = Date.now() + 45_000;
    while (Date.now() < readyBy) {
      try { ready = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).upgradeReady; } catch { /* not up */ }
      if (ready) break;
      await sleep(2000);
    }
    check(`GET /api/health reports upgradeReady ${NEW} (the relaunch banner's signal)`, ready === NEW, String(ready));
    const view = await (await fetch(`http://127.0.0.1:${port}/api/launcher/self-update`)).json();
    check('Settings reads the same record', view.enabled === true && view.record?.state === 'updated', JSON.stringify(view));
  } finally {
    srv.kill('SIGTERM');
    reg.server.close();
    await sleep(500);
  }
  check('the developer\'s own global dreamcontext is untouched', realGlobalVersion() === realBefore, `${realBefore} → ${realGlobalVersion()}`);
  if (fail) console.log(`\nserver output tail:\n${serverOut.slice(-4000)}`);
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
