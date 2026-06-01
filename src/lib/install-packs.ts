import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import {
  loadCatalog,
  platformSkillRoot,
  isPackInstalledForPlatform,
  type Catalog,
  type CatalogPack,
  type CatalogStandalone,
} from './catalog.js';
import {
  recordFile,
  recordPack,
  recordPlatform,
  isSafeDeletePath,
  dreamcontextVersion,
  walk,
  type Manifest,
  type ManagedFileKind,
} from './manifest.js';
import { SUPPORTED_PLATFORMS, type PlatformId } from './platforms.js';

/**
 * Dependency-free install/uninstall core for skill packs and standalone skills.
 *
 * This module is the extraction of the pure file-operation logic out of
 * `src/cli/commands/install-skill.ts`. It is imported by BOTH the CLI (which
 * re-adds color/UX) AND the dashboard server route — so it MUST NOT import
 * `@inquirer/prompts` or `chalk`. Functions RETURN data (plain rel-path
 * strings); the caller is responsible for presentation.
 */

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface InstallResult {
  installed: string[];
  warnings: string[];
}

export interface UninstallResult {
  removed: string[];
  skipped: string[];
  warnings: string[];
}

// ─── Error Types ──────────────────────────────────────────────────────────────

/** Thrown when the skill-packs catalog cannot be loaded. */
export class CatalogUnavailableError extends Error {
  constructor(message = 'skill-packs catalog not found. Try reinstalling dreamcontext.') {
    super(message);
    this.name = 'CatalogUnavailableError';
  }
}

/** Thrown when a requested pack/standalone name is not in the catalog. */
export class UnknownPackError extends Error {
  constructor(public readonly packName: string, message?: string) {
    super(message ?? `Pack "${packName}" not found.`);
    this.name = 'UnknownPackError';
  }
}

// ─── Agent File Parsing ─────────────────────────────────────────────────────

interface ParsedAgent {
  name: string;
  description: string;
  model: string;
  body: string;
}

export function parseAgentFile(agentPath: string): ParsedAgent {
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

/**
 * Write an agent file for one platform and return its project-relative path.
 * Owned by this lib so there is exactly one copy of the agent-write logic;
 * `installCoreForPlatform` (in install-skill.ts) imports this.
 */
export function installAgentForPlatform(
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

// ─── Manifest Recording ─────────────────────────────────────────────────────

function recordIfManifest(
  manifest: Manifest | undefined,
  relPath: string,
  kind: ManagedFileKind,
): void {
  if (!manifest) return;
  recordFile(manifest, relPath, dreamcontextVersion(), kind);
}

// ─── Pack File Installation ───────────────────────────────────────────────────

/**
 * Install a pack's files (base SKILL.md, sub-skills, references, related agents)
 * for ONE platform. Returns each written file's project-relative path (plain,
 * ANSI-free) so the path is both display-ready and manifest-matchable.
 */
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
  const skillRootRel = skillRoot.replace(projectRoot + sep, '');

  // Install base SKILL.md
  const baseSrc = join(packSourceDir, 'SKILL.md');
  if (existsSync(baseSrc)) {
    mkdirSync(skillDestDir, { recursive: true });
    writeFileSync(join(skillDestDir, 'SKILL.md'), readFileSync(baseSrc, 'utf-8'), 'utf-8');
    const rel = `${skillRootRel}/${pack.name}/SKILL.md`;
    recordIfManifest(manifest, rel, 'pack-skill');
    installed.push(rel);
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
    installed.push(subRel);

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
          // Each reference is its own clean rel-path entry — no label suffix,
          // so the uninstall prefix scan and the no-ANSI assertion both hold.
          installed.push(refRel);
        }
      }
    }
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
      installed.push(agentRel);
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
  const rel = `${skillRoot.replace(projectRoot + sep, '')}/${standalone.name}/SKILL.md`;
  recordIfManifest(manifest, rel, 'pack-skill');
  if (manifest) recordPack(manifest, standalone.name, dreamcontextVersion());
  return [rel];
}

// ─── Public: install ──────────────────────────────────────────────────────────

/**
 * Install one pack or standalone skill across the given platforms, recording
 * every file in the manifest. Throws CatalogUnavailableError if the catalog
 * cannot load, UnknownPackError if `name` is not in the catalog.
 */
export function installPack(
  name: string,
  projectRoot: string,
  platforms: PlatformId[],
  manifest: Manifest,
): InstallResult {
  const loaded = loadCatalog();
  if (!loaded) throw new CatalogUnavailableError();
  const { catalog, packsDir } = loaded;

  const pack = catalog.packs.find((p) => p.name === name);
  const standalone = catalog.standalone.find((s) => s.name === name);
  if (!pack && !standalone) throw new UnknownPackError(name);

  for (const platform of platforms) recordPlatform(manifest, platform);

  const installed: string[] = [];
  const warnings: string[] = [];

  if (pack) {
    for (const platform of platforms) {
      installed.push(...installPackFiles(pack, packsDir, projectRoot, catalog, platform, manifest));
    }

    // Cross-pack dependency warnings (plain strings; CLI/UI presents them).
    if (pack.crossPackDeps?.length) {
      for (const dep of pack.crossPackDeps) {
        const depPack = dep.split(/[\s/(]/)[0];
        const depInstalled = platforms.every((p) => isPackInstalledForPlatform(projectRoot, p, depPack));
        if (!depInstalled) {
          warnings.push(`${name} recommends: ${dep}`);
        }
      }
    }
  } else if (standalone) {
    for (const platform of platforms) {
      installed.push(...installStandaloneFiles(standalone, packsDir, projectRoot, platform, manifest));
    }
  }

  return { installed, warnings };
}

// ─── Uninstall: delete-bound helper (load-bearing) ────────────────────────────

/**
 * Absolute dir to remove for a pack's skills under one platform, or null if
 * `name` does not resolve to a STRICT child of skillRoot. Returns null for '.',
 * '..', names containing '/', absolute paths, and the skillRoot itself — so a
 * caller can never rmSync(skillRoot) or anything at/above it. This is the
 * load-bearing delete bound; both the empty-dir cleanup and the on-disk
 * fallback-walk root flow through it.
 */
export function resolveSkillDirToRemove(skillRoot: string, name: string): string | null {
  if (name.includes('/') || name.includes('\0')) return null; // enforce single-segment
  const abs = safeChildPath(skillRoot, name);                  // null on absolute / escape
  if (!abs || abs === resolve(skillRoot)) return null;          // reject '.' (== skillRoot) and non-strict-child
  return abs;
}

/**
 * Local copy of the server's safeChildPath so the lib stays free of any
 * `../server/*` import (it must remain a pure node-only lib). Resolves `child`
 * under `baseDir`, returning null if it escapes via `..`, an absolute path, or
 * a null byte.
 */
function safeChildPath(baseDir: string, child: string): string | null {
  if (!child || child.includes('\0')) return null;
  const base = resolve(baseDir);
  const target = resolve(base, child);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

// ─── Uninstall: helpers ─────────────────────────────────────────────────────

/**
 * Collect skill-file rel paths to remove for a pack on one platform.
 * Primary source: manifest 'pack-skill' entries under <skillRootRel>/<name>/.
 * Fallback (foreign/legacy install with no manifest record): enumerate the
 * on-disk skill dir.
 */
function collectSkillFiles(
  name: string,
  projectRoot: string,
  platform: PlatformId,
  manifest: Manifest,
  skillDirAbs: string,
): string[] {
  const skillRoot = platformSkillRoot(projectRoot, platform);
  const skillRootRel = skillRoot.replace(projectRoot + sep, '').split('\\').join('/');
  const prefix = `${skillRootRel}/${name}/`;

  const fromManifest = Object.entries(manifest.files)
    .filter(([rel, entry]) => entry.kind === 'pack-skill' && rel.startsWith(prefix))
    .map(([rel]) => rel);

  if (fromManifest.length > 0) return fromManifest;

  // Fallback: on-disk enumeration when the manifest has no record of this pack
  // (e.g. installed before manifests, or out-of-band).
  if (!isPackInstalledForPlatform(projectRoot, platform, name)) return [];
  const files: string[] = [];
  walk(skillDirAbs, '', files);
  return files.map((f) => `${skillRootRel}/${name}/${f}`);
}

/** Project-relative path(s) for a related agent on one platform. */
function agentRelPaths(agentName: string, platform: PlatformId): string[] {
  if (platform === 'claude') return [`.claude/agents/${agentName}.md`];
  return [`.codex/agents/${agentName}.toml`];
}

// ─── Public: uninstall ──────────────────────────────────────────────────────

/**
 * Uninstall one pack or standalone skill across the given platforms. Deletes
 * exactly the files the manifest/catalog attribute to it (within safe-delete
 * prefixes), removes the manifest pack entry, and NEVER deletes a related agent
 * still used by another installed pack.
 *
 * Idempotent: uninstalling an absent-but-catalog-valid pack returns removed:[].
 * Throws UnknownPackError only when `name` is not in the catalog at all.
 */
export function uninstallPack(
  name: string,
  projectRoot: string,
  platforms: PlatformId[],
  manifest: Manifest,
): UninstallResult {
  const loaded = loadCatalog();
  if (!loaded) throw new CatalogUnavailableError();
  const { catalog } = loaded;

  const pack = catalog.packs.find((p) => p.name === name);
  const standalone = catalog.standalone.find((s) => s.name === name);
  if (!pack && !standalone) throw new UnknownPackError(name);

  const relatedAgents = pack?.relatedAgents ?? [];

  const removed: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  // Candidate rel paths to delete (deduped), gathered across platforms.
  const candidates = new Set<string>();

  for (const platform of platforms) {
    const skillRoot = platformSkillRoot(projectRoot, platform);
    const skillDirAbs = resolveSkillDirToRemove(skillRoot, name);

    if (!skillDirAbs) {
      // name does not resolve to a strict child of skillRoot — never touch disk.
      warnings.push(`skipped ${platform}: "${name}" is not a valid skill directory`);
      continue;
    }

    for (const rel of collectSkillFiles(name, projectRoot, platform, manifest, skillDirAbs)) {
      candidates.add(rel);
    }
  }

  // Related agents: keep any agent another still-installed pack depends on.
  for (const agentName of relatedAgents) {
    const keptBy = catalog.packs.find(
      (p) =>
        p.name !== name &&
        (p.relatedAgents ?? []).includes(agentName) &&
        SUPPORTED_PLATFORMS.some((pl) => isPackInstalledForPlatform(projectRoot, pl, p.name)),
    );
    if (keptBy) {
      warnings.push(`kept ${agentName} — still used by ${keptBy.name}`);
      continue;
    }
    for (const platform of platforms) {
      for (const rel of agentRelPaths(agentName, platform)) candidates.add(rel);
    }
  }

  // Delete safe candidates; record unsafe as skipped.
  for (const rel of candidates) {
    if (!isSafeDeletePath(rel)) {
      skipped.push(rel);
      continue;
    }
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue; // idempotent: nothing to remove
    try {
      rmSync(abs, { force: true });
      removed.push(rel);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`could not delete ${rel}: ${msg}`);
    }
  }

  // Remove the now-empty skill dir per platform, bounded by resolveSkillDirToRemove.
  for (const platform of platforms) {
    const skillRoot = platformSkillRoot(projectRoot, platform);
    const skillDirAbs = resolveSkillDirToRemove(skillRoot, name);
    if (skillDirAbs && existsSync(skillDirAbs)) {
      rmSync(skillDirAbs, { recursive: true, force: true });
    }
  }

  // Update manifest: drop file entries we removed + the pack record.
  for (const rel of removed) {
    const normalized = rel.split('\\').join('/');
    delete manifest.files[normalized];
  }
  delete manifest.packs[name];

  return { removed, skipped, warnings };
}
