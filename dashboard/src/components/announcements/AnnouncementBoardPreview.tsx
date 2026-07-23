import { useI18n } from '../../context/I18nContext';
import { useAnnouncementBoard } from '../../hooks/useAnnouncements';
import { ExcalidrawPreview } from '../core/ExcalidrawPreview';
import './AnnouncementBoardPreview.css';

interface Props {
  /** Board filename from the manifest (`<id>.excalidraw.md`). */
  board: string;
  /** Accessible name for the whole clickable teaser (the announcement title). */
  label: string;
  onOpen: () => void;
}

/**
 * An inert teaser of an announcement board. The canvas renders under a
 * `pointer-events: none` layer with all editor chrome hidden, so the wheel
 * scrolls the page (or the modal body) instead of panning/zooming the board —
 * the scroll trap that made the old feed unusable. The whole teaser is one
 * button: clicking it opens the full-screen reader, where the board is large
 * enough to read and fully interactive.
 */
export function AnnouncementBoardPreview({ board, label, onOpen }: Props) {
  const { t } = useI18n();
  const { data: content, isLoading } = useAnnouncementBoard(board);

  return (
    <button type="button" className="announcement-board-preview" onClick={onOpen} aria-label={label}>
      <div className="announcement-board-preview-canvas" aria-hidden="true">
        {isLoading ? (
          <div className="announcement-board-preview-loading">{t('common.loading')}</div>
        ) : (
          <ExcalidrawPreview content={content ?? ''} />
        )}
      </div>
      <span className="announcement-board-preview-cta">{t('announcements.readStory')} →</span>
    </button>
  );
}
