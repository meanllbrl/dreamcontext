import { mkdirSync, renameSync, rmSync, writeFileSync, lstatSync, readFileSync, closeSync, openSync, readSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Router } from '../router.js';
import { sendError, sendJson } from '../middleware.js';
import {
  cloudGitConfigPath, cloudLocalPath, cloudMirrorPrefix, cloudPublicDir, cloudServerDir, cloudWorkDir, isCloud,
  spawnAsWorker, type CloudPhase,
} from '../cloud-mode.js';
import { handsfreeAuth, type VerifierPush } from '../handsfree-auth.js';
import { CloudStateStore } from '../cloud-state.js';
import { CloudIdle, cloudIdle } from '../cloud-idle.js';
import { CHUNK_MAX, TransferError, TransferStore, readRawBody } from '../cloud-transfers.js';
import { WorkerOpError, parseGitDirSpec, runWorkerOp } from '../cloud-worker.js';
import { checkRelPath } from '../../lib/handsfree/paths.js';
import { isVersionPin } from '../../lib/handsfree/npm-pin.js';
import { cutLiveChats, liveChatsByPgid, liveChatsSnapshot } from './agent-chat-live.js';
import { assertTripId, HandsfreeRefusal, type RepoSnapshot } from '../../lib/handsfree/git-snapshot.js';
import { encodeProjectDir, rootIdFor, type GoManifest, type ManifestEntry, type RootKind, type RootSpec } from '../../lib/handsfree/manifest.js';
import { listClaudeAccounts, sandboxDirFor } from '../../lib/claude-accounts.js';
import { claudeAuthStatus } from '../../lib/claude-auth.js';

/**
 * The cloud half of the hands-free transfer channel (PINNED WIRE CONTRACT v1). Every route
 * lives under `/api/handsfree/cloud/`, is the transfer class (the cloud gate already demanded
 * the HMAC proof and refused device cookies), and answers 404 off the cloud. The laptop
 * (lane E) declares its own types for these shapes; this side validates every input.
 *
 * dcserver never runs git or touches a pack: each of those is a dcuser worker op
 * (cloud-worker.ts), and uploads reach the worker through its stdin, never as a path.
 */

const JSON_MAX = 8 * 1024 * 1024;
/** Decompressed cap for one pack (the machine's disk; the laptop's trip estimate is smaller). */
const PACK_MAX_BYTES = 32 * 1024 * 1024 * 1024;
const LAPTOP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ROOT_ID_RE = /^r-[0-9a-f]{16}$/;
const SNAPSHOT_TIMEOUT_MS = 30 * 60_000;
const SMALL_OP_TIMEOUT_MS = 5 * 60_000;
export const TRIP_MARKER_NAME = '.dreamcontext-handsfree-trip.json';
/** `runtime` exits with this code; the root supervisor then installs the requested version. */
export const RUNTIME_EXIT_CODE = 75;
/** D25: the `{version, integrity}` the root supervisor fetches from npm and verifies (no tarball upload). */
export const RUNTIME_REQUEST_NAME = 'runtime-request.json';

// ─── process-wide services (cloud serve builds them over the dcserver dir) ────

interface CloudServices { state: CloudStateStore; transfers: TransferStore }

let services: CloudServices | null = null;

export function cloudServices(): CloudServices {
  if (!services) {
    const dir = cloudServerDir();
    services = { state: new CloudStateStore({ dir }), transfers: new TransferStore({ dir }) };
  }
  return services;
}

/** Tests (and only tests) swap the services for ones over a scratch dir. */
export function setCloudServicesForTests(next: CloudServices | null): void {
  services = next;
}

/** The phase the cloud gate reads (cloud serve passes this to setCloudPhaseSource). */
export function cloudPhaseFromStore(): CloudPhase {
  return cloudServices().state.phase();
}

let exitForRuntime: (code: number) => void = (code) => process.exit(code);
export function setRuntimeExitForTests(fn: (code: number) => void): void {
  exitForRuntime = fn;
}

// ─── helpers ────────────────────────────────────────────────────────────────

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readRawBody(req, JSON_MAX).catch((e) => {
    if (e instanceof TransferError) throw new RouteError(413, 'too_large', `JSON bodies are at most ${JSON_MAX} bytes; use an upload.`);
    throw e;
  });
  if (buf.length === 0) return {};
  try {
    const v = JSON.parse(buf.toString('utf-8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new RouteError(400, 'bad_request', 'The body is not a JSON object.');
  }
}

function workerBase(): { gitConfigPath: string; workDir: string; mirrorPrefix: string | null } {
  return { gitConfigPath: cloudGitConfigPath(), workDir: cloudWorkDir(), mirrorPrefix: cloudMirrorPrefix() };
}

function tripIdOf(v: unknown): string {
  try { return assertTripId(v as string); } catch { throw new RouteError(400, 'bad_trip', 'Invalid trip id.'); }
}

/** Validate an UNTRUSTED go manifest: every root is absolute, under home, and named by its own id. */
export function parseGoManifest(raw: unknown, tripId: string, laptopId: string): GoManifest {
  const bad = (m: string) => new RouteError(400, 'bad_go', `go manifest: ${m}`);
  const g = raw as GoManifest;
  if (!g || typeof g !== 'object' || g.version !== 1) throw bad('version');
  if (g.tripId !== tripId) throw bad('trip mismatch');
  if (g.laptopId !== laptopId) throw bad('laptop mismatch');
  if (typeof g.home !== 'string' || !isAbsolute(g.home) || g.home.includes('\0') || resolve(g.home) === sep) throw bad('home');
  if (!Array.isArray(g.roots) || g.roots.length === 0 || g.roots.length > 500) throw bad('roots');
  const home = resolve(g.home);
  const kinds: RootKind[] = ['vault', 'repo', 'worktree', 'transcripts'];
  const ids = new Set<string>();
  for (const r of g.roots as RootSpec[]) {
    if (!r || typeof r.absPath !== 'string' || !isAbsolute(r.absPath) || r.absPath.includes('\0')) throw bad('root path');
    const abs = resolve(r.absPath);
    if (!abs.startsWith(home + sep)) throw bad(`root ${abs} is outside home`);
    if (!kinds.includes(r.kind)) throw bad('root kind');
    if (r.rootId !== rootIdFor(abs) || ids.has(r.rootId)) throw bad(`root id of ${abs}`);
    ids.add(r.rootId);
    if (r.repoRootId !== undefined && (typeof r.repoRootId !== 'string' || !ROOT_ID_RE.test(r.repoRootId))) throw bad('repoRootId');
  }
  return g;
}

function currentTrip(tripId?: unknown): { go: GoManifest; tripId: string } {
  const rec = cloudServices().state.get();
  if (!rec.tripId || !rec.go) throw new RouteError(409, 'no_trip', 'No trip is recorded on this cloud.');
  if (tripId !== undefined && tripId !== rec.tripId) throw new RouteError(409, 'trip_mismatch', 'That is not the trip this cloud holds.');
  return { go: rec.go as GoManifest, tripId: rec.tripId };
}

function rootOf(go: GoManifest, rootId: unknown): { spec: RootSpec; local: string } {
  if (typeof rootId !== 'string' || !ROOT_ID_RE.test(rootId)) throw new RouteError(400, 'bad_root', 'Invalid root id.');
  const spec = go.roots.find((r) => r.rootId === rootId);
  if (!spec) throw new RouteError(404, 'unknown_root', 'That root is not part of this trip.');
  return { spec, local: cloudLocalPath(spec.absPath) };
}

function homeLocal(go: GoManifest): string {
  return cloudLocalPath(go.home);
}

/** lstat only (never follows, never reads): is this root a git repository in the cloud? */
function isRepoRoot(spec: RootSpec, local: string): boolean {
  if (spec.kind !== 'repo' && spec.kind !== 'vault') return false;
  try { return lstatSync(join(local, '.git')).isDirectory(); } catch { return false; }
}

function goManifestDir(tripId: string): string {
  return join(cloudServerDir(), 'trips', tripId);
}

function recordedAtGo(tripId: string, rootId: string): ManifestEntry[] {
  try {
    const v = JSON.parse(readFileSync(join(goManifestDir(tripId), `go-${rootId}.json`), 'utf-8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writePrivateJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

/** The opted-in files the cloud was given at go that the default selection would not pick up
 *  (belt and braces beside the trip's own `includes`, wire v1.1). */
function includeFromGo(entries: ManifestEntry[]): string[] {
  return entries
    .map((e) => e.path)
    .filter((p) => !p.startsWith('_dream_context/') && !p.startsWith('.claude/') && !/(^|\/)(\.env[^/]*|\.npmrc|\.dev\.vars|\.netrc)$/.test(p));
}

const INCLUDE_MAX = 1000;

/** `POST trip`'s `includes` (wire v1.1): per root id of THIS go manifest, root-relative paths. */
export function parseIncludes(raw: unknown, go: GoManifest): Record<string, string[]> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RouteError(400, 'bad_includes', 'includes must map root ids to path lists.');
  const out: Record<string, string[]> = {};
  for (const [rootId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!go.roots.some((r) => r.rootId === rootId)) throw new RouteError(400, 'bad_includes', `includes names a root that is not in this trip: ${rootId}`);
    if (!Array.isArray(list) || list.length > INCLUDE_MAX) throw new RouteError(400, 'bad_includes', 'includes values must be path lists.');
    out[rootId] = list.map((v) => {
      const p = typeof v === 'string' ? v.replace(/^\.\/+/, '').replace(/\/+$/, '') : '';
      const c = checkRelPath(p);
      if (!c.ok) throw new RouteError(400, 'bad_includes', `include ${JSON.stringify(v)} is refused (${c.reason}).`);
      return c.path;
    });
  }
  return out;
}

function tripIncludes(tripId: string): Record<string, string[]> {
  try {
    const v = JSON.parse(readFileSync(join(goManifestDir(tripId), 'includes.json'), 'utf-8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Everything the cloud walk of one root must honour beyond the default selection. */
function includesFor(tripId: string, rootId: string, atGo: ManifestEntry[]): string[] {
  return [...new Set([...(tripIncludes(tripId)[rootId] ?? []), ...includeFromGo(atGo)])];
}

/** The laptop's info files and remotes for a repo root (wire v1.1), as last received. */
function gitSpecFor(tripId: string, rootId: string): { info?: unknown; remotes?: unknown } {
  try {
    return JSON.parse(readFileSync(join(goManifestDir(tripId), `git-${rootId}.json`), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * dcserver's HOME is the mirror of the laptop HOME, so every `homedir()` lookup (vaults.json,
 * `~/.claude/projects`, the account sandboxes) lands in the mirror. The supervisor starts the
 * server with it; this keeps it right for the test seam and before the first restart.
 */
export function adoptMirrorHome(go: GoManifest): void {
  process.env.HOME = cloudLocalPath(go.home);
}

/**
 * The orchestration GIT_CONFIG_GLOBAL (0644 in the 0755 public dir, dcuser reads it):
 * safe.directory for every in-scope root, and the fixed identity our own stash/snapshot
 * commits use. Agents get their own `~/.gitconfig` from the global set.
 */
export function writeOrchestrationGitConfig(go: GoManifest): void {
  const lines = ['[user]', '\tname = dreamcontext handsfree', '\temail = handsfree@dreamcontext.invalid', '[safe]'];
  for (const r of go.roots) lines.push(`\tdirectory = ${cloudLocalPath(r.absPath).replace(/[\\"\n]/g, '')}`);
  lines.push('[core]', '\tquotePath = false', '');
  const file = cloudGitConfigPath();
  mkdirSync(cloudPublicDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.join('\n'), { mode: 0o644 });
  renameSync(tmp, file);
}

/**
 * Is the mirror mounted on this trip's HOME? Only asked when the root supervisor runs (its
 * `supervised` marker): the Mac test seam has no supervisor and no mount. When it is not, the
 * request for the supervisor is written here (validated again by the supervisor).
 */
function mirrorReady(go: GoManifest): boolean {
  const pub = cloudPublicDir();
  let supervised = false;
  try { supervised = lstatSync(join(pub, 'supervised')).isFile(); } catch { /* no supervisor */ }
  if (!supervised) return true;
  const want = resolve(go.home);
  let mounted = '';
  try { mounted = readFileSync(join(pub, 'mirror-mounted'), 'utf-8').trim(); } catch { /* none yet */ }
  if (mounted === want && resolve(homedir()) === want) return true;
  const tmp = join(pub, `mirror-request.${process.pid}.tmp`);
  writeFileSync(tmp, `${want}\n`, { mode: 0o644 });
  renameSync(tmp, join(pub, 'mirror-request'));
  return false;
}

function markerPath(go: GoManifest): string {
  return join(homeLocal(go), TRIP_MARKER_NAME);
}

async function assertMarker(go: GoManifest, tripId: string): Promise<void> {
  const r = await runWorkerOp<{ present: boolean; tripId?: string | null }>({ op: 'marker', params: { action: 'check', file: markerPath(go) }, timeoutMs: SMALL_OP_TIMEOUT_MS });
  if (!r.present || r.tripId !== tripId) throw new RouteError(409, 'trip_lost', 'The cloud mirror lost this trip (its marker is missing).');
}

function requireEpoch(epoch: unknown): number {
  const st = cloudServices().state;
  if (!st.epochMatches(epoch)) throw new RouteError(409, 'epoch_mismatch', 'That quiesce epoch is not the current one.');
  return epoch as number;
}

/** cut, snapshot, wipe-secrets and seal: only during a return (quiescing) under its epoch. */
function requireQuiescing(epoch: unknown): number {
  const v = cloudServices().state.quiescingEpoch(epoch);
  if (v === 'epoch_mismatch') throw new RouteError(409, 'epoch_mismatch', 'That quiesce epoch is not the current one.');
  if (v === 'not_quiescing') throw new RouteError(409, 'not_quiescing', 'The cloud is not quiescing; quiesce it first.');
  return epoch as number;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

/** Wrap a handler: 404 off the cloud, laptop progress, the idle clock's transfer deferral, errors. */
function route(fn: Handler): (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> {
  return async (req, res, params) => {
    if (!isCloud()) { sendError(res, 404, 'not_found', 'No route.'); return; }
    const svc = cloudServices();
    svc.state.touchLaptopProgress();
    const done = cloudIdle()?.transferBegin() ?? (() => { /* no clock (tests) */ });
    try {
      await fn(req, res, params);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof RouteError) {
        if (Object.keys(err.extra).length) sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
        else sendError(res, err.status, err.code, err.message);
      } else if (err instanceof TransferError) {
        sendError(res, err.status, err.code, err.message);
      } else if (err instanceof WorkerOpError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
      } else if (err instanceof HandsfreeRefusal) {
        sendJson(res, 409, { error: 'refused', kind: err.kind, message: err.message });
      } else {
        console.error(`[handsfree-cloud] ${req.method} ${(req.url ?? '').split('?')[0]} failed: ${(err as Error)?.message ?? err}`);
        sendError(res, 500, 'internal_error', 'Internal server error');
      }
    } finally {
      done();
    }
  };
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url || '/', 'http://localhost').searchParams;
}

// ─── handlers ───────────────────────────────────────────────────────────────

const putChunk: Handler = async (req, res, p) => {
  const body = await readRawBody(req, CHUNK_MAX);
  sendJson(res, 200, { ok: true, ...cloudServices().transfers.putChunk(p.uploadId, p.n, body) });
};

const commitUpload: Handler = async (req, res, p) => {
  await cloudServices().transfers.commit(p.uploadId, await readJson(req));
  sendJson(res, 200, { ok: true });
};

const getDownload: Handler = async (req, res, p) => {
  const q = queryOf(req);
  const buf = cloudServices().transfers.readDownload(p.downloadId, q.get('offset'), q.get('length'));
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
};

const postVerifiers: Handler = async (req, res) => {
  const body = await readJson(req);
  const r = handsfreeAuth().store.installVerifiers(body as unknown as VerifierPush);
  sendJson(res, r.ok ? 200 : 409, r);
};

const postRevokeAll: Handler = async (req, res) => {
  const body = await readJson(req);
  const r = handsfreeAuth().store.revokeAllDevices(body.generation as number);
  sendJson(res, r.ok ? 200 : 409, r);
};

/**
 * D25 (AC18): install this exact dreamcontext version from npm. The laptop sends only
 * `{version, integrity}` (strict semver, npm's sha512 integrity); the request is written for the
 * root supervisor, which fetches exactly that version, checks its sha512 against the integrity
 * before installing, and falls back to the last good build when health fails.
 */
const postRuntime: Handler = async (req, res) => {
  const body = await readJson(req);
  if (!isVersionPin(body) || Object.keys(body).some((k) => k !== 'version' && k !== 'integrity')) {
    throw new RouteError(400, 'bad_runtime', 'The runtime request needs an exact dreamcontext version and its npm sha512 integrity.');
  }
  writePrivateJson(join(cloudServerDir(), RUNTIME_REQUEST_NAME), { version: body.version, integrity: body.integrity });
  sendJson(res, 200, { ok: true, restarting: true });
  // Exit once the reply is out; the supervisor installs, restarts, and health shows the new
  // version (or the last good one when the new build fails its health check).
  res.on('finish', () => setTimeout(() => exitForRuntime(RUNTIME_EXIT_CODE), 200));
};

const postTrip: Handler = async (req, res) => {
  const body = await readJson(req);
  const tripId = tripIdOf(body.tripId);
  if (typeof body.laptopId !== 'string' || !LAPTOP_ID_RE.test(body.laptopId)) throw new RouteError(400, 'bad_laptop', 'Invalid laptop id.');
  const go = parseGoManifest(body.go, tripId, body.laptopId);
  const includes = parseIncludes(body.includes, go);
  const pre = cloudServices().state.checkStartTrip({ laptopId: body.laptopId, takeOver: body.takeOver === true });
  if (pre.ok && !mirrorReady(go)) {
    // The image cannot know the laptop's HOME: the root supervisor bind-mounts the mirror on
    // it when asked, then restarts this server with that HOME. The laptop retries a 503.
    throw new RouteError(503, 'mirror_pending', 'The cloud is preparing the mirror of your home folder; retry shortly.');
  }
  const r = cloudServices().state.startTrip({
    tripId, laptopId: body.laptopId, go, rootIds: go.roots.map((x) => x.rootId), takeOver: body.takeOver === true,
  });
  if (!r.ok) {
    throw new RouteError(409, r.error, r.error === 'not_sealed'
      ? 'The cloud holds a live trip; it must be sealed first.'
      : 'A live trip on this cloud belongs to another laptop.');
  }
  writeOrchestrationGitConfig(go);
  writePrivateJson(join(goManifestDir(tripId), 'includes.json'), includes);
  adoptMirrorHome(go);
  await runWorkerOp({ op: 'marker', params: { action: 'write', file: markerPath(go), data: { tripId, rootIds: r.record.rootIds } }, timeoutMs: SMALL_OP_TIMEOUT_MS });
  sendJson(res, 200, { ok: true, tripId, epoch: r.record.epoch });
};

const getState: Handler = async (req, res) => {
  const { go, tripId } = currentTrip();
  const { spec, local } = rootOf(go, queryOf(req).get('rootId'));
  const want = isRepoRoot(spec, local) ? 'repo' : 'files';
  const r = await runWorkerOp<unknown>({
    op: 'state',
    params: { ...workerBase(), want, trip: tripId, root: local, rootKind: spec.kind, home: homeLocal(go), include: includesFor(tripId, spec.rootId, recordedAtGo(tripId, spec.rootId)) },
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  });
  sendJson(res, 200, r);
};

function optionalUpload(v: unknown): { path: string } | null {
  if (v === undefined || v === null) return null;
  return cloudServices().transfers.consume(v);
}

const postGitReceive: Handler = async (req, res) => {
  const body = await readJson(req);
  const { go, tripId } = currentTrip(tripIdOf(body.tripId));
  const { spec, local } = rootOf(go, body.rootId);
  if (spec.kind !== 'repo' && spec.kind !== 'vault') throw new RouteError(400, 'not_a_repo', 'Only a repository root receives git state.');
  if (!body.snapshot || typeof body.snapshot !== 'object') throw new RouteError(400, 'bad_snapshot', 'snapshot is required.');
  // Wire v1.1: the laptop's info files + remotes for the GENERATED .git (refused before any work).
  const gitSpec = { info: body.info, remotes: body.remotes };
  try { parseGitDirSpec(gitSpec); } catch (err) { throw new RouteError(400, 'bad_request', (err as Error).message); }
  writePrivateJson(join(goManifestDir(tripId), `git-${spec.rootId}.json`), gitSpec);
  const up = optionalUpload(body.uploadId);
  try {
    const r = await runWorkerOp<{ snapshotId: string }>({
      op: 'git-receive',
      params: { ...workerBase(), trip: tripId, repoRoot: local, home: homeLocal(go), go, snapshot: body.snapshot as RepoSnapshot, hasBundle: !!up, ...gitSpec },
      inputFile: up?.path,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    sendJson(res, 200, { ok: true, snapshotId: r.snapshotId });
  } finally {
    if (up) rmSync(up.path, { force: true });
  }
};

const postFilesReceive: Handler = async (req, res) => {
  const body = await readJson(req);
  const { go, tripId } = currentTrip(tripIdOf(body.tripId));
  const { spec, local } = rootOf(go, body.rootId);
  if (!Array.isArray(body.expected)) throw new RouteError(400, 'bad_manifest', 'expected must be a manifest array.');
  const expected = body.expected as ManifestEntry[];
  const up = optionalUpload(body.uploadId);
  try {
    const r = await runWorkerOp<{ refused: Array<{ path: string; reason: string }>; digest: string }>({
      op: 'files-receive',
      params: {
        ...workerBase(), trip: tripId, rootId: spec.rootId, root: local, rootKind: spec.kind,
        expected, include: includesFor(tripId, spec.rootId, expected), maxBytes: PACK_MAX_BYTES, hasPack: !!up,
      },
      inputFile: up?.path,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    // What the cloud recorded at go (the return pack is the delta against it).
    const refused = new Set(r.refused.map((x) => x.path));
    writePrivateJson(join(goManifestDir(tripId), `go-${spec.rootId}.json`), expected.filter((e) => !refused.has(e.path)));
    sendJson(res, 200, { ok: true, refused: r.refused, digest: r.digest });
  } finally {
    if (up) rmSync(up.path, { force: true });
  }
};

const postGlobal: Handler = async (req, res) => {
  const body = await readJson(req);
  const { go } = currentTrip();
  const up = cloudServices().transfers.consume(body.uploadId);
  try {
    const r = await runWorkerOp<{ written: number; refused: unknown[] }>({
      op: 'global',
      // AC3: the trip's project (the go manifest's first root) is registered on the cloud too.
      params: { ...workerBase(), home: homeLocal(go), maxBytes: PACK_MAX_BYTES, tripVault: go.roots.find((r) => r.kind !== 'worktree' && r.kind !== 'transcripts')?.absPath },
      inputFile: up.path,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    sendJson(res, 200, { ok: true, written: r.written, refused: r.refused });
  } finally {
    rmSync(up.path, { force: true });
  }
};

const INSTALL_COMMANDS: Record<string, string> = {
  'package-lock.json': 'npm ci --no-audit --no-fund',
  'pnpm-lock.yaml': 'pnpm install --frozen-lockfile',
  'yarn.lock': 'yarn install --frozen-lockfile',
};

/** Go step 7: a changed lockfile's install, as dcuser with a clean env, in the background. */
async function runInstalls(go: GoManifest): Promise<void> {
  const hashesFile = join(cloudServerDir(), 'lockfile-hashes.json');
  let hashes: Record<string, string> = {};
  try { hashes = JSON.parse(readFileSync(hashesFile, 'utf-8')); } catch { /* none yet */ }
  for (const spec of go.roots) {
    const local = cloudLocalPath(spec.absPath);
    if (!isRepoRoot(spec, local)) continue;
    let lock: { lockfile: string | null; sha256: string | null };
    try {
      lock = await runWorkerOp({ op: 'lockfile-hash', params: { root: local }, timeoutMs: SMALL_OP_TIMEOUT_MS });
    } catch { continue; }
    if (!lock.lockfile || !lock.sha256 || hashes[spec.rootId] === lock.sha256) continue;
    const cmd = INSTALL_COMMANDS[lock.lockfile];
    const done = cloudIdle()?.installBegin() ?? (() => { /* no clock */ });
    const code = await new Promise<number | null>((resolvePromise) => {
      try {
        const child = spawnAsWorker('/bin/bash', ['-lc', cmd], { cwd: local, stdio: ['ignore', 'ignore', 'ignore'] });
        child.on('error', () => resolvePromise(null));
        child.on('close', (c) => resolvePromise(c));
      } catch {
        resolvePromise(null);
      }
    }).finally(done);
    if (code === 0) {
      hashes[spec.rootId] = lock.sha256;
      writePrivateJson(hashesFile, hashes);
    } else {
      console.warn(`[handsfree-cloud] dependency install for ${spec.rootId} exited ${code}; the hash is not recorded`);
    }
  }
}

const postActivate: Handler = async (req, res) => {
  const body = await readJson(req);
  const tripId = tripIdOf(body.tripId);
  const { go } = currentTrip(tripId);
  const r = cloudServices().state.activate(tripId);
  if (!r.ok) throw new RouteError(409, r.error, 'That is not the trip this cloud holds.');
  // AC16: the trip arriving is the owner's real action (a go can take ~17 min of start, npm
  // install and transfer): the phone gets the full idle window from HERE, not from the last byte.
  cloudIdle()?.recordAction();
  sendJson(res, 200, { ok: true });
  void runInstalls(go).catch((err) => console.warn(`[handsfree-cloud] installs failed: ${(err as Error).message}`));
};

const postQuiesce: Handler = async (req, res) => {
  const body = await readJson(req);
  const tripId = tripIdOf(body.tripId);
  const { go } = currentTrip(tripId);
  const recovery = body.recovery === true;
  // The trip marker: present for THIS trip (normal), missing, or naming another trip (never
  // quiesced). A missing marker refuses a normal quiesce (trip_lost). A RECOVERY quiesce from
  // the laptop's transfer credential still quiesces under a new epoch and says so (`tripLost`)
  // so the laptop runs the full D12 recovery (cut -> tolerant snapshot -> park -> seal) —
  // but only while the trip's roots are on disk: "marker missing" is not "mirror gone" (a
  // deleted or unreadable marker, an unmounted HOME). No roots = nothing to recover from: 409
  // mirror_absent, nothing changes, nothing is ever sealed or wiped.
  const lost = await markerVerdict(go, tripId, { recovery, tolerant: true });
  const r = cloudServices().state.quiesce(tripId, { recovery });
  if (!r.ok) throw new RouteError(409, r.error, 'That is not the trip this cloud holds.');
  // D4: an idle chat is cut without asking (it stays resumable from its transcript), so
  // `running` keeps its wire meaning: running turns, plus work nobody registered.
  await cutIdleChats();
  sendJson(res, 200, { epoch: r.epoch, running: await runningInScope(go), ...(lost ? { tripLost: true } : {}) });
};

/** Every non-transcript root of the trip is on disk in the mirror (a missing one may hold work). */
function rootsPresent(go: GoManifest): boolean {
  return go.roots.filter((r) => r.kind !== 'transcripts').every((r) => {
    try { return lstatSync(cloudLocalPath(r.absPath)).isDirectory(); } catch { return false; }
  });
}

/**
 * The trip marker rule for quiesce and snapshot. Present for this trip: ok (false). Naming
 * another trip: trip_lost. Missing: trip_lost unless this is the laptop's recovery (a recovery
 * quiesce, a tolerant snapshot) AND the roots are on disk; then true (`tripLost`). Roots absent:
 * mirror_absent (never quiesced, never snapshotted, never sealed).
 */
async function markerVerdict(go: GoManifest, tripId: string, o: { recovery: boolean; tolerant: boolean }): Promise<boolean> {
  const m = await runWorkerOp<{ present: boolean; tripId?: string | null }>({ op: 'marker', params: { action: 'check', file: markerPath(go) }, timeoutMs: SMALL_OP_TIMEOUT_MS });
  if (m.present && m.tripId === tripId) return false;
  if (m.present || !o.recovery || !o.tolerant) throw new RouteError(409, 'trip_lost', 'The cloud mirror lost this trip (its marker is missing).');
  if (!rootsPresent(go)) {
    throw new RouteError(409, 'mirror_absent', 'The trip marker is missing and the trip\'s folders are not on this machine (is the mirror mounted?): nothing can be recovered, so nothing is sealed or wiped.');
  }
  return true;
}

const postCut: Handler = async (req, res) => {
  const body = await readJson(req);
  requireQuiescing(body.epoch);
  const { go } = currentTrip();
  const cut = await cutCloudScope(go);
  sendJson(res, 200, { ok: true, cut: cut.conversations, processes: cut.processes });
};

/**
 * D22: the cloud's Return cut is by PROCESS TREE, not by registry. The live chats go first
 * (their entries label the conversations), then the worker cuts every dcuser process whose
 * cwd is inside the mirror (the laptop HOME's mirror holds every root and any worktree the
 * phone created), process groups first, SIGKILL after the grace, until all are gone. The
 * server never matches: it is not dcuser, and the worker skips itself.
 */
async function cutCloudScope(go: GoManifest): Promise<{ conversations: string[]; processes: number[] }> {
  const conversations = await cutLiveChats(() => true);
  const r = await runWorkerOp<{ cut: number[] }>({
    op: 'cut-scope',
    params: { roots: scopeRoots(go), graceMs: 5_000 },
    timeoutMs: SMALL_OP_TIMEOUT_MS,
  });
  return { conversations, processes: r.cut };
}

function scopeRoots(go: GoManifest): string[] {
  return [homeLocal(go), ...go.roots.map((x) => cloudLocalPath(x.absPath))];
}

/** One entry of quiesce's `running` (wire: `{conversationId, startedAt}` plus additive fields). */
interface RunningEntry {
  conversationId: string | null;
  startedAt: number | null;
  pid: number;
  pgid: number;
  command: string;
}

/**
 * D22: what runs in the cloud's scope = the PROCESS SCAN (a dry run of the cut over dcuser
 * processes with cwd in the mirror home or a trip root), one entry per process group, named by
 * the chat registry where a chat child leads that group. A background task, a dev server or an
 * orphaned hook shows up here too, so the laptop waits for it and offers Cut.
 */
async function runningInScope(go: GoManifest): Promise<RunningEntry[]> {
  const r = await runWorkerOp<{ found: Array<{ pid: number; pgid: number; cwd: string; command: string }> }>({
    op: 'cut-scope', params: { roots: scopeRoots(go), dryRun: true }, timeoutMs: SMALL_OP_TIMEOUT_MS,
  });
  const chats = liveChatsByPgid();
  const byGroup = new Map<number, RunningEntry>();
  for (const f of r.found) {
    if (byGroup.has(f.pgid)) continue;
    const chat = chats.get(f.pgid);
    // A chat with no turn running is not running work (cutIdleChats ends it before a snapshot).
    if (chat && !chat.busy) continue;
    byGroup.set(f.pgid, {
      conversationId: chat?.conversationId ?? null,
      startedAt: chat?.startedAt ?? null,
      pid: chat ? f.pgid : f.pid,
      pgid: f.pgid,
      command: f.command,
    });
  }
  return [...byGroup.values()];
}

/** Registered chats with no turn running: cut (awaited, whole groups), never counted as running. */
async function cutIdleChats(): Promise<string[]> {
  return cutLiveChats((e) => !e.busy);
}

/** Seals and wipes in flight: while any runs, the cloud may not go active again. */
let finalizing = 0;

async function finalizingWhile<T>(fn: () => Promise<T>): Promise<T> {
  finalizing++;
  try {
    return await fn();
  } finally {
    finalizing--;
  }
}

const postUnquiesce: Handler = async (req, res) => {
  const body = await readJson(req);
  requireEpoch(body.epoch);
  // A wipe must never run inside a trip that went active again.
  if (finalizing > 0) throw new RouteError(409, 'finalizing', 'The cloud is wiping and sealing this return; it cannot go back to active now.');
  if (!cloudServices().state.unquiesce()) throw new RouteError(409, 'not_quiescing', 'The cloud is not quiescing.');
  // AC16: a cancelled Return puts the owner back mid-trip: a real action (the idle clock's own
  // revert of an unserved quiesce goes through state.unquiesce directly and does not count).
  cloudIdle()?.recordAction();
  sendJson(res, 200, { ok: true, phase: 'active' });
};

/** The downloads each epoch's snapshot produced (replaced by a retry, cleared by seal). */
const servedDownloads = new Map<number, string[]>();

interface RepoRootReply { rootId: string; kind: 'repo'; snapshot: RepoSnapshot; worktreesAdded: string[]; bundle?: { id: string; size: number; sha256: string } }
interface FilesRootReply { rootId: string; kind: 'files'; rootKind?: 'transcripts'; worktreePath?: string; manifest: ManifestEntry[]; refused: Array<{ path: string; reason: string }>; pack?: { id: string; size: number; sha256: string } }

const postSnapshot: Handler = async (req, res) => {
  const body = await readJson(req);
  const epoch = requireQuiescing(body.epoch);
  const { go, tripId } = currentTrip();
  // A missing marker is accepted only for the laptop's tolerant RECOVERY snapshot of roots that
  // are on disk (same rule as the lost-marker quiesce).
  await markerVerdict(go, tripId, { recovery: body.tolerant === true, tolerant: body.tolerant === true });
  // D22: never a snapshot over live work.
  await cutIdleChats(); // a chat that went idle after quiesce is cut, not counted
  const running = await runningInScope(go);
  if (running.length > 0) throw new RouteError(409, 'turns_running', 'Work is still running in the cloud; wait for it or cut it first.', { running });
  const tolerant = body.tolerant === true;
  const knownTips = (body.knownTips && typeof body.knownTips === 'object' ? body.knownTips : {}) as Record<string, unknown>;
  const repos = go.roots.filter((r) => isRepoRoot(r, cloudLocalPath(r.absPath)));
  const home = homeLocal(go);

  if (!tolerant) {
    const pf = await runWorkerOp<{ problems: unknown[] }>({
      op: 'preflight',
      params: { ...workerBase(), home, repos: repos.map((r) => ({ rootId: r.rootId, root: cloudLocalPath(r.absPath), git: gitSpecFor(tripId, r.rootId) })) },
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    if (pf.problems.length > 0) throw new RouteError(409, 'preflight', 'Resolve these on the phone first.', { problems: pf.problems });
  }

  const transfers = cloudServices().transfers;
  // A retried snapshot of the same epoch replaces the previous one's downloads.
  for (const id of servedDownloads.get(epoch) ?? []) transfers.deleteDownload(id);
  servedDownloads.delete(epoch);
  const roots: Array<RepoRootReply | FilesRootReply> = [];
  const goRootIds = go.roots.map((r) => r.rootId);
  const addedWorktrees: string[] = [];
  for (const spec of repos) {
    const dl = transfers.newDownloadPath();
    const r = await runWorkerOp<{ snapshot: RepoSnapshot; worktreesAdded: string[]; bundleCreated: boolean }>({
      op: 'snapshot-repo',
      params: {
        ...workerBase(), trip: tripId, repoRoot: cloudLocalPath(spec.absPath), home, tolerant, goRootIds, git: gitSpecFor(tripId, spec.rootId),
        knownTips: Array.isArray(knownTips[spec.rootId]) ? knownTips[spec.rootId] : [],
      },
      outputFile: dl.path,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    const entry: RepoRootReply = { rootId: spec.rootId, kind: 'repo', snapshot: r.snapshot, worktreesAdded: r.worktreesAdded };
    if (r.bundleCreated) entry.bundle = await transfers.finishDownload(dl.id);
    else rmSync(dl.path, { force: true });
    roots.push(entry);
    for (const wt of r.worktreesAdded) addedWorktrees.push(wt);
  }
  for (const spec of go.roots) {
    const dl = transfers.newDownloadPath();
    const atGo = recordedAtGo(tripId, spec.rootId);
    const r = await runWorkerOp<{ manifest: ManifestEntry[]; refused: Array<{ path: string; reason: string }>; packCreated: boolean }>({
      op: 'snapshot-files',
      params: { ...workerBase(), root: cloudLocalPath(spec.absPath), rootKind: spec.kind, atGo, include: includesFor(tripId, spec.rootId, atGo) },
      outputFile: dl.path,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    const entry: FilesRootReply = { rootId: spec.rootId, kind: 'files', manifest: r.manifest, refused: r.refused };
    if (r.packCreated) entry.pack = await transfers.finishDownload(dl.id);
    else rmSync(dl.path, { force: true });
    roots.push(entry);
  }
  // Wire v1.1: the transcripts of a worktree the phone created travel too, as a `transcripts`
  // files entry keyed by that worktree's root id (the laptop derives the destination itself).
  for (const wt of addedWorktrees) {
    const dir = join(cloudLocalPath(go.home), '.claude', 'projects', encodeProjectDir(wt));
    const dl = transfers.newDownloadPath();
    const r = await runWorkerOp<{ manifest: ManifestEntry[]; refused: Array<{ path: string; reason: string }>; packCreated: boolean }>({
      op: 'snapshot-files',
      params: { ...workerBase(), root: dir, rootKind: 'transcripts', atGo: [] },
      outputFile: dl.path,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    const entry: FilesRootReply = { rootId: rootIdFor(wt), kind: 'files', rootKind: 'transcripts', worktreePath: wt, manifest: r.manifest, refused: r.refused };
    if (r.packCreated) entry.pack = await transfers.finishDownload(dl.id);
    else rmSync(dl.path, { force: true });
    roots.push(entry);
  }
  servedDownloads.set(epoch, roots.flatMap((r) => {
    const d = r.kind === 'repo' ? r.bundle : r.pack;
    return d ? [d.id] : [];
  }));
  // Served: from here on quiescing never auto-reverts (AC13).
  cloudServices().state.markServed(epoch);
  sendJson(res, 200, { epoch, roots });
};

/** Wipe the secret class from every root of the trip, as dcuser (the same wipe everywhere). */
async function wipeSecretClass(go: GoManifest, tripId: string): Promise<{ wiped: number; failed: string[] }> {
  return runWorkerOp<{ wiped: number; failed: string[] }>({
    op: 'wipe-secrets',
    params: {
      ...workerBase(),
      home: homeLocal(go),
      roots: go.roots.map((s) => ({ root: cloudLocalPath(s.absPath), rootKind: s.kind, include: includesFor(tripId, s.rootId, recordedAtGo(tripId, s.rootId)) })),
    },
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  });
}

/**
 * D21: EVERY seal (the laptop's, and the cloud's own self-seal) wipes the secret class FIRST;
 * a wipe that leaves a file behind does not seal (a sealed cloud never holds the secret class).
 */
export async function wipeAndSeal(): Promise<{ wiped: number }> {
  return finalizingWhile(() => wipeAndSealNow());
}

async function wipeAndSealNow(): Promise<{ wiped: number }> {
  const svc = cloudServices();
  const start = svc.state.get();
  if (start.phase !== 'quiescing') throw new RouteError(409, 'not_quiescing', 'Only a quiescing cloud is sealed.');
  const { go, tripId } = currentTrip();
  // Order (D21/D22): nothing runs (it could write a secret back) → wipe → the return is still
  // the one we started for → seal.
  await cutCloudScope(go);
  const w = await wipeSecretClass(go, tripId);
  if (w.failed.length > 0) throw new RouteError(500, 'wipe_failed', `The secret class could not be wiped (${w.failed.length} file(s)); not sealed.`);
  const now = svc.state.get();
  if (now.phase !== 'quiescing' || now.epoch !== start.epoch || now.tripId !== start.tripId) {
    throw new RouteError(409, 'seal_aborted', 'The cloud left this return while the secret class was wiped; not sealed.');
  }
  svc.state.seal();
  svc.transfers.clearDownloads();
  servedDownloads.clear();
  return { wiped: w.wiped };
}

/** D21 verdict for wipe-secrets and seal: do it, already done, or the two refusals. */
function finalizeVerdict(epoch: unknown): 'do' | 'already_done' {
  const v = cloudServices().state.finalizeVerdict(epoch);
  if (v === 'epoch_mismatch') throw new RouteError(409, 'epoch_mismatch', 'That quiesce epoch is older than the current one.');
  if (v === 'not_quiescing') throw new RouteError(409, 'not_quiescing', 'The cloud is not quiescing; quiesce it first.');
  return v;
}

/**
 * A lost-marker trip is only ever wiped or sealed AFTER its recovery snapshot was served under
 * this epoch (D12: quiesce -> cut -> snapshot -> seal): otherwise the phone's work is destroyed.
 */
async function requireSnapshotIfLost(go: GoManifest, tripId: string, epoch: unknown): Promise<void> {
  const m = await runWorkerOp<{ present: boolean; tripId?: string | null }>({ op: 'marker', params: { action: 'check', file: markerPath(go) }, timeoutMs: SMALL_OP_TIMEOUT_MS });
  if (m.present && m.tripId === tripId) return;
  if (cloudServices().state.get().servedEpoch !== epoch) {
    throw new RouteError(409, 'snapshot_first', 'This trip lost its marker: its recovery snapshot must be taken under this epoch before it is wiped or sealed.');
  }
}

const postWipeSecrets: Handler = async (req, res) => {
  const body = await readJson(req);
  const v = finalizeVerdict(body.epoch);
  const { go, tripId } = currentTrip();
  if (v === 'do') await requireSnapshotIfLost(go, tripId, body.epoch);
  // Idempotent: sealed at this epoch re-runs the (no-op) wipe and says so.
  const r = await finalizingWhile(() => wipeSecretClass(go, tripId));
  if (r.failed.length > 0) {
    // A partial wipe is never "done": 500 wipe_failed (the code seal answers for the same
    // case), ok:false, the files that stayed listed.
    sendJson(res, 500, { ok: false, error: 'wipe_failed', message: `The secret class could not be wiped (${r.failed.length} file(s)).`, wiped: r.wiped, failed: r.failed });
    return;
  }
  if (v === 'already_done') { sendJson(res, 200, { ok: true, alreadyDone: true, wiped: r.wiped, failed: r.failed }); return; }
  sendJson(res, 200, { ok: true, wiped: r.wiped, failed: r.failed });
};

const postSeal: Handler = async (req, res) => {
  const body = await readJson(req);
  if (finalizeVerdict(body.epoch) === 'already_done') { sendJson(res, 200, { ok: true, alreadyDone: true, phase: 'sealed' }); return; }
  const { go, tripId } = currentTrip();
  await requireSnapshotIfLost(go, tripId, body.epoch);
  await wipeAndSeal();
  sendJson(res, 200, { ok: true, phase: 'sealed' });
};

const getAccounts: Handler = async (_req, res) => {
  const out: Array<{ id: string; label: string; signedIn: boolean }> = [];
  for (const acc of listClaudeAccounts()) {
    let signedIn = false;
    try {
      signedIn = (await claudeAuthStatus(sandboxDirFor(acc.id))).loggedIn === true;
    } catch { /* unknown = not signed in */ }
    out.push({ id: acc.id, label: acc.email || acc.id, signedIn });
  }
  sendJson(res, 200, out);
};

/** PINNED for lane E: one call in `buildRouter`. */
export function registerHandsfreeCloudRoutes(router: Router): void {
  const base = '/api/handsfree/cloud';
  router.put(`${base}/upload/:uploadId/:n`, route(putChunk));
  router.post(`${base}/upload/:uploadId/commit`, route(commitUpload));
  router.get(`${base}/download/:downloadId`, route(getDownload));
  router.post(`${base}/verifiers`, route(postVerifiers));
  router.post(`${base}/revoke-all`, route(postRevokeAll));
  router.post(`${base}/runtime`, route(postRuntime));
  router.post(`${base}/trip`, route(postTrip));
  router.get(`${base}/state`, route(getState));
  router.post(`${base}/git/receive`, route(postGitReceive));
  router.post(`${base}/files/receive`, route(postFilesReceive));
  router.post(`${base}/global`, route(postGlobal));
  router.post(`${base}/activate`, route(postActivate));
  router.post(`${base}/quiesce`, route(postQuiesce));
  router.post(`${base}/cut`, route(postCut));
  router.post(`${base}/unquiesce`, route(postUnquiesce));
  router.post(`${base}/snapshot`, route(postSnapshot));
  router.post(`${base}/wipe-secrets`, route(postWipeSecrets));
  router.post(`${base}/seal`, route(postSeal));
  router.get(`${base}/accounts`, route(getAccounts));
}

/** Build the idle clock over these services (cloud serve calls it once). */
export function createCloudIdle(bootId: string, now?: () => number): CloudIdle {
  const svc = cloudServices();
  return new CloudIdle({
    now,
    liveChats: liveChatsSnapshot,
    trip: () => {
      const r = svc.state.get();
      return { phase: r.phase, goingSince: r.goingSince, quiescingSince: r.quiescingSince, servedEpoch: r.servedEpoch, epoch: r.epoch, lastLaptopProgressAt: r.lastLaptopProgressAt, noRevert: r.noRevert };
    },
    // Never while a wipe/seal runs (it would put a trip being wiped back to active).
    onRevert: () => { if (finalizing === 0) svc.state.unquiesce(); },
    // D21: the self-seal (the 2 h quiescing cap) wipes the secret class first.
    onSeal: async () => {
      try {
        await wipeAndSeal();
      } catch (err) {
        // A self-seal that cannot finish is visible (health: sealBlocked) and retried next tick.
        if (!(err instanceof RouteError && err.code === 'seal_aborted')) svc.state.recordSealBlocked((err as Error).message);
        throw err;
      }
    },
    publicDir: cloudPublicDir(),
    bootId,
  });
}
