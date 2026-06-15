import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { currentVaultTarget } from '../../lib/federation-recall.js';
import {
  addConnection,
  listConnections,
  removeConnection,
  type ConnectionDirection,
} from '../../lib/connections.js';
import { VaultError } from '../../lib/vaults.js';
import { refreshPeerSummaries } from '../../lib/federation-peer-summary.js';
import { header, success, error, info, formatTable } from '../../lib/format.js';

const DIRECTIONS: ConnectionDirection[] = ['out', 'in', 'both'];

/**
 * Refresh the ambient peer-summary cache after a read relationship changes, so a
 * freshly-drawn (or removed) connection updates the snapshot's "Connected
 * projects" section immediately. NEVER throws — a refresh failure must not fail
 * the connect/disconnect that just succeeded.
 */
function refreshPeerSummariesQuietly(contextRoot: string): void {
  try {
    refreshPeerSummaries(contextRoot);
  } catch {
    // Best-effort: ambient awareness refresh must never break the command.
  }
}

/** Resolve the current vault's registered name (or basename) from its context root. */
function currentVaultName(contextRoot: string): string {
  return currentVaultTarget(dirname(contextRoot)).name;
}

/**
 * Register the federation connection verbs (issue #25 P2.1):
 *   - `connect <vault> --direction <out|in|both> [--topics a,b]`
 *   - `disconnect <vault>`
 *   - `connections list`
 *
 * Connections are an OUTGOING mesh stored in `state/.connections.json`; they
 * gate the digest flow (Phase 3) and the `--connected` recall span (Phase 2).
 */
export function registerConnectionsCommand(program: Command): void {
  // ─── connect ─────────────────────────────────────────────────────────────────
  program
    .command('connect <vault>')
    .description('Connect this vault to a peer for federation (out|in|both)')
    .option('-d, --direction <direction>', 'Connection direction: out | in | both', 'both')
    .option('--topics <list>', 'Comma-separated topic filter (default: all topics)')
    .action((vault: string, opts: { direction?: string; topics?: string }) => {
      const contextRoot = ensureContextRoot();
      const direction = (opts.direction ?? 'both').toLowerCase();
      if (!(DIRECTIONS as string[]).includes(direction)) {
        error(`Unknown direction '${opts.direction}'.`, `Use one of: ${DIRECTIONS.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      const parsed = opts.topics
        ? opts.topics.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const topics = parsed.length > 0 ? parsed : null;

      try {
        addConnection(
          contextRoot,
          currentVaultName(contextRoot),
          vault,
          direction as ConnectionDirection,
          topics,
        );
        success(
          `Connected to "${vault}" (${direction}${topics ? `, topics: ${topics.join(', ')}` : ''}).`,
        );
        // A new read relationship → refresh ambient awareness immediately.
        refreshPeerSummariesQuietly(contextRoot);
      } catch (err) {
        if (err instanceof VaultError) {
          error(err.message);
        } else {
          error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exitCode = 1;
      }
    });

  // ─── disconnect ──────────────────────────────────────────────────────────────
  program
    .command('disconnect <vault>')
    .description('Remove a federation connection to a peer')
    .action((vault: string) => {
      const contextRoot = ensureContextRoot();
      const removed = removeConnection(contextRoot, vault);
      if (removed) {
        success(`Disconnected from "${vault}".`);
        // A removed read relationship → refresh ambient awareness immediately.
        refreshPeerSummariesQuietly(contextRoot);
      } else {
        info(`No connection to "${vault}".`);
        process.exitCode = 1;
      }
    });

  // ─── connections list ────────────────────────────────────────────────────────
  const connections = program
    .command('connections')
    .description('Inspect cross-project federation connections');

  connections
    .command('list', { isDefault: true })
    .description("List this vault's federation connections")
    .action(() => {
      const contextRoot = ensureContextRoot();
      const all = listConnections(contextRoot);
      if (all.length === 0) {
        console.log(chalk.dim('(no connections)'));
        info(chalk.dim('Add one with `dreamcontext connect <vault> --direction <out|in|both>`.'));
        return;
      }
      console.log(header('Federation Connections'));
      const rows = all.map((c) => [
        c.vault,
        c.direction,
        c.topics && c.topics.length > 0 ? c.topics.join(', ') : '(all)',
        c.status,
        c.last_synced_at ?? 'never',
      ]);
      console.log(
        formatTable(['Vault', 'Direction', 'Topics', 'Status', 'Last synced'], rows, {
          statusCol: 3,
        }),
      );
    });
}
