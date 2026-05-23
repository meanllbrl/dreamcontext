import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ManagedFileKind = 'core' | 'agent' | 'skill' | 'hook' | 'pack-skill' | 'pack-agent';

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

// ─── Constants ──────────────────────────────────────────────────────────────

const MANIFEST_REL_PATH = '_dream_context/state/.install-manifest.json';

/** Path prefixes that may be safely deleted during an update. */
export const SAFE_DELETE_PREFIXES = ['.claude/', '.agents/', '.codex/'] as const;

// ─── Version Resolution ─────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let cachedVersion: string | null = null;

/**
 * Read the dreamcontext CLI's own package.json version.
 * Searches typical locations relative to this compiled file.
 */
export function dreamcontextVersion(): string {
  if (cachedVersion) return cachedVersion;

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
        cachedVersion = pkg.version;
        return pkg.version;
      }
    } catch {
      // continue
    }
  }

  cachedVersion = '0.0.0';
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
 * Only paths under `.claude/`, `.agents/`, or `.codex/` are considered safe.
 * Notably, anything under `_dream_context/` is NEVER safe to delete (user data).
 */
export function isSafeDeletePath(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  if (normalized.includes('..')) return false;
  if (normalized.startsWith('/')) return false;
  return SAFE_DELETE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// ─── Bootstrap (legacy projects without a manifest) ─────────────────────────

const PRE_MANIFEST_VERSION = 'pre-manifest';

function walk(dir: string, relBase: string, out: string[]): void {
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
 * - .claude/skills/dreamcontext/** → core
 * - .claude/skills/<pack>/**       → pack-skill
 * - .claude/agents/**.md            → agent
 * - .agents/skills/**               → same split as above
 * - .codex/agents/**.toml           → agent
 * - .codex/config.toml              → hook
 * - .claude/settings.json           → hook
 */
export function bootstrapManifestFromScan(projectRoot: string): Manifest {
  const m = emptyManifest();
  m.version = PRE_MANIFEST_VERSION;

  // Claude
  const claudeSkillsRoot = join(projectRoot, '.claude', 'skills');
  if (existsSync(claudeSkillsRoot)) {
    recordPlatform(m, 'claude');
    for (const entry of readdirSync(claudeSkillsRoot)) {
      const sub = join(claudeSkillsRoot, entry);
      if (!statSync(sub).isDirectory()) continue;
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
      recordFile(m, `.claude/agents/${f}`, PRE_MANIFEST_VERSION, 'agent');
    }
  }

  const claudeSettings = join(projectRoot, '.claude', 'settings.json');
  if (existsSync(claudeSettings)) {
    recordFile(m, '.claude/settings.json', PRE_MANIFEST_VERSION, 'hook');
  }

  // Codex / .agents
  const agentsSkillsRoot = join(projectRoot, '.agents', 'skills');
  if (existsSync(agentsSkillsRoot)) {
    recordPlatform(m, 'codex');
    for (const entry of readdirSync(agentsSkillsRoot)) {
      const sub = join(agentsSkillsRoot, entry);
      if (!statSync(sub).isDirectory()) continue;
      const files: string[] = [];
      walk(sub, '', files);
      const kind: ManagedFileKind = entry === 'dreamcontext' ? 'core' : 'pack-skill';
      for (const f of files) {
        recordFile(m, `.agents/skills/${entry}/${f}`, PRE_MANIFEST_VERSION, kind);
      }
    }
  }

  const codexAgentsDir = join(projectRoot, '.codex', 'agents');
  if (existsSync(codexAgentsDir)) {
    recordPlatform(m, 'codex');
    for (const f of readdirSync(codexAgentsDir)) {
      if (!f.endsWith('.toml')) continue;
      recordFile(m, `.codex/agents/${f}`, PRE_MANIFEST_VERSION, 'agent');
    }
  }

  const codexConfig = join(projectRoot, '.codex', 'config.toml');
  if (existsSync(codexConfig)) {
    recordFile(m, '.codex/config.toml', PRE_MANIFEST_VERSION, 'hook');
  }

  return m;
}
