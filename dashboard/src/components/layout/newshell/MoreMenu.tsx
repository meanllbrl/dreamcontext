import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { Page } from '../Sidebar';

interface MoreMenuProps {
  anchor: HTMLElement | null;
  pages: readonly Page[];
  current: Page | null;
  label: (page: Page) => string;
  icon: (page: Page) => ReactNode;
  onPick: (page: Page) => void;
  onClose: () => void;
}

/** The rail's More: the pages the rail has no row for. Opens beside its button (above it on the
 *  bottom bar) and is clamped inside the window. Esc or a click outside closes it. */
export function MoreMenu({ anchor, pages, current, label, icon, onPick, onClose }: MoreMenuProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Beside the rail; on the bottom bar (anchor near the window's foot) it opens upward.
    const below = a.bottom + m.height + gap <= vh;
    let left = a.right + gap;
    let top = a.top;
    if (a.bottom > vh - 80) { left = a.left + a.width / 2 - m.width / 2; top = a.top - m.height - gap; }
    else if (!below) top = vh - m.height - gap;
    left = Math.max(gap, Math.min(left, vw - m.width - gap));
    top = Math.max(gap, Math.min(top, vh - m.height - gap));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [anchor, onClose]);

  return (
    <div
      ref={ref}
      className="ns-menu ns-more"
      role="menu"
      aria-label={t('nav.more')}
      data-testid="ns-more-menu"
      data-no-drag
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
    >
      <div className="ns-menu-head">{t('nav.more')}</div>
      {pages.map((p) => (
        <button
          key={p}
          type="button"
          role="menuitem"
          className="ns-menu-row"
          data-on={current === p ? 'true' : undefined}
          data-testid={`ns-more-${p}`}
          onClick={() => onPick(p)}
        >
          <span className="ns-menu-icon" aria-hidden="true">{icon(p)}</span>
          <span className="ns-menu-label">{label(p)}</span>
        </button>
      ))}
    </div>
  );
}
