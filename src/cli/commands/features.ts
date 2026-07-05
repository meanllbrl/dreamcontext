import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { insertToSection } from '../../lib/markdown.js';
import { prepareSectionInsert, SECTION_MAP } from '../../lib/section-insert.js';
import { promptInput } from '../../lib/prompt.js';
import { generateId, slugify, today } from '../../lib/id.js';
import { success, error, header, warn } from '../../lib/format.js';
import { analyzeFeatures, type FeatureRef, type TaskRef } from '../../lib/feature-freshness.js';
import { featuresDir, FEATURES_TYPE } from '../../lib/features-path.js';

const VALID_FEATURE_STATUSES = ['planning', 'in_progress', 'in_review', 'active', 'shipped', 'deprecated'];

function parseCsv(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function getFeaturesDir(): string {
  const root = ensureContextRoot();
  return featuresDir(root);
}

// Features are typed knowledge now (migration 0.10.7) — `dreamcontext features`
// remains a compat alias. Print the notice once per process invocation (a
// single CLI call never spams it twice even if multiple actions run).
let deprecationPrinted = false;
function printDeprecation(): void {
  if (deprecationPrinted) return;
  deprecationPrinted = true;
  warn(
    'dreamcontext features is deprecated — features are now typed knowledge under knowledge/features/. This alias will be removed in a future release.',
  );
}

function findFeatureFile(name: string): string | null {
  const dir = getFeaturesDir();
  const slug = slugify(name);

  // Try exact match first
  const exact = join(dir, `${slug}.md`);
  if (existsSync(exact)) return exact;

  // Try glob match: prefer exact, then prefix, then substring
  const files = fg.sync('*.md', { cwd: dir, absolute: true });

  const exactGlob = files.find((f) => basename(f, '.md') === slug);
  if (exactGlob) return exactGlob;

  const prefixMatches = files.filter((f) => basename(f, '.md').startsWith(slug));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    error(`Ambiguous feature name "${name}". Did you mean: ${prefixMatches.map(f => basename(f, '.md')).join(', ')}?`);
    return null;
  }

  const substringMatches = files.filter((f) => basename(f, '.md').includes(slug));
  if (substringMatches.length === 1) return substringMatches[0];
  if (substringMatches.length > 1) {
    error(`Ambiguous feature name "${name}". Did you mean: ${substringMatches.map(f => basename(f, '.md')).join(', ')}?`);
    return null;
  }

  return null;
}

function getFeatureTemplate(): string {
  // Try to load from templates directory
  const candidates = [
    join(new URL('.', import.meta.url).pathname, '..', '..', 'templates', 'feature.md'),
    join(new URL('.', import.meta.url).pathname, '..', 'templates', 'feature.md'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }

  // Inline fallback
  return `---
id: "{{ID}}"
type: "${FEATURES_TYPE}"
name: "{{NAME}}"
description: "{{DESCRIPTION}}"
pinned: false
date: "{{DATE}}"
status: "planning"
created: "{{DATE}}"
updated: "{{DATE}}"
released_version: null
tags: []
related_tasks: []
---

## Why

{{WHY}}

## User Stories

- [ ] As a [user], I want [action] so that [outcome]

## Acceptance Criteria

- (Specific, testable conditions for this feature to be complete)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

## Technical Details

(How this feature is wired. Key files, services, dependencies, flows.)

## Notes

(Edge cases, open questions, future considerations.)

## Changelog
<!-- LIFO: newest entry at top -->

### {{DATE}} - Created
- Feature PRD created.
`;
}

export function registerFeaturesCommand(program: Command): void {
  const features = program
    .command('features')
    .description('Create features and insert into sections');

  // Create a feature
  features
    .command('create')
    .argument('<name>')
    .option('-w, --why <why>', 'Why are we building this?')
    .option('-d, --description <description>', 'One-line description (knowledge-index display)')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .option('-s, --status <status>', `Status (${VALID_FEATURE_STATUSES.join(', ')})`)
    .option('--related-tasks <slugs>', 'Comma-separated related task slugs')
    .description('Create a new feature document (typed knowledge under knowledge/features/)')
    .action(async (name: string, opts: { why?: string; description?: string; tags?: string; status?: string; relatedTasks?: string }) => {
      printDeprecation();
      const dir = getFeaturesDir();
      const slug = slugify(name);
      const filePath = join(dir, `${slug}.md`);

      if (existsSync(filePath)) {
        error(`Feature already exists: ${slug}.md`);
        return;
      }

      if (opts.status && !VALID_FEATURE_STATUSES.includes(opts.status)) {
        error(`Status must be one of: ${VALID_FEATURE_STATUSES.join(', ')}`);
        return;
      }

      const why = opts.why || await promptInput({ message: 'Why are we building this?' });
      const date = today();

      const template = getFeatureTemplate();
      const content = template
        .replaceAll('{{ID}}', generateId('feat'))
        .replaceAll('{{DATE}}', date)
        .replaceAll('{{NAME}}', name)
        .replaceAll('{{DESCRIPTION}}', opts.description ?? '')
        .replaceAll('{{WHY}}', why || '(To be defined)');

      writeFileSync(filePath, content, 'utf-8');

      const fields: Record<string, unknown> = {};
      if (opts.tags) fields.tags = parseCsv(opts.tags);
      if (opts.status) fields.status = opts.status;
      if (opts.relatedTasks) fields.related_tasks = parseCsv(opts.relatedTasks);
      if (Object.keys(fields).length > 0) {
        updateFrontmatterFields(filePath, fields);
      }

      success(`Feature created: ${slug}.md`);
    });

  // Set a feature's frontmatter field (tags / status / related_tasks)
  features
    .command('set')
    .argument('<name>')
    .argument('<field>', 'tags | status | related_tasks')
    .argument('<value...>', 'Value (comma-separated for tags / related_tasks)')
    .description('Set a feature frontmatter field without hand-editing')
    .action((name: string, field: string, valueParts: string[]) => {
      printDeprecation();
      const file = findFeatureFile(name);
      if (!file) {
        error(`Feature not found: ${name}`);
        return;
      }

      const key = field.toLowerCase();
      const value = valueParts.join(' ').trim();
      const updates: Record<string, unknown> = {};

      if (key === 'tags' || key === 'related_tasks' || key === 'related-tasks') {
        updates[key === 'tags' ? 'tags' : 'related_tasks'] = parseCsv(value);
      } else if (key === 'status') {
        if (!VALID_FEATURE_STATUSES.includes(value)) {
          error(`Status must be one of: ${VALID_FEATURE_STATUSES.join(', ')}`);
          return;
        }
        updates.status = value;
      } else {
        error(`Unknown field: "${field}". Settable fields: tags, status, related_tasks`);
        return;
      }

      updates.updated = today();
      updateFrontmatterFields(file, updates);
      success(`Set ${key} on ${basename(file, '.md')}`);
    });

  // Insert into a section
  features
    .command('insert')
    .argument('<name>')
    .argument(
      '<section>',
      'Section: changelog, notes, technical_details, constraints, user_stories, acceptance_criteria',
    )
    .argument('[content...]', 'Content to insert')
    .description('Insert content into a feature section')
    .action(async (name: string, section: string, contentParts: string[]) => {
      printDeprecation();
      const file = findFeatureFile(name);
      if (!file) {
        error(`Feature not found: ${name}`);
        return;
      }

      const sectionKey = section.toLowerCase();
      if (!SECTION_MAP[sectionKey]) {
        error(`Unknown section: "${section}". Valid sections: ${Object.keys(SECTION_MAP).join(', ')}`);
        return;
      }

      const rawContent = contentParts.length > 0
        ? contentParts.join(' ')
        : await promptInput({ message: `Content for ${SECTION_MAP[sectionKey]}:` });

      if (!rawContent.trim()) {
        error('No content provided.');
        return;
      }

      const prep = prepareSectionInsert(sectionKey, rawContent, today())!;

      try {
        insertToSection(file, prep.sectionName, prep.content, prep.position, true, prep.replacePlaceholders);
        updateFrontmatterFields(file, { updated: today() });
        success(`Inserted into ${prep.sectionName} in ${basename(file)}`);
      } catch (err: any) {
        error(err.message);
      }
    });

  // Doctor: read-only freshness + linkage health check
  features
    .command('doctor')
    .description('Check feature PRDs for staleness, orphans, and dangling task references (read-only)')
    .action(() => {
      printDeprecation();
      const root = ensureContextRoot();
      const dir = getFeaturesDir();
      const stateDir = join(root, 'state');

      // Read all feature PRDs
      const featureFiles = existsSync(dir)
        ? fg.sync('*.md', { cwd: dir, absolute: true })
        : [];

      const featureRefs: FeatureRef[] = [];
      for (const file of featureFiles) {
        try {
          const { data } = readFrontmatter<Record<string, unknown>>(file);
          featureRefs.push({
            slug: basename(file, '.md'),
            id: data.id ? String(data.id) : undefined,
            created: data.created ? String(data.created) : undefined,
            updated: data.updated ? String(data.updated) : undefined,
            related_tasks: Array.isArray(data.related_tasks)
              ? data.related_tasks.map(String)
              : [],
          });
        } catch {
          // skip unreadable files
        }
      }

      // Read all task state files for related_feature back-refs
      const taskFiles = existsSync(stateDir)
        ? fg.sync('*.md', { cwd: stateDir, absolute: true })
        : [];

      const taskRefs: TaskRef[] = [];
      for (const file of taskFiles) {
        const taskSlug = basename(file, '.md');
        if (taskSlug.startsWith('.')) continue; // skip hidden files
        try {
          const { data } = readFrontmatter<Record<string, unknown>>(file);
          taskRefs.push({
            task: taskSlug,
            related_feature: data.related_feature ? String(data.related_feature) : null,
          });
        } catch {
          // skip unreadable files
        }
      }

      const { stale, orphaned, danglingTaskRefs } = analyzeFeatures(featureRefs, taskRefs);

      console.log(header('Features doctor'));

      const issueCount = stale.length + orphaned.length + danglingTaskRefs.length;

      if (issueCount === 0) {
        success(`All ${featureRefs.length} feature(s) fresh and linked.`);
        return;
      }

      if (stale.length > 0) {
        console.log(`\n  ${chalk.yellow('STALE')} (${stale.length})`);
        for (const s of stale) {
          console.log(`    ${chalk.yellow('·')} ${chalk.bold(s.slug)}  ${chalk.dim(`${s.daysSinceUpdate}d`)}  ${chalk.dim(s.note)}`);
        }
      }

      if (orphaned.length > 0) {
        console.log(`\n  ${chalk.red('ORPHANED')} (${orphaned.length})  — no related tasks in either direction`);
        for (const o of orphaned) {
          console.log(`    ${chalk.red('·')} ${chalk.bold(o.slug)}`);
        }
      }

      if (danglingTaskRefs.length > 0) {
        console.log(`\n  ${chalk.red('DANGLING TASK REFS')} (${danglingTaskRefs.length})  — task points to missing feature PRD`);
        for (const d of danglingTaskRefs) {
          console.log(`    ${chalk.red('·')} ${chalk.bold(d.task)} → ${chalk.dim(d.missingFeature)}`);
        }
      }

      process.exitCode = 1;
    });
}
