import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { checkbox, confirm } from '@inquirer/prompts';
import { error, info, warn, miniBox, header } from '../../lib/format.js';
import {
  PLATFORM_CATALOG,
  ensurePlatformSelection,
  formatSupportedPlatforms,
  parsePlatformList,
  type PlatformId,
} from '../../lib/platforms.js';
import {
  readProjectPlatformDefaults,
  writeProjectPlatformDefaults,
  getPlatformDefaultsPath,
} from '../../lib/platform-defaults.js';
import {
  readManifest,
  writeManifest,
  recordFile,
  recordPack,
  recordPlatform,
  emptyManifest,
  dreamcontextVersion,
  type Manifest,
  type ManagedFileKind,
} from '../../lib/manifest.js';
import { readSetupConfig, updateSetupConfig } from '../../lib/setup-config.js';
import { applyClaudeAutoMemory } from '../../lib/claude-settings.js';

// ─── Hook Constants (Claude) ───────────────────────────────────────────────

const SESSION_START_HOOK = 'npx dreamcontext hook session-start';
const STOP_HOOK = 'npx dreamcontext hook stop';
const SUBAGENT_START_HOOK = 'npx dreamcontext hook subagent-start';
const PRE_TOOL_USE_HOOK = 'npx dreamcontext hook pre-tool-use';
const USER_PROMPT_SUBMIT_HOOK = 'npx dreamcontext hook user-prompt-submit';
const POST_TOOL_USE_HOOK = 'npx dreamcontext hook post-tool-use';
const PRE_COMPACT_HOOK = 'npx dreamcontext hook pre-compact';
const ENSURE_DASHBOARD_HOOK = 'npx dreamcontext hook ensure-dashboard';
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
  // Second PreToolUse entry: gates direct writes to protected files (e.g. marketing/.env).
  // The hook.ts action already branches on tool_name, so the same command serves both gates.
  { event: 'PreToolUse', command: PRE_TOOL_USE_HOOK, timeout: 5, matcher: 'Edit|Write|MultiEdit' },
  { event: 'UserPromptSubmit', command: USER_PROMPT_SUBMIT_HOOK, timeout: 120 },
  { event: 'PostToolUse', command: POST_TOOL_USE_HOOK, timeout: 30, matcher: 'Edit|Write' },
  { event: 'PreCompact', command: PRE_COMPACT_HOOK, timeout: 5 },
  // Auto-open the dashboard when a session starts and no server is already up.
  // Separate SessionStart group (own matcher) so it does NOT fire on compaction —
  // mid-session compaction should not relaunch the dashboard. Opt out with
  // DREAMCONTEXT_AUTO_DASHBOARD=0.
  { event: 'SessionStart', command: ENSURE_DASHBOARD_HOOK, timeout: 10, matcher: 'startup|resume' },
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

// ─── Platform Helpers ───────────────────────────────────────────────────────

function platformLabel(_platform: PlatformId): string {
  return 'Claude';
}

function platformPrefixed(platform: PlatformId, relPath: string): string {
  return `${chalk.dim(`[${platform}]`)} ${relPath}`;
}

/**
 * Prefix an installed rel-path with its platform tag for the CLI summary. The
 * lib returns plain (uncolored, unprefixed) rel paths; 'claude' is currently the
 * only supported platform.
 */
function labelInstalledPath(relPath: string): string {
  return platformPrefixed('claude', relPath);
}

/**
 * Drop cross-pack-dep warnings whose recommended dep is ALSO being installed in
 * the same batch. The lib emits one warning per uninstalled dep ("<pack>
 * recommends: <dep …>"); when the user selected the dep in the same command the
 * warning is noise. Matches the dep token after "recommends: ".
 */
function filterBatchDepWarnings(warnings: string[], selectedNames: Set<string>): string[] {
  return warnings.filter((w) => {
    const idx = w.indexOf('recommends: ');
    if (idx === -1) return true;
    const depToken = w.slice(idx + 'recommends: '.length).split(/[\s/(]/)[0];
    return !selectedNames.has(depToken);
  });
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function parsePlatformsOption(raw?: string): PlatformId[] {
  if (!raw) return [];
  const parsed = parsePlatformList(raw);
  if (parsed.invalid.length > 0) {
    throw new Error(
      `Unknown platform(s): ${parsed.invalid.join(', ')}. Supported: ${formatSupportedPlatforms()}`,
    );
  }
  return ensurePlatformSelection(parsed.platforms);
}

async function resolvePlatforms(projectRoot: string, raw?: string): Promise<PlatformId[]> {
  const explicit = parsePlatformsOption(raw);
  if (explicit.length > 0) return explicit;

  const defaults = readProjectPlatformDefaults(projectRoot);
  if (!process.stdin.isTTY) {
    return defaults;
  }

  const selected = await checkbox<PlatformId>({
    message: 'Select platform support to install',
    choices: PLATFORM_CATALOG.map((p) => ({
      value: p.id,
      name: `${chalk.bold(p.label)} ${chalk.dim('— ' + p.description)}`,
      checked: defaults.includes(p.id),
    })),
    pageSize: PLATFORM_CATALOG.length,
  });

  const platforms = ensurePlatformSelection(selected);
  const defaultsPath = getPlatformDefaultsPath(projectRoot);
  if (defaultsPath && !arraysEqual(platforms, defaults)) {
    const shouldSave = await confirm({
      message: `Save selected platforms as project defaults (${platforms.join(', ')})?`,
      default: true,
    });
    if (shouldSave) {
      writeProjectPlatformDefaults(projectRoot, platforms);
      info(`Saved platform defaults to ${chalk.dim(defaultsPath)}`);
    }
  }

  return platforms;
}

// ─── Hook Installation (Claude) ────────────────────────────────────────────

/**
 * Ensure all dreamcontext hooks are installed.
 * Migrates old `npx dreamcontext snapshot` hook if present.
 */
function ensureClaudeHooks(projectRoot: string): { added: string[]; updated: string[]; migrated: boolean } {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const result = { added: [] as string[], updated: [] as string[], migrated: false };

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

  // Register all hooks via data-driven loop.
  // Dedup key is (command, matcher) — two entries with the same command but
  // different matchers are intentionally distinct (e.g. the two PreToolUse
  // entries: one for 'Agent' gate and one for 'Edit|Write|MultiEdit' gate).
  for (const spec of HOOK_SPECS) {
    if (!settings.hooks[spec.event]) {
      settings.hooks[spec.event] = [];
    }
    // Find the existing managed handler (matched on command + matcher) so we can
    // both detect presence AND reconcile its timeout. Without reconciliation a
    // project written by an older installer keeps its stale timeout forever —
    // e.g. UserPromptSubmit installed at 5s before the Haiku recall path (which
    // can take ~15s) made the larger 120s timeout necessary, so the hook keeps
    // timing out after upgrade. Re-running install now heals the drift.
    let existingHandler: HookHandler | undefined;
    for (const group of settings.hooks[spec.event]) {
      if ((group.matcher ?? '') !== (spec.matcher ?? '')) continue;
      const handler = group.hooks?.find((h) => h.command === spec.command);
      if (handler) {
        existingHandler = handler;
        break;
      }
    }
    if (!existingHandler) {
      const group: MatcherGroup = {
        hooks: [{ type: 'command', command: spec.command, timeout: spec.timeout }],
      };
      if (spec.matcher) group.matcher = spec.matcher;
      settings.hooks[spec.event].push(group);
      result.added.push(spec.event);
    } else if (existingHandler.timeout !== spec.timeout) {
      existingHandler.timeout = spec.timeout;
      result.updated.push(spec.event);
    }
  }

  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return result;
}

// ─── Catalog (re-exported from lib/catalog) ──────────────────────────────────

export {
  loadCatalog,
  findPackageDir,
  platformSkillRoot,
  isPackInstalledForPlatform,
  type Catalog,
  type CatalogPack,
  type CatalogStandalone,
  type CatalogSubSkill,
  type CatalogAgent,
} from '../../lib/catalog.js';
import { loadCatalog, findPackageDir, platformSkillRoot, isPackInstalledForPlatform } from '../../lib/catalog.js';
import {
  installPack,
  installAgentForPlatform,
  UnknownPackError,
} from '../../lib/install-packs.js';

// ─── File Resolution ────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
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

// ─── Manifest Helpers ───────────────────────────────────────────────────────

export function getOrCreateManifest(projectRoot: string): Manifest {
  const existing = readManifest(projectRoot);
  if (existing) return existing;
  return emptyManifest();
}

function recordIfManifest(
  manifest: Manifest | undefined,
  relPath: string,
  kind: ManagedFileKind,
): void {
  if (!manifest) return;
  recordFile(manifest, relPath, dreamcontextVersion(), kind);
}

// ─── Interactive Pack Browser ───────────────────────────────────────────────

async function interactivePackInstall(
  projectRoot: string,
  platforms: PlatformId[],
  manifest?: Manifest,
): Promise<void> {
  const loaded = loadCatalog();
  if (!loaded) {
    error('skill-packs not found. Try reinstalling dreamcontext.');
    return;
  }

  const { catalog, packsDir } = loaded;

  // Check what's already installed for selected platforms
  const isInstalled = (name: string) =>
    platforms.every((p) => isPackInstalledForPlatform(projectRoot, p, name));

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
  console.log(chalk.dim(`Platforms: ${platforms.join(', ')}`));
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

  const localManifest = manifest ?? getOrCreateManifest(projectRoot);
  const allInstalled: string[] = [];
  const warnings: string[] = [];
  const selectedNames = new Set(selected.map((sel) => sel.split(':')[1]));

  for (const sel of selected) {
    const [type, name] = sel.split(':');
    console.log();
    info(type === 'pack' ? `Installing ${chalk.bold(name)} pack...` : `Installing ${chalk.bold(name)}...`);
    const result = installPack(name, projectRoot, platforms, localManifest);
    allInstalled.push(...result.installed.map(labelInstalledPath));
    warnings.push(...result.warnings);
  }

  writeManifest(projectRoot, localManifest);
  printInstallSummary(allInstalled, filterBatchDepWarnings(warnings, selectedNames));
}

// ─── Direct Pack Install ────────────────────────────────────────────────────

export function directPackInstall(
  packNames: string[],
  projectRoot: string,
  platforms: PlatformId[],
  manifest?: Manifest,
): void {
  const loaded = loadCatalog();
  if (!loaded) {
    error('skill-packs not found. Try reinstalling dreamcontext.');
    return;
  }

  const localManifest = manifest ?? getOrCreateManifest(projectRoot);
  for (const platform of platforms) recordPlatform(localManifest, platform);

  const { catalog } = loaded;
  const allInstalled: string[] = [];
  const warnings: string[] = [];
  const selectedNames = new Set(packNames);

  for (const name of packNames) {
    const isPackName = catalog.packs.some((p) => p.name === name);
    try {
      info(isPackName ? `Installing ${chalk.bold(name)} pack...` : `Installing ${chalk.bold(name)}...`);
      const result = installPack(name, projectRoot, platforms, localManifest);
      allInstalled.push(...result.installed.map(labelInstalledPath));
      warnings.push(...result.warnings);
    } catch (e: unknown) {
      if (e instanceof UnknownPackError) {
        const available = [
          ...catalog.packs.map((p) => p.name),
          ...catalog.standalone.map((s) => s.name),
        ];
        error(`Pack "${name}" not found.`, `Available: ${available.join(', ')}`);
        continue;
      }
      throw e;
    }
  }

  // Only persist if we own the manifest (caller didn't pass one in).
  if (!manifest) writeManifest(projectRoot, localManifest);

  if (allInstalled.length > 0) {
    printInstallSummary(allInstalled, filterBatchDepWarnings(warnings, selectedNames));
  }
}

// ─── Individual Skill Install ───────────────────────────────────────────────

function installSingleSkill(skillName: string, projectRoot: string, platforms: PlatformId[]): void {
  const loaded = loadCatalog();
  if (!loaded) {
    error('skill-packs not found. Try reinstalling dreamcontext.');
    return;
  }

  const { catalog, packsDir } = loaded;
  const manifest = getOrCreateManifest(projectRoot);
  for (const platform of platforms) recordPlatform(manifest, platform);

  // Search packs for the sub-skill
  for (const pack of catalog.packs) {
    const sub = pack.subSkills.find((s) => s.name === skillName);
    if (!sub) continue;

    const packSourceDir = join(packsDir, pack.name);
    const subSrc = join(packSourceDir, sub.file);

    if (!existsSync(subSrc)) {
      error(`Skill file not found: ${sub.file}`);
      return;
    }

    const installed: string[] = [];

    for (const platform of platforms) {
      const skillRoot = platformSkillRoot(projectRoot, platform);
      const skillDestDir = join(skillRoot, pack.name);
      const subDest = join(skillDestDir, sub.file);
      mkdirSync(dirname(subDest), { recursive: true });
      writeFileSync(subDest, readFileSync(subSrc, 'utf-8'), 'utf-8');

      const skillRootRel = skillRoot.replace(projectRoot + '/', '');
      const subRel = `${skillRootRel}/${pack.name}/${sub.file}`;
      recordFile(manifest, subRel, dreamcontextVersion(), 'pack-skill');
      let label = platformPrefixed(platform, subRel);

      if (sub.hasReferences) {
        const refSrcDir = join(dirname(subSrc), 'references');
        if (existsSync(refSrcDir)) {
          const refDestDir = join(dirname(subDest), 'references');
          cpSync(refSrcDir, refDestDir, { recursive: true });
          const refFiles = readdirSync(refSrcDir).filter((f) => f.endsWith('.md'));
          for (const rf of refFiles) {
            const refRel = `${skillRootRel}/${pack.name}/${dirname(sub.file) === '.' ? '' : dirname(sub.file) + '/'}references/${rf}`;
            recordFile(manifest, refRel, dreamcontextVersion(), 'pack-skill');
          }
          label += chalk.dim(` (+ ${refFiles.length} references)`);
        }
      }

      installed.push(label);
    }

    writeManifest(projectRoot, manifest);

    console.log();
    console.log(miniBox([
      chalk.green.bold(`Skill "${skillName}" installed from ${pack.name} pack`),
      '',
      ...installed.map((f) => `  ${chalk.green('✓')} ${chalk.magentaBright(f)}`),
    ], { color: 'green' }));

    // Warn if base pack not installed
    const baseMissing = platforms.filter((p) => !isPackInstalledForPlatform(projectRoot, p, pack.name));
    if (baseMissing.length > 0) {
      console.log();
      warn(
        `Base ${chalk.bold(pack.name)} pack not installed for ${baseMissing.join(', ')}. `
        + `Run: dreamcontext install-skill --packs ${pack.name} --platforms ${baseMissing.join(',')}`,
      );
    }
    console.log();
    return;
  }

  // Check standalone
  const standalone = catalog.standalone.find((s) => s.name === skillName);
  if (standalone) {
    const result = installPack(standalone.name, projectRoot, platforms, manifest);
    const files = result.installed.map(labelInstalledPath);
    writeManifest(projectRoot, manifest);
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

function listAvailablePacks(projectRoot: string, platforms: PlatformId[]): void {
  const loaded = loadCatalog();
  if (!loaded) {
    error('skill-packs not found. Try reinstalling dreamcontext.');
    return;
  }

  const { catalog } = loaded;

  const isInstalled = (name: string) =>
    platforms.every((p) => isPackInstalledForPlatform(projectRoot, p, name));

  console.log(header('Available Skill Packs'));
  console.log(chalk.dim(`Platforms: ${platforms.join(', ')}`));

  for (const pack of catalog.packs) {
    const installed = isInstalled(pack.name);
    const badge = pack.alwaysApply ? chalk.cyan(' [always active]') : '';
    const status = installed ? chalk.green(' [installed]') : '';

    console.log();
    console.log(`  ${chalk.magentaBright.bold(pack.name)}${badge}${status}`);
    console.log(`  ${chalk.dim(pack.base)}`);

    for (const sub of pack.subSkills) {
      const subInstalled = platforms.every((platform) =>
        existsSync(join(platformSkillRoot(projectRoot, platform), pack.name, sub.file)),
      );
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

export async function installCoreForPlatform(
  platform: PlatformId,
  projectRoot: string,
  manifest?: Manifest,
): Promise<{ installed: string[]; notes: string[] }> {
  const installed: string[] = [];
  const notes: string[] = [];

  const skillSource = findPackageFile('skill', 'SKILL.md');
  if (!skillSource) {
    throw new Error('SKILL.md not found in package. Try reinstalling dreamcontext.');
  }

  if (manifest) recordPlatform(manifest, platform);

  const skillRoot = platformSkillRoot(projectRoot, platform);
  const skillDestDir = join(skillRoot, 'dreamcontext');
  const skillRootRel = skillRoot.replace(projectRoot + '/', '');
  mkdirSync(skillDestDir, { recursive: true });
  writeFileSync(join(skillDestDir, 'SKILL.md'), readFileSync(skillSource, 'utf-8'), 'utf-8');
  const coreSkillRel = `${skillRootRel}/dreamcontext/SKILL.md`;
  recordIfManifest(manifest, coreSkillRel, 'core');
  installed.push(platformPrefixed(platform, coreSkillRel));

  // Copy the skill's references/ directory (progressive-disclosure docs the
  // agent Reads on demand). The skill is a folder, not a lone SKILL.md — the
  // references carry the full CLI surface, ClickUp/dashboard/federation
  // integrations, and the deep sleep/task/knowledge protocols. Without these,
  // the always-loaded core only NAMES capabilities; the references are where
  // their depth lives. Each is recorded as 'core' so `update` refreshes (and
  // never prunes) them alongside SKILL.md.
  const refsSourceDir = join(dirname(skillSource), 'references');
  if (existsSync(refsSourceDir)) {
    const refsDestDir = join(skillDestDir, 'references');
    cpSync(refsSourceDir, refsDestDir, { recursive: true });
    const refFiles = readdirSync(refsSourceDir).filter((f) => f.endsWith('.md'));
    for (const rf of refFiles) {
      const refRel = `${skillRootRel}/dreamcontext/references/${rf}`;
      recordIfManifest(manifest, refRel, 'core');
    }
    if (refFiles.length > 0) {
      installed.push(platformPrefixed(platform, `${skillRootRel}/dreamcontext/references/ ${chalk.dim(`(${refFiles.length} reference${refFiles.length === 1 ? '' : 's'})`)}`));
    }
  }

  // Copy the `initializer` core skill (the interactive, sub-agent-driven brain
  // bootstrap orchestrator). It is foundational, not an optional pack: every
  // project that lacks/under-populates a brain needs it, and the dreamcontext
  // core skill directs the agent to invoke it. Shipped at repo root in
  // `skill-initializer/` (package.json `files`), mirroring how the dreamcontext
  // skill ships from `skill/`. Recorded 'core' so `update` refreshes it.
  // Non-fatal if absent (older/partial packages still install the rest).
  const initSkillSource = findPackageFile('skill-initializer', 'SKILL.md');
  if (initSkillSource) {
    const initDestDir = join(skillRoot, 'initializer');
    mkdirSync(initDestDir, { recursive: true });
    writeFileSync(join(initDestDir, 'SKILL.md'), readFileSync(initSkillSource, 'utf-8'), 'utf-8');
    const initSkillRel = `${skillRootRel}/initializer/SKILL.md`;
    recordIfManifest(manifest, initSkillRel, 'core');
    installed.push(platformPrefixed(platform, initSkillRel));
  }

  // Copy the `curator` core skill (the interactive, sub-agent-driven brain
  // REFACTOR orchestrator). Like the initializer it is foundational, not an
  // optional pack: every maturing brain accretes drift that sleep won't re-order
  // (duplicate knowledge, topics living as both feature and knowledge, stale
  // statuses, off-vocab tags), and the dreamcontext core skill directs the agent
  // to invoke it. Shipped at repo root in `skill-curator/` (package.json
  // `files`), mirroring how the dreamcontext + initializer skills ship. Recorded
  // 'core' so `update` refreshes it. Non-fatal if absent (older/partial packages
  // still install the rest).
  const curatorSkillSource = findPackageFile('skill-curator', 'SKILL.md');
  if (curatorSkillSource) {
    const curatorDestDir = join(skillRoot, 'curator');
    mkdirSync(curatorDestDir, { recursive: true });
    writeFileSync(join(curatorDestDir, 'SKILL.md'), readFileSync(curatorSkillSource, 'utf-8'), 'utf-8');
    const curatorSkillRel = `${skillRootRel}/curator/SKILL.md`;
    recordIfManifest(manifest, curatorSkillRel, 'core');
    installed.push(platformPrefixed(platform, curatorSkillRel));
  }

  // Copy the `dream-sync` core skill (the manual brain-repo sync loop:
  // defer/resume/resolve/continue) — github-cloud-collaboration-brain-repo-sync.
  // Foundational, not an optional pack: any project with a `separate` brain
  // repo needs it to reconcile agent-class conflicts. Shipped at repo root in
  // `skill-sync/` (package.json `files`), mirroring the curator/initializer
  // pattern. Recorded 'core' so `update` refreshes it. Non-fatal if absent
  // (older/partial packages still install the rest).
  const dreamSyncSkillSource = findPackageFile('skill-sync', 'SKILL.md');
  if (dreamSyncSkillSource) {
    const dreamSyncDestDir = join(skillRoot, 'dream-sync');
    mkdirSync(dreamSyncDestDir, { recursive: true });
    writeFileSync(join(dreamSyncDestDir, 'SKILL.md'), readFileSync(dreamSyncSkillSource, 'utf-8'), 'utf-8');
    const dreamSyncSkillRel = `${skillRootRel}/dream-sync/SKILL.md`;
    recordIfManifest(manifest, dreamSyncSkillRel, 'core');
    installed.push(platformPrefixed(platform, dreamSyncSkillRel));

    const dreamSyncRefsSourceDir = join(dirname(dreamSyncSkillSource), 'references');
    if (existsSync(dreamSyncRefsSourceDir)) {
      const dreamSyncRefsDestDir = join(dreamSyncDestDir, 'references');
      cpSync(dreamSyncRefsSourceDir, dreamSyncRefsDestDir, { recursive: true });
      const dreamSyncRefFiles = readdirSync(dreamSyncRefsSourceDir).filter((f) => f.endsWith('.md'));
      for (const rf of dreamSyncRefFiles) {
        recordIfManifest(manifest, `${skillRootRel}/dream-sync/references/${rf}`, 'core');
      }
    }
  }

  // Copy the `dreamcontext-deep-research` core skill (the iterative, sub-agent-driven
  // corpus-synthesis orchestrator — the heavy counterpart to dreamcontext-explore).
  // Like the initializer and curator it is foundational, not an optional pack: any
  // large or multi-project/federated brain eventually hits a question one explore pass
  // can't synthesize, and the dreamcontext core skill directs the agent to escalate to
  // it. Shipped at repo root in `skill-deep-research/` (package.json `files`), mirroring
  // how the dreamcontext + initializer + curator skills ship. It reuses the existing
  // `dreamcontext-explore` agent as its searcher/verifier (no new sub-agent file).
  // Recorded 'core' so `update` refreshes it. Non-fatal if absent (older/partial
  // packages still install the rest).
  const deepResearchSkillSource = findPackageFile('skill-deep-research', 'SKILL.md');
  if (deepResearchSkillSource) {
    const deepResearchDestDir = join(skillRoot, 'dreamcontext-deep-research');
    mkdirSync(deepResearchDestDir, { recursive: true });
    writeFileSync(join(deepResearchDestDir, 'SKILL.md'), readFileSync(deepResearchSkillSource, 'utf-8'), 'utf-8');
    const deepResearchSkillRel = `${skillRootRel}/dreamcontext-deep-research/SKILL.md`;
    recordIfManifest(manifest, deepResearchSkillRel, 'core');
    installed.push(platformPrefixed(platform, deepResearchSkillRel));
  }

  // Copy the `task-agent` core skill (the task-scoped CURATE agent: revise / summarize /
  // split / status-reconcile ONE task document via the CLI). Foundational, not an optional
  // pack: the dashboard's task-detail Curate pane opens a Claude session that names this skill
  // in its first message, so a project whose skills lag would open a curate session with no
  // curate instructions — it would improvise markdown rewrites and desync the Workflow mermaid
  // from the acceptance criteria, which is exactly what the skill exists to prevent. Shipped at
  // repo root in `skill-task-agent/` (package.json `files`), mirroring the curator/dream-sync
  // pattern. Recorded 'core' so `update` refreshes it. Non-fatal if absent (older/partial
  // packages still install the rest).
  const taskAgentSkillSource = findPackageFile('skill-task-agent', 'SKILL.md');
  if (taskAgentSkillSource) {
    const taskAgentDestDir = join(skillRoot, 'task-agent');
    mkdirSync(taskAgentDestDir, { recursive: true });
    writeFileSync(join(taskAgentDestDir, 'SKILL.md'), readFileSync(taskAgentSkillSource, 'utf-8'), 'utf-8');
    const taskAgentSkillRel = `${skillRootRel}/task-agent/SKILL.md`;
    recordIfManifest(manifest, taskAgentSkillRel, 'core');
    installed.push(platformPrefixed(platform, taskAgentSkillRel));
  }

  const agentsSourceDir = findPackageDir('agents');
  if (agentsSourceDir) {
    const agentFiles = readdirSync(agentsSourceDir).filter((f) => f.endsWith('.md'));
    for (const file of agentFiles) {
      const source = join(agentsSourceDir, file);
      const agentRel = installAgentForPlatform(platform, projectRoot, source);
      recordIfManifest(manifest, agentRel, 'agent');
      installed.push(platformPrefixed(platform, agentRel));
    }
  }

  {
    const hookResult = ensureClaudeHooks(projectRoot);
    recordIfManifest(manifest, '.claude/settings.json', 'hook');
    if (hookResult.added.length > 0) {
      installed.push(platformPrefixed(platform, `.claude/settings.json ${chalk.dim(`(${hookResult.added.join(' + ')} hooks)`)}`));
    }
    if (hookResult.updated.length > 0) {
      const updatedEvents = [...new Set(hookResult.updated)].join(' + ');
      notes.push(platformPrefixed(platform, `${chalk.yellow('↑')} ${chalk.dim(`Reconciled hook timeouts (${updatedEvents})`)}`));
    }
    if (hookResult.migrated) {
      notes.push(platformPrefixed(platform, `${chalk.yellow('↑')} ${chalk.dim('Migrated old snapshot hook -> session-start hook')}`));
    }
    if (hookResult.added.length === 0 && hookResult.updated.length === 0 && !hookResult.migrated) {
      notes.push(platformPrefixed(platform, chalk.dim('Hooks already present — skipped')));
    }

    // dreamcontext owns project memory: disable Claude's native auto-memory unless
    // the user opted to keep it (config.disableNativeMemory === false). Config is
    // absent on first install → default true (disable). Idempotent.
    const disableNativeMemory = readSetupConfig(projectRoot)?.disableNativeMemory ?? true;
    const memoryChanged = applyClaudeAutoMemory(projectRoot, disableNativeMemory);
    if (memoryChanged) {
      notes.push(platformPrefixed(platform, disableNativeMemory
        ? chalk.dim('Disabled Claude native auto-memory (autoMemoryEnabled:false) — dreamcontext owns memory')
        : chalk.dim('Enabled Claude native auto-memory (autoMemoryEnabled:true) per config')));
    }
  }

  return { installed, notes };
}

// ─── Command Registration ───────────────────────────────────────────────────

/**
 * When set, the install-skill / install-instructions / install-claude-md /
 * init commands suppress their deprecation hint. The `setup` command sets
 * this so the chained calls don't nag.
 */
export const SETUP_INTERNAL_ENV = 'DREAMCONTEXT_SETUP_INTERNAL';

export function printDeprecationHint(commandName: string): void {
  if (process.env[SETUP_INTERNAL_ENV] === '1') return;
  console.log();
  console.log(
    chalk.magentaBright('ℹ')
      + '  Tip: '
      + chalk.bold('dreamcontext setup')
      + ' runs init + install-skill + install-instructions in one step.'
      + ` The standalone ${chalk.dim(commandName)} command will be removed in v0.5.`,
  );
}

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install dreamcontext skill, agents, and optional packs for selected platforms')
    .option('--platforms <list>', `Comma-separated platforms: ${formatSupportedPlatforms()}`)
    .option('--packs [names...]', 'Install optional skill packs (interactive if no names given)')
    .option('--skill <name>', 'Install a specific sub-skill by name')
    .option('--list', 'List all available skill packs')
    .action(async (opts: { platforms?: string; packs?: boolean | string[]; skill?: string; list?: boolean }) => {
      try {
        const projectRoot = process.cwd();
        const platforms = await resolvePlatforms(projectRoot, opts.platforms);

        // --list: show available packs
        if (opts.list) {
          listAvailablePacks(projectRoot, platforms);
          return;
        }

        // --skill: install a single sub-skill
        if (opts.skill) {
          installSingleSkill(opts.skill, projectRoot, platforms);
          printDeprecationHint('install-skill');
          return;
        }

        // --packs: install optional skill packs
        if (opts.packs !== undefined) {
          const manifest = getOrCreateManifest(projectRoot);
          for (const p of platforms) recordPlatform(manifest, p);
          if (Array.isArray(opts.packs)) {
            directPackInstall(opts.packs, projectRoot, platforms, manifest);
            writeManifest(projectRoot, manifest);
            updateSetupConfig(projectRoot, { platforms, packs: Array.from(new Set([...(opts.packs ?? [])])) });
          } else {
            await interactivePackInstall(projectRoot, platforms, manifest);
          }
          printDeprecationHint('install-skill');
          return;
        }

        // Default: install core dreamcontext skill + agents + hooks for selected platforms
        const manifest = getOrCreateManifest(projectRoot);
        const installed: string[] = [];
        const notes: string[] = [];

        for (const platform of platforms) {
          const result = await installCoreForPlatform(platform, projectRoot, manifest);
          installed.push(...result.installed);
          notes.push(...result.notes);
        }

        writeManifest(projectRoot, manifest);
        updateSetupConfig(projectRoot, { platforms, setupVersion: dreamcontextVersion() });

        console.log();
        console.log(miniBox([
          chalk.green.bold(`✓ Integration installed for ${platforms.map(platformLabel).join(', ')}!`),
          '',
          ...installed.map((f) => `  ${chalk.green('✓')} ${chalk.magentaBright(f)}`),
          ...(notes.length > 0 ? ['', ...notes.map((n) => `  ${n}`)] : []),
        ], { color: 'green' }));
        console.log();
        info(`Platforms active for this install: ${chalk.dim(platforms.join(', '))}`);

        // Hint about optional packs
        const loaded = loadCatalog();
        if (loaded) {
          const packCount = loaded.catalog.packs.length + loaded.catalog.standalone.length;
          console.log();
          info(`${packCount} optional skill packs available. Run: ${chalk.dim('dreamcontext install-skill --packs')}`);
        }

        printDeprecationHint('install-skill');
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
