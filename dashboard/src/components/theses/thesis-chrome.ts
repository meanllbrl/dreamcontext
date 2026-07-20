import type { CSSProperties } from 'react';

/**
 * Shared style atoms for the Hypotheses board toolbar/columns — same pattern as
 * `components/roadmap/chrome.ts` (copied atoms, not imported, so this module
 * never couples to the Roadmap or Tasks boards even though it reuses their
 * interactive `.bd-*` classes from `tasks/Board.css`, which is always in the
 * bundle). Colors reference the `--thesis-*` custom properties from
 * `theses.css` (the PO's pinned semantic palette), not the generic `--color-*`
 * ramp, since the design fixes these exact hexes for both themes.
 */

export type ThesisMenuKey = 'status' | 'kind' | 'objective' | 'sort' | 'display' | null;
export type ThesisSortKey = 'updated' | 'confidence' | 'staleness';

export const SORT_LABEL: Record<ThesisSortKey, string> = {
  updated: 'Recently updated',
  confidence: 'Confidence',
  staleness: 'Staleness',
};

export const STATUS_META: Record<string, { label: string; colorVar: string }> = {
  draft: { label: 'Draft', colorVar: 'var(--thesis-draft)' },
  open: { label: 'Open', colorVar: 'var(--thesis-open)' },
  validated: { label: 'Validated', colorVar: 'var(--thesis-validated)' },
  invalidated: { label: 'Invalidated', colorVar: 'var(--thesis-invalidated)' },
  retired: { label: 'Retired', colorVar: 'var(--thesis-retired)' },
};

/** Base board columns, always rendered; Retired is appended only when Archive is on. */
export const BASE_COLUMNS = ['draft', 'open', 'validated', 'invalidated'] as const;

export const KIND_META: Record<string, { glyph: string; label: string; colorVar: string }> = {
  observational: { glyph: '👁', label: 'Observational', colorVar: 'var(--thesis-violet)' },
  experimental: { glyph: '⚗', label: 'Experimental', colorVar: 'var(--thesis-amber)' },
};

/**
 * "Checked N day(s) ago" + a stale flag. The captured design specs "N cycle(s)
 * ago" against a sleep-cycle counter, but `ThesisView` (server contract, wave
 * 3/T7) exposes no such counter — only `cycles_checked` (a lifetime total) and
 * `checked_at` (a date). Cycles-since-checked isn't honestly derivable from
 * that, so this uses day-since-`checked_at` instead (an analogous, honestly
 * derivable recency signal) and labels it accordingly rather than fabricating a cycle
 * count. The "≥5" staleness threshold is kept as the same magic number the
 * design pins, reapplied to days.
 */
export const STALE_DAYS_THRESHOLD = 5;

export function daysSince(dateStr: string): number {
  const then = new Date(`${dateStr}T00:00:00Z`).getTime();
  if (Number.isNaN(then)) return Infinity;
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/**
 * Best-effort "flipped this cycle" signal — mirrors ThesisDetailModal's own
 * (there's no explicit `flipped` flag from the server): a validated/invalidated
 * thesis whose latest write is the SAME write that recorded its most recent
 * evidence check is treated as flipped this cycle.
 */
export function isFlippedThisCycle(t: { status: string; checked_at: string | null; updated_at: string }): boolean {
  return (t.status === 'validated' || t.status === 'invalidated')
    && t.checked_at !== null
    && t.checked_at === t.updated_at;
}

export const chipTrigger = (active: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 11px', borderRadius: 9, cursor: 'pointer',
  fontSize: 12.5, fontWeight: 500, fontFamily: 'var(--font-family-text)', userSelect: 'none',
  border: `1px solid ${active ? 'var(--thesis-violet)' : 'var(--color-border)'}`,
  background: active ? 'rgba(157,140,255,0.13)' : 'var(--color-bg)',
  color: active ? 'var(--color-text)' : 'var(--color-text-secondary)', transition: 'all .12s', whiteSpace: 'nowrap',
});

export const popBase: CSSProperties = {
  position: 'absolute', top: 42, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6, zIndex: 40,
};

export const optRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 7, cursor: 'pointer',
  fontSize: 13, color: 'var(--color-text-secondary)',
};

export const sectionLabel: CSSProperties = {
  padding: '6px 8px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
  color: 'var(--color-text-tertiary)',
};

export const checkBox = (on: boolean): CSSProperties => ({
  flex: '0 0 auto', width: 16, height: 16, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10, color: '#fff', background: on ? 'var(--thesis-violet)' : 'transparent',
  border: `1px solid ${on ? 'var(--thesis-violet)' : 'var(--color-border-hover)'}`,
});

export const radioBox = (on: boolean): CSSProperties => ({
  flex: '0 0 auto', width: 15, height: 15, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 8, color: '#fff', background: on ? 'var(--thesis-violet)' : 'transparent',
  border: `1px solid ${on ? 'var(--thesis-violet)' : 'var(--color-border-hover)'}`,
});
