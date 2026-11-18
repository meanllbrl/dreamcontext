/**
 * `dreamcontext plugins list | install <id> | remove <id>` (Mağaza D1, C3).
 *
 * The installed set is team data (`overrides/plugins/<id>.json`): an install or remove here
 * reaches teammates with the next brain sync or commit. Remove hides, never deletes: the
 * plugin's files stay, recall keeps finding them, every read keeps answering.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, header, info, success, warn } from '../../lib/format.js';
import { PLUGINS } from '../../lib/plugins/registry.js';
import {
  installPlugin,
  pluginStatuses,
  readPins,
  removePlugin,
  unknownEntryFiles,
  PluginEntryConflictError,
  UnknownPluginError,
  type PluginStatus,
} from '../../lib/plugins/store.js';
import { automationsUsingPlugin } from '../../lib/plugins/automations.js';

function why(s: PluginStatus): string {
  if (s.conflict) return `çakışma var · ${s.file} (edit it to one side and commit)`;
  if (s.error) return `unreadable ${s.file}: ${s.error}; ${s.hasData ? 'has data' : 'no data'}`;
  if (s.source === 'chosen' && s.entry) return `chosen by ${s.entry.by} ${s.entry.at}`;
  if (s.source === 'data') return s.id === 'hypotheses' ? "has data (this Mac's learning switch)" : 'has data';
  return 'no data';
}

function handle(err: unknown): void {
  if (err instanceof PluginEntryConflictError || err instanceof UnknownPluginError) {
    error(err.message);
    process.exitCode = 1;
    return;
  }
  throw err;
}

export function registerPluginsCommand(program: Command): void {
  const cmd = program
    .command('plugins')
    .description('Installable features (Mağaza): list, install, remove. The installed set is shared with the team.');

  cmd
    .command('list')
    .option('--json', 'Machine-readable output')
    .description('Every plugin: installed or not, and why')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const statuses = pluginStatuses(root);
      const pins = readPins(root, statuses.filter((s) => s.installed).map((s) => s.id));
      if (opts.json) {
        console.log(JSON.stringify({
          plugins: statuses.map((s) => ({
            id: s.id,
            label: PLUGINS.find((p) => p.id === s.id)!.label,
            installed: s.installed,
            source: s.source,
            hasData: s.hasData,
            pinned: pins.includes(s.id),
            why: why(s),
            ...(s.conflict ? { conflict: true, file: s.file } : {}),
            ...(s.error ? { error: s.error, file: s.file } : {}),
          })),
          unknownEntries: unknownEntryFiles(root),
        }, null, 2));
        return;
      }
      console.log(header('Plugins'));
      for (const s of statuses) {
        const def = PLUGINS.find((p) => p.id === s.id)!;
        const mark = s.installed ? chalk.green('✓ installed') : chalk.dim('· not installed');
        console.log(`  ${chalk.cyan(s.id.padEnd(11))} ${def.label.padEnd(11)} ${mark}  ${chalk.dim(why(s))}`);
      }
      for (const file of unknownEntryFiles(root)) {
        console.log(chalk.dim(`  (left alone: ${file}, a plugin this CLI does not know)`));
      }
      console.log();
      info('Install: dreamcontext plugins install <id> · Remove (keeps the data): dreamcontext plugins remove <id>');
    });

  cmd
    .command('install')
    .argument('<id>', `Plugin id (${PLUGINS.map((p) => p.id).join(', ')})`)
    .description('Install a plugin for this project and its team')
    .action((id: string) => {
      const root = ensureContextRoot();
      try {
        const r = installPlugin(root, id);
        if (r.mirrorError) warn(`learning.enabled mirror not written: ${r.mirrorError}`);
        success(`${id} installed. Its page, snapshot section, sleep step and commands are on; your next brain sync carries it to the team.`);
      } catch (err) {
        handle(err);
      }
    });

  cmd
    .command('remove')
    .argument('<id>', 'Plugin id')
    .description('Remove a plugin (hides it; its data stays and stays readable)')
    .action((id: string) => {
      const root = ensureContextRoot();
      try {
        const affected = automationsUsingPlugin(root, id);
        const r = removePlugin(root, id);
        if (r.mirrorError) warn(`learning.enabled mirror not written: ${r.mirrorError}`);
        success(`${id} removed. Its data stays and stays readable; install it again to bring it all back.`);
        if (affected.length > 0) {
          warn(`These automations run ${id} commands and will now fail with plugin_not_installed:`);
          for (const a of affected) console.log(`  ${chalk.cyan(a.slug)}  ${a.title}${a.enabled ? '' : chalk.dim(' (paused)')}`);
        }
      } catch (err) {
        handle(err);
      }
    });
}
