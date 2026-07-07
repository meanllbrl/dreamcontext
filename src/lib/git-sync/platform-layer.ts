import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { ensureGitignoreEntries } from '../gitignore.js';
// Function-level circular import (brain-repo ↔ platform-layer): both sides only
// reference each other inside function bodies, never at module-evaluation time.
import { currentTaskBackend, ensureLocalOnlyArtifacts } from './brain-repo.js';

/**
 * Platform layer — carry the Claude Code project files (CLAUDE.md + .claude)
 * INSIDE the brain repo so `brain sync` shares them with the team.
 *
 * A separate-mode brain repo is rooted at `_dream_context/`, so anything at
 * the PROJECT root (CLAUDE.md, .claude/ skills/agents/hooks) never reaches
 * GitHub. The fix: the real files live under `_dream_context/platform/` and
 * the project root holds symlinks into it. Claude Code resolves the symlinks
 * transparently; git carries the platform layer with the rest of the brain;
 * a fresh clone re-creates the root links via `healPlatformLinks` (wired into
 * `runBrainSync` and `dreamcontext brain platform`).
 */

export const PLATFORM_DIR = 'platform';

/** Project-root artifacts `setupPlatformLayer` migrates into the brain. */
export const PLATFORM_ITEMS = ['CLAUDE.md', '.claude'] as const;

/**
 * Machine-local runtime files inside `platform/` that must never sync —
 * appended to the brain gitignore BEFORE anything is moved (same
 * gitignore-first discipline as `writeCredential`).
 */
export const PLATFORM_GITIGNORE_ENTRIES = [
  'platform/.claude/settings.local.json',
  'platform/.claude/scheduled_tasks.lock',
];

const PLATFORM_GITIGNORE_COMMENT =
  'platform/ — Claude Code layer (CLAUDE.md + .claude), synced for portability; machine-local runtime files must never sync';

/** Junk entries inside `platform/` that are never platform items. */
const IGNORED_DIR_ENTRIES = new Set(['.DS_Store']);

export type PlatformItemState =
  /** Root symlink in place, resolving to the platform copy. */
  | 'linked'
  /** Platform copy exists but the root link is missing (fresh clone) — healable. */
  | 'missing-link'
  /** Real file/dir at project root, no platform copy yet — migratable. */
  | 'not-migrated'
  /** BOTH a real root file/dir AND a platform copy exist — never auto-resolved. */
  | 'conflict'
  /** Root path is a symlink pointing somewhere else — left alone. */
  | 'foreign-link'
  /** Neither side exists. */
  | 'absent';

export interface PlatformItemStatus {
  item: string;
  state: PlatformItemState;
  /** Populated when an action on this item failed (e.g. symlink EPERM). */
  error?: string;
}

export interface PlatformStatus {
  /** `_dream_context/platform/` exists — the layer is (at least partly) in use. */
  active: boolean;
  items: PlatformItemStatus[];
}

export interface PlatformActionResult extends PlatformStatus {
  /** Items moved into `platform/` by this call. */
  moved: string[];
  /** Root symlinks created by this call (both migrate and heal). */
  linked: string[];
}

function platformDirPath(contextRoot: string): string {
  return join(contextRoot, PLATFORM_DIR);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `rootPath` is a symlink that resolves to `platformPath` itself. */
function linkResolvesTo(rootPath: string, platformPath: string): boolean {
  try {
    return realpathSync(rootPath) === realpathSync(platformPath);
  } catch {
    return false; // broken link
  }
}

function itemState(projectRoot: string, contextRoot: string, item: string): PlatformItemState {
  const rootPath = join(projectRoot, item);
  const platformPath = join(platformDirPath(contextRoot), item);
  const rootExists = existsSync(rootPath) || isSymlink(rootPath); // existsSync follows (and fails on broken) links
  const platformExists = existsSync(platformPath);

  if (isSymlink(rootPath)) {
    if (platformExists && linkResolvesTo(rootPath, platformPath)) return 'linked';
    if (platformExists) return 'foreign-link';
    // A symlink (into the now-missing platform copy or elsewhere) with no
    // platform copy: nothing to migrate or heal.
    return 'foreign-link';
  }
  if (rootExists && platformExists) return 'conflict';
  if (rootExists) return 'not-migrated';
  if (platformExists) return 'missing-link';
  return 'absent';
}

/** Union of the canonical items and whatever actually lives in `platform/`. */
function allItems(contextRoot: string): string[] {
  const items = new Set<string>(PLATFORM_ITEMS);
  const dir = platformDirPath(contextRoot);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (!IGNORED_DIR_ENTRIES.has(entry)) items.add(entry);
    }
  }
  return [...items].sort();
}

export function platformLayerStatus(projectRoot: string, contextRoot: string): PlatformStatus {
  return {
    active: existsSync(platformDirPath(contextRoot)),
    items: allItems(contextRoot).map((item) => ({ item, state: itemState(projectRoot, contextRoot, item) })),
  };
}

function createLink(projectRoot: string, contextRoot: string, item: string): string | undefined {
  const rootPath = join(projectRoot, item);
  const platformPath = join(platformDirPath(contextRoot), item);
  // Relative target keeps the tree relocatable. Windows dir links need a
  // junction (no privilege required); Node resolves the target for those.
  const target = relative(projectRoot, platformPath);
  const isDir = lstatSync(platformPath).isDirectory();
  const type = isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file';
  try {
    symlinkSync(target, rootPath, type);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Re-create missing project-root symlinks for everything under `platform/`
 * (a fresh clone has the platform copies but no root links). Never moves,
 * never overwrites a real file, never touches conflicts. Safe to call on
 * every sync — a project without a platform layer is a no-op.
 */
export function healPlatformLinks(projectRoot: string, contextRoot: string): PlatformActionResult {
  const linked: string[] = [];
  const items: PlatformItemStatus[] = [];
  const active = existsSync(platformDirPath(contextRoot));

  if (active) {
    for (const item of allItems(contextRoot)) {
      let state = itemState(projectRoot, contextRoot, item);
      let error: string | undefined;
      if (state === 'missing-link') {
        error = createLink(projectRoot, contextRoot, item);
        if (!error) {
          state = 'linked';
          linked.push(item);
        }
      }
      items.push({ item, state, ...(error ? { error } : {}) });
    }
  }

  return { active, items, moved: [], linked };
}

/** Best-effort heal for the sync path — a heal failure must never fail a sync. */
export function healPlatformLinksBestEffort(projectRoot: string, contextRoot: string): void {
  try {
    healPlatformLinks(projectRoot, contextRoot);
  } catch {
    /* never let a heal problem break a sync */
  }
}

/**
 * Migrate the project-root platform items into `_dream_context/platform/` and
 * symlink them back — the one-time setup (idempotent; also heals). Gitignore
 * FIRST: the machine-local excludes are appended before any content moves so
 * `settings.local.json` can never become trackable, even transiently.
 */
export function setupPlatformLayer(projectRoot: string, contextRoot: string): PlatformActionResult {
  // FULL canonical gitignore first when none exists yet: creating a
  // platform-entries-only stub here would permanently defeat
  // `bootstrapBrainRepo`'s `!existsSync` guard, and local state
  // (state/.brain-merge/.lock, secrets, …) would sync to the team. Same
  // discipline as `writeCredential`.
  ensureLocalOnlyArtifacts(contextRoot, currentTaskBackend(projectRoot));
  ensureGitignoreEntries(contextRoot, PLATFORM_GITIGNORE_ENTRIES, {
    comment: PLATFORM_GITIGNORE_COMMENT,
  });

  const moved: string[] = [];
  const linked: string[] = [];
  const items: PlatformItemStatus[] = [];

  for (const item of allItems(contextRoot)) {
    let state = itemState(projectRoot, contextRoot, item);
    let error: string | undefined;

    if (state === 'not-migrated') {
      mkdirSync(platformDirPath(contextRoot), { recursive: true });
      renameSync(join(projectRoot, item), join(platformDirPath(contextRoot), item));
      moved.push(item);
      state = 'missing-link';
    }
    if (state === 'missing-link') {
      error = createLink(projectRoot, contextRoot, item);
      if (!error) {
        state = 'linked';
        linked.push(item);
      }
    }

    items.push({ item, state, ...(error ? { error } : {}) });
  }

  return { active: existsSync(platformDirPath(contextRoot)), items, moved, linked };
}
