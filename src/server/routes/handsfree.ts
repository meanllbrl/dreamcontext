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
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
import { createSpawnRunner } from '../../lib/handsfree/git-snapshot.js';
import type { RosterIO } from '../../lib/handsfree/session-merge.js';

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
const BODY_SCREEN_MAX = 32 * 1024 * 1024;

export function isBodySelectorRoute(method: string, pathname: string): boolean {
  return MUTATING.has(method.toUpperCase()) && BODY_SELECTOR_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Every string of a parsed body (depth-limited), for vault names and absolute paths. */
function stringsOf(v: unknown, out: string[], depth = 0): void {
  if (out.length > 2000 || depth > 4) return;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out, depth + 1);
}

/**
 * The lock covering any vault a body/query names: a registered vault NAME (its folder) or an
 * absolute path (a target or parent dir). Null when none is inside a locked root.
 */
export function bodySelectedVaultLock(body: unknown, query: URLSearchParams, home?: string): HandsfreeLock | null {
  const candidates: string[] = [];
  stringsOf(body, candidates);
  for (const v of query.values()) candidates.push(v);
  const vaults = listVaults(home);
  for (const c of candidates) {
    const t = c.trim();
    if (!t || t.length > 4096) continue;
    const vault = vaults.find((v) => v.name === t);
    const path = vault ? vault.path : isAbsolute(t) ? t : t.startsWith('~/') ? join(home ?? homedir(), t.slice(2)) : null;
    if (!path) continue;
    const lock = handsfreeLockFor(path, home);
    if (lock) return lock;
  }
  return null;
}

/**
 * While away: read the body of a body-selector route, refuse it (the lock) when it names a
 * locked vault, else hand the handler an equivalent request carrying the same bytes.
 */
export async function screenBodySelectedVault(req: IncomingMessage, url: URL, home?: string): Promise<{ lock: HandsfreeLock } | { req: IncomingMessage }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const tooBig = await new Promise<boolean>((resolvePromise) => {
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_SCREEN_MAX) { req.destroy(); resolvePromise(true); return; }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(false));
    req.on('error', () => resolvePromise(false));
  });
  const away = handsfreeLockFor('/', home) ?? { tripId: 'unknown', phase: 'away' as const, rootId: '*', root: '/' };
  if (tooBig) return { lock: { ...away, error: 'request too large to check against the hands-free lock' } };
  const buf = Buffer.concat(chunks);
  let body: unknown = null;
  try { body = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { body = buf.toString('utf8'); }
  const lock = bodySelectedVaultLock(body, url.searchParams, home);
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

export function currentHandsfreeJob(): HandsfreeJob | null {
  return current;
}

function startJob(kind: HandsfreeJobKind, run: (onProgress: Progress) => Promise<unknown>): { job: HandsfreeJob; started: boolean } {
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
  void run(onProgress).then(
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

/** GET /api/handsfree/status → StatusReport (+ the current job). Never starts the machine. */
export async function handleHandsfreeStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  sendJson(res, 200, { ...(await status(envFactory())), job: current });
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
  sendJob(res, startJob('go', (onProgress) => go(env, {
    contextRoot, cutRunning: flag(b, 'cutRunning'), takeOver: flag(b, 'takeOver'), confirmTakeOverLive: flag(b, 'confirmTakeOverLive'), onProgress,
  })));
}

/** POST /api/handsfree/return {cutRunning?} → 202 {job}. */
export async function handleHandsfreeReturn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const b = await parseJsonBody(req);
  const env = envFactory();
  sendJob(res, startJob('return', (onProgress) => returnTrip(env, { cutRunning: flag(b, 'cutRunning'), onProgress })));
}

/** POST /api/handsfree/resume {cutRunning?} → 202 {job}. */
export async function handleHandsfreeResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!gate(req, res)) return;
  const b = await parseJsonBody(req);
  const env = envFactory();
  sendJob(res, startJob('resume', (onProgress) => resumeTrip(env, { cutRunning: flag(b, 'cutRunning'), onProgress })));
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
