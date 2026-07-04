import type { CSSProperties } from 'react';

/**
 * Shared style atoms for the Roadmap top chrome — copied VERBATIM from the Tasks
 * board toolbar/tabs (`components/tasks/BoardToolbar.tsx`) so the Roadmap header
 * is pixel-identical to the Tasks header the team already relies on. Kept as a
 * standalone module (not imported from the tasks board) so this NEVER touches the
 * live Tasks board — same look, zero coupling. The interactive `.bd-*` classes
 * (hover, popover animation, scrollbar) come from `tasks/Board.css`, which is
 * always in the bundle, so we reuse them directly by className.
 */

export type RoadmapLayout = 'timeline' | 'board';
export type RoadmapSortKey = 'manual' | 'target' | 'forecast' | 'progress' | 'title';
export type RoadmapMenuKey = 'filter' | 'viewtype' | 'sort' | 'props' | null;

export const SORT_LABEL: Record<RoadmapSortKey, string> = {
  manual: 'Manual',
  target: 'Target date',
  forecast: 'Forecast',
  progress: 'Progress',
  title: 'Title',
};

/**
 * Roadmap status palette — from the Claude roadmap design (Roadmap.dc.html).
 * Each status has a base color + a lighter shade for gradient bar fills.
 */
export const RM_STATUS: Record<string, { label: string; color: string; lite: string }> = {
  not_started: { label: 'Not started', color: '#7c8396', lite: '#98a0b3' },
  active: { label: 'In progress', color: '#4aa8ff', lite: '#6cbcff' },
  review: { label: 'Review', color: '#e3b341', lite: '#f0c85f' },
  done: { label: 'Done', color: '#3fb950', lite: '#59d16d' },
};

/** Slip red + the roadmap accent purple (design brand colors, theme-independent). */
export const RM_RED = '#f0616d';
export const RM_ACCENT = '#9d8cff';

/** Member-task status → short label + color (maps our task enum to the design chips). */
export const RM_TASK: Record<string, { label: string; color: string }> = {
  completed: { label: 'done', color: '#3fb950' },
  done: { label: 'done', color: '#3fb950' },
  in_review: { label: 'review', color: '#e3b341' },
  in_progress: { label: 'wip', color: '#4aa8ff' },
  todo: { label: 'todo', color: '#7c8396' },
};

/** Compact number: 2000 → "2,000", 43.5 → "43.5" (thousands separators, no trailing zeros). */
export function fmtMetricNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : Number(n.toFixed(2)).toLocaleString();
}

/** A metric value with its unit: unit-first for currency-ish, else value + unit suffix. */
export function fmtMetricValue(value: number, unit: string | null): string {
  if (!unit) return fmtMetricNum(value);
  const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', TRY: '₺' };
  const prefix = sym[unit.toUpperCase()];
  return prefix ? `${prefix}${fmtMetricNum(value)}` : `${fmtMetricNum(value)} ${unit}`;
}

/** hex → rgba with alpha, for soft status tints (mirrors the design's softColor). */
export function softColor(hex: string, a = 0.13): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** status → base color (derived from RM_STATUS; used by list/board/timeline). */
export const STATUS_COLOR: Record<string, string> = {
  not_started: RM_STATUS.not_started.color,
  active: RM_STATUS.active.color,
  review: RM_STATUS.review.color,
  done: RM_STATUS.done.color,
};

/** Target-vs-forecast signal (spec: on-track green, slipping red, unforecastable grey). */
export const SIGNAL_COLOR: Record<string, string> = {
  on_track: '#4ade80',
  slipping: 'var(--color-error)',
  unforecastable: 'var(--color-text-tertiary)',
};

export const chipTrigger = (active: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 11px', borderRadius: 9, cursor: 'pointer',
  fontSize: 12.5, fontWeight: 500, fontFamily: 'var(--font-family-text)', userSelect: 'none',
  border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
  background: active ? 'var(--color-accent-soft)' : 'var(--color-bg)',
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
  fontSize: 10, color: '#fff', background: on ? 'var(--color-accent)' : 'transparent',
  border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border-hover)'}`,
});

export const radioBox = (on: boolean): CSSProperties => ({
  flex: '0 0 auto', width: 15, height: 15, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 8, color: '#fff', background: on ? 'var(--color-accent)' : 'transparent',
  border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border-hover)'}`,
});

export const incBtn = (on: boolean): CSSProperties => ({
  flex: '0 0 auto', width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 11, cursor: 'pointer', color: on ? '#fff' : 'var(--color-text-tertiary)',
  background: on ? 'var(--color-accent)' : 'transparent', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`,
});

export const excBtn = (on: boolean): CSSProperties => ({
  flex: '0 0 auto', width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10, cursor: 'pointer', color: on ? '#fff' : 'var(--color-text-tertiary)',
  background: on ? 'var(--color-error)' : 'transparent', border: `1px solid ${on ? 'var(--color-error)' : 'var(--color-border)'}`,
});
