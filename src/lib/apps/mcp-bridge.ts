/**
 * `dc.mcp.call` (dreamcontext-apps plan r19, W3): an app's backend calls an MCP server the
 * way an agent would, WITHOUT a Claude turn. Owner decision: apps spend no usage limit, so only
 * key-based servers (stdio, or http/sse with static headers) are called directly; an OAuth
 * connector is a clear error, never a silent fallback to an agent.
 *
 * Which definition (the order every spawn uses, src/lib/mcp-store.ts): the dreamcontext stores
 * (`syncImports` once per client, then `storeServers`: Settings and account sandboxes included),
 * then the machine's `~/.claude.json`, then the project's `.mcp.json`, which needs the OWNER's
 * pin first (`mcp_needs_owner_ok`; changed since → `mcp_definition_changed`). A name the owner
 * removed in Settings (`removedInApp`) falls through to nothing. Only names in the manifest's
 * `mcp` list are reachable.
 *
 * Running it: stdio children get the login-shell PATH and the env allow-list plus the
 * definition's own expanded env, cwd = the PROJECT (`def.cwd` relative to it); `${VAR}` expands
 * only from the app's `.env`. Clients live with the gateway and reconnect when the expanded
 * inputs change (a rotated key never sticks). Errors are named: mcp_needs_key, mcp_cwd_missing,
 * mcp_command_not_found, mcp_transport_unsupported, mcp_definition_unreadable …
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { computerStorePath, isImportableName, projectStorePath, readStore, storeServers, syncImports } from '../mcp-store.js';
import { machineMcpServers, rawProjectServers } from '../mcp-project.js';
import { parseDotenv } from './redact.js';
import { appsHome } from './registry.js';
import { mcpHash, reviewMcpDefinition, type ReviewedMcp } from './mcp-review.js';

export class McpBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpBridgeError';
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'TERM'];
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export type McpSource = 'store' | 'machine' | 'project';

function removedInApp(projectRoot: string, home: string): Set<string> {
  const out = new Set<string>();
  for (const p of [computerStorePath(home), projectStorePath(projectRoot, home)]) {
    try {
      const body = existsSync(p) ? readStore(p) : null;
      for (const [n, led] of Object.entries(body?.ledger ?? {})) if (led.removedInApp) out.add(n);
    } catch { /* unreadable store: nothing removed */ }
  }
  return out;
}

/** The definition `name` resolves to for this project, by the spawn order. */
export function resolveMcpDefinition(projectRoot: string, name: string, home: string = homedir()): { source: McpSource; raw: Record<string, unknown> } | null {
  if (!NAME_RE.test(name) || !isImportableName(name)) return null;
  const store = storeServers(projectRoot, home);
  if (store.has(name)) return { source: 'store', raw: store.get(name) as Record<string, unknown> };
  const removed = removedInApp(projectRoot, home);
  if (removed.has(name)) return null;
  const machine = machineMcpServers(home);
  if (Object.hasOwn(machine, name)) return { source: 'machine', raw: machine[name] as Record<string, unknown> };
  const project = rawProjectServers(projectRoot);
  if (Object.hasOwn(project, name)) return { source: 'project', raw: project[name] as Record<string, unknown> };
  return null;
}

// ─── pins (.mcp.json definitions the owner approved, per app) ───────────────────────

export function pinsPath(home: string, appHash: string): string {
  if (!/^[0-9a-f]{16}$/.test(appHash)) throw new Error('bad app hash');
  return join(appsHome(home), 'mcp-pins', `${appHash}.json`);
}

interface PinFile { servers: Record<string, { def: ReviewedMcp; hash: string; at: string }> }

export function readPins(home: string, appHash: string): PinFile {
  try {
    const p = pinsPath(home, appHash);
    if (lstatSync(p).isSymbolicLink()) return { servers: {} };
    const v = JSON.parse(readFileSync(p, 'utf-8')) as PinFile;
    return v && typeof v.servers === 'object' ? v : { servers: {} };
  } catch {
    return { servers: {} };
  }
}

/** Written ONLY by the notch approval path (routes/apps.ts mcp-request → decision). */
export function writePin(home: string, appHash: string, name: string, def: ReviewedMcp): void {
  const p = pinsPath(home, appHash);
  mkdirSync(join(appsHome(home), 'mcp-pins'), { recursive: true, mode: 0o700 });
  const cur = readPins(home, appHash);
  cur.servers[name] = { def, hash: mcpHash(def), at: new Date().toISOString() };
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, p);
}

export function removePins(home: string, appHash: string): void {
  try { rmSync(pinsPath(home, appHash), { force: true }); } catch { /* none */ }
}

// ─── expansion ──────────────────────────────────────────────────────────────────────

function appEnv(appRoot: string): Record<string, string> {
  try {
    return Object.fromEntries(parseDotenv(readFileSync(join(appRoot, '.env'), 'utf-8')).map((e) => [e.key, e.value]));
  } catch {
    return {};
  }
}

/** Expand `${VAR}` / `${VAR:-default}` from the app's `.env` only. Missing → mcp_needs_key. */
export function expandVars(value: string, vars: Record<string, string>): string {
  return value.replace(VAR, (_m, name: string, dflt: string | undefined) => {
    if (Object.hasOwn(vars, name) && vars[name] !== '') return vars[name];
    if (dflt !== undefined) return dflt;
    throw new McpBridgeError('mcp_needs_key', `${name} is not set: add it to the app's .env (the owner can use a secret card).`);
  });
}

export interface ResolvedMcp {
  name: string;
  source: McpSource;
  def: ReviewedMcp;
  /** The expanded transport inputs (never logged, never returned). */
  expanded: ReviewedMcp;
  /** Every resolved env/header value, for the redaction sink. */
  secrets: Array<{ key: string; value: string }>;
}

/** Resolve, gate (manifest list, pins) and expand one server for one app. */
export function prepareMcp(opts: { home?: string; projectRoot: string; appRoot: string; appHash: string; allowed: readonly string[]; name: string }): ResolvedMcp {
  const home = opts.home ?? homedir();
  if (!opts.allowed.includes(opts.name)) throw new McpBridgeError('mcp_not_in_manifest', `"${opts.name}" is not in the app manifest's mcp list.`);
  const hit = resolveMcpDefinition(opts.projectRoot, opts.name, home);
  if (!hit) throw new McpBridgeError('mcp_needs_key', `No MCP server named "${opts.name}" for this project (Settings → MCP), or it was removed there.`);
  const reviewed = reviewMcpDefinition(hit.raw);
  if (!reviewed.ok) throw new McpBridgeError(reviewed.code, reviewed.message);
  const def = reviewed.def;
  if (hit.source === 'project') {
    const pin = readPins(home, opts.appHash).servers[opts.name];
    if (!pin) throw new McpBridgeError('mcp_needs_owner_ok', `The owner has not approved "${opts.name}" from .mcp.json for this app yet (Apps card → approve in the notch).`);
    if (pin.hash !== mcpHash(def)) throw new McpBridgeError('mcp_definition_changed', `"${opts.name}" in .mcp.json changed since the owner approved it; it needs a new approval.`);
  }
  const vars = appEnv(opts.appRoot);
  const ex = (v: string) => expandVars(v, vars);
  const expanded: ReviewedMcp = {
    type: def.type,
    url: def.url === null ? null : ex(def.url),
    command: def.command === null ? null : ex(def.command),
    args: def.args.map(ex),
    cwd: def.cwd === null ? null : ex(def.cwd),
    env: Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, ex(v)])),
    headers: Object.fromEntries(Object.entries(def.headers).map(([k, v]) => [k, ex(v)])),
  };
  const secrets = [
    ...Object.entries(expanded.env).map(([key, value]) => ({ key, value })),
    ...Object.entries(expanded.headers).map(([key, value]) => ({ key, value })),
  ];
  return { name: opts.name, source: hit.source, def, expanded, secrets };
}

// ─── clients ────────────────────────────────────────────────────────────────────────

interface Live { key: string; client: Promise<Client>; close: () => Promise<void>; closed?: boolean }
/**
 * One client per app and server. The entry holds the CONNECT PROMISE, set before the first await,
 * so concurrent first calls share one child; a client that closes (its server exited) leaves the
 * map, so the next call starts a fresh one instead of failing on a dead transport.
 */
const clients = new Map<string, Live>();
let synced = new Set<string>();

function liveKey(r: ResolvedMcp): string {
  return createHash('sha256').update(JSON.stringify(r.expanded)).digest('hex');
}

export interface ConnectDeps {
  loginPath?: () => Promise<string>;
  onStderr?: (line: string) => void;
}

function connect(appHash: string, projectRoot: string, r: ResolvedMcp, deps: ConnectDeps): Promise<Client> {
  const id = `${appHash}\u0000${r.name}`;
  const key = liveKey(r);
  const cur = clients.get(id);
  if (cur && cur.key === key) return cur.client;
  if (cur) { clients.delete(id); void cur.close().catch(() => {}); }
  const client = new Client({ name: 'dreamcontext-app', version: '1' });
  const live: Live = {
    key,
    // Closed while still connecting (Stop, DELETE, sweep): close() was a no-op then, since no
    // transport was attached yet, so the child that connect() just started is closed here.
    client: open(client, projectRoot, r, deps).then(async (c) => {
      if (live.closed) { await c.close().catch(() => {}); throw new McpBridgeError('mcp_connect_failed', 'The app stopped while the server was starting.'); }
      return c;
    }),
    close: () => { live.closed = true; return client.close(); },
  };
  clients.set(id, live);
  client.onclose = () => { if (clients.get(id) === live) clients.delete(id); };
  live.client.catch(() => { if (clients.get(id) === live) clients.delete(id); });
  return live.client;
}

async function open(client: Client, projectRoot: string, r: ResolvedMcp, deps: ConnectDeps): Promise<Client> {
  const e = r.expanded;
  if (e.type === 'stdio') {
    const cwd = e.cwd ? (isAbsolute(e.cwd) ? e.cwd : resolve(projectRoot, e.cwd)) : projectRoot;
    try { if (!statSync(cwd).isDirectory()) throw new Error(); } catch { throw new McpBridgeError('mcp_cwd_missing', `The server's working folder does not exist: ${cwd}`); }
    const env: Record<string, string> = {};
    for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k] as string;
    if (deps.loginPath) { try { env.PATH = await deps.loginPath(); } catch { /* keep */ } }
    Object.assign(env, e.env);
    const transport = new StdioClientTransport({ command: e.command as string, args: e.args, env, cwd, stderr: 'pipe' });
    transport.stderr?.on('data', (c: Buffer) => { for (const l of String(c).split('\n')) if (l.trim()) deps.onStderr?.(l); });
    try {
      await client.connect(transport);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new McpBridgeError('mcp_command_not_found', `Command not found: ${e.command}`);
      throw new McpBridgeError('mcp_connect_failed', `Could not start the server: ${(err as Error).message}`);
    }
  } else {
    const url = new URL(e.url as string);
    const transport = e.type === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers: e.headers } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers: e.headers } });
    try {
      await client.connect(transport);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/401|403|unauthori[sz]ed|oauth/i.test(msg)) {
        throw new McpBridgeError('mcp_needs_key', `"${r.name}" refused without a key. Apps call key-based servers only (no OAuth connectors): put its key in the app's .env.`);
      }
      throw new McpBridgeError('mcp_connect_failed', `Could not reach the server: ${msg}`);
    }
  }
  return client;
}

/** Call `tool` on `server` for this app. `syncImports` runs once per app per process. */
export async function callMcpTool(opts: {
  home?: string; projectRoot: string; appRoot: string; appHash: string; allowed: readonly string[];
  server: string; tool: string; args: Record<string, unknown>; deps?: ConnectDeps;
}): Promise<{ result: unknown; secrets: Array<{ key: string; value: string }> }> {
  const home = opts.home ?? homedir();
  if (!synced.has(opts.appHash)) {
    synced.add(opts.appHash);
    try { syncImports(home, opts.projectRoot); } catch { /* the stores as they are */ }
  }
  const r = prepareMcp({ home, projectRoot: opts.projectRoot, appRoot: opts.appRoot, appHash: opts.appHash, allowed: opts.allowed, name: opts.server });
  const client = await connect(opts.appHash, opts.projectRoot, r, opts.deps ?? {});
  const result = await client.callTool({ name: opts.tool, arguments: opts.args });
  return { result, secrets: r.secrets };
}

/** Close every client of an app (its gateway closed), or all of them. */
export async function closeMcpClients(appHash?: string): Promise<void> {
  for (const [id, live] of [...clients]) {
    if (appHash && !id.startsWith(`${appHash}\u0000`)) continue;
    clients.delete(id);
    await live.close().catch(() => {});
  }
  if (appHash) synced.delete(appHash);
  if (!appHash) synced = new Set();
}
