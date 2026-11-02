/**
 * The Settings window's menu (new layout only): 16 pages by topic, in the owner's order
 * (task settings-konuya-gore-…, 2026-11-01). Classic Settings keeps its own menu.
 */

export type SwPageId =
  | 'general' | 'chat' | 'voice'
  | 'models' | 'mcp' | 'super' | 'assistant'
  | 'memory' | 'sleep'
  | 'tasks' | 'repos'
  | 'teamsync' | 'mirror' | 'connected' | 'handsfree'
  | 'system';

/** The tabs of the Models page: Defaults, then one per tool. */
export type SwModelsTab = 'defaults' | 'claude' | 'codex' | 'antigravity';

export interface SwGroup {
  id: 'top' | 'agents' | 'memory' | 'project' | 'connections' | 'end';
  /** i18n key of the group label; '' = no label (the top and bottom groups). */
  labelKey: string;
  pages: SwPageId[];
}

export const SW_GROUPS: readonly SwGroup[] = [
  { id: 'top', labelKey: '', pages: ['general', 'chat', 'voice'] },
  { id: 'agents', labelKey: 'shell.sw.group.agents', pages: ['models', 'mcp', 'super', 'assistant'] },
  { id: 'memory', labelKey: 'shell.sw.group.memory', pages: ['memory', 'sleep'] },
  { id: 'project', labelKey: 'shell.sw.group.project', pages: ['tasks', 'repos'] },
  { id: 'connections', labelKey: 'shell.sw.group.connections', pages: ['teamsync', 'mirror', 'connected', 'handsfree'] },
  { id: 'end', labelKey: '', pages: ['system'] },
];

export const SW_PAGES: readonly SwPageId[] = SW_GROUPS.flatMap((g) => g.pages);

export const pageTitleKey = (id: SwPageId): string => `shell.sw.page.${id}`;
export const pageDescKey = (id: SwPageId): string => `shell.sw.page.${id}.d`;
export const groupOf = (id: SwPageId): SwGroup => SW_GROUPS.find((g) => g.pages.includes(id)) ?? SW_GROUPS[0];

export interface SwTarget {
  page: SwPageId;
  tab?: SwModelsTab;
}

/**
 * Where a deep link lands. Every entry point already passes a focus id through `navigate`
 * (the rail, the palette, the composer's "Models ›", `/mcp`, appLink, Stats); unknown = General.
 */
export function swTarget(focusId: string | null | undefined): SwTarget {
  switch (focusId) {
    case 'brain':
    case 'teamsync':
    case 'github': return { page: 'teamsync' };
    case 'system': return { page: 'system' };
    case 'mcp': return { page: 'mcp' };
    case 'models': return { page: 'models', tab: 'defaults' };
    case 'accounts': return { page: 'models', tab: 'claude' };
    case 'accounts-codex': return { page: 'models', tab: 'codex' };
    case 'accounts-antigravity': return { page: 'models', tab: 'antigravity' };
    default: {
      if (focusId && (SW_PAGES as readonly string[]).includes(focusId)) return { page: focusId as SwPageId };
      return { page: 'general' };
    }
  }
}
