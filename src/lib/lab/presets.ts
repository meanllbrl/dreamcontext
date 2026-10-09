/**
 * Card presets: a ready-made block layout for one insight.
 *
 * The funnel explorer preset is ONE card that behaves as an interactive page:
 * a breakdown chip row with a funnel picker over the tabs Daily, Benchmark,
 * Ranking, Flow, Steps, Compare, Payment, Access and one Segments tab per
 * client dimension (the first 4). Every block binds the same insight, so the
 * card's funnel pick and selection drive them all. `lab board add-card
 * --preset funnel-explorer`, the dashboard's add-card entry and a derived
 * board's explorer card all call `funnelExplorerBlocks`, so they produce the
 * same spec.
 *
 * Each tab carries a `labelKey` the dashboard localizes (`label` is the copy in
 * the locale chosen at insertion, what the CLI prints and the fallback).
 *
 * PURE and SELF-CONTAINED: no imports, types declared inline, ES2020 only.
 * `scripts/gen-lab-mirrors.mjs` copies this file BYTE-IDENTICAL to
 * `dashboard/src/generated/presets.ts`; `tests/unit/lab-mirrors-drift.test.ts`
 * fails when the copies differ. Edit this file, then re-run the generator.
 */

export type PresetLocale = 'en' | 'tr';

export interface PresetTab {
  label: string;
  /** i18n key the dashboard shows the label in (`lab.explorer.tab.<id>`), when the tab has one. */
  labelKey?: string;
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
  benchmark: { en: 'Benchmark', tr: 'Benchmark' },
  ranking: { en: 'Ranking', tr: 'Sıralama' },
  flow: { en: 'Flow', tr: 'Akış' },
  steps: { en: 'Steps', tr: 'Adımlar' },
  compare: { en: 'Compare', tr: 'Karşılaştır' },
  payment: { en: 'Payment', tr: 'Ödeme' },
  access: { en: 'Access', tr: 'Erişim' },
  platform: { en: 'Platform', tr: 'Platform' },
  country: { en: 'Country', tr: 'Ülke' },
  language: { en: 'Language', tr: 'Dil' },
} as const;

/** Dimensions whose tab label the dashboard localizes (`lab.explorer.tab.dim.<key>`); others keep the payload's label. */
export const WELL_KNOWN_DIMS = ['platform', 'country', 'language'] as const;

/** The preset card's grid size. */
export const FUNNEL_EXPLORER_SIZE = { w: 12, h: 18 } as const;

/** Segments tabs the preset adds at most (one per dimension, in declared order). */
export const FUNNEL_EXPLORER_MAX_SEGMENT_TABS = 4;

/** The i18n key of an explorer tab. */
export function presetTabKey(id: string): string {
  return `lab.explorer.tab.${id}`;
}

/**
 * The card lets the reader pick the funnel: a top-level `breakdown` with
 * `picker: true`. Such a card's blocks without their own `funnel` option follow
 * the pick, so the engine sends them every funnel (`projectFunnelFrame`'s
 * `allFunnels`) and the dashboard hands them the card's pick.
 */
export function cardPicksFunnels(blocks: readonly { type: string; options?: Record<string, unknown> }[] | null | undefined): boolean {
  return (blocks ?? []).some((b) => b.type === 'breakdown' && !!b.options && b.options.picker === true);
}

/** The funnel explorer card's blocks for `insight`: the pages, then one Segments tab per dim (first 4). */
export function funnelExplorerBlocks(insight: string, dims: readonly PresetDim[], locale: PresetLocale): PresetBlock[] {
  const lang: PresetLocale = locale === 'tr' ? 'tr' : 'en';
  const page = (id: keyof typeof PRESET_LABELS, type: string, options: Record<string, unknown>): PresetTab => ({
    label: PRESET_LABELS[id][lang],
    labelKey: presetTabKey(id),
    blocks: [{ type, data: insight, options }],
  });
  const tabs: PresetTab[] = [
    page('daily', 'trend', { chart: 'bar', table: true }),
    page('benchmark', 'benchmark', {}),
    page('ranking', 'ranking', {}),
    page('flow', 'funnel', { layout: 'flow', markWorst: true, compare: 'off' }),
    page('steps', 'funnel', { layout: 'bars', markWorst: true, compare: 'off', table: true }),
    page('compare', 'funnel', { layout: 'bars', markWorst: true, compare: 'lanes' }),
    page('payment', 'payment', {}),
    page('access', 'access', {}),
  ];
  for (const dim of dims.slice(0, FUNNEL_EXPLORER_MAX_SEGMENT_TABS)) {
    const known = (WELL_KNOWN_DIMS as readonly string[]).indexOf(dim.key) !== -1;
    const tab: PresetTab = {
      label: known ? PRESET_LABELS[dim.key as (typeof WELL_KNOWN_DIMS)[number]][lang] : dim.label || dim.key,
      blocks: [{ type: 'segments', data: insight, options: { by: dim.key } }],
    };
    if (known) tab.labelKey = presetTabKey(`dim.${dim.key}`);
    tabs.push(tab);
  }
  return [
    // `locale`: the card speaks its insight's language whatever the dashboard's (the card scopes its own copy).
    { type: 'breakdown', data: insight, options: { picker: true, counts: true, locale: lang } },
    { type: 'tabs', options: {}, tabs },
  ];
}
