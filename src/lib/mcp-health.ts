import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureGitignoreEntries } from './gitignore.js';
import type { McpHome, McpLiveServer, McpLiveStatus } from './mcp-wire.js';

/**
 * What a chat's agent knows about its own MCP servers (task mcp-management).
 *
 * The chat server writes the live status it read from the CLI (`mcp_status`, already redacted:
 * names, statuses, homes) to `<contextRoot>/state/.mcp-health/<tab>.json`, keyed by the chat's
 * pinned tab id (`DREAMCONTEXT_TAB_SESSION`). The `user-prompt-submit` hook reads it and, when
 * a server needs a sign-in or failed AND that set changed since it last said so, adds ONE block
 * telling the agent which servers this chat cannot use — and to send a `mcp` card only if its
 * task needs one. An unpinned chat writes nothing, so its hook says nothing. The directory is
 * gitignored before its first write; the file dies with the chat child.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAMES = 8;
const NAME_MAX = 60;

export function mcpHealthDir(contextRoot: string): string {
  return join(contextRoot, 'state', '.mcp-health');
}

function healthPath(contextRoot: string, tabId: string): string | null {
  return UUID_RE.test(tabId) ? join(mcpHealthDir(contextRoot), `${tabId}.json`) : null;
}

/** The dir for writing, or null when something that is not a real directory sits there. */
function ensureDir(contextRoot: string): string | null {
  const stateDir = join(contextRoot, 'state');
  if (existsSync(stateDir) && !lstatSync(stateDir).isDirectory()) return null;
  const dir = mcpHealthDir(contextRoot);
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) return null;
  if (!existsSync(dir)) {
    try {
      ensureGitignoreEntries(dirname(contextRoot), ['_dream_context/state/.mcp-health/'], {
        comment: 'dreamcontext: machine-local live MCP status per chat tab',
      });
    } catch { /* best-effort: the file holds names and statuses only */ }
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

interface HealthRow { name: string; status: McpLiveStatus; home: McpHome }

/** What a reading adds beyond its rows: the account's claude.ai connectors the list never
 *  loaded for in this chat (lean-mcp.ts `unloadedConnectors`), and the chat's own `apiKeySource`
 *  from its `system:init` frame (`none` on a claude.ai sign-in). */
export interface McpHealthExtra {
  unloaded?: readonly string[];
  /** The subset read connected in the last 7 days: the only names an outage verdict names. */
  unloadedFresh?: readonly string[];
  apiKeySource?: string;
  listSettled?: boolean;
}

/** Record a chat's reading. Names, statuses and homes only. Best-effort, never throws. */
export function writeMcpHealth(
  contextRoot: string, tabId: string, servers: readonly McpLiveServer[], now: number = Date.now(), extra: McpHealthExtra = {},
): void {
  try {
    const path = healthPath(contextRoot, tabId);
    if (!path || !ensureDir(contextRoot)) return;
    const rows: HealthRow[] = servers.map((s) => ({ name: s.name, status: s.status, home: s.home }));
    const unloaded = (extra.unloaded ?? []).slice(0, 40);
    const unloadedFresh = (extra.unloadedFresh ?? []).slice(0, 40);
    const tmp = `${path}.${randomUUID()}.tmp`;
    const body = {
      at: now, servers: rows,
      ...(unloaded.length ? { unloaded } : {}),
      ...(unloadedFresh.length ? { unloadedFresh } : {}),
      ...(extra.apiKeySource ? { apiKeySource: extra.apiKeySource.slice(0, 40) } : {}),
      ...(extra.listSettled ? { listSettled: true } : {}),
    };
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the hook simply says nothing */ }
}

/** The chat child is gone: its reading and the hook's memory of it go too. */
export function removeMcpHealth(contextRoot: string, tabId: string): void {
  const path = healthPath(contextRoot, tabId);
  if (!path) return;
  for (const p of [path, `${path}.said`]) {
    try { rmSync(p, { force: true }); } catch { /* already gone */ }
  }
}

function readHealth(path: string): { rows: HealthRow[]; unloaded: string[]; unloadedFresh: string[]; apiKeySource: string; listSettled: boolean } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { servers?: unknown; unloaded?: unknown; unloadedFresh?: unknown; apiKeySource?: unknown; listSettled?: unknown };
    if (!Array.isArray(parsed.servers)) return null;
    const rows = parsed.servers.filter((r): r is HealthRow => !!r && typeof (r as HealthRow).name === 'string' && typeof (r as HealthRow).status === 'string');
    const names = (v: unknown): string[] => Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : [];
    return { rows, unloaded: names(parsed.unloaded), unloadedFresh: names(parsed.unloadedFresh), apiKeySource: typeof parsed.apiKeySource === 'string' ? parsed.apiKeySource : '', listSettled: parsed.listSettled === true };
  } catch { return null; }
}

/** Why a chat has none of its account's claude.ai connectors. Claude Code loads them only for a
 *  first-party claude.ai sign-in whose token carries the connector permission (CLI 2.1.323). */
export type ConnectorCause = 'disabled' | 'third-party' | 'console' | 'api-key' | 'setup-token' | 'list';

const on = (v: string | undefined): boolean => !!v && v !== '0' && v.toLowerCase() !== 'false';

/**
 * The cause, from the chat's OWN environment (the hook runs inside the chat's process tree, so it
 * sees what the login shell exported) and the `apiKeySource` its init frame reported.
 */
export function connectorCause(env: NodeJS.ProcessEnv, apiKeySource: string = ''): ConnectorCause {
  const off = (env.ENABLE_CLAUDEAI_MCP_SERVERS ?? '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(off)) return 'disabled';
  if (on(env.CLAUDE_CODE_USE_BEDROCK) || on(env.CLAUDE_CODE_USE_VERTEX) || on(env.CLAUDE_CODE_USE_FOUNDRY)) return 'third-party';
  if (/login managed key/i.test(apiKeySource)) return 'console';
  if ((apiKeySource && apiKeySource !== 'none') || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'api-key';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'setup-token';
  return 'list';
}

/** The sentence for the agent: why, and the ONE step that fixes it. */
export function connectorCauseLine(cause: ConnectorCause, names: readonly string[], apiKeySource: string = '', env: NodeJS.ProcessEnv = {}): string {
  const listed = names.slice(0, MAX_NAMES).map(quoteName).join(', ') + (names.length > MAX_NAMES ? ` … +${names.length - MAX_NAMES} more` : '');
  const head = `claude.ai connectors this account has did not load in this chat: ${listed}.`;
  const tail = ' Tell the owner this cause and fix in plain words when the task needs one of them; never just say there is no connection.';
  switch (cause) {
    case 'disabled':
      return `${head} Why: ENABLE_CLAUDEAI_MCP_SERVERS is off where this chat starts, which turns claude.ai connectors off in Claude Code. Fix: remove it from the shell profile (~/.zshrc) and open a new chat.${tail}`;
    case 'console':
      return `${head} Why: Claude Code here is signed in with an Anthropic Console account (API billing), not claude.ai; connectors load only for a claude.ai sign-in. Fix: run \`claude auth login\` and choose the claude.ai account, then open a new chat.${tail}`;
    case 'third-party':
      return `${head} Why: this chat runs Claude through Bedrock, Vertex or Foundry (CLAUDE_CODE_USE_*), where claude.ai connectors never load. Fix: remove that variable from the shell profile (~/.zshrc) and open a new chat.${tail}`;
    case 'api-key': {
      const src = apiKeySource && apiKeySource !== 'none' ? apiKeySource.replace(/[^\w.-]/g, '')
        : env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
      return `${head} Why: an Anthropic API key (${src}) is set where this chat starts and takes precedence over the claude.ai sign-in; Claude Code loads claude.ai connectors only for a claude.ai sign-in. Fix: remove it from the shell profile (~/.zshrc) or the apiKeyHelper from Claude's settings, then open a new chat.${tail}`;
    }
    case 'setup-token':
      return `${head} Why: CLAUDE_CODE_OAUTH_TOKEN (a \`claude setup-token\` token) is set where this chat starts; that token has no connector permission. Fix: remove it from the shell profile (~/.zshrc) and open a new chat; the normal \`claude auth login\` sign-in carries the connectors.${tail}`;
    default:
      return `${head} Why: claude.ai is not answering right now: its connector service returned errors or timed out when this chat started, and Claude Code stops retrying after about a minute. This is on claude.ai's side, not this project's setup. Fix: try again later in a new chat; status.claude.com shows whether claude.ai is down.${tail}`;
  }
}

/** A name as the block quotes it: control characters out, quotes softened, 60 chars at most. */
function quoteName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/"/g, "'").trim();
  return `"${clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX - 1)}…` : clean}"`;
}

function whereLabel(home: McpHome): string {
  switch (home) {
    case 'computer': return 'this computer';
    case 'project': return 'this project';
    case 'team': return 'team .mcp.json';
    case 'claudeai': return 'claude.ai';
    case 'plugin': return 'plugin';
    case 'app': return 'the app';
    default: return 'Claude Code';
  }
}

/**
 * The block the hook adds, or null: nothing needs the owner, or the same set was already said
 * for this tab. `pending` servers are still connecting and say nothing.
 */
export function mcpHealthBlock(contextRoot: string, tabId: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!tabId) return null;
  const path = healthPath(contextRoot, tabId);
  if (!path) return null;
  const health = readHealth(path);
  if (!health) return null;
  const { rows, apiKeySource, listSettled } = health;
  const broken = rows
    .filter((r) => r.status === 'needs-auth' || r.status === 'failed')
    .sort((a, b) => a.name.localeCompare(b.name));
  // A cause the env or init proves is said at once, over every connector the cache keeps. "claude.ai
  // did not answer" waits for init and the CLI's own retries, and names only connectors read in the
  // last 7 days (one removed on claude.ai is not an outage).
  const rawCause = health.unloaded.length || health.unloadedFresh.length ? connectorCause(env, apiKeySource) : null;
  const pool = rawCause === 'list' ? health.unloadedFresh : health.unloaded;
  const cause = !rawCause || !pool.length || (rawCause === 'list' && !listSettled) ? null : rawCause;
  const unloaded = cause ? pool : [];
  const hash = createHash('sha256').update(JSON.stringify([broken.map((r) => [r.name, r.status]), unloaded, cause])).digest('hex').slice(0, 16);
  const saidPath = `${path}.said`;
  let said = '';
  try { said = readFileSync(saidPath, 'utf-8').trim(); } catch { said = ''; }
  if (said === hash) return null;
  try { writeFileSync(saidPath, hash, { encoding: 'utf-8', mode: 0o600 }); } catch { /* says it again next time */ }
  const connectorLine = cause ? connectorCauseLine(cause, unloaded, apiKeySource, env) : null;
  if (!broken.length) return connectorLine;
  const listed = broken.slice(0, MAX_NAMES).map((r) => `${quoteName(r.name)} (${r.status === 'needs-auth' ? 'needs sign-in' : 'failed'}, ${whereLabel(r.home)})`);
  const more = broken.length > MAX_NAMES ? ` … +${broken.length - MAX_NAMES} more` : '';
  const block = `MCP not usable in this chat: ${listed.join(', ')}${more}. Only if your task needs one, send a \`dream-view\` \`mcp\` card naming it (e.g. {"type":"mcp","id":"connect-x","why":"…","servers":["name"]}); never ask in prose, never fail silently.`;
  return connectorLine ? `${block}\n${connectorLine}` : block;
}
