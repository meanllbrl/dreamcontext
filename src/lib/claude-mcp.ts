import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { executeClaudeDetached } from './automations/runner.js';
import { accountEnvFor, isRealHomeConfigDir } from './claude-accounts.js';
import { ensureSharedMcpConfig } from './claude-account-sandbox.js';

/**
 * The MCP surface, read from the CLI that owns it.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────
 * `/mcp` typed into the Chat surface is a dead end, and it is a dead end in the most
 * frustrating way available: the user types exactly the right thing and the engine answers
 * with a sentence telling them to go somewhere else. Verified on CLI 2.1.276 — a headless
 * `-p` run of `/mcp` returns a result frame carrying `local_command: "mcp"` and the text
 * "24 MCP server(s): 3 connected, 21 not connected, 0 disabled. Use `/mcp` in the terminal
 * for details." The panel that word "details" refers to exists only in the TUI.
 *
 * That sentence is also where the cost lives: on the machine this was built for, 11 of 24
 * servers sat at "Needs authentication", which means the tools the agent believes it has are
 * dead, and nothing in the chat window could say so or fix it.
 *
 * So the Chat surface grows its own panel, and this module is its source of truth. It does
 * NOT reimplement MCP: every answer here comes from `claude mcp …`, the same commands a user
 * would run by hand, so a CLI that changes its behaviour changes this panel with it.
 *
 * ── The token is never handled ──────────────────────────────────────────────────────────
 * Authenticating is `claude mcp login <name>`: the CLI opens the browser, the CLI receives
 * the callback, the CLI writes its own credential into its own config directory. This process
 * never sees, stores, displays, logs or asks anyone to paste a token — and the login child's
 * output is DISCARDED rather than buffered, because an interactive OAuth flow's stdout can
 * carry a callback URL bearing an authorization code (the same rule `claude auth login` has
 * followed since the multi-account work; see `agent-accounts.ts`). What comes back from a
 * login is one thing: a freshly probed status for that one server.
 *
 * ── Why the output is parsed, and what happens when it cannot be ────────────────────────
 * `claude mcp list` has no `--json` on this CLI (checked: its only option is `-h`), so the
 * human-readable lines are parsed. The parser is pure and fixture-tested, and it refuses to
 * guess twice over: a line it does not recognise yields `null` and is dropped, and a STATUS
 * label it does not recognise is carried through verbatim as `unknown` rather than being
 * rounded to the nearest known state. A future CLI that invents a fourth status will show
 * that status to the user, spelled the way the CLI spelled it — never silently as "connected".
 */

/** What `claude mcp list` says about one server, as the panel draws it. */
export interface McpServerStatus {
  /** The server's name, exactly as configured (`claude.ai Figma`, `plugin:stripe:stripe`). */
  name: string;
  /** URL or launch command, as listed. May carry a trailing transport note — `(HTTP)`. */
  target: string;
  /** The recognised state. `unknown` means the CLI said something new; read `label`. */
  state: 'connected' | 'needs-auth' | 'pending-approval' | 'failed' | 'disabled' | 'unknown';
  /** The status text the CLI printed, glyph stripped — always shown for `unknown`. */
  label: string;
}

/**
 * Where a row came from, which is also where its credential belongs.
 *
 * `account` — the session's own config directory (claude.ai connectors, plugins, project
 * scope). `shared` — the machine's user-scope servers, handed to a sandboxed session by
 * reference through `--mcp-config`.
 */
export type McpOrigin = 'account' | 'shared';

/** One row as the panel draws it: a parsed listing line plus where the session gets it from. */
export interface McpServerRow extends McpServerStatus {
  origin: McpOrigin;
}

/** Health checks are N network round-trips; the whole listing is one command, so one budget. */
const LIST_TIMEOUT_MS = 90_000;
/** An interactive browser OAuth. Same ceiling `claude auth login` gets. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Logout is local bookkeeping. */
const LOGOUT_TIMEOUT_MS = 30_000;

/**
 * `✔ Connected` → `connected`. The glyph is stripped first because it is decoration: the
 * CLI has already changed it once (`✓`/`✔`), and matching on WORDS survives that.
 */
function readState(label: string): McpServerStatus['state'] {
  const text = label.replace(/^[^A-Za-z]+/, '').trim().toLowerCase();
  if (text.startsWith('connected')) return 'connected';
  if (text.startsWith('needs authentication')) return 'needs-auth';
  if (text.startsWith('pending approval')) return 'pending-approval';
  if (text.startsWith('disabled')) return 'disabled';
  if (text.startsWith('failed') || text.startsWith('error')) return 'failed';
  return 'unknown';
}

/**
 * One listing line → one server, or `null` for anything that is not one.
 *
 * The shape is `NAME: TARGET - STATUS`, and both separators are ambiguous in a way that
 * decides the split direction:
 *   • the NAME may not contain `: `, but the TARGET always does (`https://…`) — so the name
 *     is taken from the FIRST `: `;
 *   • the STATUS never contains ` - `, but a launch command may — so the status is taken
 *     from the LAST ` - `.
 * Anything without both separators is a header ("Checking MCP server health…"), a blank, or
 * a form this parser has not seen. It is dropped rather than half-read.
 */
export function parseMcpListLine(line: string): McpServerStatus | null {
  const raw = line.trim();
  if (!raw) return null;
  const nameCut = raw.indexOf(': ');
  if (nameCut <= 0) return null;
  const rest = raw.slice(nameCut + 2);
  const statusCut = rest.lastIndexOf(' - ');
  if (statusCut <= 0) return null;
  const name = raw.slice(0, nameCut).trim();
  const target = rest.slice(0, statusCut).trim();
  const label = rest.slice(statusCut + 3).trim();
  if (!name || !target || !label) return null;
  return { name, target, state: readState(label), label: label.replace(/^[^A-Za-z]+/, '').trim() };
}

/** Every server in a `claude mcp list` transcript, in the order the CLI printed them. */
export function parseMcpList(stdout: string): McpServerStatus[] {
  const out: McpServerStatus[] = [];
  for (const line of stdout.split('\n')) {
    const server = parseMcpListLine(line);
    if (server) out.push(server);
  }
  return out;
}

/**
 * `claude mcp get <name>` → the state of that ONE server.
 *
 * Used after a login instead of re-listing: re-running the full list would health-check 24
 * servers to answer a question about one. The output is a `key: value` block, and only
 * `Status:` is load-bearing here.
 */
export function parseMcpGetState(stdout: string): Pick<McpServerStatus, 'state' | 'label'> | null {
  const line = stdout.split('\n').map((l) => l.trim()).find((l) => /^Status:/i.test(l));
  if (!line) return null;
  const label = line.slice(line.indexOf(':') + 1).trim();
  if (!label) return null;
  return { state: readState(label), label: label.replace(/^[^A-Za-z]+/, '').trim() };
}

/** What the CLI leg answered, before any interpretation. `ran` is false when it never started. */
export interface McpRun {
  ran: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
}

/** The one place this module actually spawns. `env` comes from the ACCOUNT gate, never by hand. */
async function runMcp(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
  discardOutput = false,
): Promise<McpRun> {
  const execution = await executeClaudeDetached(['mcp', ...args], {
    cwd: homedir(),
    env,
    timeoutMs,
    discardOutput,
  });
  return {
    ran: execution.spawned,
    timedOut: execution.timedOut,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
  };
}

/**
 * Every configured MCP server, health-checked, for ONE account.
 *
 * The account matters and is not cosmetic: a chat session runs under its account's
 * `CLAUDE_CONFIG_DIR`, so the panel must ask the same directory the session will ask. (A
 * sandbox reports the same servers as the real home here — its claude.ai connectors come from
 * the account itself — but that is the CLI's answer to give, not ours to assume.)
 */
export async function listMcpServers(env: Record<string, string | undefined>): Promise<
  { ok: true; servers: McpServerStatus[] } | { ok: false; reason: 'spawn_failed' | 'timeout' }
> {
  const run = await runMcp(['list'], env, LIST_TIMEOUT_MS);
  if (!run.ran) return { ok: false, reason: 'spawn_failed' };
  if (run.timedOut) return { ok: false, reason: 'timeout' };
  return { ok: true, servers: parseMcpList(run.stdout) };
}

/** One server's state, freshly checked. `null` when the CLI answered in a shape we cannot read. */
export async function probeMcpServer(
  name: string,
  env: Record<string, string | undefined>,
): Promise<Pick<McpServerStatus, 'state' | 'label'> | null> {
  const run = await runMcp(['get', name], env, LIST_TIMEOUT_MS);
  if (!run.ran || run.timedOut) return null;
  return parseMcpGetState(run.stdout);
}

/**
 * Authenticate with one server — the CLI's own OAuth, start to finish.
 *
 * `discardOutput` is the load-bearing argument, not a tidiness choice: see the module header.
 * The RESULT of a login is never read from the exit code either; the caller re-probes.
 */
export async function loginMcpServer(
  name: string,
  env: Record<string, string | undefined>,
): Promise<McpRun> {
  return runMcp(['login', name], env, LOGIN_TIMEOUT_MS, true);
}

/** Clear one server's stored credential. */
export async function logoutMcpServer(
  name: string,
  env: Record<string, string | undefined>,
): Promise<McpRun> {
  return runMcp(['logout', name], env, LOGOUT_TIMEOUT_MS, true);
}

/**
 * The server names a SANDBOXED spawn is handed by reference, read from the very file the
 * spawn points at.
 *
 * Read rather than re-derived from `~/.claude.json`: `ensureSharedMcpConfig` is what decides
 * what a sandboxed session actually receives, so asking it — and then reading its output — is
 * the only way this panel and that spawn cannot drift apart. Returns an empty array when
 * there is nothing shared, which is also the account-#0 case.
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

/**
 * The environment a leg for THIS row must run under.
 *
 * A `shared` server is configured in the real home and its credential belongs there; running
 * its sign-in under the sandbox would write the credential where no session will look for it.
 */
export function envForOrigin(
  origin: McpOrigin,
  configDir: string,
  home: string = homedir(),
): Record<string, string | undefined> {
  return origin === 'shared' ? accountEnvFor(home, home) : accountEnvFor(configDir, home);
}

/**
 * Every MCP server THIS SESSION actually has, for the account it runs on.
 *
 * Two listings, merged, because that is what the spawn does (see the module header): the
 * account's own, plus the shared file's servers listed against the real home. They run in
 * parallel — each is a fan-out of health checks, and running them in sequence would double
 * the wait for no gain. A name already reported by the account wins: it is the same server,
 * and the account's reading is the one the session's own config directory will use.
 *
 * Account #0 takes the single-listing path unchanged: nothing is shared by reference there,
 * because its session reads the real `~/.claude.json` directly.
 */
export async function listMcpForSession(
  configDir: string,
  home: string = homedir(),
): Promise<{ ok: true; servers: McpServerRow[] } | { ok: false; reason: 'spawn_failed' | 'timeout' }> {
  const sandboxed = !isRealHomeConfigDir(configDir, home);
  const sharedNames = sandboxed ? sharedMcpServerNames(home) : [];

  const [account, shared] = await Promise.all([
    listMcpServers(accountEnvFor(configDir, home)),
    sharedNames.length
      ? listMcpServers(accountEnvFor(home, home))
      : Promise.resolve({ ok: true as const, servers: [] as McpServerStatus[] }),
  ]);

  // The account's listing is the one that must succeed. The shared leg degrading is reported
  // as missing ROWS, never as a failed panel: a user whose connectors are listed can still
  // sign into them while the other listing is timing out.
  if (!account.ok) return account;

  const rows: McpServerRow[] = account.servers.map((s) => ({ ...s, origin: 'account' as const }));
  const seen = new Set(rows.map((r) => r.name));
  if (shared.ok) {
    for (const s of shared.servers) {
      if (!sharedNames.includes(s.name) || seen.has(s.name)) continue;
      rows.push({ ...s, origin: 'shared' });
      seen.add(s.name);
    }
  }
  return { ok: true, servers: rows };
}
