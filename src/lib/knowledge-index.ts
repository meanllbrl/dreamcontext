import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';

// ─── Standard Tags ─────────────────────────────────────────────────────────

/**
 * Standard knowledge tags that agents know about for filtering and categorization.
 * Custom tags are always allowed, but these are the well-known categories.
 */
export const STANDARD_TAGS = [
  'architecture',  // system design, patterns, structure decisions
  'api',           // endpoints, contracts, integrations, protocols
  'frontend',      // UI, components, styling, client-side
  'backend',       // server, services, business logic
  'database',      // schema, queries, migrations, data modeling
  'devops',        // deployment, CI/CD, infrastructure, Docker, K8s
  'security',      // auth, permissions, vulnerabilities, encryption
  'testing',       // test strategies, patterns, fixtures, coverage
  'design',        // UX, branding, style guide, accessibility
  'decisions',     // ADRs, technical decisions, trade-offs, rationale
  'onboarding',    // setup, environment, getting started, conventions
  'domain',        // business domain knowledge, terminology, workflows
] as const;

export type StandardTag = typeof STANDARD_TAGS[number];

// ─── Types ─────────────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  date: string;
  pinned: boolean;
  content: string;
  pinnedPreviewLines?: number;
  pinnedPreviewAll?: boolean;
}

// ─── Index Builder ─────────────────────────────────────────────────────────

/**
 * Scan knowledge/*.md and return structured index entries.
 * Sorted: pinned first, then alphabetical by slug.
 * Returns [] if knowledge/ doesn't exist or is empty.
 */
export function buildKnowledgeIndex(contextRoot: string): KnowledgeEntry[] {
  const knowledgeDir = join(contextRoot, 'knowledge');
  if (!existsSync(knowledgeDir)) return [];

  const files = fg.sync('*.md', { cwd: knowledgeDir, absolute: true });
  const entries: KnowledgeEntry[] = [];

  for (const file of files) {
    try {
      const { data, content } = readFrontmatter(file);
      const entry: KnowledgeEntry = {
        slug: basename(file, '.md'),
        name: String(data.name ?? basename(file, '.md')),
        description: String(data.description ?? ''),
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        date: String(data.date ?? ''),
        pinned: data.pinned === true,
        content: content.trim(),
      };
      if (typeof data.pinned_preview_lines === 'number' && data.pinned_preview_lines > 0) {
        entry.pinnedPreviewLines = data.pinned_preview_lines;
      }
      if (data.pinned_preview === 'all') {
        entry.pinnedPreviewAll = true;
      }
      entries.push(entry);
    } catch {
      // skip unreadable files
    }
  }

  entries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });

  return entries;
}
