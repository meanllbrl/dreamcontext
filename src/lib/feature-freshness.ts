/**
 * Feature freshness helpers.
 * Single deterministic core for freshness computation, snapshot notes, and doctor analysis.
 * No separate feature-query.ts — toFeatureRecord normalization is inlined in analyzeFeatures.
 */

export const FEATURE_STALE_DAYS = 30;

export interface FeatureFreshness {
  level: 'fresh' | 'stale' | 'unknown';
  daysSinceUpdate: number | null;
  note: string;
}

/**
 * Compute the number of whole days between an ISO date string and `now`.
 * Returns null if `fromISO` is missing, empty, or unparseable.
 */
export function daysBetween(fromISO: string | undefined | null, now: Date): number | null {
  if (!fromISO || !fromISO.trim()) return null;
  const ms = new Date(fromISO).getTime();
  if (isNaN(ms)) return null;
  return Math.floor((now.getTime() - ms) / 86_400_000);
}

/**
 * Compute freshness for a single feature PRD.
 *
 * Rules:
 * - `updated` missing/unparseable => level:'unknown', daysSinceUpdate:null, note:''
 * - daysSinceUpdate > 30 => level:'stale'
 *   - if updated === created (never actually updated) => note includes '(never updated since creation)'
 * - else => level:'fresh', note:''
 *
 * Inject `now` for deterministic tests (defaults to real clock).
 */
export function computeFeatureFreshness(
  created?: string,
  updated?: string,
  now: Date = new Date(),
): FeatureFreshness {
  const days = daysBetween(updated, now);
  if (days === null) {
    return { level: 'unknown', daysSinceUpdate: null, note: '' };
  }

  if (days > FEATURE_STALE_DAYS) {
    // Check if the PRD was never updated: created and updated are the same date string
    const neverUpdated =
      typeof created === 'string' &&
      typeof updated === 'string' &&
      created.trim() === updated.trim() &&
      created.trim() !== '';

    const note = neverUpdated
      ? 'stale: never updated since creation (30+ days)'
      : 'stale: not updated in 30+ days';

    return { level: 'stale', daysSinceUpdate: days, note };
  }

  return { level: 'fresh', daysSinceUpdate: days, note: '' };
}

/**
 * Returns the parenthesised snippet to append to the snapshot feature header line.
 * Mirrors the knowledge stalenessNote string shape: ' (note)' when note is non-empty, else ''.
 */
export function freshnessSnapshotNote(f: FeatureFreshness): string {
  return f.note ? ` (${f.note})` : '';
}

// ─── analyzeFeatures ─────────────────────────────────────────────────────────

export interface FeatureRef {
  /** slug == basename of the .md file (primary match key) */
  slug: string;
  /** id from frontmatter (fallback match key) */
  id?: string;
  created?: string;
  updated?: string;
  /** slugs/ids of related tasks recorded in the feature's own frontmatter */
  related_tasks?: string[];
}

export interface TaskRef {
  /** task slug (basename of state .md) */
  task: string;
  /** value of related_feature frontmatter field (null if absent) */
  related_feature: string | null;
}

export interface AnalyzeResult {
  stale: Array<{ slug: string; note: string; daysSinceUpdate: number }>;
  orphaned: Array<{ slug: string }>;
  danglingTaskRefs: Array<{ task: string; missingFeature: string }>;
}

/**
 * Case-insensitive equality helper.
 */
function ieq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Analyze a set of features and task back-references for health issues.
 *
 * Matching rules (BINDING — do not copy graph.ts which does id-first):
 *   - Slug is PRIMARY: a task's `related_feature` is matched against feature.slug first.
 *   - feature.id is FALLBACK only.
 *   - Slug-matched refs must never be flagged dangling/orphaned.
 *
 * Definitions:
 *   stale     : computeFeatureFreshness(created, updated, now).level === 'stale'
 *   orphaned  : feature has no related_tasks entries AND no task points back via slug|id
 *   dangling  : task has non-null related_feature that matches NO feature by slug OR id
 *
 * @param features  list of feature records (from PRD frontmatter)
 * @param taskRefs  list of {task, related_feature} from task frontmatter
 * @param now       injectable for deterministic tests
 */
export function analyzeFeatures(
  features: FeatureRef[],
  taskRefs: TaskRef[],
  now: Date = new Date(),
): AnalyzeResult {
  const stale: AnalyzeResult['stale'] = [];
  const orphaned: AnalyzeResult['orphaned'] = [];
  const danglingTaskRefs: AnalyzeResult['danglingTaskRefs'] = [];

  // Build a Set of all feature slugs and ids for O(1) lookups
  const featureSlugs = new Set(features.map(f => f.slug.toLowerCase()));
  const featureIds = new Set(
    features.filter(f => f.id && f.id.trim()).map(f => f.id!.toLowerCase()),
  );

  // Build a Set of related_feature values that actually resolve (slug or id)
  const resolvedRefs = new Set<string>();
  for (const tr of taskRefs) {
    if (!tr.related_feature) continue;
    const rf = tr.related_feature.toLowerCase();
    if (featureSlugs.has(rf) || featureIds.has(rf)) {
      resolvedRefs.add(rf);
    }
  }

  // Identify dangling refs (task.related_feature non-null, matches no feature)
  for (const tr of taskRefs) {
    if (!tr.related_feature) continue;
    const rf = tr.related_feature.toLowerCase();
    if (!featureSlugs.has(rf) && !featureIds.has(rf)) {
      danglingTaskRefs.push({ task: tr.task, missingFeature: tr.related_feature });
    }
  }

  // Analyze each feature for stale / orphaned
  for (const feat of features) {
    // Stale check
    const freshness = computeFeatureFreshness(feat.created, feat.updated, now);
    if (freshness.level === 'stale') {
      stale.push({
        slug: feat.slug,
        note: freshness.note,
        daysSinceUpdate: freshness.daysSinceUpdate!,
      });
    }

    // Orphaned check
    // 1. Feature's own frontmatter has related_tasks
    const hasFrontmatterTasks =
      Array.isArray(feat.related_tasks) && feat.related_tasks.length > 0;

    // 2. Any task points back to this feature (by slug primary, id fallback)
    const slug = feat.slug.toLowerCase();
    const id = feat.id ? feat.id.toLowerCase() : '';
    const hasBackRef = taskRefs.some(tr => {
      if (!tr.related_feature) return false;
      const rf = tr.related_feature.toLowerCase();
      // slug is primary
      if (ieq(rf, slug)) return true;
      // id is fallback
      if (id && ieq(rf, id)) return true;
      return false;
    });

    if (!hasFrontmatterTasks && !hasBackRef) {
      orphaned.push({ slug: feat.slug });
    }
  }

  return { stale, orphaned, danglingTaskRefs };
}
