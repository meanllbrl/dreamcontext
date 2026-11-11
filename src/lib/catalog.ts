import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_PLATFORMS, type PlatformId } from './platforms.js';
// Type-only import — zero runtime, keeps catalog.ts → manifest.ts one-directional
// (manifest.ts must NOT import catalog.ts to avoid a circular dependency).
import type { KnownArtifacts } from './manifest.js';
import { GUARDED_SKILLS } from './core-guarded-skill.js';

// ─── __dirname shim (ESM) ─────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * The small core skill dreamcontext's own sub-agents preload instead of the full
 * `dreamcontext` skill. One name for three places that must agree: the installed
 * folder (`.claude/skills/<name>/`), the skill's frontmatter `name`, and the
 * skill-recall exclusion (the main session already carries the full skill, so
 * surfacing this one there is noise).
 */
export const AGENT_CORE_SKILL = 'dreamcontext-agent-core' as const;

// ─── Platform / Installation Helpers ─────────────────────────────────────────

/**
 * Root directory where skills are installed for a given platform.
 * claude  → <projectRoot>/.claude/skills
 *
 * 'claude' is currently the only supported platform. When another platform is
 * re-added, branch here to return its skill root.
 */
export function platformSkillRoot(projectRoot: string, _platform: PlatformId): string {
  return join(projectRoot, '.claude', 'skills');
}

/**
 * Which agent platforms actually have the core skill installed on disk. This is
 * the ONLY honest answer to "does this project have an agent platform?" —
 * `.config.json.platforms` records what was *requested*, not what is present.
 *
 * Shared because two callers must agree: `update` refuses to run without one,
 * and the launcher explains a failed update to the user. They disagreed once,
 * and the launcher told people to run `install-skill` on fully-installed vaults.
 */
export function detectInstalledPlatforms(projectRoot: string): PlatformId[] {
  return SUPPORTED_PLATFORMS.filter((p) =>
    existsSync(join(platformSkillRoot(projectRoot, p), 'dreamcontext', 'SKILL.md')),
  );
}

// ─── File Resolution ──────────────────────────────────────────────────────────

/**
 * Find a package subdirectory by probing 3 candidate depths.
 * Works whether running from dist/lib/ (depth 3) or dist/ (depth 2) or src/lib/.
 *
 * The last candidate is `<dist>/<subdir>` itself: `tsup` copies `agents/` and `skill-draw/`
 * there. It only matters for a partial layout where the package root's copy is absent (the
 * desktop app's resources folder once shipped `dist/` without `agents/`), and it can never
 * shadow the root copy because it is probed after it.
 *
 * `base` is the directory the probe starts from (the running module's own folder);
 * tests pass a scratch layout.
 */
export function findPackageDir(subdir: string, base: string = __dirname): string | null {
  const candidates = [
    join(base, '..', '..', '..', subdir),
    join(base, '..', '..', subdir),
    join(base, '..', subdir),
    join(base, subdir),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

// ─── Known Artifact Names (bootstrap allowlist) ──────────────────────────────

/**
 * Build the allowlist of dreamcontext-shipped artifact names for the legacy
 * bootstrap scan (see `bootstrapManifestFromScan` in manifest.ts).
 *
 * agentNames = repo-root agent base-names (from `agents/*.md`).
 * skillDirs  = 'dreamcontext' (core skill) ∪ every guarded core skill (design, draw, council,
 *              multi-review, goal-skill, video-watching: a pre-manifest copy must be adopted as ours).
 *
 * The skills dreamcontext stopped shipping (2026-11-11) are deliberately NOT here: with no manifest
 * nothing proves a copy is ours, so it is never adopted and never offered for deletion.
 *
 * Degrades gracefully: if the agents dir is unreadable, returns whatever it could
 * resolve (never throws). A smaller allowlist only means fewer files are adopted —
 * it can never cause a custom file to be deleted.
 */
export function knownArtifactNames(): KnownArtifacts {
  const agentNames = new Set<string>();
  const skillDirs = new Set<string>(['dreamcontext', ...GUARDED_SKILLS.map((g) => g.name)]);

  const agentsDir = findPackageDir('agents');
  if (agentsDir) {
    try {
      for (const f of readdirSync(agentsDir)) {
        if (f.endsWith('.md')) agentNames.add(basename(f, '.md'));
      }
    } catch {
      // unreadable agents dir — skip, allowlist is best-effort
    }
  }

  return { agentNames, skillDirs };
}
