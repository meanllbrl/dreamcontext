import { Command } from 'commander';
import chalk from 'chalk';
import { addVault, listVaults, removeVault, VaultError } from '../../lib/vaults.js';
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
