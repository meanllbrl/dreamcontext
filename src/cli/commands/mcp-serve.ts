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
}
