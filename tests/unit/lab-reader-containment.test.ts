import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createInsight,
  getInsight,
  listInsights,
  readCache,
  resolveContainedLabFile,
  validateManifestForWrite,
  writeCache,
  RESERVED_INSIGHT_SLUGS,
} from '../../src/lib/lab/store.js';
import { resolveBoardFrames, resolveFrame } from '../../src/lib/lab/frames.js';
import { listRejectedLabFiles } from '../../src/lib/lab/block-library.js';
import { LabError, type InsightCache } from '../../src/lib/lab/types.js';

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-contain-'));
  outside = mkdtempSync(join(tmpdir(), 'dc-lab-outside-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const cache = (slug: string): InsightCache => ({
  slug, fetchedAt: '2026-09-01T00:00:00Z', tweaks: {}, granularity: 'daily', unit: null,
  series: [{ name: slug, points: [{ t: '2026-09-01', v: 42 }] }], latest: 42,
  error: null, errorAt: null, scriptHash: null,
});

describe('resolveContainedLabFile', () => {
  it('returns the path for a real contained file, null for absent / unsafe slugs', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(resolveContainedLabFile(root, 'insight', 'wau')).toBe(join(root, 'lab', 'insights', 'wau.md'));
    expect(resolveContainedLabFile(root, 'insight', 'nope')).toBeNull();
    for (const bad of ['../wau', '..%2Fwau', 'a%2Fb', 'lab/insights/wau', 'WAU', '', '.', '..']) {
      expect(resolveContainedLabFile(root, 'insight', bad)).toBeNull();
    }
  });
});

describe('hardened readers', () => {
  it('a symlinked cache yields no data at readCache, frame resolution and a board', () => {
    createInsight(root, { slug: 'leak', title: 'Leak' });
    mkdirSync(join(root, 'lab', 'cache'), { recursive: true });
    writeFileSync(join(outside, 'secret.json'), JSON.stringify(cache('leak')));
    symlinkSync(join(outside, 'secret.json'), join(root, 'lab', 'cache', 'leak.json'));

    expect(readCache(root, 'leak')).toBeNull();
    expect(resolveFrame(root, 'leak', ['series', 'value'])).toMatchObject({ kind: 'empty', reason: 'no-cache' });
    const frames = resolveBoardFrames(root, {
      cards: [{
        id: 'c-leak', at: { x: 0, y: 0, w: 4, h: 3 },
        blocks: [
          { type: 'stat', data: 'leak', options: {} },
          { type: 'html', options: { html: '<p></p>', inputs: { s: 'leak' } } },
        ],
      }],
    });
    expect(frames['c-leak:0']).toMatchObject({ kind: 'empty', reason: 'no-cache' });
    expect(frames['c-leak:1#s']).toMatchObject({ kind: 'empty', reason: 'no-cache' });
  });

  it('a symlinked lab/cache/ directory is refused too', () => {
    createInsight(root, { slug: 'leak', title: 'Leak' });
    writeFileSync(join(outside, 'leak.json'), JSON.stringify(cache('leak')));
    symlinkSync(outside, join(root, 'lab', 'cache'));
    expect(readCache(root, 'leak')).toBeNull();
  });

  it('a symlinked manifest is not an insight (getInsight, listInsights)', () => {
    createInsight(root, { slug: 'real', title: 'Real' });
    writeFileSync(join(outside, 'fake.md'), '---\ntitle: Fake\n---\n');
    symlinkSync(join(outside, 'fake.md'), join(root, 'lab', 'insights', 'fake.md'));
    expect(getInsight(root, 'fake')).toBeNull();
    expect(listInsights(root).map((m) => m.slug)).toEqual(['real']);
  });

  it('../ and %2F bindings are refused at resolve time, before any path is built', () => {
    createInsight(root, { slug: 'ok', title: 'OK' });
    writeCache(root, 'ok', cache('ok'));
    for (const ref of ['../ok', '..%2Fok', 'ok%2F..', '%2e%2e/ok', '../../etc/passwd']) {
      expect(resolveFrame(root, ref, ['series'])).toMatchObject({ kind: 'empty', reason: 'unsafe-ref' });
    }
    expect(readCache(root, '../lab/cache/ok')).toBeNull();
    expect(getInsight(root, '..%2Fok')).toBeNull();
    // The real thing still resolves.
    expect(resolveFrame(root, 'ok', ['series']).kind).toBe('series');
  });
});

describe('listRejectedLabFiles (for lab doctor)', () => {
  it('reports non-kebab and symlinked manifests that every reader skips, without reading them', () => {
    createInsight(root, { slug: 'real', title: 'Real' });
    writeFileSync(join(root, 'lab', 'insights', 'Bad_Slug.md'), '---\ntitle: Bad\n---\n');
    writeFileSync(join(outside, 'fake.md'), '---\ntitle: Fake\n---\n');
    symlinkSync(join(outside, 'fake.md'), join(root, 'lab', 'insights', 'fake.md'));
    writeFileSync(join(root, 'lab', 'insights', 'notes.txt'), 'ignored');

    expect(listInsights(root).map((m) => m.slug)).toEqual(['real']);
    expect(listRejectedLabFiles(root, 'insight')).toEqual([
      { name: 'Bad_Slug', reason: 'unsafe-slug' },
      { name: 'fake', reason: 'symlink' },
    ]);
    expect(listRejectedLabFiles(root, 'cache')).toEqual([]);
  });
});

describe('reserved insight slugs', () => {
  it('lab create refuses route words', () => {
    expect(RESERVED_INSIGHT_SLUGS).toEqual(['b', 'boards', 'blocks', 'caches', 'sync', 'sync-jobs', 'credentials', 'reports']);
    // Removed Reports: an insight named `reports` must never make /api/lab/reports answer.
    expect(() => createInsight(root, { slug: 'reports', title: 'Reports' })).toThrow(/reserved/);
    for (const slug of RESERVED_INSIGHT_SLUGS) {
      expect(() => validateManifestForWrite({ slug, title: 'X' })).toThrow(LabError);
      expect(() => createInsight(root, { slug, title: 'X' })).toThrow(/reserved/);
    }
    expect(() => validateManifestForWrite({ slug: 'boards-growth', title: 'X' })).not.toThrow();
  });
});
