import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCorpus, bm25Search } from '../../src/lib/recall.js';
import { writeDigest, buildDigest } from '../../src/lib/session-digest.js';
import type { DistilledSection } from '../../src/cli/commands/transcript.js';

function makeTmpRoot(): string {
  const dir = join(tmpdir(), `cap-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'state'), { recursive: true });
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  mkdirSync(join(dir, 'core', 'features'), { recursive: true });
  return dir;
}

function distilledFixture(): DistilledSection {
  return {
    userMessages: ['Use the kestrel scheduler for the cron jobs.'],
    agentDecisions: ['Decided to adopt the kestrel scheduler as the cron backbone.'],
    codeChanges: ['WRITE src/kestrel.ts (30 lines)'],
    errors: [],
    bookmarks: [],
  };
}

describe('continuous-capture corpus indexing (C3)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('buildCorpus includes session digests (folded under task) and they are recallable', () => {
    writeDigest(root, 'sess-1', buildDigest(distilledFixture()));

    const corpus = buildCorpus(root);
    const digestDoc = corpus.find(d => d.slug === 'digest#sess-1');
    expect(digestDoc).toBeDefined();
    expect(digestDoc?.type).toBe('task');

    const hits = bm25Search('kestrel scheduler cron', corpus, 5);
    expect(hits.some(h => h.doc.slug === 'digest#sess-1')).toBe(true);
  });

  it('buildCorpus includes .sleep.json bookmarks (folded under memory) and they are recallable', () => {
    const sleep = {
      bookmarks: [
        {
          id: 'bm_abc123',
          message: 'Chose gravastar caching layer for the dashboard hot path.',
          salience: 2,
          created_at: '2026-06-01T10:00:00.000Z',
          session_id: 'sess-1',
          task_slug: 'dashboard-perf',
        },
      ],
    };
    writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify(sleep), 'utf-8');

    const corpus = buildCorpus(root);
    const bmDoc = corpus.find(d => d.slug === 'bookmark#bm_abc123');
    expect(bmDoc).toBeDefined();
    expect(bmDoc?.type).toBe('memory');

    const hits = bm25Search('gravastar caching dashboard', corpus, 5);
    expect(hits[0].doc.slug).toBe('bookmark#bm_abc123');
  });

  it('surfaces BOTH a digest and a bookmark together by keyword', () => {
    writeDigest(root, 'sess-1', buildDigest(distilledFixture()));
    const sleep = {
      bookmarks: [
        {
          id: 'bm_xyz',
          message: 'kestrel scheduler tuned to 4 worker threads.',
          salience: 1,
          created_at: '2026-06-01T11:00:00.000Z',
          session_id: 'sess-1',
          task_slug: null,
        },
      ],
    };
    writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify(sleep), 'utf-8');

    const corpus = buildCorpus(root);
    const hits = bm25Search('kestrel scheduler', corpus, 10);
    const slugs = hits.map(h => h.doc.slug);
    expect(slugs).toContain('digest#sess-1');
    expect(slugs).toContain('bookmark#bm_xyz');
  });

  it('no digests + empty bookmarks → those loaders contribute nothing', () => {
    writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify({ bookmarks: [] }), 'utf-8');
    const corpus = buildCorpus(root);
    expect(corpus.find(d => d.slug.startsWith('digest#'))).toBeUndefined();
    expect(corpus.find(d => d.slug.startsWith('bookmark#'))).toBeUndefined();
  });
});
