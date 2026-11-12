import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  splitChangelog,
  joinChangelog,
  planCompaction,
  compactFeature,
  cutoffDate,
  oversizedPrds,
  archivePathFor,
  COMPACT_POINTER_MARK,
} from '../../src/lib/feature-compact.js';

/**
 * SL-4: a PRD's old Changelog entries MOVE to a dated archive. The archive is written and read
 * back before the PRD changes, every byte that leaves the PRD is in the archive, and an undated
 * or recent entry (or one of the newest five) never moves.
 */

const PRD = [
  '---',
  'name: checkout',
  'type: feature',
  '---',
  '',
  '## Why',
  'Because.',
  '',
  '## Changelog',
  '',
  '### 2026-11-10 - Newest',
  '- n',
  '',
  '### 2026-09-15 — September work',
  '- s1',
  '- s2',
  '',
  '### Undated note',
  '- u',
  '',
  '### 2026-07-02 - July work',
  '- j',
  '',
  '## Notes',
  'after the changelog',
  '',
].join('\n');

let root: string;
let prd: string;
beforeEach(() => {
  root = join(tmpdir(), `feature-compact-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'knowledge', 'features'), { recursive: true });
  prd = join(root, 'knowledge', 'features', 'checkout.md');
  writeFileSync(prd, PRD);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('splitting is lossless', () => {
  it('splits into head, entries and tail, and joins back byte for byte', () => {
    const s = splitChangelog(PRD)!;
    expect(s.entries.map((e) => e.date)).toEqual(['2026-11-10', '2026-09-15', null, '2026-07-02']);
    expect(s.tail.startsWith('## Notes')).toBe(true);
    expect(joinChangelog(s)).toBe(PRD);
  });

  it('a PRD with no Changelog is left alone', () => {
    expect(splitChangelog('## Why\nx\n')).toBeNull();
  });
});

describe('what moves', () => {
  it('only dated entries before the cutoff, never the newest N, never an undated one', () => {
    const s = splitChangelog(PRD)!;
    const p = planCompaction(s.entries, '2026-10-01', 1);
    expect(p.move.map((e) => e.date)).toEqual(['2026-09-15', '2026-07-02']);
    expect(p.keep.map((e) => e.date)).toEqual(['2026-11-10', null]);
    expect([...p.byMonth.keys()]).toEqual(['2026-09', '2026-07']);
  });

  it('keep protects the newest entries even when they are old', () => {
    const s = splitChangelog(PRD)!;
    expect(planCompaction(s.entries, '2099-01-01', 5).move).toEqual([]);
    expect(planCompaction(s.entries, '2099-01-01', 2).move.map((e) => e.date)).toEqual(['2026-07-02']);
  });
});

describe('compactFeature', () => {
  const opts = { cutoff: '2026-10-01', keepNewest: 1, today: '2026-11-12' };

  it('moves the entries into month archives, adds one pointer, and loses nothing', () => {
    const r = compactFeature(root, 'checkout', prd, opts);
    expect(r).toMatchObject({ moved: 2, skipped: null });
    const after = readFileSync(prd, 'utf-8');
    const sept = readFileSync(archivePathFor(root, 'checkout', '2026-09'), 'utf-8');
    const july = readFileSync(archivePathFor(root, 'checkout', '2026-07'), 'utf-8');
    expect(after).toContain(COMPACT_POINTER_MARK);
    expect(after).toContain('### 2026-11-10 - Newest');
    expect(after).toContain('### Undated note');
    expect(after).not.toContain('September work');
    expect(after).toContain('## Notes\nafter the changelog');
    expect(sept).toContain('### 2026-09-15 — September work\n- s1\n- s2');
    expect(sept).toMatch(/^---\nname: checkout-2026-09\ntype: knowledge\n/);
    expect(july).toContain('### 2026-07-02 - July work\n- j');
    // Every line that left the PRD is in an archive.
    for (const line of PRD.split('\n').filter((l) => l && !after.includes(l))) {
      expect(sept + july).toContain(line);
    }
  });

  it('is idempotent: a second run moves nothing and adds no second pointer', () => {
    compactFeature(root, 'checkout', prd, opts);
    const once = readFileSync(prd, 'utf-8');
    const r = compactFeature(root, 'checkout', prd, opts);
    expect(r.skipped).toBe('no entry old enough to move');
    expect(readFileSync(prd, 'utf-8')).toBe(once);
  });

  it('appends to an existing month archive without duplicating an entry already there', () => {
    compactFeature(root, 'checkout', prd, opts);
    const sept = archivePathFor(root, 'checkout', '2026-09');
    const before = readFileSync(sept, 'utf-8');
    writeFileSync(prd, PRD); // the same old entry shows up again (e.g. restored from git)
    compactFeature(root, 'checkout', prd, opts);
    expect(readFileSync(sept, 'utf-8')).toBe(before);
    expect(readFileSync(prd, 'utf-8')).not.toContain('September work');
  });

  it('dry run writes nothing', () => {
    const r = compactFeature(root, 'checkout', prd, { ...opts, dryRun: true });
    expect(r.moved).toBe(2);
    expect(readFileSync(prd, 'utf-8')).toBe(PRD);
    expect(existsSync(join(root, 'knowledge', 'archive'))).toBe(false);
  });

  it('a symlinked archive folder is refused and the PRD stays as it was', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(root, 'knowledge', 'archive'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'knowledge', 'archive', 'features'));
    expect(() => compactFeature(root, 'checkout', prd, opts)).toThrow(/symlink/);
    expect(readFileSync(prd, 'utf-8')).toBe(PRD);
  });

  it('a ### or ## line inside a fenced code block is not a heading (review round 1)', () => {
    const doc = [
      '## Changelog', '',
      '### 2025-01-01 - Old entry with code', '```md', '### not a heading', '## nor this', '```', 'after the fence', '',
      '### 2026-11-10 - New', '- n', '',
      '## Notes', 'x', '',
    ].join('\n');
    writeFileSync(prd, doc);
    const s = splitChangelog(doc)!;
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0].text).toContain('after the fence');
    expect(s.tail.startsWith('## Notes')).toBe(true);
    compactFeature(root, 'checkout', prd, { cutoff: '2026-01-01', keepNewest: 1, today: '2026-11-12' });
    const after = readFileSync(prd, 'utf-8');
    expect(after).not.toContain('not a heading');
    expect((after.match(/```/g) ?? []).length % 2).toBe(0);
    expect(readFileSync(archivePathFor(root, 'checkout', '2025-01'), 'utf-8')).toContain('### not a heading\n## nor this\n```\nafter the fence');
  });

  it('a PRD reached through a symlinked feature folder is refused, the outside file untouched (review round 1)', () => {
    const outside = join(root, 'other-checkout');
    mkdirSync(outside);
    const outsidePrd = join(outside, 'x.md');
    writeFileSync(outsidePrd, PRD);
    symlinkSync(outside, join(root, 'knowledge', 'features', 'linked'));
    expect(() => compactFeature(root, 'linked/x', join(root, 'knowledge', 'features', 'linked', 'x.md'), opts)).toThrow(/symlink/);
    expect(readFileSync(outsidePrd, 'utf-8')).toBe(PRD);
  });

  it('a nested feature gets a flat archive name', () => {
    expect(archivePathFor(root, 'lina/checkout', '2026-09')).toBe(join(root, 'knowledge', 'archive', 'features', 'lina-checkout-2026-09.md'));
  });
});

describe('helpers', () => {
  it('cutoffDate counts days back', () => {
    expect(cutoffDate(new Date('2026-11-12T12:00:00Z'), 30)).toBe('2026-10-13');
  });

  it('oversizedPrds keeps only files over the size, largest first', () => {
    const small = join(root, 'small.md');
    writeFileSync(small, 'x');
    const big = oversizedPrds([{ feature: 'checkout', path: prd }, { feature: 'small', path: small }], 10);
    expect(big.map((b) => b.feature)).toEqual(['checkout']);
  });
});
