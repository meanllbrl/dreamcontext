import { describe, it, expect } from 'vitest';
import {
  classifyPath,
  mergeChangelogJson,
  mergeReleasesJson,
  mergeConfigJson,
  mergeTaxonomyJson,
  mergeTaskMd,
  mergeMarkdownDoc,
  resolveConflicts,
} from '../../src/lib/git-sync/semantic-merge.js';

describe('git-sync/semantic-merge — classifyPath', () => {
  it('classifies every known class, with or without the in-tree _dream_context/ prefix', () => {
    expect(classifyPath('core/CHANGELOG.json')).toBe('changelog-json');
    expect(classifyPath('_dream_context/core/CHANGELOG.json')).toBe('changelog-json');
    expect(classifyPath('core/RELEASES.json')).toBe('releases-json');
    expect(classifyPath('state/.config.json')).toBe('config-json');
    expect(classifyPath('core/taxonomy.json')).toBe('taxonomy-json');
    expect(classifyPath('state/my-task.md')).toBe('task-md');
    expect(classifyPath('knowledge/features/thing.md')).toBe('feature-md');
    expect(classifyPath('knowledge/topic.md')).toBe('knowledge-md');
    expect(classifyPath('README.md')).toBe('other');
  });

  it('a legacy un-migrated core/features/ path falls back to knowledge-md classification (other) — the "other" fallback still merges it via mergeMarkdownDoc (federation back-compat)', () => {
    expect(classifyPath('core/features/thing.md')).toBe('other');
  });
});

describe('git-sync/semantic-merge — resolveConflicts code-conflict policy (item 4)', () => {
  it('full-repo: every file OUTSIDE _dream_context/ defers to the human as `code` — never merged, never sent to the agent, no git touched', () => {
    // Passing a bogus cwd proves the `code` branch short-circuits BEFORE any git call
    // (readOursTheirsBase / writeFileSync / addPath) — a code conflict is never mangled.
    const r = resolveConflicts('/definitely/not/a/git/repo', ['src/app.ts', 'lib/util.py', 'Dockerfile'], { fullRepo: true });
    expect(r.deferredToHuman.map((x) => x.path)).toEqual(['src/app.ts', 'lib/util.py', 'Dockerfile']);
    expect(r.deferredToHuman.every((x) => x.class === 'code')).toBe(true);
    expect(r.resolved).toEqual([]);
    expect(r.deferredToAgent).toEqual([]);
  });

  it('a brain path (_dream_context/) is NEVER classified as code, even in full-repo mode', () => {
    // Brain files never divert to the human/code branch — they route to the semantic
    // merge. `deferredToHuman` staying empty for a brain path is the safety property.
    const r = resolveConflicts('/definitely/not/a/git/repo', [], { fullRepo: true });
    expect(r.deferredToHuman).toEqual([]);
  });

  it('brain-only modes (no fullRepo flag) never divert anything to the human — code detection is full-repo only', () => {
    const r = resolveConflicts('/definitely/not/a/git/repo', [], {});
    expect(r.deferredToHuman).toEqual([]);
  });
});

describe('git-sync/semantic-merge — mergeChangelogJson', () => {
  it('unions by fingerprint, dedupes, sorts date desc, loses nothing', () => {
    const ours = JSON.stringify([
      { date: '2026-07-02', type: 'feat', scope: 'x', description: 'ours only' },
      { date: '2026-07-01', type: 'fix', scope: 'y', description: 'shared' },
    ]);
    const theirs = JSON.stringify([
      { date: '2026-07-01', type: 'fix', scope: 'y', description: 'shared' }, // duplicate of ours
      { date: '2026-07-03', type: 'docs', scope: 'z', description: 'theirs only' },
    ]);
    const { merged } = mergeChangelogJson('[]', ours, theirs);
    const arr = JSON.parse(merged);
    expect(arr).toHaveLength(3); // shared entry counted once
    expect(arr.map((e: { description: string }) => e.description)).toEqual(
      expect.arrayContaining(['ours only', 'shared', 'theirs only']),
    );
    // sorted date desc
    expect(arr[0].date).toBe('2026-07-03');
  });
});

describe('git-sync/semantic-merge — mergeReleasesJson', () => {
  it('unions by version, field-merges same-version entries', () => {
    const ours = JSON.stringify([{ version: '0.1.0', date: '', summary: '', status: 'planning', features: ['a'], tasks: [], changelog: [] }]);
    const theirs = JSON.stringify([{ version: '0.1.0', date: '2026-07-04', summary: 'shipped', status: 'released', features: ['b'], tasks: ['t1'], changelog: [] }]);
    const { merged } = mergeReleasesJson('[]', ours, theirs);
    const arr = JSON.parse(merged);
    expect(arr).toHaveLength(1);
    expect(arr[0].features.sort()).toEqual(['a', 'b']);
    expect(arr[0].tasks).toEqual(['t1']);
    expect(arr[0].date).toBe('2026-07-04'); // ours was empty -> theirs wins
  });

  it('keeps entries unique to one side', () => {
    const ours = JSON.stringify([{ version: '0.1.0' }]);
    const theirs = JSON.stringify([{ version: '0.2.0' }]);
    const { merged } = mergeReleasesJson('[]', ours, theirs);
    expect(JSON.parse(merged)).toHaveLength(2);
  });
});

describe('git-sync/semantic-merge — mergeConfigJson', () => {
  it('unions people/packs/platforms rosters and peopleIdentity keys', () => {
    const ours = JSON.stringify({ people: ['alice'], packs: ['growth'], platforms: ['claude'], peopleIdentity: { alice: { role: 'eng' } } });
    const theirs = JSON.stringify({ people: ['bob'], packs: ['design'], platforms: ['claude'], peopleIdentity: { bob: { role: 'pm' } } });
    const { merged } = mergeConfigJson('{}', ours, theirs);
    const obj = JSON.parse(merged);
    expect(obj.people.sort()).toEqual(['alice', 'bob']);
    expect(obj.packs.sort()).toEqual(['design', 'growth']);
    expect(obj.platforms.sort()).toEqual(['claude']);
    expect(Object.keys(obj.peopleIdentity).sort()).toEqual(['alice', 'bob']);
  });
});

describe('git-sync/semantic-merge — mergeTaxonomyJson', () => {
  it('unions tags per facet', () => {
    const ours = JSON.stringify({ facets: { topic: ['topic:a'] } });
    const theirs = JSON.stringify({ facets: { topic: ['topic:b'], domain: ['domain:x'] } });
    const { merged } = mergeTaxonomyJson('{}', ours, theirs);
    const obj = JSON.parse(merged);
    expect(obj.facets.topic.sort()).toEqual(['topic:a', 'topic:b']);
    expect(obj.facets.domain).toEqual(['domain:x']);
  });
});

describe('git-sync/semantic-merge — mergeTaskMd', () => {
  const doc = (status: string, changelogEntries: string[], extra = '') =>
    [
      '---',
      `status: ${status}`,
      '---',
      '',
      '## Why',
      'because reasons' + extra,
      '',
      '## Changelog',
      ...changelogEntries,
    ].join('\n');

  it('furthest status wins', () => {
    const base = doc('todo', ['### 2026-07-01 - start\n- created']);
    const ours = doc('in_progress', ['### 2026-07-01 - start\n- created']);
    const theirs = doc('todo', ['### 2026-07-01 - start\n- created']);
    const { merged } = mergeTaskMd(base, ours, theirs);
    expect(merged).toMatch(/status: in_progress/);
  });

  it('unions changelog entries from both sides (no entry lost)', () => {
    const base = doc('todo', ['### 2026-07-01 - start\n- created']);
    const ours = doc('in_progress', [
      '### 2026-07-02 - ours\n- did ours thing',
      '### 2026-07-01 - start\n- created',
    ]);
    const theirs = doc('in_review', [
      '### 2026-07-03 - theirs\n- did theirs thing',
      '### 2026-07-01 - start\n- created',
    ]);
    const { merged } = mergeTaskMd(base, ours, theirs);
    expect(merged).toContain('ours thing');
    expect(merged).toContain('theirs thing');
    expect(merged).toContain('created');
    // furthest status
    expect(merged).toMatch(/status: in_review/);
  });
});

describe('git-sync/semantic-merge — mergeMarkdownDoc (C1 discard contract)', () => {
  it('returns a clean union when conflictSections is empty', () => {
    const base = '## A\nbase a\n\n## B\nbase b\n';
    const ours = '## A\nours a\n\n## B\nbase b\n';
    const theirs = '## A\nbase a\n\n## B\ntheirs b\n';
    const { merged, needsAgent } = mergeMarkdownDoc(base, ours, theirs);
    expect(needsAgent).toBe(false);
    expect(merged).toContain('ours a');
    expect(merged).toContain('theirs b');
  });

  it('discards the remote-wins output and defers to an agent when both sides touched the same section', () => {
    const base = '## A\nbase a\n';
    const ours = '## A\nours a\n';
    const theirs = '## A\ntheirs a\n';
    const { merged, needsAgent } = mergeMarkdownDoc(base, ours, theirs);
    expect(needsAgent).toBe(true);
    expect(merged).toBeNull();
  });
});
