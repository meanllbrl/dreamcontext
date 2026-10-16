/**
 * Mac mode's tunnel manager: a pinned, sha256-verified `cloudflared` pointed at the PHONE
 * listener (127.0.0.1:<phonePort>), never at the main dashboard port.
 *
 *  • Binary: `assets/cloudflared-pins.json` pins the release archive's sha256 (the trust
 *    anchor) and the binary's. Only the `cloudflared` entry is extracted — a traversal, a link
 *    or any non-regular entry refuses the whole archive — into a 0700 temp dir, then renamed
 *    to `~/.dreamcontext/bin/cloudflared-<version>`.
 *  • Quick tunnel (default): `cloudflared tunnel --no-autoupdate --config <our file> --url …`;
 *    the first `https://<name>.trycloudflare.com` it prints is the address (random per start).
 *  • Fixed address (optional): a LOCALLY-MANAGED named tunnel on the owner's own domain. Setup
 *    runs `tunnel login` with HOME pointed at a private dir inside the Mac dir (login writes
 *    `$HOME/.cloudflared/cert.pem` and has no flag for it — verified against 2026.10.1), creates
 *    the tunnel with its credentials JSON in the Mac dir (0600), routes DNS, then DELETES the
 *    zone-wide cert. Nothing is ever written to the owner's `~/.cloudflared`. At every start we
 *    write the ingress config ourselves: the phone port, then a 404 catch-all.
 *  • Every child gets an env built per spawn; `process.env` is never touched.
 *  • A watchdog (`/bin/sh`, polling the server pid every 2 s) SIGTERMs cloudflared when the
 *    server dies, so a crashed app never leaves a public tunnel behind.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import dns from 'node:dns';
import https from 'node:https';
import { downloadVerified, DownloadError } from '../../onboarding/download.js';

// ─── Pins ───────────────────────────────────────────────────────────────────

export interface CloudflaredPin { asset: string; sha256: string; binarySha256: string; size: number }
export interface CloudflaredPins { version: string; base: string; files: Record<string, CloudflaredPin> }

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** `assets/cloudflared-pins.json`, found upward from this module (src/ in dev, dist/ shipped). */
export function loadCloudflaredPins(): CloudflaredPins {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const p = join(dir, 'assets', 'cloudflared-pins.json');
    if (existsSync(p)) return (JSON.parse(readFileSync(p, 'utf8')) as { cloudflared: CloudflaredPins }).cloudflared;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('cloudflared pins not found (assets/cloudflared-pins.json)');
}

export function platformKey(arch: string = process.arch): string {
  return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function binDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin');
}

export function cloudflaredPath(version: string, home: string = homedir()): string {
  return join(binDir(home), `cloudflared-${version}`);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ─── Safe extraction (ustar/pax, gzip) ──────────────────────────────────────

export class ArchiveRefused extends Error {
  constructor(message: string) { super(message); this.name = 'ArchiveRefused'; }
}

function cstr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, len: number): number {
  const s = cstr(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function unsafeName(name: string): boolean {
  if (!name || name.includes('\0') || name.startsWith('/') || name.includes('\\')) return true;
  return name.split('/').some((seg) => seg === '..');
}

/**
 * The `cloudflared` file inside a release `.tgz`, refusing the WHOLE archive on any entry that
 * could write outside where we put it: an absolute or `..` path, a hard or symbolic link, a
 * device, a FIFO. Returns the binary's bytes (nothing touches the disk here).
 */
export function readCloudflaredFromTgz(tgz: Buffer): Buffer {
  let tar: Buffer;
  try { tar = gunzipSync(tgz); } catch { throw new ArchiveRefused('not a gzip archive'); }
  let off = 0;
  let found: Buffer | null = null;
  let paxPath: string | null = null;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = cstr(h, 345, 155);
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      // A pax header can rename the next entry: read its path= record.
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (type === 'x') paxPath = m ? m[1] : null;
      if (m && unsafeName(m[1])) throw new ArchiveRefused(`unsafe entry: ${m[1]}`);
      continue;
    }
    if (type === 'L') { longName = cstr(body, 0, body.length); if (unsafeName(longName)) throw new ArchiveRefused(`unsafe entry: ${longName}`); continue; }
    paxPath = null;
    longName = null;
    name = name.replace(/^\.\//, '');
    if (unsafeName(name)) throw new ArchiveRefused(`unsafe entry: ${name}`);
    if (type === '1' || type === '2') throw new ArchiveRefused(`link entry refused: ${name}`);
    if (type === '5') continue; // a directory carries no bytes
    if (type !== '0' && type !== '\0' && type !== '7') throw new ArchiveRefused(`non-regular entry refused: ${name}`);
    if (name === 'cloudflared') {
      if (found) throw new ArchiveRefused('two cloudflared entries');
      found = Buffer.from(body);
    }
  }
  if (!found) throw new ArchiveRefused('no cloudflared entry');
  return found;
}

export interface EnsureOptions {
  home?: string;
  pins?: CloudflaredPins;
  arch?: string;
  fetchImpl?: typeof fetch;
  /** The verify/test seam: a 127.0.0.1 http base instead of GitHub. */
  baseOverride?: string;
}

/**
 * The verified cloudflared binary's path, downloading it first when needed. An installed binary
 * is reused only when its sha256 still equals the pin. On ANY failure no executable is left
 * behind (the archive and the temp dir are removed; the final name appears only by rename).
 */
export async function ensureCloudflared(o: EnsureOptions = {}): Promise<string> {
  const home = o.home ?? homedir();
  const pins = o.pins ?? loadCloudflaredPins();
  const pin = pins.files[platformKey(o.arch)];
  if (!pin) throw new Error(`no cloudflared pin for ${platformKey(o.arch)}`);
  const dir = binDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  if (lstatSync(dir).isSymbolicLink()) throw new ArchiveRefused('bin dir is a symlink');
  const finalPath = cloudflaredPath(pins.version, home);
  if (existsSync(finalPath)) {
    const st = lstatSync(finalPath);
    if (st.isFile() && sha256File(finalPath) === pin.binarySha256) return finalPath;
    rmSync(finalPath, { force: true });
  }
  const tmp = join(dir, `.cloudflared-${randomBytes(6).toString('hex')}`);
  mkdirSync(tmp, { mode: 0o700 });
  try {
    const archive = join(tmp, pin.asset);
    const base = o.baseOverride ?? pins.base;
    await downloadVerified(new URL(pin.asset, base).toString(), {
      sha256: pin.sha256, maxBytes: pin.size + 1024 * 1024, dest: archive, fetchImpl: o.fetchImpl,
      allowLoopback: !!o.baseOverride && /^http:\/\/127\.0\.0\.1[:/]/.test(o.baseOverride),
    });
    const bytes = readCloudflaredFromTgz(readFileSync(archive));
    const out = join(tmp, 'cloudflared');
    const fd = openSync(out, 'wx', 0o700);
    try { writeSync(fd, bytes); } finally { closeSync(fd); }
    const st = lstatSync(out);
    if (!st.isFile()) throw new ArchiveRefused('extracted entry is not a regular file');
    if (sha256File(out) !== pin.binarySha256) throw new ArchiveRefused('the binary does not match its pinned checksum');
    chmodSync(out, 0o700);
    renameSync(out, finalPath);
    return finalPath;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export { DownloadError };

// ─── Child env ──────────────────────────────────────────────────────────────

/**
 * The env every cloudflared child gets, built from scratch per spawn. Nothing of the server's
 * env passes but these (no dreamcontext secret, no token, no CLAUDE_* variable), and
 * `process.env` itself is never written.
 */
export function cloudflaredEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    NO_AUTOUPDATE: 'true',
    ...extra,
  };
}

// ─── Config files (written by us, never by the owner) ───────────────────────

export function quickConfigPath(macDir: string): string {
  return join(macDir, 'cloudflared-quick.yml');
}

export function writeQuickConfig(macDir: string): string {
  const p = quickConfigPath(macDir);
  // Explicit, so cloudflared never reads a config.yml the owner keeps elsewhere.
  writeFileSync(p, 'no-autoupdate: true\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

export interface FixedTunnelRecord { hostname: string; tunnelId: string; name: string }

export function fixedRecordPath(macDir: string): string { return join(macDir, 'fixed.json'); }
export function fixedCredentialsPath(macDir: string): string { return join(macDir, 'tunnel.json'); }
export function fixedConfigPath(macDir: string): string { return join(macDir, 'cloudflared-fixed.yml'); }

export function readFixedRecord(macDir: string): FixedTunnelRecord | null {
  try {
    const r = JSON.parse(readFileSync(fixedRecordPath(macDir), 'utf8')) as Partial<FixedTunnelRecord>;
    if (typeof r.hostname === 'string' && typeof r.tunnelId === 'string' && typeof r.name === 'string' && existsSync(fixedCredentialsPath(macDir))) {
      return { hostname: r.hostname, tunnelId: r.tunnelId, name: r.name };
    }
  } catch { /* none */ }
  return null;
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function isValidHostname(h: string): boolean {
  return HOSTNAME_RE.test(h.trim().toLowerCase());
}

/** The ingress config, written at EVERY start: the phone port, then 404 for anything else. */
export function fixedConfigYaml(rec: FixedTunnelRecord, credentialsFile: string, phonePort: number): string {
  if (!isValidHostname(rec.hostname)) throw new Error('invalid hostname');
  if (!/^[0-9a-f-]{36}$/.test(rec.tunnelId)) throw new Error('invalid tunnel id');
  if (!Number.isInteger(phonePort) || phonePort <= 0 || phonePort > 65535) throw new Error('invalid port');
  return [
    `tunnel: ${rec.tunnelId}`,
    `credentials-file: ${JSON.stringify(credentialsFile)}`,
    'no-autoupdate: true',
    'ingress:',
    `  - hostname: ${rec.hostname}`,
    `    service: http://127.0.0.1:${phonePort}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

export function writeFixedConfig(macDir: string, rec: FixedTunnelRecord, phonePort: number): string {
  const p = fixedConfigPath(macDir);
  writeFileSync(p, fixedConfigYaml(rec, fixedCredentialsPath(macDir), phonePort), { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

// ─── Running a tunnel ───────────────────────────────────────────────────────

export type SpawnImpl = (file: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => ChildProcess;

const defaultSpawn: SpawnImpl = (file, args, opts) => spawn(file, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

export const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface RunningTunnel { child: ChildProcess; url: string; mode: 'quick' | 'fixed' }

export interface StartTunnelOptions {
  bin: string;
  macDir: string;
  phonePort: number;
  home?: string;
  /** Fixed address: the record from setup. Absent = a quick tunnel. */
  fixed?: FixedTunnelRecord | null;
  spawnImpl?: SpawnImpl;
  timeoutMs?: number;
}

/**
 * Start cloudflared and resolve once its public URL is known (quick: the first trycloudflare URL
 * it prints, within `timeoutMs`; fixed: `https://<hostname>` once a connection registers).
 * Rejects (and kills the child) on timeout or early exit. Never logs a line of its output.
 */
export function startTunnel(o: StartTunnelOptions): Promise<RunningTunnel> {
  const home = o.home ?? join(o.macDir, 'cf-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const timeoutMs = o.timeoutMs ?? 30_000;
  const fixed = o.fixed ?? null;
  const args = fixed
    ? ['tunnel', '--no-autoupdate', '--config', writeFixedConfig(o.macDir, fixed, o.phonePort), 'run', fixed.tunnelId]
    : ['tunnel', '--no-autoupdate', '--config', writeQuickConfig(o.macDir), '--url', `http://127.0.0.1:${o.phonePort}`];
  const child = (o.spawnImpl ?? defaultSpawn)(o.bin, args, { env: cloudflaredEnv(home), cwd: o.macDir });
  return new Promise<RunningTunnel>((resolveRun, reject) => {
    let settled = false;
    let buf = '';
    const done = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        reject(err);
      } else {
        resolveRun({ child, url: url!, mode: fixed ? 'fixed' : 'quick' });
      }
    };
    const onData = (d: Buffer): void => {
      if (settled) return;
      buf = (buf + d.toString('utf8')).slice(-16_384);
      if (fixed) {
        if (/Registered tunnel connection/i.test(buf)) done(null, `https://${fixed.hostname}`);
        return;
      }
      const m = QUICK_URL_RE.exec(buf);
      if (m && !/api\.trycloudflare\.com/.test(m[0])) done(null, m[0]);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (e) => done(e));
    child.once('exit', (code) => done(new Error(`cloudflared exited early (${code})`)));
    const timer = setTimeout(() => done(new Error('cloudflared did not report a URL in time')), timeoutMs);
  });
}

/** Public resolvers asked first: never the Mac's own (negative-)cached answer. */
const PUBLIC_RESOLVERS = ['1.1.1.1', '1.0.0.1', '8.8.8.8'];

export interface ZoneQuery { ns: (name: string) => Promise<string[]>; a: (name: string) => Promise<string[]> }

/**
 * The IPv4 addresses of the nameservers authoritative for the zone that holds `hostname`: walk
 * up from its parent (never the bare TLD) until a name has an NS set. Null when none answers.
 */
export async function zoneServers(hostname: string, q: ZoneQuery): Promise<string[] | null> {
  const labels = hostname.split('.');
  for (let i = 1; i <= labels.length - 2; i++) {
    const zone = labels.slice(i).join('.');
    const ns = await q.ns(zone).catch(() => [] as string[]);
    if (!ns.length) continue;
    const ips = (await Promise.all(ns.slice(0, 4).map((n) => q.a(n).catch(() => [] as string[])))).flat();
    return ips.length ? ips : null;
  }
  return null;
}

/** No answer from a stage within this → the next stage. Short, so the system resolver is reached
 *  even where port 53 to anything but the network's own resolver is dropped. */
export const DNS_STAGE_MS = 1500;
/** A zone whose servers did not answer is skipped for this long (no 3-stage cost per attempt). */
const ZONE_UNREACHABLE_MS = 60_000;

/** Resolves to `fallback` when `p` takes longer than `ms` (or rejects). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((done) => {
    const t = setTimeout(() => done(fallback), ms);
    p.then((v) => { clearTimeout(t); done(v); }, () => { clearTimeout(t); done(fallback); });
  });
}

/** One resolver's IPv4 answers, or the error code ('ENOTFOUND', 'ETIMEOUT', …). */
function resolve4At(servers: string[], hostname: string): Promise<string[] | string> {
  const r = new dns.promises.Resolver({ timeout: DNS_STAGE_MS, tries: 1 });
  try { r.setServers(servers.slice(0, 2)); } catch { return Promise.resolve('EBADSERVERS'); }
  return r.resolve4(hostname).catch((e: NodeJS.ErrnoException) => e.code ?? 'EFAIL');
}

export interface FreshDnsStages {
  zone: (hostname: string) => Promise<string[] | null>;
  at: (servers: string[], hostname: string) => Promise<string[] | string>;
  system: (hostname: string) => Promise<string>;
  stageMs?: number;
}

const zoneCache = new Map<string, { at: number; servers: string[] | null }>();
async function cachedZoneServers(hostname: string): Promise<string[] | null> {
  const parent = hostname.split('.').slice(1).join('.');
  const hit = zoneCache.get(parent);
  if (hit && (hit.servers || Date.now() - hit.at < ZONE_UNREACHABLE_MS)) return hit.servers;
  const r = new dns.promises.Resolver({ timeout: DNS_STAGE_MS, tries: 1 });
  try { r.setServers(PUBLIC_RESOLVERS.slice(0, 2)); } catch { /* keep defaults */ }
  const servers = await within(zoneServers(hostname, { ns: (n) => r.resolveNs(n), a: (n) => r.resolve4(n) }), DNS_STAGE_MS * 2, null);
  zoneCache.set(parent, { at: Date.now(), servers });
  return servers;
}

const realStages: FreshDnsStages = {
  zone: cachedZoneServers,
  at: resolve4At,
  system: (h) => dns.promises.lookup(h, { family: 4 }).then((r) => r.address),
};

/**
 * Resolve a fresh tunnel name at the zone's AUTHORITATIVE nameservers, then public resolvers,
 * then the system's, each stage on its own short timer. Why: a quick tunnel's name is printed a
 * few seconds BEFORE its DNS record exists, and any caching resolver asked in that window caches
 * the NXDOMAIN for the zone's negative TTL (trycloudflare.com: 60 s) — macOS's mDNSResponder and
 * 1.1.1.1/8.8.8.8 alike — so every probe in the next minute fails (measured 2026-10-16: the URL
 * in ~5 s, a public answer only at ~67 s, three runs out of three). Authoritative servers cache
 * nothing, and asking them leaves no negative answer in the public resolvers the phone may use.
 * Only an authoritative NXDOMAIN is final (the name is not there yet); anything else — no answer,
 * ENODATA (e.g. a CNAME out of the zone), a refused query — falls through to the next stage.
 */
export async function resolveFreshName(hostname: string, st: FreshDnsStages = realStages): Promise<string> {
  const ms = st.stageMs ?? DNS_STAGE_MS;
  const servers = await within(st.zone(hostname), ms * 2, null);
  if (servers?.length) {
    const r = await within(st.at(servers, hostname), ms, 'ETIMEOUT');
    if (Array.isArray(r) && r.length) return r[0];
    if (r === 'ENOTFOUND') throw Object.assign(new Error(`${hostname} is not published yet`), { code: 'ENOTFOUND' });
  }
  const pub = await within(st.at(PUBLIC_RESOLVERS, hostname), ms, 'ETIMEOUT');
  if (Array.isArray(pub) && pub.length) return pub[0];
  return st.system(hostname);
}

/**
 * One GET over https to a fresh name: resolved FIRST ({@link resolveFreshName}, its own timers),
 * so `timeoutMs` covers only the connection and the answer. TLS is still verified against the
 * hostname; only the address comes from the lookup.
 */
export async function getWithFreshDns(url: string, header: string, timeoutMs = 5000): Promise<{ status: number; value: string | null }> {
  const u = new URL(url);
  const address = await resolveFreshName(u.hostname);
  return new Promise((resolveGet, reject) => {
    const lookup = (_h: string, opts: { all?: boolean } | ((...a: unknown[]) => void), cb?: (...a: unknown[]) => void): void => {
      const done = (typeof opts === 'function' ? opts : cb)!;
      if (typeof opts === 'object' && opts?.all) done(null, [{ address, family: 4 }]); else done(null, address, 4);
    };
    const req = https.request({
      host: u.hostname, servername: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      lookup: lookup as never, timeout: timeoutMs, headers: { 'Cache-Control': 'no-store' },
    }, (res) => {
      res.resume();
      const raw = res.headers[header.toLowerCase()];
      resolveGet({ status: res.statusCode ?? 0, value: typeof raw === 'string' ? raw : null });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** A quick tunnel's DNS record is published 4-8 s after cloudflared prints its URL (measured
 *  2026-10-16); the probe asks nobody before this. */
export const QUICK_DNS_GRACE_MS = 10_000;
/** Covers the grace plus one 60 s negative-cache miss, should the record still come late. */
export const QUICK_PROBE_BUDGET_MS = 85_000;

/**
 * The reachability probe: GET `<url>/api/health` until the phone listener's per-start value
 * comes back in {@link MAC_PROBE_HEADER} (retrying within `budgetMs`; a quick tunnel's first ask
 * waits {@link QUICK_DNS_GRACE_MS} so it never caches the name's absence). Proves the tunnel reaches THIS listener; the value is
 * public and never authenticates anything.
 */
export async function probeReachable(url: string, nonce: string, o: { header: string; budgetMs?: number; get?: typeof getWithFreshDns; stepMs?: number; firstAskAfterMs?: number }): Promise<boolean> {
  const get = o.get ?? getWithFreshDns;
  const until = Date.now() + (o.budgetMs ?? 30_000);
  // Asking before the record is published caches the NXDOMAIN for the zone's negative TTL, even
  // at Cloudflare's authoritative edge (see resolveFreshName): wait first, ask once it exists.
  if (o.firstAskAfterMs) await new Promise((r) => setTimeout(r, o.firstAskAfterMs));
  while (Date.now() < until) {
    try {
      const r = await get(`${url.replace(/\/+$/, '')}/api/health`, o.header);
      if (r.value === nonce) return true;
    } catch { /* not resolvable yet */ }
    await new Promise((r) => setTimeout(r, o.stepMs ?? 1000));
  }
  return false;
}

// ─── Watchdog ───────────────────────────────────────────────────────────────

/**
 * A `/bin/sh` loop that outlives a crashed server: every 2 s it checks the server pid; once that
 * is gone it SIGTERMs the tunnel pid — only if that pid is still OUR cloudflared (its command
 * names `binPath`), never a process that reused the number. Detached and unref'd.
 */
export function watchdogScript(serverPid: number, tunnelPid: number, binPath: string): string {
  if (!Number.isInteger(serverPid) || !Number.isInteger(tunnelPid) || serverPid <= 1 || tunnelPid <= 1) throw new Error('invalid pid');
  if (!/^\/[A-Za-z0-9._/ -]+$/.test(binPath)) throw new Error('invalid binary path');
  const quoted = `'${binPath.replace(/'/g, `'\\''`)}'`;
  return [
    `while /bin/kill -0 ${serverPid} 2>/dev/null; do /bin/sleep 2; done`,
    `case "$(/bin/ps -o command= -p ${tunnelPid} 2>/dev/null)" in ${quoted}*) /bin/kill -TERM ${tunnelPid} 2>/dev/null;; esac`,
  ].join('\n');
}

export function startWatchdog(serverPid: number, tunnelPid: number, binPath: string, spawnImpl: typeof spawn = spawn): ChildProcess {
  const child = spawnImpl('/bin/sh', ['-c', watchdogScript(serverPid, tunnelPid, binPath)], {
    stdio: 'ignore', detached: true, env: { PATH: '/usr/bin:/bin' },
  });
  child.unref();
  return child;
}

// ─── Supervisor ─────────────────────────────────────────────────────────────

export const MAX_RESTARTS = 5;
export const RESTART_WINDOW_MS = 10 * 60_000;

export interface SupervisorEvents {
  /** A (re)start produced this URL (a quick tunnel's changes on every restart). */
  onUrl: (url: string, restarted: boolean) => void;
  /** The tunnel stopped for good (restart budget spent, or a restart failed). */
  onGiveUp: (reason: string) => void;
}

/**
 * Keeps one tunnel running until {@link stop}: an unexpected exit restarts it, at most
 * {@link MAX_RESTARTS} times per {@link RESTART_WINDOW_MS}. It NEVER closes the tunnel on its
 * own for being idle (owner decision) — only `stop` (Return) does.
 */
export class TunnelSupervisor {
  private current: RunningTunnel | null = null;
  private watchdog: ChildProcess | null = null;
  private stopped = false;
  private restarts: number[] = [];

  constructor(private readonly opts: StartTunnelOptions & { serverPid: number; now?: () => number; startImpl?: typeof startTunnel; watchdogImpl?: typeof startWatchdog }, private readonly events: SupervisorEvents) {}

  get pid(): number | null { return this.current?.child.pid ?? null; }
  get watchdogPid(): number | null { return this.watchdog?.pid ?? null; }
  get url(): string | null { return this.current?.url ?? null; }

  async start(): Promise<RunningTunnel> {
    const run = await (this.opts.startImpl ?? startTunnel)(this.opts);
    this.attach(run);
    this.events.onUrl(run.url, false);
    return run;
  }

  private attach(run: RunningTunnel): void {
    this.current = run;
    if (run.child.pid) {
      try { this.watchdog?.kill('SIGTERM'); } catch { /* gone */ }
      this.watchdog = (this.opts.watchdogImpl ?? startWatchdog)(this.opts.serverPid, run.child.pid, this.opts.bin);
    }
    run.child.once('exit', () => { if (!this.stopped && this.current === run) void this.restart(); });
  }

  private async restart(): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    this.restarts = this.restarts.filter((t) => t > now - RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) { this.current = null; this.events.onGiveUp('restart_budget'); return; }
    this.restarts.push(now);
    try {
      const run = await (this.opts.startImpl ?? startTunnel)(this.opts);
      if (this.stopped) { try { run.child.kill('SIGTERM'); } catch { /* gone */ } return; }
      this.attach(run);
      this.events.onUrl(run.url, true);
    } catch (err) {
      this.current = null;
      this.events.onGiveUp((err as Error).message);
    }
  }

  /** Return: the tunnel and its watchdog end; resolves once cloudflared exited (SIGKILL after 3 s). */
  async stop(): Promise<void> {
    this.stopped = true;
    const run = this.current;
    this.current = null;
    try { this.watchdog?.kill('SIGTERM'); } catch { /* gone */ }
    this.watchdog = null;
    if (!run) return;
    const child = run.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((r) => {
      const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
      child.once('exit', () => { clearTimeout(kill); r(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(kill); r(); }
    });
  }
}

// ─── Fixed address setup ────────────────────────────────────────────────────

export type CommandRunner = (file: string, args: string[], opts: { env: Record<string, string>; cwd: string; timeoutMs?: number; onLine?: (line: string) => void }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const defaultCommandRunner: CommandRunner = (file, args, opts) => new Promise((resolveRun, reject) => {
  const child = spawn(file, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, opts.timeoutMs) : null;
  const lines = (d: Buffer, acc: 'o' | 'e') => {
    const s = d.toString('utf8');
    if (acc === 'o') stdout += s; else stderr += s;
    if (opts.onLine) for (const l of s.split('\n')) if (l.trim()) opts.onLine(l);
  };
  child.stdout.on('data', (d: Buffer) => lines(d, 'o'));
  child.stderr.on('data', (d: Buffer) => lines(d, 'e'));
  child.once('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
  child.once('close', (code) => { if (timer) clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
});

export const FIXED_TUNNEL_NAME = 'dreamcontext-hf';

/** The hostname already has a DNS record: routing it to the tunnel would replace that record. */
export class HostnameInUseError extends Error {
  constructor(readonly hostname: string) { super(`${hostname} already has a DNS record`); }
}

/** Does the hostname already answer in public DNS (A, AAAA or CNAME)? Asked of public resolvers,
 *  so a stale local cache cannot hide a live site. A lookup that fails says "no record". */
export async function hostnameHasRecord(hostname: string): Promise<boolean> {
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  try { resolver.setServers(PUBLIC_RESOLVERS); } catch { /* keep defaults */ }
  const any = (p: Promise<unknown[]>) => p.then((r) => r.length > 0, () => false);
  const answers = await Promise.all([any(resolver.resolve4(hostname)), any(resolver.resolve6(hostname)), any(resolver.resolveCname(hostname))]);
  return answers.some(Boolean);
}

/**
 * Set up the fixed address (a locally-managed named tunnel): `login` (the owner's browser opens
 * the URL it prints), `create`, `route dns`, then the zone-wide cert is deleted. `login` runs with
 * HOME = a private dir inside the Mac dir, so it writes its cert THERE, never to the owner's
 * `~/.cloudflared`. The credentials JSON lands 0600 in the Mac dir; its contents are never read
 * back into any response or log. The hostname's DNS record is NEVER replaced unless
 * `overwriteDns` (the owner confirmed it): a name that already resolves is refused with
 * {@link HostnameInUseError} before the login, and Cloudflare's own "already exists" on
 * `route dns` maps to the same error.
 */
export async function setupFixedTunnel(o: { bin: string; macDir: string; hostname: string; overwriteDns?: boolean; hostnameInUse?: (hostname: string) => Promise<boolean>; run?: CommandRunner; onLoginUrl?: (url: string) => void; loginTimeoutMs?: number }): Promise<FixedTunnelRecord> {
  const hostname = o.hostname.trim().toLowerCase();
  if (!isValidHostname(hostname)) throw new Error('invalid hostname');
  if (!o.overwriteDns && await (o.hostnameInUse ?? hostnameHasRecord)(hostname)) throw new HostnameInUseError(hostname);
  const run = o.run ?? defaultCommandRunner;
  const loginHome = join(o.macDir, 'cf-login');
  rmSync(loginHome, { recursive: true, force: true });
  mkdirSync(loginHome, { recursive: true, mode: 0o700 });
  const cert = join(loginHome, '.cloudflared', 'cert.pem');
  const env = cloudflaredEnv(loginHome);
  try {
    const login = await run(o.bin, ['tunnel', 'login'], {
      env, cwd: o.macDir, timeoutMs: o.loginTimeoutMs ?? 10 * 60_000,
      onLine: (l) => { const m = /https:\/\/dash\.cloudflare\.com\/\S+/.exec(l); if (m) o.onLoginUrl?.(m[0]); },
    });
    if (login.code !== 0 || !existsSync(cert)) throw new Error('cloudflare login did not finish');
    const creds = fixedCredentialsPath(o.macDir);
    rmSync(creds, { force: true });
    const created = await run(o.bin, ['tunnel', '--origincert', cert, 'create', '--credentials-file', creds, FIXED_TUNNEL_NAME], { env, cwd: o.macDir, timeoutMs: 60_000 });
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(created.stdout + created.stderr)?.[1];
    if (created.code !== 0 || !id || !existsSync(creds)) throw new Error('could not create the tunnel');
    chmodSync(creds, 0o600);
    const routed = await run(o.bin, ['tunnel', '--origincert', cert, 'route', 'dns', ...(o.overwriteDns ? ['--overwrite-dns'] : []), FIXED_TUNNEL_NAME, hostname], { env, cwd: o.macDir, timeoutMs: 60_000 });
    if (routed.code !== 0 && /already exists/i.test(routed.stdout + routed.stderr)) {
      // The tunnel we just created must not outlive the refusal: the owner's confirmed retry
      // creates it again under the same name, which Cloudflare refuses while this one exists.
      await run(o.bin, ['tunnel', '--origincert', cert, 'delete', '-f', FIXED_TUNNEL_NAME], { env, cwd: o.macDir, timeoutMs: 60_000 }).catch(() => null);
      rmSync(creds, { force: true });
      throw new HostnameInUseError(hostname);
    }
    if (routed.code !== 0) throw new Error('could not route the hostname to the tunnel');
    const rec: FixedTunnelRecord = { hostname, tunnelId: id, name: FIXED_TUNNEL_NAME };
    writeFileSync(fixedRecordPath(o.macDir), JSON.stringify(rec), { mode: 0o600 });
    return rec;
  } finally {
    // The zone-wide cert can manage every tunnel on the account: it never outlives setup.
    rmSync(loginHome, { recursive: true, force: true });
  }
}

/** Forget the fixed address locally (the credentials JSON and our record). */
export function removeFixedTunnel(macDir: string): void {
  for (const p of [fixedRecordPath(macDir), fixedCredentialsPath(macDir), fixedConfigPath(macDir)]) {
    try { unlinkSync(p); } catch { /* absent */ }
  }
}

/** True when `pid`'s command line is one of our pinned cloudflared binaries. */
export function isOurCloudflared(command: string, home: string = homedir()): boolean {
  const prefix = resolve(binDir(home), 'cloudflared-');
  return command.trim().startsWith(prefix);
}
