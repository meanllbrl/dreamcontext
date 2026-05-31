import { Command } from 'commander';
import chalk from 'chalk';
import { registerInitCommand } from './commands/init.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerCoreCommand } from './commands/core.js';
import { registerFeaturesCommand } from './commands/features.js';
import { registerKnowledgeCommand } from './commands/knowledge.js';
import { registerTasksCommand } from './commands/tasks.js';
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
import { registerCouncilCommand } from './commands/council.js';
import { registerMarketingCommand } from './commands/marketing.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
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
  ${chalk.magentaBright('features')}          Create features and insert into sections
  ${chalk.magentaBright('knowledge')}         Create and index knowledge files
  ${chalk.magentaBright('memory')}            Recall facts via BM25 search over the project corpus
  ${chalk.magentaBright('tasks')}             Create tasks, log progress, and mark complete
  ${chalk.magentaBright('bookmark')}          Tag important moments for consolidation
  ${chalk.magentaBright('trigger')}           Manage contextual reminders (prospective memory)
  ${chalk.magentaBright('council')}           Run structured multi-agent debates on decisions

${chalk.bold('System')}
  ${chalk.magentaBright('snapshot')}          Output context snapshot (used by SessionStart hook)
  ${chalk.magentaBright('sleep')}             Track sleep debt and consolidation state
  ${chalk.magentaBright('hook')}              Hook handlers used by platform integrations
  ${chalk.magentaBright('transcript')}        Process session transcripts
  ${chalk.magentaBright('doctor')}            Validate _dream_context/ structure and report issues

${chalk.bold('Dashboard')}
  ${chalk.magentaBright('dashboard')}         Open the web dashboard in your browser

${chalk.dim('Run')} dreamcontext ${chalk.dim('<command> --help')} ${chalk.dim('for details on a specific command.')}
`;

// ─── Program ────────────────────────────────────────────────────────────────

export function createProgram(): Command {
  const program = new Command();

  program
    .name('dreamcontext')
    .description('Persistent memory for AI agents')
    .version(dreamcontextVersion())
    .addHelpText('after', HELP_GROUPS)
    .configureHelp({
      showGlobalOptions: false,
    });

  registerSetupCommand(program);
  registerInitCommand(program);
  registerCoreCommand(program);
  registerFeaturesCommand(program);
  registerKnowledgeCommand(program);
  registerTasksCommand(program);
  registerInstallSkillCommand(program);
  registerInstallInstructionsCommand(program);
  registerInstallClaudeMdCommand(program);
  registerUpdateCommand(program);
  registerUpgradeCommand(program);
  registerSnapshotCommand(program);
  registerSleepCommand(program);
  registerRecallCommand(program);
  registerHookCommand(program);
  registerDoctorCommand(program);
  registerDashboardCommand(program);
  registerBookmarkCommand(program);
  registerTriggerCommand(program);
  registerTranscriptCommand(program);
  registerCouncilCommand(program);
  registerMarketingCommand(program);
  registerMemoryCommand(program);

  return program;
}

async function main() {
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
