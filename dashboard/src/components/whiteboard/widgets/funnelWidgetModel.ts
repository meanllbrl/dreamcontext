/**
 * Pure helpers for a funnel insight on a whiteboard. No React, no CSS: root vitest imports this.
 */

interface SetLike {
  primary?: string;
  funnels?: readonly { id: string; name: string; steps: readonly { key: string; label: string; users: number }[] }[];
}

/** The funnel a small widget speaks for: the set's `primary`, else the first; null when there is none with steps. */
export function funnelHeadline(set: SetLike | null | undefined): { id: string; name: string; steps: { key: string; label: string; users: number }[] } | null {
  const funnels = set?.funnels ?? [];
  const f = (set?.primary ? funnels.find((x) => x.id === set.primary) : undefined) ?? funnels[0];
  if (!f || f.steps.length === 0) return null;
  return { id: f.id, name: f.name, steps: f.steps.map((s) => ({ key: s.key, label: s.label, users: s.users })) };
}

interface TabsCardLike {
  blocks?: readonly { type: string; options?: Record<string, unknown>; tabs?: readonly { blocks: readonly { type: string; options?: Record<string, unknown> }[] }[] }[];
}

/**
 * Where a funnel-explorer card opens on a whiteboard: the tab that draws its pinned lanes, found
 * by content, not by position, so a re-ordered preset still opens on the lanes. That is the
 * Compare tab (a funnel block with `compare: 'lanes'`); a card without one opens on its first
 * bars funnel (an older preset, whose Steps tab drew the lanes). `{ path: '1', tab: 5 }` for
 * today's preset; null when the card has no funnel tab (it then opens on its first, as in Lab).
 */
export function lanesTab(card: TabsCardLike): { path: string; tab: number } | null {
  const blocks = card.blocks ?? [];
  const find = (match: (c: { type: string; options?: Record<string, unknown> }) => boolean) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type !== 'tabs') continue;
      const tab = (b.tabs ?? []).findIndex((t) => t.blocks.some(match));
      if (tab >= 0) return { path: String(i), tab };
    }
    return null;
  };
  return find((c) => c.type === 'funnel' && c.options?.compare === 'lanes')
    ?? find((c) => c.type === 'funnel' && (c.options?.layout ?? 'bars') === 'bars');
}
