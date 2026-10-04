// dreamcontext hands-free ROOT supervisor. Started detached by entrypoint.sh at every container
// start; copied verbatim into <owner>/dreamcontext-handsfree/.devcontainer/supervisor.mjs.
//
//  - binds 0.0.0.0:8080 ONCE and hands the listening fd to every server instance, so the port
//    is never free for dcuser to grab across a restart (W0 item 4);
//  - kills every dcuser process before each (re)start;
//  - restarts the server on ANY exit, with backoff;
//  - exit code 75 (POST runtime): installs the tarball dcserver spooled into
//    /opt/dreamcontext.next (`npm i --ignore-scripts --omit=optional`), renames it into place,
//    keeps the last good build (also as a tarball on /workspaces, so a rebuild that wiped /opt
//    reinstalls the same build), falls back to it when health fails, and writes the build
//    fingerprint of the installed files to a root-owned file;
//  - bind-mounts the mirror (/workspaces/dc-home) on the laptop's HOME once a trip names it
//    (dcserver asks through $PUB/mirror-request), and again at every start.
// Node builtins only.
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRV = '/workspaces/dc-server';
const PUB = '/workspaces/dc-server-pub';
const HM = '/workspaces/dc-home';
const RUNTIME = '/workspaces/dc-runtime';
const OPT = '/opt/dreamcontext';
const OPT_NEXT = '/opt/dreamcontext.next';
const OPT_PREV = '/opt/dreamcontext.prev';
const PKG = (prefix) => join(prefix, 'node_modules', 'dreamcontext');
const ENTRY = join(PKG(OPT), 'dist', 'index.js');
const FINGERPRINT_FILE = '/opt/dc-hf/fingerprint';
const LAST_GOOD = join(RUNTIME, 'last-good.tgz');
const MIRROR_RE = /^\/(Users|home)\/[A-Za-z0-9._-]{1,64}$/;
export const RUNTIME_EXIT_CODE = 75;

const LOG = join(RUNTIME, 'supervisor.log');
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* disk */ } };

/**
 * The build fingerprint (PINNED, identical to src/server/cloud-fingerprint.ts): every regular
 * file under <packageRoot>/dist, symlinks skipped, one line `<posix rel path>\0<sha256 hex>\n`,
 * lines sorted, sha256 hex of the concatenation.
 */
export function computeFingerprint(packageRoot) {
  const dist = join(packageRoot, 'dist');
  if (!existsSync(dist)) return null;
  const lines = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) visit(abs);
      else if (st.isFile()) {
        const rel = relative(packageRoot, abs).split(sep).join('/');
        lines.push(`${rel}\0${createHash('sha256').update(readFileSync(abs)).digest('hex')}\n`);
      }
    }
  };
  visit(dist);
  lines.sort();
  const h = createHash('sha256');
  for (const l of lines) h.update(l);
  return h.digest('hex');
}

/** A path dcserver may ask the mirror to be mounted on. */
export function validMirrorPath(p) {
  return typeof p === 'string' && MIRROR_RE.test(p) && !p.split('/').includes('..');
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000, ...opts });
}

function writeFingerprint() {
  const fp = existsSync(PKG(OPT)) ? computeFingerprint(PKG(OPT)) : null;
  try {
    writeFileSync(`${FINGERPRINT_FILE}.tmp`, `${fp ?? ''}\n`, { mode: 0o644 });
    renameSync(`${FINGERPRINT_FILE}.tmp`, FINGERPRINT_FILE);
  } catch (e) { log(`fingerprint write failed: ${e.message}`); }
  return fp;
}

/** `npm i` a tarball (or a registry spec) into a fresh prefix, root-owned and read-only. */
function installInto(prefix, spec) {
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true, mode: 0o755 });
  writeFileSync(join(prefix, 'package.json'), '{"name":"dc-hf-runtime","private":true}\n');
  sh('npm', ['i', '--prefix', prefix, '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', spec], { env: { PATH: process.env.PATH, HOME: '/root' } });
  sh('chown', ['-R', 'root:root', prefix]);
  sh('chmod', ['-R', 'go-w', prefix]);
  if (!existsSync(join(PKG(prefix), 'dist', 'index.js'))) throw new Error('installed package has no dist/index.js');
}

/** The spooled tarball must be an npm pack of dreamcontext. */
function verifyTarball(tgz) {
  const pj = JSON.parse(sh('tar', ['-xzOf', tgz, 'package/package.json']).toString('utf-8'));
  if (pj.name !== 'dreamcontext') throw new Error(`tarball is ${pj.name}, not dreamcontext`);
}

/** /opt is wiped by a rebuild: reinstall the last good build (else the registry's). */
function ensureInstalled() {
  if (existsSync(ENTRY)) return;
  try {
    if (existsSync(LAST_GOOD)) installInto(OPT_NEXT, LAST_GOOD);
    else installInto(OPT_NEXT, 'dreamcontext@latest');
    rmSync(OPT, { recursive: true, force: true });
    renameSync(OPT_NEXT, OPT);
    sh('ln', ['-sf', join(OPT, 'node_modules', '.bin', 'dreamcontext'), '/usr/local/bin/dreamcontext']);
    log('installed dreamcontext into /opt/dreamcontext');
  } catch (e) {
    log(`install failed: ${e.message}`);
  }
}

// ─── the mirror (the laptop HOME, bind-mounted from the persistent disk) ──────

let mirror = null;

function isMounted(p) {
  try { sh('mountpoint', ['-q', p]); return true; } catch { return false; }
}

function writeDotfiles(root) {
  const files = {
    '.bashrc': 'umask 0002\nexport PATH="/usr/local/bin:/usr/bin:/bin:$PATH"\n',
    '.profile': 'umask 0002\n[ -f ~/.bashrc ] && . ~/.bashrc\n',
    '.bash_profile': 'umask 0002\n[ -f ~/.bashrc ] && . ~/.bashrc\n',
  };
  for (const [name, body] of Object.entries(files)) {
    const tmp = join(RUNTIME, `dot-${name}`);
    writeFileSync(tmp, body, { mode: 0o644 });
    // `install` unlinks the target first: a planted symlink is replaced, never followed.
    try { sh('install', ['-o', 'dcuser', '-g', 'dcwork', '-m', '0644', tmp, join(root, name)]); } catch (e) { log(`dotfile ${name}: ${e.message}`); }
  }
}

function mountMirror(target) {
  if (!validMirrorPath(target)) { log(`refused mirror path ${JSON.stringify(target)}`); return false; }
  try {
    if (mirror && mirror !== target && isMounted(mirror)) sh('umount', [mirror]);
    if (!isMounted(target)) {
      mkdirSync(target, { recursive: true });
      sh('mount', ['--bind', HM, target]);
    }
    mirror = target;
    writeDotfiles(target);
    writeFileSync(join(PUB, 'mirror-mounted.tmp'), `${target}\n`, { mode: 0o644 });
    renameSync(join(PUB, 'mirror-mounted.tmp'), join(PUB, 'mirror-mounted'));
    log(`mirror mounted on ${target}`);
    return true;
  } catch (e) {
    log(`mirror mount failed: ${e.message}`);
    return false;
  }
}

function readLine(p) {
  try {
    if (lstatSync(p).isSymbolicLink()) return '';
    return readFileSync(p, 'utf-8').trim();
  } catch { return ''; }
}

// ─── the server ─────────────────────────────────────────────────────────────

let listener = null;
let child = null;
let backoff = 500;
let startedAt = 0;
let installing = false;

function serverEnv() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: mirror ?? HM,
    LANG: 'C.UTF-8',
    SHELL: '/bin/bash',
    DREAMCONTEXT_CLOUD: '1',
    DREAMCONTEXT_AUTO_DASHBOARD: '0',
    DC_HF_ORIGIN: readLine(join(RUNTIME, 'origin')),
  };
}

function killDcuser() {
  try { execFileSync('pkill', ['-KILL', '-u', 'dcuser']); } catch { /* none */ }
}

function start() {
  if (installing) return;
  if (!existsSync(ENTRY)) ensureInstalled();
  killDcuser();
  const fd = listener._handle.fd;
  startedAt = Date.now();
  child = spawn('setpriv', [
    '--reuid=dcserver', '--regid=dcserver', '--init-groups',
    '--inh-caps=-all,+setuid,+setgid,+kill', '--ambient-caps=-all,+setuid,+setgid,+kill',
    '--', '/usr/bin/node', ENTRY, 'cloud', 'serve', '--listen-fd', '3',
  ], { cwd: SRV, stdio: ['ignore', 'inherit', 'inherit', fd], env: serverEnv() });
  log(`server started pid=${child.pid}`);
  child.on('exit', (code, sig) => {
    child = null;
    log(`server exited code=${code} sig=${sig}`);
    if (code === RUNTIME_EXIT_CODE) { void installRuntime(); return; }
    backoff = Date.now() - startedAt > 60_000 ? 500 : Math.min(backoff * 2, 30_000);
    setTimeout(start, backoff);
  });
}

function restart() {
  if (child) child.kill('SIGTERM'); // the exit handler restarts it
  else start();
}

function healthFingerprint(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8080, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).fingerprint ?? null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitHealthy(fp, budgetMs) {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if ((await healthFingerprint(5000)) === fp) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Exit 75: install the spooled tarball, swap it in, keep the last good build, fall back. */
async function installRuntime() {
  installing = true;
  const spooled = join(SRV, 'runtime-next.tgz');
  const incoming = join(RUNTIME, 'incoming.tgz');
  let swapped = false;
  try {
    if (!existsSync(spooled) || lstatSync(spooled).isSymbolicLink()) throw new Error('no spooled runtime');
    copyFileSync(spooled, incoming); // root's own copy: dcserver can no longer swap it underneath
    chmodSync(incoming, 0o600);
    rmSync(spooled, { force: true });
    verifyTarball(incoming);
    installInto(OPT_NEXT, incoming);
    rmSync(OPT_PREV, { recursive: true, force: true });
    if (existsSync(OPT)) renameSync(OPT, OPT_PREV);
    renameSync(OPT_NEXT, OPT);
    swapped = true;
    const fp = writeFingerprint();
    installing = false;
    start();
    if (fp && await waitHealthy(fp, 90_000)) {
      copyFileSync(incoming, LAST_GOOD);
      chmodSync(LAST_GOOD, 0o600);
      rmSync(OPT_PREV, { recursive: true, force: true });
      log(`runtime installed, fingerprint ${fp}`);
      return;
    }
    throw new Error('the new build failed its health check');
  } catch (e) {
    log(`runtime install failed: ${e.message}`);
    if (swapped && existsSync(OPT_PREV)) {
      if (child) { const c = child; child = null; c.removeAllListeners('exit'); c.kill('SIGKILL'); }
      rmSync(OPT, { recursive: true, force: true });
      renameSync(OPT_PREV, OPT);
      log('fell back to the last good build');
    }
    writeFingerprint();
    installing = false;
    if (!child) start();
  } finally {
    rmSync(incoming, { force: true });
    rmSync(OPT_NEXT, { recursive: true, force: true });
  }
}

function watchMirrorRequests() {
  setInterval(() => {
    const want = readLine(join(PUB, 'mirror-request'));
    if (want && want !== mirror && validMirrorPath(want)) {
      if (mountMirror(want)) restart(); // the server's HOME is the mirror
    }
  }, 2000).unref();
}

function main() {
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
  ensureInstalled();
  writeFingerprint();
  try { writeFileSync(join(PUB, 'supervised'), `${process.pid}\n`, { mode: 0o644 }); } catch (e) { log(`supervised marker: ${e.message}`); }
  const known = readLine(join(PUB, 'mirror-mounted'));
  if (known && validMirrorPath(known)) mountMirror(known);
  listener = net.createServer();
  listener.on('error', (e) => { log(`listen error ${e.code}`); process.exit(1); });
  listener.listen({ host: '0.0.0.0', port: 8080, backlog: 511 }, () => {
    log('bound 0.0.0.0:8080 (root holds the fd)');
    start();
    watchMirrorRequests();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
