import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAnnouncementInbox, useAnnouncementBoard } from '../../hooks/useAnnouncements';
import type { Announcement } from '../../lib/announcements';
import { ExcalidrawPreview } from '../core/ExcalidrawPreview';
import { pushOverlay, popOverlay, isTopOverlay } from '../../lib/overlayStack';
import './AnnouncementsModal.css';

const OVERLAY_ID = 'announcements-modal';

interface Props {
  /** Navigate to the full Announcements page (called alongside markAllRead). */
  onOpenPage: () => void;
}

/**
 * The on-load "What's New" popup. This component is mounted once, unconditionally,
 * at the Shell root — it decides its own visibility rather than being conditionally
 * rendered by a parent, so `show` (not a prop) gates both the render and the
 * overlay-stack registration below. Without that gate, an always-registered Esc
 * listener would sit on the stack for the app's whole lifetime and could shadow a
 * later overlay even while this popup shows nothing.
 *
 * `dismissed` is a ref: `dismiss()` always calls `markAllRead()`, which updates
 * real state in useAnnouncementInbox and forces a re-render — that re-render is
 * what the ref is read on. A plain boolean check on `unread.length === 0` would
 * already cover the same case once that re-render lands, but the ref makes the
 * dismissal a hard one-way latch for this mount regardless of any later data change.
 *
 * Being *shown* the popup — not clicking a button in it — is what counts as
 * "seen": the newest unread announcements are snapshotted into `pinned` and
 * marked read the instant the popup first becomes eligible. A user who reads the
 * popup and simply closes the window (never touching "Got it"/✕/Esc) must not be
 * shown the same announcement on the next launch. Pinning the snapshot keeps the
 * popup rendered for its whole lifetime even though `markAllRead` empties the
 * live `unread` on the same tick — otherwise it would flash and vanish.
 */
export function AnnouncementsModal({ onOpenPage }: Props) {
  const { t } = useI18n();
  const { unread, loading, markAllRead } = useAnnouncementInbox();
  const dismissed = useRef(false);
  const [pinned, setPinned] = useState<Announcement[] | null>(null);

  useEffect(() => {
    if (pinned === null && !loading && unread.length > 0 && !dismissed.current) {
      setPinned(unread);
      markAllRead();
    }
  }, [pinned, loading, unread, markAllRead]);

  const show = pinned !== null && pinned.length > 0 && !dismissed.current;

  // The popup is a single-board hero: the newest pinned announcement (pinned is
  // sorted newest-first). Deeper ones are reached via "See all". Rendering one
  // read-only canvas on load stays light; a stack of them would not. The board
  // hook is called unconditionally (disabled on '' when there's nothing pinned).
  const hero = pinned?.[0];
  const { data: heroBoard, isLoading: heroLoading } = useAnnouncementBoard(hero?.board ?? '');

  const dismiss = useCallback(() => {
    dismissed.current = true;
    markAllRead();
  }, [markAllRead]);

  const seeAll = useCallback(() => {
    dismissed.current = true;
    onOpenPage();
    markAllRead();
  }, [markAllRead, onOpenPage]);

  // Esc closes — topmost-only (overlay stack), same contract as CommandModal /
  // InsightDetailPanel. Registers only while `show` is true, mirroring how those
  // components gate on their `open` prop.
  useEffect(() => {
    if (!show) return;
    pushOverlay(OVERLAY_ID);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(OVERLAY_ID)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      popOverlay(OVERLAY_ID);
    };
  }, [show, dismiss]);

  if (!show || !hero) return null;

  return (
    <>
      <div className="announcements-modal-scrim" onClick={dismiss} />
      <div
        className="announcements-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('announcements.whatsNew')}
      >
        <header className="announcements-modal-head">
          <h2 className="announcements-modal-title">{t('announcements.whatsNew')}</h2>
          <button
            type="button"
            className="announcements-modal-close"
            onClick={dismiss}
            aria-label={t('announcements.dismiss')}
            title={t('announcements.dismiss')}
          >
            ✕
          </button>
        </header>

        <div className="announcements-modal-body">
          <article className="announcements-modal-entry">
            <div className="announcements-modal-entry-meta">
              <span className="announcements-modal-entry-date">{hero.date}</span>
              {hero.version && (
                <span className="announcements-modal-entry-version">
                  {t('announcements.shippedIn').replace('{version}', hero.version)}
                </span>
              )}
              {pinned.length > 1 && (
                <span className="announcements-modal-entry-more">
                  {t('announcements.moreUnread').replace('{count}', String(pinned.length - 1))}
                </span>
              )}
            </div>
            <h3 className="announcements-modal-entry-title">{hero.title}</h3>
            <div className="announcements-modal-board">
              {heroLoading ? (
                <div className="announcement-board-loading">{t('common.loading')}</div>
              ) : (
                <ExcalidrawPreview content={heroBoard ?? ''} />
              )}
            </div>
          </article>
        </div>

        <footer className="announcements-modal-foot">
          <button type="button" className="announcements-modal-btn-secondary" onClick={seeAll}>
            {t('announcements.seeAll')}
          </button>
          <button type="button" className="announcements-modal-btn" onClick={dismiss}>
            {t('announcements.gotIt')}
          </button>
        </footer>
      </div>
    </>
  );
}
