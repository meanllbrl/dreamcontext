import { computeRiceScore, validateRiceInput, type RiceInput } from './rice.js';

/**
 * priority_suggestion — the agent's proposed RICE values and objective link for a
 * task or an objective, kept in its OWN local-only frontmatter key, apart from
 * `rice` / `objectives`, so a suggestion can never look like, or overwrite, an
 * owner value (pattern: "the agent must not undo what the owner just did").
 *
 * PURE. Everything here is a function of (stored record, target's current values,
 * live objectives). What is still worth showing — the EFFECTIVE suggestion — is
 * derived on every read and at accept time, never stored: stored fields minus
 * whatever the target now holds. So no writer (CLI, ClickUp pull, drag, PATCH)
 * has to remember to clear a suggestion that became stale.
 */

export const RICE_KEYS = ['reach', 'impact', 'confidence', 'effort'] as const;
export type RiceKey = (typeof RICE_KEYS)[number];
export type RiceValues = Record<RiceKey, number | null>;
export type RicePart = Partial<Record<RiceKey, number>>;

export const WHY_MAX = 280;

export interface PrioritySuggestion {
  reach?: number;
  impact?: number;
  confidence?: number;
  effort?: number;
  /** Tasks only: the suggested objective link. */
  objective?: string;
  /** Tasks only: the agent's verdict that no live objective fits. */
  no_objective?: boolean;
  /**
   * When the verdict was given, if earlier than `at`: a later suggestion that carries a
   * live verdict forward keeps its ORIGINAL day, so an objective created since still
   * reopens the question.
   */
  verdict_at?: string;
  why?: string;
  /** Identity: ISO ms timestamp + random suffix. Always a string. */
  at: string;
  dismissed_at: string | null;
  /** Set on the tombstone kept after an accept: {at, accepted_at, no_objective}. */
  accepted_at: string | null;
}

/** What the resolver needs to know about one objective. */
export interface ObjectiveLiveness {
  slug: string;
  /** Effective status is done (override or computed). */
  done: boolean;
  created_at: string | null;
}

/** A suggestion target: a task (has links) or an objective (no links). */
export interface SuggestionTarget {
  kind: 'task' | 'objective';
  rice: RiceValues;
  /** Tasks: current `objectives:` links. Objectives: ignored. */
  objectives?: string[];
  priority_suggestion: PrioritySuggestion | null;
}

export interface EffectiveSuggestion {
  at: string;
  why: string;
  /** Only the fields the target still lacks; null when none remain. */
  rice: RicePart | null;
  /** A live objective to link, only while the task has no live link. */
  objective: string | null;
}

export type SuggestionRefusal = 'owner_scored' | 'owner_linked' | 'dismissed';

/** ISO ms timestamp + a random suffix: unique even for two writes in one ms. */
export function newSuggestionAt(now: Date = new Date()): string {
  return `${now.toISOString()}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function strOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return null;
}

/** Read a stored record defensively; anything without an `at` is no record. */
export function normalizePrioritySuggestion(raw: unknown): PrioritySuggestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const at = strOrNull(r.at);
  if (!at) return null;
  const out: PrioritySuggestion = {
    at,
    dismissed_at: strOrNull(r.dismissed_at),
    accepted_at: strOrNull(r.accepted_at),
  };
  for (const k of RICE_KEYS) if (finite(r[k])) out[k] = r[k] as number;
  if (typeof r.objective === 'string' && r.objective.trim()) out.objective = r.objective.trim();
  if (r.no_objective === true) out.no_objective = true;
  const verdictAt = strOrNull(r.verdict_at);
  if (verdictAt && out.no_objective) out.verdict_at = verdictAt;
  if (typeof r.why === 'string' && r.why.trim()) out.why = r.why.trim();
  return out;
}

/** The record as written to frontmatter (no undefined keys, stable order). */
export function serializePrioritySuggestion(s: PrioritySuggestion): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RICE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  if (s.objective !== undefined) out.objective = s.objective;
  if (s.no_objective !== undefined) out.no_objective = s.no_objective;
  if (s.verdict_at !== undefined) out.verdict_at = s.verdict_at;
  if (s.why !== undefined) out.why = s.why;
  out.at = s.at;
  out.dismissed_at = s.dismissed_at;
  out.accepted_at = s.accepted_at;
  return out;
}

export function ricePartOf(s: Pick<PrioritySuggestion, RiceKey>): RicePart {
  const out: RicePart = {};
  for (const k of RICE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

export function missingRiceKeys(rice: RiceValues): RiceKey[] {
  return RICE_KEYS.filter((k) => rice[k] === null || rice[k] === undefined);
}

export function isScored(rice: RiceValues): boolean {
  return computeRiceScore(rice) !== null;
}

function liveSet(objectives: readonly ObjectiveLiveness[]): Set<string> {
  return new Set(objectives.filter((o) => !o.done).map((o) => o.slug));
}

/** Links that point at an existing, not-done objective. */
export function liveLinks(links: readonly string[] | undefined, objectives: readonly ObjectiveLiveness[]): string[] {
  const live = liveSet(objectives);
  return (links ?? []).filter((l) => live.has(l));
}

/**
 * Why a task with links has no live one: 'done' when every link is a done
 * objective... strictly: 'missing' when any link names no objective, else 'done'.
 * null when it has a live link or no links at all.
 */
export function deadLinkMark(
  links: readonly string[] | undefined,
  objectives: readonly ObjectiveLiveness[],
): 'objective done' | 'objective missing' | null {
  const all = links ?? [];
  if (all.length === 0 || liveLinks(all, objectives).length > 0) return null;
  const known = new Set(objectives.map((o) => o.slug));
  return all.some((l) => !known.has(l)) ? 'objective missing' : 'objective done';
}

/** Calendar day (YYYY-MM-DD) of an ISO-ish string, or null. */
function dayOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}

/**
 * A `no_objective` verdict counts only while no live objective was created on a
 * later calendar day than the verdict: a new objective reopens the question.
 */
export function hasLiveVerdict(
  s: PrioritySuggestion | null,
  objectives: readonly ObjectiveLiveness[],
): boolean {
  if (!s || s.no_objective !== true) return false;
  const verdictDay = dayOf(s.verdict_at ?? s.at);
  if (!verdictDay) return false;
  let newest: string | null = null;
  for (const o of objectives) {
    if (o.done) continue;
    const d = dayOf(o.created_at);
    if (d && (!newest || d > newest)) newest = d;
  }
  return !newest || verdictDay >= newest;
}

/**
 * The ONE resolver. Returns what is still worth proposing, or null when the
 * record is dismissed, accepted, or has nothing left that the target lacks.
 * A verdict is never part of it (a verdict is never pending).
 */
export function effectiveSuggestion(
  target: SuggestionTarget,
  objectives: readonly ObjectiveLiveness[],
): EffectiveSuggestion | null {
  const s = target.priority_suggestion;
  if (!s || s.dismissed_at || s.accepted_at) return null;

  let rice: RicePart | null = null;
  for (const k of RICE_KEYS) {
    const v = s[k];
    if (v === undefined) continue;
    if (target.rice[k] !== null && target.rice[k] !== undefined) continue;
    rice = { ...(rice ?? {}), [k]: v };
  }

  let objective: string | null = null;
  if (target.kind === 'task' && s.objective) {
    const live = liveSet(objectives);
    if (live.has(s.objective) && liveLinks(target.objectives, objectives).length === 0) {
      objective = s.objective;
    }
  }

  if (!rice && !objective) return null;
  return { at: s.at, why: s.why ?? '', rice, objective };
}

export interface SuggestionInput {
  reach?: number;
  impact?: number;
  confidence?: number;
  effort?: number;
  objective?: string;
  no_objective?: boolean;
  why?: string;
}

/** Shape validation of a new suggestion (no target needed). Returns messages. */
export function validatePrioritySuggestion(input: SuggestionInput, kind: 'task' | 'objective'): string[] {
  const errors: string[] = [];
  const rice: RiceInput = {};
  for (const k of RICE_KEYS) if (input[k] !== undefined) rice[k] = input[k];
  for (const e of validateRiceInput(rice)) errors.push(`${e.field}: ${e.message}`);
  const why = typeof input.why === 'string' ? input.why.trim() : '';
  if (!why) errors.push('why: a one-sentence reason is required');
  else if (why.length > WHY_MAX) errors.push(`why: at most ${WHY_MAX} characters`);
  if (kind === 'objective' && (input.objective !== undefined || input.no_objective)) {
    errors.push('objective: an objective cannot be linked to an objective');
  }
  if (input.objective !== undefined && input.no_objective) {
    errors.push('objective: a suggested link and a no-objective verdict contradict each other');
  }
  const hasRice = RICE_KEYS.some((k) => input[k] !== undefined);
  if (!hasRice && input.objective === undefined && !input.no_objective) {
    errors.push('a suggestion needs RICE values, an objective, or a no-objective verdict; why alone is not one');
  }
  return errors;
}

/**
 * Would writing this suggestion contradict the owner? Checked INSIDE the write
 * lock against a fresh read.
 *  - owner_scored: the payload carries a RICE field the target already holds.
 *  - owner_linked: the payload carries a link or verdict and the task already has a live link.
 *  - dismissed: the stored record was dismissed and `again` was not given.
 */
export function suggestionRefusal(
  target: SuggestionTarget,
  input: SuggestionInput,
  objectives: readonly ObjectiveLiveness[],
  opts: { again?: boolean } = {},
): SuggestionRefusal | null {
  for (const k of RICE_KEYS) {
    if (input[k] !== undefined && target.rice[k] !== null && target.rice[k] !== undefined) return 'owner_scored';
  }
  if (target.kind === 'task' && (input.objective !== undefined || input.no_objective)
      && liveLinks(target.objectives, objectives).length > 0) {
    return 'owner_linked';
  }
  if (target.priority_suggestion?.dismissed_at && !opts.again) return 'dismissed';
  return null;
}

/**
 * What the target still needs that this suggestion leaves open. A suggestion has
 * to close every open side of its target so that accepting it removes the item
 * from the scoring work — the invariant that one full agent pass takes N to 0.
 */
export function suggestionGaps(
  target: SuggestionTarget,
  input: SuggestionInput,
  objectives: readonly ObjectiveLiveness[],
): string[] {
  const gaps: string[] = [];
  const missing = missingRiceKeys(target.rice);
  const given = RICE_KEYS.filter((k) => input[k] !== undefined);
  if (missing.length > 0) {
    const lacking = missing.filter((k) => input[k] === undefined);
    if (lacking.length > 0) gaps.push(`RICE: also give ${lacking.map((k) => `--${k}`).join(' ')}`);
  } else if (given.length === 0 && target.kind === 'objective') {
    gaps.push('nothing to suggest: this objective is already scored');
  }
  if (target.kind === 'task') {
    const linked = liveLinks(target.objectives, objectives).length > 0;
    if (!linked && input.objective === undefined && !input.no_objective && !hasLiveVerdict(target.priority_suggestion, objectives)) {
      gaps.push('link: give --objective <slug> or --no-objective');
    }
    if (linked && missing.length === 0 && given.length === 0) {
      gaps.push('nothing to suggest: this task is already scored and linked');
    }
  }
  return gaps;
}

export interface AcceptPlan {
  outcome: 'applied' | 'already_applied' | 'nothing_to_apply';
  /** New rice values (all four), or undefined when RICE is unchanged. */
  rice?: RiceValues;
  /** New links, or undefined when links are unchanged. */
  objectives?: string[];
  /** The record to store afterwards (the tombstone), or undefined to leave it. */
  record?: PrioritySuggestion;
  /** The stored suggestion named a link that is no longer live: it was dropped. */
  linkDropped: string | null;
  /** RICE keys that were empty before and are filled now. */
  filled: RiceKey[];
}

export type AcceptRefusal = 'suggestion_changed' | 'suggestion_dismissed';

/**
 * Plan an accept. `at` must equal the stored record's `at`; `edits` are the
 * owner's explicit RICE values from the panel (owner values: they may set any
 * field). Only the EFFECTIVE suggestion plus those edits are applied, so a CLI
 * score or a link that landed after the suggestion is never overwritten.
 */
export function planAccept(
  target: SuggestionTarget,
  at: string,
  edits: RicePart,
  objectives: readonly ObjectiveLiveness[],
  now: Date = new Date(),
): AcceptPlan | AcceptRefusal {
  const s = target.priority_suggestion;
  if (!s || s.at !== at) return 'suggestion_changed';
  if (s.accepted_at) return { outcome: 'already_applied', linkDropped: null, filled: [] };
  if (s.dismissed_at) return 'suggestion_dismissed';

  const tombstone: PrioritySuggestion = {
    at: s.at,
    accepted_at: now.toISOString(),
    dismissed_at: null,
    no_objective: s.no_objective === true,
    ...(s.verdict_at ? { verdict_at: s.verdict_at } : {}),
  };
  const eff = effectiveSuggestion(target, objectives);
  const hasEdits = RICE_KEYS.some((k) => edits[k] !== undefined);
  const linkDropped = target.kind === 'task' && s.objective && !eff?.objective
    && liveLinks(target.objectives, objectives).length === 0
    ? s.objective
    : null;

  if (!eff && !hasEdits) {
    return { outcome: 'nothing_to_apply', record: tombstone, linkDropped, filled: [] };
  }

  let rice: RiceValues | undefined;
  const filled: RiceKey[] = [];
  if (eff?.rice || hasEdits) {
    const next: RiceValues = { ...target.rice };
    for (const k of RICE_KEYS) {
      const v = edits[k] ?? eff?.rice?.[k];
      if (v === undefined) continue;
      if (next[k] === null || next[k] === undefined) filled.push(k);
      next[k] = v;
    }
    rice = next;
  }

  let links: string[] | undefined;
  if (eff?.objective) {
    links = Array.from(new Set([...(target.objectives ?? []), eff.objective]));
  }

  return { outcome: 'applied', rice, objectives: links, record: tombstone, linkDropped, filled };
}

/** Plan a dismiss: the record keeps its fields and gains `dismissed_at`. */
export function planDismiss(
  target: SuggestionTarget,
  at: string,
  now: Date = new Date(),
): PrioritySuggestion | 'suggestion_changed' | 'already_dismissed' {
  const s = target.priority_suggestion;
  if (!s || s.at !== at || s.accepted_at) return 'suggestion_changed';
  if (s.dismissed_at) return 'already_dismissed';
  return { ...s, dismissed_at: now.toISOString() };
}

/**
 * Build a new record from validated input. `previous` is the record it replaces: a live
 * `no_objective` verdict on it is carried forward (with its original day) when the new
 * input carries no link part of its own — otherwise a RICE-only re-score would erase the
 * verdict and the task's link side would come back as work after accepting it.
 */
export function buildSuggestionRecord(
  input: SuggestionInput,
  now: Date = new Date(),
  carry?: { previous: PrioritySuggestion | null; objectives: readonly ObjectiveLiveness[] },
): PrioritySuggestion {
  const rec: PrioritySuggestion = { at: newSuggestionAt(now), dismissed_at: null, accepted_at: null };
  for (const k of RICE_KEYS) if (input[k] !== undefined) rec[k] = input[k];
  if (input.objective !== undefined) rec.objective = input.objective;
  if (input.no_objective) rec.no_objective = true;
  const prev = carry?.previous ?? null;
  if (input.objective === undefined && !input.no_objective && prev && hasLiveVerdict(prev, carry!.objectives)) {
    rec.no_objective = true;
    rec.verdict_at = prev.verdict_at ?? prev.at;
  }
  rec.why = (input.why ?? '').trim();
  return rec;
}

/** Validate an owner's RICE edits sent with an accept. */
export function validateEdits(raw: unknown): { edits: RicePart } | { error: string } {
  if (raw === undefined || raw === null) return { edits: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'rice must be an object' };
  const r = raw as Record<string, unknown>;
  const edits: RicePart = {};
  for (const k of RICE_KEYS) {
    if (r[k] === undefined || r[k] === null) continue;
    if (!finite(r[k])) return { error: `${k} must be a number` };
    edits[k] = r[k] as number;
  }
  const errs = validateRiceInput(edits);
  if (errs.length > 0) return { error: errs.map((e) => `${e.field}: ${e.message}`).join('; ') };
  return { edits };
}

export type SuggestionErrorCode =
  | SuggestionRefusal
  | AcceptRefusal
  | 'invalid'
  | 'incomplete'
  | 'not_found'
  | 'invalid_objective';

/** A refused or invalid suggestion write; `code` maps 1:1 onto the HTTP error code. */
export class SuggestionError extends Error {
  constructor(public readonly code: SuggestionErrorCode, message: string) {
    super(message);
    this.name = 'SuggestionError';
  }

  static refusal(code: SuggestionRefusal, slug: string): SuggestionError {
    const msg = code === 'owner_scored'
      ? `Refused (owner_scored): ${slug} already holds an owner value for a RICE field in this suggestion. Suggest only the fields it lacks.`
      : code === 'owner_linked'
        ? `Refused (owner_linked): ${slug} is already linked to a live objective.`
        : `Refused (dismissed): the owner dismissed the last suggestion for ${slug}. Pass --again only if asked to re-score.`;
    return new SuggestionError(code, msg);
  }

  /** HTTP status for this code. */
  get httpStatus(): number {
    if (this.code === 'not_found') return 404;
    if (this.code === 'invalid' || this.code === 'incomplete' || this.code === 'invalid_objective') return 400;
    return 409;
  }
}

/** A task's suggestion target, read from raw frontmatter. */
export function taskSuggestionTarget(data: Record<string, unknown>): SuggestionTarget {
  const r = (data.rice && typeof data.rice === 'object' && !Array.isArray(data.rice) ? data.rice : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (finite(v) ? v : null);
  return {
    kind: 'task',
    rice: { reach: num(r.reach), impact: num(r.impact), confidence: num(r.confidence), effort: num(r.effort) },
    objectives: Array.isArray(data.objectives)
      ? (data.objectives as unknown[]).map((s) => String(s).trim()).filter(Boolean)
      : [],
    priority_suggestion: normalizePrioritySuggestion(data.priority_suggestion),
  };
}

export interface LinkMovePlan {
  links: string[];
  changed: boolean;
  note: 'already_linked' | null;
  /** The op that puts the links back as they were (position included). */
  undo: { remove: string | null; add: string | null; index?: number };
}

/**
 * Move ONE link, applied to the links as they are NOW (a fresh read): remove the
 * source, add the target at the source's position (or `index`). Dropping onto an
 * objective the task already holds removes the source only, and says so. Every
 * other link stays where it is.
 *   [A,B] move A→B  → [B]      undo {add: A, index: 0}
 *   [A,B] move A→C  → [C,B]    undo {remove: C, add: A, index: 0}
 *   [A,B] move A→∅  → [B]      undo {add: A, index: 0}
 */
export function planLinkMove(
  current: readonly string[],
  op: { remove: string | null; add: string | null; index?: number },
): LinkMovePlan {
  const links = [...current];
  let removedAt = -1;
  let removed: string | null = null;
  if (op.remove !== null && op.remove !== op.add) {
    removedAt = links.indexOf(op.remove);
    if (removedAt >= 0) {
      links.splice(removedAt, 1);
      removed = op.remove;
    }
  }
  let added: string | null = null;
  let note: LinkMovePlan['note'] = null;
  if (op.add !== null) {
    if (links.includes(op.add)) {
      if (op.remove !== null && op.remove !== op.add) note = 'already_linked';
    } else {
      const at = op.index !== undefined
        ? Math.max(0, Math.min(links.length, Math.trunc(op.index)))
        : removedAt >= 0 ? removedAt : links.length;
      links.splice(at, 0, op.add);
      added = op.add;
    }
  }
  const changed = removed !== null || added !== null;
  const undo: LinkMovePlan['undo'] = { remove: added, add: removed };
  if (removed !== null) undo.index = removedAt;
  return { links, changed, note, undo };
}
