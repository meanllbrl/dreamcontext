import { useEffect, useRef, type RefObject } from 'react';

/**
 * A small menu on the Super stage, as the card's size menu has always behaved: it takes focus
 * ONCE when it opens (the checked row, else the first), the arrow keys move between its rows, Esc
 * closes it, and a press outside it closes it, except on its own toggle (which toggles; closing
 * here would reopen it). The card re-renders on every push while its agent works, so the latest
 * close is read through a ref: a new arrow each render must not re-run this.
 *
 * Its root must carry `.super-size-menu`: the stage's and the surface's own Esc yield to it.
 */
export function useStageMenu(
  ref: RefObject<HTMLElement | null>,
  onClose: (why: 'escape' | 'outside') => void,
  toggle: () => Element | null,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    (ref.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)') ?? items()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current('escape'); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      list[(at + step + list.length) % list.length].focus();
    };
    const own = toggleRef.current();
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node | null;
      if (!ref.current?.contains(el) && !(own && el && own.contains(el))) closeRef.current('outside');
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [ref]);
}
