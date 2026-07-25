import { useEffect } from 'react';

/**
 * Image lightbox overlay, state 4 — dark scrim, filename+dims caption, ✕, large
 * view. `src` is caller-built (typically `/api/agent/file?path=…&raw=1`).
 */
export function Lightbox({ src, caption, onClose }: { src: string; caption?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="chat-lightbox-scrim" onClick={onClose}>
      <div className="chat-lightbox-frame" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="chat-lightbox-close" onClick={onClose} aria-label="Close">✕</button>
        <img className="chat-lightbox-img" src={src} alt={caption ?? ''} />
        {caption && <div className="chat-lightbox-caption">{caption}</div>}
      </div>
    </div>
  );
}
