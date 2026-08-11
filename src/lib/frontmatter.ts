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
