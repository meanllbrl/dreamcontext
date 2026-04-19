import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { error, info, miniBox } from '../../lib/format.js';

const FENCE_START = '<!-- dreamcontext:start -->';
const FENCE_END = '<!-- dreamcontext:end -->';

type Mode = 'append' | 'replace' | 'skip';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function findTemplate(): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'templates', 'CLAUDE.md'),
    join(__dirname, '..', 'templates', 'CLAUDE.md'),
    join(__dirname, 'templates', 'CLAUDE.md'),
    join(__dirname, '..', '..', '..', 'src', 'templates', 'CLAUDE.md'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function buildBlock(templateBody: string): string {
  return `${FENCE_START}\n${templateBody.trim()}\n${FENCE_END}\n`;
}

function hasFence(content: string): boolean {
  return content.includes(FENCE_START) && content.includes(FENCE_END);
}

function replaceFence(content: string, block: string): string {
  const startIdx = content.indexOf(FENCE_START);
  const endIdx = content.indexOf(FENCE_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + FENCE_END.length);
  // Trim a single trailing newline from `before` if present, then re-add structure.
  const trimmedBefore = before.replace(/\n+$/, '');
  const trimmedAfter = after.replace(/^\n+/, '');
  const head = trimmedBefore ? trimmedBefore + '\n\n' : '';
  const tail = trimmedAfter ? '\n\n' + trimmedAfter : '\n';
  return head + block.trimEnd() + tail;
}

function backupPath(target: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${target}.bak-${ts}`;
}

async function resolveMode(target: string, requested?: Mode): Promise<Mode> {
  if (requested) return requested;
  const choice = await select<Mode>({
    message: `CLAUDE.md exists at ${target}. What should I do?`,
    choices: [
      {
        name: 'Append — add a managed dreamcontext block at the end (your content untouched)',
        value: 'append',
      },
      {
        name: 'Replace — backup existing, then overwrite with the dreamcontext template',
        value: 'replace',
      },
      { name: 'Skip — do nothing', value: 'skip' },
    ],
  });
  return choice;
}

interface InstallResult {
  action: 'created' | 'updated' | 'appended' | 'replaced' | 'skipped';
  target: string;
  backup?: string;
}

export async function installClaudeMd(
  projectRoot: string,
  requestedMode?: Mode,
): Promise<InstallResult> {
  const templatePath = findTemplate();
  if (!templatePath) {
    throw new Error('CLAUDE.md template not found. Try reinstalling dreamcontext.');
  }

  const templateBody = readFileSync(templatePath, 'utf-8');
  const block = buildBlock(templateBody);
  const target = join(projectRoot, 'CLAUDE.md');

  // Case 1: no existing CLAUDE.md
  if (!existsSync(target)) {
    writeFileSync(target, block, 'utf-8');
    return { action: 'created', target };
  }

  const existing = readFileSync(target, 'utf-8');

  // Case 2: existing file has our fence — idempotent re-install
  if (hasFence(existing)) {
    const next = replaceFence(existing, block);
    writeFileSync(target, next, 'utf-8');
    return { action: 'updated', target };
  }

  // Case 3: existing file, no fence — ask or use requested mode
  const mode = await resolveMode(target, requestedMode);

  if (mode === 'skip') {
    return { action: 'skipped', target };
  }

  if (mode === 'replace') {
    const backup = backupPath(target);
    copyFileSync(target, backup);
    writeFileSync(target, block, 'utf-8');
    return { action: 'replaced', target, backup };
  }

  // append
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(target, existing + sep + block, 'utf-8');
  return { action: 'appended', target };
}

function printResult(result: InstallResult): void {
  const lines: string[] = [];
  switch (result.action) {
    case 'created':
      lines.push(chalk.green.bold('✓ CLAUDE.md created'));
      lines.push('', `  ${chalk.green('✓')} ${chalk.magentaBright(result.target)}`);
      break;
    case 'updated':
      lines.push(chalk.green.bold('✓ CLAUDE.md managed block updated'));
      lines.push(
        '',
        `  ${chalk.green('✓')} ${chalk.magentaBright(result.target)} ${chalk.dim('(content outside fence preserved)')}`,
      );
      break;
    case 'appended':
      lines.push(chalk.green.bold('✓ CLAUDE.md updated (append)'));
      lines.push(
        '',
        `  ${chalk.green('✓')} ${chalk.magentaBright(result.target)} ${chalk.dim('(your content preserved, dreamcontext block added)')}`,
      );
      break;
    case 'replaced':
      lines.push(chalk.green.bold('✓ CLAUDE.md replaced'));
      lines.push('', `  ${chalk.green('✓')} ${chalk.magentaBright(result.target)}`);
      if (result.backup) {
        lines.push(`  ${chalk.yellow('↑')} ${chalk.dim('Backup: ' + result.backup)}`);
      }
      break;
    case 'skipped':
      lines.push(chalk.dim('CLAUDE.md unchanged.'));
      break;
  }

  console.log();
  console.log(miniBox(lines, { color: result.action === 'skipped' ? 'dim' : 'green' }));
  console.log();
}

export function registerInstallClaudeMdCommand(program: Command): void {
  program
    .command('install-claude-md')
    .description('Install a terse CLAUDE.md at the project root (optional, separate from skill packs)')
    .option('--mode <mode>', 'Conflict mode when CLAUDE.md exists: append | replace | skip')
    .action(async (opts: { mode?: string }) => {
      try {
        const projectRoot = process.cwd();
        const mode = opts.mode as Mode | undefined;

        if (mode && !['append', 'replace', 'skip'].includes(mode)) {
          error(`Invalid --mode "${mode}". Use: append | replace | skip`);
          return;
        }

        const result = await installClaudeMd(projectRoot, mode);
        printResult(result);

        if (result.action === 'appended' || result.action === 'replaced' || result.action === 'created') {
          info(
            `Re-running ${chalk.dim('dreamcontext install-claude-md')} updates only the fenced block.`,
          );
          console.log();
        }
      } catch (err: any) {
        if (err.name === 'ExitPromptError') {
          console.log();
          info('Cancelled.');
          return;
        }
        error(err.message);
      }
    });
}
