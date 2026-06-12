import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestEntry } from '../../src/lib/federation-ingest.js';
import { readFrontmatter } from '../../src/lib/frontmatter.js';
import { readSleepState } from '../../src/cli/commands/sleep.js';
import { DIGEST_SCHEMA_VERSION, type DigestEntry } from '../../src/lib/federation-inbox.js';

function makeContextRoot(): string {
  const root = join(
    tmpdir(),
    `dc-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    '_dream_context',
  );
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  return root;
}

function makeEntry(over: Partial<DigestEntry> = {}): DigestEntry {
  return {
    version: DIGEST_SCHEMA_VERSION,
    id: 'alpha:knowledge/rate-limiting@2026-06-10',
    origin: {
      vault: 'alpha',
      entryId: 'knowledge/rate-limiting@2026-06-10',
      sourceTimestamp: '2026-06-10',
    },
    kind: 'knowledge',
    title: 'Rate Limiting Strategy',
    summary: 'Token-bucket rate limiting at the gateway layer.',
    recallScore: 2.5,
    links: ['knowledge/rate-limiting.md'],
    ...over,
  };
}

describe('federation-ingest', () => {
  let contextRoot: string;

  beforeEach(() => {
    contextRoot = makeContextRoot();
  });
  afterEach(() => {
    rmSync(join(contextRoot, '..'), { recursive: true, force: true });
  });

  it('writes the ingested entry as knowledge/<slug>.md with federated:true + origin frontmatter', () => {
    const result = ingestEntry(contextRoot, makeEntry());

    expect(result.collided).toBe(false);
    expect(result.slug).toBe('rate-limiting-strategy');
    const expectedPath = join(contextRoot, 'knowledge', 'rate-limiting-strategy.md');
    expect(result.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const { data } = readFrontmatter(expectedPath);
    expect(data.federated).toBe(true);
    expect(data.origin).toMatchObject({
      vault: 'alpha',
      entryId: 'knowledge/rate-limiting@2026-06-10',
      sourceTimestamp: '2026-06-10',
    });
  });

  it('on a slug collision writes knowledge/<slug>--from-<vault>.md and leaves the local doc untouched', () => {
    // Seed a LOCAL doc that the ingested entry's slug would collide with.
    const localPath = join(contextRoot, 'knowledge', 'rate-limiting-strategy.md');
    const localContent = '---\nname: Rate Limiting Strategy\ntype: knowledge\n---\n\nLOCAL CONTENT — do not clobber\n';
    writeFileSync(localPath, localContent, 'utf-8');

    const result = ingestEntry(contextRoot, makeEntry());

    expect(result.collided).toBe(true);
    expect(result.slug).toBe('rate-limiting-strategy--from-alpha');
    const namespaced = join(contextRoot, 'knowledge', 'rate-limiting-strategy--from-alpha.md');
    expect(result.path).toBe(namespaced);
    expect(existsSync(namespaced)).toBe(true);

    // The LOCAL doc content is byte-for-byte unchanged.
    expect(readFileSync(localPath, 'utf-8')).toBe(localContent);

    // The namespaced doc carries the federation provenance.
    const { data } = readFrontmatter(namespaced);
    expect(data.federated).toBe(true);
    expect(data.origin).toMatchObject({ vault: 'alpha' });
  });

  it('a conflict-note entry surfaces a bookmark and does NOT auto-edit any local doc', () => {
    const result = ingestEntry(contextRoot, makeEntry({ kind: 'conflict-note' }));

    expect(result.bookmarked).toBe(true);

    // A salience-3 bookmark referencing the federation entry id is recorded.
    const state = readSleepState(contextRoot);
    expect(state.bookmarks.length).toBeGreaterThanOrEqual(1);
    const bm = state.bookmarks[0];
    expect(bm.salience).toBe(3);
    expect(bm.message).toContain('[federation:alpha:knowledge/rate-limiting@2026-06-10]');

    // The ingested doc is still written as a federated doc (NOT auto-resolved into
    // a local edit) — provenance preserved, no local doc modified.
    const { data } = readFrontmatter(join(contextRoot, 'knowledge', `${result.slug}.md`));
    expect(data.federated).toBe(true);
  });
});
