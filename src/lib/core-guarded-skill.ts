/**
 * Guarded core skills (`design`, `draw`): installed and refreshed with dreamcontext on every
 * project, like the other core skills, but each was an editable pack for a long time, so an owner
 * may have tuned their copy. Every file is written under the manifest-hash rule:
 *  - the manifest on disk records the sha256 of what we last wrote (`baselineSha`);
 *  - an installed file that no longer matches that baseline is someone's edit: kept, still tracked
 *    (so `update` never offers it for deletion), and reported in a note, never overwritten;
 *  - with no baseline (a pack-era manifest, or no manifest at all: a fresh clone, a second
 *    machine) a file is refreshed only if it is byte-for-byte a version we shipped (the skill's
 *    shipped table, keyed by the file's path inside the skill); otherwise it is kept and reported;
 *  - a file present on disk that a manifest exists for but does not list is not ours: kept;
 *  - text hashes read CRLF as LF, so a Windows checkout is never mistaken for an edit; a binary
 *    (any NUL byte: `examples/sample.png`) is hashed raw;
 *  - a symlink is never written through: not the file, and not a folder on the way to it.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from './manifest.js';
import { DESIGN_SHIPPED_SHAS, DRAW_SHIPPED_SHAS } from './core-guarded-skill/shipped.js';

export type ShippedShas = Readonly<Record<string, readonly string[]>>;

export const DESIGN_SKILL = 'design' as const;
/** Package folder the skill ships in (package.json `files`, the desktop app's resources). */
export const DESIGN_SKILL_SOURCE = 'skill-design' as const;
export const DRAW_SKILL = 'draw' as const;
export const DRAW_SKILL_SOURCE = 'skill-draw' as const;

/** Each guarded skill's shipped table. Append, never remove (tests/unit/draw-core-skill.test.ts). */
export const GUARDED_SHIPPED_SHAS: Readonly<Record<string, ShippedShas>> = {
  [DESIGN_SKILL]: DESIGN_SHIPPED_SHAS,
  [DRAW_SKILL]: DRAW_SHIPPED_SHAS,
};

/** design ships its top-level markdown only (as it always did). */
export const designFilter = (rel: string): boolean => !rel.includes('/') && rel.endsWith('.md');
/** draw ships its whole folder, minus boards an example run generated and installed deps. */
export const drawFilter = (rel: string): boolean =>
  !rel.split('/').includes('node_modules') && !/^examples\/[^/]*\.excalidraw\.md$/.test(rel) && !rel.endsWith('.DS_Store');

/** A manifest path inside an installed guarded skill (`<skill root>/design/...`, `.../draw/...`). */
export function isGuardedSkillPath(rel: string): boolean {
  return /(^|\/)skills\/(design|draw)\//.test(rel.split('\\').join('/'));
}

/** Is any existing folder on `root/segments...` a symlink (or not a folder)? Absent ones are fine. */
export function linkedFolderOnPath(root: string, segments: string[]): boolean {
  let p = root;
  for (const seg of segments) {
    p = join(p, seg);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) return true;
    } catch {
      return false; // absent: mkdir makes a real folder from here down
    }
  }
  return false;
}

/** sha256 of a skill file: text with CRLF read as LF, a binary (any NUL byte) raw. */
export function guardedFileSha(content: string | Buffer): string {
  if (typeof content !== 'string' && content.includes(0)) return createHash('sha256').update(content).digest('hex');
  const text = typeof content === 'string' ? content : content.toString('utf-8');
  return createHash('sha256').update(text.split('\r\n').join('\n'), 'utf-8').digest('hex');
}

/**
 * May `update` delete this installed guarded-skill file (a later release dropped it)? Only when it
 * is still exactly what dreamcontext wrote: its recorded baseline, or with none a version we
 * shipped at that path. Unreadable, a link, or edited: no, it is kept.
 */
export function guardedFileIsUnchanged(projectRoot: string, rel: string, baselineSha: string | undefined): boolean {
  try {
    const abs = join(projectRoot, rel);
    if (!lstatSync(abs).isFile()) return false;
    const now = guardedFileSha(readFileSync(abs));
    if (baselineSha) return now === baselineSha;
    const m = /(?:^|\/)skills\/(design|draw)\/(.+)$/.exec(rel.split('\\').join('/'));
    if (!m) return false;
    return (GUARDED_SHIPPED_SHAS[m[1]]?.[m[2]] ?? []).includes(now);
  } catch {
    return false;
  }
}

export interface GuardedInstallResult {
  /** Files that are (now) dreamcontext's copy: rel path → baseline to record. */
  written: { rel: string; baselineSha: string }[];
  /** Files left as they are: rel path → baseline to keep recording (undefined = untracked). */
  kept: { rel: string; baselineSha?: string; reason: 'edited' | 'not-ours' | 'symlink' }[];
}

export interface GuardedSkill {
  /** Installed folder name under the skill root. */
  name: string;
  /** The package's copy of the skill. */
  sourceDir: string;
  shippedShas: ShippedShas;
  /** Which files (path inside the skill, `/`-separated) ship. */
  filter: (rel: string) => boolean;
}

/** Every regular file under `dir` as a path relative to it; symlinks and `node_modules` skipped. */
function sourceFiles(dir: string, prefix = '', out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules') continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (st.isDirectory()) sourceFiles(abs, rel, out);
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Copy a guarded skill from its package folder into `<skillRoot>/<name>/`.
 * `recorded` is the manifest ON DISK (the previous install's record), never the one being built.
 */
export function installGuardedSkill(
  skill: GuardedSkill,
  projectRoot: string,
  skillRootRel: string,
  recorded: Manifest | null,
): GuardedInstallResult {
  const result: GuardedInstallResult = { written: [], kept: [] };
  const files = sourceFiles(skill.sourceDir).filter(skill.filter);
  const rootSegs = [...skillRootRel.split('/').filter(Boolean), skill.name];
  const relOf = (f: string): string => `${skillRootRel}/${skill.name}/${f}`;
  // A linked folder anywhere between the project and the skill (`.claude`, `.claude/skills`, the
  // skill folder) would carry every write below out of the project: refuse the whole skill.
  if (linkedFolderOnPath(projectRoot, rootSegs)) {
    for (const f of files) {
      const baselineSha = recorded?.files[relOf(f)]?.baselineSha;
      result.kept.push({ rel: relOf(f), reason: 'symlink', ...(baselineSha ? { baselineSha } : {}) });
    }
    return result;
  }
  const destDir = join(projectRoot, ...rootSegs);
  mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const rel = relOf(f);
    const entry = recorded?.files[rel];
    const keepBaseline = entry?.baselineSha ? { baselineSha: entry.baselineSha } : {};
    const sub = f.split('/');
    // A linked sub-folder (`scripts/`, `scripts/lib/`) is never written through either.
    if (sub.length > 1 && linkedFolderOnPath(destDir, sub.slice(0, -1))) {
      result.kept.push({ rel, reason: 'symlink', ...keepBaseline });
      continue;
    }
    const dest = join(destDir, ...sub);
    const source = readFileSync(join(skill.sourceDir, ...sub));
    const shipped = guardedFileSha(source);

    let installed: Buffer | null = null;
    try {
      const st = lstatSync(dest);
      if (st.isSymbolicLink() || !st.isFile()) {
        result.kept.push({ rel, reason: 'symlink', ...keepBaseline });
        continue;
      }
      installed = readFileSync(dest);
    } catch {
      installed = null; // not installed yet
    }

    if (installed !== null) {
      const now = guardedFileSha(installed);
      if (now === shipped) {
        result.written.push({ rel, baselineSha: shipped });
        continue;
      }
      // Ours to refresh only when it is exactly something dreamcontext wrote: the recorded
      // baseline, or (with no baseline) a version we shipped. Anything else is an edit.
      const ours = entry?.baselineSha ? now === entry.baselineSha : (skill.shippedShas[f] ?? []).includes(now);
      if (!ours) {
        if (recorded && !entry) result.kept.push({ rel, reason: 'not-ours' });
        else result.kept.push({ rel, reason: 'edited', ...keepBaseline });
        continue;
      }
    }
    if (sub.length > 1) mkdirSync(join(destDir, ...sub.slice(0, -1)), { recursive: true });
    writeFileSync(dest, source);
    result.written.push({ rel, baselineSha: shipped });
  }
  return result;
}

/** The design skill (unchanged behaviour: its top-level markdown, its table). */
export function installDesignSkill(
  sourceDir: string,
  projectRoot: string,
  skillRootRel: string,
  recorded: Manifest | null,
  shippedShas: ShippedShas = DESIGN_SHIPPED_SHAS,
): GuardedInstallResult {
  return installGuardedSkill({ name: DESIGN_SKILL, sourceDir, shippedShas, filter: designFilter }, projectRoot, skillRootRel, recorded);
}

/** The draw skill: its whole folder (router, references, scripts, examples). */
export function installDrawSkill(
  sourceDir: string,
  projectRoot: string,
  skillRootRel: string,
  recorded: Manifest | null,
  shippedShas: ShippedShas = DRAW_SHIPPED_SHAS,
): GuardedInstallResult {
  return installGuardedSkill({ name: DRAW_SKILL, sourceDir, shippedShas, filter: drawFilter }, projectRoot, skillRootRel, recorded);
}
