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
// The height each embedded screen needs, measured: at 560 the chat keeps about 330px of messages
// above its box, and still about 120px while a long draft holds the box at its tallest.
const EMBED_MIN_HEIGHT = { chat: 560, team: 560, tasks: 560, roadmap: 560, insight: 360 };
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

/** A CSS colour as #rrggbb plus its alpha, through a canvas: oklch, color() and rgba all land here. */
function cssHex(color) {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`, alpha: a };
}

/** The first opaque background from `host` up, with the text colour read the same way. */
function pageColors(host) {
  for (let el = host; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor ? cssHex(cs.backgroundColor) : null;
    if (bg && bg.alpha === 255) return { bg: bg.hex, text: cssHex(cs.color)?.hex };
  }
  return null;
}

function themeParams(host, params) {
  const { theme = 'auto', ...rest } = params;
  if (theme !== 'auto' || typeof getComputedStyle !== 'function') return theme === 'auto' ? rest : { theme, ...rest };
  const seen = pageColors(host);
  if (seen) return { theme: luminance(seen.bg) < 0.4 ? 'dark' : 'light', ...seen, ...rest };
  // Nothing opaque: the page's declared scheme, else the Mac's. Never dreamcontext's own.
  const scheme = getComputedStyle(document.documentElement).colorScheme || '';
  return { theme: /dark/.test(scheme) && !/light/.test(scheme) ? 'dark' : /light/.test(scheme) && !/dark/.test(scheme) ? 'light' : 'system', ...rest };
}

function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

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
  /**
   * Ask this app's assistant one question and wait for the answer. Backend only. Works the same
   * for its own assistant and a bound member. Read-only: it reads the app's files, runs nothing,
   * so put the facts it needs in the text. Returns {ok: true, answer} or {ok: false, code}.
   */
  ask: async (text) => {
    backendOnly('dc.ask');
    let id;
    try { ({ id } = await call('POST', '/__dc/ask', { text })); } catch (e) {
      if (e instanceof DcError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
    const until = Date.now() + 130_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 700));
      let s;
      try { s = await call('GET', `/__dc/ask/${enc(id)}`); } catch (e) {
        if (e instanceof DcError) return { ok: false, code: e.code, message: e.message };
        throw e;
      }
      if (s.state === 'done') return { ok: true, answer: s.answer };
      if (s.state === 'failed') return { ok: false, code: s.code, message: s.message };
    }
    return { ok: false, code: 'ask_timeout', message: 'The assistant took too long.' };
  },
  mcp: {
    /** Call a key-based MCP server named in the manifest's `mcp` list. Backend only. */
    call: (server, tool, args = {}) => { backendOnly('dc.mcp.call'); return call('POST', `/__dc/mcp/${enc(server)}/${enc(tool)}`, args); },
  },
  /**
   * {body, sound?, banner?, notch?, path?}: a Mac banner and/or a notch row titled with the app name.
   * sound: true or 'default' plays a sound, a name from /System/Library/Sounds plays that one,
   * false or 'none' is silent; left out is silent. Anything else is a `bad_sound` error.
   */
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
  /**
   * The URL of an embeddable dreamcontext screen: chat | insight | tasks | roadmap | team.
   * params: {theme?: 'light'|'dark'|'system', bg?, surface?, text?, accent?: '#rrggbb'}, plus
   * member (old apps) and insight.
   */
  embed: (view, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return `/__dc/embed/${enc(view)}${q ? `?${q}` : ''}`;
  },
  /** Draw an embeddable screen into `host`: fills it, and neither is ever shorter than that screen
   *  needs, so a fixed or clipping `host` grows rather than hiding the chat's box. It follows the
   *  page's look: `theme: 'auto'` (the default) reads the colours around `host`; pass theme, bg,
   *  surface, text, accent to say them yourself. Page only. Returns the iframe; after a theme
   *  change of your own, call its `dcRetheme()`. */
  mountEmbed: (host, view, params = {}) => {
    if (!isBrowser) throw new DcError('page_only', 'dc.mountEmbed works in the page.', 0);
    const frame = document.createElement('iframe');
    frame.title = view;
    const src = () => dc.embed(view, themeParams(host, params));
    frame.src = src();
    frame.dcRetheme = () => { frame.src = src(); };
    frame.style.display = 'block';
    frame.style.width = '100%';
    frame.style.height = '100%';
    const min = `${EMBED_MIN_HEIGHT[view] ?? 560}px`;
    frame.style.minHeight = min;
    frame.style.border = '0';
    host.style.minHeight = min;
    host.replaceChildren(frame);
    return frame;
  },
};

export default dc;
