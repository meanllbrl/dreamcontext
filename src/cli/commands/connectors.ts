import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, success, error } from '../../lib/format.js';
import { maskToken, writeClickUpToken } from '../../lib/task-backend/secrets.js';
import { readSleepHistory } from './sleep.js';
import {
  addConnectorList,
  connectorDue,
  consumeConnectorEvents,
  createConnector,
  getConnector,
  listConnectors,
  readConnectorCache,
  removeConnector,
  removeConnectorList,
} from '../../lib/connectors/store.js';
import { pullConnector } from '../../lib/connectors/clickup-pull.js';
import { ConnectorError, type ClickUpListRef, type ConnectorManifest } from '../../lib/connectors/types.js';

/**
 * `dreamcontext connectors` — the sleep-connector sensory feed CLI (task
 * sleep-connectors). Thin renderer over lib/connectors: manifests are the
 * agreement, caches hold pending events for the sleep flow to distill and
 * `consume`. Credentials resolve inside this process only — sub-agents get
 * cache paths, never secrets.
 */

function handleConnectorsError(err: unknown): void {
  if (err instanceof ConnectorError) {
    error(err.message);
    process.exitCode = 1;
    return;
  }
  error((err as Error).message ?? String(err));
  process.exitCode = 1;
}

/** Repeatable `--list <id[:name]>` accumulator. */
function collectList(value: string, previous: ClickUpListRef[]): ClickUpListRef[] {
  const sep = value.indexOf(':');
  const id = (sep === -1 ? value : value.slice(0, sep)).trim();
  const name = sep === -1 ? null : value.slice(sep + 1).trim() || null;
  return [...previous, { id, name }];
}

function listLabel(l: ClickUpListRef): string {
  return l.name ? `${l.name} (${l.id})` : l.id;
}

function cadenceLabel(m: ConnectorManifest): string {
  const parts: string[] = [];
  if (m.cadence.every_cycles !== null) parts.push(`every ${m.cadence.every_cycles} sleep(s)`);
  if (m.cadence.ttl_hours !== null) parts.push(`ttl ${m.cadence.ttl_hours}h`);
  return parts.join(' | ') || 'default';
}

function requireConnector(contextRoot: string, slug: string): ConnectorManifest {
  const manifest = getConnector(contextRoot, slug);
  if (!manifest) throw new ConnectorError(`Connector not found: ${slug}`);
  return manifest;
}

async function runPull(contextRoot: string, manifest: ConnectorManifest, cycle: number): Promise<void> {
  const outcome = await pullConnector(contextRoot, manifest, { cycle });
  for (const l of outcome.perList) {
    const label = l.name ?? l.id;
    if (l.error) console.log(chalk.red(`  ✗ ${label}: ${l.error}`));
    else console.log(chalk.dim(`  ✓ ${label}: ${l.added} event(s) from ${l.tasksScanned} task(s)${l.truncated ? ' (window truncated)' : ''}`));
  }
  const summary = `${manifest.slug}: +${outcome.added} event(s), ${outcome.pending} pending${outcome.dropped > 0 ? `, ${outcome.dropped} dropped by caps` : ''}`;
  if (outcome.error) error(`${summary} — partial failure: ${outcome.error}`);
  else success(summary);
}

export function registerConnectorsCommand(program: Command): void {
  const connectors = program
    .command('connectors')
    .description('Sleep connectors — external sources the brain observes during sleep');

  connectors
    .command('create <slug>')
    .description('Create a connector (kind: clickup; add one or more lists)')
    .requiredOption('-t, --title <title>', 'Connector title')
    .option('-l, --list <id[:name]>', 'ClickUp list to watch (repeatable)', collectList, [] as ClickUpListRef[])
    .option('--every <cycles>', 'Pull every N sleep cycles', parseFloat)
    .option('--ttl <hours>', 'Also pull when older than N hours', parseFloat)
    .option('--learn <prose>', 'What to extract (fills the ## Learn section)')
    .action((slug: string, opts: { title: string; list: ClickUpListRef[]; every?: number; ttl?: number; learn?: string }) => {
      try {
        const contextRoot = ensureContextRoot();
        const manifest = createConnector(contextRoot, {
          slug,
          title: opts.title,
          kind: 'clickup',
          lists: opts.list,
          every_cycles: opts.every,
          ttl_hours: opts.ttl,
          learn: opts.learn ?? null,
        });
        success(`Connector created: ${manifest.slug} — ${manifest.source.lists.length} list(s), ${cadenceLabel(manifest)}`);
        console.log(chalk.dim(`  Edit the ## Learn section in ${manifest.path} to sharpen what sleep should extract.`));
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('list')
    .description('All connectors with cadence, lists, and pending events')
    .action(() => {
      try {
        const contextRoot = ensureContextRoot();
        const all = listConnectors(contextRoot);
        console.log(header('Connectors'));
        if (all.length === 0) {
          console.log(chalk.dim('  none — `dreamcontext connectors create <slug> --title … --list <id>`'));
          return;
        }
        const cycle = readSleepHistory(contextRoot).length;
        for (const m of all) {
          const cache = readConnectorCache(contextRoot, m.slug);
          const due = connectorDue(m, cache, cycle, Date.now());
          const flags = [
            due.due ? chalk.yellow('due') : chalk.dim('idle'),
            cache.events.length > 0 ? chalk.cyan(`${cache.events.length} pending`) : null,
            cache.error ? chalk.red('error') : null,
          ].filter(Boolean).join(' ');
          console.log(`  ${chalk.bold(m.slug)} — ${m.title} [${flags}]`);
          console.log(chalk.dim(`    ${m.source.lists.map(listLabel).join(', ') || 'no lists'} · ${cadenceLabel(m)} · last pull ${cache.pulledAt ?? 'never'}`));
        }
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('show <slug>')
    .description('One connector: manifest, health, pending events')
    .action((slug: string) => {
      try {
        const contextRoot = ensureContextRoot();
        const m = requireConnector(contextRoot, slug);
        const cache = readConnectorCache(contextRoot, slug);
        console.log(header(`Connector: ${m.slug}`));
        console.log(`  ${m.title} (${m.source.kind}) · ${cadenceLabel(m)} · caps ${m.caps.max_events} events / ${m.caps.max_chars} chars`);
        for (const l of m.source.lists) {
          const cursor = cache.cursors[l.id];
          console.log(chalk.dim(`    list ${listLabel(l)} — cursor ${cursor ? new Date(cursor).toISOString() : 'fresh'}`));
        }
        console.log(`  last pull: ${cache.pulledAt ?? 'never'} · consumed: ${cache.consumedAt ?? 'never'} · pending: ${cache.events.length}`);
        if (cache.error) console.log(chalk.red(`  error: ${cache.error} (${cache.errorAt})`));
        for (const e of cache.events.slice(-10)) {
          console.log(chalk.dim(`    [${e.t}] ${e.list} / ${e.task}${e.author ? ` — ${e.author}` : ''}: ${e.text.slice(0, 100)}`));
        }
        if (cache.events.length > 10) console.log(chalk.dim(`    … ${cache.events.length - 10} more (see ${m.slug}.json)`));
        if (m.body) console.log(`\n${m.body}`);
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('add-list <slug> <listId>')
    .description('Add another ClickUp list to a connector')
    .option('-n, --name <name>', 'Display name for the list')
    .action((slug: string, listId: string, opts: { name?: string }) => {
      try {
        const contextRoot = ensureContextRoot();
        const m = addConnectorList(contextRoot, slug, { id: listId, name: opts.name ?? null });
        success(`List added — ${m.slug} now watches ${m.source.lists.length} list(s): ${m.source.lists.map(listLabel).join(', ')}`);
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('remove-list <slug> <listId>')
    .description('Stop watching a list (its cursor is dropped)')
    .action((slug: string, listId: string) => {
      try {
        const contextRoot = ensureContextRoot();
        const m = removeConnectorList(contextRoot, slug, listId);
        success(`List removed — ${m.slug} watches ${m.source.lists.map(listLabel).join(', ') || 'no lists'}`);
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('token <token>')
    .description('Store the ClickUp API token (shared with task sync; never committed)')
    .action((token: string) => {
      try {
        const contextRoot = ensureContextRoot();
        writeClickUpToken(dirname(contextRoot), token);
        success(`ClickUp token stored (${maskToken(token)}).`);
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('due')
    .description('Which connectors want a pull this cycle (sleep reads this)')
    .action(() => {
      try {
        const contextRoot = ensureContextRoot();
        const cycle = readSleepHistory(contextRoot).length;
        const now = Date.now();
        const due = listConnectors(contextRoot)
          .map((m) => ({ m, status: connectorDue(m, readConnectorCache(contextRoot, m.slug), cycle, now) }))
          .filter((x) => x.status.due);
        if (due.length === 0) {
          console.log(chalk.dim('No connectors due.'));
          return;
        }
        for (const { m, status } of due) console.log(`${m.slug}: ${status.reason}`);
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('pull [slug]')
    .description('Pull one connector, or every due one (--due). Read-only against the source.')
    .option('--due', 'Pull all connectors whose cadence is due')
    .action(async (slug: string | undefined, opts: { due?: boolean }) => {
      try {
        const contextRoot = ensureContextRoot();
        const cycle = readSleepHistory(contextRoot).length;
        if (slug) {
          await runPull(contextRoot, requireConnector(contextRoot, slug), cycle);
          return;
        }
        if (!opts.due) throw new ConnectorError('Name a connector, or pass --due to pull every due one.');
        const now = Date.now();
        const due = listConnectors(contextRoot)
          .filter((m) => connectorDue(m, readConnectorCache(contextRoot, m.slug), cycle, now).due);
        if (due.length === 0) {
          console.log(chalk.dim('No connectors due.'));
          return;
        }
        // Best-effort, sequential: one failing connector never stops the rest.
        for (const m of due) {
          try {
            await runPull(contextRoot, m, cycle);
          } catch (err) {
            error(`${m.slug}: ${(err as Error).message}`);
            process.exitCode = 1;
          }
        }
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('consume <slug>')
    .description('Mark pending events distilled (sleep calls this after updating docs)')
    .action((slug: string) => {
      try {
        const contextRoot = ensureContextRoot();
        const n = consumeConnectorEvents(contextRoot, slug);
        success(`${slug}: ${n} event(s) consumed.`);
      } catch (err) {
        handleConnectorsError(err);
      }
    });

  connectors
    .command('remove <slug>')
    .description('Remove a connector and its cache')
    .action((slug: string) => {
      try {
        const contextRoot = ensureContextRoot();
        removeConnector(contextRoot, slug);
        success(`Connector removed: ${slug}`);
      } catch (err) {
        handleConnectorsError(err);
      }
    });
}
