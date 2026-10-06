/**
 * The LAPTOP's hands-free routes (the wave 3 UI calls them; the CLI calls the same lib
 * functions in `src/lib/handsfree/orchestrator.ts`).
 *
 * Every route: desktop app + a loopback peer + same-site, and refused when the request
 * carries the network token, a forwarding header (a tailnet / proxy hop), a transfer proof,
 * or a non-loopback Host (AC4, laptop part). They never live under `/api/handsfree/cloud/`
 * and never use the names `login` / `logout` (those are the cloud's). Long operations run
 * as ONE server-side job at a time (the `src/server/sync-job.ts` shape): the POST starts it,
 * `GET /api/handsfree/jobs/current` polls it.
 *
 * Also here: {@link handsfreeLockRefusal}, the ONE lock middleware `index.ts` runs (D3/AC6).
 */
import { IncomingMessage, type ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { listVaults } from '../../lib/vaults.js';
import { isCloud } from '../cloud-mode.js';
import { isDesktop } from '../desktop.js';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isLoopback } from './agent-spawn-shared.js';
import { AUTH_COOKIE } from '../network-auth.js';
import { cutLiveChats, liveChatsSnapshot } from './agent-chat-live.js';
import { cutPtySessionsUnder, ptySessionsUnder } from './agent-terminal.js';
import { readRosterSurface, writeMergedRosterSurfaceAsync } from './agent-sessions.js';
import { cutDetachedRunsUnder, detachedRunsUnder } from '../../lib/automations/runner.js';
import { assertTripId } from '../../lib/handsfree/git-snapshot.js';
import { laptopEnv } from '../../lib/handsfree/laptop-env.js';
import {
  abandonTrip, go, HandsfreeError, readReceipt, resumeTrip, returnTrip, revokeAllDevices, rollbackTrip, status, type HandsfreeEnv, type Progress,
} from '../../lib/handsfree/orchestrator.js';
import { handsfreeLockFor, type HandsfreeLock } from '../../lib/handsfree/trip-state.js';
import { processTurnControl, under, type RunningWork, type TurnControl } from '../../lib/handsfree/turns.js';
import { createSpawnRunner, gitPreflight } from '../../lib/handsfree/git-snapshot.js';
import type { RosterIO } from '../../lib/handsfree/session-merge.js';
import { computeScope, dirBytes, estimateRepoBytes, ScopeError } from '../../lib/handsfree/scope.js';
import { readConfig, RETURN_RESERVE_MINUTES, usedCoreMinutes } from '../../lib/handsfree/local-store.js';
import { coresFor } from '../../lib/handsfree/provider.js';
import { readTripState } from '../../lib/handsfree/trip-state.js';

// ---------------------------------------------------------------- the gate (AC4, laptop part)

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function carriesNetworkToken(req: IncomingMessage): boolean {
  const cookie = req.headers.cookie ?? '';
  if (cookie.split(';').some((p) => p.split('=')[0].trim() === AUTH_COOKIE)) return true;
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams.has('token');
  } catch {
    return true;
  }
}

/** Why a laptop hands-free request is refused, or null when it may pass. */
export function laptopRouteRefusal(req: IncomingMessage): { status: number; code: string; message: string } | null {
  if (isCloud()) return { status: 404, code: 'not_found', message: 'No such route in the cloud.' };
  if (!isDesktop()) return { status: 403, code: 'desktop_only', message: 'Hands-free mode is driven from the desktop app.' };
  if (!isLoopback(req)) return { status: 403, code: 'loopback_only', message: 'Hands-free mode is only reachable from this machine.' };
  if (carriesNetworkToken(req)) return { status: 403, code: 'loopback_only', message: 'Hands-free routes refuse network-token requests.' };
  if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) {
    return { status: 403, code: 'loopback_only', message: 'Hands-free routes refuse forwarded (tailnet or proxy) requests.' };
  }
  if (typeof req.headers.authorization === 'string' && req.headers.authorization.trim()) {
    return { status: 403, code: 'loopback_only', message: 'Hands-free routes take no credential.' };
  }
  const host = req.headers.host ?? '';
  if (!LOCAL_HOST_RE.test(host)) return { status: 403, code: 'loopback_only', message: 'Hands-free routes answer only on a loopback host name.' };
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN_RE.test(origin)) return { status: 403, code: 'forbidden', message: 'Cross-site request blocked.' };
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return { status: 403, code: 'forbidden', message: 'Cross-site request blocked.' };
  }
  return null;
}

function gate(req: IncomingMessage, res: ServerResponse): boolean {
  const r = laptopRouteRefusal(req);
  if (r) sendError(res, r.status, r.code, r.message);
  return !r;
}

// ---------------------------------------------------------------- the lock middleware (D3/AC6)

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The lock covering a mutating `/api/*` request scoped to `vaultRoot` (`hv ?? contextRoot`),
 * or null. `/api/handsfree/*` is exempt (go, return, the cloud's own transfer routes).
 */
export function handsfreeLockRefusal(method: string, pathname: string, vaultRoot: string | null, home?: string): HandsfreeLock | null {
  if (!MUTATING.has(method.toUpperCase()) || !pathname.startsWith('/api/')) return null;
  if (pathname === '/api/handsfree' || pathname.startsWith('/api/handsfree/')) return null;
  if (!vaultRoot) return null;
  return handsfreeLockFor(vaultRoot, home);
}

/**
 * Vault-agnostic mutating routes that pick their target vault from the BODY or the query
 * (`/api/launcher/connection {from,to}`, `/update {name}`, `/clone {parentDir}`, `/logo?vault=`,
 * assistant deliveries, …). The header-resolved effRoot never names it, so while away the
 * lock middleware screens these too.
 */
const BODY_SELECTOR_PREFIXES = ['/api/launcher/', '/api/assistant/', '/api/agent/accounts/'];
/** Single routes that carry a vault in the body (`/api/peer/send {vault}`). */
const BODY_SELECTOR_PATHS = ['/api/peer/send'];
const BODY_SCREEN_MAX = 32 * 1024 * 1024;
/** A body not finished within this is refused while away (never a slow-loris past the lock). */
const BODY_SCREEN_TIMEOUT_MS = 30_000;

export function isBodySelectorRoute(method: string, pathname: string): boolean {
  return MUTATING.has(method.toUpperCase()) && (BODY_SELECTOR_PREFIXES.some((p) => pathname.startsWith(p)) || BODY_SELECTOR_PATHS.includes(pathname));
}

/** EVERY string of a parsed body, iteratively (no depth or count cap: the size cap bounds it). */
function stringsOf(root: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) stack.push(x);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); stack.push(x); }
  }
  return out;
}

/** Every quoted string of a body that is not valid JSON (or nests past what JSON.parse takes). */
function quotedStringsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try { out.push(JSON.parse(`"${m[1]}"`) as string); } catch { out.push(m[1]); }
  }
  out.push(text);
  return out;
}

/**
 * The lock covering any vault a body/query names: a registered vault NAME (case-insensitive),
 * an absolute path, a `~/` path, or a relative path (against the server's cwd). Null when none
 * is inside a locked root.
 */
export function bodySelectedVaultLock(body: unknown, query: URLSearchParams, home?: string, o: { cwd?: string; rawText?: string } = {}): HandsfreeLock | null {
  const candidates = o.rawText !== undefined ? quotedStringsOf(o.rawText) : stringsOf(body);
  for (const v of query.values()) candidates.push(v);
  const vaults = listVaults(home);
  const byName = new Map(vaults.map((v) => [v.name.toLowerCase(), v.path]));
  const cwd = o.cwd ?? process.cwd();
  for (const c of candidates) {
    const t = c.trim();
    if (!t || t.length > 4096 || t.includes('\0')) continue;
    const named = byName.get(t.toLowerCase());
    const paths: string[] = [];
    if (named) paths.push(named);
    if (isAbsolute(t)) paths.push(t);
    else if (t.startsWith('~/')) paths.push(join(home ?? homedir(), t.slice(2)));
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(t) && /[/\\]|^\.\.?$/.test(t)) paths.push(resolvePath(cwd, t));
    for (const p of paths) {
      const lock = handsfreeLockFor(p, home);
      if (lock) return lock;
    }
  }
  return null;
}

/**
 * While away: read the body of a body-selector route, refuse it (the lock) when it names a
 * locked vault, else hand the handler an equivalent request carrying the same bytes.
 */
export async function screenBodySelectedVault(req: IncomingMessage, url: URL, home?: string, o: { timeoutMs?: number } = {}): Promise<{ lock: HandsfreeLock } | { req: IncomingMessage }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const verdict = await new Promise<'ok' | 'too_big' | 'timeout'>((resolvePromise) => {
    const timer = setTimeout(() => { req.destroy(); resolvePromise('timeout'); }, o.timeoutMs ?? BODY_SCREEN_TIMEOUT_MS);
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_SCREEN_MAX) { clearTimeout(timer); req.destroy(); resolvePromise('too_big'); return; }
      chunks.push(c);
    });
    req.on('end', () => { clearTimeout(timer); resolvePromise('ok'); });
    req.on('error', () => { clearTimeout(timer); resolvePromise('timeout'); });
  });
  const away = handsfreeLockFor('/', home) ?? { tripId: 'unknown', phase: 'away' as const, rootId: '*', root: '/' };
  if (verdict === 'too_big') return { lock: { ...away, error: 'request too large to check against the hands-free lock' } };
  if (verdict === 'timeout') return { lock: { ...away, error: 'request body not received in time to check against the hands-free lock' } };
  const buf = Buffer.concat(chunks);
  const text = buf.toString('utf8');
  let body: unknown = null;
  let parsed = true;
  try { body = buf.length ? JSON.parse(text) : null; } catch { parsed = false; }
  const lock = bodySelectedVaultLock(body, url.searchParams, home, parsed ? {} : { rawText: text });
  if (lock) return { lock };
  const replay = new IncomingMessage(req.socket);
  replay.method = req.method;
  replay.url = req.url;
  replay.headers = req.headers;
  replay.rawHeaders = req.rawHeaders;
  replay.httpVersion = req.httpVersion;
  if (buf.length) replay.push(buf);
  replay.push(null);
  return { req: replay };
}

export function sendHandsfreeAway(res: ServerResponse, lock: HandsfreeLock): void {
  sendJson(res, 423, {
    error: 'handsfree_away',
    message: lock.error ?? 'This project is on the cloud machine (hands-free mode); return it to the laptop to change it here.',
    tripId: lock.tripId,
    phase: lock.phase,
    rootId: lock.rootId,
  });
}

// ---------------------------------------------------------------- server-side env

/** Running work from this server's live registries (chat children, PTYs, detached runs). */
export const registryTurns: TurnControl = {
  async list(roots: string[]): Promise<RunningWork[]> {
    const chats = liveChatsSnapshot().filter((e) => under(roots, e.projectRoot))
      .map((e) => ({ kind: 'chat' as const, id: e.conversationId, cwd: e.projectRoot, busy: e.busy }));
    const ptys = ptySessionsUnder(roots).map((p) => ({ kind: 'pty' as const, id: p.id, cwd: p.cwd, busy: true }));
    const runs = detachedRunsUnder(roots).map((d) => ({ kind: 'detached' as const, id: String(d.pid), cwd: d.cwd, busy: true }));
    return [...chats, ...ptys, ...runs];
  },
  async cut(roots: string[], o: { all: boolean }): Promise<number> {
    let n = (await cutLiveChats((e) => under(roots, e.projectRoot) && (o.all || !e.busy))).length;
    if (o.all) {
      n += await cutPtySessionsUnder(roots);
      n += await cutDetachedRunsUnder(roots);
    }
    return n;
  },
};

/**
 * The dashboard's turn control (D22): the process-tree scan decides what runs in scope, its
 * own children included; the registries only label (a detached run by pid; the dashboard's
 * own child tree while a registry already shows it running) and cut idle chats without
 * asking. A scanned child of this server stays listed as running work whenever no registry
 * entry accounts for it (a draining chat whose tab closed, a hook child), so go never sees
 * "nothing running" while a process is still in a scope root.
 */
export function makeServerTurns(scan: TurnControl = processTurnControl(createSpawnRunner())): TurnControl {
  return {
    async list(roots) {
      const [reg, found] = await Promise.all([registryTurns.list(roots), scan.list(roots)]);
      const detachedPids = new Set(reg.filter((r) => r.kind === 'detached').map((r) => r.id));
      // A running chat/PTY (or a detached run of this server's own tree) already stands for the
      // dashboard's child tree; otherwise those children are listed themselves.
      const ownTreeRunning = reg.some((r) => r.busy && (r.kind === 'chat' || r.kind === 'pty'))
        || found.some((f) => f.fromSelf && detachedPids.has(String(f.pid ?? f.id)));
      const rest = found.filter((f) => !detachedPids.has(String(f.pid ?? f.id)) && !(ownTreeRunning && f.fromSelf));
      return [...reg, ...rest];
    },
    async cut(roots, o) {
      let n = await registryTurns.cut(roots, o);
      if (o.all) n += await scan.cut(roots, o);
      return n;
    },
  };
}

export const serverTurns: TurnControl = makeServerTurns();

/** A Return that meets a held roster lock waits (lane F, up to 5 s) instead of failing. */
export const serverRoster: RosterIO = { read: readRosterSurface, write: (c, s) => writeMergedRosterSurfaceAsync(c, s) };

let envFactory: () => HandsfreeEnv = () => laptopEnv({ turns: serverTurns, roster: serverRoster });

/** Tests only: route the handlers to an env over a scratch home and a fake cloud. */
export function setHandsfreeEnvForTests(f: (() => HandsfreeEnv) | null): void {
  envFactory = f ?? (() => laptopEnv({ turns: serverTurns, roster: serverRoster }));
}

// ---------------------------------------------------------------- jobs (sync-job shape)

export type HandsfreeJobKind = 'go' | 'return' | 'resume' | 'rollback' | 'abandon' | 'revoke-all';

export interface HandsfreeJob {
  id: string;
  kind: HandsfreeJobKind;
  status: 'running' | 'success' | 'error';
  /** The current step (`preflight`, `waiting`, `start`, `health`, `snapshot`, `go.git`, `download`, `apply`, `seal`, …). */
  step: string | null;
  detail: string | null;
  /** While `step === 'waiting'`: the running turns go/return waits for (offer Cut). */
  running: RunningWork[];
  startedAt: number;
  finishedAt: number | null;
  result: unknown;
  error: { code: string; message: string; detail: Record<string, unknown> } | null;
}

let current: HandsfreeJob | null = null;
/** Jobs the owner asked to cut their running work (`POST jobs/current/cut`); dies with the job. */
const cutRequested = new WeakSet<HandsfreeJob>();
/** The job kinds that wait for running turns, so a Cut means something to them. */
const CUTTABLE: ReadonlySet<HandsfreeJobKind> = new Set(['go', 'return', 'resume']);

export function currentHandsfreeJob(): HandsfreeJob | null {
  return current;
}

function startJob(kind: HandsfreeJobKind, run: (onProgress: Progress, shouldCut: () => boolean) => Promise<unknown>): { job: HandsfreeJob; started: boolean } {
  if (current?.status === 'running') return { job: current, started: false };
  const job: HandsfreeJob = {
    id: `hf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    kind, status: 'running', step: null, detail: null, running: [], startedAt: Date.now(), finishedAt: null, result: null, error: null,
  };
  current = job;
  const onProgress: Progress = (e) => {
    job.step = e.step;
    job.detail = e.detail ?? null;
    job.running = e.running ?? [];
  };
  void run(onProgress, () => cutRequested.has(job)).then(
    (result) => { job.status = 'success'; job.result = result ?? null; job.finishedAt = Date.now(); },
    (err: unknown) => {
      job.status = 'error';
      job.finishedAt = Date.now();
      job.error = err instanceof HandsfreeError
        ? { code: err.code, message: err.message, detail: err.detail }
        : { code: 'internal_error', message: (err as Error)?.message ?? String(err), detail: {} };
    },
  );
  return { job, started: true };
}

function sendJob(res: ServerResponse, r: { job: HandsfreeJob; started: boolean }): void {
  if (!r.started) {
    sendJson(res, 409, { error: 'busy', message: `a hands-free ${r.job.kind} is already running`, job: r.job });
    return;
  }
  sendJson(res, 202, { job: r.job });
}

const flag = (b: Record<string, unknown> | null, k: string) => b?.[k] === true;

// ---------------------------------------------------------------- handlers

/** The trip state stores realpaths (trip-state.ts); a registry entry may name the same folder by a symlinked path. */
function realOrResolved(p: string): string {
  try { return realpathSync.native(p); } catch { return resolvePath(p); }
}

/** The vault a status request explicitly names (header, or `?vault=` on GET), never the server's pinned root. */
function askedVault(req: IncomingMessage): string | null {
  const h = req.headers['x-dreamcontext-vault'];
  if (typeof h === 'string' && h) return h;
  try { return new URL(req.url || '/', 'http://localhost').searchParams.get('vault') || null; } catch { return null; }
}

/**
 * GET /api/handsfree/status → StatusReport (+ the current job). Never starts the machine.
 *
 * Plus, for the window's project (AC6: the lock banner belongs to the LOCKED project only):
 * `here` = is the vault this request names inside the trip, by the same `handsfreeLockFor` the
 * lock middleware refuses with (no vault named, or a vault outside the trip: false; the name is
 * echoed so a window that switched project never shows another project's answer), and `away` =
 * the trip's project by its registered name (else its folder name), for the other projects'
 * quiet line.
 */
export async function handleHandsfreeStatus(req: IncomingMessage, res: ServerResponse, _p?: Record<string, string>, vaultRoot?: string | null): Promise<void> {
  if (!gate(req, res)) return;
  const env = envFactory();
  const report = await status(env);
  const vault = askedVault(req);
  const lock = vault && vaultRoot ? handsfreeLockFor(vaultRoot, env.home) : null;
  const here = { vault, inTrip: !!lock, ...(lock ? { rootId: lock.rootId } : {}) };
  const st = readTripState(env.home);
  const tripRoot = st.phase !== 'home' ? st.roots[0]?.path : undefined;
  const away = tripRoot
    ? { name: listVaults(env.home).find((v) => realOrResolved(v.path) === realOrResolved(tripRoot))?.name ?? (tripRoot.split(/[\\/]/).filter(Boolean).pop() ?? tripRoot), path: tripRoot }
    : null;
  sendJson(res, 200, { ...report, job: current, here, away });
}

/** GET /api/handsfree/jobs/current → {job | null}. */
export async function handleHandsfreeJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  sendJson(res, 200, { job: current });
}

/** GET /api/handsfree/receipt?trip=<tripId> → Receipt (404 when the trip has none). */
export async function handleHandsfreeReceipt(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const trip = new URL(req.url || '/', 'http://localhost').searchParams.get('trip') ?? '';
  try { assertTripId(trip); } catch { sendError(res, 400, 'bad_trip', 'Unknown trip id.'); return; }
  const r = readReceipt(envFactory(), trip);
  if (!r) { sendError(res, 404, 'not_found', 'No receipt for this trip.'); return; }
  sendJson(res, 200, r);
}

/** POST /api/handsfree/go {cutRunning?, takeOver?, confirmTakeOverLive?} → 202 {job}. */
export async function handleHandsfreeGo(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!gate(req, res)) return;
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'Pick the project to take hands-free first.'); return; }
  const b = await parseJsonBody(req);
  const env = envFactory();
  sendJob(res, startJob('go', (onProgress, shouldCut) => go(env, {
    contextRoot, cutRunning: flag(b, 'cutRunning'), takeOver: flag(b, 'takeOver'), confirmTakeOverLive: flag(b, 'confirmTakeOverLive'), onProgress, shouldCut,
  })));
}

/** POST /api/handsfree/return {cutRunning?} → 202 {job}. */
export async function handleHandsfreeReturn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const b = await parseJsonBody(req);
  const env = envFactory();
  sendJob(res, startJob('return', (onProgress, shouldCut) => returnTrip(env, { cutRunning: flag(b, 'cutRunning'), shouldCut, onProgress })));
}

/** POST /api/handsfree/resume {cutRunning?} → 202 {job}. */
export async function handleHandsfreeResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const b = await parseJsonBody(req);
  const env = envFactory();
  sendJob(res, startJob('resume', (onProgress, shouldCut) => resumeTrip(env, { cutRunning: flag(b, 'cutRunning'), shouldCut, onProgress })));
}

/** POST /api/handsfree/rollback → 202 {job}. */
export async function handleHandsfreeRollback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const env = envFactory();
  sendJob(res, startJob('rollback', () => rollbackTrip(env)));
}

/** POST /api/handsfree/abandon {confirm: 'abandon'} → 202 {job}. The UI double-confirms first. */
export async function handleHandsfreeAbandon(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const b = await parseJsonBody(req);
  if (b?.confirm !== 'abandon') { sendError(res, 400, 'confirm_required', 'Abandon needs {"confirm":"abandon"}.'); return; }
  const env = envFactory();
  sendJob(res, startJob('abandon', () => abandonTrip(env)));
}

/** POST /api/handsfree/devices/revoke-all → 202 {job}; the result says whether the cloud confirmed. */
export async function handleHandsfreeRevokeAll(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const env = envFactory();
  sendJob(res, startJob('revoke-all', () => revokeAllDevices(env)));
}

/**
 * POST /api/handsfree/jobs/current/cut → 200 {job} when a go/return/resume is waiting for
 * running work (it cuts that work on its next wait round), else 409 {error:'not_waiting', job}.
 */
export async function handleHandsfreeCut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const job = current;
  if (!job || job.status !== 'running' || job.step !== 'waiting' || !CUTTABLE.has(job.kind)) {
    sendJson(res, 409, { error: 'not_waiting', message: 'no hands-free go or return is waiting for running work', job });
    return;
  }
  cutRequested.add(job);
  sendJson(res, 200, { job });
}

// ---------------------------------------------------------------- preflight (the sheet's first step)

/** Mirrors `IMAGE_OVERHEAD_BYTES` and the 1.3 margin of the go preflight's `diskFit` (orchestrator.ts). */
const IMAGE_OVERHEAD_BYTES = 21 * 2 ** 30;
const DISK_MARGIN = 1.3;

export type PreflightRefusal = 'not_setup' | 'not_home' | 'scope' | 'preflight' | 'disk' | 'quota';

export interface PreflightReport {
  roots: Array<{ rootId: string; path: string; kind: 'repo' | 'files'; bytes: number }>;
  totalBytes: number;
  machine: {
    name: string;
    /** Free disk once the image is in, null when GitHub's machine list could not be read. */
    freeBytes: number | null;
    needBytes: number;
    biggerMachine: string | null;
    remainingCoreMinutes: number | null;
    needCoreMinutes: number;
    /** Where `remainingCoreMinutes` came from (GitHub's REST, or the laptop's own uptime count). */
    quotaSource: 'github' | 'laptop';
    /** The machine is already running: go starts nothing, so the quota is not checked. */
    running: boolean;
  } | null;
  warnings: string[];
  runningTurns: RunningWork[];
  /** Why go would refuse now (Go is disabled with this reason), or null. */
  refusal: { code: PreflightRefusal; message: string; detail?: Record<string, unknown> } | null;
}

/**
 * The read-only scope + size estimate go's own preflight uses: no codespace start, no write
 * (GitHub's REST is only read: the machine's state, its machine types and the quota).
 */
export async function buildPreflight(env: HandsfreeEnv, contextRoot: string): Promise<PreflightReport> {
  const warnings: string[] = [];
  let refusal: PreflightReport['refusal'] = null;
  const refuse = (code: PreflightRefusal, message: string, detail?: Record<string, unknown>) => { refusal ??= { code, message, ...(detail ? { detail } : {}) }; };
  const st = readTripState(env.home);
  const cfg = readConfig(env.home);
  if (!cfg?.codespace) refuse('not_setup', 'hands-free mode is not set up: run `dreamcontext handsfree setup` first');
  if (st.unreadable) refuse('not_home', st.unreadable);
  else if (st.phase !== 'home') refuse('not_home', `a trip is already ${st.phase}; return, resume or abandon it first`);

  let scopeRoots: Awaited<ReturnType<typeof computeScope>>['roots'] = [];
  try {
    scopeRoots = (await computeScope({ run: env.run, home: env.home, contextRoot, claudeProjectsDir: env.claudeProjectsDir ?? join(env.home, '.claude', 'projects') })).roots;
  } catch (err) {
    if (!(err instanceof ScopeError)) throw err;
    refuse('scope', err.message);
  }
  // The same estimate go's disk check makes: a worktree shares its repo's objects (counted there).
  const roots: PreflightReport['roots'] = [];
  for (const r of scopeRoots) {
    const bytes = r.kind === 'repo' ? await estimateRepoBytes(env.run, r.absPath)
      : r.kind === 'transcripts' ? dirBytes(r.absPath)
        : r.kind === 'vault' ? dirBytes(join(r.absPath, '_dream_context'))
          : 0;
    roots.push({ rootId: r.rootId, path: r.absPath, kind: r.kind === 'repo' || r.kind === 'worktree' ? 'repo' : 'files', bytes });
  }
  const totalBytes = roots.reduce((n, r) => n + r.bytes, 0);

  for (const r of scopeRoots.filter((x) => x.kind === 'repo' || x.kind === 'worktree')) {
    try {
      const problems = await gitPreflight(env.run, r.absPath, { side: 'laptop' });
      if (problems.length) refuse('preflight', `cannot go hands-free yet:\n  ${problems.map((p) => `${r.absPath}: ${p.detail}`).join('\n  ')}`, { problems: problems.map((p) => ({ ...p, repo: r.absPath })) });
    } catch (err) {
      warnings.push(`${r.absPath}: ${(err as Error).message}`);
    }
  }

  const codeRoots = scopeRoots.filter((r) => r.kind !== 'transcripts').map((r) => r.absPath);
  let runningTurns: RunningWork[] = [];
  try { runningTurns = codeRoots.length ? (await env.turns.list(codeRoots)).filter((w) => w.busy) : []; } catch (err) { warnings.push(`running work could not be checked: ${(err as Error).message}`); }

  let machine: PreflightReport['machine'] = null;
  if (cfg?.codespace) {
    const name = cfg.codespace.machine;
    const cores = coresFor(name);
    const needBytes = Math.ceil(totalBytes * DISK_MARGIN);
    const needCoreMinutes = cores * (cfg.tripEstimateHours * 60 + RETURN_RESERVE_MINUTES);
    // `Promise.resolve().then`: the production provider throws SYNCHRONOUSLY when not signed in.
    const ask = <T>(f: () => Promise<T>) => Promise.resolve().then(f);
    const csName = cfg.codespace.name;
    const [info, types, remote] = await Promise.all([
      ask(() => env.provider.get(csName)).catch((err: Error) => { warnings.push(`GitHub: ${err.message}`); return null; }),
      ask(() => env.provider.machineTypes()).catch((err: Error) => { warnings.push(`GitHub machine types: ${err.message}`); return []; }),
      ask(() => env.provider.remainingQuotaCoreMinutes()).catch(() => null),
    ]);
    const cur = types.find((t) => t.name === name);
    const freeBytes = cur?.storageBytes ? cur.storageBytes - IMAGE_OVERHEAD_BYTES : null;
    const bigger = types.find((t) => t.storageBytes - IMAGE_OVERHEAD_BYTES >= needBytes)?.name ?? null;
    const remainingCoreMinutes = remote ?? Math.round(cfg.budgetCoreMinutes - usedCoreMinutes(cfg, cores));
    const running = info?.state === 'available';
    machine = { name, freeBytes, needBytes, biggerMachine: bigger, remainingCoreMinutes, needCoreMinutes, quotaSource: remote === null ? 'laptop' : 'github', running };
    if (freeBytes !== null && needBytes > freeBytes) {
      refuse('disk', `this trip needs about ${(needBytes / 2 ** 30).toFixed(1)} GB but ${name} has about ${(freeBytes / 2 ** 30).toFixed(1)} GB free.${bigger ? ` Re-create the machine bigger: \`dreamcontext handsfree teardown\` then \`dreamcontext handsfree setup --machine ${bigger}\`.` : ' No machine type is big enough: exclude large folders first.'}`, { needBytes, freeBytes, biggerMachine: bigger });
    }
    if (!running && remainingCoreMinutes < needCoreMinutes) {
      refuse('quota', `about ${Math.max(0, Math.floor(remainingCoreMinutes / cores / 60))} h of Codespaces quota remain this month, below this trip's estimate plus a Return reserve (${Math.ceil(needCoreMinutes / cores / 60)} h).`, { remainingCoreMinutes, needCoreMinutes });
    }
  }
  return { roots, totalBytes, machine, warnings, runningTurns, refusal };
}

/** GET /api/handsfree/preflight → {@link PreflightReport} for the active vault. Never starts or writes. */
export async function handleHandsfreePreflight(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!gate(req, res)) return;
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'Pick the project to take hands-free first.'); return; }
  sendJson(res, 200, await buildPreflight(envFactory(), contextRoot));
}
