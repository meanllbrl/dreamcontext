import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGitHubTokenSecretsOnly, type ResolvedToken } from '../task-backend/secrets.js';
import { readGlobalGitHubToken } from './auth-store.js';
import { readSetupConfig, updateSetupConfig, type SetupConfig } from '../setup-config.js';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import * as git from './git.js';
import { ensureGitignoreEntries } from '../gitignore.js';

/**
 * Brain-sync resolve + local-artifact + lock + token resolver. The brain always
 * lives inside the code repo (`_dream_context/`); cloud sync pushes the WHOLE
 * project (`full-repo` mode) to the project's own `origin`, or commits locally
 * only (`in-tree`). After any clone/pull, local-only artifacts stay gitignored.
 */

/** M1 author-tiering fallback — a commit never fails on a missing git identity. */
export const FALLBACK_AUTHOR = { name: 'dreamcontext-sync', email: 'noreply@dreamcontext.local' };

// ─── D. Token resolution — resolveBrainSyncToken ────────────────────────────

/**
 * M1 tiers: per-project `.secrets.json` github token → env
 * (`GITHUB_TOKEN`/`GH_TOKEN`). Secrets-first, env-last — INTENTIONALLY the
 * reverse of `resolveGitHubToken` (secrets.ts, env-first): a stray
 * `GITHUB_TOKEN` in some inherited shell must never silently override the
 * account a non-technical collaborator is actually logged in as.
 *
 * M2 tiering (final): per-project `.secrets.json` → GLOBAL
 * `~/.dreamcontext/.secrets.json` (the account the user signed into the
 * launcher/dashboard as) → env. A per-project token still wins over the global
 * one; the global one still wins over a stray env var.
 */
export function resolveBrainSyncToken(projectRoot: string): ResolvedToken | null {
  const perProject = readGitHubTokenSecretsOnly(projectRoot);
  if (perProject) return perProject;
  const global = readGlobalGitHubToken();
  if (global) return global;
  for (const envVar of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = process.env[envVar];
    if (v && v.trim()) return { token: v.trim(), source: 'env', via: envVar };
  }
  return null;
}

// ─── A/B. Mode resolution ────────────────────────────────────────────────────

export function resolveMode(config: SetupConfig | null | undefined): 'in-tree' | 'full-repo' {
  return config?.brainRepo?.mode === 'full-repo' ? 'full-repo' : 'in-tree';
}

// ─── Stale-config self-heal — healStaleBrainConfig ──────────────────────────

/**
 * Migrate the pre-b45adb4 config-model drift: a project with
 * `brainRepo: { enabled: true, mode: 'in-tree' }` renders DISHONESTLY — Settings
 * reads `enabled:true` ("sync on + connected repo") while the sidebar reads the
 * MODE (`in-tree` → `hasRemote:false` → "Set up team sync"), and `in-tree` never
 * pushes, so sync is effectively OFF despite the "on" UI. That combo is a legacy
 * artifact: the old toggle wrote only `enabled` and a separate `/api/brain/scope`
 * endpoint flipped `mode` independently; when the `separate` mode was removed
 * (b45abd4) no migration was written. Current code can't PRODUCE this state
 * (enable sets `full-repo`, disable sets `in-tree` atomically), but old configs
 * still carry it.
 *
 * The heal, run idempotently on the dashboard/CLI status read path:
 *  - origin EXISTS → PROMOTE to `full-repo` (what "enabled" means today — the only
 *    pushing mode), lay the gitignore-first machine-local excludes, and persist.
 *    The UI now honestly shows on + connected + actually syncing. This is exactly
 *    the side-effect the master toggle's "enable" already performs.
 *  - no origin → COERCE `enabled:false`, so the toggle renders an honest OFF
 *    (full-repo can't push without an origin, so "on" would still be a lie).
 *
 * Touches ONLY the exact stale combo — every other config (disabled, already
 * `full-repo`, no `brainRepo`) is returned untouched, so a healthy config never
 * triggers a git lookup or a write. Returns the (possibly rewritten) config so
 * the caller reads truth on the same request.
 */
export function healStaleBrainConfig(
  projectRoot: string,
  config: SetupConfig | null,
  gitModule: Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'> = git,
): SetupConfig | null {
  const brainRepo = config?.brainRepo;
  // The dishonest combo is EXACTLY explicit `enabled:true` with a non-pushing
  // mode. Anything else is already honest — short-circuit (no git, no write).
  if (!config || !brainRepo || brainRepo.enabled !== true || brainRepo.mode === 'full-repo') {
    return config;
  }

  let origin: string | null = null;
  try {
    origin = gitModule.isGitRepo(projectRoot) ? gitModule.getRemoteUrl(projectRoot, 'origin') : null;
  } catch {
    origin = null;
  }

  if (origin) {
    // Promote to the only functional pushing mode — mirrors the master toggle's
    // "enable" (full-repo + autoSync + gitignore-first). Preserve an explicit
    // autoSync opt-out if one somehow exists; default it on like `enable` does.
    const next = updateSetupConfig(projectRoot, {
      brainRepo: { ...brainRepo, mode: 'full-repo', enabled: true, autoSync: brainRepo.autoSync ?? true },
    });
    ensureFullRepoGitignore(projectRoot, config.taskBackend);
    return next;
  }

  // No origin — full-repo can't push, so honor the truth: render the toggle OFF.
  return updateSetupConfig(projectRoot, {
    brainRepo: { ...brainRepo, mode: 'in-tree', enabled: false },
  });
}

// ─── v3.3 master switch — resolveBrainSyncEnabled ───────────────────────────

export interface EnabledResolution {
  enabled: boolean;
  source: 'explicit' | 'derived-github-connected' | 'derived-unconnected';
}

/**
 * Explicit `brainRepo.enabled` always wins. Absent ⇒ derived default: ON iff
 * the project is already GitHub-connected (code repo's `origin` remote is a
 * github.com URL, OR `taskBackend==='github'`); OFF otherwise (new/unconnected
 * projects stay off until the user turns it on via Settings or
 * `dreamcontext brain enable`).
 */
export function resolveBrainSyncEnabled(
  projectRoot: string,
  config: SetupConfig | null | undefined,
  gitModule: Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'> = git,
): EnabledResolution {
  const explicit = config?.brainRepo?.enabled;
  if (typeof explicit === 'boolean') return { enabled: explicit, source: 'explicit' };

  let originIsGithub = false;
  try {
    if (gitModule.isGitRepo(projectRoot)) {
      const url = gitModule.getRemoteUrl(projectRoot, 'origin');
      originIsGithub = !!url && /github\.com/i.test(url);
    }
  } catch {
    originIsGithub = false;
  }

  const taskBackendGithub = config?.taskBackend === 'github';
  const connected = originIsGithub || taskBackendGithub;
  return { enabled: connected, source: connected ? 'derived-github-connected' : 'derived-unconnected' };
}

// ─── C. Tracked-vs-local — buildBrainGitignore ──────────────────────────────

/**
 * The brain folder's own `_dream_context/.gitignore` (written on first setup by
 * `ensureLocalOnlyArtifacts` when absent). Tracks core/, knowledge/, overrides/,
 * and the shared config; everything else is per-machine/session state that must
 * never sync. Table lives verbatim in `skill-sync/references/merge-rules.md`.
 */
export function buildBrainGitignore(taskBackend?: SetupConfig['taskBackend']): string {
  const lines: string[] = [
    '# Generated by dreamcontext.',
    '# This tracks core/, knowledge/, overrides/, and the shared config —',
    '# everything else here is local machine/session state and must never sync.',
    '',
    'state/.secrets.json',
    'state/.sleep.json',
    'state/.sleep-history.json',
    'state/.agent-sessions.json',
    'state/.agent-session-map/',
    'state/.session-digests/',
    'state/.conflicts/',
    'state/.brain-merge/',
    'state/.version-check.json',
    'state/.auto-upgrade.json',
    'state/.brain-local.json',
    'state/.lab-prefs.json',
    'state/.tasks-map.json',
    'state/.tasks-sync.*',
    'state/.tasks-queue.json',
    '.obsidian/',
    'tmp/',
    '**/.env',
    '**/.DS_Store',
    // Lab (analytics insights) credentials — insights + cache DO sync (deny-list
    // gitignore); only the credential file is excluded. lab/scripts/*.env is
    // already covered by the **/.env entry above. The tracked example file
    // (key names only, never values) is re-allowed so teammates can see which
    // credentials an insight needs.
    'lab/credentials.json',
    'lab/credentials.*',
    '!lab/credentials.example.json',
  ];
  if (taskBackend && taskBackend !== 'local') {
    lines.push(
      '',
      '# Tasks are a local mirror under a remote task backend — issues/ClickUp are source of truth.',
      'state/*.md',
    );
  }
  return `${lines.join('\n')}\n`;
}

// ─── full-repo mode: machine-local brain excludes at the PROJECT root ────────

/**
 * In `full-repo` mode the WHOLE project folder is staged (`git add -A` at the
 * project root), so the project's OWN `.gitignore` must exclude the machine-local
 * brain runtime and secrets under `_dream_context/`. Without this, `git add -A`
 * would commit-and-push the sync lock (`state/.brain-merge/.lock`) — poisoning
 * every clone with a foreign live PID that reads as "locked" — and, far worse,
 * secrets. `_dream_context/state/.tasks-map.json` is DELIBERATELY absent: the
 * stable slug↔remoteId map is meant to sync.
 */
export const FULL_REPO_LOCAL_GITIGNORE_ENTRIES = [
  // Secrets — never sync, regardless of anything else.
  '_dream_context/state/.secrets.json',
  '_dream_context/**/.env',
  // Machine-local brain runtime — per-machine; must never sync (merge churn, or
  // in the sync lock's case, cross-machine lock contention).
  '_dream_context/state/.brain-merge/',
  '_dream_context/state/.brain-local.json',
  '_dream_context/state/.sleep.json',
  '_dream_context/state/.sleep-history.json',
  '_dream_context/state/.agent-sessions.json',
  '_dream_context/state/.agent-session-map/',
  '_dream_context/state/.session-digests/',
  '_dream_context/state/.conflicts/',
  '_dream_context/state/.version-check.json',
  '_dream_context/state/.auto-upgrade.json',
  '_dream_context/state/.lab-prefs.json',
  '_dream_context/state/.tasks-sync.lock',
  '_dream_context/state/.tasks-sync.json',
  '_dream_context/state/.tasks-queue.json',
  '_dream_context/tmp/',
  // Lab analytics credentials — the example (key names only) still syncs.
  '_dream_context/lab/credentials.json',
  '_dream_context/lab/credentials.*',
  '!_dream_context/lab/credentials.example.json',
];

/**
 * Idempotently ensure the project-root `.gitignore` excludes every machine-local
 * brain artifact + secret (full-repo mode). Adds the derived task-mirror
 * (`state/*.md`) exclude only under a remote task backend. Returns the entries
 * newly added (empty when already covered). Best-effort — a read-only gitignore
 * must never break a sync.
 */
export function ensureFullRepoGitignore(projectRoot: string, taskBackend?: SetupConfig['taskBackend']): string[] {
  const entries = [...FULL_REPO_LOCAL_GITIGNORE_ENTRIES];
  if (taskBackend && taskBackend !== 'local') entries.push('_dream_context/state/*.md');
  try {
    return ensureGitignoreEntries(projectRoot, entries, {
      comment: 'dreamcontext full-repo sync — machine-local brain state + secrets (never sync)',
    });
  } catch {
    return [];
  }
}

// ─── Local-only artifacts (folded index-guard, P3) ──────────────────────────

/**
 * Ensure the brain folder's `_dream_context/.gitignore` exists so local-only
 * artifacts (secrets, per-machine state) are never staged. Best-effort — a
 * read-only gitignore must not break anything.
 */
export function ensureLocalOnlyArtifacts(
  contextRoot: string,
  taskBackend?: SetupConfig['taskBackend'],
  gitModule: typeof git = git,
): void {
  const gitignorePath = join(contextRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, buildBrainGitignore(taskBackend), 'utf-8');
  }
  void gitModule; // reserved for a future "assert nothing local-only is staged" check
}

// ─── Lock (reuses file-lock.ts, PID-liveness-gated — amendment 3) ──────────

const BRAIN_LOCK_STALE_MS = 5 * 60_000; // 5 minutes

export function brainLockPath(contextRoot: string): string {
  return join(contextRoot, 'state', '.brain-merge', '.lock');
}

export function acquireBrainLock(contextRoot: string, nowMs: number = Date.now()): boolean {
  return acquireFileLock(brainLockPath(contextRoot), nowMs, BRAIN_LOCK_STALE_MS, { verifyPidLiveness: true });
}

export function releaseBrainLock(contextRoot: string): void {
  releaseFileLock(brainLockPath(contextRoot));
}

// Re-exported for CLI/tests convenience (avoids importing setup-config.js separately just for this).
export function currentTaskBackend(projectRoot: string): SetupConfig['taskBackend'] {
  return readSetupConfig(projectRoot)?.taskBackend;
}
