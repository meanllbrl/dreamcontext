import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { executeClaudeDetached } from './automations/runner.js';
import { accountEnvFor, isRealHomeConfigDir } from './claude-accounts.js';
import { ensureSharedMcpConfig } from './claude-account-sandbox.js';

/**
 * The MCP surface, read from the session that actually has it.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────
 * `/mcp` typed into the Chat surface was a dead end: the headless engine answers it with
 * "N MCP server(s): … Use `/mcp` in the terminal for details." (CLI 2.1.276). The user types
 * exactly the right thing and is sent to another application, while unauthenticated servers
 * stay dead with nothing in the window able to say so.
 *
 * ── The source of truth is the SESSION, and nothing else (2026-09-20) ───────────────────
 * The first two cuts of this file asked `claude mcp list`, and both were wrong — the second
 * one silently, which is worse. That command reports the CONFIGURATION of a config directory.
 * The panel needs to answer a different question: which servers does the conversation in this
 * window actually have? Those are not the same question, and on the machine this was built
 * for they disagreed about 26 of 32 servers:
 *
 *   • A sandboxed account's `.claude.json` carries NO MCP keys at all (copying them per
 *     account would multiply every MCP secret), so a sandboxed session reaches the machine's
 *     own servers BY REFERENCE — the spawn adds `--mcp-config <shared file>`. `claude mcp
 *     list` cannot be told about that file: before the subcommand the variadic flag swallows
 *     `mcp list` as filenames, after it the flag is rejected, and with `=` it parses but the
 *     servers still do not appear. All three measured.
 *   • `claude mcp list` reported twelve claude.ai connectors as "✔ Connected" that the session
 *     itself reported as `needs-auth` — because an OAuth credential is stored per config
 *     directory, and the listing was describing the account's configuration rather than this
 *     directory's credentials.
 *
 * So the listing is taken from the session's OWN `system/init` frame, which carries
 * `mcp_servers: [{ name, status, source }]` — the engine's own answer about the engine's own
 * tools. It is produced by running `claude -p "/mcp"`, which the engine handles as a local
 * command: `num_turns: 0`, `total_cost_usd: 0`. The truthful reading is also the free one.
 *
 * ── What `source` buys ──────────────────────────────────────────────────────────────────
 * The frame says where each server came from, which is what decides whether an action is even
 * possible. Measured values: `project` (the repo's `.mcp.json` — shared with the whole team,
 * and connected for an account seeing the repo for the FIRST time, no approval step in a
 * headless run), `claudeai` (the account's connectors), `plugin`, and `dynamic` (handed in by
 * `--mcp-config`). A `dynamic` server cannot be signed into from a sandbox at all —
 * `claude mcp login` does not know it exists there ("No MCP server named …", measured) — so
 * the panel must not offer a button that cannot work.
 *
 * ── The token is never handled ──────────────────────────────────────────────────────────
 * Signing in is `claude mcp login <name>`: the CLI opens the browser, the CLI receives the
 * callback, the CLI writes its own credential into its own directory. This process never
 * sees, stores, displays or asks anyone to paste a token, and the login child's output is
 * DISCARDED rather than buffered, because an interactive OAuth's stdout can carry a callback
 * URL bearing an authorization code (the rule `claude auth login` has followed since the
 * multi-account work).
 */

/** Where the engine says a server came from. Unrecognised values are carried, never guessed. */
export type McpSource = 'project' | 'claudeai' | 'plugin' | 'dynamic' | 'user' | 'unknown';

/** What the engine says about a server's readiness. Same rule: unknown stays unknown. */
export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unknown';

/** One row as the panel draws it — the session's own view of one server. */
export interface McpServerRow {
  name: string;
  status: McpStatus;
  /** The engine's own word for the status, kept verbatim for anything unrecognised. */
  statusLabel: string;
  source: McpSource;
  /** The engine's own word for the source, same reason. */
  sourceLabel: string;
}

/** The probe is a local command: no turn, no tokens. It still boots hooks, so give it room. */
const LIST_TIMEOUT_MS = 120_000;
/** An interactive browser OAuth. Same ceiling `claude auth login` gets. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Logout is local bookkeeping. */
const LOGOUT_TIMEOUT_MS = 30_000;

/** Recognised statuses. Anything else is reported as `unknown` WITH the engine's own word. */
const STATUSES: Record<string, McpStatus> = {
  connected: 'connected',
  'needs-auth': 'needs-auth',
  needs_auth: 'needs-auth',
  failed: 'failed',
  error: 'failed',
  pending: 'pending',
};

/** Recognised sources, same contract. */
const SOURCES: Record<string, McpSource> = {
  project: 'project',
  claudeai: 'claudeai',
  plugin: 'plugin',
  dynamic: 'dynamic',
  user: 'user',
  local: 'user',
};

/**
 * The `mcp_servers` array out of a session's `system/init` frame.
 *
 * Returns `null` — not `[]` — when no init frame was found or it carried no array. The two
 * are different facts: an empty array means "this session has no MCP servers", while a
 * missing frame means "we could not read this session", and a caller that conflated them
 * would tell the user they have nothing when the truth is that we do not know.
 */
export function parseInitMcpServers(stdout: string): McpServerRow[] | null {
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let frame: unknown;
    try { frame = JSON.parse(text); } catch { continue; }
    const obj = frame as { type?: string; subtype?: string; mcp_servers?: unknown };
    if (obj.type !== 'system' || obj.subtype !== 'init') continue;
    if (!Array.isArray(obj.mcp_servers)) return null;
    const rows: McpServerRow[] = [];
    for (const raw of obj.mcp_servers) {
      const entry = raw as { name?: unknown; status?: unknown; source?: unknown };
      if (typeof entry?.name !== 'string' || !entry.name) continue;
      const statusLabel = typeof entry.status === 'string' ? entry.status : '';
      const sourceLabel = typeof entry.source === 'string' ? entry.source : '';
      rows.push({
        name: entry.name,
        status: STATUSES[statusLabel] ?? 'unknown',
        statusLabel,
        source: SOURCES[sourceLabel] ?? 'unknown',
        sourceLabel,
      });
    }
    return rows;
  }
  return null;
}

/**
 * Can this row be signed into from here?
 *
 * Only a server the CLI can NAME in this config directory is a login target. A `dynamic`
 * server is handed to the session by reference and is invisible to `claude mcp login`, so
 * offering the button would be offering a failure. What fixes a `dynamic` server is moving
 * its definition into the project's `.mcp.json`, which is the Settings surface's job.
 */
export function canSignIn(row: McpServerRow): boolean {
  return (row.status === 'needs-auth' || row.status === 'failed') && row.source !== 'dynamic';
}

/** What the CLI leg answered, before any interpretation. `ran` is false when it never started. */
export interface McpRun {
  ran: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
}

/**
 * The environment a leg runs under: the session's OWN account, always.
 *
 * An earlier cut routed a machine-local server's sign-in to the real home, reasoning that its
 * credential belonged where the server was configured. That was built on the wrong model —
 * the credential has to be where the SESSION will look for it, which is this config
 * directory — and it is moot now that `canSignIn` refuses the only rows it applied to.
 */
export function envForSession(
  configDir: string,
  home: string = homedir(),
): Record<string, string | undefined> {
  return accountEnvFor(configDir, home);
}

/**
 * The server names a sandboxed spawn is handed by reference, read from the very file the
 * spawn points at.
 *
 * Read rather than re-derived from `~/.claude.json`: `ensureSharedMcpConfig` is what decides
 * what a sandboxed session receives, so asking it — and then reading its output — is the only
 * way this surface and that spawn cannot drift apart. These are the servers a Settings screen
 * offers to move into the project, because they are the ones no teammate can see.
 */
export function sharedMcpServerNames(home: string = homedir()): string[] {
  const path = ensureSharedMcpConfig(home);
  if (!path) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const servers = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
    return servers ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

/** The `--mcp-config` argument this account's spawns carry, if any. Mirrors `agent-chat.ts`. */
function mcpConfigArgs(configDir: string, home: string): string[] {
  if (isRealHomeConfigDir(configDir, home)) return [];
  const path = ensureSharedMcpConfig(home);
  return path ? ['--mcp-config', path] : [];
}

/**
 * Every MCP server THIS SESSION has, as the engine itself reports them.
 *
 * `projectRoot` is load-bearing and was missing from the first cut: MCP servers can be
 * PROJECT-scoped (the repo's `.mcp.json`), and that scope is resolved from the working
 * directory. Probing from the home directory made every team-shared server invisible — which
 * is exactly the configuration this feature is meant to encourage.
 */
export async function readSessionMcpServers(
  projectRoot: string,
  configDir: string,
  home: string = homedir(),
): Promise<
  { ok: true; servers: McpServerRow[] } | { ok: false; reason: 'spawn_failed' | 'timeout' | 'unreadable' }
> {
  const execution = await executeClaudeDetached([
    '-p', '/mcp',
    '--output-format', 'stream-json',
    '--verbose',
    ...mcpConfigArgs(configDir, home),
  ], {
    cwd: projectRoot,
    env: envForSession(configDir, home),
    timeoutMs: LIST_TIMEOUT_MS,
  });

  if (!execution.spawned) return { ok: false, reason: 'spawn_failed' };
  if (execution.timedOut) return { ok: false, reason: 'timeout' };
  const servers = parseInitMcpServers(execution.stdout);
  if (!servers) return { ok: false, reason: 'unreadable' };
  return { ok: true, servers };
}

/** The one place the action legs spawn. Always in the project, always as this account. */
async function runMcp(
  args: string[],
  projectRoot: string,
  configDir: string,
  timeoutMs: number,
  home: string,
): Promise<McpRun> {
  const execution = await executeClaudeDetached(['mcp', ...args], {
    cwd: projectRoot,
    env: envForSession(configDir, home),
    timeoutMs,
    // An interactive OAuth's stdout can carry a callback URL bearing an authorization code.
    discardOutput: true,
  });
  return {
    ran: execution.spawned,
    timedOut: execution.timedOut,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
  };
}

/**
 * Authenticate with one server — the CLI's own OAuth, start to finish.
 *
 * Run in the PROJECT, so a server defined in the repo's `.mcp.json` is a valid target and its
 * credential lands in the account this conversation runs on. The RESULT is never read from the
 * exit code: an OAuth abandoned in the browser exits 0, so the caller re-reads the session.
 */
export async function loginMcpServer(
  name: string,
  projectRoot: string,
  configDir: string,
  home: string = homedir(),
): Promise<McpRun> {
  return runMcp(['login', name], projectRoot, configDir, LOGIN_TIMEOUT_MS, home);
}

/** Clear one server's stored credential for this account. */
export async function logoutMcpServer(
  name: string,
  projectRoot: string,
  configDir: string,
  home: string = homedir(),
): Promise<McpRun> {
  return runMcp(['logout', name], projectRoot, configDir, LOGOUT_TIMEOUT_MS, home);
}

/** One server's state now, re-read from the session — the verdict after an action. */
export async function probeMcpServer(
  name: string,
  projectRoot: string,
  configDir: string,
  home: string = homedir(),
): Promise<McpServerRow | null> {
  const result = await readSessionMcpServers(projectRoot, configDir, home);
  if (!result.ok) return null;
  return result.servers.find((s) => s.name === name) ?? null;
}
