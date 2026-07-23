import { useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { useAnnouncementInbox } from '../hooks/useAnnouncements';
import { AnnouncementBoardPreview } from '../components/announcements/AnnouncementBoardPreview';
import { AnnouncementReader } from '../components/announcements/AnnouncementReader';
import type { Announcement } from '../lib/announcements';
import './AnnouncementsPage.css';

interface Props {
  /** Navigation focus target (modal "Read the full story", ⌘K): an announcement id to open in the reader. */
  focus?: { id: string | null; nonce: number };
}

/**
 * News-index model: the newest announcement is a hero card with an inert board
 * teaser; every older one is a compact headline row. No live canvas ever sits
 * in the scroll path (the teaser is pointer-events: none), so the page scrolls
 * like a page. Clicking any story opens the full-screen AnnouncementReader,
 * where the landing-page board gets the whole viewport and full interactivity.
 */
export function AnnouncementsPage({ focus }: Props): React.ReactElement {
  const { t } = useI18n();
  const { all, unread, loading, markAllRead } = useAnnouncementInbox();
  const [openId, setOpenId] = useState<string | null>(null);
  // Snapshot of what was unread when the user ARRIVED — markAllRead clears the
  // live unread set immediately (that's what kills the sidebar badge), but the
  // "New" pills should keep marking this visit's fresh stories, not vanish on
  // the next render tick.
  const [newIds, setNewIds] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (loading || newIds !== null) return;
    setNewIds(new Set(unread.map((a) => a.id)));
    markAllRead();
  }, [loading, unread, newIds, markAllRead]);

  // Deep-link focus: open the requested story once the feed is loaded. The
  // nonce re-triggers when the same id is navigated to twice.
  useEffect(() => {
    if (focus?.id && all.some((a) => a.id === focus.id)) setOpenId(focus.id);
  }, [focus?.id, focus?.nonce, all]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;

  const [hero, ...rest] = all;
  const open = openId ? (all.find((a) => a.id === openId) ?? null) : null;
  const isNew = (a: Announcement) => newIds?.has(a.id) ?? false;

  const meta = (a: Announcement) => (
    <div className="announcement-meta">
      <span className="announcement-meta-date">{a.date}</span>
      {a.version && (
        <span className="announcement-meta-version">
          {t('announcements.shippedIn').replace('{version}', a.version)}
        </span>
      )}
      {isNew(a) && <span className="announcement-meta-new">{t('announcements.new')}</span>}
    </div>
  );

  return (
    <div className="announcements-page">
      <header className="announcements-header">
        <h1 className="page-title">{t('announcements.title')}</h1>
        <p className="announcements-subtitle">{t('announcements.subtitle')}</p>
      </header>

      {all.length === 0 ? (
        <div className="announcements-empty">{t('announcements.empty')}</div>
      ) : (
        <>
          <article className="announcements-hero">
            {meta(hero)}
            <button type="button" className="announcements-hero-title" onClick={() => setOpenId(hero.id)}>
              {hero.title}
            </button>
            <p className="announcements-hero-summary">{hero.summary}</p>
            <AnnouncementBoardPreview
              board={hero.board}
              label={hero.title}
              onOpen={() => setOpenId(hero.id)}
            />
          </article>

          {rest.length > 0 && (
            <div className="announcements-archive">
              {rest.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="announcement-row"
                  onClick={() => setOpenId(a.id)}
                >
                  {meta(a)}
                  <span className="announcement-row-title">{a.title}</span>
                  <span className="announcement-row-summary">{a.summary}</span>
                  <span className="announcement-row-open" aria-hidden="true">
                    {t('announcements.readStory')} →
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {open && (
        <AnnouncementReader
          announcement={open}
          all={all}
          onNavigate={setOpenId}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
