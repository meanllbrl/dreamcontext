import { Command } from 'commander';
import { dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { resolveContextRoot } from '../../lib/context-path.js';
import { readSetupConfig, updateSetupConfig } from '../../lib/setup-config.js';
import { ensurePeopleSection } from '../../lib/people.js';
import { applyClaudeAutoMemory } from '../../lib/claude-settings.js';
import { header, success, error, info } from '../../lib/format.js';
import { promptInput } from '../../lib/prompt.js';
import { slugify } from '../../lib/id.js';
import {
  hasSecretsFile,
  maskToken,
  resolveClickUpToken,
  writeClickUpToken,
  resolveGitHubToken,
  writeGitHubToken,
} from '../../lib/task-backend/secrets.js';
import { ensureRemoteBackendGitignore } from '../../lib/task-backend/paths.js';
import { installTaskSyncHooks, uninstallTaskSyncHooks, hasManagedTaskSyncHooks } from '../../lib/task-backend/git-hooks.js';
import { createClickUpBackend, discoverClickUpLists } from '../../lib/task-backend/clickup.js';
import { createGitHubBackend, discoverGitHubRepos } from '../../lib/task-backend/github.js';
import { SyncLedger } from '../../lib/task-backend/sync-state.js';
import { join } from 'node:path';
import { confirm, select } from '@inquirer/prompts';

/** Resolve the project root that holds `_dream_context/`, or null. */
function resolveProjectRoot(): string | null {
  const contextRoot = resolveContextRoot();
  return contextRoot ? dirname(contextRoot) : null;
}

function requireProjectRoot(): string | undefined {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    error('Not inside a dreamcontext project.', 'Run `dreamcontext setup` first.');
    process.exitCode = 1;
    return undefined;
  }
  return projectRoot;
}

function printConfig(projectRoot: string): void {
  const cfg = readSetupConfig(projectRoot);
  console.log(header('dreamcontext config'));
  if (!cfg) {
    info('No config file yet. Run `dreamcontext setup` to create one.');
    return;
  }
  const products = cfg.multiProduct === false ? 'single (default)' : cfg.multiProduct.join(', ');
  console.log(`  Platforms:      ${chalk.white(cfg.platforms.join(', ') || '(none)')}`);
  console.log(`  Packs:          ${chalk.white(cfg.packs.join(', ') || '(none)')}`);
  console.log(`  Products:       ${chalk.white(products)}`);
  // Only surface a People line when a roster exists — single-person projects
  // (absent/empty roster) print nothing, keeping the output unchanged.
  if (cfg.people && cfg.people.length > 0) {
    console.log(`  People:         ${chalk.white(cfg.people.join(', '))}`);
  }
  console.log(
    `  Native memory:  ${cfg.disableNativeMemory
      ? chalk.green('disabled') + chalk.dim(' (dreamcontext owns project memory)')
      : chalk.yellow('enabled') + chalk.dim(" (Claude's native MEMORY.md is active)")}`,
  );
  console.log(
    `  Shareable:      ${cfg.shareable === true
      ? chalk.yellow('on') + chalk.dim(' (peer vaults may recall this corpus)')
      : chalk.green('off') + chalk.dim(' (private — default)')}`,
  );
  // Task backend is an ADVANCED setting — its lines only appear once the
  // feature is in use; projects that never touched taskBackend keep the
  // exact pre-#11 output.
  if (cfg.taskBackend) {
    console.log(chalk.dim('\n  Advanced'));
    console.log(`  Task backend:   ${chalk.white(cfg.taskBackend)}`);
    if (cfg.taskBackend === 'clickup') {
      const resolved = resolveClickUpToken(projectRoot);
      const tokenLine = resolved
        ? chalk.green('present') + chalk.dim(` (${resolved.source === 'env' ? `env:${resolved.via}` : 'secrets file'}, ${maskToken(resolved.token)})`)
        : chalk.yellow('absent') + chalk.dim(' (set with `dreamcontext config clickup-token`)');
      console.log(`  ClickUp token:  ${tokenLine}`);
      if (cfg.clickup?.listId) {
        console.log(`  ClickUp list:   ${chalk.dim(cfg.clickup.listId)}`);
      }
    }
    if (cfg.taskBackend === 'github') {
      const resolved = resolveGitHubToken(projectRoot);
      const tokenLine = resolved
        ? chalk.green('present') + chalk.dim(` (${resolved.source === 'env' ? `env:${resolved.via}` : 'secrets file'}, ${maskToken(resolved.token)})`)
        : chalk.yellow('absent') + chalk.dim(' (set with `dreamcontext config github-token`)');
      console.log(`  GitHub token:   ${tokenLine}`);
      if (cfg.github?.owner && cfg.github?.repo) {
        console.log(`  GitHub repo:    ${chalk.dim(`${cfg.github.owner}/${cfg.github.repo}`)}`);
      }
    }
  }
  console.log(`  Setup version:  ${chalk.dim(cfg.setupVersion)}`);
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('View or change dreamcontext project configuration');

  config
    .command('show', { isDefault: true })
    .description('Print the current project configuration')
    .action(() => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;
      printConfig(projectRoot);
    });

  config
    .command('native-memory <state>')
    .description("Toggle Claude Code's native auto-memory: enable | disable (default state: disabled)")
    .action((state: string) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;

      const s = state.toLowerCase();
      const ENABLE = ['enable', 'on', 'true'];
      const DISABLE = ['disable', 'off', 'false'];
      if (!ENABLE.includes(s) && !DISABLE.includes(s)) {
        error(`Unknown state '${state}'.`, 'Use: dreamcontext config native-memory <enable|disable>');
        process.exitCode = 1;
        return;
      }

      const disableNativeMemory = DISABLE.includes(s);
      updateSetupConfig(projectRoot, { disableNativeMemory });
      const changed = applyClaudeAutoMemory(projectRoot, disableNativeMemory);

      if (disableNativeMemory) {
        success("Claude native memory disabled — dreamcontext owns project memory.");
      } else {
        success("Claude native memory enabled — running alongside dreamcontext.");
      }
      info(
        changed
          ? chalk.dim(`.claude/settings.json updated (autoMemoryEnabled: ${!disableNativeMemory}).`)
          : chalk.dim('.claude/settings.json already up to date.'),
      );
    });

  config
    .command('shareable <state>')
    .description('Toggle cross-project federation read access: on | off (default: off — private by default)')
    .action((state: string) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;

      const s = state.toLowerCase();
      const ON = ['on', 'enable', 'true'];
      const OFF = ['off', 'disable', 'false'];
      if (!ON.includes(s) && !OFF.includes(s)) {
        error(`Unknown state '${state}'.`, 'Use: dreamcontext config shareable <on|off>');
        process.exitCode = 1;
        return;
      }

      const shareable = ON.includes(s);
      updateSetupConfig(projectRoot, { shareable });
      if (shareable) {
        success('Federation sharing ON — peer vaults may recall this project\'s corpus.');
      } else {
        success('Federation sharing OFF — this project is private (the default).');
      }
    });

  config
    .command('task-backend <backend>')
    .description('[Advanced] Switch the task backend: local | clickup | github (issue #11)')
    .action(async (backend: string) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;

      const b = backend.toLowerCase();
      if (b !== 'local' && b !== 'clickup' && b !== 'github') {
        error(`Unknown backend '${backend}'.`, 'Use: dreamcontext config task-backend <local|clickup|github>');
        process.exitCode = 1;
        return;
      }

      const isRemote = b === 'clickup' || b === 'github';

      if (isRemote) {
        // The mirror + sync state are derived files — gitignore them BEFORE
        // flipping the backend so nothing derived is ever committable.
        try {
          const added = ensureRemoteBackendGitignore(projectRoot);
          if (added.length > 0) {
            info(chalk.dim(`.gitignore updated (${added.length} entr${added.length === 1 ? 'y' : 'ies'} for the task mirror/sync state).`));
          }
        } catch (err) {
          error(`Could not update .gitignore: ${(err as Error).message}`, 'Fix .gitignore and retry — derived task files must never be committable.');
          process.exitCode = 1;
          return;
        }
      }

      updateSetupConfig(projectRoot, {
        taskBackend: b,
        cloudTaskManagement: isRemote,
      });
      success(`Task backend set to ${b}.`);
      if (b === 'local' && hasManagedTaskSyncHooks(projectRoot)) {
        // The hooks no-op safely on local, but leaving them is untidy.
        if (process.stdin.isTTY) {
          if (await confirm({ message: 'Remove the git sync hooks (post-commit/pre-push)?', default: true })) {
            const removed = uninstallTaskSyncHooks(projectRoot);
            if (removed.length > 0) info(chalk.dim(`git sync hooks removed: ${removed.join(', ')}.`));
          }
        } else {
          info(chalk.dim('git sync hooks are still installed (harmless no-ops on local). Remove with `dreamcontext tasks sync-hooks uninstall`.'));
        }
      }
      if (isRemote) {
        // Best-effort git triggers (post-commit/pre-push); they can never
        // fail or block git, and a non-dreamcontext hook is never clobbered.
        // Backend-generic — they no-op on local and drive sync on any remote.
        try {
          const hooks = installTaskSyncHooks(projectRoot);
          if (hooks.installed.length > 0) {
            info(chalk.dim(`git sync hooks installed: ${hooks.installed.join(', ')} (best-effort, never block git).`));
          }
        } catch { /* hooks are a convenience — never fail the switch */ }
      }

      if (b === 'clickup') {
        const token = resolveClickUpToken(projectRoot);
        const cfg = readSetupConfig(projectRoot);

        if (process.stdin.isTTY) {
          // Guided onboarding: token → connection test → pick the list from
          // the API (no id hunting) → provision fields → first sync.
          if (!token) {
            const key = (await promptInput({
              message: 'ClickUp API key (pk_…; goes to the gitignored secrets file — leave empty to add later):',
            })).trim();
            if (key) {
              try {
                writeClickUpToken(projectRoot, key);
                success(`ClickUp token stored (${maskToken(key)}).`);
              } catch (err) {
                error((err as Error).message);
              }
            } else {
              info(chalk.dim('No token saved. Add one later with `dreamcontext config clickup-token`.'));
            }
          }

          const liveToken = resolveClickUpToken(projectRoot);
          let connected = false;
          if (liveToken) {
            const contextRoot = join(projectRoot, '_dream_context');
            const probe = createClickUpBackend(contextRoot, readSetupConfig(projectRoot));
            const test = await probe.testConnection();
            if (test.ok) {
              success(`Connected to ClickUp as ${test.user}.`);
              connected = true;
            } else {
              error(`Connection test failed: ${test.error}`);
            }
          }

          // List picker — fetched from the API, no URL spelunking.
          let cfgNow = readSetupConfig(projectRoot);
          if (connected && !cfgNow?.clickup?.listId) {
            try {
              info(chalk.dim('Fetching your ClickUp workspaces…'));
              const lists = await discoverClickUpLists(liveToken!.token);
              if (lists.length > 0) {
                const picked = await select({
                  message: 'Which list should tasks sync to?',
                  choices: lists.map((l) => ({
                    value: l,
                    name: `${l.teamName} / ${l.spaceName}${l.folderName ? ` / ${l.folderName}` : ''} / ${chalk.bold(l.listName)}`,
                  })),
                  pageSize: Math.min(12, lists.length),
                });
                updateSetupConfig(projectRoot, {
                  clickup: {
                    teamId: picked.teamId,
                    spaceId: picked.spaceId,
                    listId: picked.listId,
                    changelogTarget: 'comments',
                  },
                });
                success(`Sync target: ${picked.teamName} / ${picked.spaceName} / ${picked.listName}.`);
              } else {
                info(chalk.dim('No lists visible to this token. Set one later with `dreamcontext config clickup-list`.'));
              }
            } catch (err) {
              error(`Could not list workspaces: ${(err as Error).message}`);
              info(chalk.dim('Set the target manually: `dreamcontext config clickup-list <teamId> <spaceId> <listId>`.'));
            }
            cfgNow = readSetupConfig(projectRoot);
          }

          // Provision + first sync — finish in a working state, not a TODO list.
          if (connected && cfgNow?.clickup?.listId) {
            const contextRoot = join(projectRoot, '_dream_context');
            const backend = createClickUpBackend(contextRoot, cfgNow);

            if (await confirm({ message: 'Create the recommended custom fields on the list (urgency, summary, RICE, …)?', default: true })) {
              const result = await backend.provisionRemote();
              if (result.created.length > 0) success(`Created remote fields: ${result.created.join(', ')}`);
              else console.log(chalk.dim('  All recommended fields already exist.'));
              if (result.backfilled > 0) console.log(chalk.dim(`  Backfilled ${result.backfilled} value(s).`));
              for (const e of result.errors) error(e);
            }

            const localCount = (await backend.list({ all: true })).length;
            const syncMsg = localCount > 0
              ? `Run the first sync now? ${localCount} local task(s) will be created in the list.`
              : 'Run the first sync now? (pulls any tasks already in the list)';
            if (await confirm({ message: syncMsg, default: true })) {
              const report = await backend.sync('both');
              if (report.errors.length > 0) {
                for (const e of report.errors) error(e);
              } else {
                success(`Synced: ${report.pushed + report.created} up, ${report.pulled} down${report.conflicts.length > 0 ? `, ${report.conflicts.length} conflict(s) preserved` : ''}.`);
              }
            }

            info(chalk.dim('Assignees: tag tasks `person:<slug>` (see `dreamcontext tasks members`) or pick one in the dashboard.'));
          }
        } else {
          // Non-interactive (scripts/CI): print the next steps instead.
          if (!token) {
            info(chalk.dim('No ClickUp token found. Add one with `dreamcontext config clickup-token`.'));
          }
          if (!cfg?.clickup?.listId) {
            info(chalk.dim('Set the ClickUp list with `dreamcontext config clickup-list <teamId> <spaceId> <listId>`.'));
          }
        }
      }

      if (b === 'github') {
        const token = resolveGitHubToken(projectRoot);
        const cfg = readSetupConfig(projectRoot);

        if (process.stdin.isTTY) {
          // Guided onboarding parallels ClickUp: token → connection test → pick
          // owner/repo from the API (no id hunting) → provision dc:* labels.
          if (!token) {
            const key = (await promptInput({
              message: 'GitHub token (classic PAT with `repo`, or fine-grained with Issues + Metadata; goes to the gitignored secrets file — leave empty to add later):',
            })).trim();
            if (key) {
              try {
                writeGitHubToken(projectRoot, key);
                success(`GitHub token stored (${maskToken(key)}).`);
              } catch (err) {
                error((err as Error).message);
              }
            } else {
              info(chalk.dim('No token saved. Add one later with `dreamcontext config github-token`.'));
            }
          }

          const liveToken = resolveGitHubToken(projectRoot);
          let connected = false;
          if (liveToken) {
            const contextRoot = join(projectRoot, '_dream_context');
            const probe = createGitHubBackend(contextRoot, readSetupConfig(projectRoot));
            const test = await probe.testConnection();
            if (test.ok) {
              success(`Connected to GitHub as ${test.user}.`);
              connected = true;
            } else {
              error(`Connection test failed: ${test.error}`);
            }
          }

          // Repo picker — fetched from the API, no owner/repo spelunking.
          let cfgNow = readSetupConfig(projectRoot);
          if (connected && !(cfgNow?.github?.owner && cfgNow?.github?.repo)) {
            try {
              info(chalk.dim('Fetching your GitHub repositories…'));
              const repos = await discoverGitHubRepos(liveToken!.token);
              if (repos.length > 0) {
                const picked = await select({
                  message: 'Which repository should tasks sync to?',
                  choices: repos.map((r) => ({
                    value: r,
                    name: chalk.bold(r.full_name),
                  })),
                  pageSize: Math.min(12, repos.length),
                });
                updateSetupConfig(projectRoot, {
                  github: {
                    owner: picked.owner,
                    repo: picked.name,
                    changelogTarget: 'comments',
                  },
                });
                success(`Sync target: ${picked.full_name}.`);
              } else {
                info(chalk.dim('No repositories visible to this token. Set one later with `dreamcontext config github-repo <owner> <repo>`.'));
              }
            } catch (err) {
              error(`Could not list repositories: ${(err as Error).message}`);
              info(chalk.dim('Set the target manually: `dreamcontext config github-repo <owner> <repo>`.'));
            }
            cfgNow = readSetupConfig(projectRoot);
          }

          // Provision the recommended dc:* labels — finish in a working state.
          if (connected && cfgNow?.github?.owner && cfgNow?.github?.repo) {
            const contextRoot = join(projectRoot, '_dream_context');
            const backend = createGitHubBackend(contextRoot, cfgNow);

            if (await confirm({ message: 'Create the recommended `dc:*` labels on the repo (sub-status, priority, urgency, …)?', default: true })) {
              const result = await backend.provisionRemote();
              if (result.created.length > 0) success(`Created labels: ${result.created.join(', ')}`);
              else console.log(chalk.dim('  All recommended labels already exist.'));
              for (const e of result.errors) error(e);
            }

            info(chalk.dim('Assignees: tag tasks `person:<slug>` (the person must be a repo collaborator) or pick one in the dashboard.'));
          }
        } else {
          // Non-interactive (scripts/CI): print the next steps instead.
          if (!token) {
            info(chalk.dim('No GitHub token found. Add one with `dreamcontext config github-token`.'));
          }
          if (!(cfg?.github?.owner && cfg?.github?.repo)) {
            info(chalk.dim('Set the GitHub repo with `dreamcontext config github-repo <owner> <repo>`.'));
          }
        }
      }
    });

  config
    .command('people [names...]')
    .description('Set the people roster (display names) and sync the ## People block in 1.user.md')
    .option('--clear', 'Empty the roster (single-person project)')
    .action((names: string[], opts: { clear?: boolean }) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;

      // Resolve the roster: --clear wins; otherwise dedupe the supplied display
      // names (case-insensitive on slug) preserving first-seen order.
      let roster: string[] = [];
      if (!opts.clear) {
        const seen = new Set<string>();
        for (const raw of names) {
          const name = raw.trim();
          if (!name) continue;
          const slug = slugify(name);
          if (!slug || seen.has(slug)) continue;
          seen.add(slug);
          roster.push(name);
        }
        if (roster.length === 0) {
          error('No valid names provided.', 'Usage: dreamcontext config people "Alice" "Bob"  (or --clear)');
          process.exitCode = 1;
          return;
        }
      }

      // updateSetupConfig merges with `patch.people ?? existing.people`, so
      // `undefined` would be a no-op (can't clear). An empty array IS a clear and
      // reads as single-person via isMultiPerson([]) === false.
      updateSetupConfig(projectRoot, { people: roster });

      // Sync the ## People block in 1.user.md. ensurePeopleSection is a no-op for
      // ≤1 person, so a cleared/single roster never adds a block (and an existing
      // block is left in place — note that below so the user can prune it).
      const contextRoot = resolveContextRoot();
      let userMdSynced = false;
      if (contextRoot) {
        const userMdPath = join(contextRoot, 'core', '1.user.md');
        if (existsSync(userMdPath)) {
          try {
            const before = readFileSync(userMdPath, 'utf-8');
            const after = ensurePeopleSection(before, roster);
            if (after !== before) {
              writeFileSync(userMdPath, after, 'utf-8');
              userMdSynced = true;
            }
          } catch (err: any) {
            // Roster is already persisted to config; surface the sync failure
            // cleanly rather than throwing a raw stack trace.
            error(`Could not sync the ## People block in 1.user.md: ${err.message}`);
            process.exitCode = 1;
            return;
          }
        }
      }

      if (roster.length === 0) {
        success('People roster cleared (single-person project).');
        info(chalk.dim('Any existing "## People" block in 1.user.md was left as-is — remove it manually if no longer needed.'));
        return;
      }
      const multi = roster.length > 1;
      success(`People roster set: ${roster.join(', ')}.`);
      info(chalk.dim(`Slugs: ${roster.map((p) => `person:${slugify(p)}`).join(', ')}`));
      if (userMdSynced) info(chalk.dim('Synced the "## People" section in 1.user.md.'));
      if (!multi) {
        info(chalk.dim('Only one person — multi-person attribution stays off until a second person is added.'));
      }
    });

  config
    .command('clickup-member <person> <memberId>')
    .description('[Advanced] Map a person from the roster to a ClickUp member id (assignee round-trip)')
    .option('--token-env <env>', "Env var holding this person's ClickUp API token")
    .action((person: string, memberId: string, opts: { tokenEnv?: string }) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;

      const slug = slugify(person);
      const cfg = readSetupConfig(projectRoot);
      const identity = { ...(cfg?.peopleIdentity ?? {}) };
      identity[slug] = {
        ...(identity[slug] ?? {}),
        clickupMemberId: memberId,
        ...(opts.tokenEnv ? { tokenEnv: opts.tokenEnv } : {}),
      };
      updateSetupConfig(projectRoot, { peopleIdentity: identity });
      success(`Mapped ${slug} → ClickUp member ${memberId}${opts.tokenEnv ? ` (token env: ${opts.tokenEnv})` : ''}.`);
      const roster = (cfg?.people ?? []).map((p) => slugify(p));
      if (roster.length > 0 && !roster.includes(slug)) {
        info(chalk.dim(`Note: '${slug}' is not in the people roster of .config.json — add them there for full multi-person support.`));
      }
    });

  config
    .command('clickup-list <teamId> <spaceId> <listId>')
    .description('Set the ClickUp team/space/list the tasks sync against')
    .option('--migrate', 'When changing lists: reset the sync ledger so the next sync recreates every local task in the NEW list')
    .option('--keep', 'When changing lists: keep existing task mappings (tasks were moved in ClickUp itself)')
    .action(async (teamId: string, spaceId: string, listId: string, opts: { migrate?: boolean; keep?: boolean }) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;
      const contextRoot = join(projectRoot, '_dream_context');
      const existing = readSetupConfig(projectRoot)?.clickup ?? {};
      const ledger = new SyncLedger(contextRoot);
      const changingList = !!existing.listId && existing.listId !== listId && ledger.readMap().length > 0;

      let migrate = opts.migrate === true;
      if (changingList && !opts.migrate && !opts.keep) {
        if (process.stdin.isTTY) {
          migrate = await select({
            message: `The sync target is changing (${existing.listId} → ${listId}) and ${ledger.readMap().length} task(s) are mapped to the old list. What should happen?`,
            choices: [
              { value: true, name: 'Migrate — next sync recreates every local task in the NEW list (old list untouched)' },
              { value: false, name: 'Keep mappings — the tasks were moved within ClickUp itself' },
            ],
          });
        } else {
          error(
            `Changing the sync target would leave ${ledger.readMap().length} task mapping(s) pointing at the old list.`,
            'Re-run with --migrate (recreate tasks in the new list) or --keep (tasks were moved in ClickUp).',
          );
          process.exitCode = 1;
          return;
        }
      }

      if (changingList && migrate) {
        const { backupPath } = ledger.reset();
        info(chalk.dim(`Sync ledger reset${backupPath ? ` (old id-map backed up: ${backupPath})` : ''} — the next sync creates all local tasks in the new list.`));
      } else if (changingList) {
        info(chalk.dim('Task mappings kept — sync keeps updating the existing remote tasks by id.'));
      }

      updateSetupConfig(projectRoot, {
        clickup: { ...existing, teamId, spaceId, listId, changelogTarget: existing.changelogTarget ?? 'comments' },
      });
      success(`ClickUp target set: team ${teamId}, space ${spaceId}, list ${listId}.`);
    });

  config
    .command('clickup-token [token]')
    .description('Store a ClickUp API key in the gitignored secrets file (never .config.json)')
    .option('--user <name>', 'Scope the token to a person from the people roster')
    .action(async (token: string | undefined, opts: { user?: string }) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;

      let value = token;
      if (!value) {
        // Piped value (echo "$KEY" | dreamcontext config clickup-token) or prompt.
        if (!process.stdin.isTTY) {
          try {
            const { readFileSync } = await import('node:fs');
            value = readFileSync(0, 'utf-8').trim();
          } catch {
            value = '';
          }
        }
        if (!value) {
          value = (await promptInput({ message: 'ClickUp API key (pk_…):' })).trim();
        }
      }

      if (!value) {
        error('No token provided.');
        process.exitCode = 1;
        return;
      }

      const user = opts.user ? slugify(opts.user) : undefined;
      try {
        // writeClickUpToken guarantees the .gitignore entry exists BEFORE the
        // secrets file is written, and aborts if .gitignore can't be updated.
        writeClickUpToken(projectRoot, value, user);
      } catch (err) {
        error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      success(
        user
          ? `ClickUp token stored for ${user} (${maskToken(value)}).`
          : `ClickUp token stored (${maskToken(value)}).`,
      );
      if (token) {
        // Passed as a CLI argument → it's now in shell history.
        info(chalk.dim('Tip: pipe it next time (`echo "$KEY" | dreamcontext config clickup-token`) to keep it out of shell history.'));
      }
      info(chalk.dim('Saved to _dream_context/state/.secrets.json (gitignored, mode 0600).'));
      if (!hasSecretsFile(projectRoot)) {
        // Defensive: should be unreachable — writeClickUpToken just wrote it.
        error('Secrets file missing after write — check filesystem permissions.');
        process.exitCode = 1;
      }
    });

  config
    .command('github-repo <owner> <repo>')
    .description('Set the GitHub owner/repo the tasks sync against')
    .action((owner: string, repo: string) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;
      const existing = readSetupConfig(projectRoot)?.github ?? {};
      updateSetupConfig(projectRoot, {
        github: { ...existing, owner: owner.trim(), repo: repo.trim(), changelogTarget: existing.changelogTarget ?? 'comments' },
      });
      success(`GitHub target set: ${owner.trim()}/${repo.trim()}.`);
    });

  config
    .command('github-token [token]')
    .description('Store a GitHub token in the gitignored secrets file (never .config.json)')
    .option('--user <name>', 'Scope the token to a person from the people roster')
    .action(async (token: string | undefined, opts: { user?: string }) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;

      let value = token;
      if (!value) {
        // Piped value (echo "$KEY" | dreamcontext config github-token) or prompt.
        if (!process.stdin.isTTY) {
          try {
            const { readFileSync } = await import('node:fs');
            value = readFileSync(0, 'utf-8').trim();
          } catch {
            value = '';
          }
        }
        if (!value) {
          value = (await promptInput({ message: 'GitHub token (classic PAT with `repo`, or fine-grained with Issues + Metadata):' })).trim();
        }
      }

      if (!value) {
        error('No token provided.');
        process.exitCode = 1;
        return;
      }

      const user = opts.user ? slugify(opts.user) : undefined;
      try {
        // writeGitHubToken guarantees the .gitignore entry exists BEFORE the
        // secrets file is written, and aborts if .gitignore can't be updated.
        writeGitHubToken(projectRoot, value, user);
      } catch (err) {
        error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      success(
        user
          ? `GitHub token stored for ${user} (${maskToken(value)}).`
          : `GitHub token stored (${maskToken(value)}).`,
      );
      if (token) {
        // Passed as a CLI argument → it's now in shell history.
        info(chalk.dim('Tip: pipe it next time (`echo "$KEY" | dreamcontext config github-token`) to keep it out of shell history.'));
      }
      info(chalk.dim('Saved to _dream_context/state/.secrets.json (gitignored, mode 0600).'));
      if (!hasSecretsFile(projectRoot)) {
        // Defensive: should be unreachable — writeGitHubToken just wrote it.
        error('Secrets file missing after write — check filesystem permissions.');
        process.exitCode = 1;
      }
    });
}
