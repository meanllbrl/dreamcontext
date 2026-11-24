/**
 * Live links (tunel-paylasim plan r3): one app or one whiteboard shared over its OWN Cloudflare
 * quick tunnel, pointed at its OWN 127.0.0.1 listener, so every share has its own public origin
 * (D1). Shares live in memory only (D3): a quit, a restart or a crash ends every one, and the
 * boot sweep removes what a dead server left behind.
 *
 * States: `starting` (stage `download` | `tunnel` | `probe`), `open`, `closing` (the 60 s grace of
 * an owner close, D13), `broken` (cloudflared died or a stage failed: the row stays so the owner
 * reads "Bağlantı koptu"), then gone. {@link closeShare} works from every state and resolves after
 * the bounded steps 1-4; the teardown (steps 5-7) runs after the grace or at once, never awaited by
 * a caller but {@link closeAllShares}.
 *
 * Secrets: the link's token and the password live here and are handed out ONLY by
 * {@link revealShare} (the owner's page). {@link publicShare} never carries them.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  binDir, ensureCloudflared, probeReachable, QUICK_DNS_GRACE_MS, QUICK_PROBE_BUDGET_MS,
  startQuickTunnel, startWatchdog, type QuickTunnelOptions, type RunningTunnel,
} from '../../lib/handsfree/mac/tunnel.js';
import { AwakeHold } from './awake.js';

export type ShareKind = 'app' | 'board';
export type ShareState = 'starting' | 'open' | 'closing' | 'broken';
export type ShareStage = 'download' | 'tunnel' | 'probe';
export type CloseReason = 'owner' | 'cli' | 'removed' | 'board_gone' | 'broken' | 'shutdown';

/** The probe answers this header with the share's per-start nonce (public: proves routing only). */
export const SHARE_PROBE_HEADER = 'X-Dreamcontext-Share-Probe';
export const SHARE_PROBE_PATH = '/__share/probe';
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
/** Download, URL and probe deadlines (C5). */
export const DOWNLOAD_DEADLINE_MS = 120_000;
export const URL_DEADLINE_MS = 30_000;
/** The closed-page grace after an owner close of an open share (D13). */
export const CLOSE_GRACE_MS = 60_000;
/** A guest counts as "connected" while its session made a request within this. */
export const PEOPLE_WINDOW_MS = 60_000;

export class ShareError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** What a kind resolves a `{vault, slug}` to (synchronously: the D9 reservation needs no await). */
export interface KindTarget {
  /** Shown in the list and on the guest's door pages. */
  name: string;
  /** One live share per key (D9): `app:<hash>`, `board:<project>:<slug>`. */
  key: string;
  /** Held from start to step 2 of the close (C9: an app's runtime lease). Returns its release. */
  hold?: () => () => void;
}

export interface ShareKindHandler {
  resolve(input: { vault: string; slug: string }): KindTarget;
  /** A guest request with a live session. Never a dashboard handler. */
  serve(share: Share, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> | void;
  /** A guest WebSocket upgrade with a live session and the share's own Origin. */
  upgrade?(share: Share, req: IncomingMessage, sock: Duplex, head: Buffer): void;
}

export interface Share {
  readonly id: string;
  readonly kind: ShareKind;
  readonly vault: string;
  readonly slug: string;
  readonly name: string;
  readonly key: string;
  readonly ownerName: string | null;
  state: ShareState;
  stage: ShareStage | null;
  error: string | null;
  /** 32 random bytes, base64url: the link's path credential. */
  readonly token: string;
  /** In memory only (D7); read back only through the owner's reveal. */
  readonly password: string | null;
  readonly passwordDigest: Buffer | null;
  readonly ai: boolean;
  readonly openedAt: string;
  host: string | null;
  origin: string | null;
  readonly nonce: string;
  /** Prefix of the cookies an app backend sets for this share's guests (C6). */
  readonly cookiePrefix: string;
  /** Guest sessions: value → last request (ms). LRU order (oldest first). */
  readonly sessions: Map<string, number>;
  /** Password door tickets: value → expiry (ms). */
  readonly tickets: Map<string, number>;
  /** Every socket the share's listener accepted. */
  readonly sockets: Set<Duplex>;
  /** Every upstream socket opened for its guests (gateway HTTP and WebSocket pipes). */
  readonly upstream: Set<Duplex>;
  /** Per-kind state (the board viewer's misses). */
  readonly data: Record<string, unknown>;
  listener: Server | null;
  port: number;
  releasePort: (() => void) | null;
  child: ChildProcess | null;
  watchdog: ChildProcess | null;
  readonly abort: AbortController;
  graceTimer: NodeJS.Timeout | null;
  releaseHold: (() => void) | null;
  awake: boolean;
  readonly dir: string;
  teardown: Promise<void> | null;
}

/** What `GET /api/shares` and `dreamcontext shares list` show: never the link, token or password. */
export interface PublicShare {
  id: string;
  kind: ShareKind;
  vault: string;
  slug: string;
  name: string;
  state: ShareState;
  stage: ShareStage | null;
  error?: string;
  people: number;
  password: boolean;
  ai: boolean;
  openedAt: string;
}

// ─── Dependencies (real by default; the tests swap them) ────────────────────

export type ListenerStart = (share: Share) => Promise<{ server: Server; port: number; release: () => void }>;

export interface ShareDeps {
  home: string;
  serverPid: number;
  ensureBinary: (o: { signal: AbortSignal; deadlineMs: number }) => Promise<string>;
  startTunnel: (o: QuickTunnelOptions) => Promise<RunningTunnel>;
  probe: (url: string, nonce: string, o: { header: string; path: string; signal: AbortSignal; firstAskAfterMs: number; budgetMs: number }) => Promise<boolean>;
  watchdog: (serverPid: number, tunnelPid: number, bin: string) => ChildProcess | null;
  /** The share listener (listener.ts registers the real one, so this module never imports it). */
  startListener: ListenerStart | null;
  awake: AwakeHold;
  graceMs: number;
  killAfterMs: number;
  now: () => number;
  log: (line: string) => void;
}

function realDeps(): ShareDeps {
  return {
    home: homedir(),
    serverPid: process.pid,
    ensureBinary: (o) => ensureCloudflared({ signal: o.signal, deadlineMs: o.deadlineMs }),
    startTunnel: (o) => startQuickTunnel(o),
    probe: (url, nonce, o) => probeReachable(url, nonce, o),
    watchdog: (s, t, b) => { try { return startWatchdog(s, t, b); } catch { return null; } },
    startListener: null,
    awake: new AwakeHold(),
    graceMs: CLOSE_GRACE_MS,
    killAfterMs: 3000,
    now: () => Date.now(),
    log: (l) => console.warn(l),
  };
}

let deps: ShareDeps = realDeps();
const kinds = new Map<ShareKind, ShareKindHandler>();
const shares = new Map<string, Share>();

/** The listener module wires its start here (no import cycle). */
export function setShareListenerStart(start: ListenerStart): void {
  deps.startListener = start;
  realListenerStart = start;
}
let realListenerStart: ListenerStart | null = null;

/** app-kind.ts / board-kind.ts register themselves. */
export function registerShareKind(kind: ShareKind, handler: ShareKindHandler): void {
  kinds.set(kind, handler);
}

export function shareKind(kind: ShareKind): ShareKindHandler | null {
  return kinds.get(kind) ?? null;
}

/** Tests only: swap dependencies (and forget every share without tearing it down). */
export function configureSharesForTests(patch: Partial<ShareDeps> | null): void {
  if (patch === null) { deps = realDeps(); deps.startListener = realListenerStart; shares.clear(); return; }
  deps = { ...deps, ...patch };
}

export function shareDeps(): Readonly<ShareDeps> {
  return deps;
}

export function sharesRoot(home: string = deps.home): string {
  return join(home, '.dreamcontext', 'shares');
}

// ─── Open ───────────────────────────────────────────────────────────────────

export interface OpenInput {
  kind: string;
  vault: string;
  slug: string;
  password?: string | null;
  ai?: boolean;
  ownerName?: string | null;
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

function liveFor(key: string): Share | null {
  for (const s of shares.values()) if (s.key === key && (s.state === 'starting' || s.state === 'open')) return s;
  return null;
}

/**
 * Open a live link: validate, resolve the target and RESERVE it synchronously (D9: a second press
 * while one is starting or open gets that share), then start in the background.
 * `{ share, existing }`; throws {@link ShareError} (400 / 404).
 */
export function openShare(input: OpenInput): { share: Share; existing: boolean } {
  if (input.kind !== 'app' && input.kind !== 'board') throw new ShareError(400, 'bad_kind', 'kind must be app or board.');
  const handler = kinds.get(input.kind);
  if (!handler) throw new ShareError(503, 'kind_unavailable', `Live links for ${input.kind} are not available.`);
  if (typeof input.vault !== 'string' || !input.vault || typeof input.slug !== 'string' || !input.slug) throw new ShareError(400, 'bad_target', 'vault and slug are required.');
  const password = typeof input.password === 'string' && input.password !== '' ? input.password : null;
  if (password !== null && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) {
    throw new ShareError(400, 'weak_password', `The password needs at least ${PASSWORD_MIN} characters.`);
  }
  const target = handler.resolve({ vault: input.vault, slug: input.slug });
  const live = liveFor(target.key);
  if (live) return { share: live, existing: true };
  const id = randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
  const share: Share = {
    id, kind: input.kind, vault: input.vault, slug: input.slug, name: target.name, key: target.key,
    ownerName: input.ownerName ?? null,
    state: 'starting', stage: 'download', error: null,
    token: randomBytes(32).toString('base64url'),
    password, passwordDigest: password === null ? null : digest(password),
    ai: input.kind === 'app' && input.ai === true,
    openedAt: new Date(deps.now()).toISOString(),
    host: null, origin: null,
    nonce: randomBytes(16).toString('hex'),
    cookiePrefix: `dcs${randomBytes(6).toString('hex')}.`,
    sessions: new Map(), tickets: new Map(), sockets: new Set(), upstream: new Set(), data: {},
    listener: null, port: 0, releasePort: null, child: null, watchdog: null,
    abort: new AbortController(), graceTimer: null, releaseHold: null, awake: false,
    dir: join(sharesRoot(), id), teardown: null,
  };
  shares.set(id, share);
  void startShare(share, target).catch((e) => deps.log(`[shares] ${id}: ${(e as Error).message}`));
  return { share, existing: false };
}

async function startShare(share: Share, target: KindTarget): Promise<void> {
  const signal = share.abort.signal;
  const alive = (): boolean => share.state === 'starting' && !signal.aborted;
  try {
    mkdirSync(share.dir, { recursive: true, mode: 0o700 });
    if (lstatSync(share.dir).isSymbolicLink()) throw new ShareError(500, 'bad_dir', 'share dir is a symlink');
    if (!deps.startListener) throw new ShareError(500, 'no_listener', 'share listener not wired');
    const l = await deps.startListener(share);
    share.listener = l.server;
    share.port = l.port;
    share.releasePort = l.release;
    if (!alive()) { stopListener(share); return; }
    if (target.hold) share.releaseHold = target.hold();
    share.stage = 'download';
    let bin: string;
    try { bin = await deps.ensureBinary({ signal, deadlineMs: DOWNLOAD_DEADLINE_MS }); }
    catch (e) { throw Object.assign(new Error((e as Error).message), { code: 'download_failed' }); }
    if (!alive()) return;
    share.stage = 'tunnel';
    let run: RunningTunnel;
    try {
      run = await deps.startTunnel({
        bin, dir: share.dir, port: share.port, signal, timeoutMs: URL_DEADLINE_MS,
        onSpawn: (child) => {
          share.child = child;
          if (child.pid) {
            try { writeFileSync(join(share.dir, 'pid'), String(child.pid), { mode: 0o600 }); } catch { /* the sweep then skips it */ }
            share.watchdog = deps.watchdog(deps.serverPid, child.pid, bin);
          }
          child.once('exit', () => onChildExit(share, child));
        },
      });
    } catch (e) { throw Object.assign(new Error((e as Error).message), { code: 'tunnel_failed' }); }
    if (!alive()) return;
    const u = new URL(run.url);
    share.host = u.host;
    share.origin = u.origin;
    share.stage = 'probe';
    const ok = await deps.probe(run.url, share.nonce, {
      header: SHARE_PROBE_HEADER, path: SHARE_PROBE_PATH, signal, firstAskAfterMs: QUICK_DNS_GRACE_MS, budgetMs: QUICK_PROBE_BUDGET_MS,
    });
    if (!alive()) return;
    if (!ok) throw Object.assign(new Error('the link did not answer in time'), { code: 'probe_failed' });
    share.state = 'open';
    share.stage = null;
    deps.awake.acquire(share.id);
    share.awake = true;
  } catch (e) {
    if (share.state !== 'starting') return;
    share.error = String((e as { code?: unknown }).code ?? 'start_failed');
    deps.log(`[shares] ${share.id} did not start (${share.error})`);
    await closeShare(share.id, 'broken');
  }
}

function onChildExit(share: Share, child: ChildProcess): void {
  if (share.child !== child) return;
  if (share.state === 'starting' || share.state === 'open') {
    if (!share.error) share.error = 'tunnel_exited';
    void closeShare(share.id, 'broken');
  } else if (share.state === 'closing' && share.graceTimer) {
    // The grace just ends: the link is dead either way.
    clearTimeout(share.graceTimer);
    share.graceTimer = null;
    void beginTeardown(share);
  }
}

// ─── Close ──────────────────────────────────────────────────────────────────

const step = (share: Share, what: string, fn: () => void): void => {
  try { fn(); } catch (e) { deps.log(`[shares] ${share.id} ${what}: ${(e as Error).message}`); }
};

/**
 * Close one share from any state (C5). Resolves after steps 1-4 (bounded, synchronous); the
 * teardown follows after the 60 s grace when an owner or the CLI closes an OPEN share, else at
 * once. A later call during the grace, with any reason, tears down at once.
 */
export function closeShare(id: string, reason: CloseReason): Promise<void> {
  const share = shares.get(id);
  if (!share) return Promise.resolve();
  if (share.state === 'broken') {
    // Its teardown already runs; an owner or CLI close dismisses the row.
    if (reason !== 'broken') { if (!share.teardown) void beginTeardown(share); shares.delete(id); }
    return Promise.resolve();
  }
  if (share.state === 'closing') {
    if (share.graceTimer) { clearTimeout(share.graceTimer); share.graceTimer = null; }
    void beginTeardown(share);
    return Promise.resolve();
  }
  const graceful = (reason === 'owner' || reason === 'cli') && share.state === 'open';
  // (1) Every gate refuses this share from here.
  share.state = reason === 'broken' ? 'broken' : 'closing';
  share.stage = null;
  // (2) Sessions and door tickets; the app lease (only the closed page is served from now).
  step(share, 'sessions', () => { share.sessions.clear(); share.tickets.clear(); });
  step(share, 'hold', () => { const r = share.releaseHold; share.releaseHold = null; r?.(); });
  // (3) Every socket its listener accepted and every upstream pipe opened for it.
  step(share, 'sockets', () => {
    for (const s of share.sockets) { try { s.destroy(); } catch { /* gone */ } }
    for (const s of share.upstream) { try { s.destroy(); } catch { /* gone */ } }
    share.upstream.clear();
  });
  // (4) A starting share's download is detached and its child killed (startQuickTunnel's abort).
  step(share, 'abort', () => share.abort.abort());
  if (graceful) {
    const t = setTimeout(() => {
      if (share.graceTimer !== t) return; // a stronger close already ran
      share.graceTimer = null;
      void beginTeardown(share).catch((e) => deps.log(`[shares] ${share.id} teardown: ${(e as Error).message}`));
    }, deps.graceMs);
    t.unref?.();
    share.graceTimer = t;
  } else {
    void beginTeardown(share);
  }
  return Promise.resolve();
}

function stopListener(share: Share): void {
  const srv = share.listener;
  share.listener = null;
  step(share, 'listener', () => {
    if (srv) {
      srv.close(() => { /* closed */ });
      srv.closeAllConnections?.();
    }
    for (const s of share.sockets) { try { s.destroy(); } catch { /* gone */ } }
    share.sockets.clear();
  });
  step(share, 'port', () => { const r = share.releasePort; share.releasePort = null; r?.(); });
}

function killChild(share: Share): Promise<void> {
  const child = share.child;
  step(share, 'watchdog', () => { share.watchdog?.kill('SIGTERM'); share.watchdog = null; });
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((r) => {
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(); }, deps.killAfterMs);
    kill.unref?.();
    const finish = (): void => { clearTimeout(kill); r(); };
    child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch { finish(); }
  });
}

/** Steps 5-7, once per share (idempotent). */
function beginTeardown(share: Share): Promise<void> {
  if (share.teardown) return share.teardown;
  if (share.graceTimer) { clearTimeout(share.graceTimer); share.graceTimer = null; }
  share.teardown = (async () => {
    // (5) Listener and port claim, cloudflared (SIGTERM, SIGKILL after 3 s), watchdog.
    stopListener(share);
    await killChild(share).catch(() => undefined);
    // (6) The app lease (if step 2 did not run) and the awake hold.
    step(share, 'hold', () => { const r = share.releaseHold; share.releaseHold = null; r?.(); });
    step(share, 'awake', () => { if (share.awake) { share.awake = false; deps.awake.release(share.id); } });
    // (7) Its dir.
    step(share, 'dir', () => rmSync(share.dir, { recursive: true, force: true }));
    if (share.state !== 'broken' && shares.get(share.id) === share) shares.delete(share.id);
  })();
  return share.teardown;
}

/** Close every share whose target key matches (an app removed, a board deleted). */
export function closeSharesFor(key: string, reason: CloseReason): Promise<void> {
  for (const s of [...shares.values()]) if (s.key === key) void closeShare(s.id, reason);
  return Promise.resolve();
}

/** Close every share and wait for every teardown (server shutdown: bounded by the 3 s SIGKILL). */
export async function closeAllShares(reason: CloseReason): Promise<void> {
  const all = [...shares.values()];
  for (const s of all) void closeShare(s.id, reason);
  // An owner's "Close all" leaves open shares in their grace (no teardown yet); every other
  // reason has started each teardown synchronously above.
  await Promise.all(all.map((s) => s.teardown ?? Promise.resolve()));
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export function getShare(id: string): Share | null {
  return shares.get(id) ?? null;
}

export function allShares(): Share[] {
  return [...shares.values()];
}

/** The one-live-share key of an app (D9, C10): every share of that app hash. */
export function appShareKey(hash: string): string {
  return `app:${hash}`;
}

/** C10: the app has a share that is starting or open (the shared-live window). */
export function sharedLive(key: string): boolean {
  return liveFor(key) !== null;
}

/** The live share (`starting`/`open`) of a key, for its AI flag; never a closing one. */
export function liveShare(key: string): Share | null {
  return liveFor(key);
}

export function peopleOf(share: Share, now: number = deps.now()): number {
  let n = 0;
  for (const last of share.sessions.values()) if (now - last < PEOPLE_WINDOW_MS) n++;
  return n;
}

export function publicShare(share: Share): PublicShare {
  return {
    id: share.id, kind: share.kind, vault: share.vault, slug: share.slug, name: share.name,
    state: share.state, stage: share.stage, ...(share.error ? { error: share.error } : {}),
    people: peopleOf(share), password: share.passwordDigest !== null, ai: share.ai, openedAt: share.openedAt,
  };
}

export function listShares(): PublicShare[] {
  return allShares().map(publicShare);
}

/** The owner's reveal: the link (and password) of an OPEN share, else null. */
export function revealShare(id: string): { link: string; password?: string } | null {
  const s = shares.get(id);
  if (!s || s.state !== 'open' || !s.origin) return null;
  return { link: `${s.origin}/k/${s.token}`, ...(s.password !== null ? { password: s.password } : {}) };
}

// ─── Boot sweep ─────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * At boot: remove every `~/.dreamcontext/shares/<id>/` whose recorded cloudflared is not alive
 * (a crashed server's leftovers; its watchdog already ended the process), and stray
 * `.cloudflared-<hex>` download dirs older than 10 minutes. A dir whose process still runs is
 * left alone (another server may own it).
 */
export function sweepShareDirs(home: string = deps.home, alive: (pid: number) => boolean = pidAlive): void {
  const root = sharesRoot(home);
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (!/^[A-Za-z0-9]{6,32}$/.test(name)) continue;
      const dir = join(root, name);
      try {
        if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue;
        let pid = 0;
        try { pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim()); } catch { /* none recorded */ }
        if (Number.isInteger(pid) && pid > 1 && alive(pid)) continue;
        rmSync(dir, { recursive: true, force: true });
      } catch { /* next */ }
    }
  }
  const bins = binDir(home);
  if (existsSync(bins)) {
    for (const name of readdirSync(bins)) {
      if (!/^\.cloudflared-[0-9a-f]{12}$/.test(name)) continue;
      const p = join(bins, name);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        if (Date.now() - statSync(p).mtimeMs < 10 * 60_000) continue;
        rmSync(p, { recursive: true, force: true });
      } catch { /* next */ }
    }
  }
}
