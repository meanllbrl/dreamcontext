import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '../../../context/I18nContext';
import '../super/superUnread.css';

/**
 * Every chat's one way down (owner 2026-11-15, "Claude Desktop gibi"): a round ↓ floating over the
 * transcript, centred above the composer, shown while the view is not at the bottom. It takes no
 * layout room, so showing or hiding it moves no row. The Super chat adds the count of unseen Super
 * messages below as a small badge on its edge ("telegram gibi", owner 2026-11-13).
 */
export function JumpToLatest({ shown, below = 0, testId, onClick, onGone }: {
  shown: boolean;
  /** Unread messages below the view (the Super chat); 0 draws no badge. */
  below?: number;
  testId: string;
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
      {shown && <JumpButton below={below} label={count || t('super.new.bottom')} testId={testId} onClick={onClick} onGone={onGone} />}
    </>
  );
}

/** The button itself: its unmount runs while it is still in the page, so it can tell whether it
 *  held the focus (after removal the focus is already on the body). */
function JumpButton({ below, label, testId, onClick, onGone }: { below: number; label: string; testId: string; onClick: () => void; onGone?: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  useLayoutEffect(() => () => {
    const el = ref.current;
    if (el && el.contains(document.activeElement)) goneRef.current?.();
  }, []);
  return (
    <button ref={ref} type="button" className="chat-jump" data-testid={testId} aria-label={label} title={label} onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
      </svg>
      {below > 0 && <span className="chat-jump-badge" aria-hidden>{below > 99 ? '99+' : below}</span>}
    </button>
  );
}
