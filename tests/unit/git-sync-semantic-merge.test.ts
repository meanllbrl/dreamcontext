import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import * as gitMock from '../../src/lib/git-sync/git.js';
import {
  classifyPath,
  mergeChangelogJson,
  mergeReleasesJson,
  mergeConfigJson,
  mergeTaxonomyJson,
  mergeTasksMapJson,
  mergeTaskMd,
  mergeMarkdownDoc,
  resolveConflicts,
} from '../../src/lib/git-sync/semantic-merge.js';

/**
 * `resolveConflicts` calls `readOursTheirsBase`/`addPath` (git.ts), which shell
 * out to `git show :<stage>:<path>` against an in-progress merge — there is no
 * precedent in this file for standing up a real git fixture, so it's mocked.
 * Fixtures are keyed by path and set per-test via `__setFixture`.
 */
vi.mock('../../src/lib/git-sync/git.js', () => {
  const fixtures = new Map<string, { base: string; ours: string; theirs: string }>();
  return {
    __setFixture: (path: string, v: { base: string; ours: string; theirs: string }) => fixtures.set(path, v),
    __clearFixtures: () => fixtures.clear(),
    readOursTheirsBase: (_cwd: string, path: string) => fixtures.get(path) ?? { base: '', ours: '', theirs: '' },
    addPath: () => {},
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setFixture = (gitMock as any).__setFixture as (path: string, v: { base: string; ours: string; theirs: string }) => void;

/** Fresh tmp dir with a `state/` subfolder, mirroring the brain repo layout. */
function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'dc-semantic-merge-'));
  mkdirSync(join(cwd, 'state'), { recursive: true });
  return cwd;
}

function taskDoc(id: string, status: string): string {
  return matter.stringify(`## Why\nbecause reasons\n`, { id, status, name: id });
}

describe('git-sync/semantic-merge — classifyPath', () => {
  it('classifies every known class, with or without the in-tree _dream_context/ prefix', () => {
    expect(classifyPath('core/CHANGELOG.json')).toBe('changelog-json');
    expect(classifyPath('_dream_context/core/CHANGELOG.json')).toBe('changelog-json');
    expect(classifyPath('core/RELEASES.json')).toBe('releases-json');
    expect(classifyPath('state/.config.json')).toBe('config-json');
    expect(classifyPath('core/taxonomy.json')).toBe('taxonomy-json');
    expect(classifyPath('state/.tasks-map.json')).toBe('tasks-map-json');
    expect(classifyPath('_dream_context/state/.tasks-map.json')).toBe('tasks-map-json');
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

describe('git-sync/semantic-merge — mergeTasksMapJson (#204 map merge class)', () => {
  it('A2: unions distinct entries added on each side, sorted by slug, valid JSON with trailing newline', () => {
    const ours = JSON.stringify([{ slug: 'alpha', dcId: 'task_A', backend: 'clickup', remoteId: 'R1' }]);
    const theirs = JSON.stringify([{ slug: 'beta', dcId: 'task_B', backend: 'clickup', remoteId: 'R2' }]);
    const { merged } = mergeTasksMapJson('[]', ours, theirs);
    expect(merged.endsWith('\n')).toBe(true);
    const arr = JSON.parse(merged);
    expect(arr.map((e: { slug: string }) => e.slug)).toEqual(['alpha', 'beta']);
  });

  it('A3: same remoteId under two different slugs collapses to exactly one entry, deterministically regardless of side order', () => {
    const sideA = JSON.stringify([{ slug: 'foo', dcId: 'task_A', backend: 'clickup', remoteId: 'R1' }]);
    const sideB = JSON.stringify([{ slug: 'foo-renamed', dcId: 'task_A', backend: 'clickup', remoteId: 'R1' }]);
    const forward = JSON.parse(mergeTasksMapJson('[]', sideA, sideB).merged);
    const swapped = JSON.parse(mergeTasksMapJson('[]', sideB, sideA).merged);
    expect(forward).toHaveLength(1);
    expect(swapped).toHaveLength(1);
    expect(forward[0].remoteId).toBe('R1');
    expect(forward).toEqual(swapped); // order-independent
  });

  it('A5: same-slug collision across DISTINCT remoteIds keeps BOTH entries — bare slug to the smaller dcId, byte-identical regardless of side order', () => {
    const sideA = JSON.stringify([{ slug: 'foo', dcId: 'task_AAA', backend: 'clickup', remoteId: 'R2' }]);
    const sideB = JSON.stringify([{ slug: 'foo', dcId: 'task_BBB', backend: 'clickup', remoteId: 'R1' }]);
    const forward = mergeTasksMapJson('[]', sideA, sideB).merged;
    const swapped = mergeTasksMapJson('[]', sideB, sideA).merged;
    expect(forward).toBe(swapped); // byte-identical regardless of ours/theirs order
    const arr = JSON.parse(forward);
    expect(arr).toHaveLength(2);
    const bare = arr.find((e: { slug: string }) => e.slug === 'foo');
    const suffixed = arr.find((e: { slug: string }) => e.slug === 'foo-2');
    expect(bare.dcId).toBe('task_AAA'); // smaller dcId keeps the bare slug
    expect(suffixed.dcId).toBe('task_BBB');
    expect(bare.remoteId).toBe('R2');
    expect(suffixed.remoteId).toBe('R1');
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

  it('A7: same-task merge (equal id, real base) is unaffected — sibling is null, no spurious split', () => {
    const base = doc('todo', ['### 2026-07-01 - start\n- created']);
    const ours = matter.stringify(matter(doc('in_progress', ['### 2026-07-01 - start\n- created'])).content, {
      status: 'in_progress',
      id: 'task_SAME',
    });
    const theirs = matter.stringify(matter(doc('todo', ['### 2026-07-01 - start\n- created'])).content, {
      status: 'todo',
      id: 'task_SAME',
    });
    const result = mergeTaskMd(base, ours, theirs);
    expect(result.sibling).toBeNull();
    expect(result.merged).toMatch(/status: in_progress/);
  });

  it('A6 (unit): add/add of two DISTINCT tasks (no base, differing dcId) splits — smaller dcId keeps the bare content verbatim, larger becomes the sibling verbatim', () => {
    const ours = taskDoc('task_AAA', 'todo');
    const theirs = taskDoc('task_CCC', 'todo');
    const result = mergeTaskMd('', ours, theirs);
    expect(result.merged).toBe(ours); // verbatim — not re-stringified
    expect(result.sibling).toEqual({ content: theirs });
  });

  it('A6 (unit, order-independent): the smaller dcId always keeps the bare slug regardless of which side is ours/theirs', () => {
    const smaller = taskDoc('task_AAA', 'todo');
    const larger = taskDoc('task_CCC', 'todo');
    const forward = mergeTaskMd('', smaller, larger);
    const swapped = mergeTaskMd('', larger, smaller);
    expect(forward.merged).toBe(smaller);
    expect(forward.sibling).toEqual({ content: larger });
    expect(swapped.merged).toBe(smaller);
    expect(swapped.sibling).toEqual({ content: larger });
  });

  it('missing id on one side never triggers the add/add split (falls through to the ordinary merge)', () => {
    const ours = matter.stringify('## Why\nno id here\n', { status: 'todo' });
    const theirs = taskDoc('task_CCC', 'todo');
    const result = mergeTaskMd('', ours, theirs);
    expect(result.sibling).toBeNull();
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

describe('git-sync/semantic-merge — resolveConflicts: tasks-map-json (A4)', () => {
  it('a conflicted state/.tasks-map.json is resolved deterministically and staged — NEVER deferred to the agent, no markers survive', () => {
    const cwd = makeCwd();
    const ours = JSON.stringify([{ slug: 'alpha', dcId: 'task_A', backend: 'clickup', remoteId: 'R1' }]);
    const theirs = JSON.stringify([{ slug: 'beta', dcId: 'task_B', backend: 'clickup', remoteId: 'R2' }]);
    setFixture('state/.tasks-map.json', { base: '[]', ours, theirs });

    const r = resolveConflicts(cwd, ['state/.tasks-map.json']);

    expect(r.deferredToAgent).toEqual([]);
    expect(r.deferredToHuman).toEqual([]);
    expect(r.resolved).toEqual(['state/.tasks-map.json']);
    const written = readFileSync(join(cwd, 'state/.tasks-map.json'), 'utf-8');
    expect(written).not.toContain('<<<<<<<');
    const arr = JSON.parse(written);
    expect(arr.map((e: { slug: string }) => e.slug)).toEqual(['alpha', 'beta']);
  });
});

describe('git-sync/semantic-merge — resolveConflicts: task-md add/add split (A6, mocked git)', () => {
  it('materializes BOTH files — keeper at the original path, sibling at the next free -N — each with its own id/body, no hybrid', () => {
    const cwd = makeCwd();
    const ours = taskDoc('task_AAA', 'todo'); // smaller dcId -> keeps state/foo.md
    const theirs = taskDoc('task_CCC', 'todo'); // larger dcId -> sibling
    setFixture('state/foo.md', { base: '', ours, theirs });

    const r = resolveConflicts(cwd, ['state/foo.md']);

    expect(r.deferredToAgent).toEqual([]);
    expect(r.resolved.slice().sort()).toEqual(['state/foo-2.md', 'state/foo.md']);
    expect(readFileSync(join(cwd, 'state/foo.md'), 'utf-8')).toBe(ours);
    expect(readFileSync(join(cwd, 'state/foo-2.md'), 'utf-8')).toBe(theirs);
    expect(matter(readFileSync(join(cwd, 'state/foo.md'), 'utf-8')).data.id).toBe('task_AAA');
    expect(matter(readFileSync(join(cwd, 'state/foo-2.md'), 'utf-8')).data.id).toBe('task_CCC');
  });
});

describe('git-sync/semantic-merge — resolveConflicts: dcId cross-mechanism agreement (A8)', () => {
  it('a simultaneous .tasks-map.json collision and matching state/foo.md add/add agree — every file id equals its map entry dcId', () => {
    const cwd = makeCwd();

    // Map side: same slug 'foo', distinct remoteIds, distinct dcIds — the exact
    // #204 collision unionTaskMap resolves by dcId ascending.
    const mapOurs = JSON.stringify([{ slug: 'foo', dcId: 'task_AAA', backend: 'clickup', remoteId: 'R2' }]);
    const mapTheirs = JSON.stringify([{ slug: 'foo', dcId: 'task_BBB', backend: 'clickup', remoteId: 'R1' }]);
    setFixture('state/.tasks-map.json', { base: '[]', ours: mapOurs, theirs: mapTheirs });

    // File side: same add/add, same two dcIds — mergeTaskMd's keeper choice is
    // the SAME dcId-ascending order as unionTaskMap's pass 2, by construction.
    const fileOurs = taskDoc('task_AAA', 'todo');
    const fileTheirs = taskDoc('task_BBB', 'todo');
    setFixture('state/foo.md', { base: '', ours: fileOurs, theirs: fileTheirs });

    const r = resolveConflicts(cwd, ['state/.tasks-map.json', 'state/foo.md']);
    expect(r.deferredToAgent).toEqual([]);

    const map = JSON.parse(readFileSync(join(cwd, 'state/.tasks-map.json'), 'utf-8'));
    const bareEntry = map.find((e: { slug: string }) => e.slug === 'foo');
    const suffixedEntry = map.find((e: { slug: string }) => e.slug === 'foo-2');

    const bareFileId = matter(readFileSync(join(cwd, 'state/foo.md'), 'utf-8')).data.id;
    const suffixedFileId = matter(readFileSync(join(cwd, 'state/foo-2.md'), 'utf-8')).data.id;

    expect(bareFileId).toBe(bareEntry.dcId); // no cross-wiring
    expect(suffixedFileId).toBe(suffixedEntry.dcId);
    expect(bareEntry.dcId).toBe('task_AAA');
    expect(suffixedEntry.dcId).toBe('task_BBB');
  });
});

describe('git-sync/semantic-merge — resolveConflicts: task-md sibling-suffix determinism (shuffle invariance)', () => {
  it('two colliding task-md conflicts in one batch resolve to the SAME file assignment regardless of input order', () => {
    // 'state/foo.md' is an add/add split whose sibling would normally want
    // 'state/foo-2.md' — but 'state/foo-2.md' is ITSELF a distinct conflicted
    // path in the same batch (a genuinely different, ordinary same-task merge).
    // Lexically 'state/foo-2.md' < 'state/foo.md', so sorted task-md processing
    // ALWAYS resolves foo-2.md first, forcing foo.md's sibling to 'state/foo-3.md'
    // — deterministic no matter which order the caller lists the two conflicts in.
    const fooOurs = taskDoc('task_AAA', 'todo');
    const fooTheirs = taskDoc('task_CCC', 'todo');
    const foo2Content = taskDoc('task_ZZZ', 'todo'); // same dcId both sides -> ordinary merge, not a split

    const run = (order: string[]) => {
      const cwd = makeCwd();
      setFixture('state/foo.md', { base: '', ours: fooOurs, theirs: fooTheirs });
      setFixture('state/foo-2.md', { base: foo2Content, ours: foo2Content, theirs: foo2Content });
      const r = resolveConflicts(cwd, order);
      return {
        resolved: r.resolved.slice().sort(),
        foo: readFileSync(join(cwd, 'state/foo.md'), 'utf-8'),
        foo2: readFileSync(join(cwd, 'state/foo-2.md'), 'utf-8'),
        foo3: readFileSync(join(cwd, 'state/foo-3.md'), 'utf-8'),
      };
    };

    const forward = run(['state/foo.md', 'state/foo-2.md']);
    const shuffled = run(['state/foo-2.md', 'state/foo.md']);

    expect(forward).toEqual(shuffled);
    expect(forward.resolved).toEqual(['state/foo-2.md', 'state/foo-3.md', 'state/foo.md']);
    expect(forward.foo).toBe(fooOurs); // keeper (smaller dcId) unaffected by the collision
    expect(forward.foo3).toBe(fooTheirs); // bumped to -3 because -2 was already taken this pass
  });
});
