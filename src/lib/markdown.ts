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
 * Insert content into a specific section.
 * position 'top' = right after the header (LIFO), 'bottom' = before the next section.
 */
export function insertToSection(
  filePath: string,
  sectionName: string,
  newContent: string,
  position: 'top' | 'bottom' = 'top',
  createIfMissing: boolean = false,
): void {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  const lines = parsed.content.split('\n');
  const sections = parseSections(parsed.content);
  let section = findSection(sections, sectionName);

  if (!section) {
    if (createIfMissing) {
      // Append a new ## section at the end of the file body
      const headerLine = `## ${sectionName}`;
      lines.push('', headerLine);
      const startLine = lines.length - 1;
      section = { name: sectionName, level: 2, startLine, endLine: startLine };
    } else {
      throw new Error(`Section "${sectionName}" not found in ${filePath}`);
    }
  }

  // Find the insertion point
  let insertAt: number;

  if (position === 'top') {
    // Insert right after the header line (skip HTML comments)
    insertAt = section.startLine + 1;
    while (
      insertAt <= section.endLine &&
      (lines[insertAt]?.trim().startsWith('<!--') || lines[insertAt]?.trim() === '')
    ) {
      insertAt++;
    }
  } else {
    insertAt = section.endLine + 1;
  }

  // Insert the new content
  const contentLines = newContent.split('\n');
  lines.splice(insertAt, 0, '', ...contentLines);

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

