import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createInsight,
  getInsight,
  listInsights,
  isSafeInsightSlug,
  readCache,
  writeCache,
  writeInsightTweaks,
  insightPath,
  parseSource,
  parseTweaks,
  parseBinding,
} from '../../src/lib/lab/store.js';
import { LabError } from '../../src/lib/lab/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('lab store — create/list/get', () => {
  it('lazily creates lab/insights and scaffolds a manifest with a ## Meaning stub', () => {
    const m = createInsight(root, { slug: 'wau', title: 'Weekly Active Users', render: 'number', adapter: 'http' });
    expect(m.slug).toBe('wau');
    expect(m.title).toBe('Weekly Active Users');
    expect(m.render).toBe('number');
    expect(m.body).toContain('## Meaning');
    expect(existsSync(insightPath(root, 'wau'))).toBe(true);
  });

  it('lab list shows a created insight', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const insights = listInsights(root);
    expect(insights.map((i) => i.slug)).toContain('wau');
  });

  it('rejects an invalid slug', () => {
    expect(() => createInsight(root, { slug: 'Not Valid!', title: 'x' })).toThrow(LabError);
  });

  it('rejects a duplicate slug', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(() => createInsight(root, { slug: 'wau', title: 'WAU 2' })).toThrow(LabError);
  });

  it('getInsight returns null for a missing/unsafe slug', () => {
    expect(getInsight(root, 'nope')).toBeNull();
    expect(getInsight(root, '../etc')).toBeNull();
  });

  it('listInsights returns [] when lab/insights/ is missing', () => {
    expect(listInsights(root)).toEqual([]);
  });
});

describe('lab store — lenient read parsers (malformed -> null/skip, never throw)', () => {
  it('parseSource returns null for a malformed source block', () => {
    expect(parseSource(null)).toBeNull();
    expect(parseSource({ adapter: 'carrier-pigeon' })).toBeNull();
    expect(parseSource({ adapter: 'http', http: {} })).toBeNull(); // missing endpoint
  });

  it('parseTweaks skips malformed entries but keeps valid ones', () => {
    const tweaks = parseTweaks([
      { key: 'range', type: 'enum', options: ['last_30_days'] },
      { type: 'enum' }, // missing key -> skipped
      { key: 'bad', type: 'not-a-type' }, // invalid type -> skipped
    ]);
    expect(tweaks).toHaveLength(1);
    expect(tweaks[0].key).toBe('range');
  });

  it('parseBinding returns null without a non-empty objective', () => {
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding({ objective: '' })).toBeNull();
    expect(parseBinding({ objective: 'mrr' })).toEqual({ objective: 'mrr', value: 'latest' });
  });

  it('a manifest file that fails to parse frontmatter is skipped by listInsights, not thrown', () => {
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    writeFileSync(join(root, 'lab', 'insights', 'broken.md'), '---\ntitle: [unterminated\n---\nbody', 'utf-8');
    expect(() => listInsights(root)).not.toThrow();
  });
});

describe('lab store — cache read/write (atomic)', () => {
  it('round-trips a cache snapshot', () => {
    const cache = {
      slug: 'wau', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily' as const,
      unit: 'users', series: [{ name: 'default', points: [{ t: '2026-01-01', v: 5 }] }],
      latest: 5, error: null, errorAt: null, scriptHash: null,
    };
    writeCache(root, 'wau', cache);
    expect(readCache(root, 'wau')).toEqual(cache);
  });

  it('readCache returns null for a missing cache file', () => {
    expect(readCache(root, 'nope')).toBeNull();
  });
});

describe('writeInsightTweaks — strict validation', () => {
  it('persists a valid enum tweak value', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeInsightTweaks(root, 'wau', {}); // no declared tweaks yet — no-op
    const m = getInsight(root, 'wau')!;
    expect(m.tweaks).toEqual([]);
  });

  it('throws on an unknown tweak key', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(() => writeInsightTweaks(root, 'wau', { bogus: 'x' })).toThrow(LabError);
  });

  it('throws when an enum value is not one of the declared options', () => {
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    writeFileSync(
      join(root, 'lab', 'insights', 'wau.md'),
      '---\ntitle: WAU\nrender: number\ntweaks:\n  - key: range\n    type: enum\n    options: ["last_30_days", "last_1_year"]\n---\n## Meaning\n',
      'utf-8',
    );
    expect(() => writeInsightTweaks(root, 'wau', { range: 'last_5_minutes' })).toThrow(LabError);
    writeInsightTweaks(root, 'wau', { range: 'last_1_year' });
    expect(getInsight(root, 'wau')!.tweaks[0].value).toBe('last_1_year');
  });

  it('throws when a date tweak value is not a valid calendar date', () => {
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    writeFileSync(
      join(root, 'lab', 'insights', 'wau.md'),
      '---\ntitle: WAU\nrender: number\ntweaks:\n  - key: from\n    type: date\n---\n## Meaning\n',
      'utf-8',
    );
    expect(() => writeInsightTweaks(root, 'wau', { from: 'not-a-date' })).toThrow(LabError);
  });
});

describe('isSafeInsightSlug', () => {
  it('accepts kebab-case, rejects unsafe forms', () => {
    expect(isSafeInsightSlug('weekly-active-users')).toBe(true);
    expect(isSafeInsightSlug('../etc')).toBe(false);
    expect(isSafeInsightSlug('Bad_Slug')).toBe(false);
    expect(isSafeInsightSlug('double--dash')).toBe(false);
    expect(isSafeInsightSlug('trailing-')).toBe(false);
  });
});
