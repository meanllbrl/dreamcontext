import { Command } from 'commander';
import { basename, resolve } from 'node:path';
import chalk from 'chalk';
import { addVault, listVaults, removeVault, VaultError } from '../../lib/vaults.js';
import { discoverVaults } from '../../lib/vault-discovery.js';
import { slugify } from '../../lib/id.js';
import { success, error, info, header } from '../../lib/format.js';

export function registerVaultsCommand(program: Command): void {
  const vaults = program
    .command('vaults')
    .description('Manage the global vault registry (multi-project)');

  // ─── add ───────────────────────────────────────────────────────────────────
  vaults
    .command('add')
    .argument('<name>', 'Vault name (unique identifier)')
    .argument('<path>', 'Path to the project directory (must contain _dream_context/)')
    .description('Register a project directory as a vault')
    .action((name: string, dirPath: string) => {
      try {
        const vault = addVault(name, dirPath);
        success(`Registered vault "${vault.name}" at ${vault.path}`);
      } catch (err) {
        if (err instanceof VaultError) {
          error(err.message);
        } else {
          error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(1);
      }
    });

  // ─── list ──────────────────────────────────────────────────────────────────
  vaults
    .command('list')
    .description('List all registered vaults')
    .action(() => {
      const all = listVaults();
      if (all.length === 0) {
        console.log(chalk.dim('(none)'));
        return;
      }

      console.log(header('Registered Vaults'));
      for (const v of all) {
        console.log(`  ${chalk.magentaBright(v.name)}  ${chalk.dim(v.path)}`);
      }
    });

  // ─── discover ────────────────────────────────────────────────────────────────
  vaults
    .command('discover [root]')
    .description('Find every _dream_context/ project under a directory tree (node_modules ignored)')
    .option('--register', 'Register newly-found projects as vaults (idempotent; already-registered skipped)')
    .action((root: string | undefined, opts: { register?: boolean }) => {
      const searchRoot = resolve(root ?? process.cwd());
      const found = discoverVaults(searchRoot);

      if (found.length === 0) {
        info(`No dreamcontext projects found under ${searchRoot}.`);
        return;
      }

      if (!opts.register) {
        console.log(header(`Discovered ${found.length} project${found.length === 1 ? '' : 's'}`));
        for (const projectPath of found) {
          console.log(`  ${chalk.magentaBright(basename(projectPath))}  ${chalk.dim(projectPath)}`);
        }
        info(chalk.dim('Re-run with --register to add the new ones to the vault registry.'));
        return;
      }

      // --register: idempotent. Already-registered paths are skipped (never an
      // error); a name collision is resolved by suffixing -2, -3, … so two
      // sibling "app" dirs both register cleanly.
      const registered = new Set(listVaults().map((v) => resolve(v.path)));
      const takenNames = new Set(listVaults().map((v) => v.name));
      let added = 0;
      let skipped = 0;

      for (const projectPath of found) {
        if (registered.has(resolve(projectPath))) {
          skipped++;
          continue;
        }
        const base = slugify(basename(projectPath)) || 'vault';
        let name = base;
        let suffix = 2;
        while (takenNames.has(name)) name = `${base}-${suffix++}`;
        try {
          const vault = addVault(name, projectPath);
          takenNames.add(vault.name);
          registered.add(resolve(vault.path));
          added++;
          success(`Registered "${vault.name}" → ${vault.path}`);
        } catch (err) {
          // Never-throw the whole batch on one bad entry (e.g. a path that
          // vanished between discovery and register).
          info(chalk.dim(`Skipped ${projectPath}: ${err instanceof VaultError ? err.message : String(err)}`));
          skipped++;
        }
      }

      info(`Done: ${added} registered, ${skipped} skipped (already-registered or unresolvable).`);
    });

  // ─── remove ────────────────────────────────────────────────────────────────
  vaults
    .command('remove')
    .argument('<name>', 'Name of the vault to remove')
    .description('Unregister a vault')
    .action((name: string) => {
      const removed = removeVault(name);
      if (removed) {
        success(`Removed vault "${name}".`);
      } else {
        info(`No vault named "${name}" found.`);
        process.exit(1);
      }
    });
}
