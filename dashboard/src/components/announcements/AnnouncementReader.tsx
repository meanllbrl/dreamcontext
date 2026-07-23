import { useMemo } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAnnouncementBoard } from '../../hooks/useAnnouncements';
import type { Announcement } from '../../lib/announcements';
import { ExcalidrawPreview } from '../core/ExcalidrawPreview';
import { FullscreenOverlay } from '../layout/FullscreenOverlay';
import './AnnouncementReader.css';

interface Props {
  announcement: Announcement;
  /** The full newest-first feed, so the reader can page between stories. */
  all: readonly Announcement[];
  onNavigate: (id: string) => void;
  onClose: () => void;
}

/**
 * The "article view": one announcement opened full screen. The landing-page
 * board finally gets the whole viewport — readable text, and pan/zoom is
 * welcome here because the page behind is scroll-locked by FullscreenOverlay,
 * so the canvas can own the wheel without trapping anything. Newer/Older
 * controls page through the feed without leaving the reader.
 */
export function AnnouncementReader({ announcement, all, onNavigate, onClose }: Props) {
  const { t } = useI18n();
  const { data: content, isLoading } = useAnnouncementBoard(announcement.board);

  const index = useMemo(() => all.findIndex((a) => a.id === announcement.id), [all, announcement.id]);
  const newer = index > 0 ? all[index - 1] : null;
  const older = index >= 0 && index < all.length - 1 ? all[index + 1] : null;

  const actions = all.length > 1 && (
    <div className="announcement-reader-pager">
      <button
        type="button"
        className="announcement-reader-pager-btn"
        disabled={!newer}
        onClick={() => newer && onNavigate(newer.id)}
      >
        ← {t('announcements.newer')}
      </button>
      <span className="announcement-reader-pager-pos">
        {index + 1} / {all.length}
      </span>
      <button
        type="button"
        className="announcement-reader-pager-btn"
        disabled={!older}
        onClick={() => older && onNavigate(older.id)}
      >
        {t('announcements.older')} →
      </button>
    </div>
  );

  return (
    <FullscreenOverlay label={announcement.title} actions={actions || undefined} onClose={onClose}>
      <div className="announcement-reader">
        <div className="announcement-reader-meta">
          <span className="announcement-reader-date">{announcement.date}</span>
          {announcement.version && (
            <span className="announcement-reader-version">
              {t('announcements.shippedIn').replace('{version}', announcement.version)}
            </span>
          )}
          {announcement.tags?.map((tag) => (
            <span key={tag} className="announcement-reader-tag">
              {tag}
            </span>
          ))}
        </div>
        <p className="announcement-reader-summary">{announcement.summary}</p>
        <div className="announcement-reader-board">
          {isLoading ? (
            <div className="announcement-reader-loading">{t('common.loading')}</div>
          ) : (
            <ExcalidrawPreview key={announcement.id} content={content ?? ''} />
          )}
        </div>
      </div>
    </FullscreenOverlay>
  );
}
