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

/** Record a chat's reading. Names, statuses and homes only. Best-effort, never throws. */
export function writeMcpHealth(contextRoot: string, tabId: string, servers: readonly McpLiveServer[], now: number = Date.now()): void {
  try {
    const path = healthPath(contextRoot, tabId);
    if (!path || !ensureDir(contextRoot)) return;
    const rows: HealthRow[] = servers.map((s) => ({ name: s.name, status: s.status, home: s.home }));
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ at: now, servers: rows })}\n`, { encoding: 'utf-8', mode: 0o600 });
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

function readRows(path: string): HealthRow[] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { servers?: unknown };
    if (!Array.isArray(parsed.servers)) return null;
    return parsed.servers.filter((r): r is HealthRow => !!r && typeof (r as HealthRow).name === 'string' && typeof (r as HealthRow).status === 'string');
  } catch { return null; }
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
export function mcpHealthBlock(contextRoot: string, tabId: string | undefined): string | null {
  if (!tabId) return null;
  const path = healthPath(contextRoot, tabId);
  if (!path) return null;
  const rows = readRows(path);
  if (!rows) return null;
  const broken = rows
    .filter((r) => r.status === 'needs-auth' || r.status === 'failed')
    .sort((a, b) => a.name.localeCompare(b.name));
  const hash = createHash('sha256').update(JSON.stringify(broken.map((r) => [r.name, r.status]))).digest('hex').slice(0, 16);
  const saidPath = `${path}.said`;
  let said = '';
  try { said = readFileSync(saidPath, 'utf-8').trim(); } catch { said = ''; }
  if (said === hash) return null;
  try { writeFileSync(saidPath, hash, { encoding: 'utf-8', mode: 0o600 }); } catch { /* says it again next time */ }
  if (!broken.length) return null;
  const listed = broken.slice(0, MAX_NAMES).map((r) => `${quoteName(r.name)} (${r.status === 'needs-auth' ? 'needs sign-in' : 'failed'}, ${whereLabel(r.home)})`);
  const more = broken.length > MAX_NAMES ? ` … +${broken.length - MAX_NAMES} more` : '';
  return `MCP not usable in this chat: ${listed.join(', ')}${more}. Only if your task needs one, send a \`dream-view\` \`mcp\` card naming it (e.g. {"type":"mcp","id":"connect-x","why":"…","servers":["name"]}); never ask in prose, never fail silently.`;
}
