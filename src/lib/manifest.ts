import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ManagedFileKind =
  | 'core'
  | 'agent'
  | 'skill'
  | 'hook'
  | 'pack-skill'
  | 'pack-agent'
  | 'pack-asset';

export interface ManagedFileEntry {
  version: string;
  kind: ManagedFileKind;
}

export interface Manifest {
  version: string;
  createdAt: string;
  updatedAt: string;
  platforms: string[];
  files: Record<string, ManagedFileEntry>;
  packs: Record<string, { version: string }>;
}

export interface ManifestDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Allowlist of dreamcontext-shipped artifact names used to constrain the
 * legacy bootstrap scan. Anything NOT in these sets is a user-authored file
 * and must never be adopted as dreamcontext-owned (data-loss guard).
 *
 * - agentNames: base names (no extension) of agent files dreamcontext ships
 *   (core agents from repo-root `agents/` + pack agents from catalog).
 * - skillDirs: skill directory names dreamcontext ships ('dreamcontext' core
 *   + every pack/standalone name).
 *
 * Built by `knownArtifactNames()` in catalog.ts and passed into
 * `bootstrapManifestFromScan` — manifest.ts must NOT import catalog.ts
 * (avoids a circular import).
 */
export interface KnownArtifacts {
  agentNames: Set<string>;
  skillDirs: Set<string>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MANIFEST_REL_PATH = '_dream_context/state/.install-manifest.json';

/** Path prefixes that may be safely deleted during an update. */
export const SAFE_DELETE_PREFIXES = ['.claude/'] as const;

// ─── Version Resolution ─────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let cachedVersion: string | null = null;

/**
 * Read the dreamcontext package.json version from disk RIGHT NOW — no cache.
 * Returns '0.0.0' when no valid package.json is found (e.g. mid-upgrade, when
 * npm has the directory in a transient state) so callers can treat that as
 * "unknown" rather than a real version change.
 */
export function readDreamcontextVersionFromDisk(): string {
  const candidates = [
    join(__dirname, '..', '..', 'package.json'),    // dist/package.json (unlikely)
    join(__dirname, '..', '..', '..', 'package.json'), // repo root from src/lib or dist/lib
    join(__dirname, '..', 'package.json'),
    join(__dirname, 'package.json'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf-8'));
      if (typeof pkg.name === 'string' && pkg.name === 'dreamcontext' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // continue
    }
  }

  return '0.0.0';
}

/**
 * Read the dreamcontext CLI's own package.json version.
 * Searches typical locations relative to this compiled file.
 */
export function dreamcontextVersion(): string {
  if (cachedVersion) return cachedVersion;
  cachedVersion = readDreamcontextVersionFromDisk();
  return cachedVersion;
}

// ─── Read / Write ───────────────────────────────────────────────────────────

function manifestPath(projectRoot: string): string {
  return join(projectRoot, MANIFEST_REL_PATH);
}

export function readManifest(projectRoot: string): Manifest | null {
  const path = manifestPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Manifest>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      platforms: Array.isArray(parsed.platforms) ? parsed.platforms.filter((p): p is string => typeof p === 'string') : [],
      files: (parsed.files && typeof parsed.files === 'object')
        ? parsed.files as Record<string, ManagedFileEntry>
        : {},
      packs: (parsed.packs && typeof parsed.packs === 'object')
        ? parsed.packs as Record<string, { version: string }>
        : {},
    };
  } catch {
    return null;
  }
}

export function writeManifest(projectRoot: string, manifest: Manifest): void {
  const path = manifestPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

// ─── Manifest Construction ──────────────────────────────────────────────────

export function emptyManifest(): Manifest {
  const now = new Date().toISOString();
  return {
    version: dreamcontextVersion(),
    createdAt: now,
    updatedAt: now,
    platforms: [],
    files: {},
    packs: {},
  };
}

/** Mutate manifest in place to record a managed file. */
export function recordFile(
  manifest: Manifest,
  relPath: string,
  version: string,
  kind: ManagedFileKind,
): void {
  // Normalize to forward slashes.
  const normalized = relPath.split('\\').join('/');
  manifest.files[normalized] = { version, kind };
}

export function recordPack(manifest: Manifest, name: string, version: string): void {
  manifest.packs[name] = { version };
}

export function recordPlatform(manifest: Manifest, platform: string): void {
  if (!manifest.platforms.includes(platform)) {
    manifest.platforms.push(platform);
  }
}

// ─── Diff ───────────────────────────────────────────────────────────────────

export function diffManifests(oldM: Manifest, nextM: Manifest): ManifestDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  const oldFiles = oldM.files ?? {};
  const newFiles = nextM.files ?? {};

  for (const path of Object.keys(newFiles)) {
    if (!(path in oldFiles)) {
      added.push(path);
    } else if (oldFiles[path].version !== newFiles[path].version) {
      changed.push(path);
    }
  }

  for (const path of Object.keys(oldFiles)) {
    if (!(path in newFiles)) removed.push(path);
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

// ─── Safety ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the given path may be safely deleted by the update command.
 * Only paths under `.claude/` are considered safe.
 * Notably, anything under `_dream_context/` is NEVER safe to delete (user data).
 */
export function isSafeDeletePath(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  if (normalized.includes('..')) return false;
  if (normalized.startsWith('/')) return false;
  return SAFE_DELETE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// ─── Bootstrap (legacy projects without a manifest) ─────────────────────────

export const PRE_MANIFEST_VERSION = 'pre-manifest';

export function walk(dir: string, relBase: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = relBase ? `${relBase}/${entry}` : entry;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, rel, out);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * Scan platform integration directories to build a baseline manifest for
 * projects that were installed before manifests existed. All entries are
 * marked with version `pre-manifest`.
 *
 * Only files whose name is in the `known` allowlist are adopted — user-authored
 * agents/skills (e.g. a custom `.claude/agents/watchlist-monitor.md`) are left
 * untracked so a later `update` never offers to delete them (data-loss guard).
 *
 * - .claude/skills/<dir>/**         → core ('dreamcontext') / pack-skill, if dir ∈ known.skillDirs
 * - .claude/agents/<name>.md         → agent, if name ∈ known.agentNames
 * - .claude/settings.json            → hook (always — out of allowlist scope)
 */
export function bootstrapManifestFromScan(projectRoot: string, known: KnownArtifacts): Manifest {
  const m = emptyManifest();
  m.version = PRE_MANIFEST_VERSION;

  // Claude
  const claudeSkillsRoot = join(projectRoot, '.claude', 'skills');
  if (existsSync(claudeSkillsRoot)) {
    recordPlatform(m, 'claude');
    for (const entry of readdirSync(claudeSkillsRoot)) {
      const sub = join(claudeSkillsRoot, entry);
      if (!statSync(sub).isDirectory()) continue;
      if (!known.skillDirs.has(entry)) continue; // skip user-authored skill dirs
      const files: string[] = [];
      walk(sub, '', files);
      const kind: ManagedFileKind = entry === 'dreamcontext' ? 'core' : 'pack-skill';
      for (const f of files) {
        recordFile(m, `.claude/skills/${entry}/${f}`, PRE_MANIFEST_VERSION, kind);
      }
    }
  }

  const claudeAgentsDir = join(projectRoot, '.claude', 'agents');
  if (existsSync(claudeAgentsDir)) {
    for (const f of readdirSync(claudeAgentsDir)) {
      if (!f.endsWith('.md')) continue;
      if (!known.agentNames.has(basename(f, '.md'))) continue; // skip user-authored agents
      recordFile(m, `.claude/agents/${f}`, PRE_MANIFEST_VERSION, 'agent');
    }
  }

  const claudeSettings = join(projectRoot, '.claude', 'settings.json');
  if (existsSync(claudeSettings)) {
    recordFile(m, '.claude/settings.json', PRE_MANIFEST_VERSION, 'hook');
  }

  return m;
}
