import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { success, error, info, miniBox } from '../../lib/format.js';

const SESSION_START_HOOK = 'npx agentcontext hook session-start';
const STOP_HOOK = 'npx agentcontext hook stop';
const SUBAGENT_START_HOOK = 'npx agentcontext hook subagent-start';
const PRE_TOOL_USE_HOOK = 'npx agentcontext hook pre-tool-use';
const USER_PROMPT_SUBMIT_HOOK = 'npx agentcontext hook user-prompt-submit';
const POST_TOOL_USE_HOOK = 'npx agentcontext hook post-tool-use';
const PRE_COMPACT_HOOK = 'npx agentcontext hook pre-compact';
const OLD_HOOK = 'npx agentcontext snapshot'; // migration target

interface HookHandler {
  type: string;
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}

interface SettingsJson {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

interface HookSpec {
  event: string;
  command: string;
  timeout: number;
  matcher?: string;
}

const HOOK_SPECS: HookSpec[] = [
  { event: 'SessionStart', command: SESSION_START_HOOK, timeout: 10, matcher: 'startup|resume|compact|clear' },
  { event: 'Stop', command: STOP_HOOK, timeout: 5 },
  { event: 'SubagentStart', command: SUBAGENT_START_HOOK, timeout: 5 },
  { event: 'PreToolUse', command: PRE_TOOL_USE_HOOK, timeout: 5, matcher: 'Agent' },
  { event: 'UserPromptSubmit', command: USER_PROMPT_SUBMIT_HOOK, timeout: 5 },
  { event: 'PostToolUse', command: POST_TOOL_USE_HOOK, timeout: 30, matcher: 'Edit|Write' },
  { event: 'PreCompact', command: PRE_COMPACT_HOOK, timeout: 5 },
];

/**
 * Ensure all agentcontext hooks are installed.
 * Migrates old `npx agentcontext snapshot` hook if present.
 */
function ensureHooks(projectRoot: string): { added: string[]; migrated: boolean } {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const result = { added: [] as string[], migrated: false };

  let settings: SettingsJson = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Migration: remove old `npx agentcontext snapshot` hook from SessionStart
  if (settings.hooks.SessionStart) {
    const oldIdx = settings.hooks.SessionStart.findIndex((group) =>
      group.hooks?.some((h) => h.command === OLD_HOOK),
    );
    if (oldIdx !== -1) {
      settings.hooks.SessionStart.splice(oldIdx, 1);
      result.migrated = true;
    }
  }

  // Register all hooks via data-driven loop
  for (const spec of HOOK_SPECS) {
    if (!settings.hooks[spec.event]) {
      settings.hooks[spec.event] = [];
    }
    const exists = settings.hooks[spec.event].some((group) =>
      group.hooks?.some((h) => h.command === spec.command),
    );
    if (!exists) {
      const group: MatcherGroup = {
        hooks: [{ type: 'command', command: spec.command, timeout: spec.timeout }],
      };
      if (spec.matcher) group.matcher = spec.matcher;
      settings.hooks[spec.event].push(group);
      result.added.push(spec.event);
    }
  }

  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return result;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function findPackageFile(subdir: string, filename: string): string | null {
  const candidates = [
    join(__dirname, '..', '..', '..', subdir, filename),
    join(__dirname, '..', '..', subdir, filename),
    join(__dirname, '..', subdir, filename),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function findPackageDir(subdir: string): string | null {
  const candidates = [
    join(__dirname, '..', '..', '..', subdir),
    join(__dirname, '..', '..', subdir),
    join(__dirname, '..', subdir),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install the agentcontext skill and agents for Claude Code (project-level)')
    .action(() => {
      try {
        const projectRoot = process.cwd();

        // 1. Install skill
        const skillSource = findPackageFile('skill', 'SKILL.md');
        if (!skillSource) {
          throw new Error('SKILL.md not found in package. Try reinstalling agentcontext.');
        }

        const skillDestDir = join(projectRoot, '.claude', 'skills', 'agentcontext');
        const skillDestFile = join(skillDestDir, 'SKILL.md');

        mkdirSync(skillDestDir, { recursive: true });
        writeFileSync(skillDestFile, readFileSync(skillSource, 'utf-8'), 'utf-8');

        const installed: string[] = [`.claude/skills/agentcontext/SKILL.md`];

        // 2. Install agents
        const agentsSourceDir = findPackageDir('agents');
        if (agentsSourceDir) {
          const agentsDestDir = join(projectRoot, '.claude', 'agents');
          mkdirSync(agentsDestDir, { recursive: true });

          const agentFiles = readdirSync(agentsSourceDir).filter((f) => f.endsWith('.md'));
          for (const file of agentFiles) {
            const source = join(agentsSourceDir, file);
            const dest = join(agentsDestDir, file);
            writeFileSync(dest, readFileSync(source, 'utf-8'), 'utf-8');
            installed.push(`.claude/agents/${file}`);
          }
        }

        // 3. Install hooks into .claude/settings.json
        const hookResult = ensureHooks(projectRoot);
        if (hookResult.added.length > 0) {
          installed.push(`.claude/settings.json ${chalk.dim(`(${hookResult.added.join(' + ')} hooks)`)}`);
        }

        const notes: string[] = [];
        if (hookResult.migrated) {
          notes.push(`  ${chalk.yellow('↑')} ${chalk.dim('Migrated old snapshot hook → session-start hook')}`);
        }
        if (hookResult.added.length === 0 && !hookResult.migrated) {
          notes.push(`  ${chalk.dim('Hooks already present — skipped')}`);
        }

        console.log();
        console.log(miniBox([
          chalk.green.bold('✓ Claude Code integration installed!'),
          '',
          ...installed.map((f) => `  ${chalk.green('✓')} ${chalk.magentaBright(f)}`),
          ...(notes.length > 0 ? ['', ...notes] : []),
        ], { color: 'green' }));
        console.log();
        info('Claude Code will auto-detect these when working in this project.');
      } catch (err: any) {
        error(err.message);
      }
    });
}
