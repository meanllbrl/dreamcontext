/**
 * A task body, read as its `## ` sections. Pure (no React, no DOM), so the detail drawer and
 * the unit tests share one reading of the markdown.
 *
 * The drawer renders each known section in a fixed order (AC10) and edits the body in place:
 * ticking a criterion flips exactly ONE line inside ONE section (never a checkbox in another
 * section, never one inside fenced code), and a criterion linked to a mermaid node
 * (`<!-- node:<id> -->`) moves that node's `:::done|:::todo` class in the same write.
 */

export type SectionKey =
  | 'why' | 'user_stories' | 'acceptance_criteria' | 'workflow' | 'constraints'
  | 'technical_details' | 'notes' | 'changelog' | 'other';

/** The headings the task template writes, by key. */
export const SECTION_HEADINGS: Record<Exclude<SectionKey, 'other'>, string> = {
  why: 'Why',
  user_stories: 'User Stories',
  acceptance_criteria: 'Acceptance Criteria',
  workflow: 'Workflow',
  constraints: 'Constraints & Decisions',
  technical_details: 'Technical Details',
  notes: 'Notes',
  changelog: 'Changelog',
};

const KEY_BY_HEADING = new Map(
  (Object.entries(SECTION_HEADINGS) as [Exclude<SectionKey, 'other'>, string][]).map(([k, h]) => [h.toLowerCase(), k]),
);

export interface BodySection {
  key: SectionKey;
  /** The heading text as written ('' for the text before the first heading). */
  heading: string;
  /** The section's text WITHOUT its heading line. */
  text: string;
  /** Line index of the heading (or of the first line, for the preamble). */
  start: number;
  /** Line index one past the section's last line. */
  end: number;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^##\s+(.+?)\s*#*\s*$/;
// Bullet or ordered (`1.` / `1)`) task-list items, as marked renders them; a CRLF body's `\r` is not part of the text.
const CHECKBOX_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s+)(.*?)(\r?)$/;

/** Every `## ` section in order, plus a leading `other` preamble when there is text before the first heading. */
export function splitSections(body: string): BodySection[] {
  const lines = body.split('\n');
  const out: BodySection[] = [];
  let fence: string | null = null;
  let cur: { key: SectionKey; heading: string; start: number } | null = null;
  const close = (end: number) => {
    if (!cur) return;
    const textLines = lines.slice(cur.heading ? cur.start + 1 : cur.start, end);
    out.push({ ...cur, text: textLines.join('\n'), end });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
    }
    if (fence !== null && !f) continue;
    if (f) continue;
    const h = HEADING_RE.exec(line);
    if (h && !line.startsWith('###')) {
      close(i);
      const heading = h[1].trim();
      cur = { key: KEY_BY_HEADING.get(heading.toLowerCase()) ?? 'other', heading, start: i };
      continue;
    }
    if (!cur && line.trim()) cur = { key: 'other', heading: '', start: i };
  }
  close(lines.length);
  return out;
}

/** The first section with this key, or null. */
export function findSection(body: string, key: SectionKey): BodySection | null {
  return splitSections(body).find((s) => s.key === key) ?? null;
}

/** Template sections the body does not have yet, or has only as an empty heading (the "+ Add section" menu). */
export function missingSections(body: string): Exclude<SectionKey, 'other'>[] {
  const present = new Set(splitSections(body).filter((s) => sectionContent(s.text)).map((s) => s.key));
  return (Object.keys(SECTION_HEADINGS) as Exclude<SectionKey, 'other'>[]).filter((k) => !present.has(k));
}

/** A checkbox line inside a section: its index among the section's checkboxes, state and text. */
export interface CheckItem { index: number; checked: boolean; text: string; line: number }

/** The checkbox lines of a section, in order, skipping fenced code. */
export function checkItems(body: string, key: SectionKey): CheckItem[] {
  const sec = findSection(body, key);
  if (!sec) return [];
  const lines = body.split('\n');
  const items: CheckItem[] = [];
  let fence: string | null = null;
  let inComment = false;
  for (let i = sec.start + (sec.heading ? 1 : 0); i < sec.end; i++) {
    const line = lines[i];
    // An HTML comment (a template hint) renders nothing, so a checkbox inside one is not a box.
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (fence === null && /^\s*<!--/.test(line)) { if (!line.includes('-->')) inComment = true; continue; }
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = CHECKBOX_LINE_RE.exec(line);
    if (!m) continue;
    items.push({ index: items.length, checked: m[2] !== ' ', text: m[4], line: i });
  }
  return items;
}

/**
 * Set (or flip) the `index`-th checkbox of ONE section. Lines outside the section and lines in
 * fenced code are never touched. Returns null when the section or the checkbox does not exist.
 * `nodeId` is the `<!-- node:<id> -->` the line carries (for the mermaid sync), else null.
 */
export function toggleCheckbox(
  body: string,
  sectionKey: SectionKey,
  index: number,
  checked?: boolean,
): { body: string; nodeId: string | null; checked: boolean } | null {
  const item = checkItems(body, sectionKey).find((it) => it.index === index);
  if (!item) return null;
  const lines = body.split('\n');
  const m = CHECKBOX_LINE_RE.exec(lines[item.line]);
  if (!m) return null;
  const next = checked ?? !item.checked;
  const [, prefix, , spacing, rest, cr] = m;
  lines[item.line] = `${prefix}${next ? '[x]' : '[ ]'}${spacing}${rest}${cr}`;
  const node = /<!--\s*node:([A-Za-z0-9_-]+)\s*-->/.exec(rest);
  return { body: lines.join('\n'), nodeId: node ? node[1] : null, checked: next };
}

// Edge-line operators in mermaid flowcharts. A line containing one is an edge statement, never
// a node definition, and must not have its `:::status` rewritten (it would flip the wrong node).
const MERMAID_EDGE_RE = /-->|---|==>|==|-\.|~~~|\.->/;

/**
 * In every mermaid block of `body`, rewrite the node DEFINITION of `nodeId` to `:::done`
 * (checked) or `:::todo`. Class/style/edge lines are left alone.
 */
export function updateMermaidNodeStatus(body: string, nodeId: string, checked: boolean): string {
  const status = checked ? 'done' : 'todo';
  const escapedId = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nodeDefRe = new RegExp(
    `^(\\s*)(${escapedId})((?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\})?)(\\s*:::(?:done|todo|active|blocked)\\b)?\\s*$`,
  );
  const lines = body.split('\n');
  let inMermaid = false;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inMermaid) {
      const open = /^(\s*)(```|~~~)\s*mermaid\b/i.exec(line);
      if (open) { inMermaid = true; fenceChar = open[2]; }
      continue;
    }
    if (line.trim().startsWith(fenceChar)) { inMermaid = false; fenceChar = ''; continue; }
    if (/^\s*(classDef|class|style|linkStyle|click|subgraph|end)\b/.test(line)) continue;
    if (MERMAID_EDGE_RE.test(line)) continue;
    const m = nodeDefRe.exec(line);
    if (!m) continue;
    const [, indent, id, label] = m;
    lines[i] = `${indent}${id}${label ?? ''}:::${status}`;
  }
  return lines.join('\n');
}

/** Tick a criterion and keep its linked mermaid node in step. Null when nothing changes. */
export function toggleCriterion(body: string, sectionKey: SectionKey, index: number, checked?: boolean): string | null {
  const t = toggleCheckbox(body, sectionKey, index, checked);
  if (!t) return null;
  const next = t.nodeId ? updateMermaidNodeStatus(t.body, t.nodeId, t.checked) : t.body;
  return next === body ? null : next;
}

/**
 * The newest `n` entries of a LIFO section and how many there are. `constraints`: each top-level
 * `- ` bullet (with its indented continuation lines). `changelog`: each `### ` block. HTML
 * comments (template hints) are not entries.
 */
export function latestEntries(sectionText: string, n: number, kind: 'constraints' | 'changelog'): { entries: string[]; total: number } {
  const lines = sectionText.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const entries: string[] = [];
  let cur: string[] | null = null;
  const push = () => { if (cur) { const e = cur.join('\n').trim(); if (e) entries.push(e); } cur = null; };
  for (const line of lines) {
    const starts = kind === 'constraints' ? /^[-*+]\s+/.test(line) : /^###\s+/.test(line);
    if (starts) { push(); cur = [line]; continue; }
    if (cur) cur.push(line);
  }
  push();
  return { entries: entries.slice(0, n), total: entries.length };
}

/** A section's text with template hint comments removed and trimmed: '' means "nothing written". */
export function sectionContent(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}
