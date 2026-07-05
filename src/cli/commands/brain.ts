import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { dirname } from 'node:path';
import { success, error, warn, info, header } from '../../lib/format.js';
import { readSetupConfig, updateSetupConfig, readBrainLocal } from '../../lib/setup-config.js';
import { runBrainSync, type SyncResult } from '../../lib/git-sync/sync-engine.js';
import {
  resolveMode,
  resolveBrainSyncEnabled,
  resolveBrainSyncToken,
  createBrainRepo,
  discoverBrainRepos,
  attachBrainRepo,
} from '../../lib/git-sync/brain-repo.js';
import { scrubStagedFiles, summarizeScrub } from '../../lib/git-sync/scrub.js';
import * as git from '../../lib/git-sync/git.js';
import { GitSyncError } from '../../lib/git-sync/git.js';

/** `dreamcontext brain …` — see `skill-sync/references/merge-rules.md` for the full contract. */
export function registerBrainCommand(program: Command): void {
  const brain = program
    .command('brain')
    .description('Cloud collaboration for the brain repo (separate GitHub repo, agent-driven merge sync)');

  brain
    .command('status')
    .description('Show brain-repo mode, remote, sync state, and the resolved cloud-sync switch')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      const config = readSetupConfig(projectRoot);
      const mode = resolveMode(config);
      const enabledResolution = resolveBrainSyncEnabled(projectRoot, config);
      const gitCwd = mode === 'separate' ? contextRoot : projectRoot;
      const local = readBrainLocal(projectRoot);

      console.log(header('Brain Repo Status'));
      info(`Cloud sync: ${enabledResolution.enabled ? 'ON' : 'OFF'} (${enabledResolution.source})`);
      info(`Mode: ${mode}`);
      if (mode === 'separate') {
        const remote = git.isGitRepo(gitCwd) ? git.getRemoteUrl(gitCwd, 'origin') : null;
        info(`Remote: ${remote ?? '(none configured)'}`);
      }
      info(`Merge in progress: ${git.isGitRepo(gitCwd) && git.hasMergeHead(gitCwd) ? 'yes' : 'no'}`);
      info(`Pending team-merge handoff: ${local.pendingAgentMerge ? 'yes' : 'no'}`);
      if (local.pulledUpdates) info(`Last pull merged ${local.pulledUpdates} update(s).`);
    });

  brain
    .command('enable')
    .description('Explicitly turn cloud sync ON for this project (v3.3 master switch)')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      const config = readSetupConfig(projectRoot);
      updateSetupConfig(projectRoot, { brainRepo: { ...(config?.brainRepo ?? { mode: 'in-tree' }), enabled: true } });
      success('Cloud sync enabled.');
    });

  brain
    .command('disable')
    .description('Explicitly turn cloud sync OFF for this project (v3.3 master switch)')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      const config = readSetupConfig(projectRoot);
      updateSetupConfig(projectRoot, { brainRepo: { ...(config?.brainRepo ?? { mode: 'in-tree' }), enabled: false } });
      success('Cloud sync disabled.');
    });

  brain
    .command('init')
    .description('Create a brain repo on GitHub (private by default) and push a scrubbed first commit')
    .requiredOption('--owner <owner>', 'GitHub owner (user or org login)')
    .requiredOption('--name <name>', 'Repository name')
    .option('--public', 'Create the repo PUBLIC (default: private). Requires interactive confirmation.')
    .option('--code-repo <url>', 'URL of the paired code repo (stored in the brain marker)')
    .action(async (opts: { owner: string; name: string; public?: boolean; codeRepo?: string }) => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);

      let makePublic = false;
      if (opts.public) {
        warn('You are about to create a PUBLIC brain repo. It aggregates project knowledge, local paths, and team activity — anyone can read it.');
        makePublic = await confirm({ message: 'Really make this brain repo PUBLIC?', default: false });
        if (!makePublic) {
          info('Creating a PRIVATE repo instead (use --public + confirm to override).');
        }
      }

      try {
        const result = await createBrainRepo({
          contextRoot,
          projectRoot,
          owner: opts.owner,
          name: opts.name,
          private: !makePublic,
          confirmed: makePublic,
          codeRepoUrl: opts.codeRepo,
          taskBackend: readSetupConfig(projectRoot)?.taskBackend,
        });
        if (result.blocked) {
          error('Brain init blocked: staged content contains a secret.');
          for (const b of result.scrub.blocks) warn(`  ${b.excerpt}`);
          process.exitCode = 1;
          return;
        }
        updateSetupConfig(projectRoot, {
          brainRepo: { mode: 'separate', remote: result.remote, codeRepoUrl: opts.codeRepo, autoSync: true },
        });
        success(`Brain repo created: ${result.remote}`);
      } catch (err) {
        error(`Brain init failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  brain
    .command('attach')
    .argument('<url>', 'Brain repo URL to attach')
    .description('Attach an existing brain repo — TRUST decision (S6): its content loads into every future session')
    .option('-y, --yes', 'Skip the interactive confirmation')
    .action(async (url: string, opts: { yes?: boolean }) => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);

      warn(`You are about to trust content from ${url}.`);
      warn('It will be loaded verbatim into every future AI session in this vault (SessionStart).');
      warn('Only attach a repo you and your team control.');

      const confirmed = opts.yes || (await confirm({ message: 'Attach this brain repo?', default: false }));
      const result = attachBrainRepo({
        contextRoot,
        projectRoot,
        url,
        confirmed,
        taskBackend: readSetupConfig(projectRoot)?.taskBackend,
      });
      if (!result.ok) {
        error(result.reason ?? 'Attach refused.');
        process.exitCode = 1;
        return;
      }
      updateSetupConfig(projectRoot, { brainRepo: { mode: 'separate', remote: url, autoSync: true } });
      success(`Brain repo attached: ${url}`);
    });

  brain
    .command('discover')
    .description('List dreamcontext-brain-topic repos you can access on GitHub')
    .action(async () => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      try {
        const repos = await discoverBrainRepos(projectRoot);
        if (repos.length === 0) {
          info('No accessible dreamcontext-brain repos found.');
          return;
        }
        console.log(header('Discoverable Brain Repos'));
        for (const r of repos) info(`${r.fullName}${r.private ? ' (private)' : ''} — ${r.htmlUrl}`);
      } catch (err) {
        error(`Discover failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  brain
    .command('scrub')
    .description('Dry-run the scrub gate against the current staged tree')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      const config = readSetupConfig(projectRoot);
      const mode = resolveMode(config);
      const gitCwd = mode === 'separate' ? contextRoot : projectRoot;
      const hits = scrubStagedFiles(gitCwd);
      const { blocks, warns } = summarizeScrub(hits);
      if (blocks.length === 0 && warns.length === 0) {
        success('Scrub: clean — no hits in staged content.');
        return;
      }
      for (const b of blocks) error(`BLOCK ${b.excerpt}`);
      for (const w of warns) warn(`WARN  ${w.excerpt}`);
      if (blocks.length > 0) process.exitCode = 1;
    });

  brain
    .command('sync')
    .description('Fetch/merge/commit/push the brain repo (or in-tree commit-only)')
    .option('--pull-only', 'Only pull team content in — never pushes')
    .option('--push-only', 'Only stage/scrub/commit/push local changes')
    .option('--strict', 'Treat WARN-tier scrub hits as blocking too')
    .option('--continue', 'Commit an in-progress agent-resolved merge')
    .option('--resume', 'Attended redo of a pull-only-deferred handoff')
    .action(async (opts: { pullOnly?: boolean; pushOnly?: boolean; strict?: boolean; continue?: boolean; resume?: boolean }) => {
      if (opts.continue && opts.resume) {
        error('--continue and --resume are mutually exclusive.');
        process.exitCode = 1;
        return;
      }
      if ((opts.continue || opts.resume) && (opts.pullOnly || opts.pushOnly)) {
        error('--continue/--resume cannot be combined with --pull-only/--push-only.');
        process.exitCode = 1;
        return;
      }

      const contextRoot = ensureContextRoot();
      const syncMode: 'auto' | 'pull-only' | 'push-only' = opts.pullOnly ? 'pull-only' : opts.pushOnly ? 'push-only' : 'auto';

      try {
        const result = await runBrainSync({
          cwd: contextRoot,
          mode: syncMode,
          strict: opts.strict,
          continue: opts.continue,
          resume: opts.resume,
        });
        renderBrainSyncResult(result);
        if (result.action === 'invalid-flag' || result.action === 'blocked-scrub') process.exitCode = 1;
      } catch (err) {
        if (err instanceof GitSyncError) {
          error(err.message);
        } else {
          error(`Brain sync failed: ${(err as Error).message}`);
        }
        process.exitCode = 1;
      }
    });
}

/** Shared renderer — also used by `sleep done`'s brain-sync integration. */
export function renderBrainSyncResult(result: SyncResult): void {
  switch (result.action) {
    case 'noop':
      info('Brain sync: nothing to do.');
      break;
    case 'pushed':
      success('Brain sync: pushed.');
      break;
    case 'pulled':
      success(`Brain sync: pulled${result.pulledUpdates ? ` (${result.pulledUpdates} update(s) merged in)` : ''}.`);
      break;
    case 'skipped-in-tree':
      info('Brain sync: committed (in-tree — never pushes).');
      break;
    case 'disabled':
      info(result.note ?? 'Brain sync: cloud sync is off for this project.');
      break;
    case 'locked':
      warn('Brain sync: another sync is already running.');
      break;
    case 'no-remote':
      warn(result.note ?? 'Brain sync: no brain repo configured yet.');
      break;
    case 'blocked-scrub':
      error('Brain sync BLOCKED: staged/dirty content contains something that looks like a secret.');
      for (const b of result.scrub.blocks) warn(`  ${b.excerpt}`);
      if (result.note) warn(result.note);
      break;
    case 'awaiting-agent':
    case 'already-awaiting-agent':
      warn('Brain sync paused on a team merge — run /dream-sync to reconcile (it will resume or continue as needed).');
      break;
    case 'invalid-flag':
      error(result.note ?? 'Invalid flag combination.');
      break;
    default:
      info(`Brain sync: ${result.action}.`);
  }
}
