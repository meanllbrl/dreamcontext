import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { projectRootOf, requireOwnerWindow } from './agent-spawn-shared.js';
import {
  ClaudeAccountError, accountEnvFor, isSafeAccountId, listClaudeAccounts, resolveConfigDir,
} from '../../lib/claude-accounts.js';
import { ensureSandbox } from '../../lib/claude-account-sandbox.js';
import {
  IMPORT_NAME_RE, McpStoreError, mcpStoreFiles, readScope, removeStoreServer, resetToSource, saveStoreServer,
  sourceDefinition, storedDefinition, syncImports, type McpDefinition, type McpScope,
} from '../../lib/mcp-store.js';
import {
  cancelConnect, connectStatus, displayTarget, probeAccount, readStatusCache, serverKey, startConnect,
} from '../../lib/mcp-live.js';
import { readProjectMcp } from '../../lib/mcp-project.js';
import { MCP_NAME_RE, FORBIDDEN_KEYS } from '../../lib/super/lean-mcp.js';
import {
  isUsableServerName, type McpHome, type McpOverview, type McpOverviewAccount, type McpOverviewCell,
  type McpOverviewServer,
} from '../../lib/mcp-wire.js';

/**
 * Settings → MCP (task mcp-management W2): one overview of every server × every Claude account,
 * the account probes that fill its cells, a sign-in per account, and the store edits.
 *
 * ── Owner window only ───────────────────────────────────────────────────────────────────
 * Every route, reads included, passes `requireOwnerWindow`: desktop, loopback peer, loopback
 * Host, this very origin, not cross-site. These routes save a stdio `command` that later runs
 * on every spawn, so a DNS-rebinding page that is loopback to the server must not get in.
 *
 * ── Nothing secret crosses ──────────────────────────────────────────────────────────────
 * The overview carries names, a display target (host + masked path, or a command's basename
 * and arg count), header/env KEY names and statuses. A probe's or a sign-in child's output is
 * never returned or logged; the status they read is redacted before it is cached.
 */

/** The column of a machine with no registered account (the real `~/.claude` only). */
export const DEFAULT_ACCOUNT = 'default';

function guard(req: IncomingMessage, res: ServerResponse, contextRoot: string | null): contextRoot is string {
  if (!requireOwnerWindow(req, res)) return false;
  if (!contextRoot) {
    sendError(res, 400, 'no_vault', 'This request needs a project.');
    return false;
  }
  return true;
}

function accountsOf(home: string): McpOverviewAccount[] {
  const cache = readStatusCache(home);
  const list = listClaudeAccounts(home);
  // `checkedAt` is the last Settings PROBE only (0 = a chat's partial reading, never a probe).
  const at = (id: string) => (cache[id]?.at ? { checkedAt: cache[id].at } : {});
  if (!list.length) return [{ id: DEFAULT_ACCOUNT, label: 'this Mac', email: '', ...at(DEFAULT_ACCOUNT) }];
  return list.map((a) => ({ id: a.id, label: a.email || a.id, email: a.email, ...at(a.id) }));
}

/** An account id from a request, resolved through the one gate. */
function configDirFor(account: string, home: string): { dir: string } | { error: string } {
  try {
    if (account && account !== DEFAULT_ACCOUNT && !isSafeAccountId(account)) return { error: 'That is not an account.' };
    const dir = resolveConfigDir(account && account !== DEFAULT_ACCOUNT ? account : null, home);
    ensureSandbox(dir, home);
    return { dir };
  } catch (err) {
    return { error: err instanceof ClaudeAccountError ? err.message : 'That account cannot be used.' };
  }
}

function describe(name: string, def: McpDefinition, home: McpHome, ledger: { source: string; editedInApp: boolean; goneAtSource?: boolean } | undefined, differs: boolean): McpOverviewServer {
  const keys = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : []);
  const transport = typeof def.type === 'string' ? def.type : (typeof def.url === 'string' ? 'http' : 'stdio');
  return {
    name,
    home,
    transport,
    target: displayTarget(def),
    headerKeys: keys(def.headers),
    envKeys: keys(def.env),
    imported: !!ledger && ledger.source !== 'app',
    editedInApp: !!ledger?.editedInApp,
    differs,
    removedAtSource: !!ledger?.goneAtSource,
    key: serverKey(name, def, home),
  };
}

/** Everything Settings draws. Never a value. */
export function buildOverview(projectRoot: string, home: string = homedir()): McpOverview {
  const sync = syncImports(home, projectRoot);
  const { problems } = mcpStoreFiles({ home, projectRoot, sync: false });
  const accounts = accountsOf(home);
  const differing = new Set(sync.outside.filter((o) => o.reason === 'differs').map((o) => o.name));
  const servers: McpOverviewServer[] = [];
  for (const scope of ['computer', 'project'] as const) {
    const body = readScope(scope, projectRoot, home);
    if (!body) continue;
    for (const name of Object.keys(body.mcpServers).sort()) {
      servers.push(describe(name, body.mcpServers[name], scope, body.ledger[name], differing.has(name) && !!body.ledger[name]?.editedInApp));
    }
  }
  for (const t of readProjectMcp(projectRoot)) {
    servers.push({
      name: t.name, home: 'team', transport: t.kind, target: t.target, headerKeys: t.headerKeys, envKeys: t.envKeys,
      imported: false, editedInApp: false, differs: false, removedAtSource: false, key: `${t.name}|team`,
    });
  }

  const cache = readStatusCache(home);
  const live: McpOverview['live'] = [];
  const liveKeys = new Set<string>();
  for (const acc of Object.values(cache)) {
    for (const key of Object.keys(acc.cells)) {
      const cut = key.lastIndexOf('|');
      const name = key.slice(0, cut);
      const where = key.slice(cut + 1) as McpHome;
      if (where !== 'claudeai' || liveKeys.has(key)) continue;
      liveKeys.add(key);
      live.push({ name, home: where, transport: 'http' });
    }
  }

  const cells: McpOverview['cells'] = {};
  const rowKeys = [...servers.map((s) => ({ key: s.key, home: s.home })), ...live.map((l) => ({ key: `${l.name}|${l.home}`, home: l.home }))];
  for (const { key, home: where } of rowKeys) {
    const row: Record<string, McpOverviewCell> = {};
    for (const a of accounts) {
      const reading = cache[a.id];
      const c = reading?.cells[key];
      if (c) row[a.id] = { status: c.status, ...(c.errorKind ? { errorKind: c.errorKind } : {}), at: c.at };
      else row[a.id] = { status: reading && (where === 'claudeai' || where === 'team') ? 'absent' : 'unchecked' };
    }
    cells[key] = row;
  }
  return { accounts, servers, live, cells, outside: sync.outside, storeProblem: problems, projectRoot };
}

/** GET /api/agent/mcp/overview */
export async function handleMcpOverview(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  sendJson(res, 200, buildOverview(projectRootOf(contextRoot)));
}

/** POST /api/agent/mcp/check `{account?}`: probe one account, or every account. */
export async function handleMcpCheck(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const body = await parseJsonBody(req);
  const home = homedir();
  const projectRoot = projectRootOf(contextRoot);
  const asked = typeof body?.account === 'string' ? body.account : '';
  const ids = asked ? [asked] : accountsOf(home).map((a) => a.id);
  const files = mcpStoreFiles({ home, projectRoot }).files;
  for (const id of ids) {
    const r = configDirFor(id, home);
    if ('error' in r) { sendError(res, 422, 'bad_account', r.error); return; }
  }
  await Promise.all(ids.map(async (id) => {
    const r = configDirFor(id, home) as { dir: string };
    await probeAccount({ files, cwd: projectRoot, env: accountEnvFor(r.dir, home), accountId: id, projectRoot, home });
  }));
  sendJson(res, 200, buildOverview(projectRoot, home));
}

const TICKET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** POST /api/agent/mcp/connect `{account, name}`: a sign-in on one account, by ticket. */
export async function handleMcpConnect(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const account = typeof body?.account === 'string' ? body.account : '';
  if (!isUsableServerName(name)) { sendError(res, 422, 'bad_server_name', 'That is not a usable MCP server name.'); return; }
  const home = homedir();
  const r = configDirFor(account, home);
  if ('error' in r) { sendError(res, 422, 'bad_account', r.error); return; }
  const projectRoot = projectRootOf(contextRoot);
  const ticket = startConnect({
    files: mcpStoreFiles({ home, projectRoot }).files, cwd: projectRoot, env: accountEnvFor(r.dir, home),
    accountId: account || DEFAULT_ACCOUNT, name, projectRoot, home,
  });
  if (ticket === 'busy') { sendError(res, 409, 'busy', 'Another sign-in is running. Finish or cancel it first.'); return; }
  if (!ticket) { sendError(res, 500, 'spawn_failed', 'Could not start the Claude CLI for the sign-in.'); return; }
  sendJson(res, 200, ticket);
}

/** GET /api/agent/mcp/connect/:ticket */
export async function handleMcpConnectStatus(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const t = TICKET_RE.test(params.ticket ?? '') ? connectStatus(params.ticket) : null;
  if (!t) { sendError(res, 404, 'no_ticket', 'No such sign-in.'); return; }
  sendJson(res, 200, t);
}

/** DELETE /api/agent/mcp/connect/:ticket */
export async function handleMcpConnectCancel(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const ok = TICKET_RE.test(params.ticket ?? '') && cancelConnect(params.ticket);
  sendJson(res, ok ? 200 : 404, { cancelled: ok });
}

// ─── Store edits ──────────────────────────────────────────────────────────────

const PAIR_KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

function scopeOf(v: unknown): McpScope | null {
  return v === 'computer' || v === 'project' ? v : null;
}

/** A definition as the form sent it, merged with the stored values `keep` names, validated. */
export function buildDefinition(raw: unknown, keep: readonly string[], prev: McpDefinition | null): { def: McpDefinition } | { error: string } {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!r) return { error: 'The definition is missing.' };
  const type = r.type;
  if (type !== 'http' && type !== 'sse' && type !== 'stdio') return { error: 'type is http, sse or stdio.' };
  const def: McpDefinition = { type };
  if (type === 'stdio') {
    const command = keep.includes('command') && prev && typeof prev.command === 'string' ? prev.command : r.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 1000 || CONTROL.test(command)) return { error: 'A stdio server needs a command.' };
    def.command = command.trim();
    const args = keep.includes('args') && prev && Array.isArray(prev.args) ? prev.args : (r.args ?? []);
    if (!Array.isArray(args) || args.length > 64 || !args.every((a) => typeof a === 'string' && a.length <= 2000 && !CONTROL.test(a))) return { error: 'args is a list of up to 64 strings.' };
    if (args.length) def.args = args;
  } else {
    const url = keep.includes('url') && prev && typeof prev.url === 'string' ? prev.url : r.url;
    let ok = false;
    try { const u = new URL(String(url)); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { ok = false; }
    if (!ok || typeof url !== 'string' || url.length > 2000) return { error: 'An http server needs an http(s) URL.' };
    def.url = url;
  }
  const field = type === 'stdio' ? 'env' : 'headers';
  const pairs = r[field];
  if (pairs !== undefined) {
    if (!pairs || typeof pairs !== 'object' || Array.isArray(pairs)) return { error: `${field} is a map of names to values.` };
    const old = prev?.[field] && typeof prev[field] === 'object' ? prev[field] as Record<string, unknown> : null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pairs as Record<string, unknown>)) {
      if (!PAIR_KEY_RE.test(k) || FORBIDDEN_KEYS.has(k)) return { error: `"${k.slice(0, 40)}" is not a usable ${field} name.` };
      const kept = keep.includes(`${field}.${k}`) && old && Object.hasOwn(old, k) ? old[k] : v;
      if (typeof kept !== 'string' || kept.length > 8000 || /[\r\n\0]/.test(kept)) return { error: `The value of ${k} is not usable.` };
      out[k] = kept;
    }
    if (Object.keys(out).length > 50) return { error: `At most 50 ${field}.` };
    if (Object.keys(out).length) def[field] = out;
  }
  return { def };
}

function storeErr(res: ServerResponse, err: unknown): void {
  if (err instanceof McpStoreError) sendError(res, 409, err.code, err.message);
  else sendError(res, 500, 'store_failed', 'The MCP file could not be written.');
}

/** POST /api/agent/mcp/server `{scope, name, definition, keep?, from?}` */
export async function handleMcpServerSave(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const body = await parseJsonBody(req);
  const projectRoot = projectRootOf(contextRoot);
  const home = homedir();
  const scope = scopeOf(body?.scope);
  const from = body?.from === undefined ? scope : scopeOf(body.from);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!scope || !from) { sendError(res, 422, 'bad_scope', 'scope is computer or project.'); return; }
  const keep = Array.isArray(body?.keep) ? (body.keep as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, 120) : [];
  const prev = IMPORT_NAME_RE.test(name) ? storedDefinition(from, name, { projectRoot, home }) : null;
  // A new name: lowercase slug, never an option-looking `-x` (the CLI's control requests and
  // `isUsableServerName` refuse those). An imported name already in the store keeps its spelling.
  const nameOk = FORBIDDEN_KEYS.has(name) || name.startsWith('-') ? false : prev ? IMPORT_NAME_RE.test(name) : MCP_NAME_RE.test(name);
  if (!nameOk) { sendError(res, 422, 'bad_name', 'A name is lowercase letters, digits, - and _ (up to 40).'); return; }
  const built = buildDefinition(body?.definition, keep, prev);
  if ('error' in built) { sendError(res, 422, 'bad_definition', built.error); return; }
  try {
    saveStoreServer(scope, name, built.def, { projectRoot, home });
    if (from !== scope) removeStoreServer(from, name, { projectRoot, home });
  } catch (err) { storeErr(res, err); return; }
  sendJson(res, 200, buildOverview(projectRoot, home));
}

/** POST /api/agent/mcp/server/remove `{scope, name}` */
export async function handleMcpServerRemove(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const body = await parseJsonBody(req);
  const projectRoot = projectRootOf(contextRoot);
  const scope = scopeOf(body?.scope);
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!scope || !IMPORT_NAME_RE.test(name) || FORBIDDEN_KEYS.has(name)) { sendError(res, 422, 'bad_name', 'Which server?'); return; }
  try {
    if (!removeStoreServer(scope, name, { projectRoot })) { sendError(res, 404, 'not_found', 'No server by that name there.'); return; }
  } catch (err) { storeErr(res, err); return; }
  sendJson(res, 200, buildOverview(projectRoot));
}

/** POST /api/agent/mcp/server/move `{name, from, to}`: computer ↔ project, secrets carried server-side. */
export async function handleMcpServerMove(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const body = await parseJsonBody(req);
  const projectRoot = projectRootOf(contextRoot);
  const from = scopeOf(body?.from);
  const to = scopeOf(body?.to);
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!from || !to || from === to || !IMPORT_NAME_RE.test(name) || FORBIDDEN_KEYS.has(name)) { sendError(res, 422, 'bad_move', 'Move which server, from where, to where?'); return; }
  const def = storedDefinition(from, name, { projectRoot });
  if (!def) { sendError(res, 404, 'not_found', 'No server by that name there.'); return; }
  try {
    saveStoreServer(to, name, def, { projectRoot });
    removeStoreServer(from, name, { projectRoot });
  } catch (err) { storeErr(res, err); return; }
  sendJson(res, 200, buildOverview(projectRoot));
}

/**
 * POST /api/agent/mcp/import `{name, source, as?, scope?}`: bring a "found outside" server in.
 * Without `as`: follow the source again (an entry removed or edited here). With `as`: a copy
 * under a usable name (a name the stores cannot take, or a conflicting definition).
 */
export async function handleMcpImport(req: IncomingMessage, res: ServerResponse, _p: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const body = await parseJsonBody(req);
  const projectRoot = projectRootOf(contextRoot);
  const name = typeof body?.name === 'string' ? body.name : '';
  const source = typeof body?.source === 'string' ? body.source : '';
  if (!isUsableServerName(name) || !/^(user|sandbox:[a-z0-9-]+|local:(user|sandbox:[a-z0-9-]+))$/.test(source)) { sendError(res, 422, 'bad_import', 'Import which server, from where?'); return; }
  const scope: McpScope = scopeOf(body?.scope) ?? (source.startsWith('local:') ? 'project' : 'computer');
  try {
    if (typeof body?.as === 'string') {
      const as = body.as.trim();
      if (!MCP_NAME_RE.test(as) || as.startsWith('-') || FORBIDDEN_KEYS.has(as)) { sendError(res, 422, 'bad_name', 'A name is lowercase letters, digits, - and _ (up to 40).'); return; }
      const def = sourceDefinition(source, name, { projectRoot });
      if (!def) { sendError(res, 404, 'not_found', 'That server is no longer there.'); return; }
      if (storedDefinition(scope, as, { projectRoot })) { sendError(res, 409, 'name_taken', `There is already a server named ${as}.`); return; }
      saveStoreServer(scope, as, def, { projectRoot });
    } else {
      if (!IMPORT_NAME_RE.test(name) || FORBIDDEN_KEYS.has(name)) { sendError(res, 422, 'bad_name', 'This name needs a new one to import.'); return; }
      resetToSource(scope, name, { projectRoot });
    }
  } catch (err) { storeErr(res, err); return; }
  sendJson(res, 200, buildOverview(projectRoot));
}
