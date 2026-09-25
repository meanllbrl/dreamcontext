/**
 * A file name shortened in the MIDDLE, so the part that tells two files apart survives.
 *
 * CSS can only cut the end, and the end is what matters: an agent's files share a long prefix
 * (`quarterly_signup_funnel_analysis_…`) and differ in the date or version just before the
 * extension. An 86-character name in a 270px card lost 57% of itself to a trailing ellipsis and
 * with it the only distinguishing part. This keeps the head, the last few characters of the
 * stem and the extension, and puts the `…` between them. Callers still give the element the
 * full name as its `title`.
 */

/** How much of the stem's END is always kept, before the extension. */
const TAIL_CHARS = 8;

export function middleTruncate(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  // A leading dot (`.env`) or no dot at all is not an extension.
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, dot) : name;
  const tail = stem.slice(-TAIL_CHARS) + ext;
  const headLen = max - tail.length - 1;
  // Too narrow to keep a head: keep the end, which is the part worth reading.
  if (headLen < 1) return `…${name.slice(-(max - 1))}`;
  return `${stem.slice(0, headLen)}…${tail}`;
}
