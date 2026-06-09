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
  // Whole-line parenthetical, optionally bulleted: "(...)" / "- (...)"
  if (/^[-*]?\s*\([^)]*\)\s*$/.test(t)) return true;
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
      // Append a new ## section at the end of the file body, then re-locate it.
      lines.push('', `## ${sectionName}`);
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

/**
 * Count acceptance-criteria checkboxes (- [ ] / - [x]) in a markdown body.
 * Returns { total, done }.
 */
export function countCheckboxes(sectionBody: string): { total: number; done: number } {
  const lines = sectionBody.split('\n');
  let total = 0;
  let done = 0;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+/);
    if (!m) continue;
    total++;
    if (m[1].toLowerCase() === 'x') done++;
  }
  return { total, done };
}

