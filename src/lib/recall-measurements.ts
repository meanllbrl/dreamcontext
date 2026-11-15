/**
 * What each recall option measured to, in ONE place. Settings → Recall shows these numbers (the
 * dashboard receives them over `GET /api/recall/options`; no component carries a figure of its own).
 *
 * Source: `eval/runs/2026-10-11-final.json` — the sealed held-out set (72 questions: 23 Turkish,
 * 25 English, 24 mixed). Accuracy is `heldout.<arm>.<lang>.r5pct` (the right document in the top 5);
 * latency is `latencyQuiet.<arm>.overheadP90Ms` (extra time per prompt, quiet machine) and, for
 * raw, `latencyQuiet.rawAfterCacheFix.overheadP90Ms`; cost is `costs.AC-C1` (one-time index) and
 * `costs.AC-C2` (per 1,000 queries). `tests/unit/recall-measurements.test.ts` reads that file and
 * fails when these figures drift from it.
 *
 * Mode names follow the app: `haiku`, `raw`, `hybrid` (local e5), `off` are `recall_mode` values;
 * `cloud` and `cloud-index` are the opt-in cloud tiers (both run as `recall_mode: hybrid`).
 */

export type RecallOptionId = 'haiku' | 'cloud' | 'cloud-index' | 'raw' | 'off' | 'hybrid';

/** The language buckets of the held-out set. */
export type RecallLanguage = 'tr' | 'en' | 'mixed';

/** One-sentence egress answers; the dashboard words each in the person's language. */
export type RecallEgress =
  | 'nothing'
  | 'anthropic-prompt-and-index'
  | 'chunks-once-then-local'
  | 'chunks-once-and-each-prompt';

export interface RecallMeasurement {
  id: RecallOptionId;
  /** Held-out recall@5 in percent per language; `null` when the option injects nothing (off). */
  accuracyR5Pct: Record<RecallLanguage, number> | null;
  /** Extra time per prompt, p90, milliseconds. A range when only an estimate exists. */
  overheadP90Ms: { min: number; max: number };
  /** True when `overheadP90Ms` is an estimate rather than a quiet-machine measurement. */
  overheadIsEstimate: boolean;
  cost: {
    /** One-time cost of building the vault's cloud index, USD. */
    indexOnceUsd: number;
    /** Running cost per 1,000 prompts, USD. */
    per1000QueriesUsd: number;
  };
  egress: RecallEgress;
}

export interface RecallMeasurements {
  /** The measurement file these figures come from (repo-relative). */
  source: string;
  measuredOn: string;
  /** Number of questions in the sealed held-out set, and per language. */
  queries: { total: number } & Record<RecallLanguage, number>;
  options: readonly RecallMeasurement[];
}

const NO_COST = { indexOnceUsd: 0, per1000QueriesUsd: 0 } as const;

export const RECALL_MEASUREMENTS: RecallMeasurements = {
  source: 'eval/runs/2026-10-11-final.json',
  measuredOn: '2026-10-11',
  queries: { total: 72, tr: 23, en: 25, mixed: 24 },
  options: [
    {
      id: 'haiku',
      accuracyR5Pct: { tr: 52.2, en: 64, mixed: 62.5 },
      // Judged recall (2026-11-16, 111 train turns): the local search plus one Haiku call, judge p50 ~6 s
      // on a quiet machine, per-turn p90 ~18 s on a busy one; the hook waits at most 30 s. Accuracy below is
      // still the 2026-10-11 held-out figure of the previous single-call picker (a different metric).
      overheadP90Ms: { min: 6000, max: 18000 },
      overheadIsEstimate: true,
      cost: NO_COST,
      egress: 'anthropic-prompt-and-index',
    },
    {
      id: 'cloud',
      accuracyR5Pct: { tr: 95.7, en: 100, mixed: 95.8 },
      overheadP90Ms: { min: 1887, max: 1887 },
      overheadIsEstimate: false,
      cost: { indexOnceUsd: 0.16, per1000QueriesUsd: 0.25 },
      egress: 'chunks-once-and-each-prompt',
    },
    {
      id: 'cloud-index',
      accuracyR5Pct: { tr: 100, en: 100, mixed: 83.3 },
      overheadP90Ms: { min: 2236, max: 2236 },
      overheadIsEstimate: false,
      cost: { indexOnceUsd: 0.16, per1000QueriesUsd: 0 },
      egress: 'chunks-once-then-local',
    },
    {
      id: 'raw',
      accuracyR5Pct: { tr: 30.4, en: 88, mixed: 75 },
      // After the corpus-cache fix (`latencyQuiet.rawAfterCacheFix`).
      overheadP90Ms: { min: 317, max: 317 },
      overheadIsEstimate: false,
      cost: NO_COST,
      egress: 'nothing',
    },
    {
      id: 'off',
      accuracyR5Pct: null,
      overheadP90Ms: { min: 0, max: 0 },
      overheadIsEstimate: false,
      cost: NO_COST,
      egress: 'nothing',
    },
    {
      id: 'hybrid',
      // The `local` arm: BM25 + local e5, no cloud.
      accuracyR5Pct: { tr: 26.1, en: 88, mixed: 66.7 },
      overheadP90Ms: { min: 1861, max: 1861 },
      overheadIsEstimate: false,
      cost: NO_COST,
      // On Claude the prompt hook judges hybrid's candidates with Haiku too (judged recall, 2026-11-16).
      egress: 'anthropic-prompt-and-index',
    },
  ],
};

export function measurementFor(id: RecallOptionId): RecallMeasurement {
  const found = RECALL_MEASUREMENTS.options.find((o) => o.id === id);
  if (!found) throw new Error(`recall-measurements: no measurement for "${id}"`);
  return found;
}
