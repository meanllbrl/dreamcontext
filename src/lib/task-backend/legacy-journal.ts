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

const V033_HEADING =
  /^###\s+(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2})?\s+-\s+(.*?)\s+\[je_[A-Za-z0-9_-]{4,}\](?:\s+\(by ([^)]+)\))?\s*$/;
const JE_MARKER = /[ \t]*<!--\s*je:[A-Za-z0-9_-]+\s*-->/g;
const FENCE = /^\s*(```|~~~)/;

/** `### <date> - <title>` for a 0.33.0 heading line, or null for any other line. */
export function convertJournalHeading(line: string): string | null {
  const m = V033_HEADING.exec(line);
  if (!m) return null;
  const [, date, label, actor] = m;
  const k = /^([a-z]+)(?::\s*(.*))?$/.exec(label.trim());
  const kind = k?.[1] ?? '';
  const rest = (k?.[2] ?? '').trim();
  let title: string;
  switch (kind) {
    case 'created': title = 'Created'; break;
    case 'log': title = rest || 'Session Update'; break;
    case 'status': title = rest || 'Status changed'; break;
    case 'evidence': title = rest ? `Evidence: ${rest}` : 'Evidence'; break;
    case 'approval': title = rest ? `Approval: ${rest}` : 'Approval'; break;
    case 'sleep': title = rest ? `Sleep: ${rest}` : 'Sleep'; break;
    case 'remote': title = 'Comment'; break;
    default: title = label.trim();
  }
  const by = actor ? ` (by ${actor.trim().replace(/^remote:/, '')})` : '';
  return `### ${date} - ${title}${by}`;
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
      return (convertJournalHeading(line) ?? line).replace(JE_MARKER, '');
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
