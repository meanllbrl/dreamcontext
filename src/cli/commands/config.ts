import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { resolveContextRoot } from '../../lib/context-path.js';
import { readSetupConfig, updateSetupConfig } from '../../lib/setup-config.js';
import { applyClaudeAutoMemory } from '../../lib/claude-settings.js';
import { header, success, error, info } from '../../lib/format.js';
import { promptInput } from '../../lib/prompt.js';
import { slugify } from '../../lib/id.js';
import {
  hasSecretsFile,
  maskToken,
  resolveClickUpToken,
  writeClickUpToken,
} from '../../lib/task-backend/secrets.js';
import { ensureRemoteBackendGitignore } from '../../lib/task-backend/paths.js';
import { installTaskSyncHooks } from '../../lib/task-backend/git-hooks.js';

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
    .command('task-backend <backend>')
    .description('[Advanced] Switch the task backend: local | clickup (issue #11)')
    .action(async (backend: string) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;

      const b = backend.toLowerCase();
      if (b !== 'local' && b !== 'clickup') {
        error(`Unknown backend '${backend}'.`, 'Use: dreamcontext config task-backend <local|clickup>');
        process.exitCode = 1;
        return;
      }

      if (b === 'clickup') {
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
        cloudTaskManagement: b === 'clickup',
      });
      success(`Task backend set to ${b}.`);
      if (b === 'clickup') {
        // Best-effort git triggers (post-commit/pre-push); they can never
        // fail or block git, and a non-dreamcontext hook is never clobbered.
        try {
          const hooks = installTaskSyncHooks(projectRoot);
          if (hooks.installed.length > 0) {
            info(chalk.dim(`git sync hooks installed: ${hooks.installed.join(', ')} (best-effort, never block git).`));
          }
        } catch { /* hooks are a convenience — never fail the switch */ }

        const token = resolveClickUpToken(projectRoot);
        const cfg = readSetupConfig(projectRoot);

        if (process.stdin.isTTY) {
          // Guided onboarding: collect everything the sync needs in one go.
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

          if (!cfg?.clickup?.listId) {
            info(chalk.dim('ClickUp IDs: teamId is in the URL (app.clickup.com/{teamId}/…); listId is the `li/{listId}` part of the list URL.'));
            const teamId = (await promptInput({ message: 'Team ID (leave empty to set later):' })).trim();
            const spaceId = teamId ? (await promptInput({ message: 'Space ID:' })).trim() : '';
            const listId = teamId ? (await promptInput({ message: 'List ID:' })).trim() : '';
            if (teamId && listId) {
              updateSetupConfig(projectRoot, {
                clickup: {
                  ...(cfg?.clickup ?? {}),
                  teamId,
                  ...(spaceId ? { spaceId } : {}),
                  listId,
                  changelogTarget: cfg?.clickup?.changelogTarget ?? 'comments',
                },
              });
              success(`ClickUp target set: team ${teamId}${spaceId ? `, space ${spaceId}` : ''}, list ${listId}.`);
            } else {
              info(chalk.dim('Target not set. Use `dreamcontext config clickup-list <teamId> <spaceId> <listId>` when ready.'));
            }
          }

          if ((cfg?.people?.length ?? 0) > 0) {
            info(chalk.dim('Assignees: map people to ClickUp members with `dreamcontext config clickup-member <person> <memberId>`.'));
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
    .action((teamId: string, spaceId: string, listId: string) => {
      const projectRoot = requireProjectRoot();
      if (!projectRoot) return;
      const existing = readSetupConfig(projectRoot)?.clickup ?? {};
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
      info(chalk.dim('Saved to _dream_context/state/.secrets.json (gitignored, mode 0600).'));
      if (!hasSecretsFile(projectRoot)) {
        // Defensive: should be unreachable — writeClickUpToken just wrote it.
        error('Secrets file missing after write — check filesystem permissions.');
        process.exitCode = 1;
      }
    });
}
