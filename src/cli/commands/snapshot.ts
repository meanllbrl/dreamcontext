import { Command } from 'commander';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { resolveContextRoot } from '../../lib/context-path.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { readJsonArray } from '../../lib/json-file.js';
import { readSection } from '../../lib/markdown.js';
import { readSleepState, writeSleepState, readSleepHistory } from './sleep.js';
import { buildKnowledgeIndex } from '../../lib/knowledge-index.js';
import { buildCoreIndex } from '../../lib/core-index.js';
import { buildMarketingSnapshot } from '../../lib/marketing/snapshot.js';
import { readSetupConfig } from '../../lib/setup-config.js';

/**
 * Default line cap when inlining pinned knowledge into the auto-context snapshot.
 * Per-entry overrides via frontmatter `pinned_preview_lines: N` or `pinned_preview: "all"`.
 */
export const DEFAULT_PINNED_PREVIEW_LINES = 60;

/**
 * Strip leading YAML frontmatter and surrounding blank lines from markdown content.
 * Used by the preview helpers below.
 */
function stripFrontmatter(content: string): string {
  const lines = content.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    if (i < lines.length) i++;
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

/**
 * Take up to `maxLines` lines of body content (after frontmatter).
 * Returns `truncated: true` if the original body was longer than `maxLines`.
 * Preserves markdown structure — no paragraph joining, no char cap.
 */
export function extractPinnedPreview(
  content: string,
  maxLines: number,
): { preview: string; truncated: boolean; totalLines: number } {
  const body = stripFrontmatter(content).replace(/\s+$/, '');
  const lines = body.split('\n');
  const totalLines = lines.length;
  if (totalLines <= maxLines) {
    return { preview: body, truncated: false, totalLines };
  }
  return { preview: lines.slice(0, maxLines).join('\n'), truncated: true, totalLines };
}

/**
 * Extract the first paragraph from markdown content.
 * Skips headings, blank lines, and frontmatter blocks.
 * Returns the first block of contiguous body text.
 */
export function extractFirstParagraph(content: string): string {
  const lines = content.split('\n');
  const paragraphLines: string[] = [];
  let started = false;
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Handle YAML frontmatter blocks (--- ... ---)
    if (trimmed === '---') {
      if (!started) {
        inFrontmatter = !inFrontmatter;
        continue;
      }
    }
    if (inFrontmatter) continue;

    if (!started) {
      // Skip headings and blank lines
      if (!trimmed || trimmed.startsWith('#')) continue;
      started = true;
    }
    if (started) {
      if (!trimmed) break; // end of first paragraph
      if (trimmed.startsWith('#')) break; // next heading
      paragraphLines.push(trimmed);
    }
  }

  const result = paragraphLines.join(' ');
  return result.length > 300 ? result.slice(0, 297) + '...' : result;
}

/**
 * Build formatted lines for active (non-completed) tasks in state/*.md.
 * Shared by generateSnapshot() and generateSubagentBriefing().
 */
function getActiveTaskLines(root: string): string[] {
  const stateDir = join(root, 'state');
  if (!existsSync(stateDir)) return [];

  const taskFiles = fg.sync('*.md', { cwd: stateDir, absolute: true });
  const lines: string[] = [];

  for (const file of taskFiles) {
    try {
      const { data } = readFrontmatter(file);
      const status = String(data.status ?? 'unknown');
      if (status === 'completed') continue;
      const name = basename(file, '.md');
      const priority = String(data.priority ?? '-');
      const updated = String(data.updated_at ?? data.created_at ?? '');

      let line = `- ${name} (status: ${status}, priority: ${priority}, updated: ${updated})`;

      // Why (from ## Why section, first real line)
      // Strip HTML comments first (template placeholders like
      // `<!-- What problem does this solve? ... -->` would otherwise leak in).
      try {
        const whyContent = readSection(file, 'Why');
        if (whyContent) {
          const stripped = whyContent.replace(/<!--[\s\S]*?-->/g, '');
          const firstLine = stripped.split('\n').find(l => l.trim() && !l.trim().startsWith('('))?.trim();
          if (firstLine) {
            const capped = firstLine.length > 250 ? firstLine.slice(0, 247) + '...' : firstLine;
            line += `\n  Why: ${capped}`;
          }
        }
      } catch { /* skip */ }

      lines.push(line);
    } catch {
      // skip unreadable files
    }
  }

  return lines;
}

/**
 * Resolve the "active task" for the current session.
 *
 * Heuristic, in order of preference:
 *   1. `_dream_context/state/.active-task` file (plain text containing the task slug),
 *      if present. Lets the user/CLI override the heuristic explicitly.
 *   2. Otherwise, scan `_dream_context/state/*.md` for tasks with status `in_progress`
 *      and pick the most recently modified one (mtime fallback to frontmatter
 *      `updated_at` if mtime is unreliable).
 *
 * Returns the absolute task file path, or null if none matches.
 *
 * Edge cases / fragility:
 * - Multiple in_progress tasks across products: we pick the most recent.
 *   If the user switched products mid-session, the snapshot will reflect the
 *   last-edited task, not the one they're about to resume. Workaround: write
 *   the slug to `.active-task`.
 * - All tasks `todo`/`in_review`: no active task -> no product knowledge injected.
 * - Frontmatter without `product:`: no injection (single-product fallback).
 */
function resolveActiveTaskPath(root: string): string | null {
  const stateDir = join(root, 'state');
  if (!existsSync(stateDir)) return null;

  // 1. Explicit override
  const overridePath = join(stateDir, '.active-task');
  if (existsSync(overridePath)) {
    try {
      const slug = readFileSync(overridePath, 'utf-8').trim();
      if (slug) {
        const taskPath = join(stateDir, `${slug}.md`);
        if (existsSync(taskPath)) return taskPath;
      }
    } catch { /* fall through to heuristic */ }
  }

  // 2. Heuristic: most recently modified in_progress task
  const taskFiles = fg.sync('*.md', { cwd: stateDir, absolute: true });
  type Candidate = { path: string; mtime: number };
  const candidates: Candidate[] = [];

  for (const file of taskFiles) {
    try {
      const { data } = readFrontmatter(file);
      const status = String(data.status ?? '');
      if (status !== 'in_progress') continue;
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch { /* skip */ }
      candidates.push({ path: file, mtime });
    } catch {
      // skip unreadable
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

/**
 * Build the "Active Product Knowledge" section if the active task is bound to
 * a configured product. Returns an empty array when not applicable.
 *
 * Trigger:
 *   - `_dream_context/state/.config.json` has `multiProduct: string[]`
 *   - resolveActiveTaskPath() returns a task whose frontmatter `product: X`
 *     is one of the configured products
 *   - `_dream_context/knowledge/products/<X>.md` exists
 *
 * Cap the injected content at ~200 lines to avoid blowing up the snapshot;
 * direct the agent to read the full file if truncated.
 */
function getActiveProductKnowledge(root: string): string[] {
  const config = readSetupConfig(root);
  if (!config || !Array.isArray(config.multiProduct) || config.multiProduct.length === 0) {
    return [];
  }

  const activeTaskPath = resolveActiveTaskPath(root);
  if (!activeTaskPath) return [];

  let product = '';
  try {
    const { data } = readFrontmatter(activeTaskPath);
    if (typeof data.product === 'string' && data.product.trim()) {
      product = data.product.trim();
    }
  } catch {
    return [];
  }

  if (!product) return [];
  if (!config.multiProduct.includes(product)) return [];

  const productKnowledgePath = join(root, 'knowledge', 'products', `${product}.md`);
  if (!existsSync(productKnowledgePath)) return [];

  let raw: string;
  try {
    raw = readFileSync(productKnowledgePath, 'utf-8');
  } catch {
    return [];
  }

  // Strip frontmatter for the snapshot body
  const body = (() => {
    const lines = raw.split('\n');
    if (lines[0]?.trim() !== '---') return raw;
    let i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    if (i < lines.length) i++;
    return lines.slice(i).join('\n').replace(/^\s+/, '');
  })();

  const MAX_LINES = 200;
  const bodyLines = body.split('\n');
  let injected: string;
  let truncatedNote = '';
  if (bodyLines.length > MAX_LINES) {
    injected = bodyLines.slice(0, MAX_LINES).join('\n');
    truncatedNote = `\n→ Truncated; read full: _dream_context/knowledge/products/${product}.md (${bodyLines.length} lines total)`;
  } else {
    injected = body;
  }

  return [
    `## Active Product Knowledge: ${product}\n`,
    `_Auto-injected because the active task has \`product: ${product}\` and \`_dream_context/state/.config.json\` lists ${product} under \`multiProduct\`._\n`,
    injected.trim(),
    truncatedNote ? truncatedNote.trim() : '',
    '',
  ].filter((s) => s !== '');
}

/**
 * Output a plain-text context snapshot to stdout.
 * Designed for SessionStart hook consumption — no chalk, no interactivity.
 * If _dream_context/ doesn't exist, exits silently.
 */
export function generateSnapshot(): string {
  const root = resolveContextRoot();
  if (!root) return '';

  const parts: string[] = ['# Agent Context — Auto-loaded\n'];

  // 1. Soul file (full content) — WHO the agent is
  const soulPath = join(root, 'core', '0.soul.md');
  if (existsSync(soulPath)) {
    const content = readFileSync(soulPath, 'utf-8').trim();
    parts.push('## Soul (Agent Identity, Principles, Rules)\n');
    parts.push(content);
    parts.push('');
  }

  // 2. User file (full content) — WHO uses the agent
  const userPath = join(root, 'core', '1.user.md');
  if (existsSync(userPath)) {
    const content = readFileSync(userPath, 'utf-8').trim();
    parts.push('## User (Preferences, Project Details, Rules)\n');
    parts.push(content);
    parts.push('');
  }

  // 3. Memory file (full content) — WHAT the agent knows
  const memoryPath = join(root, 'core', '2.memory.md');
  if (existsSync(memoryPath)) {
    const content = readFileSync(memoryPath, 'utf-8').trim();
    if (content) {
      parts.push('## Memory (Technical Decisions, Known Issues, Session Log)\n');
      parts.push(content);
      parts.push('');
    }
  }

  // 4. Extended Core Files index (files 3+, not loaded in full)
  const coreExtras = buildCoreIndex(root);
  if (coreExtras.length > 0) {
    parts.push('## Extended Core Files\n');
    for (const entry of coreExtras) {
      let line = `- **${entry.name}** (${entry.path})`;
      if (entry.summary) {
        line += `: ${entry.summary}`;
      }
      parts.push(line);
    }
    parts.push('');
  }

  // 5. Active tasks
  const activeTasks = getActiveTaskLines(root);
  if (activeTasks.length > 0) {
    parts.push('## Active Tasks\n');
    parts.push(activeTasks.join('\n'));
    parts.push('');
  }

  // 5.1 Active Product Knowledge (multi-product binding)
  // If the active in_progress task has `product: X` frontmatter AND
  // state/.config.json lists X under multiProduct, inject
  // knowledge/products/X.md into the snapshot so the agent never has to
  // remember to load it manually.
  const productKnowledge = getActiveProductKnowledge(root);
  if (productKnowledge.length > 0) {
    parts.push(...productKnowledge);
  }

  // 5.5 Read sleep state (used by multiple sections below)
  const sleepState = readSleepState(root);

  // 5.6 Bookmarks (awake ripples, tagged moments from previous sessions)
  if (sleepState.bookmarks.length > 0) {
    const sorted = [...sleepState.bookmarks].sort((a, b) => b.salience - a.salience);
    parts.push('## Bookmarks\n');
    const salienceLabels: Record<number, string> = { 1: '*', 2: '**', 3: '***' };
    for (const b of sorted) {
      const taskRef = b.task_slug ? ` (task: ${b.task_slug})` : '';
      parts.push(`- ${salienceLabels[b.salience] || '*'} ${b.message}${taskRef}`);
    }
    parts.push('');
  }

  // 5.7 Contextual Reminders (matching triggers for active tasks)
  if (sleepState.triggers.length > 0) {
    // Gather active task names and tags for matching
    const taskNames: string[] = [];
    const taskTags: string[] = [];
    const stateDir = join(root, 'state');
    if (existsSync(stateDir)) {
      const taskFiles = fg.sync('*.md', { cwd: stateDir, absolute: true });
      for (const file of taskFiles) {
        try {
          const { data } = readFrontmatter(file);
          if (String(data.status ?? '') === 'completed') continue;
          taskNames.push(basename(file, '.md').toLowerCase());
          if (Array.isArray(data.tags)) {
            taskTags.push(...data.tags.map((t: string) => String(t).toLowerCase()));
          }
        } catch { /* skip */ }
      }
    }
    // Also check recent bookmark messages
    const recentBookmarkText = sleepState.bookmarks.map(b => b.message.toLowerCase()).join(' ');

    const matchContext = [...taskNames, ...taskTags].join(' ') + ' ' + recentBookmarkText;

    const matchedTriggers = sleepState.triggers.filter(t => {
      if (t.fired_count >= t.max_fires) return false;
      const keywords = t.when.toLowerCase().split(/[\s,]+/);
      return keywords.some(kw => matchContext.includes(kw));
    });

    if (matchedTriggers.length > 0) {
      parts.push('## Contextual Reminders\n');
      for (const t of matchedTriggers) {
        parts.push(`- ${t.remind}`);
        // Increment fired_count
        t.fired_count++;
      }
      parts.push('');
      // Persist trigger fired_count updates
      writeSleepState(root, sleepState);
    }
  }

  // 6. Sleep State — DEPRECATED in snapshot (v0.4.0+).
  // Sleep debt + critical bookmark reminders are delivered by the
  // UserPromptSubmit hook on every prompt; rendering them here too would
  // duplicate the signal and bloat the snapshot. Kept as a no-op block for
  // clarity; remove entirely in a later cleanup if the hook stays stable.

  // 7. Recent changelog — tiered display (2026-05-23):
  //   Tier 1 (top 3): summary headline + first ~300 chars of description.
  //   Tier 2 (next 10): one-line headline only (summary or truncated desc).
  //   Rationale: recent events deserve narrative; older events stay on the
  //   horizon as titles so the agent knows what shipped without paying full
  //   description token cost. Full text always recoverable via
  //   `dreamcontext memory recall --types changelog`.
  const CHANGELOG_TIER1 = 3;
  const CHANGELOG_TIER2 = 10;
  const TIER1_BODY_CHARS = 300;
  const TIER2_LINE_CHARS = 140;
  const changelogPath = join(root, 'core', 'CHANGELOG.json');
  if (existsSync(changelogPath)) {
    try {
      const entries = readJsonArray<Record<string, unknown>>(changelogPath);
      const tier1 = entries.slice(0, CHANGELOG_TIER1);
      const tier2 = entries.slice(CHANGELOG_TIER1, CHANGELOG_TIER1 + CHANGELOG_TIER2);
      if (tier1.length > 0) {
        parts.push('## Recent Changelog\n');
        for (const e of tier1) {
          const date = String(e.date ?? '');
          const type = String(e.type ?? '');
          const scope = String(e.scope ?? '');
          const summary = typeof e.summary === 'string' ? e.summary : '';
          const desc = String(e.description ?? '');
          const headline = summary || (desc.length > 200 ? desc.slice(0, 197) + '...' : desc);
          parts.push(`- ${date} [${type}] ${scope}: ${headline}`);
          // Body preview only when summary is present (otherwise headline is
          // already the description). Avoids printing the same text twice.
          if (summary && desc && desc !== summary) {
            const body = desc.length > TIER1_BODY_CHARS
              ? desc.slice(0, TIER1_BODY_CHARS - 3) + '...'
              : desc;
            parts.push(`    ${body}`);
          }
        }
        if (tier2.length > 0) {
          parts.push('');
          parts.push('### Older (titles only — use `dreamcontext memory recall --types changelog` for detail):');
          for (const e of tier2) {
            const date = String(e.date ?? '');
            const type = String(e.type ?? '');
            const scope = String(e.scope ?? '');
            const summary = typeof e.summary === 'string' ? e.summary : '';
            const desc = String(e.description ?? '');
            const raw = summary || desc;
            const line = raw.length > TIER2_LINE_CHARS
              ? raw.slice(0, TIER2_LINE_CHARS - 3) + '...'
              : raw;
            parts.push(`- ${date} [${type}] ${scope}: ${line}`);
          }
        }
        parts.push('');
      }
    } catch {
      // skip if malformed
    }
  }

  // 7.5. Releases (planning + latest released)
  const releasesPath = join(root, 'core', 'RELEASES.json');
  if (existsSync(releasesPath)) {
    try {
      const releases = readJsonArray<Record<string, unknown>>(releasesPath);
      if (releases.length > 0) {
        const planning = releases.filter(r => r.status === 'planning');
        const released = releases.filter(r => r.status !== 'planning');

        if (planning.length > 0) {
          parts.push('## Upcoming Versions\n');
          for (const p of planning) {
            const ver = String(p.version ?? '');
            const sum = String(p.summary ?? '');
            const taskCount = Array.isArray(p.tasks) ? p.tasks.length : 0;
            parts.push(`- ${ver}: ${sum}${taskCount > 0 ? ` (${taskCount} task(s))` : ''}`);
          }
          parts.push('');
        }

        if (released.length > 0) {
          const latest = released[0];
          const ver = String(latest.version ?? '');
          const relDate = String(latest.date ?? '');
          const sum = String(latest.summary ?? '');
          const taskCount = Array.isArray(latest.tasks) ? latest.tasks.length : 0;
          const featCount = Array.isArray(latest.features) ? latest.features.length : 0;
          const brk = latest.breaking ? ' (BREAKING)' : '';
          parts.push('## Latest Release\n');
          parts.push(`- ${ver} (${relDate})${brk}: ${sum}`);
          if (taskCount > 0 || featCount > 0) {
            parts.push(`  Includes: ${taskCount} task(s), ${featCount} feature(s)`);
          }
          parts.push('');
        }
      }
    } catch {
      // skip if malformed
    }
  }

  // 8. Features summary (with Why, related tasks, and latest changelog)
  const featuresDir = join(root, 'core', 'features');
  if (existsSync(featuresDir)) {
    const featureFiles = fg.sync('*.md', { cwd: featuresDir, absolute: true });
    const features: string[] = [];

    for (const file of featureFiles) {
      try {
        const { data } = readFrontmatter(file);
        const name = basename(file, '.md');
        const status = String(data.status ?? 'unknown');
        const tags = Array.isArray(data.tags) ? data.tags.join(', ') : '';

        // Why (from ## Why section, first real line; HTML template comments stripped)
        let why = '';
        try {
          const whyContent = readSection(file, 'Why');
          if (whyContent) {
            const stripped = whyContent.replace(/<!--[\s\S]*?-->/g, '');
            const firstLine = stripped.split('\n').find(l => l.trim() && !l.trim().startsWith('('))?.trim();
            if (firstLine) {
              why = firstLine.length > 250 ? firstLine.slice(0, 247) + '...' : firstLine;
            }
          }
        } catch { /* skip */ }

        // Related tasks (from frontmatter)
        const relatedTasks = Array.isArray(data.related_tasks) && data.related_tasks.length > 0
          ? data.related_tasks.join(', ')
          : '';

        // Latest changelog entry (from ## Changelog section)
        let latest = '';
        try {
          const changelogContent = readSection(file, 'Changelog');
          if (changelogContent) {
            const lines = changelogContent.split('\n');
            const headerLine = lines.find(l => l.startsWith('### '));
            if (headerLine) {
              const header = headerLine.replace(/^###\s*/, '').trim();
              if (!header.endsWith('- Created')) {
                const bulletIdx = lines.indexOf(headerLine) + 1;
                const bullet = lines.slice(bulletIdx).find(l => l.trim().startsWith('-'));
                if (bullet) {
                  const entry = `${header.split(' - ')[0]} - ${bullet.trim().replace(/^-\s*/, '')}`;
                  latest = entry.length > 120 ? entry.slice(0, 117) + '...' : entry;
                }
              }
            }
          }
        } catch { /* skip */ }

        // Build output
        let featureLine = `- **${name}** (status: ${status}${tags ? `, tags: ${tags}` : ''})`;
        const details: string[] = [];
        if (why) details.push(`  Why: ${why}`);
        if (relatedTasks) details.push(`  Tasks: ${relatedTasks}`);
        if (latest) details.push(`  Latest: ${latest}`);

        if (details.length > 0) {
          featureLine += '\n' + details.join('\n');
        }
        features.push(featureLine);
      } catch {
        // skip unreadable files
      }
    }

    if (features.length > 0) {
      parts.push('## Features\n');
      parts.push(features.join('\n'));
      parts.push('');
    }
  }

  // 9. Knowledge Index + Pinned Knowledge
  const knowledgeEntries = buildKnowledgeIndex(root);
  if (knowledgeEntries.length > 0) {
    const indexLines: string[] = [];
    const pinnedEntries: typeof knowledgeEntries = [];
    const warmEntries: typeof knowledgeEntries = [];

    // Gather active task tags for warm knowledge matching
    const activeTaskTags: string[] = [];
    const stDir = join(root, 'state');
    if (existsSync(stDir)) {
      const tFiles = fg.sync('*.md', { cwd: stDir, absolute: true });
      for (const file of tFiles) {
        try {
          const { data } = readFrontmatter(file);
          if (String(data.status ?? '') === 'completed') continue;
          if (Array.isArray(data.tags)) {
            activeTaskTags.push(...data.tags.map((t: string) => String(t).toLowerCase()));
          }
        } catch { /* skip */ }
      }
    }

    for (const entry of knowledgeEntries) {
      const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      // Staleness indicator
      const accessRecord = sleepState.knowledge_access[entry.slug];
      let stalenessNote = '';
      if (accessRecord) {
        const daysSince = Math.floor((Date.now() - new Date(accessRecord.last_accessed).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSince > 30) {
          stalenessNote = ' (stale: not accessed in 30+ days)';
        }
      } else if (entry.date) {
        const daysSinceCreation = Math.floor((Date.now() - new Date(entry.date).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceCreation > 30) {
          stalenessNote = ' (stale: never accessed)';
        }
      }

      indexLines.push(`- **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}${stalenessNote}`);
      if (entry.pinned) {
        pinnedEntries.push(entry);
      } else if (!stalenessNote) {
        // Warm candidate: recently accessed or task-relevant
        const isRecentlyAccessed = accessRecord && accessRecord.count > 0 &&
          (Date.now() - new Date(accessRecord.last_accessed).getTime()) < 7 * 24 * 60 * 60 * 1000; // 7 days
        const isTaskRelevant = entry.tags.some(t => activeTaskTags.includes(t.toLowerCase()));
        if (isRecentlyAccessed || isTaskRelevant) {
          warmEntries.push(entry);
        }
      }
    }

    parts.push('## Knowledge Index\n');

    // Pinned entries surface at the TOP with a prominent warning. Body is
    // intentionally NOT inlined — `memory recall` fetches on demand and the
    // agent can Read the file when the warning applies.
    if (pinnedEntries.length > 0) {
      parts.push('> !!! ÇOK ÖNEMLİ !!! Kullanıcı bu bilgiyi pinlemiş — yapacağın bir işle ilişkisi varsa MUTLAKA OKU!\n');
      for (const entry of pinnedEntries) {
        const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
        parts.push(`- 📌 **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}`);
      }
      parts.push('');
    }

    const pinnedSlugs = new Set(pinnedEntries.map(e => e.slug));
    const nonPinnedLines = indexLines.filter((_, i) => !pinnedSlugs.has(knowledgeEntries[i]?.slug));
    if (nonPinnedLines.length > 0) {
      if (pinnedEntries.length > 0) parts.push('### Other knowledge:\n');
      parts.push(nonPinnedLines.join('\n'));
    }
    parts.push('');

    // 9.5 Warm Knowledge (recently relevant, first paragraph only)
    if (warmEntries.length > 0) {
      parts.push('## Warm Knowledge (Recently Relevant)\n');
      for (const entry of warmEntries) {
        parts.push(`### ${entry.name}`);
        const firstParagraph = extractFirstParagraph(entry.content);
        if (firstParagraph) {
          parts.push(firstParagraph);
        }
        parts.push(`-> Read full: _dream_context/knowledge/${entry.slug}.md`);
        parts.push('');
      }
    }
  }

  // 11. Marketing snapshot (skill-pack scoped — only present when bootstrapped)
  try {
    const marketing = buildMarketingSnapshot();
    if (marketing) {
      parts.push(marketing);
      parts.push('');
    }
  } catch {
    // Marketing snapshot must never break the SessionStart hook.
  }

  return parts.join('\n').trim();
}

/**
 * Output a lightweight context briefing for sub-agents.
 * Lighter than generateSnapshot(): no soul/user/memory content, no sleep state,
 * no changelog, no features detail. Includes project summary, active tasks,
 * knowledge index, and pinned knowledge.
 * Plain text, no chalk — consumed by SubagentStart hook.
 */
export function generateSubagentBriefing(): string {
  const root = resolveContextRoot();
  if (!root) return '';

  const parts: string[] = ['# Agent Context -- Sub-agent Briefing\n'];

  // 1. Top-priority directive (MUST be first thing the sub-agent reads)
  parts.push('MANDATORY: This project has documented context files. You MUST check the feature list');
  parts.push('and knowledge index below BEFORE using Glob, Grep, or searching code. If any feature');
  parts.push('name or tag matches your task, Read that feature file first. Searching the codebase');
  parts.push('without checking context wastes tokens and duplicates existing documentation.\n');

  // 2. Project summary (first meaningful line from soul file content)
  const soulPath = join(root, 'core', '0.soul.md');
  if (existsSync(soulPath)) {
    const { data, content } = readFrontmatter(soulPath);
    const projectName = typeof data.name === 'string' ? data.name : '';
    const lines = content.split('\n');
    const summaryLine = lines.find(l => {
      const t = l.trim();
      return t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('<!--') && !t.startsWith('---');
    });
    if (projectName || summaryLine) {
      let summary = projectName ? `**${projectName}**` : '';
      if (summaryLine) {
        const trimmed = summaryLine.trim();
        const capped = trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
        summary += summary ? `: ${capped}` : capped;
      }
      parts.push(`Project: ${summary}\n`);
    }
  }

  // 3. Features summary (name, status, tags, why, related tasks)
  // Features come FIRST because they're the most actionable context for sub-agents.
  const featuresDir = join(root, 'core', 'features');
  if (existsSync(featuresDir)) {
    const featureFiles = fg.sync('*.md', { cwd: featuresDir, absolute: true });
    const features: string[] = [];

    for (const file of featureFiles) {
      try {
        const { data } = readFrontmatter(file);
        const name = basename(file, '.md');
        const status = String(data.status ?? 'unknown');
        const tags = Array.isArray(data.tags) ? data.tags.join(', ') : '';

        let why = '';
        try {
          const whyContent = readSection(file, 'Why');
          if (whyContent) {
            const firstLine = whyContent.split('\n').find(l => l.trim() && !l.trim().startsWith('('))?.trim();
            if (firstLine) {
              why = firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
            }
          }
        } catch { /* skip */ }

        const relatedTasks = Array.isArray(data.related_tasks) && data.related_tasks.length > 0
          ? data.related_tasks.join(', ')
          : '';

        let featureLine = `- **${name}** --> Read: _dream_context/core/features/${name}.md`;
        const details: string[] = [];
        if (tags) details.push(`  Tags: ${tags}`);
        if (why) details.push(`  Why: ${why}`);
        if (relatedTasks) details.push(`  Tasks: ${relatedTasks}`);

        if (details.length > 0) {
          featureLine += '\n' + details.join('\n');
        }
        features.push(featureLine);
      } catch {
        // skip unreadable files
      }
    }

    if (features.length > 0) {
      parts.push('## Features (read these BEFORE searching code)\n');
      parts.push(features.join('\n'));
      parts.push('');
    }
  }

  // 4. Knowledge Index + Pinned Knowledge
  const knowledgeEntries = buildKnowledgeIndex(root);
  if (knowledgeEntries.length > 0) {
    const indexLines: string[] = [];
    const pinnedEntries: typeof knowledgeEntries = [];

    for (const entry of knowledgeEntries) {
      const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      indexLines.push(`- **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}`);
      if (entry.pinned) {
        pinnedEntries.push(entry);
      }
    }

    parts.push('## Knowledge Index\n');

    if (pinnedEntries.length > 0) {
      parts.push('> !!! ÇOK ÖNEMLİ !!! Kullanıcı bu bilgiyi pinlemiş — yapacağın bir işle ilişkisi varsa MUTLAKA OKU!\n');
      for (const entry of pinnedEntries) {
        const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
        parts.push(`- 📌 **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}`);
      }
      parts.push('');
    }

    const pinnedSlugs2 = new Set(pinnedEntries.map(e => e.slug));
    const nonPinnedLines2 = indexLines.filter((_, i) => !pinnedSlugs2.has(knowledgeEntries[i]?.slug));
    if (nonPinnedLines2.length > 0) {
      if (pinnedEntries.length > 0) parts.push('### Other knowledge:\n');
      parts.push(nonPinnedLines2.join('\n'));
    }
    parts.push('');
  }

  // 5. All Core Files index (so sub-agents know what exists to read/update)
  const coreDir = join(root, 'core');
  if (existsSync(coreDir)) {
    const allCoreFiles = fg.sync(['[0-9]*'], { cwd: coreDir, absolute: true });
    allCoreFiles.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));

    if (allCoreFiles.length > 0) {
      parts.push('## Core Files\n');
      for (const file of allCoreFiles) {
        const filename = basename(file);
        const relativePath = `_dream_context/core/${filename}`;

        if (filename.endsWith('.json')) {
          const name = filename.replace(/^\d+\./, '').replace(/\.\w+$/, '').replace(/_/g, ' ');
          parts.push(`- **${name}** (${relativePath})`);
          continue;
        }

        try {
          const { data } = readFrontmatter(file);
          const name = String(data.name ?? filename);
          const summary = data.summary ? `: ${String(data.summary)}` : '';
          parts.push(`- **${name}** (${relativePath})${summary}`);
        } catch {
          parts.push(`- **${filename}** (${relativePath})`);
        }
      }
      parts.push('');
    }
  }

  // 6. Active tasks
  const activeTasks = getActiveTaskLines(root);
  if (activeTasks.length > 0) {
    parts.push('## Active Tasks\n');
    parts.push(activeTasks.join('\n'));
    parts.push('');
  }

  // 7. Task-awareness instruction (for Plan agents and all sub-agents)
  parts.push('## Task Awareness\n');
  parts.push('All significant work should be linked to a task in `_dream_context/state/`.');
  parts.push('If you are creating a plan or completing an implementation:');
  parts.push('- Check if an existing task in Active Tasks above relates to this work');
  parts.push('- If planning: after the plan is approved, ask the user: "Would you like to save this plan as an dreamcontext task?"');
  parts.push('- To create: `dreamcontext tasks create <name> --status pending --priority <p> --tags <t>`');
  parts.push('- To log progress: `dreamcontext tasks log <name> "what was done"`');
  parts.push('Untracked work gets lost across sessions. Tasks are how knowledge persists.');
  parts.push('');

  // 8. Context directory reference
  parts.push('## Context Directory\n');
  parts.push('`_dream_context/core/` -- Core files: soul (0), user (1), memory (2), extended (3+), features/');
  parts.push('`_dream_context/knowledge/` -- Deep research documents on specific topics');
  parts.push('`_dream_context/state/` -- Active task files with progress logs');
  parts.push('');

  return parts.join('\n').trim();
}

export function registerSnapshotCommand(program: Command): void {
  program
    .command('snapshot')
    .description('Output a context snapshot for SessionStart hook (plain text, no colors)')
    .option('--tokens', 'Show estimated token count instead of snapshot content')
    .action((opts: { tokens?: boolean }) => {
      const output = generateSnapshot();
      if (!output) return;

      if (opts.tokens) {
        // Rough estimate: ~4 chars per token for English text
        const estimated = Math.ceil(output.length / 4);
        console.log(String(estimated));
      } else {
        console.log(output);
      }
    });
}
