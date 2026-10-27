/**
 * MIRROR of `src/lib/mcp-wire.ts` (the dashboard cannot import from `src/`). Everything from
 * `MCP_LIVE_STATUSES` down is byte-identical to the server file, pinned by
 * `tests/unit/mcp-wire-mirror.test.ts`: change both or neither.
 */

/** What the live session says about one server. `pending` = still connecting. */
export const MCP_LIVE_STATUSES = ['connected', 'needs-auth', 'pending', 'failed', 'disabled', 'unknown'] as const;
export type McpLiveStatus = (typeof MCP_LIVE_STATUSES)[number];

/** Why a server failed, derived on the server. Free error text never leaves it. */
export const MCP_ERROR_KINDS = ['auth', 'timeout', 'spawn', 'protocol', 'other'] as const;
export type McpErrorKind = (typeof MCP_ERROR_KINDS)[number];

/**
 * Where a server lives, as the owner reads it: this computer (every account), this project
 * (home-side store), the team's `.mcp.json`, a claude.ai connector, a plugin, a server Claude
 * Code has that dreamcontext did not import ("found outside"), or one the app itself adds
 * (the headless browser, the Assistant's hands).
 */
export const MCP_HOMES = ['computer', 'project', 'team', 'claudeai', 'plugin', 'outside', 'app'] as const;
export type McpHome = (typeof MCP_HOMES)[number];

/** One server in a live session, redacted (`redactStatus`). */
export interface McpLiveServer {
  name: string;
  status: McpLiveStatus;
  home: McpHome;
  /** `http` | `sse` | `stdio` | … as the engine says it; '' when it did not. */
  transport: string;
  /** `scheme://host` of an http server; absent for stdio. */
  urlHost?: string;
  toolCount?: number;
  errorKind?: McpErrorKind;
}

/** `_meta {subtype:'mcp_status'}` on the chat socket. */
export interface McpStatusFrame {
  subtype: 'mcp_status';
  servers: McpLiveServer[];
  /** Epoch ms of the reading. */
  at: number;
}

/** `_meta {subtype:'mcp_auth_url'}`: the browser to open for one server's sign-in. */
export interface McpAuthUrlFrame {
  subtype: 'mcp_auth_url';
  name: string;
  url: string;
  host: string;
}

/** `_meta {subtype:'mcp_connect'}`: how a connect the window started is going. */
export const MCP_CONNECT_STATES = ['opening', 'waiting', 'connected', 'timeout', 'failed', 'busy'] as const;
export type McpConnectState = (typeof MCP_CONNECT_STATES)[number];
export interface McpConnectFrame {
  subtype: 'mcp_connect';
  name: string;
  state: McpConnectState;
}

/** Settings → MCP: one store-backed server, as the matrix draws its row. Values never included. */
export interface McpOverviewServer {
  name: string;
  home: McpHome;
  transport: string;
  /** `displayTarget`: host + masked path, or a command's basename + arg count. */
  target: string;
  /** Header / env KEY names only, for the edit form. */
  headerKeys: string[];
  envKeys: string[];
  /** Copied from a Claude Code config and still following it. */
  imported: boolean;
  /** Saved from Settings: frozen against its source. */
  editedInApp: boolean;
  /** Its Claude Code source differs from this (edited) copy. */
  differs: boolean;
  /** Its Claude Code source no longer has it (edited copy kept). */
  removedAtSource: boolean;
  /** The status-cache key part for this definition (`name|defHash`). */
  key: string;
}

/** One cell of the matrix: what that account's live session last reported. */
export interface McpOverviewCell {
  status: McpLiveStatus | 'unchecked' | 'absent';
  errorKind?: McpErrorKind;
  /** Epoch ms of the probe. */
  at?: number;
}

export interface McpOverviewAccount {
  id: string;
  label: string;
  email: string;
  /** The epoch ms of this account's last probe, if any. */
  checkedAt?: number;
}

/** A server found in a Claude Code config that the stores do not hold as-is. */
export interface McpOutsideServer {
  name: string;
  /** `user` | `sandbox:<id>` | `local:<id>` — where it was found. */
  source: string;
  reason: 'bad-name' | 'conflict' | 'removed-in-app' | 'differs';
}

export interface McpOverview {
  accounts: McpOverviewAccount[];
  servers: McpOverviewServer[];
  /** claude.ai connectors and team servers seen in any probe, by name. */
  live: Array<{ name: string; home: McpHome; transport: string }>;
  /** `[serverKey][accountId]`. */
  cells: Record<string, Record<string, McpOverviewCell>>;
  outside: McpOutsideServer[];
  /** A store file the spawns skip (not 0600, a symlink, another owner, unreadable). */
  storeProblem: Array<{ scope: 'computer' | 'project'; reason: string }>;
  projectRoot: string;
}

/** Control characters, by code point: a name carrying one is not a name. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Is this a name we may hand to the CLI (a control request, a positional argument)?
 *
 * Server names are free-form and genuinely contain spaces, dots and colons (`claude.ai Google
 * Calendar`, `plugin:stripe:stripe`), so this cannot be a slug test. The one thing that must be
 * refused is a name the CLI would read as an OPTION, plus control characters and absurd lengths.
 */
export function isUsableServerName(name: unknown): name is string {
  return typeof name === 'string' && !!name && name.length <= 200 && !name.startsWith('-') && !CONTROL_CHARS.test(name);
}
