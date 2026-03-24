import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { checkbox } from '@inquirer/prompts';
import { success, error, info, warn, miniBox, header } from '../../lib/format.js';

// ─── Hook Constants ─────────────────────────────────────────────────────────

const SESSION_START_HOOK = 'npx dreamcontext hook session-start';
const STOP_HOOK = 'npx dreamcontext hook stop';
const SUBAGENT_START_HOOK = 'npx dreamcontext hook subagent-start';
const PRE_TOOL_USE_HOOK = 'npx dreamcontext hook pre-tool-use';
const USER_PROMPT_SUBMIT_HOOK = 'npx dreamcontext hook user-prompt-submit';
const POST_TOOL_USE_HOOK = 'npx dreamcontext hook post-tool-use';
const PRE_COMPACT_HOOK = 'npx dreamcontext hook pre-compact';
const OLD_HOOK = 'npx dreamcontext snapshot'; // migration target

// ─── Hook Types ─────────────────────────────────────────────────────────────

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

// ─── Catalog Types ──────────────────────────────────────────────────────────

interface CatalogSubSkill {
  name: string;
  file: string;
  description: string;
  hasReferences?: boolean;
}

interface CatalogPack {
  name: string;
  description: string;
  tags: string[];
  alwaysApply: boolean;
  base: string;
  subSkills: CatalogSubSkill[];
  relatedAgents?: string[];
  crossPackDeps?: string[];
}

interface CatalogStandalone {
  name: string;
  file: string;
  description: string;
  tags: string[];
  alwaysApply: boolean;
}

interface CatalogAgent {
  name: string;
  file: string;
  pack: string;
  description: string;
  tags: string[];
  model: string;
}

interface Catalog {
  version: string;
  packs: CatalogPack[];
  standalone: CatalogStandalone[];
  agents: CatalogAgent[];
}

// ─── Hook Installation ──────────────────────────────────────────────────────

/**
 * Ensure all dreamcontext hooks are installed.
 * Migrates old `npx dreamcontext snapshot` hook if present.
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

  // Migration: remove old `npx dreamcontext snapshot` hook from SessionStart
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

// ─── File Resolution ────────────────────────────────────────────────────────

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

// ─── Catalog Loading ────────────────────────────────────────────────────────

function loadCatalog(): { catalog: Catalog; packsDir: string } | null {
  const packsDir = findPackageDir('skill-packs');
  if (!packsDir) return null;

  const catalogPath = join(packsDir, 'catalog.json');
  if (!existsSync(catalogPath)) return null;

  try {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as Catalog;
    return { catalog, packsDir };
  } catch {
    return null;
  }
}

// ─── Pack Installation Logic ────────────────────────────────────────────────

function installPackFiles(
  pack: CatalogPack,
  packsDir: string,
  projectRoot: string,
  catalog: Catalog,
): string[] {
  const installed: string[] = [];
  const packSourceDir = join(packsDir, pack.name);
  const skillDestDir = join(projectRoot, '.claude', 'skills', pack.name);

  // Install base SKILL.md
  const baseSrc = join(packSourceDir, 'SKILL.md');
  if (existsSync(baseSrc)) {
    mkdirSync(skillDestDir, { recursive: true });
    writeFileSync(join(skillDestDir, 'SKILL.md'), readFileSync(baseSrc, 'utf-8'), 'utf-8');
    installed.push(`.claude/skills/${pack.name}/SKILL.md`);
  }

  // Install sub-skills
  for (const sub of pack.subSkills) {
    const subSrc = join(packSourceDir, sub.file);
    if (!existsSync(subSrc)) continue;

    const subDest = join(skillDestDir, sub.file);
    mkdirSync(dirname(subDest), { recursive: true });
    writeFileSync(subDest, readFileSync(subSrc, 'utf-8'), 'utf-8');

    let label = `.claude/skills/${pack.name}/${sub.file}`;

    // Copy references/ directory if present
    if (sub.hasReferences) {
      const refSrcDir = join(dirname(subSrc), 'references');
      if (existsSync(refSrcDir)) {
        const refDestDir = join(dirname(subDest), 'references');
        cpSync(refSrcDir, refDestDir, { recursive: true });
        const refCount = readdirSync(refSrcDir).filter((f) => f.endsWith('.md')).length;
        label += chalk.dim(` (+ ${refCount} references)`);
      }
    }

    installed.push(label);
  }

  // Install related agents
  if (pack.relatedAgents?.length) {
    const agentsDestDir = join(projectRoot, '.claude', 'agents');
    mkdirSync(agentsDestDir, { recursive: true });

    for (const agentName of pack.relatedAgents) {
      const agentEntry = catalog.agents.find((a) => a.name === agentName);
      if (!agentEntry) continue;

      const agentSrc = join(packsDir, agentEntry.file);
      if (!existsSync(agentSrc)) continue;

      const agentDest = join(agentsDestDir, `${agentName}.md`);
      writeFileSync(agentDest, readFileSync(agentSrc, 'utf-8'), 'utf-8');
      installed.push(`.claude/agents/${agentName}.md`);
    }
  }

  return installed;
}

function installStandaloneFiles(
  standalone: CatalogStandalone,
  packsDir: string,
  projectRoot: string,
): string[] {
  const src = join(packsDir, standalone.file);
  if (!existsSync(src)) return [];

  const destDir = join(projectRoot, '.claude', 'skills', standalone.name);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'SKILL.md'), readFileSync(src, 'utf-8'), 'utf-8');
  return [`.claude/skills/${standalone.name}/SKILL.md`];
}

// ─── Interactive Pack Browser ───────────────────────────────────────────────

async function interactivePackInstall(projectRoot: string): Promise<void> {
  const loaded = loadCatalog();
  if (!loaded) {
    error('skill-packs not found. Try reinstalling dreamcontext.');
    return;
  }

  const { catalog, packsDir } = loaded;

  // Check what's already installed
  const isInstalled = (name: string) =>
    existsSync(join(projectRoot, '.claude', 'skills', name, 'SKILL.md'));

  // Build choices: packs + standalone
  const packChoices = catalog.packs.map((p) => {
    const installed = isInstalled(p.name);
    const badge = p.alwaysApply ? chalk.cyan(' [always active]') : '';
    const status = installed ? chalk.green(' (installed)') : '';
    const subCount = p.subSkills.length;
    const agentCount = p.relatedAgents?.length ?? 0;
    const meta = chalk.dim(` ${subCount} skills${agentCount > 0 ? `, ${agentCount} agents` : ''}`);

    return {
      name: `${chalk.bold(p.name.padEnd(18))}${meta}${badge}${status}\n${' '.repeat(20)}${chalk.dim(p.description)}`,
      value: `pack:${p.name}`,
      checked: false,
    };
  });

  const standaloneChoices = catalog.standalone.map((s) => {
    const installed = isInstalled(s.name);
    const status = installed ? chalk.green(' (installed)') : '';

    return {
      name: `${chalk.bold(s.name.padEnd(18))}${chalk.dim('standalone')}${status}\n${' '.repeat(20)}${chalk.dim(s.description)}`,
      value: `standalone:${s.name}`,
      checked: false,
    };
  });

  console.log(header('Optional Skill Packs'));
  console.log();

  const selected = await checkbox({
    message: 'Select packs to install (space to toggle, enter to confirm)',
    choices: [
      ...packChoices,
      ...standaloneChoices,
    ],
    pageSize: 12,
  });

  if (selected.length === 0) {
    info('No packs selected.');
    return;
  }

  const allInstalled: string[] = [];
  const warnings: string[] = [];
  const selectedPackNames = new Set<string>();

  // Collect selected pack names first for dep checking
  for (const sel of selected) {
    const [, name] = sel.split(':');
    selectedPackNames.add(name);
  }

  for (const sel of selected) {
    const [type, name] = sel.split(':');

    if (type === 'pack') {
      const pack = catalog.packs.find((p) => p.name === name);
      if (!pack) continue;

      console.log();
      info(`Installing ${chalk.bold(name)} pack...`);
      const files = installPackFiles(pack, packsDir, projectRoot, catalog);
      allInstalled.push(...files);

      // Cross-pack dependency warnings
      if (pack.crossPackDeps?.length) {
        for (const dep of pack.crossPackDeps) {
          const depPack = dep.split(/[\s/(]/)[0];
          if (!selectedPackNames.has(depPack) && !isInstalled(depPack)) {
            warnings.push(`${chalk.bold(name)} recommends: ${dep}`);
          }
        }
      }
    } else if (type === 'standalone') {
      const standalone = catalog.standalone.find((s) => s.name === name);
      if (!standalone) continue;

      console.log();
      info(`Installing ${chalk.bold(name)}...`);
      const files = installStandaloneFiles(standalone, packsDir, projectRoot);
      allInstalled.push(...files);
    }
  }

  printInstallSummary(allInstalled, warnings);
}

// ─── Direct Pack Install ────────────────────────────────────────────────────

function directPackInstall(packNames: string[], projectRoot: string): void {
  const loaded = loadCatalog();
  if (!loaded) {
    error('skill-packs not found. Try reinstalling dreamcontext.');
    return;
  }

  const { catalog, packsDir } = loaded;
  const allInstalled: string[] = [];
  const warnings: string[] = [];
  const selectedPackNames = new Set(packNames);

  for (const name of packNames) {
    // Check packs
    const pack = catalog.packs.find((p) => p.name === name);
    if (pack) {
      info(`Installing ${chalk.bold(name)} pack...`);
      const files = installPackFiles(pack, packsDir, projectRoot, catalog);
      allInstalled.push(...files);

      if (pack.crossPackDeps?.length) {
        for (const dep of pack.crossPackDeps) {
          const depPack = dep.split(/[\s/(]/)[0];
          const depInstalled = existsSync(join(projectRoot, '.claude', 'skills', depPack, 'SKILL.md'));
          if (!selectedPackNames.has(depPack) && !depInstalled) {
            warnings.push(`${chalk.bold(name)} recommends: ${dep}`);
          }
        }
      }
      continue;
    }

    // Check standalone
    const standalone = catalog.standalone.find((s) => s.name === name);
    if (standalone) {
      info(`Installing ${chalk.bold(name)}...`);
      const files = installStandaloneFiles(standalone, packsDir, projectRoot);
      allInstalled.push(...files);
      continue;
    }

    // Not found
    const available = [
      ...catalog.packs.map((p) => p.name),
      ...catalog.standalone.map((s) => s.name),
    ];
    error(`Pack "${name}" not found.`, `Available: ${available.join(', ')}`);
  }

  if (allInstalled.length > 0) {
    printInstallSummary(allInstalled, warnings);
  }
}

// ─── Individual Skill Install ───────────────────────────────────────────────

function installSingleSkill(skillName: string, projectRoot: string): void {
  const loaded = loadCatalog();
  if (!loaded) {
    error('skill-packs not found. Try reinstalling dreamcontext.');
    return;
  }

  const { catalog, packsDir } = loaded;

  // Search packs for the sub-skill
  for (const pack of catalog.packs) {
    const sub = pack.subSkills.find((s) => s.name === skillName);
    if (!sub) continue;

    const packSourceDir = join(packsDir, pack.name);
    const skillDestDir = join(projectRoot, '.claude', 'skills', pack.name);
    const subSrc = join(packSourceDir, sub.file);

    if (!existsSync(subSrc)) {
      error(`Skill file not found: ${sub.file}`);
      return;
    }

    const subDest = join(skillDestDir, sub.file);
    mkdirSync(dirname(subDest), { recursive: true });
    writeFileSync(subDest, readFileSync(subSrc, 'utf-8'), 'utf-8');

    const installed = [`.claude/skills/${pack.name}/${sub.file}`];

    if (sub.hasReferences) {
      const refSrcDir = join(dirname(subSrc), 'references');
      if (existsSync(refSrcDir)) {
        const refDestDir = join(dirname(subDest), 'references');
        cpSync(refSrcDir, refDestDir, { recursive: true });
        const refCount = readdirSync(refSrcDir).filter((f) => f.endsWith('.md')).length;
        installed[0] += chalk.dim(` (+ ${refCount} references)`);
      }
    }

    console.log();
    console.log(miniBox([
      chalk.green.bold(`Skill "${skillName}" installed from ${pack.name} pack`),
      '',
      ...installed.map((f) => `  ${chalk.green('✓')} ${chalk.magentaBright(f)}`),
    ], { color: 'green' }));

    // Warn if base pack not installed
    const baseInstalled = existsSync(join(skillDestDir, 'SKILL.md'));
    if (!baseInstalled) {
      console.log();
      warn(`Base ${chalk.bold(pack.name)} pack not installed. Run: dreamcontext install-skill --packs ${pack.name}`);
    }
    console.log();
    return;
  }

  // Check standalone
  const standalone = catalog.standalone.find((s) => s.name === skillName);
  if (standalone) {
    const files = installStandaloneFiles(standalone, packsDir, projectRoot);
    console.log();
    console.log(miniBox([
      chalk.green.bold(`Skill "${skillName}" installed`),
      '',
      ...files.map((f) => `  ${chalk.green('✓')} ${chalk.magentaBright(f)}`),
    ], { color: 'green' }));
    console.log();
    return;
  }

  // Not found
  error(`Skill "${skillName}" not found.`);
  console.log(chalk.dim('\n  Available skills:'));
  for (const pack of catalog.packs) {
    for (const sub of pack.subSkills) {
      console.log(`    ${chalk.magentaBright('•')} ${sub.name} ${chalk.dim(`(${pack.name})`)}`);
    }
  }
  for (const s of catalog.standalone) {
    console.log(`    ${chalk.magentaBright('•')} ${s.name} ${chalk.dim('(standalone)')}`);
  }
  console.log();
}

// ─── List Available Packs ───────────────────────────────────────────────────

function listAvailablePacks(projectRoot: string): void {
  const loaded = loadCatalog();
  if (!loaded) {
    error('skill-packs not found. Try reinstalling dreamcontext.');
    return;
  }

  const { catalog } = loaded;

  const isInstalled = (name: string) =>
    existsSync(join(projectRoot, '.claude', 'skills', name, 'SKILL.md'));

  console.log(header('Available Skill Packs'));

  for (const pack of catalog.packs) {
    const installed = isInstalled(pack.name);
    const badge = pack.alwaysApply ? chalk.cyan(' [always active]') : '';
    const status = installed ? chalk.green(' [installed]') : '';

    console.log();
    console.log(`  ${chalk.magentaBright.bold(pack.name)}${badge}${status}`);
    console.log(`  ${chalk.dim(pack.base)}`);

    for (const sub of pack.subSkills) {
      const subInstalled = existsSync(join(projectRoot, '.claude', 'skills', pack.name, sub.file));
      const subStatus = subInstalled ? chalk.green(' ✓') : '';
      console.log(`    ${chalk.dim('•')} ${sub.name}${subStatus} ${chalk.dim('- ' + sub.description)}`);
    }

    if (pack.relatedAgents?.length) {
      console.log(`    ${chalk.dim('agents:')} ${pack.relatedAgents.join(', ')}`);
    }
  }

  if (catalog.standalone.length > 0) {
    console.log();
    console.log(`  ${chalk.dim('─── Standalone ───')}`);
    for (const s of catalog.standalone) {
      const installed = isInstalled(s.name);
      const status = installed ? chalk.green(' [installed]') : '';
      console.log();
      console.log(`  ${chalk.magentaBright.bold(s.name)}${status}`);
      console.log(`  ${chalk.dim(s.description)}`);
    }
  }

  console.log();
  info(`Install packs: ${chalk.dim('dreamcontext install-skill --packs')}`);
  info(`Install one:   ${chalk.dim('dreamcontext install-skill --skill <name>')}`);
  console.log();
}

// ─── Summary Output ─────────────────────────────────────────────────────────

function printInstallSummary(installed: string[], warnings: string[]): void {
  console.log();
  console.log(miniBox([
    chalk.green.bold(`✓ ${installed.length} files installed`),
    '',
    ...installed.map((f) => `  ${chalk.green('✓')} ${chalk.magentaBright(f)}`),
    ...(warnings.length > 0
      ? ['', ...warnings.map((w) => `  ${chalk.yellow('⚠')} ${w}`)]
      : []),
  ], { color: 'green' }));
  console.log();
}

// ─── Command Registration ───────────────────────────────────────────────────

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install dreamcontext skill, agents, and optional skill packs for Claude Code')
    .option('--packs [names...]', 'Install optional skill packs (interactive if no names given)')
    .option('--skill <name>', 'Install a specific sub-skill by name')
    .option('--list', 'List all available skill packs')
    .action(async (opts: { packs?: boolean | string[]; skill?: string; list?: boolean }) => {
      try {
        const projectRoot = process.cwd();

        // --list: show available packs
        if (opts.list) {
          listAvailablePacks(projectRoot);
          return;
        }

        // --skill: install a single sub-skill
        if (opts.skill) {
          installSingleSkill(opts.skill, projectRoot);
          return;
        }

        // --packs: install optional skill packs
        if (opts.packs !== undefined) {
          if (Array.isArray(opts.packs)) {
            directPackInstall(opts.packs, projectRoot);
          } else {
            await interactivePackInstall(projectRoot);
          }
          return;
        }

        // Default: install core dreamcontext skill + agents + hooks
        const skillSource = findPackageFile('skill', 'SKILL.md');
        if (!skillSource) {
          throw new Error('SKILL.md not found in package. Try reinstalling dreamcontext.');
        }

        const skillDestDir = join(projectRoot, '.claude', 'skills', 'dreamcontext');
        const skillDestFile = join(skillDestDir, 'SKILL.md');

        mkdirSync(skillDestDir, { recursive: true });
        writeFileSync(skillDestFile, readFileSync(skillSource, 'utf-8'), 'utf-8');

        const installed: string[] = [`.claude/skills/dreamcontext/SKILL.md`];

        // Install core agents
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

        // Install hooks
        const hookResult = ensureHooks(projectRoot);
        if (hookResult.added.length > 0) {
          installed.push(`.claude/settings.json ${chalk.dim(`(${hookResult.added.join(' + ')} hooks)`)}`);
        }

        const notes: string[] = [];
        if (hookResult.migrated) {
          notes.push(`  ${chalk.yellow('↑')} ${chalk.dim('Migrated old snapshot hook -> session-start hook')}`);
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

        // Hint about optional packs
        const loaded = loadCatalog();
        if (loaded) {
          const packCount = loaded.catalog.packs.length + loaded.catalog.standalone.length;
          console.log();
          info(`${packCount} optional skill packs available. Run: ${chalk.dim('dreamcontext install-skill --packs')}`);
        }
      } catch (err: any) {
        if (err.name === 'ExitPromptError') {
          // User pressed Ctrl+C during interactive prompt
          console.log();
          info('Cancelled.');
          return;
        }
        error(err.message);
      }
    });
}
