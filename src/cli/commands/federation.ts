import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { currentVaultTarget } from '../../lib/federation-recall.js';
import {
  listConnections,
  advanceWatermark,
  markStale,
  receiverConsents,
  type Connection,
} from '../../lib/connections.js';
import { resolveVaultContextRoot, VaultError } from '../../lib/vaults.js';
import {
  drainInbox,
  consumeEntry,
  pendingInboxCount,
  writeInboxEntry,
  listConsumedEntries,
} from '../../lib/federation-inbox.js';
import { ingestEntry } from '../../lib/federation-ingest.js';
import {
  buildInterestProfile,
  computeDigest,
  detectConflicts,
} from '../../lib/federation-digest.js';
import { header, success, info, warn } from '../../lib/format.js';

/** Default number of entries pushed per peer per sync. */
const DEFAULT_TOP_K = 10;

/** Resolve the current vault's registered name (or basename). */
function currentVaultName(contextRoot: string): string {
  return currentVaultTarget(dirname(contextRoot)).name;
}

/** Connections this vault can SEND digests over (out/both, not stale). */
function outboundConnections(contextRoot: string): Connection[] {
  return listConnections(contextRoot).filter(
    (c) => (c.direction === 'out' || c.direction === 'both') && c.status !== 'stale',
  );
}

/**
 * Register the federation digest verbs (issue #25 P3):
 *   - `federation drain`        — ingest inbox entries, move them to consumed/.
 *   - `federation sync [--dry-run]` — push recall-filtered digests to peers.
 *   - `federation status`       — inbox counts + per-connection watermarks.
 */
export function registerFederationCommand(program: Command): void {
  const federation = program
    .command('federation')
    .description('Sleep-driven cross-project federation: drain inbox, sync digests');

  // ─── drain ─────────────────────────────────────────────────────────────────
  federation
    .command('drain')
    .description('Ingest pending inbox entries as first-class knowledge, then consume them')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const { entries, quarantined } = drainInbox(contextRoot);

      if (entries.length === 0 && quarantined.length === 0) {
        info(chalk.dim('Federation inbox is empty — nothing to drain.'));
        return;
      }

      let ingested = 0;
      let collisions = 0;
      let conflicts = 0;
      for (const { file, entry } of entries) {
        try {
          const result = ingestEntry(contextRoot, entry);
          ingested++;
          if (result.collided) collisions++;
          if (result.bookmarked) conflicts++;
          // Only consume AFTER a successful ingest (atomic move → never re-drained).
          consumeEntry(contextRoot, file);
        } catch (err) {
          warn(`Could not ingest "${file}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log(header('Federation Drain'));
      success(`Ingested ${ingested} entr${ingested === 1 ? 'y' : 'ies'} as first-class knowledge.`);
      if (collisions > 0) {
        info(`${collisions} slug collision(s) namespaced as knowledge/<slug>--from-<vault>.md.`);
      }
      if (conflicts > 0) {
        warn(`${conflicts} conflict-note(s) surfaced as bookmarks — review manually (NOT auto-resolved).`);
      }
      if (quarantined.length > 0) {
        warn(
          `${quarantined.length} entr${quarantined.length === 1 ? 'y' : 'ies'} quarantined ` +
            `(incompatible schema) — left in place: ${quarantined.map((q) => q.file).join(', ')}.`,
        );
      }
    });

  // ─── sync ──────────────────────────────────────────────────────────────────
  federation
    .command('sync')
    .description('Push recall-filtered digests into consenting peers’ inboxes')
    .option('--dry-run', 'Compute + print the digests but write NOTHING (watermark not advanced)')
    .action((opts: { dryRun?: boolean }) => {
      const contextRoot = ensureContextRoot();
      const dryRun = opts.dryRun === true;
      const senderName = currentVaultName(contextRoot);
      const outbound = outboundConnections(contextRoot);

      console.log(header(dryRun ? 'Federation Sync (dry-run)' : 'Federation Sync'));
      if (outbound.length === 0) {
        info(chalk.dim('No out/both connections — nothing to sync.'));
        return;
      }

      const syncedAt = new Date().toISOString();
      let pushedPeers = 0;

      for (const conn of outbound) {
        let peerRoot: string;
        try {
          peerRoot = resolveVaultContextRoot(conn.vault);
        } catch (err) {
          if (err instanceof VaultError) {
            warn(`Peer "${conn.vault}" is unreachable — skipping (stale).`);
            if (!dryRun) markStale(contextRoot, conn.vault);
            continue;
          }
          throw err;
        }

        // CONSENT (binding): only write if the RECEIVER declares in/both back to us.
        if (!receiverConsents(peerRoot, senderName)) {
          info(
            chalk.dim(
              `Peer "${conn.vault}" has not consented (no in/both link back to "${senderName}") — skipped.`,
            ),
          );
          continue;
        }

        const profile = buildInterestProfile(peerRoot, conn.topics);
        let entries = computeDigest(
          contextRoot,
          senderName,
          profile,
          conn.last_synced_at,
          DEFAULT_TOP_K,
        );
        entries = detectConflicts(entries, peerRoot);

        if (entries.length === 0) {
          info(chalk.dim(`Peer "${conn.vault}": no new entries since last sync.`));
          if (!dryRun) advanceWatermark(contextRoot, conn.vault, syncedAt);
          continue;
        }

        if (dryRun) {
          console.log(chalk.cyan(`\n  ${conn.vault} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} would be pushed:`));
          for (const e of entries) {
            const tag = e.kind === 'conflict-note' ? chalk.yellow(' [conflict-note]') : '';
            console.log(`    - ${e.title}${tag}`);
          }
          pushedPeers++;
          // Dry-run: NEVER write, NEVER advance the watermark.
          continue;
        }

        let written = 0;
        for (const entry of entries) {
          // Provenance proves intended receiver via the registry-resolved peer root.
          if (writeInboxEntry(peerRoot, entry).written) written++;
        }
        advanceWatermark(contextRoot, conn.vault, syncedAt);
        pushedPeers++;
        success(`Pushed ${written} new entr${written === 1 ? 'y' : 'ies'} to "${conn.vault}".`);
      }

      if (pushedPeers === 0) {
        info(chalk.dim('No consenting peers with new entries.'));
      } else if (dryRun) {
        info(chalk.dim('Dry-run complete — nothing written, no watermarks advanced.'));
      }
    });

  // ─── status ────────────────────────────────────────────────────────────────
  federation
    .command('status')
    .description('Show inbox counts and per-connection sync watermarks')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const pending = pendingInboxCount(contextRoot);
      const consumed = listConsumedEntries(contextRoot).length;
      const connections = listConnections(contextRoot);

      console.log(header('Federation Status'));
      console.log(`  Inbox: ${chalk.bold(String(pending))} pending, ${consumed} consumed.`);
      if (connections.length === 0) {
        info(chalk.dim('  No connections.'));
        return;
      }
      console.log('  Connections:');
      for (const c of connections) {
        const watermark = c.last_synced_at ?? chalk.dim('never');
        const staleTag = c.status === 'stale' ? chalk.red(' (stale)') : '';
        console.log(`    - ${c.vault} [${c.direction}]${staleTag} — last synced: ${watermark}`);
      }
    });
}
