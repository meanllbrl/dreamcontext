/**
 * Keeps the highlight mirror (`.chat-cmp-hl`) glued to the textarea it sits behind. The mirror
 * is the same text at the same metrics, so two things used to pull it off its words:
 *
 * - the textarea's scrollbar takes width the mirror (overflow hidden) never loses, so a line
 *   wrapped in one and not the other and every band below it slid a line;
 * - a draft ending in a newline has an empty last line in the textarea that `pre-wrap` drops
 *   from the mirror, so the mirror could never scroll as far as the text it follows.
 *
 * DOM-only and React-free so a test can drive it with plain objects.
 */

/** Zero-width space closing the mirror's text: it gives a trailing newline a line to own. */
export const MIRROR_TAIL = '​';

interface FieldBox { scrollTop: number; offsetWidth: number; clientWidth: number }
interface MirrorBox { scrollTop: number; style: { setProperty(name: string, value: string): void } }

/** Make the mirror's text box exactly as wide as the textarea's, and scroll it to match. */
export function syncMirror(field: FieldBox, mirror: MirrorBox): void {
  const gutter = Math.max(0, field.offsetWidth - field.clientWidth);
  mirror.style.setProperty('--chat-cmp-hl-gutter', `${gutter}px`);
  if (mirror.scrollTop !== field.scrollTop) mirror.scrollTop = field.scrollTop;
}
