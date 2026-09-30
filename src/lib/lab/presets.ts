/**
 * Card presets: a ready-made block layout for one insight.
 *
 * The funnel explorer preset is ONE card that behaves as an interactive page:
 * a breakdown chip row over tabs Daily, Benchmark, Flow, Steps and one
 * Segments tab per client dimension (the first 4). Every block binds the same
 * insight, so the card's selection drives them all. `lab board add-card
 * --preset funnel-explorer` and the dashboard's add-card entry both call
 * `funnelExplorerBlocks`, so they produce the same spec.
 *
 * PURE and SELF-CONTAINED: no imports, types declared inline, ES2020 only.
 * `scripts/gen-lab-mirrors.mjs` copies this file BYTE-IDENTICAL to
 * `dashboard/src/generated/presets.ts`; `tests/unit/lab-mirrors-drift.test.ts`
 * fails when the copies differ. Edit this file, then re-run the generator.
 */

export type PresetLocale = 'en' | 'tr';

export interface PresetTab {
  label: string;
  blocks: PresetBlock[];
}

/** A block as a board spec stores it (the same shape as the engine's `Block`). */
export interface PresetBlock {
  type: string;
  data?: string;
  options: Record<string, unknown>;
  tabs?: PresetTab[];
}

export interface PresetDim {
  key: string;
  label: string;
}

export const PRESET_IDS = ['funnel-explorer'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** Copy written INTO the spec at insertion, in the chosen locale. */
export const PRESET_LABELS = {
  'funnel-explorer': { en: 'Funnel explorer', tr: 'Huni gezgini' },
  daily: { en: 'Daily', tr: 'Günlük' },
  benchmark: { en: 'Benchmark', tr: 'Kıyas' },
  flow: { en: 'Flow', tr: 'Akış' },
  steps: { en: 'Steps', tr: 'Adımlar' },
} as const;

/** The preset card's grid size. */
export const FUNNEL_EXPLORER_SIZE = { w: 12, h: 12 } as const;

/** Segments tabs the preset adds at most (one per dimension, in declared order). */
export const FUNNEL_EXPLORER_MAX_SEGMENT_TABS = 4;

/** The funnel explorer card's blocks for `insight`, with one Segments tab per dim (first 4). */
export function funnelExplorerBlocks(insight: string, dims: readonly PresetDim[], locale: PresetLocale): PresetBlock[] {
  const lang: PresetLocale = locale === 'tr' ? 'tr' : 'en';
  const page = (label: string, type: string, options: Record<string, unknown>): PresetTab => ({
    label,
    blocks: [{ type, data: insight, options }],
  });
  const tabs: PresetTab[] = [
    page(PRESET_LABELS.daily[lang], 'trend', {}),
    page(PRESET_LABELS.benchmark[lang], 'benchmark', {}),
    page(PRESET_LABELS.flow[lang], 'funnel', { layout: 'flow', markWorst: true }),
    page(PRESET_LABELS.steps[lang], 'funnel', { layout: 'bars', markWorst: true }),
  ];
  for (const dim of dims.slice(0, FUNNEL_EXPLORER_MAX_SEGMENT_TABS)) {
    tabs.push(page(dim.label || dim.key, 'segments', { by: dim.key }));
  }
  return [
    { type: 'breakdown', data: insight, options: {} },
    { type: 'tabs', options: {}, tabs },
  ];
}
