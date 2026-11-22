/** An open sheet (components/apps/Sheet.tsx) and whether its project is the one on screen. */
export interface OpenSheet { onScreen: () => boolean }

/** The sheet that owns the keyboard: the newest one whose project is on screen. A sheet of a
 *  project out of sight (prepared, or left) is skipped, never the top that refuses the keys. */
export function keyboardOwner(sheets: readonly OpenSheet[]): OpenSheet | null {
  for (let i = sheets.length - 1; i >= 0; i--) if (sheets[i].onScreen()) return sheets[i];
  return null;
}
