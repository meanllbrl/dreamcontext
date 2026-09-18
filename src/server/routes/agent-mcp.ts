import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isLoopback } from './agent-spawn-shared.js';
import { ClaudeAccountError, resolveConfigDir } from '../../lib/claude-accounts.js';
import { ensureSandbox } from '../../lib/claude-account-sandbox.js';
import {
  envForOrigin, listMcpForSession, loginMcpServer, logoutMcpServer, probeMcpServer,
  sharedMcpServerNames, type McpOrigin, type McpServerRow,
} from '../../lib/claude-mcp.js';

/**
 * `/mcp`, as a surface the Chat window can actually operate.
 *
 * Three legs over `src/lib/claude-mcp.ts`: list the servers for the account a session runs
 * on, authenticate with one, sign out of one. Desktop + loopback only, like every other
 * route that can spawn the user's `claude`.
 *
 * ── Nothing secret crosses this boundary ─────────────────────────────────────────────────
 * A login's child output is discarded at the spawn (an OAuth callback URL carries an
 * authorization code), so there is no buffer here to leak into a response or a log. What the
 * client receives is a name, a target, and a state — never a token, never a URL the CLI was
 * handed, never the child's stdout. The browser does the sign-in; this process only starts it
 * and then ASKS the CLI what the result was.
 *
 * ── Why the exit code is not the verdict ─────────────────────────────────────────────────
 * Same reason `claude auth login` is judged by `claude auth status` and not by `$?`: a login
 * can exit 0 having been abandoned in the browser. After the child ends, the server re-probes
 * THAT server with `claude mcp get` and reports what the probe says. A panel that claimed
 * "Connected" on an exit code would be lying to the user about which tools they now have.
 */

function guard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isDesktop() || !isLoopback(req)) {
    sendError(res, 403, 'forbidden', 'MCP servers are managed from the desktop app only.');
    return false;
  }
  return true;
}

/**
 * Resolve the request's account to a config directory the CLI may be pointed at.
 *
 * Goes through the SAME gate the chat spawn uses — it validates the id's shape, refuses an
 * unregistered id, and confines the path to the real HOME or a sandbox under
 * `~/.dreamcontext/claude-accounts/`. `ensureSandbox` then returns immediately for account #0
 * and otherwise repairs the sandbox, so `claude mcp login` writes its credential where that
 * account's sessions will actually read it.
 */
function configDirFor(account: string): { dir: string } | { error: string } {
  try {
    const dir = resolveConfigDir(account || null);
    ensureSandbox(dir);
    return { dir };
  } catch (err) {
    return { error: err instanceof ClaudeAccountError ? err.message : (err as Error).message };
  }
}

/**
 * Which config directory a leg for this row must run against.
 *
 * A `shared` row is one the session only has by reference (`--mcp-config`), configured in the
 * real home — so its sign-in belongs there, not in the sandbox. The claim is CHECKED rather
 * than trusted: a name the shared file does not contain is not a shared server, whatever the
 * client said, and falls back to the account's own directory.
 */
function envForRow(origin: McpOrigin, name: string, dir: string): Record<string, string | undefined> {
  const shared = origin === 'shared' && sharedMcpServerNames().includes(name);
  return envForOrigin(shared ? 'shared' : 'account', dir);
}

/** `origin` off the wire, defaulting to the account — an absent field is not a shared claim. */
function readOrigin(value: unknown): McpOrigin {
  return value === 'shared' ? 'shared' : 'account';
}

/** Control characters, by code point — a name carrying one is not a name. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Is this a name we may hand to the CLI as an argument?
 *
 * Server names are free-form and genuinely contain spaces, dots and colons (`claude.ai
 * Google Calendar`, `plugin:stripe:stripe`), so this cannot be a slug test. Arguments are
 * passed positionally to the process — never through a shell — so the one thing that must be
 * refused is a name the CLI would read as an OPTION, plus the control characters and the
 * absurd lengths that mean the caller is not sending a name at all.
 */
function isUsableServerName(name: string): boolean {
  return !!name && name.length <= 200 && !name.startsWith('-') && !CONTROL_CHARS.test(name);
}

/** The server list, exactly as the panel draws it. */
function wire(servers: McpServerRow[]): {
  servers: McpServerRow[];
  counts: { total: number; connected: number; needsAuth: number; other: number };
} {
  const connected = servers.filter((s) => s.state === 'connected').length;
  const needsAuth = servers.filter((s) => s.state === 'needs-auth').length;
  return {
    servers,
    counts: {
      total: servers.length,
      connected,
      needsAuth,
      other: servers.length - connected - needsAuth,
    },
  };
}

/**
 * GET /api/agent/mcp?account=<id> — every configured server, health-checked.
 *
 * Deliberately NOT cached: the whole point of opening this panel is to find out what is live
 * right now, and the answer changes the moment the user finishes an OAuth in the browser. It
 * is one command (the CLI does the fan-out), and it only runs when someone opens the panel.
 */
export async function handleAgentMcpList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const account = new URL(req.url ?? '', 'http://localhost').searchParams.get('account') ?? '';
  const resolved = configDirFor(account);
  if ('error' in resolved) {
    sendError(res, 422, 'bad_account', resolved.error);
    return;
  }
  // The SESSION's set, not the config directory's — see `listMcpForSession`. A sandboxed
  // session's local servers arrive by reference and would otherwise be missing entirely.
  const result = await listMcpForSession(resolved.dir);
  if (!result.ok) {
    if (result.reason === 'timeout') {
      sendError(res, 504, 'list_timeout', 'The server health check took too long. Try again.');
      return;
    }
    sendError(res, 500, 'spawn_failed', 'Could not run the Claude CLI to read your MCP servers.');
    return;
  }
  sendJson(res, 200, wire(result.servers));
}

/**
 * POST /api/agent/mcp/login — `{ name, account }`. Runs the CLI's OAuth for ONE server.
 *
 * The response is the re-probed state of that server, so the panel updates the row it just
 * acted on without re-checking the other twenty-three.
 */
export async function handleAgentMcpLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const account = typeof body?.account === 'string' ? body.account : '';
  if (!isUsableServerName(name)) {
    sendError(res, 422, 'bad_server_name', 'That is not a usable MCP server name.');
    return;
  }
  const resolved = configDirFor(account);
  if ('error' in resolved) {
    sendError(res, 422, 'bad_account', resolved.error);
    return;
  }
  const env = envForRow(readOrigin(body?.origin), name, resolved.dir);

  const run = await loginMcpServer(name, env);
  if (!run.ran) {
    sendError(res, 500, 'spawn_failed', 'Could not start the sign-in — the Claude CLI did not launch.');
    return;
  }
  if (run.timedOut) {
    sendError(res, 504, 'login_timeout', 'The sign-in timed out. Nothing was saved; you can try again.');
    return;
  }

  // The verdict comes from the CLI, not from the exit code. A probe that cannot be read
  // reports itself as unknown rather than inventing a success.
  const probed = await probeMcpServer(name, env);
  sendJson(res, 200, { name, state: probed?.state ?? 'unknown', label: probed?.label ?? '' });
}

/** POST /api/agent/mcp/logout — `{ name, account }`. Clears one server's stored credential. */
export async function handleAgentMcpLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const account = typeof body?.account === 'string' ? body.account : '';
  if (!isUsableServerName(name)) {
    sendError(res, 422, 'bad_server_name', 'That is not a usable MCP server name.');
    return;
  }
  const resolved = configDirFor(account);
  if ('error' in resolved) {
    sendError(res, 422, 'bad_account', resolved.error);
    return;
  }
  const env = envForRow(readOrigin(body?.origin), name, resolved.dir);

  const run = await logoutMcpServer(name, env);
  if (!run.ran) {
    sendError(res, 500, 'spawn_failed', 'Could not run the Claude CLI to sign out.');
    return;
  }
  const probed = await probeMcpServer(name, env);
  sendJson(res, 200, { name, state: probed?.state ?? 'unknown', label: probed?.label ?? '' });
}
