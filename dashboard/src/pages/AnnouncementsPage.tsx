import { useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { useAnnouncementInbox } from '../hooks/useAnnouncements';
import { AnnouncementStoryTeaser } from '../components/announcements/AnnouncementStoryTeaser';
import { AnnouncementReader } from '../components/announcements/AnnouncementReader';
import { formatVersion, type Announcement } from '../lib/announcements';
import './AnnouncementsPage.css';

interface Props {
  /** Navigation focus target (modal "Read the full story", ⌘K): an announcement id to open in the reader. */
  focus?: { id: string | null; nonce: number };
}

/**
 * Version-history model: one story per release, newest first. The current
 * version is a hero card showing its cover screenshot; every release before it
 * is a row on a version rail. The version — not the date — is what the eye lands
 * on, because the feed answers "what did 0.18 give me?" rather than "what got
 * built lately". Clicking any release opens the full-screen AnnouncementReader,
 * where the landing page — hero, screenshots, proof — gets the whole viewport.
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
            <div className="announcements-hero-head">
              <span className="announcements-hero-version">{formatVersion(hero.version)}</span>
              {meta(hero)}
            </div>
            <button type="button" className="announcements-hero-title" onClick={() => setOpenId(hero.id)}>
              {hero.title}
            </button>
            <p className="announcements-hero-summary">{hero.summary}</p>
            <AnnouncementStoryTeaser
              story={hero.story}
              label={hero.title}
              onOpen={() => setOpenId(hero.id)}
            />
          </article>

          {rest.length > 0 && (
            <div className="announcements-archive">
              <h2 className="announcements-archive-label">{t('announcements.earlierReleases')}</h2>
              {rest.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="announcement-row"
                  onClick={() => setOpenId(a.id)}
                >
                  <span className="announcement-row-version">{formatVersion(a.version)}</span>
                  <span className="announcement-row-body">
                    {meta(a)}
                    <span className="announcement-row-title">{a.title}</span>
                    <span className="announcement-row-summary">{a.summary}</span>
                    <span className="announcement-row-open" aria-hidden="true">
                      {t('announcements.readStory')} →
                    </span>
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
