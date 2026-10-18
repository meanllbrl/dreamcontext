/**
 * A card body cut at its `## ` headings (fenced blocks are never cut), so the task page can put
 * each section where it belongs: the criteria and decisions in their own pieces, Why, Technical
 * Details and Notes as sections, a legacy in-card Changelog folded away, anything else under
 * "More". Text before the first heading is kept as an untitled lead.
 */
export interface BodySection {
  /** The heading as written (`''` for the lead). */
  title: string;
  /** What the page calls it: a known section, or `other`. */
  key: SectionKey;
  text: string;
}

export type SectionKey = 'lead' | 'why' | 'stories' | 'criteria' | 'decisions' | 'details' | 'notes' | 'changelog' | 'other';

const FENCE_RE = /^\s*(```|~~~)/;

function keyOf(title: string): SectionKey {
  const k = title.toLowerCase().replace(/[^a-z]/g, '');
  if (k === 'why') return 'why';
  if (k === 'userstories') return 'stories';
  if (k === 'acceptancecriteria') return 'criteria';
  if (k === 'constraintsdecisions' || k === 'constraints' || k === 'decisions') return 'decisions';
  if (k === 'technicaldetails') return 'details';
  if (k === 'notes') return 'notes';
  if (k === 'changelog') return 'changelog';
  return 'other';
}

export function splitBodySections(body: string): BodySection[] {
  const out: BodySection[] = [];
  let title = '';
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join('\n').trim();
    if (title || text) out.push({ title, key: title ? keyOf(title) : 'lead', text });
  };
  for (const line of (body ?? '').split('\n')) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const h = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (h) {
      flush();
      title = h[1];
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}
