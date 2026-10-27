import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { claudeAwarePath, findClaudeBin } from './claude-path.js';
import { defHash, readScope, type McpDefinition } from './mcp-store.js';
import { maskTarget } from './mcp-project.js';
import type { McpErrorKind, McpHome, McpLiveServer, McpLiveStatus } from './mcp-wire.js';

/**
 * MCP status and sign-in, asked of the LIVE session (task mcp-management; the ask-the-subject
 * pattern). A `claude -p --input-format stream-json` child answers `control_request
 * {subtype:"mcp_status"}` before its first user turn (measured on 2.1.311), and
 * `mcp_authenticate {serverName}` returns the browser URL the CLI itself is waiting on.
 *
 * ── Secrets never leave this file raw ───────────────────────────────────────────────────
 * The status reply's `config` carries every header, env value and URL the definition holds,
 * and `error` is free CLI text that can echo them. So:
 *   • the chat's stdout loop consumes these replies BEFORE relaying anything (fail closed: any
 *     control_response carrying `mcpServers`, whatever its id — {@link isMcpControlLine});
 *   • {@link redactStatus} whitelists `{name, status, home, transport, urlHost, toolCount,
 *     errorKind}` and runs a by-value scrub with every literal the definition holds;
 *   • probe and connect children's output is never logged or returned.
 */

/** Request ids this app writes. A reply carrying one is ours and is never relayed. */
export const MCP_REQUEST_PREFIX = 'dcmcp-';
const CONTROL_TIMEOUT_MS = 10_000;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Must this stdout line be consumed rather than relayed? A `control_response` whose nested
 * `response.request_id` is ours, OR whose payload carries `mcpServers` at all (fail closed: a
 * status reply somebody else asked for still carries secrets).
 */
export function isMcpControlLine(obj: Record<string, unknown> | null): boolean {
  if (!obj || obj.type !== 'control_response') return false;
  const resp = asRecord(obj.response);
  if (!resp) return false;
  if (typeof resp.request_id === 'string' && resp.request_id.startsWith(MCP_REQUEST_PREFIX)) return true;
  const inner = asRecord(resp.response);
  return !!inner && Object.hasOwn(inner, 'mcpServers');
}

/**
 * The head of a chat child's stdout loop: parse FIRST, then either hand an MCP control reply to
 * `control` (and nothing else: no socket, no mirror, no observer) or relay the line and return
 * the parsed frame for the rest of the loop. Null = the loop continues with the next line.
 */
export function routeChildLine(
  line: string,
  sinks: { send: (line: string) => void; mirror: (line: string) => void; control: (obj: Record<string, unknown>) => void },
): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown> | null = null;
  try { obj = asRecord(JSON.parse(trimmed)); } catch { /* a partial or non-JSON line */ }
  if (obj && isMcpControlLine(obj)) {
    sinks.control(obj);
    return null;
  }
  sinks.send(line);
  sinks.mirror(line);
  return obj;
}

/** Writes control requests to a child and matches the replies. One per child. */
export class McpControl {
  private pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private write: (frame: Record<string, unknown>) => boolean, private timeoutMs: number = CONTROL_TIMEOUT_MS) {}

  request(subtype: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `${MCP_REQUEST_PREFIX}${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      let ok = false;
      try { ok = this.write({ type: 'control_request', request_id: id, request: { subtype, ...extra } }); } catch { ok = false; }
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('unwritable'));
      }
    });
  }

  /** A consumed control_response. Resolves the matching request; anything else is dropped. */
  handle(obj: Record<string, unknown>): void {
    const resp = asRecord(obj.response);
    const id = typeof resp?.request_id === 'string' ? resp.request_id : '';
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (resp?.subtype === 'error') p.reject(new Error('refused'));
    else p.resolve(asRecord(resp?.response) ?? {});
  }

  /** The child is gone: every waiting request fails now, not in 10 s. */
  close(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('closed'));
      this.pending.delete(id);
    }
  }

  async status(): Promise<unknown[]> {
    const r = await this.request('mcp_status');
    return Array.isArray(r.mcpServers) ? r.mcpServers : [];
  }
}

// ─── Redaction ────────────────────────────────────────────────────────────────

const MASK = '••••';

/** Every literal in a definition that must never be shown: header/env values, URL query values
 *  and userinfo, and stdio arguments of 8+ characters. */
export function secretLiterals(def: McpDefinition | null | undefined): string[] {
  if (!def) return [];
  const out = new Set<string>();
  const add = (v: unknown, min: number) => {
    const text = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    if (text.length < min) return;
    out.add(text);
    // `Bearer <token>`, `--token=<token>`: the token alone is a secret too.
    for (const part of text.split(/[\s=:,;]+/)) if (part.length >= 8) out.add(part);
  };
  for (const field of ['headers', 'env'] as const) {
    const m = asRecord(def[field]);
    if (m) for (const v of Object.values(m)) add(v, 4);
  }
  if (typeof def.url === 'string') {
    try {
      const u = new URL(def.url);
      for (const v of u.searchParams.values()) add(v, 4);
      add(decodeURIComponent(u.username), 4);
      add(decodeURIComponent(u.password), 4);
      for (const seg of u.pathname.split('/')) if (/^[A-Za-z0-9_-]{24,}$/.test(seg)) add(seg, 4);
    } catch { /* not a URL: nothing parsed out of it is shown either */ }
  }
  if (Array.isArray(def.args)) for (const a of def.args) add(a, 8);
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every secret literal in `text`. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join(MASK);
  return out;
}

/**
 * How a definition is shown: an http server as `scheme://host` + its path with opaque segments
 * masked (query and userinfo dropped entirely); a stdio one as the command's basename + its
 * argument count. Scrubbed by value as well.
 */
export function displayTarget(def: McpDefinition): string {
  const secrets = secretLiterals(def);
  if (typeof def.url === 'string') {
    try {
      const u = new URL(def.url);
      return scrub(`${u.protocol}//${u.host}${maskTarget(u.pathname === '/' ? '' : u.pathname)}`, secrets);
    } catch { return MASK; }
  }
  const command = typeof def.command === 'string' ? basename(def.command) : '';
  const n = Array.isArray(def.args) ? def.args.length : 0;
  return scrub(`${command || 'command'}${n ? ` · ${n} arg${n === 1 ? '' : 's'}` : ''}`, secrets);
}

/** `scheme://host` of a URL, or undefined. */
function urlHostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.protocol}//${u.host}` : undefined;
  } catch { return undefined; }
}

const STATUS_MAP: Record<string, McpLiveStatus> = {
  connected: 'connected', 'needs-auth': 'needs-auth', needs_auth: 'needs-auth', pending: 'pending',
  failed: 'failed', error: 'failed', disabled: 'disabled',
};

/** The error KIND of a failed server, from the CLI's free text, which itself never leaves. */
export function errorKindOf(status: McpLiveStatus, error: unknown): McpErrorKind | undefined {
  if (status === 'needs-auth') return 'auth';
  if (status !== 'failed') return undefined;
  const t = typeof error === 'string' ? error : '';
  if (/ENOENT|EACCES|\bspawn\b|command not found|exited|exit code|No such file/i.test(t)) return 'spawn';
  if (/unauthori|forbidden|\b401\b|\b403\b|oauth|invalid_token|authenticat/i.test(t)) return 'auth';
  if (/time(d)?\s?out|ETIMEDOUT/i.test(t)) return 'timeout';
  if (/protocol|parse|invalid|JSON|handshake|ECONNREFUSED|fetch failed/i.test(t)) return 'protocol';
  return 'other';
}

/** What redaction needs to know about where servers live. */
export interface RedactContext {
  computer: ReadonlyMap<string, McpDefinition>;
  project: ReadonlyMap<string, McpDefinition>;
}

/** The context for a project's stores, read now (trusted files only). */
export function redactContextFor(projectRoot: string | null, home: string = homedir()): RedactContext {
  const toMap = (body: ReturnType<typeof readScope>) => new Map(Object.entries(body?.mcpServers ?? {}));
  return {
    computer: toMap(readScope('computer', null, home)),
    project: projectRoot ? toMap(readScope('project', projectRoot, home)) : new Map(),
  };
}

function homeOf(name: string, scope: string, source: string, ctx: RedactContext): McpHome {
  if (source === 'claudeai' || scope === 'claudeai') return 'claudeai';
  if (scope === 'project' || source === 'project') return 'team';
  if (scope === 'plugin' || source === 'plugin') return 'plugin';
  if (scope === 'dynamic' || source === 'dynamic') {
    if (ctx.project.has(name)) return 'project';
    if (ctx.computer.has(name)) return 'computer';
    return 'app';
  }
  return 'outside';
}

/** The definition a live server row came from, when it is one of ours. */
export function definitionFor(name: string, home: McpHome, ctx: RedactContext): McpDefinition | null {
  if (home === 'project') return ctx.project.get(name) ?? null;
  if (home === 'computer') return ctx.computer.get(name) ?? null;
  return null;
}

/**
 * The status reply, whitelisted and scrubbed. `config`, `tools[]`, `serverInfo` and `error`
 * never leave; `errorKind` is derived here.
 */
export function redactStatus(raw: unknown, ctx: RedactContext): McpLiveServer[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw)?.mcpServers;
  if (!Array.isArray(list)) return [];
  const out: McpLiveServer[] = [];
  for (const item of list) {
    const r = asRecord(item);
    if (!r || typeof r.name !== 'string' || !r.name) continue;
    const scope = typeof r.scope === 'string' ? r.scope : '';
    const source = typeof r.source === 'string' ? r.source : '';
    const home = homeOf(r.name, scope, source, ctx);
    const config = asRecord(r.config);
    const secrets = [...new Set([...secretLiterals(config), ...secretLiterals(definitionFor(r.name, home, ctx))])].sort((a, b) => b.length - a.length);
    const status = STATUS_MAP[typeof r.status === 'string' ? r.status : ''] ?? 'unknown';
    const transport = typeof r.transport === 'string' ? r.transport : (typeof config?.type === 'string' ? config.type : '');
    const urlHost = urlHostOf(config?.url) ?? (typeof r.urlHost === 'string' ? urlHostOf(`https://${r.urlHost}`) : undefined);
    const row: McpLiveServer = {
      name: scrub(r.name, secrets).slice(0, 200),
      status,
      home,
      transport: scrub(transport, secrets).slice(0, 20),
    };
    if (urlHost) row.urlHost = scrub(urlHost, secrets);
    if (Array.isArray(r.tools)) row.toolCount = r.tools.length;
    const kind = errorKindOf(status, r.error);
    if (kind) row.errorKind = kind;
    out.push(row);
  }
  return out;
}

/** An auth URL the window may open: https only. Returns its host, or null. */
export function isSafeAuthUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host ? u.host : null;
  } catch { return null; }
}

// ─── Status cache: ~/.dreamcontext/mcp-status.json ────────────────────────────

export interface CachedCell { status: McpLiveStatus; errorKind?: McpErrorKind; at: number }
export type StatusCache = Record<string, { at: number; cells: Record<string, CachedCell> }>;

export function statusCachePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'mcp-status.json');
}

/** The cache key of one server: `name|defHash` for a stored definition, `name|<home>` else. */
export function serverKey(name: string, def: McpDefinition | null, home: McpHome): string {
  return `${name}|${def ? defHash(def) : home}`;
}

export function readStatusCache(home: string = homedir()): StatusCache {
  try {
    const parsed = asRecord(JSON.parse(readFileSync(statusCachePath(home), 'utf-8')));
    const out = Object.create(null) as StatusCache;
    for (const id of Object.keys(parsed ?? {})) {
      const acc = asRecord(parsed?.[id]);
      const cells = asRecord(acc?.cells);
      if (!acc || !cells || typeof acc.at !== 'number') continue;
      out[id] = { at: acc.at, cells: Object.assign(Object.create(null), cells) as Record<string, CachedCell> };
    }
    return out;
  } catch { return Object.create(null) as StatusCache; }
}

/** Record one account's reading. 0600, atomic, O_EXCL temp. Never a value: status words only. */
export function writeStatusCache(accountId: string, servers: McpLiveServer[], ctx: RedactContext, home: string = homedir(), now: number = Date.now()): void {
  const cache = readStatusCache(home);
  const cells: Record<string, CachedCell> = Object.create(null) as Record<string, CachedCell>;
  for (const s of servers) {
    const key = serverKey(s.name, definitionFor(s.name, s.home, ctx), s.home);
    cells[key] = { status: s.status, ...(s.errorKind ? { errorKind: s.errorKind } : {}), at: now };
  }
  cache[accountId || 'default'] = { at: now, cells };
  const path = statusCachePath(home);
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(cache)}\n`); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch { try { rmSync(tmp, { force: true }); } catch { /* gone */ } }
}

// ─── Transient children: Settings' probe and connect ─────────────────────────

export type SpawnFn = (cmd: string, args: string[], opts: Parameters<typeof nodeSpawn>[2]) => ChildProcess;

export interface LiveChildOptions {
  /** `--mcp-config` files, computer then project. */
  files: string[];
  cwd: string;
  /** The account's env (`accountEnvFor`). */
  env: Record<string, string | undefined>;
  spawnImpl?: SpawnFn;
}

/** The argv of a probe/connect child: the same stores every spawn carries, nothing else. */
export function liveChildArgs(files: string[]): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...(files.length ? ['--mcp-config', ...files] : []),
  ];
}

/** A live stream-json child whose only readable output is its control replies. */
export interface LiveChild {
  control: McpControl;
  kill: () => void;
  exited: Promise<void>;
}

export function startLiveChild(o: LiveChildOptions): LiveChild | null {
  const spawnFn = o.spawnImpl ?? (nodeSpawn as unknown as SpawnFn);
  const bin = findClaudeBin();
  const args = liveChildArgs(o.files);
  let child: ChildProcess;
  try {
    child = bin
      ? spawnFn(bin, args, { cwd: o.cwd, env: { ...process.env, PATH: claudeAwarePath(), ...o.env, DREAMCONTEXT_MCP_PROBE: '1' }, stdio: ['pipe', 'pipe', 'ignore'], detached: true })
      : spawnFn(process.env.SHELL || '/bin/zsh', ['-ilc', 'exec claude "$@"', 'claude', ...args], { cwd: o.cwd, env: { ...process.env, PATH: claudeAwarePath(), ...o.env, DREAMCONTEXT_MCP_PROBE: '1' }, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  } catch { return null; }
  child.on('error', () => { /* reported through `exited` */ });
  if (child.pid == null || !child.stdin || !child.stdout) return null;
  const stdin = child.stdin;
  stdin.on('error', () => { /* the child went away */ });
  const control = new McpControl((frame) => {
    if (stdin.destroyed || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  });
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    if (buf.length > 4_000_000) buf = buf.slice(-1_000_000);
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let obj: Record<string, unknown> | null = null;
      try { obj = asRecord(JSON.parse(line)); } catch { obj = null; }
      // Everything but our control replies is discarded unread.
      if (obj && obj.type === 'control_response') control.handle(obj);
    }
  });
  const exited = new Promise<void>((resolve) => { child.on('exit', () => { control.close(); resolve(); }); });
  const kill = () => {
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  };
  return { control, kill, exited };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask until nothing is `pending`, or the deadline passes. */
export async function pollUntilSettled(
  control: McpControl, ctx: RedactContext, o: { deadlineMs?: number; everyMs?: number } = {},
): Promise<McpLiveServer[] | null> {
  const deadline = Date.now() + (o.deadlineMs ?? 20_000);
  let last: McpLiveServer[] | null = null;
  for (;;) {
    try { last = redactStatus(await control.status(), ctx); } catch { /* not yet answering */ }
    if (last && !last.some((s) => s.status === 'pending')) return last;
    if (Date.now() >= deadline) return last;
    await sleep(o.everyMs ?? 2000);
  }
}

let probesRunning = 0;
const PROBE_LIMIT = 2;

/**
 * Settings' "Check": one transient child for one account, polled until nothing is pending (or
 * 20 s), written to the status cache, killed. At most two at once.
 */
export async function probeAccount(o: LiveChildOptions & { accountId: string; projectRoot: string; home?: string }): Promise<McpLiveServer[] | null> {
  while (probesRunning >= PROBE_LIMIT) await sleep(250);
  probesRunning += 1;
  const child = startLiveChild(o);
  try {
    if (!child) return null;
    const ctx = redactContextFor(o.projectRoot, o.home);
    const servers = await pollUntilSettled(child.control, ctx);
    if (servers) {
      try { writeStatusCache(o.accountId, servers, ctx, o.home); } catch { /* a reading not kept is still shown */ }
    }
    return servers;
  } finally {
    child?.kill();
    probesRunning -= 1;
  }
}

// One machine-wide connect at a time: a browser sign-in is one human doing one thing.
export interface ConnectTicket {
  id: string;
  accountId: string;
  name: string;
  state: 'opening' | 'waiting' | 'connected' | 'timeout' | 'failed';
  url?: string;
  host?: string;
  startedAt: number;
}

let activeTicket: (ConnectTicket & { stop: () => void }) | null = null;

export function connectStatus(id: string): ConnectTicket | null {
  if (!activeTicket || activeTicket.id !== id) return null;
  const { stop: _stop, ...t } = activeTicket;
  return t;
}

export function cancelConnect(id: string): boolean {
  if (!activeTicket || activeTicket.id !== id) return false;
  activeTicket.stop();
  return true;
}

/**
 * Start a sign-in for one server on one account: a transient child kept alive while the owner
 * finishes in the browser (≤ 5 min), `mcp_authenticate` → the https auth URL, then the status
 * polled every 3 s. On `connected` the reading goes to the cache. Null = another one is running.
 */
export function startConnect(o: LiveChildOptions & {
  accountId: string; name: string; projectRoot: string; home?: string; windowMs?: number; everyMs?: number;
}): ConnectTicket | 'busy' | null {
  if (activeTicket && (activeTicket.state === 'opening' || activeTicket.state === 'waiting')) return 'busy';
  const child = startLiveChild(o);
  if (!child) return null;
  const ticket: ConnectTicket & { stop: () => void } = {
    id: randomUUID(), accountId: o.accountId, name: o.name, state: 'opening', startedAt: Date.now(),
    stop: () => { stopped = true; child.kill(); if (ticket.state === 'opening' || ticket.state === 'waiting') ticket.state = 'failed'; },
  };
  let stopped = false;
  activeTicket = ticket;
  const ctx = redactContextFor(o.projectRoot, o.home);
  void (async () => {
    try {
      const r = await child.control.request('mcp_authenticate', { serverName: o.name });
      const host = isSafeAuthUrl(r.authUrl);
      if (host) { ticket.url = String(r.authUrl); ticket.host = host; }
      ticket.state = 'waiting';
      const deadline = Date.now() + (o.windowMs ?? 5 * 60_000);
      let reconnected = false;
      while (!stopped) {
        await sleep(o.everyMs ?? 3000);
        if (stopped) break;
        let servers: McpLiveServer[] = [];
        try { servers = redactStatus(await child.control.status(), ctx); } catch { continue; }
        const row = servers.find((s) => s.name === o.name);
        if (row?.status === 'connected') {
          ticket.state = 'connected';
          try { writeStatusCache(o.accountId, servers, ctx, o.home); } catch { /* shown anyway */ }
          break;
        }
        if (Date.now() >= deadline) {
          if (!reconnected) {
            reconnected = true;
            try { await child.control.request('mcp_reconnect', { serverName: o.name }); } catch { /* reported as timeout */ }
            continue;
          }
          ticket.state = 'timeout';
          break;
        }
      }
    } catch {
      if (ticket.state === 'opening') ticket.state = 'failed';
    } finally {
      child.kill();
    }
  })();
  const { stop: _stop, ...t } = ticket;
  return t;
}

/** Tests only. */
export function resetMcpLiveForTests(): void {
  activeTicket = null;
  probesRunning = 0;
}
