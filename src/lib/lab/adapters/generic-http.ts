import { ApiAdapter, ApiError } from '../../task-backend/api-adapter.js';
import { resolvePlaceholders, redactSecrets } from '../credentials.js';
import { LabError, type AdapterContext, type ExtractConfig, type HttpSource, type LabAdapter, type RawSeries, type SeriesPoint } from '../types.js';

/**
 * Generic-HTTP adapter — declarative JSON API → RawSeries[]. Reuses the shared
 * ApiAdapter (rate-limit queue, 429/Retry-After, retry/backoff).
 *
 * URL FIDELITY (LOCKED — see the buildUrl hazard note): the resolved endpoint is
 * split via `new URL()` into `origin` (the adapter baseUrl) + `pathname+search`
 * (the request path). NEVER pass the full endpoint as baseUrl with an empty path
 * — ApiAdapter.buildUrl would append a trailing slash and corrupt the query
 * string (e.g. `?range=30d` → `?range=30d/`). We also do NOT pass `opts.query`
 * (the query already lives in the path — double-setting would corrupt it).
 *
 * REDACTION: every thrown LabError is built EXCLUSIVELY from the redacted
 * endpoint + the numeric status. The raw ApiError.message (which embeds an
 * echoed response-body snippet) never propagates.
 */

const DEFAULT_SERIES_NAME = 'default';

/** Resolve a dot/bracket JSON path (no eval). Returns undefined on any miss. */
function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function extractSeries(json: unknown, extract: ExtractConfig): RawSeries[] {
  const arr = getPath(json, extract.seriesPath);
  if (!Array.isArray(arr)) {
    throw new LabError(`extract.seriesPath "${extract.seriesPath}" did not resolve to an array.`);
  }
  if (extract.seriesKey) {
    const bySeries = new Map<string, SeriesPoint[]>();
    for (const row of arr) {
      const name = String(getPath(row, extract.seriesKey) ?? DEFAULT_SERIES_NAME);
      const t = String(getPath(row, extract.x) ?? '');
      const v = Number(getPath(row, extract.y));
      const bucket = bySeries.get(name);
      if (bucket) bucket.push({ t, v });
      else bySeries.set(name, [{ t, v }]);
    }
    return [...bySeries.entries()].map(([name, points]) => ({ name, points }));
  }
  const points: SeriesPoint[] = arr.map((row) => ({
    t: String(getPath(row, extract.x) ?? ''),
    v: Number(getPath(row, extract.y)),
  }));
  return [{ name: DEFAULT_SERIES_NAME, points }];
}

export const genericHttpAdapter: LabAdapter = {
  async fetch(ctx: AdapterContext): Promise<RawSeries[]> {
    const source = ctx.manifest.source;
    if (!source || source.adapter !== 'http') {
      throw new LabError('Generic-HTTP adapter requires an `http` source.');
    }
    const http: HttpSource = source;
    const secretValues = Object.values(ctx.credentials);
    const placeholderCtx = { cred: ctx.credentials, tweak: ctx.resolvedTweaks.values };

    // Build the redacted endpoint FIRST — it is the only endpoint string that may
    // ever appear in an error/log message.
    const redactedEndpoint = resolvePlaceholders(http.endpoint, placeholderCtx, { redact: true });
    const resolvedEndpoint = resolvePlaceholders(http.endpoint, placeholderCtx);

    let url: URL;
    try {
      url = new URL(resolvedEndpoint);
    } catch {
      throw new LabError(`Invalid endpoint URL after resolution: ${redactedEndpoint}`);
    }

    const resolvedHeaders: Record<string, string> = {};
    for (const [k, val] of Object.entries(http.headers)) {
      resolvedHeaders[k] = resolvePlaceholders(val, placeholderCtx);
    }

    const method = http.method ?? 'GET';
    const opts: { body?: unknown } = {};
    if (method === 'POST') {
      if (http.body === null || http.body === undefined) {
        throw new LabError('POST insight requires a `body` template that resolves to JSON.');
      }
      const resolvedBody = resolvePlaceholders(http.body, placeholderCtx);
      try {
        // Parse to an OBJECT before handing to ApiAdapter (which JSON.stringify's) —
        // passing the raw string would double-encode it.
        opts.body = JSON.parse(resolvedBody);
      } catch {
        // Never echo the (possibly secret-bearing) resolved body in the message.
        throw new LabError('POST `body` template did not resolve to valid JSON.');
      }
    }

    // origin as baseUrl + pathname+search as path — byte-for-byte endpoint fidelity.
    const adapter = new ApiAdapter({
      baseUrl: url.origin,
      authHeaders: () => resolvedHeaders,
      fetchImpl: ctx.fetchImpl,
    });

    let json: unknown;
    try {
      json = await adapter.request(method, url.pathname + url.search, opts);
    } catch (err) {
      const status = err instanceof ApiError && err.status ? ` (${err.status})` : '';
      // Message is built ONLY from the redacted endpoint + status — never err.message.
      throw new LabError(redactSecrets(`HTTP ${method} ${redactedEndpoint} failed${status}`, secretValues));
    }

    return extractSeries(json, http.extract);
  },
};
