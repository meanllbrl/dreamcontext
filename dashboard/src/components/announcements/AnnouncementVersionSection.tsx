import { useI18n } from '../../context/I18nContext';
import { useAnnouncementStory } from '../../hooks/useAnnouncements';
import { formatVersion, type Announcement } from '../../lib/announcements';
import type { StoryShot } from '../../lib/announcementStory';
import { AnnouncementStory } from './AnnouncementStory';

interface Props {
  announcement: Announcement;
  expanded: boolean;
  isNew: boolean;
  onToggle: () => void;
  onShotClick: (shot: StoryShot) => void;
}

/**
 * One release on the What's New page: a version header that is always visible,
 * and the release's whole story underneath it when it is open.
 *
 * WHY THIS EXISTS. The page used to be a teaser feed — a hero card for the newest
 * release and a row per older one, each of which opened a separate full-screen
 * reader. Finding out what 0.24 gave you meant leaving the page, reading, coming
 * back, and losing your place. Now the version list IS the document: the newest
 * release is open when you arrive, everything before it is one click away, and
 * nothing navigates.
 *
 * The story document is fetched only once the section has been opened —
 * `useAnnouncementStory` is disabled while `expanded` is false — so arriving on a
 * feed of a dozen releases pulls exactly one story and its screenshots, not
 * twelve. Once opened, the section stays mounted, so re-collapsing and
 * re-expanding costs nothing.
 */
export function AnnouncementVersionSection({
  announcement, expanded, isNew, onToggle, onShotClick,
}: Props) {
  const { t } = useI18n();
  const { data: story, isLoading } = useAnnouncementStory(expanded ? announcement.story : '');

  const panelId = `ann-panel-${announcement.id}`;
  const headId = `ann-head-${announcement.id}`;

  return (
    <section className={`ann-version${expanded ? ' is-open' : ''}`}>
      <h2 className="ann-version-heading">
        <button
          type="button"
          id={headId}
          className="ann-version-head"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span className="ann-version-chevron" aria-hidden="true" />
          <span className="ann-version-num">{formatVersion(announcement.version)}</span>
          <span className="ann-version-text">
            <span className="ann-version-title">{announcement.title}</span>
            {/* The summary is the collapsed state's whole job: it has to say what
                the release was about well enough that you can decide not to open
                it. Hidden once open, where the story's own hero says it better. */}
            <span className="ann-version-summary">{announcement.summary}</span>
          </span>
          <span className="ann-version-meta">
            {isNew && <span className="ann-version-new">{t('announcements.new')}</span>}
            <span className="ann-version-date">{announcement.date}</span>
          </span>
        </button>
      </h2>

      {expanded && (
        <div className="ann-version-panel" id={panelId} role="region" aria-labelledby={headId}>
          {isLoading ? (
            <div className="ann-version-loading">{t('common.loading')}</div>
          ) : story ? (
            <AnnouncementStory story={story} onShotClick={onShotClick} />
          ) : (
            // A missing or malformed story document must still leave a readable
            // release — the manifest's own title/summary are the fallback.
            <div className="ann-version-fallback">
              <p>{announcement.summary}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
