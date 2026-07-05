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
   * ClickUp remote backend with a gitignored local mirror. "github" routes them
   * through the GitHub Issues remote backend (same local-mirror pattern).
   */
  taskBackend?: 'local' | 'clickup' | 'github';
  /**
   * The Advanced Config switch behind the setup prompt. true ⇒ a remote task
   * backend is in use (taskBackend says which one).
   */
  cloudTaskManagement?: boolean;
  /** Remote coordinates + options for the ClickUp backend (issue #11). */
  clickup?: ClickUpConfig;
  /** Remote coordinates + options for the GitHub Issues backend. */
  github?: GitHubConfig;
  /**
   * Per-person remote identity, keyed by the person slug from `people`.
   * Additive: people without an entry simply have no remote identity yet.
   */
  peopleIdentity?: Record<string, PersonIdentity>;
  /**
   * Cross-project federation read gate (issue #25). When true, peer vaults may
   * pull this vault's corpus into a cross-vault recall. Default FALSE (private
   * by default): absent / legacy / migrated configs are NOT shareable until the
   * owner opts in. Gates READS only — never required to read a shareable peer.
   */
  shareable?: boolean;
  /** Cloud collaboration for the brain repo (github-cloud-collaboration-brain-repo-sync). */
  brainRepo?: BrainRepoConfig;
}

export interface BrainRepoConfig {
  /**
   * `separate` — the brain lives in its own git repo + remote; full auto-sync
   * (commit → fetch → merge → push). `in-tree` — the brain is nested inside
   * the code repo; commit-only, NEVER auto-pushes. Absent ⇒ `in-tree` (the
   * safe default for every project that hasn't opted into `separate`).
   */
  mode: 'separate' | 'in-tree';
  /**
   * v3.3 MASTER SWITCH — cloud sync is COMPLETELY OPTIONAL. Explicit value
   * always wins. When ABSENT, the default is DERIVED: ON iff the project is
   * already GitHub-connected (code repo's `origin` remote is a github.com URL,
   * OR `taskBackend==='github'`, OR a `brainRepo.remote` is configured); OFF
   * otherwise (new/unconnected projects — stays off until the user configures
   * it via Settings or `dreamcontext brain enable`). See `resolveBrainSyncEnabled`.
   */
  enabled?: boolean;
  /** Brain repo remote — CLEAN https URL, never contains a token (S1). Absent in in-tree mode. */
  remote?: string;
  /** Pointer BACK to the paired code repo (shared, so teammates resolve it). */
  codeRepoUrl?: string;
  /** Marker: how this repo is identified as a brain (topic name). Default 'dreamcontext-brain'. */
  marker?: string;
  /** Auto-sync on `sleep done`. Default true for `separate`, false for `in-tree`. Gated by `enabled`. */
  autoSync?: boolean;
}

/**
 * Machine-local pointer for the brain-repo sync engine — NEVER tracked in
 * `.config.json` (which rides to teammates); lives at
 * `_dream_context/state/.brain-local.json`, gitignored.
 */
export interface BrainLocalState {
  /** Absolute path to the paired code repo on THIS machine — must never be pushed. */
  codeRepoPath?: string;
  lastSyncedSha?: string;
  lastFetchAt?: number;
  /** Commits actually merged in on the last pull (P2 rename). */
  pulledUpdates?: number;
  /** A pull deferred an agent-class conflict to /dream-sync (P2). */
  pendingAgentMerge?: boolean;
  /**
   * C2 (github-cloud-collaboration-brain-repo-sync M3): a pull-only merge
   * touched task-referencing files under a remote task backend. The
   * BACKGROUND path (session-start detached pull) cannot auto-run the task
   * backend sync itself (best-effort, non-blocking) — it surfaces this flag so
   * the NEXT session-start instructs the user to run `dreamcontext tasks sync`.
   * The foreground path (`sleep done`) auto-runs the sync instead and never
   * needs this flag to persist.
   */
  needsTaskSync?: boolean;
}

export interface ClickUpConfig {
  teamId?: string;
  spaceId?: string;
  listId?: string;
  /** Where changelog entries land remotely. Comments are the natural ClickUp fit. */
  changelogTarget?: 'comments';
}

export interface GitHubConfig {
  /** Repo owner (user or org login). The pickable "container" is `owner/repo`. */
  owner?: string;
  /** Repo name. */
  repo?: string;
  /** Where changelog entries land remotely. Comments are the natural GitHub fit. */
  changelogTarget?: 'comments';
}

export interface PersonIdentity {
  /** Optional role label (seedable from knowledge/team_owners.md). */
  role?: string;
  /** ClickUp member id for assignee mapping. */
  clickupMemberId?: string;
  /** Env var holding this person's API token (per-user rate limits). */
  tokenEnv?: string;
  /**
   * GitHub login this person signs into dreamcontext with (github-cloud-
   * collaboration-brain-repo-sync C3). Drives `mapLoginToPerson` — the brain
   * commit author tier layered ON TOP of the M1 git-identity tiering.
   */
  githubLogin?: string;
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

function sanitizeGitHub(raw: unknown): GitHubConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: GitHubConfig = {};
  if (typeof o.owner === 'string') out.owner = o.owner;
  if (typeof o.repo === 'string') out.repo = o.repo;
  if (o.changelogTarget === 'comments') out.changelogTarget = o.changelogTarget;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeBrainRepo(raw: unknown): BrainRepoConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const mode: BrainRepoConfig['mode'] = o.mode === 'separate' ? 'separate' : 'in-tree';
  const out: BrainRepoConfig = { mode };
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (typeof o.remote === 'string') out.remote = o.remote;
  if (typeof o.codeRepoUrl === 'string') out.codeRepoUrl = o.codeRepoUrl;
  if (typeof o.marker === 'string') out.marker = o.marker;
  if (typeof o.autoSync === 'boolean') out.autoSync = o.autoSync;
  return out;
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
    if (typeof v.githubLogin === 'string') id.githubLogin = v.githubLogin;
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
        parsed.taskBackend === 'local' || parsed.taskBackend === 'clickup' || parsed.taskBackend === 'github'
          ? parsed.taskBackend
          : undefined,
      cloudTaskManagement:
        typeof parsed.cloudTaskManagement === 'boolean' ? parsed.cloudTaskManagement : undefined,
      clickup: sanitizeClickUp(parsed.clickup),
      github: sanitizeGitHub(parsed.github),
      peopleIdentity: sanitizePeopleIdentity(parsed.peopleIdentity),
      // Federation read gate (issue #25). Absent / non-boolean ⇒ undefined,
      // which `isShareable` treats as private (the default-false invariant).
      shareable: typeof parsed.shareable === 'boolean' ? parsed.shareable : undefined,
      brainRepo: sanitizeBrainRepo(parsed.brainRepo),
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
    github: patch.github ?? existing.github,
    peopleIdentity: patch.peopleIdentity ?? existing.peopleIdentity,
    shareable: patch.shareable ?? existing.shareable,
    brainRepo: patch.brainRepo ?? existing.brainRepo,
  };
  writeSetupConfig(projectRoot, next);
  return next;
}

// ─── Brain-local state (machine-local, gitignored — never tracked) ──────────

const BRAIN_LOCAL_REL_PATH = '_dream_context/state/.brain-local.json';

function brainLocalPath(projectRoot: string): string {
  return join(projectRoot, BRAIN_LOCAL_REL_PATH);
}

/** Read `.brain-local.json`. Missing / corrupt ⇒ `{}` (never throws). */
export function readBrainLocal(projectRoot: string): BrainLocalState {
  const path = brainLocalPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BrainLocalState>;
    const out: BrainLocalState = {};
    if (typeof parsed.codeRepoPath === 'string') out.codeRepoPath = parsed.codeRepoPath;
    if (typeof parsed.lastSyncedSha === 'string') out.lastSyncedSha = parsed.lastSyncedSha;
    if (typeof parsed.lastFetchAt === 'number') out.lastFetchAt = parsed.lastFetchAt;
    if (typeof parsed.pulledUpdates === 'number') out.pulledUpdates = parsed.pulledUpdates;
    if (typeof parsed.pendingAgentMerge === 'boolean') out.pendingAgentMerge = parsed.pendingAgentMerge;
    if (typeof parsed.needsTaskSync === 'boolean') out.needsTaskSync = parsed.needsTaskSync;
    return out;
  } catch {
    return {};
  }
}

/** Merge-write `.brain-local.json` (0644 — not a secret, but never tracked: brain-repo `.gitignore` covers it). */
export function writeBrainLocal(projectRoot: string, patch: Partial<BrainLocalState>): BrainLocalState {
  const existing = readBrainLocal(projectRoot);
  const next: BrainLocalState = { ...existing, ...patch };
  const path = brainLocalPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8');
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
