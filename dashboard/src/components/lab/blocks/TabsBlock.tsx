import { Fragment, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { blockRenderKey } from './htmlBlockBridge';
import type { BlockViewProps } from './blockCommon';

/**
 * `tabs`: panels of blocks, one visible at a time. ONE level: a tabs block
 * inside a tab is not drawn (the engine refuses it on write, this only guards
 * a hand-edited file). Children render through `renderChild(child, path)`,
 * where `path` is RELATIVE to this tabs block: `[tabIndex, childIndex]`; the
 * page that hands `renderChild` in prefixes the tabs block's own index (the
 * frame key is `index.tab.child`). Only the active panel is mounted, so an
 * html child gets a fresh instance each time its tab is shown.
 *
 * The open tab is CONTROLLED by the card (`activeTab` / `onTab`) so it survives
 * the card going fullscreen; without them (a detail panel, a test) the block
 * keeps it locally.
 */
export function TabsBlock({ block, renderChild, activeTab, onTab }: BlockViewProps) {
  const { t } = useI18n();
  const tabs = block.tabs ?? [];
  const [local, setLocal] = useState(0);
  const control = typeof activeTab === 'number' && onTab ? { index: activeTab, set: onTab } : null;
  const active = control ? control.index : local;
  const setActive = (i: number) => (control ? control.set(i) : setLocal(i));
  const current = Math.min(Math.max(0, active), Math.max(0, tabs.length - 1));
  const tab = tabs[current];

  return (
    <div className="lab-block-tabs">
      <div className="lab-block-tabs-bar" role="tablist" onClick={(e) => e.stopPropagation()}>
        {tabs.map((tb, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            data-lab-tab={i}
            className="lab-block-tab"
            aria-selected={i === current}
            title={tb.label}
            onClick={() => setActive(i)}
          >{tb.label}</button>
        ))}
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
