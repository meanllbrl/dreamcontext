/**
 * Reading what the reverted 0.33.0 task system wrote.
 *
 * 0.33.0 was installed on a few machines and never published. It moved each
 * task's `## Changelog` into `state/journal/<slug>.md` and wrote NEW history in
 * its own heading shape:
 *
 *   ### 2026-10-19 21:04 - log [je_GdiRYGvJEp]
 *   ### 2026-10-19 22:00 - status: Status → in_review [je_itE6EqBkls]
 *   ### 2026-10-19 20:52 - evidence [je_Phk7pS5rMi] (by mehmet-nuraydin)
 *
 * and its sync posted those entries as comments carrying a hidden
 * `<!-- je:<id> -->` marker. This module turns that shape back into the one this
 * CLI writes (`### <date> - <title>`), so the journal fold (task-journal-fold.ts)
 * puts readable history back on the card, and so a remote comment 0.33.0 posted
 * compares EQUAL to the entry folded from the same journal line — instead of
 * reading as a stranger's comment and being merged in a second time.
 *
 * Entries 0.33.0 moved off a card verbatim carry no `[je_…]` id and are left
 * byte-for-byte: only a heading with the id suffix is rewritten.
 */

/**
 * Every pattern here runs on text this machine does not own — raw ClickUp and
 * GitHub comments, teammates' cards — so each one is linear by construction: no
 * two adjacent quantifiers can match the same character, nothing unanchored
 * scans a whitespace run, and the cheap guards below reject a line before any
 * pattern sees it. (The first version, `-\s+(.*?)\s+\[je_`, took 49 s on one
 * 4,000-character comment line.)
 */

/** A 0.33.0 heading is one short line; anything longer is left exactly as it is. */
export const MAX_HEADING_LINE = 500;
/** `### <date>[ HH:MM] -`, anchored; every quantifier is followed by a character it cannot match. */
const V033_PREFIX = /^###\s+(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2})?\s+-/;
/** What follows the label, tried at ONE position (sticky): ` [je_<id>]`, an optional ` (by <actor>)`, the end. */
const V033_SUFFIX = /\[je_[A-Za-z0-9_-]{4,}\](?:\s+\(by ([^)]+)\))?\s*$/y;
/** The hidden marker 0.33.0's sync put on each comment; the blanks before it are trimmed by hand (see stripJeMarkers). */
const JE_MARKER = /<!--\s*je:[A-Za-z0-9_-]+\s*-->/g;
const FENCE = /^\s*(```|~~~)/;
const KIND = /^[a-z]+$/;
const isBlank = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** `### <date> - <title>` for a 0.33.0 heading line, or null for any other line. */
export function convertJournalHeading(line: string): string | null {
  if (line.length > MAX_HEADING_LINE || !line.startsWith('###') || !line.includes('[je_')) return null;
  const head = V033_PREFIX.exec(line);
  if (!head) return null;
  const idAt = line.lastIndexOf('[je_');
  V033_SUFFIX.lastIndex = idAt;
  const tail = V033_SUFFIX.exec(line);
  if (!tail) return null;
  // Between the ` -` and the `[je_` id: at least one blank on each side of the label.
  const mid = line.slice(head[0].length, idAt);
  if (!isBlank(mid[0]) || !isBlank(mid[mid.length - 1]) || mid.length < 2) return null;
  const date = head[1];
  const actor = tail[1];
  const label = mid.trim();
  const colon = label.indexOf(':');
  const word = colon < 0 ? label : label.slice(0, colon);
  const kind = KIND.test(word) ? word : '';
  const rest = kind && colon >= 0 ? label.slice(colon + 1).trim() : '';
  let title: string;
  switch (kind) {
    case 'created': title = 'Created'; break;
    case 'log': title = rest || 'Session Update'; break;
    case 'status': title = rest || 'Status changed'; break;
    case 'evidence': title = rest ? `Evidence: ${rest}` : 'Evidence'; break;
    case 'approval': title = rest ? `Approval: ${rest}` : 'Approval'; break;
    case 'sleep': title = rest ? `Sleep: ${rest}` : 'Sleep'; break;
    case 'remote': title = 'Comment'; break;
    default: title = label;
  }
  const by = actor ? ` (by ${actor.trim().replace(/^remote:/, '')})` : '';
  return `### ${date} - ${title}${by}`;
}

/** Drop each `<!-- je:… -->` marker and the spaces/tabs right before it. Linear: the blanks are trimmed by a loop, not a pattern. */
function stripJeMarkers(line: string): string {
  if (!line.includes('<!--') || !line.includes('je:')) return line;
  let out = '';
  let from = 0;
  for (const m of line.matchAll(JE_MARKER)) {
    let end = m.index;
    while (end > from && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
    out += line.slice(from, end);
    from = m.index + m[0].length;
  }
  return from === 0 ? line : out + line.slice(from);
}

/**
 * Journal text → changelog text: 0.33.0 headings rewritten (outside code
 * fences), `<!-- je:… -->` markers dropped, every other byte kept.
 */
export function convertJournalText(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return stripJeMarkers(convertJournalHeading(line) ?? line);
    })
    .join('\n');
}

/**
 * The comparison form of a changelog entry (or a remote comment): the 0.33.0
 * shape converted, markers dropped, whitespace collapsed. Every "is this the
 * same history line" check on the sync path goes through this.
 */
export function canonicalEntry(entry: string): string {
  return convertJournalText(entry).replace(/\s+/g, ' ').trim();
}
