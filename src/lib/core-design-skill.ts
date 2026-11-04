/**
 * The `design` core skill: installed and refreshed with dreamcontext on every project, like the
 * other core skills. It used to be an optional pack, so a project without the pack had no design
 * rules and an agent asked to "load `design`" quietly built a default-looking screen instead.
 *
 * Unlike the other core skills, an owner may have tuned their copy (it lived as an editable pack
 * for a long time). So every file is written under the manifest-hash rule:
 *  - the manifest on disk records the sha256 of what we last wrote (`baselineSha`);
 *  - an installed file that no longer matches that baseline is someone's edit: kept, still tracked
 *    (so `update` never offers it for deletion), and reported in a note, never overwritten;
 *  - a file the manifest lists without a baseline (the old pack install) is ours: refreshed;
 *  - a file present on disk that a manifest exists for but does not list is not ours: kept;
 *  - no manifest at all (a pre-manifest project) reads as ours, the same rule agents follow;
 *  - a symlink is never written through.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from './manifest.js';

export const DESIGN_SKILL = 'design' as const;
/** Package folder the skill ships in (package.json `files`, the desktop app's resources). */
export const DESIGN_SKILL_SOURCE = 'skill-design' as const;

/** A manifest path inside an installed design skill (`<skill root>/design/...`). */
export function isDesignSkillPath(rel: string): boolean {
  return /(^|\/)skills\/design\//.test(rel.split('\\').join('/'));
}

export function designFileSha(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface DesignInstallResult {
  /** Files that are (now) dreamcontext's copy: rel path → baseline to record. */
  written: { rel: string; baselineSha: string }[];
  /** Files left as they are: rel path → baseline to keep recording (undefined = untracked). */
  kept: { rel: string; baselineSha?: string; reason: 'edited' | 'not-ours' | 'symlink' }[];
}

/**
 * Copy the design skill's markdown files from `sourceDir` into `<skillRoot>/design/`.
 * `recorded` is the manifest ON DISK (the previous install's record), never the one being built.
 */
export function installDesignSkill(
  sourceDir: string,
  skillRoot: string,
  skillRootRel: string,
  recorded: Manifest | null,
): DesignInstallResult {
  const destDir = join(skillRoot, DESIGN_SKILL);
  mkdirSync(destDir, { recursive: true });
  const result: DesignInstallResult = { written: [], kept: [] };
  const files = readdirSync(sourceDir).filter((f) => f.endsWith('.md')).sort();
  for (const f of files) {
    const rel = `${skillRootRel}/${DESIGN_SKILL}/${f}`;
    const dest = join(destDir, f);
    const source = readFileSync(join(sourceDir, f));
    const entry = recorded?.files[rel];

    let installed: Buffer | null = null;
    try {
      const st = lstatSync(dest);
      if (st.isSymbolicLink() || !st.isFile()) {
        result.kept.push({ rel, reason: 'symlink', ...(entry?.baselineSha ? { baselineSha: entry.baselineSha } : {}) });
        continue;
      }
      installed = readFileSync(dest);
    } catch {
      installed = null; // not installed yet
    }

    if (installed !== null) {
      const same = installed.equals(source);
      if (!same && recorded && !entry) {
        result.kept.push({ rel, reason: 'not-ours' });
        continue;
      }
      if (!same && entry?.baselineSha && designFileSha(installed) !== entry.baselineSha) {
        result.kept.push({ rel, reason: 'edited', baselineSha: entry.baselineSha });
        continue;
      }
      if (same) {
        result.written.push({ rel, baselineSha: designFileSha(source) });
        continue;
      }
    }
    writeFileSync(dest, source);
    result.written.push({ rel, baselineSha: designFileSha(source) });
  }
  return result;
}
