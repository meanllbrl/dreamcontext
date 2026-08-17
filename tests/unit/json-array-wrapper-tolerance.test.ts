import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildCorpus } from '../../src/lib/recall.js';
import { mergeChangelogJson, mergeReleasesJson } from '../../src/lib/git-sync/semantic-merge.js';

/**
 * Cross-cutting invariant: **every** reader of `core/CHANGELOG.json` and
 * `core/RELEASES.json` reads through a wrapper object, not just the shared
 * `readJsonArray()` helper.
 *
 * The reported bug (a vault scaffolded as `{"entries": []}` / `{"releases":
 * []}`) had two halves. The loud half — `core releases add` throwing "Expected
 * JSON array … got object" — was obvious. The silent half was worse: readers
 * that inlined their own `Array.isArray(parsed)` check answered "nothing here"
 * on a full file and surfaced no error at all, so the vault looked healthy
 * while its history was invisible for nine days.
 *
 * These tests pin the readers that had their own inline parse. A new reader
 * that reintroduces one fails here.
 */

function makeVault(): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dc-wrapper-tolerance-'));
  const root = join(dir, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  return { dir, root };
}

describe('recall indexes a wrapper-shaped CHANGELOG.json', () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    ({ dir, root } = makeVault());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const ENTRIES = [
    { date: '2026-06-24', type: 'feat', scope: 'recall', description: 'Wired the hybrid recall engine' },
    { date: '2026-06-23', type: 'chore', scope: 'project', description: 'Agent context initialized' },
  ];

  it('indexes the same docs whether the file is a bare array or wrapped', () => {
    writeFileSync(join(root, 'core', 'CHANGELOG.json'), JSON.stringify(ENTRIES), 'utf-8');
    const bare = buildCorpus(root, { types: ['changelog'] });

    writeFileSync(join(root, 'core', 'CHANGELOG.json'), JSON.stringify({ entries: ENTRIES }), 'utf-8');
    const wrapped = buildCorpus(root, { types: ['changelog'] });

    expect(bare.length).toBe(ENTRIES.length);
    expect(wrapped.length).toBe(bare.length);
    expect(wrapped.map((d) => d.title)).toEqual(bare.map((d) => d.title));
  });

  it('returns zero docs — not a throw — when the shape cannot be recovered', () => {
    writeFileSync(join(root, 'core', 'CHANGELOG.json'), '{"date": "2026-06-23"}', 'utf-8');
    expect(() => buildCorpus(root, { types: ['changelog'] })).not.toThrow();
    expect(buildCorpus(root, { types: ['changelog'] })).toHaveLength(0);
  });
});

/**
 * The brain-sync merge is the highest-stakes reader: it unions two sides and
 * writes the result back. A side that parsed to `[]` because of its wrapper
 * would be unioned AWAY — silently deleting that machine's whole history.
 */
describe('semantic merge unions a wrapper-shaped side instead of dropping it', () => {
  const OURS = [{ date: '2026-06-23', type: 'chore', scope: 'project', description: 'ours only' }];
  const THEIRS = [{ date: '2026-06-24', type: 'feat', scope: 'api', description: 'theirs only' }];

  it('keeps both sides when OURS is wrapped', () => {
    const { merged } = mergeChangelogJson('', JSON.stringify({ entries: OURS }), JSON.stringify(THEIRS));
    const out = JSON.parse(merged);

    expect(Array.isArray(out)).toBe(true);
    expect(out.map((e: { description: string }) => e.description).sort())
      .toEqual(['ours only', 'theirs only']);
  });

  it('keeps both sides when THEIRS is wrapped', () => {
    const { merged } = mergeChangelogJson('', JSON.stringify(OURS), JSON.stringify({ entries: THEIRS }));
    const out = JSON.parse(merged);

    expect(out.map((e: { description: string }) => e.description).sort())
      .toEqual(['ours only', 'theirs only']);
  });

  it('normalises the merge output to a bare array, ending the wrapper', () => {
    const { merged } = mergeChangelogJson(
      '', JSON.stringify({ entries: OURS }), JSON.stringify({ entries: THEIRS }),
    );
    expect(merged.trimStart().startsWith('[')).toBe(true);
  });

  it('does the same for RELEASES.json', () => {
    const ours = [{ version: 'v0.1.0', summary: 'ours' }];
    const theirs = [{ version: 'v0.2.0', summary: 'theirs' }];
    const { merged } = mergeReleasesJson('', JSON.stringify({ releases: ours }), JSON.stringify(theirs));
    const out = JSON.parse(merged);

    expect(Array.isArray(out)).toBe(true);
    expect(out.map((r: { version: string }) => r.version).sort()).toEqual(['v0.1.0', 'v0.2.0']);
  });
});
