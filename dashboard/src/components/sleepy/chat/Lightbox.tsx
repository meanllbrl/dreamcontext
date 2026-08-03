import { ImageViewer } from '../../layout/ImageViewer';
import { FileActions } from './FileActions';

/**
 * Image lightbox overlay, state 4 — an inline image or an image file reference
 * opened at full size.
 *
 * It is the shared `ImageViewer`, not a chat-local one: the picture covers the
 * whole window (not just this pane) and zooms to the pixel, which is the point
 * of opening a screenshot the agent produced. `src` is caller-built (typically
 * `/api/agent/file?path=…&raw=1`).
 *
 * `path` is what makes this MORE than the announcement reader's use of the same
 * viewer: a picture opened from a real file can also be handed to the OS, which
 * is how you get a screenshot out of the app and into a message, an editor, or a
 * folder. Absent (an image the transcript only ever knew as a URL) the actions
 * are simply not offered — a Finder button for a file that doesn't exist opens
 * nothing and says nothing.
 */
export function Lightbox({
  src, caption, path, onClose,
}: {
  src: string;
  caption?: string;
  path?: string;
  onClose: () => void;
}) {
  return (
    <ImageViewer
      src={src}
      alt={caption ?? ''}
      caption={caption}
      actions={path ? <FileActions path={path} compact /> : undefined}
      onClose={onClose}
    />
  );
}
