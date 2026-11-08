import type { Command } from 'commander';
import { createRootCommand } from './root.js';

/**
 * The root plus ONLY the command argv names, its module loaded on demand.
 *
 * `program.ts` imports all ~60 command modules, and each module's imports evaluate the whole CLI
 * (the dashboard server, the MCP SDK, every task backend) before the first line of a command runs:
 * ~0.1 s CPU on every start, paid by every hook event. A start that names a known top-level
 * command builds a program holding just that command, so only its module graph is evaluated.
 * Every other start (no command, `help`, an option, an unknown or misspelt command, so Commander's
 * "did you mean" still sees every name) uses the full `createProgram()`.
 *
 * Each key is a top-level command name or alias, mapped to the register calls that create it,
 * exactly as `createProgram()` makes them. A drift test (`tests/unit/lazy-program.test.ts`) proves
 * every top-level name of the full tree is here and builds the same command (help, options and
 * subcommands, recursively) both ways.
 */

type Register = (program: Command) => void;
type Loader = () => Promise<Register>;

const sleepGroup: Loader = async () => {
  const [{ registerSleepCommand }, { registerSleepEvalCommand }] = await Promise.all([
    import('./commands/sleep.js'),
    import('./commands/sleep-eval.js'),
  ]);
  return (program) => {
    registerSleepCommand(program);
    // `sleep eval` hangs off the sleep command, as in createProgram().
    registerSleepEvalCommand(program.commands.find((c) => c.name() === 'sleep')!);
  };
};

const connections: Loader = async () => (await import('./commands/connections.js')).registerConnectionsCommand;
const link: Loader = async () => (await import('./commands/link.js')).registerLinkCommand;
const t3: Loader = async () => (await import('./commands/t3-chat.js')).registerT3ChatCommand;
const marketing: Loader = async () => (await import('./commands/marketing.js')).registerMarketingCommand;

const LOADERS = new Map<string, Loader>([
  ['setup', async () => (await import('./commands/setup.js')).registerSetupCommand],
  ['init', async () => (await import('./commands/init.js')).registerInitCommand],
  ['core', async () => (await import('./commands/core.js')).registerCoreCommand],
  ['features', async () => (await import('./commands/features.js')).registerFeaturesCommand],
  ['knowledge', async () => (await import('./commands/knowledge.js')).registerKnowledgeCommand],
  ['patterns', async () => (await import('./commands/patterns.js')).registerPatternsCommand],
  ['tasks', async () => (await import('./commands/tasks.js')).registerTasksCommand],
  ['whiteboard', async () => (await import('./commands/whiteboard.js')).registerWhiteboardCommand],
  ['roadmap', async () => (await import('./commands/roadmap.js')).registerRoadmapCommand],
  ['lab', async () => (await import('./commands/lab.js')).registerLabCommand],
  ['theses', async () => (await import('./commands/theses.js')).registerThesesCommand],
  ['install-skill', async () => (await import('./commands/install-skill.js')).registerInstallSkillCommand],
  ['install-instructions', async () => (await import('./commands/install-claude-md.js')).registerInstallInstructionsCommand],
  ['install-claude-md', async () => (await import('./commands/install-claude-md.js')).registerInstallClaudeMdCommand],
  ['update', async () => (await import('./commands/update.js')).registerUpdateCommand],
  ['upgrade', async () => (await import('./commands/upgrade.js')).registerUpgradeCommand],
  ['app', async () => (await import('./commands/app.js')).registerAppCommand],
  ['assistant', async () => (await import('./commands/assistant.js')).registerAssistantCommand],
  ['window', async () => (await import('./commands/window.js')).registerWindowCommand],
  ['voice', async () => (await import('./commands/voice.js')).registerVoiceCommand],
  ['super', async () => (await import('./commands/super.js')).registerSuperCommand],
  ['snapshot', async () => (await import('./commands/snapshot.js')).registerSnapshotCommand],
  ['sleep', sleepGroup],
  ['recall', async () => (await import('./commands/sleep.js')).registerRecallCommand],
  ['hook', async () => (await import('./commands/hook.js')).registerHookCommand],
  ['doctor', async () => (await import('./commands/doctor.js')).registerDoctorCommand],
  ['dashboard', async () => (await import('./commands/dashboard.js')).registerDashboardCommand],
  ['bookmark', async () => (await import('./commands/bookmark.js')).registerBookmarkCommand],
  ['automations', async () => (await import('./commands/automations.js')).registerAutomationsCommand],
  ['agents', async () => (await import('./commands/agents.js')).registerAgentsCommand],
  ['trigger', async () => (await import('./commands/trigger.js')).registerTriggerCommand],
  ['transcript', async () => (await import('./commands/transcript.js')).registerTranscriptCommand],
  ['goal-live', async () => (await import('./commands/goal-live.js')).registerGoalLiveCommand],
  ['plan', async () => (await import('./commands/plan.js')).registerPlanCommand],
  ['builder', async () => (await import('./commands/builder.js')).registerBuilderCommand],
  ['reflect', async () => (await import('./commands/reflect.js')).registerReflectCommand],
  ['council', async () => (await import('./commands/council.js')).registerCouncilCommand],
  ['marketing', marketing],
  ['mk', marketing],
  ['memory', async () => (await import('./commands/memory.js')).registerMemoryCommand],
  ['changelog', async () => (await import('./commands/changelog.js')).registerChangelogCommand],
  ['embed', async () => (await import('./commands/embed.js')).registerEmbedCommand],
  ['taxonomy', async () => (await import('./commands/taxonomy.js')).registerTaxonomyCommand],
  ['vaults', async () => (await import('./commands/vaults.js')).registerVaultsCommand],
  ['connect', connections],
  ['disconnect', connections],
  ['connections', connections],
  ['peer', async () => (await import('./commands/peer.js')).registerPeerCommand],
  ['ask', async () => (await import('./commands/ask.js')).registerAskCommand],
  ['federation', async () => (await import('./commands/federation.js')).registerFederationCommand],
  ['config', async () => (await import('./commands/config.js')).registerConfigCommand],
  ['people', async () => (await import('./commands/people.js')).registerPeopleCommand],
  ['feedback', async () => (await import('./commands/feedback.js')).registerFeedbackCommand],
  ['migrations', async () => (await import('./commands/migrations.js')).registerMigrationsCommand],
  ['brain', async () => (await import('./commands/brain.js')).registerBrainCommand],
  ['link', link],
  ['links', link],
  ['unlink', link],
  ['notify', async () => (await import('./commands/notify.js')).registerNotifyCommand],
  ['apps', async () => (await import('./commands/apps.js')).registerAppsCommand],
  ['handsfree', async () => (await import('./commands/handsfree.js')).registerHandsfreeCommand],
  ['t3-chat', t3],
  ['t3-run', t3],
  ['t3-account', t3],
  ['mcp', async () => (await import('./commands/mcp-serve.js')).registerMcpServeCommand],
  ['install', async () => (await import('./commands/install-tool.js')).registerInstallToolCommand],
]);

/** Every name the lazy path answers for (the drift test reads it). */
export function lazyCommandNames(): string[] {
  return [...LOADERS.keys()];
}

/**
 * The program for a start whose first argument is `name`: the root plus that one command, or
 * null when `name` is not a top-level command (the caller then builds the full tree).
 */
export async function createProgramFor(name: string | undefined): Promise<Command | null> {
  const load = name === undefined ? undefined : LOADERS.get(name);
  if (!load) return null;
  const register = await load();
  const program = createRootCommand();
  register(program);
  return program;
}
