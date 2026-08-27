import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { useAnnouncementInbox } from '../hooks/useAnnouncements';
import { AnnouncementVersionSection } from '../components/announcements/AnnouncementVersionSection';
import { storyAssetUrl, type StoryShot } from '../lib/announcementStory';
import { ImageViewer } from '../components/layout/ImageViewer';
import type { Announcement } from '../lib/announcements';
import './AnnouncementsPage.css';

interface Props {
  /** Navigation focus target (modal "Read the full story", ⌘K): an announcement id to open. */
  focus?: { id: string | null; nonce: number };
}

/**
 * What's New — the release history as one document.
 *
 * Every version is a section. The newest one is open when you arrive; every
 * release before it is collapsed to its version number, title and one-line
 * summary, and opens in place. There is no separate reader and nothing
 * navigates: the question this page answers is "what have I been given", and
 * answering it should never cost you your scroll position.
 *
 * Opening a second version does NOT close the first. Releases get compared —
 * "when did the composer change?" is answered by having two of them open — and
 * an accordion that allows only one panel makes that impossible. Only the
 * DEFAULT is one-open.
 *
 * Any screenshot can be clicked into the full-window `ImageViewer` and zoomed to
 * the pixel, because a shot scaled into a 980px column can still hide the detail
 * the section is about.
 */
export function AnnouncementsPage({ focus }: Props): React.ReactElement {
  const { t } = useI18n();
  const { all, unread, loading, markAllRead } = useAnnouncementInbox();
  const [openIds, setOpenIds] = useState<ReadonlySet<string> | null>(null);
  const [zoomed, setZoomed] = useState<StoryShot | null>(null);
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

  // The newest release opens itself, once, as soon as the feed lands. Guarded on
  // `openIds === null` rather than on a mount effect so a user who has already
  // collapsed everything doesn't get it reopened under them by a refetch.
  useEffect(() => {
    if (loading || openIds !== null || all.length === 0) return;
    setOpenIds(new Set([all[0].id]));
  }, [loading, all, openIds]);

  // Deep-link focus: open the requested release and bring it into view. The
  // nonce re-triggers when the same id is navigated to twice.
  useEffect(() => {
    const id = focus?.id;
    if (!id || !all.some((a) => a.id === id)) return;
    setOpenIds((prev) => new Set([...(prev ?? []), id]));
    // The section has to exist before it can be scrolled to, and it only mounts
    // its panel on the render that follows the state change above.
    const raf = requestAnimationFrame(() => {
      document.getElementById(`ann-head-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [focus?.id, focus?.nonce, all]);

  const toggle = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const closeZoom = useCallback(() => setZoomed(null), []);

  if (loading) return <div className="loading">{t('common.loading')}</div>;

  const isNew = (a: Announcement) => newIds?.has(a.id) ?? false;
  const zoomUrl = zoomed ? storyAssetUrl(zoomed.src) : null;

  return (
    <div className="announcements-page">
      <header className="announcements-header">
        <h1 className="page-title">{t('announcements.title')}</h1>
        <p className="announcements-subtitle">{t('announcements.subtitle')}</p>
      </header>

      {all.length === 0 ? (
        <div className="announcements-empty">{t('announcements.empty')}</div>
      ) : (
        <div className="ann-versions">
          {all.map((a) => (
            <AnnouncementVersionSection
              key={a.id}
              announcement={a}
              expanded={openIds?.has(a.id) ?? false}
              isNew={isNew(a)}
              onToggle={() => toggle(a.id)}
              onShotClick={setZoomed}
            />
          ))}
        </div>
      )}

      {zoomed && zoomUrl && (
        <ImageViewer
          src={zoomUrl}
          alt={zoomed.alt}
          caption={zoomed.caption ?? zoomed.alt}
          onClose={closeZoom}
        />
      )}
    </div>
  );
}
