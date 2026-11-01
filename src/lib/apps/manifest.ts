/**
 * `dreamcontext-app.json`, the manifest at an app's root (dreamcontext-apps plan r19,
 * "Dosya yerleşimi"). Parsing is diagnostic: every problem names its field and how to fix it
 * (the diagnostic-repair loop), so `dreamcontext apps validate` can hand an agent a to-do
 * list instead of "invalid".
 *
 *   { slug, name, icon, backend?: {command, health, unguarded?}, build?, watch?: {ignore: []},
 *     agent?: {own?, member?, brief?, readTools?: []}, mcp?: [], schedules?: [], actions?: [] }
 *
 * The platform does not validate what an action DOES (the app's backend does); it only makes
 * sure every path stays inside the app (`safeAppPath`) and every text is one clean line.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { APP_SLUG_RE } from './bundle.js';
import { safeAppPath } from './safe-path.js';
import { parseScheduleDetailed } from '../automations/schedule.js';
import { readToolsOf } from '../agents/read-tools.js';

export const MANIFEST_FILE = 'dreamcontext-app.json';
/** The app assistant's role: this literal name at the app root, never configurable, so an edit to
 *  the manifest cannot point the role at another file. */
export const ROLE_FILE = 'ASSISTANT.md';
export const ACTION_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ActionMethod = (typeof ACTION_METHODS)[number];

export interface AppAction {
  id: string;
  title: string;
  method: ActionMethod;
  path: string;
  input?: string;
  output?: string;
  danger?: boolean;
}

export interface AppScheduleCall {
  method: ActionMethod;
  path: string;
  body?: unknown;
}

export interface AppSchedule {
  id: string;
  schedule: Record<string, unknown>;
  call: AppScheduleCall;
  notify?: 'never' | 'failure' | 'always';
  catchupHours?: number;
}

/** Who talks in the app. `own`: the app's own assistant, plain Claude with the role in
 *  `ASSISTANT.md`. `member`: an AI Team agent bound to the app; it wins when both are written. */
export interface AppAgent {
  member?: string;
  brief: string;
  own?: true;
  /** Literal MCP tool names the own assistant runs with no card: a name is a claim. */
  readTools?: string[];
}

export interface AppManifest {
  slug: string;
  name: string;
  icon: string | null;
  backend: { command: string; health: string; unguarded: boolean } | null;
  build: string | null;
  watch: { ignore: string[] };
  agent: AppAgent | null;
  mcp: string[];
  schedules: AppSchedule[];
  actions: AppAction[];
}

export interface ManifestProblem {
  field: string;
  problem: string;
  fix: string;
}

export type ManifestResult =
  | { ok: true; manifest: AppManifest; warnings: ManifestProblem[] }
  | { ok: false; errors: ManifestProblem[]; warnings: ManifestProblem[] };

/** One line, no control or bidi characters, at most `max` characters. */
export function cleanText(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, max).join('');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parse the manifest text of the app at `appRoot`. */
export function parseManifest(text: string, appRoot: string): ManifestResult {
  const errors: ManifestProblem[] = [];
  const warnings: ManifestProblem[] = [];
  const err = (field: string, problem: string, fix: string) => errors.push({ field, problem, fix });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [{ field: '(file)', problem: `not valid JSON: ${(e as Error).message}`, fix: `Rewrite ${MANIFEST_FILE} as a JSON object.` }], warnings };
  }
  if (!isObj(raw)) return { ok: false, errors: [{ field: '(file)', problem: 'not a JSON object', fix: `Make ${MANIFEST_FILE} one JSON object.` }], warnings };

  const slug = typeof raw.slug === 'string' ? raw.slug : '';
  if (!APP_SLUG_RE.test(slug)) err('slug', 'missing or not a slug', 'Use lowercase letters, digits and dashes, starting with a letter (max 64), e.g. "meta-ads".');

  const name = typeof raw.name === 'string' ? cleanText(raw.name, 60) : '';
  if (!name) err('name', 'missing', 'Give the app a display name (one line, max 60 characters).');

  let icon: string | null = null;
  if (raw.icon !== undefined && raw.icon !== null) {
    if (typeof raw.icon !== 'string' || !raw.icon) err('icon', 'not a path', 'Point icon at a PNG, JPEG or ICNS file inside the app folder, e.g. "icon.png".');
    else {
      const inside = insideRoot(appRoot, raw.icon);
      if (!inside) err('icon', 'outside the app folder or missing', 'Put the icon file inside the app folder and name it relative to it.');
      else if (!/\.(png|jpe?g|icns)$/i.test(inside)) err('icon', 'not a PNG, JPEG or ICNS', 'Use a .png, .jpg or .icns icon (512x512 or larger).');
      else icon = inside;
    }
  }

  let backend: AppManifest['backend'] = null;
  if (raw.backend !== undefined && raw.backend !== null) {
    const b = raw.backend;
    if (!isObj(b)) err('backend', 'not an object', 'Write backend as {"command": "node server.mjs", "health": "/health"}.');
    else {
      const command = typeof b.command === 'string' ? b.command.trim() : '';
      if (!command) err('backend.command', 'missing', 'Give the command that starts the backend, e.g. "node server.mjs". It must listen on $PORT at $HOST.');
      const h = safeAppPath(b.health);
      if (!h.ok) err('backend.health', `missing or unsafe (${h.reason})`, 'Give a GET path the backend answers 200 on once ready, e.g. "/health". It must refuse requests without the gateway secret (dcGuard).');
      if (b.unguarded !== undefined && typeof b.unguarded !== 'boolean') err('backend.unguarded', 'not a boolean', 'Remove it (recommended) or set it to true only if the owner asked for an unguarded backend.');
      if (b.unguarded === true) warnings.push({ field: 'backend.unguarded', problem: 'the backend is marked unguarded', fix: 'Only the owner may ask for this; the app card shows it. Remove it once dcGuard is in place.' });
      if (command && h.ok) backend = { command, health: h.path, unguarded: b.unguarded === true };
    }
  }

  let build: string | null = null;
  if (raw.build !== undefined && raw.build !== null) {
    if (typeof raw.build !== 'string' || !raw.build.trim()) err('build', 'not a command', 'Give the build command as a string, or remove it.');
    else build = raw.build.trim();
  }

  const watch = { ignore: [] as string[] };
  if (raw.watch !== undefined) {
    const w = raw.watch;
    if (!isObj(w) || (w.ignore !== undefined && (!Array.isArray(w.ignore) || !w.ignore.every((x) => typeof x === 'string')))) {
      err('watch', 'not {"ignore": [strings]}', 'Write watch as {"ignore": ["generated", "*.db"]}.');
    } else watch.ignore = ((w.ignore as string[] | undefined) ?? []).slice(0, 100);
  }

  let agent: AppManifest['agent'] = null;
  if (raw.agent !== undefined && raw.agent !== null) {
    const a = raw.agent;
    const memberOk = isObj(a) && typeof a.member === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(a.member);
    if (!isObj(a) || (a.member !== undefined && !memberOk) || (a.own !== undefined && a.own !== true) || (!memberOk && a.own !== true)) {
      err('agent', 'not {"own": true} or {"member": "<agent slug>", "brief": "…"}', 'Give the app its own assistant ("agent": {"own": true}, the role in ASSISTANT.md), or name the AI Team agent assigned to it (`dreamcontext apps assign <slug> <agent>`).');
    } else if (a.readTools !== undefined && !Array.isArray(a.readTools)) {
      err('agent.readTools', 'not a list', 'List literal MCP tool names, e.g. ["mcp__meta-ads__list_campaigns"].');
    } else {
      const readTools = readToolsOf(a.readTools);
      agent = {
        ...(memberOk ? { member: a.member as string } : {}),
        brief: typeof a.brief === 'string' ? a.brief.slice(0, 4000) : '',
        ...(a.own === true ? { own: true as const } : {}),
        ...(readTools.length ? { readTools } : {}),
      };
    }
  }

  const mcp: string[] = [];
  if (raw.mcp !== undefined) {
    if (!Array.isArray(raw.mcp)) err('mcp', 'not a list', 'List the MCP server names the app calls, e.g. ["meta-ads"].');
    else for (const [i, m] of raw.mcp.entries()) {
      if (typeof m !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(m) || m === '__proto__' || m === 'constructor') err(`mcp[${i}]`, 'not a server name', 'Use the server name as it appears in .mcp.json or Settings → MCP.');
      else if (!mcp.includes(m)) mcp.push(m);
    }
  }

  const actions: AppAction[] = [];
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) err('actions', 'not a list', 'Write actions as a list of {"id","title","method","path"}.');
    else raw.actions.forEach((a, i) => {
      const f = `actions[${i}]`;
      if (!isObj(a)) { err(f, 'not an object', 'Each action is {"id","title","method","path","input?","output?","danger?"}.'); return; }
      const id = typeof a.id === 'string' ? a.id : '';
      if (!APP_SLUG_RE.test(id)) { err(`${f}.id`, 'missing or not a slug', 'Use a slug id, e.g. "pause-campaign".'); return; }
      if (actions.some((x) => x.id === id)) { err(`${f}.id`, `duplicate id "${id}"`, 'Give every action its own id.'); return; }
      const method = typeof a.method === 'string' ? a.method.toUpperCase() : '';
      if (!(ACTION_METHODS as readonly string[]).includes(method)) { err(`${f}.method`, 'not GET/POST/PUT/PATCH/DELETE', 'Pick one of GET, POST, PUT, PATCH, DELETE.'); return; }
      const p = safeAppPath(a.path);
      if (!p.ok) { err(`${f}.path`, `unsafe path (${p.reason})`, 'Use a path on the app backend starting with one "/", not under /__dc, e.g. "/api/campaigns/pause".'); return; }
      const title = typeof a.title === 'string' ? cleanText(a.title, 200) : '';
      if (!title) { err(`${f}.title`, 'missing', 'Say in one line what the action does; agents read it to pick the action.'); return; }
      actions.push({
        id, title, method: method as ActionMethod, path: p.path,
        ...(typeof a.input === 'string' && cleanText(a.input, 200) ? { input: cleanText(a.input, 200) } : {}),
        ...(typeof a.output === 'string' && cleanText(a.output, 200) ? { output: cleanText(a.output, 200) } : {}),
        ...(a.danger === true ? { danger: true } : {}),
      });
    });
  }

  const schedules: AppSchedule[] = [];
  if (raw.schedules !== undefined) {
    if (!Array.isArray(raw.schedules)) err('schedules', 'not a list', 'Write schedules as a list of {"id","schedule","call":{"method","path"}}.');
    else raw.schedules.forEach((sc, i) => {
      const f = `schedules[${i}]`;
      if (!isObj(sc)) { err(f, 'not an object', 'Each schedule is {"id","schedule","call":{"method","path","body?"},"notify?"}.'); return; }
      const id = typeof sc.id === 'string' ? sc.id : '';
      if (!APP_SLUG_RE.test(id)) { err(`${f}.id`, 'missing or not a slug', 'Use a slug id, e.g. "nightly-sync".'); return; }
      if (schedules.some((x) => x.id === id)) { err(`${f}.id`, `duplicate id "${id}"`, 'Give every schedule its own id.'); return; }
      const parsed = parseScheduleDetailed(sc.schedule);
      if (!isObj(sc.schedule) || !parsed.schedule) { err(`${f}.schedule`, parsed.error ?? 'missing', 'Use the automations schedule shape: {"days":"daily","at":"09:00"}, {"days":["mon","thu"],"at":"18:30"} or {"slots":[{"cron":"*/15 * * * *"}]}.'); return; }
      const call = sc.call;
      const method = isObj(call) && typeof call.method === 'string' ? call.method.toUpperCase() : '';
      const p = isObj(call) ? safeAppPath(call.path) : { ok: false as const, reason: 'missing' };
      if (!(ACTION_METHODS as readonly string[]).includes(method) || !p.ok) { err(`${f}.call`, 'needs {"method","path"} with a safe path', 'Point the schedule at a backend route, e.g. {"method":"POST","path":"/api/sync"}.'); return; }
      const notify = sc.notify === 'never' || sc.notify === 'always' || sc.notify === 'failure' ? sc.notify : undefined;
      schedules.push({
        id, schedule: sc.schedule, call: { method: method as ActionMethod, path: p.path, ...(isObj(call) && 'body' in call ? { body: call.body } : {}) },
        ...(notify ? { notify } : {}),
        ...(typeof sc.catchupHours === 'number' && sc.catchupHours >= 0 && sc.catchupHours <= 168 ? { catchupHours: sc.catchupHours } : {}),
      });
    });
  }

  if (!backend && (actions.length || schedules.length)) {
    err('backend', 'actions and schedules need a backend', 'Add a backend (they call its routes), or remove the actions and schedules.');
  }

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, manifest: { slug, name, icon, backend, build, watch, agent, mcp, schedules, actions }, warnings };
}

/** Read and parse `<appRoot>/dreamcontext-app.json`. */
export function readManifest(appRoot: string): ManifestResult {
  const file = join(appRoot, MANIFEST_FILE);
  if (!existsSync(file)) {
    return { ok: false, errors: [{ field: '(file)', problem: `${MANIFEST_FILE} not found in ${appRoot}`, fix: 'Run `dreamcontext apps new <slug>` or write the manifest at the app root.' }], warnings: [] };
  }
  return parseManifest(readFileSync(file, 'utf-8'), appRoot);
}

/**
 * What is wrong with the role file, or null. A real file at the app root, never a symlink, its
 * realpath inside the root: read at every spawn, so a swap after `apps validate` is caught too.
 */
export function roleFileProblem(appRoot: string): ManifestProblem | null {
  const file = join(appRoot, ROLE_FILE);
  const missing = { field: ROLE_FILE, problem: 'missing', fix: `Write the assistant's role in ${ROLE_FILE} at the app root: its subject, what it reads, what it may do, what it asks first.` };
  let st;
  try { st = lstatSync(file); } catch { return missing; }
  if (st.isSymbolicLink() || !st.isFile()) return { field: ROLE_FILE, problem: 'not a plain file (a symlink or a folder)', fix: `Replace it with a real ${ROLE_FILE} at the app root.` };
  try {
    const realRoot = realpathSync(appRoot);
    const r = relative(realRoot, realpathSync(file));
    if (r !== ROLE_FILE) return { field: ROLE_FILE, problem: 'outside the app folder', fix: `Replace it with a real ${ROLE_FILE} at the app root.` };
  } catch { return missing; }
  return null;
}

/** A relative path inside `root` (realpath, symlinks resolved), as an absolute path; else null. */
export function insideRoot(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(join(realRoot, rel));
    const r = relative(realRoot, real);
    if (!r || r.startsWith('..') || isAbsolute(r) || r.split(sep).some((s) => s.startsWith('.'))) return null;
    return real;
  } catch {
    return null;
  }
}
