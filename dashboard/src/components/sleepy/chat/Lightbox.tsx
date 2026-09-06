import { useState } from 'react';
import { ImageViewer } from '../../layout/ImageViewer';
import { FileActions } from './FileActions';
import { FileUnavailable } from './FileUnavailable';

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
 *
 * The same `path` is what lets a FAILURE be answered rather than merely drawn.
 * Until 09-06 a picture the endpoint refused — overwhelmingly a screenshot sitting
 * outside the project root, which needs the user's per-file consent — opened as
 * the engine's broken-file glyph on a full-window black screen: the file was real,
 * the transcript named it, and clicking it said nothing at all. Now the viewer
 * hands the stage to `FileUnavailable`, which asks the endpoint why and offers
 * *Allow access* where that is the answer.
 */
export function Lightbox({
  src, caption, path, onClose,
}: {
  src: string;
  caption?: string;
  path?: string;
  onClose: () => void;
}) {
  // Bumped by a granted file: consent changes what the SERVER will answer, so the picture
  // has to be requested again. A new URL is also how `ImageViewer` learns the subject
  // changed and clears its failed state (see its `src` effect) — the same reason the
  // parameter is in the query rather than a hash the browser would serve from cache.
  const [reload, setReload] = useState(0);
  const url = reload ? `${src}${src.includes('?') ? '&' : '?'}reload=${reload}` : src;

  return (
    <ImageViewer
      src={url}
      alt={caption ?? ''}
      caption={caption}
      actions={path ? <FileActions path={path} compact /> : undefined}
      // Only a picture with a file behind it can be explained or granted; a URL-only image
      // falls through to the viewer's own "couldn't load" line.
      fallback={path ? <FileUnavailable src={url} kind="image" onGranted={() => setReload((n) => n + 1)} /> : undefined}
      onClose={onClose}
    />
  );
}
