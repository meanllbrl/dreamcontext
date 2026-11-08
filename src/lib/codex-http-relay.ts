import { lstatSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * One HTTP MCP server, as a stdio one, for Codex (`dreamcontext mcp http-relay <file> <name>`).
 *
 * Codex takes an HTTP server's headers from a `-c` value (seen in `ps`) or from env vars of its
 * own process, and that env reaches its hooks. So a server with a key never gets a URL at all:
 * Codex starts this relay, which reads the address and headers from the 0600 store and speaks
 * to the server. The key is in this one process's memory and nowhere else.
 *
 * Client to server only: a tool server's replies arrive on the POST that asked. Only JSON-RPC
 * objects reach stdout: a server's error page does not, and a refusal is its status code. Every
 * request is answered, by the server or here, so a call never hangs on a stream that ended.
 */

interface RelayTarget { url: string; headers: Record<string, string> }

export function relayTarget(file: string, name: string): RelayTarget | null {
  try {
    if (!lstatSync(file).isFile()) return null;
    const servers = (JSON.parse(readFileSync(file, 'utf-8')) as { mcpServers?: Record<string, { url?: unknown; headers?: unknown }> }).mcpServers ?? {};
    if (!Object.prototype.hasOwnProperty.call(servers, name)) return null;
    const s = servers[name]!;
    if (typeof s.url !== 'string') return null;
    const raw = s.headers && typeof s.headers === 'object' ? Object.entries(s.headers as Record<string, unknown>) : [];
    return { url: s.url, headers: Object.fromEntries(raw.filter((e): e is [string, string] => typeof e[1] === 'string')) };
  } catch {
    return null;
  }
}

/** The complete events at the head of an SSE buffer: their JSON, and what is left unread. */
export function takeSseEvents(buffer: string): { messages: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  const messages: string[] = [];
  for (const event of parts) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (data) messages.push(data.replace(/\n/g, ' '));
  }
  return { messages, rest };
}

/** A JSON-RPC object on one line, or null: anything else (a gateway's error page) never goes out. */
function rpcObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const m = v as Record<string, unknown>;
    if (typeof m.method === 'string' || (m.id !== undefined && m.id !== null && ('result' in m || 'error' in m))) return m;
  } catch { /* not JSON */ }
  return null;
}

const NOTIFICATION_HOLD_MS = 5_000;

function holdFor(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
}

export interface RelayIo {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/** Runs until stdin closes and every answer is out. */
export async function runRelay(target: RelayTarget, io: RelayIo): Promise<void> {
  const doFetch = io.fetchImpl ?? fetch;
  let session = '';

  const send = async (line: string, requestId: unknown): Promise<void> => {
    const asked = requestId !== undefined;
    let answered = false;
    /** One message from the server: passed on as it comes, and marks its request answered. */
    const pass = (text: string): void => {
      const m = rpcObject(text);
      if (!m) return;
      io.write(`${JSON.stringify(m)}\n`);
      if (asked && m.id === requestId && !('method' in m)) answered = true;
    };
    const fail = (message: string): void => {
      if (asked && !answered) io.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message } })}\n`);
    };
    try {
      // `error`: a custom header survives a cross-origin redirect, and the key would go with it.
      const res = await doFetch(target.url, {
        method: 'POST',
        redirect: 'error',
        headers: { ...target.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
        body: line,
      });
      const next = res.headers.get('mcp-session-id');
      if (next) session = next;
      if (!asked) { await res.body?.cancel().catch(() => {}); return; }
      if (!res.ok) { fail(`The server answered ${res.status}.`); return; }
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body) {
        // Read as it arrives: a tool can ask something mid-call and wait for the answer.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!answered) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { messages, rest } = takeSseEvents(buffer);
          buffer = rest;
          for (const m of messages) pass(m);
        }
        await reader.cancel().catch(() => {});
      } else {
        pass((await res.text()).replace(/\n/g, ' '));
      }
      fail('The server gave no answer.');
    } catch {
      fail('The server could not be reached.');
    }
  };

  const running = new Set<Promise<void>>();
  for await (const line of createInterface({ input: io.input })) {
    if (!line.trim()) continue;
    const msg = rpcObject(line);
    if (!msg) continue;
    // A reply of Codex's own (an answer to the server) carries an id and expects nothing back.
    const isRequest = typeof msg.method === 'string' && msg.id !== undefined;
    const p = send(line, isRequest ? msg.id : undefined);
    // `initialize` goes alone: what follows needs its session.
    if (msg.method === 'initialize') { await p; continue; }
    if (isRequest) {
      running.add(p);
      void p.finally(() => running.delete(p));
    } else if (msg.id === undefined) {
      // A notification keeps its place, but a server that sits on one must not stop the relay:
      // a cancel is sent exactly when a server is stuck.
      await holdFor(p, NOTIFICATION_HOLD_MS);
    }
  }
  await Promise.all(running);
}

/** The relay on this process's stdio: its exit code. */
export async function startHttpRelay(file: string, name: string): Promise<number> {
  const target = relayTarget(file, name);
  if (!target) { process.stderr.write(`mcp http-relay: no server ${name} in that file\n`); return 2; }
  await runRelay(target, { input: process.stdin, write: (l) => { process.stdout.write(l); } });
  return 0;
}
