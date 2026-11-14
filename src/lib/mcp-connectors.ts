import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpFilesHome } from './mcp-store.js';

/**
 * Where each claude.ai connector of an account lives (owner 2026-11-14: a Super could not give
 * its child Notion). A Super child runs lean, and `--strict-mcp-config` drops every claude.ai
 * connector (measured on CLI 2.1.325: init lists none, and `ENABLE_CLAUDEAI_MCP_SERVERS=true`
 * does not bring them back). What keeps exactly one connector is an `allowedMcpServers` entry
 * by its URL; a name entry does not match a connector. The URL is in the live `mcp_status`
 * reply only (`config.url` of a `claudeai` row), so every reading of a chat that carries the
 * account's connectors records it here.
 *
 * `~/.dreamcontext/mcp-connectors.json`, 0600: `{ [accountId]: { [name]: { url, at } } }`. A
 * URL may carry a secret in its path (an n8n webhook), so it never leaves this file and the
 * child's own 0600 settings file: no wire frame, no state, no log names it.
 */

export interface ConnectorUrl { url: string; at: number }
export type ConnectorUrls = Record<string, Record<string, ConnectorUrl>>;

export function connectorUrlsPath(home: string = homedir()): string {
  return join(mcpFilesHome(home), '.dreamcontext', 'mcp-connectors.json');
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** An https URL a settings allowlist may carry; null for anything else. */
function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000 || /[\s*]/.test(v)) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
}

/** The claude.ai rows of a raw `mcp_status` reply: name + URL. Null = the reply carried no
 *  claude.ai row at all (the connector list did not load in that process: nothing to learn). */
export function connectorRowsOf(raw: unknown): Array<{ name: string; url: string }> | null {
  const list = Array.isArray(raw) ? raw : asRecord(raw)?.mcpServers;
  if (!Array.isArray(list)) return null;
  const out: Array<{ name: string; url: string }> = [];
  let any = false;
  for (const item of list) {
    const r = asRecord(item);
    if (!r || typeof r.name !== 'string' || !r.name || r.name.length > 200) continue;
    if (r.scope !== 'claudeai' && r.source !== 'claudeai') continue;
    any = true;
    const url = safeUrl(asRecord(r.config)?.url);
    if (url) out.push({ name: r.name, url });
  }
  return any ? out : null;
}

export function readConnectorUrls(home: string = homedir()): ConnectorUrls {
  const out = Object.create(null) as ConnectorUrls;
  const path = connectorUrlsPath(home);
  try {
    if (!lstatSync(path).isFile()) return out;
    const parsed = asRecord(JSON.parse(readFileSync(path, 'utf-8')));
    for (const id of Object.keys(parsed ?? {})) {
      const acc = asRecord(parsed?.[id]);
      if (!acc) continue;
      const rows = Object.create(null) as Record<string, ConnectorUrl>;
      for (const [name, v] of Object.entries(acc)) {
        const e = asRecord(v);
        const url = safeUrl(e?.url);
        if (url && typeof e?.at === 'number') rows[name] = { url, at: e.at };
      }
      out[id] = rows;
    }
  } catch { /* none yet */ }
  return out;
}

/**
 * Record one reading's connectors for an account: the list REPLACES that account's entry (a
 * connector removed on claude.ai leaves), unless the reply carried no claude.ai row (the list
 * did not load: the last one stays). Atomic, 0600, O_EXCL temp. Returns whether it wrote.
 */
export function recordConnectorUrls(accountId: string, raw: unknown, home: string = homedir(), now: number = Date.now()): boolean {
  const rows = connectorRowsOf(raw);
  if (!rows || !accountId) return false;
  const all = readConnectorUrls(home);
  const next = Object.create(null) as Record<string, ConnectorUrl>;
  for (const r of rows) next[r.name] = { url: r.url, at: now };
  const prev = all[accountId] ?? {};
  const same = Object.keys(prev).length === rows.length && rows.every((r) => prev[r.name]?.url === r.url);
  // Unchanged within a day: no write per reading (a chat reads after every turn).
  if (same && rows.every((r) => now - (prev[r.name]?.at ?? 0) < 86_400_000)) return false;
  all[accountId] = next;
  const path = connectorUrlsPath(home);
  mkdirSync(join(mcpFilesHome(home), '.dreamcontext'), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(all)}\n`); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch { try { rmSync(tmp, { force: true }); } catch { /* gone */ } }
  return true;
}
