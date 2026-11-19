import type { Page } from '../components/layout/Sidebar';

/**
 * The dashboard's mirror of the plugin registry (`src/lib/plugins/registry.ts`, Mağaza D1 C1).
 * The dashboard bundle cannot import from `src/`, so the fields it needs are copied here and held
 * equal by `tests/unit/plugins-mirror.test.ts` (pattern `mirror-with-drift-test`). Names, taglines,
 * descriptions and example prompts live in i18n under `plugin.<id>.*`.
 */
export type PluginId = 'roadmap' | 'hypotheses' | 'lab' | 'council' | 'marketing' | 'hackathon';
export type PluginCategory = 'product' | 'data' | 'marketing';

export interface PluginMirror {
  id: PluginId;
  /** The page the plugin owns, when it has one. */
  page?: Page;
  category: PluginCategory;
  /** Sleep runs a step for it. */
  sleepStep: boolean;
  /** Its CLI command (the registry's first `cliRoots` entry), when it has one. */
  command?: string;
}

export const PLUGINS: readonly PluginMirror[] = [
  { id: 'roadmap', page: 'roadmap', category: 'product', sleepStep: true, command: 'roadmap' },
  { id: 'hypotheses', page: 'hypotheses', category: 'data', sleepStep: true, command: 'theses' },
  { id: 'lab', page: 'lab', category: 'data', sleepStep: false, command: 'lab' },
  { id: 'council', page: 'council', category: 'product', sleepStep: true, command: 'council' },
  { id: 'hackathon', page: 'hackathon', category: 'product', sleepStep: false, command: 'hackathon' },
  { id: 'marketing', category: 'marketing', sleepStep: true, command: 'marketing' },
];

/** Store sections, in order; a section shows only when a plugin is in it. */
export const PLUGIN_CATEGORIES: readonly PluginCategory[] = ['product', 'data', 'marketing'];

/** Every page a plugin owns. */
export const PLUGIN_PAGES: readonly Page[] = PLUGINS.flatMap((p) => (p.page ? [p.page] : []));

export function isPluginId(v: unknown): v is PluginId {
  return typeof v === 'string' && PLUGINS.some((p) => p.id === v);
}

export function pluginById(id: string): PluginMirror | undefined {
  return PLUGINS.find((p) => p.id === id);
}

export function pluginForPage(page: string): PluginMirror | undefined {
  return PLUGINS.find((p) => p.page === page);
}

export type PluginGive = 'screen' | 'command' | 'agent' | 'sleep';

/** What installing it brings (C1 `gives`, derived): a screen iff it has a page, a command iff it
 *  has a CLI, an agent instruction always, a sleep job iff sleep runs a step for it. */
export function pluginGives(p: PluginMirror): PluginGive[] {
  const out: PluginGive[] = [];
  if (p.page) out.push('screen');
  if (p.command) out.push('command');
  out.push('agent');
  if (p.sleepStep) out.push('sleep');
  return out;
}

/** The tile look per plugin (colours as in the approved list picture), and a glyph. */
export const PLUGIN_LOOK: Record<PluginId, { from: string; to: string }> = {
  roadmap: { from: '#8b5cf6', to: '#6d28d9' },
  hypotheses: { from: '#fb923c', to: '#ea580c' },
  lab: { from: '#3b82f6', to: '#1d4ed8' },
  council: { from: '#374151', to: '#111827' },
  marketing: { from: '#f472b6', to: '#e11d48' },
  hackathon: { from: '#f59e0b', to: '#b45309' },
};

/** One row of `GET /api/plugins` (C3). */
export interface PluginStatus {
  id: string;
  installed: boolean;
  source: 'chosen' | 'data' | 'none';
  hasData: boolean;
  pinned: boolean;
  automations?: Array<{ slug: string; title: string; enabled: boolean }>;
  conflict?: boolean;
  file?: string;
}

export interface PluginsView {
  version: string;
  plugins: PluginStatus[];
}

export type PluginState = 'installed' | 'not-installed' | 'unknown';

/** Unknown is never "not installed": with no set known, every surface behaves as before. */
export function pluginStateIn(set: PluginsView | null | undefined, id: string): PluginState {
  if (!set) return 'unknown';
  const row = set.plugins.find((p) => p.id === id);
  if (!row) return 'unknown';
  return row.installed ? 'installed' : 'not-installed';
}

/** The plugin pages the rail shows: pinned installed ones in registry order; every plugin page
 *  while the set is unknown (as before this feature). */
export function railPluginPages(set: PluginsView | null | undefined): Page[] {
  if (!set) return [...PLUGIN_PAGES];
  return PLUGINS.flatMap((p) => {
    if (!p.page) return [];
    const row = set.plugins.find((r) => r.id === p.id);
    return row?.installed && row.pinned ? [p.page] : [];
  });
}

/** Is this page hidden because its plugin is known to be not installed? */
export function pageHidden(set: PluginsView | null | undefined, page: Page): boolean {
  const p = pluginForPage(page);
  return !!p && pluginStateIn(set, p.id) === 'not-installed';
}

/** The window event `ApiClient` fires when a write is refused for a plugin (C4 notice). */
export const PLUGIN_REFUSED_EVENT = 'dreamcontext-plugin-refused';
export interface PluginRefusedDetail {
  vault: string | null;
  code: 'plugin_not_installed' | 'plugin_entry_conflict';
  plugin: string;
  file?: string;
}
