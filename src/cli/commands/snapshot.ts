import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { resolveContextRoot } from '../../lib/context-path.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { readJsonArray } from '../../lib/json-file.js';
import { readSection } from '../../lib/markdown.js';
import { readSleepState, writeSleepState, readSleepHistory } from './sleep.js';
import { buildKnowledgeIndex } from '../../lib/knowledge-index.js';
import { buildCoreIndex } from '../../lib/core-index.js';

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

      // Why (from ## Why section, first non-placeholder line)
      try {
        const whyContent = readSection(file, 'Why');
        if (whyContent) {
          const firstLine = whyContent.split('\n').find(l => l.trim() && !l.trim().startsWith('('))?.trim();
          if (firstLine) {
            const capped = firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
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
 * Output a plain-text context snapshot to stdout.
 * Designed for SessionStart hook consumption — no chalk, no interactivity.
 * If _agent_context/ doesn't exist, exits silently.
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

  // 5.5 Read sleep state (used by multiple sections below)
  const sleepState = readSleepState(root);

  // 5.6 Bookmarks (awake ripples, tagged moments from previous sessions)
  if (sleepState.bookmarks.length > 0) {
    const sorted = [...sleepState.bookmarks].sort((a, b) => b.salience - a.salience);
    parts.push('## Bookmarks\n');
    const salienceLabels: Record<number, string> = { 1: '*', 2: '**', 3: '***' };
    for (const b of sorted) {
      parts.push(`- ${salienceLabels[b.salience] || '*'} ${b.message}`);
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

  // 6. Sleep State
  if (sleepState.debt > 0 || sleepState.last_sleep || sleepState.sessions.length > 0 || sleepState.sleep_started_at) {
    const level = sleepState.debt <= 3 ? 'Alert'
      : sleepState.debt <= 6 ? 'Drowsy'
      : sleepState.debt <= 9 ? 'Sleepy'
      : 'Must Sleep';
    parts.push('## Sleep State\n');
    parts.push(`- Debt: ${sleepState.debt} (${level})`);
    if (sleepState.sessions_since_last_sleep > 0) {
      parts.push(`- Sessions since last sleep: ${sleepState.sessions_since_last_sleep}`);
    }
    if (sleepState.sleep_started_at) {
      parts.push(`- Consolidation in progress (started: ${sleepState.sleep_started_at})`);
    }
    if (sleepState.last_sleep) {
      parts.push(`- Last sleep: ${sleepState.last_sleep}`);
    }
    if (sleepState.sessions.length > 0) {
      const lastSession = sleepState.sessions[0];
      if (lastSession.stopped_at) {
        parts.push(`- Last session ended: ${lastSession.stopped_at}`);
      }
      if (lastSession.last_assistant_message) {
        parts.push(`- Last session summary: ${lastSession.last_assistant_message}`);
      }
      parts.push(`- Entries since last sleep:`);
      for (const s of sleepState.sessions) {
        const scoreStr = s.score !== null ? `(+${s.score})` : '(pending)';
        const changePart = s.change_count !== null ? `${s.change_count} changes` : '';
        const toolPart = s.tool_count != null ? `${s.tool_count} tools` : '';
        const metricsStr = [changePart, toolPart].filter(Boolean).join(', ');
        parts.push(`  - ${s.stopped_at ?? 'active'} ${scoreStr}${metricsStr ? ` ${metricsStr}` : ''}`);
        if (s.last_assistant_message) {
          const preview = s.last_assistant_message.length > 200
            ? s.last_assistant_message.slice(0, 200) + '...'
            : s.last_assistant_message;
          parts.push(`    ${preview}`);
        }
      }
    }
    // Sleep history (last 3 entries from separate file)
    const sleepHistory = readSleepHistory(root);
    if (sleepHistory.length > 0) {
      parts.push(`- Recent consolidation history:`);
      for (const h of sleepHistory.slice(0, 3)) {
        parts.push(`  - ${h.date}: debt ${h.debt_before} -> ${h.debt_after}, ${h.sessions_processed} session(s), ${h.bookmarks_processed} bookmark(s)`);
        const summary = h.summary.length > 120 ? h.summary.slice(0, 117) + '...' : h.summary;
        parts.push(`    ${summary}`);
      }
    }
    parts.push('');
  }

  // 7. Recent changelog (last 5 entries)
  const changelogPath = join(root, 'core', 'CHANGELOG.json');
  if (existsSync(changelogPath)) {
    try {
      const entries = readJsonArray<Record<string, unknown>>(changelogPath);
      const recent = entries.slice(0, 3);
      if (recent.length > 0) {
        parts.push('## Recent Changelog\n');
        for (const e of recent) {
          const date = String(e.date ?? '');
          const type = String(e.type ?? '');
          const scope = String(e.scope ?? '');
          const desc = String(e.description ?? '');
          parts.push(`- ${date} [${type}] ${scope}: ${desc}`);
        }
        parts.push('');
      }
    } catch {
      // skip if malformed
    }
  }

  // 7.5. Latest Release
  const releasesPath = join(root, 'core', 'RELEASES.json');
  if (existsSync(releasesPath)) {
    try {
      const releases = readJsonArray<Record<string, unknown>>(releasesPath);
      if (releases.length > 0) {
        const latest = releases[0];
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

        // Why (from ## Why section)
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

      indexLines.push(`- **${entry.slug}** (_agent_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}${stalenessNote}`);
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
    parts.push(indexLines.join('\n'));
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
        parts.push(`-> Read full: _agent_context/knowledge/${entry.slug}.md`);
        parts.push('');
      }
    }

    // 10. Pinned Knowledge (full content, only if any)
    if (pinnedEntries.length > 0) {
      parts.push('## Pinned Knowledge\n');
      for (const entry of pinnedEntries) {
        parts.push(`### ${entry.name}\n`);
        parts.push(entry.content);
        parts.push('');
      }
    }
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

        let featureLine = `- **${name}** --> Read: _agent_context/core/features/${name}.md`;
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
      indexLines.push(`- **${entry.slug}** (_agent_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}`);
      if (entry.pinned) {
        pinnedEntries.push(entry);
      }
    }

    parts.push('## Knowledge Index\n');
    parts.push(indexLines.join('\n'));
    parts.push('');

    if (pinnedEntries.length > 0) {
      parts.push('## Pinned Knowledge\n');
      for (const entry of pinnedEntries) {
        parts.push(`### ${entry.name}\n`);
        parts.push(entry.content);
        parts.push('');
      }
    }
  }

  // 5. All Core Files index (so sub-agents know what exists to read/update)
  const coreDir = join(root, 'core');
  if (existsSync(coreDir)) {
    const allCoreFiles = fg.sync(['[0-9]*'], { cwd: coreDir, absolute: true });
    allCoreFiles.sort((a, b) => basename(a).localeCompare(basename(b)));

    if (allCoreFiles.length > 0) {
      parts.push('## Core Files\n');
      for (const file of allCoreFiles) {
        const filename = basename(file);
        const relativePath = `_agent_context/core/${filename}`;

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
  parts.push('All significant work should be linked to a task in `_agent_context/state/`.');
  parts.push('If you are creating a plan or completing an implementation:');
  parts.push('- Check if an existing task in Active Tasks above relates to this work');
  parts.push('- If planning: after the plan is approved, ask the user: "Would you like to save this plan as an agentcontext task?"');
  parts.push('- To create: `agentcontext tasks create <name> --status pending --priority <p> --tags <t>`');
  parts.push('- To log progress: `agentcontext tasks log <name> "what was done"`');
  parts.push('Untracked work gets lost across sessions. Tasks are how knowledge persists.');
  parts.push('');

  // 8. Context directory reference
  parts.push('## Context Directory\n');
  parts.push('`_agent_context/core/` -- Core files: soul (0), user (1), memory (2), extended (3+), features/');
  parts.push('`_agent_context/knowledge/` -- Deep research documents on specific topics');
  parts.push('`_agent_context/state/` -- Active task files with progress logs');
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
