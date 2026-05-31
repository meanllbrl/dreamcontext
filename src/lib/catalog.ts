import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
