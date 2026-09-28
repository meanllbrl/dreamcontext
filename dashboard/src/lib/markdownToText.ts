/**
 * Markdown → readable prose, for places that show a PREVIEW of a document
 * rather than the document.
 *
 * WHY NOT JUST RENDER THE MARKDOWN. An agent's description is its `## Prompt`
 * — an operational document, often hundreds of lines, opening with a
 * blockquote status header and a wall of bold. Dropping the raw string into a
 * card shows the reader `> **DURDURULDU 2026-09-19 (Day-44).**`, which is
 * worse than useless. But RENDERING it in a 300px card is not the fix either:
 * a blockquote rule, a bold run and a bullet list inside two clamped lines is
 * three kinds of texture and no information.
 *
 * So a card gets prose — the same sentences with the syntax removed — and the
 * surfaces that have room to be a document (the profile popover, the detail
 * panel) render the real markdown. One document, two honest views of it.
 */

/** Order matters: fences and code spans come out FIRST so their contents are
 *  never treated as syntax, and link text survives before the brackets go. */
export function markdownToText(md: string): string {
  return md
    // Fenced blocks — dropped whole. A card cannot show code, and half a
    // fence is worse than none.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // Images before links: `![alt](src)` keeps nothing, a link keeps its text.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Wikilinks — `[[target|label]]` reads as its label.
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    // HTML comments and tags.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    // Inline code keeps its contents — an agent's prompt names real files and
    // commands, and those ARE the description.
    .replace(/`([^`]*)`/g, '$1')
    // Block syntax at line starts: headings, blockquotes, list bullets,
    // ordered markers, table pipes, thematic breaks.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ')
    .replace(/^[ \t]*\|/gm, ' ')
    // Emphasis. Done after block syntax so a `**bold**` opening a heading is
    // already unwrapped from the `#`.
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // `==highlight==` — this project's own extension.
    .replace(/==([^=]+)==/g, '$1')
    // Whatever survived: one line, single-spaced. A card clamps by LINE, so a
    // preserved newline would spend one of its two lines on nothing.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The card's one- or two-line summary: prose, cut at a word boundary, with an
 * ellipsis only when something was actually removed.
 *
 * Cuts on a word, never mid-word — `Kanallar: Insta…` reads as a truncation,
 * `Kanallar: Instagr…` reads as a bug.
 */
export function summarize(md: string, maxChars = 150): string {
  const text = markdownToText(md);
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
