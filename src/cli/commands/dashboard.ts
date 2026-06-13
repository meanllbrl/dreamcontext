import { Command } from 'commander';
import { ensureContextRoot } from '../../lib/context-path.js';
import { resolveVaultContextRoot, VaultError } from '../../lib/vaults.js';
import { startDashboardServer } from '../../server/index.js';
import { error } from '../../lib/format.js';

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Open the web dashboard in your browser')
    .option('-p, --port <port>', 'Port number', '4173')
    .option('--host <host>', 'Interface to bind (default loopback). Use 0.0.0.0 to expose on your network.', '127.0.0.1')
    .option('--no-open', 'Do not open browser automatically')
    .option('--vault <path>', 'Open a specific vault by registered name or path')
    .option('--launcher', 'Boot vault-agnostic (launcher mode); vault is resolved per-request')
    .action(async (opts: { port: string; host: string; open: boolean; vault?: string; launcher?: boolean }) => {
      let contextRoot: string | null;

      if (opts.launcher) {
        // Launcher mode: no default vault — each window pins its own via the
        // X-Dreamcontext-Vault header. `--vault` is ignored when --launcher is set.
        contextRoot = null;
      } else if (opts.vault !== undefined) {
        try {
          contextRoot = resolveVaultContextRoot(opts.vault);
        } catch (err) {
          if (err instanceof VaultError) {
            error(err.message);
          } else {
            error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
          }
          process.exitCode = 1;
          return;
        }
      } else {
        contextRoot = ensureContextRoot();
      }

      const port = parseInt(opts.port, 10);

      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('Invalid port number. Must be between 1 and 65535.');
      }

      await startDashboardServer({ port, contextRoot, open: opts.open, host: opts.host });
    });
}
