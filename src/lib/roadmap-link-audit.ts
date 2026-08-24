import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import matter from 'gray-matter';

/**
 * TASK → OBJECTIVE LINK-LOSS AUDIT.
 *
 * `objectives:` lives in task frontmatter under the GITIGNORED `state/`, so a
 * lost link has no git history to restore from. The auto-generated
 * `knowledge/roadmap/board.md` does though: it is committed, and it lists every
 * objective with its member tasks. That artifact is what made the 2026-07-27
 * incident recoverable at all (72 links stripped by one `tasks sync pull`,
 * reconstructed from the previous day's committed board) — luck, not a
 * mechanism. This turns it into a mechanism: doctor compares the board against
 * the live task files and reports objectives whose links have vanished.
 *
 * Deliberately narrow, because unlinking a task IS a legitimate PO action: an
 * objective is only reported when EVERY link the board recorded for it is gone
 * while the task files themselves still exist. One task unlinked reads as an
 * edit; all of them at once reads as the failure mode this audit exists for.
 */

export interface VanishedObjectiveLinks {
  /** The objective whose member links all disappeared. */
  objective: string;
  /** Tasks the board recorded for it that still exist but no longer link to it. */
  tasks: string[];
}

/** Objective → member task slugs, as recorded in a generated board.md. */
export function parseBoardLinks(boardMarkdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of boardMarkdown.split('\n')) {
    const heading = /^###\s+\S*\s*\*\*([a-z0-9-]+)\*\*/.exec(line);
    if (heading) {
      current = heading[1];
      out.set(current, []);
      continue;
    }
    if (line.startsWith('#')) { // any other heading closes the section
      current = null;
      continue;
    }
    if (current === null) continue;
    const task = /^\s{2}-\s+([a-z0-9][a-z0-9._-]*)\s+\(/.exec(line);
    if (task) out.get(current)!.push(task[1]);
  }
  return out;
}

/** Live `objectives:` links, keyed by task slug. Unreadable files are skipped. */
function liveTaskLinks(contextRoot: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const stateDir = join(contextRoot, 'state');
  if (!existsSync(stateDir)) return out;
  for (const file of fg.sync('*.md', { cwd: stateDir, absolute: true })) {
    try {
      const data = matter(readFileSync(file, 'utf-8')).data as Record<string, unknown>;
      const links = Array.isArray(data.objectives) ? data.objectives.map((s) => String(s).trim()) : [];
      out.set(file.slice(file.lastIndexOf('/') + 1, -3), new Set(links.filter(Boolean)));
    } catch { /* unreadable task — other doctor checks own that */ }
  }
  return out;
}

/**
 * Objectives whose entire recorded member set no longer links back to them.
 * Empty when there is no board yet, or when nothing was lost.
 */
export function auditObjectiveLinkLoss(contextRoot: string): VanishedObjectiveLinks[] {
  const boardPath = join(contextRoot, 'knowledge', 'roadmap', 'board.md');
  if (!existsSync(boardPath)) return [];

  let board: Map<string, string[]>;
  try {
    board = parseBoardLinks(readFileSync(boardPath, 'utf-8'));
  } catch {
    return [];
  }
  if (board.size === 0) return [];

  const live = liveTaskLinks(contextRoot);
  const objectivesDir = join(contextRoot, 'core', 'objectives');
  const out: VanishedObjectiveLinks[] = [];

  for (const [objective, taskSlugs] of board) {
    // Only objectives that still exist — a deleted objective self-heals its
    // task links on delete, which is a legitimate unlink, not a loss.
    if (!existsSync(join(objectivesDir, `${objective}.md`))) continue;
    const surviving = taskSlugs.filter((t) => live.has(t));
    if (surviving.length === 0) continue; // the tasks are gone too — not link loss
    const unlinked = surviving.filter((t) => !live.get(t)!.has(objective));
    if (unlinked.length === surviving.length) out.push({ objective, tasks: unlinked });
  }
  return out;
}
