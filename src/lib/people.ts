import { slugify } from './id.js';

/**
 * Multi-person attribution helpers.
 *
 * Person attribution rides existing carriers — there is no bespoke person data
 * type. A person is identified by a kebab-case slug (`slugify(name)`), the same
 * slug used in `person:<slug>` task tags and in changelog `authors`.
 *
 * `ensurePeopleSection` keeps a `## People` block in `1.user.md` in sync with the
 * roster. It is a NO-OP for single-person projects (≤1 person) so single-person
 * `user.md` stays byte-identical to today, and it is idempotent: repeated calls
 * with the same roster yield identical output (it replaces the block in place).
 */

const PEOPLE_HEADING = '## People';

/** Build the `## People` block body (heading + one bullet per person). */
function renderPeopleSection(people: string[]): string {
  const lines = [PEOPLE_HEADING, ''];
  for (const name of people) {
    lines.push(`- ${name} (\`person:${slugify(name)}\`)`);
  }
  return lines.join('\n');
}

/**
 * Find the `[start, end)` line range of an existing `## People` section, or null.
 * The section runs from its heading up to (but not including) the next H2/H1
 * heading, or to end-of-file.
 */
function findPeopleSection(lines: string[]): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === PEOPLE_HEADING) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Return `userMd` with its `## People` section reflecting `people`.
 *
 * - ≤1 person ⇒ returns `userMd` UNCHANGED (no section is added or removed). A
 *   single-person project never grows a People block.
 * - >1 person ⇒ inserts the block (appended after a trailing blank line) when
 *   absent, or replaces an existing block in place. Idempotent across repeated
 *   calls with the same roster.
 */
export function ensurePeopleSection(userMd: string, people: string[]): string {
  if (people.length <= 1) return userMd;

  const block = renderPeopleSection(people);
  const lines = userMd.split('\n');
  const existing = findPeopleSection(lines);

  if (existing) {
    // Replace the existing section (heading through just-before the next
    // heading) with the freshly rendered block. Normalise trailing whitespace
    // on the segment after the block so the output is a stable fixed point:
    // re-running with the same roster reproduces this exact string.
    const before = lines.slice(0, existing.start);
    const after = lines.slice(existing.end);
    const head = before.join('\n').replace(/\s+$/, '');
    const tail = after.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
    const prefix = head.length > 0 ? `${head}\n\n` : '';
    const suffix = tail.length > 0 ? `\n\n${tail}\n` : '\n';
    return `${prefix}${block}${suffix}`;
  }

  // Append the block at the end, separated by a single blank line. Trim trailing
  // whitespace first so appends are stable (idempotent block boundary).
  const trimmed = userMd.replace(/\s+$/, '');
  if (trimmed.length === 0) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}
