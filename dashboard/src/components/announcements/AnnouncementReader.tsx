import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAnnouncementStory } from '../../hooks/useAnnouncements';
import { formatVersion, type Announcement } from '../../lib/announcements';
import { storyAssetUrl, type StoryShot } from '../../lib/announcementStory';
import { AnnouncementStory } from './AnnouncementStory';
import { FullscreenOverlay } from '../layout/FullscreenOverlay';
import { ImageViewer } from '../layout/ImageViewer';
import './AnnouncementReader.css';

interface Props {
  announcement: Announcement;
  /** The full newest-first feed, so the reader can page between stories. */
  all: readonly Announcement[];
  onNavigate: (id: string) => void;
  onClose: () => void;
}

/**
 * The "article view": one announcement opened full screen as a landing page —
 * hero, screenshots, proof, closer — scrolling in a single column. Any shot can
 * be clicked into the full-window `ImageViewer` and zoomed to the pixel, because
 * a screenshot scaled into a 920px column can still hide the detail the story is
 * about. Newer/Older controls page through the feed without leaving the reader.
 */
export function AnnouncementReader({ announcement, all, onNavigate, onClose }: Props) {
  const { t } = useI18n();
  const { data: story, isLoading } = useAnnouncementStory(announcement.story);
  const [zoomed, setZoomed] = useState<StoryShot | null>(null);

  const index = useMemo(() => all.findIndex((a) => a.id === announcement.id), [all, announcement.id]);
  const newer = index > 0 ? all[index - 1] : null;
  const older = index >= 0 && index < all.length - 1 ? all[index + 1] : null;

  // Paging to another story must not leave the previous story's viewer open over
  // it — the zoomed shot belongs to the announcement, not to the reader.
  useEffect(() => { setZoomed(null); }, [announcement.id]);

  // Esc ordering (viewer first, reader only on a second press) lives inside
  // `ImageViewer`, which swallows the key while it is the topmost layer.
  const closeZoom = useCallback(() => setZoomed(null), []);

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

  const zoomUrl = zoomed ? storyAssetUrl(zoomed.src) : null;

  return (
    <FullscreenOverlay label={announcement.title} actions={actions || undefined} onClose={onClose}>
      <div className="announcement-reader">
        <div className="announcement-reader-meta">
          <span className="announcement-reader-version">{formatVersion(announcement.version)}</span>
          <span className="announcement-reader-date">{announcement.date}</span>
          {announcement.tags?.map((tag) => (
            <span key={tag} className="announcement-reader-tag">
              {tag}
            </span>
          ))}
        </div>

        {isLoading ? (
          <div className="announcement-reader-loading">{t('common.loading')}</div>
        ) : story ? (
          <AnnouncementStory story={story} onShotClick={setZoomed} />
        ) : (
          // A missing or malformed story document must still leave a readable
          // announcement — the manifest's own title/summary are the fallback.
          <div className="announcement-reader-fallback">
            <h1>{announcement.title}</h1>
            <p>{announcement.summary}</p>
          </div>
        )}
      </div>

      {zoomed && zoomUrl && (
        <ImageViewer
          src={zoomUrl}
          alt={zoomed.alt}
          caption={zoomed.caption ?? zoomed.alt}
          onClose={closeZoom}
        />
      )}
    </FullscreenOverlay>
  );
}
