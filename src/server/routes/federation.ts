import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson } from '../middleware.js';
import {
  drainInbox,
  listConsumedEntries,
  type DigestEntry,
} from '../../lib/federation-inbox.js';
import {
  listConnections,
  receiverConsents,
  type Connection,
} from '../../lib/connections.js';
import { currentVaultTarget } from '../../lib/federation-recall.js';
import { resolveVaultContextRoot, VaultError } from '../../lib/vaults.js';
import { buildInterestProfile, computeDigest, detectConflicts } from '../../lib/federation-digest.js';

// ─────────────────────────────────────────────────────────────────────────────
// PROHIBITION (binding amendment 3): NO server route may import `writeInboxEntry`
// or ANY federation WRITE function (write-to-inbox, ingest, advanceWatermark,
// consumeEntry). `/api/federation/sync` is DRY-RUN BY CONSTRUCTION: it computes
// deltas with READ-ONLY functions only and writes NOTHING. Enforced the same way
// as the version-check no-network rule (documented in
// _dream_context/knowledge/control-plane-api.md). Do not add a write import here.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 10;

/**
 * GET /api/federation/inbox — list pending + consumed digest entries (P3.8).
 * READ-ONLY. `drainInbox` here is a pure read (it never consumes); the dashboard
 * renders provenance from each entry's `origin`.
 */
export async function handleFederationInboxGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { entries, quarantined } = drainInbox(contextRoot);
  const pending: DigestEntry[] = entries.map((e) => e.entry);
  const consumed: DigestEntry[] = listConsumedEntries(contextRoot);
  sendJson(res, 200, {
    pending,
    consumed,
    quarantined: quarantined.map((q) => ({ file: q.file, version: q.version })),
  });
}

interface PeerDelta {
  vault: string;
  consented: boolean;
  stale: boolean;
  entries: Array<{ title: string; kind: DigestEntry['kind']; recallScore: number }>;
}

/**
 * POST /api/federation/sync — PREVIEW the outbound deltas WITHOUT writing (P3.8).
 *
 * DRY-RUN BY CONSTRUCTION: for each out/both peer this computes the digest that
 * WOULD be pushed (read-only `computeDigest`/`detectConflicts`) and returns it.
 * It NEVER calls `writeInboxEntry`, NEVER ingests, and NEVER advances a
 * watermark — none of those functions is even imported (see the prohibition
 * banner above). The CLI `federation sync` is the only write path.
 */
export async function handleFederationSyncPost(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const senderName = currentVaultTarget(dirname(contextRoot)).name;
  const outbound: Connection[] = listConnections(contextRoot).filter(
    (c) => (c.direction === 'out' || c.direction === 'both') && c.status !== 'stale',
  );

  const deltas: PeerDelta[] = [];
  for (const conn of outbound) {
    let peerRoot: string;
    try {
      peerRoot = resolveVaultContextRoot(conn.vault);
    } catch (err) {
      if (err instanceof VaultError) {
        deltas.push({ vault: conn.vault, consented: false, stale: true, entries: [] });
        continue;
      }
      throw err;
    }

    const consented = receiverConsents(peerRoot, senderName);
    if (!consented) {
      deltas.push({ vault: conn.vault, consented: false, stale: false, entries: [] });
      continue;
    }

    const profile = buildInterestProfile(peerRoot, conn.topics);
    let entries = computeDigest(contextRoot, senderName, profile, conn.last_synced_at, DEFAULT_TOP_K);
    entries = detectConflicts(entries, peerRoot);
    deltas.push({
      vault: conn.vault,
      consented: true,
      stale: false,
      entries: entries.map((e) => ({ title: e.title, kind: e.kind, recallScore: e.recallScore })),
    });
  }

  // `dryRun: true` is a CONSTANT — this route can never write.
  sendJson(res, 200, { dryRun: true, deltas });
}
