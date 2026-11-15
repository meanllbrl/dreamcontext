import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECALL_MEASUREMENTS, measurementFor, type RecallLanguage } from '../../src/lib/recall-measurements.js';

/**
 * The figures Settings shows must be the ones in the committed measurement file. This test reads
 * `eval/runs/2026-10-11-final.json` and holds the typed constant to it.
 */

interface Arm { tr: { r5pct: number; n: number }; en: { r5pct: number; n: number }; mixed: { r5pct: number; n: number }; all: { n: number } }
interface Final {
  date: string;
  heldout: Record<string, Arm>;
  latencyQuiet: Record<string, { overheadP90Ms?: number; overhead?: unknown; raw?: { p90Ms: number }; overheadP90?: number }> & { rawAfterCacheFix: { overheadP90Ms: number } };
  costs: { 'AC-C1': { deltaUsd?: number; ledgerBeforeUsd: number; ledgerAfterUsd: number }; 'AC-C2': { usdPer1000Queries_approx: number } };
}

const final = JSON.parse(readFileSync(join(__dirname, '..', '..', 'eval', 'runs', '2026-10-11-final.json'), 'utf-8')) as Final;

const LANGS: RecallLanguage[] = ['tr', 'en', 'mixed'];
/** Option id → the arm of the measurement file it was measured as. */
const ARM: Record<string, string> = { haiku: 'B0-haiku', raw: 'B0-raw', hybrid: 'local', 'cloud-index': 'cloud-index', cloud: 'cloud' };

describe('RECALL_MEASUREMENTS', () => {
  it('names its source and date', () => {
    expect(RECALL_MEASUREMENTS.source).toBe('eval/runs/2026-10-11-final.json');
    expect(RECALL_MEASUREMENTS.measuredOn).toBe(final.date);
  });

  it('lists every option once, with a measurement for each', () => {
    const ids = RECALL_MEASUREMENTS.options.map((o) => o.id).sort();
    expect(ids).toEqual(['cloud', 'cloud-index', 'haiku', 'hybrid', 'off', 'raw']);
    expect(() => measurementFor('raw')).not.toThrow();
  });

  it('carries the held-out question counts', () => {
    const arm = final.heldout['B0-raw'];
    expect(RECALL_MEASUREMENTS.queries).toEqual({ total: arm.all.n, tr: arm.tr.n, en: arm.en.n, mixed: arm.mixed.n });
  });

  for (const [id, armName] of Object.entries(ARM)) {
    it(`${id}: recall@5 per language matches the "${armName}" arm`, () => {
      const acc = measurementFor(id as 'raw').accuracyR5Pct;
      expect(acc).not.toBeNull();
      for (const lang of LANGS) expect(acc![lang]).toBe(final.heldout[armName][lang].r5pct);
    });
  }

  it('off injects nothing, so it has no accuracy and costs nothing', () => {
    const off = measurementFor('off');
    expect(off.accuracyR5Pct).toBeNull();
    expect(off.overheadP90Ms).toEqual({ min: 0, max: 0 });
    expect(off.cost).toEqual({ indexOnceUsd: 0, per1000QueriesUsd: 0 });
  });

  it('latency matches the quiet-machine run (raw: after the cache fix)', () => {
    const q = final.latencyQuiet as unknown as Record<string, { overheadP90Ms: number }>;
    expect(measurementFor('raw').overheadP90Ms.max).toBe(final.latencyQuiet.rawAfterCacheFix.overheadP90Ms);
    expect(measurementFor('hybrid').overheadP90Ms.max).toBe(q.local.overheadP90Ms);
    expect(measurementFor('cloud-index').overheadP90Ms.max).toBe(q['cloud-index'].overheadP90Ms);
    expect(measurementFor('cloud').overheadP90Ms.max).toBe(q.cloud.overheadP90Ms);
    expect(measurementFor('haiku').overheadIsEstimate).toBe(true);
  });

  it('costs match the file: index once about $0.16, cloud about $0.25 per 1,000 queries, the rest free', () => {
    const indexUsd = final.costs['AC-C1'].ledgerAfterUsd - final.costs['AC-C1'].ledgerBeforeUsd;
    const per1000 = final.costs['AC-C2'].usdPer1000Queries_approx;
    expect(measurementFor('cloud-index').cost.indexOnceUsd).toBeCloseTo(indexUsd, 2);
    expect(measurementFor('cloud').cost.indexOnceUsd).toBeCloseTo(indexUsd, 2);
    expect(measurementFor('cloud').cost.per1000QueriesUsd).toBeCloseTo(per1000, 2);
    expect(measurementFor('cloud-index').cost.per1000QueriesUsd).toBe(0);
    for (const free of ['haiku', 'raw', 'hybrid', 'off'] as const) {
      expect(measurementFor(free).cost).toEqual({ indexOnceUsd: 0, per1000QueriesUsd: 0 });
    }
  });

  it('egress: only the cloud tiers and Haiku send anything', () => {
    expect(measurementFor('haiku').egress).toBe('anthropic-prompt-and-index');
    expect(measurementFor('cloud').egress).toBe('chunks-once-and-each-prompt');
    expect(measurementFor('cloud-index').egress).toBe('chunks-once-then-local');
    // Judged recall: on Claude, hybrid's candidates go to Haiku as the default mode's do.
    expect(measurementFor('hybrid').egress).toBe('anthropic-prompt-and-index');
    for (const none of ['raw', 'off'] as const) expect(measurementFor(none).egress).toBe('nothing');
  });
});
