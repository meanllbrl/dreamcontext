import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The owner's "Always allow localhost:PORT" (jarvis plan r9, K4): which loopback ports a web
 * card (the Super Agent's, a whiteboard's web box) may load without asking again.
 *
 * Held on the MACHINE, outside every vault: `~/.dreamcontext/loopback-grants.json`, keyed by the
 * vault's real path. The desktop app picks a new port on every launch, so a grant in the window's
 * localStorage would be lost with its origin; and inside the vault a clone or a brain sync could
 * carry an approval to another machine.
 *
 * Only the owner's route writes it (`POST /api/agent/loopback-grant`); no agent verb carries a
 * grant. The file is 0600, written atomically, a symlink is refused, a vault holds at most
 * MAX_GRANTS ports, and an entry is `{port, grantedAt}` and nothing else. A port this process
 * listens on (`owned`) is dropped on every READ as well: ports change between launches, so a
 * grant that matches today's dashboard port must not open the dashboard.
 */

export interface LoopbackGrant { port: number; grantedAt: number }

export const MAX_GRANTS = 100;
const MAX_FILE_BYTES = 512 * 1024;

export function loopbackGrantsPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'loopback-grants.json');
}

const isPort = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536;

function readAll(home: string): Record<string, LoopbackGrant[]> {
  const path = loopbackGrantsPath(home);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return {};
  } catch {
    return {};
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf-8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, LoopbackGrant[]> = {};
  for (const [vault, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!vault.startsWith('/') || !Array.isArray(list)) continue;
    const seen = new Set<number>();
    const grants: LoopbackGrant[] = [];
    for (const g of list) {
      if (!g || typeof g !== 'object') continue;
      const { port, grantedAt } = g as Record<string, unknown>;
      if (!isPort(port) || seen.has(port) || typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) continue;
      seen.add(port);
      grants.push({ port, grantedAt });
    }
    if (grants.length) out[vault] = grants.slice(-MAX_GRANTS);
  }
  return out;
}

function writeAll(home: string, all: Record<string, LoopbackGrant[]>): void {
  const path = loopbackGrantsPath(home);
  mkdirSync(join(home, '.dreamcontext'), { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('loopback-grants.json is a symlink; refusing it');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

/** The vault's granted ports, minus any port this process owns right now. */
export function readLoopbackGrants(vaultRealPath: string, owned: ReadonlySet<number>, home: string = homedir()): LoopbackGrant[] {
  return (readAll(home)[vaultRealPath] ?? []).filter((g) => !owned.has(g.port));
}

/** Grant or revoke one port for the vault. Returns the vault's grants afterwards (owned dropped).
 *  Refuses (throws) a port that is not a port, or one this process owns. */
export function setLoopbackGrant(
  vaultRealPath: string, port: number, op: 'grant' | 'revoke', owned: ReadonlySet<number>,
  home: string = homedir(), now: number = Date.now(),
): LoopbackGrant[] {
  if (!vaultRealPath.startsWith('/')) throw new Error('a vault is named by its real path');
  if (!isPort(port)) throw new Error('not a port');
  if (op === 'grant' && owned.has(port)) throw new Error('owned-port');
  const all = readAll(home);
  const list = (all[vaultRealPath] ?? []).filter((g) => g.port !== port);
  if (op === 'grant') list.push({ port, grantedAt: now });
  if (list.length) all[vaultRealPath] = list.slice(-MAX_GRANTS); else delete all[vaultRealPath];
  writeAll(home, all);
  return list.filter((g) => !owned.has(g.port));
}
