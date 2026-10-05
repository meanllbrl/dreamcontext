/**
 * Shared helpers for scripts/verify/handsfree-roundtrip.mjs: scratch layout, git plumbing
 * state, sha256 sets, the tsx driver call, and the device (phone) HTTP client.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { realpathSync } from 'node:fs';

export const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
/** Unique per run (TMPDIR respected; pid + random suffix): concurrent runs never clobber each other. */
export const SCRATCH = join(realpathSync.native(process.env.TMPDIR || tmpdir()), `dreamcontext-verify-handsfree-roundtrip-${process.pid}-${randomBytes(4).toString('hex')}`);
export const LH = join(SCRATCH, 'laptop', 'home');
export const CLOUD = {
  home: join(SCRATCH, 'cloud', 'home'),
  serverDir: join(SCRATCH, 'cloud', 'srv', 'dc-server'),
  publicDir: join(SCRATCH, 'cloud', 'srv', 'dc-server-pub'),
  mirror: join(SCRATCH, 'cloud', 'mirror'),
  stubBin: join(SCRATCH, 'cloud', 'bin'),
  log: join(SCRATCH, 'cloud', 'server.log'),
  pidFile: join(SCRATCH, 'cloud', 'server.pid'),
};
export const GITCONFIG = join(SCRATCH, 'gitconfig');
export const HFRT_CONFIG = join(SCRATCH, 'harness.json');
/** A frozen copy of the built package: other sessions rebuild dist/ while this runs, and a
 *  worker spawned mid-rebuild would load a half-written bundle. Everything runs from here. */
export const PKG = join(SCRATCH, 'pkg');
export const CLI = join(PKG, 'dist', 'index.js');
export const DRIVER = join(REPO, 'scripts', 'verify', 'handsfree-roundtrip', 'driver.ts');

/** Where the cloud keeps laptop path p (the --mirror-prefix seam). */
export const M = (p) => join(CLOUD.mirror, p);

export const gitEnv = (() => {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) e[k] = v;
  return { ...e, HOME: LH, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
})();

export function git(cwd, args, o = {}) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...gitEnv, ...(o.env ?? {}) }, encoding: o.buffer ? undefined : 'utf8', input: o.input, maxBuffer: 1 << 28 });
  if (r.status !== 0 && !o.allowFail) throw new Error(`git ${args.join(' ')} (in ${cwd}) failed: ${r.stderr}`);
  return o.full ? r : r.stdout;
}

export function put(base, rel, data, mode) {
  const p = join(base, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  if (mode) spawnSync('chmod', [mode.toString(8), p]);
}
export const read = (base, rel) => readFileSync(join(base, ...rel.split('/')));
export const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/** The repo state AC2/AC7 compare: HEAD, refs, stash (sha + message), trees, status. */
export function gitState(repo) {
  const head = (() => {
    const s = git(repo, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true, full: true });
    const oid = git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true, full: true }).stdout.trim() || 'unborn';
    return s.status === 0 ? `${s.stdout.trim()} @ ${oid}` : `detached @ ${oid}`;
  })();
  const indexTree = git(repo, ['write-tree']).trim();
  const tmpIndex = join(SCRATCH, `idx-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const ienv = { GIT_INDEX_FILE: tmpIndex };
  git(repo, ['read-tree', indexTree], { env: ienv });
  git(repo, ['add', '-A', '--', '.'], { env: ienv });
  const worktreeTree = git(repo, ['write-tree'], { env: ienv }).trim();
  rmSync(tmpIndex, { force: true });
  return {
    head,
    refs: git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/notes']),
    stash: git(repo, ['log', '-g', '--format=%H %gs', 'refs/stash'], { allowFail: true }),
    indexTree,
    worktreeTree,
    status: git(repo, ['status', '--porcelain=v2']),
  };
}

export function diffState(a, b, keys = ['head', 'refs', 'stash', 'indexTree', 'worktreeTree', 'status']) {
  const out = [];
  for (const k of keys) if (a[k] !== b[k]) out.push(`${k}: laptop=${JSON.stringify(a[k])} cloud=${JSON.stringify(b[k])}`);
  return out;
}

const SECRET_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.dev\.vars|\.netrc|service-account.*\.json|credentials.*\.json|.*\.(?:p12|pem|p8|key|keystore|jks))$/i;
export const NEVER_TRAVEL = ['_dream_context/state/.secrets.json', '_dream_context/lab/credentials.json'];
const EXCL = ['marketing', 'tmp', '.embeddings', '.obsidian'];

/**
 * The allow-listed non-git set of a repo root, as sha256 per path (re-derived here from the
 * task's Transport 2 rules, independently of the product's manifest.ts): ignored files
 * under _dream_context/ minus its excluded dirs, ignored .claude/ content, the ignored secret
 * class; never the dreamcontext credential files. Session state is excluded when asked.
 */
export function nonGitSet(root, o = {}) {
  const listed = git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { allowFail: true }).split('\0').filter(Boolean);
  const out = {};
  for (const rel of listed) {
    if (NEVER_TRAVEL.includes(rel)) continue;
    if (EXCL.some((d) => rel.startsWith(`_dream_context/${d}/`))) continue;
    const base = rel.split('/').pop();
    const keep = rel.startsWith('_dream_context/') || rel.startsWith('.claude/') || SECRET_RE.test(base);
    if (!keep) continue;
    if (o.noSecrets && SECRET_RE.test(base)) continue;
    if (o.noSession && /^_dream_context\/state\/(\.agent-sessions\.json|\.session-titles\.json|\.agent-session-map\/)/.test(rel)) continue;
    const p = join(root, ...rel.split('/'));
    const st = lstatSync(p);
    out[rel] = st.isSymbolicLink() ? `link:${readlinkSync(p)}` : sha(readFileSync(p));
  }
  return out;
}

/** sha256 of every regular file under dir (relative path -> sha). */
export function treeShas(dir) {
  const out = {};
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) out[relative(dir, p)] = `link:${readlinkSync(p)}`;
      else out[relative(dir, p)] = sha(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

export function diffMaps(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out.push(`${k}: ${a[k] ?? '(absent)'} vs ${b[k] ?? '(absent)'}`);
  return out;
}

/**
 * The tsx CLI, resolved ONCE from this (real-HOME) process: tsx is not a repo dependency, npx
 * finds it in the owner's npx cache, and every driver runs with the scratch HOME (so any
 * homedir() inside the libraries lands in scratch), where npx would find nothing.
 */
const TSX = (() => {
  const local = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(local)) return local;
  const base = join(homedir(), '.npm', '_npx');
  let best = null;
  for (const d of (() => { try { return readdirSync(base); } catch { return []; } })()) {
    const cli = join(base, d, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(cli) && (!best || lstatSync(cli).mtimeMs > lstatSync(best).mtimeMs)) best = cli;
  }
  if (!best) throw new Error('tsx not found: run `npx tsx --version` once, then retry');
  return best;
})();

/** Run one orchestrator call in its own tsx process. `killAt` = 'kind#n' (case 8). */
export function driver(cmd, args = {}, o = {}) {
  const t0 = Date.now();
  const resultFile = join(SCRATCH, `result-${cmd}-${t0}.json`);
  rmSync(resultFile, { force: true });
  const r = spawnSync(process.execPath, [TSX, DRIVER, cmd, JSON.stringify(args)], {
    cwd: REPO,
    env: { ...process.env, HOME: LH, HFRT_CONFIG, HFRT_RESULT: resultFile, ...(o.killAt ? { HFRT_KILL_AT: o.killAt } : {}), ...(o.pauseAt ? { HFRT_PAUSE_AT: o.pauseAt } : {}) },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 15 * 60_000,
  });
  const ms = Date.now() - t0;
  if (!existsSync(resultFile)) return { ok: false, killed: r.signal === 'SIGKILL' || r.status === null, signal: r.signal, status: r.status, stderr: (r.stderr ?? '').slice(-4000), ms };
  const out = JSON.parse(readFileSync(resultFile, 'utf8'));
  rmSync(resultFile, { force: true });
  return { ...out, ms };
}

/** {@link driver} without blocking: resolves with the same shape when the process exits. */
export function driverAsync(cmd, args = {}, o = {}) {
  const t0 = Date.now();
  const resultFile = join(SCRATCH, `result-${cmd}-${t0}-async.json`);
  rmSync(resultFile, { force: true });
  const child = spawn(process.execPath, [TSX, DRIVER, cmd, JSON.stringify(args)], {
    cwd: REPO,
    env: { ...process.env, HOME: LH, HFRT_CONFIG, HFRT_RESULT: resultFile, ...(o.killAt ? { HFRT_KILL_AT: o.killAt } : {}), ...(o.pauseAt ? { HFRT_PAUSE_AT: o.pauseAt } : {}) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve) => child.on('close', (status, signal) => {
    const ms = Date.now() - t0;
    if (!existsSync(resultFile)) return resolve({ ok: false, killed: signal === 'SIGKILL', signal, status, stderr: stderr.slice(-4000), ms });
    const out = JSON.parse(readFileSync(resultFile, 'utf8'));
    rmSync(resultFile, { force: true });
    resolve({ ...out, ms });
  }));
}

/** The phone: a device session against the cloud's public port. */
export class Phone {
  constructor(origin) { this.origin = origin; this.cookie = null; this.log = []; }
  async login(passphrase) {
    const r = await fetch(`${this.origin}/api/handsfree/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: this.origin }, body: JSON.stringify({ passphrase }) });
    const sc = r.headers.get('set-cookie') ?? '';
    const m = /__Host-dc_hf_session=([^;]+)/.exec(sc);
    this.cookie = m ? m[1] : null;
    return { status: r.status, cookie: this.cookie, setCookie: sc };
  }
  async req(method, path, body, o = {}) {
    const headers = { Accept: 'application/json', ...(o.vault ? { 'X-Dreamcontext-Vault': o.vault } : {}) };
    if (this.cookie) headers.Cookie = `__Host-dc_hf_session=${this.cookie}`;
    if (method !== 'GET') headers.Origin = this.origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(this.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    this.log.push({ method, path, status: r.status });
    return { status: r.status, json, text };
  }
}
