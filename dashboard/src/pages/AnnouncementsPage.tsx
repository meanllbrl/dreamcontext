import { useEffect } from 'react';
import { useI18n } from '../context/I18nContext';
import { useAnnouncementInbox, useAnnouncementBoard } from '../hooks/useAnnouncements';
import { ExcalidrawPreview } from '../components/core/ExcalidrawPreview';
import type { Announcement } from '../lib/announcements';
import './AnnouncementsPage.css';

/**
 * One announcement = one landing-page-style Excalidraw board (git-tracked,
 * shipped as a static asset). The board fetches its own `.excalidraw.md` text
 * and hands it to ExcalidrawPreview; each row mounts its own hook, so a slow or
 * missing board never blocks its siblings. No `slug` is passed — announcement
 * boards are self-contained (no externally-referenced screenshots to resolve).
 */
function AnnouncementBoardCard({ announcement, unread }: { announcement: Announcement; unread: boolean }) {
  const { t } = useI18n();
  const { data: content, isLoading } = useAnnouncementBoard(announcement.board);

  return (
    <article className={`announcement-card${unread ? ' announcement-card--unread' : ''}`}>
      <div className="announcement-card-meta">
        <span className="announcement-card-date">{announcement.date}</span>
        {announcement.version && (
          <span className="announcement-card-version">
            {t('announcements.shippedIn').replace('{version}', announcement.version)}
          </span>
        )}
      </div>
      <h2 className="announcement-card-title">{announcement.title}</h2>
      <div className="announcement-card-board">
        {isLoading ? (
          <div className="announcement-board-loading">{t('common.loading')}</div>
        ) : (
          <ExcalidrawPreview content={content ?? ''} />
        )}
      </div>
    </article>
  );
}

export function AnnouncementsPage(): React.ReactElement {
  const { t } = useI18n();
  const { all, unread, loading, markAllRead } = useAnnouncementInbox();

  // Opening this page IS the read signal — no separate dismiss action needed,
  // so the sidebar badge clears the moment the user actually looks at the list.
  useEffect(() => {
    markAllRead();
  }, [markAllRead]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;

  const unreadIds = new Set(unread.map((a) => a.id));

  return (
    <div className="announcements-page">
      <header className="announcements-header">
        <h1 className="page-title">{t('announcements.title')}</h1>
        <p className="announcements-subtitle">{t('announcements.subtitle')}</p>
      </header>

      {all.length === 0 ? (
        <div className="announcements-empty">{t('announcements.empty')}</div>
      ) : (
        <div className="announcements-list">
          {all.map((a) => (
            <AnnouncementBoardCard key={a.id} announcement={a} unread={unreadIds.has(a.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
