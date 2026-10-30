import { useEffect, useState } from 'react';

/** True while the window is at most `px` wide. A WIDTH check only: unlike `useIsMobile` it
 *  never asks about the pointer, so a narrow desktop window counts (the new shell's ≤900 and
 *  ≤600 layouts). */
export function useIsNarrowWindow(px: number): boolean {
  const query = `(max-width: ${px}px)`;
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}
