import { ImageViewer } from '../../layout/ImageViewer';

/**
 * Image lightbox overlay, state 4 — an inline image or an image file reference
 * opened at full size.
 *
 * It is the shared `ImageViewer`, not a chat-local one: the picture covers the
 * whole window (not just this pane) and zooms to the pixel, which is the point
 * of opening a screenshot the agent produced. `src` is caller-built (typically
 * `/api/agent/file?path=…&raw=1`).
 */
export function Lightbox({ src, caption, onClose }: { src: string; caption?: string; onClose: () => void }) {
  return <ImageViewer src={src} alt={caption ?? ''} caption={caption} onClose={onClose} />;
}
