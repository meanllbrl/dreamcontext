import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { computerStorePath, mcpStoreFiles, projectStorePath, readScope, type McpDefinition } from './mcp-store.js';
import { adoptConnect, secretLiterals, type ConnectTicket, type SpawnFn } from './mcp-live.js';
import { codexConfigArg, tomlString } from './t3-bridge/launch.js';
import type { CodexMcpAuth, CodexMcpLeft, McpLiveStatus } from './mcp-wire.js';

/**
 * The owner's MCP servers on Codex, and what a live Codex says about them.
 *
 * ── Reaching Codex ───────────────────────────────────────────────────────────────────────
 * Claude Code gets the app's stores with `--mcp-config`. Codex's equivalent is one `-c
 * mcp_servers.<name>.…` per field on its launch, so `~/.codex/config.toml` is never written and
 * a server edited in Settings reaches the next chat.
 *
 * `-c` values are process arguments, and `ps` shows those, while env vars of the Codex process
 * reach its hooks, so no secret rides in either. A stdio server starts as `dreamcontext mcp
 * lean-exec <store file> <name>`, an HTTP server holding a key as `dreamcontext mcp http-relay
 * <store file> <name>`: each reads the real values from the 0600 store. Only an HTTP server with
 * a plain address and no headers is handed over as a URL, which is also what lets Codex run its
 * own OAuth for it.
 *
 * ── Asking Codex ─────────────────────────────────────────────────────────────────────────
 * `codex app-server` answers `mcpServerStatus/list` before any thread exists (measured on 0.164:
 * 1.5 s, no session file). A row holds tools and an auth status; a server that did not start is
 * just a row with no tools. Nothing but a name, a status and a count leaves this file.
 */

const PLAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VARIABLE = /\$\{/;
/** The same patience Claude Code gives a server, Codex's own default being 10 s. */
const STARTUP_TIMEOUT_SEC = 30;

export interface CodexStorePlan {
  /** `[key, tomlValue]`, one per `-c` override. */
  pairs: Array<[string, string]>;
  /** The servers that reach this Codex, with their transport. */
  reached: Array<{ name: string; transport: 'stdio' | 'http' }>;
  left: CodexMcpLeft[];
  /** The same servers as launch routes: a tool that takes a server list (ACP) reads these. */
  routes: StoreRoute[];
}

/** How a stored server starts: through our own child from its 0600 file, or a plain address. */
export type StoreRoute =
  | { name: string; via: 'lean-exec' | 'http-relay'; file: string }
  | { name: string; via: 'url'; url: string };

const emptyPlan = (): CodexStorePlan => ({ pairs: [], reached: [], left: [], routes: [] });

function usesVariable(def: McpDefinition): boolean {
  const strings = (v: unknown): string[] => {
    if (typeof v === 'string') return [v];
    if (Array.isArray(v)) return v.flatMap(strings);
    return v && typeof v === 'object' ? Object.values(v as object).flatMap(strings) : [];
  };
  return strings([def.command, def.args, def.env, def.url, def.headers]).some((s) => VARIABLE.test(s));
}

/**
 * The stores, as Codex config. `listed` is what Codex already has: its own entry wins, since
 * overriding single fields of it would mix two definitions. Null (it did not answer) means
 * nothing is added: one unknown clash can stop Codex from starting at all.
 */
export function codexStorePlan(o: { home?: string; projectRoot: string | null; node: string; cli: string; listed: readonly string[] | null; sync?: boolean }): CodexStorePlan {
  const plan = emptyPlan();
  if (!o.listed || !o.node || !o.cli) return plan;
  const home = o.home ?? homedir();
  mcpStoreFiles({ home, projectRoot: o.projectRoot, sync: o.sync !== false });
  const merged = new Map<string, { def: McpDefinition; file: string }>();
  const scopes = [
    { body: readScope('computer', null, home), file: computerStorePath(home) },
    ...(o.projectRoot ? [{ body: readScope('project', o.projectRoot, home), file: projectStorePath(o.projectRoot, home) }] : []),
  ];
  for (const s of scopes) for (const name of Object.keys(s.body?.mcpServers ?? {})) merged.set(name, { def: s.body!.mcpServers[name], file: s.file });

  const arr = (xs: string[]): string => `[${xs.map(tomlString).join(', ')}]`;
  for (const name of [...merged.keys()].sort()) {
    const { def, file } = merged.get(name)!;
    if (o.listed.includes(name) || name === 'dreamcontext') continue;
    if (!PLAIN_NAME.test(name)) { plan.left.push({ name, why: 'name' }); continue; }
    if (usesVariable(def)) { plan.left.push({ name, why: 'variable' }); continue; }
    const at = (field: string): string => `mcp_servers.${name}.${field}`;
    if (typeof def.url === 'string') {
      if (def.type !== undefined && def.type !== 'http') { plan.left.push({ name, why: 'transport' }); continue; }
      const hasHeaders = !!def.headers && typeof def.headers === 'object' && Object.keys(def.headers).length > 0;
      if (hasHeaders || !plainAddress(def.url)) {
        plan.pairs.push([at('command'), tomlString(o.node)]);
        plan.pairs.push([at('args'), arr([o.cli, 'mcp', 'http-relay', file, name])]);
        plan.routes.push({ name, via: 'http-relay', file });
      } else {
        plan.pairs.push([at('url'), tomlString(def.url)]);
        plan.routes.push({ name, via: 'url', url: def.url });
      }
      plan.pairs.push([at('startup_timeout_sec'), String(STARTUP_TIMEOUT_SEC)]);
      plan.reached.push({ name, transport: 'http' });
    } else if (typeof def.command === 'string') {
      plan.pairs.push([at('command'), tomlString(o.node)]);
      plan.pairs.push([at('args'), arr([o.cli, 'mcp', 'lean-exec', file, name])]);
      plan.pairs.push([at('startup_timeout_sec'), String(STARTUP_TIMEOUT_SEC)]);
      plan.reached.push({ name, transport: 'stdio' });
      plan.routes.push({ name, via: 'lean-exec', file });
    } else {
      plan.left.push({ name, why: 'transport' });
    }
  }
  return plan;
}

/** An address that may stand in `ps`: nothing in it that could be a key. */
function plainAddress(url: string): boolean {
  try {
    const u = new URL(url);
    return !u.search && !u.hash && !u.username && !u.password && secretLiterals({ url }).length === 0;
  } catch { return false; }
}

/** The plan as T3's launch-args string. */
export const planLaunchArgs = (plan: CodexStorePlan): string =>
  plan.pairs.map(([k, v]) => codexConfigArg(k, v)).join(' ');

/** The plan as a plain argv, for our own `codex app-server` child. */
export const planArgv = (plan: CodexStorePlan): string[] => plan.pairs.flatMap(([k, v]) => ['-c', `${k}=${v}`]);

// ─── One short-lived `codex app-server` ───────────────────────────────────────────────────

export interface AppServerOptions {
  bin: string;
  /** Goes before `app-server`: an account's `-c`, the plan. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawnImpl?: SpawnFn;
}

interface AppServer {
  request: (method: string, params: unknown) => Promise<Record<string, unknown>>;
  onNotification: (fn: (method: string, params: Record<string, unknown>) => void) => void;
  exited: Promise<void>;
  kill: () => void;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Its stdout is read only for JSON-RPC replies, stderr is not read at all: both can echo config. */
function startAppServer(o: AppServerOptions): AppServer | null {
  const spawnFn = o.spawnImpl ?? (nodeSpawn as unknown as SpawnFn);
  let child: ChildProcess;
  try {
    child = spawnFn(o.bin, [...o.argv, 'app-server'], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  } catch { return null; }
  child.on('error', () => { /* reported through `exited` */ });
  if (!child.stdin || !child.stdout) return null;
  const stdin = child.stdin;
  stdin.on('error', () => { /* it went away */ });
  let nextId = 0;
  const waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let listener: (method: string, params: Record<string, unknown>) => void = () => {};
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    if (buf.length > 8_000_000) buf = buf.slice(-1_000_000);
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m: Record<string, unknown> | null = null;
      try { m = asRecord(JSON.parse(line)); } catch { continue; }
      if (!m) continue;
      if (typeof m.id === 'number' && waiting.has(m.id) && typeof m.method !== 'string') {
        const w = waiting.get(m.id)!;
        waiting.delete(m.id);
        if (m.error) w.reject(new Error('refused'));
        else w.resolve(asRecord(m.result) ?? {});
      } else if (typeof m.method === 'string' && m.id === undefined) {
        listener(m.method, asRecord(m.params) ?? {});
      }
    }
  });
  const exited = new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      for (const w of waiting.values()) w.reject(new Error('closed'));
      waiting.clear();
      resolve();
    };
    child.on('exit', finish);
    child.on('error', finish);
  });
  const send = (frame: Record<string, unknown>): void => { if (!stdin.destroyed && stdin.writable) stdin.write(`${JSON.stringify(frame)}\n`); };
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      send({ id, method, params });
    }),
    onNotification: (fn) => { listener = fn; },
    exited,
    kill: () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    },
  };
}

async function initialize(server: AppServer): Promise<void> {
  await server.request('initialize', { clientInfo: { name: 'dreamcontext', version: '1' } });
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ─── Status ───────────────────────────────────────────────────────────────────────────────

export interface CodexLiveServer {
  name: string;
  status: McpLiveStatus;
  authStatus: CodexMcpAuth;
  toolCount: number;
}

function authOf(v: unknown): CodexMcpAuth {
  switch (v) {
    case 'unsupported': return 'unsupported';
    case 'notLoggedIn': return 'not_logged_in';
    case 'bearerToken': return 'bearer_token';
    case 'oAuth': return 'oauth';
    default: return 'unknown';
  }
}

const RUNTIME_STATUS: Record<string, McpLiveStatus> = {
  connected: 'connected', authenticationRequired: 'needs-auth', failed: 'failed', disabled: 'disabled', starting: 'pending',
};

/**
 * One `mcpServerStatus/list` row, whitelisted. With no thread `runtimeStatus` is empty, so the
 * tools decide first: `notLoggedIn` only means no OAuth token, and a server reached with an API
 * key header reports it beside its tools. Then the auth status; a stdio server that failed to
 * start is a row with no tools, and one with no tools gives a chat nothing anyway.
 */
export function codexLiveRow(raw: unknown): CodexLiveServer | null {
  const r = asRecord(raw);
  if (!r || typeof r.name !== 'string' || !r.name) return null;
  const authStatus = authOf(r.authStatus);
  const tools = r.tools;
  const toolCount = Array.isArray(tools) ? tools.length : asRecord(tools) ? Object.keys(tools as object).length : 0;
  const runtime = typeof r.runtimeStatus === 'string' ? RUNTIME_STATUS[r.runtimeStatus] : undefined;
  const status: McpLiveStatus = runtime ?? (toolCount > 0 ? 'connected' : authStatus === 'not_logged_in' ? 'needs-auth' : 'failed');
  return { name: r.name, status, authStatus, toolCount };
}

const PROBE_DEADLINE_MS = 45_000;
const CONNECT_WINDOW_MS = 5 * 60_000;

/** Ask one transient Codex about its servers, every page. Null = it gave no answer. */
export async function probeCodexMcp(o: AppServerOptions & { deadlineMs?: number }): Promise<CodexLiveServer[] | null> {
  const server = startAppServer(o);
  if (!server) return null;
  const ask = async (): Promise<CodexLiveServer[]> => {
    await initialize(server);
    const out: CodexLiveServer[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const r: Record<string, unknown> = await server.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) });
      for (const row of Array.isArray(r.data) ? r.data : []) {
        const parsed = codexLiveRow(row);
        if (parsed) out.push(parsed);
      }
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
      if (!cursor) break;
    }
    return out;
  };
  try {
    return await withDeadline(ask(), o.deadlineMs ?? PROBE_DEADLINE_MS);
  } catch {
    return null;
  } finally {
    server.kill();
  }
}

// ─── Sign-in ──────────────────────────────────────────────────────────────────────────────

/**
 * A server's sign-in on Codex: Codex's own OAuth, through the transient child that holds the
 * callback. The ticket is the same one Claude's sign-in uses, so the window follows it the same
 * way, one sign-in at a time across both tools. The token lands where Codex keeps it.
 */
export function startCodexConnect(o: AppServerOptions & { name: string; windowMs?: number }): ConnectTicket | 'busy' | null {
  const server = startAppServer(o);
  if (!server) return null;
  let stopped = false;
  const ticket = adoptConnect('codex', o.name, () => { stopped = true; server.kill(); });
  if (ticket === 'busy') { server.kill(); return 'busy'; }
  const live = ticket;
  void (async () => {
    try {
      const done = new Promise<boolean>((resolve) => {
        server.onNotification((method, params) => {
          if (method === 'mcpServer/oauthLogin/completed' && params.name === o.name) resolve(params.success === true);
        });
        void server.exited.then(() => resolve(false));
      });
      await initialize(server);
      const r = await server.request('mcpServer/oauth/login', { name: o.name });
      live.setUrl(r.authorizationUrl);
      live.setState('waiting');
      const ok = await withDeadline(done, o.windowMs ?? CONNECT_WINDOW_MS);
      if (!stopped) live.setState(ok === null ? 'timeout' : ok ? 'connected' : 'failed');
    } catch {
      if (!stopped) live.setState('failed');
    } finally {
      server.kill();
    }
  })();
  return live.view();
}

