import { formatListItems } from './markdown.js';

/** Maps CLI section shortcuts to their `##` header names. Shared by tasks + features. */
export const SECTION_MAP: Record<string, string> = {
  changelog: 'Changelog',
  notes: 'Notes',
  technical_details: 'Technical Details',
  constraints: 'Constraints & Decisions',
  user_stories: 'User Stories',
  acceptance_criteria: 'Acceptance Criteria',
  why: 'Why',
};

export interface PreparedInsert {
  sectionName: string;
  content: string;
  position: 'top' | 'bottom';
  replacePlaceholders: boolean;
}

/**
 * Normalize raw user content into a well-formed section insert:
 * - `user_stories` / `acceptance_criteria` → Markdown checkbox list items.
 * - `changelog` → dated `### <date> - Update` block, prepended (LIFO).
 * - `constraints` → dated `- **[<date>]** ...` bullet, prepended (LIFO).
 * - everything else → appended at the section bottom.
 * Bottom inserts replace template placeholders on first write.
 *
 * Returns null for an unknown section key.
 */
export function prepareSectionInsert(
  sectionKey: string,
  rawContent: string,
  dateStr: string,
): PreparedInsert | null {
  const sectionName = SECTION_MAP[sectionKey];
  if (!sectionName) return null;

  let content = rawContent;
  if (sectionKey === 'user_stories' || sectionKey === 'acceptance_criteria') {
    content = formatListItems(content, true);
  } else if (sectionKey === 'changelog') {
    content = `### ${dateStr} - Update\n- ${content}`;
  } else if (sectionKey === 'constraints') {
    content = `- **[${dateStr}]** ${content}`;
  }

  const position: 'top' | 'bottom' =
    sectionKey === 'changelog' || sectionKey === 'constraints' ? 'top' : 'bottom';

  return { sectionName, content, position, replacePlaceholders: position === 'bottom' };
}
