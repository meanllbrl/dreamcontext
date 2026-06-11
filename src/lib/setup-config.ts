import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PlatformId } from './platforms.js';

const CONFIG_REL_PATH = '_dream_context/state/.config.json';

export interface SetupConfig {
  platforms: PlatformId[];
  packs: string[];
  multiProduct: false | string[];
  /**
   * Canonical roster of humans working in this project (kebab-case display
   * names). Optional + additive: absent ⇒ single-person project. There is NO
   * persisted `multiPerson` flag — multi-person status is DERIVED from this
   * roster via `isMultiPerson()` (people.length > 1) to avoid desync.
   */
  people?: string[];
  setupVersion: string;
  /**
   * When true (the default), dreamcontext disables Claude Code's native
   * auto-memory (`autoMemoryEnabled: false` in `.claude/settings.json`) so that
   * dreamcontext is the single source of project memory. Set false to keep
   * Claude's native MEMORY.md alongside dreamcontext.
   */
  disableNativeMemory: boolean;
  /**
   * Where tasks live (issue #11). Absent ⇒ "local" — existing projects with no
   * field behave exactly as before. "clickup" routes task verbs through the
   * ClickUp remote backend with a gitignored local mirror.
   */
  taskBackend?: 'local' | 'clickup';
  /**
   * The Advanced Config switch behind the setup prompt. true ⇒ a remote task
   * backend is in use (taskBackend says which one).
   */
  cloudTaskManagement?: boolean;
  /** Remote coordinates + options for the ClickUp backend (issue #11). */
  clickup?: ClickUpConfig;
  /**
   * Per-person remote identity, keyed by the person slug from `people`.
   * Additive: people without an entry simply have no remote identity yet.
   */
  peopleIdentity?: Record<string, PersonIdentity>;
}

export interface ClickUpConfig {
  teamId?: string;
  spaceId?: string;
  listId?: string;
  /** Where changelog entries land remotely. Comments are the natural ClickUp fit. */
  changelogTarget?: 'comments';
}

export interface PersonIdentity {
  /** Optional role label (seedable from knowledge/team_owners.md). */
  role?: string;
  /** ClickUp member id for assignee mapping. */
  clickupMemberId?: string;
  /** Env var holding this person's API token (per-user rate limits). */
  tokenEnv?: string;
}

function sanitizeClickUp(raw: unknown): ClickUpConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: ClickUpConfig = {};
  if (typeof o.teamId === 'string') out.teamId = o.teamId;
  if (typeof o.spaceId === 'string') out.spaceId = o.spaceId;
  if (typeof o.listId === 'string') out.listId = o.listId;
  if (o.changelogTarget === 'comments') out.changelogTarget = o.changelogTarget;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizePeopleIdentity(raw: unknown): Record<string, PersonIdentity> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, PersonIdentity> = {};
  for (const [slug, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const id: PersonIdentity = {};
    if (typeof v.role === 'string') id.role = v.role;
    if (typeof v.clickupMemberId === 'string') id.clickupMemberId = v.clickupMemberId;
    if (typeof v.tokenEnv === 'string') id.tokenEnv = v.tokenEnv;
    out[slug] = id;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function configPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_REL_PATH);
}

export function readSetupConfig(projectRoot: string): SetupConfig | null {
  const path = configPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SetupConfig>;
    return {
      platforms: Array.isArray(parsed.platforms) ? parsed.platforms as PlatformId[] : [],
      packs: Array.isArray(parsed.packs) ? parsed.packs.filter((p): p is string => typeof p === 'string') : [],
      multiProduct: Array.isArray(parsed.multiProduct)
        ? parsed.multiProduct.filter((p): p is string => typeof p === 'string')
        : false,
      // Absent / non-array ⇒ undefined (single-person). Filter to strings so a
      // malformed roster can never leak non-string entries downstream.
      people: Array.isArray(parsed.people)
        ? parsed.people.filter((p): p is string => typeof p === 'string')
        : undefined,
      setupVersion: typeof parsed.setupVersion === 'string' ? parsed.setupVersion : '0.0.0',
      // Default true: absent in legacy configs means "disable native memory".
      disableNativeMemory:
        typeof parsed.disableNativeMemory === 'boolean' ? parsed.disableNativeMemory : true,
      // Absent / unknown value ⇒ undefined (treated as "local" everywhere).
      taskBackend:
        parsed.taskBackend === 'local' || parsed.taskBackend === 'clickup'
          ? parsed.taskBackend
          : undefined,
      cloudTaskManagement:
        typeof parsed.cloudTaskManagement === 'boolean' ? parsed.cloudTaskManagement : undefined,
      clickup: sanitizeClickUp(parsed.clickup),
      peopleIdentity: sanitizePeopleIdentity(parsed.peopleIdentity),
    };
  } catch {
    return null;
  }
}

export function writeSetupConfig(projectRoot: string, config: SetupConfig): void {
  const path = configPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Merge new values into existing config (or create new). Returns final config.
 * `undefined` fields are left untouched. To clear packs pass [].
 */
export function updateSetupConfig(
  projectRoot: string,
  patch: Partial<SetupConfig>,
): SetupConfig {
  const existing = readSetupConfig(projectRoot) ?? {
    platforms: [],
    packs: [],
    multiProduct: false,
    setupVersion: '0.0.0',
    disableNativeMemory: true,
  };
  const next: SetupConfig = {
    platforms: patch.platforms ?? existing.platforms,
    packs: patch.packs ?? existing.packs,
    multiProduct: patch.multiProduct ?? existing.multiProduct,
    people: patch.people ?? existing.people,
    setupVersion: patch.setupVersion ?? existing.setupVersion,
    disableNativeMemory: patch.disableNativeMemory ?? existing.disableNativeMemory,
    taskBackend: patch.taskBackend ?? existing.taskBackend,
    cloudTaskManagement: patch.cloudTaskManagement ?? existing.cloudTaskManagement,
    clickup: patch.clickup ?? existing.clickup,
    peopleIdentity: patch.peopleIdentity ?? existing.peopleIdentity,
  };
  writeSetupConfig(projectRoot, next);
  return next;
}

/**
 * Multi-person status is DERIVED, never persisted: a project is multi-person iff
 * its roster lists more than one human. Absent/short roster ⇒ single-person.
 * Mirrors the `multiProduct` length check so every surface gates identically.
 */
export function isMultiPerson(config: SetupConfig | null | undefined): boolean {
  return (config?.people?.length ?? 0) > 1;
}
