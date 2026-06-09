import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { resolveContextRoot } from '../../lib/context-path.js';
import { readSetupConfig, updateSetupConfig } from '../../lib/setup-config.js';
import { applyClaudeAutoMemory } from '../../lib/claude-settings.js';
import { header, success, error, info } from '../../lib/format.js';

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
}
