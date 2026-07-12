import { Command } from 'commander';
import { ensureContextRoot } from '../../lib/context-path.js';
import { dirname } from 'node:path';
import { success, error, warn, info, header } from '../../lib/format.js';
import { readSetupConfig, updateSetupConfig, readBrainLocal } from '../../lib/setup-config.js';
import { runBrainSync, type SyncResult } from '../../lib/git-sync/sync-engine.js';
import {
  resolveMode,
  resolveBrainSyncEnabled,
  ensureFullRepoGitignore,
  resolveBrainSyncToken,
} from '../../lib/git-sync/brain-repo.js';
import { scrubStagedFiles, summarizeScrub } from '../../lib/git-sync/scrub.js';
import { classifySyncError } from '../../lib/git-sync/failure.js';
import { isPerProjectToken } from '../../lib/git-sync/token-fallback.js';
import { reconcileBrainSyncSuccess, reconcileBrainSyncFailure } from '../../lib/git-sync/auth-reconcile.js';
import * as git from '../../lib/git-sync/git.js';
import { GitSyncError } from '../../lib/git-sync/git.js';

/** `dreamcontext brain …` — see `skill-sync/references/merge-rules.md` for the full contract. */
export function registerBrainCommand(program: Command): void {
  const brain = program
    .command('brain')
    .description('Cloud collaboration — sync the whole project (code + brain) to your GitHub origin');

  brain
    .command('status')
    .description('Show sync mode, remote, sync state, and the resolved cloud-sync switch')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      const config = readSetupConfig(projectRoot);
      const mode = resolveMode(config);
      const enabledResolution = resolveBrainSyncEnabled(projectRoot, config);
      const local = readBrainLocal(projectRoot);

      console.log(header('Brain Sync Status'));
      info(`Cloud sync: ${enabledResolution.enabled ? 'ON' : 'OFF'} (${enabledResolution.source})`);
      info(`Mode: ${mode === 'full-repo' ? 'full-repo (whole project → origin)' : 'in-tree (commit-only, never pushes)'}`);
      if (mode === 'full-repo') {
        const remote = git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null;
        info(`Remote: ${remote ?? '(no origin configured)'}`);
      }
      info(`Merge in progress: ${git.isGitRepo(projectRoot) && git.hasMergeHead(projectRoot) ? 'yes' : 'no'}`);
      info(`Pending team-merge handoff: ${local.pendingAgentMerge ? 'yes' : 'no'}`);
      if (local.pulledUpdates) info(`Last pull merged ${local.pulledUpdates} update(s).`);
    });

  brain
    .command('enable')
    .description('Turn cloud sync ON — sync the whole project (code + brain) to your GitHub origin')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      const config = readSetupConfig(projectRoot);
      const origin = git.isGitRepo(projectRoot) ? git.getRemoteUrl(projectRoot, 'origin') : null;
      updateSetupConfig(projectRoot, {
        brainRepo: { ...(config?.brainRepo ?? {}), mode: 'full-repo', enabled: true, autoSync: true },
      });
      // Gitignore-first: exclude machine-local brain state + secrets before the
      // first whole-project sync can stage them.
      ensureFullRepoGitignore(projectRoot, config?.taskBackend);
      if (!origin) {
        warn('Cloud sync enabled, but this project has no GitHub `origin` yet.');
        info('Add one (`git remote add origin …`) — the next sync will push the whole project there.');
      } else {
        success('Cloud sync enabled (whole project → origin).');
      }
    });

  brain
    .command('disable')
    .description('Turn cloud sync OFF — the brain is still committed in-tree locally, never pushed')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      const config = readSetupConfig(projectRoot);
      updateSetupConfig(projectRoot, {
        brainRepo: { ...(config?.brainRepo ?? {}), mode: 'in-tree', enabled: false },
      });
      success('Cloud sync disabled (brain still committed in-tree locally).');
    });

  brain
    .command('scrub')
    .description('Dry-run the scrub gate against the current staged tree')
    .action(() => {
      const contextRoot = ensureContextRoot();
      const projectRoot = dirname(contextRoot);
      const hits = scrubStagedFiles(projectRoot);
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
    .description('Fetch/merge/commit/push the whole project (or in-tree commit-only when cloud sync is off)')
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
        // A CLI sync is a real git op too — reconcile the global sign-in flag off
        // its result so a working sync clears a stale "reconnect" banner (the
        // server route is no longer the only path that keeps the flag honest).
        reconcileBrainSyncSuccess(result.action);
        renderBrainSyncResult(result);
        if (result.action === 'invalid-flag' || result.action === 'blocked-scrub') process.exitCode = 1;
      } catch (err) {
        const projectRoot = dirname(contextRoot);
        reconcileBrainSyncFailure((err as Error).message, projectRoot);
        if (err instanceof GitSyncError) {
          error(err.message);
        } else {
          error(`Brain sync failed: ${(err as Error).message}`);
        }
        // Tier-aware guidance: a stale per-project token still shadowing the
        // signed-in account is the usual cause of a persistent auth/permission
        // failure — name it so the user fixes the right thing.
        const failure = classifySyncError((err as Error).message, undefined, {
          perProjectToken: isPerProjectToken(resolveBrainSyncToken(projectRoot)),
        });
        if ((failure.kind === 'auth' || failure.kind === 'permission') && isPerProjectToken(resolveBrainSyncToken(projectRoot))) {
          warn(failure.message);
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
      warn(result.note ?? 'Brain sync: no git remote (origin) configured yet.');
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
  // Surface the stale-per-project-token self-heal on ANY successful outcome (the
  // note isn't printed by the success/pushed/pulled cases above).
  if (result.healedStaleProjectToken && result.note) info(result.note);
}
