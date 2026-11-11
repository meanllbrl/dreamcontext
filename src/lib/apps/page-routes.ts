/**
 * What an app's PAGE (the window's cookie identity) may call through the gateway's
 * `/__dc/api/*` (dreamcontext-apps plan r19, "Gateway sözleşmesi"). A CLOSED list, default
 * deny, independent of `routePolicy` (that table was written for the phone's trust level).
 * Matching uses the dashboard router's own `match` on the normalized path, and the same path
 * is forwarded.
 *
 * Task writes from a page are narrow: the body is parsed and REBUILT. PATCH carries only
 * priority/urgency/tags/start_date/due_date (anything else, `status` included, is
 * `backend_only`: closing a task can end a live agent job); POST only
 * name/why/description/priority/urgency/tags, stamped `by: 'agent'`.
 * Answers are narrowed too: agents to `{slug,title,hasPhoto,roleLine,approvedForChat,
 * approvedToRun}`, automation runs to `{status,startedAt,finishedAt,runId}`.
 *
 * The backend (Bearer DC_TOKEN) has the dashboard API in full (it already reaches loopback),
 * except speaking for the owner: `threads/say`, `:slug/thread/reply` and `/api/apps/*` are
 * refused for both identities; the app's only voice to an agent is `/__dc/team/say`.
 */

export const PAGE_ROUTES: readonly string[] = [
  'GET /api/lab',
  'GET /api/lab/:slug',
  'GET /api/lab/caches',
  'GET /api/lab/boards',
  'GET /api/lab/boards/:slug',
  'GET /api/lab/explorer/:slug',
  'GET /api/tasks',
  'GET /api/tasks/:slug',
  'POST /api/tasks',
  'PATCH /api/tasks/:slug',
  'GET /api/roadmap',
  'GET /api/objectives',
  'GET /api/agents',
  'GET /api/automations/runs',
];

const PAGE_SET = new Set(PAGE_ROUTES);
const PATCH_KEYS = ['priority', 'urgency', 'tags', 'start_date', 'due_date'];
const POST_KEYS = ['name', 'why', 'description', 'priority', 'urgency', 'tags'];

/** Refused for BOTH identities: speaking as the owner, and the apps control surface. */
export function deniedForEveryone(path: string): boolean {
  return /^\/api\/automations\/threads\/say(\/|$)/.test(path)
    || /^\/api\/automations\/[^/]+\/thread\/reply(\/|$)/.test(path)
    || /^\/api\/apps(\/|$)/.test(path)
    // The quick edit spends the owner's Claude account and writes his boards (plan
    // tahta-hizli-duzenle D14). Anchored, so a board slugged `quick-edit` stays readable.
    || /^\/api\/whiteboards\/quick-edit\/status$/.test(path)
    || /^\/api\/whiteboards\/[^/]+\/quick-edit(\/|$)/.test(path);
}

export interface RouteMatcher {
  match(method: string, url: string): { method: string; path: string } | null;
}

export type PageDecision =
  | { ok: true; key: string }
  | { ok: false; status: number; error: string; message: string };

/** May a page call `method path`? `path` is already normalized (`new URL().pathname`). */
export function pageRouteDecision(router: RouteMatcher, method: string, path: string): PageDecision {
  if (deniedForEveryone(path)) return { ok: false, status: 403, error: 'forbidden', message: 'Apps cannot speak for the owner or drive other apps.' };
  let m: { method: string; path: string } | null;
  try {
    m = router.match(method, path);
  } catch {
    return { ok: false, status: 400, error: 'bad_path', message: 'Malformed path.' };
  }
  if (!m) return { ok: false, status: 404, error: 'not_found', message: `No route: ${method} ${path}` };
  const key = `${m.method} ${m.path}`;
  if (!PAGE_SET.has(key)) return { ok: false, status: 403, error: 'backend_only', message: `${key} is available to the app backend only (DC_TOKEN), not to the page.` };
  return { ok: true, key };
}

export type BodyDecision = { ok: true; body: string | null } | { ok: false; status: number; error: string; message: string };

/** Rebuild a page's write body for its route (GETs carry none). */
export function narrowPageBody(key: string, raw: string): BodyDecision {
  if (key !== 'PATCH /api/tasks/:slug' && key !== 'POST /api/tasks') return { ok: true, body: null };
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, status: 400, error: 'invalid_body', message: 'Body must be JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, status: 400, error: 'invalid_body', message: 'Body must be a JSON object.' };
  const obj = parsed as Record<string, unknown>;
  const allowed = key === 'POST /api/tasks' ? POST_KEYS : PATCH_KEYS;
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) {
    return { ok: false, status: 403, error: 'backend_only', message: `${extra.join(', ')} can be set by the app backend only, not the page.` };
  }
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (k in obj) out[k] = obj[k];
  if (key === 'POST /api/tasks') out.by = 'agent';
  return { ok: true, body: JSON.stringify(out) };
}

/**
 * Narrow a JSON answer for a page. A narrowed route FAILS CLOSED: an answer of any other shape
 * gives the page the empty form, never the raw object. Other routes pass through untouched.
 */
export function narrowPageResponse(key: string, json: unknown): unknown {
  const pick = (o: unknown, keys: readonly string[]): Record<string, unknown> | null =>
    (o && typeof o === 'object' && !Array.isArray(o)
      ? Object.fromEntries(keys.filter((k) => k in (o as object)).map((k) => [k, (o as Record<string, unknown>)[k]]))
      : null);
  if (key === 'GET /api/agents') {
    // `{ agents: [...] }` (handleAgentsList).
    const a = json && typeof json === 'object' ? (json as { agents?: unknown }).agents : null;
    return { agents: Array.isArray(a) ? a.map((x) => pick(x, AGENT_KEYS)).filter(Boolean) : [] };
  }
  if (key === 'GET /api/automations/runs') {
    // `{ job: AutomationJobState | null }` (handleAutomationsRunStatus): never its outcome.
    const j = json && typeof json === 'object' ? (json as { job?: unknown }).job : null;
    return { job: pick(j, RUN_KEYS) };
  }
  return json;
}

const AGENT_KEYS = ['slug', 'title', 'hasPhoto', 'roleLine', 'approvedForChat', 'approvedToRun'] as const;
const RUN_KEYS = ['status', 'startedAt', 'finishedAt', 'runId'] as const;
