import { useEffect, useState } from 'react';

/**
 * How much of the layout viewport the visual viewport may lose before it counts as an on-screen
 * keyboard. Safari's collapsing URL bar takes well under this; a phone keyboard takes ~260 px+.
 */
export const KEYBOARD_MIN_PX = 120;

/** Whether an on-screen keyboard is up, from the layout and the visual viewport heights. Pure. */
export function keyboardShown(layoutHeight: number, visualHeight: number): boolean {
  return layoutHeight > 0 && visualHeight > 0 && layoutHeight - visualHeight >= KEYBOARD_MIN_PX;
}

/**
 * The on-screen keyboard is up (`visualViewport`), read only while `enabled` — on a phone, keyed on
 * the phone layout and not on width, so a landscape phone hides its bottom bar too. False anywhere
 * without a visual viewport.
 */
export function useKeyboardUp(enabled: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!enabled || !vv) { setUp(false); return undefined; }
    const read = () => setUp(keyboardShown(window.innerHeight, vv.height));
    vv.addEventListener('resize', read);
    read();
    return () => vv.removeEventListener('resize', read);
  }, [enabled]);
  return up;
}
