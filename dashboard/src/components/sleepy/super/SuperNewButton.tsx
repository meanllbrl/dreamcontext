import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '../../../context/I18nContext';
import './superUnread.css';

/**
 * The Super chat's one way down (owner 2026-11-13, "telegram gibi"): where "Latest" stands, shown
 * while the view is not at the bottom. "↓ N yeni" when N unseen Super messages lie below, a bare
 * "↓" when nothing new does. Its strip is reserved all the time in the Super view
 * (ChatPane.css `.chat-transcript--super`), so showing or hiding it moves no row.
 */
export function SuperNewButton({ shown, below, onClick, onGone }: {
  shown: boolean;
  /** Unread Super messages below the view. */
  below: number;
  onClick: () => void;
  /** It unmounted while holding the focus (the view reached the bottom under it): hand it back. */
  onGone?: () => void;
}) {
  const { t } = useI18n();
  const count = below > 0 ? t('super.new.count').replace('{n}', String(below)) : '';
  return (
    <>
      {/* Mounted before it has anything to say, or its first words go unannounced. */}
      <span className="super-unread-status" role="status">{shown ? count : ''}</span>
      {shown && <NewButton count={count} label={count || t('super.new.bottom')} onClick={onClick} onGone={onGone} />}
    </>
  );
}

/** The button itself: its unmount runs while it is still in the page, so it can tell whether it
 *  held the focus (after removal the focus is already on the body). */
function NewButton({ count, label, onClick, onGone }: { count: string; label: string; onClick: () => void; onGone?: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  useLayoutEffect(() => () => {
    const el = ref.current;
    if (el && el.contains(document.activeElement)) goneRef.current?.();
  }, []);
  return (
    <button ref={ref} type="button" className="chat-jump super-new" data-testid="super-new" aria-label={label} onClick={onClick}>
      <span aria-hidden>↓</span>{count && <span>{count}</span>}
    </button>
  );
}
