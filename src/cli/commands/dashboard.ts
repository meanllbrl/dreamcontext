import { Command } from 'commander';
import { ensureContextRoot } from '../../lib/context-path.js';
import { startDashboardServer } from '../../server/index.js';

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Open the web dashboard in your browser')
    .option('-p, --port <port>', 'Port number', '4173')
    .option('--host <host>', 'Interface to bind (default loopback). Use 0.0.0.0 to expose on your network.', '127.0.0.1')
    .option('--no-open', 'Do not open browser automatically')
    .action(async (opts: { port: string; host: string; open: boolean }) => {
      const contextRoot = ensureContextRoot();
      const port = parseInt(opts.port, 10);

      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('Invalid port number. Must be between 1 and 65535.');
      }

      await startDashboardServer({ port, contextRoot, open: opts.open, host: opts.host });
    });
}
