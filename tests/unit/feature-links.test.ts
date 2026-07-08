import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveFeature,
  taskExists,
  taskFeatureOf,
  anyFeaturesExist,
  applyTaskFeatureLink,
  applyFeatureTaskList,
  healTaskRename,
  healFeatureRename,
  healTaskRemoved,
  auditFeatureLinks,
  reconcileFeatureLinks,
  isLinkAuditClean,
} from '../../src/lib/feature-links.js';
import { readFrontmatter } from '../../src/lib/frontmatter.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
//
// The link engine is the single write path for the bidirectional relation
// task.related_feature (single-valued) ↔ feature.related_tasks (list). These
// tests prove: canonical-slug resolution, both-side writes, healing on task
// rename/delete, and the audit/reconcile pass doctor exposes.

let root: string;

function writeFeature(slug: string, relatedTasks: string[] = []): string {
  const path = join(root, 'knowledge', 'features', `${slug}.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  const list = relatedTasks.length > 0
    ? `related_tasks:\n${relatedTasks.map((t) => `  - ${t}`).join('\n')}`
    : 'related_tasks: []';
  writeFileSync(path, `---\nid: feat_${slug.replace(/\W/g, '_')}\ntype: feature\nname: ${slug}\nstatus: planning\n${list}\n---\n\n## Why\n\nBody.\n`, 'utf-8');
  return path;
}

function writeTask(slug: string, relatedFeature: string | null = null): string {
  const path = join(root, 'state', `${slug}.md`);
  writeFileSync(path, `---\nid: task_${slug.replace(/\W/g, '_')}\nname: ${slug}\nstatus: todo\nrelated_feature: ${relatedFeature ?? 'null'}\n---\n\n## Why\n\nBody.\n`, 'utf-8');
  return path;
}

function featureTasks(slug: string): string[] {
  const { data } = readFrontmatter<Record<string, unknown>>(join(root, 'knowledge', 'features', `${slug}.md`));
  return Array.isArray(data.related_tasks) ? (data.related_tasks as unknown[]).map(String) : [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-featlinks-'));
  mkdirSync(join(root, 'knowledge', 'features'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── resolveFeature ───────────────────────────────────────────────────────────

describe('resolveFeature', () => {
  it('resolves a flat feature by exact slug', () => {
    writeFeature('checkout');
    const r = resolveFeature(root, 'checkout');
    expect(r).toMatchObject({ ok: true, slug: 'checkout' });
  });

  it('resolves a nested feature by its qualified path and by bare name', () => {
    writeFeature('lina/checkout');
    expect(resolveFeature(root, 'lina/checkout')).toMatchObject({ ok: true, slug: 'lina/checkout' });
    // A bare name resolves a nested feature when unambiguous — and yields the
    // CANONICAL folder-qualified slug, not the basename.
    expect(resolveFeature(root, 'checkout')).toMatchObject({ ok: true, slug: 'lina/checkout' });
  });

  it('reports ambiguity instead of guessing across folders', () => {
    writeFeature('lina/checkout');
    writeFeature('mos/checkout');
    const r = resolveFeature(root, 'checkout');
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'ambiguous') {
      expect(r.candidates.sort()).toEqual(['lina/checkout', 'mos/checkout']);
    } else {
      expect.fail('expected ambiguous resolution');
    }
  });

  it('does not fuzzy-match a qualified path that missed', () => {
    writeFeature('lina/checkout');
    expect(resolveFeature(root, 'mos/checkout')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('slugifies free-form references', () => {
    writeFeature('auth-system');
    expect(resolveFeature(root, 'Auth System')).toMatchObject({ ok: true, slug: 'auth-system' });
  });

  it('anyFeaturesExist / taskExists reflect the corpus', () => {
    expect(anyFeaturesExist(root)).toBe(false);
    writeFeature('a');
    expect(anyFeaturesExist(root)).toBe(true);
    expect(taskExists(root, 'nope')).toBe(false);
    writeTask('yep');
    expect(taskExists(root, 'yep')).toBe(true);
  });
});

// ─── applyTaskFeatureLink ─────────────────────────────────────────────────────

describe('applyTaskFeatureLink', () => {
  it('sets both sides and removes the task from every other feature', () => {
    writeFeature('old-home', ['t1']);
    writeFeature('new-home');
    writeTask('t1', 'old-home');

    const result = applyTaskFeatureLink(root, 't1', { slug: 'new-home' });

    expect(result).toMatchObject({ feature: 'new-home', addedTo: 'new-home', removedFrom: ['old-home'] });
    expect(taskFeatureOf(root, 't1')).toBe('new-home');
    expect(featureTasks('old-home')).toEqual([]);
    expect(featureTasks('new-home')).toEqual(['t1']);
  });

  it('clear removes the membership and nulls the task side', () => {
    writeFeature('home', ['t1']);
    writeTask('t1', 'home');

    const result = applyTaskFeatureLink(root, 't1', null);

    expect(result).toMatchObject({ feature: null, addedTo: null, removedFrom: ['home'] });
    expect(taskFeatureOf(root, 't1')).toBeNull();
    expect(featureTasks('home')).toEqual([]);
  });

  it('is idempotent when the link already holds', () => {
    writeFeature('home', ['t1']);
    writeTask('t1', 'home');
    const result = applyTaskFeatureLink(root, 't1', { slug: 'home' });
    expect(result).toMatchObject({ feature: 'home', addedTo: null, removedFrom: [] });
    expect(featureTasks('home')).toEqual(['t1']);
  });
});

// ─── applyFeatureTaskList ─────────────────────────────────────────────────────

describe('applyFeatureTaskList', () => {
  it('throws on a ghost task slug (validation is not optional)', () => {
    const path = writeFeature('home');
    expect(() => applyFeatureTaskList(root, { slug: 'home', path }, ['nope'])).toThrow(/Unknown task slug/);
  });

  it('links, re-links (stealing from the previous holder), and unlinks', () => {
    const homePath = writeFeature('home', ['keeper', 'goner']);
    writeFeature('rival', ['stolen']);
    writeTask('keeper', 'home');
    writeTask('goner', 'home');
    writeTask('fresh');
    writeTask('stolen', 'rival');

    const result = applyFeatureTaskList(root, { slug: 'home', path: homePath }, ['keeper', 'fresh', 'stolen']);

    expect(result.relatedTasks).toEqual(['keeper', 'fresh', 'stolen']);
    expect(result.linked).toEqual(['fresh']);
    expect(result.relinked).toEqual([{ task: 'stolen', from: 'rival' }]);
    expect(result.unlinked).toEqual(['goner']);
    expect(taskFeatureOf(root, 'fresh')).toBe('home');
    expect(taskFeatureOf(root, 'stolen')).toBe('home');
    expect(taskFeatureOf(root, 'goner')).toBeNull();
    expect(featureTasks('rival')).toEqual([]);
  });

  it('repairs a drifted back-ref for a task that was already listed', () => {
    // Pre-engine data: the feature lists the task but the task side is null.
    const path = writeFeature('home', ['drifted']);
    writeTask('drifted', null);
    const result = applyFeatureTaskList(root, { slug: 'home', path }, ['drifted']);
    expect(result.linked).toEqual(['drifted']);
    expect(taskFeatureOf(root, 'drifted')).toBe('home');
  });

  it('deduplicates the incoming list', () => {
    const path = writeFeature('home');
    writeTask('t1');
    const result = applyFeatureTaskList(root, { slug: 'home', path }, ['t1', 't1']);
    expect(result.relatedTasks).toEqual(['t1']);
    expect(featureTasks('home')).toEqual(['t1']);
  });
});

// ─── Healing ──────────────────────────────────────────────────────────────────

describe('healing', () => {
  it('healTaskRename rewrites the slug in every listing feature', () => {
    writeFeature('a', ['old-slug', 'other']);
    writeFeature('b', ['old-slug']);
    writeTask('other');
    expect(healTaskRename(root, 'old-slug', 'new-slug').sort()).toEqual(['a', 'b']);
    expect(featureTasks('a')).toEqual(['new-slug', 'other']);
    expect(featureTasks('b')).toEqual(['new-slug']);
  });

  it('healTaskRemoved drops the slug from every listing feature', () => {
    writeFeature('a', ['gone', 'other']);
    writeTask('other');
    expect(healTaskRemoved(root, 'gone')).toEqual(['a']);
    expect(featureTasks('a')).toEqual(['other']);
  });
});

// ─── Audit + reconcile ────────────────────────────────────────────────────────

describe('auditFeatureLinks / reconcileFeatureLinks', () => {
  it('reports a clean corpus as clean', () => {
    writeFeature('home', ['t1']);
    writeTask('t1', 'home');
    expect(isLinkAuditClean(auditFeatureLinks(root))).toBe(true);
  });

  it('categorizes every kind of drift', () => {
    writeFeature('home', ['ghost-task', 'unclaimed', 'foreign']);
    writeFeature('rival', ['unclaimed2']);
    writeFeature('rival2', ['unclaimed2']);
    writeFeature('lina/nested');
    writeTask('unclaimed', null);            // → missingBackRefs (single claim)
    writeTask('unclaimed2', null);           // → conflictingClaims (two claims)
    writeTask('foreign', 'rival');           // → foreignClaims (home lists, belongs to rival) + rival missing membership
    writeTask('ghost-ref', 'no-such-feat');  // → ghostFeatureRefs
    writeTask('lazy-ref', 'nested');         // → nonCanonicalFeatureRefs (resolves to lina/nested)

    const audit = auditFeatureLinks(root);
    expect(audit.ghostTaskRefs).toEqual([{ feature: 'home', task: 'ghost-task' }]);
    expect(audit.missingBackRefs).toEqual([{ feature: 'home', task: 'unclaimed' }]);
    expect(audit.conflictingClaims).toEqual([{ task: 'unclaimed2', features: ['rival', 'rival2'] }]);
    expect(audit.foreignClaims).toEqual([{ feature: 'home', task: 'foreign', actual: 'rival' }]);
    expect(audit.ghostFeatureRefs).toEqual([{ task: 'ghost-ref', feature: 'no-such-feat' }]);
    expect(audit.nonCanonicalFeatureRefs).toEqual([{ task: 'lazy-ref', from: 'nested', to: 'lina/nested' }]);
    // foreign belongs to rival but rival's list misses it; lazy-ref points at
    // lina/nested whose list misses it.
    expect(audit.missingMemberships.map((m) => m.task).sort()).toEqual(['foreign', 'lazy-ref']);
  });

  it('reconcile applies every deterministic fix and reports the rest', () => {
    writeFeature('home', ['ghost-task', 'unclaimed', 'foreign']);
    writeFeature('rival', []);
    writeTask('unclaimed', null);
    writeTask('foreign', 'rival');
    writeTask('ghost-ref', 'no-such-feat');

    const report = reconcileFeatureLinks(root);

    expect(report.adopted).toEqual([{ task: 'unclaimed', feature: 'home' }]);
    expect(report.ghostTaskRefsDropped).toEqual([{ feature: 'home', task: 'ghost-task' }]);
    expect(report.foreignClaimsDropped).toEqual([{ feature: 'home', task: 'foreign', actual: 'rival' }]);
    expect(report.membershipsAdded).toEqual([{ task: 'foreign', feature: 'rival' }]);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]).toContain('ghost-ref');

    // After reconcile, the only remaining noise is the ghost ref a human owns.
    const after = auditFeatureLinks(root);
    expect(after.ghostTaskRefs).toEqual([]);
    expect(after.missingBackRefs).toEqual([]);
    expect(after.foreignClaims).toEqual([]);
    expect(after.missingMemberships).toEqual([]);
    expect(after.ghostFeatureRefs).toEqual([{ task: 'ghost-ref', feature: 'no-such-feat' }]);
  });

  it('reconcile is idempotent', () => {
    writeFeature('home', ['unclaimed']);
    writeTask('unclaimed', null);
    reconcileFeatureLinks(root);
    const second = reconcileFeatureLinks(root);
    expect(second.adopted).toEqual([]);
    expect(second.membershipsAdded).toEqual([]);
    expect(isLinkAuditClean(auditFeatureLinks(root))).toBe(true);
  });
});

// ─── healFeatureRename (mirror of healTaskRename, for `features move`) ──────────
describe('healFeatureRename', () => {
  it('repoints related_feature on every task that pointed at the old feature slug', () => {
    writeTask('t1', 'checkout');
    writeTask('t2', 'checkout');
    writeTask('t3', 'other');

    const healed = healFeatureRename(root, 'checkout', 'lina/checkout').sort();

    expect(healed).toEqual(['t1', 't2']);
    expect(taskFeatureOf(root, 't1')).toBe('lina/checkout');
    expect(taskFeatureOf(root, 't2')).toBe('lina/checkout');
    expect(taskFeatureOf(root, 't3')).toBe('other'); // untouched
  });

  it('is a no-op when old and new slugs match', () => {
    writeTask('t1', 'checkout');
    expect(healFeatureRename(root, 'checkout', 'checkout')).toEqual([]);
  });

  it('leaves the link healthy after a move — the audit finds NO ghost/non-canonical ref', () => {
    // Simulate `features move checkout lina`: the feature file now lives at the
    // nested slug, and healFeatureRename fixes the task back-ref. The audit
    // (which resolveFeature drives) must then be clean — proving the link no
    // longer dangles and won't silently mis-resolve on a later collision.
    writeFeature('lina/checkout', ['t1']); // feature already moved
    writeTask('t1', 'checkout');           // task still points at the OLD slug

    // Before healing: the stale ref is non-canonical (basename-fallback resolves it).
    expect(auditFeatureLinks(root).nonCanonicalFeatureRefs).toEqual([
      { task: 't1', from: 'checkout', to: 'lina/checkout' },
    ]);

    healFeatureRename(root, 'checkout', 'lina/checkout');

    expect(taskFeatureOf(root, 't1')).toBe('lina/checkout');
    expect(isLinkAuditClean(auditFeatureLinks(root))).toBe(true);
  });
});

// ─── auditFeatureLinks: ambiguous vs. not-found ────────────────────────────────
describe('auditFeatureLinks — ambiguous ref distinction', () => {
  it('attaches candidates when a bare related_feature is ambiguous across product folders', () => {
    writeFeature('lina/checkout', []);
    writeFeature('memoryos/checkout', []);
    writeTask('t1', 'checkout'); // bare basename matches TWO features

    const audit = auditFeatureLinks(root);
    expect(audit.ghostFeatureRefs).toHaveLength(1);
    expect(audit.ghostFeatureRefs[0].task).toBe('t1');
    expect(audit.ghostFeatureRefs[0].candidates?.sort()).toEqual(['lina/checkout', 'memoryos/checkout']);
  });

  it('leaves candidates undefined for a truly missing feature', () => {
    writeTask('t1', 'no-such-feature');
    const audit = auditFeatureLinks(root);
    expect(audit.ghostFeatureRefs).toEqual([{ task: 't1', feature: 'no-such-feature' }]);
    expect(audit.ghostFeatureRefs[0].candidates).toBeUndefined();
  });
});

// ─── Path-safety guard on task slugs (defense in depth) ────────────────────────
describe('task-slug path safety', () => {
  it('taskExists / taskFeatureOf return safe defaults for a traversal slug', () => {
    expect(taskExists(root, '../../etc/passwd')).toBe(false);
    expect(taskFeatureOf(root, '../../secret')).toBeNull();
  });

  it('applyFeatureTaskList rejects a traversal slug as an unknown task (never writes outside state/)', () => {
    const path = writeFeature('checkout', []);
    expect(() => applyFeatureTaskList(root, { slug: 'checkout', path }, ['../../evil']))
      .toThrow(/Unknown task slug/);
  });
});
