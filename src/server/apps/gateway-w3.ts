/**
 * The gateway's W3 paths (dreamcontext-apps plan r19): the SDK, notifications, MCP and the
 * schedule list. Registered on the gateway through `registerGatewayRoute`, each with the
 * identities it accepts (`cookie` = the window's page, `bearer` = the backend's DC_TOKEN).
 *
 *   /__dc/sdk.js      cookie + bearer   the SDK (src/lib/apps/sdk/dc.mjs), as a module
 *   /__dc/notify      cookie + bearer   {body, sound?, banner?, notch?, path?}: the title is the
 *                                       registered app name (never page text); 30 a minute
 *   /__dc/mcp/:s/:t   bearer only       a key-based MCP call, no Claude turn (mcp-bridge.ts)
 *   /__dc/schedules   cookie + bearer   the schedule views the card shows
 *   /__dc/automations bearer only       create an agent automation; the gateway stamps `app`
 *   /__dc/team/say    bearer only       ask a project agent; the gateway stamps the app
 *   /__dc/ask         bearer only       ask the app's assistant; polled at /__dc/ask/:id
 *   /__dc/embed/:view cookie only       302 to a dreamcontext screen, carrying the embed token
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gatewayDashboardPort, gatewayTheme, registerGatewayRoute, type AppGateway } from './gateway.js';
import { recordAppEvent } from '../../lib/assistant/notch-inbox.js';
import { APP_SOUND_HELP, notifyFromApp, resolveAppSound } from '../../lib/apps/app-notify.js';
import { safeAppPath } from '../../lib/apps/safe-path.js';
import { cleanText } from '../../lib/apps/manifest.js';
import { scheduleViews } from '../../lib/apps/schedule.js';
import { callMcpTool, McpBridgeError } from '../../lib/apps/mcp-bridge.js';
import { createFromBody, sayFromApp } from '../routes/automations.js';
import { appRunBrief } from '../../lib/apps/brief.js';
import { askRoom, readOwnAsk, startOwnAsk, type AskState } from '../../lib/apps/assistant-ask.js';
import type { ThreadEntry } from '../../lib/automations/types.js';
import { resolveAppAgent } from '../../lib/apps/assistant.js';
import { readManifest } from '../../lib/apps/manifest.js';
import { readThread } from '../../lib/automations/threads.js';
import { mintEmbedToken } from './embed-token.js';
import { buildAppLink } from '../../lib/app-link.js';
import { issueLinkNonce } from './link-nonces.js';

const NOTIFY_PER_MINUTE = 30;

let homeDir = process.env.HOME ?? '';
let loginPath: (() => Promise<string>) | undefined;
export function configureGatewayW3(opts: { home?: string; loginPath?: () => Promise<string> }): void {
  if (opts.home) homeDir = opts.home;
  if (opts.loginPath) loginPath = opts.loginPath;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error('too_large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : {};
}

// ─── the SDK ────────────────────────────────────────────────────────────────────────

let sdkCache: string | null = null;
/** dist/apps/dc.mjs in the bundle, src/lib/apps/sdk/dc.mjs from source. */
export function sdkSource(): string {
  if (sdkCache !== null) return sdkCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'apps', 'dc.mjs'), join(here, '..', '..', 'lib', 'apps', 'sdk', 'dc.mjs'), join(here, '..', 'src', 'lib', 'apps', 'sdk', 'dc.mjs')];
  for (const c of candidates) {
    if (existsSync(c)) { sdkCache = readFileSync(c, 'utf-8'); return sdkCache; }
  }
  throw new Error('the app SDK (dc.mjs) is missing from this install');
}

registerGatewayRoute('/__dc/sdk.js', { cookie: true, bearer: true }, (_gw, _req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(sdkSource());
});

// ─── notify ─────────────────────────────────────────────────────────────────────────

const recent = new Map<string, number[]>();

/** Null, never a throw: a vault name no link can hold still gets its banner. */
function appHistoryLink(vault: string, slug: string, nonce: string | null): string | null {
  try { return buildAppLink({ kind: 'app', vault, slug, nonce }); } catch { return null; }
}

registerGatewayRoute('/__dc/notify', { cookie: true, bearer: true }, async (gw: AppGateway, req, res) => {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') { send(res, 405, { error: 'method' }); return; }
  let body: Record<string, unknown>;
  try { body = (await readJson(req, 16 * 1024)) as Record<string, unknown>; } catch { send(res, 400, { error: 'invalid_body' }); return; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { error: 'invalid_body' }); return; }
  const extra = Object.keys(body).filter((k) => !['body', 'sound', 'banner', 'notch', 'path'].includes(k));
  if (extra.length) { send(res, 400, { error: 'unknown_field', message: `Only body, sound, banner, notch and path (not ${extra.join(', ')}).` }); return; }
  const text = typeof body.body === 'string' ? gw.runtime.scrub(cleanText(body.body, 500)) : '';
  if (!text) { send(res, 400, { error: 'no_body', message: 'body is required' }); return; }
  const sound = resolveAppSound(body.sound);
  if (sound === null) { send(res, 400, { error: 'bad_sound', message: APP_SOUND_HELP }); return; }
  let path: string | null = null;
  if (body.path !== undefined) {
    const p = safeAppPath(body.path);
    if (!p.ok) { send(res, 400, { error: 'bad_path', message: p.reason }); return; }
    path = p.path;
  }
  const key = gw.runtime.hash;
  const now = Date.now();
  const window = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
  if (window.length >= NOTIFY_PER_MINUTE) { send(res, 429, { error: 'rate_limited', message: `At most ${NOTIFY_PER_MINUTE} notifications a minute.` }); return; }
  window.push(now);
  recent.set(key, window);
  const rec = gw.runtime.rec;
  // The title is the registered app name, never page text.
  const title = rec.name;
  // The banner opens the bundle, and a window that opens takes this path. An open window keeps
  // its page. The history row is a link: the path stays here, behind a one-time nonce.
  if (path && gw.runtime.liveWindows() === 0) gw.pendingPath = path;
  const historyLink = appHistoryLink(rec.vault, rec.slug, path ? issueLinkNonce(rec.hash, path) : null);
  const wantBanner = body.banner !== false;
  const wantNotch = body.notch !== false;
  let banner: { banner: true; via: 'app' | 'dreamcontext' } | { banner: false; reason: string } = { banner: false, reason: 'not asked' };
  if (wantBanner) {
    const via = await notifyFromApp({ title, body: text, rec, sound, historyLink, home: homeDir });
    banner = via ? { banner: true, via } : { banner: false, reason: process.platform !== 'darwin' ? 'macOS only' : 'notifications are not set up (Apps card → Turn on notifications)' };
  }
  const notch = wantNotch ? !!recordAppEvent({ vault: rec.vault, projectRoot: rec.projectRoot, slug: rec.slug, name: title, body: text }, homeDir) : false;
  send(res, 200, { ok: true, ...banner, notch });
});

// ─── MCP ────────────────────────────────────────────────────────────────────────────

registerGatewayRoute('/__dc/mcp', { cookie: false, bearer: true }, async (gw, req, res, _ident, url) => {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') { send(res, 405, { error: 'method' }); return; }
  const m = /^\/__dc\/mcp\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!m) { send(res, 404, { error: 'not_found', message: 'POST /__dc/mcp/<server>/<tool>' }); return; }
  let server: string;
  let tool: string;
  try { server = decodeURIComponent(m[1]); tool = decodeURIComponent(m[2]); } catch { send(res, 400, { error: 'bad_path' }); return; }
  let args: unknown;
  try { args = await readJson(req, 1024 * 1024); } catch { send(res, 400, { error: 'invalid_body' }); return; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) { send(res, 400, { error: 'invalid_body', message: 'The body is the tool arguments object.' }); return; }
  const rt = gw.runtime;
  if (!rt.manifest) { send(res, 409, { error: 'not_ready' }); return; }
  const release = rt.acquireCall();
  try {
    const out = await callMcpTool({
      home: homeDir, projectRoot: rt.rec.projectRoot, appRoot: rt.rec.root, appHash: rt.hash, allowed: rt.manifest.mcp,
      server, tool, args: args as Record<string, unknown>,
      deps: { loginPath, onStderr: (l) => rt.log.push(`[mcp ${server}] ${l}`) },
    });
    rt.addMcpSecrets(server, out.secrets);
    send(res, 200, JSON.parse(rt.scrub(JSON.stringify({ result: out.result }))));
  } catch (err) {
    if (err instanceof McpBridgeError) { send(res, 409, { error: err.code, message: rt.scrub(err.message) }); return; }
    rt.log.push(`[mcp ${server}] ${rt.scrub((err as Error).message)}`);
    send(res, 502, { error: 'mcp_error', message: rt.scrub((err as Error).message).slice(0, 500) });
  } finally {
    release();
  }
});

// ─── schedules ──────────────────────────────────────────────────────────────────────

registerGatewayRoute('/__dc/schedules', { cookie: true, bearer: true }, (gw, _req, res) => {
  send(res, 200, { schedules: scheduleViews(homeDir, gw.runtime.rec) });
});

// ─── automations ────────────────────────────────────────────────────────────────────

// Not `/api/automations`: its route has no way to carry `app`, and this slug must come from the
// gateway, never from the backend's own body.
registerGatewayRoute('/__dc/automations', { cookie: false, bearer: true }, async (gw, req, res) => {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') { send(res, 405, { error: 'method' }); return; }
  let body: unknown;
  try { body = await readJson(req); } catch { send(res, 400, { error: 'invalid_body' }); return; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { error: 'invalid_body' }); return; }
  await createFromBody(res, join(gw.runtime.rec.projectRoot, '_dream_context'), body as Record<string, unknown>, gw.runtime.rec.slug);
});

// ─── team ───────────────────────────────────────────────────────────────────────────

// `app` is this gateway's own slug: a backend cannot speak as another app, or as the owner.
registerGatewayRoute('/__dc/team/say', { cookie: false, bearer: true }, async (gw, req, res) => {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') { send(res, 405, { error: 'method' }); return; }
  let body: Record<string, unknown>;
  try { body = (await readJson(req)) as Record<string, unknown>; } catch { send(res, 400, { error: 'invalid_body' }); return; }
  const rec = gw.runtime.rec;
  const app = appRunBrief(rec.projectRoot, rec.slug, homeDir);
  if (!app) { send(res, 409, { error: 'not_ready' }); return; }
  const out = sayFromApp(join(rec.projectRoot, '_dream_context'), {
    slug: typeof body?.member === 'string' ? body.member : '',
    text: typeof body?.text === 'string' ? body.text : '',
    app,
  });
  if (out.ok) send(res, 200, out.body);
  else send(res, out.status, { error: out.code, message: out.message });
});

// ─── ask ────────────────────────────────────────────────────────────────────────────

/** A bound member's answers, by the ask's id: `<member>|<runId>`. A map, so the id names no path. */
const memberAsks = new Map<string, { hash: string; member: string; runId: string }>();

/** A member's run, as a poll reads it: answered once the run ended well and it said something. */
export function memberAskState(entries: readonly ThreadEntry[]): AskState {
  const ended = entries.filter((e) => e.kind === 'system').map((e) => e.event);
  if (ended.some((e) => e === 'failed' || e === 'timeout' || e === 'skipped')) {
    return { state: 'failed', code: 'ask_failed', message: 'The assistant did not answer.' };
  }
  const said = entries.filter((e) => e.kind === 'agent' && e.text).pop();
  if (!said || !ended.includes('ok')) return { state: 'running' };
  return { state: 'done', answer: said.text ?? '' };
}

registerGatewayRoute('/__dc/ask', { cookie: false, bearer: true }, async (gw, req, res, _ident, url) => {
  const rec = gw.runtime.rec;
  const poll = /^\/__dc\/ask\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
  if ((req.method ?? 'GET').toUpperCase() === 'GET' && poll) {
    const id = poll[1];
    const member = memberAsks.get(id);
    if (member) {
      if (member.hash !== rec.hash) { send(res, 404, { error: 'not_found' }); return; }
      const state = memberAskState(readThread(join(rec.projectRoot, '_dream_context'), member.member, { runId: member.runId }));
      if (state.state === 'running') { send(res, 200, state); return; }
      memberAsks.delete(id);
      send(res, 200, state.state === 'done' ? { ...state, answer: gw.runtime.scrub(state.answer) } : state);
      return;
    }
    const state = readOwnAsk(rec.hash, id);
    if (!state) { send(res, 404, { error: 'not_found' }); return; }
    send(res, 200, state.state === 'done' ? { ...state, answer: gw.runtime.scrub(state.answer) } : state);
    return;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST' || url.pathname !== '/__dc/ask') { send(res, 405, { error: 'method' }); return; }
  let body: Record<string, unknown>;
  try { body = (await readJson(req, 32 * 1024)) as Record<string, unknown>; } catch { send(res, 400, { error: 'invalid_body' }); return; }
  const text = typeof body?.text === 'string' ? body.text : '';
  const m = readManifest(rec.root);
  const choice = resolveAppAgent(m.ok ? m.manifest : null, null);
  if (choice.kind === 'none') { send(res, 409, { error: 'no_assistant', message: 'This app has no assistant: run dreamcontext apps assign <slug> --own.' }); return; }
  if (choice.kind === 'own') {
    const out = startOwnAsk(rec, text, { home: homeDir });
    if (out.ok) send(res, 200, { id: out.id });
    else send(res, out.status, { error: out.code, message: out.message });
    return;
  }
  const app = appRunBrief(rec.projectRoot, rec.slug, homeDir);
  if (!app) { send(res, 409, { error: 'not_ready' }); return; }
  const room = askRoom(rec.hash, Date.now(), [...memberAsks.values()].filter((a) => a.hash === rec.hash).length);
  if (room) { send(res, room.status, { error: room.code, message: room.message }); return; }
  const out = sayFromApp(join(rec.projectRoot, '_dream_context'), { slug: choice.member, text, app });
  if (!out.ok) { send(res, out.status, { error: out.code, message: out.message }); return; }
  const id = randomUUID();
  memberAsks.set(id, { hash: rec.hash, member: choice.member, runId: String(out.body.runId) });
  // The death of the key: a question nobody polls again.
  const t = setTimeout(() => memberAsks.delete(id), 10 * 60_000);
  t.unref?.();
  send(res, 200, { id });
});

// ─── embed ──────────────────────────────────────────────────────────────────────────

const EMBED_VIEWS = new Set(['chat', 'insight', 'tasks', 'roadmap', 'team']);
const EMBED_REF_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const EMBED_THEMES = new Set(['light', 'dark', 'system']);
const EMBED_COLOR_RE = /^#[0-9a-f]{6}$/;

// A redirect and nothing else: a JSON form would hand the token to the page's scripts.
registerGatewayRoute('/__dc/embed', { cookie: true, bearer: false }, (gw, req, res, _ident, url) => {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') { send(res, 405, { error: 'method' }); return; }
  // Only a frame: a top-level `location=` would land the token in the page's history.
  if (String(req.headers['sec-fetch-dest'] ?? '').toLowerCase() !== 'iframe') { send(res, 403, { error: 'frame_only', message: 'This address opens only inside the app\'s frame.' }); return; }
  const view = /^\/__dc\/embed\/([a-z]+)$/.exec(url.pathname)?.[1] ?? '';
  const dashboardPort = gatewayDashboardPort();
  if (!EMBED_VIEWS.has(view) || !dashboardPort) { send(res, 404, { error: 'not_found' }); return; }
  const rec = gw.runtime.rec;
  const tk = mintEmbedToken({ slug: rec.slug, vault: rec.vault, projectRoot: rec.projectRoot, gwPort: gw.port });
  const to = new URL(`http://127.0.0.1:${dashboardPort}/`);
  to.searchParams.set('embed', view);
  to.searchParams.set('vault', rec.vault);
  to.searchParams.set('tk', tk);
  // The app's theme when the page says it, dreamcontext's own otherwise. Allowlisted, never a prompt:
  // no text of the page's reaches the frame's chat.
  const theme = url.searchParams.get('theme');
  to.searchParams.set('theme', theme !== null && EMBED_THEMES.has(theme) ? theme : gatewayTheme());
  for (const key of ['bg', 'surface', 'text', 'accent']) {
    const value = url.searchParams.get(key);
    if (value !== null && EMBED_COLOR_RE.test(value)) to.searchParams.set(key, value);
  }
  for (const key of ['member', 'insight']) {
    const value = url.searchParams.get(key);
    if (value !== null && EMBED_REF_RE.test(value)) to.searchParams.set(key, value);
  }
  res.writeHead(302, { Location: to.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
});
