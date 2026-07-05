import { Command } from 'commander';
import chalk from 'chalk';
import { registerInitCommand } from './commands/init.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerCoreCommand } from './commands/core.js';
import { registerFeaturesCommand } from './commands/features.js';
import { registerKnowledgeCommand } from './commands/knowledge.js';
import { registerTasksCommand } from './commands/tasks.js';
import { registerRoadmapCommand } from './commands/roadmap.js';
import { registerInstallSkillCommand } from './commands/install-skill.js';
import { registerInstallClaudeMdCommand, registerInstallInstructionsCommand } from './commands/install-claude-md.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerSnapshotCommand } from './commands/snapshot.js';
import { registerSleepCommand, registerRecallCommand } from './commands/sleep.js';
import { registerHookCommand } from './commands/hook.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerBookmarkCommand } from './commands/bookmark.js';
import { registerTriggerCommand } from './commands/trigger.js';
import { registerTranscriptCommand } from './commands/transcript.js';
import { registerReflectCommand } from './commands/reflect.js';
import { registerCouncilCommand } from './commands/council.js';
import { registerMarketingCommand } from './commands/marketing.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerAppCommand } from './commands/app.js';
import { registerTaxonomyCommand } from './commands/taxonomy.js';
import { registerVaultsCommand } from './commands/vaults.js';
import { registerConnectionsCommand } from './commands/connections.js';
import { registerFederationCommand } from './commands/federation.js';
import { registerConfigCommand } from './commands/config.js';
import { registerFeedbackCommand } from './commands/feedback.js';
import { registerMigrationsCommand } from './commands/migrations.js';
import { registerBrainCommand } from './commands/brain.js';
import { startInteractive } from './interactive.js';
import { renderBanner } from '../lib/pixel-banner.js';
import { dreamcontextVersion } from '../lib/manifest.js';

// ─── Logo ────────────────────────────────────────────────────────────────────

function getBanner(): string {
  const logo = renderBanner();
  // Logo visual center is ~col 19 (4-space pad + 15-char center of content)
  const title = `${chalk.bold.cyan('D R E A M')}${chalk.bold.cyanBright('   C O N T E X T')}`;
  const sep = chalk.dim('━'.repeat(25));
  const tagline = chalk.dim('persistent memory for AI agents');
  const text = [
    '',
    `       ${title}`,
    `       ${sep}`,
    `    ${tagline}`,
  ].join('\n');
  return '\n' + logo + text + '\n';
}

// ─── Custom Help ────────────────────────────────────────────────────────────

const HELP_GROUPS = `
${chalk.bold('Setup')}
  ${chalk.magentaBright('setup')}             One-shot: init + install-skill + install-instructions
  ${chalk.magentaBright('init')}              ${chalk.dim('(deprecated)')} Initialize _dream_context/ in your project
  ${chalk.magentaBright('install-skill')}     ${chalk.dim('(deprecated)')} Install skill + agents + optional packs
  ${chalk.magentaBright('install-instructions')} ${chalk.dim('(deprecated)')} Install managed root instruction files
  ${chalk.magentaBright('install-claude-md')} ${chalk.dim('(deprecated)')} Legacy alias for CLAUDE.md install
  ${chalk.magentaBright('update')}            Refresh installed skill, agents, hooks, packs, and root instructions
  ${chalk.magentaBright('upgrade')}           Upgrade the dreamcontext CLI itself to the latest version

${chalk.bold('Content')}
  ${chalk.magentaBright('core')}              Add changelog and release entries
  ${chalk.magentaBright('features')}          ${chalk.dim('(deprecated)')} Create features (now typed knowledge under knowledge/features/)
  ${chalk.magentaBright('knowledge')}         Create and index knowledge files
  ${chalk.magentaBright('taxonomy')}          Inspect and maintain the project tag vocabulary
  ${chalk.magentaBright('memory')}            Recall facts via BM25 search over the project corpus
  ${chalk.magentaBright('tasks')}             Create tasks, log progress, and mark complete
  ${chalk.magentaBright('roadmap')}           PO-authored objective board (rollups, dependencies, target vs forecast)
  ${chalk.magentaBright('bookmark')}          Tag important moments for consolidation
  ${chalk.magentaBright('trigger')}           Manage contextual reminders (prospective memory)
  ${chalk.magentaBright('council')}           Run structured multi-agent debates on decisions

${chalk.bold('System')}
  ${chalk.magentaBright('snapshot')}          Output context snapshot (used by SessionStart hook)
  ${chalk.magentaBright('sleep')}             Track sleep debt and consolidation state
  ${chalk.magentaBright('hook')}              Hook handlers used by platform integrations
  ${chalk.magentaBright('transcript')}        Process session transcripts
  ${chalk.magentaBright('doctor')}            Validate _dream_context/ structure and report issues
  ${chalk.magentaBright('feedback')}          File a gap/bug as a GitHub issue to the dreamcontext project

${chalk.bold('Dashboard')}
  ${chalk.magentaBright('dashboard')}         Open the web dashboard in your browser

${chalk.bold('Cloud Collaboration')}
  ${chalk.magentaBright('brain')}             Sync the brain to its own GitHub repo (init/attach/sync/enable/disable)

${chalk.bold('Vaults')}
  ${chalk.magentaBright('vaults')}            Manage the global vault registry (multi-project)
  ${chalk.magentaBright('connect')}           Connect this vault to a peer for cross-project federation
  ${chalk.magentaBright('disconnect')}        Remove a federation connection to a peer
  ${chalk.magentaBright('connections')}       Inspect cross-project federation connections

${chalk.dim('Run')} dreamcontext ${chalk.dim('<command> --help')} ${chalk.dim('for details on a specific command.')}
`;

// ─── Program ────────────────────────────────────────────────────────────────

export function createProgram(): Command {
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

  registerSetupCommand(program);
  registerInitCommand(program);
  registerCoreCommand(program);
  registerFeaturesCommand(program);
  registerKnowledgeCommand(program);
  registerTasksCommand(program);
  registerRoadmapCommand(program);
  registerInstallSkillCommand(program);
  registerInstallInstructionsCommand(program);
  registerInstallClaudeMdCommand(program);
  registerUpdateCommand(program);
  registerUpgradeCommand(program);
  registerAppCommand(program);
  registerSnapshotCommand(program);
  registerSleepCommand(program);
  registerRecallCommand(program);
  registerHookCommand(program);
  registerDoctorCommand(program);
  registerDashboardCommand(program);
  registerBookmarkCommand(program);
  registerTriggerCommand(program);
  registerTranscriptCommand(program);
  registerReflectCommand(program);
  registerCouncilCommand(program);
  registerMarketingCommand(program);
  registerMemoryCommand(program);
  registerTaxonomyCommand(program);
  registerVaultsCommand(program);
  registerConnectionsCommand(program);
  registerFederationCommand(program);
  registerConfigCommand(program);
  registerFeedbackCommand(program);
  registerMigrationsCommand(program);
  registerBrainCommand(program);

  return program;
}

async function main() {
  // Root version request. Handled here (not via Commander's global `.version()`)
  // so subcommands can own `--version <id>`. A leading `--version`/`-V` token
  // unambiguously means the root, since subcommand names always come first.
  const firstArg = process.argv[2];
  if (firstArg === '--version' || firstArg === '-V') {
    console.log(dreamcontextVersion());
    return;
  }

  const program = createProgram();

  // If no arguments, show banner + enter interactive mode
  if (process.argv.length <= 2) {
    console.log(getBanner());
    await startInteractive(program);
  } else {
    await program.parseAsync(process.argv);
  }
}

main().catch((err) => {
  console.error(chalk.red('✗') + ' ' + err.message);
  process.exit(1);
});
