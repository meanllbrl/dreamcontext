/**
 * Hypothesis shape validator.
 *
 * Per task PR 1 contract + Strategy Optimizer agent: a cohort hypothesis must
 * have all four fields, all non-empty, all concrete:
 *   - predicted_winner       : which variant / structure / audience wins
 *   - predicted_metric       : the single metric to judge by (ROAS, CPA, hook_rate)
 *   - decision_threshold     : numeric value that confirms the hypothesis
 *   - kill_condition         : numeric value or signal that ends the test
 *
 * Strategy Optimizer refuses to write strategy until shape passes.
 */
import { existsSync, readFileSync } from 'node:fs';

// Whitelist of metric names we accept by default. Custom metrics allowed via
// `allowCustomMetric: true` flag (e.g. for novel cohort designs the corpus
// hasn't seen yet) — but the agent still warns about confidence.
const KNOWN_METRICS = new Set([
  'ROAS', 'roas',
  'CPA', 'cpa',
  'CPR', 'cpr',
  'CPM', 'cpm',
  'CPC', 'cpc',
  'CTR', 'ctr',
  'hook_rate', 'thumbstop',
  'conversion_rate', 'cvr',
  'frequency',
  'reach',
  'video_view_rate',
  'cost_per_thruplay',
]);

export interface Hypothesis {
  predicted_winner: string;
  predicted_metric: string;
  decision_threshold: number;
  kill_condition: number | string;
}

export interface HypothesisFile {
  hypothesis: Hypothesis;
  /** Optional human-readable note. */
  note?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Field-level issues for actionable error messages. */
  fieldErrors: Record<string, string>;
}

const REQUIRED_FIELDS: ReadonlyArray<keyof Hypothesis> = [
  'predicted_winner',
  'predicted_metric',
  'decision_threshold',
  'kill_condition',
];

export function validateHypothesis(
  raw: unknown,
  options: { allowCustomMetric?: boolean } = {},
): ValidationResult {
  const errors: string[] = [];
  const fieldErrors: Record<string, string> = {};

  if (raw == null || typeof raw !== 'object') {
    return {
      valid: false,
      errors: ['Hypothesis must be a JSON object with predicted_winner, predicted_metric, decision_threshold, kill_condition.'],
      fieldErrors: {},
    };
  }

  const h = raw as Record<string, unknown>;

  // Presence + non-empty
  for (const field of REQUIRED_FIELDS) {
    if (!(field in h)) {
      errors.push(`Missing required field: ${field}`);
      fieldErrors[field] = 'missing';
    } else if (h[field] == null || h[field] === '') {
      errors.push(`Field ${field} is empty — must be concrete and measurable.`);
      fieldErrors[field] = 'empty';
    }
  }

  // Field-specific shape checks (skip if already flagged as missing/empty)
  if (!fieldErrors.predicted_winner) {
    if (typeof h.predicted_winner !== 'string') {
      errors.push('predicted_winner must be a string describing what is expected to win (e.g. "broad audience + UGC video").');
      fieldErrors.predicted_winner = 'wrong_type';
    } else if (h.predicted_winner.trim().length < 5) {
      errors.push('predicted_winner is too vague — give a concrete description of the expected winner.');
      fieldErrors.predicted_winner = 'too_short';
    }
  }

  if (typeof h.predicted_metric !== 'undefined') {
    if (typeof h.predicted_metric !== 'string') {
      errors.push('predicted_metric must be a string (e.g. "ROAS", "CPA", "hook_rate").');
      fieldErrors.predicted_metric = 'wrong_type';
    } else if (
      !options.allowCustomMetric
      && !KNOWN_METRICS.has(h.predicted_metric)
    ) {
      errors.push(
        `predicted_metric "${h.predicted_metric}" is not in the known metric set. ` +
        `Known: ${Array.from(KNOWN_METRICS).slice(0, 10).join(', ')}, ... ` +
        `Pass --allow-custom-metric if this is intentional.`,
      );
      fieldErrors.predicted_metric = 'unknown_metric';
    }
  }

  if (typeof h.decision_threshold !== 'undefined') {
    if (typeof h.decision_threshold !== 'number' || !Number.isFinite(h.decision_threshold)) {
      errors.push('decision_threshold must be a finite number — the value of predicted_metric that confirms the hypothesis.');
      fieldErrors.decision_threshold = 'wrong_type';
    }
  }

  if (typeof h.kill_condition !== 'undefined') {
    // Accept either a number (absolute threshold) or a string (signal description).
    const t = typeof h.kill_condition;
    if (t !== 'number' && t !== 'string') {
      errors.push('kill_condition must be a number (absolute floor) or a string (e.g. "spend zero for 3 days").');
      fieldErrors.kill_condition = 'wrong_type';
    } else if (t === 'string' && (h.kill_condition as string).trim().length < 5) {
      errors.push('kill_condition is too vague — describe a concrete signal or numeric floor.');
      fieldErrors.kill_condition = 'too_short';
    } else if (t === 'number' && !Number.isFinite(h.kill_condition as number)) {
      errors.push('kill_condition number must be finite.');
      fieldErrors.kill_condition = 'wrong_type';
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    fieldErrors,
  };
}

/** Convenience: load + parse + validate a hypothesis file. */
export function loadHypothesisFile(
  path: string,
  options: { allowCustomMetric?: boolean } = {},
): { ok: true; data: HypothesisFile } | { ok: false; errors: string[] } {
  if (!existsSync(path)) {
    return { ok: false, errors: [`Hypothesis file not found: ${path}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`Failed to parse JSON at ${path}: ${(e as Error).message}`] };
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { ok: false, errors: ['Hypothesis file must be a JSON object'] };
  }
  // Accept either { hypothesis: {...} } envelope or bare hypothesis object.
  const obj = parsed as Record<string, unknown>;
  const hypothesisRaw = (obj.hypothesis as unknown) ?? obj;
  const validation = validateHypothesis(hypothesisRaw, options);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }
  return {
    ok: true,
    data: {
      hypothesis: hypothesisRaw as Hypothesis,
      ...(typeof obj.note === 'string' ? { note: obj.note } : {}),
    },
  };
}
