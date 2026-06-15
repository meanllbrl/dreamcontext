import { Command } from 'commander';
import { realpathSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { ensureContextRoot } from '../../lib/context-path.js';
import { listConnections } from '../../lib/connections.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { pendingInboxCount, listConsumedEntries } from '../../lib/federation-inbox.js';
import { refreshPeerSummaries } from '../../lib/federation-peer-summary.js';
import { header, success, info, warn } from '../../lib/format.js';

/**
 * Federation is READ-ONLY (live reference). A connection means "this vault may
 * READ a shareable peer's CANONICAL docs at recall time" — nothing is ever
 * copied across a vault boundary. The copy-based digest path (`sync` push +
 * `drain` ingest) is PARKED on the roadmap pending a redesign: it produced
 * lossy, write-once-stale duplicates that broke single-source-of-truth. The
 * `sync`/`drain` verbs remain registered but are INERT so any lingering
 * sleep-cycle / hook invocation is a harmless no-op, never a silent copy.
 */
const SYNC_DISABLED_NOTE =
  'Federation is read-only (live reference). Copy-based sync/drain is parked on the roadmap — ' +
  'nothing was copied. Peers are read live during recall; clean up old copies with ' +
  '`dreamcontext federation purge`.';

/**
 * Register the federation verbs (issue #25, read-only):
 *   - `federation peers`  — refresh + print compact summaries of readable peers.
 *   - `federation status` — connection list + leftover federated-copy count.
 *   - `federation purge`  — remove leftover `federated:true` copies (deliberate).
 *   - `federation sync` / `federation drain` — INERT (roadmap; print a note).
 */
export function registerFederationCommand(program: Command): void {
  const federation = program
    .command('federation')
    .description('Cross-project federation: read peers live; manage leftover copies');

  // ─── drain (inert — roadmap) ─────────────────────────────────────────────────
  federation
    .command('drain')
    .description('(disabled) copy-based ingest is parked on the roadmap — no-op')
    .action(() => {
      ensureContextRoot();
      info(chalk.dim(SYNC_DISABLED_NOTE));
    });

  // ─── sync (inert — roadmap) ──────────────────────────────────────────────────
  federation
    .command('sync')
    .description('(disabled) copy-based push is parked on the roadmap — no-op')
    .option('--dry-run', '(ignored — sync is disabled)')
    .action(() => {
      ensureContextRoot();
      info(chalk.dim(SYNC_DISABLED_NOTE));
    });

  // ─── peers ───────────────────────────────────────────────────────────────────
  federation
    .command('peers')
    .description('Refresh + print compact summaries of readable peers (ambient awareness)')
    .action(() => {
      const contextRoot = ensureContextRoot();
      // The REAL peer-read path (off the snapshot hot path): resolves readable
      // peers, reads each peer's core files, and writes the local cache the
      // snapshot's "Connected projects" section is fed from.
      const peers = refreshPeerSummaries(contextRoot);

      console.log(header('Federation Peers'));
      if (peers.length === 0) {
        info(
          chalk.dim(
            'No readable peers (need an out/both connection to a shareable vault). ' +
              'Connect with `dreamcontext connect <vault> --direction out`.',
          ),
        );
        return;
      }
      for (const p of peers) {
        console.log(chalk.bold(`\n  ${p.vault}`) + (p.whatItIs ? chalk.dim(` — ${p.whatItIs}`) : ''));
        for (const act of p.lastActivity) console.log(`    Last: ${act}`);
        if (p.activeTask) console.log(`    In progress: ${p.activeTask}`);
        if (p.topTags.length > 0) console.log(chalk.dim(`    Tags: ${p.topTags.join(', ')}`));
      }
      console.log('');
      info(
        chalk.dim(
          'Recall surfaces these peers’ canonical docs live. Search one directly: ' +
            '`dreamcontext memory recall <q> --vault <name>`.',
        ),
      );
    });

  // ─── purge ─────────────────────────────────────────────────────────────────
  federation
    .command('purge')
    .description('Remove leftover federated copies (knowledge/*.md with federated:true)')
    .option('--vault <name>', 'Only remove copies whose origin.vault matches this name')
    .option('--all', 'Remove every federated copy in this vault')
    .option('--dry-run', 'List what would be removed without deleting')
    .action((opts: { vault?: string; all?: boolean; dryRun?: boolean }) => {
      const contextRoot = ensureContextRoot();
      if (!opts.vault && !opts.all) {
        warn('Specify --all (remove every federated copy) or --vault <name> (one origin).');
        process.exitCode = 1;
        return;
      }

      const found = findFederatedCopies(contextRoot, opts.vault);
      console.log(header(opts.dryRun ? 'Federation Purge (dry-run)' : 'Federation Purge'));
      if (found.length === 0) {
        info(chalk.dim('No federated copies found — nothing to purge.'));
        return;
      }

      let removed = 0;
      for (const f of found) {
        if (opts.dryRun) {
          console.log(`  would remove: ${f.relPath}${f.originVault ? chalk.dim(` (from ${f.originVault})`) : ''}`);
          continue;
        }
        try {
          unlinkSync(f.path);
          removed++;
          console.log(`  removed: ${f.relPath}${f.originVault ? chalk.dim(` (from ${f.originVault})`) : ''}`);
        } catch (err) {
          warn(`Could not remove ${f.relPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (opts.dryRun) {
        info(chalk.dim(`${found.length} federated cop${found.length === 1 ? 'y' : 'ies'} would be removed.`));
      } else {
        success(`Purged ${removed} federated cop${removed === 1 ? 'y' : 'ies'}.`);
      }
    });

  // ─── status ────────────────────────────────────────────────────────────────
  federation
    .command('status')
    .description('Show connections + any leftover federated copies')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const connections = listConnections(contextRoot);
      const copies = findFederatedCopies(contextRoot).length;
      // Legacy inbox counters — surfaced only so a user with a pre-existing inbox
      // knows it is now inert (sync/drain disabled).
      const pending = pendingInboxCount(contextRoot);
      const consumed = listConsumedEntries(contextRoot).length;

      console.log(header('Federation Status'));
      info(chalk.dim('Mode: read-only (live reference). Copy-based sync is parked on the roadmap.'));
      if (connections.length === 0) {
        info(chalk.dim('  No connections.'));
      } else {
        console.log('  Connections (read):');
        for (const c of connections) {
          const reads = c.direction === 'out' || c.direction === 'both';
          const staleTag = c.status === 'stale' ? chalk.red(' (stale)') : '';
          const tag = reads ? chalk.green('reads') : chalk.dim('no-read');
          console.log(`    - ${c.vault} [${c.direction}] ${tag}${staleTag}`);
        }
      }
      if (copies > 0) {
        warn(`  ${copies} leftover federated cop${copies === 1 ? 'y' : 'ies'} — remove with \`dreamcontext federation purge --all\`.`);
      }
      if (pending > 0 || consumed > 0) {
        info(chalk.dim(`  Legacy inbox: ${pending} pending, ${consumed} consumed (inert — sync disabled).`));
      }
    });
}

export interface FederatedCopy {
  path: string;
  relPath: string;
  originVault: string | null;
}

/**
 * Find every `federated: true` knowledge doc in the vault, optionally filtered to
 * one `origin.vault`. These are the leftover copies a prior copy-based sync wrote;
 * read-only federation never creates them. Never throws — unreadable files skip.
 */
export function findFederatedCopies(contextRoot: string, originVault?: string): FederatedCopy[] {
  const knowledgeDir = join(contextRoot, 'knowledge');
  let files: string[];
  try {
    // followSymbolicLinks:false + an explicit realpath escape guard below: this
    // result feeds `unlinkSync`, so a symlink inside knowledge/ pointing outside
    // the vault must never let purge delete an out-of-vault file.
    files = fg.sync('**/*.md', { cwd: knowledgeDir, absolute: true, followSymbolicLinks: false });
  } catch {
    return [];
  }
  // Resolve the base too, so the escape check is symlink-consistent (e.g. macOS
  // /var → /private/var) and only a TRUE escape out of knowledge/ is rejected.
  let guard: string;
  try {
    guard = realpathSync(knowledgeDir) + sep;
  } catch {
    return [];
  }
  const out: FederatedCopy[] = [];
  for (const file of files) {
    try {
      // Resolve symlinks and reject anything that escapes the knowledge dir.
      if (!realpathSync(file).startsWith(guard)) continue;
      const { data } = readFrontmatter(file);
      if (data.federated !== true) continue;
      const origin =
        data.origin && typeof data.origin === 'object'
          ? ((data.origin as Record<string, unknown>).vault as string | undefined)
          : undefined;
      if (originVault && origin !== originVault) continue;
      out.push({
        path: file,
        relPath: `knowledge/${file.slice(knowledgeDir.length + 1)}`,
        originVault: origin ?? null,
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}
