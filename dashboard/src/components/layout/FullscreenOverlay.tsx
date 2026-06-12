import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import './FullscreenOverlay.css';

interface Props {
  /** Dialog title; doubles as the accessible name (typically the document name). */
  label: string;
  /** Extra header controls (e.g. File/Preview tabs) rendered next to the close button. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

// :not(:disabled) matters: markdown task lists render disabled checkboxes, and a
// disabled element can never be document.activeElement — if one were first/last,
// the Tab wrap check below would never match and focus would escape the dialog.
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Generic in-app full-screen overlay (NOT the browser Fullscreen API): a
 * `position: fixed` dialog covering the whole viewport, above the nav.
 *
 * Behavior contract:
 * - `Esc` and the header close button both call `onClose`.
 * - Focus moves into the overlay on open, is trapped while open (Tab cycles),
 *   and returns to the previously focused element on close.
 * - Body scroll is locked while open; the scrollbar width is compensated so
 *   the page behind doesn't shift on enter/exit.
 */
export function FullscreenOverlay({ label, actions, onClose, children }: Props) {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

    overlay.focus();

    // Listen on document (capture phase), not the overlay element: clicking
    // non-focusable content (markdown text, the excalidraw svg) moves focus to
    // <body> in Firefox/Safari, where an element-scoped listener would go dead —
    // Esc would stop closing and Tab would walk into the page behind the dialog.
    // Capture also lets stopPropagation shield other document-level Esc handlers.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = overlay.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!active || !overlay.contains(active)) {
        // Focus escaped the dialog (e.g. landed on <body>) — pull it back in.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === overlay)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPaddingRight;
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className="fullscreen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
    >
      <div className="fullscreen-overlay-header">
        <h2 className="fullscreen-overlay-title">{label}</h2>
        <div className="fullscreen-overlay-actions">
          {actions}
          <button
            className="fullscreen-overlay-close"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>
      </div>
      <div className="fullscreen-overlay-body">{children}</div>
    </div>
  );
}
