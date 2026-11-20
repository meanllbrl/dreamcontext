/**
 * The presentation window (W3 D14, K14): a Safari-tabbed window as wide as what it shows. Its
 * title row holds the lights (red closes the front tab, yellow puts the presentation away with
 * the rest still waiting), one tab per presentation (a tab never shown yet carries the purple
 * dot; the front one never changes under him), and Mention. Shift-click selects tabs; a right
 * click offers "Close N tabs"; a tab dragged onto the Super's chat lands as its mention chip
 * (the app's own drag type only: an outside drop is not one).
 */
import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import type { Rect } from './superLayout';
import { PRESENT_WIN } from './superLayout';
import { useI18n } from '../../../context/I18nContext';
import { CardLights } from './CardLights';

/** The app's own drag type for a presentation tab; its payload is the id to mention. */
export const PRESENT_TAB_DRAG = 'application/x-dreamcontext-present-tab';

export interface WindowTab {
  key: string;
  name: string;
  /** Cards it shows (a group counts as its pictures). */
  count: number;
  front: boolean;
  /** Never on screen yet: the background dot. */
  unseen: boolean;
  /** What Mention and a drag name: the group, else the first card. */
  mention: string;
}

/** The tabs a close gesture on `key` takes: the selection when `key` is in it, else `key` alone. */
export function tabsToClose(key: string, selected: ReadonlySet<string>): string[] {
  return selected.has(key) && selected.size > 1 ? [...selected] : [key];
}

/** Shift-click toggles `key` in the selection; a plain click selects only it. */
export function nextSelection(selected: ReadonlySet<string>, key: string, shift: boolean): Set<string> {
  if (!shift) return new Set([key]);
  const out = new Set(selected);
  if (out.has(key)) out.delete(key); else out.add(key);
  return out;
}

export function PresentWindow({ win, tabs, onShow, onClose, onMinimize, onMention }: {
  win: Rect;
  tabs: readonly WindowTab[];
  onShow: (key: string) => void;
  onClose: (keys: string[]) => void;
  onMinimize: () => void;
  onMention: (id: string) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; keys: string[] } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const front = tabs.find((x) => x.front) ?? tabs[0];
  // A selection names tabs that are still there.
  const live = new Set([...selected].filter((k) => tabs.some((x) => x.key === k)));

  useEffect(() => {
    if (!menu) return undefined;
    const off = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && rootRef.current?.querySelector('.super-win-menu')?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', off, true);
    window.addEventListener('keydown', off, true);
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', off, true); };
  }, [menu]);

  const click = (e: MouseEvent, tab: WindowTab) => {
    setSelected(nextSelection(live, tab.key, e.shiftKey));
    if (!e.shiftKey && !tab.front) onShow(tab.key);
  };
  const context = (e: MouseEvent, tab: WindowTab) => {
    e.preventDefault();
    const box = rootRef.current?.getBoundingClientRect();
    setMenu({ x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0), keys: tabsToClose(tab.key, live) });
  };
  const drag = (e: DragEvent, tab: WindowTab) => {
    e.dataTransfer.setData(PRESENT_TAB_DRAG, tab.mention);
    e.dataTransfer.effectAllowed = 'link';
  };
  const close = (keys: string[]) => { setMenu(null); setSelected(new Set()); onClose(keys); };

  return (
    <div ref={rootRef} className="super-win" data-testid="super-present-window"
      style={{ left: win.x, top: win.y, width: win.width, height: win.height, ['--win-title-h' as string]: `${PRESENT_WIN.TITLE_H}px` }}>
      <div className="super-win-title" role="group" aria-label={t('super.pq.label')} data-testid="super-present-tabs">
        <CardLights inline
          close={{ label: t('super.win.close'), testId: 'super-win-close', onClick: front ? () => close([front.key]) : undefined }}
          minimize={{ label: t('super.win.minimize'), testId: 'super-win-min', onClick: onMinimize }} />
        <div className="super-win-tabs" role="tablist">
          {tabs.map((tab) => (
            <div key={tab.key} role="tab" tabIndex={0} aria-selected={tab.front} className="super-win-tab"
              data-front={tab.front ? 'true' : undefined} data-picked={live.has(tab.key) && live.size > 1 ? 'true' : undefined}
              data-testid={tab.front ? 'super-present-tab-current' : 'super-present-tab-back'} data-tab-key={tab.key} title={tab.name}
              draggable onDragStart={(e) => drag(e, tab)} onClick={(e) => click(e, tab)} onContextMenu={(e) => context(e, tab)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !tab.front) { e.preventDefault(); onShow(tab.key); } }}>
              {tab.unseen && <span className="super-present-tab-dot" data-testid="super-win-tab-dot" aria-label={t('super.win.unseen')} />}
              <span className="super-present-tab-name">{tab.name}</span>
              {tab.count > 1 && <span className="super-present-tab-count">{tab.count}</span>}
              <button type="button" className="super-win-tab-x" aria-label={t('super.win.closeTab').replace('{name}', tab.name)}
                data-testid="super-win-tab-x" onClick={(e) => { e.stopPropagation(); close([tab.key]); }}>×</button>
            </div>
          ))}
        </div>
        {front && (
          <button type="button" className="super-win-mention" data-testid="super-win-mention" onClick={() => onMention(front.mention)}>
            <span aria-hidden>@</span> {t('super.win.mention')}
          </button>
        )}
      </div>
      {menu && (
        <div className="super-win-menu" role="menu" data-testid="super-win-menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" role="menuitem" data-testid="super-win-menu-close" onClick={() => close(menu.keys)}>
            {menu.keys.length > 1 ? t('super.win.closeTabs').replace('{n}', String(menu.keys.length)) : t('super.win.closeOne')}
          </button>
        </div>
      )}
    </div>
  );
}
