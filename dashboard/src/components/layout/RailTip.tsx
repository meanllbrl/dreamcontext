import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * The collapsed rail's name tag. At 56px the rail is a column of bare glyphs, and the native
 * `title` takes a second to appear and looks like an OS hint, so a glyph you do not recognise
 * stays a guess. This shows the row's name the moment the pointer or focus lands on it.
 *
 * Portalled to the body because `.sidebar` clips horizontally; positioned from the row's own
 * rect, so it follows the rail's scroll without a listener. Reads `data-tip` from the row.
 */
export function RailTip({ railRef, enabled }: { railRef: RefObject<HTMLElement | null>; enabled: boolean }) {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || !enabled) {
      setTip(null);
      return;
    }
    const show = (e: Event) => {
      const row = (e.target as Element | null)?.closest<HTMLElement>('[data-tip]');
      if (!row || !rail.contains(row)) return setTip(null);
      const r = row.getBoundingClientRect();
      setTip({ text: row.dataset.tip ?? '', x: rail.getBoundingClientRect().right + 6, y: r.top + r.height / 2 });
    };
    const hide = () => setTip(null);
    rail.addEventListener('pointerover', show);
    rail.addEventListener('focusin', show);
    rail.addEventListener('pointerleave', hide);
    rail.addEventListener('focusout', hide);
    rail.addEventListener('scroll', hide);
    rail.addEventListener('click', hide);
    return () => {
      rail.removeEventListener('pointerover', show);
      rail.removeEventListener('focusin', show);
      rail.removeEventListener('pointerleave', hide);
      rail.removeEventListener('focusout', hide);
      rail.removeEventListener('scroll', hide);
      rail.removeEventListener('click', hide);
    };
  }, [railRef, enabled]);

  if (!enabled || !tip?.text) return null;
  return createPortal(
    <div className="sidebar-tip" role="presentation" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>,
    document.body,
  );
}
