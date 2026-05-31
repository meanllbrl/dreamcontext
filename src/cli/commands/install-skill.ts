import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import chalk from 'chalk';
import matter from 'gray-matter';
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
import { installInstructions } from './install-claude-md.js';
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
import { updateSetupConfig } from '../../lib/setup-config.js';

// ─── Hook Constants (Claude) ───────────────────────────────────────────────

const SESSION_START_HOOK = 'npx dreamcontext hook session-start';
const STOP_HOOK = 'npx dreamcontext hook stop';
const SUBAGENT_START_HOOK = 'npx dreamcontext hook subagent-start';
const PRE_TOOL_USE_HOOK = 'npx dreamcontext hook pre-tool-use';
const USER_PROMPT_SUBMIT_HOOK = 'npx dreamcontext hook user-prompt-submit';
const POST_TOOL_USE_HOOK = 'npx dreamcontext hook post-tool-use';
const PRE_COMPACT_HOOK = 'npx dreamcontext hook pre-compact';
const OLD_HOOK = 'npx dreamcontext snapshot'; // migration target

// ─── Codex Config ──────────────────────────────────────────────────────────

const CODEX_BLOCK_START = '# dreamcontext:codex:start';
const CODEX_BLOCK_END = '# dreamcontext:codex:end';

interface CodexHookSpec {
  event: 'SessionStart' | 'Stop' | 'UserPromptSubmit' | 'PostToolUse';
  command: string;
  timeout: number;
  matcher?: string;
  statusMessage?: string;
}

const CODEX_HOOK_SPECS: CodexHookSpec[] = [
  { event: 'SessionStart', command: SESSION_START_HOOK, timeout: 10, matcher: 'startup|resume|clear' },
  { event: 'Stop', command: STOP_HOOK, timeout: 5 },
  { event: 'UserPromptSubmit', command: USER_PROMPT_SUBMIT_HOOK, timeout: 120 },
  { event: 'PostToolUse', command: POST_TOOL_USE_HOOK, timeout: 30, matcher: 'Edit|Write' },
];

function codexHooksBlock(): string {
  const lines = [
    CODEX_BLOCK_START,
    '# dreamcontext managed hooks for Codex',
    '# SubagentStart, PreCompact, and agent-gating PreToolUse are Claude-specific and omitted here.',
  ];

  for (const spec of CODEX_HOOK_SPECS) {
    lines.push(`[[hooks.${spec.event}]]`);
    if (spec.matcher) lines.push(`matcher = ${JSON.stringify(spec.matcher)}`);
    lines.push('');
    lines.push(`[[hooks.${spec.event}.hooks]]`);
    lines.push('type = "command"');
    lines.push(`command = ${JSON.stringify(spec.command)}`);
    lines.push(`timeout = ${spec.timeout}`);
    if (spec.statusMessage) lines.push(`statusMessage = ${JSON.stringify(spec.statusMessage)}`);
    lines.push('');
  }

  lines.push(CODEX_BLOCK_END, '');
  return lines.join('\n');
}

function ensureCodexHooksFeatureEnabled(content: string): { content: string; updated: boolean } {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const featureIdx = lines.findIndex((line) => line.trim() === '[features]');

  if (featureIdx === -1) {
    const prefix = ['[features]', 'codex_hooks = true', ''].join('\n');
    const suffix = normalized.trimStart();
    return {
      content: suffix ? `${prefix}\n${suffix}` : `${prefix}\n`,
      updated: true,
    };
  }

  let sectionEnd = lines.length;
  for (let i = featureIdx + 1; i < lines.length; i++) {
    if (/^\s*\[\[?.+\]\]?\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  for (let i = featureIdx + 1; i < sectionEnd; i++) {
    if (/^\s*codex_hooks\s*=/.test(lines[i])) {
      if (lines[i].trim() === 'codex_hooks = true') {
        return { content: normalized, updated: false };
      }
      lines[i] = 'codex_hooks = true';
      return { content: lines.join('\n'), updated: true };
    }
  }

  lines.splice(featureIdx + 1, 0, 'codex_hooks = true');
  return { content: lines.join('\n'), updated: true };
}

function ensureCodexConfig(projectRoot: string): { created: boolean; updated: boolean } {
  const configDir = join(projectRoot, '.codex');
  const configPath = join(configDir, 'config.toml');
  const block = codexHooksBlock();

  mkdirSync(configDir, { recursive: true });

  if (!existsSync(configPath)) {
    const initial = ensureCodexHooksFeatureEnabled('').content.trimEnd();
    writeFileSync(configPath, `${initial}\n\n${block}`, 'utf-8');
    return { created: true, updated: true };
  }

  const existing = readFileSync(configPath, 'utf-8');
  const startIdx = existing.indexOf(CODEX_BLOCK_START);
  const endIdx = existing.indexOf(CODEX_BLOCK_END);

  let withoutManaged = existing;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).replace(/\n+$/, '');
    const after = existing.slice(endIdx + CODEX_BLOCK_END.length).replace(/^\n+/, '');
    withoutManaged = `${before}${before && after ? '\n\n' : ''}${after}`;
  }

  const withFeatures = ensureCodexHooksFeatureEnabled(withoutManaged).content.replace(/\n+$/, '');
  const merged = `${withFeatures ? `${withFeatures}\n\n` : ''}${block}`;
  writeFileSync(configPath, merged, 'utf-8');
  return { created: false, updated: true };
}

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
  { event: 'UserPromptSubmit', command: USER_PROMPT_SUBMIT_HOOK, timeout: 120 },
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

// ─── Platform Helpers ───────────────────────────────────────────────────────

function platformLabel(platform: PlatformId): string {
  return platform === 'claude' ? 'Claude' : 'Codex';
}

export function platformSkillRoot(projectRoot: string, platform: PlatformId): string {
  if (platform === 'claude') return join(projectRoot, '.claude', 'skills');
  return join(projectRoot, '.agents', 'skills');
}

function isPackInstalledForPlatform(projectRoot: string, platform: PlatformId, name: string): boolean {
  return existsSync(join(platformSkillRoot(projectRoot, platform), name, 'SKILL.md'));
}

function platformPrefixed(platform: PlatformId, relPath: string): string {
  return `${chalk.dim(`[${platform}]`)} ${relPath}`;
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
function ensureClaudeHooks(projectRoot: string): { added: string[]; migrated: boolean } {
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

// ─── Catalog (re-exported from lib/catalog) ──────────────────────────────────

export {
  loadCatalog,
  findPackageDir,
  type Catalog,
  type CatalogPack,
  type CatalogStandalone,
  type CatalogSubSkill,
  type CatalogAgent,
} from '../../lib/catalog.js';
import { loadCatalog, findPackageDir } from '../../lib/catalog.js';

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

// ─── Agent Installation ─────────────────────────────────────────────────────

interface ParsedAgent {
  name: string;
  description: string;
  model: string;
  body: string;
}

function parseAgentFile(agentPath: string): ParsedAgent {
  const raw = readFileSync(agentPath, 'utf-8');
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  const name = typeof data.name === 'string' && data.name.trim().length > 0
    ? data.name.trim()
    : basename(agentPath, '.md');

  const description = typeof data.description === 'string'
    ? data.description.replace(/\s+/g, ' ').trim()
    : '';

  const model = typeof data.model === 'string' && data.model.trim().length > 0
    ? data.model.trim()
    : 'sonnet';

  return {
    name,
    description,
    model,
    body: parsed.content.trim(),
  };
}

function writeCodexAgent(projectRoot: string, agentPath: string): string {
  const parsed = parseAgentFile(agentPath);
  const agentsDir = join(projectRoot, '.codex', 'agents');
  mkdirSync(agentsDir, { recursive: true });

  const configPath = join(agentsDir, `${parsed.name}.toml`);
  const lines = [
    `name = ${JSON.stringify(parsed.name)}`,
    `description = ${JSON.stringify(parsed.description)}`,
    `model = ${JSON.stringify(parsed.model)}`,
    `developer_instructions = ${JSON.stringify(parsed.body)}`,
    '',
  ];
  writeFileSync(configPath, lines.join('\n'), 'utf-8');

  return `.codex/agents/${parsed.name}.toml`;
}

function installAgentForPlatform(
  platform: PlatformId,
  projectRoot: string,
  agentPath: string,
  agentName?: string,
): string {
  if (platform === 'claude') {
    const agentsDestDir = join(projectRoot, '.claude', 'agents');
    mkdirSync(agentsDestDir, { recursive: true });
    const file = agentName ? `${agentName}.md` : basename(agentPath);
    const dest = join(agentsDestDir, file);
    writeFileSync(dest, readFileSync(agentPath, 'utf-8'), 'utf-8');
    return `.claude/agents/${file}`;
  }

  return writeCodexAgent(projectRoot, agentPath);
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

// ─── Pack Installation Logic ────────────────────────────────────────────────

function installPackFiles(
  pack: CatalogPack,
  packsDir: string,
  projectRoot: string,
  catalog: Catalog,
  platform: PlatformId,
  manifest?: Manifest,
): string[] {
  const installed: string[] = [];
  const packSourceDir = join(packsDir, pack.name);
  const skillRoot = platformSkillRoot(projectRoot, platform);
  const skillDestDir = join(skillRoot, pack.name);
  const skillRootRel = skillRoot.replace(projectRoot + '/', '');

  // Install base SKILL.md
  const baseSrc = join(packSourceDir, 'SKILL.md');
  if (existsSync(baseSrc)) {
    mkdirSync(skillDestDir, { recursive: true });
    writeFileSync(join(skillDestDir, 'SKILL.md'), readFileSync(baseSrc, 'utf-8'), 'utf-8');
    const rel = `${skillRootRel}/${pack.name}/SKILL.md`;
    recordIfManifest(manifest, rel, 'pack-skill');
    installed.push(platformPrefixed(platform, rel));
  }

  // Install sub-skills
  for (const sub of pack.subSkills) {
    const subSrc = join(packSourceDir, sub.file);
    if (!existsSync(subSrc)) continue;

    const subDest = join(skillDestDir, sub.file);
    mkdirSync(dirname(subDest), { recursive: true });
    writeFileSync(subDest, readFileSync(subSrc, 'utf-8'), 'utf-8');
    const subRel = `${skillRootRel}/${pack.name}/${sub.file}`;
    recordIfManifest(manifest, subRel, 'pack-skill');

    let label = platformPrefixed(platform, subRel);

    // Copy references/ directory if present
    if (sub.hasReferences) {
      const refSrcDir = join(dirname(subSrc), 'references');
      if (existsSync(refSrcDir)) {
        const refDestDir = join(dirname(subDest), 'references');
        cpSync(refSrcDir, refDestDir, { recursive: true });
        const refFiles = readdirSync(refSrcDir).filter((f) => f.endsWith('.md'));
        for (const rf of refFiles) {
          const refRel = `${skillRootRel}/${pack.name}/${dirname(sub.file) === '.' ? '' : dirname(sub.file) + '/'}references/${rf}`;
          recordIfManifest(manifest, refRel, 'pack-skill');
        }
        label += chalk.dim(` (+ ${refFiles.length} references)`);
      }
    }

    installed.push(label);
  }

  // Install related agents
  if (pack.relatedAgents?.length) {
    for (const agentName of pack.relatedAgents) {
      const agentEntry = catalog.agents.find((a) => a.name === agentName);
      if (!agentEntry) continue;

      const agentSrc = join(packsDir, agentEntry.file);
      if (!existsSync(agentSrc)) continue;

      const agentRel = installAgentForPlatform(platform, projectRoot, agentSrc, agentName);
      recordIfManifest(manifest, agentRel, 'pack-agent');
      installed.push(platformPrefixed(platform, agentRel));
    }
  }

  if (manifest) {
    recordPack(manifest, pack.name, dreamcontextVersion());
  }

  return installed;
}

function installStandaloneFiles(
  standalone: CatalogStandalone,
  packsDir: string,
  projectRoot: string,
  platform: PlatformId,
  manifest?: Manifest,
): string[] {
  const src = join(packsDir, standalone.file);
  if (!existsSync(src)) return [];

  const skillRoot = platformSkillRoot(projectRoot, platform);
  const destDir = join(skillRoot, standalone.name);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'SKILL.md'), readFileSync(src, 'utf-8'), 'utf-8');
  const rel = `${skillRoot.replace(projectRoot + '/', '')}/${standalone.name}/SKILL.md`;
  recordIfManifest(manifest, rel, 'pack-skill');
  if (manifest) recordPack(manifest, standalone.name, dreamcontextVersion());
  return [platformPrefixed(platform, rel)];
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
      for (const platform of platforms) {
        const files = installPackFiles(pack, packsDir, projectRoot, catalog, platform, manifest);
        allInstalled.push(...files);
      }

      // Cross-pack dependency warnings
      if (pack.crossPackDeps?.length) {
        for (const dep of pack.crossPackDeps) {
          const depPack = dep.split(/[\s/(]/)[0];
          const depInstalled = platforms.every((p) => isPackInstalledForPlatform(projectRoot, p, depPack));
          if (!selectedPackNames.has(depPack) && !depInstalled) {
            warnings.push(`${chalk.bold(name)} recommends: ${dep}`);
          }
        }
      }
    } else if (type === 'standalone') {
      const standalone = catalog.standalone.find((s) => s.name === name);
      if (!standalone) continue;

      console.log();
      info(`Installing ${chalk.bold(name)}...`);
      for (const platform of platforms) {
        const files = installStandaloneFiles(standalone, packsDir, projectRoot, platform, manifest);
        allInstalled.push(...files);
      }
    }
  }

  if (manifest) writeManifest(projectRoot, manifest);
  printInstallSummary(allInstalled, warnings);
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

  const { catalog, packsDir } = loaded;
  const allInstalled: string[] = [];
  const warnings: string[] = [];
  const selectedPackNames = new Set(packNames);

  for (const name of packNames) {
    // Check packs
    const pack = catalog.packs.find((p) => p.name === name);
    if (pack) {
      info(`Installing ${chalk.bold(name)} pack...`);
      for (const platform of platforms) {
        const files = installPackFiles(pack, packsDir, projectRoot, catalog, platform, localManifest);
        allInstalled.push(...files);
      }

      if (pack.crossPackDeps?.length) {
        for (const dep of pack.crossPackDeps) {
          const depPack = dep.split(/[\s/(]/)[0];
          const depInstalled = platforms.every((p) => isPackInstalledForPlatform(projectRoot, p, depPack));
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
      for (const platform of platforms) {
        const files = installStandaloneFiles(standalone, packsDir, projectRoot, platform, localManifest);
        allInstalled.push(...files);
      }
      continue;
    }

    // Not found
    const available = [
      ...catalog.packs.map((p) => p.name),
      ...catalog.standalone.map((s) => s.name),
    ];
    error(`Pack "${name}" not found.`, `Available: ${available.join(', ')}`);
  }

  // Only persist if we own the manifest (caller didn't pass one in).
  if (!manifest) writeManifest(projectRoot, localManifest);

  if (allInstalled.length > 0) {
    printInstallSummary(allInstalled, warnings);
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
    const files: string[] = [];
    for (const platform of platforms) {
      files.push(...installStandaloneFiles(standalone, packsDir, projectRoot, platform, manifest));
    }
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

  if (platform === 'claude') {
    const hookResult = ensureClaudeHooks(projectRoot);
    recordIfManifest(manifest, '.claude/settings.json', 'hook');
    if (hookResult.added.length > 0) {
      installed.push(platformPrefixed(platform, `.claude/settings.json ${chalk.dim(`(${hookResult.added.join(' + ')} hooks)`)}`));
    }
    if (hookResult.migrated) {
      notes.push(platformPrefixed(platform, `${chalk.yellow('↑')} ${chalk.dim('Migrated old snapshot hook -> session-start hook')}`));
    }
    if (hookResult.added.length === 0 && !hookResult.migrated) {
      notes.push(platformPrefixed(platform, chalk.dim('Hooks already present — skipped')));
    }
  } else {
    const codexResult = ensureCodexConfig(projectRoot);
    recordIfManifest(manifest, '.codex/config.toml', 'hook');
    if (codexResult.updated) {
      installed.push(platformPrefixed(platform, '.codex/config.toml (managed hooks block)'));
    }

    // Codex relies on AGENTS.md; use append to avoid destructive replacement in automated installs.
    try {
      const result = await installInstructions(projectRoot, 'codex', 'append');
      if (result.action !== 'skipped') {
        notes.push(platformPrefixed(platform, `Root guidance synced: ${result.target}`));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(platformPrefixed(platform, `${chalk.yellow('⚠')} AGENTS.md install skipped: ${msg}`));
    }

    notes.push(platformPrefixed(platform, chalk.dim('Codex gap: SubagentStart + PreCompact hooks are Claude-only.')));
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
