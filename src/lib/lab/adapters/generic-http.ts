import { ApiAdapter, ApiError } from '../../task-backend/api-adapter.js';
import { resolvePlaceholders, redactSecrets } from '../credentials.js';
import {
  FRESHNESS_PROBE_TIMEOUT_MS,
  isRawFunnelSet,
  LabError,
  type AdapterContext,
  type AdapterResult,
  type ExtractConfig,
  type HttpFreshnessProbe,
  type HttpSource,
  type LabAdapter,
  type RawFreshness,
  type RawSeries,
  type SeriesPoint,
} from '../types.js';

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
  async fetch(ctx: AdapterContext): Promise<AdapterResult> {
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

    // Funnel-set passthrough: when the response (or the object at
    // `extract.seriesPath`) IS a funnel-set payload, hand it to the engine raw —
    // parseFunnelSet validates + caps it there. `extract.x/y` don't apply.
    if (isRawFunnelSet(json)) return json;
    const atPath = http.extract.seriesPath ? getPath(json, http.extract.seriesPath) : undefined;
    if (isRawFunnelSet(atPath)) return atPath;

    return extractSeries(json, http.extract);
  },

  async probe(ctx: AdapterContext): Promise<RawFreshness | null> {
    const source = ctx.manifest.source;
    const spec = ctx.manifest.refresh.freshness;
    if (!source || source.adapter !== 'http' || !spec) return null;
    const secretValues = Object.values(ctx.credentials);
    const placeholderCtx = { cred: ctx.credentials, tweak: ctx.resolvedTweaks.values };
    const redactedUrl = resolvePlaceholders(spec.url, placeholderCtx, { redact: true });
    // Every probe error is built from the redacted URL + status only.
    const fail = (why: string): LabError =>
      new LabError(redactSecrets(`Freshness probe ${spec.method} ${redactedUrl} ${why}`, secretValues));

    const plan = buildProbeRequest(source, spec, ctx.credentials, placeholderCtx);
    if ('refused' in plan) throw fail(plan.refused);

    // Re-check at resolve time: the URL actually handed to fetch is parsed
    // again and must still satisfy the credential rule it was planned under.
    let finalUrl: URL;
    try {
      finalUrl = new URL(plan.url);
    } catch {
      throw fail('has an invalid URL after resolution.');
    }
    if (plan.carriesCredential && finalUrl.origin !== plan.sourceOrigin) {
      throw fail('refused: a credential may only go to the source origin.');
    }

    const fetchImpl = ctx.fetchImpl ?? fetch;
    const controller = new AbortController();
    const budgetMs = ctx.probeTimeoutMs ?? FRESHNESS_PROBE_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await fetchImpl(finalUrl.href, {
        method: spec.method,
        headers: plan.headers,
        body: plan.body ?? undefined,
        // A redirect could carry the credential somewhere else; it is a probe
        // failure (full fetch), never followed.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw fail(controller.signal.aborted ? `timed out after ${budgetMs}ms.` : 'failed.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status < 200 || res.status >= 300) throw fail(`failed (${res.status}).`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw fail(`returned an unreadable body (${res.status}).`);
    }
    return {
      marker: getPath(json, spec.extract.marker),
      asOf: spec.extract.asOf ? getPath(json, spec.extract.asOf) : undefined,
      note: spec.extract.note ? getPath(json, spec.extract.note) : undefined,
    };
  },
};

/** The probe request, or the reason the credential rule refuses it. */
export type ProbePlan =
  | {
    url: string;
    headers: Record<string, string>;
    body: string | null;
    sourceOrigin: string;
    /** True when anything in the request is (or contains) a credential. */
    carriesCredential: boolean;
  }
  | { refused: string };

/**
 * Plan a freshness probe under the same-origin credential rule, AFTER
 * placeholder resolution: a `{{cred:*}}` that resolves the host, or a literal
 * secret typed into a header, is judged by where the request would actually go.
 * The source's own headers (its auth) are inherited only when the probe
 * declares none AND the origins match. A cross-origin probe is refused as soon
 * as a credential sits anywhere in it (URL, headers, body); without one it goes
 * out bare.
 */
export function buildProbeRequest(
  source: HttpSource,
  spec: HttpFreshnessProbe,
  credentials: Record<string, string>,
  placeholderCtx: { cred: Record<string, string>; tweak: Record<string, string> },
): ProbePlan {
  let sourceOrigin: string;
  let probeOrigin: string;
  const url = resolvePlaceholders(spec.url, placeholderCtx);
  try {
    sourceOrigin = new URL(resolvePlaceholders(source.endpoint, placeholderCtx)).origin;
  } catch {
    return { refused: 'refused: the source endpoint does not resolve to a URL.' };
  }
  try {
    probeOrigin = new URL(url).origin;
  } catch {
    return { refused: 'has an invalid URL after resolution.' };
  }
  const sameOrigin = probeOrigin === sourceOrigin;

  const templates = [spec.url, ...Object.values(spec.headers ?? {}), spec.body ?? ''];
  const headers: Record<string, string> = {};
  for (const [k, val] of Object.entries(spec.headers ?? {})) {
    headers[k] = resolvePlaceholders(val, placeholderCtx);
  }
  let inherited = false;
  if (!spec.headers && sameOrigin) {
    for (const [k, val] of Object.entries(source.headers)) {
      headers[k] = resolvePlaceholders(val, placeholderCtx);
    }
    inherited = Object.keys(source.headers).length > 0;
  }
  let body: string | null = null;
  if (spec.method === 'POST') {
    const resolvedBody = resolvePlaceholders(spec.body ?? '{}', placeholderCtx);
    try {
      JSON.parse(resolvedBody);
    } catch {
      return { refused: 'has a POST body that did not resolve to valid JSON.' };
    }
    body = resolvedBody;
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  const secrets = Object.values(credentials).filter((s) => s.length > 0);
  const resolvedParts = [url, ...Object.values(headers), body ?? ''];
  const carriesCredential = inherited
    || templates.some((t) => /\{\{\s*cred:/.test(t))
    || resolvedParts.some((part) => secrets.some((s) => part.includes(s)));
  if (carriesCredential && !sameOrigin) {
    return { refused: 'refused: a credential may only go to the source origin.' };
  }
  return { url, headers, body, sourceOrigin, carriesCredential };
}
