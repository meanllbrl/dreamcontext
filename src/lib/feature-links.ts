import { existsSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, updateFrontmatterFields } from './frontmatter.js';
import { featuresDir, featureSlug } from './features-path.js';
import { slugify, today } from './id.js';

/**
 * A task slug is safe when `state/<slug>.md` stays inside `state/` — rejects
 * `..`, absolute paths, and NUL. Inlined copy of task-backend's `isSafeTaskSlug`
 * (keep in sync): a direct import would create a module cycle because
 * `task-backend/local.ts` imports this file's heal helpers. Every read here
 * degrades to a safe default on a hostile slug; every WRITE hard-fails, so a
 * caller that bypasses its own validation can never read or write outside
 * `state/`.
 */
function isSafeTaskSlug(slug: string): boolean {
  if (!slug || slug.includes('\0')) return false;
  const base = resolve(sep, 'dc-slug-check');
  const target = resolve(base, `${slug}.md`);
  return target === join(base, `${slug}.md`) && target.startsWith(base + sep);
}

/**
 * Task ↔ Feature link engine — the single write path for the bidirectional
 * relation between `task.related_feature` (single-valued, task side) and
 * `feature.related_tasks` (list, feature side).
 *
 * Invariants this module enforces:
 * - `related_feature` stores the feature's CANONICAL relative slug (nested
 *   features keep their folder prefix, e.g. `lina/checkout`; flat features
 *   are their basename). Never a fuzzy name.
 * - A task appears in at most ONE feature's `related_tasks` (the relation is
 *   many-tasks-to-one-feature), and that feature is the task's
 *   `related_feature`.
 * - Every write validates the other endpoint exists — ghost slugs are
 *   rejected at write time, and rename/delete heal the feature side.
 *
 * The task side is deliberately written WITHOUT bumping `updated_at`: link
 * bookkeeping must not churn task recency (backfills would otherwise mark
 * every task "updated today"). Call sites that represent a direct user edit
 * (e.g. `tasks feature`) bump the stamp themselves through the task backend.
 */

// ─── Resolution ───────────────────────────────────────────────────────────────

export type FeatureResolution =
  | { ok: true; path: string; slug: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] };

function featureFiles(contextRoot: string): string[] {
  const dir = featuresDir(contextRoot);
  if (!existsSync(dir)) return [];
  return fg.sync('**/*.md', { cwd: dir, absolute: true });
}

/** Whether the project has any feature PRDs at all (drives create-time nudges). */
export function anyFeaturesExist(contextRoot: string): boolean {
  return featureFiles(contextRoot).length > 0;
}

/**
 * Resolve a free-form feature reference to its file + canonical relative slug.
 * A path-like ref ("lina/checkout") matches only on the full relative slug; a
 * bare name matches exact basename, then basename prefix, then substring —
 * erroring as ambiguous instead of guessing across folders.
 */
export function resolveFeature(contextRoot: string, ref: string): FeatureResolution {
  const dir = featuresDir(contextRoot);
  const files = featureFiles(contextRoot);
  const relSlug = (f: string) => featureSlug(dir, f);

  const norm = ref.trim().replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '');
  const isPath = norm.includes('/');
  const target = norm.split('/').map(slugify).filter(Boolean).join('/');
  if (!target) return { ok: false, reason: 'not_found' };

  const exactSlug = files.find((f) => relSlug(f) === target);
  if (exactSlug) return { ok: true, path: exactSlug, slug: target };

  // A qualified path that did not resolve must not fuzzy-match across folders
  // (that would silently hit a same-named feature in another product).
  if (isPath) return { ok: false, reason: 'not_found' };

  const tiers = [
    files.filter((f) => basename(f, '.md') === target),
    files.filter((f) => basename(f, '.md').startsWith(target)),
    files.filter((f) => basename(f, '.md').includes(target)),
  ];
  for (const matches of tiers) {
    if (matches.length === 1) return { ok: true, path: matches[0], slug: relSlug(matches[0]) };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', candidates: matches.map(relSlug) };
  }
  return { ok: false, reason: 'not_found' };
}

// ─── Frontmatter access ───────────────────────────────────────────────────────

interface FeatureLinkState {
  slug: string;
  path: string;
  relatedTasks: string[];
}

function readFeatureLinkStates(contextRoot: string): FeatureLinkState[] {
  const dir = featuresDir(contextRoot);
  return featureFiles(contextRoot).map((path) => {
    let relatedTasks: string[] = [];
    try {
      const { data } = readFrontmatter<Record<string, unknown>>(path);
      if (Array.isArray(data.related_tasks)) relatedTasks = (data.related_tasks as unknown[]).map(String);
    } catch {
      /* a malformed feature file is the doctor's problem, not the link engine's */
    }
    return { slug: featureSlug(dir, path), path, relatedTasks };
  });
}

function writeFeatureRelatedTasks(path: string, relatedTasks: string[]): void {
  updateFrontmatterFields(path, { related_tasks: relatedTasks, updated: today() });
}

function taskPath(contextRoot: string, slug: string): string {
  return join(contextRoot, 'state', `${slug}.md`);
}

export function taskExists(contextRoot: string, slug: string): boolean {
  return isSafeTaskSlug(slug) && existsSync(taskPath(contextRoot, slug));
}

/** The task's current `related_feature`, or null (missing/unsafe reads as null). */
export function taskFeatureOf(contextRoot: string, slug: string): string | null {
  if (!isSafeTaskSlug(slug)) return null;
  const path = taskPath(contextRoot, slug);
  if (!existsSync(path)) return null;
  try {
    const { data } = readFrontmatter<Record<string, unknown>>(path);
    return data.related_feature ? String(data.related_feature) : null;
  } catch {
    return null;
  }
}

function writeTaskRelatedFeature(contextRoot: string, slug: string, feature: string | null): void {
  // Hard-fail on a hostile slug — never write a frontmatter field outside state/.
  if (!isSafeTaskSlug(slug)) throw new Error(`Unsafe task slug: ${slug}`);
  updateFrontmatterFields(taskPath(contextRoot, slug), { related_feature: feature });
}

// ─── Bidirectional writes ─────────────────────────────────────────────────────

export interface TaskFeatureLinkResult {
  /** Canonical feature slug now on the task (null when cleared). */
  feature: string | null;
  /** Features whose related_tasks dropped the task (previous memberships). */
  removedFrom: string[];
  /** Feature whose related_tasks gained the task (null when cleared or already present). */
  addedTo: string | null;
}

/**
 * Point a task at a feature (or clear it) and keep every feature's
 * `related_tasks` membership consistent: the task is removed from every other
 * feature that lists it and added to the target. The TASK side is also
 * written here (without an `updated_at` bump — see module doc); call sites
 * that go through a task backend may re-write it with actor/stamp semantics.
 */
export function applyTaskFeatureLink(
  contextRoot: string,
  taskSlug: string,
  feature: { slug: string } | null,
): TaskFeatureLinkResult {
  const target = feature?.slug ?? null;
  const removedFrom: string[] = [];
  let addedTo: string | null = null;

  for (const state of readFeatureLinkStates(contextRoot)) {
    const listed = state.relatedTasks.includes(taskSlug);
    if (state.slug === target) {
      if (!listed) {
        writeFeatureRelatedTasks(state.path, [...state.relatedTasks, taskSlug]);
        addedTo = state.slug;
      }
    } else if (listed) {
      writeFeatureRelatedTasks(state.path, state.relatedTasks.filter((t) => t !== taskSlug));
      removedFrom.push(state.slug);
    }
  }

  writeTaskRelatedFeature(contextRoot, taskSlug, target);
  return { feature: target, removedFrom, addedTo };
}

export interface FeatureTaskListResult {
  /** The validated, deduplicated list now on the feature. */
  relatedTasks: string[];
  /** Tasks newly pointed at this feature. */
  linked: string[];
  /** Tasks that were pointing at ANOTHER feature and were re-pointed here. */
  relinked: Array<{ task: string; from: string }>;
  /** Tasks dropped from the list whose `related_feature` was cleared. */
  unlinked: string[];
}

/**
 * Replace a feature's `related_tasks` list and write the relation through to
 * every affected task's `related_feature`. Caller must have validated the
 * task slugs (see `taskExists`) — this function throws on a ghost slug so a
 * bypassed validation can never persist a dangling ref.
 */
export function applyFeatureTaskList(
  contextRoot: string,
  feature: { slug: string; path: string },
  taskSlugs: string[],
): FeatureTaskListResult {
  const next = Array.from(new Set(taskSlugs));
  const ghost = next.find((t) => !taskExists(contextRoot, t));
  if (ghost) throw new Error(`Unknown task slug: ${ghost}`);

  const prev = readFeatureLinkStates(contextRoot).find((s) => s.slug === feature.slug)?.relatedTasks ?? [];
  const removed = prev.filter((t) => !next.includes(t));

  const linked: string[] = [];
  const relinked: Array<{ task: string; from: string }> = [];

  // Re-assert the back-ref for EVERY listed task, not just newly added ones —
  // setting the list is a statement of the full relation, so members whose
  // `related_feature` drifted (pre-engine data, hand edits) are repaired too.
  for (const task of next) {
    const current = taskFeatureOf(contextRoot, task);
    if (current === feature.slug) continue;
    if (current !== null) {
      // Single-valued task side: adopting the task here steals it from the
      // previous feature, whose membership list must drop it too.
      const states = readFeatureLinkStates(contextRoot);
      const holder = states.find((s) => s.slug === current && s.relatedTasks.includes(task));
      if (holder) writeFeatureRelatedTasks(holder.path, holder.relatedTasks.filter((t) => t !== task));
      relinked.push({ task, from: current });
    } else {
      linked.push(task);
    }
    writeTaskRelatedFeature(contextRoot, task, feature.slug);
  }

  const unlinked: string[] = [];
  for (const task of removed) {
    if (taskFeatureOf(contextRoot, task) === feature.slug) {
      writeTaskRelatedFeature(contextRoot, task, null);
      unlinked.push(task);
    }
  }

  writeFeatureRelatedTasks(feature.path, next);
  return { relatedTasks: next, linked, relinked, unlinked };
}

// ─── Healing (task rename / delete) ───────────────────────────────────────────

/** Rewrite a renamed task's slug inside every feature's `related_tasks`. */
export function healTaskRename(contextRoot: string, oldSlug: string, newSlug: string): string[] {
  const healed: string[] = [];
  for (const state of readFeatureLinkStates(contextRoot)) {
    if (!state.relatedTasks.includes(oldSlug)) continue;
    const next = Array.from(new Set(state.relatedTasks.map((t) => (t === oldSlug ? newSlug : t))));
    writeFeatureRelatedTasks(state.path, next);
    healed.push(state.slug);
  }
  return healed;
}

/**
 * Rewrite `related_feature` on every task that pointed at a feature's OLD
 * canonical slug after the feature is renamed/moved (`features move`). The
 * mirror of `healTaskRename`: it keeps the TASK side of the bidirectional link
 * consistent when the FEATURE side's canonical slug changes, so a task's link
 * never dangles (or, once a same-basename feature exists elsewhere, silently
 * resolves to the wrong feature). Matches the stored slug exactly, like
 * `healTaskRename` — non-canonical drift is `doctor`'s job. Returns healed task
 * slugs. Feature slugs here are relative to `features/` (e.g. `lina/checkout`),
 * NOT knowledge slugs.
 */
export function healFeatureRename(contextRoot: string, oldSlug: string, newSlug: string): string[] {
  if (oldSlug === newSlug) return [];
  const healed: string[] = [];
  for (const [task, ref] of readAllTaskFeatures(contextRoot)) {
    if (ref === oldSlug) {
      writeTaskRelatedFeature(contextRoot, task, newSlug);
      healed.push(task);
    }
  }
  return healed;
}

/** Drop a deleted task's slug from every feature's `related_tasks`. */
export function healTaskRemoved(contextRoot: string, slug: string): string[] {
  const healed: string[] = [];
  for (const state of readFeatureLinkStates(contextRoot)) {
    if (!state.relatedTasks.includes(slug)) continue;
    writeFeatureRelatedTasks(state.path, state.relatedTasks.filter((t) => t !== slug));
    healed.push(state.slug);
  }
  return healed;
}

// ─── Audit + reconcile (doctor / backfill) ────────────────────────────────────

export interface LinkAudit {
  /**
   * task.related_feature does not resolve to a single feature — needs a human.
   * `candidates` is set when the ref is AMBIGUOUS (a bare basename matching two
   * features in different folders); absent when the feature simply does not
   * exist. Both are non-deterministic to fix, so they share this bucket.
   */
  ghostFeatureRefs: Array<{ task: string; feature: string; candidates?: string[] }>;
  /** task.related_feature resolves, but not to the canonical slug (fixable). */
  nonCanonicalFeatureRefs: Array<{ task: string; from: string; to: string }>;
  /** feature.related_tasks entry with no task file behind it (fixable: drop). */
  ghostTaskRefs: Array<{ feature: string; task: string }>;
  /** feature lists a task whose related_feature is empty (fixable: adopt). */
  missingBackRefs: Array<{ feature: string; task: string }>;
  /** 2+ features list the same unclaimed task — needs a human. */
  conflictingClaims: Array<{ task: string; features: string[] }>;
  /** task points at a feature whose list misses it (fixable: add). */
  missingMemberships: Array<{ task: string; feature: string }>;
  /** feature lists a task that points at a DIFFERENT feature (fixable: drop). */
  foreignClaims: Array<{ feature: string; task: string; actual: string }>;
}

export function isLinkAuditClean(audit: LinkAudit): boolean {
  return Object.values(audit).every((entries) => entries.length === 0);
}

function readAllTaskFeatures(contextRoot: string): Map<string, string | null> {
  const stateDir = join(contextRoot, 'state');
  const out = new Map<string, string | null>();
  if (!existsSync(stateDir)) return out;
  for (const file of fg.sync('*.md', { cwd: stateDir, absolute: true })) {
    const slug = basename(file, '.md');
    out.set(slug, taskFeatureOf(contextRoot, slug));
  }
  return out;
}

/**
 * Read-only consistency pass over every task↔feature link in the corpus.
 * `dreamcontext doctor` renders the result; `reconcileFeatureLinks` applies
 * the deterministic fixes.
 */
export function auditFeatureLinks(contextRoot: string): LinkAudit {
  const audit: LinkAudit = {
    ghostFeatureRefs: [],
    nonCanonicalFeatureRefs: [],
    ghostTaskRefs: [],
    missingBackRefs: [],
    conflictingClaims: [],
    missingMemberships: [],
    foreignClaims: [],
  };

  const features = readFeatureLinkStates(contextRoot);
  const bySlug = new Map(features.map((f) => [f.slug, f]));
  const taskFeatures = readAllTaskFeatures(contextRoot);

  // Task side: every related_feature must resolve to a canonical slug whose
  // feature lists the task back.
  const canonicalOf = new Map<string, string | null>(); // task → canonical feature slug (null = unset/ghost)
  for (const [task, ref] of taskFeatures) {
    if (ref === null) {
      canonicalOf.set(task, null);
      continue;
    }
    const resolved = resolveFeature(contextRoot, ref);
    if (!resolved.ok) {
      audit.ghostFeatureRefs.push(
        resolved.reason === 'ambiguous'
          ? { task, feature: ref, candidates: resolved.candidates }
          : { task, feature: ref },
      );
      canonicalOf.set(task, null);
      continue;
    }
    if (resolved.slug !== ref) {
      audit.nonCanonicalFeatureRefs.push({ task, from: ref, to: resolved.slug });
    }
    canonicalOf.set(task, resolved.slug);
    const holder = bySlug.get(resolved.slug);
    if (holder && !holder.relatedTasks.includes(task)) {
      audit.missingMemberships.push({ task, feature: resolved.slug });
    }
  }

  // Feature side: every related_tasks entry must exist, and its back-ref must
  // point here (empty back-refs are adoptable unless contested).
  const claimsOnUnset = new Map<string, string[]>(); // task → claiming features
  for (const feature of features) {
    for (const task of feature.relatedTasks) {
      if (!taskFeatures.has(task)) {
        audit.ghostTaskRefs.push({ feature: feature.slug, task });
        continue;
      }
      const actual = canonicalOf.get(task) ?? null;
      if (actual === null) {
        claimsOnUnset.set(task, [...(claimsOnUnset.get(task) ?? []), feature.slug]);
      } else if (actual !== feature.slug) {
        audit.foreignClaims.push({ feature: feature.slug, task, actual });
      }
    }
  }
  for (const [task, claimants] of claimsOnUnset) {
    if (claimants.length === 1) audit.missingBackRefs.push({ feature: claimants[0], task });
    else audit.conflictingClaims.push({ task, features: claimants });
  }

  return audit;
}

export interface LinkReconcileReport {
  adopted: Array<{ task: string; feature: string }>;
  canonicalized: Array<{ task: string; from: string; to: string }>;
  membershipsAdded: Array<{ task: string; feature: string }>;
  ghostTaskRefsDropped: Array<{ feature: string; task: string }>;
  foreignClaimsDropped: Array<{ feature: string; task: string; actual: string }>;
  /** Left for a human: ghost feature refs + contested claims. */
  unresolved: string[];
}

/**
 * Apply every deterministic fix the audit found. Ghost `related_feature`
 * values and multi-feature claims on the same task are REPORTED, never
 * guessed — deleting or picking a winner is a human call.
 */
export function reconcileFeatureLinks(contextRoot: string): LinkReconcileReport {
  const audit = auditFeatureLinks(contextRoot);
  const features = readFeatureLinkStates(contextRoot);
  const byFeature = new Map(features.map((f) => [f.slug, f]));

  const report: LinkReconcileReport = {
    adopted: [],
    canonicalized: [],
    membershipsAdded: [],
    ghostTaskRefsDropped: [],
    foreignClaimsDropped: [],
    unresolved: [
      ...audit.ghostFeatureRefs.map((g) =>
        g.candidates
          ? `task '${g.task}' points at ambiguous feature '${g.feature}' (${g.candidates.join(', ')}) — qualify it: dreamcontext tasks feature ${g.task} <folder/slug>`
          : `task '${g.task}' points at unknown feature '${g.feature}' — fix or clear with: dreamcontext tasks feature ${g.task} <feature|clear>`,
      ),
      ...audit.conflictingClaims.map(
        (c) => `task '${c.task}' is claimed by ${c.features.length} features (${c.features.join(', ')}) — pick one with: dreamcontext tasks feature ${c.task} <feature>`,
      ),
    ],
  };

  for (const { task, from, to } of audit.nonCanonicalFeatureRefs) {
    writeTaskRelatedFeature(contextRoot, task, to);
    report.canonicalized.push({ task, from, to });
  }
  for (const { feature, task } of audit.missingBackRefs) {
    writeTaskRelatedFeature(contextRoot, task, feature);
    report.adopted.push({ task, feature });
  }
  for (const { task, feature } of audit.missingMemberships) {
    const state = byFeature.get(feature);
    if (state && !state.relatedTasks.includes(task)) {
      state.relatedTasks = [...state.relatedTasks, task];
      writeFeatureRelatedTasks(state.path, state.relatedTasks);
      report.membershipsAdded.push({ task, feature });
    }
  }
  const drops = [
    ...audit.ghostTaskRefs.map((g) => ({ ...g, kind: 'ghost' as const })),
    ...audit.foreignClaims.map((f) => ({ ...f, kind: 'foreign' as const })),
  ];
  for (const drop of drops) {
    const state = byFeature.get(drop.feature);
    if (state && state.relatedTasks.includes(drop.task)) {
      state.relatedTasks = state.relatedTasks.filter((t) => t !== drop.task);
      writeFeatureRelatedTasks(state.path, state.relatedTasks);
      if (drop.kind === 'ghost') report.ghostTaskRefsDropped.push({ feature: drop.feature, task: drop.task });
      else report.foreignClaimsDropped.push({ feature: drop.feature, task: drop.task, actual: (drop as { actual: string }).actual });
    }
  }

  return report;
}
