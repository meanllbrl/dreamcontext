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
  // Task backend lines only appear once the feature is in use — projects that
  // never touched taskBackend keep the exact pre-#11 output.
  if (cfg.taskBackend) {
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
    .description('Switch the task backend: local | clickup (issue #11)')
    .action((backend: string) => {
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
        const token = resolveClickUpToken(projectRoot);
        if (!token) {
          info(chalk.dim('No ClickUp token found. Add one with `dreamcontext config clickup-token`.'));
        }
        const cfg = readSetupConfig(projectRoot);
        if (!cfg?.clickup?.listId) {
          info(chalk.dim('Set the ClickUp list with `dreamcontext config clickup-list <teamId> <spaceId> <listId>`.'));
        }
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
