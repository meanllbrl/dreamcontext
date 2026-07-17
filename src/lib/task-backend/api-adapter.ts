/**
 * Generic REST adapter — issue #11.
 *
 * Backend-GENERIC by contract: auth header, base URL, rate-limit queue,
 * retry/backoff, and error normalization. Concrete remote backends are merely
 * configurations of this adapter — adding another provider must not require
 * touching callers or the sync engine, and nothing in this file may mention a
 * specific provider (that invariant is under test).
 */

export type ApiErrorKind =
  | 'auth'          // 401/403
  | 'not_found'     // 404
  | 'invalid'       // other 4xx
  | 'rate_limited'  // 429 (after retries exhausted)
  | 'server'        // 5xx (after retries exhausted)
  | 'network'       // transport failure
  | 'timeout';      // request exceeded timeoutMs

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface ApiAdapterOptions {
  baseUrl: string;
  /** Returns the auth header(s) for each request (token resolved lazily). */
  authHeaders: () => Record<string, string>;
  /** Requests per minute across this adapter instance (default 100). */
  ratePerMinute?: number;
  /** Max retries for 429/5xx/network failures (default 3). */
  maxRetries?: number;
  /** Per-attempt timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Injectable transport (tests use an in-memory fake). */
  fetchImpl?: typeof fetch;
  /** Injectable clock + sleeper so rate-limit/backoff tests run instantly. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RATE_PER_MINUTE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const WINDOW_MS = 60_000;
const BASE_BACKOFF_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  // The timer must stay ref'd: during a rate-limit/backoff wait it can be the
  // ONLY pending handle, and an unref'd timer lets Node drain the event loop
  // and exit 0 mid-sync — no report, finally blocks skipped, stale lock left.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ApiAdapter {
  private readonly baseUrl: string;
  private readonly authHeaders: () => Record<string, string>;
  private readonly ratePerMinute: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Dispatch timestamps within the sliding window (rate limiting). */
  private sent: number[] = [];
  /** Serialization chain: requests dispatch one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: ApiAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authHeaders = opts.authHeaders;
    this.ratePerMinute = opts.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Queue a request. Requests run strictly in order, each waiting for a
   * rate-limit slot, with retry/backoff on 429/5xx/network failures.
   * Resolves with the parsed JSON body (or null for empty responses).
   */
  request<T = unknown>(method: string, path: string, opts: ApiRequestOptions = {}): Promise<T> {
    const run = this.queue.then(() => this.execute<T>(method, path, opts));
    // The chain must survive rejections, or one failure poisons every later call.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private buildUrl(path: string, query?: ApiRequestOptions['query']): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const cutoff = this.now() - WINDOW_MS;
      this.sent = this.sent.filter((t) => t > cutoff);
      if (this.sent.length < this.ratePerMinute) {
        this.sent.push(this.now());
        return;
      }
      const oldest = this.sent[0];
      await this.sleep(Math.max(1, oldest + WINDOW_MS - this.now()));
    }
  }

  private async execute<T>(method: string, path: string, opts: ApiRequestOptions): Promise<T> {
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = lastError?.kind === 'rate_limited' && lastError.status === 429
          ? this.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt
          : BASE_BACKOFF_MS * 2 ** attempt;
        await this.sleep(backoff);
      }
      this.retryAfterMs = null;

      await this.waitForSlot();

      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
        try {
          response = await this.fetchImpl(this.buildUrl(path, opts.query), {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...this.authHeaders(),
            },
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        const aborted = (err as Error)?.name === 'AbortError';
        lastError = new ApiError(
          aborted ? 'timeout' : 'network',
          aborted
            ? `Request timed out after ${this.timeoutMs}ms: ${method} ${path}`
            : `Network failure: ${method} ${path}: ${(err as Error).message ?? err}`,
        );
        continue; // network/timeout → retry
      }

      if (response.ok) {
        const text = await response.text();
        if (!text) return null as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new ApiError('server', `Invalid JSON in response: ${method} ${path}`, response.status);
        }
      }

      const status = response.status;
      const detail = await response.text().catch(() => '');
      const snippet = detail ? `: ${detail.slice(0, 200)}` : '';

      if (status === 401 || status === 403) {
        throw new ApiError('auth', `Authentication failed (${status})${snippet}`, status);
      }
      if (status === 404) {
        throw new ApiError('not_found', `Not found (${status}): ${method} ${path}${snippet}`, status);
      }
      if (status === 429) {
        const ra = Number(response.headers.get('retry-after'));
        this.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : null;
        lastError = new ApiError('rate_limited', `Rate limited (429): ${method} ${path}${snippet}`, status);
        continue; // retry with backoff / Retry-After
      }
      if (status >= 500) {
        lastError = new ApiError('server', `Server error (${status}): ${method} ${path}${snippet}`, status);
        continue; // retry
      }
      throw new ApiError('invalid', `Request rejected (${status}): ${method} ${path}${snippet}`, status);
    }

    throw lastError ?? new ApiError('network', `Request failed: ${method} ${path}`);
  }

  private retryAfterMs: number | null = null;
}
