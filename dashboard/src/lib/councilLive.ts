/**
 * Types + phase model for the council debate live state
 * (`_dream_context/tmp/.council-live.json` — written by the council CLI commands,
 * served by GET /api/agent/council-live, session-scoped to the orchestrator's pane).
 * The CLI is the single writer; the chamber panel above the composer and the dock
 * badge are read-only renderers of this state.
 */

export type CouncilPhase = 'setup' | 'debate' | 'interlude' | 'synthesis' | 'done';

export type CouncilPersonaState = 'wait' | 'think' | 'done';

export interface CouncilOption {
  key: string;
  label: string;
}

export interface CouncilLivePersona {
  slug: string;
  model?: string;
  state: CouncilPersonaState;
  stance?: string;
  conviction?: number;
  prevStance?: string;
  prevConviction?: number;
  /** One-line position from the persona's latest verdict, when available. */
  headline?: string;
}

export interface CouncilLiveState {
  debate?: string;
  topic?: string;
  /** Orchestrator's Claude conversation id — scopes the panel to its pane. */
  session?: string;
  started?: string;
  updated?: string;
  phase: string; // setup | debate | interlude | synthesis | done
  round?: number;
  rounds?: number;
  options?: CouncilOption[];
  personas?: CouncilLivePersona[];
  /** 0-100: share of total conviction sitting on the leading stance. */
  convergence?: number;
  /** Option key of the leading stance. */
  leading?: string;
}

export interface CouncilLiveResponse {
  active: boolean;
  state?: CouncilLiveState;
}

export const COUNCIL_PHASE_LABELS: Record<string, string> = {
  setup: 'SETUP',
  debate: 'DEBATE',
  interlude: 'INTERLUDE',
  synthesis: 'SYNTH',
  done: 'DONE',
};

export function councilPhaseLabel(phase: string): string {
  return COUNCIL_PHASE_LABELS[phase] ?? phase.toUpperCase();
}

/**
 * Stable stance palette: each registered option gets a color by its index in the
 * options list (cycled). Free-form stances that never made the options list hash
 * onto the same palette so a stance keeps its color across rounds.
 */
export const COUNCIL_STANCE_PALETTE = [
  '#4dabf7', // blue
  '#fab005', // amber
  '#40c057', // green
  '#b197fc', // violet
  '#fa5252', // red
  '#22d3ee', // cyan
  '#f783ac', // pink
  '#94d82d', // lime
] as const;

/** Palette index for a stance: registered option index first, stable hash fallback. */
export function councilStanceIndex(options: CouncilOption[] | undefined, stance: string | undefined): number {
  if (!stance) return -1;
  const opts = options ?? [];
  const i = opts.findIndex((o) => o.key.toLowerCase() === stance.toLowerCase());
  if (i >= 0) return i % COUNCIL_STANCE_PALETTE.length;
  let h = 0;
  for (let k = 0; k < stance.length; k++) h = (h * 31 + stance.charCodeAt(k)) | 0;
  return Math.abs(h) % COUNCIL_STANCE_PALETTE.length;
}

/**
 * Color for a stance. The palette itself is a DATA encoding (a stance must keep its
 * colour across rounds and across themes), but the no-stance case is UI chrome, so it
 * resolves to the theme's tertiary text token rather than a fixed grey that only read
 * correctly on the old dark-only panel.
 */
export function councilStanceColor(options: CouncilOption[] | undefined, stance: string | undefined): string {
  const i = councilStanceIndex(options, stance);
  return i < 0 ? 'var(--color-text-tertiary)' : COUNCIL_STANCE_PALETTE[i];
}

/** Whole minutes since the debate started, or null when unknown. */
export function councilElapsedMinutes(state: CouncilLiveState): number | null {
  const t = Date.parse(state.started ?? '');
  if (!t) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

export type CouncilShift =
  | { kind: 'stance'; from: string; to: string }
  | { kind: 'conviction'; from: number; to: number; up: boolean }
  | { kind: 'stable' }
  | null;

/** Per-persona shift vs the previous round; null when there is no prior verdict. */
export function councilShift(p: CouncilLivePersona): CouncilShift {
  if (p.prevStance != null && p.stance != null && p.prevStance !== p.stance) {
    return { kind: 'stance', from: p.prevStance, to: p.stance };
  }
  if (p.prevConviction != null && p.conviction != null) {
    const delta = p.conviction - p.prevConviction;
    if (Math.abs(delta) >= 10) {
      return { kind: 'conviction', from: p.prevConviction, to: p.conviction, up: delta > 0 };
    }
    return { kind: 'stable' };
  }
  return null;
}

/** Options tally: per option key → { label, votes, conviction sum }, options order kept. */
export function councilTally(
  state: CouncilLiveState,
): Array<{ key: string; label: string; votes: number; conviction: number }> {
  const personas = state.personas ?? [];
  const seen = new Map<string, { key: string; label: string; votes: number; conviction: number }>();
  for (const o of state.options ?? []) {
    seen.set(o.key.toLowerCase(), { key: o.key, label: o.label, votes: 0, conviction: 0 });
  }
  for (const p of personas) {
    if (!p.stance) continue;
    const k = p.stance.toLowerCase();
    let row = seen.get(k);
    if (!row) {
      row = { key: p.stance, label: p.stance, votes: 0, conviction: 0 };
      seen.set(k, row);
    }
    row.votes += 1;
    row.conviction += p.conviction ?? 0;
  }
  return [...seen.values()];
}
