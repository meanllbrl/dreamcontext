import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperUnread } from './useSuperUnread';
import './superUnread.css';

/** The way around the chat while something unread is out of view, where "Latest" stands: the next
 *  unread, mark all, and the way down, one pill over the composer instead of two controls at two
 *  ends of the chat. The arrow says where the next one lies. */
export function SuperUnreadBar({ unread, onJump, onBottom, onGone }: {
  unread: SuperUnread;
  onJump: () => void;
  /** Null at the bottom. */
  onBottom: (() => void) | null;
  /** The bar went away with focus inside it, by any path: a read, a jump's landing, mark all. */
  onGone: () => void;
}) {
  const { t } = useI18n();
  const shown = !!unread.edge && unread.count > 0;
  const count = t('super.unread.count').replace('{n}', String(unread.count));
  const hadFocus = useRef(false);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  useLayoutEffect(() => {
    if (!shown && hadFocus.current) { hadFocus.current = false; goneRef.current(); }
  }, [shown]);
  return (
    <>
      {/* Mounted before it has anything to say, or its first words go unannounced; the count alone. */}
      <span className="super-unread-status" role="status">{shown ? count : ''}</span>
      {shown && (
    <div className="super-unread-bar" data-testid="super-unread-bar" role="group" aria-label={t('super.unread.bar')}
      onFocus={() => { hadFocus.current = true; }}
      onBlur={(e) => { if (e.relatedTarget) hadFocus.current = false; }}>
      <button type="button" className="super-unread-jump" data-testid="super-unread-jump" onClick={onJump}>
        <span aria-hidden>{unread.edge === 'up' ? '↑' : '↓'}</span>
        <span className="super-unread-count">{count}</span>
        <span className="super-unread-go">· {t(unread.edge === 'up' ? 'super.unread.go' : 'super.unread.next')}</span>
      </button>
      <button type="button" className="super-unread-side" data-testid="super-unread-all" onClick={unread.markAll}>{t('super.unread.markAll')}</button>
      {onBottom && (
        <button type="button" className="super-unread-side" data-testid="super-unread-bottom" onClick={onBottom}>
          <span aria-hidden>↓</span> {t('super.unread.bottom')}
        </button>
      )}
    </div>
      )}
    </>
  );
}
