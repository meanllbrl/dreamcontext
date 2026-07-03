import { useEffect, useState } from 'react';

/**
 * The app-wide UI zoom factor (top-bar "− 100% +"). The Header stores it as the
 * `--zoom` CSS variable on <html> and broadcasts a `dreamcontext-zoom` event on
 * change. Surfaces that scale via the `--font-size-*` tokens react automatically;
 * this hook is for surfaces that need the numeric factor in JS — notably the
 * roadmap timeline, whose card is CSS-`zoom`ed, so its pointer math (clientX deltas
 * are post-zoom/physical px) must be divided by this factor to map back to the
 * timeline's logical geometry.
 */
function readZoom(): number {
  if (typeof document === 'undefined') return 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function useAppZoom(): number {
  const [zoom, setZoom] = useState(readZoom);
  useEffect(() => {
    const onZoom = (e: Event) => {
      const d = (e as CustomEvent).detail;
      setZoom(typeof d === 'number' && d > 0 ? d : readZoom());
    };
    window.addEventListener('dreamcontext-zoom', onZoom);
    setZoom(readZoom()); // sync in case zoom was applied before mount
    return () => window.removeEventListener('dreamcontext-zoom', onZoom);
  }, []);
  return zoom;
}
