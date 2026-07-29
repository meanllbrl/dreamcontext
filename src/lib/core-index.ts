import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CoreFileEntry {
  filename: string;
  name: string;
  type: string;
  summary: string;
  path: string;
}

/**
 * Soft authoring ceiling for core files — the heuristic the skill and the sleep
 * specialist already state (SKILL.md rule 12, `agents/sleep-state.md` §C1).
 */
export const CORE_FILE_LINE_CEILING = 150;

/**
 * Hard-ish size ceiling in CHARS — what the SessionStart snapshot actually pays.
 *
 * The line ceiling above is not a usable size proxy, which is why this exists.
 * Measured on this repo: `core/0.soul.md` is 69 lines but 13,573 chars (197
 * chars/line) and `core/2.memory.md` is 165 lines / 92,249 chars — a line-only
 * check reports "fine" on exactly the files that push the snapshot past the
 * harness persist limit. Both axes are reported so neither hides the other.
 */
export const CORE_FILE_CHAR_CEILING = 4_000;

export interface CoreFileSizeAudit {
  /** Vault-relative path, named exactly as the snapshot names it. */
  relPath: string;
  /**
   * UTF-16 code units (`String.length`), NOT bytes. The harness persist limit is
   * compared against `text.length`, and on real vaults the two diverge by ~1.3%
   * (emoji, `★`, `—`, Turkish text), so `statSync().size` would over-report.
   */
  chars: number;
  /**
   * Newline-separated segments (`split('\n').length`). A file ending in a
   * trailing newline therefore counts one higher than `wc -l`; the ceiling is a
   * soft heuristic so the exact convention matters less than it being stated.
   */
  lines: number;
  overChars: boolean;
  overLines: boolean;
}

// ─── Index Builder ─────────────────────────────────────────────────────────

/**
 * Scan core/ for extra files (3+) not already loaded in full by the snapshot.
 * Excludes 0.soul, 1.user, 2.memory, CHANGELOG.json, RELEASES.json. (Features
 * now live under knowledge/features/, not core/ — the `[3-9]*` glob already
 * excludes core/features/ on any brain, migrated or not.)
 *
 * SLOT 1 IS RETIRED, not reused. The user file moved to `people/<slug>.md` in
 * 0.23.0 and the numbering deliberately keeps its gap: `0.soul, 2.memory,
 * 3.style_guide, 4.tech_stack`. Renumbering `2.memory → 1.memory` would churn
 * every doc, fixture, test and user habit for cosmetics, and the `[3-9]*` glob
 * here never saw slot 1 either way. A future core file takes 5+, never 1.
 *
 * Returns [] if none exist.
 */
export function buildCoreIndex(contextRoot: string): CoreFileEntry[] {
  const coreDir = join(contextRoot, 'core');
  if (!existsSync(coreDir)) return [];

  const files = fg.sync('[3-9]*', { cwd: coreDir, absolute: true });
  const entries: CoreFileEntry[] = [];

  for (const file of files) {
    const filename = basename(file);
    const relativePath = `_dream_context/core/${filename}`;

    // JSON files don't have frontmatter — derive name from filename
    if (filename.endsWith('.json')) {
      entries.push({
        filename,
        name: filename.replace(/^\d+\./, '').replace(/\.\w+$/, '').replace(/_/g, ' '),
        type: 'data',
        summary: '',
        path: relativePath,
      });
      continue;
    }

    try {
      const { data } = readFrontmatter(file);
      entries.push({
        filename,
        name: String(data.name ?? filename),
        type: String(data.type ?? 'unknown'),
        summary: String(data.summary ?? ''),
        path: relativePath,
      });
    } catch {
      entries.push({
        filename,
        name: filename,
        type: 'unknown',
        summary: '',
        path: relativePath,
      });
    }
  }

  entries.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  return entries;
}

// ─── Anti-bloat audit ──────────────────────────────────────────────────────

/**
 * Measure every always-loaded constitution-class markdown file against the
 * anti-bloat ceilings.
 *
 * Covers `core/[0-9]*.md` — soul (0), the retired user slot (1), memory (2) and
 * the extended files (3+) — AND `people/*.md`, the per-person constitutions.
 * The people files earn the same ceiling on the same grounds: the ACTIVE one is
 * never-evict and renders verbatim on every single session, so an oversized
 * constitution is a content problem the ladder cannot absorb. (The inactive ones
 * cost nothing at render time, but they are the same kind of document and a
 * teammate's bloat becomes yours the day their machine is the active one.)
 *
 * Non-markdown siblings are skipped: a `.json` payload carries no prose to
 * extract into knowledge, and a legacy `.sql` schema is not subject to a prose
 * ceiling. `people/people.json` is skipped for exactly that reason.
 *
 * Read-only and TOTAL — absent dirs yield `[]`, an unreadable dir contributes
 * nothing, and an unreadable file is skipped rather than throwing. Callers sit on
 * or beside the SessionStart hot path (`doctor`, the snapshot's over-budget
 * banner), so this must never be the thing that breaks them.
 *
 * Sorted numerically by path so output is stable for rendering and for tests;
 * `core/…` sorts before `people/…`, which keeps every existing row in place.
 */
export function auditCoreFileSizes(contextRoot: string): CoreFileSizeAudit[] {
  const audits: CoreFileSizeAudit[] = [
    ...auditDir(join(contextRoot, 'core'), '[0-9]*', '_dream_context/core'),
    ...auditDir(join(contextRoot, 'people'), '*.md', '_dream_context/people'),
  ];
  audits.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true }));
  return audits;
}

/** One directory's worth of the audit. Total: never throws, whatever it finds. */
function auditDir(dir: string, glob: string, relPrefix: string): CoreFileSizeAudit[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = fg.sync(glob, { cwd: dir, absolute: true });
  } catch {
    return []; // unreadable dir — report nothing, never throw
  }

  const audits: CoreFileSizeAudit[] = [];
  for (const file of files) {
    const filename = basename(file);
    if (!filename.endsWith('.md')) continue;

    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue; // unreadable file — skipped, never fatal
    }

    const chars = content.length;
    const lines = content.split('\n').length;
    audits.push({
      relPath: `${relPrefix}/${filename}`,
      chars,
      lines,
      overChars: chars > CORE_FILE_CHAR_CEILING,
      overLines: lines > CORE_FILE_LINE_CEILING,
    });
  }
  return audits;
}
