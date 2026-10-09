import { hasAccess } from '../../../generated/frameOps';
import type { Block, Frame } from '../board/boardTypes';

/**
 * Which tabs of a funnel explorer card are hidden: a page with nothing to show
 * is left out instead of drawing zeros (the Access page when the snapshot
 * carries no access ladder). Keyed by block type as a plain string so it does
 * not depend on the dashboard's BlockType union.
 *
 * A tab is hidden only when it has blocks and EVERY one of them is a block type
 * listed here whose own frame says it has nothing. Any other block keeps the tab.
 */
export const TAB_HIDES_WHEN_EMPTY: Record<string, (frame: Frame | null) => boolean> = {
  access: (frame) => !(frame?.kind === 'funnel' && hasAccess(frame)),
};

/**
 * The indexes of `block`'s tabs to hide. `frameAt` reads the resolved frame at a
 * full block path; `tabsPath` is the tabs block's own path (a child's path is
 * `[...tabsPath, tabIndex, childIndex]`). Never hides every tab: if all would
 * go, none is hidden (the card keeps its pages and their own empty states).
 */
export function hiddenTabIndexes(
  block: Pick<Block, 'type' | 'tabs'>,
  frameAt: (path: number[]) => Frame | null,
  tabsPath: readonly number[],
): number[] {
  if (block.type !== 'tabs') return [];
  const tabs = block.tabs ?? [];
  const hidden: number[] = [];
  tabs.forEach((tab, ti) => {
    if (tab.blocks.length === 0) return;
    const empty = tab.blocks.every((child, ci) => {
      const hides = TAB_HIDES_WHEN_EMPTY[child.type];
      return !!hides && hides(frameAt([...tabsPath, ti, ci]));
    });
    if (empty) hidden.push(ti);
  });
  return hidden.length === tabs.length ? [] : hidden;
}
