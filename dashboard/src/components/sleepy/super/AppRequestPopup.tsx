import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { AppRequestCard } from '../chat/AppRequestCard';
import { focusablesIn, trapTab } from '../../aiteam/focusTrap';
import './AppRequestPopup.css';

/** How long Reddet and Onayla ignore a press after the pop-up's buttons appear: it opens by
 *  itself, centred where he may be clicking, so a click meant for the chat lands on nothing. */
export const APP_POPUP_ARM_MS = 600;

/**
 * ORGANISM — a waiting app card as a POP-UP (owner 2026-11-16: "bu istek pop up olarak gelsin"):
 * the very `AppRequestCard` a chat draws, centred over the window, with its own Reddet / Onayla.
 * The decision is the card's (the notch's owner-key route): this frame adds no way to decide.
 *
 * Closing it (Esc, X, Sonra, a click outside) never decides: the card stays waiting and its row on
 * the Super's screen opens it again. Focus starts on the frame, never on Onayla, so an Enter that
 * was meant for the composer approves nothing; a click is guarded by `APP_POPUP_ARM_MS`.
 *
 * Esc: the scrim is in the window's Esc owner lists (AgentSurface's fold, `PRESENT_KEY_OWNERS`),
 * so Esc closes this alone; a dialog opened on top of it keeps its own Esc.
 */
export function AppRequestPopup({ id, onLater, onDecided }: {
  id: string;
  /** Closed without a decision. */
  onLater: () => void;
  onDecided: (action: 'approve' | 'reject', appName: string) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const laterRef = useRef(onLater);
  laterRef.current = onLater;

  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root) return;
      // Only the topmost dialog answers: one opened over this one keeps its keys.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals.length > 0 && modals[modals.length - 1] !== root) return;
      if (e.key === 'Escape') { e.preventDefault(); laterRef.current(); return; }
      if (e.key !== 'Tab') return;
      if (document.activeElement === root) {
        // From the frame itself, Tab goes into the card, never to the page under it.
        const items = focusablesIn(root);
        if (items.length) { e.preventDefault(); (e.shiftKey ? items[items.length - 1] : items[0]).focus(); }
        return;
      }
      trapTab(e, root);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (back && back.isConnected) back.focus();
    };
  }, [id]);

  return createPortal(
    <div className="app-popup-scrim" data-testid="app-request-popup-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onLater(); }}>
      <div
        ref={ref}
        className="app-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`app-popup-kicker-${id}`}
        tabIndex={-1}
        data-app-popup={id}
        data-testid="app-request-popup"
      >
        <div className="app-popup-head">
          <span className="app-popup-kicker" id={`app-popup-kicker-${id}`}>{t('super.approvals.title')}</span>
          <button type="button" className="app-popup-x" aria-label={t('appreq.popup.close')} onClick={onLater} data-testid="app-request-popup-x">×</button>
        </div>
        <AppRequestCard key={id} spec={{ type: 'app-request', id }} where="super" armMs={APP_POPUP_ARM_MS} onDecided={onDecided} />
        <div className="app-popup-foot">
          <button type="button" className="app-popup-later" onClick={onLater} data-testid="app-request-popup-later">{t('appreq.popup.later')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
