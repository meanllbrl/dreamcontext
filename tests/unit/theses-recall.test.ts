import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCorpus, bm25Search } from '../../src/lib/recall.js';
import { writeFrontmatter } from '../../src/lib/frontmatter.js';
import { TYPE_LABELS, parseTypes } from '../../src/cli/commands/memory.js';

// T3 (theses/store.ts) doesn't exist yet — fixtures are written as raw
// theses/<slug>.md frontmatter, mirroring how a real thesis file will look
// (per the proactive-learning-layer plan §A: `claim`/`status`/`kind` frontmatter).

let root: string;

function writeThesisFixture(
  root: string,
  slug: string,
  data: Record<string, unknown>,
  body = '',
): void {
  mkdirSync(join(root, 'theses'), { recursive: true });
  writeFrontmatter(join(root, 'theses', `${slug}.md`), data, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-theses-recall-'));
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('thesis recall — proactive-learning-layer T4', () => {
  it('"thesis" is part of buildCorpus defaults (no --types filter needed)', () => {
    writeThesisFixture(root, 'weekly-digests-improve-retention', {
      claim: 'Weekly digests improve 30-day retention',
      status: 'open',
      kind: 'observational',
    });
    const corpus = buildCorpus(root);
    const thesisDocs = corpus.filter((d) => d.type === 'thesis');
    expect(thesisDocs).toHaveLength(1);
    expect(thesisDocs[0].slug).toBe('weekly-digests-improve-retention');
  });

  it('a thesis with no name/title indexes under its claim text', () => {
    writeThesisFixture(root, 'weekly-digests-improve-retention', {
      claim: 'Weekly digests improve 30-day retention',
      status: 'open',
      kind: 'observational',
    });
    const corpus = buildCorpus(root, { types: ['thesis'] });
    expect(corpus).toHaveLength(1);
    expect(corpus[0].title).toBe('Weekly digests improve 30-day retention');
  });

  it('a `name`/`title` frontmatter field still wins over `claim` (fallback order preserved)', () => {
    writeThesisFixture(root, 'has-explicit-title', {
      title: 'Explicit Title Wins',
      claim: 'This claim should be shadowed by the explicit title',
      status: 'draft',
      kind: 'experimental',
    });
    const corpus = buildCorpus(root, { types: ['thesis'] });
    expect(corpus[0].title).toBe('Explicit Title Wins');
  });

  it('a claim-phrase query surfaces the thesis when scoped --types thesis', () => {
    writeThesisFixture(
      root,
      'weekly-digests-improve-retention',
      {
        claim: 'Weekly digests improve 30-day retention',
        status: 'open',
        kind: 'observational',
      },
      'Users who receive a weekly digest email show higher 30-day retention than those who do not.',
    );
    const corpus = buildCorpus(root, { types: ['thesis'] });
    const hits = bm25Search('weekly digests retention', corpus);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.slug).toBe('weekly-digests-improve-retention');
  });

  it('missing theses/ directory degrades to an empty thesis corpus (no throw)', () => {
    const corpus = buildCorpus(root, { types: ['thesis'] });
    expect(corpus).toEqual([]);
  });

  it('memory.ts TYPE_LABELS carries a thesis entry', () => {
    expect(TYPE_LABELS.thesis).toBe('thesis');
  });

  it('memory.ts parseTypes accepts "thesis" (alone and mixed with other types)', () => {
    expect(parseTypes('thesis')).toEqual(['thesis']);
    expect(parseTypes('task,thesis')).toEqual(['task', 'thesis']);
    // Unknown types are dropped, not fatal.
    expect(parseTypes('thesis,bogus')).toEqual(['thesis']);
  });
});
