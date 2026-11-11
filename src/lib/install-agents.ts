import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findPackageDir } from './catalog.js';
import { readManifest, writeManifest, recordFile, dreamcontextVersion } from './manifest.js';
import type { PlatformId } from './platforms.js';
import { readSetupConfig, isSleepSpecialist, effectiveSpecialist } from './setup-config.js';
import {
  applySpecialistFrontmatter,
  agentBaselineSha,
  isCustomizedAgent,
  readSpecialistFrontmatter,
} from './sleep-specialist-frontmatter.js';
import type { SleepSpecialist } from './setup-config.js';

/**
 * The one place `.claude/agents/*.md` is written from the package, and the per-brain sleep
 * specialist override applied to it. Dependency-free (no `chalk`, no prompts): the CLI and the
 * dashboard server both import it. Until 2026-11-11 this file also installed optional skill packs;
 * packs are gone (every skill ships with the core), so only the agent half remains.
 */

// ─── Agent File Installation ────────────────────────────────────────────────

export interface InstalledAgent {
  /** Project-relative path written (`.claude/agents/<name>.md`). */
  relPath: string;
  /**
   * sha256 of the file's CANONICAL form as we just wrote it — recorded in the
   * install manifest so `isCustomizedAgent` can later tell a hand edit from a
   * package refresh. Excludes `model`/`effort`, so the sleep override below
   * cannot change it.
   */
  baselineSha: string;
}

/**
 * Write an agent file for one platform and return its project-relative path
 * plus the baseline hash of what was written. Owned by this lib so there is
 * exactly one copy of the agent-write logic; `installCoreForPlatform` (in
 * install-skill.ts) imports this.
 *
 * THE ONE COPY SITE for `.claude/agents/*.md`, which is why the per-brain sleep
 * specialist model/effort override is injected HERE: every install path
 * (`install-skill`, `setup`, `update --core-only`) routes through this function,
 * so a brain's choice survives all three instead of being silently reverted by
 * whichever one ran last.
 *
 * 'claude' is currently the only supported platform. When another platform is
 * re-added, branch on `platform` here.
 */
export function installAgentForPlatform(
  _platform: PlatformId,
  projectRoot: string,
  agentPath: string,
  agentName?: string,
): InstalledAgent {
  const agentsDestDir = join(projectRoot, '.claude', 'agents');
  mkdirSync(agentsDestDir, { recursive: true });
  const file = agentName ? `${agentName}.md` : basename(agentPath);
  const dest = join(agentsDestDir, file);
  const source = readFileSync(agentPath, 'utf-8');

  // The baseline describes the PACKAGE content, before any override — so
  // injecting a model can never make the file read as user-customized.
  const baselineSha = agentBaselineSha(source);

  const name = file.replace(/\.md$/, '');
  let content = source;
  if (isSleepSpecialist(name)) {
    const override = effectiveSpecialist(readSetupConfig(projectRoot)?.sleep, name);
    content = applySpecialistFrontmatter(source, override);
  }

  writeFileSync(dest, content, 'utf-8');
  return { relPath: `.claude/agents/${file}`, baselineSha };
}

/**
 * Re-apply the per-brain model/effort override to the specialists whose setting
 * JUST CHANGED — the immediate half of A6, so a change in Settings or
 * `sleep config set` shows up in `.claude/agents/*.md` without waiting for the
 * next install.
 *
 * SCOPED ON PURPOSE: only the named specialists are touched, so changing
 * sleep-state's effort can never disturb a customization someone made to
 * sleep-tasks.
 *
 * Two paths, decided by `isCustomizedAgent` against the baseline recorded at
 * install:
 *  - uncustomized → re-copy from the package with the new override applied
 *    (picks up any packaged fix at the same time);
 *  - customized   → PATCH only the `model:`/`effort:` frontmatter keys in place
 *    and leave the body alone. We never overwrite work we did not write.
 *
 * Best-effort by design: a missing package dir or an unreadable agent is skipped
 * rather than thrown, because this runs as a side effect of saving a setting.
 */
export function applySleepSpecialistOverrides(
  projectRoot: string,
  changed: SleepSpecialist[],
): { updated: string[]; skipped: string[] } {
  const updated: string[] = [];
  const skipped: string[] = [];
  if (changed.length === 0) return { updated, skipped };

  const agentsSourceDir = findPackageDir('agents');
  const config = readSetupConfig(projectRoot);
  const manifest = readManifest(projectRoot);
  let manifestDirty = false;

  for (const name of changed) {
    const relPath = `.claude/agents/${name}.md`;
    const dest = join(projectRoot, relPath);
    if (!existsSync(dest)) { skipped.push(relPath); continue; }

    const override = effectiveSpecialist(config?.sleep, name);
    try {
      const installed = readFileSync(dest, 'utf-8');
      const baselineSha = manifest?.files[relPath]?.baselineSha;

      if (!isCustomizedAgent(installed, baselineSha)) {
        const source = agentsSourceDir ? join(agentsSourceDir, `${name}.md`) : null;
        if (source && existsSync(source)) {
          const packaged = readFileSync(source, 'utf-8');
          writeFileSync(dest, applySpecialistFrontmatter(packaged, override), 'utf-8');
          // The package may have moved since install; re-pin the baseline to
          // what we just wrote, or the next call would read it as customized.
          if (manifest) {
            const sha = agentBaselineSha(packaged);
            if (manifest.files[relPath]?.baselineSha !== sha) {
              recordFile(manifest, relPath, manifest.files[relPath]?.version ?? dreamcontextVersion(),
                manifest.files[relPath]?.kind ?? 'agent', { baselineSha: sha });
              manifestDirty = true;
            }
          }
          updated.push(relPath);
          continue;
        }
      }

      // Customized (or no package copy to fall back on): patch ONLY the two
      // frontmatter keys, never the body. Clearing an override falls back to
      // the values the package ships, so "reset to default" is real here too —
      // not "keep whatever was last injected".
      const source = agentsSourceDir ? join(agentsSourceDir, `${name}.md`) : null;
      const packagedDefaults = source && existsSync(source)
        ? readSpecialistFrontmatter(readFileSync(source, 'utf-8'))
        : undefined;
      const effective = {
        model: override?.model ?? packagedDefaults?.model,
        effort: override?.effort ?? packagedDefaults?.effort,
      };
      writeFileSync(dest, applySpecialistFrontmatter(installed, effective), 'utf-8');
      updated.push(relPath);
    } catch {
      skipped.push(relPath);
    }
  }

  if (manifestDirty && manifest) writeManifest(projectRoot, manifest);
  return { updated, skipped };
}
