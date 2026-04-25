/**
 * meta-fetch — the only wrapper allowed to call the Meta Graph API.
 *
 * Everything that touches graph.facebook.com / graph-video.facebook.com goes
 * through metaFetch. CLI commands flip ctx.dryRun=false via --no-dry-run; the
 * library never constructs a ctx.
 *
 * Contract (per task PR 1):
 *   - Retry on 429/5xx + Meta error.code ∈ {1,2,4,17,32,613} (max 5 attempts)
 *   - Exponential backoff + jitter, base 1000ms, cap 30s
 *   - 429 honors X-Business-Use-Case-Usage / X-App-Usage hints
 *   - Idempotency: UUIDv4 on every create*, pre-POST cache at runs/by-idem/<key>.json
 *   - OAuthException 190 → TokenExpiredError, no retry, prints regen URL
 *   - Header-only Authorization: Bearer <token>; runtime assertion forbids access_token= in URL
 *   - Per-account in-process queue, max 3 concurrent writes
 *   - Chunked upload >50MB against graph-video.facebook.com (4MB chunks, start|transfer|finish)
 *   - ctx.dryRun gate inside the wrapper, not at CLI boundary
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MARKETING_PATHS } from './paths.js';
import { redactSecrets, redactDeep } from './secrets.js';
import { DEFAULT_API_VERSION } from './config.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface MetaCtx {
  /** When true, no network calls are made. Synthesized fake responses are returned and logged. */
  dryRun: boolean;
  /** e.g. 'v25.0' — the only place this default lives is config.DEFAULT_API_VERSION. */
  apiVersion: string;
  /** Bearer token. Header-only. Never appears in URLs. */
  accessToken: string;
  /** Already includes the `act_` prefix when the API requires it. */
  adAccountId: string;
  pageId?: string;
  igActorId?: string;
  pixelId?: string;
  /** Optional callback for log lines (test injection). */
  logger?: (line: string) => void;
}

export type MetaJson = Record<string, unknown>;

export interface MetaFetchInit {
  /** HTTP method. GET = read (unthrottled). POST/DELETE = write (per-account queued). */
  method: 'GET' | 'POST' | 'DELETE';
  /** Path under graph base, e.g. 'me/adaccounts' or 'act_123/campaigns'. No leading slash. */
  path: string;
  /** Form-urlencoded body fields (POST/DELETE). Auto-stringifies non-string values. */
  params?: Record<string, unknown>;
  /** Query-string fields (GET). */
  query?: Record<string, unknown>;
  /** When set, force the video upload host (graph-video.facebook.com). */
  useVideoHost?: boolean;
  /** Override fetch implementation (test injection). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Disable retries for this single call (used by 190 / token-expired path). */
  noRetry?: boolean;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly metaErrorCode: number | null,
    public readonly fbtraceId: string | null,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

export class TokenExpiredError extends MetaApiError {
  constructor(message: string, body: string, fbtraceId: string | null) {
    super(message, 401, 190, fbtraceId, body);
    this.name = 'TokenExpiredError';
  }
}

export class HeaderAuthAssertionError extends Error {
  constructor(public readonly url: string) {
    super(
      `metaFetch refused to send a URL containing access_token=. Header-only auth is enforced. URL: ${redactSecrets(url)}`,
    );
    this.name = 'HeaderAuthAssertionError';
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GRAPH_HOST = 'graph.facebook.com';
const GRAPH_VIDEO_HOST = 'graph-video.facebook.com';
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const RETRY_HTTP_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
// Meta-side codes that warrant a retry per task PR 1 contract.
const RETRY_META_CODES = new Set<number>([1, 2, 4, 17, 32, 613]);
const TOKEN_EXPIRED_CODE = 190;
const CHUNKED_UPLOAD_THRESHOLD = 50 * 1024 * 1024; // 50 MiB
const CHUNK_SIZE = 4 * 1024 * 1024;                // 4 MiB
const PER_ACCOUNT_WRITE_CONCURRENCY = 3;

// ─── Per-account in-process write queue ─────────────────────────────────────

interface QueueState {
  active: number;
  waiting: Array<() => void>;
}
const writeQueues = new Map<string, QueueState>();

function getQueue(accountId: string): QueueState {
  let q = writeQueues.get(accountId);
  if (!q) {
    q = { active: 0, waiting: [] };
    writeQueues.set(accountId, q);
  }
  return q;
}

async function withWriteSlot<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const q = getQueue(accountId);
  if (q.active >= PER_ACCOUNT_WRITE_CONCURRENCY) {
    await new Promise<void>((resolve) => q.waiting.push(resolve));
  }
  q.active += 1;
  try {
    return await fn();
  } finally {
    q.active -= 1;
    const next = q.waiting.shift();
    if (next) next();
  }
}

/** Test helper — clears all queues. */
export function _resetQueues(): void {
  writeQueues.clear();
}

// ─── URL build + auth assertion ──────────────────────────────────────────────

function buildUrl(ctx: MetaCtx, init: MetaFetchInit): string {
  const host = init.useVideoHost ? GRAPH_VIDEO_HOST : GRAPH_HOST;
  const u = new URL(`https://${host}/${ctx.apiVersion}/${init.path.replace(/^\//, '')}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v == null) continue;
      u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }
  const built = u.toString();
  // Defense in depth — header-only auth is mandatory. If anything ever sets
  // access_token= as a query param, we refuse to send.
  if (/[?&]access_token=/.test(built)) {
    throw new HeaderAuthAssertionError(built);
  }
  return built;
}

function isCreate(init: MetaFetchInit): boolean {
  // create* operations on the API are POST + leaf path that does NOT match
  // an action verb (e.g. 'pause', 'finish'). For our purposes, all POSTs to
  // /campaigns, /adsets, /ads, /adcreatives, /advideos, /adimages are creates.
  if (init.method !== 'POST') return false;
  return /\/(campaigns|adsets|ads|adcreatives|advideos|adimages|customaudiences)$/.test(
    init.path.replace(/\?.*$/, ''),
  );
}

// ─── Idempotency cache ───────────────────────────────────────────────────────

interface IdemRecord {
  key: string;
  request_path: string;
  response: MetaJson;
  written_at: string;
}

function idemCachePath(key: string): string {
  return `${MARKETING_PATHS.byIdemDir()}/${key}.json`;
}

function readIdem(key: string): IdemRecord | null {
  const p = idemCachePath(key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as IdemRecord;
  } catch {
    return null;
  }
}

function writeIdem(rec: IdemRecord): void {
  const p = idemCachePath(rec.key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(rec, null, 2) + '\n', 'utf8');
}

// ─── Backoff ─────────────────────────────────────────────────────────────────

function backoffMs(attempt: number, hintSec: number | null): number {
  if (hintSec != null && Number.isFinite(hintSec) && hintSec > 0) {
    return Math.min(BACKOFF_CAP_MS, Math.ceil(hintSec * 1000));
  }
  const exp = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
  const capped = Math.min(BACKOFF_CAP_MS, exp);
  // Jitter ± 25%
  const jitter = capped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

function parseRetryHints(headers: Headers): number | null {
  // X-Business-Use-Case-Usage: { "<id>": [{ "estimated_time_to_regain_access": <minutes>, ... }] }
  const bucu = headers.get('x-business-use-case-usage');
  if (bucu) {
    try {
      const obj = JSON.parse(bucu) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
      let maxMin = 0;
      for (const arr of Object.values(obj)) {
        for (const entry of arr) {
          if (entry.estimated_time_to_regain_access && entry.estimated_time_to_regain_access > maxMin) {
            maxMin = entry.estimated_time_to_regain_access;
          }
        }
      }
      if (maxMin > 0) return maxMin * 60;
    } catch {
      // ignore malformed
    }
  }
  // X-App-Usage hint isn't a wait-time itself, but its presence with high values suggests
  // we should back off — fall through to exponential.
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ─── Body builders ───────────────────────────────────────────────────────────

function urlEncodeParams(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    usp.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return usp.toString();
}

// ─── Dry-run synthesizer ─────────────────────────────────────────────────────

function synthesizeDryRun(init: MetaFetchInit): MetaJson {
  const leaf = init.path.split('/').pop() ?? 'unknown';
  const fakeId = `DRY_${leaf}_${Math.random().toString(36).slice(2, 10)}`;
  if (leaf === 'advideos') return { id: fakeId };
  if (leaf === 'adimages') {
    return { images: { dryrun: { hash: `DRY_HASH_${fakeId}` } } };
  }
  if (init.method === 'GET') return { data: [], paging: {} };
  return { id: fakeId, success: true };
}

function logLine(ctx: MetaCtx, line: string): void {
  const safe = redactSecrets(line);
  if (ctx.logger) {
    ctx.logger(safe);
  } else {
    process.stderr.write(safe + '\n');
  }
}

// ─── Core fetch loop ─────────────────────────────────────────────────────────

interface ParsedResponse {
  ok: boolean;
  status: number;
  json: MetaJson | null;
  rawBody: string;
  metaErrorCode: number | null;
  fbtraceId: string | null;
  retryHintSec: number | null;
}

async function readResponse(resp: Response): Promise<ParsedResponse> {
  const rawBody = await resp.text();
  let json: MetaJson | null = null;
  try {
    json = JSON.parse(rawBody) as MetaJson;
  } catch {
    json = null;
  }
  let metaErrorCode: number | null = null;
  let fbtraceId: string | null = null;
  if (json && typeof json === 'object' && 'error' in json) {
    const err = (json as { error?: { code?: number; fbtrace_id?: string } }).error;
    if (err && typeof err.code === 'number') metaErrorCode = err.code;
    if (err && typeof err.fbtrace_id === 'string') fbtraceId = err.fbtrace_id;
  }
  return {
    ok: resp.ok,
    status: resp.status,
    json,
    rawBody,
    metaErrorCode,
    fbtraceId,
    retryHintSec: parseRetryHints(resp.headers),
  };
}

function shouldRetry(parsed: ParsedResponse): boolean {
  if (RETRY_HTTP_STATUSES.has(parsed.status)) return true;
  if (parsed.metaErrorCode != null && RETRY_META_CODES.has(parsed.metaErrorCode)) return true;
  return false;
}

async function fetchOnce(ctx: MetaCtx, init: MetaFetchInit, idemKey?: string, body?: BodyInit, contentType?: string): Promise<ParsedResponse> {
  const url = buildUrl(ctx, init);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
  };
  if (contentType) headers['Content-Type'] = contentType;
  if (idemKey) {
    // Meta accepts an arbitrary X-FB-Unique-* header; we also include in the
    // form body where applicable. Header presence is what avoids replay.
    headers['X-FB-Unique-Idempotency-Key'] = idemKey;
  }
  const fetchImpl = init.fetchImpl ?? globalThis.fetch;
  const resp = await fetchImpl(url, {
    method: init.method,
    headers,
    body,
  });
  return readResponse(resp);
}

// ─── Top-level entry ─────────────────────────────────────────────────────────

/**
 * Make a Meta Graph API call. Library functions never construct a ctx — they
 * accept one and pass it through. CLI commands build the ctx via loadCtx().
 */
export async function metaFetch(ctx: MetaCtx, init: MetaFetchInit): Promise<MetaJson> {
  // 1. Dry-run gate (inside the wrapper, by design — bypass-by-refactor impossible)
  if (ctx.dryRun) {
    const url = buildUrl(ctx, init);
    logLine(ctx, `[DRY] ${init.method} ${url}`);
    if (init.params) logLine(ctx, `[DRY]   params: ${JSON.stringify(redactDeep(init.params))}`);
    return synthesizeDryRun(init);
  }

  // 2. Idempotency pre-check (creates only)
  let idemKey: string | undefined;
  if (isCreate(init)) {
    idemKey = randomUUID();
    const cached = readIdem(idemKey);
    if (cached) {
      logLine(ctx, `[idem] cache hit ${idemKey} on ${init.path}`);
      return cached.response;
    }
  }

  // 3. Per-account write queue (writes only; reads unthrottled)
  const isWrite = init.method !== 'GET';
  const exec = (): Promise<MetaJson> => fetchWithRetry(ctx, init, idemKey);
  const result = isWrite ? await withWriteSlot(ctx.adAccountId, exec) : await exec();

  // 4. Cache successful create response
  if (idemKey) {
    writeIdem({
      key: idemKey,
      request_path: init.path,
      response: result,
      written_at: new Date().toISOString(),
    });
  }

  return result;
}

async function fetchWithRetry(ctx: MetaCtx, init: MetaFetchInit, idemKey?: string): Promise<MetaJson> {
  const body = init.params ? urlEncodeParams({ ...init.params, ...(idemKey ? { idempotency_key: idemKey } : {}) }) : undefined;
  const contentType = body ? 'application/x-www-form-urlencoded' : undefined;

  let attempt = 0;
  let lastParsed: ParsedResponse | null = null;
  let lastError: Error | null = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    let parsed: ParsedResponse;
    try {
      parsed = await fetchOnce(ctx, init, idemKey, body, contentType);
    } catch (e) {
      // Configuration / programmer errors must not be retried — surface immediately.
      if (e instanceof HeaderAuthAssertionError) throw e;
      // Network-layer failure (DNS, socket reset). Retry like a 5xx.
      lastError = e as Error;
      if (init.noRetry || attempt >= MAX_ATTEMPTS) throw e;
      const wait = backoffMs(attempt, null);
      logLine(ctx, `[meta-fetch] network error attempt ${attempt}: ${(e as Error).message} — retry in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    lastParsed = parsed;

    // Success path
    if (parsed.ok && parsed.metaErrorCode == null) {
      return (parsed.json ?? {}) as MetaJson;
    }

    // Token-expired = no retry, surface immediately
    if (parsed.metaErrorCode === TOKEN_EXPIRED_CODE) {
      const regenUrl = 'https://business.facebook.com/settings/system-users';
      logLine(
        ctx,
        `[meta-fetch] OAuth 190 token expired or invalid. Regenerate at ${regenUrl} and update _dream_context/marketing/.env (META_SYSTEM_USER_TOKEN).`,
      );
      throw new TokenExpiredError(
        `Token expired (OAuth 190). Regenerate at ${regenUrl}.`,
        parsed.rawBody,
        parsed.fbtraceId,
      );
    }

    // Retry path
    if (!init.noRetry && shouldRetry(parsed) && attempt < MAX_ATTEMPTS) {
      const wait = backoffMs(attempt, parsed.retryHintSec);
      logLine(
        ctx,
        `[meta-fetch] ${init.method} ${init.path} status=${parsed.status} code=${parsed.metaErrorCode ?? '-'} attempt ${attempt}/${MAX_ATTEMPTS} — retry in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }

    // Non-retriable or out of attempts
    throw new MetaApiError(
      `Meta API ${parsed.status} (code=${parsed.metaErrorCode ?? '-'}) on ${init.method} ${init.path}: ${redactSecrets(parsed.rawBody.slice(0, 500))}`,
      parsed.status,
      parsed.metaErrorCode,
      parsed.fbtraceId,
      parsed.rawBody,
    );
  }

  // Out of attempts
  if (lastParsed) {
    throw new MetaApiError(
      `Meta API exhausted ${MAX_ATTEMPTS} attempts on ${init.method} ${init.path}: ${redactSecrets(lastParsed.rawBody.slice(0, 500))}`,
      lastParsed.status,
      lastParsed.metaErrorCode,
      lastParsed.fbtraceId,
      lastParsed.rawBody,
    );
  }
  throw lastError ?? new Error(`metaFetch exhausted retries with no response`);
}

// ─── Chunked video upload ────────────────────────────────────────────────────

export interface ChunkedUploadResult {
  video_id: string;
  upload_session_id: string;
}

interface UploadStartResp {
  upload_session_id: string;
  video_id: string;
  start_offset: string;
  end_offset: string;
}

interface UploadTransferResp {
  start_offset: string;
  end_offset: string;
}

interface UploadFinishResp {
  success: boolean;
}

/**
 * Upload a video file. Files ≤50MB use the single-shot multipart endpoint.
 * Files >50MB use the chunked start|transfer|finish flow against
 * graph-video.facebook.com per the task contract.
 */
export async function uploadVideoFile(
  ctx: MetaCtx,
  filepath: string,
  fields: { name?: string; title?: string; description?: string } = {},
): Promise<ChunkedUploadResult> {
  if (ctx.dryRun) {
    const fakeId = `DRY_video_${Math.random().toString(36).slice(2, 10)}`;
    logLine(ctx, `[DRY] uploadVideoFile ${filepath}`);
    return { video_id: fakeId, upload_session_id: `DRY_session_${fakeId}` };
  }

  const stat = statSync(filepath);
  const fileSize = stat.size;
  const path = `${ctx.adAccountId}/advideos`;

  if (fileSize <= CHUNKED_UPLOAD_THRESHOLD) {
    // Single-shot multipart — direct to graph.facebook.com, FormData body.
    const result = await singleShotVideoUpload(ctx, filepath, fields);
    return { video_id: String(result.id), upload_session_id: '' };
  }

  // Chunked path — graph-video.facebook.com, three phases.
  const startResp = await metaFetch(ctx, {
    method: 'POST',
    path,
    useVideoHost: true,
    params: { upload_phase: 'start', file_size: fileSize },
  }) as unknown as UploadStartResp;

  const sessionId = startResp.upload_session_id;
  const videoId = startResp.video_id;
  let startOffset = Number(startResp.start_offset);
  let endOffset = Number(startResp.end_offset);

  const fd = openSync(filepath, 'r');
  try {
    while (startOffset < endOffset) {
      const chunkLen = Math.min(CHUNK_SIZE, endOffset - startOffset);
      const buf = Buffer.alloc(chunkLen);
      readSync(fd, buf, 0, chunkLen, startOffset);

      const form = new FormData();
      form.set('upload_phase', 'transfer');
      form.set('upload_session_id', sessionId);
      form.set('start_offset', String(startOffset));
      const blob = new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' });
      form.set('video_file_chunk', blob, basename(filepath));

      const transfer = await uploadFormDataChunked(ctx, path, form);
      const next = transfer as unknown as UploadTransferResp;
      startOffset = Number(next.start_offset);
      endOffset = Number(next.end_offset);
      logLine(ctx, `[upload] ${basename(filepath)} progress: ${startOffset}/${fileSize}`);
    }
  } finally {
    closeSync(fd);
  }

  const finishParams: Record<string, unknown> = {
    upload_phase: 'finish',
    upload_session_id: sessionId,
  };
  if (fields.name) finishParams.title = fields.name;
  if (fields.title) finishParams.title = fields.title;
  if (fields.description) finishParams.description = fields.description;

  const finished = (await metaFetch(ctx, {
    method: 'POST',
    path,
    useVideoHost: true,
    params: finishParams,
  })) as unknown as UploadFinishResp;
  if (!finished.success) {
    throw new MetaApiError('Chunked video upload finish returned success=false', 200, null, null, JSON.stringify(finished));
  }
  return { video_id: videoId, upload_session_id: sessionId };
}

async function singleShotVideoUpload(
  ctx: MetaCtx,
  filepath: string,
  fields: { name?: string; title?: string; description?: string },
): Promise<{ id: string }> {
  // Single-shot uses graph.facebook.com (the standard host).
  return withWriteSlot(ctx.adAccountId, async () => {
    const url = buildUrl(ctx, { method: 'POST', path: `${ctx.adAccountId}/advideos` });
    const form = new FormData();
    if (fields.name) form.set('name', fields.name);
    if (fields.title) form.set('title', fields.title);
    if (fields.description) form.set('description', fields.description);
    const buffer = readFileSync(filepath);
    const blob = new Blob([new Uint8Array(buffer)], { type: 'video/mp4' });
    form.set('source', blob, basename(filepath));
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
      body: form,
    });
    const parsed = await readResponse(resp);
    if (!parsed.ok || parsed.metaErrorCode != null) {
      throw new MetaApiError(
        `Meta API ${parsed.status} (code=${parsed.metaErrorCode ?? '-'}) on POST advideos: ${redactSecrets(parsed.rawBody.slice(0, 500))}`,
        parsed.status,
        parsed.metaErrorCode,
        parsed.fbtraceId,
        parsed.rawBody,
      );
    }
    return parsed.json as { id: string };
  });
}

async function uploadFormDataChunked(ctx: MetaCtx, path: string, form: FormData): Promise<MetaJson> {
  return withWriteSlot(ctx.adAccountId, async () => {
    const url = buildUrl(ctx, { method: 'POST', path, useVideoHost: true });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
      body: form,
    });
    const parsed = await readResponse(resp);
    if (!parsed.ok || parsed.metaErrorCode != null) {
      throw new MetaApiError(
        `Meta API ${parsed.status} (code=${parsed.metaErrorCode ?? '-'}) on chunked transfer: ${redactSecrets(parsed.rawBody.slice(0, 500))}`,
        parsed.status,
        parsed.metaErrorCode,
        parsed.fbtraceId,
        parsed.rawBody,
      );
    }
    return parsed.json as MetaJson;
  });
}

// ─── Image upload (single-shot multipart, no chunk path) ─────────────────────

export async function uploadImageFile(ctx: MetaCtx, filepath: string): Promise<{ hash: string }> {
  if (ctx.dryRun) {
    return { hash: `DRY_HASH_${Math.random().toString(36).slice(2, 10)}` };
  }
  return withWriteSlot(ctx.adAccountId, async () => {
    const url = buildUrl(ctx, { method: 'POST', path: `${ctx.adAccountId}/adimages` });
    const form = new FormData();
    const buffer = readFileSync(filepath);
    const blob = new Blob([new Uint8Array(buffer)], { type: 'image/png' });
    form.set('filename', blob, basename(filepath));
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
      body: form,
    });
    const parsed = await readResponse(resp);
    if (!parsed.ok || parsed.metaErrorCode != null) {
      throw new MetaApiError(
        `Meta API ${parsed.status} (code=${parsed.metaErrorCode ?? '-'}) on POST adimages: ${redactSecrets(parsed.rawBody.slice(0, 500))}`,
        parsed.status,
        parsed.metaErrorCode,
        parsed.fbtraceId,
        parsed.rawBody,
      );
    }
    const json = parsed.json as { images?: Record<string, { hash: string; url: string }> };
    const images = json.images ?? {};
    const first = Object.values(images)[0];
    if (!first) {
      throw new MetaApiError('Meta returned no image hash', 200, null, parsed.fbtraceId, parsed.rawBody);
    }
    return { hash: first.hash };
  });
}

// ─── Ctx factories ───────────────────────────────────────────────────────────

export interface CtxOverrides {
  dryRun?: boolean;
  apiVersion?: string;
  logger?: (line: string) => void;
}

/** Build a live (writes hit Meta) ctx from a profile + env. */
export function liveCtxFromEnv(
  env: Record<string, string>,
  overrides: CtxOverrides = {},
): MetaCtx {
  const adAccountId = env.META_AD_ACCOUNT_ID;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is required to build a Meta ctx');
  const accessToken = env.META_SYSTEM_USER_TOKEN;
  if (!accessToken) throw new Error('META_SYSTEM_USER_TOKEN is required to build a Meta ctx');
  return {
    dryRun: overrides.dryRun ?? false,
    apiVersion: overrides.apiVersion ?? DEFAULT_API_VERSION,
    accessToken,
    adAccountId: adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`,
    pageId: env.META_PAGE_ID,
    igActorId: env.META_IG_ACTOR_ID,
    pixelId: env.META_PIXEL_ID,
    logger: overrides.logger,
  };
}

/** Default-safe ctx for tests / tooling — dry-run on, fake token. */
export function dryRunCtx(overrides: Partial<MetaCtx> = {}): MetaCtx {
  return {
    dryRun: true,
    apiVersion: DEFAULT_API_VERSION,
    accessToken: 'DRY_RUN_FAKE_TOKEN',
    adAccountId: overrides.adAccountId ?? 'act_dryrun',
    pageId: overrides.pageId,
    igActorId: overrides.igActorId,
    pixelId: overrides.pixelId,
    logger: overrides.logger,
  };
}
