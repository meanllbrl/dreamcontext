import { Fragment, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { blockRenderKey } from './htmlBlockBridge';
import type { BlockViewProps } from './blockCommon';

/** The prefix of the i18n keys a preset tab carries (`lab.explorer.tab.daily`, `lab.explorer.tab.dim.country`). */
const TAB_KEY_PREFIX = 'lab.explorer.tab.';

/** A tab's stable id from its `labelKey` (`daily`, `dim.country`), or null when it has none. */
export function tabKeyOf(labelKey: string | undefined): string | null {
  return typeof labelKey === 'string' && labelKey.startsWith(TAB_KEY_PREFIX) && labelKey.length > TAB_KEY_PREFIX.length
    ? labelKey.slice(TAB_KEY_PREFIX.length)
    : null;
}

/** The tab to show: the requested one unless it is hidden or out of range, else the first visible one. */
export function visibleTab(requested: number, count: number, hidden: readonly number[]): number {
  const current = Math.min(Math.max(0, requested), Math.max(0, count - 1));
  if (!hidden.includes(current)) return current;
  for (let i = 0; i < count; i++) if (!hidden.includes(i)) return i;
  return current;
}

/**
 * `tabs`: panels of blocks, one visible at a time. ONE level: a tabs block
 * inside a tab is not drawn (the engine refuses it on write, this only guards
 * a hand-edited file). Children render through `renderChild(child, path)`,
 * where `path` is RELATIVE to this tabs block: `[tabIndex, childIndex]`; the
 * page that hands `renderChild` in prefixes the tabs block's own index (the
 * frame key is `index.tab.child`). Only the active panel is mounted, so an
 * html child gets a fresh instance each time its tab is shown.
 *
 * A tab with a `labelKey` (the funnel explorer preset) shows that key's copy in
 * the reader's language, falling back to the label written in the spec, and
 * carries `data-lab-tab-key` (the key's id: `daily`, `dim.country`). Tabs in
 * `hiddenTabs` (a page with nothing to show) are not drawn; a hidden active tab
 * falls back to the first visible one.
 *
 * The open tab is CONTROLLED by the card (`activeTab` / `onTab`) so it survives
 * the card going fullscreen; without them (a detail panel, a test) the block
 * keeps it locally.
 */
export function TabsBlock({ block, renderChild, activeTab, onTab, hiddenTabs }: BlockViewProps) {
  const { t } = useI18n();
  const tabs = block.tabs ?? [];
  const hidden = hiddenTabs ?? [];
  const [local, setLocal] = useState(0);
  const control = typeof activeTab === 'number' && onTab ? { index: activeTab, set: onTab } : null;
  const active = control ? control.index : local;
  const setActive = (i: number) => (control ? control.set(i) : setLocal(i));
  const current = visibleTab(active, tabs.length, hidden);
  const tab = tabs[current];
  const labelOf = (labelKey: string | undefined, label: string) => {
    if (!labelKey) return label;
    const copy = t(labelKey);
    return copy && copy !== labelKey ? copy : label;
  };

  return (
    <div className="lab-block-tabs">
      <div className="lab-block-tabs-bar" role="tablist" onClick={(e) => e.stopPropagation()}>
        {tabs.map((tb, i) => {
          if (hidden.includes(i)) return null;
          const text = labelOf(tb.labelKey, tb.label);
          return (
            <button
              key={i}
              type="button"
              role="tab"
              data-lab-tab={i}
              data-lab-tab-key={tabKeyOf(tb.labelKey) ?? undefined}
              className="lab-block-tab"
              aria-selected={i === current}
              title={text}
              onClick={() => setActive(i)}
            >{text}</button>
          );
        })}
      </div>
      <div className="lab-block-tabs-panel" role="tabpanel">
        {!tab || tab.blocks.length === 0 ? (
          <div className="lab-block-empty">{t('lab.blocks.tabs.empty')}</div>
        ) : tab.blocks.map((child, i) => (
          <Fragment key={blockRenderKey(`tab${current}`, [current, i], child)}>
            {child.type === 'tabs'
              ? <div className="lab-block-empty">{t('lab.blocks.tabs.nested')}</div>
              : <div className="lab-block-tabs-child">{renderChild?.(child, [current, i])}</div>}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
