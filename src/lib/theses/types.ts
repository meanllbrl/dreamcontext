/**
 * Theses (proactive learning layer) — shared types.
 *
 * A THESIS is a falsifiable claim the brain is actively trying to validate or
 * invalidate across sleep cycles: `draft` (a hunch being watched) → `open`
 * (predictions pre-registered) → `validated` | `invalidated` (a confidence-
 * derived flip, checked against pre-registered predictions) → `retired`
 * (promoted into knowledge, or archived as anti-knowledge). Manifests live at
 * `_dream_context/theses/<slug>.md` — frontmatter ledger + prose body.
 *
 * Confidence is DERIVED from the evidence ledger by arithmetic (see
 * confidence.ts) — never asserted by an agent. This mirrors the lab/objectives
 * subsystems: markdown-first, recall-indexed, dashboard-renderable.
 */

export const THESIS_STATUSES = ['draft', 'open', 'validated', 'invalidated', 'retired'] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];

/** Observational theses validate from incoming data; experimental ones can't
 *  be validated by watching and instead surface as suggestions (roadmap item /
 *  task proposals) whose outcome becomes the evidence. */
export const THESIS_KINDS = ['observational', 'experimental'] as const;
export type ThesisKind = (typeof THESIS_KINDS)[number];

export const EVIDENCE_VERDICTS = ['supports', 'contradicts', 'no-signal'] as const;
export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number];

export const EVIDENCE_SOURCES = ['insight', 'task', 'objective', 'changelog', 'external'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const PREDICTION_STANDINGS = ['untested', 'supported', 'contradicted'] as const;
export type PredictionStanding = (typeof PREDICTION_STANDINGS)[number];

/** A falsifiable claim pre-registered at (or after) thesis creation, checked
 *  against evidence over time. draft→open requires at least one of these. */
export interface Prediction {
  id: string;
  text: string;
  standing: PredictionStanding;
}

/** One discrete, cited observation appended to a thesis's evidence ledger.
 *  Ledgers are chronological, oldest-first (`evidence[0]` is the oldest). */
export interface EvidenceEvent {
  /** YYYY-MM-DD. */
  date: string;
  /** Sleep cycle number this event was recorded in, or null (awake/manual). */
  cycle: number | null;
  source: EvidenceSource;
  /** Slug/path/URL of the cited source, or null. */
  ref: string | null;
  verdict: EvidenceVerdict;
  note: string;
  /** True for a numeric series/metric-delta event — feeds the shared
   *  workflow-rule promotion threshold (see THESIS_RULE_PROMOTION_THRESHOLD). */
  quantitative: boolean;
}

/** One entry in the bounded, per-cycle understanding changelog (body-embedded,
 *  LIFO — chain-of-thought inheritance across cycles; older entries condense). */
export interface ChangelogEntry {
  cycle: number | null;
  /** True once this entry condenses multiple older entries into one summary. */
  condensed: boolean;
  /** YYYY-MM-DD. */
  when: string;
  text: string;
}

/** The parsed manifest for one thesis. */
export interface ThesisManifest {
  slug: string;
  claim: string;
  status: ThesisStatus;
  kind: ThesisKind;
  /** DERIVED from `evidence` via deriveConfidence — never asserted. Recomputed
   *  on every read so a hand-edited/stale persisted value can never linger. */
  confidence: number;
  created_by: 'user' | 'sleep-learn';
  predictions: Prediction[];
  evidence: EvidenceEvent[];
  insights: string[];
  objectives: string[];
  related_tasks: string[];
  /** Reserved for the knowledge-workflows bridge (task_QcBUZMU1) — unset in
   *  v1 (nothing writes it yet); see THESIS_RULE_PROMOTION_THRESHOLD. */
  related_workflows: string[];
  blocked_on_instrumentation: boolean;
  blocked_metric: string | null;
  cycles_checked: number;
  /** YYYY-MM-DD of the last evidence/status touch, or null. */
  checked_at: string | null;
  /** Knowledge doc path this thesis was promoted to, or null. */
  promoted_to: string | null;
  created_at: string;
  updated_at: string;
  /** Absolute path of the manifest file. */
  path: string;
  /** Markdown body (claim prose + understanding changelog section). */
  body: string;
  changelog: ChangelogEntry[];
}

/** All thesis failures throw this so callers can map it (400/404 in routes, exit 1 in CLI). */
export class ThesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThesisError';
  }
}

/**
 * The ONE exported constant encoding when a validated/invalidated thesis is
 * significant enough to promote into a workflow RULE instead of (or in
 * addition to) plain knowledge. Imported by both `sleep-learn` (which only
 * ever PROPOSES this via a decision ask — it never edits knowledge/workflows
 * itself) and the knowledge-workflows promotion path (task_QcBUZMU1, planning
 * only / not yet built) — a single source of truth so the two can never drift.
 * PO confirmation is always required regardless of this gate.
 */
export const THESIS_RULE_PROMOTION_THRESHOLD = {
  qualifyingStatuses: ['validated', 'invalidated'] as readonly ThesisStatus[],
  minConfidenceDistance: 0.25,
  minEvidenceEvents: 3,
  requiresQuantitativeEvidence: true,
  requiresGovernsProcedure: true,
} as const;

/**
 * True iff `thesis` clears every THESIS_RULE_PROMOTION_THRESHOLD bar:
 * status ∈ {validated, invalidated} ∧ |confidence − 0.5| ≥ 0.25 ∧
 * supports+contradicts ≥ 3 ∧ ≥1 quantitative evidence event ∧ governs a
 * procedure (`related_workflows` non-empty). In v1, `related_workflows` is
 * never populated (no CLI/UI writes it yet), so this always returns false and
 * every promotion routes through the plain knowledge path — matching the v1
 * scope of "ship the constant + the proposal path only".
 */
export function qualifiesForWorkflowRulePromotion(thesis: ThesisManifest): boolean {
  const t = THESIS_RULE_PROMOTION_THRESHOLD;
  if (!t.qualifyingStatuses.includes(thesis.status)) return false;
  if (Math.abs(thesis.confidence - 0.5) < t.minConfidenceDistance) return false;
  const evidenceCount = thesis.evidence.filter(
    (e) => e.verdict === 'supports' || e.verdict === 'contradicts',
  ).length;
  if (evidenceCount < t.minEvidenceEvents) return false;
  if (t.requiresQuantitativeEvidence && !thesis.evidence.some((e) => e.quantitative)) return false;
  if (t.requiresGovernsProcedure && thesis.related_workflows.length === 0) return false;
  return true;
}
