import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { isLightMode } from '../../../lib/lightMode';
import { IconButton } from './SuperContainer';
import { prefersReducedMotion } from './motionRunner';
import { STAGE, type Rect } from './superLayout';
import { MAX_FILMSTRIP } from '../../../lib/superTypes';

/** A double-click's second press lands on the panel the first one opened: within this long of
 *  opening, a press with a click count of 2+ means "open them all", not a card or a dismissal. */
export const DOUBLE_OPEN_MS = 500;

/** "Open all", or "Open first 8" for a group bigger than a filmstrip (its first 8 cards open). */
export function openAllLabel(t: (k: string) => string, n: number): string {
  return n > MAX_FILMSTRIP ? t('super.group.openFirst').replace('{n}', String(MAX_FILMSTRIP)) : t('super.group.openAll');
}

/** The open-all button's hint; a group bigger than a filmstrip says which of its cards open. */
export function openAllHint(t: (k: string) => string, n: number): string {
  return n > MAX_FILMSTRIP
    ? t('super.group.openFirstHint').replace('{n}', String(MAX_FILMSTRIP)).replace('{total}', String(n))
    : t('super.group.openAllHint');
}

/** Is this press the second half of the double-click that opened the panel? */
export function isDoubleOpen(openedAt: number, now: number, clicks: number): boolean {
  return clicks >= 2 && now - openedAt >= 0 && now - openedAt <= DOUBLE_OPEN_MS;
}

/** The panel a group (or Others) opens into: its rect on the stage, anchored to the tile it grew
 *  from (a group: over its tile; Others: above its stack, right-aligned), always inside the stage. */
export function panelRect(anchor: Rect, n: number, stage: { width: number; height: number }, system: boolean): Rect {
  const { TILE: T, MARGIN } = STAGE;
  const GAP = 16;
  const cols = Math.max(1, Math.min(n, 4));
  const rows = Math.max(1, Math.ceil(n / cols));
  const width = cols * T + (cols - 1) * GAP + 2 * GAP;
  // Taller than the room it has (the stage, or for Others the space above its stack): the panel
  // stops there and its grid scrolls inside it, so the stack never covers a row.
  const room = (system ? anchor.y - 12 : stage.height - MARGIN) - MARGIN;
  const height = Math.min(48 + rows * T + (rows - 1) * GAP + GAP, Math.max(48 + T + GAP, room));
  let x = system ? anchor.x + anchor.width - width : anchor.x;
  let y = system ? anchor.y - height - 12 : anchor.y + (anchor.height - height) / 2;
  x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, stage.width - MARGIN - width));
  y = Math.min(Math.max(y, MARGIN), Math.max(MARGIN, stage.height - MARGIN - height));
  return { x, y, width, height };
}

/**
 * An open group, or Others (the stage's own group): a scrim over the stage and a panel holding
 * every card as its tile (owner decision 2026-10-20). The panel grows out of the tile it was
 * opened from (one transform + opacity animation, a crossfade under reduced motion, nothing in
 * Light mode). A click on a card shows it side by side; dragging one out takes it out of the
 * group (the surface arms that drag). Escape, the close button or a press on the scrim closes it
 * and focus goes back to the tile. A group's "Open all" (or a double-click on its tile, whose second
 * press lands here) shows every card at once (owner 2026-10-27).
 */
export function GroupPanel({ title, ids, anchor, stage, system, onClose, onUngroup, closableCards, onCloseGroups, onOpenItem, onPressItem, onPresentAll, doubleOpens = false, renderItem, itemTestId, returnFocus, hidden = false }: {
  title: string;
  ids: readonly string[];
  anchor: Rect;
  stage: { width: number; height: number };
  /** Others: no Ungroup, its own hint. */
  system: boolean;
  onClose: () => void;
  onUngroup?: () => void;
  /** Others only: how many cards its groups would close (the live jobs' cards stay), and the close. */
  closableCards?: number;
  onCloseGroups?: () => void;
  onOpenItem: (id: string) => void;
  onPressItem: (e: PointerEvent<HTMLDivElement>, id: string) => void;
  /** A group: show all its cards at once (absent: no button, no double-click). */
  onPresentAll?: () => void;
  /** Opened by a click on its tile: that click's double finishes here (not after "back to the group"). */
  doubleOpens?: boolean;
  renderItem: (id: string) => ReactNode;
  itemTestId: string;
  returnFocus: () => void;
  /** A card is being dragged out of it: still mounted (the item holds the pointer), not drawn. */
  hidden?: boolean;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const rect = panelRect(anchor, ids.length, stage, system);
  const [closeAsk, setCloseAsk] = useState(false);
  const askRef = useRef(false);
  askRef.current = closeAsk;
  const openedAt = useRef(performance.now());
  /** The tile's double-click finishing on the panel: every card at once, nothing else happens. */
  const doubleOpen = (e: { detail: number; preventDefault: () => void; stopPropagation: () => void }): boolean => {
    if (!onPresentAll || !doubleOpens || !isDoubleOpen(openedAt.current, performance.now(), e.detail)) return false;
    e.preventDefault();
    e.stopPropagation();
    onPresentAll();
    return true;
  };

  // Grow out of the tile: the one entrance animation (transform + opacity, one shot).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    if (!panel || !scrim || isLightMode() || typeof panel.animate !== 'function') return;
    if (prefersReducedMotion()) {
      panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
      return;
    }
    const sx = Math.max(0.05, anchor.width / rect.width);
    const sy = Math.max(0.05, anchor.height / rect.height);
    const dx = anchor.x - rect.x;
    const dy = anchor.y - rect.y;
    panel.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.4 }, { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1 }],
      { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'linear' });
    // Opened once per mount: the rect it grew from is the one it was opened from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[data-panel-item]')?.focus());
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      // The close question first: Escape cancels it, the next one closes the panel.
      if (askRef.current) { setCloseAsk(false); return; }
      onClose();
      returnFocus();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose, returnFocus]);

  const onItemKey = (e: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenItem(id); }
  };

  return (
    <>
      <div ref={scrimRef} className="super-panel-scrim" data-testid="super-panel-scrim" data-hidden={hidden ? 'true' : undefined} onPointerDown={() => { if (!onPresentAll || !doubleOpens || performance.now() - openedAt.current > DOUBLE_OPEN_MS) onClose(); }}
        onClickCapture={(e) => { doubleOpen(e); }} aria-hidden />
      <div
        ref={panelRef}
        className="super-group-panel"
        data-testid={system ? 'super-others-fan' : 'super-group-panel'}
        data-system={system ? 'true' : undefined}
        data-hidden={hidden ? 'true' : undefined}
        role="dialog"
        aria-label={title}
        onClickCapture={(e) => { doubleOpen(e); }}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      >
        <div className="super-group-panel-head">
          <span className="super-tile-glyph" aria-hidden>{system ? '⧉' : '▤'}</span>
          <span className="super-group-panel-title">{title}</span>
          <span className="super-tile-count">{ids.length}</span>
          <span className="super-group-panel-hint">{system ? t('super.others.hint') : t('super.group.hint')}</span>
          {!system && onUngroup && (
            <button type="button" className="super-group-panel-btn" data-testid="super-group-panel-ungroup" onClick={() => { onUngroup(); returnFocus(); }}>
              {t('super.group.ungroup')}
            </button>
          )}
          {!system && onPresentAll && (
            <button type="button" className="super-group-panel-btn" data-testid="super-group-panel-open-all" data-first={ids.length > MAX_FILMSTRIP ? MAX_FILMSTRIP : undefined}
              title={openAllHint(t, ids.length)} onClick={() => onPresentAll()}>
              {openAllLabel(t, ids.length)}
            </button>
          )}
          {system && onCloseGroups && (closableCards ?? 0) > 0 && (
            <button type="button" className="super-group-panel-btn" data-testid="super-others-close-groups" onClick={() => setCloseAsk((v) => !v)}>
              {t('super.group.closeOthers')}
            </button>
          )}
          <IconButton icon="close" label={t('super.group.close')} onClick={() => { onClose(); returnFocus(); }} testId="super-group-panel-close" />
        </div>
        {closeAsk && system && onCloseGroups && (
          <div className="super-close-choice" role="group" aria-label={t('super.group.closeOthersAsk')} data-testid="super-others-close-choice">
            <span className="super-close-choice-q">{t('super.group.closeOthersAsk')}</span>
            <button type="button" className="super-close-choice-btn super-close-choice-btn--end" data-testid="super-others-close-end"
              onClick={() => { setCloseAsk(false); onCloseGroups(); }}>
              {t('super.group.closeEnd').replace('{n}', String(closableCards ?? 0))}
            </button>
          </div>
        )}
        <div className="super-group-panel-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(ids.length, 4))}, ${STAGE.TILE}px)` }}>
          {ids.map((id) => (
            <div
              key={id}
              className="super-panel-item"
              data-panel-item
              data-testid={itemTestId}
              data-container-id={id}
              role="button"
              tabIndex={0}
              title={t('super.card.sideBySide')}
              onPointerDown={(e) => onPressItem(e, id)}
              onClick={() => onOpenItem(id)}
              onKeyDown={(e) => onItemKey(e, id)}
            >
              {renderItem(id)}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
