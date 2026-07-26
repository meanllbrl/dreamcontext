import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAnnouncementInbox } from '../../hooks/useAnnouncements';
import { readSeenIds, unreadAnnouncements, type Announcement } from '../../lib/announcements';
import { AnnouncementStoryTeaser } from '../announcements/AnnouncementStoryTeaser';
import { pushOverlay, popOverlay, isTopOverlay } from '../../lib/overlayStack';
import './AnnouncementsModal.css';

const OVERLAY_ID = 'announcements-modal';

interface Props {
  /**
   * Navigate to the Announcements page (called alongside markAllRead). When an
   * announcement id is given, the page opens that story in the full reader.
   */
  onOpenPage: (announcementId?: string) => void;
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
 *
 * The body is content-first: headline + summary carry the message in text; the
 * story's cover screenshot is a teaser that opens the full-screen reader on the
 * Announcements page, where the whole landing page is readable.
 */
export function AnnouncementsModal({ onOpenPage }: Props) {
  const { t } = useI18n();
  const { unread, loading, markAllRead } = useAnnouncementInbox();
  const dismissed = useRef(false);
  // One-way latch for the pin effect below. Idempotency invariant: the
  // pin+markAllRead body runs at most once per mount. The `pinned === null`
  // check alone doesn't guarantee that — React 18 StrictMode double-invokes
  // the effect on dev mount before the setPinned re-render lands, so both
  // invocations would still see `pinned === null` and call markAllRead twice.
  const pinLatched = useRef(false);
  const [pinned, setPinned] = useState<Announcement[] | null>(null);

  useEffect(() => {
    if (pinLatched.current || pinned !== null || loading || unread.length === 0 || dismissed.current) {
      return;
    }
    // Same-vault multi-window TOCTOU guard: another window sharing this
    // origin's localStorage may have pinned + marked these read after our
    // `unread` state was computed but before the cross-window `storage` sync
    // (useAnnouncementInbox) lands. Synchronously re-read the persisted seen
    // ids and keep only the genuinely-unseen entries; if none remain, the
    // other window already showed them — bail without latching so a later
    // genuine unread (e.g. seen-set cleared elsewhere) can still pin.
    const fresh = unreadAnnouncements(unread, readSeenIds());
    if (fresh.length === 0) return;
    pinLatched.current = true;
    setPinned(fresh);
    markAllRead();
  }, [pinned, loading, unread, markAllRead]);

  const show = pinned !== null && pinned.length > 0 && !dismissed.current;

  // The popup is a single-story hero: the newest pinned announcement (pinned is
  // sorted newest-first). Deeper ones are listed under "Also new" and open the
  // page reader directly.
  const hero = pinned?.[0];

  // The markAllRead calls below look redundant — the pin effect already marked
  // everything read — but they are load-bearing: markAllRead is what forces the
  // re-render on which the `dismissed` ref is read (see the component comment).
  // Dropping them would set the ref and then leave the modal on screen.
  const dismiss = useCallback(() => {
    dismissed.current = true;
    markAllRead();
  }, [markAllRead]);

  const openStory = useCallback(
    (id?: string) => {
      dismissed.current = true;
      onOpenPage(id);
      markAllRead();
    },
    [markAllRead, onOpenPage],
  );

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
          <div className="announcements-modal-meta">
            <span className="announcements-modal-date">{hero.date}</span>
            {hero.version && (
              <span className="announcements-modal-version">
                {t('announcements.shippedIn').replace('{version}', hero.version)}
              </span>
            )}
          </div>
          <h3 className="announcements-modal-headline">{hero.title}</h3>
          <p className="announcements-modal-summary">{hero.summary}</p>

          <AnnouncementStoryTeaser story={hero.story} label={hero.title} onOpen={() => openStory(hero.id)} />

          {pinned.length > 1 && (
            <div className="announcements-modal-also">
              <span className="announcements-modal-also-label">{t('announcements.alsoNew')}</span>
              {pinned.slice(1).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="announcements-modal-also-row"
                  onClick={() => openStory(a.id)}
                >
                  <span className="announcements-modal-also-date">{a.date}</span>
                  <span className="announcements-modal-also-title">{a.title}</span>
                  <span className="announcements-modal-also-arrow" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <footer className="announcements-modal-foot">
          <button type="button" className="announcements-modal-btn-ghost" onClick={() => openStory()}>
            {t('announcements.seeAll')}
          </button>
          <div className="announcements-modal-foot-main">
            <button type="button" className="announcements-modal-btn-secondary" onClick={dismiss}>
              {t('announcements.gotIt')}
            </button>
            <button type="button" className="announcements-modal-btn" onClick={() => openStory(hero.id)}>
              {t('announcements.readStory')}
            </button>
          </div>
        </footer>
      </div>
    </>
  );
}
