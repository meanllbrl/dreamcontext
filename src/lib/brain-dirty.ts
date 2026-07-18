/**
 * brain-dirty — post-sleep durability warning (AC5).
 *
 * User decision (binding, 2026-07-18): the default is a LOUD WARNING with a
 * ready-to-run commit command — NEVER an auto-commit, and no config flag to
 * turn one on. This module only INSPECTS and RENDERS; nothing here executes a
 * git write of any kind (grep this file for `commit` — it appears only inside
 * string literals rendered for the user to run themselves).
 */

import { resolve } from 'node:path';
import { statusPorcelainTracked, repoToplevel } from './git-sync/git.js';

export interface BrainDirtyReport {
  /** Repo-relative paths under the brain dir that are uncommitted (tracked-dirty
   *  or untracked). Empty when the tree is clean (or inconclusive — see `unavailable`). */
  paths: string[];
  /** True when git status could not be determined (no git, not a repo, thrown
   *  error) — the report is inconclusive, NOT a claim that the tree is clean. */
  unavailable: boolean;
}

/**
 * Collect uncommitted paths under `<contextDirName>/`, scoped to that prefix so
 * a dirty CODE tree never triggers this warning — only brain output does.
 *
 * `projectRoot` MUST be its own repo top-level before `git status` output is
 * trusted: when a scratch vault sits NESTED inside an enclosing checkout (no
 * `.git` of its own), `git status` run there walks UP to the enclosing repo,
 * and its uncommitted paths have nothing to do with `projectRoot` — reporting
 * them would falsely warn about another project's files. `repoToplevel`
 * resolves the work-tree root git would actually operate on; a mismatch (or a
 * failed/absent repo) makes the report `unavailable` rather than wrong.
 *
 * Reuses `statusPorcelainTracked` (already includes untracked files, already
 * swallows its own git-invocation errors to `[]`); the try/catch around both
 * injected impls exists so a test double that throws is reported as
 * `unavailable` instead of silently read as "clean".
 */
export function collectBrainDirty(
  projectRoot: string,
  opts: {
    contextDirName?: string;
    statusImpl?: (cwd: string) => string[];
    topLevelImpl?: (cwd: string) => string | null;
  } = {},
): BrainDirtyReport {
  const contextDirName = opts.contextDirName ?? '_dream_context';
  const statusImpl = opts.statusImpl ?? statusPorcelainTracked;
  const topLevelImpl = opts.topLevelImpl ?? repoToplevel;

  let topLevel: string | null;
  try {
    topLevel = topLevelImpl(projectRoot);
  } catch {
    return { paths: [], unavailable: true };
  }
  if (!topLevel || resolve(topLevel) !== resolve(projectRoot)) {
    return { paths: [], unavailable: true };
  }

  let raw: string[];
  try {
    raw = statusImpl(projectRoot);
  } catch {
    return { paths: [], unavailable: true };
  }

  const prefix = `${contextDirName}/`;
  const paths = raw.filter((p) => p === contextDirName || p.startsWith(prefix));
  return { paths, unavailable: false };
}

/** Cap on how many dirty paths are listed verbatim in the warning. */
export const BRAIN_DIRTY_MAX_LISTED = 15;

/**
 * Render the loud warning: what's dirty, and the exact command to fix it.
 * Returns `[]` when there is nothing to warn about (clean tree) — callers emit
 * nothing in that case. The rendered command scopes `git add` to the brain dir
 * ONLY (never a bare `-A` over the whole repo) and never runs anything itself.
 */
export function renderBrainDirtyWarning(
  r: BrainDirtyReport,
  opts: { contextDirName: string; today: string; maxListed?: number },
): string[] {
  const maxListed = opts.maxListed ?? BRAIN_DIRTY_MAX_LISTED;

  if (r.unavailable) {
    return [
      `⚠ Could not verify whether ${opts.contextDirName}/ is committed (git status unavailable) — check manually.`,
    ];
  }
  if (r.paths.length === 0) return [];

  const lines: string[] = [
    `⚠ ${r.paths.length} uncommitted file(s) under ${opts.contextDirName}/ — a stray \`git checkout .\` could erase this cycle's consolidated output:`,
  ];
  for (const p of r.paths.slice(0, maxListed)) lines.push(`  - ${p}`);
  if (r.paths.length > maxListed) {
    lines.push(`  … and ${r.paths.length - maxListed} more`);
  }
  lines.push('Commit it now:');
  lines.push(`  git add -A -- ${opts.contextDirName} && git commit -m "chore(brain): consolidate ${opts.today} sleep output"`);
  return lines;
}
