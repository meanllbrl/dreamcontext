// dreamcontext App SDK (dreamcontext-apps plan r19, W3). ONE file, two homes:
//   - the page:    import { dc } from '/__dc/sdk.js'   (the window's cookie identity)
//   - the backend: import { dc } from './lib/dc.mjs'   (DC_URL + DC_TOKEN from the env)
// The copy `dreamcontext apps new` puts in an app is this file, byte for byte (drift-tested).
//
// What runs where: the PAGE reaches only the read/write subset the gateway allows
// (insights, tasks list/get/create and priority/urgency/tags/dates, roadmap, the agent list,
// automation runs, notify, schedules, theme, copy, embed). Asking an agent, MCP calls,
// automations and changing a task's status are BACKEND ONLY and throw `backend_only` in the page.
// A backend-less app therefore cannot use them: give it a backend.

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
const env = !isBrowser && typeof process !== 'undefined' ? process.env : {};
const BASE = isBrowser ? '' : (env.DC_URL || '');
const TOKEN = isBrowser ? null : (env.DC_TOKEN || null);

export class DcError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'DcError';
    this.code = code;
    this.status = status;
  }
}

function backendOnly(what) {
  if (isBrowser) throw new DcError('backend_only', `${what} works only in the app backend (with DC_TOKEN), not in the page.`, 403);
  if (!BASE || !TOKEN) throw new DcError('no_gateway', 'DC_URL / DC_TOKEN are not set: run the backend through dreamcontext.', 0);
}

async function call(method, path, body) {
  if (!isBrowser && (!BASE || !TOKEN)) throw new DcError('no_gateway', 'DC_URL / DC_TOKEN are not set: run the backend through dreamcontext.', 0);
  const headers = {};
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(isBrowser ? { credentials: 'same-origin' } : {}),
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* text */ }
  if (!res.ok) {
    const code = data && typeof data === 'object' && data.error ? data.error : `http_${res.status}`;
    const message = data && typeof data === 'object' && data.message ? data.message : String(text).slice(0, 300);
    throw new DcError(code, message, res.status);
  }
  return data;
}

const enc = encodeURIComponent;
// A dashboard route is written as the dashboard names it (`/api/tasks`); the gateway serves it at
// `/__dc/api/tasks`. A path without the `/api` prefix is taken as already relative to it.
const api = (method, path, body) => call(method, `/__dc/api${path.startsWith('/api/') ? path.slice(4) : path}`, body);

export const dc = {
  /** True in the page, false in the backend. */
  isBrowser,
  /** Any dashboard API route (the page: only the allowed subset). */
  api,
  insights: {
    list: () => api('GET', '/api/lab'),
    get: (slug) => api('GET', `/api/lab/${enc(slug)}`),
    caches: () => api('GET', '/api/lab/caches'),
    boards: () => api('GET', '/api/lab/boards'),
    board: (slug) => api('GET', `/api/lab/boards/${enc(slug)}`),
    explore: (slug) => api('GET', `/api/lab/explorer/${enc(slug)}`),
  },
  tasks: {
    list: (query = '') => api('GET', `/api/tasks${query ? `?${query}` : ''}`),
    get: (slug) => api('GET', `/api/tasks/${enc(slug)}`),
    /** {name, why?, description?, priority?, urgency?, tags?} */
    create: (task) => api('POST', '/api/tasks', task),
    /** The page may change priority, urgency, tags, start_date, due_date; status is backend only. */
    update: (slug, patch) => {
      if (isBrowser && patch && Object.keys(patch).some((k) => !['priority', 'urgency', 'tags', 'start_date', 'due_date'].includes(k))) {
        throw new DcError('backend_only', 'Only priority, urgency, tags and dates can be changed from the page; status and text are backend only.', 403);
      }
      return api('PATCH', `/api/tasks/${enc(slug)}`, patch);
    },
  },
  roadmap: { get: () => api('GET', '/api/roadmap'), objectives: () => api('GET', '/api/objectives') },
  team: {
    list: () => api('GET', '/api/agents'),
    /** Ask an AI Team agent (a fresh run, labelled as coming from this app). Backend only. */
    ask: (member, text) => { backendOnly('dc.team.ask'); return call('POST', '/__dc/team/say', { member, text }); },
    thread: (member) => { backendOnly('dc.team.thread'); return api('GET', `/api/automations/${enc(member)}/thread`); },
  },
  mcp: {
    /** Call a key-based MCP server named in the manifest's `mcp` list. Backend only. */
    call: (server, tool, args = {}) => { backendOnly('dc.mcp.call'); return call('POST', `/__dc/mcp/${enc(server)}/${enc(tool)}`, args); },
  },
  /** {body, sound?, banner?, notch?, path?}: a Mac banner and/or a notch row titled with the app name. */
  notify: (n) => call('POST', '/__dc/notify', typeof n === 'string' ? { body: n } : n),
  automations: {
    create: (manifest) => { backendOnly('dc.automations.create'); return call('POST', '/__dc/automations', manifest); },
    list: () => { backendOnly('dc.automations.list'); return api('GET', '/api/automations'); },
    runs: () => api('GET', '/api/automations/runs'),
  },
  schedules: { list: () => call('GET', '/__dc/schedules') },
  /** 'light' | 'dark' | 'system' */
  theme: async () => (await call('GET', '/__dc/theme')).theme,
  /** Copy text to the Mac pasteboard (Turkish characters intact). Page only. */
  copy: async (text) => {
    if (!isBrowser) throw new DcError('page_only', 'dc.copy works in the page.', 0);
    if (window.dcRunner && typeof window.dcRunner.copy === 'function') { window.dcRunner.copy(String(text)); return; }
    await navigator.clipboard.writeText(String(text));
  },
  /** The URL of an embeddable dreamcontext screen: chat | insight | tasks | roadmap | team. */
  embed: (view, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return `/__dc/embed/${enc(view)}${q ? `?${q}` : ''}`;
  },
};

export default dc;
