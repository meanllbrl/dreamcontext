import { readFileSync, writeFileSync } from 'node:fs';
import matter from 'gray-matter';

interface Section {
  name: string;
  level: number;
  startLine: number;
  endLine: number;
}

/**
 * Parse a markdown file into sections based on ## headers.
 * Only top-level (##) headers create sections. Sub-headers (###, ####, etc.)
 * are part of the parent section's content.
 */
function parseSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{2})\s+(.+)$/);
    if (match) {
      if (sections.length > 0) {
        sections[sections.length - 1].endLine = i - 1;
      }
      sections.push({
        name: match[2].trim(),
        level: match[1].length,
        startLine: i,
        endLine: lines.length - 1,
      });
    }
  }

  return sections;
}

/**
 * Normalize a section name for comparison.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find a section by name (case-insensitive, ignores special chars).
 */
function findSection(sections: Section[], sectionName: string): Section | null {
  const normalized = normalizeName(sectionName);
  return (
    sections.find((s) => normalizeName(s.name) === normalized) ?? null
  );
}

/**
 * List all section names in a markdown file.
 */
export function listSections(filePath: string): string[] {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  const sections = parseSections(parsed.content);
  return sections.map((s) => s.name);
}

/**
 * Read the content of a specific section.
 */
export function readSection(filePath: string, sectionName: string): string | null {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  const sections = parseSections(parsed.content);
  const section = findSection(sections, sectionName);
  if (!section) return null;

  const lines = parsed.content.split('\n');
  // Return lines after the header, up to the end of the section
  const bodyLines = lines.slice(section.startLine + 1, section.endLine + 1);
  return bodyLines.join('\n').trim();
}

/**
 * Recognise a template placeholder/skeleton line — the kind seeded by the
 * task/feature templates (e.g. `- [ ] As a [user], I want [action]...`,
 * `- (Specific, testable conditions...)`, `(To be defined)`). These should be
 * replaced by the first real insert, not appended after.
 */
export function isPlaceholderLine(line: string): boolean {
  const t = line.trim();
  if (t === '' || t.startsWith('<!--')) return false;
  // Whole-line parenthetical that BEGINS with a known template-filler stem.
  // Keyed to the stems instead of matching any "(...)" so a real one-line note
  // like `- (see RFC-42 for rationale)` is preserved, not silently dropped.
  if (/^[-*]?\s*\(\s*(?:to be defined|specific, testable|how this feature|key files|working notes|edge cases, open questions)[^)]*\)\s*$/i.test(t)) return true;
  // User-story skeletons with bracketed role/action/outcome tokens
  if (/\[(?:users?|roles?|actions?|outcomes?)\]/i.test(t)) return true;
  // Task acceptance-criteria skeleton: "...(matches node A1 in Workflow)"
  if (/\(matches node [A-Za-z0-9]+/i.test(t)) return true;
  return false;
}

/**
 * Wrap each non-empty line of `content` as a Markdown list item, unless it
 * already starts with a list marker. `checkbox` produces `- [ ] ` items.
 */
export function formatListItems(content: string, checkbox: boolean): string {
  return content
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === '') return line;
      if (/^[-*]\s+/.test(t)) return line; // already a bullet / checkbox
      return checkbox ? `- [ ] ${t}` : `- ${t}`;
    })
    .join('\n');
}

/**
 * Remove a section's body lines IN PLACE when they consist only of template
 * placeholders (plus blanks/comments). Comments are kept; placeholder text is
 * dropped; blank runs collapse. Returns the net number of lines removed (0 if
 * the body had real content and was left untouched).
 */
function stripPlaceholderBody(lines: string[], section: Section): number {
  const start = section.startLine + 1;
  const end = section.endLine;

  const meaningful: number[] = [];
  for (let i = start; i <= end; i++) {
    const t = lines[i]?.trim() ?? '';
    if (t === '' || t.startsWith('<!--')) continue;
    meaningful.push(i);
  }
  if (meaningful.length === 0) return 0;
  if (!meaningful.every((i) => isPlaceholderLine(lines[i]))) return 0;

  // Rebuild the body: keep comments, drop placeholder text, collapse blank runs.
  const kept: string[] = [];
  for (let i = start; i <= end; i++) {
    const line = lines[i] ?? '';
    const t = line.trim();
    if (t.startsWith('<!--')) { kept.push(line); continue; }
    if (t === '') {
      if (kept.length > 0 && kept[kept.length - 1].trim() === '') continue;
      kept.push('');
      continue;
    }
    // placeholder text → drop
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  const originalCount = end - start + 1;
  lines.splice(start, originalCount, ...kept);
  return originalCount - kept.length;
}

/**
 * Insert content into a specific section.
 * position 'top' = right after the header (LIFO), 'bottom' = before the next section.
 *
 * `replacePlaceholders` (bottom inserts): if the section currently holds only
 * template placeholders, they are dropped so the first real insert replaces the
 * skeleton instead of stacking under it. Bottom inserts always keep a blank
 * line before the following `##` header (no glued headers).
 */
export function insertToSection(
  filePath: string,
  sectionName: string,
  newContent: string,
  position: 'top' | 'bottom' = 'top',
  createIfMissing: boolean = false,
  replacePlaceholders: boolean = false,
): void {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  let lines = parsed.content.split('\n');
  let section = findSection(parseSections(lines.join('\n')), sectionName);

  if (!section) {
    if (createIfMissing) {
      // Sections are scaffolded on first insert (lean template). Keep Changelog
      // as the last section: new sections slot in right before it when present,
      // else append at the end of the file body. Re-locate after the splice.
      const changelog = sectionName === 'Changelog'
        ? null
        : findSection(parseSections(lines.join('\n')), 'Changelog');
      if (changelog) {
        const insertion = [`## ${sectionName}`, ''];
        if (changelog.startLine > 0 && (lines[changelog.startLine - 1]?.trim() ?? '') !== '') {
          insertion.unshift('');
        }
        lines.splice(changelog.startLine, 0, ...insertion);
      } else {
        lines.push('', `## ${sectionName}`);
      }
      section = findSection(parseSections(lines.join('\n')), sectionName);
    } else {
      throw new Error(`Section "${sectionName}" not found in ${filePath}`);
    }
  }

  // Optionally drop a placeholder-only body before inserting (re-parse on change).
  if (replacePlaceholders && section && stripPlaceholderBody(lines, section) > 0) {
    section = findSection(parseSections(lines.join('\n')), sectionName);
  }
  if (!section) throw new Error(`Section "${sectionName}" not found in ${filePath}`);

  const contentLines = newContent.split('\n');

  if (position === 'top') {
    // Insert right after the header line (skip HTML comments + blanks)
    let insertAt = section.startLine + 1;
    while (
      insertAt <= section.endLine &&
      (lines[insertAt]?.trim().startsWith('<!--') || lines[insertAt]?.trim() === '')
    ) {
      insertAt++;
    }
    // Blank/comment-only body (a section created on first insert): the scan
    // ran off the section's end — go back under the header, else the content
    // lands glued to the NEXT section's `##` line.
    if (insertAt > section.endLine) insertAt = section.startLine + 1;
    lines.splice(insertAt, 0, '', ...contentLines);
  } else {
    // Insert after the last non-blank content line of the section.
    let last = section.endLine;
    while (last > section.startLine && (lines[last]?.trim() ?? '') === '') last--;
    const insertAt = last + 1;
    const block = ['', ...contentLines];
    // Keep a blank line before whatever follows (next header / EOF).
    if (lines[insertAt] !== undefined && lines[insertAt].trim() !== '') block.push('');
    lines.splice(insertAt, 0, ...block);
  }

  // Reconstruct the file with frontmatter
  const output = matter.stringify(lines.join('\n'), parsed.data);
  writeFileSync(filePath, output, 'utf-8');
}

export interface MermaidNode {
  id: string;
  label: string;
  classes: string[];
}

const NODE_CLASSES = ['done', 'active', 'todo', 'blocked'] as const;
export type NodeStatus = typeof NODE_CLASSES[number];

/**
 * Extract nodes from the first ```mermaid flowchart block in `content`.
 * Recognises `Id[Label]:::class` and `Id["Label"]:::class` (and `(...)`, `{...}`).
 * `:::class` may also be applied via a separate `class A1,B2 done;` line.
 */
export function extractMermaidNodes(content: string): MermaidNode[] {
  const fence = content.match(/```mermaid\s+([\s\S]*?)```/);
  if (!fence) return [];
  let body = fence[1];

  if (!/^\s*flowchart\b/m.test(body) && !/^\s*graph\b/m.test(body)) return [];

  // Strip `subgraph Id [Label]` headers — their bracketed labels would otherwise
  // be picked up as nodes. Keep `end` lines (harmless).
  body = body.replace(/^\s*subgraph\b.*$/gm, '');

  const nodes = new Map<string, MermaidNode>();

  // Inline node defs: Id[Label] / Id(Label) / Id{Label}, optional :::class, label may be quoted.
  const nodeRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*[\[\(\{]\s*"?([^"\]\)\}\n]*?)"?\s*[\]\)\}](?::::([A-Za-z_][A-Za-z0-9_]*))?/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(body)) !== null) {
    const [, id, label, klass] = m;
    if (id === 'subgraph' || id === 'flowchart' || id === 'graph') continue;
    const existing = nodes.get(id);
    const classes = klass ? [klass] : [];
    if (existing) {
      if (klass && !existing.classes.includes(klass)) existing.classes.push(klass);
      if (!existing.label && label) existing.label = label.trim();
    } else {
      nodes.set(id, { id, label: label.trim(), classes });
    }
  }

  // Bare references with class: `A1:::done` (no brackets)
  const bareRe = /(?:^|[\s>])([A-Za-z_][A-Za-z0-9_]*):::([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = bareRe.exec(body)) !== null) {
    const [, id, klass] = m;
    const existing = nodes.get(id);
    if (existing) {
      if (!existing.classes.includes(klass)) existing.classes.push(klass);
    } else {
      nodes.set(id, { id, label: '', classes: [klass] });
    }
  }

  // Separate-line class assignments: `class A1,B2 done`
  const classLineRe = /^\s*class\s+([A-Za-z0-9_,\s]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/gm;
  while ((m = classLineRe.exec(body)) !== null) {
    const ids = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const klass = m[2];
    for (const id of ids) {
      const existing = nodes.get(id);
      if (existing) {
        if (!existing.classes.includes(klass)) existing.classes.push(klass);
      } else {
        nodes.set(id, { id, label: '', classes: [klass] });
      }
    }
  }

  // Drop classDef definitions accidentally captured (they have id === 'classDef'-style noise)
  // The regex above already excludes the `classDef` keyword because it isn't followed by `[(...{`.

  return Array.from(nodes.values());
}

/**
 * Status class assigned to a node, if any. Returns null if no recognised
 * status class is attached (raw classDef-only nodes excluded).
 */
export function nodeStatus(node: MermaidNode): NodeStatus | null {
  for (const c of node.classes) {
    if ((NODE_CLASSES as readonly string[]).includes(c)) return c as NodeStatus;
  }
  return null;
}

/** The one line grammar both checkbox readers below share, so "what counts as a criterion"
 *  can never drift between the counter and the reader. Group 1 is the box, group 2 the text. */
const CHECKBOX_LINE_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;

/**
 * Count acceptance-criteria checkboxes (- [ ] / - [x]) in a markdown body.
 * Returns { total, done }.
 */
export function countCheckboxes(sectionBody: string): { total: number; done: number } {
  const lines = sectionBody.split('\n');
  let total = 0;
  let done = 0;
  for (const line of lines) {
    const m = line.match(CHECKBOX_LINE_RE);
    if (!m) continue;
    total++;
    if (m[1].toLowerCase() === 'x') done++;
  }
  return { total, done };
}

/**
 * Strip the markdown emphasis a criterion carries, keeping its words.
 *
 * DELIBERATELY CONSERVATIVE: only `**strong**`, `__strong__` and `` `code` `` are unwrapped.
 * Single `*`/`_` are left alone because acceptance criteria are full of paths — a naive
 * `_italic_` rule turns `_dream_context/state/x.md` into `dreamcontext/state/x.md`, which is
 * a worse outcome than leaving a stray asterisk in the rare italicised criterion. This is a
 * label for one line of UI, not a markdown renderer.
 */
function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1');
}

/**
 * The text of the FIRST unticked acceptance criterion — "what is in flight" for the chat
 * shelf's progress row — or null when the section has no criteria or every one is ticked.
 *
 * Reads the same line grammar {@link countCheckboxes} counts, so the number and the name can
 * never describe different sets of lines. Emphasis is stripped (see {@link stripEmphasis});
 * the result is trimmed and never empty — a `- [ ]` with no text after it is skipped rather
 * than returned as `''`.
 */
export function firstUnticked(sectionBody: string): string | null {
  for (const line of sectionBody.split('\n')) {
    const m = line.match(CHECKBOX_LINE_RE);
    if (!m || m[1].toLowerCase() === 'x') continue;
    const text = stripEmphasis(m[2]).trim();
    if (text) return text;
  }
  return null;
}


/**
 * One acceptance-criterion checkbox, with the milestone heading it sits under.
 *
 * `group` exists because a flat list of twenty answers "how many" and not "where am I".
 * Criteria in this repo are written under `### ` milestone headings (`### Part A — …`,
 * `### Validation`), which are already the run's phases.
 */
export interface Checkbox {
  /** Read from the same `[x]` / `[ ]` grammar {@link countCheckboxes} counts. */
  done: boolean;
  /** The criterion's words, emphasis unwrapped (see {@link stripEmphasis}). EMPTY when the
   *  task file holds a malformed `- [ ]` with nothing after it — kept rather than skipped,
   *  so the list length can never drift from the number rendered beside it. */
  text: string;
  /** The nearest `###`-or-deeper heading ABOVE this line inside the section, or null when
   *  the line precedes every heading (or the section has none). */
  group: string | null;
}

/** `### `…`###### ` inside a section body. `##` cannot appear here — it would have ENDED the
 *  section before `readSection` handed the body over. */
const SUBHEADING_LINE_RE = /^\s{0,3}#{3,6}\s+(.+?)\s*#*\s*$/;

/**
 * Every acceptance-criteria checkbox in a section body, in document order.
 *
 * ONE READER, ONE GRAMMAR. This walks the same `CHECKBOX_LINE_RE` {@link countCheckboxes}
 * counts and applies the same {@link stripEmphasis} {@link firstUnticked} applies, so the
 * list, the fraction and the name of what is in flight can never describe different sets of
 * lines. That is the whole reason it lives here beside them rather than being re-derived by
 * whatever needs a list — a second parser is a second, quietly different answer.
 *
 * The invariant callers rely on, and the reason nothing is filtered out:
 *
 *     listCheckboxes(body).length === countCheckboxes(body).total
 *
 * holds for EVERY body, including malformed ones. `firstUnticked` skips a `- [ ]` with no
 * text (returning `''` as "what is in flight" would be worse than looking further down), but
 * a LIST that silently dropped it would render 19 rows under a heading reading `8/20`, which
 * is the exact defect this list was added to fix. So the entry is kept with an empty `text`,
 * and a caller wanting the line `firstUnticked` names asks for the first unticked entry whose
 * text is non-empty — the two then agree by construction.
 *
 * Consistent with both of them, this is deliberately NOT a markdown parser:
 *   • no fenced-code tracking — a `- [ ]` inside a fence is counted by `countCheckboxes`
 *     today, and a list that skipped it would no longer match the number beside it;
 *   • only the checkbox's OWN line is read, so a criterion continued on following lines
 *     contributes its first line exactly as `firstUnticked` already reports it.
 */
export function listCheckboxes(sectionBody: string): Checkbox[] {
  const out: Checkbox[] = [];
  let group: string | null = null;
  for (const line of sectionBody.split('\n')) {
    const heading = line.match(SUBHEADING_LINE_RE);
    if (heading) {
      const name = stripEmphasis(heading[1]).trim();
      // An empty `### ` resets to ungrouped rather than becoming a blank heading on screen.
      group = name || null;
      continue;
    }
    const m = line.match(CHECKBOX_LINE_RE);
    if (!m) continue;
    out.push({ done: m[1].toLowerCase() === 'x', text: stripEmphasis(m[2]).trim(), group });
  }
  return out;
}
