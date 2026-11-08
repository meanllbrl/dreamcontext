import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import fg from './glob.js';
import { acquireFileLock, releaseFileLock } from './file-lock.js';
import { readFrontmatter } from './frontmatter.js';
import { loadStatuses } from './overrides.js';
import { isTerminal, normalizeStatusKey } from './task-status.js';
import { buildRoadmapModel, type RoadmapModel } from './roadmap-model.js';
import { listObjectives } from './objectives-store.js';
import {
  effectiveSuggestion,
  hasLiveVerdict,
  isScored,
  liveLinks,
  missingRiceKeys,
  taskSuggestionTarget,
  type ObjectiveLiveness,
  type RiceKey,
  type SuggestionTarget,
} from './priority-suggestion.js';

/**
 * scoringWork — the ONE definition of N, the count on the board's "✦ Score N"
 * button and the payload a scoring agent reads (`roadmap unscored --json`).
 *
 * An item is an open top-level task that is unscored or has no live objective
 * link, or an open objective that is unscored. Items with a pending or a
 * dismissed suggestion are not work (the owner has them, or said no). A live
 * `no_objective` verdict closes only the LINK side of a task. With `again`,
 * dismissed items and verdict items come back.
 */

export interface OpenTask {
  slug: string;
  name: string;
  status: string;
  parent_task: string | null;
  data: Record<string, unknown>;
}

/** Every open (non-terminal) task in state/, with its raw frontmatter. */
export function loadOpenTasks(contextRoot: string): OpenTask[] {
  const stateDir = join(contextRoot, 'state');
  if (!existsSync(stateDir)) return [];
  const statuses = loadStatuses(contextRoot);
  const out: OpenTask[] = [];
  for (const file of fg.sync('*.md', { cwd: stateDir, absolute: true }).sort()) {
    try {
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      const status = normalizeStatusKey(data.status) || 'todo';
      if (isTerminal(statuses, status)) continue;
      const parent = typeof data.parent_task === 'string' && data.parent_task.trim() ? data.parent_task.trim() : null;
      out.push({
        slug: basename(file, '.md'),
        name: typeof data.name === 'string' && data.name.trim() ? data.name : basename(file, '.md'),
        status,
        parent_task: parent,
        data,
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * The Tasks board's top-level rule (dashboard boardModel.ts `nestChildren`),
 * over the OPEN set: a task is its own card unless its parent is open AND that
 * parent is itself a card. Two levels max. Drift-tested against boardModel.
 */
export function topLevelOf<T extends { slug: string; parent_task: string | null }>(tasks: readonly T[]): T[] {
  const slugs = new Set(tasks.map((t) => t.slug));
  const isTop = (t: T): boolean => !t.parent_task || !slugs.has(t.parent_task) || t.parent_task === t.slug;
  const topSlugs = new Set(tasks.filter(isTop).map((t) => t.slug));
  return tasks.filter((t) => !(t.parent_task && t.parent_task !== t.slug && topSlugs.has(t.parent_task)));
}

/** Liveness of every objective (effective status from the model). */
export function objectiveLiveness(model: RoadmapModel): ObjectiveLiveness[] {
  return model.objectives.map((o) => ({ slug: o.slug, done: o.status === 'done', created_at: o.created_at }));
}

export interface ScoringItem {
  kind: 'task' | 'objective';
  slug: string;
  title: string;
  /** RICE keys the target lacks (the suggestion must carry exactly these). */
  missing: RiceKey[];
  /** Tasks: the link side is open (no live link, no live verdict). */
  needs_link: boolean;
  /** Current values, so an agent sees what is already set. */
  rice: SuggestionTarget['rice'];
  objectives: string[];
  why: string | null;
  /** The previous suggestion was dismissed (only listed with `again`). */
  dismissed: boolean;
}

export interface ScoringWork {
  count: number;
  /** Items with a pending (effective, not dismissed) suggestion. */
  pending: number;
  items: ScoringItem[];
  /** Live objectives a task may be linked to. */
  objectives: Array<{ slug: string; title: string }>;
}

export function scoringWork(
  contextRoot: string,
  opts: { again?: boolean; model?: RoadmapModel; tasks?: OpenTask[] } = {},
): ScoringWork {
  const model = opts.model ?? buildRoadmapModel(contextRoot);
  const liveness = objectiveLiveness(model);
  const items: ScoringItem[] = [];
  let pending = 0;

  const tasks = topLevelOf(opts.tasks ?? loadOpenTasks(contextRoot));
  for (const t of tasks) {
    const target = taskSuggestionTarget(t.data);
    const s = target.priority_suggestion;
    if (effectiveSuggestion(target, liveness)) {
      pending++;
      continue;
    }
    const dismissed = !!s?.dismissed_at;
    if (dismissed && !opts.again) continue;
    const needsScore = !isScored(target.rice);
    const linked = liveLinks(target.objectives, liveness).length > 0;
    const verdict = hasLiveVerdict(s, liveness);
    const needsLink = !linked && (opts.again || !verdict);
    if (!needsScore && !needsLink) continue;
    items.push({
      kind: 'task',
      slug: t.slug,
      title: t.name,
      missing: missingRiceKeys(target.rice),
      needs_link: needsLink,
      rice: target.rice,
      objectives: target.objectives ?? [],
      why: s?.why ?? null,
      dismissed,
    });
  }

  for (const o of listObjectives(contextRoot)) {
    const live = liveness.find((l) => l.slug === o.slug);
    if (!live || live.done) continue;
    const target: SuggestionTarget = {
      kind: 'objective',
      rice: { reach: o.reach, impact: o.impact, confidence: o.confidence, effort: o.effort },
      priority_suggestion: o.priority_suggestion,
    };
    if (effectiveSuggestion(target, liveness)) {
      pending++;
      continue;
    }
    const dismissed = !!o.priority_suggestion?.dismissed_at;
    if (dismissed && !opts.again) continue;
    if (isScored(target.rice)) continue;
    items.push({
      kind: 'objective',
      slug: o.slug,
      title: o.title,
      missing: missingRiceKeys(target.rice),
      needs_link: false,
      rice: target.rice,
      objectives: [],
      why: o.priority_suggestion?.why ?? null,
      dismissed,
    });
  }

  return {
    count: items.length,
    pending,
    items,
    objectives: model.objectives.filter((o) => o.status !== 'done').map((o) => ({ slug: o.slug, title: o.title })),
  };
}

// ─── The "agent is scoring" marker ──────────────────────────────────────────
//
// Machine-local (tmp/ is gitignored, outside the task glob). scoring/start sets
// it with a compare-and-set; each suggest refreshes it ONLY while one is active
// (an ad hoc suggest creates none); `roadmap unscored --done` or 10 quiet
// minutes end it. On the server so a reload, or leaving the page, keeps the
// button on "Scoring…", and an accept that takes pending to 0 mid-run does not
// release it.

export const SCORING_IDLE_MS = 10 * 60 * 1000;

interface ScoringMarker {
  started_at: number;
  touched_at: number;
}

export function scoringMarkerPath(contextRoot: string): string {
  return join(contextRoot, 'tmp', 'roadmap-scoring.json');
}

function readMarker(contextRoot: string): ScoringMarker | null {
  try {
    const raw = JSON.parse(readFileSync(scoringMarkerPath(contextRoot), 'utf-8')) as Partial<ScoringMarker>;
    if (typeof raw.touched_at !== 'number' || typeof raw.started_at !== 'number') return null;
    return { started_at: raw.started_at, touched_at: raw.touched_at };
  } catch {
    return null;
  }
}

function writeMarker(contextRoot: string, m: ScoringMarker): void {
  const p = scoringMarkerPath(contextRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m) + '\n');
}

export function isScoringRunning(contextRoot: string, now: number = Date.now()): boolean {
  const m = readMarker(contextRoot);
  return !!m && now - m.touched_at < SCORING_IDLE_MS;
}

/**
 * Compare-and-set: true when this call started a run, false when one is already
 * running. Serialised by an O_EXCL lock so two windows (or a double click) can
 * never both win.
 */
export function startScoring(contextRoot: string, now: number = Date.now()): boolean {
  const lock = join(contextRoot, 'tmp', 'locks', 'roadmap-scoring.lock');
  // Another start holds the lock right now: it wins. A crashed holder's lock goes stale in 10 s.
  if (!acquireFileLock(lock, Date.now(), 10_000)) return false;
  try {
    if (isScoringRunning(contextRoot, now)) return false;
    writeMarker(contextRoot, { started_at: now, touched_at: now });
    return true;
  } finally {
    releaseFileLock(lock);
  }
}

export function stopScoring(contextRoot: string): void {
  rmSync(scoringMarkerPath(contextRoot), { force: true });
}

/** A suggest refreshes an ACTIVE marker; it never creates one. */
export function touchScoring(contextRoot: string, now: number = Date.now()): void {
  const m = readMarker(contextRoot);
  if (!m || now - m.touched_at >= SCORING_IDLE_MS) return;
  writeMarker(contextRoot, { ...m, touched_at: now });
}
