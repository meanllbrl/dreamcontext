/**
 * The owner's tool servers on Antigravity. Measured on agent 1.4.1:
 *  - they ride `session/new`; the agent connects them when the first turn starts, not before;
 *  - ONE server that will not start, or answers Unauthorized, refuses every turn of that session at
 *    0 tokens ("The MCP server 'x' failed to initialize"), and only a new session gets past it. So
 *    a server goes in only after it answered us the handshake the agent makes (`server/discover`,
 *    then `initialize` when discover is refused): `initialize` alone let a server through that dies
 *    on discover, and the agent then took minutes to refuse the turn (3 Nov 2026);
 *  - there is no sign-in for a server over ACP, so a server that wants one cannot reach this agent;
 *  - the session writes `brain/<thread>/mcp/<server>/<tool>.json` for each server it connected:
 *    that folder is the live report, and it is read by name and count only.
 *
 * Nothing from a definition crosses this file: a server starts through our own child, and what comes
 * back is a name, a status and a count.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { antigravityProfileDir } from './antigravity-accounts.js';
import type { McpLiveStatus } from './mcp-wire.js';
import type { AcpMcpServer } from './t3-bridge/launch.js';

/** How long one server gets to answer: the same patience a chat's start can afford, in parallel. */
export const MCP_CHECK_LIMIT_MS = 8_000;

export type ServerCheck = 'connected' | 'needs-auth' | 'failed';

/**
 * The handshake the agent makes, measured on agent 1.4.1 (3 Nov 2026): `server/discover` first; on a
 * JSON-RPC error it falls back to `initialize`. A server that answers `initialize` but dies on
 * `server/discover` (an older Python FastMCP) refuses the whole chat, so the check asks both, in order.
 */
const DISCOVER = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'dreamcontext', version: '0' }, 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } };
const INITIALIZE = { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dreamcontext', version: '0' } } };

function checkStdio(server: Extract<AcpMcpServer, { command: string }>, env: NodeJS.ProcessEnv, ms: number): Promise<ServerCheck> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(server.command, server.args, { env: { ...env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (v: ServerCheck): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Gently first: the wrapper hands the signal on, and a SIGKILL would orphan the real server.
      try { child.stdin.end(); child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1_500).unref();
      resolve(v);
    };
    const timer = setTimeout(() => finish('failed'), ms);
    child.on('error', () => finish('failed'));
    child.on('exit', () => finish('failed'));
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf-8');
      const lines = out.split('\n');
      out = lines.pop() ?? '';
      for (const line of lines) {
        let m: { id?: unknown; result?: unknown; error?: unknown };
        try { m = JSON.parse(line) as typeof m; } catch { continue; }
        // The agent's own fallback: a server that refuses `server/discover` is asked to `initialize`.
        if (m.id === DISCOVER.id) {
          if (m.result) finish('connected');
          else if (m.error) child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
          else finish('failed');
        }
        if (m.id === INITIALIZE.id) finish(m.result ? 'connected' : 'failed');
      }
    });
    child.stdin.write(`${JSON.stringify(DISCOVER)}\n`);
  });
}

async function checkHttp(server: Extract<AcpMcpServer, { url: string }>, ms: number): Promise<ServerCheck> {
  // The agent's order: `server/discover`, then `initialize` when that one is not understood.
  const deadline = Date.now() + ms;
  const discovered = await postHttp(server, DISCOVER, ms);
  if (discovered !== 'no-result') return discovered;
  const left = deadline - Date.now();
  if (left <= 0) return 'failed';
  const initialized = await postHttp(server, INITIALIZE, left);
  return initialized === 'no-result' ? 'failed' : initialized;
}

/** One POST: a JSON-RPC result, a sign-in, or neither. */
async function postHttp(server: Extract<AcpMcpServer, { url: string }>, body: object, ms: number): Promise<ServerCheck | 'no-result'> {
  try {
    const r = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    if (r.status === 401 || r.status === 403) { await r.body?.cancel().catch(() => undefined); return 'needs-auth'; }
    if (!r.ok || !r.body) { await r.body?.cancel().catch(() => undefined); return 'no-result'; }
    // A login page answers 200 too: only a JSON-RPC result is a server, or it refuses the whole chat.
    const reader = r.body.getReader();
    let text = '';
    while (text.length < 65_536) {
      const { done, value } = await reader.read();
      if (value) text += Buffer.from(value).toString('utf-8');
      if (/"result"\s*:/.test(text)) { await reader.cancel().catch(() => undefined); return 'connected'; }
      if (done) break;
    }
    await reader.cancel().catch(() => undefined);
    return 'no-result';
  } catch {
    return 'failed';
  }
}

/** Will this server start for the agent? Every one in parallel, each bounded. */
export async function checkAcpServers(servers: readonly AcpMcpServer[], o: { env: NodeJS.ProcessEnv; limitMs?: number }): Promise<Map<string, ServerCheck>> {
  const ms = o.limitMs ?? MCP_CHECK_LIMIT_MS;
  const rows = await Promise.all(servers.map(async (s) => [s.name, await ('url' in s ? checkHttp(s, ms) : checkStdio(s, o.env, ms))] as const));
  return new Map(rows);
}

const brainDir = (thread: string, accountId: string, home: string): string =>
  join(antigravityProfileDir(accountId, home), 'antigravity-acp', 'brain', thread);

const PLAIN = /^[A-Za-z0-9_-]{1,64}$/;

/** What the session connected, from its own folder: each server and how many tools. */
export function sessionServers(thread: string, accountId: string, home: string = homedir()): Map<string, number> {
  const out = new Map<string, number>();
  if (!PLAIN.test(thread)) return out;
  const dir = join(brainDir(thread, accountId, home), 'mcp');
  try {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (lstatSync(at).isDirectory()) out.set(name, readdirSync(at).filter((f) => f.endsWith('.json')).length);
    }
  } catch { /* nothing connected yet */ }
  return out;
}

/** A probe leaves nothing in the account's history. */
export function forgetProbe(thread: string, accountId: string, home: string = homedir()): void {
  if (!PLAIN.test(thread)) return;
  const dir = join(antigravityProfileDir(accountId, home), 'antigravity-acp');
  rmSync(brainDir(thread, accountId, home), { recursive: true, force: true });
  const conversations = join(dir, 'conversations');
  if (!existsSync(conversations)) return;
  for (const f of readdirSync(conversations)) if (f.startsWith(`${thread}.`)) rmSync(join(conversations, f), { force: true });
}

const FAILED_START = /The MCP server '([^']{1,200})' failed to initialize/;

/** The agent refused the turn over one server: its name, or null. */
export function refusedServer(text: string): { name: string; unauthorized: boolean } | null {
  const m = FAILED_START.exec(text);
  return m ? { name: m[1]!, unauthorized: /unauthori[sz]ed|forbidden/i.test(text) } : null;
}

export interface ProbeRow { name: string; status: McpLiveStatus; toolCount?: number }
export interface ProbeReport { state: 'ok' | 'signed_out' | 'failed'; servers: ProbeRow[] }
