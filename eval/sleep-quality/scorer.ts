/**
 * sleep-quality scorer — pure, deterministic, NO LLM.
 *
 * Scores the consolidation/debt pipeline against implementation-blind gold
 * labels by replaying the WS1/WS-DEBT/WS-DEPTH pure functions over a committed
 * fixture. Every sub-score is reproducible by re-running the one vitest command.
 *
 * The scorer can compute TWO profiles:
 *   - 'after'  : current code's real behavior (the functions as they ship).
 *   - 'before' : the pre-refinement behavior, emulated for the three MOVERS so
 *     the test can show a deterministic delta:
 *       (5) attribution  — BEFORE the helper existed, coverage was 0%.
 *       (8) substance    — BEFORE = max(change,tool) only (no substance term).
 *       (9) depth-gating  — BEFORE = destructive ops always allowed (no gate).
 *     The regression guards (1,2,3,7) are profile-independent: they exercise the
 *     same shipped functions either way and must stay 100 in both profiles.
 *
 * Layer 2 metrics — (4) dedup discipline and (6) capture→promote rate — require
 * a real live-LLM specialist run and are NOT computed here (see RESULTS.md).
 */

import {
  applyConsolidation,
  upsertSessionOnStop,
  consolidationDepth,
  isDestructiveAllowed,
  type SleepState,
  type StopUpsertInput,
  type ConsolidationDepth,
} from '../../src/lib/sleep-consolidation.js';
import { scoreFromSubstance, scoreFromChangeCount, scoreFromToolCount } from '../../src/cli/commands/hook.js';
import { attributeByPerson, type Commit } from '../../src/lib/attribution.js';

export type Profile = 'before' | 'after';

export interface FixtureMeta {
  epoch: string;
  restop: {
    session_id: string;
    firstStop: StopUpsertInput;
    secondStop: StopUpsertInput;
  };
  denseSession: {
    session_id: string;
    changeCount: number;
    toolCount: number;
    substanceSignals: {
      userTurns: number;
      assistantChars: number;
      decisionMarkers: number;
      taskSlugs: string[];
    };
  };
}

export interface ScorerInput {
  state: SleepState;
  meta: FixtureMeta;
  commits: Commit[];
  roster: string[];
  controlCommits: Commit[];
  controlRoster: string[];
}

export interface Gold {
  epochSafety: {
    expectedSurvivorSessionIds: string[];
    expectedSurvivorBookmarkIds: string[];
    expectedSurvivorDashboardSummaries: string[];
    expectedProcessedSessionCount: number;
  };
  debtCorrectness: { expectedRecomputedDebt: number };
  noDoubleCount: { expectedDebt: number; expectedSessionCount: number };
  attribution: { expectedBuckets: Record<string, string[]> };
  attributionControl: { expectedBucketKeys: string[]; expectedBuckets: Record<string, string[]> };
  triggerExpiry: { expectedSurvivingTriggerIds: string[] };
  substanceScoring: { expectedScoreBefore: number; expectedScoreAfter: number };
  depthGating: { expectedAllowedByDepth: Record<ConsolidationDepth, boolean> };
}

/** A single labelled sub-score 0-100 plus its weight in the overall. */
export interface SubScore {
  key: string;
  label: string;
  score: number;
  weight: number;
  isMover: boolean;
}

export interface SleepQualityReport {
  profile: Profile;
  subScores: SubScore[];
  overall: number;
}

// Sub-score weights — regression guards and movers weighted equally so the
// overall is a faithful average; movers are flagged for the delta assertions.
const WEIGHTS: Record<string, { label: string; weight: number; mover: boolean }> = {
  epochSafety: { label: 'epoch safety', weight: 1, mover: false },
  debtCorrectness: { label: 'debt correctness', weight: 1, mover: false },
  noDoubleCount: { label: 'no double-count', weight: 1, mover: false },
  attribution: { label: 'attribution coverage', weight: 1, mover: true },
  triggerExpiry: { label: 'trigger expiry', weight: 1, mover: false },
  substanceScoring: { label: 'substance scoring', weight: 1, mover: true },
  depthGating: { label: 'depth gating', weight: 1, mover: true },
};

function pct(ok: boolean): number {
  return ok ? 100 : 0;
}

function arrayEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function bucketsEq(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (!arrayEq(ak, bk)) return false;
  return ak.every((k) => arrayEq([...a[k]].sort(), [...b[k]].sort()));
}

// ─── Regression guards (profile-independent) ─────────────────────────────────

function scoreEpochSafety(input: ScorerInput, gold: Gold): number {
  const g = gold.epochSafety;
  const result = applyConsolidation(input.state, input.meta.epoch);
  const survivorIds = result.state.sessions.map((s) => s.session_id);
  const bookmarkIds = result.state.bookmarks.map((b) => b.id);
  const dashSummaries = result.state.dashboard_changes.map((c) => c.summary);
  const ok =
    arrayEq(survivorIds, g.expectedSurvivorSessionIds) &&
    arrayEq(bookmarkIds, g.expectedSurvivorBookmarkIds) &&
    arrayEq(dashSummaries, g.expectedSurvivorDashboardSummaries) &&
    result.sessionsProcessed === g.expectedProcessedSessionCount;
  return pct(ok);
}

function scoreDebtCorrectness(input: ScorerInput, gold: Gold): number {
  const result = applyConsolidation(input.state, input.meta.epoch);
  return pct(result.state.debt === gold.debtCorrectness.expectedRecomputedDebt);
}

function scoreNoDoubleCount(input: ScorerInput, gold: Gold): number {
  // Start from a clean state so the re-stop debt is isolated.
  const blank: SleepState = { ...input.state, sessions: [], debt: 0, sessions_since_last_sleep: 0 };
  let s = upsertSessionOnStop(blank, input.meta.restop.firstStop);
  s = upsertSessionOnStop(s, input.meta.restop.secondStop);
  const ok =
    s.debt === gold.noDoubleCount.expectedDebt &&
    s.sessions.length === gold.noDoubleCount.expectedSessionCount;
  return pct(ok);
}

function scoreTriggerExpiry(input: ScorerInput, gold: Gold): number {
  const result = applyConsolidation(input.state, input.meta.epoch);
  const ids = result.state.triggers.map((t) => t.id);
  return pct(arrayEq(ids.sort(), [...gold.triggerExpiry.expectedSurvivingTriggerIds].sort()));
}

// ─── Movers (profile-dependent) ──────────────────────────────────────────────

function scoreAttribution(input: ScorerInput, gold: Gold, profile: Profile): number {
  if (profile === 'before') {
    // BEFORE the attributeByPerson helper existed there was no per-person
    // bucketing at all — coverage was 0%.
    return 0;
  }
  const toHashes = (b: Record<string, Commit[]>): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const k of Object.keys(b)) out[k] = b[k].map((c) => c.hash);
    return out;
  };

  const buckets = toHashes(attributeByPerson(input.commits, input.roster));
  const mainOk = bucketsEq(buckets, gold.attribution.expectedBuckets);

  const controlBuckets = toHashes(attributeByPerson(input.controlCommits, input.controlRoster));
  const noPhantom = arrayEq(
    Object.keys(controlBuckets).sort(),
    [...gold.attributionControl.expectedBucketKeys].sort(),
  );
  const controlOk = bucketsEq(controlBuckets, gold.attributionControl.expectedBuckets);

  // Full credit requires correct multi-person buckets AND zero phantom on control.
  return pct(mainOk && noPhantom && controlOk);
}

/** The raw debt score a session would receive under a given profile. */
export function sessionScoreForProfile(
  changeCount: number,
  toolCount: number,
  substanceSignals: { userTurns: number; assistantChars: number; decisionMarkers: number; taskSlugs: string[] },
  profile: Profile,
): number {
  const base = Math.max(scoreFromChangeCount(changeCount), scoreFromToolCount(toolCount));
  if (profile === 'before') return base; // no substance term existed
  return Math.max(base, scoreFromSubstance(substanceSignals));
}

/**
 * Quality bar: an edit-free-but-dense session must accrue meaningful debt
 * (score >= 2) so its information is not silently lost. BEFORE = max(change,tool)
 * scores it 1 (fails the bar). AFTER = max(...,substance) scores it 3 (passes).
 * This is the genuine mover — the sub-score measures whether the pipeline
 * captures the dense session, not whether it equals an exact number.
 */
const DENSE_QUALITY_BAR = 2;

function scoreSubstance(input: ScorerInput, gold: Gold, profile: Profile): number {
  const d = input.meta.denseSession;
  const actual = sessionScoreForProfile(d.changeCount, d.toolCount, d.substanceSignals, profile);
  // Sanity-tie the actual to the gold-labelled expectation per profile.
  const expected =
    profile === 'before' ? gold.substanceScoring.expectedScoreBefore : gold.substanceScoring.expectedScoreAfter;
  if (actual !== expected) return 0; // pipeline diverged from the blind gold label
  return pct(actual >= DENSE_QUALITY_BAR);
}

/** Whether destructive ops are authorized for a depth under a given profile. */
export function destructiveAllowedForProfile(depth: ConsolidationDepth, profile: Profile): boolean {
  // BEFORE: no depth gate existed — destructive ops were always allowed.
  if (profile === 'before') return true;
  return isDestructiveAllowed(depth);
}

// Debt values that resolve to each depth via consolidationDepth(debt).
// (×2 scale, 2026-06-29: light 0–7 · standard 8–19 · deep 20+.)
const DEBT_BY_DEPTH: Record<ConsolidationDepth, number> = { light: 0, standard: 10, deep: 20 };

function scoreDepthGating(_input: ScorerInput, gold: Gold, profile: Profile): number {
  const depths: ConsolidationDepth[] = ['light', 'standard', 'deep'];
  const allCorrect = depths.every((depth) => {
    // Resolve the depth from a representative debt via the real function, then
    // gate. BEFORE = always-allowed (no gate existed) → wrong at light/standard.
    const resolved = consolidationDepth(DEBT_BY_DEPTH[depth]).depth;
    const actual = destructiveAllowedForProfile(resolved, profile);
    return actual === gold.depthGating.expectedAllowedByDepth[depth];
  });
  return pct(allCorrect);
}

/**
 * Score a consolidation run for one profile. Pure — same inputs always yield the
 * same report.
 */
export function scoreConsolidation(input: ScorerInput, gold: Gold, profile: Profile): SleepQualityReport {
  const raw: Record<string, number> = {
    epochSafety: scoreEpochSafety(input, gold),
    debtCorrectness: scoreDebtCorrectness(input, gold),
    noDoubleCount: scoreNoDoubleCount(input, gold),
    attribution: scoreAttribution(input, gold, profile),
    triggerExpiry: scoreTriggerExpiry(input, gold),
    substanceScoring: scoreSubstance(input, gold, profile),
    depthGating: scoreDepthGating(input, gold, profile),
  };

  const subScores: SubScore[] = Object.keys(WEIGHTS).map((key) => ({
    key,
    label: WEIGHTS[key].label,
    score: raw[key],
    weight: WEIGHTS[key].weight,
    isMover: WEIGHTS[key].mover,
  }));

  const totalWeight = subScores.reduce((s, x) => s + x.weight, 0);
  const overall = subScores.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight;

  return { profile, subScores, overall };
}

/** Render a BEFORE/AFTER report pair as a fixed-width ASCII table. */
export function formatReport(before: SleepQualityReport, after: SleepQualityReport): string {
  const lines: string[] = [];
  lines.push('sleep-quality eval — BEFORE → AFTER (deterministic, Layer 1)');
  const head = ['metric'.padEnd(22), 'before'.padStart(7), 'after'.padStart(7), 'Δ'.padStart(6), 'mover'.padStart(6)];
  lines.push(head.join(' | '));
  lines.push('-'.repeat(22) + '-+-' + '-'.repeat(7) + '-+-' + '-'.repeat(7) + '-+-' + '-'.repeat(6) + '-+-' + '-'.repeat(6));
  for (let i = 0; i < after.subScores.length; i++) {
    const b = before.subScores[i];
    const a = after.subScores[i];
    const delta = a.score - b.score;
    lines.push(
      [
        a.label.padEnd(22),
        b.score.toFixed(0).padStart(7),
        a.score.toFixed(0).padStart(7),
        (delta >= 0 ? '+' + delta.toFixed(0) : delta.toFixed(0)).padStart(6),
        (a.isMover ? 'yes' : '·').padStart(6),
      ].join(' | '),
    );
  }
  lines.push('-'.repeat(22) + '-+-' + '-'.repeat(7) + '-+-' + '-'.repeat(7) + '-+-' + '-'.repeat(6) + '-+-' + '-'.repeat(6));
  const od = after.overall - before.overall;
  lines.push(
    [
      'OVERALL'.padEnd(22),
      before.overall.toFixed(1).padStart(7),
      after.overall.toFixed(1).padStart(7),
      (od >= 0 ? '+' + od.toFixed(1) : od.toFixed(1)).padStart(6),
      ''.padStart(6),
    ].join(' | '),
  );
  return lines.join('\n');
}
