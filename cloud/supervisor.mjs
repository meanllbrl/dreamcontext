// dreamcontext hands-free ROOT supervisor. Started detached by entrypoint.sh at every container
// start; copied verbatim into <owner>/dreamcontext-handsfree/.devcontainer/supervisor.mjs.
//
//  - binds 0.0.0.0:8080 ONCE and hands the listening fd to every server instance, so the port
//    is never free for dcuser to grab across a restart (W0 item 4);
//  - kills every dcuser process before each (re)start;
//  - restarts the server on ANY exit, with backoff;
//  - the build ALWAYS comes from npm at ONE exact version (D25): `npm pack dreamcontext@<v>` into
//    a root 0700 dir, the tarball's sha512 checked against the pin's integrity BEFORE anything
//    is installed, then `npm i --ignore-scripts --omit=optional` into /opt/dreamcontext.next and
//    a rename into place. Never a range, never a tag, never an unverified tarball;
//  - exit code 75 (POST runtime): dcserver wrote `{version, integrity}`; that version is
//    installed as above, the last good build is kept (also as a tarball on /workspaces, so a
//    rebuild that wiped /opt reinstalls the same build), it falls back to it when health fails,
//    and writes the build fingerprint of the installed files to a root-owned file;
//  - first boot (no build, no last good): the version pin the laptop wrote into the repo
//    (`.devcontainer/bootstrap/version.json`, read only from the locked-down checkout); that
//    install becomes the last good build at once, so the checkout is read only on a first boot;
//  - `prepare` / `lockdown` (entrypoint, root): the checkout's .devcontainer tree is locked down
//    before anything reads it, and every read of it is no-follow and owner/mode-checked;
//  - bind-mounts the mirror (/workspaces/dc-home) on the laptop's HOME once a trip names it
//    (dcserver asks through $PUB/mirror-request), and again at every start.
// Node builtins only.
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync, chmodSync, closeSync, constants as FS, copyFileSync, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
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

/** `npm i` a local tarball into a fresh prefix, root-owned and read-only. */
function installInto(prefix, spec) {
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true, mode: 0o755 });
  writeFileSync(join(prefix, 'package.json'), '{"name":"dc-hf-runtime","private":true}\n');
  sh('npm', ['i', '--prefix', prefix, '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', spec], { env: { PATH: process.env.PATH, HOME: '/root' } });
  sh('chown', ['-R', 'root:root', prefix]);
  sh('chmod', ['-R', 'go-w', prefix]);
  if (!existsSync(join(PKG(prefix), 'dist', 'index.js'))) throw new Error('installed package has no dist/index.js');
}

/** The tarball must be an npm pack of dreamcontext at exactly `version`. */
function verifyTarball(tgz, version) {
  const pj = JSON.parse(sh('tar', ['-xzOf', tgz, 'package/package.json']).toString('utf-8'));
  if (pj.name !== 'dreamcontext') throw new Error(`tarball is ${pj.name}, not dreamcontext`);
  if (pj.version !== version) throw new Error(`tarball is dreamcontext ${pj.version}, not ${version}`);
}

// ─── the version pin (D25): mirrored from src/lib/handsfree/npm-pin.ts (drift-tested) ──────

/** Strict semver: one exact published version (no range, no tag). */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
/** npm's `dist.integrity` for a sha512. */
export const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PIN_MAX_BYTES = 4096;

export function isPin(v) {
  return !!v && typeof v === 'object' && typeof v.version === 'string' && SEMVER_RE.test(v.version)
    && typeof v.integrity === 'string' && INTEGRITY_RE.test(v.integrity);
}

/** `npm pack dreamcontext@<exact version>` into `dir`; returns the tarball path. */
function npmPackExact(version, dir) {
  if (!SEMVER_RE.test(version)) throw new Error(`"${version}" is not an exact version`);
  const out = sh('npm', ['pack', `dreamcontext@${version}`, '--pack-destination', dir, '--json', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: '/root' },
  }).toString('utf-8');
  const name = JSON.parse(out)?.[0]?.filename;
  if (typeof name !== 'string' || !/^dreamcontext-[0-9A-Za-z.-]+\.tgz$/.test(name)) throw new Error('npm pack named no tarball');
  return join(dir, name);
}

/**
 * Fetch exactly `pin.version` and check the tarball's sha512 against `pin.integrity` BEFORE it
 * can be installed (and that it is dreamcontext at that version). Throws on any mismatch.
 */
export function fetchVerified(pin, dir, { fetchTarball = npmPackExact } = {}) {
  if (!isPin(pin)) throw new Error('the version pin is not an exact version with a sha512 integrity');
  const tgz = fetchTarball(pin.version, dir);
  const st = lstatSync(tgz);
  if (!st.isFile()) throw new Error(`${tgz} is not a regular file`);
  const got = `sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}`;
  if (got !== pin.integrity) throw new Error(`dreamcontext ${pin.version} from npm has sha512 ${got}, not the pinned ${pin.integrity}; refused`);
  verifyTarball(tgz, pin.version);
  return tgz;
}

/** A root 0700 dir for one fetch, removed by `cleanup`. */
function fetchIntoRuntime(pin) {
  const dir = mkdtempSync(join(RUNTIME, 'fetch-'));
  try {
    return { tgz: fetchVerified(pin, dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** dcserver's `{version, integrity}` (its own dir): no-follow, size-capped, shape-checked, then removed. */
export function readRuntimeRequest(path) {
  let buf;
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (e) {
    rmSync(path, { force: true }); // a planted link is removed, never followed
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > PIN_MAX_BYTES) throw new Error('the runtime request is not a small regular file');
    buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
  } finally {
    closeSync(fd);
    rmSync(path, { force: true });
  }
  const pin = JSON.parse(buf.toString('utf-8'));
  if (!isPin(pin)) throw new Error('the runtime request is not an exact version with a sha512 integrity');
  return { version: pin.version, integrity: pin.integrity };
}

const VERIFIERS_MAX_BYTES = 16384;
/** The image's `codespace` user (Dockerfile): it owns the repo checkout itself, never dcuser. */
const CODESPACE_UID = 1000;
const DCSERVER_UID = 2001;
const DCSERVER_GID = 2001;
/** Who may own what in the checkout: the checkout dir (root or codespace), everything in .devcontainer (root only). */
const TRUST = { rootUid: 0, repoOwners: [0, CODESPACE_UID] };

/** The repo checkouts on /workspaces (GitHub's clone of the private repo); never a dc-* dir. */
function cloneDirs(workspaces) {
  let names = [];
  try { names = readdirSync(workspaces).sort(); } catch { /* none */ }
  return names.filter((n) => !n.startsWith('dc-') && !n.startsWith('.')).map((n) => join(workspaces, n));
}

/** A plain directory (lstat: never a link), owned by one of `owners`, writable by nobody else. */
function trustedDir(p, owners) {
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${p} is not a plain directory`);
  if (!owners.includes(st.uid)) throw new Error(`${p} is owned by uid ${st.uid}`);
  if (st.mode & 0o022) throw new Error(`${p} is writable by group or others`);
}

/**
 * Read `rel` under a repo checkout with no-follow semantics on EVERY component: the checkout
 * and each directory below it are lstat-checked (never a link, owned by the trusted owner, not
 * group/other-writable, so nobody else can swap them afterwards), and the file is opened
 * O_NOFOLLOW and checked again on the open fd (root-owned, a regular file, not writable by
 * others) before a byte is read. The clone sits on a /workspaces whose default ACL gives
 * other::rwx (W0 b): only the lockdown below makes it trustworthy, and only root's lockdown.
 */
export function readCloneFile(repoDir, rel, maxBytes, trust = TRUST) {
  trustedDir(repoDir, trust.repoOwners);
  const parts = rel.split('/');
  let p = repoDir;
  for (const part of parts.slice(0, -1)) { p = join(p, part); trustedDir(p, [trust.rootUid]); }
  const file = join(p, parts[parts.length - 1]);
  const fd = openSync(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.uid !== trust.rootUid) throw new Error(`${file} is owned by uid ${st.uid}`);
    if (st.mode & 0o022) throw new Error(`${file} is writable by group or others`);
    if (st.size > maxBytes) throw new Error(`${file} is over ${maxBytes} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off !== st.size) throw new Error(`${file} changed while it was read`);
    return buf;
  } finally {
    closeSync(fd);
  }
}

function stripAclXattrs(paths) {
  if (!paths.length) return;
  try {
    sh('python3', ['-c', `import os,sys
for p in sys.argv[1:]:
    for a in ("system.posix_acl_access", "system.posix_acl_default"):
        try: os.removexattr(p, a, follow_symlinks=False)
        except OSError: pass`, ...paths]);
  } catch (e) { log(`acl strip failed: ${e.message}`); }
}

/** fd-based: a link is unlinked (never followed), a dir is locked BEFORE its entries are read. */
function lockTree(p, owner, locked, logLine) {
  let fd;
  try {
    fd = openSync(p, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') { // a symlink: its parent is already locked, so this IS the link
      try { unlinkSync(p); logLine(`lockdown: removed the link ${p}`); } catch (u) { logLine(`lockdown: ${p}: ${u.message}`); }
    } else if (e.code !== 'ENOENT') logLine(`lockdown: ${p}: ${e.message}`);
    return;
  }
  let dir = false;
  try {
    const st = fstatSync(fd);
    if (owner) fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, (st.mode & 0o7777) & ~0o022);
    locked.push(p);
    dir = st.isDirectory();
  } finally {
    closeSync(fd);
  }
  if (dir) for (const name of readdirSync(p)) lockTree(join(p, name), owner, locked, logLine);
}

/**
 * Root, before anything reads the checkout (entrypoint `prepare`, and again after GitHub's
 * one-time re-own at creation): every checkout dir loses group/other write and its ACLs; its
 * whole `.devcontainer` tree becomes root:root, no group/other write, no ACLs (default ones
 * too), and any link in it is removed. A `.devcontainer` that is itself a link is removed.
 */
export function lockdownClones({ workspaces = '/workspaces', owner = { uid: 0, gid: 0 }, stripAcl = stripAclXattrs, logLine = log } = {}) {
  for (const repo of cloneDirs(workspaces)) {
    let fd;
    try { fd = openSync(repo, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_DIRECTORY | FS.O_NONBLOCK); } catch { continue; } // a link or not a dir: never followed, never trusted
    try { fchmodSync(fd, (fstatSync(fd).mode & 0o7777) & ~0o022); } finally { closeSync(fd); }
    const locked = [repo];
    lockTree(join(repo, '.devcontainer'), owner, locked, logLine);
    stripAcl(locked);
  }
}

/**
 * The version pin the laptop wrote into the repo (`.devcontainer/bootstrap/version.json`,
 * blob-sha checked by the laptop before every start/create), read through
 * {@link readCloneFile} only. Returns `{version, integrity}`, or null with the reason logged.
 */
export function repoPin({ workspaces = '/workspaces', logLine = log, trust = TRUST } = {}) {
  for (const repo of cloneDirs(workspaces)) {
    let pin;
    try {
      pin = JSON.parse(readCloneFile(repo, '.devcontainer/bootstrap/version.json', PIN_MAX_BYTES, trust).toString('utf-8'));
    } catch (e) {
      if (e.code !== 'ENOENT') logLine(`version pin in ${repo} refused (${e.message})`);
      continue;
    }
    if (!isPin(pin)) { logLine(`version pin in ${repo} is not an exact version with a sha512 integrity`); continue; }
    return { version: pin.version, integrity: pin.integrity };
  }
  return null;
}

/**
 * The repo's bootstrap verifiers, copied into the dcserver dir ONLY when it holds none or a
 * lower generation; sanitized to the three fields `cloud serve` installs. Read through
 * {@link readCloneFile}; written O_EXCL|O_NOFOLLOW (dcserver owns that dir) and renamed in.
 */
export function copyVerifiers({ workspaces = '/workspaces', dst = join(SRV, 'bootstrap-verifiers.json'), owner = { uid: DCSERVER_UID, gid: DCSERVER_GID }, logLine = log, trust = TRUST } = {}) {
  let best = null;
  for (const repo of cloneDirs(workspaces)) {
    let v;
    try { v = JSON.parse(readCloneFile(repo, '.devcontainer/bootstrap/verifiers.json', VERIFIERS_MAX_BYTES, trust).toString('utf-8')); } catch (e) {
      if (e.code !== 'ENOENT') logLine(`bootstrap verifiers in ${repo} refused (${e.message})`);
      continue;
    }
    const g = v?.generation;
    if (!Number.isSafeInteger(g) || g < 1 || typeof v.passphrase !== 'object' || v.passphrase === null || typeof v.transferSha256 !== 'string') continue;
    if (!best || g > best.generation) best = { generation: g, passphrase: v.passphrase, transferSha256: v.transferSha256 };
  }
  if (!best) return false;
  let old = 0;
  try {
    const fd = openSync(dst, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (st.isFile() && st.size <= VERIFIERS_MAX_BYTES) {
        const buf = Buffer.alloc(st.size);
        readSync(fd, buf, 0, st.size, 0);
        const g = JSON.parse(buf.toString('utf-8')).generation;
        if (Number.isSafeInteger(g)) old = g;
      }
    } finally { closeSync(fd); }
  } catch { old = 0; }
  if (old >= best.generation) return false;
  const tmp = `${dst}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, JSON.stringify(best));
    if (owner) fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
  renameSync(tmp, dst);
  logLine(`bootstrap verifiers generation ${best.generation} installed`);
  return true;
}

/** Entrypoint, as root, before the supervisor starts: lock the checkout, then read it. */
export function prepare() {
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
  lockdownClones();
  try { copyVerifiers(); } catch (e) { log(`bootstrap verifiers: ${e.message}`); }
}

/**
 * /opt has no build (first boot, or a rebuild wiped it). Install order (D25): the last good
 * build on /workspaces, else exactly the repo's pinned version from npm with its sha512 checked
 * against the pin, else NOTHING (no unpinned install, no range, no tag). A pinned install
 * becomes the last good build at once, so the checkout is read only on a true first boot and a
 * later rebuild reinstalls the same build.
 */
export function ensureInstalled({
  entry = ENTRY, lastGood = LAST_GOOD, pin = () => repoPin(), fetch = fetchIntoRuntime, install = installBuild, logLine = log,
} = {}) {
  if (existsSync(entry)) return false;
  let spec = null;
  let version = null;
  let from = '';
  let cleanup = null;
  if (existsSync(lastGood)) { spec = lastGood; from = 'the last good build'; }
  else {
    let p = null;
    try { p = pin(); } catch (e) { logLine(`version pin unusable (${e.message})`); }
    if (p) {
      try {
        const f = fetch(p);
        spec = f.tgz;
        cleanup = f.cleanup;
        version = p.version;
        from = `dreamcontext ${p.version} from npm (the repo's version pin)`;
      } catch (e) { logLine(`dreamcontext ${p.version} from npm not installed: ${e.message}`); }
    }
  }
  try {
    if (!spec) {
      logLine('no build to install: no last good build on /workspaces and no verified npm build of the repo\'s version pin; run `dreamcontext handsfree setup` on the laptop (nothing unpinned is ever installed)');
      return false;
    }
    try {
      install(spec, version);
      if (spec !== lastGood) {
        copyFileSync(spec, lastGood);
        chmodSync(lastGood, 0o600);
      }
      logLine(`installed dreamcontext into /opt/dreamcontext from ${from}`);
      return true;
    } catch (e) {
      logLine(`install from ${from} failed: ${e.message}`);
      return false;
    }
  } finally {
    cleanup?.();
  }
}

function installBuild(tgz, version) {
  if (version) verifyTarball(tgz, version); // the last good build was verified when it was installed
  installInto(OPT_NEXT, tgz);
  rmSync(OPT, { recursive: true, force: true });
  renameSync(OPT_NEXT, OPT);
  sh('ln', ['-sf', join(OPT, 'node_modules', '.bin', 'dreamcontext'), '/usr/local/bin/dreamcontext']);
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
    // Written AS dcuser (the mirror is dcuser's tree): temp + rename, so a planted link is
    // replaced, never followed, and root never writes into a dcuser-writable directory.
    try {
      execFileSync('setpriv', [
        '--reuid=dcuser', '--regid=dcwork', '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--',
        '/bin/sh', '-c', 'umask 0022; t=$(mktemp "$1.XXXXXX") && cat > "$t" && chmod 0644 "$t" && mv -f -- "$t" "$1"', 'sh', join(root, name),
      ], { input: body, stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' }, timeout: 15_000 });
    } catch (e) { log(`dotfile ${name}: ${e.message}`); }
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

/** Exit 75: install the requested npm version, swap it in, keep the last good build, fall back. */
async function installRuntime() {
  installing = true;
  let fetched = null;
  let swapped = false;
  try {
    const pin = readRuntimeRequest(join(SRV, 'runtime-request.json'));
    fetched = fetchIntoRuntime(pin);
    installInto(OPT_NEXT, fetched.tgz);
    rmSync(OPT_PREV, { recursive: true, force: true });
    if (existsSync(OPT)) renameSync(OPT, OPT_PREV);
    renameSync(OPT_NEXT, OPT);
    swapped = true;
    const fp = writeFingerprint();
    installing = false;
    start();
    if (fp && await waitHealthy(fp, 90_000)) {
      copyFileSync(fetched.tgz, LAST_GOOD);
      chmodSync(LAST_GOOD, 0o600);
      rmSync(OPT_PREV, { recursive: true, force: true });
      log(`runtime installed: dreamcontext ${pin.version}, fingerprint ${fp}`);
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
    fetched?.cleanup();
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
  lockdownClones(); // idempotent: entrypoint `prepare` already ran it
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === 'prepare') prepare();
  else if (process.argv[2] === 'lockdown') lockdownClones();
  else main();
}
