import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { peekBox, type PeekBox, type PeekRect } from './picturePeekBox';

/**
 * A picture chip's hover card (owner 2026-11-07): the picture itself, floating next to the chip.
 * Fixed and portaled to the body, so neither the bubble nor the composer moves; it takes no
 * pointer (a click still lands on the chip, which opens the picture large) and says nothing a
 * screen reader has not already heard from the chip's name. It draws only once the picture's
 * size is known (the thumbnail usually loaded it already), and goes on scroll, resize or Esc.
 */
function PicturePeek({ src, anchor, onGone }: { src: string; anchor: PeekRect; onGone: () => void }) {
  const [box, setBox] = useState<PeekBox | null>(null);
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      setBox(peekBox(anchor, { w: img.naturalWidth, h: img.naturalHeight }, { w: window.innerWidth, h: window.innerHeight }));
    };
    img.src = src;
    return () => { live = false; img.onload = null; };
  }, [src, anchor]);
  useEffect(() => {
    const gone = () => onGone();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onGone(); };
    window.addEventListener('scroll', gone, true);
    window.addEventListener('resize', gone);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('scroll', gone, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('keydown', key, true);
    };
  }, [onGone]);
  if (!box) return null;
  return createPortal(
    <div
      className="chat-pic-peek"
      data-testid="chat-pic-peek"
      data-side={box.side}
      aria-hidden
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <img src={src} alt="" draggable={false} />
    </div>,
    document.body,
  );
}

/** Wait this long on a chip before its card shows, so a pointer passing over the text stays quiet. */
const PEEK_DELAY_MS = 200;

/**
 * One hover card for a surface: `show` after a short dwell, `hide` at once, `node` to render.
 * `key` names what is shown (a chip), so a pointer moving inside the same chip does not restart it.
 */
export function usePicturePeek(): {
  show: (key: string, src: string, anchor: PeekRect) => void;
  hide: () => void;
  shown: string | null;
  node: ReactNode;
} {
  const [peek, setPeek] = useState<{ key: string; src: string; anchor: PeekRect } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<string | null>(null);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    pending.current = null;
    setPeek(null);
  }, []);
  const show = useCallback((key: string, src: string, anchor: PeekRect) => {
    if (pending.current === key) return;
    window.clearTimeout(timer.current);
    pending.current = key;
    setPeek((p) => (p && p.key !== key ? null : p));
    timer.current = window.setTimeout(() => setPeek({ key, src, anchor }), PEEK_DELAY_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    show,
    hide,
    shown: peek?.key ?? null,
    node: peek ? <PicturePeek src={peek.src} anchor={peek.anchor} onGone={hide} /> : null,
  };
}

/** A DOMRect as the plain rect `peekBox` reads. */
export function rectOf(el: Element): PeekRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
