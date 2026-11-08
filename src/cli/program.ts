import type { Command } from 'commander';
import { createRootCommand } from './root.js';
import { registerInitCommand } from './commands/init.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerCoreCommand } from './commands/core.js';
import { registerFeaturesCommand } from './commands/features.js';
import { registerKnowledgeCommand } from './commands/knowledge.js';
import { registerTasksCommand } from './commands/tasks.js';
import { registerRoadmapCommand } from './commands/roadmap.js';
import { registerLabCommand } from './commands/lab.js';
import { registerThesesCommand } from './commands/theses.js';
import { registerInstallSkillCommand } from './commands/install-skill.js';
import { registerInstallClaudeMdCommand, registerInstallInstructionsCommand } from './commands/install-claude-md.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerSnapshotCommand } from './commands/snapshot.js';
import { registerSleepCommand, registerRecallCommand } from './commands/sleep.js';
import { registerSleepEvalCommand } from './commands/sleep-eval.js';
import { registerHookCommand } from './commands/hook.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerBookmarkCommand } from './commands/bookmark.js';
import { registerAutomationsCommand } from './commands/automations.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerTriggerCommand } from './commands/trigger.js';
import { registerTranscriptCommand } from './commands/transcript.js';
import { registerGoalLiveCommand } from './commands/goal-live.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerBuilderCommand } from './commands/builder.js';
import { registerReflectCommand } from './commands/reflect.js';
import { registerCouncilCommand } from './commands/council.js';
import { registerMarketingCommand } from './commands/marketing.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerChangelogCommand } from './commands/changelog.js';
import { registerEmbedCommand } from './commands/embed.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerAppCommand } from './commands/app.js';
import { registerAssistantCommand } from './commands/assistant.js';
import { registerWindowCommand } from './commands/window.js';
import { registerVoiceCommand } from './commands/voice.js';
import { registerSuperCommand } from './commands/super.js';
import { registerTaxonomyCommand } from './commands/taxonomy.js';
import { registerVaultsCommand } from './commands/vaults.js';
import { registerTmpCommand } from './commands/tmp.js';
import { registerConnectionsCommand } from './commands/connections.js';
import { registerPeerCommand } from './commands/peer.js';
import { registerAskCommand } from './commands/ask.js';
import { registerFederationCommand } from './commands/federation.js';
import { registerConfigCommand } from './commands/config.js';
import { registerPeopleCommand } from './commands/people.js';
import { registerFeedbackCommand } from './commands/feedback.js';
import { registerMigrationsCommand } from './commands/migrations.js';
import { registerBrainCommand } from './commands/brain.js';
import { registerLinkCommand } from './commands/link.js';
import { registerPatternsCommand } from './commands/patterns.js';
import { registerWhiteboardCommand } from './commands/whiteboard.js';
import { registerNotifyCommand } from './commands/notify.js';
import { registerAppsCommand } from './commands/apps.js';
import { registerHandsfreeCommand } from './commands/handsfree.js';
import { registerT3ChatCommand } from './commands/t3-chat.js';
import { registerMcpServeCommand } from './commands/mcp-serve.js';
import { registerInstallToolCommand } from './commands/install-tool.js';

/**
 * The command TREE, with no entrypoint attached.
 *
 * Split out of `index.ts` so the tree can be BUILT without running the CLI: `index.ts` calls
 * `main()` at module load, so anything importing it to inspect the program (the manifest the
 * dashboard's chat rows are derived from — see `tests/unit/cli-manifest.test.ts`) would parse
 * the importing process's own argv instead. This module registers commands and returns;
 * importing it does nothing else.
 */

// ─── Program ────────────────────────────────────────────────────────────────

export function createProgram(): Command {
  const program = createRootCommand();

  registerSetupCommand(program);
  registerInitCommand(program);
  registerCoreCommand(program);
  registerFeaturesCommand(program);
  registerKnowledgeCommand(program);
  registerPatternsCommand(program);
  registerTasksCommand(program);
  registerWhiteboardCommand(program);
  registerRoadmapCommand(program);
  registerLabCommand(program);
  registerThesesCommand(program);
  registerInstallSkillCommand(program);
  registerInstallInstructionsCommand(program);
  registerInstallClaudeMdCommand(program);
  registerUpdateCommand(program);
  registerUpgradeCommand(program);
  registerAppCommand(program);
  registerAssistantCommand(program);
  registerWindowCommand(program);
  registerVoiceCommand(program);
  registerSuperCommand(program);
  registerSnapshotCommand(program);
  registerSleepCommand(program);
  // `sleep eval` hangs off the sleep command without touching sleep.ts.
  registerSleepEvalCommand(program.commands.find((c) => c.name() === 'sleep')!);
  registerRecallCommand(program);
  registerHookCommand(program);
  registerDoctorCommand(program);
  registerDashboardCommand(program);
  registerBookmarkCommand(program);
  registerAutomationsCommand(program);
  registerAgentsCommand(program);
  registerTriggerCommand(program);
  registerTranscriptCommand(program);
  registerGoalLiveCommand(program);
  registerPlanCommand(program);
  registerBuilderCommand(program);
  registerReflectCommand(program);
  registerCouncilCommand(program);
  registerMarketingCommand(program);
  registerMemoryCommand(program);
  registerChangelogCommand(program);
  registerEmbedCommand(program);
  registerTaxonomyCommand(program);
  registerVaultsCommand(program);
  registerTmpCommand(program);
  registerConnectionsCommand(program);
  registerPeerCommand(program);
  registerAskCommand(program);
  registerFederationCommand(program);
  registerConfigCommand(program);
  registerPeopleCommand(program);
  registerFeedbackCommand(program);
  registerMigrationsCommand(program);
  registerBrainCommand(program);
  registerLinkCommand(program);
  registerNotifyCommand(program);
  registerAppsCommand(program);
  registerHandsfreeCommand(program);
  registerT3ChatCommand(program);
  registerMcpServeCommand(program);
  registerInstallToolCommand(program);

  return program;
}
