/**
 * The snapshot store (`lab/data/<slug>.json`): a snapshot is validated before
 * it replaces the old one, every refusal names its problem and leaves the file
 * on disk byte-identical (or absent), the write is atomic, and a symlinked
 * target is never read or written. Synthetic names only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_LAB_DATA_BYTES,
  checkLabSnapshot,
  labDataPath,
  readLabSnapshot,
  writeLabSnapshot,
} from '../../src/lib/lab/labData.js';
import { LabError } from '../../src/lib/lab/types.js';

const WINDOW = ['2026-09-07', '2026-10-04'];

function funnelSet(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'funnel-set/v1',
    segment_mode: 'lookup',
    dimensions: [{ key: 'country', label: 'Country', mode: 'client' }],
    funnels: [
      {
        id: 'quiz',
        name: 'Acme quiz',
        meta: {},
        metrics: { users: { v: 1000, format: 'count' } },
        steps: [{ key: 'visit', label: 'Visit', users: 1000 }, { key: 'lead', label: 'Lead', users: 400 }],
        segments: [{ dims: { country: 'TR' }, users: 600, steps: [{ key: 'visit', users: 600 }, { key: 'lead', users: 250 }] }],
        daily: [{ t: '2026-09-07', m: { users: 40 } }],
      },
    ],
    ...extra,
  };
}

function snapshot(over: { source?: Record<string, unknown>; data?: unknown } = {}): Record<string, unknown> {
  return {
    source: {
      vault: 'acme-storefront',
      chart_name: 'Funnel Analysis',
      applied_filters: [
        { field: 'product', op: '=', value: 'Acme', source: 'request' },
        { field: 'date', op: 'between', values: WINDOW, source: 'request' },
      ],
      freshness: 'data 2h old',
      pulled_at: '2026-10-08T14:33:48Z',
      ...(over.source ?? {}),
    },
    data: over.data === undefined ? funnelSet() : over.data,
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lab-data-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkLabSnapshot', () => {
  it('a valid funnel snapshot passes with a summary', () => {
    const c = checkLabSnapshot(snapshot(), { requireFunnel: true });
    expect(c.problems).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.kind).toBe('funnel-set/v1');
    expect(c.summary).toMatchObject({
      funnels: 1,
      dims: [{ key: 'country', values: 1 }],
      segments: 1,
      dailyFunnels: 1,
      segmentFunnels: 1,
      payment: false,
      access: false,
      pulledAt: '2026-10-08T14:33:48Z',
    });
    expect(c.summary!.storedBytes).toBeGreaterThan(0);
  });

  it('refuses a payload that is not { source, data }', () => {
    expect(checkLabSnapshot(funnelSet()).ok).toBe(false);
    expect(checkLabSnapshot(null).problems[0]).toMatch(/\{ source, data \}/);
  });

  it('refuses a missing or unparseable pulled_at', () => {
    expect(checkLabSnapshot(snapshot({ source: { pulled_at: undefined } })).problems.join(' ')).toMatch(/pulled_at/);
    expect(checkLabSnapshot(snapshot({ source: { pulled_at: 'yesterday' } })).ok).toBe(false);
  });

  it('refuses a source with no applied filters', () => {
    const c = checkLabSnapshot(snapshot({ source: { applied_filters: [] } }));
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/no applied filters/);
  });

  it('refuses filters without an explicit between date window', () => {
    const c = checkLabSnapshot(snapshot({ source: { applied_filters: [{ field: 'product', op: '=', value: 'Acme', source: 'request' }] } }));
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/explicit date filter/);
  });

  it('reads filters from source.queries[] too', () => {
    const c = checkLabSnapshot(snapshot({
      source: {
        applied_filters: undefined,
        queries: [{ chart_name: 'Funnel Analysis', applied_filters: [{ field: 'date', op: 'between', values: WINDOW, source: 'request' }] }],
      },
    }));
    expect(c.ok).toBe(true);
    // No product filter: a notice, never a refusal.
    expect(c.notices.join(' ')).toMatch(/no product filter/);
  });

  it('refuses a data.window that matches no query date filter, accepts a matching one', () => {
    const bad = checkLabSnapshot(snapshot({ data: funnelSet({ window: { from: '2026-09-01', to: '2026-10-04' } }) }));
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/data.window/);
    const good = checkLabSnapshot(snapshot({ data: funnelSet({ window: { from: WINDOW[0], to: WINDOW[1] } }) }));
    expect(good.ok).toBe(true);
    expect(good.summary!.window).toEqual({ from: WINDOW[0], to: WINDOW[1] });
  });

  it('refuses data its parser refuses', () => {
    const c = checkLabSnapshot(snapshot({ data: { kind: 'funnel-set/v1', funnels: 'nope' } }));
    expect(c.ok).toBe(false);
    expect(c.problems[0]).toMatch(/^data: /);
    expect(checkLabSnapshot(snapshot({ data: { kind: 'something/v9' } })).ok).toBe(false);
  });

  it('accepts a Series[] payload, but not for a funnel explorer', () => {
    const series = [{ name: 'Signups', points: [{ t: '2026-09-07', v: 12 }] }];
    expect(checkLabSnapshot(snapshot({ data: series })).ok).toBe(true);
    const c = checkLabSnapshot(snapshot({ data: series }), { requireFunnel: true });
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/funnel explorer/);
  });

  it('a dataset bundle passes a funnel explorer only with a funnel member', () => {
    const bundle = { kind: 'dataset/v1', datasets: [{ key: 'plans', dims: [{ key: 'plan' }], rows: [{ d: { plan: 'pro' }, v: 3 }] }] };
    expect(checkLabSnapshot(snapshot({ data: bundle }), { requireFunnel: true }).ok).toBe(false);
    const withFunnel = checkLabSnapshot(snapshot({ data: { ...bundle, funnel: funnelSet() } }), { requireFunnel: true });
    expect(withFunnel.ok).toBe(true);
    expect(withFunnel.kind).toBe('dataset/v1');
    expect(withFunnel.summary!.funnels).toBe(1);
  });

  it('refuses a snapshot over the byte cap', () => {
    const big = snapshot({ source: { padding: 'x'.repeat(MAX_LAB_DATA_BYTES) } });
    const c = checkLabSnapshot(big);
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/byte cap/);
  });
});

describe('writeLabSnapshot / readLabSnapshot', () => {
  it('writes atomically into lab/data (created when missing) and reads it back', () => {
    expect(readLabSnapshot(root, 'acme-funnels')).toBeNull();
    const check = writeLabSnapshot(root, 'acme-funnels', snapshot(), { requireFunnel: true });
    expect(check.ok).toBe(true);
    const path = labDataPath(root, 'acme-funnels');
    expect(path).toBe(join(root, 'lab', 'data', 'acme-funnels.json'));
    expect(readLabSnapshot(root, 'acme-funnels')).toEqual(snapshot());
    // No tmp file is left behind.
    expect(readdirSync(join(root, 'lab', 'data'))).toEqual(['acme-funnels.json']);
  });

  it('a refused write leaves the existing file byte-identical', () => {
    writeLabSnapshot(root, 'acme-funnels', snapshot());
    const path = labDataPath(root, 'acme-funnels');
    const before = readFileSync(path);
    const refusals = [
      snapshot({ source: { pulled_at: undefined } }),
      snapshot({ source: { applied_filters: [] } }),
      snapshot({ data: funnelSet({ window: { from: '2026-01-01', to: '2026-01-31' } }) }),
      snapshot({ data: { kind: 'funnel-set/v1' } }),
    ];
    for (const raw of refusals) {
      expect(() => writeLabSnapshot(root, 'acme-funnels', raw)).toThrow(LabError);
      expect(readFileSync(path).equals(before)).toBe(true);
    }
    expect(readdirSync(join(root, 'lab', 'data'))).toEqual(['acme-funnels.json']);
  });

  it('a refused first write creates nothing', () => {
    expect(() => writeLabSnapshot(root, 'acme-funnels', snapshot({ source: { applied_filters: [] } }))).toThrow(/nothing written/);
    expect(existsSync(labDataPath(root, 'acme-funnels'))).toBe(false);
  });

  it('the refusal names every problem', () => {
    try {
      writeLabSnapshot(root, 'acme-funnels', snapshot({ source: { pulled_at: undefined, applied_filters: [] } }));
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(LabError);
      expect((err as Error).message).toMatch(/pulled_at/);
      expect((err as Error).message).toMatch(/no applied filters/);
    }
  });

  it('refuses an unsafe slug', () => {
    expect(() => labDataPath(root, '../escape')).toThrow(LabError);
    expect(() => writeLabSnapshot(root, 'Bad Slug', snapshot())).toThrow(LabError);
  });

  it('refuses a symlinked snapshot for both read and write, and leaves the link target alone', () => {
    mkdirSync(join(root, 'lab', 'data'), { recursive: true });
    const outside = join(root, 'outside.json');
    writeFileSync(outside, '{"secret":true}');
    symlinkSync(outside, labDataPath(root, 'acme-funnels'));
    expect(() => readLabSnapshot(root, 'acme-funnels')).toThrow(/symlink/);
    expect(() => writeLabSnapshot(root, 'acme-funnels', snapshot())).toThrow(/symlink/);
    expect(readFileSync(outside, 'utf-8')).toBe('{"secret":true}');
  });

  it('a planted <slug>.json.tmp symlink is never followed: the outside file is untouched', () => {
    mkdirSync(join(root, 'lab', 'data'), { recursive: true });
    const outside = join(root, 'outside-target.txt');
    writeFileSync(outside, 'do not overwrite');
    const planted = `${labDataPath(root, 'acme-funnels')}.tmp`;
    symlinkSync(outside, planted);
    writeLabSnapshot(root, 'acme-funnels', snapshot());
    expect(readFileSync(outside, 'utf-8')).toBe('do not overwrite');
    expect(readLabSnapshot(root, 'acme-funnels')).toEqual(snapshot());
    // The planted link is left where it was; no temp file of ours is left behind.
    expect(readdirSync(join(root, 'lab', 'data')).sort()).toEqual(['acme-funnels.json', 'acme-funnels.json.tmp']);
  });

  it('a symlinked lab/ is refused and nothing is created outside the vault', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'lab-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(root, 'lab'));
      expect(() => writeLabSnapshot(root, 'acme-funnels', snapshot())).toThrow(/outside the vault/);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('an unreadable snapshot reports a fixed message without echoing its content', () => {
    mkdirSync(join(root, 'lab', 'data'), { recursive: true });
    writeFileSync(labDataPath(root, 'acme-funnels'), 'SECRET-TOKEN-abc123 not json');
    try {
      readLabSnapshot(root, 'acme-funnels');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as Error).message).toBe('lab/data/acme-funnels.json is not valid JSON.');
    }
  });

  it('refuses a lab/data directory that resolves outside the vault', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'lab-data-elsewhere-'));
    try {
      mkdirSync(join(root, 'lab'), { recursive: true });
      symlinkSync(elsewhere, join(root, 'lab', 'data'));
      expect(() => writeLabSnapshot(root, 'acme-funnels', snapshot())).toThrow(/outside the vault/);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
