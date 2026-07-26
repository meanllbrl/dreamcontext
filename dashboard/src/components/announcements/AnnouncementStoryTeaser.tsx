import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAnnouncementStory } from '../../hooks/useAnnouncements';
import { storyAssetUrl, storyCoverShot } from '../../lib/announcementStory';
import './AnnouncementStoryTeaser.css';

interface Props {
  /** Story filename from the manifest (`<id>.json`). */
  story: string;
  /** Accessible name for the whole clickable teaser (the announcement title). */
  label: string;
  onOpen: () => void;
}

/**
 * The teaser for a story: its cover screenshot, cropped to a wide card, under a
 * "Read the full story →" chip. One button — clicking it opens the full reader.
 *
 * This replaced the inert Excalidraw board teaser. That one had to mount a whole
 * canvas just to show a thumbnail, then defend against the canvas eating the
 * page's wheel events; an `<img>` has neither problem. A story with no cover
 * shot (a CLI release, say) renders no teaser at all rather than an empty frame —
 * the headline and summary above it already carry the story.
 */
export function AnnouncementStoryTeaser({ story, label, onOpen }: Props) {
  const { t } = useI18n();
  const { data, isLoading } = useAnnouncementStory(story);
  const [broken, setBroken] = useState(false);

  const cover = storyCoverShot(data);
  const url = cover ? storyAssetUrl(cover.src) : null;

  if (isLoading) {
    return <div className="announcement-story-teaser-loading">{t('common.loading')}</div>;
  }
  if (!url || broken) return null;

  return (
    <button type="button" className="announcement-story-teaser" onClick={onOpen} aria-label={label}>
      <img
        className="announcement-story-teaser-img"
        src={url}
        alt={cover?.alt ?? ''}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
      />
      <span className="announcement-story-teaser-cta">{t('announcements.readStory')} →</span>
    </button>
  );
}
