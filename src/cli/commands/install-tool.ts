import type { Command } from 'commander';
import { ensureCodexHooks } from './install-skill.js';
import { ensureAgentsMdBlock } from '../../lib/install-agents-md.js';

/**
 * `dreamcontext install --tool codex` — opt in, per project, to the brain in a TERMINAL Codex
 * session (Track T W3): `.codex/hooks.json` runs our hooks in Codex's shape, and a marker block in
 * `AGENTS.md` says where the memory lives. Idempotent; text that is not ours is kept. A desktop
 * Codex chat needs none of it (the bridge injects the brain itself, and these hooks stay quiet
 * there except the `.env` gate).
 */
export function registerInstallToolCommand(program: Command): void {
  program
    .command('install')
    .description('Opt this project in to the brain for another tool\'s own terminal sessions (writes that tool\'s hook file and instructions block)')
    .requiredOption('--tool <tool>', 'the tool: codex')
    .action((o: { tool: string }) => {
      if (o.tool !== 'codex') {
        process.stderr.write(`install: --tool ${o.tool} is not supported (codex). Claude Code is set up by install-skill.\n`);
        process.exit(2);
      }
      const projectRoot = process.cwd();
      try {
        const hooks = ensureCodexHooks(projectRoot);
        const agents = ensureAgentsMdBlock(projectRoot);
        console.log(`${hooks.changed ? 'Wrote' : 'Unchanged'}: .codex/hooks.json`);
        console.log(`AGENTS.md: ${agents}`);
        console.log('Codex runs project hooks only after you trust them: open `codex` here once and trust both the folder and its hooks.');
      } catch (err) {
        process.stderr.write(`install: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });
}
