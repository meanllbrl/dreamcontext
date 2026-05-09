import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveContextRoot } from './context-path.js';
import { DEFAULT_PLATFORMS, ensurePlatformSelection, normalizePlatforms, type PlatformId } from './platforms.js';

export interface PlatformDefaultsState {
  version: 1;
  selected: PlatformId[];
  updated_at: string;
}

const DEFAULT_FILE = '.platforms.json';

function defaultsPathFromContextRoot(contextRoot: string): string {
  return join(contextRoot, 'state', DEFAULT_FILE);
}

export function getPlatformDefaultsPath(projectRoot: string): string | null {
  const contextRoot = resolveContextRoot(projectRoot);
  if (!contextRoot) return null;
  return defaultsPathFromContextRoot(contextRoot);
}

export function readProjectPlatformDefaults(projectRoot: string): PlatformId[] {
  const path = getPlatformDefaultsPath(projectRoot);
  if (!path || !existsSync(path)) {
    return [...DEFAULT_PLATFORMS];
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PlatformDefaultsState>;
    if (!Array.isArray(raw.selected)) {
      return [...DEFAULT_PLATFORMS];
    }
    const selected = ensurePlatformSelection(normalizePlatforms(raw.selected));
    return selected;
  } catch {
    return [...DEFAULT_PLATFORMS];
  }
}

export function writeProjectPlatformDefaults(projectRoot: string, selected: PlatformId[]): string | null {
  const path = getPlatformDefaultsPath(projectRoot);
  if (!path) return null;

  const normalized = ensurePlatformSelection(normalizePlatforms(selected));
  mkdirSync(dirname(path), { recursive: true });

  const payload: PlatformDefaultsState = {
    version: 1,
    selected: normalized,
    updated_at: new Date().toISOString(),
  };

  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return path;
}

export function hasProjectContext(projectRoot: string): boolean {
  return getPlatformDefaultsPath(projectRoot) !== null;
}
