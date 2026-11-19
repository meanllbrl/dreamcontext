/**
 * Put an `ask` button's text into the composer as a numbered line.
 *
 * Pure so it can be tested. The next number comes from the LAST line of `current` that starts
 * with `N.` (never a separate counter), so a hand-deleted line or a cleared composer just
 * continues from what is there. Text the owner typed by hand is never touched: the new item
 * goes on its own line below it. The same item twice is not added twice.
 */
const NUMBERED = /^(\d+)\.\s/;

export function appendActionText(current: string, text: string): string {
  const item = text.trim();
  if (!item) return current;
  const lines = current.split('\n');
  let last = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = NUMBERED.exec(lines[i]);
    if (m) { last = Number(m[1]); break; }
  }
  // Same button pressed again: that item is already a numbered line.
  if (lines.some((l) => NUMBERED.test(l) && l.replace(NUMBERED, '').trim() === item)) return current;
  const line = `${last + 1}. ${item}`;
  if (!current.trim()) return current + line;
  return current.endsWith('\n') ? current + line : `${current}\n${line}`;
}
