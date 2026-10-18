import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyTaskFeatureLink, resolveFeature, taskFeatureOf } from './feature-links.js';
import { readFrontmatter, updateFrontmatterFields } from './frontmatter.js';
import { generateId, today } from './id.js';
import { readJsonArray } from './json-file.js';
import { loadStatuses } from './overrides.js';
import { safeResolveInside } from './safe-resolve.js';
import { prepareSectionInsert } from './section-insert.js';
import { NAME_SOFT_LIMIT, WHY_SOFT_LIMIT } from './task-card.js';
import { readCycles } from './cycles.js';
import { TaskFileBusyError, withTaskFileLock } from './task-file-lock.js';
import { appendJournalEntry } from './task-journal.js';
import { dateUpdatesForStatus } from './task-dates.js';
import { linkTaskToParent } from './task-parent-link.js';
import {
  buildFamily,
  checkParentLink,
  liveChildren,
  loadFamily,
  loadTaskBriefs,
  normalizeParentRef,
  rolledUpStatus,
  type Family,
  type TaskBrief,
} from './task-parent.js';
import { cycleOfCard, derivedParentPlacement, hasPlacement, type Queue } from './task-order.js';
import { isTerminal, statusKind, type StatusDef } from './task-status.js';
import type { TaskBackend } from './task-backend/types.js';
import { isSafeTaskSlug } from './task-backend/local.js';

/**
 * The 0.33.0 task migration: the open backlog moves onto the new model
 * (parents and children, Now/Next/Later, no planning versions).
 *
 * Two halves, like every migration that needs judgment:
 *
 *  - The CODE step (`runBacklogStep`, run by `update` / `sleep start`) does only
 *    what has one right answer: every `planning` entry leaves RELEASES.json,
 *    `state/.active-version.json` goes, every open card gets a place (BACKLOG →
 *    Later, everything else → Next, ranked so the old active version's work
 *    leads), legacy `parent_task` ids become slugs, and `<x>-step-<n>` cards go
 *    under the one open `<x>-epic…` card. It also takes stock: every task open
 *    at that moment gets a record waiting for an outcome.
 *  - The AGENT half (agentTask `reorganize-open-tasks`, done by sleep-migration
 *    in the next sleep) decides each record: keep (optionally under a parent,
 *    linked to its family's feature), merge (cancelled + absorbed_by, never
 *    deleted) or cancel. A family is an AREA, so it is a feature link, never a
 *    parent; only a real deliverable gets a parent. What the agent is not sure
 *    about becomes a proposal on the Tasks screen and stays kept until the
 *    owner answers.
 *
 * Nothing here deletes a task. The change list (`state/.backlog-migration.json`)
 * keeps every value the migration replaced, the retired planning entries
 * verbatim and the old active-version file, so every step can be undone by
 * hand. It is machine state like `.task-declined.json`: it syncs where the
 * brain repo syncs `state/`, and stays on this machine where `state/` is
 * ignored.
 */

export const BACKLOG_MIGRATION_VERSION = '0.33.0';
export const BACKLOG_STEP_ID = 'retire-planning-and-place-open-tasks';
export const BACKLOG_AGENT_TASK_ID = 'reorganize-open-tasks';
export const BACKLOG_MIGRATION_REL_PATH = 'state/.backlog-migration.json';
const ACTIVE_VERSION_REL_PATH = 'state/.active-version.json';
const RELEASES_REL_PATH = 'core/RELEASES.json';
/** The lock key for every read-modify-write of the change list. */
const LOCK_KEY = '.backlog-migration';
const RANK_STEP = 10;
const LEGACY_PRIORITY = ['critical', 'high', 'medium', 'low'];

export type BacklogOutcome = 'keep' | 'merge' | 'cancel';
export type DecidedBy = 'code' | 'agent' | 'owner';

export interface FieldChange {
  /** A frontmatter key, or `created` for a parent the migration created. */
  field: string;
  before: unknown;
  after: unknown;
  at: string;
  by: DecidedBy;
}

export interface BacklogTaskRecord {
  slug: string;
  name: string;
  /** The status it had when the migration took stock. */
  status: string;
  /** null = still waiting for a decision. */
  outcome: BacklogOutcome | null;
  by: DecidedBy | null;
  /** The task a merged one was absorbed by. */
  into?: string;
  reason?: string;
  /** An uncertain change put in front of the owner on the Tasks screen (Proposals section). */
  suggestion?: ChangeSuggestion;
  /** True for a parent the migration created to hold a family. */
  created?: boolean;
  decidedAt?: string;
  /**
   * A merge or cancel being written: recorded before the card changes, so a run
   * interrupted after the card was cancelled can be finished by a retry.
   */
  intent?: { outcome: BacklogOutcome; into?: string; at: string };
  /** Every field the migration changed on this card, in order: the undo record. */
  changes: FieldChange[];
}

export type SuggestedChange = 'merge' | 'cancel' | 'parent' | 'later' | 'feature';
export const SUGGESTED_CHANGES: readonly SuggestedChange[] = ['merge', 'cancel', 'parent', 'later', 'feature'];

/**
 * A change the agent was not sure enough to apply. The task stays as it is
 * (outcome keep) until the owner answers on the Tasks screen: apply it, or
 * keep the task as it is. A resolved suggestion stays on the record as history.
 */
export interface ChangeSuggestion {
  id: string;
  change: SuggestedChange;
  /** merge: the task that would absorb it; parent: the parent it would go under; feature: the feature. */
  target: string | null;
  why: string;
  by: DecidedBy;
  proposedAt: string;
  resolved?: { verdict: 'applied' | 'kept'; at: string };
}

export interface BacklogCounts {
  /** Open tasks (not done-kind, not cancelled-kind). */
  open: number;
  /** What the board shows at the top level: open standalone tasks + parents with open work. */
  topLevel: number;
  /** Parents holding at least one open sub-task. */
  parents: number;
  /**
   * The top-level items by feature: what a board grouped by area shows. A
   * family is an area, so this is where the families become few. Absent on a
   * change list written before the feature link existed.
   */
  byFeature?: { groups: number; features: number; unlinked: number };
}

export interface BacklogMigrationStore {
  version: 1;
  startedAt: string;
  before: BacklogCounts;
  /** RELEASES.json `planning` entries, verbatim, as they were removed. */
  retiredReleases: Array<Record<string, unknown>>;
  /** The removed `state/.active-version.json`, verbatim. */
  retiredActiveVersion: string | null;
  /** Parents the migration created to hold a family. */
  createdParents: string[];
  tasks: Record<string, BacklogTaskRecord>;
}

export class BacklogError extends Error {
  constructor(
    public readonly code:
      | 'no_store' | 'corrupt' | 'not_found' | 'not_open' | 'invalid' | 'decided'
      | 'no_cancel_status' | 'has_children' | 'stale',
    message: string,
  ) {
    super(message);
    this.name = 'BacklogError';
  }
}

// ─── The change list ─────────────────────────────────────────────────────────

function storePath(contextRoot: string): string {
  return safeResolveInside(contextRoot, BACKLOG_MIGRATION_REL_PATH);
}

function isStore(v: unknown): v is BacklogMigrationStore {
  const s = v as Record<string, unknown> | null;
  return !!s && s.version === 1 && typeof s.tasks === 'object' && s.tasks !== null && !Array.isArray(s.tasks)
    && Array.isArray(s.retiredReleases) && Array.isArray(s.createdParents);
}

/**
 * The change list, or null when the migration never took stock here. A file
 * that exists but cannot be read throws {@link BacklogError} `corrupt`: a write
 * must never replace a change list it could not read (it is the undo record).
 */
export function readBacklogStore(contextRoot: string): BacklogMigrationStore | null {
  const path = storePath(contextRoot);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new BacklogError('corrupt', `${BACKLOG_MIGRATION_REL_PATH} is not valid JSON; fix or restore it before deciding anything.`);
  }
  if (!isStore(parsed)) {
    throw new BacklogError('corrupt', `${BACKLOG_MIGRATION_REL_PATH} has an unknown shape; fix or restore it before deciding anything.`);
  }
  return parsed;
}

function writeStore(contextRoot: string, store: BacklogMigrationStore): void {
  const path = storePath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/** Read-modify-write the change list under its lock. */
function mutateStore<T>(contextRoot: string, fn: (store: BacklogMigrationStore) => T): T {
  return withTaskFileLock(contextRoot, LOCK_KEY, () => {
    const store = readBacklogStore(contextRoot);
    if (!store) throw new BacklogError('no_store', 'The 0.33.0 task migration has not taken stock in this brain, so there is nothing to decide.');
    const out = fn(store);
    writeStore(contextRoot, store);
    return out;
  });
}

// ─── Counting ────────────────────────────────────────────────────────────────

/**
 * Open / top-level / parent counts over a family. A top-level item is what the
 * board shows on its own: an open task with no parent, or the parent of an open
 * sub-task (counted once, even when the parent itself is closed).
 */
export function countBacklog(
  family: Family,
  defs: readonly StatusDef[],
  featureOf?: (slug: string) => string | null,
): BacklogCounts {
  const roots = new Set<string>();
  const parents = new Set<string>();
  let open = 0;
  for (const b of family.bySlug.values()) {
    if (isTerminal(defs, b.status)) continue;
    open++;
    const parent = family.parentOf.get(b.slug);
    if (parent) {
      roots.add(parent);
      parents.add(parent);
    } else {
      roots.add(b.slug);
    }
  }
  const counts: BacklogCounts = { open, topLevel: roots.size, parents: parents.size };
  if (featureOf) {
    const features = new Set<string>();
    let unlinked = 0;
    for (const r of roots) {
      const f = featureOf(r);
      if (f) features.add(f);
      else unlinked++;
    }
    counts.byFeature = { groups: features.size + unlinked, features: features.size, unlinked };
  }
  return counts;
}

/** A `related_feature` value as written (a slug, null, '' or the string 'null'). */
function featureValue(v: unknown): string | null {
  return typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : null;
}

function taskFeature(contextRoot: string, slug: string): string | null {
  return featureValue(taskFeatureOf(contextRoot, slug));
}

// ─── The code step ───────────────────────────────────────────────────────────

export interface BacklogStepReport {
  /** True when the step wrote nothing (already migrated, or nothing to migrate). */
  detected: boolean;
  retiredReleases: string[];
  activeVersionRemoved: boolean;
  placed: { next: number; later: number };
  parentIdsNormalised: number;
  familyLinks: Array<{ child: string; parent: string }>;
  tookStock: number;
  filesTouched: string[];
  failed: Array<{ slug: string; reason: string }>;
  notes: string[];
}

function normVersion(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).trim().replace(/^["']|["']$/g, '').replace(/^v(?=\d)/i, '').toLowerCase();
}

function cardFile(contextRoot: string, slug: string): string {
  return safeResolveInside(contextRoot, `state/${slug}.md`);
}

interface CardWrite {
  slug: string;
  fields: Record<string, unknown>;
  /** Re-checked inside the card lock: false = someone got there first, skip. */
  still: (data: Record<string, unknown>) => boolean;
  journal?: { kind: 'log' | 'status'; label?: string; body: string };
}

function readActiveVersion(contextRoot: string): { raw: string; version: string } | null {
  const path = safeResolveInside(contextRoot, ACTIVE_VERSION_REL_PATH);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  let version = '';
  try {
    const parsed = JSON.parse(raw) as { active_planning_version?: unknown };
    version = normVersion(parsed?.active_planning_version);
  } catch { /* unreadable: still retired verbatim */ }
  return { raw, version };
}

/**
 * The deterministic half. Idempotent on the filesystem: a card that already
 * has a place, a planning entry already gone, a link already made are each
 * left alone, so a second run writes nothing.
 */
export function runBacklogStep(contextRoot: string, opts: { now?: Date } = {}): BacklogStepReport {
  const report: BacklogStepReport = {
    detected: true, retiredReleases: [], activeVersionRemoved: false, placed: { next: 0, later: 0 },
    parentIdsNormalised: 0, familyLinks: [], tookStock: 0, filesTouched: [], failed: [], notes: [],
  };
  const at = (opts.now ?? new Date()).toISOString();
  const stateDir = join(contextRoot, 'state');
  const defs = loadStatuses(contextRoot);
  const briefs = loadTaskBriefs(stateDir).filter((b) => isSafeTaskSlug(b.slug));
  const family = buildFamily(briefs);
  const open = briefs.filter((b) => !isTerminal(defs, b.status));

  // Planning entries (read only for now: the change list records them first).
  const releasesPath = join(contextRoot, RELEASES_REL_PATH);
  let releases: Array<Record<string, unknown>> | null = null;
  if (existsSync(releasesPath)) {
    try {
      releases = readJsonArray<Record<string, unknown>>(releasesPath);
    } catch {
      report.notes.push(`${RELEASES_REL_PATH} is unreadable; its planning entries were left in place`);
    }
  }
  const planning = (releases ?? []).filter((r) => r && typeof r === 'object' && r.status === 'planning');
  const active = readActiveVersion(contextRoot);

  let store: BacklogMigrationStore | null;
  try {
    store = readBacklogStore(contextRoot);
  } catch (err) {
    // The undo record is unreadable: write nothing (never replace it), say so.
    report.notes.push((err as Error).message);
    return report;
  }

  if (!store && open.length === 0 && planning.length === 0 && !active) return report;

  const raws = new Map<string, Record<string, unknown>>();
  const rawOf = (slug: string): Record<string, unknown> => {
    let d = raws.get(slug);
    if (!d) {
      try { d = readFrontmatter<Record<string, unknown>>(cardFile(contextRoot, slug)).data; } catch { d = {}; }
      raws.set(slug, d);
    }
    return d;
  };

  if (!store) {
    store = {
      version: 1,
      startedAt: at,
      before: countBacklog(family, defs, (slug) => featureValue(rawOf(slug).related_feature)),
      retiredReleases: [],
      retiredActiveVersion: null,
      createdParents: [],
      tasks: {},
    };
    for (const b of open) {
      store.tasks[b.slug] = { slug: b.slug, name: b.name, status: b.status, outcome: null, by: null, changes: [] };
    }
    report.tookStock = open.length;
  }

  // ── 1. Retire planning: change list first, then RELEASES.json, then the file.
  const kept = new Set(store.retiredReleases.map((r) => JSON.stringify(r)));
  for (const p of planning) {
    if (!kept.has(JSON.stringify(p))) store.retiredReleases.push(p);
    report.retiredReleases.push(String(p.version ?? p.id ?? '?'));
  }
  if (active && store.retiredActiveVersion === null) store.retiredActiveVersion = active.raw;

  // ── 2. Card changes, planned in full before any card is written.
  const writes: CardWrite[] = [];
  const recordFor = (slug: string): BacklogTaskRecord | undefined => store!.tasks[slug];

  // 2a. Legacy parent ids → slugs (buildFamily already resolves them).
  for (const b of open) {
    const resolved = family.parentOf.get(b.slug);
    if (resolved && b.parent && b.parent !== resolved) {
      writes.push({
        slug: b.slug,
        fields: { parent_task: resolved },
        still: (d) => normalizeParentRef(d.parent_task) === b.parent,
      });
      report.parentIdsNormalised++;
    }
  }

  // 2b. A place for every open card the migration took stock of.
  const activeVersion = active?.version ?? '';
  const unplaced = open.filter((b) => recordFor(b.slug) && !hasPlacement(b));
  const sortKey = (b: TaskBrief): [number, number, number, string, string] => {
    const d = rawOf(b.slug);
    const inActive = activeVersion && normVersion(d.version) === activeVersion ? 0 : 1;
    const kind = statusKind(defs, b.status);
    const flight = kind === 'active' ? 0 : kind === 'review' ? 1 : 2;
    const p = LEGACY_PRIORITY.indexOf(String(d.priority ?? '').toLowerCase());
    return [inActive, flight, p === -1 ? LEGACY_PRIORITY.length : p, String(d.created_at ?? ''), b.slug];
  };
  const cmp = (a: TaskBrief, b: TaskBrief): number => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  };
  const nextRank: Record<Queue, number> = { next: 0, later: 0 };
  for (const b of briefs) {
    if (b.rank === null || cycleOfCard(b)) continue;
    const q: Queue = b.queue === 'later' ? 'later' : 'next';
    if (hasPlacement(b) && b.rank > nextRank[q]) nextRank[q] = b.rank;
  }
  for (const b of [...unplaced].sort(cmp)) {
    const queue: Queue = normVersion(rawOf(b.slug).version) === 'backlog' ? 'later' : 'next';
    nextRank[queue] += RANK_STEP;
    // A legacy rank meant nothing on the new axis: every unplaced card is ranked afresh.
    const fields: Record<string, unknown> = { queue, rank: nextRank[queue] };
    writes.push({ slug: b.slug, fields, still: (d) => !hasPlacement({ cycle: d.cycle as string, queue: d.queue as string }) });
    report.placed[queue]++;
  }

  // 2c. Exact families: `<x>-step-<n>` under the one open `<x>-epic…` card.
  const linkedParents = new Set<string>();
  for (const b of open) {
    const m = /^(.+?)-step-\d+(?:-|$)/.exec(b.slug);
    if (!m || !recordFor(b.slug) || family.parentOf.has(b.slug)) continue;
    const stem = m[1];
    const epics = open.filter((e) => (e.slug === `${stem}-epic` || e.slug.startsWith(`${stem}-epic-`)) && !family.parentOf.has(e.slug));
    if (epics.length !== 1) continue;
    const check = checkParentLink(family, defs, b.slug, epics[0].slug);
    if (!check.ok) continue;
    writes.push({
      slug: b.slug,
      fields: { parent_task: check.parent },
      still: (d) => normalizeParentRef(d.parent_task) === null,
      journal: { kind: 'log', body: `- placed under ${check.parent} (exact family match, task migration ${BACKLOG_MIGRATION_VERSION})` },
    });
    report.familyLinks.push({ child: b.slug, parent: check.parent });
    linkedParents.add(check.parent);
  }

  // Record every planned change before writing, so the undo record is never behind.
  const changeOf = (w: CardWrite): FieldChange[] => Object.entries(w.fields).map(([field, after]) => ({
    field, before: rawOf(w.slug)[field] ?? null, after, at, by: 'code' as const,
  }));
  for (const w of writes) recordFor(w.slug)?.changes.push(...changeOf(w));
  for (const { child, parent } of report.familyLinks) {
    for (const slug of [child, parent]) {
      const rec = recordFor(slug);
      if (rec && rec.outcome === null) {
        rec.outcome = 'keep';
        rec.by = 'code';
        rec.reason = slug === child ? `exact family: a step of ${parent}` : 'exact family: holds its steps';
        rec.decidedAt = at;
      }
    }
  }

  const somethingToWrite = writes.length > 0 || planning.length > 0 || (active !== null) || report.tookStock > 0;
  if (!somethingToWrite) return report;

  try {
    withTaskFileLock(contextRoot, LOCK_KEY, () => writeStore(contextRoot, store!));
  } catch (err) {
    if (err instanceof TaskFileBusyError) report.failed.push({ slug: LOCK_KEY, reason: 'the change list is locked' });
    else report.notes.push(`the change list could not be written (${(err as Error).message}); nothing was changed`);
    return report;
  }
  report.detected = false;
  report.filesTouched.push(storePath(contextRoot));

  if (planning.length > 0 && releases) {
    const remaining = releases.filter((r) => !(r && typeof r === 'object' && r.status === 'planning'));
    const tmp = `${releasesPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(remaining, null, 2) + '\n', 'utf-8');
    renameSync(tmp, releasesPath);
    report.filesTouched.push(releasesPath);
  }
  if (active) {
    const path = safeResolveInside(contextRoot, ACTIVE_VERSION_REL_PATH);
    try {
      unlinkSync(path);
      report.activeVersionRemoved = true;
      report.filesTouched.push(path);
    } catch (err) {
      report.notes.push(`${ACTIVE_VERSION_REL_PATH} could not be removed (${(err as Error).message})`);
    }
  }

  // ── 3. Card writes, each under its own lock and re-checked there.
  const skipped = new Set<CardWrite>();
  for (const w of writes) {
    try {
      const path = cardFile(contextRoot, w.slug);
      const wrote = withTaskFileLock(contextRoot, w.slug, () => {
        const { data } = readFrontmatter<Record<string, unknown>>(path);
        if (!w.still(data)) return false;
        updateFrontmatterFields(path, w.fields);
        return true;
      });
      if (!wrote) {
        skipped.add(w);
        continue;
      }
      if (w.journal) appendJournalEntry(stateDir, w.slug, w.journal);
      if (!report.filesTouched.includes(path)) report.filesTouched.push(path);
    } catch (err) {
      skipped.add(w);
      // A lock held by a live writer is the one retryable failure (the version
      // stays pinned and the next run retries); a card that cannot be read or
      // written safely (a symlink, broken YAML) is left for the agent task.
      if (err instanceof TaskFileBusyError) report.failed.push({ slug: w.slug, reason: 'the card is locked' });
      else report.notes.push(`left ${w.slug} as it is (${(err as Error).message})`);
    }
  }

  // ── 4. A parent that gained children: its status and place come from them.
  if (linkedParents.size > 0) {
    const fresh = loadFamily(stateDir);
    const cycles = readCycles(contextRoot).cycles;
    for (const parent of linkedParents) {
      const p = fresh.bySlug.get(parent);
      if (!p) continue;
      try {
        const path = cardFile(contextRoot, parent);
        withTaskFileLock(contextRoot, parent, () => {
          const { data, content } = readFrontmatter<Record<string, unknown>>(path);
          const fields: Record<string, unknown> = {};
          const kids = fresh.children.get(parent) ?? [];
          const next = rolledUpStatus(defs, String(data.status ?? ''), content, kids);
          if (next) {
            const now = today();
            const dates = dateUpdatesForStatus(next, {
              start_date: (data.start_date as string | null) ?? null,
              due_date: (data.due_date as string | null) ?? null,
            }, now, defs);
            Object.assign(fields, { status: next, updated_at: now, ...dates });
          }
          const derived = derivedParentPlacement(liveChildren(fresh, defs, parent), cycles);
          if (derived && ((data.cycle ?? null) !== derived.cycle || (data.queue ?? null) !== derived.queue)) {
            Object.assign(fields, { cycle: derived.cycle, queue: derived.queue });
          }
          if (Object.keys(fields).length === 0) return;
          const rec = recordFor(parent);
          rec?.changes.push(...Object.entries(fields).map(([field, after]) => ({ field, before: data[field] ?? null, after, at, by: 'code' as const })));
          updateFrontmatterFields(path, fields);
          if (next) {
            appendJournalEntry(stateDir, parent, {
              kind: 'status', label: `Status → ${next}`, body: `- computed from its sub-tasks (was ${String(data.status ?? '')})`,
            });
          }
        });
        if (!report.filesTouched.includes(path)) report.filesTouched.push(path);
      } catch (err) {
        if (err instanceof TaskFileBusyError) report.failed.push({ slug: parent, reason: 'the card is locked' });
        else report.notes.push(`left ${parent}'s status as it is (${(err as Error).message})`);
      }
    }
  }

  // A change that did not land leaves the undo record (it never happened).
  if (skipped.size > 0 || linkedParents.size > 0) {
    const undone = new Map<string, Set<string>>();
    for (const w of skipped) {
      const set = undone.get(w.slug) ?? new Set<string>();
      for (const f of Object.keys(w.fields)) set.add(f);
      undone.set(w.slug, set);
    }
    try {
      mutateStore(contextRoot, (s) => {
        for (const [slug, fields] of undone) {
          const rec = s.tasks[slug];
          if (!rec) continue;
          rec.changes = rec.changes.filter((c) => !(c.at === at && c.by === 'code' && fields.has(c.field)));
          const link = report.familyLinks.find((l) => l.child === slug);
          if (link && fields.has('parent_task') && rec.by === 'code' && rec.decidedAt === at) {
            rec.outcome = null;
            rec.by = null;
            delete rec.reason;
            delete rec.decidedAt;
          }
        }
        // Parent status/placement changes were recorded on the in-memory copy.
        for (const parent of linkedParents) {
          const mine = store!.tasks[parent];
          if (mine && s.tasks[parent]) s.tasks[parent].changes = mine.changes;
        }
      });
    } catch (err) {
      if (err instanceof TaskFileBusyError) report.failed.push({ slug: LOCK_KEY, reason: 'the change list is locked' });
      else report.notes.push(`the change list could not be updated (${(err as Error).message})`);
    }
    for (const w of skipped) {
      const q = w.fields.queue as Queue | undefined;
      if (q) report.placed[q]--;
      report.familyLinks = report.familyLinks.filter((l) => !(l.child === w.slug && 'parent_task' in w.fields));
    }
  }
  return report;
}

/** The step's one-paragraph summary (ledger, CHANGELOG, `update` output). */
export function summarizeBacklogStep(r: BacklogStepReport): string {
  const parts: string[] = [];
  if (r.tookStock > 0) parts.push(`took stock of ${r.tookStock} open task(s)`);
  if (r.retiredReleases.length > 0) parts.push(`retired planning entr${r.retiredReleases.length === 1 ? 'y' : 'ies'} ${r.retiredReleases.join(', ')}`);
  if (r.activeVersionRemoved) parts.push('removed state/.active-version.json');
  if (r.placed.next + r.placed.later > 0) parts.push(`placed ${r.placed.next} in Next and ${r.placed.later} in Later`);
  if (r.parentIdsNormalised > 0) parts.push(`turned ${r.parentIdsNormalised} parent id(s) into slugs`);
  if (r.familyLinks.length > 0) parts.push(`put ${r.familyLinks.length} step(s) under their epic`);
  if (r.failed.length > 0) parts.push(`${r.failed.length} could not be written yet (${r.failed.map((f) => f.slug).join(', ')})`);
  parts.push(...r.notes);
  if (parts.length === 0) return 'No open tasks or planning versions to migrate';
  return `${parts.join('; ')}. The rest is the agent task ${BACKLOG_AGENT_TASK_ID} (dreamcontext migrations backlog show).`;
}

// ─── What still waits ────────────────────────────────────────────────────────

function cardFields(contextRoot: string, slug: string): Record<string, unknown> | null {
  if (!isSafeTaskSlug(slug)) return null;
  try {
    const path = cardFile(contextRoot, slug);
    if (!existsSync(path)) return null;
    return readFrontmatter<Record<string, unknown>>(path).data;
  } catch {
    return null;
  }
}

function cardStatus(contextRoot: string, slug: string): string | null {
  const data = cardFields(contextRoot, slug);
  return data ? String(data.status ?? '') : null;
}

/**
 * An interrupted merge or cancel whose card already shows exactly what it
 * intended (cancelled, and absorbed by the intended task for a merge): only the
 * outcome is left to record.
 */
function intentLanded(defs: readonly StatusDef[], intent: NonNullable<BacklogTaskRecord['intent']>, card: Record<string, unknown>): boolean {
  if (statusKind(defs, String(card.status ?? '')) !== 'cancelled') return false;
  return intent.outcome === 'cancel' || (card.absorbed_by ?? null) === intent.into;
}

/** Records still waiting for a decision whose task is still open. */
export function pendingRecords(contextRoot: string, store: BacklogMigrationStore, defs = loadStatuses(contextRoot)): BacklogTaskRecord[] {
  return Object.values(store.tasks).filter((r) => {
    if (r.outcome !== null) return false;
    // A merge or cancel interrupted after its card was written still waits to be
    // finished, but only while its card exists and shows that (a card closed some
    // other way, or gone, waits for nothing: it is "closed meanwhile").
    if (r.intent) {
      const card = cardFields(contextRoot, r.slug);
      if (card && intentLanded(defs, r.intent, card)) return true;
    }
    const st = cardStatus(contextRoot, r.slug);
    return st !== null && !isTerminal(defs, st);
  });
}

/**
 * Does the agent task still have work? False on a brain the migration never
 * took stock of (fresh, or nothing open) and once every record has an outcome,
 * so `migrations pending` stays silent there. An unreadable change list is
 * TRUE: the agent is the one who can report it.
 */
export function backlogDecisionsPending(contextRoot: string): boolean {
  let store: BacklogMigrationStore | null;
  try {
    store = readBacklogStore(contextRoot);
  } catch {
    return true;
  }
  if (!store) return false;
  return pendingRecords(contextRoot, store).length > 0;
}

// ─── Decisions ───────────────────────────────────────────────────────────────

export interface DecideInput {
  outcome: BacklogOutcome;
  by: Exclude<DecidedBy, 'code'>;
  /** keep: put it under this parent. */
  parent?: string;
  /** keep: move it between the queues (only outside a cycle). */
  queue?: Queue;
  /** merge: the task that absorbs it. */
  into?: string;
  /** keep: the feature (area) its family belongs to; a parent passes it on to its open sub-tasks. */
  feature?: string;
  reason?: string;
}

function requireRecord(store: BacklogMigrationStore, slug: string): BacklogTaskRecord {
  const rec = store.tasks[slug];
  if (!rec) throw new BacklogError('not_found', `"${slug}" was not open when the migration took stock (see: dreamcontext migrations backlog show).`);
  return rec;
}

function cancelKeyOf(defs: readonly StatusDef[]): string {
  const key = defs.find((d) => d.kind === 'cancelled')?.key ?? null;
  if (!key) {
    throw new BacklogError('no_cancel_status',
      'This project declares no cancelled-kind status (overrides/task.md), so nothing can be merged or cancelled. Keep it instead, or declare one.');
  }
  return key;
}

/**
 * Record one task's outcome and apply it. The only writer of outcomes: the
 * agent half calls it through `migrations backlog decide`, the owner through
 * the same command or the Tasks screen's proposals.
 */
export async function decideTask(
  contextRoot: string,
  backend: TaskBackend,
  slug: string,
  input: DecideInput,
  opts: { applying?: string } = {},
): Promise<BacklogTaskRecord> {
  const at = new Date().toISOString();
  const defs = loadStatuses(contextRoot);
  const stateDir = join(contextRoot, 'state');
  const store = readBacklogStore(contextRoot);
  if (!store) throw new BacklogError('no_store', 'The 0.33.0 task migration has not taken stock in this brain, so there is nothing to decide.');
  const rec = requireRecord(store, slug);
  if (rec.by === 'owner' && input.by !== 'owner') {
    throw new BacklogError('decided', `The owner already decided "${slug}" (${rec.outcome}); an agent does not overrule that.`);
  }
  const task = await backend.get(slug);
  if (!task) throw new BacklogError('not_found', `Task not found: ${slug}`);
  // An interrupted merge or cancel whose card already landed: the same decision finishes it.
  const landed = !!rec.intent && intentLanded(defs, rec.intent, task.raw);
  const resuming = landed && rec.intent!.outcome === input.outcome
    && (input.outcome !== 'merge' || rec.intent!.into === input.into?.trim());
  if (isTerminal(defs, task.status) && !resuming && !(rec.outcome === input.outcome && input.outcome !== 'keep')) {
    const finish = landed
      ? ` It is an interrupted ${rec.intent!.outcome}; finish it with: dreamcontext migrations backlog decide ${slug} ${rec.intent!.outcome}${rec.intent!.into ? ` --into ${rec.intent!.into}` : ''} --reason "…".`
      : '';
    throw new BacklogError('not_open', `"${slug}" is ${task.status}; only an open task gets an outcome.${finish}`);
  }
  // Every change below is written ahead onto the record before its card is
  // touched (writeAhead), so the undo record is never behind what landed.
  const changes: FieldChange[] = [];
  const by = input.by;
  const note = input.reason?.trim() ? `: ${input.reason.trim()}` : '';

  if (input.outcome === 'merge' || input.outcome === 'cancel') {
    if (input.parent || input.queue || input.feature) throw new BacklogError('invalid', '--parent, --queue and --feature go with keep.');
    if (liveChildren(loadFamily(stateDir), defs, slug).length > 0) {
      throw new BacklogError('has_children', `"${slug}" still has open sub-tasks; decide each of them first (keep them under another parent, merge or cancel them).`);
    }
    const cancelKey = cancelKeyOf(defs);
    let into: string | undefined;
    if (input.outcome === 'merge') {
      into = input.into?.trim();
      if (!into || !isSafeTaskSlug(into)) throw new BacklogError('invalid', 'merge needs --into <task slug>.');
      if (into === slug) throw new BacklogError('invalid', 'A task cannot absorb itself.');
      // A merge that already landed is only recorded: its target may have closed since.
      if (!resuming) {
        const target = await backend.get(into);
        if (!target) throw new BacklogError('not_found', `--into: no task "${into}".`);
        if (isTerminal(defs, target.status)) throw new BacklogError('not_open', `--into: "${into}" is ${target.status}; merge into an open task.`);
        if ((target.parent_task ?? null) === slug) throw new BacklogError('invalid', `"${into}" is a sub-task of "${slug}"; it cannot absorb its own parent.`);
      }
    } else if (input.into) {
      throw new BacklogError('invalid', '--into goes with merge.');
    }
    if (!isTerminal(defs, task.status)) {
      const fields: Record<string, unknown> = { status: cancelKey, updated_at: today() };
      if (into) fields.absorbed_by = into;
      for (const [field, after] of Object.entries(fields)) {
        if (field !== 'updated_at') changes.push({ field, before: task.raw[field] ?? null, after, at, by });
      }
      writeAhead(contextRoot, slug, changes, { outcome: input.outcome, ...(into ? { into } : {}), at });
      await backend.addJournal(slug, {
        kind: 'status',
        label: cancelKey,
        body: into ? `- merged into ${into}${note} (task migration ${BACKLOG_MIGRATION_VERSION})` : `- cancelled${note} (task migration ${BACKLOG_MIGRATION_VERSION})`,
      });
      await backend.updateFields(slug, fields);
      if (into) await backend.addJournal(into, { kind: 'log', body: `- absorbed ${slug} (${task.name})` });
    }
    return recordOutcome(contextRoot, slug, { outcome: input.outcome, by, at, changes: [], into, reason: input.reason, applying: opts.applying });
  }

  // keep
  if (input.into) throw new BacklogError('invalid', '--into goes with merge.');
  // Resolved before anything is written, so a wrong feature changes nothing.
  const feature = input.feature?.trim() ? resolveFeature(contextRoot, input.feature.trim()) : null;
  if (feature && !feature.ok) {
    const hint = feature.reason === 'ambiguous' ? ` It matches ${feature.candidates.join(', ')}; name one.` : ' (the areas: dreamcontext migrations backlog show --pending)';
    throw new BacklogError('invalid', `--feature: no single feature "${input.feature}".${hint}`);
  }
  if (feature?.ok) checkFeatureLink(contextRoot, slug, feature.slug, by, input.parent?.trim() || null);
  if (input.parent) {
    const parent = input.parent.trim();
    if (!isSafeTaskSlug(parent)) throw new BacklogError('invalid', `Invalid parent: "${parent}".`);
    const check = checkParentLink(loadFamily(stateDir), defs, slug, parent);
    if (!check.ok) throw new BacklogError('invalid', check.reason);
    const was = task.parent_task ?? null;
    if (was !== check.parent) {
      // What linking will write: the parent, and its feature when the task has none.
      const planned: FieldChange[] = [{ field: 'parent_task', before: was, after: check.parent, at, by }];
      const featureBefore = taskFeature(contextRoot, slug);
      const parentFeature = taskFeature(contextRoot, check.parent);
      if (!featureBefore && parentFeature) planned.push({ field: 'related_feature', before: null, after: parentFeature, at, by });
      writeAhead(contextRoot, slug, planned);
    }
    const linked = await linkTaskToParent(contextRoot, backend, slug, parent);
    if (!linked.ok) throw new BacklogError('invalid', linked.reason);
    if (!linked.already) {
      // A parent created outside the migration still gets a record, so the
      // report and the undo list see it.
      if (!store.tasks[linked.parent]) {
        mutateStore(contextRoot, (s) => {
          if (!s.tasks[linked.parent]) {
            s.tasks[linked.parent] = {
              slug: linked.parent, name: linked.parent, status: 'todo', outcome: 'keep', by, reason: 'holds a family', decidedAt: at, changes: [],
            };
          }
        });
      }
    }
    // Also on a retry: an interrupted run may have linked the task but not moved its parent.
    await syncParentPlace(contextRoot, backend, linked.parent, at, by);
  }
  if (input.queue) {
    const fresh = await backend.get(slug);
    if (fresh && cycleOfCard({ cycle: fresh.raw.cycle as string }) ) {
      throw new BacklogError('invalid', `"${slug}" is in a cycle; move it with dreamcontext tasks plan, not here.`);
    }
    const before = (fresh?.raw.queue as string | undefined) ?? null;
    if (before !== input.queue) {
      writeAhead(contextRoot, slug, [{ field: 'queue', before, after: input.queue, at, by }]);
      await backend.updateFields(slug, { queue: input.queue, updated_at: today() });
      const parentOf = fresh?.parent_task;
      if (parentOf) await syncParentPlace(contextRoot, backend, parentOf, at, by);
    }
  }
  if (feature?.ok) linkFeature(contextRoot, slug, feature.slug, at, by);
  return recordOutcome(contextRoot, slug, { outcome: 'keep', by, at, changes, reason: input.reason, applying: opts.applying });
}

/**
 * Write-ahead: put the changes a decision is about to make on the record BEFORE
 * the card is written, so the undo record is never behind what landed (a change
 * that then fails to land only over-states the record; undoing it is a no-op).
 * A retry that plans the same change again does not add it twice. Throws when
 * the change list cannot be written: then nothing is written to the card either.
 */
function writeAhead(contextRoot: string, slug: string, planned: FieldChange[], intent?: BacklogTaskRecord['intent']): void {
  if (planned.length === 0 && !intent) return;
  mutateStore(contextRoot, (s) => {
    const rec = s.tasks[slug];
    if (!rec) return;
    for (const c of planned) {
      const last = [...rec.changes].reverse().find((x) => x.field === c.field);
      const same = last && JSON.stringify(last.before) === JSON.stringify(c.before) && JSON.stringify(last.after) === JSON.stringify(c.after);
      if (!same) rec.changes.push(c);
    }
    if (intent) rec.intent = intent;
  });
}

/**
 * May this task be linked to this feature? A sub-task takes its parent's
 * feature (the binding model), so the feature goes on the parent; and an agent
 * never moves a task off a feature it already has — that is a proposal for the
 * owner. `parent` is the parent this same decision puts it under, if any.
 */
function checkFeatureLink(contextRoot: string, slug: string, feature: string, by: DecidedBy, parent: string | null): void {
  const under = parent ?? loadFamily(join(contextRoot, 'state')).parentOf.get(slug) ?? null;
  if (under) {
    const pf = taskFeature(contextRoot, under);
    if (pf !== feature) {
      throw new BacklogError('invalid',
        `"${slug}" is a sub-task of ${under}, and a sub-task takes its parent's feature: decide ${under} with --feature ${feature} instead${pf ? ` (it has ${pf})` : ''}.`);
    }
  }
  const had = taskFeature(contextRoot, slug);
  if (had && had !== feature && by !== 'owner') {
    throw new BacklogError('invalid',
      `"${slug}" already belongs to the feature ${had}; an agent does not move it. Sure it is wrong? Propose it: dreamcontext migrations backlog propose ${slug} feature --feature ${feature} --why "…".`);
  }
}

/**
 * Link a kept task to its feature (both sides stay in sync), then pass the
 * feature on to its open sub-tasks that have none. Returns this task's change;
 * a sub-task's change goes on its own record.
 */
function linkFeature(contextRoot: string, slug: string, feature: string, at: string, by: DecidedBy): void {
  const had = taskFeature(contextRoot, slug);
  if (had !== feature) {
    writeAhead(contextRoot, slug, [{ field: 'related_feature', before: had, after: feature, at, by }]);
    withTaskFileLock(contextRoot, slug, () => applyTaskFeatureLink(contextRoot, slug, { slug: feature }));
  }
  const family = loadFamily(join(contextRoot, 'state'));
  for (const kid of liveChildren(family, loadStatuses(contextRoot), slug)) {
    if (taskFeature(contextRoot, kid.slug)) continue;
    writeAhead(contextRoot, kid.slug, [{ field: 'related_feature', before: null, after: feature, at, by }]);
    withTaskFileLock(contextRoot, kid.slug, () => applyTaskFeatureLink(contextRoot, kid.slug, { slug: feature }));
  }
}

/** A parent's place follows its open children (a parent is never planned on its own). */
async function syncParentPlace(contextRoot: string, backend: TaskBackend, parent: string, at: string, by: DecidedBy): Promise<void> {
  const family = loadFamily(join(contextRoot, 'state'));
  const p = family.bySlug.get(parent);
  if (!p) return;
  const derived = derivedParentPlacement(liveChildren(family, loadStatuses(contextRoot), parent), readCycles(contextRoot).cycles);
  if (!derived) return;
  if ((p.cycle ?? null) === derived.cycle && (p.queue ?? null) === derived.queue) return;
  writeAhead(contextRoot, parent, [
    { field: 'cycle', before: p.cycle ?? null, after: derived.cycle, at, by },
    { field: 'queue', before: p.queue ?? null, after: derived.queue, at, by },
  ]);
  await backend.updateFields(parent, { cycle: derived.cycle, queue: derived.queue, updated_at: today() });
}

function recordOutcome(
  contextRoot: string,
  slug: string,
  d: { outcome: BacklogOutcome; by: DecidedBy; at: string; changes: FieldChange[]; into?: string; reason?: string; applying?: string },
): BacklogTaskRecord {
  return mutateStore(contextRoot, (s) => {
    const rec = requireRecord(s, slug);
    rec.outcome = d.outcome;
    rec.by = d.by;
    rec.decidedAt = d.at;
    rec.changes.push(...d.changes);
    delete rec.intent;
    if (d.into) rec.into = d.into; else delete rec.into;
    if (d.reason?.trim()) rec.reason = d.reason.trim(); else delete rec.reason;
    // Applying a suggestion resolves it; any other direct decision replaces an
    // open one (it no longer describes a choice anybody has to make).
    if (rec.suggestion && !rec.suggestion.resolved) {
      if (d.applying && rec.suggestion.id === d.applying) rec.suggestion.resolved = { verdict: 'applied', at: d.at };
      else delete rec.suggestion;
    }
    return { ...rec };
  });
}

// ─── Suggestions: what the agent is not sure about ──────────────────────────

/** A suggestion still waiting for the owner. */
export function isWaitingSuggestion(rec: BacklogTaskRecord): boolean {
  return !!rec.suggestion && !rec.suggestion.resolved;
}

/**
 * Put an uncertain change in front of the owner. The task is kept as it is
 * meanwhile (its outcome is keep, which ends the agent's part for it), and the
 * suggestion is checked now so that applying it later can work.
 */
export async function suggestChange(
  contextRoot: string,
  backend: TaskBackend,
  slug: string,
  input: { change: SuggestedChange; target?: string | null; why: string; by: Exclude<DecidedBy, 'code'> },
): Promise<BacklogTaskRecord> {
  const at = new Date().toISOString();
  const defs = loadStatuses(contextRoot);
  const store = readBacklogStore(contextRoot);
  if (!store) throw new BacklogError('no_store', 'The 0.33.0 task migration has not taken stock in this brain, so there is nothing to suggest.');
  const rec = requireRecord(store, slug);
  if (rec.by === 'owner' && input.by !== 'owner') {
    throw new BacklogError('decided', `The owner already decided "${slug}" (${rec.outcome}); an agent does not overrule that.`);
  }
  if (!SUGGESTED_CHANGES.includes(input.change)) throw new BacklogError('invalid', `A suggestion is one of: ${SUGGESTED_CHANGES.join(', ')}.`);
  const why = input.why.trim();
  if (!why) throw new BacklogError('invalid', 'A suggestion needs --why: what you saw.');
  const task = await backend.get(slug);
  if (!task) throw new BacklogError('not_found', `Task not found: ${slug}`);
  if (isTerminal(defs, task.status)) throw new BacklogError('not_open', `"${slug}" is ${task.status}; only an open task gets a suggestion.`);
  const family = loadFamily(join(contextRoot, 'state'));
  let target = input.target?.trim() || null;

  if (input.change === 'merge' || input.change === 'cancel') {
    cancelKeyOf(defs);
    if (liveChildren(family, defs, slug).length > 0) {
      throw new BacklogError('has_children', `"${slug}" still has open sub-tasks; it cannot be merged or cancelled as a whole.`);
    }
  }
  if (input.change === 'merge') {
    if (!target || !isSafeTaskSlug(target)) throw new BacklogError('invalid', 'A merge suggestion needs --into <task slug>.');
    if (target === slug) throw new BacklogError('invalid', 'A task cannot absorb itself.');
    const t = family.bySlug.get(target);
    if (!t) throw new BacklogError('not_found', `--into: no task "${target}".`);
    if (isTerminal(defs, t.status)) throw new BacklogError('not_open', `--into: "${target}" is ${t.status}.`);
  } else if (input.change === 'parent') {
    if (!target || !isSafeTaskSlug(target)) throw new BacklogError('invalid', 'A parent suggestion needs --parent <task slug>.');
    const check = checkParentLink(family, defs, slug, target);
    if (!check.ok) throw new BacklogError('invalid', check.reason);
  } else if (input.change === 'feature') {
    if (!target) throw new BacklogError('invalid', 'A feature suggestion needs --feature <feature slug>.');
    const f = resolveFeature(contextRoot, target);
    if (!f.ok) throw new BacklogError('invalid', `--feature: no single feature "${target}".`);
    const parent = family.parentOf.get(slug);
    if (parent) throw new BacklogError('invalid', `"${slug}" is a sub-task of ${parent}; it takes its parent's feature, so suggest the feature for ${parent}.`);
    if (taskFeature(contextRoot, slug) === f.slug) throw new BacklogError('invalid', `"${slug}" already belongs to ${f.slug}.`);
    target = f.slug;
  } else if (target) {
    throw new BacklogError('invalid', `A ${input.change} suggestion takes no target.`);
  } else if (input.change === 'later' && cycleOfCard({ cycle: task.raw.cycle as string })) {
    throw new BacklogError('invalid', `"${slug}" is in a cycle; it does not wait in a queue.`);
  }

  return mutateStore(contextRoot, (s) => {
    const live = requireRecord(s, slug);
    if (live.outcome === null) {
      live.outcome = 'keep';
      live.by = input.by;
      live.decidedAt = at;
      live.reason = 'kept as it is until the owner answers the suggestion';
    }
    live.suggestion = { id: generateId('bs'), change: input.change, target, why, by: input.by, proposedAt: at };
    return { ...live };
  });
}

export interface SuggestionRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  change: SuggestedChange;
  target: string | null;
  targetName: string | null;
  why: string;
  by: DecidedBy;
  proposedAt: string;
}

/**
 * The suggestions the Tasks screen shows: waiting, and about a task that is
 * still open (one closed some other way waits for nothing). Never throws: an
 * unreadable change list shows nothing here (the agent task reports it).
 */
export function waitingSuggestions(contextRoot: string): SuggestionRow[] {
  let store: BacklogMigrationStore | null;
  try {
    store = readBacklogStore(contextRoot);
  } catch {
    return [];
  }
  if (!store) return [];
  const defs = loadStatuses(contextRoot);
  const briefs = new Map(loadTaskBriefs(join(contextRoot, 'state')).map((b) => [b.slug, b]));
  const rows: SuggestionRow[] = [];
  for (const rec of Object.values(store.tasks)) {
    if (!isWaitingSuggestion(rec)) continue;
    const b = briefs.get(rec.slug);
    if (!b || isTerminal(defs, b.status)) continue;
    const sug = rec.suggestion!;
    rows.push({
      id: sug.id, slug: rec.slug, name: b.name, status: b.status, change: sug.change, target: sug.target,
      targetName: !sug.target ? null : sug.change === 'feature' ? featureName(contextRoot, sug.target) : briefs.get(sug.target)?.name ?? null,
      why: sug.why, by: sug.by, proposedAt: sug.proposedAt,
    });
  }
  return rows.sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.slug.localeCompare(b.slug));
}

/** A feature's display name (its frontmatter `name:`), or null when it has none or is gone. */
function featureName(contextRoot: string, slug: string): string | null {
  const f = resolveFeature(contextRoot, slug);
  if (!f.ok || f.slug !== slug) return null;
  try {
    const name = readFrontmatter<Record<string, unknown>>(f.path).data.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

function waitingSuggestionFor(contextRoot: string, slug: string, id: string): ChangeSuggestion {
  const store = readBacklogStore(contextRoot);
  if (!store) throw new BacklogError('no_store', 'Nothing to answer: the task migration has no change list here.');
  const rec = requireRecord(store, slug);
  if (!rec.suggestion || rec.suggestion.id !== id) throw new BacklogError('stale', `That suggestion for "${slug}" is no longer the current one.`);
  if (rec.suggestion.resolved) throw new BacklogError('stale', `That suggestion for "${slug}" was already ${rec.suggestion.resolved.verdict}.`);
  return rec.suggestion;
}

/** The owner applies a suggestion: the change goes through the same path as a decision. */
export async function applySuggestion(contextRoot: string, backend: TaskBackend, slug: string, id: string): Promise<BacklogTaskRecord> {
  const sug = waitingSuggestionFor(contextRoot, slug, id);
  const reason = `the owner applied the suggestion: ${sug.why}`;
  const input: DecideInput =
    sug.change === 'merge' ? { outcome: 'merge', into: sug.target ?? undefined, by: 'owner', reason }
    : sug.change === 'cancel' ? { outcome: 'cancel', by: 'owner', reason }
    : sug.change === 'parent' ? { outcome: 'keep', parent: sug.target ?? undefined, by: 'owner', reason }
    : sug.change === 'feature' ? { outcome: 'keep', feature: sug.target ?? undefined, by: 'owner', reason }
    : { outcome: 'keep', queue: 'later', by: 'owner', reason };
  return decideTask(contextRoot, backend, slug, input, { applying: id });
}

/** The owner keeps the task as it is: the suggestion is answered, nothing on the card changes. */
export function keepAsIs(contextRoot: string, slug: string, id: string): BacklogTaskRecord {
  waitingSuggestionFor(contextRoot, slug, id);
  const at = new Date().toISOString();
  return mutateStore(contextRoot, (s) => {
    const rec = requireRecord(s, slug);
    if (!rec.suggestion || rec.suggestion.id !== id || rec.suggestion.resolved) {
      throw new BacklogError('stale', `That suggestion for "${slug}" is no longer the current one.`);
    }
    rec.suggestion.resolved = { verdict: 'kept', at };
    rec.outcome = 'keep';
    rec.by = 'owner';
    rec.decidedAt = at;
    rec.reason = 'the owner kept it as it is';
    return { ...rec };
  });
}

/**
 * Create a parent for a family of open tasks and put them under it. Only for a
 * real deliverable two or more of them serve (a feature is an area, never a
 * parent); the parent's place follows its children. It is born a clean card:
 * a name and a Why within the card standard, and at least one criterion that
 * says when the deliverable is done (its status still rolls up from its
 * children, and it reaches review only once that criterion is proven).
 */
export async function createFamilyParent(
  contextRoot: string,
  backend: TaskBackend,
  input: {
    name: string; why: string; criteria: string[]; description?: string; feature?: string; children: string[];
    by: Exclude<DecidedBy, 'code'>;
  },
): Promise<{ slug: string; linked: string[] }> {
  const at = new Date().toISOString();
  const defs = loadStatuses(contextRoot);
  const store = readBacklogStore(contextRoot);
  if (!store) throw new BacklogError('no_store', 'The 0.33.0 task migration has not taken stock in this brain, so there is nothing to group.');
  const name = input.name.trim();
  const why = input.why.trim();
  if (!name || !why) throw new BacklogError('invalid', 'A parent needs a name and a why.');
  if (name.length > NAME_SOFT_LIMIT) throw new BacklogError('invalid', `The name is ${name.length} chars; a parent's name is ${NAME_SOFT_LIMIT} at most (a name, not a summary).`);
  if (why.length > WHY_SOFT_LIMIT) throw new BacklogError('invalid', `The why is ${why.length} chars; ${WHY_SOFT_LIMIT} at most (two or three sentences).`);
  const criteria = input.criteria.map((c) => c.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (criteria.length === 0) throw new BacklogError('invalid', 'A parent needs --criterion: what is observable when the deliverable is done.');
  const children = [...new Set(input.children.map((c) => c.trim()).filter(Boolean))];
  if (children.length < 2) throw new BacklogError('invalid', 'A parent holds two or more tasks; a single task stays top-level.');
  const family = loadFamily(join(contextRoot, 'state'));
  for (const c of children) {
    if (!isSafeTaskSlug(c)) throw new BacklogError('invalid', `Invalid task: "${c}".`);
    const rec = requireRecord(store, c);
    if (rec.by === 'owner') throw new BacklogError('decided', `The owner already decided "${c}".`);
    const b = family.bySlug.get(c);
    if (!b) throw new BacklogError('not_found', `Task not found: ${c}`);
    if (isTerminal(defs, b.status)) throw new BacklogError('not_open', `"${c}" is ${b.status}.`);
    if ((family.children.get(c) ?? []).length > 0) throw new BacklogError('invalid', `"${c}" has sub-tasks of its own, so it is a parent; two levels only.`);
  }
  const feature = input.feature?.trim() ? resolveFeature(contextRoot, input.feature.trim()) : null;
  if (feature && !feature.ok) throw new BacklogError('invalid', `--feature: no feature "${input.feature}".`);
  const created = await backend.create({ name, why, description: input.description?.trim() || name, variant: 'cli' });
  for (const c of criteria) {
    const prep = prepareSectionInsert('acceptance_criteria', c, today())!;
    await backend.insertSection(created.slug, prep.sectionName, prep.content, { position: prep.position, replacePlaceholders: prep.replacePlaceholders });
  }
  if (feature?.ok) applyTaskFeatureLink(contextRoot, created.slug, { slug: feature.slug });
  mutateStore(contextRoot, (s) => {
    if (!s.createdParents.includes(created.slug)) s.createdParents.push(created.slug);
    s.tasks[created.slug] = {
      slug: created.slug, name, status: created.status, outcome: 'keep', by: input.by, created: true,
      reason: why, decidedAt: at, changes: [{ field: 'created', before: null, after: created.slug, at, by: input.by }],
    };
  });
  const linked: string[] = [];
  for (const c of children) {
    await decideTask(contextRoot, backend, c, { outcome: 'keep', by: input.by, parent: created.slug, reason: `a step of ${created.slug}` });
    linked.push(c);
  }
  return { slug: created.slug, linked };
}

// ─── The report ──────────────────────────────────────────────────────────────

export interface BacklogReport {
  started: boolean;
  startedAt: string | null;
  before: BacklogCounts | null;
  now: BacklogCounts;
  outcomes: { keep: number; merge: number; cancel: number; pending: number; closedMeanwhile: number };
  by: { code: number; agent: number; owner: number };
  proposalsWaiting: number;
  placement: { now: number; next: number; later: number };
  retiredReleases: string[];
  activeVersionRemoved: boolean;
  createdParents: string[];
}

export function backlogReport(contextRoot: string): BacklogReport {
  const defs = loadStatuses(contextRoot);
  const stateDir = join(contextRoot, 'state');
  const family = loadFamily(stateDir);
  const store = readBacklogStore(contextRoot);
  const cycles = readCycles(contextRoot).cycles;
  const activeId = cycles.find((c) => c.status === 'active')?.id ?? null;
  const placement = { now: 0, next: 0, later: 0 };
  for (const b of family.bySlug.values()) {
    // Leaves and standalone tasks only: a parent's place is derived from its children.
    if (isTerminal(defs, b.status) || liveChildren(family, defs, b.slug).length > 0) continue;
    const c = cycleOfCard(b);
    if (c) placement[c === activeId ? 'now' : 'next']++;
    else placement[b.queue === 'later' ? 'later' : 'next']++;
  }
  const outcomes = { keep: 0, merge: 0, cancel: 0, pending: 0, closedMeanwhile: 0 };
  const by = { code: 0, agent: 0, owner: 0 };
  let proposalsWaiting = 0;
  if (store) {
    const pending = new Set(pendingRecords(contextRoot, store, defs).map((r) => r.slug));
    for (const r of Object.values(store.tasks)) {
      if (r.outcome) {
        outcomes[r.outcome]++;
        if (r.by) by[r.by]++;
        if (isWaitingSuggestion(r) && !isTerminal(defs, family.bySlug.get(r.slug)?.status ?? 'completed')) proposalsWaiting++;
      } else if (pending.has(r.slug)) {
        outcomes.pending++;
      } else {
        outcomes.closedMeanwhile++;
      }
    }
  }
  return {
    started: store !== null,
    startedAt: store?.startedAt ?? null,
    before: store?.before ?? null,
    now: countBacklog(family, defs, (slug) => taskFeature(contextRoot, slug)),
    outcomes,
    by,
    proposalsWaiting,
    placement,
    retiredReleases: (store?.retiredReleases ?? []).map((r) => String(r.version ?? r.id ?? '?')),
    activeVersionRemoved: !!store?.retiredActiveVersion,
    createdParents: store?.createdParents ?? [],
  };
}
