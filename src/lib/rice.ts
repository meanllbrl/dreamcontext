export interface RiceFields {
  reach: number | null;
  impact: number | null;
  confidence: number | null;
  effort: number | null;
  score: number | null;
}

export type RiceInput = Partial<Omit<RiceFields, 'score'>>;

export const VALID_CONFIDENCES = [25, 50, 75, 100] as const;

export interface RiceValidationError {
  field: keyof RiceInput;
  message: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInteger(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v);
}

/**
 * Validate a partial RICE input. Returns array of errors; empty if all-clear.
 * `null` values are allowed (mean "clear this field"). `undefined` means "not provided".
 */
export function validateRiceInput(input: RiceInput): RiceValidationError[] {
  const errors: RiceValidationError[] = [];

  if (input.reach !== undefined && input.reach !== null) {
    if (!isInteger(input.reach) || input.reach < 1 || input.reach > 10) {
      errors.push({ field: 'reach', message: 'reach must be an integer 1–10' });
    }
  }

  if (input.impact !== undefined && input.impact !== null) {
    if (!isInteger(input.impact) || input.impact < 1 || input.impact > 5) {
      errors.push({ field: 'impact', message: 'impact must be an integer 1–5' });
    }
  }

  if (input.confidence !== undefined && input.confidence !== null) {
    if (!isInteger(input.confidence) || !VALID_CONFIDENCES.includes(input.confidence as 25 | 50 | 75 | 100)) {
      errors.push({ field: 'confidence', message: 'confidence must be one of 25, 50, 75, 100' });
    }
  }

  if (input.effort !== undefined && input.effort !== null) {
    if (!isFiniteNumber(input.effort) || input.effort <= 0 || input.effort > 52) {
      errors.push({ field: 'effort', message: 'effort must be a number > 0 and ≤ 52 (weeks)' });
    }
  }

  return errors;
}

/**
 * Compute RICE score = (reach × impact × (confidence/100)) / effort.
 * Returns null if any of the four inputs is missing or invalid.
 * Result is rounded to 2 decimals.
 */
export function computeRiceScore(fields: Pick<RiceFields, 'reach' | 'impact' | 'confidence' | 'effort'>): number | null {
  const { reach, impact, confidence, effort } = fields;
  if (
    reach === null || reach === undefined ||
    impact === null || impact === undefined ||
    confidence === null || confidence === undefined ||
    effort === null || effort === undefined
  ) {
    return null;
  }
  if (!isFiniteNumber(reach) || !isFiniteNumber(impact) || !isFiniteNumber(confidence)) return null;
  if (!isFiniteNumber(effort) || effort <= 0) return null;
  const raw = (reach * impact * (confidence / 100)) / effort;
  return Math.round(raw * 100) / 100;
}

/**
 * Build a normalized RICE block from raw frontmatter input.
 * Coerces missing fields to null, computes score.
 * Returns null if every input field is null/undefined (no RICE on this task).
 */
export function normalizeRice(raw: unknown): RiceFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const reach = isFiniteNumber(obj.reach) ? obj.reach : null;
  const impact = isFiniteNumber(obj.impact) ? obj.impact : null;
  const confidence = isFiniteNumber(obj.confidence) ? obj.confidence : null;
  const effort = isFiniteNumber(obj.effort) ? obj.effort : null;

  if (reach === null && impact === null && confidence === null && effort === null) {
    return null;
  }

  const score = computeRiceScore({ reach, impact, confidence, effort });
  return { reach, impact, confidence, effort, score };
}

/**
 * Merge a partial RICE update into an existing rice block.
 * `null` in patch means "clear this field". `undefined` means "leave as-is".
 * If all 4 inputs end up null, returns null (block is removed).
 */
export function mergeRice(existing: RiceFields | null, patch: RiceInput): RiceFields | null {
  const base: Pick<RiceFields, 'reach' | 'impact' | 'confidence' | 'effort'> = {
    reach: existing?.reach ?? null,
    impact: existing?.impact ?? null,
    confidence: existing?.confidence ?? null,
    effort: existing?.effort ?? null,
  };

  if (patch.reach !== undefined) base.reach = patch.reach;
  if (patch.impact !== undefined) base.impact = patch.impact;
  if (patch.confidence !== undefined) base.confidence = patch.confidence;
  if (patch.effort !== undefined) base.effort = patch.effort;

  if (base.reach === null && base.impact === null && base.confidence === null && base.effort === null) {
    return null;
  }

  return { ...base, score: computeRiceScore(base) };
}
