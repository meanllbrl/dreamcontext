import { describe, it, expect } from 'vitest';
import {
  classifyPath,
  mergeChangelogJson,
  mergeReleasesJson,
  mergeConfigJson,
  mergeTaxonomyJson,
  mergeTaskMd,
  mergeMarkdownDoc,
} from '../../src/lib/git-sync/semantic-merge.js';

describe('git-sync/semantic-merge — classifyPath', () => {
  it('classifies every known class, with or without the in-tree _dream_context/ prefix', () => {
    expect(classifyPath('core/CHANGELOG.json')).toBe('changelog-json');
    expect(classifyPath('_dream_context/core/CHANGELOG.json')).toBe('changelog-json');
    expect(classifyPath('core/RELEASES.json')).toBe('releases-json');
    expect(classifyPath('state/.config.json')).toBe('config-json');
    expect(classifyPath('core/taxonomy.json')).toBe('taxonomy-json');
    expect(classifyPath('state/my-task.md')).toBe('task-md');
    expect(classifyPath('core/features/thing.md')).toBe('feature-md');
    expect(classifyPath('knowledge/topic.md')).toBe('knowledge-md');
    expect(classifyPath('README.md')).toBe('other');
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
    const theirs = JSON.stringify({ people: ['bob'], packs: ['design'], platforms: ['codex'], peopleIdentity: { bob: { role: 'pm' } } });
    const { merged } = mergeConfigJson('{}', ours, theirs);
    const obj = JSON.parse(merged);
    expect(obj.people.sort()).toEqual(['alice', 'bob']);
    expect(obj.packs.sort()).toEqual(['design', 'growth']);
    expect(obj.platforms.sort()).toEqual(['claude', 'codex']);
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
