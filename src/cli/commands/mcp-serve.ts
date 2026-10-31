import type { Command } from 'commander';

/**
 * `dreamcontext mcp serve --root <project>` — the brain as a stdio MCP server, started per session
 * by a tool that has no hooks of ours (Codex; Track T W3). Hidden: the bridge configures it.
 */
export function registerMcpServeCommand(program: Command): void {
  const mcp = program.command('mcp', { hidden: true }).description('The brain as an MCP server (started by a bridge tool)');
  mcp
    .command('serve')
    .description('Serve this project\'s brain over stdio MCP: recall and an allowlisted set of verbs, confined to the vault')
    .requiredOption('--root <path>', 'the project folder (holds _dream_context); realpath\'d once')
    .action(async (o: { root: string }) => {
      const { runBrainMcpServer } = await import('../../lib/brain-mcp/server.js');
      try {
        runBrainMcpServer({ root: o.root });
      } catch (err) {
        process.stderr.write(`mcp serve: ${String((err as Error)?.message ?? err)}\n`);
        process.exit(2);
      }
    });

  // A Super child's MCP server on Codex (launch.ts `codexLeanMcpArgs`): the command, arguments and
  // env stay in the 0600 file, because whatever Codex is told on `-c` shows in `ps`.
  mcp
    .command('lean-exec <file> <name>')
    .description('Start one server of a lean MCP subset file, with stdio passed through')
    .action(async (file: string, name: string) => {
      const { startLeanServer } = await import('../../lib/super/lean-exec.js');
      process.exit(await startLeanServer(file, name));
    });
}
