import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_PLATFORMS, type PlatformId } from './platforms.js';

// ─── __dirname shim (ESM) ─────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ─── Catalog Types ────────────────────────────────────────────────────────────

export interface CatalogSubSkill {
  name: string;
  file: string;
  description: string;
  hasReferences?: boolean;
}

export interface CatalogPack {
  name: string;
  description: string;
  tags: string[];
  alwaysApply: boolean;
  base: string;
  subSkills: CatalogSubSkill[];
  relatedAgents?: string[];
  crossPackDeps?: string[];
}

export interface CatalogStandalone {
  name: string;
  file: string;
  description: string;
  tags: string[];
  alwaysApply: boolean;
}

export interface CatalogAgent {
  name: string;
  file: string;
  pack: string;
  description: string;
  tags: string[];
  model: string;
}

export interface Catalog {
  version: string;
  packs: CatalogPack[];
  standalone: CatalogStandalone[];
  agents: CatalogAgent[];
}

// ─── Platform / Installation Helpers ─────────────────────────────────────────

/**
 * Root directory where skill packs are installed for a given platform.
 * claude  → <projectRoot>/.claude/skills
 * codex   → <projectRoot>/.agents/skills
 */
export function platformSkillRoot(projectRoot: string, platform: PlatformId): string {
  if (platform === 'claude') return join(projectRoot, '.claude', 'skills');
  return join(projectRoot, '.agents', 'skills');
}

/**
 * Returns true when the named pack's SKILL.md exists for the given platform.
 */
export function isPackInstalledForPlatform(
  projectRoot: string,
  platform: PlatformId,
  name: string,
): boolean {
  return existsSync(join(platformSkillRoot(projectRoot, platform), name, 'SKILL.md'));
}

/**
 * Returns true when the named pack is installed for ANY supported platform.
 */
export function isSkillInstalled(projectRoot: string, name: string): boolean {
  return SUPPORTED_PLATFORMS.some((p) => isPackInstalledForPlatform(projectRoot, p, name));
}

// ─── File Resolution ──────────────────────────────────────────────────────────

/**
 * Find a package subdirectory by probing 3 candidate depths.
 * Works whether running from dist/lib/ (depth 3) or dist/ (depth 2) or src/lib/.
 */
export function findPackageDir(subdir: string): string | null {
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

// ─── Catalog Loading ──────────────────────────────────────────────────────────

/**
 * Load the skill-packs catalog.json.
 * Returns { catalog, packsDir } or null if not found / unreadable.
 * Never throws.
 */
export function loadCatalog(): { catalog: Catalog; packsDir: string } | null {
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
