/**
 * The ONE reader of an MCP definition for dreamcontext Apps (dreamcontext-apps plan r19, W3),
 * shared by the bridge (what runs) and the owner's approval row (what is shown).
 *
 * Only `type, url, command, args, cwd, env, headers` are read; the bridge runs nothing else.
 * Unknown keys (`oauth`, `timeout`, `alwaysAllow`, `disabled` …) are ignored and LISTED. Only a
 * key that changes authentication and cannot be honoured (`headersHelper`) is refused.
 *
 * Refused (never truncated): a key outside `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`, a control / bidi /
 * zero-width character in any value, more than 24 env + header + ignored keys, more than 64
 * args, a value over 512 characters, a non-string value. The refusal names the FIELD and how to
 * fix it and never echoes the refused value.
 *
 * The approval row shows everything UNMASKED (plan r19, 13-14th rounds: any mask keyed on a name
 * or a shape gives an attacker a place to hide). The values are already in `.mcp.json`.
 */

import { createHash } from 'node:crypto';

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface ReviewedMcp {
  type: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
}

export type ReviewResult =
  | { ok: true; def: ReviewedMcp; ignored: string[] }
  | { ok: false; code: 'mcp_definition_unreadable' | 'mcp_field_unsupported' | 'mcp_transport_unsupported'; field: string; message: string };

const READ = new Set(['type', 'url', 'command', 'args', 'cwd', 'env', 'headers']);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// Control, bidi overrides/isolates, zero-width and line/paragraph separators.
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/;
const MAX_KEYS = 24;
const MAX_ARGS = 64;
const MAX_VALUE = 512;

function isRefusal(x: unknown): x is ReviewResult & { ok: false } {
  return !!x && typeof x === 'object' && (x as { ok?: unknown }).ok === false && typeof (x as { code?: unknown }).code === 'string';
}

function refuse(field: string, how: string): ReviewResult {
  return { ok: false, code: 'mcp_definition_unreadable', field, message: `${field}: ${how}` };
}

function str(v: unknown, field: string): string | ReviewResult {
  if (typeof v !== 'string') return refuse(field, 'must be a string');
  if (v.length > MAX_VALUE) return refuse(field, `is longer than ${MAX_VALUE} characters; shorten it or move it into a \${VAR}`);
  if (BAD_CHARS.test(v)) return refuse(field, 'contains a control, bidi or zero-width character; retype it as plain text');
  return v;
}

function strMap(v: unknown, field: string): Record<string, string> | ReviewResult {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return refuse(field, 'must be an object of strings');
  const out: Record<string, string> = {};
  for (const k of Object.keys(v as object)) {
    if (!Object.hasOwn(v as object, k)) continue;
    if (!KEY_RE.test(k)) return refuse(field, 'has a key that is not a plain name (letters, digits, _ and -, up to 64)');
    const s = str((v as Record<string, unknown>)[k], `${field}.${k}`);
    if (typeof s !== 'string') return s;
    out[k] = s;
  }
  return out;
}

export function reviewMcpDefinition(raw: unknown): ReviewResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('(definition)', 'must be an object');
  const obj = raw as Record<string, unknown>;
  if (Object.hasOwn(obj, 'headersHelper')) {
    return { ok: false, code: 'mcp_field_unsupported', field: 'headersHelper', message: 'headersHelper: apps cannot run a header helper; put the header in "headers" with a ${VAR}' };
  }
  const ignored = Object.keys(obj).filter((k) => !READ.has(k)).sort();
  const typeRaw = obj.type === undefined ? 'stdio' : obj.type;
  if (typeRaw !== 'stdio' && typeRaw !== 'http' && typeRaw !== 'sse') {
    return { ok: false, code: 'mcp_transport_unsupported', field: 'type', message: 'type: apps call stdio, http and sse servers only' };
  }
  const env = strMap(obj.env, 'env');
  if (isRefusal(env)) return env;
  const headers = strMap(obj.headers, 'headers');
  if (isRefusal(headers)) return headers;
  const e = env as Record<string, string>;
  const h = headers as Record<string, string>;
  if (Object.keys(e).length + Object.keys(h).length + ignored.length > MAX_KEYS) return refuse('(definition)', `has more than ${MAX_KEYS} env, header and other keys`);
  let args: string[] = [];
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) return refuse('args', 'must be a list of strings');
    if (obj.args.length > MAX_ARGS) return refuse('args', `has more than ${MAX_ARGS} items`);
    for (const [i, a] of obj.args.entries()) {
      const s = str(a, `args[${i}]`);
      if (typeof s !== 'string') return s;
      args.push(s);
    }
  }
  const one = (k: 'url' | 'command' | 'cwd'): string | null | ReviewResult => (obj[k] === undefined || obj[k] === null ? null : str(obj[k], k));
  const url = one('url');
  if (url !== null && typeof url !== 'string') return url;
  const command = one('command');
  if (command !== null && typeof command !== 'string') return command;
  const cwd = one('cwd');
  if (cwd !== null && typeof cwd !== 'string') return cwd;
  if (typeRaw === 'stdio' && !command) return refuse('command', 'a stdio server needs a command');
  if (typeRaw !== 'stdio') {
    if (!url) return refuse('url', 'an http/sse server needs a url');
    if (!/^https?:\/\//i.test(url.replace(/\$\{[^}]*\}/g, 'x'))) return refuse('url', 'must start with http:// or https://');
    args = [];
  }
  return { ok: true, def: { type: typeRaw, url, command, args, cwd, env: e, headers: h }, ignored };
}

/** The pin/hash form: field order and map key order do not matter; args order does. */
export function canonicalMcp(def: ReviewedMcp): string {
  const sortMap = (m: Record<string, string>) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
  return JSON.stringify({ args: def.args, command: def.command, cwd: def.cwd, env: sortMap(def.env), headers: sortMap(def.headers), type: def.type, url: def.url });
}

export function mcpHash(def: ReviewedMcp): string {
  return createHash('sha256').update(canonicalMcp(def)).digest('hex');
}

/** `https://user:pw@evil.example/x` → `evil.example` (punycode kept, userinfo dropped). */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g, 'var')).hostname || null; } catch { return null; }
}

/**
 * The approval row text: "N fields changed" first, then type, url (+ host), command, args, cwd,
 * env, headers, each `old → new` (or the value on a first pin). Nothing masked.
 */
export function describeChange(prev: ReviewedMcp | null, next: ReviewedMcp, ignored: string[]): string {
  const lines: string[] = [];
  const show = (v: unknown) => (v === null || v === undefined ? '(none)' : typeof v === 'string' ? v : JSON.stringify(v));
  const fields: Array<[string, unknown, unknown]> = [
    ['type', prev?.type, next.type],
    ['url', prev?.url, next.url],
    ['command', prev?.command, next.command],
    ['args', prev?.args, next.args],
    ['cwd', prev?.cwd, next.cwd],
  ];
  for (const k of new Set([...Object.keys(prev?.env ?? {}), ...Object.keys(next.env)])) fields.push([`env.${k}`, prev?.env[k], next.env[k]]);
  for (const k of new Set([...Object.keys(prev?.headers ?? {}), ...Object.keys(next.headers)])) fields.push([`headers.${k}`, prev?.headers[k], next.headers[k]]);
  let changed = 0;
  for (const [k, a, b] of fields) {
    const same = JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (prev && same) continue;
    if (!prev && (b === null || b === undefined || (Array.isArray(b) && !b.length))) continue;
    changed++;
    lines.push(prev ? `${k}: ${show(a)} → ${show(b)}` : `${k}: ${show(b)}`);
    if (k === 'url') {
      const host = hostOf(next.url);
      if (host) lines.push(`  host: ${host}`);
    }
  }
  const head = `${changed} ${changed === 1 ? 'field' : 'fields'} changed`;
  const tail = ignored.length ? [`ignored: ${ignored.join(', ')}`] : [];
  return [head, ...lines, ...tail].join('\n');
}
