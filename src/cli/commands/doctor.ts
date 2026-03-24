import { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { resolveContextRoot } from '../../lib/context-path.js';
import { header } from '../../lib/format.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

function checkFile(root: string, relPath: string, label: string, required: boolean): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return {
      name: label,
      status: required ? 'error' : 'warn',
      message: required ? `Missing: ${relPath}` : `Optional file not found: ${relPath}`,
    };
  }

  const stat = statSync(fullPath);
  if (stat.size === 0) {
    return {
      name: label,
      status: 'warn',
      message: `Empty file: ${relPath}`,
    };
  }

  // Check for placeholder content in markdown files
  if (relPath.endsWith('.md')) {
    const content = readFileSync(fullPath, 'utf-8');
    if (content.includes('(Add your') || content.includes('{{') || content.includes('(To be defined)')) {
      return {
        name: label,
        status: 'warn',
        message: `Contains placeholder content: ${relPath}`,
      };
    }
  }

  return { name: label, status: 'ok', message: relPath };
}

function checkJson(root: string, relPath: string, label: string): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return { name: label, status: 'error', message: `Missing: ${relPath}` };
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    JSON.parse(content);
    return { name: label, status: 'ok', message: relPath };
  } catch {
    return { name: label, status: 'error', message: `Malformed JSON: ${relPath}` };
  }
}

function checkDirectory(root: string, relPath: string, label: string): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return { name: label, status: 'error', message: `Missing directory: ${relPath}` };
  }
  return { name: label, status: 'ok', message: relPath };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Validate _dream_context/ structure and report issues')
    .action(() => {
      const root = resolveContextRoot();
      if (!root) {
        console.log(chalk.red('✗') + ' _dream_context/ not found. Run `dreamcontext init` to create it.');
        process.exit(1);
      }

      console.log(header('Doctor'));

      const results: CheckResult[] = [
        // Directories
        checkDirectory(root, 'core', 'Core directory'),
        checkDirectory(root, 'core/features', 'Features directory'),
        checkDirectory(root, 'knowledge', 'Knowledge directory'),
        checkDirectory(root, 'state', 'State directory'),

        // Required core files
        checkFile(root, 'core/0.soul.md', 'Soul file', true),
        checkFile(root, 'core/1.user.md', 'User file', true),
        checkFile(root, 'core/2.memory.md', 'Memory file', true),

        // JSON files
        checkJson(root, 'core/CHANGELOG.json', 'Changelog'),
        checkJson(root, 'core/RELEASES.json', 'Releases'),

        // Optional extended core files
        checkFile(root, 'core/3.style_guide_and_branding.md', 'Style guide', false),
        checkFile(root, 'core/4.tech_stack.md', 'Tech stack', false),
        checkFile(root, 'core/5.data_structures.sql', 'Data structures', false),

        // Sleep state (optional — created on first Stop hook)
        ...(existsSync(join(root, 'state', '.sleep.json'))
          ? [checkJson(root, 'state/.sleep.json', 'Sleep state')]
          : []),
      ];

      // Sleep state specific check: detect corruption
      const sleepPath = join(root, 'state', '.sleep.json');
      if (existsSync(sleepPath)) {
        try {
          const parsed = JSON.parse(readFileSync(sleepPath, 'utf-8'));
          if (typeof parsed.debt !== 'number' || parsed.debt < 0) {
            results.push({ name: 'Sleep debt', status: 'warn', message: 'Invalid debt value in .sleep.json' });
          }
          if (parsed.sessions && !Array.isArray(parsed.sessions)) {
            results.push({ name: 'Sleep sessions', status: 'error', message: 'sessions field is not an array in .sleep.json' });
          }
        } catch {
          // Already caught by checkJson above
        }
      }

      const icons = { ok: chalk.green('✓'), warn: chalk.yellow('⚠'), error: chalk.red('✗') };
      const errors = results.filter(r => r.status === 'error');
      const warnings = results.filter(r => r.status === 'warn');
      const ok = results.filter(r => r.status === 'ok');

      for (const r of results) {
        console.log(`  ${icons[r.status]} ${r.message}`);
      }

      console.log();
      const summary: string[] = [];
      if (ok.length > 0) summary.push(chalk.green(`${ok.length} ok`));
      if (warnings.length > 0) summary.push(chalk.yellow(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`));
      if (errors.length > 0) summary.push(chalk.red(`${errors.length} error${errors.length > 1 ? 's' : ''}`));
      console.log(`  ${summary.join(', ')}`);

      if (errors.length > 0) {
        process.exit(1);
      }
    });
}
