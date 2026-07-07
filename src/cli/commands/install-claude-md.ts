import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { error, info, miniBox } from '../../lib/format.js';
import {
  DEFAULT_PLATFORMS,
  formatSupportedPlatforms,
  parsePlatformList,
  type PlatformId,
} from '../../lib/platforms.js';
import { printDeprecationHint } from './install-skill.js';

export type Mode = 'append' | 'replace' | 'skip';

interface InstructionSpec {
  platform: PlatformId;
  targetFile: string;
  templateFile: string;
}

const INSTRUCTION_SPECS: Record<PlatformId, InstructionSpec> = {
  claude: {
    platform: 'claude',
    targetFile: 'CLAUDE.md',
    templateFile: 'CLAUDE.md',
  },
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function getFenceStart(platform: PlatformId): string {
  return `<!-- dreamcontext:${platform}:start -->`;
}

function getFenceEnd(platform: PlatformId): string {
  return `<!-- dreamcontext:${platform}:end -->`;
}

function findTemplate(filename: string): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'templates', filename),
    join(__dirname, '..', 'templates', filename),
    join(__dirname, 'templates', filename),
    join(__dirname, '..', '..', '..', 'src', 'templates', filename),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function buildBlock(platform: PlatformId, templateBody: string): string {
  return `${getFenceStart(platform)}\n${templateBody.trim()}\n${getFenceEnd(platform)}\n`;
}

function hasFence(content: string, platform: PlatformId): boolean {
  return content.includes(getFenceStart(platform)) && content.includes(getFenceEnd(platform));
}

function replaceFence(content: string, platform: PlatformId, block: string): string {
  const startFence = getFenceStart(platform);
  const endFence = getFenceEnd(platform);
  const startIdx = content.indexOf(startFence);
  const endIdx = content.indexOf(endFence);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + endFence.length);
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
    message: `${target} exists. What should I do?`,
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

export interface InstallResult {
  action: 'created' | 'updated' | 'appended' | 'replaced' | 'skipped';
  target: string;
  platform: PlatformId;
  backup?: string;
}

export async function installInstructions(
  projectRoot: string,
  platform: PlatformId,
  requestedMode?: Mode,
): Promise<InstallResult> {
  const spec = INSTRUCTION_SPECS[platform];
  const templatePath = findTemplate(spec.templateFile);
  if (!templatePath) {
    throw new Error(`${spec.templateFile} template not found. Try reinstalling dreamcontext.`);
  }

  const templateBody = readFileSync(templatePath, 'utf-8');
  const block = buildBlock(platform, templateBody);
  const target = join(projectRoot, spec.targetFile);

  if (!existsSync(target)) {
    writeFileSync(target, block, 'utf-8');
    return { action: 'created', target, platform };
  }

  const existing = readFileSync(target, 'utf-8');

  if (hasFence(existing, platform)) {
    const next = replaceFence(existing, platform, block);
    writeFileSync(target, next, 'utf-8');
    return { action: 'updated', target, platform };
  }

  const mode = await resolveMode(spec.targetFile, requestedMode);

  if (mode === 'skip') {
    return { action: 'skipped', target, platform };
  }

  if (mode === 'replace') {
    const backup = backupPath(target);
    copyFileSync(target, backup);
    writeFileSync(target, block, 'utf-8');
    return { action: 'replaced', target, platform, backup };
  }

  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(target, existing + sep + block, 'utf-8');
  return { action: 'appended', target, platform };
}

export async function installClaudeMd(
  projectRoot: string,
  requestedMode?: Mode,
): Promise<InstallResult> {
  return installInstructions(projectRoot, 'claude', requestedMode);
}

function printResult(result: InstallResult): void {
  const lines: string[] = [];
  const fileLabel = INSTRUCTION_SPECS[result.platform].targetFile;
  const platformLabel = 'Claude';

  switch (result.action) {
    case 'created':
      lines.push(chalk.green.bold(`✓ ${fileLabel} created (${platformLabel})`));
      lines.push('', `  ${chalk.green('✓')} ${chalk.magentaBright(result.target)}`);
      break;
    case 'updated':
      lines.push(chalk.green.bold(`✓ ${fileLabel} managed block updated (${platformLabel})`));
      lines.push(
        '',
        `  ${chalk.green('✓')} ${chalk.magentaBright(result.target)} ${chalk.dim('(content outside fence preserved)')}`,
      );
      break;
    case 'appended':
      lines.push(chalk.green.bold(`✓ ${fileLabel} updated (append, ${platformLabel})`));
      lines.push(
        '',
        `  ${chalk.green('✓')} ${chalk.magentaBright(result.target)} ${chalk.dim('(your content preserved, dreamcontext block added)')}`,
      );
      break;
    case 'replaced':
      lines.push(chalk.green.bold(`✓ ${fileLabel} replaced (${platformLabel})`));
      lines.push('', `  ${chalk.green('✓')} ${chalk.magentaBright(result.target)}`);
      if (result.backup) {
        lines.push(`  ${chalk.yellow('↑')} ${chalk.dim('Backup: ' + result.backup)}`);
      }
      break;
    case 'skipped':
      lines.push(chalk.dim(`${fileLabel} unchanged.`));
      break;
  }

  console.log();
  console.log(miniBox(lines, { color: result.action === 'skipped' ? 'dim' : 'green' }));
  console.log();
}

function parsePlatformsOption(raw?: string): PlatformId[] {
  if (!raw) return [...DEFAULT_PLATFORMS];
  const parsed = parsePlatformList(raw);
  if (parsed.invalid.length > 0) {
    throw new Error(
      `Unknown platform(s): ${parsed.invalid.join(', ')}. Supported: ${formatSupportedPlatforms()}`,
    );
  }
  return parsed.platforms.length > 0 ? parsed.platforms : [...DEFAULT_PLATFORMS];
}

export function registerInstallInstructionsCommand(program: Command): void {
  program
    .command('install-instructions')
    .description('Install managed root instruction files (CLAUDE.md)')
    .option('--platforms <list>', `Comma-separated platforms: ${formatSupportedPlatforms()}`)
    .option('--mode <mode>', 'Conflict mode when file exists: append | replace | skip')
    .action(async (opts: { platforms?: string; mode?: string }) => {
      try {
        const projectRoot = process.cwd();
        const mode = opts.mode as Mode | undefined;

        if (mode && !['append', 'replace', 'skip'].includes(mode)) {
          error(`Invalid --mode "${mode}". Use: append | replace | skip`);
          return;
        }

        const platforms = parsePlatformsOption(opts.platforms);
        for (const platform of platforms) {
          const result = await installInstructions(projectRoot, platform, mode);
          printResult(result);
        }
        printDeprecationHint('install-instructions');
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

export function registerInstallClaudeMdCommand(program: Command): void {
  program
    .command('install-claude-md')
    .description('Install a terse CLAUDE.md at the project root (legacy alias; use install-instructions)')
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

        if (
          result.action === 'appended'
          || result.action === 'replaced'
          || result.action === 'created'
        ) {
          info(
            `Re-running ${chalk.dim('dreamcontext install-claude-md')} updates only the fenced block.`,
          );
          console.log();
        }
        printDeprecationHint('install-claude-md');
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
