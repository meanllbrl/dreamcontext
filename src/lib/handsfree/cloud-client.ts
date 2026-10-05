/**
 * The laptop's transfer client: PINNED WIRE CONTRACT v1 (lane D serves it in
 * `src/server/routes/handsfree-cloud.ts`; nothing here imports that module). Every JSON
 * shape is declared here for this side and every reply is validated before use.
 *
 * Each request: `GET /api/health` (no credential) for a single-use nonce in
 * `X-Dreamcontext-Nonce`, then the request with `Authorization: DC-HF-HMAC <nonce> <mac>`
 * ({@link transferAuthorization}, bound to method + exact path-with-query) and, on every
 * non-GET, `Origin: <DC_HF_ORIGIN>`. Client rules: a timeout on every request (30 s, 10 min
 * for a chunk); retry with backoff on network errors, 502, 503, 504; for 30 s after a start a
 * 302 to github.com is retried too (the port is private ~10 s after a start, W0); after that
 * such a 302 is {@link PortPrivateError} (AC1). Bodies are <= 8 MiB: anything bigger goes
 * through uploads/downloads (GitHub's forwarder refuses bodies >= 32 MB).
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { transferAuthorization, transferKeyFromSecret, type VerifierPush } from '../../server/handsfree-auth.js';
import type { GoManifest, ManifestEntry } from './manifest.js';
import type { RepoSnapshot } from './git-snapshot.js';

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
export const CHUNK_TIMEOUT_MS = 10 * 60_000;
/** The cloud allows a snapshot 30 min; the client waits longer so it never retries one still running. */
export const SNAPSHOT_TIMEOUT_MS = 35 * 60_000;
/** For this long after a start, a 302 to GitHub is the port still turning public (W0: ~10 s). */
export const START_GRACE_MS = 30_000;
const NONCE_HEADER = 'x-dreamcontext-nonce';

// ---------------------------------------------------------------- wire types (this side's copy)

export type CloudPhaseName = 'sealed' | 'active' | 'quiescing';

export interface PublicHealth { version: string; fingerprint: string | null }
export interface CloudHealth extends PublicHealth {
  phase: CloudPhaseName;
  tripId: string | null;
  laptopId: string | null;
  epoch: number;
  verifierGeneration: number;
  supersededLaptopIds: string[];
  /** D21: the epoch the cloud was last sealed under (null before the first seal). */
  sealedEpoch: number | null;
}

export type InstallResultWire =
  | { ok: true; generation: number; changed: boolean }
  | { ok: false; error: string; generation: number };

export interface BlobRef { id: string; size: number; sha256: string }

export type RootState =
  | { kind: 'repo'; snapshot: unknown; baseTips: string[] }
  | { kind: 'files'; manifest: unknown[] };

export type SnapshotRoot =
  | { rootId: string; kind: 'repo'; snapshot: unknown; worktreesAdded: string[]; bundle?: BlobRef }
  | { rootId: string; kind: 'files'; manifest: unknown[]; refused: Array<{ path: string; reason: string }>; pack?: BlobRef };

export interface SnapshotReply { epoch: number; roots: SnapshotRoot[] }
/** Wire v1.1: the laptop's `.git/info/` files as text (<= 256 KiB each) and its remotes. */
export interface GitInfo { exclude?: string; attributes?: string }
export interface GitRemote { name: string; url: string }
export interface GitReceiveBody {
  tripId: string;
  rootId: string;
  uploadId?: string;
  snapshot: RepoSnapshot;
  info: GitInfo;
  remotes: GitRemote[];
}

/** A running turn or (lane D, D22) a live process from the cloud's process scan (pid + command, maybe no conversation). */
export interface RunningTurn { conversationId: string; startedAt: number; pid?: number; command?: string }
export interface CloudAccount { id: string; label: string; signedIn: boolean }

export interface CloudClient {
  readonly origin: string;
  /** A start was just requested: 302s to GitHub are retried for {@link START_GRACE_MS}. */
  markStarted(at?: number): void;
  publicHealth(): Promise<PublicHealth>;
  health(): Promise<CloudHealth>;
  uploadFile(path: string): Promise<string>;
  downloadTo(blob: BlobRef, path: string): Promise<void>;
  verifiers(push: VerifierPush): Promise<InstallResultWire>;
  revokeAll(generation: number): Promise<InstallResultWire>;
  /** D25: install this exact npm version (the root supervisor fetches + verifies it), then restart. */
  runtime(pin: { version: string; integrity: string }): Promise<void>;
  /** v1.1: `includes` = each root's `handsfree.include` patterns, root-relative. */
  trip(body: { tripId: string; laptopId: string; go: GoManifest; takeOver?: boolean; includes: Record<string, string[]> }): Promise<void>;
  state(rootId: string): Promise<RootState>;
  /** v1.1: `info` (the laptop's .git/info/exclude + attributes) and `remotes` (userinfo stripped). */
  gitReceive(body: GitReceiveBody): Promise<{ snapshotId: string }>;
  filesReceive(body: { tripId: string; rootId: string; uploadId?: string; expected: ManifestEntry[] }): Promise<{ refused: Array<{ path: string; reason: string }>; digest: string }>;
  global(uploadId: string): Promise<void>;
  activate(tripId: string): Promise<void>;
  /** `tripLost`: a RECOVERY quiesce of a cloud whose trip marker is missing (it still quiesced). */
  quiesce(tripId: string, recovery?: boolean): Promise<{ epoch: number; running: RunningTurn[]; tripLost?: boolean }>;
  cut(epoch: number): Promise<void>;
  unquiesce(epoch: number): Promise<void>;
  snapshot(body: { epoch: number; tolerant?: boolean; knownTips: Record<string, string[]> }): Promise<SnapshotReply>;
  wipeSecrets(epoch: number): Promise<void>;
  seal(epoch: number): Promise<void>;
  accounts(): Promise<CloudAccount[]>;
}

// ---------------------------------------------------------------- errors

/** The cloud answered with an error (`sendError` body `{error, message}`), e.g. `epoch_mismatch`. */
export class CloudError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: unknown = null) {
    super(message);
    this.name = 'CloudError';
  }
}

/** The forwarded port answers with a GitHub sign-in redirect instead of our server (AC1). */
export class PortPrivateError extends Error {
  constructor(readonly origin: string) {
    super(
      `The cloud machine's port 8080 is private (GitHub answered with a sign-in redirect instead of the dreamcontext server). `
      + `Open https://github.com/codespaces, open the codespace's Ports panel and set port 8080 to Public, then run the command again.`,
    );
    this.name = 'PortPrivateError';
  }
}

export class CloudUnreachableError extends Error {
  /** The `error` code of the last 502/503/504 body, when there was one (e.g. `mirror_pending`). */
  constructor(message: string, readonly lastCode: string | null = null) {
    super(message);
    this.name = 'CloudUnreachableError';
  }
}

/** sha256 over the sorted `path\0sha256\n` lines: the files/receive equality digest. */
export function manifestDigest(entries: Iterable<{ path: string; sha256: string }>): string {
  const lines = [...entries].map((e) => `${e.path}\0${e.sha256}\n`).sort();
  const h = createHash('sha256');
  for (const l of lines) h.update(l);
  return h.digest('hex');
}

// ---------------------------------------------------------------- validation helpers

const ID_RE = /^[a-z0-9-]{8,64}$/;
const ROOT_ID_RE = /^r-[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function bad(what: string): CloudError {
  return new CloudError(0, 'bad_reply', `the cloud sent an unexpected reply (${what})`);
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function blobRef(v: unknown): BlobRef | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v) || typeof v.id !== 'string' || !ID_RE.test(v.id) || !isInt(v.size) || typeof v.sha256 !== 'string' || !HEX64.test(v.sha256)) throw bad('blob');
  return { id: v.id, size: v.size, sha256: v.sha256 };
}

function installResult(v: unknown): InstallResultWire {
  if (!isObj(v) || !isInt(v.generation)) throw bad('install result');
  if (v.ok === true) return { ok: true, generation: v.generation, changed: v.changed === true };
  if (v.ok === false && typeof v.error === 'string') return { ok: false, error: v.error, generation: v.generation };
  throw bad('install result');
}

function publicHealthOf(v: unknown): PublicHealth {
  if (!isObj(v) || typeof v.version !== 'string' || (typeof v.fingerprint !== 'string' && v.fingerprint !== null && v.fingerprint !== undefined)) throw bad('health');
  return { version: v.version, fingerprint: typeof v.fingerprint === 'string' ? v.fingerprint : null };
}

function healthOf(v: unknown): CloudHealth {
  const p = publicHealthOf(v);
  const o = v as Record<string, unknown>;
  if (o.phase !== 'sealed' && o.phase !== 'active' && o.phase !== 'quiescing') throw bad('health without a phase (transfer proof refused?)');
  const str = (x: unknown) => (typeof x === 'string' ? x : null);
  return {
    ...p,
    phase: o.phase,
    tripId: str(o.tripId),
    laptopId: str(o.laptopId),
    epoch: isInt(o.epoch) ? o.epoch : 0,
    verifierGeneration: isInt(o.verifierGeneration) ? o.verifierGeneration : 0,
    supersededLaptopIds: Array.isArray(o.supersededLaptopIds) ? o.supersededLaptopIds.filter((x): x is string => typeof x === 'string') : [],
    sealedEpoch: isInt(o.sealedEpoch) ? o.sealedEpoch : null,
  };
}

function snapshotRootOf(v: unknown): SnapshotRoot {
  if (!isObj(v) || typeof v.rootId !== 'string' || !ROOT_ID_RE.test(v.rootId)) throw bad('snapshot root id');
  if (v.kind === 'repo') {
    const wt = Array.isArray(v.worktreesAdded) ? v.worktreesAdded : [];
    if (!wt.every((x) => typeof x === 'string' && x.startsWith('/'))) throw bad('worktreesAdded');
    return { rootId: v.rootId, kind: 'repo', snapshot: v.snapshot, worktreesAdded: wt as string[], ...(v.bundle ? { bundle: blobRef(v.bundle) } : {}) };
  }
  if (v.kind === 'files') {
    if (!Array.isArray(v.manifest)) throw bad('files manifest');
    const refused = Array.isArray(v.refused) ? v.refused : [];
    if (!refused.every((r) => isObj(r) && typeof r.path === 'string' && typeof r.reason === 'string')) throw bad('refused list');
    return {
      rootId: v.rootId, kind: 'files', manifest: v.manifest,
      refused: (refused as Array<{ path: string; reason: string }>).map((r) => ({ path: r.path, reason: r.reason.slice(0, 300) })),
      ...(v.pack ? { pack: blobRef(v.pack) } : {}),
    };
  }
  throw bad('snapshot root kind');
}

// ---------------------------------------------------------------- HTTP implementation

type FetchImpl = typeof globalThis.fetch;

export interface HttpCloudClientOptions {
  /** `https://<codespace>-8080.<domain>` (= DC_HF_ORIGIN), no trailing slash. */
  origin: string;
  /** The laptop's 32-byte transfer secret (base64url). */
  secret: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Attempts per request (network errors, 502/503/504, early 302s). Default 6. */
  attempts?: number;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

export class HttpCloudClient implements CloudClient {
  readonly origin: string;
  private readonly key: Buffer;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly attempts: number;
  private startedAt = -Infinity;

  constructor(o: HttpCloudClientOptions) {
    this.origin = o.origin.replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+$/.test(this.origin)) throw new Error(`bad cloud origin ${o.origin}`);
    this.key = transferKeyFromSecret(o.secret);
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
    this.attempts = o.attempts ?? 6;
  }

  markStarted(at: number = this.now()): void {
    this.startedAt = at;
  }

  private redirectVerdict(res: Response): 'retry' | 'private' | null {
    if (res.status < 300 || res.status >= 400) return null;
    const loc = res.headers.get('location') ?? '';
    if (!/github\.com|github\.dev/i.test(loc)) return null;
    return this.now() - this.startedAt < START_GRACE_MS ? 'retry' : 'private';
  }

  private async fetchOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return this.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  }

  /**
   * One logical request with retries. `auth` = false for the public health call. Returns the
   * successful Response (2xx); throws CloudError / PortPrivateError / CloudUnreachableError.
   */
  private async send(method: string, target: string, o: { auth: boolean; body?: Buffer; contentType?: string; timeoutMs?: number }): Promise<Response> {
    let lastErr = 'no attempt';
    let lastCode: string | null = null;
    for (let i = 0; i < this.attempts; i++) {
      if (i > 0) await this.sleep(BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)]);
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (o.auth) {
          const h = await this.fetchOnce(this.origin + '/api/health', { method: 'GET', headers: { Accept: 'application/json' } }, REQUEST_TIMEOUT_MS);
          const rv = this.redirectVerdict(h);
          if (rv === 'private') throw new PortPrivateError(this.origin);
          if (rv === 'retry' || [502, 503, 504].includes(h.status)) { lastErr = `health ${h.status}`; await h.body?.cancel().catch(() => {}); continue; }
          const nonce = h.headers.get(NONCE_HEADER);
          await h.body?.cancel().catch(() => {});
          if (!nonce) {
            lastErr = `health ${h.status} without a nonce`;
            if (h.status >= 200 && h.status < 300) throw new CloudError(h.status, 'no_nonce', 'the cloud did not hand out a transfer nonce (is it a dreamcontext cloud server?)');
            continue;
          }
          headers.Authorization = transferAuthorization(this.key, nonce, method, target);
        }
        if (method !== 'GET') headers.Origin = this.origin;
        if (o.body) headers['Content-Type'] = o.contentType ?? 'application/json';
        const res = await this.fetchOnce(this.origin + target, { method, headers, ...(o.body ? { body: new Uint8Array(o.body) } : {}) }, o.timeoutMs ?? REQUEST_TIMEOUT_MS);
        const rv = this.redirectVerdict(res);
        if (rv === 'private') throw new PortPrivateError(this.origin);
        if (rv === 'retry' || [502, 503, 504].includes(res.status)) {
          lastErr = `${res.status}`;
          const text = await res.text().catch(() => '');
          try { const b = JSON.parse(text) as { error?: unknown }; lastCode = typeof b.error === 'string' ? b.error : null; } catch { lastCode = null; }
          continue;
        }
        if (res.status >= 200 && res.status < 300) return res;
        let body: unknown = null;
        const text = await res.text().catch(() => '');
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        const code = isObj(body) && typeof body.error === 'string' ? body.error : `http_${res.status}`;
        const msg = isObj(body) && typeof body.message === 'string' ? body.message : `${method} ${target.split('?')[0]} failed (${res.status})`;
        throw new CloudError(res.status, code, msg.slice(0, 500), body);
      } catch (err) {
        if (err instanceof CloudError || err instanceof PortPrivateError) throw err;
        lastErr = (err as Error).name || 'network error';
      }
    }
    throw new CloudUnreachableError(`the cloud machine did not answer ${method} ${target.split('?')[0]} (${lastErr}${lastCode ? ` ${lastCode}` : ''})`, lastCode);
  }

  private async json(method: string, target: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    let buf: Buffer | undefined;
    if (body !== undefined) {
      buf = Buffer.from(JSON.stringify(body));
      if (buf.length > CHUNK_BYTES) throw new CloudError(0, 'body_too_large', `request body for ${target} is ${buf.length} bytes (> 8 MiB)`);
    }
    const res = await this.send(method, target, { auth: true, body: buf, timeoutMs });
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw bad(`${target} is not JSON`); }
  }

  async publicHealth(): Promise<PublicHealth> {
    const res = await this.send('GET', '/api/health', { auth: false });
    return publicHealthOf(await res.json().catch(() => null));
  }

  async health(): Promise<CloudHealth> {
    return healthOf(await this.json('GET', '/api/health'));
  }

  async uploadFile(path: string): Promise<string> {
    const id = `up-${randomBytes(12).toString('hex')}`;
    const size = statSync(path).size;
    const h = createHash('sha256');
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(CHUNK_BYTES);
      let off = 0;
      let n = 0;
      while (off < size || (size === 0 && n === 0)) {
        const got = size === 0 ? 0 : readSync(fd, buf, 0, Math.min(CHUNK_BYTES, size - off), off);
        const chunk = Buffer.from(buf.subarray(0, got));
        h.update(chunk);
        await this.send('PUT', `/api/handsfree/cloud/upload/${id}/${n}`, { auth: true, body: chunk, contentType: 'application/octet-stream', timeoutMs: CHUNK_TIMEOUT_MS });
        off += got;
        n++;
        if (size === 0) break;
      }
    } finally {
      closeSync(fd);
    }
    await this.json('POST', `/api/handsfree/cloud/upload/${id}/commit`, { size, sha256: h.digest('hex') });
    return id;
  }

  async downloadTo(blob: BlobRef, path: string): Promise<void> {
    if (!ID_RE.test(blob.id)) throw bad('download id');
    const tmp = `${path}.part-${randomBytes(4).toString('hex')}`;
    const fd = openSync(tmp, 'wx', 0o600);
    const h = createHash('sha256');
    let off = 0;
    try {
      while (off < blob.size) {
        const length = Math.min(CHUNK_BYTES, blob.size - off);
        const res = await this.send('GET', `/api/handsfree/cloud/download/${blob.id}?offset=${off}&length=${length}`, { auth: true, timeoutMs: CHUNK_TIMEOUT_MS });
        const chunk = Buffer.from(await res.arrayBuffer());
        if (chunk.length === 0 || chunk.length > length) throw bad('download chunk size');
        h.update(chunk);
        let w = 0;
        while (w < chunk.length) w += writeSync(fd, chunk, w, chunk.length - w, off + w);
        off += chunk.length;
      }
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw err;
    }
    closeSync(fd);
    if (h.digest('hex') !== blob.sha256) {
      rmSync(tmp, { force: true });
      throw new CloudError(0, 'download_mismatch', `download ${blob.id} does not match its sha256`);
    }
    renameSync(tmp, path);
  }

  async verifiers(push: VerifierPush): Promise<InstallResultWire> {
    return installResult(await this.json('POST', '/api/handsfree/cloud/verifiers', push));
  }

  async revokeAll(generation: number): Promise<InstallResultWire> {
    return installResult(await this.json('POST', '/api/handsfree/cloud/revoke-all', { generation }));
  }

  async runtime(pin: { version: string; integrity: string }): Promise<void> {
    const r = await this.json('POST', '/api/handsfree/cloud/runtime', { version: pin.version, integrity: pin.integrity });
    if (!isObj(r) || r.ok !== true) throw bad('runtime');
  }

  async trip(body: { tripId: string; laptopId: string; go: GoManifest; takeOver?: boolean; includes: Record<string, string[]> }): Promise<void> {
    await this.json('POST', '/api/handsfree/cloud/trip', body);
  }

  async state(rootId: string): Promise<RootState> {
    if (!ROOT_ID_RE.test(rootId)) throw new Error(`bad root id ${rootId}`);
    const r = await this.json('GET', `/api/handsfree/cloud/state?rootId=${rootId}`);
    if (isObj(r) && r.kind === 'repo') {
      const tips = Array.isArray(r.baseTips) ? r.baseTips : [];
      if (!tips.every((t) => typeof t === 'string' && OID_RE.test(t))) throw bad('base tips');
      return { kind: 'repo', snapshot: r.snapshot, baseTips: tips as string[] };
    }
    if (isObj(r) && r.kind === 'files' && Array.isArray(r.manifest)) return { kind: 'files', manifest: r.manifest };
    throw bad('state');
  }

  async gitReceive(body: GitReceiveBody): Promise<{ snapshotId: string }> {
    const r = await this.json('POST', '/api/handsfree/cloud/git/receive', body, CHUNK_TIMEOUT_MS);
    if (!isObj(r) || r.ok !== true || typeof r.snapshotId !== 'string' || !HEX64.test(r.snapshotId)) throw bad('git/receive');
    return { snapshotId: r.snapshotId };
  }

  async filesReceive(body: { tripId: string; rootId: string; uploadId?: string; expected: ManifestEntry[] }) {
    const r = await this.json('POST', '/api/handsfree/cloud/files/receive', body, CHUNK_TIMEOUT_MS);
    if (!isObj(r) || r.ok !== true || typeof r.digest !== 'string' || !HEX64.test(r.digest)) throw bad('files/receive');
    const refused = Array.isArray(r.refused) ? r.refused : [];
    if (!refused.every((x) => isObj(x) && typeof x.path === 'string')) throw bad('files/receive refused');
    return { refused: (refused as Array<{ path: string; reason?: unknown }>).map((x) => ({ path: x.path, reason: typeof x.reason === 'string' ? x.reason : 'refused' })), digest: r.digest };
  }

  async global(uploadId: string): Promise<void> {
    await this.json('POST', '/api/handsfree/cloud/global', { uploadId }, CHUNK_TIMEOUT_MS);
  }

  async activate(tripId: string): Promise<void> {
    await this.json('POST', '/api/handsfree/cloud/activate', { tripId });
  }

  async quiesce(tripId: string, recovery?: boolean): Promise<{ epoch: number; running: RunningTurn[]; tripLost?: boolean }> {
    const r = await this.json('POST', '/api/handsfree/cloud/quiesce', { tripId, ...(recovery ? { recovery: true } : {}) });
    if (!isObj(r) || !isInt(r.epoch) || !Array.isArray(r.running)) throw bad('quiesce');
    // Every entry counts as running work (a process entry may carry only pid + command).
    const running = (r.running as unknown[]).filter(isObj).map((x) => ({
      conversationId: typeof x.conversationId === 'string' ? x.conversationId : '',
      startedAt: Number(x.startedAt) || 0,
      ...(isInt(x.pid) ? { pid: x.pid } : {}),
      ...(typeof x.command === 'string' ? { command: x.command.slice(0, 200) } : {}),
    }));
    return { epoch: r.epoch, running, ...(r.tripLost === true ? { tripLost: true } : {}) };
  }

  async cut(epoch: number): Promise<void> {
    await this.json('POST', '/api/handsfree/cloud/cut', { epoch }, 2 * 60_000);
  }

  async unquiesce(epoch: number): Promise<void> {
    await this.json('POST', '/api/handsfree/cloud/unquiesce', { epoch });
  }

  async snapshot(body: { epoch: number; tolerant?: boolean; knownTips: Record<string, string[]> }): Promise<SnapshotReply> {
    const r = await this.json('POST', '/api/handsfree/cloud/snapshot', body, SNAPSHOT_TIMEOUT_MS);
    if (!isObj(r) || !isInt(r.epoch) || !Array.isArray(r.roots)) throw bad('snapshot');
    return { epoch: r.epoch, roots: r.roots.map(snapshotRootOf) };
  }

  async wipeSecrets(epoch: number): Promise<void> {
    await this.json('POST', '/api/handsfree/cloud/wipe-secrets', { epoch }, 5 * 60_000);
  }

  async seal(epoch: number): Promise<void> {
    await this.json('POST', '/api/handsfree/cloud/seal', { epoch });
  }

  async accounts(): Promise<CloudAccount[]> {
    const r = await this.json('GET', '/api/handsfree/cloud/accounts');
    if (!Array.isArray(r)) throw bad('accounts');
    return r.filter(isObj).filter((a) => typeof a.id === 'string')
      .map((a) => ({ id: a.id as string, label: typeof a.label === 'string' ? a.label : (a.id as string), signedIn: a.signedIn === true }));
  }
}
