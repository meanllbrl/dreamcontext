import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { listVaults, resolveVaultContextRoot, VaultError } from './vaults.js';

/**
 * Federation connection direction (P2.1). A connection is an OUTGOING edge from
 * the current vault to a peer:
 * - `out`  — this vault's digest may flow TO the peer.
 * - `in`   — this vault accepts the peer's digest into its inbox.
 * - `both` — bidirectional.
 *
 * `--connected` recall spans `out`/`both` peers (this vault reaches across).
 */
export type ConnectionDirection = 'out' | 'in' | 'both';

/** Lifecycle of a connection. A peer whose path went stale is marked `stale`. */
export type ConnectionStatus = 'active' | 'stale';

export interface Connection {
  /** Registered name of the peer vault. */
  vault: string;
  direction: ConnectionDirection;
  /** Topic filter for the federation flow; `null` ⇒ no filter (all topics). */
  topics: string[] | null;
  /** ISO timestamp of the last successful sync, advanced by Phase 3. `null` until first sync. */
  last_synced_at: string | null;
  status: ConnectionStatus;
}

export interface ConnectionsFile {
  version: 1;
  connections: Connection[];
}

const CONNECTIONS_REL_PATH = 'state/.connections.json';
const DIRECTIONS: ConnectionDirection[] = ['out', 'in', 'both'];

/** Absolute path to a context root's `.connections.json`. */
export function connectionsPath(contextRoot: string): string {
  return join(contextRoot, CONNECTIONS_REL_PATH);
}

function emptyFile(): ConnectionsFile {
  return { version: 1, connections: [] };
}

/** True iff `d` is a recognised direction enum value. */
function isDirection(d: unknown): d is ConnectionDirection {
  return typeof d === 'string' && (DIRECTIONS as string[]).includes(d);
}

/**
 * Coerce one raw entry into a well-typed {@link Connection}, or `null` if it is
 * malformed. Defensive: a hand-edited / corrupt file never leaks garbage values
 * into recall or the dashboard.
 */
function sanitizeConnection(raw: unknown): Connection | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.vault !== 'string' || !o.vault) return null;
  if (!isDirection(o.direction)) return null;
  const topics = Array.isArray(o.topics)
    ? o.topics.filter((t): t is string => typeof t === 'string')
    : null;
  const last_synced_at = typeof o.last_synced_at === 'string' ? o.last_synced_at : null;
  const status: ConnectionStatus = o.status === 'stale' ? 'stale' : 'active';
  return { vault: o.vault, direction: o.direction, topics, last_synced_at, status };
}

/**
 * Read the connections file. NEVER throws — a missing or malformed file yields
 * an empty `{version:1, connections:[]}`, and any malformed individual entries
 * are filtered out (never-throw registry contract, issue #25 LOCKED).
 */
export function readConnections(contextRoot: string): ConnectionsFile {
  const path = connectionsPath(contextRoot);
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ConnectionsFile>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.connections)) {
      return emptyFile();
    }
    const connections = parsed.connections
      .map(sanitizeConnection)
      .filter((c): c is Connection => c !== null);
    return { version: 1, connections };
  } catch {
    console.error('[dreamcontext] .connections.json is malformed — treating as empty.');
    return emptyFile();
  }
}

/** Write the connections file with pretty JSON + trailing newline. */
export function writeConnections(contextRoot: string, file: ConnectionsFile): void {
  const path = connectionsPath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf-8');
}

/** List the current vault's connections (never throws). */
export function listConnections(contextRoot: string): Connection[] {
  return readConnections(contextRoot).connections;
}

/**
 * Add (or upsert) a connection to `peer` (P2.1).
 *
 * Validates:
 * - direction must be a recognised enum value → `VaultError`.
 * - topics must be `string[] | null` → `VaultError`.
 * - peer must be registered in the vault registry → `VaultError`.
 * - self-connect rejected by NAME (peer === currentVaultName) OR by resolved
 *   path (peer's context root === this context root) → `VaultError`.
 *
 * On an edit (the peer is already connected) the existing `last_synced_at`
 * watermark is PRESERVED so re-running `connect` to change direction/topics
 * never resets the sync clock.
 *
 * Returns the full updated connection list. Throws `VaultError` on any
 * validation failure (clean message, no stack — the CLI/route map it to a
 * 400/exit-1).
 */
export function addConnection(
  contextRoot: string,
  currentVaultName: string,
  peer: string,
  direction: ConnectionDirection,
  topics: string[] | null,
  home?: string,
): Connection[] {
  if (!isDirection(direction)) {
    throw new VaultError(`Invalid direction "${direction}". Use one of: ${DIRECTIONS.join(', ')}.`);
  }
  if (topics !== null && (!Array.isArray(topics) || !topics.every((t) => typeof t === 'string'))) {
    throw new VaultError('topics must be an array of strings or null.');
  }

  // Self-connect by NAME.
  if (peer === currentVaultName) {
    throw new VaultError('A vault cannot connect to itself.');
  }

  // Peer must be in the registry.
  const registered = listVaults(home).some((v) => v.name === peer);
  if (!registered) {
    throw new VaultError(`Unknown vault "${peer}" — register it first with \`dreamcontext vaults add\`.`);
  }

  // Self-connect by resolved PATH (the peer name differs but points back here).
  // resolveVaultContextRoot can throw if the peer path is stale; that is a real
  // VaultError the caller should see, so it is intentionally not swallowed here.
  const peerRoot = resolveVaultContextRoot(peer, home);
  if (resolve(peerRoot) === resolve(contextRoot)) {
    throw new VaultError('A vault cannot connect to itself.');
  }

  const file = readConnections(contextRoot);
  const existing = file.connections.find((c) => c.vault === peer);
  const next: Connection = {
    vault: peer,
    direction,
    topics,
    // Upsert: preserve the watermark on edit; fresh links start unsynced.
    last_synced_at: existing?.last_synced_at ?? null,
    status: 'active',
  };
  const connections = existing
    ? file.connections.map((c) => (c.vault === peer ? next : c))
    : [...file.connections, next];
  writeConnections(contextRoot, { version: 1, connections });
  return connections;
}

/**
 * Remove the connection to `peer`. NEVER throws. Returns true if a connection
 * was removed, false if none existed.
 */
export function removeConnection(contextRoot: string, peer: string): boolean {
  const file = readConnections(contextRoot);
  const remaining = file.connections.filter((c) => c.vault !== peer);
  if (remaining.length === file.connections.length) return false;
  writeConnections(contextRoot, { version: 1, connections: remaining });
  return true;
}

/**
 * Advance the `last_synced_at` watermark for a peer connection (Phase 3 sync).
 * NEVER throws. Returns true if the connection existed and was updated, false if
 * absent. A `--dry-run` sync NEVER calls this (the watermark must not move).
 */
export function advanceWatermark(contextRoot: string, peer: string, syncedAt: string): boolean {
  const file = readConnections(contextRoot);
  const target = file.connections.find((c) => c.vault === peer);
  if (!target) return false;
  const connections = file.connections.map((c) =>
    c.vault === peer ? { ...c, last_synced_at: syncedAt } : c,
  );
  writeConnections(contextRoot, { version: 1, connections });
  return true;
}

/**
 * True iff the RECEIVER's connections file declares an inbound link back to the
 * sender (`in`/`both` AND not stale). The consent rule (issue #25 LOCKED): a
 * sender may only write into a peer's inbox when that peer has opted to RECEIVE
 * from this sender. Read the RECEIVER's `.connections.json` and check for a
 * connection to `senderVaultName` whose direction accepts inbound.
 */
export function receiverConsents(receiverContextRoot: string, senderVaultName: string): boolean {
  return readConnections(receiverContextRoot).connections.some(
    (c) =>
      c.vault === senderVaultName &&
      (c.direction === 'in' || c.direction === 'both') &&
      c.status !== 'stale',
  );
}

/**
 * Mark a connection `stale` (its peer path went away). NEVER throws. Returns
 * true if the connection existed and is now stale, false if absent.
 */
export function markStale(contextRoot: string, peer: string): boolean {
  const file = readConnections(contextRoot);
  const target = file.connections.find((c) => c.vault === peer);
  if (!target || target.status === 'stale') return false;
  const connections = file.connections.map((c) =>
    c.vault === peer ? { ...c, status: 'stale' as const } : c,
  );
  writeConnections(contextRoot, { version: 1, connections });
  return true;
}
