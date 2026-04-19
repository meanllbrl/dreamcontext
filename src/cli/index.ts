import { Command } from 'commander';
import chalk from 'chalk';
import { registerInitCommand } from './commands/init.js';
import { registerCoreCommand } from './commands/core.js';
import { registerFeaturesCommand } from './commands/features.js';
import { registerKnowledgeCommand } from './commands/knowledge.js';
import { registerTasksCommand } from './commands/tasks.js';
import { registerInstallSkillCommand } from './commands/install-skill.js';
import { registerInstallClaudeMdCommand } from './commands/install-claude-md.js';
import { registerSnapshotCommand } from './commands/snapshot.js';
import { registerSleepCommand } from './commands/sleep.js';
import { registerHookCommand } from './commands/hook.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerBookmarkCommand } from './commands/bookmark.js';
import { registerTriggerCommand } from './commands/trigger.js';
import { registerTranscriptCommand } from './commands/transcript.js';
import { registerCouncilCommand } from './commands/council.js';
import { startInteractive } from './interactive.js';
import { renderBanner } from '../lib/pixel-banner.js';

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
  ${chalk.magentaBright('init')}              Initialize _dream_context/ in your project
  ${chalk.magentaBright('install-skill')}     Install skill + agents + optional packs to .claude/
  ${chalk.magentaBright('install-claude-md')} Install a terse CLAUDE.md at the project root (optional)

${chalk.bold('Content')}
  ${chalk.magentaBright('core')}              Add changelog and release entries
  ${chalk.magentaBright('features')}          Create features and insert into sections
  ${chalk.magentaBright('knowledge')}         Create and index knowledge files
  ${chalk.magentaBright('tasks')}             Create tasks, log progress, and mark complete
  ${chalk.magentaBright('bookmark')}          Tag important moments for consolidation
  ${chalk.magentaBright('trigger')}           Manage contextual reminders (prospective memory)
  ${chalk.magentaBright('council')}           Run structured multi-agent debates on decisions

${chalk.bold('System')}
  ${chalk.magentaBright('snapshot')}          Output context snapshot (used by SessionStart hook)
  ${chalk.magentaBright('sleep')}             Track sleep debt and consolidation state
  ${chalk.magentaBright('hook')}              Hook handlers (7 hooks) for Claude Code
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
    .version('0.1.0')
    .addHelpText('after', HELP_GROUPS)
    .configureHelp({
      showGlobalOptions: false,
    });

  registerInitCommand(program);
  registerCoreCommand(program);
  registerFeaturesCommand(program);
  registerKnowledgeCommand(program);
  registerTasksCommand(program);
  registerInstallSkillCommand(program);
  registerInstallClaudeMdCommand(program);
  registerSnapshotCommand(program);
  registerSleepCommand(program);
  registerHookCommand(program);
  registerDoctorCommand(program);
  registerDashboardCommand(program);
  registerBookmarkCommand(program);
  registerTriggerCommand(program);
  registerTranscriptCommand(program);
  registerCouncilCommand(program);

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
