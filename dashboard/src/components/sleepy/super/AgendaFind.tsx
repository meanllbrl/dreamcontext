import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '../../../context/I18nContext';

const Glass = () => (
  <svg className="agenda-find-glass" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
    <circle cx="7" cy="7" r="4.5" /><path d="m10.6 10.6 3 3" />
  </svg>
);

/**
 * The agenda's search (owner pick A, 18 Nov): closed, a round magnifier in the header row; pressed,
 * it grows to the LEFT into a capsule over the day and the count, in the same row (no new row, no
 * height). The spot keeps the circle's place in the row; the capsule floats over the row with its
 * right edge on the spot's, so the view switch beside it keeps working. × and Esc close it.
 */
export function AgendaFind({ open, query, onOpen, onClose, onQuery }: {
  open: boolean;
  query: string;
  onOpen: () => void;
  /** Close and forget the words (× or Esc). */
  onClose: () => void;
  onQuery: (q: string) => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const capRef = useRef<HTMLSpanElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(open);

  // Open width: from the row's left edge to the spot's right edge (measured, so every size and
  // every neighbour fits); refitted when the row resizes. Closed: back to the circle.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const cap = capRef.current;
    if (!root || !cap) return undefined;
    if (!open) { cap.style.width = ''; return undefined; }
    const row = root.parentElement;
    if (!row) return undefined;
    const fit = () => { cap.style.width = `${Math.max(0, root.getBoundingClientRect().right - row.getBoundingClientRect().left)}px`; };
    fit();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    ro?.observe(row);
    // A neighbour that comes or goes (the view switch on a past day) moves the spot without resizing the row.
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(fit);
    mo?.observe(row, { childList: true });
    return () => { ro?.disconnect(); mo?.disconnect(); };
  }, [open]);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) btnRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const label = t('super.agenda.search.open');
  return (
    <span ref={rootRef} className="agenda-find" data-state={open ? 'open' : 'closed'}>
      <span className="agenda-find-spot" aria-hidden />
      <span ref={capRef} className="agenda-find-cap">
        {open ? (
          <>
            <Glass />
            <input
              className="agenda-find-input"
              data-testid="super-agenda-search-input"
              type="search"
              value={query}
              autoFocus
              maxLength={120}
              placeholder={t('super.agenda.search.placeholder')}
              aria-label={label}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}
            />
            <button type="button" className="agenda-find-clear" data-testid="super-agenda-search-close" aria-label={t('super.agenda.search.close')} title={t('super.agenda.search.close')} onClick={onClose}>
              <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </>
        ) : (
          <button ref={btnRef} type="button" className="agenda-find-btn" data-testid="super-agenda-search-open" aria-label={label} title={label} aria-expanded={false} onClick={onOpen}>
            <Glass />
          </button>
        )}
      </span>
    </span>
  );
}
