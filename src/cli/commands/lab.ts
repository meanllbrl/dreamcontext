import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { success, error, header, warn } from '../../lib/format.js';
import { createInsight, getInsight, listInsights, readCache, writeInsightTweaks } from '../../lib/lab/store.js';
import { syncInsight, syncAll } from '../../lib/lab/sync.js';
import { writeCredential, listCredentialNames } from '../../lib/lab/credentials.js';
import { gitignoreCovers } from '../../lib/gitignore.js';
import { LabError, type Render } from '../../lib/lab/types.js';

/**
 * `dreamcontext lab` — the analytics-insights subsystem CLI. Mirrors `roadmap`:
 * a thin renderer over the same store/sync engine the dashboard's `/api/lab*`
 * routes call, so behaviour never drifts between CLI and UI.
 */

/** Resolve the project root that holds `_dream_context/` (secrets file location). */
function projectRootFor(contextRoot: string): string {
  return dirname(contextRoot);
}

function handleLabError(err: unknown): void {
  if (err instanceof LabError) {
    error(err.message);
    process.exitCode = 1;
    return;
  }
  error((err as Error).message ?? String(err));
  process.exitCode = 1;
}

export function registerLabCommand(program: Command): void {
  const lab = program
    .command('lab')
    .description('Analytics insights: curated metrics from HTTP APIs or scripts, synced into the brain');

  lab
    .command('sync')
    .argument('[slug]', 'Insight slug to sync (omit with --all)')
    .description('Sync one insight, or every insight with --all')
    .option('--all', 'Sync every insight')
    .option('--force', 'Refetch even if the cached snapshot is still within its TTL')
    .action(async (slug: string | undefined, opts: { all?: boolean; force?: boolean }) => {
      const root = ensureContextRoot();
      if (!opts.all && !slug) {
        error('Provide an insight slug, or pass --all to sync every insight.');
        process.exitCode = 1;
        return;
      }
      try {
        if (opts.all) {
          const { results, failed } = await syncAll(root, { force: opts.force });
          for (const r of results) {
            if (r.status === 'ok') success(`${r.slug}: synced (latest=${r.latest ?? 'n/a'}, ${r.granularity})`);
            else if (r.status === 'fresh') console.log(chalk.dim(`  ${r.slug}: fresh (skipped)`));
            else error(`${r.slug}: ${r.error}`);
          }
          console.log();
          if (failed.length > 0) {
            error(`${failed.length} of ${results.length} insight(s) failed to sync.`);
            process.exitCode = 1;
          } else {
            success(`Synced ${results.length} insight(s).`);
          }
          return;
        }
        const result = await syncInsight(root, slug!, { force: opts.force });
        if (result.status === 'ok') success(`${result.slug}: synced (latest=${result.latest ?? 'n/a'}, ${result.granularity})`);
        else if (result.status === 'fresh') console.log(chalk.dim(`  ${result.slug}: fresh (skipped) — use --force to refetch.`));
        else {
          error(`${result.slug}: ${result.error}`);
          process.exitCode = 1;
        }
      } catch (err) {
        handleLabError(err);
      }
    });

  lab
    .command('list')
    .description('List insights with their latest value and staleness')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const insights = listInsights(root);
      if (opts.json) {
        console.log(JSON.stringify(insights.map((m) => ({ ...m, source: m.source })), null, 2));
        return;
      }
      console.log(header('Lab Insights'));
      if (insights.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext lab create <slug> --title "..." --render number --adapter http)'));
        return;
      }
      for (const m of insights) {
        const cache = readCache(root, m.slug);
        const latest = cache?.latest !== null && cache?.latest !== undefined ? String(cache.latest) : '—';
        const staleness = cache?.fetchedAt
          ? `fetched ${cache.fetchedAt}`
          : 'never synced';
        const errBadge = cache?.error ? chalk.red(' ⚠ error') : '';
        console.log(`  ${chalk.magentaBright(m.slug)} — ${m.title} · ${latest}${m.unit ? ` ${m.unit}` : ''} · ${chalk.dim(staleness)}${errBadge}`);
      }
    });

  lab
    .command('show')
    .argument('<slug>', 'Insight slug')
    .description('Show the cached snapshot for one insight (no fetch)')
    .option('--json', 'Emit as JSON')
    .action((slug: string, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const manifest = getInsight(root, slug);
      if (!manifest) {
        error(`Insight not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      const cache = readCache(root, slug);
      if (opts.json) {
        console.log(JSON.stringify({ manifest, cache }, null, 2));
        return;
      }
      console.log(header(`Insight: ${slug}`));
      console.log(`  title: ${manifest.title}`);
      console.log(`  render: ${manifest.render}`);
      console.log(`  group: ${manifest.group ?? '(none)'}`);
      if (cache) {
        console.log(`  latest: ${cache.latest ?? '—'}${manifest.unit ? ` ${manifest.unit}` : ''}`);
        console.log(`  granularity: ${cache.granularity}`);
        console.log(`  fetchedAt: ${cache.fetchedAt || '(never)'}`);
        if (cache.error) console.log(chalk.red(`  error: ${cache.error}`));
      } else {
        console.log(chalk.dim('  (no cache yet — run `dreamcontext lab sync ' + slug + '`)'));
      }
    });

  lab
    .command('create')
    .argument('<slug>', 'Kebab-case insight slug (e.g. weekly-active-users)')
    .description('Scaffold a new insight manifest in lab/insights/<slug>.md')
    .requiredOption('--title <title>', 'Insight title')
    .option('--group <group>', 'Dashboard section this insight groups under')
    .option('--render <render>', 'number|line|pie|raw (default number)')
    .option('--adapter <adapter>', 'http|script (default http)')
    .option('--unit <unit>', 'Display unit (e.g. "users")')
    .option('--ttl <minutes>', 'Cache TTL in minutes (default 1440)')
    .action((slug: string, opts: { title: string; group?: string; render?: string; adapter?: string; unit?: string; ttl?: string }) => {
      const root = ensureContextRoot();
      try {
        const m = createInsight(root, {
          slug,
          title: opts.title,
          group: opts.group ?? null,
          render: (opts.render as Render) ?? 'number',
          adapter: (opts.adapter as 'http' | 'script') ?? 'http',
          unit: opts.unit ?? null,
          ttl_minutes: opts.ttl ? Number(opts.ttl) : undefined,
        });
        success(`Insight created: lab/insights/${m.slug}.md`);
        console.log(chalk.dim('  Edit the manifest to set the real endpoint/extract config, then `dreamcontext lab sync ' + m.slug + '`.'));
      } catch (err) {
        handleLabError(err);
      }
    });

  lab
    .command('tweak')
    .argument('<slug>', 'Insight slug')
    .argument('<key>', 'Declared tweak key')
    .argument('<value>', 'New value')
    .description('Set one tweak value on an insight')
    .action((slug: string, key: string, value: string) => {
      const root = ensureContextRoot();
      try {
        writeInsightTweaks(root, slug, { [key]: value });
        success(`${slug}: tweak "${key}" set to "${value}".`);
      } catch (err) {
        handleLabError(err);
      }
    });

  const credentials = lab
    .command('credentials')
    .description('Manage lab/credentials.json (gitignore-first — never printed back)');

  credentials
    .command('set')
    .argument('<key>', 'Credential key (referenced by manifests as {{cred:key}})')
    .description('Store a credential value (hidden prompt; --value is shell-history-risky)')
    .option('--value <value>', 'Provide the value directly (visible in shell history — prefer the interactive prompt)')
    .action(async (key: string, opts: { value?: string }) => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);
      try {
        const value = opts.value ?? await password({ message: `Value for credential "${key}":` });
        if (!value || !value.trim()) {
          error('A non-empty value is required.');
          process.exitCode = 1;
          return;
        }
        writeCredential(projectRoot, root, key, value);
        success(`Credential "${key}" stored in lab/credentials.json (mode 0600, gitignored).`);
      } catch (err) {
        handleLabError(err);
      }
    });

  credentials
    .command('list')
    .description('List credential KEY NAMES only — values are never printed')
    .action(() => {
      const root = ensureContextRoot();
      const names = listCredentialNames(root);
      console.log(header('Lab Credentials (names only)'));
      if (names.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext lab credentials set <key>)'));
        return;
      }
      for (const name of names) console.log(`  ${chalk.magentaBright(name)}`);
      // Self-heal nudge: warn if the file exists but isn't covered by a gitignore.
      const projectRoot = projectRootFor(root);
      const covered = gitignoreCovers(root, ['lab/credentials.json'])
        || gitignoreCovers(projectRoot, ['_dream_context/lab/credentials.json']);
      if (!covered) {
        warn('lab/credentials.json is not covered by a governing .gitignore — run `dreamcontext doctor` then re-run `lab credentials set` to self-heal.');
      }
    });
}
