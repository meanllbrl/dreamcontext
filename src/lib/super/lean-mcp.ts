import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Lean children (orchestration plan r5 D14, O6): a Super Agent's delegated child starts with
 * `--strict-mcp-config` and ONLY the MCP servers its job names (`delegate --mcp a,b`), plus the
 * app's own configs. Everything else the owner has configured stays out of its process tree.
 *
 * The names come from the agent, so each is checked twice against the servers the user really
 * has (at `delegate` and again at the spawn), looked up by OWN key only. Only the server-made
 * file path reaches argv, never a name. The subset is the one deliberate COPY of MCP config
 * (the shared config is by reference): bounded to the named servers, 0600 inside a 0700 dir,
 * removed when the child exits and swept at server start.
 */

/** A server name as the agent may write it. */
export const MCP_NAME_RE = /^[a-z0-9_-]{1,40}$/;
/** At most this many servers per child. */
export const MAX_LEAN_MCP = 6;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

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
 * Every MCP server the user has for this project, by name: `~/.claude.json`'s top-level
 * `mcpServers` (user scope) and its `projects[<projectRoot>].mcpServers` (local scope), the
 * local one winning a clash as Claude Code does. A sandboxed account's shared config is the
 * same user-scope map (`ensureSharedMcpConfig`), so it adds nothing here. Own keys only.
 */
export function knownMcpServers(projectRoot: string, home: string = homedir()): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  let blob: Record<string, unknown> | null = null;
  try { blob = asRecord(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8'))); } catch { blob = null; }
  if (!blob) return out;
  const add = (map: unknown) => {
    const m = asRecord(map);
    if (!m) return;
    for (const name of Object.keys(m)) {
      if (!Object.hasOwn(m, name) || FORBIDDEN_KEYS.has(name) || !MCP_NAME_RE.test(name)) continue;
      const cfg = asRecord(m[name]);
      if (cfg) out.set(name, cfg);
    }
  };
  add(blob.mcpServers);
  const projects = asRecord(blob.projects);
  if (projects && Object.hasOwn(projects, projectRoot)) add(asRecord(projects[projectRoot])?.mcpServers);
  return out;
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

/** Server start: every subset left by a child the server never saw exit (a SIGKILL). */
export function sweepLeanMcpDir(dir: string = leanMcpDir()): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!/^lean-.*\.json(\.tmp)?$/.test(f)) continue;
    try { rmSync(join(dir, f), { force: true }); n += 1; } catch { /* next start */ }
  }
  return n;
}

/** The project's own `.mcp.json`, passed explicitly (strict config would drop it otherwise). */
export function projectMcpJson(projectRoot: string): string | null {
  const p = join(projectRoot, '.mcp.json');
  try { return statSync(p).isFile() ? p : null; } catch { return null; }
}
