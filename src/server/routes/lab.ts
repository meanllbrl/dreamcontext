import { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import {
  getInsight,
  listInsights,
  readCache,
  writeInsightTweaks,
} from '../../lib/lab/store.js';
import { resolveTweaks } from '../../lib/lab/tweaks.js';
import { bindInsight, syncInsight, syncAll } from '../../lib/lab/sync.js';
import { LabError, type Binding, type InsightManifest } from '../../lib/lab/types.js';

/**
 * Lab HTTP API — mirrors objectives.ts. Thin wrappers over the same sync engine
 * and store the CLI uses. LabError → 400 (invalid) / 404 (not found), else 500.
 * NO route ever returns a credential VALUE (only key names live in manifests,
 * and credentials.json is never read into a response).
 */

/** Public tweak view (safe: declared knobs + current values, no secrets). */
function toPublicTweaks(m: InsightManifest) {
  return m.tweaks.map((t) => ({
    key: t.key,
    type: t.type,
    label: t.label ?? null,
    options: t.options ?? null,
    default: t.default ?? null,
    value: t.value ?? null,
  }));
}

/** Public manifest — endpoint/headers templates carry `{{cred:*}}` placeholders,
 *  never resolved secrets; credentials.json is never touched here. */
function toPublicManifest(m: InsightManifest) {
  const source = m.source;
  return {
    slug: m.slug,
    title: m.title,
    description: m.description,
    group: m.group,
    render: m.render,
    unit: m.unit,
    binding: m.binding,
    credentials_used: m.credentials_used,
    refresh: m.refresh,
    adapter: source ? source.adapter : null,
    method: source && source.adapter === 'http' ? source.method : null,
    tweaks: toPublicTweaks(m),
  };
}

/** One row in GET /api/lab. */
function toSummary(contextRoot: string, m: InsightManifest) {
  const cache = readCache(contextRoot, m.slug);
  let staleMinutes: number | null = null;
  let stale: boolean | null = null;
  if (cache?.fetchedAt) {
    const age = (Date.now() - Date.parse(cache.fetchedAt)) / 60_000;
    if (Number.isFinite(age)) {
      staleMinutes = Math.max(0, Math.round(age));
      stale = age >= m.refresh.ttl_minutes;
    }
  }
  return {
    slug: m.slug,
    title: m.title,
    group: m.group,
    render: m.render,
    unit: m.unit,
    binding: m.binding,
    latest: cache?.latest ?? null,
    fetchedAt: cache?.fetchedAt || null,
    granularity: cache?.granularity ?? null,
    error: cache?.error ?? null,
    errorAt: cache?.errorAt ?? null,
    ttlMinutes: m.refresh.ttl_minutes,
    staleMinutes,
    stale,
    tweaks: toPublicTweaks(m),
  };
}

/** GET /api/lab — insight summaries (latest/fetchedAt/granularity/error/group/render/binding/tweaks). */
export async function handleLabList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const insights = listInsights(contextRoot).map((m) => toSummary(contextRoot, m));
    sendJson(res, 200, { insights });
  } catch (err) {
    console.error('[lab] list failed:', err);
    sendError(res, 500, 'list_failed', 'Failed to read insights.');
  }
}

/** GET /api/lab/:slug — full manifest + cached series. */
export async function handleLabShow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const manifest = getInsight(contextRoot, params.slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Insight not found: ${params.slug}`);
      return;
    }
    const cache = readCache(contextRoot, params.slug);
    sendJson(res, 200, {
      insight: toPublicManifest(manifest),
      meaning: manifest.body,
      resolvedTweaks: resolveTweaks(manifest).values,
      cache: cache ?? null,
    });
  } catch (err) {
    console.error('[lab] show failed:', err);
    sendError(res, 500, 'show_failed', 'Failed to read the insight.');
  }
}

/** POST /api/lab/sync { slug? | all?, force? } — runs the same engine as the CLI. */
export async function handleLabSync(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }
  const force = body.force === true;
  try {
    if (body.all === true) {
      const { results, failed } = await syncAll(contextRoot, { force });
      sendJson(res, 200, { results, failed });
      return;
    }
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (!slug) {
      sendError(res, 400, 'missing_slug', 'Provide a "slug" or set "all": true.');
      return;
    }
    const result = await syncInsight(contextRoot, slug, { force });
    sendJson(res, 200, { results: [result], failed: result.status === 'failed' ? [result] : [] });
  } catch (err) {
    if (err instanceof LabError) {
      const notFound = /not found/i.test(err.message);
      sendError(res, notFound ? 404 : 400, notFound ? 'not_found' : 'sync_rejected', err.message);
      return;
    }
    console.error('[lab] sync failed:', err);
    sendError(res, 500, 'sync_failed', 'Failed to sync the insight(s).');
  }
}

/** PATCH /api/lab/:slug/binding { binding: { objective, value? } | null } —
 *  connect/disconnect an insight to an objective's Key Result. Enforces the
 *  single-feeder invariant (returns `unbound[]`) and seeds `metric.current`
 *  from the cached latest (`seededCurrent`, null when nothing was written). */
export async function handleLabBinding(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body || !('binding' in body)) {
    sendError(res, 400, 'invalid_body', 'Request body must be { binding: { objective, value? } | null }.');
    return;
  }
  let binding: Binding | null = null;
  if (body.binding !== null) {
    const raw = body.binding as Record<string, unknown> | undefined;
    const objective = raw && typeof raw.objective === 'string' ? raw.objective.trim() : '';
    if (!objective) {
      sendError(res, 400, 'invalid_body', 'binding.objective must be a non-empty objective slug (or binding must be null to disconnect).');
      return;
    }
    const value = raw && typeof raw.value === 'string' && raw.value.trim() ? raw.value.trim() : 'latest';
    binding = { objective, value };
  }
  try {
    const { manifest, unbound, seededCurrent } = bindInsight(contextRoot, params.slug, binding);
    sendJson(res, 200, { insight: toPublicManifest(manifest), unbound, seededCurrent });
  } catch (err) {
    if (err instanceof LabError) {
      const notFound = /not found/i.test(err.message);
      sendError(res, notFound ? 404 : 400, notFound ? 'not_found' : 'binding_rejected', err.message);
      return;
    }
    console.error('[lab] binding update failed:', err);
    sendError(res, 500, 'binding_failed', 'Failed to update the binding.');
  }
}

/** PATCH /api/lab/:slug/tweaks { tweaks: { key: value } } — persists tweak values. */
export async function handleLabTweaks(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const rawTweaks = body && typeof body.tweaks === 'object' && body.tweaks !== null && !Array.isArray(body.tweaks)
    ? (body.tweaks as Record<string, unknown>)
    : null;
  if (!rawTweaks) {
    sendError(res, 400, 'invalid_body', 'Request body must be { tweaks: { key: value } }.');
    return;
  }
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawTweaks)) values[k] = String(v);
  try {
    const manifest = writeInsightTweaks(contextRoot, params.slug, values);
    sendJson(res, 200, { insight: toPublicManifest(manifest) });
  } catch (err) {
    if (err instanceof LabError) {
      const notFound = /not found/i.test(err.message);
      sendError(res, notFound ? 404 : 400, notFound ? 'not_found' : 'tweaks_rejected', err.message);
      return;
    }
    console.error('[lab] tweaks update failed:', err);
    sendError(res, 500, 'tweaks_failed', 'Failed to update tweaks.');
  }
}
