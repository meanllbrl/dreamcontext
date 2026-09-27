/**
 * An agent's report, cut at its `##` headings so a surface can FOLD it.
 *
 * The owner's words, on a thread that showed a six-section outreach report: "it must not bury
 * me in detail, but not this either" (this = a four-line summary with the report nowhere).
 * The middle is a report that answers first and keeps its detail one click away: the lead
 * (everything before the first `##`) reads as prose, and each section is a closed row that
 * names itself and previews its first line.
 *
 * `#` lines in the lead are dropped: a document title rendered at H1 inside a thread row is
 * the loudest thing on screen and says the least. Headings inside a code fence are not
 * headings, so the cut tracks fences.
 */
export interface ReportSection {
  title: string;
  body: string;
  /** The section's first readable line, syntax removed, for the closed row. Empty when the
   *  section opens with a table or nothing at all. */
  preview: string;
}

export interface SplitReport {
  lead: string;
  sections: ReportSection[];
}

/** A report with fewer sections than this is short enough to show whole. */
export const MIN_FOLDED_SECTIONS = 2;

const PREVIEW_MAX = 110;

/** INLINE syntax only. `markdownToText` also strips list and ordered markers, which here
 *  are content: "1. Waiting on you" is the section's number, "1) Ada" is the row's. */
function inlineText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/==[+!]?([^=]+)==/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function previewOf(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('|') || line.startsWith('```') || line.startsWith('#') || /^[-*_]{3,}$/.test(line)) continue;
    // A quote or bullet marker is syntax; what follows it is the line.
    const text = inlineText(line.replace(/^(>\s?)+/, '').replace(/^[-*+]\s+/, ''));
    if (!text) continue;
    return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : text;
  }
  return '';
}

export function splitReport(markdown: string): SplitReport {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const lead: string[] = [];
  const sections: { title: string; lines: string[] }[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMark = /^\s*(```|~~~)/.exec(line)?.[1] ?? null;
    if (fenceMark) fence = fence === null ? fenceMark : fence === fenceMark ? null : fence;
    const inFence = fence !== null || fenceMark !== null;
    const h2 = !inFence ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h2) {
      sections.push({ title: h2[1], lines: [] });
      continue;
    }
    if (sections.length === 0) {
      if (!inFence && /^#\s+/.test(line)) continue;
      lead.push(line);
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }

  return {
    lead: lead.join('\n').trim(),
    sections: sections.map((s) => {
      const body = s.lines.join('\n').trim();
      return { title: inlineText(s.title) || s.title, body, preview: previewOf(body) };
    }),
  };
}
