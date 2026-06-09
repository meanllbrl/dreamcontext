import { describe, it, expect } from 'vitest';
import {
  computeFeatureFreshness,
  daysBetween,
  freshnessSnapshotNote,
  analyzeFeatures,
  FEATURE_STALE_DAYS,
  type FeatureRef,
  type TaskRef,
} from '../../src/lib/feature-freshness.js';

const NOW = new Date('2026-06-09T00:00:00Z');

// ─── daysBetween ─────────────────────────────────────────────────────────────

describe('daysBetween', () => {
  it('returns null for undefined input', () => {
    expect(daysBetween(undefined, NOW)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(daysBetween('', NOW)).toBeNull();
  });

  it('returns null for whitespace', () => {
    expect(daysBetween('   ', NOW)).toBeNull();
  });

  it('returns null for unparseable string', () => {
    expect(daysBetween('not-a-date', NOW)).toBeNull();
  });

  it('returns correct days for a valid ISO date', () => {
    // 2026-06-09 minus 2026-04-30 = 40 days
    expect(daysBetween('2026-04-30', NOW)).toBe(40);
  });

  it('returns 0 when date equals now', () => {
    expect(daysBetween('2026-06-09', NOW)).toBe(0);
  });

  it('returns 30 for exactly 30 days ago', () => {
    expect(daysBetween('2026-05-10', NOW)).toBe(30);
  });
});

// ─── computeFeatureFreshness ─────────────────────────────────────────────────

describe('computeFeatureFreshness', () => {
  it('returns unknown when updated is undefined', () => {
    const r = computeFeatureFreshness('2026-01-01', undefined, NOW);
    expect(r.level).toBe('unknown');
    expect(r.daysSinceUpdate).toBeNull();
    expect(r.note).toBe('');
  });

  it('returns unknown when updated is empty string', () => {
    const r = computeFeatureFreshness('2026-01-01', '', NOW);
    expect(r.level).toBe('unknown');
  });

  it('returns unknown when updated is malformed', () => {
    const r = computeFeatureFreshness('2026-01-01', 'bad-date', NOW);
    expect(r.level).toBe('unknown');
  });

  it('returns stale for 40 days ago', () => {
    const r = computeFeatureFreshness('2026-01-01', '2026-04-30', NOW);
    expect(r.level).toBe('stale');
    expect(r.daysSinceUpdate).toBe(40);
    expect(r.note).toBe('stale: not updated in 30+ days');
  });

  it('returns fresh for 5 days ago', () => {
    const r = computeFeatureFreshness('2026-06-04', '2026-06-04', NOW);
    expect(r.level).toBe('fresh');
    expect(r.note).toBe('');
  });

  it('returns fresh for exactly 30 days ago (boundary: > 30, not >=)', () => {
    const r = computeFeatureFreshness('2026-05-01', '2026-05-10', NOW);
    expect(daysBetween('2026-05-10', NOW)).toBe(30);
    expect(r.level).toBe('fresh');
  });

  it('returns stale for 31 days ago', () => {
    const r = computeFeatureFreshness('2026-05-01', '2026-05-09', NOW);
    expect(daysBetween('2026-05-09', NOW)).toBe(31);
    expect(r.level).toBe('stale');
    expect(r.note).toBe('stale: not updated in 30+ days');
  });

  it('returns fresh when updated===created same-day (created today)', () => {
    // same day, zero days old — fresh regardless of equality
    const r = computeFeatureFreshness('2026-06-09', '2026-06-09', NOW);
    expect(r.level).toBe('fresh');
  });

  it('returns stale + never-updated subnote when updated===created 60d ago', () => {
    const r = computeFeatureFreshness('2026-04-10', '2026-04-10', NOW);
    expect(r.level).toBe('stale');
    expect(r.note).toBe('stale: never updated since creation (30+ days)');
  });

  it('uses FEATURE_STALE_DAYS constant (30)', () => {
    expect(FEATURE_STALE_DAYS).toBe(30);
  });
});

// ─── freshnessSnapshotNote ────────────────────────────────────────────────────

describe('freshnessSnapshotNote', () => {
  it('returns empty string when note is empty (fresh)', () => {
    const f = computeFeatureFreshness('2026-06-04', '2026-06-04', NOW);
    expect(freshnessSnapshotNote(f)).toBe('');
  });

  it('returns empty string when level is unknown', () => {
    const f = computeFeatureFreshness(undefined, undefined, NOW);
    expect(freshnessSnapshotNote(f)).toBe('');
  });

  it('wraps note in parentheses for stale', () => {
    const f = computeFeatureFreshness('2026-01-01', '2026-04-30', NOW);
    expect(f.level).toBe('stale');
    expect(freshnessSnapshotNote(f)).toBe(' (stale: not updated in 30+ days)');
  });

  it('wraps never-updated note in parentheses', () => {
    const f = computeFeatureFreshness('2026-04-10', '2026-04-10', NOW);
    expect(freshnessSnapshotNote(f)).toBe(' (stale: never updated since creation (30+ days))');
  });
});

// ─── analyzeFeatures ─────────────────────────────────────────────────────────

describe('analyzeFeatures', () => {
  it('returns empty buckets for empty inputs', () => {
    const result = analyzeFeatures([], [], NOW);
    expect(result.stale).toEqual([]);
    expect(result.orphaned).toEqual([]);
    expect(result.danglingTaskRefs).toEqual([]);
  });

  it('marks stale feature and does NOT orphan it when it has related tasks', () => {
    const features: FeatureRef[] = [
      {
        slug: 'my-feature',
        id: 'feat_abc',
        created: '2026-04-10',
        updated: '2026-04-10',  // same as created, 60d ago → stale + never-updated
        related_tasks: ['some-task'],
      },
    ];
    const taskRefs: TaskRef[] = [
      { task: 'some-task', related_feature: 'my-feature' },
    ];

    const result = analyzeFeatures(features, taskRefs, NOW);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].slug).toBe('my-feature');
    expect(result.stale[0].note).toBe('stale: never updated since creation (30+ days)');
    // Has frontmatter tasks → NOT orphaned
    expect(result.orphaned).toHaveLength(0);
    expect(result.danglingTaskRefs).toHaveLength(0);
  });

  it('marks orphaned when feature has empty related_tasks and no back-refs', () => {
    const features: FeatureRef[] = [
      {
        slug: 'lonely-feature',
        id: 'feat_xyz',
        created: '2026-06-01',
        updated: '2026-06-01',
        related_tasks: [],
      },
    ];
    const taskRefs: TaskRef[] = [
      { task: 'unrelated-task', related_feature: null },
    ];

    const result = analyzeFeatures(features, taskRefs, NOW);
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0].slug).toBe('lonely-feature');
  });

  it('does NOT orphan feature when task points back by slug (slug-primary matching)', () => {
    const features: FeatureRef[] = [
      {
        slug: 'recall-engine',
        id: 'feat_001',
        created: '2026-06-01',
        updated: '2026-06-01',
        related_tasks: [],  // empty in frontmatter
      },
    ];
    // Task uses the SLUG (as real state files do)
    const taskRefs: TaskRef[] = [
      { task: 'some-task', related_feature: 'recall-engine' },
    ];

    const result = analyzeFeatures(features, taskRefs, NOW);
    expect(result.orphaned).toHaveLength(0);
  });

  it('does NOT orphan feature when task points back by id (id fallback)', () => {
    const features: FeatureRef[] = [
      {
        slug: 'some-feature',
        id: 'feat_001',
        created: '2026-06-01',
        updated: '2026-06-01',
        related_tasks: [],
      },
    ];
    // Task uses the feature's ID as related_feature
    const taskRefs: TaskRef[] = [
      { task: 'task-a', related_feature: 'feat_001' },
    ];

    const result = analyzeFeatures(features, taskRefs, NOW);
    expect(result.orphaned).toHaveLength(0);
  });

  it('marks dangling task ref when related_feature matches no feature by slug or id', () => {
    const features: FeatureRef[] = [
      { slug: 'real-feature', id: 'feat_real', created: '2026-06-01', updated: '2026-06-01', related_tasks: [] },
    ];
    const taskRefs: TaskRef[] = [
      { task: 'task-ghost', related_feature: 'ghost-feature' },
    ];

    const result = analyzeFeatures(features, taskRefs, NOW);
    expect(result.danglingTaskRefs).toHaveLength(1);
    expect(result.danglingTaskRefs[0].task).toBe('task-ghost');
    expect(result.danglingTaskRefs[0].missingFeature).toBe('ghost-feature');
    // real-feature has no back-ref and no related_tasks → orphaned
    expect(result.orphaned).toHaveLength(1);
  });

  it('ignores tasks with null related_feature (no dangling, no back-ref effect)', () => {
    const features: FeatureRef[] = [
      { slug: 'my-feat', id: 'feat_1', created: '2026-06-01', updated: '2026-06-01', related_tasks: [] },
    ];
    const taskRefs: TaskRef[] = [
      { task: 'task-with-no-feature', related_feature: null },
    ];

    const result = analyzeFeatures(features, taskRefs, NOW);
    expect(result.danglingTaskRefs).toHaveLength(0);
    // no back-ref → orphaned
    expect(result.orphaned).toHaveLength(1);
  });

  it('slug matching is case-insensitive', () => {
    const features: FeatureRef[] = [
      { slug: 'MyFeature', id: 'feat_2', created: '2026-06-01', updated: '2026-06-01', related_tasks: [] },
    ];
    const taskRefs: TaskRef[] = [
      { task: 'task-b', related_feature: 'myfeature' },  // lowercase slug
    ];

    const result = analyzeFeatures(features, taskRefs, NOW);
    expect(result.orphaned).toHaveLength(0);
    expect(result.danglingTaskRefs).toHaveLength(0);
  });
});
