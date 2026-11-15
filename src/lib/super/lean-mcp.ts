import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { storeServers, syncImports } from '../mcp-store.js';
import { readConnectorUrls, type ConnectorUrls } from '../mcp-connectors.js';
import { connectorAlias } from '../mcp-wire.js';

/**
 * Lean children (orchestration plan r5 D14, O6): a Super Agent's delegated child starts with
 * `--strict-mcp-config` and ONLY the MCP servers its job names (`delegate --mcp a,b`), plus the
 * app's own configs. Everything else the owner has configured stays out of its process tree.
 *
 * The names come from the agent, so each is checked twice against the servers the user really
 * has (at `delegate` and again at the spawn), looked up by OWN key only. Only the server-made
 * file path reaches argv, never a name. The subset is the one deliberate COPY of MCP config
 * (the stores are by reference): bounded to the named servers, 0600 inside a 0700 dir,
 * removed when the child exits and swept at server start.
 */

/** A server name as the agent may write it. */
export const MCP_NAME_RE = /^[a-z0-9_-]{1,40}$/;
/** At most this many servers per child. */
export const MAX_LEAN_MCP = 6;

/** Names that would reach an object's prototype. Refused everywhere a server name is a key. */
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `a,b` (or a list) -> the names, or why not. Empty -> []. */
export function parseMcpNames(raw: unknown): { names: string[] } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { names: [] };
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (!parts) return { error: 'mcp names a comma-separated list of MCP servers' };
  const names: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') return { error: 'mcp names a comma-separated list of MCP servers' };
    const n = p.trim();
    if (!n) continue;
    if (!MCP_NAME_RE.test(n) || FORBIDDEN_KEYS.has(n)) return { error: `"${n.slice(0, 40)}" is not an MCP server name (a-z, 0-9, _ and -)` };
    if (!names.includes(n)) names.push(n);
  }
  if (names.length > MAX_LEAN_MCP) return { error: `at most ${MAX_LEAN_MCP} MCP servers per child` };
  return { names };
}

/**
 * Every MCP server the user has for this project, by name: dreamcontext's own stores (task
 * mcp-management), synced first from Claude Code's configs, the project store winning a clash
 * as the later `--mcp-config` file does. Names a child may ask for only (`MCP_NAME_RE`).
 */
export function knownMcpServers(projectRoot: string, home: string = homedir()): Map<string, Record<string, unknown>> {
  try { syncImports(home, projectRoot); } catch { /* the stores as they are */ }
  const out = new Map<string, Record<string, unknown>>();
  for (const [name, cfg] of storeServers(projectRoot, home)) {
    if (FORBIDDEN_KEYS.has(name) || !MCP_NAME_RE.test(name)) continue;
    out.set(name, cfg);
  }
  return out;
}

/** One claude.ai connector a Claude child may be given, by its short name (`notion`). */
export interface ChildConnector {
  /** What `delegate --mcp` and an `mcp` card name it: `connectorAlias`, settled against clashes. */
  alias: string;
  /** Claude Code's own name: `claude.ai Notion`. */
  name: string;
  /** The accounts whose last reading listed it, with that account's URL for it. */
  urls: Record<string, string>;
}

/**
 * The claude.ai connectors a Claude child may be given, by short name (owner 2026-11-14): every
 * connector some account's live reading listed (`mcp-connectors.ts`: the URL is what lets one
 * through a lean child's allowlist). An alias a local server already uses, or another connector
 * took first (names sorted), becomes `claudeai-<alias>`, then `<alias>-2`, ...: the local name
 * always keeps its meaning.
 */
export function knownConnectors(localNames: Iterable<string>, urls: ConnectorUrls): Map<string, ChildConnector> {
  const byName = new Map<string, Record<string, string>>();
  for (const [account, rows] of Object.entries(urls)) {
    for (const [name, e] of Object.entries(rows)) {
      if (!connectorAlias(name)) continue;
      const m = byName.get(name) ?? {};
      m[account] = e.url;
      byName.set(name, m);
    }
  }
  const taken = new Set(localNames);
  const out = new Map<string, ChildConnector>();
  for (const name of [...byName.keys()].sort((a, b) => a.localeCompare(b))) {
    const base = connectorAlias(name);
    let alias = base;
    if (taken.has(alias) || FORBIDDEN_KEYS.has(alias)) alias = `claudeai-${base}`.slice(0, 40).replace(/-+$/, '');
    for (let i = 2; (taken.has(alias) || FORBIDDEN_KEYS.has(alias)) && i < 100; i += 1) alias = `${base.slice(0, 36)}-${i}`;
    if (!MCP_NAME_RE.test(alias) || taken.has(alias)) continue;
    taken.add(alias);
    out.set(alias, { alias, name, urls: byName.get(name)! });
  }
  return out;
}

/** Everything a child may be given: the project's servers (`knownMcpServers`) and the
 *  account's claude.ai connectors (`knownConnectors`), which never shadow a local name. */
export function knownChildMcp(projectRoot: string, home: string = homedir()): {
  local: Map<string, Record<string, unknown>>;
  connectors: Map<string, ChildConnector>;
  /** Both, by name: what a name check (`delegate --mcp`, a card's grant) reads. */
  all: Map<string, unknown>;
  /** The accounts whose connector list some reading recorded (`connectorOnAccount`). */
  read: Set<string>;
} {
  const local = knownMcpServers(projectRoot, home);
  let connectors = new Map<string, ChildConnector>();
  let read = new Set<string>();
  try {
    const urls = readConnectorUrls(home);
    connectors = knownConnectors(local.keys(), urls);
    read = new Set(Object.keys(urls));
  } catch { /* local only */ }
  const all = new Map<string, unknown>(local);
  for (const [alias, c] of connectors) all.set(alias, c);
  return { local, connectors, all, read };
}

/**
 * Does THIS account have the connector (owner 2026-11-14: a connector is the Claude account's,
 * and a child on another account may not have it)? `yes`: its last recorded list names it;
 * `no`: its list was recorded without it; `unknown`: no list of this account was recorded yet.
 * The one rule `super state`, a child's allowlist and a grant's receipt all read.
 */
export function connectorOnAccount(c: ChildConnector, accountId: string, read: ReadonlySet<string>): 'yes' | 'no' | 'unknown' {
  if (accountId && c.urls[accountId]) return 'yes';
  return accountId && read.has(accountId) ? 'no' : 'unknown';
}

/**
 * The connectors among `names`, each with the URL its allowlist entry needs: the child's own
 * account's URL when it has the connector, else another account's (one connector, one URL). An
 * account whose recorded list lacked it may have connected it since (the card sends the owner to
 * claude.ai for exactly that), and an allowlisted URL that loads nothing costs nothing; what the
 * child is PROMISED (`super state`, a grant's receipt) reads `connectorOnAccount`, never this.
 * Local names are not here.
 */
export function connectorRulesFor(
  names: readonly string[], connectors: ReadonlyMap<string, ChildConnector>, accountId: string, read: ReadonlySet<string>,
): Array<{ alias: string; name: string; url: string }> {
  const out: Array<{ alias: string; name: string; url: string }> = [];
  for (const n of names) {
    const c = connectors.get(n);
    if (!c) continue;
    const url = connectorOnAccount(c, accountId, read) === 'yes' ? c.urls[accountId] : Object.values(c.urls)[0];
    if (url) out.push({ alias: n, name: c.name, url });
  }
  return out;
}

/**
 * The `--settings` part that lets a lean child keep `servers` (by name: the files it is given)
 * and the named connectors (by URL) and nothing else: Claude Code's own MCP policy, which
 * replaces `--strict-mcp-config` for such a child (strict drops every connector).
 */
export function leanAllowlist(servers: readonly string[], connectors: ReadonlyArray<{ url: string }>): { allowedMcpServers: Array<{ serverName: string } | { serverUrl: string }> } {
  return {
    allowedMcpServers: [
      ...[...new Set(servers)].map((serverName) => ({ serverName })),
      ...[...new Set(connectors.map((c) => c.url))].map((serverUrl) => ({ serverUrl })),
    ],
  };
}

/** The server names one `{ mcpServers }` file holds; [] when it cannot be read. */
export function mcpFileNames(path: string | null): string[] {
  if (!path) return [];
  try {
    const servers = (JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: unknown }).mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
  } catch { return []; }
}

/**
 * `mcpNeedingSignIn` over child names: a connector alias is read by its claude.ai name
 * (cells `claude.ai Notion|claudeai`), answered back by the alias.
 */
export function childMcpNeedingSignIn(
  names: readonly string[],
  connectors: ReadonlyMap<string, ChildConnector>,
  cache: Readonly<Record<string, { cells: Readonly<Record<string, { status: string }>> }>>,
): string[] {
  const real = names.map((n) => connectors.get(n)?.name ?? n);
  const need = new Set(mcpNeedingSignIn(real, cache));
  return names.filter((n, i) => need.has(real[i]));
}

/**
 * The names among `names` that need the OWNER's sign-in: some account's last live reading
 * (`~/.dreamcontext/mcp-status.json`, cells keyed `name|…`) says `needs-auth` and none says
 * `connected`. A child cannot sign in (it runs unattended), so a job needing one of these waits
 * on the owner; delegating it again only repeats the failure (kitUP 2026-11-09, posthog x3).
 */
export function mcpNeedingSignIn(
  names: readonly string[],
  cache: Readonly<Record<string, { cells: Readonly<Record<string, { status: string }>> }>>,
): string[] {
  return names.filter((n) => {
    const seen = Object.values(cache).flatMap((acc) => Object.entries(acc.cells)
      .filter(([key]) => key.slice(0, key.lastIndexOf('|')) === n).map(([, c]) => c.status));
    return seen.includes('needs-auth') && !seen.includes('connected');
  });
}

/** The same fence the chat and owner-wait.ts read: an unterminated one is not a card yet. */
const VIEW_FENCE = /```dream-view[^\S\r\n]*\r?\n([\s\S]*?)```/g;

/** The server names every `mcp` card in one assistant text asks for, in order, deduped. */
export function mcpCardServers(text: string): string[] {
  const out: string[] = [];
  if (!text.includes('dream-view')) return out;
  for (const m of text.matchAll(VIEW_FENCE)) {
    let o: unknown;
    try { o = JSON.parse(m[1]); } catch { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o) || (o as { type?: unknown }).type !== 'mcp') continue;
    const servers = (o as { servers?: unknown }).servers;
    if (!Array.isArray(servers)) continue;
    for (const s of servers) {
      const n = typeof s === 'string' ? s.trim() : '';
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/**
 * A chat asked for servers it was started without (owner 2026-11-12, memoryos: a Super child
 * needed Slack, the Super had not named it at `delegate`, and the child was blind while Slack sat
 * configured). The names its `mcp` card asks for that this project ALREADY has and the chat does
 * not: those join it on an in-place respawn at the turn's end, no owner step. Exact own-key
 * matches only (`MCP_NAME_RE`, never a prototype key), and never past {@link MAX_LEAN_MCP} for a
 * lean child, so a card cannot widen a child into everything. A name the project does not have
 * stays the owner's (the card says "add it").
 */
export function mcpGrantFor(o: {
  asked: readonly string[];
  have: readonly string[];
  known: ReadonlyMap<string, unknown>;
  /** A lean child: the total stays within MAX_LEAN_MCP. */
  lean: boolean;
}): string[] {
  const out: string[] = [];
  for (const n of o.asked) {
    if (!MCP_NAME_RE.test(n) || FORBIDDEN_KEYS.has(n) || !o.known.has(n)) continue;
    if (o.have.includes(n) || out.includes(n)) continue;
    if (o.lean && o.have.length + out.length >= MAX_LEAN_MCP) break;
    out.push(n);
  }
  return out;
}

/**
 * The MCP servers a LONG-LIVED Super Agent process is missing that a newer process would have
 * (owner 2026-11-12, a teammate's Super blind to the claude.ai Knowledge Base while a Window in
 * the same project had it). A process reads its MCP set once, at spawn; the Super's process
 * outlives that (its "Fresh session" is a `/clear` in the same process, the in-app Reconnect only
 * re-dials a server the process already lists), so a server set up later never reaches it.
 *
 *  - `store`: names in the project's stores now that were not there at spawn (`spawned`) and were
 *    not granted since: a newer process gets them from `--mcp-config`.
 *  - `connectors`: a claude.ai connector (`<name>|claudeai` cell) THIS account's cache saw
 *    `connected` AFTER this process started, and this process's own live reading (`live`) does
 *    not list: another chat on the same login got it, this one never fetched it. Strictly after
 *    the spawn, and once per conversation (`tried`): a successor that still lacks it while other
 *    chats keep reading it connected never restarts for it again.
 *
 * `live` null (no reading yet) = no connector verdict. Pure: the caller decides when to respawn.
 */
export function mcpDrift(o: {
  configuredNow: Iterable<string>;
  spawned: readonly string[];
  granted: readonly string[];
  live: ReadonlyArray<{ name: string }> | null;
  accountCells: Readonly<Record<string, { status: string; at?: number }>> | null | undefined;
  spawnedAt: number;
  /** Connectors an earlier process of this conversation already restarted for: never again. */
  tried?: readonly string[];
}): { store: string[]; connectors: string[] } {
  const have = new Set([...o.spawned, ...o.granted]);
  const store: string[] = [];
  for (const n of o.configuredNow) {
    if (FORBIDDEN_KEYS.has(n) || have.has(n) || store.includes(n)) continue;
    store.push(n);
  }
  const connectors: string[] = [];
  if (o.live && o.accountCells) {
    const liveNames = new Set(o.live.map((s) => s.name));
    for (const [key, cell] of Object.entries(o.accountCells)) {
      const bar = key.lastIndexOf('|');
      if (bar <= 0 || key.slice(bar + 1) !== 'claudeai') continue;
      const name = key.slice(0, bar);
      if (cell?.status !== 'connected' || typeof cell.at !== 'number' || cell.at <= o.spawnedAt) continue;
      if (liveNames.has(name) || connectors.includes(name) || o.tried?.includes(name)) continue;
      connectors.push(name);
    }
  }
  return { store, connectors };
}

/**
 * How long after a spawn the CLI may still be fetching the claude.ai connector list. Measured on
 * CLI 2.1.323 (2026-11-13): the list loads async after the spawn; a failure (HTTP 5xx, a timeout)
 * is retried 3 times inline and then 3 times in the background at 5, 15 and 45 s, after which
 * that process stops for good (about 65 s); 90 s leaves room for the slow attempts.
 */
const SETTLE_MS = 90_000;
let settleMs = SETTLE_MS;
export function setConnectorListSettleMsForTests(ms: number | null): void { settleMs = ms ?? SETTLE_MS; }
export function connectorListSettleMs(): number { return settleMs; }
/** Whether a process spawned at `spawnedAt` is past the CLI's own connector-list retries. */
export function connectorListSettled(spawnedAt: number, now: number = Date.now()): boolean {
  return now - spawnedAt >= settleMs;
}

/** A cell older than this no longer stands for a connector the account has: one removed on
 *  claude.ai is never read again, and must not read as an outage for a month. */
const CONNECTOR_FRESH_MS = 7 * 86_400_000;

/**
 * The claude.ai connectors this account's cache saw `connected` that a reading does not carry,
 * ONLY when the reading has no claude.ai row at all: then the connector LIST did not load in
 * that process (an API key or a setup-token login, or Anthropic's list service failing at the
 * spawn), not one connector gone. A reading with any claude.ai row loaded the list: a name
 * missing from it was removed on claude.ai, and says nothing here. Sorted, null reading = none.
 */
export function unloadedConnectors(
  live: ReadonlyArray<{ name: string; home?: string }> | null,
  accountCells: Readonly<Record<string, { status: string; at?: number }>> | null | undefined,
  now: number = Date.now(),
  /** Only cells read connected within this window (an outage verdict); null = every cell the
   *  cache keeps (a cause the env proves: no chat refreshes the cells while it lasts). */
  freshMs: number | null = CONNECTOR_FRESH_MS,
): string[] {
  if (!live || !accountCells) return [];
  if (live.some((s) => s.home === 'claudeai' || /^claude\.ai /.test(s.name))) return [];
  const out = new Set<string>();
  for (const [key, cell] of Object.entries(accountCells)) {
    const bar = key.lastIndexOf('|');
    if (bar <= 0 || key.slice(bar + 1) !== 'claudeai' || cell?.status !== 'connected') continue;
    if (freshMs !== null && (typeof cell.at !== 'number' || now - cell.at > freshMs)) continue;
    out.add(key.slice(0, bar));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** The names among `names` the user does not have (empty = all known). */
export function unknownMcpNames(names: readonly string[], known: ReadonlyMap<string, unknown>): string[] {
  return names.filter((n) => !known.has(n));
}

/** `~/.dreamcontext/claude-accounts/lean/`: where the per-child subsets live (0700). */
export function leanMcpDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'claude-accounts', 'lean');
}

function ensureLeanDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700); } catch { /* best effort */ }
}

/**
 * Write the child's subset (`{ mcpServers: { <name>: <config> } }`) and return its path; null
 * when it names nothing (then no file and no flag: strict config with no user server). Throws
 * on an unknown name: the spawn re-checks, it never trusts the earlier check.
 */
export function writeLeanMcpConfig(names: readonly string[], known: ReadonlyMap<string, Record<string, unknown>>, dir: string = leanMcpDir()): string | null {
  if (names.length === 0) return null;
  const missing = unknownMcpNames(names, known);
  if (missing.length) throw new Error(`unknown MCP server(s): ${missing.join(', ')}`);
  const mcpServers: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const n of names) mcpServers[n] = known.get(n);
  ensureLeanDir(dir);
  const path = join(dir, `lean-${process.pid}-${randomBytes(8).toString('hex')}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

export function removeLeanMcpConfig(path: string | null): void {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* already gone */ }
}

/** Is the process that wrote a subset (its pid is in the name) still running? */
function writerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

/** Server start: every subset left by a server that is gone (a SIGKILL skips the exit cleanup).
 *  A subset another LIVE server process wrote is its children's and stays. */
export function sweepLeanMcpDir(dir: string = leanMcpDir()): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const m = /^lean-(\d+)-.*\.json(\.tmp)?$/.exec(f);
    if (!m || writerAlive(Number(m[1]))) continue;
    try { rmSync(join(dir, f), { force: true }); n += 1; } catch { /* next start */ }
  }
  return n;
}

/** The project's own `.mcp.json`, passed explicitly (strict config would drop it otherwise). */
export function projectMcpJson(projectRoot: string): string | null {
  const p = join(projectRoot, '.mcp.json');
  try { return statSync(p).isFile() ? p : null; } catch { return null; }
}
