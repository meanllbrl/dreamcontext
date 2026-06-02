import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DistilledSection } from '../../src/cli/commands/transcript.js';
import {
  buildDigest,
  writeDigest,
  digestExists,
  loadDigestDocs,
} from '../../src/lib/session-digest.js';
import { bm25Search } from '../../src/lib/recall.js';

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `digest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

function fixtureDistilled(overrides: Partial<DistilledSection> = {}): DistilledSection {
  return {
    userMessages: ['No, use Postgres instead of MongoDB for the user table.'],
    agentDecisions: [
      '[thinking] I should weigh the tradeoffs between SQL and NoSQL here carefully.',
      'Decided to switch the persistence layer to Postgres for relational integrity.',
    ],
    codeChanges: [
      'WRITE src/db/postgres.ts (40 lines)\nimport { Pool } from "pg";\nexport const pool = new Pool();',
    ],
    errors: ['Error: connection refused to MongoDB on port 27017'],
    bookmarks: [],
    ...overrides,
  };
}

describe('buildDigest', () => {
  it('includes user corrections and decisions', () => {
    const md = buildDigest(fixtureDistilled());
    expect(md).toContain('Postgres instead of MongoDB');
    expect(md).toContain('switch the persistence layer to Postgres');
  });

  it('excludes [thinking] internal reasoning', () => {
    const md = buildDigest(fixtureDistilled());
    expect(md).not.toContain('[thinking]');
    expect(md).not.toContain('weigh the tradeoffs');
  });

  it('keeps only code-change headers, not full diffs', () => {
    const md = buildDigest(fixtureDistilled());
    expect(md).toContain('WRITE src/db/postgres.ts');
    expect(md).not.toContain('import { Pool }');
  });

  it('stays within maxBytes even with oversized input', () => {
    const huge: DistilledSection = {
      userMessages: Array.from({ length: 200 }, (_, i) => `message ${i} `.repeat(80)),
      agentDecisions: Array.from({ length: 200 }, (_, i) => `decision ${i} `.repeat(80)),
      codeChanges: Array.from({ length: 200 }, (_, i) => `WRITE file${i}.ts (10 lines)\n${'x'.repeat(500)}`),
      errors: Array.from({ length: 200 }, (_, i) => `Error ${i} `.repeat(80)),
      bookmarks: [],
    };
    const md = buildDigest(huge, { maxBytes: 2000 });
    expect(Buffer.byteLength(md, 'utf-8')).toBeLessThanOrEqual(2000);
  });

  it('produces a non-empty digest with the header', () => {
    const md = buildDigest(fixtureDistilled());
    expect(md).toContain('# Session Digest');
    expect(md.trim().length).toBeGreaterThan(0);
  });
});

describe('writeDigest / digestExists / loadDigestDocs', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writeDigest creates a file and digestExists detects it', () => {
    expect(digestExists(root, 'sess-abc')).toBe(false);
    const md = buildDigest(fixtureDistilled());
    const path = writeDigest(root, 'sess-abc', md);
    expect(existsSync(path)).toBe(true);
    expect(digestExists(root, 'sess-abc')).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('type: session-digest');
  });

  it('loadDigestDocs surfaces digest content as a recallable task doc', () => {
    const md = buildDigest(fixtureDistilled());
    writeDigest(root, 'sess-abc', md);

    const docs = loadDigestDocs(root);
    expect(docs.length).toBe(1);
    expect(docs[0].type).toBe('task');
    expect(docs[0].slug).toBe('digest#sess-abc');

    const hits = bm25Search('Postgres persistence layer', docs, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.slug).toBe('digest#sess-abc');
  });

  it('returns empty array when no digests directory exists', () => {
    expect(loadDigestDocs(root)).toEqual([]);
  });

  it('flags every digest as a capture (C3 rank-penalty target)', () => {
    writeDigest(root, 'sess-cap', buildDigest(fixtureDistilled()));
    const docs = loadDigestDocs(root);
    expect(docs.length).toBe(1);
    expect(docs[0].capture).toBe(true);
  });

  it('caps the indexed set to the 50 MOST-RECENT digests (C3, by created_at desc)', () => {
    // Write 60 digests with explicit, monotonically increasing created_at dates
    // so recency order is unambiguous. session-NN with NN = day-of-month.
    const dir = join(root, 'state', '.session-digests');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 60; i++) {
      const day = String(i + 1).padStart(2, '0'); // 01..60 → valid through Mar
      const date = new Date(2026, 0, i + 1).toISOString(); // Jan 1 + i days
      const fm = [
        '---',
        'type: session-digest',
        `session_id: sess-${day}`,
        `created_at: ${date}`,
        '---',
        '',
        `# Session Digest\n\n## Decisions\n- decision number ${i} about widget ${i}`,
      ].join('\n');
      writeFileSync(join(dir, `sess-${day}.md`), fm, 'utf-8');
    }

    const docs = loadDigestDocs(root);
    // Exactly K=50 survive the cap.
    expect(docs.length).toBe(50);
    // The OLDEST 10 (sess-01..sess-10) are dropped; the NEWEST (sess-60) is kept.
    const slugs = new Set(docs.map((d) => d.slug));
    expect(slugs.has('digest#sess-60')).toBe(true);
    expect(slugs.has('digest#sess-51')).toBe(true);
    expect(slugs.has('digest#sess-10')).toBe(false);
    expect(slugs.has('digest#sess-01')).toBe(false);
  });
});
