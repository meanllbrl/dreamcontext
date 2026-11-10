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
import { parseDataDecl, type DataDecl } from './data-share.js';

export const MANIFEST_FILE = 'dreamcontext-app.json';
/** The app assistant's role: this literal name at the app root, never configurable, so an edit to
 *  the manifest cannot point the role at another file. */
export const ROLE_FILE = 'ASSISTANT.md';
export const ACTION_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ActionMethod = (typeof ACTION_METHODS)[number];

export const PARAM_TYPES = ['string', 'number', 'boolean', 'date', 'enum'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];
/** One named input of a tool: what an agent reads to fill `--input`, and what `apps do` checks. */
export interface ActionParam {
  type: ParamType;
  required: boolean;
  desc?: string;
  choices?: string[];
}

export interface AppAction {
  id: string;
  title: string;
  method: ActionMethod;
  path: string;
  input?: string;
  output?: string;
  danger?: boolean;
  /** What the tool does, for an agent picking one (app text: data, never an instruction). */
  does?: string;
  /** Named inputs (at most 12): `apps do` validates `--input` against them before any call. */
  params?: Record<string, ActionParam>;
  /** The app's own claim. Only `effectOf` decides: a non-GET is a change whatever this says. */
  effect?: 'read' | 'change';
  /** The tool runs an agent turn inside the app (it spends usage). */
  usesAgent?: true;
  /** Words an agent's question may use for this tool (at most 8). */
  topics?: string[];
  /** How long the call may run, 5-300 s (default 60). */
  timeoutSec?: number;
}

export type ToolEffect = 'read' | 'change';
export const DEFAULT_TOOL_TIMEOUT_SEC = 60;
/** A tool that runs an agent turn keeps the 5 minutes every call had before tools got their own limit. */
export const AGENT_TOOL_TIMEOUT_SEC = 300;
/** How long one tool may run: its own `timeoutSec`, else 300 s for an agent turn, else 60 s. */
export function toolTimeoutSec(a: { timeoutSec?: number; usesAgent?: boolean }): number {
  return a.timeoutSec ?? (a.usesAgent ? AGENT_TOOL_TIMEOUT_SEC : DEFAULT_TOOL_TIMEOUT_SEC);
}

/**
 * THE one rule for what a tool does to the world, asked by the server gate, the CLI, the hook
 * and the Bash gate alike: a GET with no `danger` reads; everything else changes, an
 * `effect: "read"` POST included (an app's own word cannot make a write a read).
 */
export function effectOf(action: { method: string; danger?: boolean }): ToolEffect {
  return action.method.toUpperCase() === 'GET' && !action.danger ? 'read' : 'change';
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

/** One setting the app asks for (paylasilan-app-ler plan r2 K2). The template travels in the
 *  manifest; the VALUES live on the installer's Mac (app-config.ts), a secret only as a `.env` key. */
export const CONFIG_TYPES = ['text', 'number', 'choice', 'secret', 'insight', 'objective', 'agent', 'task-tag', 'mcp-tool'] as const;
export type ConfigType = (typeof CONFIG_TYPES)[number];
export interface ConfigField {
  key: string;
  type: ConfigType;
  label: string;
  required: boolean;
  help?: string;
  choices?: string[];
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
  /** The settings template (empty for an app that asks for none). */
  config: ConfigField[];
  /** Extra paths a publish may carry beyond the allow-list (same extensions). */
  share: { include: string[] };
  /**
   * Which data is the team's (app-veri-ortak K1): hand-made data `shared`, re-fetchable cache,
   * personal and secret data `local`. null = the field is absent: "undecided", nothing shared.
   */
  data: DataDecl | null;
}

/** The app has not declared which data is shared (`apps validate`: `data_undeclared`). */
export function dataUndeclared(m: Pick<AppManifest, 'data'>): boolean {
  return m.data === null;
}

export interface ManifestProblem {
  field: string;
  problem: string;
  fix: string;
  /** A writing hint for `apps validate` only (a tool's description), never an app-card warning. */
  authoring?: true;
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

/**
 * Parse the manifest text of the app at `appRoot`. `appRoot: null` = a manifest read from a
 * remote repo before install: the icon is taken by name (the install gate checks the file).
 */
export function parseManifest(text: string, appRoot: string | null): ManifestResult {
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
    else if (appRoot === null) {
      if (isAbsolute(raw.icon) || raw.icon.split('/').some((seg) => !seg || seg === '..' || seg.startsWith('.')) || !/\.(png|jpe?g|icns)$/i.test(raw.icon)) err('icon', 'not a plain PNG, JPEG or ICNS path', 'Point icon at a .png, .jpg or .icns inside the app.');
      else icon = raw.icon;
    } else {
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
      const params = parseParams(a.params, `${f}.params`, err);
      if (params === false) return;
      const does = typeof a.does === 'string' ? cleanText(a.does, 300) : '';
      if (!does) warnings.push({ field: `${f}.does`, problem: 'missing', fix: 'Say in one or two lines what the tool does and what it answers; agents pick tools by it.', authoring: true });
      if (a.effect !== undefined && a.effect !== 'read' && a.effect !== 'change') { err(`${f}.effect`, 'not "read" or "change"', 'Write "read" for a GET that only reads, "change" for anything that sends, pays, writes or deletes.'); return; }
      if (a.effect === 'read' && method !== 'GET') warnings.push({ field: `${f}.effect`, problem: `"read" on a ${method}: it counts as a change`, fix: 'If the tool only reads, make it a GET; otherwise write "change".', authoring: true });
      if (typeof a.input === 'string' && a.input.trim() && params === null) warnings.push({ field: `${f}.input`, problem: 'free text input', fix: 'Name each input in "params" ({"q": {"type": "string", "required": true}}) so an agent fills it right.', authoring: true });
      let timeoutSec: number | undefined;
      if (a.timeoutSec !== undefined) {
        if (typeof a.timeoutSec !== 'number' || !Number.isFinite(a.timeoutSec) || a.timeoutSec < 5 || a.timeoutSec > 300) { err(`${f}.timeoutSec`, 'not a number from 5 to 300', 'Give the seconds the call may run, e.g. 60.'); return; }
        timeoutSec = Math.round(a.timeoutSec);
      }
      let topics: string[] | undefined;
      if (a.topics !== undefined) {
        if (!Array.isArray(a.topics)) { err(`${f}.topics`, 'not a list', 'List words a question may use, e.g. ["yük","cpu"].'); return; }
        topics = a.topics.filter((x): x is string => typeof x === 'string').map((x) => cleanText(x, 40)).filter(Boolean).slice(0, 8);
      }
      const output = typeof a.output === 'string' ? cleanText(a.output, 300) : '';
      actions.push({
        id, title, method: method as ActionMethod, path: p.path,
        ...(typeof a.input === 'string' && cleanText(a.input, 200) ? { input: cleanText(a.input, 200) } : {}),
        ...(output ? { output } : {}),
        ...(a.danger === true ? { danger: true } : {}),
        ...(does ? { does } : {}),
        ...(params ? { params } : {}),
        ...(a.effect === 'read' || a.effect === 'change' ? { effect: a.effect } : {}),
        ...(a.usesAgent === true ? { usesAgent: true as const } : {}),
        ...(topics && topics.length ? { topics } : {}),
        ...(timeoutSec !== undefined ? { timeoutSec } : {}),
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

  const config: ConfigField[] = [];
  if (raw.config !== undefined) {
    if (!Array.isArray(raw.config)) err('config', 'not a list', 'Write config as a list of {"key","type","label","required?"}.');
    else raw.config.slice(0, 40).forEach((c, i) => {
      const f = `config[${i}]`;
      if (!isObj(c)) { err(f, 'not an object', 'Each setting is {"key","type","label","required?","help?","choices?"}.'); return; }
      const type = c.type as ConfigType;
      if (!(CONFIG_TYPES as readonly string[]).includes(type as string)) { err(`${f}.type`, 'unknown type', `Use one of ${CONFIG_TYPES.join(', ')}.`); return; }
      const key = typeof c.key === 'string' ? c.key : '';
      const keyOk = type === 'secret' ? /^[A-Z][A-Z0-9_]{0,63}$/.test(key) : /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key);
      if (!keyOk) { err(`${f}.key`, 'missing or not a key', type === 'secret' ? 'A secret is a .env key: capitals, digits and _, e.g. "META_TOKEN".' : 'Use letters, digits and _, starting with a letter, e.g. "insight".'); return; }
      if (config.some((x) => x.key === key)) { err(`${f}.key`, `duplicate key "${key}"`, 'Give every setting its own key.'); return; }
      const label = typeof c.label === 'string' ? cleanText(c.label, 80) : '';
      if (!label) { err(`${f}.label`, 'missing', 'Say in a few words what the setting is, e.g. "Which insight to watch".'); return; }
      let choices: string[] | undefined;
      if (type === 'choice') {
        choices = Array.isArray(c.choices) ? c.choices.filter((x): x is string => typeof x === 'string').map((x) => cleanText(x, 60)).filter(Boolean).slice(0, 30) : [];
        if (!choices.length) { err(`${f}.choices`, 'a choice needs choices', 'List the options, e.g. ["daily","weekly"].'); return; }
      }
      config.push({
        key, type, label, required: c.required === true,
        ...(typeof c.help === 'string' && cleanText(c.help, 200) ? { help: cleanText(c.help, 200) } : {}),
        ...(choices ? { choices } : {}),
      });
    });
  }

  const share = { include: [] as string[] };
  if (raw.share !== undefined) {
    const sh = raw.share;
    if (!isObj(sh) || (sh.include !== undefined && (!Array.isArray(sh.include) || !sh.include.every((x) => typeof x === 'string')))) {
      err('share', 'not {"include": [paths]}', 'Write share as {"include": ["assets"]}: extra folders a publish may carry.');
    } else {
      for (const inc of ((sh.include as string[] | undefined) ?? []).slice(0, 20)) {
        const clean = inc.replace(/\/+$/, '');
        if (!clean || isAbsolute(clean) || clean.split('/').some((seg) => !seg || seg === '..' || seg.startsWith('.'))) err('share.include', `"${cleanText(inc, 60)}" is not a plain relative path`, 'Name a folder or file inside the app, no dots, no "..".');
        else share.include.push(clean);
      }
    }
  }

  let data: DataDecl | null = null;
  const d = parseDataDecl(raw.data);
  if (!d.ok) {
    for (const e of d.errors) {
      const i = e.indexOf(': ');
      err(i > 0 ? e.slice(0, i) : 'data', i > 0 ? e.slice(i + 2) : e, 'Write data as {"shared": [{"path": "favorites/", "why": "…"}], "local": [{"path": "cache/", "why": "…"}]}: paths relative to the data folder (a folder "x/", a file "x.json" or "dir/*.json"), no dots, no "..", at most 20 each, every "why" one line of at most 120 characters.');
    }
  } else data = d.decl;

  if (!backend && (actions.length || schedules.length)) {
    err('backend', 'actions and schedules need a backend', 'Add a backend (they call its routes), or remove the actions and schedules.');
  }

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, manifest: { slug, name, icon, backend, build, watch, agent, mcp, schedules, actions, config, share, data }, warnings };
}

const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** `params`: null when absent, false after an error (already reported), else the parsed map. */
function parseParams(raw: unknown, field: string, err: (f: string, p: string, x: string) => void): Record<string, ActionParam> | null | false {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) { err(field, 'not an object', 'Write params as {"name": {"type": "string", "required": true, "desc": "…"}}.'); return false; }
  const names = Object.keys(raw);
  if (names.length > 12) { err(field, 'more than 12 inputs', 'Keep a tool to at most 12 inputs; split it into two tools.'); return false; }
  const out: Record<string, ActionParam> = {};
  for (const name of names) {
    const v = raw[name];
    if (!PARAM_NAME_RE.test(name) || name === '__proto__' || name === 'constructor') { err(`${field}.${cleanText(name, 40)}`, 'not an input name', 'Use letters, digits and _, starting with a letter.'); return false; }
    if (!isObj(v) || !(PARAM_TYPES as readonly string[]).includes(v.type as string)) { err(`${field}.${name}`, 'needs a type', `Give {"type": one of ${PARAM_TYPES.join(', ')}}.`); return false; }
    let choices: string[] | undefined;
    if (v.type === 'enum') {
      choices = Array.isArray(v.choices) ? v.choices.filter((x): x is string => typeof x === 'string').map((x) => cleanText(x, 60)).filter(Boolean).slice(0, 30) : [];
      if (!choices.length) { err(`${field}.${name}.choices`, 'an enum needs choices', 'List the allowed values, e.g. ["notch","mac","both"].'); return false; }
    }
    const desc = typeof v.desc === 'string' ? cleanText(v.desc, 120) : '';
    out[name] = { type: v.type as ParamType, required: v.required === true, ...(desc ? { desc } : {}), ...(choices ? { choices } : {}) };
  }
  return out;
}

/**
 * Check a tool's input against its `params`, before any call. null = fine; else the first
 * problem as `<field>: <fix>`. No `params`: anything JSON goes (the app checks it).
 */
export function checkToolInput(action: AppAction, input: unknown): string | null {
  if (!action.params) return null;
  if (input === undefined) input = {};
  if (!isObj(input)) return '(input): give a JSON object, e.g. {"q": "…"}';
  for (const [name, p] of Object.entries(action.params)) {
    const v = (input as Record<string, unknown>)[name];
    if (v === undefined || v === null || v === '') {
      if (p.required) return `${name}: required${p.desc ? ` (${p.desc})` : ''}`;
      continue;
    }
    if (p.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) return `${name}: give a number`;
    if (p.type === 'boolean' && typeof v !== 'boolean') return `${name}: give true or false`;
    if (p.type === 'string' && typeof v !== 'string') return `${name}: give a string`;
    if (p.type === 'date' && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(Date.parse(v)))) return `${name}: give a date as YYYY-MM-DD`;
    if (p.type === 'enum' && (typeof v !== 'string' || !p.choices?.includes(v))) return `${name}: one of ${(p.choices ?? []).join(', ')}`;
  }
  for (const k of Object.keys(input as Record<string, unknown>)) {
    if (!(k in action.params)) return `${k}: not an input of this tool (inputs: ${Object.keys(action.params).join(', ') || 'none'})`;
  }
  return null;
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
