import matter from 'gray-matter';
import { readFileSync, writeFileSync } from 'node:fs';

export interface FrontmatterResult<T = Record<string, unknown>> {
  data: T;
  content: string;
}

/**
 * Read a markdown file and parse its YAML frontmatter.
 */
export function readFrontmatter<T = Record<string, unknown>>(
  filePath: string,
): FrontmatterResult<T> {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  return {
    data: parsed.data as T,
    content: parsed.content,
  };
}

/**
 * `visibility: false` is the author's escape hatch: the file stays on disk and
 * stays listed on the dashboard, but it never enters an AGENT surface — not the
 * knowledge index, snapshot, `memory recall` (BM25 + semantic), embeddings,
 * taxonomy, sleep, or a federation digest pushed to a peer.
 *
 * Both choke points call this — `buildKnowledgeIndex` (index/snapshot/graph) and
 * `loadMarkdownDocs` (the whole recall corpus) — so the field works on ANY
 * frontmatter doc: knowledge, feature, task, thesis, objective, insight,
 * automation.
 *
 * Only an explicit opt-out hides a file. Boolean `false` is the documented form;
 * the quoted `'false'` and the human synonyms `private`/`hidden` are accepted
 * too, because a YAML author who writes `visibility: private` means it and a
 * silently-still-indexed private file is the one failure mode worth preventing.
 * Anything else (absent, `true`, `public`, garbage) indexes as normal.
 */
export function isHiddenFromIndex(data: Record<string, unknown>): boolean {
  const v = data.visibility;
  if (v === false) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === 'false' || s === 'private' || s === 'hidden';
}

/**
 * Write a markdown file with YAML frontmatter.
 */
export function writeFrontmatter(
  filePath: string,
  data: Record<string, unknown>,
  content: string,
): void {
  const output = matter.stringify(content, data);
  writeFileSync(filePath, output, 'utf-8');
}

/**
 * Update specific frontmatter fields without touching the body content.
 */
export function updateFrontmatterFields(
  filePath: string,
  updates: Record<string, unknown>,
): void {
  const { data, content } = readFrontmatter(filePath);
  const merged = { ...data, ...updates };
  writeFrontmatter(filePath, merged, content);
}
