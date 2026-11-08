import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './PhoneAgenda.css';

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
/** A downward drag on the sheet's top past this closes it. */
const SWIPE_CLOSE_PX = 72;

/**
 * The one bottom sheet of the phone's Super chat (the agenda, the running agents, one agent).
 * It lies over the chat and never touches it, so the chat is at the same scroll spot when it goes.
 * Closes by the scrim, by a swipe down on its top, by Escape and by the phone's back gesture: one
 * history entry of its own, so back closes the sheet and never leaves the chat. Drawn on the body:
 * the scrim covers the whole page, title bar and tab bar too, so nothing can change under an open
 * sheet. The caller's `handle` is its top.
 */
export function PhoneSheet({ testId, label, labelledBy, className, focusKey, handle, onClose, children }: {
  testId: string;
  label?: string;
  labelledBy?: string;
  className?: string;
  /** A new value moves the focus to the close button again (a new view in the same sheet). */
  focusKey?: string;
  handle: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<number | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Open: focus the close button.
  useEffect(() => {
    sheetRef.current?.querySelector<HTMLElement>('.phone-agenda-close:not(.phone-job-back)')?.focus({ preventScroll: true });
  }, [focusKey]);

  // Escape closes; Tab stays inside (aria-modal). The surface's own Esc yields to the layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sheet = sheetRef.current;
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !sheet) return;
      const all = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Back closes it. Closed any other way, its entry is unwound, so no back press is wasted later.
  useEffect(() => {
    const mark = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // A tick late: an effect run twice in development must not push and unwind in a race.
    const pushed = setTimeout(() => window.history.pushState({ phoneSheet: mark }, ''), 0);
    const onPop = () => { if (window.history.state?.phoneSheet !== mark) closeRef.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      clearTimeout(pushed);
      window.removeEventListener('popstate', onPop);
      if (window.history.state?.phoneSheet === mark) window.history.back();
    };
  }, []);

  return createPortal(
    <div className="phone-agenda-layer">
      <div className="phone-agenda-backdrop" data-testid={`${testId}-backdrop`} onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        className={`phone-agenda-sheet${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        data-testid={testId}
      >
        <div
          className="phone-agenda-grip"
          data-testid={`${testId}-grip`}
          onTouchStart={(e) => { dragFrom.current = e.touches[0]?.clientY ?? null; }}
          onTouchMove={(e) => {
            const from = dragFrom.current;
            const y = e.touches[0]?.clientY;
            if (from !== null && y !== undefined && y - from > SWIPE_CLOSE_PX) { dragFrom.current = null; onClose(); }
          }}
          onTouchEnd={() => { dragFrom.current = null; }}
        >
          <span className="phone-agenda-grip-bar" aria-hidden />
          {handle}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The sheet's ✕. */
export function PhoneSheetClose({ testId, label, onClick }: { testId: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className="phone-agenda-close" data-testid={testId} aria-label={label} onClick={onClick}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <path d="M5 5l10 10M15 5L5 15" />
      </svg>
    </button>
  );
}
