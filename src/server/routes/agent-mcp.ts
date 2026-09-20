import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isLoopback, projectRootOf } from './agent-spawn-shared.js';
import { ClaudeAccountError, resolveConfigDir } from '../../lib/claude-accounts.js';
import { ensureSandbox } from '../../lib/claude-account-sandbox.js';
import {
  canSignIn, loginMcpServer, logoutMcpServer, probeMcpServer, readSessionMcpServers,
  type McpServerRow,
} from '../../lib/claude-mcp.js';

/**
 * `/mcp`, as a surface the Chat window can actually operate.
 *
 * Three legs over `src/lib/claude-mcp.ts`: read the servers THIS SESSION has, sign into one,
 * sign out of one. Desktop + loopback only, like every other route that can spawn `claude`.
 *
 * ── Project-scoped, not vault-agnostic ───────────────────────────────────────────────────
 * This route started out vault-agnostic on the reasoning that MCP configuration belongs to
 * the Claude install. That was wrong: a server can be PROJECT-scoped (the repo's `.mcp.json`,
 * which is how a team shares servers — a colleague who has never opened the repo gets them
 * connected on first run, measured), and project scope resolves from the working directory.
 * Probing from the home directory made every team-shared server invisible. So every leg runs
 * in the project, and the route takes a context root like any other vault-scoped route.
 *
 * ── Nothing secret crosses this boundary ─────────────────────────────────────────────────
 * A login's child output is discarded at the spawn (an OAuth callback URL carries an
 * authorization code), so there is no buffer here to leak into a response or a log. What the
 * client receives is a name, a status and a source — never a token, never a URL the CLI was
 * handed, never the child's stdout.
 *
 * ── Why the exit code is not the verdict ─────────────────────────────────────────────────
 * A login can exit 0 having been abandoned in the browser. After the child ends, the server
 * RE-READS the session and reports what it says. A panel that claimed "Connected" on an exit
 * code would be lying to the user about which tools they now have.
 */

function guard(req: IncomingMessage, res: ServerResponse, contextRoot: string | null): boolean {
  if (!isDesktop() || !isLoopback(req)) {
    sendError(res, 403, 'forbidden', 'MCP servers are managed from the desktop app only.');
    return false;
  }
  if (!contextRoot) {
    sendError(res, 400, 'no_vault', 'This request needs a project.');
    return false;
  }
  return true;
}

/**
 * Resolve the request's account to a config directory the CLI may be pointed at.
 *
 * The SAME gate the chat spawn uses: it validates the id's shape, refuses an unregistered id,
 * and confines the path to the real HOME or a sandbox under `~/.dreamcontext/claude-accounts/`.
 * `ensureSandbox` then returns immediately for account #0 and otherwise repairs the sandbox,
 * so a sign-in writes its credential where that account's sessions will actually read it.
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

/** Control characters, by code point — a name carrying one is not a name. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Is this a name we may hand to the CLI as an argument?
 *
 * Server names are free-form and genuinely contain spaces, dots and colons (`claude.ai Google
 * Calendar`, `plugin:stripe:stripe`), so this cannot be a slug test. Arguments are passed
 * positionally to the process — never through a shell — so the one thing that must be refused
 * is a name the CLI would read as an OPTION, plus control characters and absurd lengths.
 */
function isUsableServerName(name: string): boolean {
  return !!name && name.length <= 200 && !name.startsWith('-') && !CONTROL_CHARS.test(name);
}

/** One row on the wire: the session's view, plus whether a button can do anything about it. */
interface McpWireRow extends McpServerRow {
  /** False for a server this account cannot sign into — a `dynamic` one, chiefly. */
  signInAvailable: boolean;
}

function wire(servers: McpServerRow[]): {
  servers: McpWireRow[];
  counts: { total: number; connected: number; needsAuth: number; other: number };
} {
  const rows: McpWireRow[] = servers.map((s) => ({ ...s, signInAvailable: canSignIn(s) }));
  const connected = rows.filter((s) => s.status === 'connected').length;
  const needsAuth = rows.filter((s) => s.status === 'needs-auth').length;
  return {
    servers: rows,
    counts: { total: rows.length, connected, needsAuth, other: rows.length - connected - needsAuth },
  };
}

/**
 * GET /api/agent/mcp?account=<id> — every server this session has, as the engine reports them.
 *
 * Deliberately NOT cached: the point of opening this panel is to find out what is live right
 * now, and the answer changes the moment the user finishes an OAuth in the browser. The probe
 * is a local command — no turn, no tokens — so the honest reading is also the cheap one.
 */
export async function handleAgentMcpList(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const account = new URL(req.url ?? '', 'http://localhost').searchParams.get('account') ?? '';
  const resolved = configDirFor(account);
  if ('error' in resolved) {
    sendError(res, 422, 'bad_account', resolved.error);
    return;
  }
  const result = await readSessionMcpServers(projectRootOf(contextRoot as string), resolved.dir);
  if (!result.ok) {
    if (result.reason === 'timeout') {
      sendError(res, 504, 'list_timeout', 'Reading the session took too long. Try again.');
      return;
    }
    if (result.reason === 'unreadable') {
      // A spawn that ran but produced no init frame we could read. Reported as its own case
      // rather than as an empty list: "we could not tell" and "you have none" are different
      // facts, and drawing the second for the first would be a confident lie.
      sendError(res, 502, 'unreadable', 'The Claude CLI did not report its MCP servers.');
      return;
    }
    sendError(res, 500, 'spawn_failed', 'Could not run the Claude CLI to read your MCP servers.');
    return;
  }
  sendJson(res, 200, wire(result.servers));
}

/** Shared body reading for the two action legs. */
async function readAction(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ name: string; account: string } | null> {
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const account = typeof body?.account === 'string' ? body.account : '';
  if (!isUsableServerName(name)) {
    sendError(res, 422, 'bad_server_name', 'That is not a usable MCP server name.');
    return null;
  }
  return { name, account };
}

/**
 * POST /api/agent/mcp/login — `{ name, account }`. Runs the CLI's OAuth for ONE server.
 *
 * The response is that server's state re-read FROM THE SESSION, so the panel updates the row
 * it acted on with the truth rather than with an exit code.
 */
export async function handleAgentMcpLogin(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const action = await readAction(req, res);
  if (!action) return;
  const resolved = configDirFor(action.account);
  if ('error' in resolved) {
    sendError(res, 422, 'bad_account', resolved.error);
    return;
  }
  const projectRoot = projectRootOf(contextRoot as string);

  const run = await loginMcpServer(action.name, projectRoot, resolved.dir);
  if (!run.ran) {
    sendError(res, 500, 'spawn_failed', 'Could not start the sign-in — the Claude CLI did not launch.');
    return;
  }
  if (run.timedOut) {
    sendError(res, 504, 'login_timeout', 'The sign-in timed out. Nothing was saved; you can try again.');
    return;
  }

  const probed = await probeMcpServer(action.name, projectRoot, resolved.dir);
  sendJson(res, 200, {
    name: action.name,
    status: probed?.status ?? 'unknown',
    statusLabel: probed?.statusLabel ?? '',
  });
}

/** POST /api/agent/mcp/logout — `{ name, account }`. Clears one server's credential here. */
export async function handleAgentMcpLogout(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const action = await readAction(req, res);
  if (!action) return;
  const resolved = configDirFor(action.account);
  if ('error' in resolved) {
    sendError(res, 422, 'bad_account', resolved.error);
    return;
  }
  const projectRoot = projectRootOf(contextRoot as string);

  const run = await logoutMcpServer(action.name, projectRoot, resolved.dir);
  if (!run.ran) {
    sendError(res, 500, 'spawn_failed', 'Could not run the Claude CLI to sign out.');
    return;
  }
  const probed = await probeMcpServer(action.name, projectRoot, resolved.dir);
  sendJson(res, 200, {
    name: action.name,
    status: probed?.status ?? 'unknown',
    statusLabel: probed?.statusLabel ?? '',
  });
}
