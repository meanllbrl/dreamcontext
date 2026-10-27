import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { isLightMode } from '../../../lib/lightMode';
import { IconButton, frameKeyOf } from './SuperContainer';
import { useLiveSession } from './liveSession';
import type { ChatSession } from '../chatSession';
import { prefersReducedMotion } from './motionRunner';
import { STAGE, type Rect } from './superLayout';
import { MAX_FILMSTRIP, type ContainerKind } from '../../../lib/superTypes';

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

/**
 * What a card's × in a panel does (owner 2026-10-28: "close cards straight from Others"): the
 * stage's own close for each kind, never a new one. A plain card closes at once; a child chat
 * asks first, as its card on the stage does (end it, or end it when its turn is done); a group
 * asks first, as its close-all does, and closes the cards that are not running jobs; a group of
 * running jobs only says why nothing closes. The agenda is never closed (null: no ×).
 */
export type PanelClose =
  | { kind: 'now' }
  | { kind: 'end'; whenDone: boolean; ending?: 'pending' | 'failed' }
  | { kind: 'group'; n: number }
  | { kind: 'kept' };

export function panelCloseOf(item: { kind: ContainerKind | 'group'; closable?: number; busy?: boolean; ending?: 'pending' | 'failed' }): PanelClose | null {
  if (item.kind === 'agenda') return null;
  if (item.kind === 'group') return (item.closable ?? 0) > 0 ? { kind: 'group', n: item.closable ?? 0 } : { kind: 'kept' };
  if (item.kind === 'chat') return { kind: 'end', whenDone: !!item.busy, ...(item.ending ? { ending: item.ending } : {}) };
  return { kind: 'now' };
}

/** Carry out a panel close on the stage's close paths. False: nothing to do (a group of running jobs). */
export function runPanelClose(id: string, close: PanelClose, paths: {
  closeCard: (id: string) => void;
  endChat: (id: string, whenDone: boolean) => void;
  closeGroup: (id: string) => void;
}): boolean {
  if (close.kind === 'now') paths.closeCard(id);
  else if (close.kind === 'end') paths.endChat(id, close.whenDone);
  else if (close.kind === 'group') paths.closeGroup(id);
  else return false;
  return true;
}

/** A panel tile's ×, its question when the close asks first, and a chat's "ends when done" or
 *  "not ended" line. Presses here are its own: never the tile's drag or "side by side". A chat
 *  tile follows its child's status, as its stage card does: the question turns to "End when
 *  done" the moment the child starts working. */
export function PanelItemClose({ closeOf, session, asking, onToggle, onConfirm }: {
  /** Read at every render (the child's status re-renders this), never a copy. */
  closeOf: () => PanelClose | null;
  session?: ChatSession;
  asking: boolean;
  onToggle: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  useLiveSession(session, () => frameKeyOf(session));
  const close = closeOf();
  if (!close) return null;
  const label = close.kind === 'now' ? t('super.panel.closeCard') : close.kind === 'end' ? t('super.close.chatLabel') : t('super.group.closeCards');
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <>
      <div className="super-panel-close" data-asking={asking ? 'true' : undefined}>
        <IconButton icon="close" label={label} onClick={close.kind === 'now' ? onConfirm : onToggle} testId="super-panel-item-close" expanded={close.kind === 'now' ? undefined : asking} />
      </div>
      {asking && close.kind !== 'now' && (
        <div className="super-close-choice" role="group" data-testid="super-panel-close-choice" onPointerDown={stop} onClick={stop} onKeyDown={stop}
          aria-label={close.kind === 'end' ? t('super.close.ask') : close.kind === 'group' ? t('super.group.closeAsk') : t('super.panel.closeKept')}>
          <span className="super-close-choice-q">{close.kind === 'end' ? t('super.close.ask') : close.kind === 'group' ? t('super.group.closeAsk') : t('super.panel.closeKept')}</span>
          {close.kind !== 'kept' && (
            <button type="button" className="super-close-choice-btn super-close-choice-btn--end" data-testid="super-panel-close-end" onClick={onConfirm}>
              {close.kind === 'group' ? t('super.group.closeEnd').replace('{n}', String(close.n)) : close.whenDone ? t('super.close.endWhenDone') : t('super.close.end')}
            </button>
          )}
        </div>
      )}
      {close.kind === 'end' && close.ending && !asking && (
        <span className={`super-close-pending${close.ending === 'failed' ? ' super-close-pending--failed' : ''}`} role={close.ending === 'failed' ? 'alert' : undefined}
          data-testid={close.ending === 'failed' ? 'super-panel-close-failed' : 'super-panel-close-pending'}>
          {close.ending === 'failed' ? t('super.close.failed') : t('super.close.pending')}
        </span>
      )}
    </>
  );
}

const PANEL_GAP = 16;

/** How many tiles a panel row holds: up to 4, never wider than the stage (a phone-width stage
 *  holds one column; a cut-off column would hide its cards and their ×). */
export function panelCols(n: number, stageWidth: number): number {
  const fit = Math.floor((stageWidth - 2 * STAGE.MARGIN - PANEL_GAP) / (STAGE.TILE + PANEL_GAP));
  return Math.max(1, Math.min(n, 4, fit));
}

/** The panel a group (or Others) opens into: its rect on the stage, anchored to the tile it grew
 *  from (a group: over its tile; Others: above its stack, right-aligned), always inside the stage. */
export function panelRect(anchor: Rect, n: number, stage: { width: number; height: number }, system: boolean): Rect {
  const { TILE: T, MARGIN } = STAGE;
  const GAP = PANEL_GAP;
  const cols = panelCols(n, stage.width);
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
export function GroupPanel({ title, ids, anchor, stage, system, onClose, onUngroup, closableCards, onCloseGroups, closeOf, sessionOf, onCloseItem, onOpenItem, onPressItem, onPresentAll, doubleOpens = false, renderItem, itemTestId, returnFocus, hidden = false }: {
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
  /** Each tile's × (absent, or null for a card: no ×), and its close once confirmed. */
  closeOf?: (id: string) => PanelClose | null;
  /** A chat tile's live session, so its × follows the child's status. */
  sessionOf?: (id: string) => ChatSession | undefined;
  onCloseItem?: (id: string, close: PanelClose) => void;
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
  // The tile whose × asks its question now (one at a time).
  const [itemAsk, setItemAsk] = useState<string | null>(null);
  const askRef = useRef(false);
  askRef.current = closeAsk || itemAsk !== null;
  // A tile closed from here: once it has left, focus goes to the one now in its place.
  const refocusAt = useRef<number | null>(null);
  const idsKey = ids.join('\u0001');
  useEffect(() => {
    const at = refocusAt.current;
    if (at === null) return;
    refocusAt.current = null;
    const items = panelRef.current?.querySelectorAll<HTMLElement>('[data-panel-item]');
    if (items?.length) items[Math.min(at, items.length - 1)].focus();
  }, [idsKey]);
  // A tile whose question is open left some other way: its question goes with it.
  useEffect(() => { setItemAsk((a) => (a !== null && !ids.includes(a) ? null : a)); }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeItem = (id: string) => {
    setItemAsk(null);
    // Read again at the press, never the copy drawn earlier: a child that started working since
    // is ended when done, not cut mid-turn.
    const close = closeOf?.(id);
    if (!close || !onCloseItem) return;
    // An end that waits for the turn leaves the tile where it is: nothing to refocus.
    refocusAt.current = close.kind === 'end' && close.whenDone ? null : ids.indexOf(id);
    onCloseItem(id, close);
  };
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
      if (askRef.current) { setCloseAsk(false); setItemAsk(null); return; }
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
        <div className="super-group-panel-grid" style={{ gridTemplateColumns: `repeat(${panelCols(ids.length, stage.width)}, ${STAGE.TILE}px)` }}>
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
              {onCloseItem && closeOf && (
                <PanelItemClose closeOf={() => closeOf(id)} session={sessionOf?.(id)} asking={itemAsk === id}
                  onToggle={() => setItemAsk((a) => (a === id ? null : id))}
                  onConfirm={() => closeItem(id)} />
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
