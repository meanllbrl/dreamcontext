import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { storeServers, syncImports } from '../mcp-store.js';

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
