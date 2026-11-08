import { Command } from 'commander';
import chalk from 'chalk';

/**
 * The root `dreamcontext` command with no subcommands: name, description, the grouped root help.
 *
 * Shared by `program.ts` (the whole tree) and `lazy-program.ts` (the root plus the ONE command
 * argv names), so a lazily built program configures its root exactly like the full one. Commander
 * copies the root's help settings into each subcommand when it is added, so the root must be
 * configured here, before any command is registered.
 */

// ─── Custom Help ────────────────────────────────────────────────────────────

const HELP_GROUPS = `
${chalk.bold('Setup')}
  ${chalk.magentaBright('setup')}             One-shot: init + install-skill + install-instructions
  ${chalk.magentaBright('init')}              ${chalk.dim('(deprecated)')} Initialize _dream_context/ in your project
  ${chalk.magentaBright('install-skill')}     ${chalk.dim('(deprecated)')} Install skill + agents + optional packs
  ${chalk.magentaBright('install-instructions')} ${chalk.dim('(deprecated)')} Install managed root instruction files
  ${chalk.magentaBright('install-claude-md')} ${chalk.dim('(deprecated)')} Legacy alias for CLAUDE.md install
  ${chalk.magentaBright('update')}            Refresh installed skill, agents, hooks, packs, and an existing CLAUDE.md block
  ${chalk.magentaBright('upgrade')}           Upgrade the dreamcontext CLI itself to the latest version

${chalk.bold('Content')}
  ${chalk.magentaBright('core')}              Add changelog and release entries
  ${chalk.magentaBright('features')}          ${chalk.dim('(deprecated)')} Create features (now typed knowledge under knowledge/features/)
  ${chalk.magentaBright('knowledge')}         Create and index knowledge files
  ${chalk.magentaBright('taxonomy')}          Inspect and maintain the project tag vocabulary
  ${chalk.magentaBright('memory')}            Recall facts via BM25 search over the project corpus
  ${chalk.magentaBright('embed')}             ${chalk.dim('(experimental)')} Local embedding index for hybrid recall
  ${chalk.magentaBright('tasks')}             Create tasks, log progress, and mark complete
  ${chalk.magentaBright('roadmap')}           PO-authored objective board (rollups, dependencies, target vs forecast)
  ${chalk.magentaBright('lab')}               Analytics insights: curated metrics from HTTP APIs or scripts
  ${chalk.magentaBright('bookmark')}          Tag important moments for consolidation
  ${chalk.magentaBright('whiteboard')}        Read and edit whiteboards (excalidraw boards with live widgets; the draw skill)
  ${chalk.magentaBright('trigger')}           Manage contextual reminders (prospective memory)
  ${chalk.magentaBright('council')}           Run structured multi-agent debates on decisions
  ${chalk.magentaBright('plan')}              Plan review loop: ledger, review packet, stops, gate into Develop

${chalk.bold('System')}
  ${chalk.magentaBright('snapshot')}          Output context snapshot (used by SessionStart hook)
  ${chalk.magentaBright('sleep')}             Track sleep debt and consolidation state
  ${chalk.magentaBright('hook')}              Hook handlers used by platform integrations
  ${chalk.magentaBright('transcript')}        Process session transcripts
  ${chalk.magentaBright('doctor')}            Validate _dream_context/ structure and report issues
  ${chalk.magentaBright('feedback')}          File a gap/bug as a GitHub issue to the dreamcontext project
  ${chalk.magentaBright('notify')}            Post a macOS banner whose click opens the exact chat or page

${chalk.bold('Dashboard')}
  ${chalk.magentaBright('dashboard')}         Open the web dashboard in your browser

${chalk.bold('Cloud Collaboration')}
  ${chalk.magentaBright('brain')}             Sync the brain to its own GitHub repo (init/attach/sync/enable/disable)

${chalk.bold('Linked Repos')}
  ${chalk.magentaBright('link')}              Govern bare code repos: add/clone/ls/rm linked repos
  ${chalk.magentaBright('links')}             List linked repos (alias for link ls)
  ${chalk.magentaBright('unlink')}            Unlink a repo (alias for link rm)

${chalk.bold('Vaults')}
  ${chalk.magentaBright('vaults')}            Manage the global vault registry (multi-project)
  ${chalk.magentaBright('connect')}           Connect this vault to a peer for cross-project federation
  ${chalk.magentaBright('disconnect')}        Remove a federation connection to a peer
  ${chalk.magentaBright('connections')}       Inspect cross-project federation connections

${chalk.dim('Run')} dreamcontext ${chalk.dim('<command> --help')} ${chalk.dim('for details on a specific command.')}
`;

export function createRootCommand(): Command {
  const program = new Command();

  program
    .name('dreamcontext')
    .description('Persistent memory for AI agents')
    .addHelpText('after', HELP_GROUPS)
    .configureHelp({
      showGlobalOptions: false,
    });
  // NOTE: we deliberately do NOT call `.version()`. Commander registers the
  // version option as a *global* option that shadows every subcommand's own
  // `--version` (e.g. `tasks list --version S5` or `tasks create --version`).
  // Root `dreamcontext --version` / `-V` is handled manually in main() instead,
  // which leaves `--version <id>` free for subcommands.

  return program;
}
