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
 *  - with no baseline (the old pack's manifest, or no manifest at all: a fresh clone, a second
 *    machine) a file is refreshed only if it is byte-for-byte a version we shipped
 *    ({@link SHIPPED_DESIGN_SHAS}); otherwise it is kept and reported;
 *  - a file present on disk that a manifest exists for but does not list is not ours: kept;
 *  - hashes read CRLF as LF, so a Windows checkout is never mistaken for an edit;
 *  - a symlink is never written through: not the file, and not a folder on the way to it.
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

/** Is any existing folder on `root/segments...` a symlink (or not a folder)? Absent ones are fine. */
function linkedFolderOnPath(root: string, segments: string[]): boolean {
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

/** sha256 of the text with CRLF read as LF, so a Windows checkout never reads as an edit. */
export function designFileSha(content: string | Buffer): string {
  const text = typeof content === 'string' ? content : content.toString('utf-8');
  return createHash('sha256').update(text.split('\r\n').join('\n'), 'utf-8').digest('hex');
}

/**
 * Every version the old `design` pack ever shipped (skill-packs/design, 2026-03-24 and 2026-11-03),
 * hashed with {@link designFileSha}. A copy without a recorded baseline (no manifest on a fresh
 * clone or second machine, or the pack-era manifest) is refreshed only when it is one of these or
 * the current file: anything else is someone's edit and is kept. Append, never remove.
 */
export const SHIPPED_DESIGN_SHAS: Readonly<Record<string, readonly string[]>> = {
  'SKILL.md': ['08e18d36b6dc3f9940ae94f51d41ed9d00d786fcd07ff93c42a2b836bef74281', '1d730ba5a1fb8bebe18ccdb29d1af12663758860ac19e90c89e15324f7ba8c1b'],
  'design-mobile.md': ['476afd5a92542bd533cd5f70f1ad9d1fc2501aee4227d3789a18e4ca20f8639c', 'eb555f03b79c9fefef551eb40e53870a87e2f21636595a683109c5292850a207'],
  'design-web.md': ['6f452df6dad699bafde616dea6c798c3e994282aaf93ce9e4e0c5532d19d903b', 'be2bf417ce3d3338ce274cfa942f637d285ca0f6209f57bc3eccc373b77e2a50'],
  'frontend-principles.md': ['c7726040decea0b88648fb3aa0d28b73cff27b4c8b5031e4c77d7be6bf941eeb', '9dbc242669c6ca7a8dbdbd259d76a603ece0172c0baffa67eb9800149f7a176a'],
  'onboarding-design.md': ['d66ffb03063605c1bb6ee776e2edb1e0f07ba41676f84d42f35e18ec8bebcc72', 'c333f0d916d8247ba91cf04e86e898d0d7d654c0e58d1a05000681849d50f9ca'],
  'product-ui.md': ['636f0d6404d15433e7cc4a561b98ae877f1be608db762ebc10ed8af6b34455f6'],
};

/**
 * May `update` delete this installed design file (a later release dropped it)? Only when it is
 * still exactly what dreamcontext wrote: its recorded baseline, or with none a version we shipped.
 * Unreadable, a link, or edited: no, it is kept.
 */
export function designFileIsUnchanged(abs: string, baselineSha: string | undefined): boolean {
  try {
    if (!lstatSync(abs).isFile()) return false;
    const now = designFileSha(readFileSync(abs));
    if (baselineSha) return now === baselineSha;
    const name = abs.split(/[\\/]/).pop() ?? '';
    return (SHIPPED_DESIGN_SHAS[name] ?? []).includes(now);
  } catch {
    return false;
  }
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
  projectRoot: string,
  skillRootRel: string,
  recorded: Manifest | null,
  shippedShas: Readonly<Record<string, readonly string[]>> = SHIPPED_DESIGN_SHAS,
): DesignInstallResult {
  const result: DesignInstallResult = { written: [], kept: [] };
  const files = readdirSync(sourceDir).filter((f) => f.endsWith('.md')).sort();
  // A linked folder anywhere between the project and the skill (`.claude`, `.claude/skills`,
  // `design`) would carry every write below out of the project: refuse the whole skill.
  if (linkedFolderOnPath(projectRoot, [...skillRootRel.split('/').filter(Boolean), DESIGN_SKILL])) {
    for (const f of files) {
      const rel = `${skillRootRel}/${DESIGN_SKILL}/${f}`;
      const baselineSha = recorded?.files[rel]?.baselineSha;
      result.kept.push({ rel, reason: 'symlink', ...(baselineSha ? { baselineSha } : {}) });
    }
    return result;
  }
  const destDir = join(projectRoot, ...skillRootRel.split('/').filter(Boolean), DESIGN_SKILL);
  mkdirSync(destDir, { recursive: true });
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
      const now = designFileSha(installed);
      const shipped = designFileSha(source);
      if (now === shipped) {
        result.written.push({ rel, baselineSha: shipped });
        continue;
      }
      // Ours to refresh only when it is exactly something dreamcontext wrote: the recorded
      // baseline, or (with no baseline) a version the pack shipped. Anything else is an edit.
      const ours = entry?.baselineSha ? now === entry.baselineSha : (shippedShas[f] ?? []).includes(now);
      if (!ours) {
        if (recorded && !entry) result.kept.push({ rel, reason: 'not-ours' });
        else result.kept.push({ rel, reason: 'edited', ...(entry?.baselineSha ? { baselineSha: entry.baselineSha } : {}) });
        continue;
      }
    }
    writeFileSync(dest, source);
    result.written.push({ rel, baselineSha: designFileSha(source) });
  }
  return result;
}
